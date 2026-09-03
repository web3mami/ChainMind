import {
  ENRICHMENT_TIMEOUT_MS,
  deadline,
  getAddressTransactions,
  getTokenHolders,
  getTokenTransfers,
} from "./blockscout.js";
import { resolvePool, resolveV4PoolManager } from "./dex-price.js";
import { finiteOrNull } from "./format-number.js";
import { noteBudgetSkip, outOfTimeFor } from "./request-budget.js";

/**
 * HOW LONG THE TOP HOLDERS HAVE ACTUALLY HELD, and whether they arrived TOGETHER —
 * both read off one pass of first acquisitions.
 *
 * THE CHEAP PATH, MEASURED. A token's own transfer feed
 * (/tokens/{t}/transfers) is 50 rows a page, newest first, and walking it back to
 * a holder's first buy means paging through everyone else's trades to find one
 * address. /addresses/{a}/token-transfers?token={t} returns just THAT address's
 * history with THAT token, also 50 a page and also newest first, so ONE call per
 * holder yields their first acquisition — the oldest row on the page. Ten holders
 * is ten calls, and every one of them goes through lib/indexer-cache.js, so the
 * second question about the same token costs nothing.
 *
 * WHAT THE FIRST LIVE RUN OF THIS PROVED, and why the module is shaped the way it
 * is. Against The Green Bull (0x31be…bf81), the top ten "holders" were:
 *
 *   0x42607B2E4f  blk  4050099  21.5d   6 transfers
 *   0x8f450B8EE3  blk 21538348   1.2d  50 transfers, TRUNCATED  <- the Uniswap pool
 *   0x0000000000  blk  4052329  21.5d   7 transfers             <- the burn address
 *   0xfC283d4DB5  blk  9142261  15.6d   5 transfers
 *   0x31BE8f7485  blk  4175794  21.4d   1 transfer              <- the token itself
 *   0xC15D9678a1  blk  7979829  17.0d  19 transfers
 *   0x875813aE0A  blk  4050279  21.5d  17 transfers
 *   0x71f2F1c2dc  blk  4052329  21.5d   4 transfers
 *   0xfa23Da5065  blk  7853322  17.1d  50 transfers, TRUNCATED
 *   0xa226c8CD4a  blk        ?      ?   0 transfers returned
 *
 * Four separate ways a naive version of this lies, all present in ten rows:
 *
 *  1. THREE OF THE TEN ARE NOT HOLDERS. The Uniswap pool, the burn address and the
 *     token contract itself all sit in a balance-ranked list. A pool's "hold time"
 *     is a fact about when liquidity was added, not about anyone's conviction, and
 *     a median computed over it is not a median of holders. They are LABELLED and
 *     kept in the table — not silently dropped — so the rows still add up to the
 *     top ten the reader can see on the explorer, and they are excluded from every
 *     statistic. The v3 pool is identified by lib/dex-price.js resolvePool, the
 *     UNISWAP V4 POOLMANAGER by lib/dex-price.js resolveV4PoolManager — which asks
 *     the chain whether the configured address BEHAVES like the singleton, because a
 *     v4 pool has no per-pool contract for a factory sweep to find and one address
 *     custodies every token — the burn address by being one of the two unspendable
 *     sinks (see DEAD_ADDRESS — the live top ten uses 0x0000…dEaD, not the zero
 *     address) and the contract by being the token: four rules, no hardcoded list of
 *     addresses to go stale.
 *  2. A FULL PAGE MEANS THE TRUE FIRST ACQUISITION IS EARLIER. 50 rows and a
 *     next-page cursor is a history longer than we read, so the oldest row we saw
 *     is not the first — the real hold time is LONGER than the figure. It travels
 *     as a LOWER BOUND ("held at least N days"), never as a measurement, the same
 *     way lib/tick-depth.js returns a capped tick walk as a labelled lower bound
 *     rather than refusing to answer.
 *  3. ZERO TRANSFERS RETURNED IS UNKNOWN, NOT ZERO DAYS. 0xa226c8CD4a came back
 *     empty. Rendering that as a first acquisition of "now" would invent the single
 *     most alarming row in the table — a fresh buyer in the top ten — out of a read
 *     that told us nothing. Unknown is a status here, with a reason attached.
 *  4. TWO HOLDERS SHARE BLOCK 4052329, and two more are within ~2,200 blocks of it.
 *     That is the shape detectBundle exists to report — and it is EVIDENCE OF
 *     COORDINATION, not proof of intent. An airdrop, a contract migration, a team
 *     allocation and a genuine sniper bundle are indistinguishable from this angle.
 *     This module states what was observed and stops.
 *
 * A NOTE ON WHAT IS NEVER SAID. Nothing here emits the word "scam", assigns a
 * score, or names a motive. The strongest sentence it will produce is that N
 * addresses acquired inside one narrow window and hold X% of supply between them,
 * with the alternative explanations listed beside it.
 *
 * COST. Bounded at MAX_HOLDERS_PROBED addresses through a worker pool of
 * PROBE_CONCURRENCY, so ten holders is three waves of indexer calls rather than a
 * burst of ten — measured, this indexer loses roughly half of a tight burst of 30.
 * Every read is on the enrichment deadline and clamped by lib/request-budget.js, so
 * a holder that could not be read inside the request's remaining time comes back
 * UNKNOWN with that reason, and never as a fresh buy.
 *
 * Server-side only: no React, no next/*. Every indexer call and the pool resolver
 * are injectable, so test/holder-history.test.mjs exercises all of it offline.
 */

/* --------------------------------- limits -------------------------------- */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** The burn/mint sink. A rule, not a list — see the header. */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * The OTHER burn sink, and the reason this is a two-entry set rather than one
 * equality test.
 *
 * MEASURED: The Green Bull's top ten contains 0x0000…dEaD holding 0.9% of supply,
 * not the zero address. ERC-20 has no burn opcode, so a token without a burn
 * function is destroyed by sending it somewhere nobody holds the key to, and the
 * two conventional sinks are the zero address and this one. Matching only the
 * first labelled a burn as a holder and counted supply that is gone toward the
 * hold-time figures — which is the exact failure this whole module exists to
 * avoid, arriving through the one address a reader would recognise on sight.
 *
 * It stays a RULE and not a growing list: these are the two addresses the
 * ecosystem treats as unspendable, and a table of "known dead wallets" would go
 * stale the week after it was written.
 */
export const DEAD_ADDRESS = "0x000000000000000000000000000000000000dead";

const BURN_ADDRESSES = new Set([ZERO_ADDRESS, DEAD_ADDRESS]);

/**
 * How many top holders get a first-acquisition probe.
 *
 * TEN, because ten is what the ask route can afford. One probe is one indexer
 * call; measured, this indexer answers an address's token-transfer page in a few
 * hundred milliseconds and falls over on tight bursts, so ten in waves of four is
 * seconds against lib/request-budget.js ASK_BUDGET_MS of 24s — of which the
 * evidence gather has already spent up to 4s before this runs.
 *
 * It is also enough to ANSWER the question. Concentration on this chain lives in
 * the top few addresses, and a bundle that does not reach the top ten is not the
 * finding anyone is asking about. A caller wanting fewer passes `limit`; nothing
 * may ask for more, because the bound is what makes the feature affordable at all.
 */
export const MAX_HOLDERS_PROBED = 10;

/**
 * How many probes run at once.
 *
 * FOUR, not ten. The cache in lib/indexer-cache.js absorbs repeats and duplicates
 * but nothing absorbs ten distinct URLs issued in the same millisecond, and the
 * measured failure mode of this indexer is exactly that: a burst of ~30 requests
 * loses roughly half to timeouts, where the same calls spaced out all land. Four
 * concurrent is ~3 waves for a full probe set — a second or two — and leaves the
 * connection budget for the reads the rest of the answer is waiting on.
 */
export const PROBE_CONCURRENCY = 4;

/**
 * The page size this indexer returns for an address's token transfers, measured
 * live on chain 4663.
 *
 * It exists as a constant because it is a TRUNCATION TEST, not a request
 * parameter: a page holding this many rows is a page that may have been cut, and
 * the hold time it implies is therefore a lower bound. See probeFirstAcquisition.
 */
export const TRANSFER_PAGE_SIZE = 50;

/**
 * The thresholds detectBundle fires on, frozen and named for the reason
 * lib/token-evidence.js PATTERN_LIMITS is: these decide whether a real trader is
 * told their token's top holders "arrived together", and a magic number inside an
 * `if` is one nobody can argue with.
 */
export const BUNDLE_LIMITS = Object.freeze({
  /**
   * How near two first acquisitions must be to count as the same cluster.
   *
   * 2,500 BLOCKS, derived from the chain rather than picked. Measured on 4663:
   * block 4,050,099 was 21.5 days ago and block 21,538,348 was 1.2 days ago, which
   * is ~813,000 blocks a day, ~9.4 a second. 2,500 blocks is therefore about four
   * and a half minutes — long enough to hold a launch that took several
   * transactions to distribute (The Green Bull's cluster spans 2,230 blocks), short
   * enough that two independent buyers landing inside it is a coincidence rather
   * than the normal case.
   *
   * Measured from the FIRST member, so a cluster's total span is bounded by this
   * too. Single-linkage chaining would let twenty near-misses accumulate into one
   * "cluster" hours wide, which is not the claim being made.
   */
  WINDOW_BLOCKS: 2_500,
  /**
   * Addresses needed before a cluster is worth naming. THREE — a pair sharing a
   * block is a coincidence with a small denominator, and the same floor
   * lib/token-evidence.js uses for its matched-amount clusters.
   */
  MIN_CLUSTER: 3,
});

/**
 * How many addresses may be asked who funded them, and how far back that read
 * looks. See fundingSources: this is the opt-in leg, and it is the expensive one.
 */
export const MAX_FUNDING_PROBES = 6;
export const FUNDING_PAGE_SIZE = 50;

/**
 * Time worth STARTING one probe with, and one funding read with.
 *
 * The question is "is it worth starting", not "has the clock run out" — a call
 * given 200ms of an 8s budget fails, and having failed it reports an indexer
 * outage, which is a claim about an upstream that was never really asked. Not
 * starting it and saying so is the honest version of the same shortage. See
 * lib/request-budget.js outOfTimeFor.
 */
const PROBE_MIN_MS = 1_200;
const FUNDING_MIN_MS = 2_000;

/**
 * The indexer calls, overridable per call — the same test seam
 * lib/token-evidence.js and lib/ask-evidence.js use. Nothing in this module may
 * reach Blockscout during a unit test.
 */
const DEFAULT_CALLS = Object.freeze({
  getAddressTransactions,
  getTokenHolders,
  getTokenTransfers,
});

/* -------------------------------- plumbing -------------------------------- */

/** Lowercased 0x address, or null when the field is not an address at all. */
function lowerAddress(v) {
  if (v && typeof v === "object") return lowerAddress(v.hash ?? v.address ?? null);
  const s = String(v ?? "").trim().toLowerCase();
  return ADDRESS_RE.test(s) ? s : null;
}

/** 0x1234567890abcdef… -> "0x1234…cdef", the form every surface here uses. */
function shortHex(value) {
  const v = String(value ?? "");
  return v.length > 12 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v;
}

/** An indexer timestamp as epoch milliseconds, or null when it is unreadable. */
function timeMs(value) {
  if (value == null) return null;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
}

/** A block number as a positive integer, or null. Never 0 — block 0 is not a buy. */
function blockNumber(value) {
  const n = finiteOrNull(value);
  return n !== null && Number.isInteger(n) && n > 0 ? n : null;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** "2,230 blocks", with the separator a reader expects at seven digits. */
function blockWords(n) {
  return `${Math.round(n).toLocaleString("en-US")} block${Math.round(n) === 1 ? "" : "s"}`;
}

/** "4m", "3h 20m", "6 days" — a span said the way a reader would say it. */
function spanWords(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

/**
 * A hold time as the sentence it must be quoted as.
 *
 * The "at least" is not decoration and it is not the caller's job to remember: a
 * lower bound rendered as a plain figure IS a false claim, so the qualifier is
 * baked into the string at the only place that knows the bound exists.
 */
function holdWords(days, isLowerBound) {
  if (days === null) return null;
  const d = `${round1(days)} day${round1(days) === 1 ? "" : "s"}`;
  return isLowerBound ? `at least ${d}` : d;
}

/** Run a read without letting it fail the gather. Same shape as lib/dex-price.js. */
async function attempt(thunk) {
  try {
    return { ok: true, value: await thunk() };
  } catch (error) {
    return { ok: false, value: null, error };
  }
}

/**
 * Map over `items` with at most `limit` in flight.
 *
 * Promise.all over ten addresses is one burst of ten, which is the shape this
 * indexer drops requests on (see PROBE_CONCURRENCY). A worker pool keeps the
 * result ORDER — `out[i]` is `items[i]`'s answer — so the rows come back ranked
 * by balance regardless of which probe settled first, and a slow holder cannot
 * reorder the table.
 */
async function mapPooled(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const i = next;
        next += 1;
        if (i >= items.length) return;
        out[i] = await worker(items[i], i);
      }
    }),
  );
  return out;
}

/* ------------------------------ role labelling ---------------------------- */

/** The four things an address in a balance-ranked list can be. */
export const HOLDER_ROLES = Object.freeze({
  HOLDER: "holder",
  POOL: "pool",
  BURN: "burn",
  CONTRACT: "contract",
});

/**
 * EVERY POOL ADDRESS FOR THIS TOKEN, and whether that question was answered.
 *
 * IDENTIFYING A POOL IS A WEAKER QUESTION THAN PRICING THROUGH ONE, and this is
 * where the two part company. lib/dex-price.js resolvePool refuses to NAME a
 * winner when a rival pool went unread or lost on a lower bound, because the
 * selection decides a price — but the addresses it swept are still pool addresses,
 * and labelling a row does not require knowing which pool is deepest. So every
 * candidate it found is taken, `found` included, even when it declined to pick.
 *
 * THE STATUS IS THE HONEST HALF. "resolved" means the sweep produced addresses;
 * "none" means the chain answered and this token has no pool, so an unlabelled row
 * genuinely is not one; "unread" means nobody looked or the look failed, and then
 * a pool may be sitting in the holder list wearing a holder's label. That third
 * case is carried into holdTimeSummary as a caveat rather than being quietly
 * treated as the second — an outage must not read as an absence.
 *
 * THE UNISWAP V4 SINGLETON IS RESOLVED ALONGSIDE, and it is not in `pools` because it
 * is not this token's pool — it is EVERY token's pool. v4 keeps all pools in one
 * contract that custodies all of them, so the address is the same whatever token is
 * being asked about and it comes back in its own field with its own status. It is
 * resolved here rather than by the callers because this is already the one place that
 * turns "what pools does this token have" into something classifyRole can use, and a
 * second resolver in three call sites is three places to forget one.
 *
 * RESOLVING IT PER TOKEN COSTS NOTHING EXTRA. lib/dex-price.js resolveV4PoolManager
 * keeps a confirmed verdict in its process-lifetime fact map and, while that is cold,
 * behind a single-flight gate — so four tokens asking at once is one round trip and
 * every later question is free. See its header.
 *
 * @param {string} token
 * @param {{ client?: object, calls?: object, resolvePool?: Function,
 *   resolveV4PoolManager?: Function }} [options]
 * @returns {Promise<{ pools: Set<string>, status: "resolved"|"none"|"unread",
 *   reason: string|null, v4: { address: string|null, status: string, reason: string|null } }>}
 */
export async function tokenPoolAddresses(token, options = {}) {
  const resolver = typeof options.resolvePool === "function" ? options.resolvePool : resolvePool;
  const v4Resolver =
    typeof options.resolveV4PoolManager === "function" ? options.resolveV4PoolManager : resolveV4PoolManager;
  // Concurrent: the v4 verdict does not depend on the token and the v3 sweep does not
  // depend on the verdict, so serialising them would put one round trip in front of
  // every hold time for nothing.
  const [res, v4Res] = await Promise.all([
    attempt(() => resolver(token, { client: options.client, calls: options.calls })),
    attempt(() => v4Resolver({ client: options.client, calls: options.calls })),
  ]);
  const v4 =
    v4Res.ok && v4Res.value && typeof v4Res.value === "object"
      ? {
          address: lowerAddress(v4Res.value.address),
          status: typeof v4Res.value.status === "string" ? v4Res.value.status : "unread",
          reason: v4Res.value.reason ?? null,
        }
      : { address: null, status: "unread", reason: "the Uniswap v4 PoolManager check did not complete" };

  if (!res.ok || !res.value || typeof res.value !== "object") {
    return { pools: new Set(), status: "unread", reason: "the pool lookup did not complete", v4 };
  }
  const { found, pools, reason } = res.value;
  const addresses = new Set();
  for (const row of Array.isArray(pools) ? pools : []) {
    const a = lowerAddress(row?.pool);
    if (a) addresses.add(a);
  }
  const winner = lowerAddress(found?.pool);
  if (winner) addresses.add(winner);

  if (addresses.size) return { pools: addresses, status: "resolved", reason: null, v4 };
  // The chain answered and there is nothing there — the one case where an
  // unlabelled row can be relied on not to be a pool.
  if (reason === "no_pool") return { pools: addresses, status: "none", reason: null, v4 };
  return {
    pools: addresses,
    status: "unread",
    reason:
      reason === "no_client"
        ? "no RPC client was supplied, so this token's pool was never looked for"
        : `the pool lookup did not settle (${reason ?? "no reason given"})`,
    v4,
  };
}

/**
 * What one address IS, relative to this token. Four rules, no address list.
 *
 * Order matters only for the token contract, which on some deployments is also a
 * pool participant; the contract identity is the more specific fact about it.
 *
 * EXPORTED because lib/cross-token.js asks the same question about the same
 * addresses against SEVERAL tokens at once, and there must be exactly one
 * definition of "this is a pool, not a position" in this codebase. A second copy
 * would drift, and the drift would surface as a Uniswap pool printed as the most
 * interesting wallet holding two tokens.
 *
 * THE FOURTH RULE IS THE UNISWAP V4 POOLMANAGER, and it exists because that drift
 * happened for real in the one shape this function could not see. The v3 rule is a
 * SET of per-token pool addresses; v4 has no such thing — one singleton contract holds
 * every pool on the chain and custodies every token in it — so the address arrives
 * separately, already verified by BEHAVIOUR (lib/dex-price.js resolveV4PoolManager
 * probes extsload/protocolFeeController and requires that token0()/token1() are
 * absent), never as a name or a hardcoded entry. Measured: holder_overlap on PIPECAT +
 * MERRYMEN presented that singleton as the largest position on the table, holding
 * 50.5% of one token and 0.7% of the other. It is the market's balance, not anyone's.
 *
 * `v4PoolManager` ABSENT IS NOT "IT IS NOT THE MANAGER". A caller that could not
 * resolve the singleton passes null and gets the labels it would have got before, which
 * is why every caller also carries the v4 status into its own caveat — an unresolved
 * check leaves a row labelled a wallet that may be v4 liquidity, and that is said out
 * loud rather than assumed away.
 *
 * @param {string} address - lowercased
 * @param {{ token: string, pools: Set<string>, v4PoolManager?: string|null }} context
 */
export function classifyRole(address, { token, pools, v4PoolManager = null }) {
  if (address === token) {
    return { role: HOLDER_ROLES.CONTRACT, reason: "this is the token contract's own address", poolVersion: null };
  }
  if (BURN_ADDRESSES.has(address)) {
    return {
      role: HOLDER_ROLES.BURN,
      reason:
        address === ZERO_ADDRESS
          ? "the zero address — tokens sent here are burned, not held"
          : "the 0x…dEaD burn address — tokens sent here are burned, not held",
      poolVersion: null,
    };
  }
  if (pools.has(address)) {
    return {
      role: HOLDER_ROLES.POOL,
      reason: "the token's Uniswap v3 pool — this balance is liquidity, not a position",
      // WHICH KIND of pool, as a field rather than as something a caller sniffs out of
      // the sentence: "the token's own pool" and "the singleton that holds every pool
      // on the chain" are different things to tell a reader, and a table that has to
      // regex-match prose to tell them apart will one day match the wrong one.
      poolVersion: "v3",
    };
  }
  if (v4PoolManager && address === v4PoolManager) {
    return {
      role: HOLDER_ROLES.POOL,
      reason:
        "the Uniswap v4 PoolManager — v4 keeps every pool in one contract and custodies every token in it, so this balance is pooled liquidity rather than a position, and the same address holds many unrelated tokens for the same reason",
      poolVersion: "v4",
    };
  }
  return { role: HOLDER_ROLES.HOLDER, reason: null, poolVersion: null };
}

/** Is this role one whose hold time says something about conviction? */
function isRealHolder(row) {
  return row?.role === HOLDER_ROLES.HOLDER;
}

/* ------------------------------- the probe -------------------------------- */

/**
 * ONE ADDRESS'S FIRST ACQUISITION OF ONE TOKEN — the oldest row on its transfer
 * page — plus whether that page was the whole story.
 *
 * THE OLDEST ROW IS TAKEN BY MINIMUM BLOCK, not by position. The endpoint returns
 * newest first and has done on every measured call, but a table whose meaning
 * depends on an undocumented ordering breaks silently the day the indexer changes
 * it, and the minimum is the same cost.
 *
 * THREE OUTCOMES, AND THEY ARE THREE DIFFERENT FACTS:
 *
 *   - measured, exact: a short page. The oldest row IS the first acquisition.
 *   - measured, lower bound: a full page, or a next-page cursor. There are older
 *     transfers we did not read, so the true first acquisition is EARLIER and the
 *     true hold time is LONGER than the figure. `isLowerBound` says so and
 *     `holdDisplay` says "at least N days" so the qualifier cannot be dropped in
 *     transit.
 *   - unknown: the call failed, or came back with no rows, or with rows carrying
 *     no block number. NONE of those is a hold time of zero. An empty history for
 *     an address that demonstrably holds the token is a read that told us nothing,
 *     and rendering it as a first acquisition of "now" would manufacture the most
 *     alarming row in the table out of thin air.
 *
 * @param {string} address - lowercased
 * @param {string} token
 * @param {{ calls: object, now: number, timeoutMs: number }} ctx
 * @returns {Promise<object>} the measurement half of a holder row
 */
async function probeFirstAcquisition(address, token, ctx) {
  const res = await attempt(() =>
    ctx.calls.getTokenTransfers(address, { token }, deadline(ctx.timeoutMs)),
  );
  if (!res.ok) {
    const status = res.error?.status ?? null;
    return unknownProbe(
      `the indexer did not answer for this address${status ? ` (HTTP ${status})` : ""}, so its first acquisition is unknown — not recent, and not none`,
    );
  }
  const items = Array.isArray(res.value?.items) ? res.value.items : null;
  if (items === null) {
    return unknownProbe("the indexer returned no transfer list for this address, so its first acquisition is unknown");
  }
  // A FULL PAGE IS A CUT PAGE, even without a cursor. Exactly 50 rows and no
  // next-page params is ambiguous — a history of exactly 50, or a cursor the
  // indexer omitted — and the two mistakes are not symmetric: calling an exact
  // figure a lower bound costs a qualifier, calling a lower bound exact is a false
  // claim about how long somebody has held.
  const truncated = Boolean(res.value?.next_page_params) || items.length >= TRANSFER_PAGE_SIZE;

  let oldest = null;
  for (const item of items) {
    const block = blockNumber(item?.block_number);
    if (block === null) continue;
    if (oldest === null || block < oldest.block) oldest = { block, item };
  }
  if (oldest === null) {
    return unknownProbe(
      items.length
        ? `${items.length} transfer${items.length === 1 ? "" : "s"} came back for this address but none carried a block number, so its first acquisition is unknown`
        : "the indexer returned no transfers of this token for this address, so its first acquisition is unknown — this is an unread history, not a new buyer",
    );
  }

  const firstTimestamp = oldest.item?.timestamp ?? null;
  const firstMs = timeMs(firstTimestamp);
  // A block with no timestamp still pins WHEN in chain order, just not in days.
  const holdDays = firstMs === null ? null : Math.max(0, (ctx.now - firstMs) / 86_400_000);
  return {
    status: "measured",
    firstBlock: oldest.block,
    firstTimestamp,
    firstTimestampMs: firstMs,
    holdDays: holdDays === null ? null : round1(holdDays),
    holdDisplay: holdWords(holdDays, truncated),
    isLowerBound: truncated,
    transfersRead: items.length,
    reason: truncated
      ? "the transfer page was full, so there are older transfers than the ones read — the true first acquisition is earlier and the hold time is longer than this"
      : null,
  };
}

/** The measurement half of a row whose history was not read. Never a zero. */
function unknownProbe(reason) {
  return {
    status: "unknown",
    firstBlock: null,
    firstTimestamp: null,
    firstTimestampMs: null,
    holdDays: null,
    holdDisplay: null,
    isLowerBound: false,
    transfersRead: 0,
    reason,
  };
}

/* ---------------------------- the one pass -------------------------------- */

/**
 * Normalise whatever the caller handed us as a holder list.
 *
 * Accepts raw getTokenHolders items ({ address: { hash }, value }) and the
 * flattened rows lib/token-evidence.js holderRows produces ({ address, percent }),
 * because both callers exist and neither should have to convert. A percent that is
 * not a finite number stays NULL — a holder shown as owning 0% of a token they
 * demonstrably hold is the sharpest false claim this product could make.
 */
function normalizeHolders(holders) {
  const out = [];
  for (const h of Array.isArray(holders) ? holders : []) {
    const address = lowerAddress(h?.address ?? h?.hash ?? h);
    if (!address) continue;
    const percent = typeof h?.percent === "number" && Number.isFinite(h.percent) ? h.percent : null;
    out.push({ address, percent, raw: h });
  }
  return out;
}

/**
 * FIRST ACQUISITION FOR A TOKEN'S TOP HOLDERS — one bounded, concurrent, cached
 * pass that both holdTimeSummary and detectBundle read from.
 *
 * ONE PASS, TWO FEATURES, deliberately. Hold-time distribution and bundle
 * detection are the same measurement asked two different questions, and running
 * them separately would double the indexer cost of a page that shows both.
 *
 * NOTHING IS DROPPED. The pool, the burn address and the token contract stay in
 * `holders` with their role and their own hold time, so the rows still reconcile
 * against the top-N list a reader can see on the explorer. Excluding them happens
 * in the STATISTICS, where including them would be wrong, and it is reported there.
 *
 * @param {string} token - the token contract
 * @param {{ holders?: Array<object>, limit?: number, calls?: object, client?: object,
 *   resolvePool?: Function, resolveV4PoolManager?: Function, now?: number,
 *   timeoutMs?: number, concurrency?: number }} [options]
 * @returns {Promise<{ ok: boolean, token: string|null, holders: Array<object>,
 *   probed: number, measured: number, unknown: number, poolStatus: string,
 *   poolReason: string|null, pools: Array<string>, v4PoolManager: string|null,
 *   v4Status: string, v4Reason: string|null, unavailable: Array<string>,
 *   error?: string }>}
 */
export async function holderFirstAcquisition(token, options = {}) {
  const tokenAddress = lowerAddress(token);
  if (!tokenAddress) {
    return {
      ok: false,
      token: null,
      holders: [],
      probed: 0,
      measured: 0,
      unknown: 0,
      poolStatus: "unread",
      poolReason: null,
      pools: [],
      v4PoolManager: null,
      v4Status: "unread",
      v4Reason: null,
      unavailable: [],
      error: "That is not a token contract address, so there is nothing to read holder history for.",
    };
  }

  const calls = { ...DEFAULT_CALLS, ...(options.calls && typeof options.calls === "object" ? options.calls : {}) };
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : ENRICHMENT_TIMEOUT_MS;
  const concurrency =
    Number.isInteger(options.concurrency) && options.concurrency > 0 ? options.concurrency : PROBE_CONCURRENCY;
  const limit = Math.max(
    1,
    Math.min(MAX_HOLDERS_PROBED, Number.isFinite(options.limit) ? Math.trunc(options.limit) : MAX_HOLDERS_PROBED),
  );
  const unavailable = [];

  // The holder list, either handed to us (the ask route already has it — see
  // lib/ask-evidence.js, which fetches holders for every token answer) or fetched.
  // Reusing it is the difference between one indexer call and eleven.
  let supplied = normalizeHolders(options.holders);
  if (!supplied.length) {
    const res = await attempt(() =>
      calls.getTokenHolders(tokenAddress, { items_count: limit }, deadline(timeoutMs)),
    );
    if (!res.ok) {
      unavailable.push("holders");
      return {
        ok: false,
        token: tokenAddress,
        holders: [],
        probed: 0,
        measured: 0,
        unknown: 0,
        poolStatus: "unread",
        poolReason: null,
        pools: [],
        v4PoolManager: null,
        v4Status: "unread",
        v4Reason: null,
        unavailable,
        error:
          "The Robinhood Chain indexer did not answer, so this token's holder list could not be read — unknown, not empty. Try again shortly.",
      };
    }
    supplied = normalizeHolders(res.value?.items);
  }

  const ranked = supplied.slice(0, limit);
  if (!ranked.length) {
    return {
      ok: true,
      token: tokenAddress,
      holders: [],
      probed: 0,
      measured: 0,
      unknown: 0,
      poolStatus: "unread",
      poolReason: "no holders were returned, so no pool lookup was made",
      pools: [],
      v4PoolManager: null,
      v4Status: "unread",
      v4Reason: "no holders were returned, so no pool lookup was made",
      unavailable,
    };
  }

  // The pool sweep runs CONCURRENTLY with the probes, not before them. It is an
  // RPC-side question and they are indexer-side ones; serialising put a full
  // factory sweep in front of every hold time for nothing (the same latency bug
  // lib/dex-price.js resolvePool fixed by running its stablecoin verification
  // alongside the WETH sweep).
  const poolPromise = tokenPoolAddresses(tokenAddress, {
    client: options.client,
    calls: options.calls,
    resolvePool: options.resolvePool,
    resolveV4PoolManager: options.resolveV4PoolManager,
  });

  const probes = await mapPooled(ranked, concurrency, async (h) => {
    // Checked per holder rather than once up front: the wave that starts with time
    // in hand may be the one that runs out, and the honest report of that is a row
    // marked unknown-for-time, not a row marked unknown-for-outage.
    if (outOfTimeFor(PROBE_MIN_MS)) {
      noteBudgetSkip("holderFirstAcquisition");
      return unknownProbe(
        "this address was not read because the request ran short of time — its first acquisition is unknown, not recent",
      );
    }
    return probeFirstAcquisition(h.address, tokenAddress, { calls, now, timeoutMs });
  });

  const pool = await poolPromise;
  if (pool.status === "unread") unavailable.push("pool_identification");
  // Its own entry: the v3 sweep and the v4 singleton are two different questions, and
  // a run where one settled and the other did not must not report either as both.
  if (pool.v4.status === "unread") unavailable.push("v4_pool_identification");

  const holders = ranked.map((h, i) => {
    const { role, reason: roleReason, poolVersion } = classifyRole(h.address, {
      token: tokenAddress,
      pools: pool.pools,
      v4PoolManager: pool.v4.address,
    });
    return {
      rank: i + 1,
      address: h.address,
      role,
      roleReason,
      poolVersion,
      percent: h.percent,
      percentDisplay: h.percent === null ? null : `${round2(h.percent)}%`,
      ...probes[i],
    };
  });

  return {
    ok: true,
    token: tokenAddress,
    holders,
    probed: holders.length,
    measured: holders.filter((h) => h.status === "measured").length,
    unknown: holders.filter((h) => h.status === "unknown").length,
    poolStatus: pool.status,
    poolReason: pool.reason,
    pools: [...pool.pools],
    // The v4 verdict travels beside the v3 one so holdTimeSummary can caveat an
    // unresolved check instead of a caller inferring it from a missing address.
    v4PoolManager: pool.v4.address,
    v4Status: pool.v4.status,
    v4Reason: pool.v4.reason,
    unavailable,
  };
}

/* ----------------------------- hold-time stats ---------------------------- */

/**
 * THE DISTRIBUTION OF HOLD TIMES ACROSS REAL HOLDERS — median, range, and every
 * reason the figure is narrower than the top-N list it came from.
 *
 * WHO IS IN IT. Only rows with role "holder" and a measured hold time. A median
 * computed over a Uniswap pool, a burn address and the token contract is not a
 * median of holders: on the measured Green Bull run, three of the top ten were
 * exactly those, and the pool — 1.2 days, because liquidity was last topped up
 * recently — would have dragged the middle of a ten-row distribution down to
 * something no holder experienced.
 *
 * WHY THE MEDIAN OF A MIXED SET IS STILL A HONEST LOWER BOUND. Some members are
 * lower bounds: their true hold time is at least the figure, never less. Every
 * order statistic — min, median, max — is MONOTONE in its inputs, so raising any
 * member can only raise it. The median computed here is therefore a lower bound on
 * the true median, and it is labelled as one whenever any member is bounded. That
 * is a proof, not a convention, and it is why the bounded rows are kept in the
 * calculation instead of being thrown away: dropping them would shrink the sample
 * for no gain in truth.
 *
 * UNKNOWNS ARE COUNTED, NEVER IMPUTED. An address whose history could not be read
 * has no hold time — not a short one — so it sits outside the statistics with its
 * reason, and the count travels beside the median so a reader can see how much of
 * the top N the figure actually speaks for.
 *
 * @param {object} analysis - holderFirstAcquisition's return value
 * @returns {object}
 */
export function holdTimeSummary(analysis) {
  const rows = Array.isArray(analysis?.holders) ? analysis.holders : [];
  const real = rows.filter(isRealHolder);
  const measured = real.filter((r) => r.status === "measured" && typeof r.holdDays === "number");
  const unknownRows = real.filter((r) => !(r.status === "measured" && typeof r.holdDays === "number"));

  const excluded = rows
    .filter((r) => !isRealHolder(r))
    .map((r) => ({
      address: r.address,
      role: r.role,
      poolVersion: r.poolVersion ?? null,
      reason: r.roleReason,
      holdDays: r.holdDays,
      holdDisplay: r.holdDisplay,
      isLowerBound: r.isLowerBound,
    }));

  const lowerBounds = measured.filter((r) => r.isLowerBound).length;
  const base = {
    holders: real.length,
    measured: measured.length,
    exact: measured.length - lowerBounds,
    lowerBounds,
    unknown: unknownRows.length,
    unknownRows: unknownRows.map((r) => ({ address: r.address, reason: r.reason })),
    excluded,
    excludedCount: excluded.length,
    poolStatus: analysis?.poolStatus ?? "unread",
    v4Status: analysis?.v4Status ?? "unread",
    // The caveat that keeps an outage from reading as an absence: with the pool
    // lookup unread, an unlabelled row COULD be a pool, so these figures may still
    // contain one. Stated, never assumed away.
    poolCaveat:
      analysis?.poolStatus === "unread"
        ? `This token's pool was not identified (${analysis?.poolReason ?? "the lookup did not settle"}), so one of the addresses counted as a holder below may in fact be the pool. Treat these figures as provisional.`
        : null,
    // A SEPARATE caveat, because it is a separate gap. The v3 sweep can succeed while
    // the v4 singleton check does not, and the v4 manager is a top holder of every
    // token whose market is on v4 — so an unsettled check leaves exactly one row that
    // could be pooled liquidity wearing a holder's label. Only raised when the v3
    // sweep settled: when neither settled, poolCaveat above already says it.
    v4Caveat:
      analysis?.v4Status === "unread" && analysis?.poolStatus !== "unread"
        ? `Whether the Uniswap v4 PoolManager holds this token was not established (${analysis?.v4Reason ?? "the check did not settle"}). v4 keeps every pool in one contract, so if this token trades there its liquidity sits at a single address that would appear in the list below as a large holder. Treat an unusually large unlabelled row with that in mind.`
        : null,
  };

  if (!measured.length) {
    return {
      ...base,
      medianDays: null,
      medianDisplay: null,
      minDays: null,
      maxDays: null,
      rangeDisplay: null,
      isLowerBound: false,
      reading: readingForNoHoldTimes(base),
    };
  }

  const days = measured.map((r) => r.holdDays).sort((a, b) => a - b);
  const mid = Math.floor(days.length / 2);
  const median = days.length % 2 ? days[mid] : (days[mid - 1] + days[mid]) / 2;
  const bounded = lowerBounds > 0;
  const minRow = measured.reduce((a, b) => (b.holdDays < a.holdDays ? b : a));
  const maxRow = measured.reduce((a, b) => (b.holdDays > a.holdDays ? b : a));

  return {
    ...base,
    medianDays: round1(median),
    medianDisplay: holdWords(median, bounded),
    minDays: round1(minRow.holdDays),
    maxDays: round1(maxRow.holdDays),
    rangeDisplay: `${holdWords(minRow.holdDays, minRow.isLowerBound)} to ${holdWords(maxRow.holdDays, maxRow.isLowerBound)}`,
    isLowerBound: bounded,
    reading: readingForHoldTimes({ ...base, median, bounded, minRow, maxRow }),
  };
}

/**
 * How many of the measured holders have held longer than a threshold.
 *
 * WHY A COUNT EXISTS AT ALL. Asked "how many have held more than 3 days", the
 * answer quoted the RANGE — "at least 0.1 to 39.4 days" — which answers a
 * different question, and then did arithmetic across two denominators that do not
 * share a scope. A threshold question needs a threshold answer, computed here
 * where the per-row bounds are still visible, rather than inferred downstream from
 * a median and a spread.
 *
 * THE ASYMMETRY IS THE WHOLE THING, and it is easy to get backwards. A row is a
 * lower bound when its history ran past the page that was read, so its true age is
 * LARGER than the figure:
 *
 *   - "at least 12 days" against a 3-day threshold is a definite YES. The floor
 *     already clears it and a larger true value clears it too.
 *   - "at least 2 days" against a 3-day threshold is UNDETERMINED, never a no.
 *     The true age could be 2 days or two years; the read simply stopped.
 *   - "2 days" EXACT against 3 is a definite no.
 *
 * Counting an undetermined row as a no is the same defect as reading an unknown as
 * a zero: it would report holders as short-term because we stopped looking, and it
 * fails in the direction that makes a token look worse than the chain says.
 *
 * @param {object[]} measured rows with numeric holdDays and an isLowerBound flag
 * @param {number} unreadable how many real holders had no readable age at all
 * @param {number} days the threshold
 * @returns {object|null} null when the threshold is unusable
 */
export function holdersOverThreshold(measured, unreadable, days) {
  // `Number(null)` is 0 and `Number.isFinite(0)` is true, so the obvious guard
  // turns "no threshold asked for" into "count everything over zero days" — a
  // block that answers a question nobody asked, with a figure that looks measured.
  if (days === null || days === undefined || days === "") return null;
  const t = Number(days);
  if (!Number.isFinite(t) || t < 0) return null;
  const rows = Array.isArray(measured) ? measured : [];

  let over = 0;
  let under = 0;
  let undetermined = 0;
  for (const r of rows) {
    const d = typeof r?.holdDays === "number" ? r.holdDays : null;
    if (d === null) { undetermined += 1; continue; }
    if (d > t) { over += 1; continue; }
    // At or below the threshold. Exact means it really is below; a floor below
    // the threshold settles nothing, because the true age is larger by an unknown
    // amount and may well clear it.
    if (r?.isLowerBound) undetermined += 1;
    else under += 1;
  }

  const unread = Number.isFinite(Number(unreadable)) ? Number(unreadable) : 0;
  undetermined += unread;

  const total = over + under + undetermined;
  return {
    thresholdDays: t,
    over,
    under,
    undetermined,
    // ONE DENOMINATOR, STATED. Every count above is out of this and nothing else,
    // so no sentence has to reconstruct a remainder by subtracting across scopes —
    // which is exactly how the reported answer went wrong.
    outOf: total,
    reading: holdThresholdReading({ over, under, undetermined, total, days: t, unread }),
  };
}

/** The finished sentence for a threshold count, with its denominator inside it. */
function holdThresholdReading({ over, under, undetermined, total, days, unread }) {
  // NOTHING SETTLED EITHER WAY is the same answer as nothing read: the count
  // cannot be given. Reporting "0 of 4 held more than 3 days" when all four were
  // undetermined would read as a finding that none of them qualified.
  if (over + under === 0) {
    return `No holding address in this list could be settled against ${days} days${unread > 0 ? `: ${unread} had no readable history at all` : ""}${unread > 0 && undetermined > unread ? ", and the rest have histories that ran past what could be read" : unread === 0 ? ", because every one of their histories ran past what could be read, so the age shown is a floor rather than a figure" : ""}. That is unread, not none — none of them is a holder who failed the mark.`;
  }
  const head = `${over} of the ${total} holding address${total === 1 ? "" : "es"} in this list first received the token more than ${days} days ago.`;
  const parts = [head];
  if (under > 0) parts.push(`${under} first received it more recently than that.`);
  if (undetermined > 0) {
    parts.push(
      `${undetermined} could not be settled either way${unread > 0 ? ` (${unread} had no readable history at all)` : ""}: their histories ran past what could be read, so their true age is larger than the figure shown and may well clear the mark. That is undetermined, not a short hold.`,
    );
  }
  parts.push(
    `This counts AGE since a first acquisition. It is not a count of who has held continuously — an address that bought, sold out and bought back still shows its earliest purchase here.`,
  );
  return parts.join(" ");
}
/** The exclusions as a clause a reader can check, or null when there were none. */
function excludedClause(excluded) {
  if (!excluded.length) return null;
  const names = excluded.map((e) => {
    // The v4 singleton gets its own words: "the Uniswap pool" would imply THIS token's
    // pool, when what is actually there is the one contract that holds every pool on
    // the chain — which is also why the same address turns up against unrelated tokens.
    if (e.role === HOLDER_ROLES.POOL && e.poolVersion === "v4") {
      return `${shortHex(e.address)} (the Uniswap v4 PoolManager — pooled liquidity, not conviction)`;
    }
    if (e.role === HOLDER_ROLES.POOL) return `${shortHex(e.address)} (the Uniswap pool — liquidity, not conviction)`;
    if (e.role === HOLDER_ROLES.BURN) return `${shortHex(e.address)} (the burn address)`;
    return `${shortHex(e.address)} (the token contract itself)`;
  });
  return `${excluded.length} of the addresses in the top list ${excluded.length === 1 ? "is" : "are"} not a holding position and ${excluded.length === 1 ? "is" : "are"} excluded from these figures: ${names.join(", ")}. ${excluded.length === 1 ? "It is" : "They are"} still listed, with ${excluded.length === 1 ? "its" : "their"} own first activity, so the rows reconcile against the explorer's list.`;
}

function readingForNoHoldTimes(base) {
  const parts = [
    base.holders
      ? `None of the ${base.holders} holding address${base.holders === 1 ? "" : "es"} in this list had a readable transfer history, so there is no hold-time distribution to report — that is unread, not "everyone just bought".`
      : "No holding addresses were left to measure once the pool, the burn address and the token contract were set aside, so there is no hold-time distribution to report.",
  ];
  const clause = excludedClause(base.excluded);
  if (clause) parts.push(clause);
  if (base.poolCaveat) parts.push(base.poolCaveat);
  if (base.v4Caveat) parts.push(base.v4Caveat);
  return parts.join(" ");
}

function readingForHoldTimes(s) {
  const parts = [
    `Across the ${s.measured} holding address${s.measured === 1 ? "" : "es"} whose first acquisition could be read, the median hold time is ${holdWords(s.median, s.bounded)}, ranging from ${holdWords(s.minRow.holdDays, s.minRow.isLowerBound)} to ${holdWords(s.maxRow.holdDays, s.maxRow.isLowerBound)}.`,
  ];
  if (s.lowerBounds) {
    parts.push(
      `${s.lowerBounds} of those ${s.lowerBounds === 1 ? "is a LOWER BOUND" : "are LOWER BOUNDS"}: ${s.lowerBounds === 1 ? "that address's" : "those addresses'"} transfer history ran past the one page read, so the real first acquisition is earlier and the real hold time is longer. Because every one of these figures can only move up, the median is a lower bound too — the true median is at least this, never less.`,
    );
  }
  if (s.unknown) {
    parts.push(
      `${s.unknown} holding address${s.unknown === 1 ? "" : "es"} could not be read at all and ${s.unknown === 1 ? "is" : "are"} not in these figures. Unknown is not zero days: nothing here says ${s.unknown === 1 ? "it is" : "they are"} a recent buyer.`,
    );
  }
  const clause = excludedClause(s.excluded);
  if (clause) parts.push(clause);
  if (s.poolCaveat) parts.push(s.poolCaveat);
  if (s.v4Caveat) parts.push(s.v4Caveat);
  return parts.join(" ");
}

/* ---------------------------- bundle detection ---------------------------- */

/**
 * DID THE TOP HOLDERS ARRIVE TOGETHER — and if so, at the launch or later?
 *
 * WHAT COUNTS AS A CANDIDATE, and this is the load-bearing restriction: only
 * holders whose first acquisition is EXACT. A truncated page gives an UPPER bound
 * on the first block (the true one is earlier, we just do not know how much),
 * so two truncated addresses sharing an observed block share nothing but a page
 * boundary. Clustering on them would manufacture bundles out of the busiest
 * addresses in the list — which, on the measured run, were the Uniswap pool and
 * the most active trader. They are reported as ineligible, with the reason, rather
 * than dropped silently: a cluster of 4 out of 7 eligible reads very differently
 * from 4 out of 10, and the reader is owed the denominator.
 *
 * LAUNCH versus LATER. A launch bundle is a tight cluster at or near the token's
 * EARLIEST activity. The earliest block anything in this pass touched is a proven
 * upper bound on that — the token demonstrably existed then — so a cluster that
 * contains it is "at the earliest activity observed here". A truncated row is
 * useful in exactly one direction: its observed block is later than its true first
 * acquisition, so a truncated row observed BEFORE the cluster proves activity
 * predating it, and the cluster is then a LATER coordinated buy rather than a
 * launch. When the caller knows the token's real first block it passes
 * `tokenFirstBlock` and the distinction stops depending on what we happened to
 * probe; `basis` says which of the two was used.
 *
 * WHAT IT NEVER SAYS. Co-acquisition in one window is EVIDENCE OF COORDINATION and
 * not proof of intent. An airdrop, a migration, a team allocation and a sniper
 * bundle produce the same shape from this angle, and the reading says so every
 * time it fires. No score, no motive, no accusation.
 *
 * PURE. Same analysis in, same answer out — no clock, no network. That is what
 * lets the caller run it beside holdTimeSummary on one pass of probes.
 *
 * @param {object} analysis - holderFirstAcquisition's return value
 * @param {{ windowBlocks?: number, minCluster?: number, tokenFirstBlock?: number }} [options]
 * @returns {object}
 */
export function detectBundle(analysis, options = {}) {
  const rows = Array.isArray(analysis?.holders) ? analysis.holders : [];
  const windowBlocks =
    Number.isFinite(options.windowBlocks) && options.windowBlocks > 0
      ? Math.trunc(options.windowBlocks)
      : BUNDLE_LIMITS.WINDOW_BLOCKS;
  const minCluster =
    Number.isInteger(options.minCluster) && options.minCluster >= 2 ? options.minCluster : BUNDLE_LIMITS.MIN_CLUSTER;

  const real = rows.filter(isRealHolder);
  const eligible = real
    .filter((r) => r.status === "measured" && !r.isLowerBound && typeof r.firstBlock === "number")
    .sort((a, b) => a.firstBlock - b.firstBlock);
  const ineligible = real
    .filter((r) => !(r.status === "measured" && !r.isLowerBound && typeof r.firstBlock === "number"))
    .map((r) => ({
      address: r.address,
      reason: r.isLowerBound
        ? "its transfer history was truncated, so its first acquisition is only known to be no later than the block read — too loose to cluster on"
        : (r.reason ?? "its first acquisition could not be read"),
    }));

  const base = {
    found: false,
    kind: null,
    cluster: [],
    eligible: eligible.length,
    ineligible,
    holders: real.length,
    limits: { windowBlocks, minCluster },
  };

  if (eligible.length < minCluster) {
    return {
      ...base,
      reading: `Not enough exactly-pinned first acquisitions to look for a cluster: ${eligible.length} of the ${real.length} holding address${real.length === 1 ? "" : "es"} in this list ${eligible.length === 1 ? "was" : "were"} pinned to a block, and ${minCluster} are needed. This is not a finding that the holders arrived separately — it is a finding that we could not tell.`,
    };
  }

  // Greedy grouping anchored on each start, keeping the LARGEST group and, at equal
  // size, the earliest. Anchoring on the first member bounds the whole cluster's
  // span by the window; single-linkage chaining would let a run of near-misses
  // accumulate into a "cluster" hours wide, which is not the claim being made.
  let best = null;
  for (let i = 0; i < eligible.length; i += 1) {
    const start = eligible[i].firstBlock;
    const group = [];
    for (let j = i; j < eligible.length && eligible[j].firstBlock - start <= windowBlocks; j += 1) {
      group.push(eligible[j]);
    }
    if (!best || group.length > best.length) best = group;
  }

  if (!best || best.length < minCluster) {
    const span = eligible[eligible.length - 1].firstBlock - eligible[0].firstBlock;
    return {
      ...base,
      tightest: best?.length ?? 0,
      spread: { blocks: span, display: blockWords(span) },
      reading: `No bundle. The ${eligible.length} first acquisitions that could be pinned exactly are spread across ${blockWords(span)}, and the tightest group of them inside ${blockWords(windowBlocks)} is ${best?.length ?? 0} address${(best?.length ?? 0) === 1 ? "" : "es"} — under the ${minCluster} this reports on. These holders bought at separate times.${ineligible.length ? ` ${ineligible.length} further address${ineligible.length === 1 ? "" : "es"} could not be pinned exactly and ${ineligible.length === 1 ? "is" : "are"} evidence neither way.` : ""}`,
    };
  }

  const firstBlock = best[0].firstBlock;
  const lastBlock = best[best.length - 1].firstBlock;
  const times = best.map((r) => r.firstTimestampMs).filter((t) => typeof t === "number" && Number.isFinite(t));
  const timeSpanMs = times.length >= 2 ? Math.max(...times) - Math.min(...times) : null;

  // Supply share, counted the way lib/token-evidence.js concentrationOf counts it:
  // an unknown percent summed as zero would UNDERSTATE the cluster, which is the
  // direction that matters when the figure is "how much do they hold between them".
  const known = best.map((r) => r.percent).filter((p) => typeof p === "number" && Number.isFinite(p));
  const supplyPercent = known.length ? round2(known.reduce((acc, p) => acc + p, 0)) : null;
  const supply = {
    percent: supplyPercent,
    counted: known.length,
    of: best.length,
    complete: known.length === best.length,
    display:
      supplyPercent === null
        ? null
        : known.length === best.length
          ? `${supplyPercent}% of supply`
          : `${supplyPercent}% of supply across the ${known.length} of ${best.length} whose share is known`,
  };

  // Is anything in this pass known to predate the cluster? An exact row before it
  // is decisive; a TRUNCATED row observed before it is decisive too, because its
  // true first acquisition is earlier still. A truncated row observed after the
  // cluster says nothing at all, and is not consulted.
  const supplied = blockNumber(options.tokenFirstBlock);
  // The EARLIEST such row, not the first one in balance order — the sentence names
  // it, and naming the second-earliest would be a smaller claim than the evidence
  // supports.
  const earlierRow = rows
    .filter((r) => typeof r.firstBlock === "number" && r.firstBlock < firstBlock)
    .sort((a, b) => a.firstBlock - b.firstBlock)[0] ?? null;
  const earlier = supplied !== null ? supplied < firstBlock : Boolean(earlierRow);
  const kind = earlier ? "later" : "launch";
  const basis = supplied !== null ? "token_first_block" : "probed";

  return {
    ...base,
    found: true,
    kind,
    basis,
    cluster: best.map((r) => ({
      address: r.address,
      firstBlock: r.firstBlock,
      firstTimestamp: r.firstTimestamp,
      percent: r.percent,
      percentDisplay: r.percentDisplay,
    })),
    firstBlock,
    lastBlock,
    blockSpan: lastBlock - firstBlock,
    blockSpanDisplay: blockWords(lastBlock - firstBlock),
    timeSpanMs,
    timeSpanDisplay: timeSpanMs === null ? null : spanWords(timeSpanMs),
    covers: { addresses: best.length, ofEligible: eligible.length, ofHolders: real.length },
    supply,
    earliestObservedBlock: earlierRow ? earlierRow.firstBlock : firstBlock,
    reading: readingForBundle({ best, kind, basis, firstBlock, lastBlock, timeSpanMs, supply, eligible, real, ineligible, earlierRow }),
  };
}

function readingForBundle(b) {
  const span = b.lastBlock - b.firstBlock;
  const when = span === 0 ? "in the same block" : `within ${blockWords(span)} of each other`;
  const clock = b.timeSpanMs === null ? "" : span === 0 ? "" : ` (about ${spanWords(b.timeSpanMs)})`;
  const parts = [
    `${b.best.length} of the ${b.eligible.length} holding address${b.eligible.length === 1 ? "" : "es"} whose first acquisition could be pinned exactly first received this token ${when}${clock}${b.supply.display ? `, and they hold ${b.supply.display} between them` : ""}.`,
  ];
  parts.push(
    b.kind === "launch"
      ? b.basis === "token_first_block"
        ? "That window is the token's own earliest activity, so this is a cluster at launch."
        : "Nothing probed here acquired earlier, so this window is the earliest activity in view — consistent with a cluster at launch, though only the top holders were probed and an earlier buyer outside that set would not appear."
      : `Something was already holding before that window${b.earlierRow ? ` (${shortHex(b.earlierRow.address)}, first seen at block ${b.earlierRow.firstBlock.toLocaleString("en-US")})` : ""}, so this is a coordinated buy AFTER launch rather than a launch bundle.`,
  );
  parts.push(
    "Addresses acquiring inside one narrow window is EVIDENCE OF COORDINATION, not proof of intent. An airdrop, a contract migration, a team allocation and a bought bundle all leave exactly this shape, and nothing measured here separates them. What is stated is what was observed.",
  );
  if (b.ineligible.length) {
    parts.push(
      `${b.ineligible.length} further address${b.ineligible.length === 1 ? "" : "es"} in the top list could not be pinned to an exact block — truncated or unread history — and ${b.ineligible.length === 1 ? "is" : "are"} evidence neither for nor against this cluster.`,
    );
  }
  if (!b.supply.complete && b.supply.counted) {
    parts.push(
      `The supply share covers ${b.supply.counted} of the ${b.best.length} cluster addresses; the rest had no readable share and are NOT counted as zero, so the real total is higher.`,
    );
  }
  return parts.join(" ");
}

/* -------------------------- funding attribution --------------------------- */

/**
 * WERE THE CLUSTERED ADDRESSES FUNDED BY THE SAME PLACE — the strongest bundling
 * signal available from an indexer, and the only leg here that is OPT-IN.
 *
 * WHY IT IS NOT ON BY DEFAULT. It is one extra call PER ADDRESS on top of the one
 * the probe already spent, and it answers a question nobody asked unless a cluster
 * was found. A feature that doubles the cost of every holder page to serve the
 * minority of tokens with a cluster is the wrong trade; run it when detectBundle
 * fires, and skip it — SAYING SO — when the request is short of time. A silent
 * skip would read as "no common funder", which is a finding, and it would be one
 * we did not make.
 *
 * WHAT IT LOOKS AT. The address's native transaction list, oldest INBOUND transfer
 * that predates its first acquisition of the token. `filter=to` is passed as a
 * hint and the sender side is checked locally as well, so an indexer that ignores
 * the parameter costs a wasted page rather than a wrong answer.
 *
 * WHY A TRUNCATED PAGE CANNOT NAME A FUNDER. The list is newest-first, so a full
 * page means the real first funder is older than anything read — the address we
 * found is AN early counterparty, not THE funder. Those come back with
 * `established: false` and are reported as such; they are not promoted to a
 * finding by being shared.
 *
 * THE FINDING, WHEN THERE IS ONE, is that N of the cluster's addresses received
 * their first funds from the same address before they bought. That is a fact about
 * plumbing. Exchanges, bridges and airdrop distributors fund thousands of unrelated
 * addresses, and the reading says so.
 *
 * @param {Array<object>} cluster - detectBundle's `cluster`
 * @param {{ calls?: object, limit?: number, timeoutMs?: number }} [options]
 * @returns {Promise<object>}
 */
export async function fundingSources(cluster, options = {}) {
  const rows = (Array.isArray(cluster) ? cluster : [])
    .map((c) => ({ address: lowerAddress(c?.address), firstBlock: blockNumber(c?.firstBlock) }))
    .filter((c) => c.address);
  const calls = { ...DEFAULT_CALLS, ...(options.calls && typeof options.calls === "object" ? options.calls : {}) };
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : ENRICHMENT_TIMEOUT_MS;
  const limit = Math.max(
    1,
    Math.min(MAX_FUNDING_PROBES, Number.isFinite(options.limit) ? Math.trunc(options.limit) : MAX_FUNDING_PROBES),
  );

  const skipped = (reason) => ({
    ran: false,
    reason,
    funders: [],
    commonFunder: null,
    covered: 0,
    of: rows.length,
    established: false,
    reading: `Funding sources were not checked — ${reason}. That is not a finding that the addresses were funded separately.`,
  });

  if (!rows.length) return skipped("there were no cluster addresses to check");
  if (outOfTimeFor(FUNDING_MIN_MS)) {
    noteBudgetSkip("fundingSources");
    return skipped("the request ran short of time");
  }

  const probed = rows.slice(0, limit);
  const results = await mapPooled(probed, PROBE_CONCURRENCY, async (row) => {
    if (outOfTimeFor(FUNDING_MIN_MS)) {
      noteBudgetSkip("fundingSources");
      return { address: row.address, funder: null, established: false, reason: "not read — the request ran short of time" };
    }
    const res = await attempt(() =>
      calls.getAddressTransactions(row.address, { filter: "to" }, deadline(timeoutMs)),
    );
    if (!res.ok) {
      return { address: row.address, funder: null, established: false, reason: "the indexer did not answer for this address" };
    }
    const items = Array.isArray(res.value?.items) ? res.value.items : null;
    if (items === null) {
      return { address: row.address, funder: null, established: false, reason: "no transaction list came back for this address" };
    }
    const truncated = Boolean(res.value?.next_page_params) || items.length >= FUNDING_PAGE_SIZE;

    let oldest = null;
    for (const item of items) {
      const block = blockNumber(item?.block_number);
      const to = lowerAddress(item?.to);
      const from = lowerAddress(item?.from);
      if (block === null || !from || to !== row.address) continue;
      // Only funding that could have paid for the acquisition counts. A transfer
      // in AFTER the buy is a consequence, not a cause.
      if (row.firstBlock !== null && block > row.firstBlock) continue;
      if (oldest === null || block < oldest.block) oldest = { block, from };
    }
    if (oldest === null) {
      return {
        address: row.address,
        funder: null,
        established: false,
        reason: truncated
          ? "no inbound transfer before its first acquisition appeared on the page read, and the page was full — an older one may exist"
          : "no inbound native transfer before its first acquisition was found",
      };
    }
    return {
      address: row.address,
      funder: oldest.from,
      fundedAtBlock: oldest.block,
      // A full page means the real FIRST funder is older than anything read, so
      // what was found is an early counterparty rather than the source.
      established: !truncated,
      reason: truncated
        ? "the transaction page was full, so an earlier funder may exist — this is the earliest one read, not established as the first"
        : null,
    };
  });

  const counts = new Map();
  for (const r of results) {
    if (!r.funder) continue;
    counts.set(r.funder, (counts.get(r.funder) ?? 0) + 1);
  }
  let top = null;
  for (const [funder, n] of counts) {
    if (!top || n > top.count) top = { funder, count: n };
  }
  const shared = top && top.count >= 2 ? top : null;
  const sharedRows = shared ? results.filter((r) => r.funder === shared.funder) : [];
  const established = sharedRows.length > 0 && sharedRows.every((r) => r.established);

  return {
    ran: true,
    reason: null,
    funders: results,
    commonFunder: shared ? shared.funder : null,
    covered: shared ? shared.count : 0,
    of: probed.length,
    ofCluster: rows.length,
    established,
    reading: shared
      ? `${shared.count} of the ${probed.length} cluster address${probed.length === 1 ? "" : "es"} checked received their first funds from the same address, ${shortHex(shared.funder)}, before they bought.${established ? "" : " At least one of those pages was full, so that address is the earliest funder READ rather than one established as the first."} A shared funder is the strongest plumbing link available here — and it is still not proof of intent: exchanges, bridges and airdrop distributors fund thousands of unrelated addresses from one hot wallet.`
      : `No shared funding source was found among the ${probed.length} cluster address${probed.length === 1 ? "" : "es"} checked. That is a weak negative, not a clearing: ${results.filter((r) => !r.funder).length} of them had no readable inbound transfer before their first acquisition, and funding routed through separate intermediaries looks exactly like this.`,
  };
}

/* ------------------------------ the one call ------------------------------ */

/**
 * The whole feature in one call: the pass, both readings off it, and the optional
 * funding leg when a cluster was actually found.
 *
 * FUNDING RUNS ONLY WHEN THERE IS SOMETHING TO ATTRIBUTE. `funding: true` asks for
 * it; it still costs nothing when detectBundle found no cluster, because there is
 * no cluster to attribute. When it is skipped for time, the skip is reported
 * rather than rendered as an absence of a common funder.
 *
 * @param {string} token
 * @param {object} [options] - holderFirstAcquisition's options, plus
 *   `funding` (boolean), `windowBlocks`, `minCluster`, `tokenFirstBlock`
 * @returns {Promise<{ ok: boolean, analysis: object, holdTime: object|null,
 *   bundle: object|null, funding: object|null, error?: string }>}
 */
export async function analyzeHolderHistory(token, options = {}) {
  const analysis = await holderFirstAcquisition(token, options);
  if (!analysis.ok) {
    return { ok: false, analysis, holdTime: null, bundle: null, funding: null, error: analysis.error };
  }
  const holdTime = holdTimeSummary(analysis);
  const bundle = detectBundle(analysis, options);
  const funding =
    options.funding && bundle.found
      ? await fundingSources(bundle.cluster, { calls: options.calls, timeoutMs: options.timeoutMs })
      : null;
  return { ok: true, analysis, holdTime, bundle, funding };
}
