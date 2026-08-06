import { getStats, getTokenHolders } from "./blockscout.js";
import { V4_DISCOVERY_BUDGET_MS, V4_MIN_MS, V4_UNREAD_REASONS, readV4Pools, v4MarketData } from "./dex-v4.js";
import { finiteOrNull } from "./format-number.js";
import { priceCacheTtlMs, withIndexerCache } from "./indexer-cache.js";
import { outOfTimeFor } from "./request-budget.js";
import { RANK_BAND_BPS, TICK_ABI, WIDE_BAND_BPS, measureBandDepth } from "./tick-depth.js";

/**
 * Price a token from its Uniswap v3 pool, because the indexer will not.
 *
 * WHY THIS EXISTS. Blockscout returns exchange_rate, circulating_market_cap and
 * volume_24h as NULL for essentially every non-equity token on Robinhood Chain —
 * only the 94 issuer-verified tokenized equities carry a feed. So the app answered
 * "no price available" for exactly the tokens people actually trade, and its symbol
 * resolver, which ranks candidates by holders and market cap, was structurally
 * biased toward whichever copycat contract happened to carry indexer data. The
 * chain itself knows the price: Uniswap v3 is deployed here and the pools are
 * real. This module reads them.
 *
 * WHAT IT IS NOT. It is not a second opinion to be averaged with the indexer's.
 * A pool price and a feed price are different measurements of different things and
 * every figure that leaves here is stamped `source: "uniswap_v3"` so the layer
 * above can never merge the two into one unlabelled number.
 *
 * Server-side only, but nothing here is server-specific: no React, no Next, no
 * module-scope I/O. Both the RPC client and the indexer calls are injectable, so
 * every path below is exercised offline in test/dex-price.test.mjs.
 */

/* ------------------------------- addresses ------------------------------- */

/**
 * The Uniswap v3 factory ON THIS CHAIN — and it is NOT the canonical one.
 *
 * FINDING, so nobody repeats the dead end. Probing
 * 0x1F98431c8aD98523631AE4a59f267346ea31F984 — the factory address Uniswap v3 has
 * on Ethereum, Arbitrum, Base, Optimism and Polygon — looked right: it holds 2109
 * bytes of bytecode here, so it is not an empty address. Every getPool call
 * against it failed, and the failure was misread as an ABI or argument-order
 * problem. It is neither. The calldata is correct (selector 0x1698ee82, the
 * canonical getPool(address,address,uint24)), getPool is order-agnostic by design,
 * and the raw eth_call returns "0x" — no data, which is what an address returns
 * for a function it does not have. That bytecode is some other contract: it has no
 * getPool selector, no owner(), no feeAmountTickSpacing().
 *
 * The real factory came from the chain, not from a guess: read factory() off a
 * pool that demonstrably exists. It answers 0x1f7d7550…, which holds 24535 bytes,
 * implements owner(), and returns 0xAD19A2… for getPool(VLAD, WETH, 3000) — the
 * known-good pool, in either token order, and the zero address for the fee tiers
 * where no pool exists. Verified live before this file was written.
 *
 * Overridable, because a chain can deploy a second factory and a hard-coded
 * address that has gone stale is worse than a configurable one.
 */
const DEFAULT_FACTORY = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA";

/**
 * Canonical WETH on Robinhood Chain, established by its ROLE and not its name.
 *
 * There is more than one contract here calling itself "Wrapped Ether"
 * (0xA753e1BE… is another), and neither the symbol nor the name distinguishes
 * them. This one is token0 of real pools carrying real liquidity, and the other
 * has no factory pool at all against it. On a chain where a "United States Dump
 * Coin" trades under the symbol USDC, role is the only evidence worth anything.
 */
const DEFAULT_WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

/**
 * Stablecoin quote CANDIDATES — proposals, not facts.
 *
 * Nothing in this list is trusted for being on it. Each one has to earn the role
 * at read time by verifyStableQuote below: a real factory pool against WETH, live
 * liquidity in it, and an implied rate that lands near the live ETH/USD. Both
 * entries are here precisely because they behave differently — measured, USDG
 * prices ETH at 1927.9 against a stats feed saying 1930.5 (0.13% out, with
 * liquidity), and USDE prices it at 1737.7 with zero liquidity, which the check
 * rejects. A list that only contained things that pass would not prove the check
 * runs.
 *
 * Extend with UNISWAP_V3_QUOTE_TOKENS (comma-separated addresses) rather than by
 * editing this file: a new candidate still has to pass the same verification, so
 * adding one cannot introduce an impostor.
 */
const DEFAULT_STABLE_CANDIDATES = Object.freeze([
  "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", // "Global Dollar", 6 decimals
  "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34", // "Ethena USDe", 18 decimals
]);

/**
 * The fee tiers Uniswap v3 ships with. EVERY ONE OF THEM IS READ, EVERY TIME, and
 * the order below is presentation only — a tie-break for two pools that measure
 * identically, and nothing else.
 *
 * THIS LIST USED TO BE A SELECTION RULE, AND THAT WAS A FREE ATTACK. resolvePool
 * returned inside the loop on the first tier the factory answered for, so the pool
 * that got priced was the first EXISTING one rather than the deepest one.
 * UniswapV3Factory.createPool is permissionless: anyone can deploy an empty pool
 * for a token they have nothing to do with, at a tier earlier in this list, for one
 * gas-only transaction and no capital. Measured on chain 4663, The Green Bull
 * 0x31be…bf81 has its real pool at tier 10000 and an EMPTY 3000 slot; a decoy there
 * would have taken its measured depth from $69,990 to zero — a measured zero, so
 * every "unmeasured" protection downstream stays silent — and flipped the ticker
 * verdict from "dominant" to "shallow, nothing wearing VLAD has a market".
 *
 * Sweeping every tier and ranking on the measurement removes the attack rather
 * than raising its price: an empty pool loses to a funded one on the only axis that
 * decides, so a decoy costs its author gas and buys them nothing.
 */
const FEE_TIERS = Object.freeze([3000, 10000, 500, 100]);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * WHERE TO LOOK FOR THE UNISWAP V4 POOLMANAGER — a candidate to be verified, not a
 * fact, and the distinction is the whole design of resolveV4PoolManager below.
 *
 * WHY THIS ADDRESS MATTERS AT ALL, from a reproduced user complaint. holder_overlap
 * on PIPECAT + MERRYMEN returned 0x8366a39c… as the most interesting "wallet" in the
 * overlap — the largest position on the table. It is not a wallet. Measured live on
 * chain 4663 it holds 24,009 bytes of bytecode, was deployed by the CREATE2 factory
 * 0x4e59b448…, answers extsload(bytes32) and protocolFeeController() ->
 * 0x6d000950…, and owner() -> 0x2BAD8182…: it is the Uniswap v4 PoolManager
 * singleton. Uniswap v4 keeps EVERY pool in that one contract and custodies every
 * token in it, so the same address is a large holder of many unrelated tokens — which
 * is exactly what made it look like somebody with a conviction position in two of
 * them. Measured, it holds 50.5% of PIPECAT's supply and 0.7% of MERRYMEN's.
 *
 * WHY lib/holder-history.js COULD NOT SEE IT. Pools are identified there through
 * resolvePool, which is a v3 design: a factory that maps a token pair to a per-pool
 * CONTRACT, and a pool contract that answers token0()/token1(). The v4 singleton has
 * no token0() — there is no pair to name, because it holds all of them — so no amount
 * of factory sweeping can ever surface it.
 *
 * WHY THE ADDRESS IS ONLY A CANDIDATE. This codebase's rule is that identity comes
 * from what a contract IS — the deployer for an equity token, the pool role for a
 * market — and never from its name or from a list, because a list is stale the moment
 * a second chain or a second deployment appears. So this address is where to LOOK,
 * and resolveV4PoolManager decides whether what is there actually behaves like the
 * singleton. Overridable with UNISWAP_V4_POOL_MANAGER for configuration; an override
 * still has to pass the same check, so pointing it at the wrong contract cannot
 * mislabel that contract as a pool.
 */
const DEFAULT_V4_POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";

/* --------------------------------- limits -------------------------------- */

/**
 * How many holder addresses may be probed for pool-ness in the fallback.
 *
 * The pool is a top holder of its own token — it custodies the entire tradable
 * side — so it is at or near the head of the list every time it exists at all.
 * Measured on VLAD it is rank 1 of 7,636 holders. Eight is a handful with room to
 * spare; probing the whole list would be four RPC calls per holder against a
 * rate-limited endpoint to find something that was never past rank two.
 */
const MAX_HOLDER_PROBES = 8;

/**
 * Below this much REALISABLE quote-side depth, inside the RANKING band, a pool price
 * is arithmetic rather than a market. It is still returned — suppressing it would be
 * inventing an absence — but it is flagged so the caller can say so.
 *
 * $200 AND NOT $1,000, AND THE CHANGE IS A UNIT CONVERSION RATHER THAN A CONCESSION.
 * The floor was $1,000 while the ranking figure was the -10% band; the ranking figure
 * is now the -2% band (lib/tick-depth.js RANK_BAND_BPS), which is a strictly smaller
 * quantity measured on the same pool, so leaving the number alone would have been
 * silently tightening the bar by five-fold — a threshold calibrated for one measure
 * left standing in front of another.
 *
 * WHERE 5× COMES FROM. For a pool with constant liquidity across both bands the
 * quote released scales as 1 - sqrt(1 - x): 1 - sqrt(0.90) = 0.051317 against
 * 1 - sqrt(0.98) = 0.010051, a ratio of 5.1058. That is band geometry, not a fitted
 * constant. The live Green Bull pool, whose liquidity IS one wide range, reads
 * $1,324.23 and $259.33 — a ratio of 5.1063, agreeing to 1 part in 10,000. So
 * $1,000 at -10% is $195.9 at -2%, rounded to $200.
 *
 * IT IS NOT A FLOOR LOWERED TO KEEP A WINNER. The test of that is the MARGIN, and
 * the margin is unchanged: The Green Bull cleared $1,000 by 1.32× on the old measure
 * and clears $200 by 1.30× on the new one. It is still the only contract wearing VLAD
 * that clears it at all, and it still clears it barely — which is the honest reading
 * of a pool holding $69,679 that gives up $259 before the price has moved 2%.
 *
 * The number was never theoretical either. The VLAD pool holds 900M VLAD ($364K at
 * its own quoted price) against 0.00203 WETH ($3.92). The price it quotes is correct
 * and the amount of it you could actually realise is four dollars. A caller handed
 * "$405K market cap" with no liquidity beside it would be reporting the first number
 * and hiding the second.
 */
const THIN_LIQUIDITY_USD = 200;

/**
 * How many DISTINCT pools one token may have measured before the sweep stops.
 *
 * Four fee tiers times up to three verified quote assets is twelve factory slots,
 * and a token with twelve funded pools does not exist on this chain — the measured
 * maximum is one. The bound is here so a token that somehow has more cannot turn
 * one lookup into an unbounded crawl, and it is above any plausible real count so
 * it never silently drops the deepest pool.
 */
const MAX_POOLS_MEASURED = 12;

/** Bound on the immutable-fact cache, same reasoning as lib/indexer-cache.js. */
const MAX_FACT_ENTRIES = 500;

/**
 * A stablecoin candidate has to price ETH within this fraction of the stats feed
 * to be accepted as a dollar. Wide enough that a real peg drifting, a thin pool
 * and a few seconds of staleness all pass; narrow enough that the impostors —
 * measured at 7.4e7 and 1.0e10 units per ETH — cannot.
 */
const PEG_TOLERANCE = 0.25;

/**
 * How much BAND DEPTH a stablecoin candidate's WETH pool must carry before it may
 * price other tokens.
 *
 * IT USED TO BE `liquidity > 0`, AND THAT WAS ONE WEI. verifyStableQuote also
 * RETURNED INSIDE ITS FEE-TIER LOOP — the exact shape removed from resolvePool —
 * so the first tier that answered won whatever it held. Measured: one wei of L in a
 * decoy USDG/WETH pool at tier 3000 was reached before the real pool at 500 and
 * captured the quote asset, which sets the dollar value of every token priced
 * through it. The bar is now a real quantity and the sweep ranks on it.
 *
 * Twice THIN_LIQUIDITY_USD rather than equal to it: this is not "is the price
 * meaningful", it is "may this contract define the dollar", and getting that wrong
 * mismarks a whole class of tokens rather than one. It is still far below any honest
 * peg pool worth routing through.
 *
 * $400 AND NOT $2,000, FOR THE SAME REASON AND BY THE SAME ARITHMETIC as
 * THIN_LIQUIDITY_USD: the bar is now read against the RANKING band (-2%) rather than
 * the wide one, and 2,000 / 5.1058 is $391.7, rounded to $400. The bar deliberately
 * moved to the tight band rather than staying on the wide one, because the wide band
 * is the figure that can be inflated by parking capital at its edge — and a decoy
 * that captures the QUOTE ASSET sets the dollar value of every token priced through
 * it, which is the largest blast radius any single measurement here has.
 */
const MIN_STABLE_QUOTE_DEPTH_USD = 400;

/* ---------------------------------- ABIs --------------------------------- */

const FACTORY_ABI = Object.freeze([
  {
    name: "getPool",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "fee", type: "uint24" },
    ],
    outputs: [{ name: "pool", type: "address" }],
  },
]);

const POOL_ABI = Object.freeze([
  { name: "token0", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "token1", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "fee", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
  { name: "liquidity", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint128" }] },
  {
    name: "slot0",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
]);

/**
 * The two functions that identify a Uniswap v4 PoolManager BY BEHAVIOUR.
 *
 * extsload(bytes32) is v4's whole state-reading interface — the singleton holds every
 * pool in one storage map and exposes it by slot, which is why it needs the function
 * and why nothing shaped like a v3 pool has it. protocolFeeController() is the other
 * half: an owner-set fee recipient that exists on the manager and on nothing else in
 * this module's world. Two positives, because one selector answering could be a
 * collision and two agreeing could not plausibly be.
 *
 * The NEGATIVE half of the check reuses POOL_ABI's token0/token1 — see
 * resolveV4PoolManager for why an absence is load-bearing here.
 */
const V4_MANAGER_ABI = Object.freeze([
  {
    name: "extsload",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "slot", type: "bytes32" }],
    outputs: [{ type: "bytes32" }],
  },
  { name: "protocolFeeController", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
]);

/** The slot extsload is probed with. Any slot proves the function exists; zero is cheapest to write. */
const ZERO_SLOT = `0x${"0".repeat(64)}`;

const ERC20_ABI = Object.freeze([
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
]);

/* -------------------------------- failures ------------------------------- */

/**
 * Every way this module can decline to produce a price, each with the sentence a
 * caller should show. The codes exist so the distinctions survive: "nothing trades
 * this on Uniswap v3 here" and "we could not read the pool" are different facts
 * about the world, and collapsing the second into the first tells the user
 * something false about the chain — the same mistake as reading an outage as an
 * absence, one layer down.
 */
const REASONS = Object.freeze({
  no_pool:
    "No Uniswap v3 pool for this token against any verified quote asset on Robinhood Chain, so it has no on-chain market price here. Unpriced is not priced at zero.",
  discovery_failed:
    "The pool lookup did not complete — the RPC and the indexer both failed to answer — so whether this token has a Uniswap v3 pool is unknown. This is an outage, not a token without a market.",
  no_client:
    "No RPC client was supplied to the pool reader, so the chain was never asked whether this token has a Uniswap v3 pool. That is a fault in the calling code, not an outage and not a token without a market.",
  pool_read_failed:
    "A Uniswap v3 pool for this token exists, but its state could not be read, so no price could be derived. The price exists; we could not fetch it.",
  depth_inconclusive:
    "This token has more than one Uniswap v3 pool, and which of them is the deepest was NOT established: a pool that ranked below the leader reported a LOWER BOUND — its tick walk was capped by the read budget — so its real depth may exceed the leader's. Every pool was read; what is missing is exactness, not data. A figure that understates cannot be shown to have lost, so no pool was chosen and no price is stated from one. This is an unresolved comparison, not a token without a market.",
  pool_not_initialised:
    "The Uniswap v3 pool for this token exists but has never been initialised — it holds no price yet. That is an empty pool, not a price of zero.",
  quote_unverified:
    "A verified quote asset could not be re-verified this call — the stablecoin's own WETH pool did not answer — so the tiers priced against it were never swept. Whether this token has a pool there is UNKNOWN. This is an outage, not a token without a market.",
  no_eth_price:
    "The pool gave a price in its quote asset, but the ETH/USD rate could not be read, so it could not be converted to dollars. No fallback rate is used, because a guessed ETH price would misprice every token on the chain.",
  price_out_of_range:
    "The pool's price is outside the range a double can represent, so no dollar figure can be stated for it honestly.",
  bad_address: "That is not a contract address, so it has no pool to read.",
});

/** Pair a failure code with its sentence. */
function fail(reason, extra = {}) {
  return { ok: false, reason, detail: REASONS[reason] ?? null, source: "uniswap_v3", ...extra };
}

/* ------------------------------ small helpers ---------------------------- */

/** A 20-byte hex address, lowercased, or null. Everything else is not an address. */
function normalizeAddress(raw) {
  const s = String(raw ?? "").trim();
  return /^0x[0-9a-fA-F]{40}$/.test(s) ? s.toLowerCase() : null;
}

/** Case-insensitive address compare — the chain mixes case, our keys do not. */
function sameAddress(a, b) {
  const x = normalizeAddress(a);
  const y = normalizeAddress(b);
  return x !== null && x === y;
}

/** The zero address means "no such pool", not "a pool at zero". */
function isZeroAddress(a) {
  return sameAddress(a, ZERO_ADDRESS);
}

/** Configured factory, env override first. A junk override falls back rather than breaking every read. */
function factoryAddress() {
  return normalizeAddress(process.env.UNISWAP_V3_FACTORY) ?? DEFAULT_FACTORY.toLowerCase();
}

/**
 * Configured WETH, env override first, same fallback rule.
 *
 * Exported because the cost-basis walk needs the same answer this module uses: a
 * third hard-coded copy would keep working right up until ROBINHOOD_WETH is set,
 * and then price trades against a contract nothing else on the chain agrees is
 * the numeraire.
 */
export function wethAddress() {
  return normalizeAddress(process.env.ROBINHOOD_WETH) ?? DEFAULT_WETH.toLowerCase();
}

/** Where to look for the v4 PoolManager, env override first. Still unverified here. */
function v4PoolManagerCandidate() {
  return normalizeAddress(process.env.UNISWAP_V4_POOL_MANAGER) ?? DEFAULT_V4_POOL_MANAGER.toLowerCase();
}

/** Stablecoin candidates: the built-ins plus any from env. Still all unverified here. */
function stableCandidates() {
  const extra = String(process.env.UNISWAP_V3_QUOTE_TOKENS ?? "")
    .split(",")
    .map(normalizeAddress)
    .filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const a of [...extra, ...DEFAULT_STABLE_CANDIDATES.map((x) => x.toLowerCase())]) {
    if (seen.has(a)) continue;
    seen.add(a);
    out.push(a);
  }
  return out;
}

/**
 * Run a read without letting it fail the whole gather, the same shape as
 * lib/ask-evidence.js attempt(). A thunk rather than a promise so a getter that
 * throws synchronously — a bad client, a malformed address — is caught too.
 */
async function attempt(thunk) {
  try {
    return { ok: true, value: await thunk() };
  } catch {
    return { ok: false, value: null };
  }
}

/* ----------------------------- immutable facts --------------------------- */

/**
 * Facts that cannot change: which pool a (token, quote, fee) triple maps to, a
 * pool's token0/token1/fee, an ERC-20's decimals. Uniswap v3 pools are deployed
 * at a deterministic address and never migrate, and decimals is immutable by the
 * standard. Caching these for the process lifetime is not a staleness risk in the
 * way a price is — there is no newer value to miss.
 *
 * ABSENCE is deliberately not stored here. "No pool at this fee tier" is a fact
 * that expires the moment somebody deploys one, so negatives go through the short
 * TTL cache below instead. A permanent negative would make a new pool invisible
 * until the process restarted.
 */
const facts = new Map();

function factGet(key) {
  if (!facts.has(key)) return undefined;
  const value = facts.get(key);
  // Re-insert so insertion order stays recency order for the eviction below.
  facts.delete(key);
  facts.set(key, value);
  return value;
}

function factSet(key, value) {
  if (facts.size >= MAX_FACT_ENTRIES) {
    for (const k of facts.keys()) {
      if (facts.size < MAX_FACT_ENTRIES) break;
      facts.delete(k);
    }
  }
  facts.set(key, value);
  return value;
}

/**
 * Drop the immutable-fact cache. For tests, and for the "read it fresh" escape
 * hatch when a chain has been forked or an env override changed underneath us.
 */
export function resetDexCache() {
  facts.clear();
}

/**
 * Volatile reads — slot0, pool balances, a failed pool lookup — go through the
 * shared indexer cache on the PRICE TTL rather than the default minute.
 *
 * Reusing lib/indexer-cache.js for RPC reads is deliberate: the contract it
 * enforces is exactly the one wanted here — a successful read is held briefly, a
 * failure is never held at all, and concurrent duplicates collapse into one call.
 * Rebuilding that would mean rebuilding the part that must never cache an outage.
 * Keys are namespaced "dex:" so they cannot collide with a real indexer URL.
 *
 * @param {string} key
 * @param {() => Promise<object>} fetcher - must resolve to an OBJECT; the cache
 *   only stores objects, so a bare value would silently never be cached.
 */
function cachedRead(key, fetcher) {
  return withIndexerCache(`dex:${key}`, fetcher, { ttlMs: priceCacheTtlMs() });
}

/* ------------------------------- BigInt math ----------------------------- */

const Q96 = 2n ** 96n;
const Q192 = Q96 * Q96;

/** Decimal digit count of a positive BigInt. */
function digitCount(x) {
  return x === 0n ? 1 : x.toString().length;
}

/** Significant digits kept when crossing from BigInt to Number. */
const TARGET_DIGITS = 20;

/**
 * num / den as a Number, without letting a huge or tiny intermediate become
 * Infinity or 0 on the way.
 *
 * WHY NOT Number(num) / Number(den). sqrtPriceX96 squared is routinely past 2^300
 * and Q192 is 2^192; both cast to finite doubles, but the ratio of two rounded
 * doubles that large throws away the digits that matter, and a decimals
 * adjustment of 10^18 on either side pushes one of them past 1.8e308 and turns
 * the whole price into Infinity or 0. A 1e-30 price and a 1e30 price are both
 * perfectly real on this chain — a token with 18 decimals quoted against one with
 * 6 spans exactly that — so the exponent has to be carried separately from the
 * mantissa the whole way.
 *
 * The division is done in BigInt at a fixed 20 significant digits, then the
 * mantissa and the power of ten are applied separately, in steps small enough
 * that neither leg overflows on its own. A true overflow or underflow returns
 * NULL, never 0 and never Infinity: a price too small to represent is a price we
 * cannot state, and "0" is the one answer that would be read as a fact.
 *
 * @param {bigint} num
 * @param {bigint} den
 * @returns {number|null}
 */
export function bigRatioToNumber(num, den) {
  if (typeof num !== "bigint" || typeof den !== "bigint") return null;
  if (den === 0n) return null;
  const negative = num < 0n !== den < 0n;
  const n = num < 0n ? -num : num;
  const d = den < 0n ? -den : den;
  if (n === 0n) return 0;

  // Shift so the integer quotient carries ~TARGET_DIGITS digits, whichever side
  // of 1 the true value sits on.
  const shift = TARGET_DIGITS - (digitCount(n) - digitCount(d));
  let quotient;
  if (shift > 0) quotient = (n * 10n ** BigInt(shift)) / d;
  else if (shift < 0) quotient = n / (d * 10n ** BigInt(-shift));
  else quotient = n / d;
  if (quotient === 0n) return null;

  let value = Number(quotient);
  if (!Number.isFinite(value)) return null;

  // Undo the shift by DIVIDING, never by multiplying by a negative power of ten.
  // 10 ** -17 is not exactly representable, so `1e20 * 10 ** -17` is
  // 999.9999999999999 where `1e20 / 10 ** 17` is exactly 1000. Every figure this
  // module produces is money, and a supply of 1000 reported as 999.9999999999999
  // is the kind of thing that ends up quoted verbatim.
  //
  // Bounded steps because the exponent can be hundreds: a single 10 ** 400 is
  // Infinity before it ever meets the mantissa, and a single 10 ** -400 is 0.
  let exponent = shift;
  while (exponent > 0) {
    const step = Math.min(exponent, 300);
    value /= 10 ** step;
    exponent -= step;
    if (value === 0) return null;
  }
  while (exponent < 0) {
    const step = Math.min(-exponent, 300);
    value *= 10 ** step;
    exponent += step;
    if (!Number.isFinite(value)) return null;
  }
  if (!Number.isFinite(value) || value === 0) return null;
  return negative ? -value : value;
}

/**
 * Human-units price of `target` denominated in the other token of the pair.
 *
 * The verified identity is price(token1 per token0) = (sqrtPriceX96 / 2^96)^2,
 * corrected for the decimals DIFFERENCE between the two tokens. Written as an
 * exact ratio that is what this is:
 *
 *   token1 per token0 = sqrtPriceX96^2 * 10^d0 / (2^192 * 10^d1)
 *
 * and the target being token1 rather than token0 inverts it — numerator and
 * denominator swap, nothing else. Both decimals are READ from their contracts;
 * 18 is a convention, not a rule, and the USDG quote on this chain has 6.
 *
 * @param {bigint} sqrtPriceX96
 * @param {number} decimals0
 * @param {number} decimals1
 * @param {boolean} targetIsToken0
 * @returns {number|null} null when the price is not representable, never 0
 */
export function priceFromSqrtX96(sqrtPriceX96, decimals0, decimals1, targetIsToken0) {
  if (typeof sqrtPriceX96 !== "bigint" || sqrtPriceX96 <= 0n) return null;
  const d0 = Number(decimals0);
  const d1 = Number(decimals1);
  if (!Number.isInteger(d0) || !Number.isInteger(d1) || d0 < 0 || d1 < 0 || d0 > 77 || d1 > 77) return null;
  const numerator = sqrtPriceX96 * sqrtPriceX96 * 10n ** BigInt(d0);
  const denominator = Q192 * 10n ** BigInt(d1);
  return targetIsToken0
    ? bigRatioToNumber(numerator, denominator)
    : bigRatioToNumber(denominator, numerator);
}

/* ------------------------------- chain reads ----------------------------- */

/** decimals() for an ERC-20, cached forever. Null when it cannot be read. */
async function readDecimals(client, token) {
  const address = normalizeAddress(token);
  if (!address) return null;
  const key = `decimals:${address}`;
  const cached = factGet(key);
  if (cached !== undefined) return cached;
  const res = await attempt(() =>
    client.readContract({ address, abi: ERC20_ABI, functionName: "decimals" }),
  );
  if (!res.ok) return null; // NOT cached: a failed read is not a fact about the token.
  const n = Number(res.value);
  if (!Number.isInteger(n) || n < 0 || n > 77) return null;
  return factSet(key, n);
}

/** token0/token1/fee for a pool, cached forever — they are set at deployment. */
async function readPoolPair(client, pool) {
  const address = normalizeAddress(pool);
  if (!address) return null;
  const key = `pair:${address}`;
  const cached = factGet(key);
  if (cached !== undefined) return cached;
  const [t0, t1, fee] = await Promise.all([
    attempt(() => client.readContract({ address, abi: POOL_ABI, functionName: "token0" })),
    attempt(() => client.readContract({ address, abi: POOL_ABI, functionName: "token1" })),
    attempt(() => client.readContract({ address, abi: POOL_ABI, functionName: "fee" })),
  ]);
  if (!t0.ok || !t1.ok || !fee.ok) return null;
  const token0 = normalizeAddress(t0.value);
  const token1 = normalizeAddress(t1.value);
  if (!token0 || !token1) return null;
  return factSet(key, { token0, token1, fee: Number(fee.value) });
}

/**
 * IS THE CONFIGURED ADDRESS ACTUALLY THE UNISWAP V4 POOLMANAGER — asked of the chain,
 * once per process, and answered with three outcomes that are three different facts.
 *
 * WHAT IT IS FOR. lib/holder-history.js classifyRole is the single definition of "this
 * is a pool, not a position", and it could not see the v4 singleton at all (see
 * DEFAULT_V4_POOL_MANAGER for the measured complaint that produced this). It now asks
 * this function for the one extra address it needs. Nothing here prices a v4 pool: this
 * module still reads v3 only, and a token whose market is v4 remains unpriced. What
 * changes is that its LIQUIDITY stops being presented as somebody's wallet.
 *
 * THE CHECK IS BEHAVIOURAL, IN BOTH DIRECTIONS, and both halves are load bearing:
 *
 *   POSITIVE — extsload(bytes32) AND protocolFeeController() both answer. Those are
 *     v4 manager functions; a v3 pool, a v3 factory and an ERC-20 all revert on them,
 *     verified live against 0x1f7d7550… (the factory) and 0x31be…bf81 (a token).
 *   NEGATIVE — token0() and token1() must NOT answer. This is what makes the verdict
 *     "a SINGLETON that holds every pair" rather than "a pool contract": a v4 manager
 *     has no pair to name, and anything that does name one is a per-pool contract that
 *     resolvePool's own sweep is the right instrument for.
 *
 * THREE OUTCOMES:
 *   "confirmed" — both positives, both negatives. `address` is set, and classifyRole
 *     may label a balance there as liquidity.
 *   "rejected"  — it answered token0()/token1(), so whatever lives there is a pool
 *     contract or a token and NOT the singleton. A real negative, cached for the
 *     process: bytecode at an address does not change.
 *   "unread"    — nothing answered, or only one of the two positives did. An RPC
 *     brownout and a wrong address are indistinguishable from here, so neither is
 *     asserted, NOTHING IS CACHED AT ALL (not even for the short window — see the
 *     throw below), and the caller reports that a row it labelled a wallet may still
 *     be v4 liquidity. An outage must not read as an absence, which is the same rule
 *     the rest of this file is built on.
 *
 * COST, AND WHY IT IS NOT PER HOLDER. Four eth_calls, once. A confirmed or rejected
 * verdict goes in the immutable fact map and is free for the life of the process; while
 * that is cold, the verdict goes through cachedRead, whose single-flight gate collapses
 * every concurrent asker in one request into ONE round trip. So a 60-holder overlap
 * that asks about the singleton sixty times pays for it once.
 *
 * @param {{ client?: object }} [options]
 * @returns {Promise<{ address: string|null, candidate: string, status: "confirmed"|"rejected"|"unread", reason: string|null }>}
 */
export async function resolveV4PoolManager(options = {}) {
  const candidate = v4PoolManagerCandidate();
  const client = options.client;
  if (!client || typeof client.readContract !== "function") {
    // A PROGRAMMING ERROR, not an outage — the same distinction resolvePool draws for
    // its own missing client, and for the same reason: reported as a brownout it would
    // make every v4 pool on the chain look like a permanent RPC failure.
    return {
      address: null,
      candidate,
      status: "unread",
      reason: "no RPC client was supplied, so the chain was never asked whether this address is the Uniswap v4 PoolManager",
    };
  }

  const key = `v4manager:${candidate}`;
  const known = factGet(key);
  if (known !== undefined) return known;

  /**
   * Why the unread reason travels in a variable and the unread verdict travels as a
   * THROW: cachedRead stores whatever the fetcher returns, and an "unread" verdict is a
   * failure wearing a value's clothes. Stored for even ten seconds it would let one
   * brownout answer the next question without asking — a cached outage, which is the
   * one thing lib/indexer-cache.js exists to refuse. Throwing keeps it out of both
   * caches; the reason is carried out here so the sentence stays specific.
   */
  let unreadReason = null;
  const res = await attempt(() =>
    cachedRead(key, async () => {
      // One wave of four calls: two selectors that must answer and two that must not.
      const [ext, controller, token0, token1] = await Promise.all([
        attempt(() =>
          client.readContract({ address: candidate, abi: V4_MANAGER_ABI, functionName: "extsload", args: [ZERO_SLOT] }),
        ),
        attempt(() =>
          client.readContract({ address: candidate, abi: V4_MANAGER_ABI, functionName: "protocolFeeController" }),
        ),
        attempt(() => client.readContract({ address: candidate, abi: POOL_ABI, functionName: "token0" })),
        attempt(() => client.readContract({ address: candidate, abi: POOL_ABI, functionName: "token1" })),
      ]);
      if (token0.ok || token1.ok) {
        return {
          status: "rejected",
          reason: "the address answers token0()/token1(), so it is a per-pool contract or a token and not the v4 PoolManager singleton",
        };
      }
      if (ext.ok && controller.ok) return { status: "confirmed", reason: null };
      unreadReason =
        ext.ok || controller.ok
          ? "the address answered only one of extsload(bytes32) and protocolFeeController(), so whether it is the v4 PoolManager did not settle"
          : "neither extsload(bytes32) nor protocolFeeController() answered, so whether this address is the v4 PoolManager is unknown — an unreachable RPC and a wrong address look the same from here";
      throw new Error("v4 pool manager check did not settle");
    }),
  );
  if (!res.ok || !res.value) {
    return {
      address: null,
      candidate,
      status: "unread",
      // The generic sentence is what a JOINER gets: single-flight hands it the leader's
      // rejection, not the leader's local variable. Still unread, still unknown.
      reason:
        unreadReason ??
        "the v4 PoolManager check did not complete, so whether that address is the singleton is unknown",
    };
  }

  const verdict = {
    address: res.value.status === "confirmed" ? candidate : null,
    candidate,
    status: res.value.status,
    reason: res.value.reason ?? null,
  };
  // Only a settled verdict is a FACT. An unread one goes no further than cachedRead's
  // short window, so a brownout cannot harden into "there is no v4 pool manager here".
  if (verdict.status !== "unread") factSet(key, verdict);
  return verdict;
}

/**
 * factory.getPool(tokenA, tokenB, fee). Three outcomes, kept apart: an address,
 * "no pool at this tier" (the zero address), and "could not ask" (a throw).
 *
 * Two caches, on purpose. A pool ADDRESS is permanent — v3 deploys pools at a
 * deterministic address and they never migrate — so it goes in the fact map. An
 * ABSENCE is only true until somebody deploys one, so it goes through the short
 * TTL instead: long enough that a single price call does not re-ask the same
 * four fee tiers for every quote asset it considers, short enough that a new pool
 * shows up within seconds. A THROW is cached by neither, so an unreachable
 * factory never hardens into "no pool exists".
 *
 * The key is order-normalised because getPool itself is: (A,B,fee) and (B,A,fee)
 * are the same question and must not cost two lookups or two cache entries.
 *
 * @returns {Promise<{ ok: boolean, pool: string|null }>}
 */
async function readFactoryPool(client, tokenA, tokenB, fee) {
  const address = factoryAddress();
  const a = normalizeAddress(tokenA);
  const b = normalizeAddress(tokenB);
  if (!a || !b) return { ok: false, pool: null };
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const key = `pool:${address}:${lo}:${hi}:${fee}`;

  const known = factGet(key);
  if (known !== undefined) return { ok: true, pool: known };

  const res = await attempt(() =>
    cachedRead(key, async () => {
      const value = await client.readContract({
        address,
        abi: FACTORY_ABI,
        functionName: "getPool",
        args: [a, b, fee],
      });
      return { pool: isZeroAddress(value) ? null : normalizeAddress(value) };
    }),
  );
  if (!res.ok || !res.value) return { ok: false, pool: null };
  return res.value.pool ? { ok: true, pool: factSet(key, res.value.pool) } : { ok: true, pool: null };
}

/** slot0, on the short price TTL. Returns the sqrt price as a decimal STRING so it survives the cache's structuredClone. */
async function readSlot0(client, pool) {
  const address = normalizeAddress(pool);
  if (!address) return null;
  const res = await attempt(() =>
    cachedRead(`slot0:${address}`, async () => {
      const s = await client.readContract({ address, abi: POOL_ABI, functionName: "slot0" });
      // viem returns a tuple for a multi-output function; a fake client may return
      // the same shape as an object. Accept both rather than making tests lie.
      const sqrt = Array.isArray(s) ? s[0] : s?.sqrtPriceX96;
      const tick = Array.isArray(s) ? s[1] : s?.tick;
      return { sqrtPriceX96: String(sqrt ?? ""), tick: tick == null ? null : Number(tick) };
    }),
  );
  if (!res.ok || !res.value) return null;
  let sqrtPriceX96;
  try {
    sqrtPriceX96 = BigInt(res.value.sqrtPriceX96);
  } catch {
    return null;
  }
  return { sqrtPriceX96, tick: res.value.tick };
}

/**
 * liquidity() — the pool's ACTIVE liquidity, on the short price TTL.
 *
 * The one figure in a v3 pool that is scoped to the current price: L counts only
 * positions whose range spans the current tick. A position parked out of range
 * contributes nothing to it while still sitting in the pool's token balances,
 * which is exactly the difference this module now measures. Null on a failed read,
 * never 0 — an unread pool is unmeasured, not empty.
 */
async function readPoolLiquidity(client, pool) {
  const address = normalizeAddress(pool);
  if (!address) return null;
  const res = await attempt(() =>
    cachedRead(`liq:${address}`, async () => {
      const raw = await client.readContract({ address, abi: POOL_ABI, functionName: "liquidity" });
      return { raw: String(raw ?? "") };
    }),
  );
  if (!res.ok || !res.value) return null;
  try {
    const n = BigInt(res.value.raw);
    return n < 0n ? null : n;
  } catch {
    return null;
  }
}

/** balanceOf(pool) for one side of the pair, on the short price TTL. */
async function readPoolBalance(client, token, pool) {
  const res = await attempt(() =>
    cachedRead(`bal:${token}:${pool}`, async () => {
      const raw = await client.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [pool],
      });
      return { raw: String(raw) };
    }),
  );
  if (!res.ok || !res.value) return null;
  try {
    return BigInt(res.value.raw);
  } catch {
    return null;
  }
}

/**
 * tickSpacing() — immutable, set by the fee tier at deployment, so it goes in the
 * fact cache beside token0/token1/fee. Read from the POOL rather than mapped from
 * the fee tier: the mapping is a factory setting and a chain may have added tiers.
 */
async function readTickSpacing(client, pool) {
  const address = normalizeAddress(pool);
  if (!address) return null;
  const key = `spacing:${address}`;
  const cached = factGet(key);
  if (cached !== undefined) return cached;
  const res = await attempt(() =>
    client.readContract({ address, abi: TICK_ABI, functionName: "tickSpacing" }),
  );
  if (!res.ok) return null;
  const n = Number(res.value);
  if (!Number.isInteger(n) || n <= 0 || n > 100_000) return null;
  return factSet(key, n);
}

/** The block the reads landed on, when the client can say. Never invented. */
async function readBlockNumber(client) {
  if (typeof client?.getBlockNumber !== "function") return null;
  const res = await attempt(() => client.getBlockNumber());
  if (!res.ok || res.value == null) return null;
  const n = Number(res.value);
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------ tradeable depth --------------------------- */

/**
 * WHAT A SELLER COULD ACTUALLY REALISE — the figure this module ranks pools on,
 * and the only one any caller may call depth.
 *
 * IT IS AN INTEGRAL OVER THE TICK LADDER, not a reserve identity and not a
 * balance: the quote-token amount obtainable by selling the target into this pool
 * until the price has moved RANK_BAND_BPS against the seller. lib/tick-depth.js walks
 * the initialised ticks across that band, applies liquidityNet at each one, and
 * sums what each range actually holds.
 *
 * WHAT IT REPLACED, AND WHY THE OLD FIGURE WAS NOT A BOUND. Depth used to be
 * min(quote balance, the reserve implied by liquidity()). Those two are computed
 * over DISJOINT SETS OF POSITIONS — the balance covers every position, in range and
 * out; liquidity() covers only the ones spanning the current tick — so neither the
 * minimum nor either half bounded what could be traded. Two positions defeated it:
 * a hair-width position across the current tick (negligible capital, enormous L,
 * extrapolating to $366,525 in a pool holding $3.94) and a position parked entirely
 * above the tick (100% WETH, invisible to liquidity(), present in balanceOf, and
 * withdrawable at any time). Measured against the real code, parking 14 WETH behind
 * a $3.94 pool flipped the VLAD verdict to "ambiguous" with the squatter named the
 * winner, for about $2.96 a day of opportunity cost.
 *
 * Both halves fall out of the band integral structurally rather than by patch: the
 * parked position is outside the band and is never reached, and the hair-width
 * position contributes only the amount it holds because the walk STOPS at its upper
 * tick. See lib/tick-depth.js for what this does and does not prove — in short, it
 * moves the attacker's capital from a refundable deposit parked out of reach to
 * capital exposed in range at the market price. That is a cost, not immunity.
 *
 * THREE QUANTITIES COME OUT AND THEY ARE NOT INTERCHANGEABLE:
 *
 *   rankDepth (-2%)  — THE RANKING FIGURE. What a seller could realise before the
 *                      price has moved 2% against them: capital genuinely exposed to
 *                      being traded through at close to the market.
 *   wideDepth (-10%) — the same integral over 10%. REPORTED CONTEXT, never the
 *                      ranking figure, because capital sitting at the far edge of it
 *                      counts in full and is never traded through — measured, $1,324
 *                      placed one tick-spacing wide at -9.16% lifted the wide figure
 *                      by $1,328.05 and left the tight one at $3.92. Both travel,
 *                      because a pool deep at 10% and empty at 2% has its liquidity
 *                      parked at the edge and one number cannot say so.
 *   balance          — what the pool HOLDS on the quote side. A SEPARATE, LABELLED
 *                      QUANTITY. Nothing ranks on it, here or downstream; it exists
 *                      so the gap between held and realisable can be named.
 *
 * NULL, NEVER ZERO, NEVER A FALLBACK TO THE BALANCE. A ladder that could not be READ
 * — a bitmap word that did not answer, an unreadable spacing, a tick entry that threw
 * — is UNMEASURED depth. Unmeasured loses every comparison rather than winning one by
 * looking like a zero, and it never quietly becomes the balance, which is the figure
 * that could be rented.
 *
 * A TRUNCATED LADDER IS NOT AN UNREAD ONE. When the read budget caps the walk the
 * figure that comes back is a genuine integral over a shorter interval — a LOWER
 * BOUND — and it is flagged as one (`rankDepthIsLowerBound` / `wideDepthIsLowerBound`).
 * It may win a comparison outright and it may never lose one, because the true figure
 * is at least this large. That distinction is what removes the tick-count griefing
 * attack: dust minted into someone else's pool can shorten the covered range and
 * nothing more.
 *
 * SAME-TRANSACTION FLASH LIQUIDITY GENUINELY CANNOT MOVE THIS, and that one IS a
 * hard guarantee rather than a cost: every read here is of COMMITTED state at a
 * mined block.
 *
 * @returns {Promise<{ rankDepthUsd: number|null, rankDepthQuoteUnits: number|null,
 *   rankDepthIsLowerBound: boolean, rankDepthCoveredBandBps: number|null,
 *   wideDepthUsd: number|null,
 *   wideDepthQuoteUnits: number|null, wideDepthIsLowerBound: boolean,
 *   balanceUsd: number|null, balanceQuoteUnits: number|null,
 *   rankBandBps: number, wideBandBps: number, ladderRead: boolean,
 *   ladderTruncated: boolean }>}
 */
async function measurePoolDepth(client, pool, pair, quote, options = {}) {
  // Which bands to integrate. Defaults to both; a caller that only needs the ranking
  // figure says so and pays for a FIFTH of the tick range, because the read range is
  // set by the widest band asked for. verifyStableQuote is that caller.
  const bands = Array.isArray(options.bands) && options.bands.length ? options.bands : [WIDE_BAND_BPS, RANK_BAND_BPS];
  const wantsWide = bands.includes(WIDE_BAND_BPS);
  const none = {
    rankDepthUsd: null,
    rankDepthQuoteUnits: null,
    rankDepthIsLowerBound: false,
    rankDepthCoveredBandBps: null,
    wideDepthUsd: null,
    wideDepthQuoteUnits: null,
    wideDepthIsLowerBound: false,
    balanceUsd: null,
    balanceQuoteUnits: null,
    rankBandBps: RANK_BAND_BPS,
    wideBandBps: WIDE_BAND_BPS,
    ladderRead: false,
    ladderTruncated: false,
  };
  const quoteIsToken0 = sameAddress(pair.token0, quote.address);
  const quoteIsToken1 = sameAddress(pair.token1, quote.address);
  if (!quoteIsToken0 && !quoteIsToken1) return none;
  const decimals = Number(quote.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) return none;
  const scale = 10n ** BigInt(decimals);

  const [balanceRaw, liquidity, slot0, tickSpacing] = await Promise.all([
    readPoolBalance(client, quote.address, pool),
    readPoolLiquidity(client, pool),
    readSlot0(client, pool),
    readTickSpacing(client, pool),
  ]);

  const balanceQuoteUnits = balanceRaw === null ? null : bigRatioToNumber(balanceRaw, scale);
  // A zero balance is a REAL zero — the read succeeded and the pool holds nothing —
  // so it must survive bigRatioToNumber's "too small to represent" null.
  const balanceUnits = balanceRaw === 0n ? 0 : balanceQuoteUnits;

  const readable =
    liquidity !== null &&
    tickSpacing !== null &&
    slot0 !== null &&
    slot0.sqrtPriceX96 > 0n &&
    Number.isInteger(slot0.tick);

  const measured = readable
    ? await measureBandDepth(
        client,
        pool,
        {
          sqrtPriceX96: slot0.sqrtPriceX96,
          tick: slot0.tick,
          liquidity,
          tickSpacing,
          quoteIsToken0,
        },
        { bands, cachedRead },
      )
    : null;

  // A raw 0n is a MEASURED nothing — the ladder was read and the band is empty —
  // and it has to survive bigRatioToNumber's "too small to represent" null, which
  // is the one place a real zero and an unrepresentable value would collide.
  const toUnits = (raw) => (raw === undefined || raw === null ? null : raw === 0n ? 0 : bigRatioToNumber(raw, scale));
  const rankUnits = measured === null ? null : toUnits(measured.amounts[RANK_BAND_BPS]);
  // Null when the wide band was not ASKED FOR, which is unmeasured and not zero.
  const wideUnits = measured === null || !wantsWide ? null : toUnits(measured.amounts[WIDE_BAND_BPS]);

  const usdPerUnit = finiteOrNull(quote.usdPerUnit);
  return {
    rankDepthQuoteUnits: rankUnits,
    rankDepthUsd: mul(rankUnits, usdPerUnit),
    // TRUE means "at least this much", never "exactly this much". Carried per band
    // because a truncation that shortens the 10% walk usually leaves the 2% walk
    // untouched — coverage is measured outward from spot.
    rankDepthIsLowerBound: measured === null ? false : Boolean(measured.lowerBound[RANK_BAND_BPS]),
    // HOW MUCH OF THE BAND THE WALK ACTUALLY COVERED, in the band's own units, and only
    // when the ranking figure is a bound. A reader told a read was capped needs to know
    // what it does cover — "at least $31.26, out to 0.31% of the 2% band" is a
    // measurement they can place, where "capped" on its own is closer to silence.
    // Null when nothing was capped: there is no shorter interval to name.
    rankDepthCoveredBandBps:
      measured === null || !measured.lowerBound[RANK_BAND_BPS] ? null : finiteOrNull(measured.coveredBandBps),
    wideDepthQuoteUnits: wideUnits,
    wideDepthUsd: mul(wideUnits, usdPerUnit),
    wideDepthIsLowerBound: measured === null || !wantsWide ? false : Boolean(measured.lowerBound[WIDE_BAND_BPS]),
    balanceQuoteUnits: balanceUnits,
    balanceUsd: mul(balanceUnits, usdPerUnit),
    rankBandBps: RANK_BAND_BPS,
    wideBandBps: WIDE_BAND_BPS,
    ladderRead: measured !== null,
    ladderTruncated: measured === null ? false : Boolean(measured.ladderTruncated),
  };
}

/**
 * The RANKING depth of a measured pool as a comparable quantity: dollars when the
 * ETH/USD leg was readable, raw quote units when it was not, null when the ladder
 * was not read at all.
 *
 * `lowerBound` TRAVELS WITH THE NUMBER and is not optional, for the reason
 * lib/depth-rank.js applyDepths gives one layer up: a figure that understates and a
 * figure that is exact support different conclusions, and the moment the two are
 * carried separately some comparison reads one without the other. Every consumer of
 * this shape gets both or neither.
 */
function measuredDepth(p) {
  const lowerBound = p?.depth?.rankDepthIsLowerBound === true;
  const usd = finiteOrNull(p?.depth?.rankDepthUsd);
  if (usd !== null) return { usd, units: finiteOrNull(p?.depth?.rankDepthQuoteUnits), lowerBound };
  const units = finiteOrNull(p?.depth?.rankDepthQuoteUnits);
  return units === null ? null : { usd: null, units, lowerBound };
}

/**
 * Is this pool's ranking figure only "AT LEAST THIS MUCH"?
 *
 * True when the tick walk was capped by its read budget, so the integral came back
 * over a shorter interval than the band it names. See lib/tick-depth.js: an attacker
 * minting dust into someone else's pool can shorten that interval and can do nothing
 * else, which is why truncation caps rather than refuses.
 *
 * A pool whose ladder was never read at all is NOT a lower bound — it has no figure to
 * be a bound on. That case is poolUnmeasured, and it is handled separately, because
 * "unknown" and "at least $X" are different states calling for different refusals.
 */
function poolDepthIsLowerBound(p) {
  const m = measuredDepth(p);
  return m !== null && m.lowerBound === true;
}

/** The -10% figure, used ONLY to break a tie between two pools equal on the ranking one. */
function wideDepth(p) {
  const usd = finiteOrNull(p?.depth?.wideDepthUsd);
  if (usd !== null) return { usd, units: finiteOrNull(p?.depth?.wideDepthQuoteUnits) };
  const units = finiteOrNull(p?.depth?.wideDepthQuoteUnits);
  return units === null ? null : { usd: null, units };
}

/** A pool whose ladder could not be read at all. Not shallow — UNKNOWN. */
function poolUnmeasured(p) {
  return measuredDepth(p) === null;
}

/**
 * Which of two pools for the same token is the deeper, as a sort compare.
 *
 * UNMEASURED SORTS LAST, which is this codebase's ordinary rule and no longer has an
 * exception here. There USED to be a three-class order that put an unmeasured pool
 * ABOVE a measured zero, on the reasoning that a pool proven to hold nothing is the
 * worst possible source for a price. That reasoning was right about measured ZEROES
 * and catastrophically wrong about everything else: it made "unmeasured" a rung on a
 * ladder rather than a stop condition, so any decoy holding a POSITIVE amount — a
 * decoy holding $4.5e-12 was enough — outranked an unread honest pool and captured
 * the price. Measured, that reported a price 100× wrong and a $40.48M cap against a
 * real $405K, and it triggered on an ordinary partial brownout.
 *
 * The empty-decoy case it was protecting against is now handled where it belongs:
 * resolvePool REFUSES TO PICK AT ALL when a rival pool went unread (see there), so a
 * measured zero never wins by default either. This compare only ever orders pools we
 * could actually measure; the unmeasured ones are pushed to the end so they cannot be
 * chosen, and the caller checks for their presence separately.
 *
 * Ranking depth first — dollars, the only figure comparable ACROSS quote assets. Two
 * pools that could not be priced in dollars are compared on the raw quote AMOUNT only
 * when they are quoted in the same asset: comparing 3 WETH against 3 USDG would be
 * arithmetic on two different units. The -10% figure breaks a tie on the ranking
 * figure and can never overturn one, so parking capital at the band edge cannot
 * promote a pool over one with more depth where it counts. Everything else falls
 * through to a stable, deterministic order (quote asset first, then the fee-tier
 * listing) so the same token resolves to the same pool on every call rather than
 * moving with whichever read settled first.
 *
 * THIS COMPARE ORDERS FIGURES; IT DOES NOT DECIDE WHETHER THE ORDER WAS ESTABLISHED.
 * A LOWER BOUND that comes out BELOW another pool has not been shown to be below it —
 * the true value is at least the figure and has no ceiling at all — so sorting it into
 * second place is a placement, not a finding. Sorting cannot express "inconclusive",
 * and inventing a preference here (bounds first, bounds last) would be inventing an
 * answer either way. So the ordering stays on the figures and resolvePool refuses to
 * SELECT when a losing pool's figure is a bound — the same division of labour the
 * unmeasured case already uses, and for the same reason.
 */
function deeperPool(a, b) {
  const ua = poolUnmeasured(a);
  const ub = poolUnmeasured(b);
  if (ua !== ub) return ua ? 1 : -1;

  const byRank = compareDepth(a, b, measuredDepth(a), measuredDepth(b));
  if (byRank !== 0) return byRank;
  const byWide = compareDepth(a, b, wideDepth(a), wideDepth(b));
  if (byWide !== 0) return byWide;

  if (a.quoteIndex !== b.quoteIndex) return a.quoteIndex - b.quoteIndex;
  return a.tierIndex - b.tierIndex;
}

/** Descending compare of two depth readings, dollars preferred, same-asset units next. */
function compareDepth(a, b, ma, mb) {
  if (ma === null || mb === null) return 0;
  if (ma.usd !== null && mb.usd !== null) {
    if (ma.usd !== mb.usd) return mb.usd > ma.usd ? 1 : -1;
    return 0;
  }
  if (sameAddress(a.quote.address, b.quote.address) && ma.units !== null && mb.units !== null) {
    if (ma.units !== mb.units) return mb.units > ma.units ? 1 : -1;
    return 0;
  }
  // One priced in dollars and one not: the priced one is the comparable figure.
  if (ma.usd !== mb.usd) return ma.usd === null ? 1 : -1;
  return 0;
}

/* --------------------------------- ETH/USD -------------------------------- */

/**
 * ETH in dollars, from the indexer's own chain stats.
 *
 * NULL, NEVER A CONSTANT, when the stat is missing or unparseable. A hard-coded
 * fallback ETH price is the single most dangerous line this module could contain:
 * it would not fail loudly, it would silently misprice every token on the chain
 * by whatever ETH had moved since the constant was written, and the figures would
 * still look plausible. A missing ETH price has to propagate as a missing dollar
 * figure.
 *
 * Zero and negative are rejected as hard as null. Number("") is 0, and a $0 ETH
 * would drive every token to $0 — the exact "missing reads as zero" failure this
 * codebase exists to prevent.
 *
 * @param {{ calls?: object }} [options]
 * @returns {Promise<number|null>}
 */
export async function ethUsd(options = {}) {
  const calls = { getStats, ...(options?.calls && typeof options.calls === "object" ? options.calls : {}) };
  const res = await attempt(() => calls.getStats());
  if (!res.ok || !res.value) return null;
  const price = finiteOrNull(res.value.coin_price);
  return price !== null && price > 0 ? price : null;
}

/* ---------------------------- quote verification -------------------------- */

/**
 * Is this candidate actually a dollar? Answered from its ROLE, using no symbol
 * and no indexer price for the candidate itself.
 *
 * The test is: it has a real factory pool against canonical WETH, THE DEEPEST of
 * those pools carries at least MIN_STABLE_QUOTE_DEPTH_USD of measured band depth,
 * and the rate that pool implies for ETH lands within PEG_TOLERANCE of the live
 * ETH/USD. A token that satisfies all three is a dollar whatever it calls itself,
 * and a token that calls itself USDC but prices ETH at 74 million of its units with
 * no depth behind it is not.
 *
 * THIS FUNCTION USED TO CARRY THE F1 BUG resolvePool had removed: it RETURNED
 * INSIDE THE FEE-TIER LOOP, so the first tier that answered won, and its only bar
 * was liquidity > 0. Measured, one wei of L in a decoy USDG/WETH pool at tier 3000
 * — reached before the real pool at 500 — captured the quote asset that sets the
 * dollar value of every token priced through it. It now sweeps every tier, measures
 * each pool the same way resolvePool does, and takes the deepest that clears a real
 * bar. A gas-only decoy measures zero and loses; a one-wei decoy measures dust and
 * loses to the bar.
 *
 * Requires an ETH/USD price to run at all — with no reference there is nothing to
 * check the peg against, and an unverified stablecoin quote is precisely the
 * impostor exposure this whole module is trying to close. So: no ETH price, no
 * stable quotes. WETH itself needs none of this; it is the reference.
 *
 * THREE ANSWERS, NOT TWO, AND THE THIRD IS THE POINT OF THIS SHAPE. `verified` is a
 * dollar; `rejected` is the chain saying this contract is not one; `unread` is a read
 * that did not happen. Collapsing the third into the second is a denial of service
 * with a false conclusion attached: knock over the USDG/WETH pool and every token
 * priced only in USDG stops having its USDG tiers swept, which used to surface as
 * reason "no_pool" — a MEASURED ABSENCE — for a token whose market nobody looked at.
 * An outage may not read as an absence, one layer down as much as anywhere else.
 *
 * A MISSING ETH/USD IS `rejected`, NOT `unread`, and that is deliberate rather than
 * sloppy: it is already surfaced end-to-end as its own reason (`no_eth_price`), the
 * whole dollar leg is missing whatever this function says, and WETH-quoted pools are
 * unaffected. Reporting it here as a quote-asset outage would blame the wrong thing.
 *
 * AND A LOWER BOUND IS A FOURTH THING, WHICH IS WHY `unread` EARNS ITS KEEP TWICE. The
 * depth bar below used to be read off `rankDepthUsd` alone, so a figure the tick budget
 * had TRUNCATED was compared against MIN_STABLE_QUOTE_DEPTH_USD as though it were exact
 * and could fail it. It cannot: a bound counts upward only, so it can show a pool
 * clears the bar and can never show it does not. Both places that comparison happens —
 * the bar itself, and which of the candidate's pools is deepest — now answer `unread`
 * rather than `rejected` when a bound is what decided them. Peg pools are the crowded
 * ones on this chain, so this is the pool most likely to truncate and the one where
 * concluding wrongly costs the most: the quote asset sets the dollar value of every
 * token priced through it.
 *
 * @returns {Promise<{ status: "verified"|"rejected"|"unread",
 *   quote: { address: string, decimals: number, usdPerUnit: number, pool: string,
 *   depthUsd: number, depthIsLowerBound: boolean }|null }>}
 */
const REJECTED = { status: "rejected", quote: null };
const UNREAD = { status: "unread", quote: null };

async function verifyStableQuote(client, candidate, ethPrice) {
  if (!(ethPrice > 0)) return REJECTED;
  const weth = wethAddress();
  if (sameAddress(candidate, weth)) return REJECTED;

  // The candidate's pools are measured on their WETH side: WETH is the reference
  // asset and its dollar value is known, where the candidate's is exactly what is
  // in question. Measuring the unverified side would assume the answer.
  const wethQuote = {
    address: weth,
    decimals: (await readDecimals(client, weth)) ?? 18,
    usdPerUnit: ethPrice,
  };

  const found = await Promise.all(FEE_TIERS.map((fee) => readFactoryPool(client, candidate, weth, fee)));
  // A tier that did not answer could be hiding the real peg pool, so the sweep is
  // not a sweep and nothing here may be concluded.
  if (found.some((res) => !res.ok)) return UNREAD;
  const slots = [];
  const seen = new Set();
  for (const [tierIndex, res] of found.entries()) {
    if (!res.pool || seen.has(res.pool)) continue;
    seen.add(res.pool);
    slots.push({ tierIndex, pool: res.pool });
  }
  // Every tier answered and none holds a pool: a stated negative about the chain.
  if (!slots.length) return REJECTED;
  // CONCURRENT, like the token sweep. In series this was four round trips per tier
  // in front of every lookup on the chain, and it is on the critical path for all
  // of them: nothing can be priced in dollars until the dollar is established.
  const measured = await Promise.all(
    slots.map(async ({ tierIndex, pool }) => {
      const pair = await readPoolPair(client, pool);
      if (!pair) return null;
      // THE RANKING BAND ONLY, for two reasons. The bar is read against it for the
      // reason MIN_STABLE_QUOTE_DEPTH_USD gives — the wide band can be inflated with
      // capital parked at its edge, and this bar decides what the dollar is. And
      // asking for the wide band as well would set the ladder's read range five times
      // wider for a figure nothing here consults: this verification is on the critical
      // path of every lookup on the chain, and measured, the peg pools are the crowded
      // ones, where tick reads are the dominant cost of a cold probe.
      const depth = await attempt(() =>
        measurePoolDepth(client, pool, pair, wethQuote, { bands: [RANK_BAND_BPS] }),
      ).then((r) => (r.ok ? r.value : null));
      return {
        pool,
        pair,
        tierIndex,
        depthUsd: finiteOrNull(depth?.rankDepthUsd),
        // The qualifier travels with the figure here too. A peg pool is exactly the
        // crowded kind whose tick walk gets capped, and this figure is checked against
        // a bar — see below for what a bound may and may not settle against one.
        depthIsLowerBound: depth?.rankDepthIsLowerBound === true,
      };
    }),
  );
  // A pool of this candidate we could not read might be the deep one. Unmeasured is
  // not "shallow by default" and it is not "deep by default" either — it is unread,
  // and nothing about this candidate may be concluded from a sweep with a hole in it.
  if (measured.some((m) => m === null || m.depthUsd === null)) return UNREAD;
  measured.sort((a, b) => (a.depthUsd !== b.depthUsd ? (b.depthUsd > a.depthUsd ? 1 : -1) : a.tierIndex - b.tierIndex));

  const best = measured[0] ?? null;
  if (!best) return REJECTED;
  // WHICH PEG POOL IS DEEPEST HAS TO BE ESTABLISHED, not merely sorted — the same rule
  // resolvePool applies to the token's own pools, and it matters more here: the pool
  // selected sets the dollar value of every token priced through this candidate. A
  // pool that sorted below the leader on a figure that UNDERSTATES may be the deeper
  // one, so the sweep did not settle the question and nothing may be concluded from it.
  if (measured.length > 1 && measured.slice(1).some((m) => m.depthIsLowerBound)) return UNREAD;
  // Read, and genuinely too thin to define the dollar. A stated negative.
  //
  // A BOUND BELOW THE BAR IS NOT A STATED NEGATIVE. A figure that only ever counts
  // upward can show that a pool DOES clear the bar and can never show that it does
  // not — the true depth is at least this and has no ceiling. Rejecting on one would
  // let dust minted into a peg pool's tick range demote a real dollar to "not a
  // dollar", which is a conclusion nobody measured. Unread is its own outcome and it
  // already has a path: the candidate's tiers go unswept and the caller surfaces
  // `quote_unverified`, which says the question is open rather than answered "no".
  if (best.depthUsd < MIN_STABLE_QUOTE_DEPTH_USD) return best.depthIsLowerBound ? UNREAD : REJECTED;

  const slot0 = await readSlot0(client, best.pool);
  if (!slot0) return UNREAD;
  if (slot0.sqrtPriceX96 <= 0n) return REJECTED; // an uninitialised pool IS an answer
  const [d0, d1] = await Promise.all([
    readDecimals(client, best.pair.token0),
    readDecimals(client, best.pair.token1),
  ]);
  if (d0 === null || d1 === null) return UNREAD;

  // How many candidate units one WETH buys, per this pool.
  const perWeth = priceFromSqrtX96(slot0.sqrtPriceX96, d0, d1, sameAddress(best.pair.token0, weth));
  if (perWeth === null || !(perWeth > 0)) return REJECTED;

  const usdPerUnit = ethPrice / perWeth;
  if (Math.abs(usdPerUnit - 1) > PEG_TOLERANCE) return REJECTED;

  const decimals = sameAddress(best.pair.token0, candidate) ? d0 : d1;
  return {
    status: "verified",
    quote: {
      address: normalizeAddress(candidate),
      decimals,
      usdPerUnit,
      pool: best.pool,
      depthUsd: best.depthUsd,
      // A bound that CLEARED the bar is decisive — at least this much, and this much is
      // enough — so it verifies. The qualifier still travels, because "$400 exactly" and
      // "at least $400" are different facts about the pool that defines the dollar.
      depthIsLowerBound: best.depthIsLowerBound,
    },
  };
}

/**
 * How long a verified stablecoin quote may be reused. Its own TTL, and much longer
 * than a price's, because it is not a price: it answers "is this contract the
 * dollar", which is an identity backed by a pool that has to be swept and measured.
 * The shared cache still takes the MINIMUM of this and the global setting, so an
 * operator turning caching down turns this down too.
 *
 * IT IS THE DIFFERENCE BETWEEN A LOOKUP THAT FITS ITS BUDGET AND ONE THAT DOES NOT.
 * Verification is a four-tier sweep with a band measurement per pool, and at the
 * 10-second price TTL a burst of collision probes re-ran it repeatedly; measured, a
 * four-contract VLAD lookup went over the 12s probe deadline and every probe came
 * back unmeasured.
 */
const STABLE_QUOTE_TTL_MS = 300_000;

/** WETH as a quote asset. The reference: it needs no verification, only its decimals. */
async function wethQuote(client, ethPrice) {
  const weth = wethAddress();
  return {
    address: weth,
    kind: "native",
    decimals: (await readDecimals(client, weth)) ?? 18,
    // Its dollar value IS the ETH price; null propagates rather than defaulting.
    usdPerUnit: ethPrice > 0 ? ethPrice : null,
    verifiedBy: "reference_asset",
  };
}

/**
 * The stablecoin quotes that pass verification right now.
 *
 * CACHED, AND THIS IS NOT ONLY AN OPTIMISATION. verifyStableQuote is a full tier
 * sweep with a band measurement per pool, and it runs on EVERY pool lookup — so a
 * four-contract collision would pay for it four times over, concurrently, before
 * any of them read the token they were asked about. The shared cache also collapses
 * those four into one call while it is in flight. A failed verification is not
 * stored on a throw (see cachedRead), so an outage never hardens into "this is not
 * a dollar"; a candidate that verifiably FAILED resolves as a stated negative, so a
 * genuine impostor is not re-swept on every lookup for the life of the process.
 *
 * `unverified` COUNTS THE CANDIDATES WE COULD NOT DECIDE ABOUT, and it is not
 * bookkeeping — it is what stops a DoS on a quote asset's own pool from surfacing as
 * "this token has no market". An unread candidate THROWS out of the fetcher, both so
 * the cache stores nothing and so the count is unmistakable here.
 *
 * @returns {Promise<{ quotes: Array<object>, unverified: number }>}
 */
async function stableQuotes(client, ethPrice) {
  const results = await Promise.all(
    stableCandidates().map((c) =>
      attempt(() =>
        withIndexerCache(
          `dex:stable:${c}:${ethPrice}`,
          async () => {
            const res = await verifyStableQuote(client, c, ethPrice);
            // Rejecting rather than resolving keeps the outage out of the cache.
            if (res.status === "unread") throw new Error(`stable quote unread: ${c}`);
            return { quote: res.quote };
          },
          { ttlMs: STABLE_QUOTE_TTL_MS },
        ),
      ),
    ),
  );
  const quotes = [];
  let unverified = 0;
  for (const v of results) {
    if (!v.ok || !v.value) {
      unverified += 1;
      continue;
    }
    if (!v.value.quote) continue; // read, and not a dollar
    quotes.push({
      address: v.value.quote.address,
      kind: "stable",
      decimals: v.value.quote.decimals,
      usdPerUnit: v.value.quote.usdPerUnit,
      verifiedBy: "weth_pool_peg_check",
    });
  }
  return { quotes, unverified };
}

/**
 * WETH ALWAYS LEADS the quote assets, wherever they are assembled: it is the
 * reference the stablecoins are checked against, it carries the deep pools on this
 * chain, and pricing through it is one conversion rather than two. A stablecoin
 * quote is the fallback for a token that has no WETH pool at all. resolvePool keeps
 * the two APART rather than building one list up front, so the verification and the
 * WETH sweep can run at the same time — see the comment there.
 */

/**
 * THE QUOTE ASSETS THAT MAY DEFINE A DOLLAR RIGHT NOW — canonical WETH first, then every
 * stablecoin candidate that passed verification this call.
 *
 * EXPORTED SO THE V4 READER INHERITS THE BAR RATHER THAN INVENTING ONE. lib/dex-v4.js
 * prices v4 pools, and a v4 pool can be paired against any ERC-20 at all. The question
 * "is this contract a dollar" is not a v4 question and must not be answered twice: it is
 * settled here, from a candidate's own WETH pool having real measured depth and implying an
 * ETH rate near the live one, and a second implementation would be a second bar that could
 * drift below this one. On a chain where a "United States Dump Coin" trades under the
 * symbol USDC, the venue a token trades on changes nothing about that.
 *
 * NATIVE ETH IS DELIBERATELY NOT IN THIS LIST. It is not a contract, v3 cannot pair it at
 * all, and only a v4 PoolKey can name it — so lib/dex-v4.js prepends it, which keeps this
 * function about ERC-20s whose identity has to be earned.
 *
 * `unverified` TRAVELS WITH THE LIST for the reason stableQuotes gives: a candidate we
 * could not decide about is not a candidate that failed, and a caller that reports "no
 * pool" while a quote asset's own pool was unreachable is turning an outage into an
 * absence.
 *
 * @param {{ client?: object, calls?: object, ethUsd?: number|null }} [options]
 * @returns {Promise<{ quotes: Array<object>, unverified: number, ethUsd: number|null }>}
 */
export async function verifiedQuoteAssets(options = {}) {
  const client = options.client;
  const calls = { getStats, ...(options.calls && typeof options.calls === "object" ? options.calls : {}) };
  const ethPrice = options.ethUsd !== undefined ? options.ethUsd : await ethUsd({ calls });
  if (!client || typeof client.readContract !== "function") {
    return { quotes: [], unverified: 0, ethUsd: ethPrice };
  }
  // Concurrent for the reason resolvePool runs them concurrently: neither depends on the
  // other, and in series the verification is six round trips in front of everything else.
  const [weth, stableCheck] = await Promise.all([wethQuote(client, ethPrice), stableQuotes(client, ethPrice)]);
  return { quotes: [weth, ...stableCheck.quotes], unverified: stableCheck.unverified, ethUsd: ethPrice };
}

/* ------------------------------- discovery -------------------------------- */

/**
 * Top holders of a token, as plain addresses. The indexer, not the RPC: there is
 * no on-chain way to enumerate holders, and this is the one thing Blockscout is
 * reliably good at for unlisted tokens.
 */
async function holderAddresses(calls, token) {
  const res = await attempt(() => calls.getTokenHolders(token, { items_count: 20 }));
  if (!res.ok || !res.value) return null;
  const items = Array.isArray(res.value.items) ? res.value.items : [];
  const out = [];
  for (const item of items) {
    const a = normalizeAddress(item?.address?.hash ?? item?.address);
    // The token itself and the burn address are never the pool; skip them rather
    // than spending two of the probe budget on them.
    if (!a || sameAddress(a, token) || isZeroAddress(a)) continue;
    if (!out.includes(a)) out.push(a);
    if (out.length >= MAX_HOLDER_PROBES) break;
  }
  return out;
}

/**
 * Does this candidate address behave like a v3 pool for `token` against one of
 * `quotes`? Returns `{ read, match }`.
 *
 * `read` says THE CHAIN ANSWERED, whatever the answer was, and it is a separate
 * fact from whether a pool was found. A holder that turns out not to be a pool is a
 * measurement; a holder whose token0() call timed out is not, and only the first of
 * those may contribute to "we looked and there is nothing here".
 *
 * Answering token0()/token1()/fee() is not on its own proof of anything — anyone
 * can deploy a contract with those three getters — so the match is confirmed
 * against the factory where the factory will answer. If the factory read fails
 * the pair is still accepted, but the returned record says `discovery:
 * "holder_probe"` rather than "factory", so the caller is never told a weaker
 * finding is a stronger one.
 */
async function probeCandidate(client, candidate, token, quotes) {
  const pair = await readPoolPair(client, candidate);
  if (!pair) return { read: false, match: null };
  const targetIsToken0 = sameAddress(pair.token0, token);
  const targetIsToken1 = sameAddress(pair.token1, token);
  if (!targetIsToken0 && !targetIsToken1) return { read: true, match: null };
  const otherSide = targetIsToken0 ? pair.token1 : pair.token0;
  const quoteIndex = quotes.findIndex((q) => sameAddress(q.address, otherSide));
  if (quoteIndex < 0) return { read: true, match: null };
  const quote = quotes[quoteIndex];

  const confirmed = await readFactoryPool(client, pair.token0, pair.token1, pair.fee);
  if (confirmed.ok && confirmed.pool && !sameAddress(confirmed.pool, candidate)) {
    return { read: true, match: null };
  }

  const tierIndex = FEE_TIERS.indexOf(Number(pair.fee));
  return {
    read: true,
    match: {
      pool: normalizeAddress(candidate),
      token0: pair.token0,
      token1: pair.token1,
      fee: pair.fee,
      quote,
      quoteIndex,
      tierIndex: tierIndex < 0 ? FEE_TIERS.length : tierIndex,
      targetIsToken0,
      discovery: confirmed.ok && confirmed.pool ? "factory_confirmed" : "holder_probe",
    },
  };
}

/**
 * Measure a set of candidate pools and return them deepest first.
 *
 * Concurrent, because the reads are independent and the sweep is now the dominant
 * cost of a lookup: run in series, twelve factory slots plus three reads per pool
 * would be a crawl; run together they are two round trips.
 */
async function measureCandidates(client, candidates) {
  const measured = await Promise.all(
    candidates.slice(0, MAX_POOLS_MEASURED).map(async (candidate) => ({
      ...candidate,
      depth: await attempt(() =>
        measurePoolDepth(client, candidate.pool, { token0: candidate.token0, token1: candidate.token1 }, candidate.quote),
      ).then((r) => (r.ok ? r.value : null)),
    })),
  );
  return measured.sort(deeperPool);
}

/**
 * Find the pool for `token` — THE DEEPEST ONE, not the first one — carrying WHY
 * when there isn't one.
 *
 * Two paths, in this order:
 *   1. The factory, swept EXHAUSTIVELY: every fee tier of every verified quote
 *      asset, every existing pool measured, and the deepest of them selected. The
 *      old shape of this returned inside the loop on the first tier that answered,
 *      which handed anyone willing to spend one gas-only transaction the power to
 *      redirect our probe onto an empty pool they deployed for a token they do not
 *      own (see FEE_TIERS). Enumerating and ranking is what makes that decoy
 *      worthless rather than merely more expensive.
 *   2. Holder probing, for anything the factory cannot serve — a pool from a
 *      second factory, a fee tier outside the standard four, or the factory read
 *      itself failing. The pool is a top holder of its own token because it
 *      custodies the tradable side, so a handful of top holders is enough. It also
 *      runs when the factory found ONLY empty pools, which is exactly the shape a
 *      decoy leaves behind when the real market lives at a non-standard tier.
 *
 * The failure modes are kept apart all the way out. `reason: "no_pool"` means the
 * CHAIN answered and there is nothing there. `reason: "discovery_failed"` means the
 * chain did not answer, which says nothing about whether a pool exists. `reason:
 * "no_client"` means nothing was even attempted because the caller passed no RPC
 * client — a third fact, and the one that must not wear the outage's clothes.
 *
 * "THE CHAIN ANSWERED" IS NOT "SOMETHING ANSWERED". The indexer returning a holder
 * list proves the indexer is up and proves nothing at all about the RPC: with every
 * eth_call failing and Blockscout healthy, the old bookkeeping counted the holder
 * list as an answer and reported "no_pool" — a total RPC outage rendered to the
 * answer layer as a measured absence of a market, on a reason code that is not in
 * POOL_UNREAD_REASONS and therefore silences every "we could not look" guard
 * downstream. Only reads that came back FROM THE CHAIN count here.
 *
 * @returns {Promise<{ found: object|null, reason: string|null, pools: Array<object>, poolCount: number }>}
 */
export async function resolvePool(tokenAddress, options = {}) {
  const token = normalizeAddress(tokenAddress);
  if (!token) return { found: null, reason: "bad_address", pools: [], poolCount: 0 };

  const client = options.client;
  // NOT "discovery_failed". A missing client is a PROGRAMMING ERROR — nobody
  // asked the chain anything — and reporting it as an outage would be the same
  // conflation this module exists to prevent, one level up: in production a
  // poolClient that failed to build would make every token on the chain look like
  // a permanent RPC brownout, forever, with a sentence blaming the RPC.
  if (!client || typeof client.readContract !== "function") {
    return { found: null, reason: "no_client", pools: [], poolCount: 0 };
  }
  const calls = { getTokenHolders, getStats, ...(options.calls && typeof options.calls === "object" ? options.calls : {}) };

  const ethPrice = options.ethUsd !== undefined ? options.ethUsd : await ethUsd({ calls });

  // Set ONLY by a read the chain answered. The indexer being up is not evidence
  // about the RPC, and conflating the two is how an outage becomes an absence.
  let chainAnswered = false;
  const seen = new Set();

  /**
   * Sweep every fee tier of ONE quote asset, pair up whatever exists, and measure
   * it. Factored out so the WETH sweep and the stablecoin sweep are the same code
   * and cannot drift — a decoy check that ran on one quote asset and not the other
   * would be no check at all.
   */
  async function sweepQuote(quote, quoteIndex) {
    if (sameAddress(quote.address, token)) return [];
    const lookups = await Promise.all(
      FEE_TIERS.map(async (fee, tierIndex) => ({
        tierIndex,
        found: await readFactoryPool(client, token, quote.address, fee),
      })),
    );
    const candidates = [];
    for (const { tierIndex, found } of lookups) {
      if (found.ok) chainAnswered = true;
      if (!found.ok || !found.pool || seen.has(found.pool)) continue;
      // The bound is on the WHOLE lookup, not on one quote asset's share of it, so
      // a long UNISWAP_V3_QUOTE_TOKENS list cannot turn one lookup into a crawl.
      if (seen.size >= MAX_POOLS_MEASURED) break;
      seen.add(found.pool);
      candidates.push({ tierIndex, pool: found.pool });
    }
    const paired = await Promise.all(
      candidates.map(async ({ tierIndex, pool }) => {
        const pair = await readPoolPair(client, pool);
        if (!pair) return null;
        chainAnswered = true;
        return {
          pool,
          token0: pair.token0,
          token1: pair.token1,
          fee: pair.fee,
          quote,
          quoteIndex,
          tierIndex,
          targetIsToken0: sameAddress(pair.token0, token),
          discovery: "factory",
        };
      }),
    );
    return measureCandidates(client, paired.filter(Boolean));
  }

  // ---- path 1: the factory. Every tier of every quote asset.
  //
  // THE WETH SWEEP AND THE STABLECOIN VERIFICATION RUN AT THE SAME TIME, and that
  // is a latency fix with teeth. Verifying a stablecoin is itself a tier sweep with
  // a band measurement per pool, and doing it FIRST — as this did — put six serial
  // round trips in front of every lookup before the token in question was read at
  // all. Measured, a four-contract VLAD collision then blew the 12s probe deadline
  // and reported every contract unmeasured. Neither branch depends on the other:
  // WETH is the reference asset and needs no verification.
  const weth = await wethQuote(client, ethPrice);
  const [wethPools, stableCheck] = await Promise.all([sweepQuote(weth, 0), stableQuotes(client, ethPrice)]);
  const stables = stableCheck.quotes;

  // The stablecoin tiers come after, because their ADDRESSES are what verification
  // produces. Usually one round trip that finds nothing: on this chain a token with
  // a WETH pool does not also have a USDG one.
  const stablePools = (
    await Promise.all(stables.map((quote, i) => sweepQuote(quote, i + 1)))
  ).flat();

  const factoryPools = [...wethPools, ...stablePools].sort(deeperPool);
  /**
   * A POOL WE COULD NOT READ IS A POOL WE CANNOT RANK, and once there is more than
   * one candidate that ends the selection rather than skipping a row.
   *
   * The alternative is what this replaces: pick the best of the ones that ANSWERED.
   * That is an outage choosing the price. Measured, it cost $4.5e-12 of band depth in
   * a decoy to take the price of a token whose own pool went unread for one brownout,
   * and it reported the token 100× mispriced with a $40.48M cap against a real $405K.
   * An unread pool could be arbitrarily deep, so nothing here can establish that the
   * pool that did answer is the deepest one — and "the deepest one" is the entire
   * basis on which a price source is chosen.
   *
   * ONE CANDIDATE IS A DIFFERENT SITUATION and is deliberately left alone: there is
   * no choice being made, so an unreadable ladder costs the DEPTH figure (null, as it
   * always has) and not the price. The rule is about SELECTION, not about depth.
   *
   * Any preference among unreadable pools would be a preference we cannot justify, so
   * there is none: they sort last in deeperPool purely so they cannot be picked, and
   * that ordering CANNOT reach the reported price, because this check runs first.
   */
  const unreadable = (rows) => rows.length > 1 && rows.some(poolUnmeasured);
  /**
   * A POOL THAT LOST ON A LOWER BOUND HAS NOT BEEN SHOWN TO LOSE, and the same rule
   * follows: once there is more than one candidate, that ends the selection.
   *
   * This is the gap O1 named, and it is the mirror image of the rule directly above.
   * lib/tick-depth.js caps the tick walk rather than refusing it, so a pool with more
   * initialised ticks inside the band than one lookup pays for comes back as a genuine
   * integral over a SHORTER interval — worth at least that much, with no ceiling.
   * lib/depth-rank.js already reasons this way about the ranking verdict; the selection
   * that decides the reported PRICE did not, and ranked on the figure alone.
   *
   * MEASURED, AND EXACTLY BOUNDED. The rank band truncates only where the ranking band
   * holds more than MAX_TICKS_READ tick positions, which among the standard tiers is
   * the 0.01% tier alone (spacing 1). There, ~25 gas-only dust mints into a victim's
   * pool capped the live Green Bull geometry 8.29× — $259.06 down to $31.26 — and a
   * decoy holding $31.27 of real in-band capital then sorted first and took the price,
   * reporting it 100× wrong with no flag anywhere in the result. The Green Bull's own
   * pool (fee 10000, spacing 200) and the USDG peg pool (fee 500, spacing 10) are
   * structurally immune: 600 dust mints move their ranking figure by nothing.
   *
   * A BOUND ON THE LEADER IS UNTOUCHED BY THIS, deliberately. The true figure is at
   * least what was read and every rival is exact, so a floor above the whole field is
   * decisive and that pool is selected exactly as before. Only a bound that LOST makes
   * the ordering unestablished.
   *
   * ONE CANDIDATE IS AGAIN A DIFFERENT SITUATION: no choice is being made, so a capped
   * ladder costs exactness in the DEPTH figure — which travels labelled — and not the
   * price.
   */
  const inconclusive = (rows) => rows.length > 1 && rows.slice(1).some(poolDepthIsLowerBound);
  if (unreadable(factoryPools)) {
    return { found: null, reason: "pool_read_failed", pools: factoryPools, poolCount: factoryPools.length };
  }
  if (inconclusive(factoryPools)) {
    return { found: null, reason: "depth_inconclusive", pools: factoryPools, poolCount: factoryPools.length };
  }
  const best = factoryPools[0] ?? null;
  // A funded pool ends it. Only when the factory's pools are ALL empty or all
  // unmeasurable is it worth paying for the holder probe — which is precisely the
  // state a decoy leaves behind, so the fallback is what stops one from hiding a
  // real pool at a tier the factory does not carry.
  if (best && finiteOrNull(best.depth?.rankDepthQuoteUnits) > 0) {
    return { found: best, reason: null, pools: factoryPools, poolCount: factoryPools.length };
  }

  // ---- path 2: holder probe, bounded and concurrent.
  const quotes = [weth, ...stables];
  const holders = await holderAddresses(calls, token);
  const probeHits = [];
  if (holders !== null) {
    const probed = await Promise.all(
      holders.map((h) => attempt(() => probeCandidate(client, h, token, quotes))),
    );
    // Keep the holder ORDER rather than whichever promise settled first, so equal
    // measurements resolve to the same pool on every call and the price does not
    // appear to move between pools for a reason the user cannot see.
    for (const p of probed) {
      if (!p.ok || !p.value) continue;
      if (p.value.read) chainAnswered = true;
      if (p.value.match && !seen.has(p.value.match.pool)) {
        seen.add(p.value.match.pool);
        probeHits.push(p.value.match);
      }
    }
  }

  const pools = probeHits.length
    ? [...factoryPools, ...(await measureCandidates(client, probeHits))].sort(deeperPool)
    : factoryPools;
  if (unreadable(pools)) {
    return { found: null, reason: "pool_read_failed", pools, poolCount: pools.length };
  }
  // The holder probe can only ADD candidates, so a bound that lost is re-checked
  // against the wider field rather than assumed to have survived the first check.
  if (inconclusive(pools)) {
    return { found: null, reason: "depth_inconclusive", pools, poolCount: pools.length };
  }
  const winner = pools[0] ?? null;
  if (winner) return { found: winner, reason: null, pools, poolCount: pools.length };

  // NOTHING WAS FOUND — and why decides whether that is a fact about the chain.
  // A quote asset we could not re-verify means its fee tiers were never swept, so
  // this token's market there was not looked for, let alone ruled out.
  return {
    found: null,
    reason: !chainAnswered ? "discovery_failed" : stableCheck.unverified > 0 ? "quote_unverified" : "no_pool",
    pools: [],
    poolCount: 0,
  };
}

/**
 * The pool for a token, or null.
 *
 * Kept to the plain shape callers asked for. `null` here does NOT distinguish "no
 * pool exists" from "we could not look" — use resolvePool when that difference
 * matters, which is any time the answer is shown to a user.
 *
 * @param {string} tokenAddress
 * @param {{ client?: object, calls?: object, ethUsd?: number|null }} [options]
 * @returns {Promise<{ pool: string, token0: string, token1: string, fee: number, quote: object } | null>}
 */
export async function findPool(tokenAddress, options = {}) {
  const { found } = await resolvePool(tokenAddress, options);
  return found;
}

/* -------------------------------- pricing --------------------------------- */

/**
 * The four liquidity figures a pool produces, which are four different quantities
 * and are never allowed to collapse into one.
 *
 *   quoteLiquidityUsd — BAND DEPTH at RANK_BAND_BPS (-2%), measured by
 *                       measurePoolDepth from the tick ladder: what a seller could
 *                       realise before the price has moved 2% against them. This is
 *                       the ranking figure and the only one any caller may call depth.
 *   wideDepthUsd      — the same integral over 10%. Context, never the ranking
 *                       figure: capital at the far edge of it counts in full and is
 *                       never traded through, which is what made it cheap to inflate.
 *   quoteBalanceUsd   — what the pool HOLDS on the quote side, positions parked
 *                       outside the band included. A SEPARATE, LABELLED QUANTITY,
 *                       reported so the gap can be named and never ranked on: it is
 *                       the figure that could be rented rather than bought.
 *   liquidityUsd      — both sides added up, and mostly circular: the token side is
 *                       valued at the very price under discussion, so counting it
 *                       says a token is worth a lot because there is a lot of it.
 *                       Measured on Vladhoods, $363,783 of it against $3.91 of
 *                       quote. Reported, labelled, and never presented as depth.
 *
 * Each depth also carries whether it is EXACT or a LOWER BOUND (`depthIsLowerBound`,
 * `wideDepthIsLowerBound`) — a truncated ladder produces a real integral over a
 * shorter interval, which is worth at least that much and may be worth more.
 *
 * The depth measurement has already been taken during pool selection, so it is
 * passed in rather than re-read — the reads behind it are cached on the price TTL
 * either way, but re-deriving it here would let the figure that RANKED a pool and
 * the figure REPORTED for it drift apart.
 */
async function poolLiquidityUsd(client, found, targetPriceUsd) {
  const depth = found.depth ?? null;
  const target = found.targetIsToken0 ? found.token0 : found.token1;

  const [targetRaw, targetDecimals] = await Promise.all([
    readPoolBalance(client, target, found.pool),
    readDecimals(client, target),
  ]);

  const quoteSide = finiteOrNull(depth?.balanceUsd);
  const targetSide =
    targetRaw === null || targetDecimals === null || targetPriceUsd == null
      ? null
      : mul(bigRatioToNumber(targetRaw, 10n ** BigInt(targetDecimals)), targetPriceUsd);

  return {
    liquidityUsd: quoteSide === null && targetSide === null ? null : (quoteSide ?? 0) + (targetSide ?? 0),
    quoteLiquidityUsd: finiteOrNull(depth?.rankDepthUsd),
    quoteBalanceUsd: quoteSide,
    depthIsLowerBound: Boolean(depth?.rankDepthIsLowerBound),
    // How far the capped walk reached, when it was capped. Null otherwise.
    depthCoveredBandBps: finiteOrNull(depth?.rankDepthCoveredBandBps),
    wideDepthUsd: finiteOrNull(depth?.wideDepthUsd),
    wideDepthIsLowerBound: Boolean(depth?.wideDepthIsLowerBound),
    depthBandBps: depth?.rankBandBps ?? RANK_BAND_BPS,
    wideBandBps: depth?.wideBandBps ?? WIDE_BAND_BPS,
  };
}

/** a * b, with null in and null out — never 0 for a missing factor. */
function mul(a, b) {
  if (a == null || b == null) return null;
  const n = a * b;
  return Number.isFinite(n) ? n : null;
}

/**
 * Price one token from its Uniswap v3 pool.
 *
 * Success carries the pool, the fee tier, WHICH quote asset was used, the block
 * the state was read at, and the liquidity behind it — everything needed to
 * qualify the number, because a v3 price with no depth beside it is arithmetic
 * dressed as a market.
 *
 * Failure carries a reason CODE, and the codes are not interchangeable: no pool,
 * pool unreadable, pool never initialised and no ETH price are four different
 * facts. On the last one the quote-denominated price is still returned — knowing
 * a token trades at 2.1e-7 ETH is worth something even when the dollar leg is
 * missing — but `ok` is false and `priceUsd` is absent, never zero.
 *
 * @param {string} tokenAddress
 * @param {{ client?: object, calls?: object, ethUsd?: number|null }} [options]
 */
export async function priceFromPool(tokenAddress, options = {}) {
  const token = normalizeAddress(tokenAddress);
  if (!token) return fail("bad_address");

  const client = options.client;
  // See resolvePool: a caller that passed no client is a bug here, never an outage.
  if (!client || typeof client.readContract !== "function") return fail("no_client");
  const calls = { getTokenHolders, getStats, ...(options.calls && typeof options.calls === "object" ? options.calls : {}) };

  const ethPrice = options.ethUsd !== undefined ? options.ethUsd : await ethUsd({ calls });
  const { found, reason, poolCount } = await resolvePool(token, { ...options, calls, ethUsd: ethPrice });
  if (!found) return fail(reason ?? "no_pool");

  const [slot0, d0, d1, asOfBlock] = await Promise.all([
    readSlot0(client, found.pool),
    readDecimals(client, found.token0),
    readDecimals(client, found.token1),
    readBlockNumber(client),
  ]);
  if (!slot0 || d0 === null || d1 === null) {
    return fail("pool_read_failed", { pool: found.pool, fee: found.fee, quote: found.quote.address });
  }
  if (slot0.sqrtPriceX96 <= 0n) {
    return fail("pool_not_initialised", { pool: found.pool, fee: found.fee, quote: found.quote.address });
  }

  const priceInQuote = priceFromSqrtX96(slot0.sqrtPriceX96, d0, d1, found.targetIsToken0);
  if (priceInQuote === null) {
    return fail("price_out_of_range", { pool: found.pool, fee: found.fee, quote: found.quote.address });
  }

  // Every quote reaches USD through the same single chain — the pool, then the
  // one ETH/USD reading — so no figure here is ever a blend of two sources.
  const priceUsd = mul(priceInQuote, found.quote.usdPerUnit);
  // The ETH-denominated price, whatever the pool was quoted in. For a WETH pool
  // it is the pool figure untouched; for a stable pool it is derived, and derived
  // from the same two numbers, not a third source.
  const priceNative =
    found.quote.kind === "native" ? priceInQuote : ethPrice > 0 ? mul(priceUsd, 1 / ethPrice) : null;

  const base = {
    quote: {
      address: found.quote.address,
      kind: found.quote.kind,
      verifiedBy: found.quote.verifiedBy,
      usdPerUnit: found.quote.usdPerUnit,
    },
    pool: found.pool,
    fee: found.fee,
    priceInQuote,
    priceNative,
    source: "uniswap_v3",
    discovery: found.discovery,
    asOfBlock,
    // HOW MANY POOLS THIS TOKEN HAS, so a caller can say the price came from the
    // deepest of several rather than implying it is the only one. One is the normal
    // case on this chain and the field is then uninteresting; more than one is
    // exactly the case where a reader deserves to be told a choice was made.
    poolCount: Number.isFinite(poolCount) ? poolCount : null,
  };

  if (priceUsd === null) {
    // The pool was read fine. What is missing is the dollar leg, and saying so is
    // a different statement from "this token has no price".
    return { ...fail("no_eth_price"), ...base };
  }

  const {
    liquidityUsd,
    quoteLiquidityUsd,
    quoteBalanceUsd,
    depthIsLowerBound,
    depthCoveredBandBps,
    wideDepthUsd,
    wideDepthIsLowerBound,
    depthBandBps,
    wideBandBps,
  } = await poolLiquidityUsd(client, found, priceUsd);
  return {
    ok: true,
    priceUsd,
    ...base,
    liquidityUsd,
    quoteLiquidityUsd,
    // WHAT THE POOL HOLDS, carried beside the depth so the answer layer can name the
    // gap. It is NOT depth and must never be presented as it — see measurePoolDepth.
    quoteBalanceUsd,
    // "At least this much", when the read budget capped the walk. Never silently
    // upgraded to an exact figure downstream.
    depthIsLowerBound,
    // …and the interval it DOES cover, so the layer that has to tell a reader the read
    // was capped can name a range rather than only an omission.
    depthCoveredBandBps,
    wideDepthUsd,
    wideDepthIsLowerBound,
    // The bands the two figures were integrated over, so no sentence downstream has
    // to hard-code "2%" and drift when the constant moves.
    depthBandBps,
    wideBandBps,
    // Reported, not enforced. The price stands; the caller decides how loudly to
    // qualify it. Null liquidity means unknown depth, which is not thin — it is
    // unmeasured, and must not be presented as either.
    //
    // A LOWER BOUND BELOW THE FLOOR IS ALSO NULL, for the same reason one rung up: a
    // figure that understates can show that a pool IS deep enough (at least $X, and
    // $X clears the bar) and can never show that it is not. Calling that "thin" would
    // be asserting an absence out of a measurement that only ever counts upward.
    thinLiquidity:
      quoteLiquidityUsd === null
        ? null
        : quoteLiquidityUsd >= THIN_LIQUIDITY_USD
          ? false
          : depthIsLowerBound
            ? null
            : true,
  };
}

/* ------------------------------ market figures ---------------------------- */

/**
 * Raw supply to whole tokens, exactly. Blockscout sends total_supply as a decimal
 * string of raw base units and it routinely exceeds 2^53, so it goes through
 * BigInt and never through parseFloat.
 */
function supplyToNumber(totalSupply, decimals) {
  if (totalSupply == null) return null;
  let raw;
  if (typeof totalSupply === "bigint") {
    raw = totalSupply;
  } else {
    // BigInt("") is 0n — the same trap as Number(""), and with the same
    // consequence: an indexer that sent no supply would be read as a supply of
    // zero and produce a market cap of $0 for a token that has one.
    const text = String(totalSupply).trim();
    if (text === "") return null;
    try {
      raw = BigInt(text);
    } catch {
      return null;
    }
  }
  if (raw < 0n) return null;
  // Unknown decimals is unknown supply, not 18 and not 0. Number(null) is 0 and
  // Number("") is 0, and either would silently rescale the whole supply by
  // 10^18 — a market cap a quintillion times too big, stated confidently.
  if (decimals == null || decimals === "") return null;
  const d = Number(decimals);
  if (!Number.isInteger(d) || d < 0 || d > 77) return null;
  if (raw === 0n) return 0;
  return bigRatioToNumber(raw, 10n ** BigInt(d));
}

/**
 * The one call the evidence layer makes: price and market cap for a token,
 * derived from its pool, with the source and the depth attached.
 *
 * SUPPLY IS THE CALLER'S. gatherEvidence has already read the token endpoint and
 * therefore already holds total_supply and decimals; re-reading them here would be
 * a second round trip against a rate-limited indexer for bytes we already have,
 * and a second chance for the two layers to disagree about the same token. Pass
 * them in. They are only read from the chain when the caller has none.
 *
 * MARKET CAP IS OMITTED, NOT ZEROED, when the supply is unknown. A token whose
 * supply we could not read has an unknown market cap; "$0" is a claim nobody
 * measured, and it is the exact shape of bug this codebase keeps closing.
 *
 * @param {string} tokenAddress
 * @param {{
 *   client?: object, calls?: object, ethUsd?: number|null,
 *   totalSupply?: string|bigint|null, decimals?: number|null
 * }} [options]
 * @returns {Promise<{ price: number|null, marketCap: number|null, liquidityUsd: number|null,
 *   source: string, quote: object|null, pool: string|null, reason?: string }>}
 */
/**
 * THE UNISWAP V4 READ, RUN ALONGSIDE THE V3 ONE — a SECOND SOURCE, never a substitute.
 *
 * WHY IT RUNS EVERY TIME AND NOT ONLY AS A FALLBACK. Two different questions need it. The
 * obvious one is "v3 found nothing, does this token trade anywhere?" — that is the defect:
 * PIPECAT's market is v4 and the answer said no market. The less obvious one is "v3 found a
 * pool; is that the whole picture?", and it matters to the layer that RANKS contracts:
 * lib/depth-rank.js used to treat a v3 `no_pool` as a MEASURED depth of zero, which is only
 * true if nothing trades the token anywhere. So the v4 read has to happen whether or not v3
 * succeeds, and the two are started TOGETHER rather than in sequence: they share nothing,
 * and measured, v4 takes under two seconds against the v3 sweep's 5.2s, so it is free in
 * wall clock and costs a handful of RPC calls against v3's hundred.
 *
 * IT CANNOT CHANGE A V3 REASON CODE. When neither venue prices the token, `reason` is
 * still exactly the v3 reason it always was, and what v4 found travels in its own `v4`
 * block. That is not timidity about the shape — it is that "no v3 pool" and "no market
 * anywhere" are different facts, and the sentence a reader gets is assembled one layer up
 * (lib/ask-evidence.js priceAvailability) where both are in hand.
 *
 * SKIPPED IS ITS OWN OUTCOME. With less than V4_MIN_MS of the request left the read is not
 * STARTED, and that is reported as `skipped` rather than as an outage: nothing was measured
 * and nothing failed, which is the distinction lib/page-retry.js draws about a withheld
 * retry and lib/ask-evidence.js draws about a pool read that never began.
 */
async function v4Discover(tokenAddress, options) {
  const client = options.client;
  if (!client || typeof client.readContract !== "function") {
    return { status: "unread", reason: "no_client", detail: null, poolCount: null };
  }
  if (outOfTimeFor(V4_MIN_MS)) {
    return {
      status: "skipped",
      reason: "out_of_time",
      detail:
        "This token's Uniswap v4 pools were NOT READ — the lookup ran out of the time it had to answer in before that read could start. Nothing was measured and nothing failed, so whether it has a v4 market is unknown. Do not report this as an absence and do not report it as an outage.",
      poolCount: null,
    };
  }
  // A caller that injects its own v4 reader (every test does) gets no discovery pass: the
  // reader is the seam, and pre-reading pools for it would be this file deciding what the
  // seam is allowed to see.
  if (typeof options.v4MarketData === "function") return { status: "inject", reason: null, detail: null };

  // The manager is established by BEHAVIOUR — extsload and protocolFeeController answer,
  // token0/token1 do not — and cached for the process once it settles, so resolving it per
  // token costs one round trip on a cold process and nothing after that.
  const managerVerdict = await resolveV4PoolManager({ client });
  if (!managerVerdict.address) {
    return {
      status: "unread",
      // A REJECTED candidate and an UNREAD one are both "we have no singleton to ask", and
      // they are still different sentences: one says the configured address is not the
      // PoolManager, the other says nobody could tell. Both forbid concluding an absence.
      reason: "manager_unknown",
      detail: `${V4_REASON_TEXT.manager_unknown} ${managerVerdict.reason ?? ""}`.trim(),
      poolCount: null,
      managerStatus: managerVerdict.status,
      managerCandidate: managerVerdict.candidate,
    };
  }
  /**
   * BOUNDED, because this is the one v4 read that runs in FRONT of the v3 sweep.
   *
   * See lib/dex-v4.js V4_DISCOVERY_BUDGET_MS: measured live, a doomed currency1 log query plus
   * its retries cost 14s and took one Green Bull lookup to 28.0s against a 24s request budget —
   * the v4 side reported UNREAD honestly, having spent the time the v3 answer needed. The race
   * does NOT cancel the underlying work: it keeps running and warms the cache for the next
   * lookup, which is the same bargain lib/ask-evidence.js withDeadline strikes.
   */
  const ceiling =
    Number.isFinite(options.v4DiscoveryBudgetMs) && options.v4DiscoveryBudgetMs > 0
      ? options.v4DiscoveryBudgetMs
      : V4_DISCOVERY_BUDGET_MS;
  const discovery = await Promise.race([
    readV4Pools(client, managerVerdict.address, tokenAddress, options),
    new Promise((resolve) => {
      // Unref'd so a bounded read that lost the race cannot hold a process open on its own.
      setTimeout(
        () => resolve({ status: "unread", pools: [], poolsDropped: 0, reason: "discovery_failed" }),
        ceiling,
      ).unref?.();
    }),
  ]);
  return { status: "read", manager: managerVerdict, discovery };
}

/**
 * PHASE TWO: state, depth and the price — every read here is a batched `eth_call`, so this
 * is the half that overlaps the v3 sweep at no cost.
 */
async function v4Market(tokenAddress, options, ethPrice, ready) {
  if (ready && ready.status !== "read" && ready.status !== "inject") return ready;
  const read = typeof options.v4MarketData === "function" ? options.v4MarketData : v4MarketData;
  const quoteAssets = await verifiedQuoteAssets({ client: options.client, calls: options.calls, ethUsd: ethPrice });

  const res = await attempt(() =>
    read(tokenAddress, {
      ...options,
      manager: ready?.manager?.address ?? null,
      discovery: ready?.discovery ?? null,
      quotes: quoteAssets.quotes,
      quotesUnverified: quoteAssets.unverified,
      ethUsd: ethPrice,
      // The maths is handed over rather than re-implemented in the v4 module: the sqrt-price
      // identity, the BigInt ratio and the supply conversion are the same arithmetic on the
      // same encodings, and a second copy is a second place for a decimals correction to be
      // the wrong way round. Passing them also keeps lib/dex-v4.js from importing this file,
      // which would be a cycle.
      priceFromSqrtX96,
      bigRatioToNumber,
      supplyToNumber,
    }),
  );
  if (!res.ok || !res.value) {
    return {
      status: "unread",
      reason: "discovery_failed",
      detail: V4_REASON_TEXT.discovery_failed,
      poolCount: null,
    };
  }
  const v4 = res.value;
  const status = v4.ok
    ? "priced"
    : v4.reason === "no_pool"
      ? "none"
      : V4_UNREAD_REASONS.has(v4.reason)
        ? "unread"
        : "found_unpriced";
  return { ...v4, status, managerStatus: ready?.manager?.status ?? null };
}

/**
 * The v4 sentences this file needs before it has called into the v4 module. Kept as the
 * one duplicated pair rather than importing V4_REASONS wholesale, because these two are
 * reached WITHOUT a v4 read having happened at all — there is no result to carry them.
 */
const V4_REASON_TEXT = Object.freeze({
  manager_unknown:
    "The Uniswap v4 PoolManager could not be identified this call, so the singleton that holds every v4 pool was never asked about this token. Whether it has a v4 market is UNKNOWN — an outage, not a token without a market.",
  discovery_failed:
    "The Uniswap v4 pool lookup did not complete, so whether this token has a v4 pool is unknown. This is an outage, not a token without a market.",
});

/**
 * DOES THIS TOKEN ALSO TRADE ON V4 — TRUE, FALSE, OR NULL, and the null is the whole point
 * of the field being three-valued.
 *
 * IT WAS A BOOLEAN AND THAT WAS WRONG, caught in live verification on The Green Bull: its v4
 * log query failed, and a two-valued field reported `false` — "this token does not trade on
 * v4" — for a read that never answered. That is the precise mistake this codebase exists to
 * prevent, reintroduced by a `||` that treated a missing count as a zero. The Green Bull HAS
 * 48 v4 pools.
 *
 * So: TRUE means the v4 read found pools, FALSE means it read the log index and found none,
 * and NULL means nobody knows. A consumer that wants a boolean has to decide what to do about
 * the null, which is the correct amount of friction.
 *
 * IT IS SET ON EVERY PATH, including the ones where no price was produced. A field that
 * exists on the success path and is `undefined` on the failure path reads as `false` to
 * anything doing a truthiness check, which is the same wrong answer by another route.
 */
function alsoOnV4(v4Reported) {
  if (v4Reported?.status === "priced" || finiteOrNull(v4Reported?.poolCount) > 0) return true;
  return v4Reported?.status === "none" ? false : null;
}

/** The v4 half of a result, trimmed to what a caller may state and always labelled. */
function v4Block(v4) {
  if (!v4) return null;
  return {
    source: "uniswap_v4",
    status: v4.status,
    priced: v4.status === "priced",
    // "WE COULD NOT LOOK", as one flag, because every consumer asks the same question of
    // it: may this be reported as "there is no v4 market"? It may not.
    outage: v4.status === "unread",
    // …and its own third state: the read never began. Not an outage and not an absence.
    skipped: v4.status === "skipped",
    reason: v4.reason ?? null,
    detail: v4.detail ?? null,
    poolCount: finiteOrNull(v4.poolCount),
    poolsDropped: finiteOrNull(v4.poolsDropped),
    measuredPoolCount: finiteOrNull(v4.measuredPoolCount),
    unpriceablePoolCount: finiteOrNull(v4.unpriceablePoolCount),
    hookedPoolCount: finiteOrNull(v4.hookedPoolCount),
    pools: Array.isArray(v4.pools) ? v4.pools : null,
    pool: v4.poolId ?? null,
    fee: finiteOrNull(v4.fee),
    tickSpacing: finiteOrNull(v4.tickSpacing),
    hooks: v4.hooks ?? null,
    hooked: v4.hooked === true,
    quote: v4.quote ?? null,
    price: finiteOrNull(v4.price),
    marketCap: finiteOrNull(v4.marketCap),
    priceInQuote: finiteOrNull(v4.priceInQuote),
    priceNative: finiteOrNull(v4.priceNative),
    quoteLiquidityUsd: finiteOrNull(v4.quoteLiquidityUsd),
    depthIsLowerBound: v4.depthIsLowerBound === true,
    depthCoveredBandBps: finiteOrNull(v4.depthCoveredBandBps),
    wideDepthUsd: finiteOrNull(v4.wideDepthUsd),
    wideDepthIsLowerBound: v4.wideDepthIsLowerBound === true,
    asOfBlock: finiteOrNull(v4.asOfBlock),
    managerStatus: v4.managerStatus ?? null,
  };
}

export async function tokenMarketData(tokenAddress, options = {}) {
  const calls = { getTokenHolders, getStats, ...(options.calls && typeof options.calls === "object" ? options.calls : {}) };
  const ethPrice = options.ethUsd !== undefined ? options.ethUsd : await ethUsd({ calls });

  /**
   * TWO PHASES, AND THE SPLIT IS WHERE THE MEASUREMENT PUT IT.
   *
   * The v4 read has exactly one fragile step — the two `eth_getLogs` calls that find the
   * token's pools — and the v3 sweep is ~170 concurrent `eth_call`s on the same endpoint.
   * Run together, the log queries lost: verified live, PIPECAT's second query came back "log
   * query timed out" and then four retries came back 429, and The Green Bull — which has 48
   * v4 pools — reported `discovery_failed` on every attempt. Run on a quiet endpoint the same
   * queries take ~370-670ms and succeed 16 times out of 16.
   *
   * So DISCOVERY goes first and alone, and everything after it — pool state, the tick ladder,
   * the pricing — is batched `eth_call`s that overlap the v3 sweep at no cost. The serial
   * cost is the part that had to be paid for the answer to exist: about a second, against a
   * v3 sweep of 5.2s. It is deliberately NOT the whole v4 read placed in front, which is the
   * mistake resolvePool already had to undo once when the stablecoin verification sat ahead
   * of the WETH sweep.
   */
  const v4Ready = await v4Discover(tokenAddress, { ...options, calls });
  const [priced, v4] = await Promise.all([
    priceFromPool(tokenAddress, { ...options, calls, ethUsd: ethPrice }),
    v4Market(tokenAddress, { ...options, calls }, ethPrice, v4Ready),
  ]);
  const v4Reported = v4Block(v4);

  const shell = {
    price: null,
    marketCap: null,
    liquidityUsd: null,
    quoteLiquidityUsd: null,
    quoteBalanceUsd: null,
    depthIsLowerBound: false,
    depthCoveredBandBps: null,
    wideDepthUsd: null,
    wideDepthIsLowerBound: false,
    depthBandBps: RANK_BAND_BPS,
    wideBandBps: WIDE_BAND_BPS,
    source: "uniswap_v3",
    quote: priced.quote ?? null,
    pool: priced.pool ?? null,
    fee: priced.fee ?? null,
    poolCount: priced.poolCount ?? null,
    asOfBlock: priced.asOfBlock ?? null,
  };

  if (!priced.ok) {
    /**
     * V4 CARRIES THE ANSWER WHEN V3 HAS NONE — the defect, closed.
     *
     * The figures below are the v4 module's and are stamped `source: "uniswap_v4"` all the
     * way out; nothing here is blended with a v3 figure, because there is no v3 figure to
     * blend with. What v3 said is kept verbatim as `v3Reason` / `v3Detail` rather than
     * discarded: "this token has no v3 pool, and its price comes from a v4 one" is a more
     * useful and more honest statement than either half alone, and the sentence layer needs
     * both to write it.
     *
     * THE V3 DEPTH FIELDS STAY NULL, and that is not laziness. A v4-sourced price carries a
     * v4-measured depth in `quoteLiquidityUsd`, and the two are the same integral over the
     * same band — but `quoteBalanceUsd` and `liquidityUsd` have no v4 meaning at all,
     * because the singleton custodies every pool's tokens together and its balance is a
     * chain-wide total rather than this pool's holdings. See lib/dex-v4.js.
     */
    if (v4?.ok) {
      return {
        ...shell,
        source: "uniswap_v4",
        price: v4.price,
        marketCap: v4.marketCap,
        priceInQuote: v4.priceInQuote ?? null,
        priceNative: v4.priceNative ?? null,
        quote: v4.quote ?? null,
        pool: v4.poolId ?? null,
        fee: v4.fee ?? null,
        tickSpacing: v4.tickSpacing ?? null,
        hooks: v4.hooks ?? null,
        // A HOOK RUNS INSIDE THE SWAP, so it travels with the figure. It does not make the
        // price wrong — the pool's committed state says what it says — and it does mean the
        // depth is a statement about that state rather than a promise about execution.
        hooked: v4.hooked === true,
        poolCount: finiteOrNull(v4.poolCount),
        asOfBlock: finiteOrNull(v4.asOfBlock),
        quoteLiquidityUsd: finiteOrNull(v4.quoteLiquidityUsd),
        depthIsLowerBound: v4.depthIsLowerBound === true,
        depthCoveredBandBps: finiteOrNull(v4.depthCoveredBandBps),
        wideDepthUsd: finiteOrNull(v4.wideDepthUsd),
        wideDepthIsLowerBound: v4.wideDepthIsLowerBound === true,
        // Measured, so it may be judged — on the same floor and by the same rule as a v3
        // figure, including the rule that a LOWER BOUND below the floor is null rather than
        // "thin", because a figure that counts upward cannot show depth is missing.
        thinLiquidity:
          finiteOrNull(v4.quoteLiquidityUsd) === null
            ? null
            : v4.quoteLiquidityUsd >= THIN_LIQUIDITY_USD
              ? false
              : v4.depthIsLowerBound === true
                ? null
                : true,
        discovery: "v4_initialize_log",
        v4: v4Reported,
        alsoOnUniswapV4: alsoOnV4(v4Reported),
        v3Reason: priced.reason,
        v3Detail: priced.detail ?? null,
        ...(v4.marketCap === null ? { marketCapReason: v4.marketCapReason ?? "supply_unknown" } : {}),
      };
    }
    return {
      ...shell,
      // A quote-denominated price survives a missing ETH/USD; the dollar figures
      // do not. Carrying it is strictly more than the caller had, and it is
      // labelled, so it cannot be mistaken for dollars.
      priceInQuote: priced.priceInQuote ?? null,
      priceNative: priced.priceNative ?? null,
      // STILL EXACTLY THE V3 REASON. Neither venue priced the token, and what v3 concluded
      // about v3 is not changed by what v4 concluded about v4 — the two facts are reported
      // side by side and joined into one sentence a layer up, where both are in hand.
      reason: priced.reason,
      detail: priced.detail ?? null,
      v4: v4Reported,
      alsoOnUniswapV4: alsoOnV4(v4Reported),
    };
  }

  // Prefer what the caller already fetched; only touch the chain if it has none.
  let supplyRaw = options.totalSupply;
  let decimals = options.decimals;
  if (supplyRaw == null) {
    const res = await attempt(() =>
      options.client.readContract({ address: normalizeAddress(tokenAddress), abi: ERC20_ABI, functionName: "totalSupply" }),
    );
    supplyRaw = res.ok ? res.value : null;
  }
  if (decimals == null) decimals = await readDecimals(options.client, tokenAddress);

  const supply = supplyToNumber(supplyRaw, decimals);
  const marketCap = mul(supply, priced.priceUsd);

  return {
    ...shell,
    price: priced.priceUsd,
    priceInQuote: priced.priceInQuote,
    priceNative: priced.priceNative,
    marketCap,
    liquidityUsd: priced.liquidityUsd ?? null,
    quoteLiquidityUsd: priced.quoteLiquidityUsd ?? null,
    // Held and the wide band travel BESIDE the ranking depth, never instead of it.
    quoteBalanceUsd: priced.quoteBalanceUsd ?? null,
    depthIsLowerBound: Boolean(priced.depthIsLowerBound),
    depthCoveredBandBps: priced.depthCoveredBandBps ?? null,
    wideDepthUsd: priced.wideDepthUsd ?? null,
    wideDepthIsLowerBound: Boolean(priced.wideDepthIsLowerBound),
    depthBandBps: priced.depthBandBps ?? RANK_BAND_BPS,
    wideBandBps: priced.wideBandBps ?? WIDE_BAND_BPS,
    thinLiquidity: priced.thinLiquidity ?? null,
    discovery: priced.discovery,
    // WHAT THE OTHER VENUE HAS, BESIDE THE FIGURES AND NEVER MIXED INTO THEM. Every number
    // above is v3's; this says whether the token also trades on v4 and what was measured
    // there. A reader shown only the v3 side of a token with markets on both has been told
    // the truth about one venue and left to assume it is the whole market.
    v4: v4Reported,
    // Three-valued, and set on every path — see alsoOnV4.
    alsoOnUniswapV4: alsoOnV4(v4Reported),
    // Absent supply is an absent market cap with a stated cause, never a zero.
    ...(marketCap === null ? { marketCapReason: "supply_unknown" } : {}),
  };
}

export {
  DEFAULT_FACTORY,
  DEFAULT_V4_POOL_MANAGER,
  DEFAULT_WETH,
  FEE_TIERS,
  MAX_HOLDER_PROBES,
  MAX_POOLS_MEASURED,
  MIN_STABLE_QUOTE_DEPTH_USD,
  PEG_TOLERANCE,
  RANK_BAND_BPS,
  REASONS,
  THIN_LIQUIDITY_USD,
  WIDE_BAND_BPS,
  supplyToNumber,
};
