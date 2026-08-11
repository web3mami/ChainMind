import { getAddress, getToken, getTokens, searchChain } from "./blockscout.js";
import { sanitizeLabel } from "./ask-evidence.js";
import {
  MAX_DEPTH_PROBES,
  applyDepths,
  collisionNotice,
  dominanceVerdict,
  measureDepths,
  quoteDepth,
} from "./depth-rank.js";
import { readPageWithRetry } from "./page-retry.js";
import stockRegistry from "../config/stock-tokens.json" with { type: "json" };

/**
 * The tokenized-equity registry for Robinhood Chain.
 *
 * Robinhood's equity tokens are ordinary ERC-20s named like
 * "NVIDIA • Robinhood Token" (NVDA). That NAME IS NOT PROOF OF ANYTHING:
 * 0x465834D5…CA492 is a live contract whose name and symbol are byte-identical
 * to the real NVDA token, and holder counts are cheap to inflate by airdrop on
 * an L2, so neither the suffix nor "it has more holders" can be the authority.
 *
 * The authority is the DEPLOYER. All 94 genuine equity tokens were deployed by
 * a single issuer address, which cannot be forged by anyone who does not hold
 * its key. config/stock-tokens.json snapshots that issuer plus the 94 verified
 * contract addresses; anything outside the snapshot is confirmed against the
 * issuer live before it is ever called official.
 *
 * Server-side only: no React, all chain data comes from lib/blockscout.js.
 */

/** Deployer of every genuine Robinhood equity token — the root of trust. */
export const CANONICAL_ISSUER = String(stockRegistry.issuer).toLowerCase();

/** Snapshot of verified contract addresses, lowercased for comparison. */
const CANONICAL_ADDRESSES = new Set(
  (stockRegistry.tokens ?? []).map((t) => String(t.address).toLowerCase()),
);

/** True when the address is a snapshotted, issuer-verified equity token. */
export function isCanonicalStockAddress(address) {
  return CANONICAL_ADDRESSES.has(String(address ?? "").toLowerCase());
}

/**
 * Confirm a contract was deployed by the canonical issuer. Used for tokens
 * listed after the snapshot was taken, so a new genuine listing is not called
 * an impostor. Fails closed: any lookup error returns false.
 * @param {string} address
 */
export async function verifiedByIssuer(address) {
  if (isCanonicalStockAddress(address)) return true;
  try {
    const info = await getAddress(address);
    return String(info?.creator_address_hash ?? "").toLowerCase() === CANONICAL_ISSUER;
  } catch {
    return false;
  }
}

/**
 * Tolerates the plain "*" bullet (some clients transliterate U+2022) and any
 * amount of surrounding whitespace, because the separator is the one part of
 * the convention that survives copy/paste badly.
 */
const STOCK_SUFFIX_RE = /\s*[•*]\s*Robinhood\s+Token\s*$/i;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Safety bound on the page-walk: a runaway cursor must not walk forever. */
const MAX_PAGES = 10;
const MAX_TOKENS = 500;

const DEFAULT_TTL_MS = 300_000;

/** True when a token name carries the official " • Robinhood Token" suffix. */
export function isStockTokenName(name) {
  if (typeof name !== "string") return false;
  return STOCK_SUFFIX_RE.test(name);
}

/** "NVIDIA • Robinhood Token" -> "NVIDIA". Non-stock names pass through. */
export function stripStockSuffix(name) {
  if (typeof name !== "string") return "";
  return name.replace(STOCK_SUFFIX_RE, "").trim();
}

/**
 * Split a user query into the forms the matchers need. Traders type "$NVDA",
 * "nvda" and "NVDA " interchangeably, and a stray "$" would otherwise make an
 * exact symbol compare fail and drop the caller into the impostor-prone search
 * fallback.
 *
 * @param {unknown} raw
 * @returns {{ raw: string, symbol: string, lower: string }}
 */
export function normalizeQuery(raw) {
  const flat = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\$+/, "")
    .trim();
  return { raw: flat, symbol: flat.toUpperCase(), lower: flat.toLowerCase() };
}

/**
 * Rank one candidate against a normalized query. Higher wins; 0 means "not a
 * match at all". The tiers exist so that an exact symbol always outranks a
 * lookalike that merely starts with it — NVDACAT must never beat NVDA.
 */
function scoreCandidate(candidate, q) {
  if (!candidate) return 0;
  const symbol = String(candidate.symbol ?? "").trim().toUpperCase();
  const company = String(candidate.company ?? "").trim().toLowerCase();
  const name = String(candidate.name ?? "").trim().toLowerCase();
  // THE SUBSTRING TIER MATCHES THE NAME WITHOUT ITS BOILERPLATE SUFFIX, and that
  // is not a nicety — every one of the 94 official names ends " • Robinhood
  // Token", so `name.includes(q)` made all 94 score on the word "hood". Measured
  // live: "HOOD" — a perfectly ordinary ticker to ask about, and one four
  // memecoins on this chain wear — resolved to NVIDIA at the substring tier and
  // came back official: true, because "robinhood token" contains "hood" and NVDA
  // had the most holders of the 94 that tied. A confident answer about the wrong
  // company. The suffix identifies the ISSUER, never the subject, so it is
  // stripped before anything is matched against it.
  const bareName = stripStockSuffix(name).trim();

  if (symbol && symbol === q.symbol) return 100;
  if (company && company === q.lower) return 90;
  if (name && name === q.lower) return 85;
  // Prefix matches need at least two characters; one letter matches half the
  // market and turns the ranking into a coin flip.
  if (company && q.lower.length >= 2 && company.startsWith(q.lower)) return 70;
  if (symbol && q.symbol.length >= 2 && symbol.startsWith(q.symbol)) return 50;
  if (q.lower.length >= 3 && (company.includes(q.lower) || bareName.includes(q.lower))) return 30;
  return 0;
}

/**
 * Descending compare that keeps unknowns last instead of poisoning the sort.
 * Plain `b - a` on two nulls yields NaN, which leaves the order undefined.
 */
function numDesc(a, b) {
  const x = Number.isFinite(a) ? a : -Infinity;
  const y = Number.isFinite(b) ? b : -Infinity;
  if (x === y) return 0;
  return y > x ? 1 : -1;
}

/**
 * ISSUER VERIFICATION OUTRANKS EVERY MARKET FIGURE, and this is where that is
 * enforced locally rather than left to emerge from the order resolveSymbol happens
 * to try things in.
 *
 * The 94 tokenized equities are settled by their deployer
 * 0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046, whose key nobody else holds. That is
 * a stronger fact than any amount of pooled WETH, so no memecoin with a deep pool
 * may outrank a real equity sharing its ticker — not the deepest pool on the chain,
 * not a million holders. The snapshot answers instantly and offline; a candidate
 * the caller has already verified live carries `official: true` and counts too.
 */
function issuerRank(candidate) {
  if (!candidate) return 0;
  return isCanonicalStockAddress(candidate.address) || candidate.official === true ? 1 : 0;
}

/**
 * Between two candidates of EQUAL relevance, whether the second displaces the first.
 *
 * THE ORDER IS: issuer verification, then REALISABLE DEPTH, then holder count,
 * then market cap. Each speaks only when the one above it cannot separate them.
 *
 * REALISABLE DEPTH REPLACED HOLDER COUNT HERE, AND THE OLD REASONING IS RETRACTED.
 * It ran: Blockscout prices almost nothing outside the 94 equities, so ranking on
 * market cap really ranks on whether the indexer happened to quote a contract, and
 * holder count is therefore the honest figure. Measured on chain 4663 across the
 * 229 contracts whose symbol is exactly VLAD, the causation runs the other way —
 * the indexer prices The Green Bull BECAUSE it is the one with a market, and its
 * feed (cap $245,195.83) and our independent pool math (cap $238,397) agree within
 * 3%. Ranking on holders picks The Robinhood: 52,214 addresses, a $3,855,217
 * notional cap, and $0.17 of realisable depth. The Green Bull has 1,334 holders and
 * $1,324.23. Airdrops make holders cheap; capital exposed in range at the market
 * price is somebody's money, so depth is the figure that answers "which contract is
 * the market" — subject to the corroboration leg agreeing, which is a question for
 * lib/depth-rank.js and not for this comparator.
 *
 * HOLDER COUNT IS STILL HERE, three rungs down, because it is the only figure a
 * search row carries for free and depth is measured for a bounded shortlist only
 * (see lib/depth-rank.js MAX_DEPTH_PROBES). Below the shortlist, and for the
 * equities where no pool is ever read, holders is what is left — but it is the
 * LAST resort rather than the first fallback, because it is the cheapest figure
 * on this list to manufacture. See the rungs below for what now sits above it.
 *
 * AN UNMEASURED FIGURE NEVER DISPLACES A MEASURED ONE, at every rung. numDesc
 * sorts nulls last, so a candidate whose depth probe failed cannot outrank one
 * whose came back — however large its cap or holder count. That is the same rule
 * as everywhere else in this codebase, and it is the direction that never promotes
 * an unknown over a known.
 *
 * @param {object} candidate
 * @param {object} best
 * @returns {boolean}
 */
function beatsOnFigures(candidate, best) {
  const byIssuer = issuerRank(best) - issuerRank(candidate);
  if (byIssuer !== 0) return byIssuer < 0;
  const byDepth = numDesc(quoteDepth(best), quoteDepth(candidate));
  if (byDepth !== 0) return byDepth > 0;
  // THE INDEXER'S OWN TRACKING, above holders and below depth.
  //
  // WHY IT IS HERE AT ALL. Depth is measured for a bounded shortlist and the
  // probes can simply not come back: measured live, a cold VLAD lookup had every
  // probe time out in 2 of 4 runs. With nothing between depth and holders the
  // comparator fell straight to holder count on those runs and handed the ticker
  // to a contract with 52,214 airdropped holders and $1.03 of realisable WETH —
  // no attacker involved, just a slow endpoint. That is the ordinary-Tuesday
  // failure, and it was more likely than any of the attacks this file defends
  // against.
  //
  // WHY IT DESERVES THE RUNG. Blockscout publishes a rate and a 24h volume only
  // for contracts it can find a market for: of the 229 contracts wearing the
  // symbol VLAD on this chain it prices essentially one, and that one is the one
  // with the pool. It is not an independent oracle — it is a second reading of a
  // market we can also measure ourselves — but it costs ZERO extra reads (both
  // fields ride along in the token body already fetched) and it is available
  // exactly when depth is not.
  //
  // VOLUME ABOVE RATE, because volume is the discriminating field: /search rows
  // carry a rate but never a volume, so a rate alone separates far less.
  //
  // Neither is a substitute for depth. Both are trivially wash-tradeable by a
  // sole liquidity provider, who pays the fees to themselves. They rank ABOVE
  // holders because holders cost an airdrop, and BELOW depth because depth is
  // the figure backed by capital exposed at the market price.
  const byVolume = numDesc(best.volume24h, candidate.volume24h);
  if (byVolume !== 0) return byVolume > 0;
  const byPrice = numDesc(best.price, candidate.price);
  if (byPrice !== 0) return byPrice > 0;
  const byHolders = numDesc(best.holders, candidate.holders);
  if (byHolders !== 0) return byHolders > 0;
  return numDesc(best.marketCap, candidate.marketCap) > 0;
}

/**
 * Best candidate for a query, or null. Pure — no upstream calls — so the whole
 * ranking policy is unit-testable offline.
 *
 * The relevance tiers come first and are untouched: an exact symbol always beats a
 * lookalike prefix, so NVDACAT can never win a query for NVDA no matter how many
 * addresses hold it. The figures only ever separate candidates the tiers rank the
 * same.
 *
 * @param {Array<object>} candidates
 * @param {string} query
 * @returns {object | null}
 */
export function pickBestMatch(candidates, query) {
  const q = normalizeQuery(query);
  if (!q.raw || !Array.isArray(candidates)) return null;

  let best = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, q);
    if (!score) continue;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
      continue;
    }
    if (score === bestScore && best && beatsOnFigures(candidate, best)) best = candidate;
  }
  return best;
}

/**
 * The candidates tied at the highest relevance score, in the order they arrived.
 * Everything below that tier is already outranked by the tiers themselves, so no
 * figure about it can change the answer.
 */
function topTier(candidates, query) {
  const q = normalizeQuery(query);
  const scored = [];
  let top = 0;
  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, q);
    if (!score) continue;
    if (score > top) top = score;
    scored.push([score, candidate]);
  }
  return scored.filter(([score]) => score === top).map(([, candidate]) => candidate);
}

/**
 * How many equally-relevant candidates get a holder count fetched.
 *
 * One request each, so the number is a latency budget. Eight ran concurrently in
 * 1.7s against the live indexer, and the tie they break is between contracts a
 * user is choosing among — a ranking decided by whichever copycat carried a market
 * cap is worth more than 1.7s.
 */
const MAX_HOLDER_LOOKUPS = 8;

/**
 * The three indexer figures a /search row does not carry, for one contract, from
 * the ONE request that was already being made for the holder count.
 *
 * WHY THE OTHER TWO ARE HERE. exchange_rate and volume_24h are the CORROBORATION
 * LEG of the ticker verdict (lib/depth-rank.js): the second, independent instrument
 * that has to agree before measured depth may name a winner. A /search row carries
 * exchange_rate and NOT volume_24h, which is the discriminating one — measured on
 * chain 4663, /search returns a rate for two contracts answering VLAD, while
 * /tokens/{address} returns volume_24h $2,990.70 for The Green Bull and null for
 * every other one. Reading them here is free: the request is already in flight for
 * the holder count, and taking one field out of a body that carries three would
 * have made the verdict rest on the weaker of two available signals.
 *
 * Null on failure, and null for each field the indexer withheld. A missing volume
 * is the indexer being silent about a contract, never a contract that did not trade.
 */
async function liveTokenFigures(address) {
  try {
    const raw = await getToken(address);
    if (!raw || typeof raw !== "object") return null;
    return {
      holders: toNum(raw.holders_count ?? raw.holders),
      price: toNum(raw.exchange_rate),
      volume24h: toNum(raw.volume_24h),
    };
  } catch {
    return null;
  }
}

/**
 * Fill in the holder counts the explorer search does not send.
 *
 * FINDING, so nobody re-derives it. A /api/v2/search row carries name, symbol,
 * total_supply, exchange_rate and circulating_market_cap — and NO holder count at
 * all. So every search-derived candidate arrives with `holders: null`, all of them
 * tie on the figure the ranking is meant to turn on, and market cap decides by
 * default. That is the whole mechanism behind a ticker resolving to the one
 * contract Blockscout happens to price: not a bad rule, a rule with nothing to
 * read. The official-list path never had this problem — /tokens rows carry
 * holders_count — which is exactly why the bias only ever showed up outside the 94
 * verified equities, where ticker collisions are commonest.
 *
 * Bounded on purpose: only the top relevance tier, only the candidates still
 * missing a count, and never more than MAX_HOLDER_LOOKUPS of them. Concurrent, and
 * behind lib/indexer-cache.js, so a repeat query inside the TTL costs nothing.
 *
 * BEST EFFORT, BIASED THE SAFE WAY. A candidate whose lookup fails keeps
 * `holders: null` and therefore cannot displace one whose count came back. The
 * ranking prefers the contract it could measure over the one it could not, which
 * is the conservative direction — it never promotes an unknown over a known.
 *
 * IT ALSO FILLS THE CORROBORATION LEG. The same body carries exchange_rate and
 * volume_24h, and the ticker verdict needs both (see liveTokenFigures). A field
 * already on the candidate is never overwritten — the search row is as good a
 * source as the token endpoint for anything it does carry — and a field neither has
 * stays null, which means the indexer said nothing, never that the figure is zero.
 *
 * @param {Array<object>} candidates
 * @param {string} query
 * @param {(address: string) => Promise<object|number|null>} [fetchFigures] - test seam.
 *   Accepts the old number-only shape as the holder count alone, so a caller that
 *   only ever cared about holders keeps working.
 * @returns {Promise<Array<object>>} the same list, indexer figures filled where read
 */
export async function withHolderCounts(candidates, query, fetchFigures = liveTokenFigures) {
  if (!Array.isArray(candidates) || candidates.length < 2) return candidates;
  const missing = topTier(candidates, query).filter((c) => toNum(c.holders) === null);
  // One candidate in the tier means the tiers already decided it, and zero means
  // every contender is already counted. Neither is worth a request.
  if (missing.length < 2) return candidates;

  const probes = missing.slice(0, MAX_HOLDER_LOOKUPS);
  const figures = await Promise.all(probes.map((c) => fetchFigures(c.address)));
  const read = new Map();
  probes.forEach((c, i) => {
    const f = figures[i];
    const row = typeof f === "object" && f !== null ? f : { holders: toNum(f) };
    const filled = {};
    for (const key of ["holders", "price", "volume24h"]) {
      const n = toNum(row[key]);
      // Only ever ADD. A figure the candidate already carries came from the search
      // row and is the same reading; overwriting it would make the ranking depend
      // on which of two equivalent endpoints answered first.
      if (n !== null && toNum(c[key]) === null) filled[key] = n;
    }
    if (Object.keys(filled).length) read.set(c.address, filled);
  });
  if (!read.size) return candidates;
  // A new object per enriched row: the caller's list, and anything else holding a
  // reference to these candidates, must not mutate under it.
  return candidates.map((c) => (read.has(c.address) ? { ...c, ...read.get(c.address) } : c));
}

/**
 * Measure how much of each equally-relevant candidate is actually realisable, and
 * report what the measurement covered.
 *
 * WHY THIS IS BOUNDED AND WHAT IT DROPS. 229 contracts on chain 4663 have the
 * exact symbol VLAD. A depth probe is a factory lookup for EVERY fee tier of every
 * verified quote asset — swept in full, because stopping at the first hit let a
 * gas-only decoy pool capture the measurement — plus slot0, liquidity(), the pool
 * balances, two decimals reads and a walk of the pool's TICK LADDER across the
 * price band, so probing them all is a crawl, not a lookup. The candidates are
 * ranked cheaply first (lib/depth-rank.js depthShortlist: indexer-priced first,
 * then holders, then cap) and only the head of that ordering is measured, at most
 * MAX_DEPTH_PROBES of them, concurrently, batched into few requests and behind the
 * price-TTL cache. Measured live, cold: a four-contract collision is 4.9s, 11 HTTP
 * requests and 170 JSON-RPC calls, inside the 12s per-probe cutoff.
 *
 * FOUR COUNTS TRAVEL OUT, NOT ONE — attempted, measured, failed and dropped — so
 * an answer can say "4 measured of 33" instead of implying the field was swept, and
 * can never report probes it STARTED as measurements it OBTAINED. A dropped
 * candidate is UNMEASURED, which is not shallow and not absent; a failed probe is
 * an outage, which is not the same as a bound.
 *
 * TWO CASES SPEND NOTHING. Fewer than two candidates in the top tier means the
 * relevance tiers already decided it. And a tier containing an issuer-verified
 * equity is already decided by the deployer, which outranks every market figure —
 * so NVDA never reads a pool, and pays none of this latency.
 *
 * @param {Array<object>} candidates
 * @param {string} query
 * @param {(address: string) => Promise<number|null>} [probe] - test seam
 * @returns {Promise<{ candidates: Array<object>, survey: object|null }>}
 */
export async function withQuoteDepth(candidates, query, probe) {
  if (!Array.isArray(candidates) || candidates.length < 2) return { candidates, survey: null };
  const tier = topTier(candidates, query);
  if (tier.length < 2) return { candidates, survey: null };
  // The issuer check has already answered this collision. Reading pools now could
  // only produce a figure that is not allowed to change the outcome.
  if (tier.some((c) => issuerRank(c) === 1)) return { candidates, survey: null };

  const survey = await measureDepths(tier, { probe, bound: MAX_DEPTH_PROBES });
  // The lower-bound set travels with the figures, never behind them: a truncated
  // ladder's figure is "at least this much", and a row that lost the qualifier on the
  // way here would be ranked as though it were exact. The VENUE map travels for the same
  // reason and is the same kind of thing — a v3 band depth and a v4 one are the same
  // integral over the same band, so the number cannot say which instrument produced it.
  return {
    candidates: applyDepths(candidates, survey.depths, survey.lowerBounds, survey.sources),
    survey,
  };
}

/* --------------------------- shaping --------------------------- */

function toNum(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Lowercased 0x address, or null when the field isn't an address at all. */
function normalizeAddress(v) {
  const s = String(v ?? "").trim();
  return ADDRESS_RE.test(s) ? s.toLowerCase() : null;
}

/**
 * Map a Blockscout token record onto the StockToken shape. Blockscout sends
 * every number as a string, so each one is coerced once here — callers get
 * Numbers or null and never a NaN they have to defend against.
 *
 * Names and symbols are attacker-controlled (anyone can mint a token whose
 * name is an instruction paragraph), so they go through sanitizeLabel before
 * anything renders or prompts with them. The suffix test runs on the raw name
 * first: sanitizeLabel truncates, and a long ETF name would lose its suffix.
 */
function makeToken(raw, address, rawName) {
  return {
    address,
    symbol: sanitizeLabel(raw.symbol, 16),
    name: sanitizeLabel(rawName, 72),
    company: sanitizeLabel(stripStockSuffix(rawName), 48) ?? sanitizeLabel(raw.symbol, 16),
    price: toNum(raw.exchange_rate),
    marketCap: toNum(raw.circulating_market_cap ?? raw.market_cap),
    volume24h: toNum(raw.volume_24h),
    holders: toNum(raw.holders_count ?? raw.holders),
    decimals: toNum(raw.decimals),
    type: raw.type ?? raw.token_type ?? null,
    // The indexer's own logo URL (Robinhood's CDN for the equities). https only
    // — an http URL or junk in the field renders nothing rather than a mixed-
    // content warning; clients treat null as "draw a monogram".
    icon: /^https:\/\//.test(String(raw.icon_url ?? "")) ? String(raw.icon_url) : null,
  };
}

/** A token-list / search row -> StockToken, or null when it isn't usable. */
function toToken(raw, { officialOnly = false } = {}) {
  if (!raw || typeof raw !== "object") return null;
  const address = normalizeAddress(raw.address_hash ?? raw.address);
  const rawName = typeof raw.name === "string" ? raw.name : null;
  if (!address || !rawName) return null;
  if (officialOnly && !isStockTokenName(rawName)) return null;
  return makeToken(raw, address, rawName);
}

/** The narrow shape used for scam warnings — enough to identify, not to trade. */
function toImpostor(token) {
  return {
    address: token.address,
    symbol: token.symbol,
    name: token.name,
    holders: token.holders,
  };
}

function sameSymbol(a, b) {
  if (!a || !b) return false;
  return String(a).trim().toUpperCase() === String(b).trim().toUpperCase();
}

/* --------------------------- listing --------------------------- */

/**
 * Cursor params for the next page. Blockscout echoes its own cursor back as
 * `next_page_params`; nulls in it would stringify to the literal "null" and
 * poison the query, so they're dropped.
 */
function pageParams(next) {
  if (!next || typeof next !== "object") return null;
  const out = {};
  for (const [key, value] of Object.entries(next)) {
    if (value == null) continue;
    out[key] = String(value);
  }
  return Object.keys(out).length ? out : null;
}

function sameParams(a, b) {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => a[k] === b[k]);
}

/**
 * Walk /tokens and keep the official equity tokens. Never throws: a page that
 * fails ends the walk and flips `partial`, because half a list plus an honest
 * "this is incomplete" beats an exception that takes the whole page down.
 *
 * A DROPPED PAGE IS RE-ASKED FIRST, and here that is worth more than in most walks:
 * this list is the registry the ticker resolver ranks candidates against, it is cached
 * for five minutes, and a page lost to one blip means five minutes of equities missing
 * from every symbol lookup. Measured, this indexer drops roughly one page in ten at
 * random and answers the retry — see lib/page-retry.js. `partial` still fires when the
 * retries do not recover it, because a prefix must never read as the whole registry.
 */
async function walkTokenPages() {
  const tokens = [];
  const seen = new Set();
  let params = {};
  let scanned = 0;
  let partial = false;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    // The clock gate is the same 1.2s every other retry in this codebase uses: a read
    // handed 200ms fails and then reports an outage, which is a claim about an upstream
    // that was never really asked. A refresh triggered by a nearly-dead request keeps
    // whatever it got and flips `partial` instead.
    const res = await readPageWithRetry(() => getTokens(params), { minMs: 1_200, label: "stockRegistry" });
    if (!res.ok) {
      partial = true;
      break;
    }
    const body = res.value;

    const items = Array.isArray(body?.items) ? body.items : [];
    if (!items.length) break;

    for (const item of items) {
      scanned += 1;
      const token = toToken(item, { officialOnly: true });
      // Dedupe on address: a cursor that overlaps pages would otherwise list
      // the same equity twice.
      if (!token || seen.has(token.address)) continue;
      seen.add(token.address);
      tokens.push(token);
    }

    const next = pageParams(body?.next_page_params);
    if (!next) break;
    if (scanned >= MAX_TOKENS || page === MAX_PAGES - 1) {
      // Stopped on the safety bound with more pages upstream: the list is a
      // prefix of the truth, so say so rather than implying completeness.
      partial = true;
      break;
    }
    // A cursor that repeats itself is an upstream bug; walking it loops forever.
    if (sameParams(next, params)) break;
    params = next;
  }

  tokens.sort((a, b) => numDesc(a.marketCap, b.marketCap) || numDesc(a.holders, b.holders));
  return { tokens, partial };
}

/**
 * In-memory, per-instance cache. Serverless spreads requests over many
 * instances, so this is a burst absorber and nothing more — never a source of
 * truth across deploys or regions.
 */
let cache = { at: 0, tokens: null };

/** Shared page-walk so a burst of callers triggers one upstream traversal. */
let inFlight = null;

function ttlMs() {
  const raw = toNum(process.env.STOCK_CACHE_TTL_MS);
  return raw != null && raw >= 0 ? raw : DEFAULT_TTL_MS;
}

/** Attach `partial` without making it part of the array's own iteration/JSON. */
function withPartial(tokens, partial) {
  Object.defineProperty(tokens, "partial", { value: partial, enumerable: false });
  return tokens;
}

async function refresh() {
  const { tokens, partial } = await walkTokenPages();

  // An empty partial result means the indexer was down, not that Robinhood
  // delisted 94 equities. Keep whatever we had and don't cache the hole —
  // otherwise one brownout blanks the app for a full TTL.
  if (partial && tokens.length === 0) {
    return cache.tokens ?? withPartial(tokens, true);
  }

  cache = { at: Date.now(), tokens: withPartial(tokens, partial) };
  return cache.tokens;
}

/**
 * Every official Robinhood equity/ETF token, biggest first.
 *
 * @param {{ force?: boolean }} [options] - force skips the cache
 * @returns {Promise<Array<object>>} StockToken[] (carries a non-enumerable
 *   `partial` flag when the walk was cut short)
 */
export async function listStockTokens({ force = false } = {}) {
  if (!force && cache.tokens && Date.now() - cache.at < ttlMs()) return cache.tokens;
  if (!force && inFlight) return inFlight;

  const run = refresh().finally(() => {
    if (inFlight === run) inFlight = null;
  });
  inFlight = run;
  return run;
}

/* --------------------------- resolving --------------------------- */

/**
 * The snapshot, keyed for instant lookup by ticker and by company name.
 *
 * This exists because resolving a ticker used to begin with listStockTokens(),
 * which page-walks the whole /tokens endpoint: measured at 7.8s cold, and it put
 * ~15s of dead air in front of every answer while the model and the stream were
 * each under 600ms. Ninety-four tickers are already known and verified in
 * config/stock-tokens.json, so for almost every real question the walk was pure
 * latency. A Map hit costs nothing and skips it.
 */
const SNAPSHOT_BY_KEY = (() => {
  const map = new Map();
  for (const t of stockRegistry.tokens ?? []) {
    const symbol = String(t.symbol ?? "").trim();
    const company = String(t.company ?? "").trim();
    if (symbol) map.set(symbol.toUpperCase(), t);
    // Company names are a second, non-overriding key so "tesla" resolves too and
    // a company that happens to match another row's ticker cannot shadow it.
    if (company && !map.has(company.toUpperCase())) map.set(company.toUpperCase(), t);
  }
  return map;
})();

/**
 * Snapshot hit for a query, or null. Exact ticker or exact company name only —
 * anything fuzzier is left to pickBestMatch over the live list, which has the
 * holder and market-cap figures needed to rank competing candidates.
 * @param {string} raw
 */
export function snapshotMatch(raw) {
  const key = String(raw ?? "").trim().replace(/^\$/, "").toUpperCase();
  return key ? SNAPSHOT_BY_KEY.get(key) ?? null : null;
}

/**
 * The same 94 rows as CANDIDATES, so pickBestMatch can rank them offline.
 *
 * THIS IS WHAT REPLACED THE PAGE WALK, and the measurement is the whole argument.
 * resolveSymbol used to answer "is this a tokenized equity?" by calling
 * listStockTokens() — a cursor walk of /api/v2/tokens, measured at 14.5s cold — and
 * then running pickBestMatch over the result. For the 94 tickers in the snapshot the
 * exact-match fast path above already skipped it. For EVERYTHING ELSE it was 14.5s
 * spent proving a negative that is knowable offline: measured live, resolveSymbol
 * ("CASTOR") took 15.1s, of which the walk was all but a second, and its entire
 * contribution was to establish that CASTOR is not one of 94 names we already have
 * on disk. lib/indexer-cache.js and the module cache below are both per-instance, so
 * on serverless the cold walk is the NORMAL case, not the exception.
 *
 * WHY THE SNAPSHOT IS ALLOWED TO ANSWER THIS. `official` has never come from
 * membership of the walked list — it comes from the DEPLOYER
 * (0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046), checked by isCanonicalStockAddress
 * offline for a snapshotted address and by verifiedByIssuer live for anything else.
 * The list only ever supplied FUZZY MATCHING (a prefix or substring of a company
 * name) and market FIGURES, and both are recoverable without it: the matching runs
 * over these rows, and the figures are fetched for the ONE contract that matched
 * rather than for all 94.
 *
 * WHAT IT COSTS. A 95th equity listed after this snapshot was taken is not in these
 * rows, so it is found by the explorer search below instead — and still labelled
 * official there, because verifiedByIssuer asks its deployer. That path already
 * existed and is already the one a brownout used; nothing new depends on it.
 *
 * Figures are deliberately null rather than absent: null is "nobody read this",
 * which is what it is, and beatsOnFigures sorts nulls last so a snapshot row can
 * never outrank a measured one on a figure it does not have.
 *
 * BUILT ON FIRST USE, not at module load, and that is load-bearing rather than
 * tidy: sanitizeLabel lives in lib/ask-evidence.js, which imports this file back,
 * so at module-init time the import cycle can leave its `const` bindings still in
 * the temporal dead zone depending on which side was entered first. Doing the work
 * on the first lookup is after every module in the cycle has finished evaluating.
 */
let snapshotCandidates = null;

function snapshotRows() {
  if (snapshotCandidates) return snapshotCandidates;
  snapshotCandidates = Object.freeze(
    (stockRegistry.tokens ?? []).map((t) =>
      Object.freeze({
        address: String(t.address).toLowerCase(),
        symbol: sanitizeLabel(t.symbol, 16),
        company: sanitizeLabel(t.company, 48),
        // NOT synthesized from the company plus the suffix. The contract's real name
        // is a fact we have not read on this path, and writing a plausible one would
        // be inventing the single field impostor detection turns on. It arrives from
        // the live token read below, or it stays null.
        name: null,
        price: null,
        marketCap: null,
        volume24h: null,
        holders: null,
        decimals: null,
        type: null,
      }),
    ),
  );
  return snapshotCandidates;
}

/**
 * The best snapshot row for a fuzzy query — "nvidi", "apple inc" — or null.
 *
 * snapshotMatch above answers EXACT ticker and company only; this is the tier below
 * it, and it is the half of listStockTokens' job that had nothing to do with the
 * network. Pure and offline: the same relevance tiers pickBestMatch applies to any
 * candidate list, applied to the 94 rows we already have.
 *
 * @param {string} raw
 */
export function snapshotBestMatch(raw) {
  return pickBestMatch(snapshotRows(), raw);
}

/** The same snapshot keyed the other way round, for address -> identity. */
const SNAPSHOT_BY_ADDRESS = new Map(
  (stockRegistry.tokens ?? []).map((t) => [String(t.address).toLowerCase(), t]),
);

/**
 * The verified equity behind a contract address, or null.
 *
 * isCanonicalStockAddress answers the yes/no; this answers "which one", which is
 * what a list of addresses needs before it can say a counterparty is NVDA rather
 * than just "an equity contract". Synchronous and offline by design: naming a
 * known contract must not depend on an indexer being up.
 *
 * @param {unknown} address
 * @returns {object|null} the snapshot entry ({ symbol, company, address, … })
 */
export function snapshotByAddress(address) {
  const key = String(address ?? "").trim().toLowerCase();
  return key ? SNAPSHOT_BY_ADDRESS.get(key) ?? null : null;
}

/**
 * One token straight from the indexer, or null. Used by the snapshot fast path,
 * where the address is already known and only the live figures are missing.
 * @param {string} address
 */
async function safeToken(address) {
  try {
    const raw = await getToken(address);
    const rawName = typeof raw?.name === "string" ? raw.name : null;
    if (!rawName) return null;
    return makeToken(raw, String(address).toLowerCase(), rawName);
  } catch {
    return null;
  }
}

/**
 * Explorer search -> StockToken[], or NULL when the search did not answer.
 *
 * The null is the whole point and it replaced a `[]`. Returning an empty array
 * for a failed search meant a rate-limited explorer produced "no other contract
 * uses this ticker" — an outage rendered as absence, on the one question where
 * that reads as reassurance: is the contract in my wallet the real NVDA. A
 * search that never ran must be unknown, and every caller below distinguishes
 * the two. The lookup is still best-effort; it just no longer lies when it fails.
 */
async function searchCandidates(query) {
  try {
    const body = await searchChain(query);
    const items = Array.isArray(body?.items) ? body.items : [];
    return items.map((item) => toToken(item)).filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Other contracts wearing the same symbol as the resolved match. This is the
 * whole point of the module: NVDA resolves to Robinhood's contract, and the
 * two unrelated NVDA contracts on the same chain get named, not hidden.
 *
 * Null in, null out: a candidate list that never arrived cannot produce "none".
 */
function findImpostors(candidates, symbol, address) {
  if (!Array.isArray(candidates)) return null;
  return candidates
    .filter((c) => c.address !== address && sameSymbol(c.symbol, symbol))
    .map(toImpostor);
}

/**
 * Resolve a ticker, company name or "$SYMBOL" to a token on Robinhood Chain.
 *
 * The issuer-verified equities are tried first, FROM THE OFFLINE SNAPSHOT, so
 * `official: true` means "this is the contract Robinhood issued". Only when nothing
 * official matches does it fall back to explorer search — but `official` is decided
 * by the DEPLOYER on every branch, never by which branch answered, so a genuine
 * equity that only the search fallback could find is still labelled official.
 * Callers must not present a verified and an unverified contract the same way, and
 * this function must not mislabel one because of how it was reached.
 *
 * NO PART OF THIS READS THE LIVE TOKEN LIST. It used to walk all 94 pages of
 * /api/v2/tokens to decide equity membership — 14.5s cold, on every lookup that was
 * not an exact snapshot hit, and spent almost entirely on non-equities to prove a
 * negative that is on disk. See SNAPSHOT_CANDIDATES.
 *
 * `impostors` is an array when the explorer search answered and NULL when it did
 * not, and `impostorsRead` says which — see searchCandidates. A caller printing
 * "no other contract uses this ticker" must check the flag first, because an
 * empty array and a failed scan are not the same statement.
 *
 * EVERY branch that resolves gets that collision check, not only the official one.
 * Ticker collisions are commonest and least policed outside the 94 verified
 * equities, and `match` always carries the resolved contract address and the
 * token's real `name` — which is frequently nothing like the symbol asked about —
 * so a caller can always say which contract it is reporting on.
 *
 * `collision` carries the DEPTH verdict when one was measured: which contract
 * wearing the ticker holds tradeable liquidity, whether it dominates, how many
 * probes were attempted, how many produced a figure, how many failed and how many
 * the bound never reached. It is NULL when no measurement was made — a snapshot
 * hit, an official match, a tier of one — and null there means "not measured",
 * never "nothing dominates". See lib/depth-rank.js.
 *
 * @param {string} query
 * @param {{ depthProbe?: (address: string) => Promise<number|null> }} [options]
 *   Test seam. This function now reads the CHAIN as well as the indexer — the
 *   depth probe goes out over RPC — so a test that stubs only globalThis.fetch is
 *   relying on viem failing to parse a stubbed body, which is an accident rather
 *   than an assertion. Pass a probe to make being offline explicit.
 * @returns {Promise<{ ok: boolean, query: string, match: object|null, official: boolean, impostors: Array<object>|null, impostorsRead: boolean, collision?: object|null, reason?: string }>}
 */
export async function resolveSymbol(query, options = {}) {
  const q = normalizeQuery(query);
  // No scan was attempted on a miss, so `impostors` is unknown rather than none.
  const miss = {
    ok: false,
    query: q.raw,
    match: null,
    official: false,
    impostors: null,
    impostorsRead: false,
    collision: null,
  };
  if (!q.raw) return { ...miss, reason: "Empty query." };

  // THE EQUITY QUESTION IS ANSWERED OFFLINE, EXACTLY ONCE, HERE.
  //
  // Exact ticker or company first (a Map hit), then the fuzzy tier over the same 94
  // rows (a 94-element scan). Both are synchronous and free. What used to sit
  // between them — `await listStockTokens()`, a 14.5s cursor walk of /api/v2/tokens
  // — is gone: see SNAPSHOT_CANDIDATES for why membership of that walked list was
  // never what `official` meant, and for what a 95th equity does instead.
  //
  // The verdict is not in question on this branch: a snapshot address is canonical
  // by definition, so isCanonicalStockAddress settles it with no call at all. The
  // impostor search still runs, because naming the fakes is the point of this module.
  const snap = snapshotMatch(q.raw) ?? snapshotBestMatch(q.raw);
  if (snap) {
    // ONE token read for the matched contract, not ninety-four. This is the half of
    // the walk that was actually load-bearing — price, market cap, holders, the
    // contract's real name — bought for the single request it is worth.
    const [live, candidates] = await Promise.all([
      safeToken(snap.address),
      searchCandidates(snap.symbol),
    ]);
    // A LIVE READ THAT FAILED NO LONGER FALLS BACK TO THE WALK, and the trade is
    // stated rather than hidden. The walk read the same figures from a different
    // endpoint of the same indexer, so it was only ever a second chance at the same
    // outage — for which the old code paid 14.5s on EVERY cold lookup, including the
    // overwhelming majority where nothing had failed. What is returned instead is
    // the identity we hold offline with its figures left NULL: unknown, never zero.
    // The evidence layer reads the same token endpoint and reports the outage by
    // name (lib/ask-evidence.js `unavailable`), so nothing goes unsaid.
    const match = live
      ? { ...live, symbol: live.symbol ?? snap.symbol, company: live.company ?? snap.company }
      : {
          address: snap.address,
          symbol: snap.symbol ?? null,
          company: snap.company ?? null,
          name: snap.name ?? null,
          price: null,
          marketCap: null,
          volume24h: null,
          holders: null,
          decimals: null,
          type: null,
        };
    return {
      ok: true,
      query: q.raw,
      match,
      official: true,
      impostors: findImpostors(candidates, snap.symbol, snap.address),
      impostorsRead: Array.isArray(candidates),
      // No depth was measured and none is needed: the issuer settled it, and a
      // pool read here would cost seconds to produce a figure that is not
      // allowed to change the answer.
      collision: null,
    };
  }

  // Nothing official. Search the explorer, but exclude the official set from
  // the candidate pool so a near-miss there can't be re-labelled unofficial.
  const candidates = await searchCandidates(q.raw);
  // The explorer is the ONLY thing that could have found this token, so a search
  // that did not answer means we never looked — "no token matching X was found"
  // would be a statement about the chain based on nothing.
  if (!candidates) {
    return {
      ...miss,
      reason: `The Robinhood Chain explorer search did not answer, so "${q.raw}" could not be looked up — unknown, not absent.`,
    };
  }
  // The official set, offline. It used to be derived from the walked list, which
  // meant that during an indexer brownout the list came back empty, nothing was
  // excluded, and the exclusion silently stopped happening on exactly the runs where
  // the ranking was least able to tell contracts apart. The snapshot is the same set
  // and cannot fail to load.
  const outsiders = candidates.filter((c) => !isCanonicalStockAddress(c.address));
  // THE RANKING NEEDS SOMETHING COMPARABLE TO RANK ON. Search rows carry no holder
  // count, so without this every contender ties and the market cap — which only
  // the indexer-priced contract has — picks the winner. See withHolderCounts.
  // Holders are read first because the DEPTH shortlist ranks on them: they are the
  // cheap figure that decides which handful of pools are worth the expensive read.
  const counted = await withHolderCounts(outsiders, q.raw);
  // …then the figure that actually decides it. See withQuoteDepth.
  const { candidates: ranked, survey } = await withQuoteDepth(counted, q.raw, options?.depthProbe);
  const best = pickBestMatch(ranked, q.raw);
  if (!best) {
    // The search DID answer and matched nothing: a measured absence.
    return {
      ...miss,
      impostors: [],
      impostorsRead: true,
      reason: `No token matching "${q.raw}" was found on Robinhood Chain.`,
    };
  }

  // THE COLLISION CHECK IS ABOUT THE TICKER, NOT THE WORDS TYPED, and outside the
  // 94 verified equities is exactly where tickers collide most and are policed
  // least. Measured: VLAD resolves to a contract NAMED "The Green Bull", while two
  // more contracts on this chain also answer to VLAD. The search above ran on the
  // user's query, which for a name-shaped query ("green bull") is a different
  // string from the resolved symbol and would find none of them, so it is re-run
  // on the symbol we actually landed on when the two differ.
  //
  // THE ISSUER CHECK RUNS ON THIS BRANCH TOO, and it is not optional. `official`
  // used to be hardcoded false here — a property of WHICH CODE PATH selected the
  // contract rather than of the contract — and a canonical equity still reaches
  // this branch: the 95th equity listed after the snapshot was taken has no
  // snapshot row to match, so the explorer search is the only thing that finds it,
  // and labelling it "not an official Robinhood tokenized equity" because of the
  // route it took would be a false statement about its deployer. The deployer is
  // the root of trust; whichever branch found the contract cannot change what its
  // deployer is. issuerRank answers offline and free for anything already in the
  // snapshot, and verifiedByIssuer is one indexer call that fails closed, run
  // concurrently with the search rather than after it.
  const [symbolCandidates, verified] = await Promise.all([
    !best.symbol || sameSymbol(best.symbol, q.raw) ? Promise.resolve(candidates) : searchCandidates(best.symbol),
    issuerRank(best) === 1 ? Promise.resolve(true) : verifiedByIssuer(best.address),
  ]);

  return {
    ok: true,
    query: q.raw,
    match: best,
    official: verified,
    impostors: findImpostors(symbolCandidates, best.symbol, best.address),
    // Not a hardcoded true: the second search can fail where the first answered,
    // and "no others wear this ticker" must never be the way a failure renders.
    impostorsRead: Array.isArray(symbolCandidates),
    // WHAT THE DEPTH MEASUREMENT SAW, and whether it settled the question. Null
    // when no measurement was made at all — which is not "nothing dominates".
    collision: survey ? collisionVerdict(ranked, q.raw, survey, best.symbol) : null,
    ...(verified
      ? {}
      : { reason: "Not an official Robinhood tokenized equity — treat this contract as unverified." }),
  };
}

/**
 * The depth verdict for a collision, with its sentence attached.
 *
 * Scoped to the top relevance tier, because that is the only set the figures can
 * change the answer within — a lookalike prefix is already outranked by the tiers
 * and no amount of liquidity promotes it.
 */
function collisionVerdict(candidates, query, survey, symbol) {
  const tier = topTier(candidates, query);
  const verdict = dominanceVerdict(tier, survey);
  return { symbol: symbol ?? null, ...verdict, notice: collisionNotice(verdict, symbol) };
}

/**
 * Look up one token by 0x address or by symbol/company name.
 *
 * @param {string} x
 * @returns {Promise<object|null>} StockToken, or null when nothing resolves
 */
export async function getStockBySymbolOrAddress(x) {
  const q = normalizeQuery(x);
  if (!q.raw) return null;

  if (ADDRESS_RE.test(q.raw)) {
    const address = q.raw.toLowerCase();
    // ONE READ, NOT A PAGE WALK. This used to call listStockTokens() first and scan
    // it for the address — 14.5s cold to find a row that /tokens/{address} returns
    // in ~1.1s from the same indexer, in the same shape, via the same makeToken. The
    // walk answered nothing this does not: an address that is an equity and one that
    // is not both end up here, and whether it is an equity is settled offline by
    // isCanonicalStockAddress wherever that matters.
    try {
      const raw = await getToken(q.raw);
      const rawName = typeof raw?.name === "string" ? raw.name : null;
      if (!rawName) return null;
      return makeToken(raw, address, rawName);
    } catch {
      return null;
    }
  }

  const resolved = await resolveSymbol(q.raw);
  return resolved.ok ? resolved.match : null;
}
