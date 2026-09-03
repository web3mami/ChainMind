import { formatUnits } from "viem";
import {
  ENRICHMENT_TIMEOUT_MS,
  TIMEOUT_MS,
  deadline,
  getAddress,
  getToken,
  getTokenActivity,
  getTokenCounters,
  getTokenHolders,
  getTransaction,
  searchChain,
} from "./blockscout.js";
import { fmtTokenAmount, pctOfSupply, sanitizeLabel } from "./ask-evidence.js";
import {
  CANONICAL_ISSUER,
  isCanonicalStockAddress,
  isStockTokenName,
  listStockTokens,
  normalizeQuery,
  resolveSymbol,
  snapshotMatch,
  stripStockSuffix,
  verifiedByIssuer,
} from "./stock-tokens.js";
import { displayNumber, finiteOrNull } from "./format-number.js";
import { compareByField } from "./market-evidence.js";
import { coHoldings, holderOverlap } from "./cross-token.js";
import { buildTable, col } from "./table-shape.js";
import { poolReadClient } from "./depth-rank.js";
import {
  HOLDER_ROLES,
  MAX_HOLDERS_PROBED,
  detectBundle,
  fundingSources,
  holdTimeSummary,
  holderFirstAcquisition,
  holdersOverThreshold,
} from "./holder-history.js";

/**
 * THE TOKEN-SIDE LOOKUPS — the questions that go past "tell me about X".
 *
 * lib/ask-evidence.js answers a token in one shape: the headline figures, ten
 * holders, eight transfers. That is the right answer to "hows nvda doin" and the
 * wrong answer to "who actually holds this", "what has moved today", "does this
 * flow look organised", "who deployed it and when", "what was that ticker
 * called again", "who is dumping", "how long have they held" and "was this
 * bundled". Each of those wants a different slice of the same contract, and
 * squeezing them into one lookup means every question pays for every slice.
 *
 * So they are separate lookups, and they share this module because they share
 * the hard parts: resolving a ticker or a company name to a contract, telling an
 * outage apart from an absence, and turning raw base-unit balances into figures
 * that are safe to print.
 *
 * The rules are the ones the rest of the codebase runs on, and they bind hardest
 * here because these functions PRINT LISTS:
 *
 *  1. A missing figure is missing. A percent with no total supply to divide by is
 *     null, never 0 — a holder shown as owning 0% of a token they demonstrably
 *     hold is the sharpest false claim this product could make.
 *  2. An outage is not an absence. An empty holder list from a call that failed
 *     is never "this token has no holders"; only a body that actually arrived can
 *     say what is in it.
 *  3. A prefix says it is a prefix. Every table carries the upstream total when
 *     the indexer gave one, so "25 of 29,642" is measured rather than implied.
 *  4. flagPatterns states OBSERVATIONS, never verdicts. Every finding carries the
 *     rows that produced it, no finding exists without them, and nothing here
 *     attaches a probability or an accusation to a shape in the data.
 *
 * Everything is best-effort and nothing throws: each function returns
 * `{ ok, kind, evidence }` or `{ ok: false, error }`, which is the contract
 * lib/ask-tools.js dispatches on.
 *
 * Server-side only: no React. Every chain read goes through lib/blockscout.js,
 * and therefore through the TTL cache and single-flight gate in
 * lib/indexer-cache.js — so a question that asks for holders and then patterns
 * pays for one holder call, not two.
 */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** The burn/mint address, which is a counterparty in name only. */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Row bounds. Wider than any answer quotes, narrow enough to stay promptable. */
export const MAX_HOLDER_ROWS = 100;
export const MAX_TRANSFER_ROWS = 100;
export const MAX_SEARCH_ROWS = 25;
/** Tighter than the transfer list: these rows are the answer, not a feed. */
export const MAX_WHALE_ROWS = 25;

/**
 * Row bounds for the two CROSS-TOKEN answers, and they are the tightest here because
 * their rows are the widest.
 *
 * MEASURED, not chosen: an overlap row carries the wallet's position in EVERY token
 * asked about, so four tokens make a row of roughly 224 characters against a holder
 * row's 90. lib/cross-token.js will happily return 200 wallets — at four tokens that
 * is a 102KB evidence blob against lib/ask-loop.js MAX_EVIDENCE_CHARS of 24,000, and
 * what gets cut when a blob is truncated mid-JSON is the tail: the bound, the
 * denominators, the reading and the disclaimer. Losing THOSE to a row cap is the
 * failure this whole change exists to prevent, so the rows are what gives way.
 *
 * Forty overlap rows at four tokens is ~9KB, which leaves room for the honesty fields
 * and for a second tool result in the same conversation. A co-holding run routinely
 * finds hundreds of other tokens (measured: 412 across five PIPECAT holders), so its
 * table is capped the same way and says how many it is out of.
 */
export const MAX_OVERLAP_ROWS = 40;
export const DEFAULT_OVERLAP_ROWS = 25;
export const MAX_COHOLDING_TOKEN_ROWS = 40;

/** The concentration bands every holder answer reports. */
const CONCENTRATION_RANKS = Object.freeze([10, 25]);

/**
 * How many rows travel in the PROSE half of the evidence, beside the table.
 *
 * The table carries every row the caller asked for, because it is what gets
 * drawn and exported. Repeating those rows in a second array would double them
 * in the prompt — at a limit of 100 that is roughly 26KB against lib/ask-loop.js
 * MAX_EVIDENCE_CHARS of 24,000, so the evidence would be truncated mid-JSON and
 * the table would be the half that got cut. So the array is a short slice for
 * the two or three rows an answer actually names, and the table is the list.
 */
const PROSE_HOLDERS = 10;
const PROSE_TRANSFERS = 8;
/** Eight, not ten: an overlap row carries a position per token and is wider. */
const PROSE_OVERLAP_WALLETS = 8;
const PROSE_COHOLDING_TOKENS = 10;

/**
 * The thresholds flagPatterns fires on, in one frozen block.
 *
 * They are exported and named because a threshold buried in an `if` is a magic
 * number nobody can argue with, and these decide whether a real trader is told
 * their token "looks coordinated". Every one of them is deliberately blunt: the
 * point is a reproducible observation the reader can check against the evidence
 * printed beside it, not a score.
 */
export const PATTERN_LIMITS = Object.freeze({
  /** Transfers of a near-identical size before the cluster is worth naming. */
  MIN_CLUSTER: 3,
  /** How close two amounts must be to count as "near-identical" (1%). */
  AMOUNT_TOLERANCE: 0.01,
  /** The window a matched-amount cluster must fall inside to mean anything. */
  CLUSTER_WINDOW_MS: 30 * 60_000,
  /** Share of supply at which one holder is the float rather than part of it. */
  DOMINANT_PCT: 50,
  /** Distinct recipients before "one-way distribution" is a shape and not noise. */
  MIN_RECEIVERS: 5,
  /** Senders allowed on the other side of that shape. */
  MAX_SENDERS: 2,
  /** Transfers needed before a tight window says anything about the token. */
  MIN_TIGHT: 5,
  /** The span that counts as tight. */
  TIGHT_WINDOW_MS: 5 * 60_000,
});

/* ------------------------------ plumbing ------------------------------ */

/**
 * The indexer calls, overridable per call — the same test seam
 * lib/ask-evidence.js and lib/ask-tools.js use. Nothing in this module may reach
 * Blockscout during a unit test.
 */
const DEFAULT_CALLS = Object.freeze({
  getAddress,
  getToken,
  getTokenActivity,
  getTokenCounters,
  getTokenHolders,
  getTransaction,
  searchChain,
  listStockTokens,
  resolveSymbol,
  snapshotMatch,
  verifiedByIssuer,
});

function withCalls(options) {
  const o = options && typeof options === "object" ? options : {};
  return o.calls && typeof o.calls === "object" ? { ...DEFAULT_CALLS, ...o.calls } : DEFAULT_CALLS;
}

/**
 * Run one indexer call without letting it fail the whole gather. A thunk rather
 * than a promise, for the reason lib/ask-evidence.js gives: a getter that throws
 * synchronously never produces a promise to catch.
 */
async function attempt(thunk) {
  try {
    return { ok: true, data: await thunk(), status: null };
  } catch (e) {
    return { ok: false, data: null, status: e?.status ?? null };
  }
}

/**
 * The `unavailable` bookkeeping, in the shape lib/ask-evidence.js established:
 * a call that failed names the evidence field it was going to fill, so the model
 * can say the field could not be read instead of reading it as empty.
 */
function tracker() {
  const unavailable = [];
  return {
    unavailable,
    async get(name, thunk) {
      const res = await attempt(thunk);
      if (!res.ok) unavailable.push(name);
      return res;
    },
    miss(name) {
      unavailable.push(name);
    },
    gaps() {
      return unavailable.length ? { unavailable: [...unavailable] } : {};
    },
  };
}

function nowIso() {
  return new Date().toISOString();
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Lowercased 0x address, or null when the field is not an address at all. */
function lowerAddress(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return ADDRESS_RE.test(s) ? s : null;
}

/** 0x1234567890abcdef… -> "0x1234…cdef", the form every surface here uses. */
function shortHex(value) {
  const v = String(value ?? "");
  return v.length > 12 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v;
}

/**
 * A base-unit amount as a Number, or null. Separate from fmtTokenAmount because
 * the pattern checks have to COMPARE amounts, and a compacted "1.23M" cannot be
 * compared with anything.
 */
function amountNumber(raw, decimals) {
  if (raw == null) return null;
  try {
    const d = Number.isFinite(Number(decimals)) ? Number(decimals) : 18;
    const n = Number(formatUnits(BigInt(raw), d));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** An indexer timestamp as epoch milliseconds, or null when it is unreadable. */
function timeMs(value) {
  if (value == null) return null;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
}

/** "2h 14m", "6 days", "just now" — a span said the way a reader would say it. */
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

/** The failure sentence for a call that never answered. Never "not found". */
function unavailableError(what, status) {
  return {
    ok: false,
    error: `The Robinhood Chain indexer did not answer${status ? ` (HTTP ${status})` : ""}, so ${what} could not be read — unknown, not absent. Try again shortly.`,
  };
}

/* ------------------------------ resolving ------------------------------ */

/**
 * A ticker, company name or 0x address -> the contract to read.
 *
 * Three paths, cheapest first: an address is already the answer; one of the 94
 * snapshotted tickers is a synchronous Map hit (lib/stock-tokens.js
 * snapshotMatch); anything else goes to the resolver, which costs a search.
 *
 * The failure branch is the one that matters. resolveSymbol reports "no token
 * matching X" both when the ticker genuinely does not exist AND when the indexer
 * answered nothing at all, because its inputs (the token walk, the explorer
 * search) both degrade to empty rather than throwing. Reporting the second as
 * the first would tell the user a contract they hold is not on the chain. So an
 * empty equity registry is read as the outage it is.
 *
 * Exported because lib/wallet-evidence.js needs exactly this: trace_wallet takes
 * a wallet AND a token, and the token half has to resolve by the same three
 * paths, fail with the same outage-versus-absence distinction, and cost the same
 * cache hits. A second copy of that decision is a second place for "the indexer
 * is down" to be answered as "no such ticker".
 *
 * @param {string} query
 * @param {object} calls - the indexer seam; needs resolveSymbol, snapshotMatch
 *   and listStockTokens (see DEFAULT_CALLS)
 * @returns {Promise<{ ok: true, address: string, symbol: string|null, company: string|null, snapshotted: boolean } | { ok: false, error: string }>}
 */
export async function resolveTokenTarget(query, calls) {
  const q = normalizeQuery(query).raw;
  if (!q) {
    return { ok: false, error: "No token to look up: name a ticker (e.g. NVDA), a company, or a 0x contract address." };
  }

  const asAddress = lowerAddress(q);
  if (asAddress) {
    // A pasted address is already the target; its ticker, if it has one, comes
    // off the token body a moment later. Nothing is resolved and nothing is
    // asserted about it here beyond whether it is in the verified snapshot.
    return {
      ok: true,
      address: asAddress,
      symbol: null,
      company: null,
      snapshotted: isCanonicalStockAddress(asAddress),
    };
  }

  const snap = safeSnapshot(q, calls);
  const snapAddress = lowerAddress(snap?.address);
  if (snapAddress) {
    return {
      ok: true,
      address: snapAddress,
      symbol: snap.symbol ?? null,
      company: snap.company ?? null,
      snapshotted: true,
    };
  }

  const resolved = await attempt(() => calls.resolveSymbol(q));
  const match = resolved.data?.ok ? resolved.data.match : null;
  const address = lowerAddress(match?.address);
  if (address) {
    return {
      ok: true,
      address,
      symbol: match.symbol ?? null,
      company: match.company ?? null,
      snapshotted: isCanonicalStockAddress(address),
    };
  }

  // Nothing resolved. An empty registry means nobody answered, not that
  // Robinhood delisted 94 equities.
  const listRes = await attempt(() => calls.listStockTokens());
  const list = Array.isArray(listRes.data) ? listRes.data : [];
  if (!list.length) return unavailableError(`"${q}"`, resolved.status);
  return {
    ok: false,
    error:
      resolved.data?.reason ??
      `No token matching "${q}" was found on Robinhood Chain. Check the spelling, or try the ticker instead of the company name.`,
  };
}

/** The snapshot hit for a ticker or company name. Synchronous, so it is guarded. */
function safeSnapshot(query, calls) {
  try {
    return calls.snapshotMatch(query) ?? null;
  } catch {
    return null;
  }
}

/**
 * The metadata every token-side lookup needs before it can print an amount:
 * decimals, the symbol, and total supply for the percentages.
 *
 * `decimalsAssumed` is the honest half. When the token endpoint does not answer
 * there is no decimals figure, and fmtTokenAmount's 18 is a GUESS — a token with
 * 6 decimals printed at 18 is understated by a factor of a trillion. Rather than
 * hide that behind a plausible-looking number, the assumption is stated and the
 * caller repeats it.
 */
async function tokenMeta(address, calls, src) {
  const res = await src.get("token", () => calls.getToken(address, deadline(TIMEOUT_MS)));
  const t = res.data ?? null;
  const rawName = typeof t?.name === "string" ? t.name : null;
  const decimals = finiteOrNull(t?.decimals);
  return {
    read: Boolean(t),
    status: res.status,
    name: sanitizeLabel(rawName, 72),
    rawName,
    symbol: sanitizeLabel(t?.symbol, 16),
    type: t?.type ?? null,
    decimals: decimals ?? 18,
    decimalsAssumed: decimals === null,
    rawSupply: t?.total_supply ?? null,
    priceUsd: t?.exchange_rate ?? null,
    marketCapUsd: t?.circulating_market_cap ?? null,
  };
}

/** The sentence that goes with `decimalsAssumed`, or null when it does not apply. */
function decimalsNote(meta) {
  return meta.decimalsAssumed
    ? "The token endpoint did not answer, so every amount below is converted at an assumed 18 decimals and may be wrong by orders of magnitude if this contract uses another precision."
    : null;
}

/* ------------------------------ pure cores ------------------------------ */
/* Exported for test/token-evidence.test.mjs. The rows, the concentration maths
   and the pattern checks are where a missing figure would become a claimed one,
   so all three are testable with no network at all. */

/**
 * A row count for a list, clamped into range. Junk falls back rather than
 * failing: a holder list is answerable at the default depth, so refusing a limit
 * of "loads" would cost a round trip to reach the same 25.
 *
 * @param {unknown} raw
 * @param {number} fallback
 * @param {number} max
 * @returns {number}
 */
export function clampRows(raw, fallback, max) {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(1, n));
}

/**
 * Raw holder items -> flat printable rows.
 *
 * Every cell is a primitive because these rows go straight into a table, where a
 * nested object renders as "[object Object]". `percent` stays a Number for the
 * concentration maths and `percentDisplay` is what anything printed reads —
 * both null, never 0, when there is no total supply to divide by.
 *
 * @param {Array<object>} items - raw getTokenHolders items
 * @param {number} decimals
 * @param {unknown} rawSupply
 * @returns {Array<object>}
 */
export function holderRows(items, decimals, rawSupply) {
  return (Array.isArray(items) ? items : []).map((h, i) => {
    const percent = pctOfSupply(h?.value, rawSupply);
    return {
      rank: i + 1,
      address: h?.address?.hash ?? h?.address ?? null,
      amount: amountNumber(h?.value, decimals),
      amountDisplay: fmtTokenAmount(h?.value, decimals),
      percent,
      percentDisplay: percent === null ? null : `${percent}%`,
    };
  });
}

/**
 * How much of the supply the top `rank` holders sit on.
 *
 * Two things are reported beside the figure, and both exist because the obvious
 * single number lies in two different ways. `counted` says how many of those
 * rows carried a percent at all — an unknown share summed as zero would
 * understate concentration, which is the direction that matters. `of` says how
 * many rows there were to look at: a "top 25" computed from the 20 holders the
 * indexer returned is not a top 25, and `complete` says so outright.
 *
 * @param {Array<object>} rows - holderRows output
 * @param {number} rank
 * @returns {{ rank: number, percent: number|null, counted: number, of: number, complete: boolean, display: string|null }}
 */
export function concentrationOf(rows, rank) {
  const slice = (Array.isArray(rows) ? rows : []).slice(0, rank);
  const known = slice.map((r) => r?.percent).filter((p) => typeof p === "number" && Number.isFinite(p));
  const complete = slice.length >= rank;
  if (!known.length) {
    return { rank, percent: null, counted: 0, of: slice.length, complete, display: null };
  }
  const percent = round2(known.reduce((acc, p) => acc + p, 0));
  return {
    rank,
    percent,
    counted: known.length,
    of: slice.length,
    complete,
    // Pre-rendered, so an answer cannot quote "the top 25 hold 38%" off a sum
    // over twenty rows without the qualifier travelling with it.
    display: complete
      ? `${percent}% across the top ${rank}`
      : `${percent}% across the ${slice.length} holder${slice.length === 1 ? "" : "s"} that could be read`,
  };
}

/**
 * Raw transfer items -> flat printable rows. Amounts use the transfer's own
 * decimals when it carries them, since a transfer body is the more specific
 * source, and fall back to the token's.
 *
 * @param {Array<object>} items - raw getTokenActivity items
 * @param {number} decimals
 * @returns {Array<object>}
 */
export function transferRows(items, decimals) {
  return (Array.isArray(items) ? items : []).map((x, i) => {
    const d = finiteOrNull(x?.total?.decimals ?? x?.token?.decimals) ?? decimals;
    return {
      rank: i + 1,
      time: x?.timestamp ?? null,
      timeMs: timeMs(x?.timestamp),
      from: x?.from?.hash ?? x?.from ?? null,
      to: x?.to?.hash ?? x?.to ?? null,
      amount: amountNumber(x?.total?.value, d),
      amountDisplay: fmtTokenAmount(x?.total?.value, d),
      txHash: x?.transaction_hash ?? x?.tx_hash ?? null,
      method: sanitizeLabel(x?.method, 24),
    };
  });
}

/**
 * Clusters of near-identical amounts, largest cluster first.
 *
 * Sorted sweep rather than bucketing: bucketing by a fixed step splits two
 * amounts that differ by a rounding error across a boundary and misses the very
 * thing being looked for. The tolerance is relative, so it means the same at
 * 0.001 tokens as at a million.
 *
 * @param {Array<object>} rows - transferRows output
 * @param {number} tolerance
 * @returns {Array<Array<object>>}
 */
export function amountClusters(rows, tolerance = PATTERN_LIMITS.AMOUNT_TOLERANCE) {
  const priced = (Array.isArray(rows) ? rows : [])
    .filter((r) => typeof r?.amount === "number" && Number.isFinite(r.amount) && r.amount > 0)
    .sort((a, b) => a.amount - b.amount);

  const clusters = [];
  let i = 0;
  while (i < priced.length) {
    const base = priced[i].amount;
    let j = i + 1;
    while (j < priced.length && priced[j].amount <= base * (1 + tolerance)) j += 1;
    clusters.push(priced.slice(i, j));
    i = j;
  }
  return clusters.sort((a, b) => b.length - a.length);
}

/** The distinct, non-null values of one side of a transfer list. */
function sideSet(rows, key) {
  const out = new Set();
  for (const row of rows) {
    const v = lowerAddress(row?.[key]);
    if (v) out.add(v);
  }
  return out;
}

/** The known timestamps of a row list, ascending. */
function knownTimes(rows) {
  return rows
    .map((r) => r?.timeMs)
    .filter((t) => typeof t === "number" && Number.isFinite(t))
    .sort((a, b) => a - b);
}

/** One finding, with the evidence that produced it attached by construction. */
function finding(id, label, reading, evidence) {
  return { id, label, reading, evidence };
}

/**
 * The four checks, run over rows already in hand. PURE and deterministic: same
 * rows in, same findings out, no clock, no network, no model.
 *
 * Every check either produces a finding WITH its evidence or produces nothing.
 * There is no path here that emits a finding whose evidence is absent, and no
 * path that attaches a likelihood, a score or a verdict to one — the readings
 * describe the shape and stop, because a shape in fifty transfers is not proof
 * of intent and this module must never be quotable as saying it is.
 *
 * @param {{ transfers: Array<object>|null, holders: Array<object>|null, symbol: string|null }} input
 * @returns {{ findings: Array<object>, checked: Array<object> }}
 */
export function detectPatterns({ transfers, holders, symbol } = {}) {
  const rows = Array.isArray(transfers) ? transfers : null;
  const held = Array.isArray(holders) ? holders : null;
  const ticker = symbol ? String(symbol) : "this token";
  const findings = [];
  const checked = [];

  const note = (check, label, ran, fired, reason) =>
    checked.push({ check, label, ran, fired: ran ? fired : null, ...(reason ? { reason } : {}) });

  /* 1. Several addresses moving near-identical amounts inside a short window. */
  if (!rows || rows.length < PATTERN_LIMITS.MIN_CLUSTER) {
    note("matched_amounts", "Near-identical amounts from several addresses", false, null,
      rows ? `only ${rows.length} recent transfers were readable` : "recent transfers could not be read");
  } else {
    let hit = null;
    for (const cluster of amountClusters(rows)) {
      if (cluster.length < PATTERN_LIMITS.MIN_CLUSTER) break;
      const senders = sideSet(cluster, "from");
      if (senders.size < PATTERN_LIMITS.MIN_CLUSTER) continue;
      const times = knownTimes(cluster);
      // No timestamps means no window, and "inside a short window" is half the
      // claim — so it does not fire rather than firing without that half.
      if (times.length < 2) continue;
      const span = times[times.length - 1] - times[0];
      if (span > PATTERN_LIMITS.CLUSTER_WINDOW_MS) continue;
      hit = { cluster, senders, span, times };
      break;
    }
    if (hit) {
      const sample = hit.cluster.slice(0, 6);
      findings.push(
        finding(
          "matched_amounts",
          "Near-identical amounts from several addresses",
          `${hit.cluster.length} transfers of about ${sample[0].amountDisplay} ${ticker} moved from ${hit.senders.size} different addresses inside ${spanWords(hit.span)}. Amounts that match this closely from separate addresses are usually one operator or one script rather than independent trades — coordinated entry, or the same balance being cycled. It is a shape in the data, not proof of either.`,
          {
            transfers: hit.cluster.length,
            distinctSenders: hit.senders.size,
            amountAbout: sample[0].amountDisplay,
            windowSeconds: Math.round(hit.span / 1000),
            windowDisplay: spanWords(hit.span),
            firstAt: new Date(hit.times[0]).toISOString(),
            lastAt: new Date(hit.times[hit.times.length - 1]).toISOString(),
            rows: sample.map((r) => ({
              from: r.from,
              to: r.to,
              amount: r.amountDisplay,
              at: r.time,
              txHash: r.txHash,
            })),
          },
        ),
      );
    }
    note("matched_amounts", "Near-identical amounts from several addresses", true, Boolean(hit));
  }

  /* 2. One address holding a dominant share. */
  const top = held?.[0] ?? null;
  if (!held || !held.length) {
    note("dominant_holder", "One address holding a dominant share", false, null,
      held ? "no holder rows were returned" : "the holder list could not be read");
  } else if (typeof top?.percent !== "number") {
    note("dominant_holder", "One address holding a dominant share", false, null,
      "no total supply came back to measure a share against");
  } else {
    const fired = top.percent >= PATTERN_LIMITS.DOMINANT_PCT;
    if (fired) {
      const rest = held.slice(1, 4).filter((h) => typeof h.percent === "number");
      findings.push(
        finding(
          "dominant_holder",
          "One address holding a dominant share",
          `${shortHex(top.address)} holds ${top.percentDisplay} of ${ticker}'s total supply. At that size the tradable float is whatever that one address chooses not to move, and any read of price or volume is a read of their behaviour as much as the market's. It is not by itself evidence of anything — a treasury, a bridge contract and an LP position all look like this.`,
          {
            address: top.address,
            amount: top.amountDisplay,
            percent: top.percentDisplay,
            nextHolders: rest.map((h) => ({ address: h.address, amount: h.amountDisplay, percent: h.percentDisplay })),
          },
        ),
      );
    }
    note("dominant_holder", "One address holding a dominant share", true, fired);
  }

  /* 3. One-way distribution out of a small set of senders. */
  if (!rows || rows.length < PATTERN_LIMITS.MIN_RECEIVERS) {
    note("one_way_distribution", "One-way distribution from a small set", false, null,
      rows ? `only ${rows.length} recent transfers were readable` : "recent transfers could not be read");
  } else {
    const senders = sideSet(rows, "from");
    const receivers = sideSet(rows, "to");
    const bothSides = [...receivers].filter((a) => senders.has(a));
    const fired = senders.size <= PATTERN_LIMITS.MAX_SENDERS && receivers.size >= PATTERN_LIMITS.MIN_RECEIVERS;
    if (fired) {
      const named = [...senders];
      const minting = named.includes(ZERO_ADDRESS);
      findings.push(
        finding(
          "one_way_distribution",
          "One-way distribution from a small set",
          `All ${rows.length} of the recent transfers read came from ${senders.size} address${senders.size === 1 ? "" : "es"} and went out to ${receivers.size} distinct recipients, with ${bothSides.length} address${bothSides.length === 1 ? "" : "es"} appearing on both sides. That is distribution outward rather than two-way trade${minting ? ", and it starts at the zero address, so this is minting or an airdrop rather than trading" : ""}. It describes the sample read, not the token's whole history.`,
          {
            transfers: rows.length,
            senders: named.slice(0, 5),
            distinctSenders: senders.size,
            distinctReceivers: receivers.size,
            addressesOnBothSides: bothSides.length,
            includesZeroAddress: minting,
            rows: rows.slice(0, 6).map((r) => ({ from: r.from, to: r.to, amount: r.amountDisplay, at: r.time })),
          },
        ),
      );
    }
    note("one_way_distribution", "One-way distribution from a small set", true, fired);
  }

  /* 4. Transfers clustered into a very tight window. */
  const times = rows ? knownTimes(rows) : [];
  if (!rows || times.length < PATTERN_LIMITS.MIN_TIGHT) {
    note("tight_window", "Transfers clustered in a tight window", false, null,
      rows ? "too few transfers carried a readable timestamp" : "recent transfers could not be read");
  } else {
    const span = times[times.length - 1] - times[0];
    const fired = span <= PATTERN_LIMITS.TIGHT_WINDOW_MS;
    if (fired) {
      findings.push(
        finding(
          "tight_window",
          "Transfers clustered in a tight window",
          `The ${times.length} most recent transfers all landed inside ${spanWords(span)}. The sample is one burst rather than steady flow, so anything read off it describes that episode and not the token's usual pace.`,
          {
            transfers: times.length,
            windowSeconds: Math.round(span / 1000),
            windowDisplay: spanWords(span),
            firstAt: new Date(times[0]).toISOString(),
            lastAt: new Date(times[times.length - 1]).toISOString(),
            rows: rows.slice(0, 6).map((r) => ({ from: r.from, to: r.to, amount: r.amountDisplay, at: r.time })),
          },
        ),
      );
    }
    note("tight_window", "Transfers clustered in a tight window", true, fired);
  }

  return { findings, checked };
}

/**
 * Score one search hit against the query. Higher wins; every hit keeps a floor
 * score, because a search that returned a row is a row the user may have meant
 * and dropping it would be answering a narrower question than they asked.
 */
function searchScore(row, q) {
  const symbol = String(row?.symbol ?? "").trim().toUpperCase();
  const name = String(row?.name ?? "").trim().toLowerCase();
  const company = String(row?.company ?? "").trim().toLowerCase();
  if (symbol && symbol === q.symbol) return 100;
  if (company && company === q.lower) return 90;
  if (name && name === q.lower) return 85;
  if (symbol && q.symbol.length >= 2 && symbol.startsWith(q.symbol)) return 70;
  if (company && q.lower.length >= 2 && company.startsWith(q.lower)) return 60;
  if (q.lower.length >= 2 && (company.includes(q.lower) || name.includes(q.lower))) return 40;
  return 10;
}

/**
 * Rank search hits: relevance, then issuer-verified ahead of everything else,
 * then the contract more people hold, then the symbol so two runs agree.
 *
 * Putting the verified equity first at equal relevance is the whole point of the
 * ordering. Someone typing "nvda" into a search box is looking for the token
 * Robinhood issued, and several contracts on this chain answer to that ticker.
 *
 * @param {Array<object>} rows - shaped search rows
 * @param {string} query
 * @returns {Array<object>} ranked copies, each with `rank` set
 */
export function rankSearchResults(rows, query) {
  const q = normalizeQuery(query);
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && typeof r === "object")
    .map((r) => ({ ...r, score: searchScore(r, q) }))
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.issuerVerified !== b.issuerVerified) return a.issuerVerified ? -1 : 1;
      const ah = Number.isFinite(a.holders) ? a.holders : -1;
      const bh = Number.isFinite(b.holders) ? b.holders : -1;
      if (ah !== bh) return bh - ah;
      return String(a.symbol ?? "").localeCompare(String(b.symbol ?? ""));
    })
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

/* ------------------------------ 1. holders ------------------------------ */

/**
 * Who holds a token, ranked, with how much of the supply the top of the book
 * sits on.
 *
 * The concentration totals are the reason this is worth its own lookup: a holder
 * list is a block explorer feature, and "the top 10 hold 94% of supply" is the
 * sentence a reader actually wanted. Both are computed over every row the page
 * returned rather than over the `limit` rows displayed, so asking for five
 * holders does not silently turn the top-25 figure into a top-5 figure.
 *
 * @param {string} query - ticker, company name or 0x contract address
 * @param {{ limit?: number, calls?: object }} [options]
 * @returns {Promise<{ ok: boolean, kind?: string, evidence?: object, error?: string }>}
 */
export async function tokenHolders(query, options = {}) {
  const calls = withCalls(options);
  const limit = clampRows(options?.limit, 25, MAX_HOLDER_ROWS);

  try {
    const target = await resolveTokenTarget(query, calls);
    if (!target.ok) return target;

    const src = tracker();
    // Both start together: the holder page is the answer and the counters carry
    // the upstream total that keeps the table honest about being a prefix.
    const holdersPromise = attempt(() => calls.getTokenHolders(target.address, {}, deadline(TIMEOUT_MS)));
    const countersPromise = attempt(() => calls.getTokenCounters(target.address, deadline(ENRICHMENT_TIMEOUT_MS)));
    const meta = await tokenMeta(target.address, calls, src);

    const holdersRes = await holdersPromise;
    if (!holdersRes.ok) src.miss("holders");
    const countersRes = await countersPromise;
    if (!countersRes.ok) src.miss("holderCount");

    if (!holdersRes.ok || !holdersRes.data) {
      // Nothing to rank and no honest way to say there is nobody holding it.
      return unavailableError(`the holder list for ${target.symbol ?? target.address}`, holdersRes.status);
    }

    const items = Array.isArray(holdersRes.data?.items) ? holdersRes.data.items : [];
    const all = holderRows(items, meta.decimals, meta.rawSupply);
    const rows = all.slice(0, limit);
    const symbol = target.symbol ?? meta.symbol ?? null;
    const holderCount = countersRes.data?.token_holders_count ?? null;
    const morePages = Boolean(holdersRes.data?.next_page_params);

    const table = buildTable({
      id: "token-holders",
      title: `Top ${rows.length} holder${rows.length === 1 ? "" : "s"}${symbol ? ` of ${symbol}` : ""}`,
      columns: [
        col("rank", "#", "right"),
        col("address", "Holder"),
        col("amountDisplay", "Amount", "right"),
        col("percentDisplay", "Share of supply", "right"),
      ],
      rows,
      // The upstream count, so the chrome can say "25 of 29,642" as a measured
      // statement. buildTable drops a total it cannot trust.
      totalRows: holderCount,
      truncated: morePages || rows.length < all.length,
      note: [
        "Balances are the indexer's at the time of the lookup, and the share is of total supply.",
        meta.rawSupply == null
          ? "No total supply came back, so every share is blank — unknown, not a zero holding."
          : "A blank share means that row's balance could not be divided by supply, not a zero holding.",
        decimalsNote(meta),
      ]
        .filter(Boolean)
        .join(" "),
    });

    return {
      ok: true,
      kind: "holders",
      evidence: {
        ...src.gaps(),
        address: target.address,
        symbol,
        company: target.company ?? null,
        name: meta.name,
        totalSupply: meta.rawSupply != null ? `${fmtTokenAmount(meta.rawSupply, meta.decimals)} ${symbol ?? ""}`.trim() : null,
        // null, never 0: an uncounted holder base is not an empty one.
        holderCount: finiteOrNull(holderCount),
        holderCountDisplay: displayNumber(finiteOrNull(holderCount), "count"),
        rowsShown: rows.length,
        rowsRead: all.length,
        limit,
        // The bands the answer is expected to quote, each already qualified.
        concentration: CONCENTRATION_RANKS.map((rank) => concentrationOf(all, rank)),
        // The front of the list, for the rows the prose names. Every row the
        // caller asked for is in the table below — see PROSE_HOLDERS.
        topHolders: rows.slice(0, PROSE_HOLDERS),
        ...(meta.decimalsAssumed ? { decimalsAssumed: true, decimalsNote: decimalsNote(meta) } : {}),
        table,
        asOf: nowIso(),
      },
    };
  } catch (e) {
    return { ok: false, error: `The holder list could not be read: ${String(e?.message ?? e).slice(0, 200)}.` };
  }
}

/* ------------------------------ 2. transfers ------------------------------ */

/**
 * What has moved recently in one token: time, from, to, amount, transaction.
 *
 * Truncation is load-bearing here in a way it is not for holders. A holder list
 * has a natural top; a transfer list does not, so "the recent transfers" is
 * ALWAYS a prefix of something longer, and an answer that reads twenty-five rows
 * and speaks about "the activity" has overstated what it saw. The upstream
 * transfer count travels with the table so it cannot.
 *
 * @param {string} query - ticker, company name or 0x contract address
 * @param {{ limit?: number, calls?: object }} [options]
 * @returns {Promise<{ ok: boolean, kind?: string, evidence?: object, error?: string }>}
 */
export async function tokenTransfers(query, options = {}) {
  const calls = withCalls(options);
  const limit = clampRows(options?.limit, 25, MAX_TRANSFER_ROWS);

  try {
    const target = await resolveTokenTarget(query, calls);
    if (!target.ok) return target;

    const src = tracker();
    const activityPromise = attempt(() => calls.getTokenActivity(target.address, {}, deadline(TIMEOUT_MS)));
    const countersPromise = attempt(() => calls.getTokenCounters(target.address, deadline(ENRICHMENT_TIMEOUT_MS)));
    const meta = await tokenMeta(target.address, calls, src);

    const activityRes = await activityPromise;
    if (!activityRes.ok) src.miss("transfers");
    const countersRes = await countersPromise;
    if (!countersRes.ok) src.miss("transferCount");

    if (!activityRes.ok || !activityRes.data) {
      return unavailableError(`recent transfers of ${target.symbol ?? target.address}`, activityRes.status);
    }

    const items = Array.isArray(activityRes.data?.items) ? activityRes.data.items : [];
    const all = transferRows(items, meta.decimals);
    const rows = all.slice(0, limit);
    const symbol = target.symbol ?? meta.symbol ?? null;
    const transferCount = countersRes.data?.transfers_count ?? null;
    const morePages = Boolean(activityRes.data?.next_page_params);
    const times = knownTimes(all);

    const table = buildTable({
      id: "token-transfers",
      title: `${rows.length} recent transfer${rows.length === 1 ? "" : "s"}${symbol ? ` of ${symbol}` : ""}`,
      columns: [
        col("time", "Time"),
        col("from", "From"),
        col("to", "To"),
        col("amountDisplay", "Amount", "right"),
        col("txHash", "Transaction"),
      ],
      rows,
      totalRows: transferCount,
      // Always a prefix unless the indexer's own count agrees it is not.
      truncated: morePages || rows.length < all.length,
      note: [
        "The newest transfers first, as the indexer had them at lookup time.",
        decimalsNote(meta),
      ]
        .filter(Boolean)
        .join(" "),
    });

    return {
      ok: true,
      kind: "transfers",
      evidence: {
        ...src.gaps(),
        address: target.address,
        symbol,
        company: target.company ?? null,
        name: meta.name,
        // null, never 0: an uncounted transfer history is not an empty one.
        transferCount: finiteOrNull(transferCount),
        transferCountDisplay: displayNumber(finiteOrNull(transferCount), "count"),
        rowsShown: rows.length,
        rowsRead: all.length,
        limit,
        // What span the sample actually covers, so "recent" is a measured word.
        window: times.length >= 2
          ? {
              from: new Date(times[0]).toISOString(),
              to: new Date(times[times.length - 1]).toISOString(),
              spanDisplay: spanWords(times[times.length - 1] - times[0]),
            }
          : null,
        // The newest few, for the rows the prose names. Every row the caller
        // asked for is in the table below — see PROSE_TRANSFERS.
        recentTransfers: rows.slice(0, PROSE_TRANSFERS),
        ...(meta.decimalsAssumed ? { decimalsAssumed: true, decimalsNote: decimalsNote(meta) } : {}),
        table,
        asOf: nowIso(),
      },
    };
  } catch (e) {
    return { ok: false, error: `Recent transfers could not be read: ${String(e?.message ?? e).slice(0, 200)}.` };
  }
}

/* ------------------------------ 3. patterns ------------------------------ */

/**
 * Deterministic, explainable observations over one token's recent flow.
 *
 * THE CONTRACT OF THIS FUNCTION, because it is the one that can do real harm:
 *
 *  - Every finding carries the rows that produced it. There is no code path that
 *    emits a finding without its addresses, amounts and timestamps.
 *  - Nothing here is a verdict. No score, no probability, no "likely wash
 *    trading". Each reading names the shape and immediately names what it does
 *    not establish, because a shape in fifty transfers is not intent.
 *  - NOTHING FIRING IS A REAL ANSWER. An empty `findings` array means the checks
 *    ran and matched nothing, and `checked` proves which ones ran — it is never
 *    the same thing as a lookup that failed, and `checked[].ran` is what tells
 *    the two apart.
 *
 * @param {string} query - ticker, company name or 0x contract address
 * @param {{ calls?: object }} [options]
 * @returns {Promise<{ ok: boolean, kind?: string, evidence?: object, error?: string }>}
 */
export async function flagPatterns(query, options = {}) {
  const calls = withCalls(options);

  try {
    const target = await resolveTokenTarget(query, calls);
    if (!target.ok) return target;

    const src = tracker();
    const activityPromise = attempt(() => calls.getTokenActivity(target.address, {}, deadline(TIMEOUT_MS)));
    const holdersPromise = attempt(() => calls.getTokenHolders(target.address, {}, deadline(TIMEOUT_MS)));
    const meta = await tokenMeta(target.address, calls, src);

    const activityRes = await activityPromise;
    if (!activityRes.ok) src.miss("recentTransfers");
    const holdersRes = await holdersPromise;
    if (!holdersRes.ok) src.miss("topHolders");

    // Neither side readable: there is nothing to observe and no honest way to
    // say nothing stood out. That is an outage, and it is reported as one.
    if (!activityRes.data && !holdersRes.data) {
      return unavailableError(`the recent flow of ${target.symbol ?? target.address}`, activityRes.status ?? holdersRes.status);
    }

    const transfers = activityRes.data
      ? transferRows(Array.isArray(activityRes.data.items) ? activityRes.data.items : [], meta.decimals)
      : null;
    const holders = holdersRes.data
      ? holderRows(Array.isArray(holdersRes.data.items) ? holdersRes.data.items : [], meta.decimals, meta.rawSupply)
      : null;

    const symbol = target.symbol ?? meta.symbol ?? null;
    const { findings, checked } = detectPatterns({ transfers, holders, symbol });
    const times = transfers ? knownTimes(transfers) : [];
    const ranCount = checked.filter((c) => c.ran).length;

    return {
      ok: true,
      kind: "patterns",
      evidence: {
        ...src.gaps(),
        address: target.address,
        symbol,
        name: meta.name,
        // What was actually looked at, so no answer can imply a wider sweep.
        sample: {
          transfersRead: transfers ? transfers.length : null,
          holdersRead: holders ? holders.length : null,
          window: times.length >= 2
            ? {
                from: new Date(times[0]).toISOString(),
                to: new Date(times[times.length - 1]).toISOString(),
                spanDisplay: spanWords(times[times.length - 1] - times[0]),
              }
            : null,
        },
        findings,
        // Which checks ran and which could not, so an empty findings list is
        // readable as "nothing matched" rather than as "nothing was looked at".
        checked,
        summary: findings.length
          ? `${findings.length} of the ${ranCount} check${ranCount === 1 ? "" : "s"} that could run matched something in the sample read.`
          : ranCount
            ? `All ${ranCount} check${ranCount === 1 ? "" : "s"} that could run found nothing to flag in the sample read. That is a result, not a failed lookup.`
            : "None of the checks could run, because neither the recent transfers nor the holder list came back. Nothing was measured, so nothing can be said either way.",
        disclaimer:
          "These are observations about a sample of recent on-chain activity, not verdicts about the token or anyone using it. Each one names the rows it came from; none of them establishes intent, and none carries a probability.",
        ...(meta.decimalsAssumed ? { decimalsAssumed: true, decimalsNote: decimalsNote(meta) } : {}),
        asOf: nowIso(),
      },
    };
  } catch (e) {
    return { ok: false, error: `The recent flow could not be read: ${String(e?.message ?? e).slice(0, 200)}.` };
  }
}

/* ------------------------------ 4. contract info ------------------------------ */

/**
 * The deployment record for one contract: verification, deployer, creation
 * transaction, whether the deployer is Robinhood's issuer, and how old it is.
 *
 * This is a DIFFERENT question from safety_check, and the difference is worth
 * stating. safety_check asks "is this the real NVDA" — it compares one contract
 * against a ticker's genuine one and names the impostors wearing the name.
 * This asks "what is this contract" — when it appeared, who put it there,
 * whether the source is published. A contract can be perfectly genuine and three
 * days old with unpublished source; a contract can be verified, ancient and
 * still not Robinhood's. Neither question answers the other.
 *
 * `issuerVerified` has three states and the third is the important one: true,
 * false, and null for "the deployer could not be read". A contract that failed
 * its lookup must never be reported as failing its issuer check.
 *
 * @param {string} query - ticker, company name or 0x contract address
 * @param {{ calls?: object }} [options]
 * @returns {Promise<{ ok: boolean, kind?: string, evidence?: object, error?: string }>}
 */
export async function contractInfo(query, options = {}) {
  const calls = withCalls(options);

  try {
    const target = await resolveTokenTarget(query, calls);
    if (!target.ok) return target;

    const src = tracker();
    const overviewPromise = attempt(() => calls.getAddress(target.address, deadline(TIMEOUT_MS)));
    const meta = await tokenMeta(target.address, calls, src);
    const overviewRes = await overviewPromise;
    if (!overviewRes.ok) src.miss("contract");

    const addr = overviewRes.data ?? null;
    if (!addr && !meta.read) {
      if (overviewRes.status === 404 && meta.status === 404) {
        return { ok: false, error: `Nothing exists at ${target.address} on Robinhood Chain.` };
      }
      return unavailableError(`the contract record for ${target.address}`, overviewRes.status);
    }

    const deployer = lowerAddress(addr?.creator_address_hash);
    const creationTx = typeof addr?.creation_tx_hash === "string" ? addr.creation_tx_hash : null;
    const snapshotted = isCanonicalStockAddress(target.address);

    // verifiedByIssuer is the positive test and fails CLOSED, so a false from it
    // cannot be reported as "not the issuer" on its own — that is only true when
    // the deployer was actually read.
    const byIssuer = await attempt(() => calls.verifiedByIssuer(target.address));
    const issuerVerified = byIssuer.data === true ? true : deployer === null ? null : deployer === CANONICAL_ISSUER;

    // The creation transaction is what dates the contract; it is enrichment, so
    // a stall costs the age and nothing else.
    let created = null;
    if (creationTx) {
      const txRes = await src.get("createdAt", () => calls.getTransaction(creationTx, deadline(ENRICHMENT_TIMEOUT_MS)));
      created = txRes.data?.timestamp ?? null;
    }
    const createdMs = timeMs(created);
    const ageMs = createdMs === null ? null : Date.now() - createdMs;

    const rawName = meta.rawName;
    const symbol = target.symbol ?? meta.symbol ?? null;

    return {
      ok: true,
      kind: "contract",
      evidence: {
        ...src.gaps(),
        address: target.address,
        symbol,
        name: meta.name,
        type: meta.type,
        isContract: addr?.is_contract ?? null,
        // null when the overview never landed: false would claim the source is
        // unpublished, which is a fact about the contract we did not check.
        sourceVerified: addr?.is_verified ?? null,
        deployer,
        creationTx,
        createdAt: created,
        ageDays: ageMs === null ? null : round2(ageMs / 86_400_000),
        ageDisplay: ageMs === null ? null : spanWords(ageMs),
        issuerVerified,
        expectedIssuer: CANONICAL_ISSUER,
        inVerifiedSnapshot: snapshotted,
        // The name carries the official convention. Reported, never trusted:
        // it is exactly the part an impostor copies first.
        namedLikeEquity: isStockTokenName(rawName),
        holders: finiteOrNull(addr?.token?.holders_count ?? addr?.token?.holders),
        reading: contractReading({ issuerVerified, snapshotted, deployer, sourceVerified: addr?.is_verified ?? null, ageMs, namedLikeEquity: isStockTokenName(rawName) }),
        ...(meta.decimalsAssumed ? { decimalsAssumed: true } : {}),
        asOf: nowIso(),
      },
    };
  } catch (e) {
    return { ok: false, error: `The contract record could not be read: ${String(e?.message ?? e).slice(0, 200)}.` };
  }
}

/**
 * The deployment record said in sentences — one per fact that is actually known.
 *
 * Written here rather than left to the model for the usual reason: "the deployer
 * could not be read" and "the deployer is someone else" are different statements
 * and only one of them is an accusation, so the wording of that distinction is
 * not something to re-derive per answer.
 */
function contractReading({ issuerVerified, snapshotted, deployer, sourceVerified, ageMs, namedLikeEquity }) {
  const lines = [];
  if (snapshotted) {
    lines.push("This contract is in ChainMind's verified snapshot of Robinhood's tokenized equities.");
  } else if (issuerVerified === true) {
    lines.push(`Deployed by Robinhood's issuer ${CANONICAL_ISSUER}, which is what makes a tokenized equity genuine. It was listed after the snapshot was taken.`);
  } else if (issuerVerified === false) {
    lines.push(
      `Deployed by ${deployer}, not Robinhood's issuer ${CANONICAL_ISSUER}${namedLikeEquity ? ", while carrying the official tokenized-equity naming convention — the name is copyable, the deployer is not" : ""}.`,
    );
  } else {
    lines.push("No deployer is recorded for this contract in the indexer's answer, so whether Robinhood issued it could not be checked. Treat it as unverified rather than as unofficial.");
  }

  if (sourceVerified === true) lines.push("Its source code is published and verified on the explorer.");
  else if (sourceVerified === false) lines.push("Its source code is not published on the explorer, so what it does can only be read from its bytecode.");
  else lines.push("Whether its source is published could not be read.");

  if (ageMs !== null && ageMs < 7 * 86_400_000) {
    lines.push("It was created within the last week.");
  }
  return lines.join(" ");
}

/* ------------------------------ 5. search ------------------------------ */

/**
 * Find tokens by a partial name or symbol — how someone reaches a ticker they
 * half-remember ("that nvidia one", "brk").
 *
 * The verified column is the point. The explorer search matches on name and
 * symbol, so it returns impostors alongside the real contract by design, and a
 * bare list of five things called NVDA is worse than no list. Every row says
 * whether its address is one of the snapshotted, issuer-verified equities — and
 * a row that says it is not is NOT being called a fake: it may be an ordinary
 * token, or an equity listed after the snapshot. The note says so, and points at
 * the tool that actually decides.
 *
 * @param {string} query - a partial name, symbol or company
 * @param {{ limit?: number, calls?: object }} [options]
 * @returns {Promise<{ ok: boolean, kind?: string, evidence?: object, error?: string }>}
 */
export async function searchTokens(query, options = {}) {
  const calls = withCalls(options);
  const limit = clampRows(options?.limit, 10, MAX_SEARCH_ROWS);
  const q = normalizeQuery(query).raw;

  if (!q) {
    return { ok: false, error: "Nothing to search for: give a partial ticker, token name or company." };
  }

  try {
    const res = await attempt(() => calls.searchChain(q, deadline(TIMEOUT_MS)));
    if (!res.ok || !res.data) return unavailableError(`a search for "${q}"`, res.status);

    const items = Array.isArray(res.data?.items) ? res.data.items : [];
    const shaped = [];
    const seen = new Set();
    for (const item of items) {
      const row = searchRow(item);
      // Dedupe on address: the explorer can return the same contract under both
      // a name and a symbol match.
      if (!row || seen.has(row.address)) continue;
      seen.add(row.address);
      shaped.push(row);
    }

    const ranked = rankSearchResults(shaped, q);
    const rows = ranked.slice(0, limit);
    const verifiedCount = ranked.filter((r) => r.issuerVerified).length;
    /*
     * The explorer search is PAGINATED, and a popular fragment fills its first
     * page: "nvidia" comes back with 50 items and a next_page_params naming the
     * 51st. Reporting the length of that page as the number of matches — which
     * is what `totalRows: ranked.length` did — states a total nobody measured,
     * and an answer built on it says "there are 50 tokens matching nvidia" when
     * the honest claim is "at least 50". Every other page-limited reader in this
     * file already checks this field; search was the one that did not.
     */
    const morePages = Boolean(res.data?.next_page_params);

    const table = buildTable({
      id: "token-search",
      title: `${rows.length} token${rows.length === 1 ? "" : "s"} matching "${q}"`,
      columns: [
        col("rank", "#", "right"),
        col("symbol", "Ticker"),
        col("name", "Name"),
        col("verified", "Issuer-verified"),
        col("holdersDisplay", "Holders", "right"),
        col("address", "Contract"),
      ],
      rows,
      // Unknown rather than the page length when there is another page: a total
      // is a measured figure or it is nothing.
      totalRows: morePages ? null : ranked.length,
      truncated: morePages || rows.length < ranked.length,
      note: [
        "\"Issuer-verified\" means the contract is one of the tokenized equities Robinhood's issuer deployed. \"No\" means it is not in that verified set — an ordinary token, or an equity listed after the snapshot — not that it is a fake. Use the safety check on a specific contract for that.",
        morePages
          ? `The explorer had more matches than it returned in one page, so ${ranked.length} is how many were read, not how many exist.`
          : null,
      ]
        .filter(Boolean)
        .join(" "),
    });

    return {
      ok: true,
      kind: "search",
      evidence: {
        query: q,
        // How many came back and were readable. When `moreUpstream` is true this
        // is a FLOOR, not a total — see the note beside it. Zero with no further
        // page is a measured zero, which is why this is never null on a body
        // that actually arrived.
        matches: ranked.length,
        moreUpstream: morePages,
        rowsShown: rows.length,
        limit,
        issuerVerifiedMatches: verifiedCount,
        results: rows,
        note: ranked.length
          ? `The explorer matches on name and symbol, so contracts copying a real ticker appear here beside the genuine one. Only the issuer-verified rows are Robinhood's.${
              morePages
                ? ` It returned one page: ${ranked.length} matches were read and there are more upstream, so say "at least ${ranked.length}" rather than giving a total, and never say these are all of them.`
                : ""
            }`
          : `The explorer returned no token matching "${q}". That is a real answer from the indexer, not a failed lookup.`,
        table,
        asOf: nowIso(),
      },
    };
  } catch (e) {
    return { ok: false, error: `The token search could not be run: ${String(e?.message ?? e).slice(0, 200)}.` };
  }
}

/* ------------------------------ 6. whale moves ------------------------------ */

/** How many of the biggest moves the prose half of the evidence carries. */
const PROSE_WHALES = 5;

/**
 * The largest recent transfers of one token, with what share of supply each one
 * moved — the evidence behind "who is dumping" and "has anyone moved size".
 *
 * The distinction this function exists to protect is between LARGEST and LARGEST
 * RECENT. The indexer returns one page of a token's transfers, newest first, and
 * sorting that page by amount gives the biggest moves IN THAT PAGE — not the
 * biggest the token has ever seen, and not necessarily the biggest today. An
 * answer that says "the largest transfer of NVDA was 4.2M" off this data has
 * overstated it by the whole length of the history it never read. So the sample
 * size, the window it covers and the upstream transfer count all travel with the
 * rows, and the note says outright what the ranking is over.
 *
 * Mints and burns are kept rather than filtered: an address minting supply or
 * sending it to the zero address IS the largest move in the sample when it
 * happens, and dropping those rows would quietly answer a different question.
 * They are labelled instead, so nobody reads a mint as a sale.
 *
 * @param {string} query - ticker, company name or 0x contract address
 * @param {{ limit?: number, calls?: object }} [options]
 * @returns {Promise<{ ok: boolean, kind?: string, evidence?: object, error?: string }>}
 */
export async function whaleMoves(query, options = {}) {
  const calls = withCalls(options);
  const limit = clampRows(options?.limit, 15, MAX_WHALE_ROWS);

  try {
    const target = await resolveTokenTarget(query, calls);
    if (!target.ok) return target;

    const src = tracker();
    const activityPromise = attempt(() => calls.getTokenActivity(target.address, {}, deadline(TIMEOUT_MS)));
    const countersPromise = attempt(() => calls.getTokenCounters(target.address, deadline(ENRICHMENT_TIMEOUT_MS)));
    const meta = await tokenMeta(target.address, calls, src);

    const activityRes = await activityPromise;
    if (!activityRes.ok) src.miss("transfers");
    const countersRes = await countersPromise;
    if (!countersRes.ok) src.miss("transferCount");

    if (!activityRes.ok || !activityRes.data) {
      return unavailableError(`recent transfers of ${target.symbol ?? target.address}`, activityRes.status);
    }

    const items = Array.isArray(activityRes.data?.items) ? activityRes.data.items : [];
    const all = transferRows(items, meta.decimals);
    const symbol = target.symbol ?? meta.symbol ?? null;
    // Parsed the same way the row amounts were, so the division is like for like.
    const supply = amountNumber(meta.rawSupply, meta.decimals);

    const ranked = all
      // A copy: `all` is still the chronological sample the window is measured on.
      .slice()
      // The shared nulls-last comparator. An amount that could not be parsed is
      // unknown, not small, so it sorts to the bottom in either direction rather
      // than being ranked as the tiniest transfer in the sample.
      .sort(compareByField("amount", "desc"))
      .slice(0, limit)
      .map((row, i) => {
        const percent =
          supply !== null && supply > 0 && typeof row.amount === "number" && Number.isFinite(row.amount)
            ? round2((row.amount / supply) * 100)
            : null;
        return {
          ...row,
          rank: i + 1,
          percent,
          // null, never "0%": a move we could not measure against supply is
          // unmeasured, and 0% of supply is a claim about its size.
          percentDisplay: percent === null ? null : `${percent}%`,
          kind: moveKind(row),
        };
      });

    const transferCount = countersRes.data?.transfers_count ?? null;
    const times = knownTimes(all);
    const shownPercents = ranked.map((r) => r.percent).filter((p) => typeof p === "number");
    const movedPercent = shownPercents.length
      ? { percent: round2(shownPercents.reduce((a, p) => a + p, 0)), counted: shownPercents.length, of: ranked.length }
      : { percent: null, counted: 0, of: ranked.length };

    const table = buildTable({
      id: "whale-moves",
      title: `${ranked.length} largest recent transfer${ranked.length === 1 ? "" : "s"}${symbol ? ` of ${symbol}` : ""}`,
      columns: [
        col("rank", "#", "right"),
        col("time", "Time"),
        col("kind", "Type"),
        col("from", "From"),
        col("to", "To"),
        col("amountDisplay", "Amount", "right"),
        col("percentDisplay", "Share of supply", "right"),
      ],
      rows: ranked,
      // The token's whole transfer history, when the counters gave one — so the
      // caption cannot read as "the 15 largest transfers there are". buildTable
      // turns that into `truncated` on its own whenever the total exceeds the
      // rows in hand, which is the usual case; the flag below covers the two it
      // cannot see, a limit shorter than the sample and a further page upstream.
      totalRows: transferCount,
      truncated: ranked.length < all.length || Boolean(activityRes.data?.next_page_params),
      note: [
        `Ranked by size within the ${all.length} most recent transfer${all.length === 1 ? "" : "s"} the indexer returned, newest first — these are the largest in that sample, not the largest in the token's history.`,
        supply === null
          ? "No total supply came back, so every share is blank — unknown, not a move of 0% of supply."
          : "Shares are of total supply.",
        "\"mint\" starts at the zero address and \"burn\" ends there; neither is a sale.",
        decimalsNote(meta),
      ]
        .filter(Boolean)
        .join(" "),
    });

    return {
      ok: true,
      kind: "whales",
      evidence: {
        ...src.gaps(),
        address: target.address,
        symbol,
        company: target.company ?? null,
        name: meta.name,
        totalSupply: meta.rawSupply != null ? `${fmtTokenAmount(meta.rawSupply, meta.decimals)} ${symbol ?? ""}`.trim() : null,
        // null, never 0: an uncounted history is not an empty one.
        transferCount: finiteOrNull(transferCount),
        transferCountDisplay: displayNumber(finiteOrNull(transferCount), "count"),
        // What the ranking is actually over. Every one of these is a bound on
        // the claim the answer is allowed to make.
        sampleSize: all.length,
        rowsShown: ranked.length,
        limit,
        window: times.length >= 2
          ? {
              from: new Date(times[0]).toISOString(),
              to: new Date(times[times.length - 1]).toISOString(),
              spanDisplay: spanWords(times[times.length - 1] - times[0]),
            }
          : null,
        // How much of the supply the listed moves add up to, qualified the same
        // way concentrationOf qualifies a holder band.
        movedPercent,
        movedPercentDisplay:
          movedPercent.percent === null
            ? null
            : `${movedPercent.percent}% of supply across ${movedPercent.counted} of the ${movedPercent.of} listed moves`,
        // The biggest few, for the rows the prose names. Every row the caller
        // asked for is in the table below.
        largest: ranked.slice(0, PROSE_WHALES),
        note: "The largest transfers WITHIN the recent sample the indexer returned. A quiet sample means nothing large moved recently, not that nothing large ever has, and a mint or a burn is not somebody selling.",
        ...(meta.decimalsAssumed ? { decimalsAssumed: true, decimalsNote: decimalsNote(meta) } : {}),
        table,
        asOf: nowIso(),
      },
    };
  } catch (e) {
    return { ok: false, error: `The largest recent transfers could not be read: ${String(e?.message ?? e).slice(0, 200)}.` };
  }
}

/* --------------------- 7. hold time and bundling --------------------- */

/**
 * The shared first leg of the two holder-history lookups: resolve the target,
 * read its holder list once, and run lib/holder-history.js over the top of it.
 *
 * ONE PASS FOR BOTH QUESTIONS. "how long have they held" and "did they arrive
 * together" are the same measurement — each top holder's first acquisition —
 * asked twice, so running them as two lookups would double the indexer cost of a
 * turn that asks both. The pass happens here; holdTimeSummary and detectBundle
 * are pure and read off it.
 *
 * THE HOLDER LIST IS FETCHED THE SAME WAY tokenHolders FETCHES IT, deliberately.
 * Identical arguments mean lib/indexer-cache.js serves the second caller from
 * the first one's answer, so a question that asks for holders and then hold times
 * pays for one holder page.
 *
 * @param {string} query
 * @param {object} options - `calls` (indexer seam), `client`/`resolvePool` /
 *   `resolveV4PoolManager` (the pool sweep's seams — v3 pools and the v4
 *   singleton are two different questions), `now`
 * @returns {Promise<{ ok: false, error: string } | { ok: true, target: object,
 *   meta: object, symbol: string|null, src: object, rows: Array<object>,
 *   analysis: object }>}
 */
async function holderHistoryPass(query, options = {}) {
  const calls = withCalls(options);
  const target = await resolveTokenTarget(query, calls);
  if (!target.ok) return target;

  const src = tracker();
  const holdersPromise = attempt(() => calls.getTokenHolders(target.address, {}, deadline(TIMEOUT_MS)));
  const meta = await tokenMeta(target.address, calls, src);

  const holdersRes = await holdersPromise;
  if (!holdersRes.ok) src.miss("holders");
  if (!holdersRes.ok || !holdersRes.data) {
    return unavailableError(`the holder list for ${target.symbol ?? target.address}`, holdersRes.status);
  }

  const rows = holderRows(Array.isArray(holdersRes.data.items) ? holdersRes.data.items : [], meta.decimals, meta.rawSupply);
  const analysis = await holderFirstAcquisition(target.address, {
    holders: rows,
    // The caller's OVERRIDES, not the merged object: holder-history.js keeps its
    // own defaults and needs endpoints (getTokenTransfers, getAddressTransactions)
    // that this module's seam does not carry.
    calls: options?.calls,
    // The pool sweep is an RPC question, and without a client every pool in the
    // list would wear a holder's label. poolReadClient is the batching client the
    // rest of the pool reads share.
    client: options?.client !== undefined ? options.client : poolReadClient(),
    resolvePool: options?.resolvePool,
    // The v4 singleton is a pool too, and the only way to see it is to ask the chain
    // how the address behaves — see lib/dex-price.js resolveV4PoolManager.
    resolveV4PoolManager: options?.resolveV4PoolManager,
    now: options?.now,
  });
  if (!analysis.ok) {
    return { ok: false, error: analysis.error ?? "The holder history could not be read — unknown, not absent." };
  }
  for (const gap of analysis.unavailable) src.miss(gap);

  return { ok: true, target, meta, symbol: target.symbol ?? meta.symbol ?? null, src, rows, analysis };
}

/** How each non-holder role is named in a table cell and in prose. */
const ROLE_WORDS = Object.freeze({
  [HOLDER_ROLES.POOL]: "Uniswap pool — liquidity, not a holder",
  [HOLDER_ROLES.BURN]: "burn address",
  [HOLDER_ROLES.CONTRACT]: "the token contract itself",
  [HOLDER_ROLES.HOLDER]: "holder",
});

/**
 * One analysed holder as a printable row.
 *
 * THE TWO CELLS THAT COULD LIE ARE WRITTEN OUT IN WORDS. A blank hold-time cell
 * reads as nothing held; a bare "1.2 days" against a truncated history reads as a
 * measurement. So an unread row says "unknown — history not read" in the cell
 * itself, and a bounded one carries the "at least" that lib/holder-history.js
 * baked into `holdDisplay`. Neither qualifier can be lost between here and the
 * screen, because neither is stored anywhere but in the string.
 */
function holderHistoryRow(h) {
  return {
    rank: h.rank,
    address: h.address,
    role: ROLE_WORDS[h.role] ?? h.role,
    percentDisplay: h.percentDisplay,
    holdDisplay: h.status === "measured" ? (h.holdDisplay ?? "block known, date unknown") : "unknown — history not read",
    firstBlock: h.firstBlock === null ? "unknown" : h.firstBlock.toLocaleString("en-US"),
  };
}

/** The excluded rows, each named as what it actually is. Never dropped. */
function excludedRows(analysis) {
  return analysis.holders
    .filter((h) => h.role !== HOLDER_ROLES.HOLDER)
    .map((h) => ({
      address: h.address,
      role: h.role,
      roleLabel: ROLE_WORDS[h.role] ?? h.role,
      reason: h.roleReason,
      percentDisplay: h.percentDisplay,
      holdDisplay: h.status === "measured" ? h.holdDisplay : null,
    }));
}

/** The shared caption for both tables: what was probed, and what a blank means. */
function historyNote(analysis, meta) {
  return [
    `First acquisitions were probed for the top ${analysis.probed} address${analysis.probed === 1 ? "" : "es"} by balance; ${analysis.measured} could be read and ${analysis.unknown} could not.`,
    "\"at least N days\" is a LOWER BOUND — that address's transfer history ran past the one page read, so it has held longer than the figure.",
    "\"unknown — history not read\" is an unread history, never a fresh buy.",
    analysis.poolStatus === "unread"
      ? "The token's pool could not be identified on this lookup, so a row labelled a holder may in fact be the pool."
      : null,
    decimalsNote(meta),
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * HOW LONG THE TOP HOLDERS HAVE ACTUALLY HELD — the distribution, and every
 * reason it speaks for fewer addresses than the list it came from.
 *
 * The figures are lib/holder-history.js's; what this adds is the evidence shape
 * the model reads, and the one rule that matters in the handover: a lower bound
 * has to reach the reader as "at least N days". It does, because it is never a
 * number here — `medianDisplay`, `rangeDisplay` and every row's `holdDisplay` are
 * strings the qualifier is already inside, and the raw days sit beside them under
 * separate names so no answer can quote one for the other by accident.
 *
 * WHAT IT CANNOT ESTABLISH, said in the evidence rather than left to the model:
 * a pool, a burn address and the token contract are not holders and are excluded
 * from the statistics while staying visible in the table; an address that could
 * not be read has no hold time rather than a short one; and the whole thing
 * covers the top ten by balance, not the token's holder base.
 *
 * @param {string} query - ticker, company name or 0x contract address
 * @param {{ calls?: object, client?: object, resolvePool?: Function,
 *   resolveV4PoolManager?: Function, now?: number }} [options]
 * @returns {Promise<{ ok: boolean, kind?: string, evidence?: object, error?: string }>}
 */
export async function holderHoldTime(query, options = {}) {
  try {
    const pass = await holderHistoryPass(query, options);
    if (!pass.ok) return pass;
    const { target, meta, symbol, src, analysis } = pass;
    const summary = holdTimeSummary(analysis);
    /*
     * ANSWERED HERE OR NOT AT ALL. A threshold question — "how many have held
     * more than three days" — cannot be read off a median and a range, and when
     * it was left to be inferred the answer quoted the RANGE as though it were a
     * count. The bounds each row carries are only visible at this level, and the
     * asymmetry between them is what makes the count correct: see
     * holdersOverThreshold.
     */
    const measuredRows = analysis.holders.filter(
      (h) => h.role === "holder" && h.status === "measured" && typeof h.holdDays === "number",
    );
    const threshold =
      options?.thresholdDays === undefined || options?.thresholdDays === null
        ? null
        : holdersOverThreshold(measuredRows, summary.unknown, options.thresholdDays);

    const rows = analysis.holders.map(holderHistoryRow);
    const table = buildTable({
      id: "holder-hold-time",
      title: `First acquisition for the top ${rows.length} address${rows.length === 1 ? "" : "es"}${symbol ? ` of ${symbol}` : ""}`,
      columns: [
        col("rank", "#", "right"),
        col("address", "Address"),
        col("role", "What it is"),
        col("percentDisplay", "Share of supply", "right"),
        col("holdDisplay", "Held for", "right"),
        col("firstBlock", "First seen at block", "right"),
      ],
      rows,
      // Always a prefix: the probe is bounded at ten addresses by design, and a
      // holder base of thousands is never what this table covers.
      truncated: true,
      note: historyNote(analysis, meta),
    });

    return {
      ok: true,
      kind: "holdTime",
      evidence: {
        ...src.gaps(),
        address: target.address,
        symbol,
        company: target.company ?? null,
        name: meta.name,
        holdersProbed: analysis.probed,
        /*
         * ONE SCOPE PER NAME, AND THE AMBIGUOUS ONES ARE GONE.
         *
         * This block used to ship FIVE counts whose names did not say what they
         * counted, two of which had a different denominator from the other three:
         * `holdersMeasured`/`holdersUnknown` were over EVERY probed row including
         * the pool, the burn address and the token contract, while
         * `counted`/`exact`/`unknown` were over real holders only. `exact` was the
         * worst — at this level it reads as a number of holders when it is a
         * quality grade on a read.
         *
         * Measured, that is exactly what went wrong: asked how many holders had
         * held more than three days, the answer took `exact` (3) against
         * `holdersProbed` (10) and produced the remainder by subtraction — "3 of
         * the 10 top holders ... and of those, 2 ... the other 7", which is three
         * scopes in one sentence and adds up to nothing. Adding a correct
         * denominator beside the wrong ones would have left the bad draw on the
         * table, so the two whole-list counts are deleted and the rest are renamed
         * to say what they are.
         */
        countedHolders: summary.holders,
        holdersWithReadableAge: summary.measured,
        agePinnedExactly: summary.exact,
        ageFloorOnly: summary.lowerBounds,
        ageUnreadable: summary.unknown,
        unknownRows: summary.unknownRows,
        // The threshold count, when one was asked for. Placed AHEAD of the
        // statistics because it is the answer when it exists, and because
        // packToolResults truncates from the end.
        ...(threshold ? { overThreshold: threshold } : {}),
        // THE QUALIFIED STRINGS ARE THE FIGURES. Quote these, not the raw days.
        medianDisplay: summary.medianDisplay,
        rangeDisplay: summary.rangeDisplay,
        isLowerBound: summary.isLowerBound,
        // The raw numbers, under names that cannot be mistaken for the quotable
        // form — they exist for a caller that wants to compare, not to print.
        medianDaysRaw: summary.medianDays,
        minDaysRaw: summary.minDays,
        maxDaysRaw: summary.maxDays,
        // The addresses that are in the list but not in the figures, each named.
        excluded: excludedRows(analysis),
        excludedCount: summary.excludedCount,
        poolStatus: summary.poolStatus,
        poolCaveat: summary.poolCaveat,
        // The v4 singleton's own verdict. Separate from poolStatus because they are
        // separate questions: a token whose market is on v4 has its liquidity at one
        // address that would otherwise sit in this table as its largest holder.
        v4Status: summary.v4Status,
        v4Caveat: summary.v4Caveat,
        reading: summary.reading,
        limits: { holdersProbed: MAX_HOLDERS_PROBED },
        disclaimer:
          "Hold time here is the age of an address's OLDEST readable transfer of this token, over the top holders by balance only. It says when an address first received the token, not what it paid, not whether it has sold since, and nothing at all about the thousands of smaller addresses that were never probed.",
        ...(meta.decimalsAssumed ? { decimalsAssumed: true, decimalsNote: decimalsNote(meta) } : {}),
        table,
        asOf: nowIso(),
      },
    };
  } catch (e) {
    return { ok: false, error: `The holder hold times could not be read: ${String(e?.message ?? e).slice(0, 200)}.` };
  }
}

/**
 * WHETHER THE TOP HOLDERS ARRIVED TOGETHER — a cluster of first acquisitions
 * inside one narrow block window, reported as an observation and nothing more.
 *
 * THE SENTENCE THIS LOOKUP EXISTS TO REFUSE is "this token was bundled by
 * insiders". Addresses acquiring inside one window is evidence of COORDINATION;
 * an airdrop, a contract migration, a team allocation and a bought sniper bundle
 * all leave exactly that shape and nothing measured here separates them. So the
 * evidence carries the observation, the denominator it is out of, the addresses
 * behind it, and a disclaimer naming the alternatives — and no score, no
 * likelihood and no motive.
 *
 * FUNDING IS OPT-IN AND ONLY WHEN THERE IS SOMETHING TO ATTRIBUTE. A shared
 * funder is the strongest plumbing link available from an indexer, and it costs
 * one more call per cluster address, so it runs only once a cluster has been
 * found. When the request is short of time it is SKIPPED AND SAID SO — a silent
 * skip would read as "no common funder", which is a finding we did not make.
 *
 * @param {string} query - ticker, company name or 0x contract address
 * @param {{ calls?: object, client?: object, resolvePool?: Function,
 *   resolveV4PoolManager?: Function, now?: number,
 *   funding?: boolean }} [options]
 * @returns {Promise<{ ok: boolean, kind?: string, evidence?: object, error?: string }>}
 */
export async function bundleCheck(query, options = {}) {
  try {
    const pass = await holderHistoryPass(query, options);
    if (!pass.ok) return pass;
    const { target, meta, symbol, src, analysis } = pass;
    const bundle = detectBundle(analysis);
    // Opt-out rather than opt-in at this layer: the caller reached for a bundle
    // check, and the attribution leg is the answer's strongest evidence when a
    // cluster exists. It still costs nothing when there is no cluster.
    const funding =
      options?.funding === false || !bundle.found
        ? null
        : await fundingSources(bundle.cluster, { calls: options?.calls });

    const rows = analysis.holders.map(holderHistoryRow);
    const table = buildTable({
      id: "bundle-check",
      title: `First acquisition for the top ${rows.length} address${rows.length === 1 ? "" : "es"}${symbol ? ` of ${symbol}` : ""}`,
      columns: [
        col("rank", "#", "right"),
        col("address", "Address"),
        col("role", "What it is"),
        col("percentDisplay", "Share of supply", "right"),
        col("firstBlock", "First seen at block", "right"),
        col("holdDisplay", "Held for", "right"),
      ],
      rows,
      truncated: true,
      note: [
        historyNote(analysis, meta),
        `Only an EXACTLY pinned first acquisition can be clustered on: ${bundle.eligible} of the ${bundle.holders} holding address${bundle.holders === 1 ? "" : "es"} qualified, and a truncated history is evidence neither way.`,
      ].join(" "),
    });

    return {
      ok: true,
      kind: "bundle",
      evidence: {
        ...src.gaps(),
        address: target.address,
        symbol,
        company: target.company ?? null,
        name: meta.name,
        // The finding, or the honest absence of one.
        found: bundle.found,
        clusterKind: bundle.kind,
        basis: bundle.basis ?? null,
        cluster: bundle.cluster,
        clusterSize: bundle.cluster.length,
        blockSpanDisplay: bundle.blockSpanDisplay ?? null,
        timeSpanDisplay: bundle.timeSpanDisplay ?? null,
        firstBlock: bundle.firstBlock ?? null,
        lastBlock: bundle.lastBlock ?? null,
        supplyDisplay: bundle.supply?.display ?? null,
        supply: bundle.supply ?? null,
        covers: bundle.covers ?? null,
        // The denominator, because "4 of 7 eligible" and "4 of 10" read very
        // differently and the reader is owed which one this is.
        eligible: bundle.eligible,
        holdersConsidered: bundle.holders,
        ineligible: bundle.ineligible,
        spread: bundle.spread ?? null,
        tightest: bundle.tightest ?? null,
        limits: { ...bundle.limits, holdersProbed: MAX_HOLDERS_PROBED },
        excluded: excludedRows(analysis),
        poolStatus: analysis.poolStatus,
        // The same caveat the hold-time answer carries, and it binds harder here:
        // with the pool unidentified, an unlabelled row could be the pool, and a
        // pool's first liquidity event sitting inside a "cluster" would be a
        // finding about a contract rather than about anyone's addresses.
        // holdTimeSummary is pure, so reading one field off it costs nothing.
        poolCaveat: holdTimeSummary(analysis).poolCaveat,
        reading: bundle.reading,
        funding: funding
          ? {
              ran: funding.ran,
              reason: funding.reason,
              commonFunder: funding.commonFunder,
              covered: funding.covered,
              of: funding.of,
              established: funding.established,
              funders: funding.funders,
              reading: funding.reading,
            }
          : null,
        disclaimer:
          "Co-acquisition inside one window is an OBSERVATION about timing, never proof of intent, and this is not a verdict on the token. An airdrop, a contract migration, a team allocation and a bought bundle all produce the same shape from this angle. Only the top holders by balance were probed, so a cluster outside that set would not appear here, and an absence of clustering among ten addresses is not a clearing of the token.",
        ...(meta.decimalsAssumed ? { decimalsAssumed: true, decimalsNote: decimalsNote(meta) } : {}),
        table,
        asOf: nowIso(),
      },
    };
  } catch (e) {
    return { ok: false, error: `The bundle check could not be run: ${String(e?.message ?? e).slice(0, 200)}.` };
  }
}

/* --------------------- relations that span two or more tokens --------------------- */

/**
 * WHY THESE TWO LOOKUPS EXIST, AND WHAT THEY ARE FIXING.
 *
 * A real user on chainmind.fun asked "what wallet in this coin 0x31ba…c6cc also
 * bought this: 0xa15c…7b32". There was no lookup for a relation between two tokens,
 * so the model ran the single-token one on the FIRST address, printed its holders and
 * never mentioned the second token. It answered an easier question and said nothing
 * about the swap — which is worse than "I cannot do that", because a reader cannot
 * tell "the answer is about A" from "I forgot about B".
 *
 * lib/cross-token.js does the measuring. What these two add is the handover, and the
 * handover is where a qualifier gets dropped: the strategy that ran, the
 * denominators, and the ONE thing that must survive into prose — a count that was
 * bounded has to reach the reader as "at least N wallets" and never as "N wallets".
 * It does, because `countDisplay` is a STRING with the qualifier already inside it,
 * the way holder_hold_time's `medianDisplay` carries "at least N days", and the raw
 * `count` sits beside it under a name no answer would print.
 */

/**
 * EVERY NAMED TOKEN RESOLVED, OR NONE OF THEM.
 *
 * A ticker, a company name and a 0x address all reach the tool, and each has to
 * become a contract before an overlap means anything. The all-or-nothing part is the
 * point: quietly intersecting the two tokens that DID resolve, out of three named,
 * would be the same silent narrowing this whole lookup exists to fix — the reader
 * would get a real answer to a question they did not ask. So one unresolvable entry
 * fails the call and names itself, and the model can either fix it or call again with
 * the tokens that work and SAY it dropped one.
 *
 * @returns {Promise<{ ok: true, targets: object[] } | { ok: false, error: string }>}
 */
async function resolveAllTokens(queries, calls) {
  const list = Array.isArray(queries) ? queries : [];
  const resolved = await Promise.all(list.map((q) => resolveTokenTarget(q, calls)));

  const failed = [];
  const targets = [];
  for (const [i, res] of resolved.entries()) {
    if (!res.ok) {
      failed.push({ asked: String(list[i] ?? ""), error: res.error });
      continue;
    }
    targets.push({ ...res, asked: String(list[i] ?? "") });
  }
  if (failed.length) {
    return {
      ok: false,
      error: `${failed.map((f) => `"${f.asked}" could not be resolved to a contract: ${f.error}`).join(" ")} An overlap is a relation, so it cannot be reported for only the tokens that resolved — that would answer a narrower question than the one asked. Either correct that target and call again, or ask about the tokens that do resolve and say which one you had to leave out.`,
    };
  }

  // Two queries can name ONE contract ("PIPECAT" and its address), and an
  // "overlap" of a token with itself is every holder of it. Said with both spellings
  // in it, because "the same contract twice" is unhelpful when the two strings differ.
  const byAddress = new Map();
  for (const t of targets) {
    const clash = byAddress.get(t.address);
    if (clash) {
      return {
        ok: false,
        error: `"${clash.asked}" and "${t.asked}" are the same contract (${t.address}), and every holder of a token overlaps with itself. Name two DIFFERENT tokens, or use token_holders for the holders of that one.`,
      };
    }
    byAddress.set(t.address, t);
  }
  return { ok: true, targets };
}

/** A token as prose names it here: its resolved ticker, else the contract, shortened. */
function overlapLabel(entry) {
  return entry?.symbol || shortHex(entry?.address);
}

/**
 * One overlapping wallet, reduced to the fields an ANSWER quotes.
 *
 * lib/cross-token.js hands back everything about a position — raw base units, a
 * Number amount, the assumed-decimals flag, which read it came from — because a
 * caller might compare on any of it. An answer names the wallet and its two figures,
 * and the rest is 60 characters per token per row of prompt that pushes the bound off
 * the end. `percentUnknownReason` is kept when there IS one, because "the share is
 * unknown" needs its reason and that is the one field here nothing else carries.
 */
function overlapWalletRow(wallet) {
  return {
    address: wallet.address,
    ...(wallet.role && wallet.role !== HOLDER_ROLES.HOLDER
      ? {
          role: wallet.role,
          roleReason: wallet.roleReason,
          // WHICH pool, when it is one. "This token's own pool" and "the singleton that
          // holds every pool on the chain" are different things to tell a reader, and
          // the second is also why the same address turns up against unrelated tokens.
          ...(wallet.poolVersion ? { poolVersion: wallet.poolVersion } : {}),
        }
      : {}),
    largestShare: wallet.largestShare?.display ?? null,
    positions: wallet.positions.map((p) => ({
      token: p.token,
      symbol: sanitizeLabel(p.symbol, 16),
      amountDisplay: p.amountDisplay,
      percentDisplay: p.percentDisplay,
      ...(p.percentUnknownReason ? { percentUnknownReason: p.percentUnknownReason } : {}),
      ...(p.decimalsAssumed ? { decimalsAssumed: true } : {}),
    })),
  };
}

/**
 * Join note fragments into sentences, ending each one.
 *
 * A plain `.join(" ")` shipped "…and are not counted as not holding A share shown as
 * unknown is…" — two claims run together with no stop between them, because the
 * fragments come from different modules and only some of them punctuate themselves.
 * A caption a reader cannot parse is a caption they skip, and these are the sentences
 * carrying the bound.
 */
function sentences(parts) {
  return parts
    .filter((p) => typeof p === "string" && p.trim())
    .map((p) => {
      const s = p.trim();
      return /[.!?]$/.test(s) ? s : `${s}.`;
    })
    .join(" ");
}

/**
 * A share of supply as a table cell: the percentage, "<0.01%" for a position too
 * small to round to one, or "unknown".
 *
 * THE THREE CASES ARE THREE DIFFERENT FACTS AND A BARE "0%" COLLAPSES TWO OF THEM. A
 * wallet holding 9.05e-12 of a 9.5e8 supply really does round to zero at two decimal
 * places, and printed as "0%" beside a real balance it reads as a position that is not
 * there — the coerce-to-zero mistake in rounding form. So a nonzero balance whose share
 * rounds away says "<0.01%", a share that could not be computed says "unknown", and
 * only a genuinely empty position could ever print "0%".
 */
function shareCell(position) {
  if (!position || position.percent === null || position.percent === undefined) return "unknown";
  if (position.percent === 0 && position.balance && position.balance !== "0") return "<0.01%";
  return position.percentDisplay ?? "unknown";
}

/** "PIPECAT and MERRYMEN", "A, B and C" — the pair or the list, said as a reader would. */
function joinLabels(labels) {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * WHICH WALLETS HOLD ALL OF THESE TOKENS — the lookup the measured session needed.
 *
 * The figures are lib/cross-token.js holderOverlap's, and so are the honesty
 * decisions: which strategy ran and why, whether every list was read in full, which
 * candidates could not be checked, and whether the count is exact or a floor. This
 * puts them in the evidence shape the model reads, and adds the table the reader
 * sees — one row per wallet, one pair of columns per token, so a wallet's position in
 * EVERY token asked about is on the same line. A table with only the first token's
 * balances in it would be the original bug drawn as a grid.
 *
 * WHAT IT CANNOT ESTABLISH, stated in the evidence rather than left to the model:
 * co-holding is not buying (`measured` is "current_co_holding" and the disclaimer
 * says why a balance is not a purchase), a pool or a burn sink holding every token is
 * not an interested wallet, and a bounded read is a floor.
 *
 * @param {string[]} queries - 2 to 4 tickers, company names or 0x contract addresses
 * @param {{ calls?: object, client?: object, resolvePool?: Function,
 *   resolveV4PoolManager?: Function, limit?: number,
 *   acquisitions?: boolean, now?: number }} [options]
 * @returns {Promise<{ ok: boolean, kind?: string, evidence?: object, error?: string }>}
 */
export async function holderOverlapReport(queries, options = {}) {
  try {
    const calls = withCalls(options);
    const resolved = await resolveAllTokens(queries, calls);
    if (!resolved.ok) return resolved;
    const { targets } = resolved;

    const res = await holderOverlap(
      targets.map((t) => t.address),
      {
        // The caller's OVERRIDES, not the merged object: cross-token.js keeps its own
        // defaults and needs /addresses/{a}/token-balances, which this module's seam
        // does not carry.
        calls: options?.calls,
        client: options?.client !== undefined ? options.client : poolReadClient(),
        resolvePool: options?.resolvePool,
        resolveV4PoolManager: options?.resolveV4PoolManager,
        limit: options?.limit,
        acquisitions: options?.acquisitions === true,
        now: options?.now,
      },
    );
    if (!res.ok) return res;

    // The resolver's ticker where it had one, the token body's otherwise, and
    // sanitized either way: a symbol is attacker-controlled text on its way into a
    // prompt and a table, so it goes through the same filter every other label here
    // does. See lib/ask-evidence.js sanitizeLabel.
    const tokens = res.tokens.map((t, i) => {
      const asked = targets[i] ?? null;
      return {
        ...t,
        asked: asked?.asked ?? null,
        symbol: asked?.symbol ?? sanitizeLabel(t.symbol, 16),
        name: sanitizeLabel(t.name, 72),
        company: asked?.company ?? null,
        issuerVerified: Boolean(asked?.snapshotted),
      };
    });
    const labels = tokens.map(overlapLabel);
    const pair = joinLabels(labels);

    // One pair of columns per token, so every row states the wallet's position in
    // each one. Built from `tokens` rather than from a row, because a wallet whose
    // share of a token could not be computed still needs the column to exist.
    const columns = [col("address", "Wallet")];
    for (const [i, label] of labels.entries()) {
      columns.push(col(`t${i}Amount`, `${label} held`, "right"));
      columns.push(col(`t${i}Share`, `% of ${label}`, "right"));
    }
    const rows = res.wallets.slice(0, MAX_OVERLAP_ROWS).map((w) => {
      const row = { address: w.address };
      for (const [i, token] of tokens.entries()) {
        const p = w.positions.find((pos) => pos.token === token.address) ?? null;
        row[`t${i}Amount`] = p?.amountDisplay ?? "unknown";
        // Never a bare "0%" beside a real balance: a wallet shown as holding none of
        // a token it demonstrably holds is the sharpest false claim on this table.
        row[`t${i}Share`] = shareCell(p);
      }
      return row;
    });

    return {
      ok: true,
      kind: "overlap",
      evidence: {
        // What the question was about, in the order it was asked.
        tokens,
        tokenCount: tokens.length,
        pair,
        measured: res.measured,
        // WHICH OF THE TWO STRATEGIES RAN, and why — the difference between "I read
        // both lists in full" and "I read the small one and checked 60 of its holders".
        strategy: res.strategy,
        strategyReason: res.strategyReason,
        base: res.base,
        // THE ONE FIELD THAT SAYS WHETHER THIS IS THE COMPLETE SET.
        exact: res.exact,
        isLowerBound: res.isLowerBound,
        // THE QUOTABLE FIGURE IS THE STRING: "14 wallets", or "at least 9 wallets"
        // with the qualifier already inside it. `count` is for comparison, not print.
        countDisplay: res.countDisplay,
        count: res.count,
        // A SHORT SLICE, and the table below is the list. The rows an answer names
        // are the first few by position; repeating all forty here would double them
        // in the prompt and the half that gets truncated is the one carrying the
        // bound. `totalWallets` and `walletsTruncated` say this is a prefix.
        wallets: res.wallets.slice(0, PROSE_OVERLAP_WALLETS).map(overlapWalletRow),
        walletsShown: Math.min(res.wallets.length, PROSE_OVERLAP_WALLETS),
        walletsTruncated: res.walletsTruncated || res.wallets.length > PROSE_OVERLAP_WALLETS,
        totalWallets: res.totalWallets,
        excluded: res.excluded.map(overlapWalletRow),
        excludedCount: res.excludedCount,
        excludedNote: res.excludedNote,
        candidates: res.candidates,
        poolStatus: res.poolStatus,
        poolCaveat: res.poolCaveat,
        // Separate verdict, separate caveat: the v4 PoolManager holds every token whose
        // market is on v4, so an unresolved check leaves exactly one row that could be
        // pooled liquidity presented as a wallet holding both tokens.
        v4Status: res.v4Status,
        v4Caveat: res.v4Caveat,
        acquisitions: res.acquisitions,
        limits: res.limits,
        reading: res.reading,
        disclaimer: res.disclaimer,
        ...(res.unavailable?.length ? { unavailable: [...res.unavailable] } : {}),
        table: buildTable({
          id: "holder-overlap",
          // The bound is in the TITLE, because a title is the one line every reader
          // reads. "14 wallets hold X and Y" and "at least 9 wallets hold X and Y"
          // are different claims and the table must not be able to make the wrong one.
          title: `${res.countDisplay} hold ${pair}`,
          columns,
          rows,
          // The full figure, so buildTable derives the truncation rather than being
          // told it — a table showing 40 of 63 must not be able to claim it is all 63.
          totalRows: res.totalWallets,
          truncated: res.walletsTruncated || res.isLowerBound,
          note: sentences([
            res.exact
              ? "Every holder list was read in full, so this is the complete set of wallets holding all of these tokens"
              : `This is a LOWER BOUND: ${res.countDisplay} hold all of these tokens, and there may be more`,
            res.exact ? null : res.candidates?.reason ?? tokens.filter((t) => !t.listComplete).map((t) => t.listReason).filter(Boolean).join("; "),
            "A share shown as \"unknown\" could not be computed and one shown as \"<0.01%\" is a real position too small to round to two decimals — neither is a zero",
            "These are CURRENT balances in every token named — co-holding, not shared buying",
            res.excludedNote,
            res.poolCaveat,
          ]),
        }),
        asOf: res.asOf,
      },
    };
  } catch (e) {
    return {
      ok: false,
      error: `The holder overlap could not be read: ${String(e?.message ?? e).slice(0, 200)}. Say the overlap could not be measured rather than reporting it as none.`,
    };
  }
}

/**
 * WHAT ELSE THIS TOKEN'S TOP HOLDERS HOLD — "what are they also in".
 *
 * THE DENOMINATOR IS THE ANSWER'S BACKBONE, and it travels on every row rather than
 * in a caption: `sharedDisplay` says "2 of the 3 probed holders" so no count can be
 * quoted without the sample it is out of, and `coverage` says how big that sample was
 * against the token's whole holder base. "40% of holders also hold X" is the sentence
 * this refuses to support when the 40% is four wallets out of ten probed and the
 * token has 52,214 holders.
 *
 * @param {string} query - ticker, company name or 0x contract address
 * @param {{ calls?: object, client?: object, resolvePool?: Function,
 *   resolveV4PoolManager?: Function, limit?: number }} [options]
 * @returns {Promise<{ ok: boolean, kind?: string, evidence?: object, error?: string }>}
 */
export async function coHoldingsReport(query, options = {}) {
  try {
    const calls = withCalls(options);
    const target = await resolveTokenTarget(query, calls);
    if (!target.ok) return target;

    const res = await coHoldings(target.address, {
      calls: options?.calls,
      client: options?.client !== undefined ? options.client : poolReadClient(),
      resolvePool: options?.resolvePool,
      resolveV4PoolManager: options?.resolveV4PoolManager,
      limit: options?.limit,
    });
    if (!res.ok) return res;

    const symbol = target.symbol ?? sanitizeLabel(res.symbol, 16);
    // Measured: five PIPECAT holders between them held 412 other tokens. The tally is
    // already ranked by how many holders share each one, so the cap keeps the rows
    // that carry the answer and the count below says what they are out of.
    const rows = res.tokens.slice(0, MAX_COHOLDING_TOKEN_ROWS).map((t) => ({
      symbol: sanitizeLabel(t.symbol, 16) ?? shortHex(t.address),
      name: sanitizeLabel(t.name, 48),
      address: t.address,
      // The count and its denominator in ONE cell, so a row cannot be read out of
      // the table without the sample it speaks for.
      shared: t.sharedDisplay,
      total: t.totalAmount === null ? "unknown" : displayNumber(t.totalAmount, "count"),
      counted: t.totalAmountCounted === t.totalAmountOf ? "all" : `${t.totalAmountCounted} of ${t.totalAmountOf}`,
    }));

    return {
      ok: true,
      kind: "coHoldings",
      evidence: {
        address: res.token,
        symbol,
        company: target.company ?? null,
        name: sanitizeLabel(res.name, 72),
        measured: res.measured,
        holderCount: res.holderCount,
        holderCountDisplay: res.holderCountDisplay,
        // How many holders were actually probed, out of how many were read, out of
        // how many the token has. Every count above is out of `coverage.probed`.
        coverage: res.coverage,
        probedHolders: res.probedHolders.map((h) => ({
          address: h.address,
          amountDisplay: h.position?.amountDisplay ?? null,
          percentDisplay: h.position?.percentDisplay ?? null,
        })),
        // A short slice for prose; the table is the list. Each row's `wallets` array
        // is dropped here — which holder holds which other token is in the table's
        // "Held by" count, and forty rows of address arrays is the prompt spend that
        // would push the coverage and the disclaimer off the end.
        tokens: res.tokens.slice(0, PROSE_COHOLDING_TOKENS).map((t) => ({
          address: t.address,
          symbol: sanitizeLabel(t.symbol, 16),
          name: sanitizeLabel(t.name, 48),
          holders: t.holders,
          ofProbed: t.ofProbed,
          sharedDisplay: t.sharedDisplay,
          totalAmount: t.totalAmount,
          totalAmountCounted: t.totalAmountCounted,
          totalAmountOf: t.totalAmountOf,
        })),
        // How many other tokens turned up in total, so the slice above and the table
        // below are both readable as prefixes of it.
        tokenCount: res.tokenCount,
        tokensShown: Math.min(res.tokenCount, PROSE_COHOLDING_TOKENS),
        excluded: res.excluded.map((x) => ({
          address: x.address,
          role: x.role,
          roleReason: x.roleReason,
          // v3 or v4, when it is a pool: the v4 singleton's "other holdings" are every
          // token trading on v4, which is a sharper reason to keep it out of a tally of
          // what a token's holders also hold than any per-token pool has.
          ...(x.poolVersion ? { poolVersion: x.poolVersion } : {}),
          percentDisplay: x.position?.percentDisplay ?? null,
        })),
        excludedCount: res.excludedCount,
        excludedNote: res.excludedNote,
        reading: res.reading,
        disclaimer: res.disclaimer,
        ...(res.unavailable?.length ? { unavailable: [...res.unavailable] } : {}),
        table: buildTable({
          id: "co-holdings",
          title: `What ${res.coverage.probed} of ${symbol ?? shortHex(res.token)}'s top holders also hold`,
          columns: [
            col("symbol", "Token"),
            col("name", "Name"),
            col("address", "Contract"),
            col("shared", "Held by", "right"),
            col("total", "Total held", "right"),
            col("counted", "Amounts read", "right"),
          ],
          rows,
          totalRows: res.tokenCount,
          // Always a prefix of the token's holder base: the probe is bounded by
          // design, so this is never a fact about every holder — true even when every
          // row of the tally fits, which is why it is asserted rather than derived.
          truncated: true,
          note: sentences([
            `Every count is out of the ${res.coverage.probed} holder${res.coverage.probed === 1 ? "" : "s"} actually probed — the top ones by balance${res.holderCountDisplay ? `, out of ${res.holderCountDisplay} the token has` : " (its holder count could not be read)"}. This is not a pattern across the token`,
            res.coverage.probeFailed
              ? `${res.coverage.probeFailed} holder${res.coverage.probeFailed === 1 ? "" : "s"} could not be read at all and ${res.coverage.probeFailed === 1 ? "is" : "are"} missing from every count — unknown holdings, not empty ones, so each figure is a floor`
              : null,
            "\"Total held\" adds only the amounts that could be read; \"Amounts read\" says how many that was",
            res.excludedNote,
          ]),
        }),
        asOf: res.asOf,
      },
    };
  } catch (e) {
    return {
      ok: false,
      error: `The holders' other holdings could not be read: ${String(e?.message ?? e).slice(0, 200)}. Say they could not be read rather than reporting none.`,
    };
  }
}

/** "mint", "burn" or "transfer" — read off the zero address, never off size. */
function moveKind(row) {
  if (lowerAddress(row?.from) === ZERO_ADDRESS) return "mint";
  if (lowerAddress(row?.to) === ZERO_ADDRESS) return "burn";
  return "transfer";
}

/**
 * One explorer search item -> a flat printable row, or null when it is not a
 * token we can identify. Names and symbols are attacker-controlled, so both go
 * through sanitizeLabel before they can reach a table or a prompt.
 */
function searchRow(item) {
  if (!item || typeof item !== "object") return null;
  const address = lowerAddress(item.address_hash ?? item.address);
  if (!address) return null;
  const rawName = typeof item.name === "string" ? item.name : null;
  const type = String(item.type ?? "").toLowerCase();
  // The search returns addresses, blocks and transactions too; only tokens have
  // a name and a token type, and only tokens belong in this table.
  if (!rawName && !item.symbol) return null;
  if (type && type !== "token" && type !== "metadata_tag") return null;

  const holders = finiteOrNull(item.holders_count ?? item.holders);
  const issuerVerified = isCanonicalStockAddress(address);
  return {
    address,
    symbol: sanitizeLabel(item.symbol, 16),
    name: sanitizeLabel(rawName, 48),
    company: sanitizeLabel(stripStockSuffix(rawName), 48),
    tokenType: item.token_type ?? item.type ?? null,
    issuerVerified,
    // The printed form of the same boolean, so the table never has to decide
    // what `false` looks like.
    verified: issuerVerified ? "Yes" : "No",
    namedLikeEquity: isStockTokenName(rawName),
    holders,
    holdersDisplay: displayNumber(holders, "count"),
  };
}
