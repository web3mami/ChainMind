import { formatUnits } from "viem";
import {
  ENRICHMENT_TIMEOUT_MS,
  TIMEOUT_MS,
  deadline,
  getAddress,
  getAddressCounters,
  getAddressTokenBalances,
  getAddressTransactions,
  getTokenTransfers,
  getTransaction,
} from "./blockscout.js";
import { fmtTokenAmount, sanitizeLabel, weiToEth } from "./ask-evidence.js";
import {
  isCanonicalStockAddress,
  listStockTokens,
  resolveSymbol,
  snapshotByAddress,
  snapshotMatch,
} from "./stock-tokens.js";
import { resolveTokenTarget } from "./token-evidence.js";
import { displayNumber, finiteOrNull } from "./format-number.js";
import { compareByField } from "./market-evidence.js";
import { readPageWithRetry } from "./page-retry.js";
import { noteBudgetSkip, outOfTimeFor } from "./request-budget.js";
import { buildTable, col } from "./table-shape.js";
import { wethAddress } from "./dex-price.js";
import {
  HOP,
  HOP_READING,
  SHAPE_READING,
  classifyShape,
  harvestTags,
  labelReading,
  outboundConcentration,
  reconcileTrace,
  tallyFlows,
} from "./flow-evidence.js";
// This module had its own local ZERO_ADDRESS and knew nothing about 0x…dEaD, so a
// burn to the dead address came back as an ordinary counterparty — one of two burn
// conventions silently missing. Both live in lib/holder-history.js; importing them
// is what stops a third copy drifting from the other two.
import { DEAD_ADDRESS, HOLDER_ROLES, classifyRole, tokenPoolAddresses } from "./holder-history.js";
import {
  NOT_PROVABLE,
  UNPRICED,
  buildLedger,
  chainOrder,
  formatEth,
  // viem's formatUnits is already imported above and returns a string built through
  // a different path; this one is the exact BigInt printer the ledger uses, and the
  // two must not be confused where money is being printed.
  formatUnits as formatUnitsExact,
  provability,
  rawAmount,
  readTrade,
} from "./pnl-ledger.js";

/**
 * THE WALLET-SIDE LOOKUPS — the three questions about an ADDRESS that
 * lib/ask-evidence.js answers only in passing.
 *
 * gatherEvidence's wallet path returns twelve holdings, eight transfers and a
 * bare list of counterparty addresses. That is the right answer to "what is
 * 0xabc" and the wrong answer to three questions people actually ask about a
 * wallet they are watching:
 *
 *   "what is this wallet holding, and what is it worth"  -> walletPortfolio
 *   "what has this wallet done in NVDA — has it ever sold" -> traceWallet
 *   "who does this address actually deal with"            -> walletCounterparties
 *
 * Each of the three is a different shape of the same address, and each is where
 * a specific false claim is easiest to make. They are stated here so the code
 * below can be read against them:
 *
 *  1. AN UNPRICED HOLDING IS NOT A WORTHLESS ONE. Blockscout quotes the
 *     issuer-verified equities and nothing else, so most ERC-20s come back with
 *     no exchange_rate at all. Sorting a portfolio with those coerced to 0 puts
 *     every unpriced token at the bottom as "the smallest position", and totals
 *     that include them as zero understate the wallet. They sort LAST in value
 *     order without being called small, and the total says out loud that it
 *     covers the priced rows only.
 *  2. A CAPPED HISTORY IS A SAMPLE, AND "NEVER SOLD" IS A CLAIM ABOUT ALL OF IT.
 *     traceWallet walks at most MAX_TRACE_TRANSFERS transfers. If no sale
 *     appears in those, the honest answer is "no sale in the transfers read",
 *     not "this wallet has never sold" — so `hasSold` is TRUE, FALSE or NULL,
 *     and null is what a truncated walk with no outgoing transfer produces.
 *  3. A RANKING OVER RECENT ACTIVITY IS NOT A RANKING OVER A LIFETIME.
 *     walletCounterparties counts one page of transactions and one of token
 *     transfers. "Its biggest counterparty" would be a claim about a history
 *     nobody read, so the evidence carries what was sampled and what the address
 *     counters say the total is.
 *
 * Everything is best-effort and nothing throws: each function returns
 * `{ ok, kind, evidence }` or `{ ok: false, error }`, which is the contract
 * lib/ask-tools.js dispatches on.
 *
 * Server-side only: no React. Every chain read goes through lib/blockscout.js,
 * and therefore through the TTL cache and single-flight gate in
 * lib/indexer-cache.js.
 */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** The burn/mint address — a counterparty in the data, not in the world. */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Row bounds. Wider than any answer quotes, narrow enough to stay promptable. */
export const MAX_PORTFOLIO_ROWS = 50;
export const MAX_COUNTERPARTY_ROWS = 50;

/**
 * How far back traceWallet walks one wallet's transfers in one token.
 *
 * Three pages rather than one because the wallet's transfer feed is not filtered
 * by token on every deployment (see the walk below), so a single page can be
 * mostly other tokens and match almost nothing. Three rather than ten because
 * each page is a round trip against a rate-limited indexer, and a walk that
 * costs six seconds to prove a wallet never sold is a walk the user abandoned.
 */
const MAX_TRACE_PAGES = 3;
export const MAX_TRACE_TRANSFERS = 150;

/**
 * Time worth RE-ASKING for a dropped transfer page with.
 *
 * The same figure and the same reason lib/cross-token.js and lib/holder-history.js
 * use for their probes: a call handed 200ms fails, and having failed it reports an
 * indexer outage — a claim about an upstream that was never really asked. So a retry
 * is only started when there is time for it to mean something, and otherwise the walk
 * reports itself cut short. See lib/request-budget.js outOfTimeFor.
 */
const TRACE_PAGE_MIN_MS = 1_200;

/**
 * How many rows travel in the PROSE half of the evidence, beside the table, and
 * how many the trace table itself carries.
 *
 * Same reasoning as lib/token-evidence.js: the table is the list and the array
 * is the two or three rows an answer names. A hundred and fifty transfers
 * repeated in both halves is roughly 40KB against lib/ask-loop.js
 * MAX_EVIDENCE_CHARS of 24,000, and the table is the half that would get cut.
 */
const TRACE_TABLE_ROWS = 40;
const PROSE_HOLDINGS = 10;
const PROSE_TRACE = 8;
const PROSE_COUNTERPARTIES = 12;

/* ------------------------------ plumbing ------------------------------ */

/**
 * The indexer calls, overridable per call — the same test seam
 * lib/ask-evidence.js and lib/token-evidence.js use. Nothing in this module may
 * reach Blockscout during a unit test.
 *
 * resolveSymbol / snapshotMatch / listStockTokens are here because
 * resolveTokenTarget (lib/token-evidence.js) takes this same bag: trace_wallet
 * resolves its token half through exactly the code the token-side lookups use.
 */
const DEFAULT_CALLS = Object.freeze({
  getAddress,
  getAddressCounters,
  getAddressTokenBalances,
  getAddressTransactions,
  getTokenTransfers,
  getTransaction,
  listStockTokens,
  resolveSymbol,
  snapshotMatch,
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
 * these amounts have to be SUMMED and COMPARED, and a compacted "1.23M" cannot
 * be added to anything.
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

/** "2h 14m", "6 days" — a span said the way a reader would say it. */
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

/** The known timestamps of a row list, ascending. */
function knownTimes(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((r) => r?.timeMs)
    .filter((t) => typeof t === "number" && Number.isFinite(t))
    .sort((a, b) => a - b);
}

/** The failure sentence for a call that never answered. Never "not found". */
function unavailableError(what, status) {
  return {
    ok: false,
    error: `The Robinhood Chain indexer did not answer${status ? ` (HTTP ${status})` : ""}, so ${what} could not be read — unknown, not absent. Try again shortly.`,
  };
}

/** The one guard every function here shares: this has to be an address. */
function requireAddress(address, purpose) {
  const self = lowerAddress(address);
  if (self) return { ok: true, value: self };
  return {
    ok: false,
    error: `"${String(address ?? "").slice(0, 64)}" is not a wallet address, so ${purpose} cannot be looked up. An address is 0x followed by exactly 40 hex characters.`,
  };
}

/**
 * Cursor params for the next page. Blockscout echoes its own cursor back as
 * `next_page_params`; nulls in it would stringify to the literal "null" and
 * poison the query. Kept local rather than shared with lib/stock-tokens.js:
 * that module's copy is part of the registry walk, and one page-walker reaching
 * into another's internals is how two walks end up having to change together.
 */
function cursorParams(next) {
  if (!next || typeof next !== "object") return null;
  const out = {};
  for (const [key, value] of Object.entries(next)) {
    if (value == null) continue;
    out[key] = String(value);
  }
  return Object.keys(out).length ? out : null;
}

/** True when two param bags are the same request — a cursor that repeats loops. */
function sameParams(a, b) {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => a[k] === b[k]);
}

/**
 * A row count for a list, clamped into range. Junk falls back rather than
 * failing, for the reason lib/token-evidence.js clampRows gives: the question is
 * answerable at the default depth, so refusing a limit of "loads" would cost a
 * round trip to reach the same number.
 *
 * @param {unknown} raw
 * @param {number} fallback
 * @param {number} max
 * @returns {number}
 */
export function clampCount(raw, fallback, max) {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(1, n));
}

/** The items array off a Blockscout body that is sometimes bare, sometimes paged. */
function itemsOf(body) {
  if (Array.isArray(body)) return body;
  return Array.isArray(body?.items) ? body.items : [];
}

/** The contract a token-transfer row belongs to, however the indexer keyed it. */
function tokenAddressOf(item) {
  return lowerAddress(item?.token?.address ?? item?.token?.address_hash ?? item?.token_address);
}

/* ------------------------------ pure cores ------------------------------ */
/* Exported for test/wallet-tools.test.mjs. The row shaping, the value ordering
   and the counterparty tally are where a missing figure would become a claimed
   one, so all three are testable with no network at all. */

/**
 * Raw token balances -> flat printable rows, ordered by USD value with the
 * unpriced last.
 *
 * The ordering is the whole point and it is not `b.valueUsd - a.valueUsd`: that
 * returns NaN for every unpriced row and leaves the order undefined, and the
 * obvious "treat null as 0" fix states that a token nobody quotes is worth
 * nothing. compareByField (lib/market-evidence.js) is the one comparator in this
 * codebase that keeps unknowns last in both directions, and it is reused here
 * rather than re-derived.
 *
 * Every cell is a primitive because these rows go straight into a table, where a
 * nested object renders as "[object Object]".
 *
 * @param {Array<object>} items - raw getAddressTokenBalances items
 * @returns {Array<object>}
 */
export function portfolioRows(items) {
  const rows = (Array.isArray(items) ? items : [])
    .map((entry) => {
      const token = entry?.token && typeof entry.token === "object" ? entry.token : {};
      const decimals = finiteOrNull(token.decimals);
      const d = decimals ?? 18;
      const amount = amountNumber(entry?.value, d);
      const price = finiteOrNull(token.exchange_rate);
      // Both halves have to be real: an amount with no price and a price with no
      // readable amount are equally unvaluable, and neither is worth $0.
      const valueUsd = price !== null && amount !== null ? round2(amount * price) : null;
      const address = lowerAddress(token.address ?? token.address_hash ?? entry?.token_address);
      const verified = snapshotByAddress(address);
      return {
        symbol: sanitizeLabel(token.symbol, 16) ?? sanitizeLabel(token.name, 24),
        name: sanitizeLabel(token.name, 48),
        address,
        amount,
        amountDisplay: fmtTokenAmount(entry?.value, d),
        priceUsd: price,
        priceDisplay: displayNumber(price, "price"),
        valueUsd,
        valueDisplay: displayNumber(valueUsd, "usd"),
        // Stated rather than inferred from a null, so an answer can say how many
        // rows it could not value without counting nulls itself.
        priced: valueUsd !== null,
        // Which of these are the equities Robinhood actually issued.
        equity: verified?.symbol ?? null,
        issuerVerified: Boolean(verified) || isCanonicalStockAddress(address),
        decimalsAssumed: decimals === null,
      };
    })
    .filter((row) => row.symbol || row.address);

  return rows.sort(compareByField("valueUsd", "desc")).map((row, i) => ({ ...row, rank: i + 1 }));
}

/**
 * Raw transfer rows -> what one wallet did, from that wallet's point of view.
 *
 * `direction` is relative to the wallet and is the field everything else here is
 * built on: "in" is a transfer this address received, "out" is one it sent. A
 * transfer touching neither side is "other" — it cannot happen on a feed keyed
 * by the address, but if a filter ever returns one it must not be counted as a
 * sale.
 *
 * @param {Array<object>} items - raw getTokenTransfers items
 * @param {string} self - the wallet the feed belongs to
 * @returns {Array<object>}
 */
export function traceRows(items, self) {
  const me = lowerAddress(self);
  return (Array.isArray(items) ? items : []).map((x, i) => {
    const decimals = finiteOrNull(x?.total?.decimals ?? x?.token?.decimals);
    const d = decimals ?? 18;
    const from = lowerAddress(x?.from?.hash ?? x?.from);
    const to = lowerAddress(x?.to?.hash ?? x?.to);
    const direction = from === me && to === me ? "self" : to === me ? "in" : from === me ? "out" : "other";
    return {
      rank: i + 1,
      time: x?.timestamp ?? null,
      timeMs: timeMs(x?.timestamp),
      direction,
      // Pre-rendered, because "in"/"out" in a drawn table is a puzzle.
      directionDisplay:
        direction === "in" ? "received" : direction === "out" ? "sent" : direction === "self" ? "self-transfer" : "unrelated",
      counterparty: direction === "in" ? from : direction === "out" ? to : (to ?? from),
      from,
      to,
      amount: amountNumber(x?.total?.value, d),
      amountDisplay: fmtTokenAmount(x?.total?.value, d),
      txHash: x?.transaction_hash ?? x?.tx_hash ?? null,
      decimalsAssumed: decimals === null,
    };
  });
}

/**
 * Sum the amounts that could actually be read, and say how many that was.
 *
 * The `counted`/`of` pair is the same discipline lib/token-evidence.js
 * concentrationOf uses: a total over eight of ten rows is a real figure about
 * eight rows, and it becomes a lie only if it is quoted as if it covered ten.
 */
function sumAmounts(rows) {
  const known = rows.map((r) => r?.amount).filter((n) => typeof n === "number" && Number.isFinite(n));
  return {
    total: known.length ? round2(known.reduce((acc, n) => acc + n, 0)) : null,
    counted: known.length,
    of: rows.length,
  };
}

/**
 * Who an address deals with, tallied across every feed it appears in.
 *
 * Counts INTERACTIONS, not value: a wallet's relationship with a router it
 * touches forty times is the thing being asked about, and totalling USD across
 * two feeds with different tokens would be a number with no unit. Direction is
 * kept per side so "both" is distinguishable from "only ever sent to".
 *
 * @param {Array<{ items: Array<object>, kind: string }>} feeds
 * @param {string} self
 * @returns {Array<object>} ranked rows, each with `rank` set
 */
export function counterpartyRows(feeds, self) {
  const me = lowerAddress(self);
  const map = new Map();

  const touch = (other, side, at, kind) => {
    const key = lowerAddress(other);
    if (!key || key === me) return;
    const row = map.get(key) ?? {
      address: key,
      interactions: 0,
      sent: 0,
      received: 0,
      transactions: 0,
      tokenTransfers: 0,
      lastSeenMs: null,
      lastSeen: null,
    };
    row.interactions += 1;
    row[side] += 1;
    if (kind === "transaction") row.transactions += 1;
    else row.tokenTransfers += 1;
    if (typeof at === "number" && (row.lastSeenMs === null || at > row.lastSeenMs)) {
      row.lastSeenMs = at;
      row.lastSeen = new Date(at).toISOString();
    }
    map.set(key, row);
  };

  for (const feed of Array.isArray(feeds) ? feeds : []) {
    for (const item of Array.isArray(feed?.items) ? feed.items : []) {
      const from = lowerAddress(item?.from?.hash ?? item?.from);
      const to = lowerAddress(item?.to?.hash ?? item?.to);
      const at = timeMs(item?.timestamp);
      // A contract creation has no `to`; a row touching neither side is not this
      // wallet's counterparty at all and is dropped rather than half-counted.
      if (from === me && to && to !== me) touch(to, "sent", at, feed.kind);
      else if (to === me && from && from !== me) touch(from, "received", at, feed.kind);
    }
  }

  return [...map.values()]
    // The shared nulls-last comparator, so an unknown count could never rank
    // first. Ties fall back to the address, which makes two runs over the same
    // sample produce the same table; recency lives in the row, not the order.
    .sort(compareByField("interactions", "desc"))
    .map((row, i) => {
      const verified = snapshotByAddress(row.address);
      return {
        ...row,
        rank: i + 1,
        direction: row.sent && row.received ? "both" : row.sent ? "sent to" : "received from",
        equity: verified?.symbol ?? null,
        issuerVerified: Boolean(verified) || isCanonicalStockAddress(row.address),
        isZeroAddress: row.address === ZERO_ADDRESS,
      };
    });
}

/* ------------------------------ 1. portfolio ------------------------------ */

/**
 * Everything one address holds: each token, how much, what it is worth, and the
 * ETH balance underneath it.
 *
 * The total is the part that has to be read carefully. It sums the PRICED
 * holdings and nothing else, and `unpricedCount` travels beside it, because on
 * this chain most ERC-20s carry no quote at all — a portfolio that says
 * "$41,203" while eleven of its nineteen holdings were unvalued has told the
 * reader something false about their own wallet. There is no path here that
 * treats an unpriced holding as $0, and none that sorts it as the smallest.
 *
 * @param {string} address - a 0x wallet or contract address
 * @param {{ calls?: object }} [options]
 * @returns {Promise<{ ok: boolean, kind?: string, evidence?: object, error?: string }>}
 */
export async function walletPortfolio(address, options = {}) {
  const calls = withCalls(options);
  const checked = requireAddress(address, "a portfolio");
  if (!checked.ok) return checked;
  const self = checked.value;

  try {
    const src = tracker();
    // All three at once: the balances are the answer, the overview carries the
    // ETH underneath it, and the counters are context that must not gate either.
    const overviewPromise = attempt(() => calls.getAddress(self, deadline(TIMEOUT_MS)));
    const balancesPromise = attempt(() => calls.getAddressTokenBalances(self, deadline(TIMEOUT_MS)));
    const countersPromise = attempt(() => calls.getAddressCounters(self, deadline(ENRICHMENT_TIMEOUT_MS)));

    const overviewRes = await overviewPromise;
    if (!overviewRes.ok) src.miss("balanceEth");
    const balancesRes = await balancesPromise;
    if (!balancesRes.ok) src.miss("holdings");
    const countersRes = await countersPromise;
    if (!countersRes.ok) src.miss("activity");

    const addr = overviewRes.data ?? null;
    if (!addr && !balancesRes.data) {
      if (overviewRes.status === 404) {
        return { ok: false, error: `Nothing exists at ${self} on Robinhood Chain.` };
      }
      return unavailableError(`the holdings of ${shortHex(self)}`, overviewRes.status ?? balancesRes.status);
    }

    // null, not []: a failed balances call is not a wallet holding nothing.
    const all = balancesRes.data ? portfolioRows(itemsOf(balancesRes.data)) : null;
    const rows = all ? all.slice(0, MAX_PORTFOLIO_ROWS) : [];
    const priced = all ? all.filter((r) => r.priced) : [];
    const unpricedCount = all ? all.length - priced.length : null;
    const totalValueUsd = priced.length ? round2(priced.reduce((acc, r) => acc + r.valueUsd, 0)) : null;
    const balanceEth = addr?.coin_balance != null ? weiToEth(addr.coin_balance) : null;

    const valuationNote = all
      ? unpricedCount
        ? `${priced.length} of ${all.length} holdings carry a price on this indexer, and the total is the sum of those only. The other ${unpricedCount} could not be valued — this indexer prices the issuer-verified tokenized equities and little else, so unpriced means unquoted, not worthless.`
        : all.length
          ? `Every one of the ${all.length} holdings carried a price, so the total covers all of them.`
          : "The indexer returned no token balances for this address — a measured empty wallet, not a failed lookup."
      : null;

    const table = all
      ? buildTable({
          id: "wallet-portfolio",
          title: `${rows.length} token holding${rows.length === 1 ? "" : "s"} in ${shortHex(self)}`,
          columns: [
            col("rank", "#", "right"),
            col("symbol", "Token"),
            col("amountDisplay", "Amount", "right"),
            col("priceDisplay", "Price", "right"),
            col("valueDisplay", "Value", "right"),
            col("address", "Contract"),
          ],
          rows,
          // A measured count from a body that arrived, so "50 of 118" is real.
          totalRows: all.length,
          truncated: rows.length < all.length,
          note: [
            "Sorted by USD value, with the holdings this indexer carries no price for last — unpriced is not zero-value and is not the smallest position.",
            valuationNote,
            "Balances and prices are the indexer's at the time of the lookup.",
          ]
            .filter(Boolean)
            .join(" "),
        })
      : null;

    return {
      ok: true,
      kind: "portfolio",
      evidence: {
        ...src.gaps(),
        address: self,
        isContract: addr?.is_contract ?? null,
        name: sanitizeLabel(addr?.name),
        // ETH is the gas token here, so it is quoted in ETH and never folded
        // into the USD total — there is no ETH/USD feed on this indexer.
        balanceEth,
        balanceEthDisplay: balanceEth === null ? null : `${balanceEth} ETH`,
        totalTransactions: finiteOrNull(countersRes.data?.transactions_count),
        tokenTransferCount: finiteOrNull(countersRes.data?.token_transfers_count),
        // null when the call failed: zero holdings is a claim about the wallet.
        holdingsRead: all ? all.length : null,
        rowsShown: rows.length,
        pricedCount: all ? priced.length : null,
        unpricedCount,
        // The priced portion ONLY, and the note beside it says so.
        totalValueUsd,
        totalValueDisplay: displayNumber(totalValueUsd, "usd"),
        valuationNote,
        issuerVerifiedHoldings: all ? all.filter((r) => r.issuerVerified).length : null,
        // The most valuable few, for the rows the prose names. Every row the
        // caller gets is in the table below — see PROSE_HOLDINGS.
        holdings: all ? all.slice(0, PROSE_HOLDINGS) : null,
        ...(table ? { table } : {}),
        asOf: nowIso(),
      },
    };
  } catch (e) {
    return { ok: false, error: `The portfolio could not be read: ${String(e?.message ?? e).slice(0, 200)}.` };
  }
}

/* ------------------------------ 2. trace ------------------------------ */

/**
 * What ONE wallet did in ONE token: how many times it received, how many times
 * it sent, when it started, when it last moved, where that leaves it, and
 * whether it has ever sold at all.
 *
 * That last flag is the reason this lookup exists. "Accumulated and never
 * distributed" is a real and interesting reading of an address, and it is one
 * that a truncated history cannot support: absence of a sale in the transfers
 * read is not absence of a sale. So `hasSold` has three states —
 *
 *   true  — an outgoing transfer was seen, and it is in the table
 *   false — none was seen AND the walk reached the end of the history
 *   null  — none was seen but the walk was cut short, so this is UNKNOWN
 *
 * — and `reading` is written here rather than left to the model, because the
 * difference between "has never sold" and "has not sold in the 150 transfers I
 * could read" is exactly the sentence that must not be improvised.
 *
 * @param {string} address - the wallet
 * @param {string} token - ticker, company name or 0x contract address
 * @param {{ calls?: object }} [options]
 * @returns {Promise<{ ok: boolean, kind?: string, evidence?: object, error?: string }>}
 */
export async function traceWallet(address, token, options = {}) {
  const calls = withCalls(options);
  const checked = requireAddress(address, "a wallet's history in one token");
  if (!checked.ok) return checked;
  const self = checked.value;

  try {
    const target = await resolveTokenTarget(token, calls);
    if (!target.ok) return target;

    const src = tracker();
    // The wallet's current balance of this token, started now so it overlaps the
    // walk. It is what turns "net +400 across the transfers read" into something
    // checkable, and losing it costs that one field.
    const balancesPromise = attempt(() => calls.getAddressTokenBalances(self, deadline(ENRICHMENT_TIMEOUT_MS)));

    /*
     * THE WALK. `token` is passed as a filter because Blockscout v2 accepts one
     * on this endpoint, and every row is ALSO matched on the contract address
     * locally — if a deployment ignores the parameter, the filter still happens,
     * it just costs more pages to fill. Believing the parameter alone would mean
     * counting another token's transfers as this one's.
     */
    let params = { type: "ERC-20", token: target.address };
    const matched = [];
    let scanned = 0;
    let pages = 0;
    let next = null;
    let cutShort = false;
    let cutShortReason = null;

    for (; pages < MAX_TRACE_PAGES; pages += 1) {
      /*
       * A FAILED PAGE IS RE-ASKED BEFORE THE WALK GIVES UP. Measured, this indexer
       * drops roughly one page in ten at random and answers the retry, so a page lost
       * on the first ask was costing this function its strongest claim: `hasSold`
       * collapses from FALSE to NULL the moment the walk is cut short, which turns
       * "this wallet has never sold" into "unknown" for a blip. See lib/page-retry.js.
       * The three-page cap and every honesty flag below are unchanged.
       */
      const res = await readPageWithRetry(
        () => calls.getTokenTransfers(self, params, deadline(TIMEOUT_MS)),
        { minMs: TRACE_PAGE_MIN_MS, label: "traceWallet" },
      );
      if (!res.ok || !res.value) {
        if (pages === 0) {
          src.miss("transfers");
          return unavailableError(
            `what ${shortHex(self)} has done in ${target.symbol ?? shortHex(target.address)}`,
            res.status,
          );
        }
        // Some pages landed. Keep them, and say the history stops here — naming which
        // shortage stopped it, because a page that failed every attempt is an outage
        // and one that could not be re-asked is a request out of time.
        cutShort = true;
        cutShortReason = res.stoppedForTime
          ? `page ${pages + 1} of this wallet's transfers did not answer and the request had no time left to ask again`
          : `page ${pages + 1} of this wallet's transfers did not answer on ${res.attempts} attempt${res.attempts === 1 ? "" : "s"}`;
        break;
      }

      const items = itemsOf(res.value);
      scanned += items.length;
      for (const item of items) {
        if (tokenAddressOf(item) === target.address) matched.push(item);
      }

      next = cursorParams(res.value?.next_page_params);
      if (!next || matched.length >= MAX_TRACE_TRANSFERS) break;
      const following = { ...next, type: "ERC-20", token: target.address };
      // A cursor that repeats itself is an upstream bug; walking it loops
      // forever. Stopping there is NOT reaching the end of the history, so it
      // counts as cut short — otherwise a broken cursor would license the
      // strongest claim this function makes, that the wallet has never sold.
      if (sameParams(following, params)) {
        cutShort = true;
        cutShortReason = "the indexer returned the same page cursor twice, so the walk was stopped";
        break;
      }
      params = following;
    }

    // More upstream than we read, or a page that never came back: either way the
    // history in hand is a prefix, and every claim below is bounded by it.
    const truncated = Boolean(next) || cutShort;

    const rows = traceRows(matched, self);
    const inRows = rows.filter((r) => r.direction === "in");
    const outRows = rows.filter((r) => r.direction === "out");
    const selfRows = rows.filter((r) => r.direction === "self");
    const received = sumAmounts(inRows);
    const sent = sumAmounts(outRows);
    const netPosition =
      received.total === null && sent.total === null ? null : round2((received.total ?? 0) - (sent.total ?? 0));

    // The three states. Only a complete walk can turn "no sale seen" into false.
    const hasSold = outRows.length > 0 ? true : truncated ? null : false;

    const times = knownTimes(rows);
    const balancesRes = await balancesPromise;
    if (!balancesRes.ok) src.miss("currentBalance");
    const held = balancesRes.data ? currentHolding(itemsOf(balancesRes.data), target.address) : null;
    const symbol = target.symbol ?? null;

    const shown = rows.slice(0, TRACE_TABLE_ROWS);
    const table = buildTable({
      id: "wallet-trace",
      title: `${rows.length} transfer${rows.length === 1 ? "" : "s"} of ${symbol ?? shortHex(target.address)} by ${shortHex(self)}`,
      columns: [
        col("rank", "#", "right"),
        col("time", "Time"),
        col("directionDisplay", "Direction"),
        col("counterparty", "Counterparty"),
        col("amountDisplay", "Amount", "right"),
        col("txHash", "Transaction"),
      ],
      rows: shown,
      totalRows: rows.length,
      truncated: truncated || shown.length < rows.length,
      note: [
        `Matched on the token's contract address across the ${scanned} most recent transfer${scanned === 1 ? "" : "s"} of this wallet that the indexer returned.`,
        truncated
          ? "The walk stopped before the end of this wallet's history, so these are its most recent transfers in this token and not all of them."
          : "The walk reached the end of what the indexer holds for this wallet in this token.",
        "\"received\" and \"sent\" are transfers in and out; on-chain that covers airdrops, mints and wallet-to-wallet moves as well as trades.",
      ].join(" "),
    });

    return {
      ok: true,
      kind: "trace",
      evidence: {
        ...src.gaps(),
        wallet: self,
        token: {
          address: target.address,
          symbol,
          company: target.company ?? null,
          issuerVerified: target.snapshotted,
        },
        // What the numbers below are computed over. Every one of these bounds
        // the claim an answer is allowed to make.
        transfersRead: rows.length,
        transfersScanned: scanned,
        pagesRead: Math.min(pages + 1, MAX_TRACE_PAGES),
        historyComplete: !truncated,
        truncated,
        // WHY it stopped, when something other than "there was more upstream" stopped
        // it. Null on a walk that simply reached its cap or the end of the history.
        truncatedReason: cutShortReason,
        // The requested counts. `basis` says what they actually mean, because a
        // transfer in is an acquisition and not necessarily a purchase.
        buys: inRows.length,
        sells: outRows.length,
        selfTransfers: selfRows.length,
        basis:
          "A transfer in is counted as a buy and a transfer out as a sell. On-chain that is acquisition and disposal — an airdrop, a mint or a move between the same owner's wallets counts the same as a trade.",
        received: { ...received, display: received.total === null ? null : `${received.total} ${symbol ?? ""}`.trim() },
        sent: { ...sent, display: sent.total === null ? null : `${sent.total} ${symbol ?? ""}`.trim() },
        netPosition,
        netPositionDisplay: netPosition === null ? null : `${netPosition} ${symbol ?? ""}`.trim(),
        // TRUE, FALSE or NULL — see the header of this function.
        hasSold,
        soldInSample: outRows.length > 0,
        firstSeen: times.length ? new Date(times[0]).toISOString() : null,
        lastSeen: times.length ? new Date(times[times.length - 1]).toISOString() : null,
        activitySpan: times.length >= 2 ? spanWords(times[times.length - 1] - times[0]) : null,
        // What it actually holds now, so the net figure above is checkable.
        currentBalance: held,
        reading: traceReading({ rows, inRows, outRows, hasSold, truncated, symbol, netPosition, held }),
        recentTransfers: rows.slice(0, PROSE_TRACE),
        table,
        asOf: nowIso(),
      },
    };
  } catch (e) {
    return { ok: false, error: `The wallet's history in that token could not be read: ${String(e?.message ?? e).slice(0, 200)}.` };
  }
}

/** What this wallet holds of the traced token right now, or null. */
function currentHolding(items, tokenAddress) {
  for (const entry of Array.isArray(items) ? items : []) {
    const token = entry?.token && typeof entry.token === "object" ? entry.token : {};
    if (lowerAddress(token.address ?? token.address_hash ?? entry?.token_address) !== tokenAddress) continue;
    const decimals = finiteOrNull(token.decimals);
    const d = decimals ?? 18;
    const amount = amountNumber(entry?.value, d);
    const price = finiteOrNull(token.exchange_rate);
    const valueUsd = price !== null && amount !== null ? round2(amount * price) : null;
    return {
      amount,
      amountDisplay: fmtTokenAmount(entry?.value, d),
      valueUsd,
      valueDisplay: displayNumber(valueUsd, "usd"),
    };
  }
  // The balances body arrived and this token was not in it, which is a real
  // answer: the wallet holds none of it now.
  return { amount: 0, amountDisplay: "0", valueUsd: null, valueDisplay: null };
}

/**
 * The trace said in sentences — one per fact that is actually established.
 *
 * Written here for the reason contractReading is: "has never sold" and "has not
 * sold in what I could read" are different statements, only one of them is
 * supportable from a capped walk, and the wording of that distinction is not
 * something to re-derive per answer.
 */
function traceReading({ rows, inRows, outRows, hasSold, truncated, symbol, netPosition, held }) {
  const ticker = symbol ?? "this token";
  if (!rows.length) {
    return truncated
      ? `No transfer of ${ticker} by this wallet appears in the transfers that could be read, and the walk stopped short of the end of its history — so this is "none found in the sample", not "never touched it".`
      : `This wallet has no transfers of ${ticker} in the indexer's history for it at all.`;
  }

  const lines = [
    `${rows.length} transfer${rows.length === 1 ? "" : "s"} of ${ticker} by this wallet were read: ${inRows.length} in, ${outRows.length} out.`,
  ];

  if (hasSold === false) {
    lines.push(
      `Every one of them was incoming, and the walk covered this wallet's whole history in ${ticker} — it accumulated and never distributed.`,
    );
  } else if (hasSold === null) {
    lines.push(
      `None of them was outgoing, but the walk stopped before the end of its history, so whether it has ever sold ${ticker} is unknown rather than no. Say that no sale appears in the transfers read.`,
    );
  } else {
    lines.push(`It has sent ${ticker} out, so it is not a wallet that has only ever accumulated.`);
  }

  if (netPosition !== null) {
    lines.push(
      `Net across the transfers read: ${netPosition >= 0 ? "+" : ""}${netPosition} ${ticker}${truncated ? ", over that sample rather than over its whole history" : ""}.`,
    );
  }
  if (held && typeof held.amount === "number") {
    lines.push(`It currently holds ${held.amountDisplay} ${ticker}.`);
  }
  return lines.join(" ");
}

/* ------------------------------ 3. counterparties ------------------------------ */

/**
 * Who an address actually deals with, ranked by how often.
 *
 * Two feeds are counted rather than one: native transactions and ERC-20
 * transfers. On a chain whose point is tokenized equities, an address's real
 * relationships are mostly in the second, and a counterparty list built from
 * transactions alone would miss the token contracts and routers it works
 * through. Both are one page each — this is a picture of recent dealing, and the
 * evidence says so beside the address's total transaction count, so nobody reads
 * "its biggest counterparty" off a sample of fifty rows.
 *
 * @param {string} address
 * @param {{ limit?: number, calls?: object }} [options]
 * @returns {Promise<{ ok: boolean, kind?: string, evidence?: object, error?: string }>}
 */
export async function walletCounterparties(address, options = {}) {
  const calls = withCalls(options);
  const checked = requireAddress(address, "an address's counterparties");
  if (!checked.ok) return checked;
  const self = checked.value;
  const limit = clampCount(options?.limit, 15, MAX_COUNTERPARTY_ROWS);

  try {
    const src = tracker();
    const txPromise = attempt(() => calls.getAddressTransactions(self, {}, deadline(TIMEOUT_MS)));
    const transferPromise = attempt(() => calls.getTokenTransfers(self, { type: "ERC-20" }, deadline(TIMEOUT_MS)));
    const countersPromise = attempt(() => calls.getAddressCounters(self, deadline(ENRICHMENT_TIMEOUT_MS)));

    const txRes = await txPromise;
    if (!txRes.ok) src.miss("transactions");
    const transferRes = await transferPromise;
    if (!transferRes.ok) src.miss("tokenTransfers");
    const countersRes = await countersPromise;
    if (!countersRes.ok) src.miss("activity");

    if (!txRes.data && !transferRes.data) {
      return unavailableError(
        `who ${shortHex(self)} interacts with`,
        txRes.status ?? transferRes.status,
      );
    }

    const txItems = txRes.data ? itemsOf(txRes.data) : [];
    const transferItems = transferRes.data ? itemsOf(transferRes.data) : [];
    const ranked = counterpartyRows(
      [
        { items: txItems, kind: "transaction" },
        { items: transferItems, kind: "transfer" },
      ],
      self,
    );
    const rows = ranked.slice(0, limit);
    // A next page on either feed means the tally is over a window, not a life.
    const sampleTruncated = Boolean(txRes.data?.next_page_params) || Boolean(transferRes.data?.next_page_params);
    const totalTransactions = finiteOrNull(countersRes.data?.transactions_count);
    const totalTransfers = finiteOrNull(countersRes.data?.token_transfers_count);

    const table = buildTable({
      id: "wallet-counterparties",
      title: `${rows.length} address${rows.length === 1 ? "" : "es"} ${shortHex(self)} deals with`,
      columns: [
        col("rank", "#", "right"),
        col("address", "Counterparty"),
        col("equity", "Robinhood equity"),
        col("direction", "Direction"),
        col("interactions", "Interactions", "right"),
        col("lastSeen", "Last seen"),
      ],
      rows,
      totalRows: ranked.length,
      truncated: rows.length < ranked.length || sampleTruncated,
      note: [
        // Each feed is described only if it actually answered: "0 transactions"
        // for a call that failed would read as an address that has never
        // transacted, which is the whole class of claim this file refuses.
        `Counted over ${[
          txRes.data ? `the ${txItems.length} most recent transaction${txItems.length === 1 ? "" : "s"}` : null,
          transferRes.data ? `${transferItems.length} token transfer${transferItems.length === 1 ? "" : "s"}` : null,
        ]
          .filter(Boolean)
          .join(" and ")} the indexer returned for this address${
          totalTransactions !== null ? `, out of ${displayNumber(totalTransactions, "count")} transactions in total` : ""
        }.${txRes.data && transferRes.data ? "" : " One of the two feeds did not answer, so this counts only the other."}`,
        sampleTruncated
          ? "There is more history upstream, so this ranks who it has dealt with recently rather than who it has dealt with most."
          : "That is this address's whole history in the indexer's answer.",
        "The \"Robinhood equity\" column names the counterparty when it is one of the issuer-verified tokenized-equity contracts; a blank means it is not in that verified set, not that it is suspicious.",
      ].join(" "),
    });

    return {
      ok: true,
      kind: "counterparties",
      evidence: {
        ...src.gaps(),
        address: self,
        // What was counted, so no answer can imply a wider sweep.
        sampled: {
          transactions: txRes.data ? txItems.length : null,
          tokenTransfers: transferRes.data ? transferItems.length : null,
          moreUpstream: sampleTruncated,
        },
        totalTransactions,
        totalTokenTransfers: totalTransfers,
        distinctCounterparties: ranked.length,
        rowsShown: rows.length,
        limit,
        equityCounterparties: ranked.filter((r) => r.issuerVerified).length,
        // The busiest few, for the rows the prose names. Every row the caller
        // asked for is in the table below — repeating all fifty here would put
        // this result past lib/ask-loop.js MAX_EVIDENCE_CHARS on its own, and
        // the table is the half that would get truncated away.
        counterparties: rows.slice(0, PROSE_COUNTERPARTIES),
        note: "Ranked by how many interactions appear in the recent sample above, not by value moved and not over the address's whole history. A counterparty seen once is still a counterparty; a blank equity column only means the address is not one of the verified equity contracts.",
        table,
        asOf: nowIso(),
      },
    };
  } catch (e) {
    return { ok: false, error: `The counterparties could not be read: ${String(e?.message ?? e).slice(0, 200)}.` };
  }
}

/* ------------------------------ profit and loss ----------------------------- */

/**
 * How many transactions may be opened to price a wallet's trades.
 *
 * Each one is a round trip, and pricing is the only reason to make it: the transfer
 * walk says WHAT moved, and only the transaction says what it was exchanged for.
 * The cap is what stops a busy wallet turning one question into a hundred calls —
 * and reaching it does not produce a worse number, it produces NO number, because a
 * trade that was never read is a hole in the basis exactly like an airdrop is.
 */
export const MAX_PNL_JOINS = 14;

/** The finished sentence, so no answer has to assemble the qualifiers itself. */
function pnlReading({ proof, ledger, symbol, self, truncated }) {
  const name = symbol ?? "this token";
  if (proof.provable) {
    const sign = ledger.realisedEth >= 0n ? "up" : "down";
    const size = formatEth(ledger.realisedEth < 0n ? -ledger.realisedEth : ledger.realisedEth);
    const rest =
      ledger.qtyHeld > 0n
        ? "It still holds a position, and what that is worth now is not measured here."
        : "The position is fully closed.";
    return `Across every priced trade in ${name}, this wallet is ${sign} ${size} ETH realised, before gas. ${rest}`;
  }
  if (proof.reason === NOT_PROVABLE.HISTORY_INCOMPLETE || truncated) {
    return `This wallet's history in ${name} is longer than could be read in one answer, so what it paid overall is unknown — not zero, and not a floor either: the part not read holds both purchases and sales, and nothing says which way they would move the figure.`;
  }
  if (proof.reason === NOT_PROVABLE.OVERSOLD) {
    return `This wallet sold more of ${name} than the transfers read ever show arriving, so its history starts before what could be read and there is no complete cost to compare against.`;
  }
  if (proof.reason === NOT_PROVABLE.UNCOSTED_ACQUISITION) {
    return `Some of this wallet's position in ${name} arrived without a purchase that could be priced — an airdrop, a native-ETH trade, or a transaction not read here — so part of it has no cost at all, and a profit figure would be inventing one. The trades that COULD be priced are listed.`;
  }
  return `No trade in ${name} by ${shortHex(self)} could be priced from what was read, so whether it is up or down is unknown.`;
}

/**
 * What one wallet made or lost in one token, in ETH, when that can be proven.
 *
 * SCOPED TO ONE TOKEN ON PURPOSE. A whole-wallet total sums figures whose knownness
 * correlates with the answer — clean WETH trades are priceable, airdrops and
 * native-ETH buys are not — so the total would quietly describe the subset that
 * happened to be readable while looking like it covered everything.
 *
 * REALISED ONLY, AND THAT IS SAID RATHER THAN IMPLIED. Unrealised profit needs a
 * current mark price for the remaining position; the pool reader here covers
 * Uniswap v3, and a great many tokens on this chain trade on v4, so a mark would be
 * silently absent for exactly the tokens most likely to be asked about. What comes
 * back instead is the position still held, as a quantity, with what it cost.
 *
 * @param {string} address the wallet
 * @param {string} token ticker, company or contract
 * @param {object} [options]
 * @returns {Promise<object>} an evidence envelope; never throws
 */
export async function walletPnl(address, token, options = {}) {
  const calls = withCalls(options);
  const checked = requireAddress(address, "a wallet's profit and loss in one token");
  if (!checked.ok) return checked;
  const self = checked.value;

  try {
    const target = await resolveTokenTarget(token, calls);
    if (!target.ok) return target;

    const src = tracker();
    const weth = wethAddress();
    const decimals = Number.isFinite(Number(target.decimals)) ? Number(target.decimals) : 18;

    // THE SAME WALK traceWallet MAKES, and for the same reasons: the token filter is
    // passed but never believed, every row is matched locally on the contract, a
    // dropped page is re-asked, and a repeating cursor stops the walk rather than
    // looping. Only what happens to the rows afterwards differs.
    let params = { type: "ERC-20", token: target.address };
    const matched = [];
    let scanned = 0;
    let pages = 0;
    let next = null;
    let cutShort = false;
    let cutShortReason = null;

    for (; pages < MAX_TRACE_PAGES; pages += 1) {
      const res = await readPageWithRetry(
        () => calls.getTokenTransfers(self, params, deadline(TIMEOUT_MS)),
        { minMs: TRACE_PAGE_MIN_MS, label: "walletPnl" },
      );
      if (!res.ok || !res.value) {
        if (pages === 0) {
          src.miss("transfers");
          return unavailableError(
            `what ${shortHex(self)} paid for ${target.symbol ?? shortHex(target.address)}`,
            res.status,
          );
        }
        cutShort = true;
        cutShortReason = res.stoppedForTime
          ? `page ${pages + 1} of this wallet's transfers did not answer and the request had no time left to ask again`
          : `page ${pages + 1} of this wallet's transfers did not answer on ${res.attempts} attempt${res.attempts === 1 ? "" : "s"}`;
        break;
      }

      const items = itemsOf(res.value);
      scanned += items.length;
      for (const item of items) {
        if (tokenAddressOf(item) === target.address) matched.push(item);
      }

      next = cursorParams(res.value?.next_page_params);
      if (!next || matched.length >= MAX_TRACE_TRANSFERS) break;
      const following = { ...next, type: "ERC-20", token: target.address };
      if (sameParams(following, params)) {
        cutShort = true;
        cutShortReason = "the indexer returned the same page cursor twice, so the walk was stopped";
        break;
      }
      params = following;
    }

    const truncated = Boolean(next) || cutShort;

    // OLDEST FIRST. The feed arrives newest-first, and a ledger replayed backwards
    // puts every sale before the purchase that funded it.
    const ordered = matched.map((row, index) => ({ ...row, index })).sort(chainOrder);

    /*
     * ONE ENTRY PER TRANSACTION, CARRYING THE QUANTITY THE WALK SAW.
     *
     * The quantity comes from HERE and never from the joined transaction. Measured:
     * a disperse to more than ten recipients returns ten legs with
     * `token_transfers_overflow: true`, and the wallet being asked about was not
     * among them — its own transfer missing from its own transaction. Taking the
     * quantity from there would have silently dropped the whole position. This walk
     * is wallet-scoped and paginated, so what it saw arrive is what arrived.
     */
    const byTx = new Map();
    for (const row of ordered) {
      const hash = String(row?.transaction_hash ?? row?.tx_hash ?? "").toLowerCase();
      if (!hash) continue;
      const amount = rawAmount(row);
      const from = String(row?.from?.hash ?? row?.from ?? "").toLowerCase();
      const to = String(row?.to?.hash ?? row?.to ?? "").toLowerCase();
      let delta = 0n;
      if (amount !== null) {
        if (to === self && from !== self) delta = amount;
        else if (from === self && to !== self) delta = -amount;
      }
      const prev = byTx.get(hash);
      if (prev) {
        prev.net += delta;
        if (amount === null) prev.unreadable = true;
      } else {
        byTx.set(hash, { hash, timestamp: row?.timestamp ?? null, net: delta, unreadable: amount === null });
      }
    }
    const txOrder = [...byTx.values()];

    const joinsNeeded = txOrder.length;
    const joinsComplete = joinsNeeded <= MAX_PNL_JOINS;

    const events = [];
    const trades = [];
    let joinsMade = 0;
    let joinsFailed = 0;

    /*
     * EVERY TRANSACTION MOVES THE POSITION; ONLY THE FIRST FEW GET PRICED.
     *
     * The quantity is already known from the walk, so it is recorded whatever
     * happens to the join — a transaction that would not open, or one past the join
     * cap, still changed what this wallet holds. Losing it would leave a later sale
     * with nothing to have been sold and report a position of zero for a wallet that
     * plainly has one. What an unpriced transaction costs is the FIGURE, through
     * provability(), and never the ledger.
     */
    for (const [i, tx] of txOrder.entries()) {
      const qty = tx.net > 0n ? tx.net : -tx.net;
      let priced = null;
      let reason = UNPRICED.NOT_READ;

      if (i < MAX_PNL_JOINS) {
        const res = await attempt(() => calls.getTransaction(tx.hash, deadline(TIMEOUT_MS)));
        if (!res.ok || !res.data) {
          joinsFailed += 1;
        } else {
          joinsMade += 1;
          const legs = Array.isArray(res.data?.token_transfers) ? res.data.token_transfers : [];
          const read = readTrade({
            legs,
            wallet: self,
            token: target.address,
            weth,
            tokenNet: tx.net,
            overflowed: res.data?.token_transfers_overflow === true,
          });
          if (read.priced) priced = read;
          else reason = read.unreadableLeg || tx.unreadable ? UNPRICED.UNREADABLE : read.reason;
        }
      }

      if (qty > 0n) {
        events.push({ kind: tx.net > 0n ? "acquire" : "dispose", qty, eth: priced ? priced.eth : null });
      }

      trades.push({
        hash: tx.hash,
        timestamp: tx.timestamp,
        side: priced ? priced.side : tx.net > 0n ? "in" : tx.net < 0n ? "out" : null,
        priced: Boolean(priced),
        reason: priced ? null : reason,
        qtyDisplay: qty === 0n ? null : formatUnitsExact(qty, decimals),
        ethDisplay: priced ? `${formatEth(priced.eth)} ETH` : null,
      });
    }

    const ledger = buildLedger(events);
    // A transaction that failed to open is a hole in the basis exactly like an
    // unpriced one, so it must also stop the figure being stated.
    const proof = provability(ledger, {
      historyComplete: !truncated,
      joinsComplete: joinsComplete && joinsFailed === 0,
    });
    const symbol = target.symbol ?? null;

    const shown = trades.slice(0, TRACE_TABLE_ROWS);
    const table = buildTable({
      id: "wallet-pnl",
      title: `${trades.length} ${symbol ?? shortHex(target.address)} transaction${trades.length === 1 ? "" : "s"} by ${shortHex(self)}`,
      columns: [
        col("timestamp", "Time"),
        col("side", "Side"),
        col("qtyDisplay", "Amount", "right"),
        col("ethDisplay", "ETH", "right"),
        col("reason", "Unpriced because"),
        col("hash", "Transaction"),
      ],
      rows: shown,
      totalRows: trades.length,
      truncated: truncated || shown.length < trades.length,
      note: [
        "Each row is one transaction. A trade is priced only where the wallet's OWN WETH leg moved opposite its token leg, which is what an exchange looks like;",
        "adding or removing liquidity moves both the same way and is never counted as a trade.",
        "Native-ETH trades leave no WETH leg and stay unpriced rather than being valued from the transaction's value field, which is gross of any router refund.",
      ].join(" "),
    });

    return {
      ok: true,
      kind: "pnl",
      evidence: {
        ...src.gaps(),
        wallet: self,
        token: { address: target.address, symbol, company: target.company ?? null, issuerVerified: target.snapshotted },
        denomination: "ETH",
        denominationNotice:
          "Every figure here is in ETH. A swap prices itself — the WETH that left the wallet against the tokens that arrived in the same transaction — so no price feed is involved and no historical rate is assumed. There is no ETH/USD rate for past trades here, so none of this is converted to dollars.",
        // WHAT WAS READ, which bounds every claim below it.
        transfersRead: matched.length,
        transfersScanned: scanned,
        transactionsSeen: joinsNeeded,
        transactionsRead: joinsMade,
        transactionsUnread: Math.max(0, joinsNeeded - joinsMade),
        joinsFailed,
        historyComplete: !truncated,
        truncated,
        truncatedReason: cutShortReason,
        // THE FIGURE, OR THE REASON THERE IS NONE — never both, so there is no
        // number sitting in the evidence that could be quoted without its caveat.
        provable: proof.provable,
        notProvableReason: proof.reason,
        realisedEth: proof.provable ? formatEth(ledger.realisedEth) : null,
        realisedEthDisplay: proof.provable ? `${formatEth(ledger.realisedEth)} ETH` : null,
        // The position, which is a measurement either way.
        stillHeld: formatUnitsExact(ledger.qtyHeld, decimals),
        costOfHeldEth: proof.provable ? formatEth(ledger.ethBasis) : null,
        pricedTrades: ledger.pricedTrades,
        uncostedAcquisitions: ledger.uncostedAcquisitions,
        unpricedDisposals: ledger.unpricedDisposals,
        oversold: ledger.oversold,
        basisConvention: "average_cost",
        basisConventionNote:
          "Average cost over the acquisitions this walk priced. FIFO would give a different figure on the same trades; neither is more correct, so the convention is named rather than left to be guessed.",
        excludes:
          "Gas is not included, and neither is any unrealised profit on what is still held — that would need a current mark price for the remaining position, which is not read here.",
        reading: pnlReading({ proof, ledger, symbol, self, truncated }),
        table,
      },
    };
  } catch (e) {
    return {
      ok: false,
      error: `That wallet's profit and loss could not be read: ${String(e?.message ?? e).slice(0, 200)}.`,
    };
  }
}

/* ------------------------------ fund tracing ------------------------------ */

/**
 * How far a trace goes, and how wide.
 *
 * Every one of these is a bound the ANSWER has to carry, not a tuning knob: a
 * trace that quietly stopped at two hops and reported what it found is telling
 * somebody the money went somewhere it did not. Branching is capped per hop
 * because a single disperse to fifty addresses would otherwise turn one question
 * into hundreds of reads, and the fiftieth is no more informative than the fifth.
 */
const MAX_TRACE_HOPS = 3;
const MAX_BRANCH_PER_HOP = 6;
const TRACE_HOP_MIN_MS = 3_500;

/**
 * Follow one token out of one wallet, hop by hop, and say where it stopped.
 *
 * WHAT MAKES THIS HONEST IS THE BUCKETS, not the walk. Value that reaches a pool
 * did NOT stop — it was traded and continues as another token — so it is counted
 * apart from value that was burned or is genuinely sitting somewhere. The most
 * common exit from a drained wallet is a swap, and a trace that folded pools into
 * "followed to a stopping point" would report a fully-swapped drain as complete.
 *
 * AND "STILL HOLDING" IS ONLY EVER SAID OF AN ADDRESS WHOSE WHOLE HISTORY WAS
 * READ. On a busy address one page is a sliver, so "no onward transfer appeared"
 * is a statement about page size; dressed as custody it would name the wrong
 * address in somebody's report.
 *
 * @param {string} address the wallet value left from
 * @param {string} token which token to follow
 * @param {object} [options]
 * @returns {Promise<object>} an evidence envelope; never throws
 */
export async function traceFunds(address, token, options = {}) {
  const calls = withCalls(options);
  const checked = requireAddress(address, "where a wallet's funds went");
  if (!checked.ok) return checked;
  const origin = checked.value;

  try {
    const target = await resolveTokenTarget(token, calls);
    if (!target.ok) return target;
    const src = tracker();
    const decimals = Number.isFinite(Number(target.decimals)) ? Number(target.decimals) : 18;
    const symbol = target.symbol ?? null;

    // Pool addresses for this token, so a swap can be told from a payment. Absent
    // ones are NOT treated as "not a pool" — see poolStatus below.
    const poolInfo = await attempt(() =>
      tokenPoolAddresses(target.address, { calls, client: options?.client ?? null }),
    );
    const pools = poolInfo.ok && poolInfo.data?.pools instanceof Set ? poolInfo.data.pools : new Set();
    const v4Pool = poolInfo.ok ? (poolInfo.data?.v4?.address ?? null) : null;
    const poolStatus = poolInfo.ok ? (poolInfo.data?.status ?? "unread") : "unread";
    if (poolStatus !== "resolved" && poolStatus !== "none") src.miss("pools");

    /**
     * One page of an address's transfers of THIS token, matched locally too.
     *
     * RE-ASKED ONCE, because this indexer drops roughly a page in ten at random and
     * answers the retry. On the origin read a dropped page is the whole trace, and
     * on any other it turns a followable hop into "not read" — a blip becoming an
     * unknown in somebody's investigation. The token filter is passed AND applied
     * locally, because some deployments ignore the parameter.
     */
    const readOutbound = async (who) => {
      const res = await readPageWithRetry(
        () => calls.getTokenTransfers(who, { type: "ERC-20", token: target.address }, deadline(ENRICHMENT_TIMEOUT_MS)),
        { minMs: TRACE_PAGE_MIN_MS, label: "traceFunds" },
      );
      if (!res.ok || !res.value) return { ok: false, out: [], complete: false };
      const items = itemsOf(res.value).filter((i) => tokenAddressOf(i) === target.address);
      const out = items.filter((i) => lowerAddress(i?.from?.hash ?? i?.from) === who);
      return { ok: true, out, complete: !res.value?.next_page_params };
    };

    const first = await readOutbound(origin);
    if (!first.ok) {
      src.miss("transfers");
      return unavailableError(`where ${shortHex(origin)} sent its ${symbol ?? shortHex(target.address)}`, null);
    }

    const edges = [];
    let setOut = 0n;
    /** Addresses already opened, so a cycle cannot walk forever. */
    const visited = new Set([origin]);
    /** frontier: [{ address, amount }] for the next hop. */
    let frontier = [];

    for (const item of first.out) {
      const amount = rawAmount(item);
      const to = lowerAddress(item?.to?.hash ?? item?.to);
      if (amount === null || !to) continue;
      setOut += amount;
      frontier.push({ address: to, amount, hop: 1, hash: item?.transaction_hash ?? null, time: item?.timestamp ?? null });
    }

    let hopsWalked = 0;
    let branchesDropped = 0;

    for (let hop = 1; hop <= MAX_TRACE_HOPS && frontier.length; hop += 1) {
      hopsWalked = hop;
      // Biggest first: if the budget cuts this hop short, what is dropped is the
      // dust rather than the money.
      const ordered = [...frontier].sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
      const opening = ordered.slice(0, MAX_BRANCH_PER_HOP);
      const dropped = ordered.slice(MAX_BRANCH_PER_HOP);
      branchesDropped += dropped.length;
      for (const d of dropped) edges.push({ ...d, state: HOP.NOT_FOLLOWED });

      const outOfTime = outOfTimeFor(TRACE_HOP_MIN_MS);
      if (outOfTime) {
        noteBudgetSkip("further hops");
        for (const node of opening) edges.push({ ...node, state: HOP.NOT_FOLLOWED });
        frontier = [];
        break;
      }

      const results = await Promise.all(
        opening.map(async (node) => {
          const role = classifyRole(node.address, { token: target.address, pools, v4PoolManager: v4Pool });
          if (role.role === HOLDER_ROLES.BURN) return { node, state: HOP.BURNED };
          if (role.role === HOLDER_ROLES.CONTRACT) return { node, state: HOP.TOKEN_CONTRACT };
          if (role.role === HOLDER_ROLES.POOL) return { node, state: HOP.LEFT_THIS_TOKEN };
          if (node.address === origin) return { node, state: HOP.RETURNED };
          if (visited.has(node.address)) return { node, state: HOP.RETURNED };
          if (hop === MAX_TRACE_HOPS) return { node, state: HOP.NOT_FOLLOWED };
          const feed = await readOutbound(node.address);
          return { node, state: null, feed };
        }),
      );

      const nextFrontier = [];
      for (const { node, state, feed } of results) {
        if (state) {
          edges.push({ ...node, state });
          continue;
        }
        visited.add(node.address);
        if (!feed.ok) {
          edges.push({ ...node, state: HOP.NOT_READ });
          continue;
        }
        if (!feed.out.length) {
          // NOTHING WENT OUT — but that only means "still held" when the whole
          // history was read. Otherwise it is a fact about one page.
          edges.push({ ...node, state: feed.complete ? HOP.STILL_HELD : HOP.NOT_READ });
          continue;
        }
        if (!feed.complete) {
          // It moved on, but not all of its history is visible, so the amounts
          // below would not add up to what arrived.
          edges.push({ ...node, state: HOP.NOT_READ });
          continue;
        }

        // Split what arrived across where it went, proportionally, and never more
        // than arrived: an address that moved its own tokens as well as these
        // would otherwise attribute value to this trace that never came from it.
        let sentOn = 0n;
        for (const item of feed.out) sentOn += rawAmount(item) ?? 0n;
        let remaining = node.amount;
        edges.push({ ...node, state: HOP.FOLLOWED });
        for (const item of feed.out) {
          const moved = rawAmount(item);
          const to = lowerAddress(item?.to?.hash ?? item?.to);
          if (moved === null || !to || remaining <= 0n) continue;
          const share = sentOn > 0n && sentOn > node.amount ? (node.amount * moved) / sentOn : moved;
          const amount = share > remaining ? remaining : share;
          if (amount <= 0n) continue;
          remaining -= amount;
          nextFrontier.push({
            address: to,
            amount,
            hop: hop + 1,
            hash: item?.transaction_hash ?? null,
            time: item?.timestamp ?? null,
          });
        }
        // Anything this address received and did not pass on is still with it.
        if (remaining > 0n) edges.push({ ...node, amount: remaining, state: HOP.STILL_HELD });
      }
      frontier = nextFrontier;
    }

    // Anything still on the frontier when the hops ran out was never opened.
    for (const node of frontier) edges.push({ ...node, state: HOP.NOT_FOLLOWED });

    // FOLLOWED is a step rather than an ending, so it is not counted: the value it
    // represents is already counted at whatever its own children ended as.
    const endings = edges.filter((e) => e.state !== HOP.FOLLOWED);
    const books = reconcileTrace(endings, setOut);

    const rows = endings
      .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0))
      .slice(0, FLOW_TABLE_ROWS)
      .map((e, i) => ({
        rank: i + 1,
        hop: e.hop,
        address: e.address,
        amountDisplay: `${formatUnitsExact(e.amount, decimals)} ${symbol ?? shortHex(target.address)}`,
        ending: e.state,
        meaning: HOP_READING[e.state] ?? null,
        time: e.time,
        txHash: e.hash,
      }));

    const fmt = (v) => `${formatUnitsExact(v, decimals)} ${symbol ?? shortHex(target.address)}`;

    return {
      ok: true,
      kind: "trace",
      evidence: {
        ...src.gaps(),
        wallet: origin,
        token: { address: target.address, symbol, company: target.company ?? null },
        hopsWalked,
        maxHops: MAX_TRACE_HOPS,
        branchesNotFollowed: branchesDropped,
        // WHAT LEFT, AND WHERE IT ENDED — in four buckets that never merge.
        setOut: fmt(books.setOut),
        endedTerminal: fmt(books.terminal),
        endedInAPool: fmt(books.leftThisToken),
        returnedToOrigin: fmt(books.returned),
        trailOpen: fmt(books.open),
        reconciles: books.reconciles,
        unaccounted: books.reconciles ? null : fmt(books.unaccounted),
        poolsKnown: poolStatus === "resolved" || poolStatus === "none",
        poolNotice:
          poolStatus === "resolved" || poolStatus === "none"
            ? null
            : "This token's pools could not be identified, so a transfer into one may be listed as an ordinary address rather than as a trade.",
        endings: HOP_READING,
        reading: fundTraceReading({ books, fmt, symbol, origin, hopsWalked, poolStatus }),
        table: buildTable({
          id: "fund-trace",
          title: `Where ${symbol ?? shortHex(target.address)} went after leaving ${shortHex(origin)}`,
          columns: [
            col("rank", "#", "right"),
            col("hop", "Hop", "right"),
            col("address", "Address"),
            col("amountDisplay", "Amount", "right"),
            col("ending", "Ended as"),
            col("txHash", "Transaction"),
          ],
          rows,
          totalRows: endings.length,
          truncated: rows.length < endings.length,
          note: [
            `Followed ${hopsWalked} hop${hopsWalked === 1 ? "" : ""} of at most ${MAX_TRACE_HOPS}, at most ${MAX_BRANCH_PER_HOP} destinations per hop, largest first.`,
            "Value that reached a pool was TRADED and continues as another token, which this does not follow — it is counted separately and never as a completed trace.",
            "\"Still held\" is only said of an address whose whole history was read; where that was not possible the ending is \"not read\", which is not the same as holding.",
          ].join(" "),
        }),
      },
    };
  } catch (e) {
    return { ok: false, error: `Those funds could not be traced: ${String(e?.message ?? e).slice(0, 200)}.` };
  }
}

/** The finished sentence, with every bound already in it. */
function fundTraceReading({ books, fmt, symbol, origin, hopsWalked, poolStatus }) {
  const name = symbol ?? "this token";
  if (books.setOut === 0n) {
    return `No ${name} was seen leaving ${shortHex(origin)} in the transfers read, so there is nothing to follow.`;
  }
  const parts = [`${fmt(books.setOut)} left ${shortHex(origin)} and was followed ${hopsWalked} hop${hopsWalked === 1 ? "" : "s"}.`];
  if (books.terminal > 0n) parts.push(`${fmt(books.terminal)} reached a burn address or the token's own contract, or sits with an address whose whole history was read.`);
  if (books.leftThisToken > 0n) parts.push(`${fmt(books.leftThisToken)} went into a pool, which means it was traded rather than paid to anyone — the trail continues in another token and is not followed here.`);
  if (books.returned > 0n) parts.push(`${fmt(books.returned)} came back to an address already in the trace.`);
  if (books.open > 0n) parts.push(`${fmt(books.open)} is still open: either the receiving address has more history than could be read, or the trace ran out of hops before opening it. That is unknown, not held.`);
  if (!books.reconciles) parts.push(`These figures do not add up to what left (${fmt(books.unaccounted)} unaccounted), so treat them as indicative rather than exact.`);
  if (poolStatus !== "resolved" && poolStatus !== "none") parts.push("This token's pools could not be identified, so a trade may appear here as an ordinary transfer.");
  return parts.join(" ");
}

/* ------------------------------- value flows ------------------------------ */

/** Pages of the cross-token transfer feed, and the transfer ceiling across them. */
const MAX_FLOW_PAGES = 4;
export const MAX_FLOW_TRANSFERS = 200;

/**
 * Rows LISTED, which is far fewer than the rows counted.
 *
 * Smaller than TRACE_TABLE_ROWS because this feed carries a token per row and a
 * counterparty block beside it. Measured: at 200 rows the result serialised to
 * 71,318 characters against the 24,000 an answer is allowed, so the model was
 * handed JSON truncated partway through the rows and invented figures to finish
 * it — including dollar amounts, in a lookup that reads no price at all. The
 * counts, shares and tallies are all still computed over every transfer read.
 */
const FLOW_TABLE_ROWS = 20;

/**
 * The wallet's transfers across EVERY token, shaped for an investigation.
 *
 * traceRows() is the single-token version and carries no token field, because
 * trace_wallet already knows which token it asked about. Here the token is the
 * interesting part — funds leave in whatever they were last swapped into — so it
 * rides on every row.
 */
function flowRows(items, self) {
  const me = lowerAddress(self);
  return (Array.isArray(items) ? items : []).map((x, i) => {
    const decimals = finiteOrNull(x?.total?.decimals ?? x?.token?.decimals);
    const d = decimals ?? 18;
    const from = lowerAddress(x?.from?.hash ?? x?.from);
    const to = lowerAddress(x?.to?.hash ?? x?.to);
    const direction = from === me && to === me ? "self" : to === me ? "in" : from === me ? "out" : "other";
    return {
      rank: i + 1,
      time: x?.timestamp ?? null,
      timeMs: timeMs(x?.timestamp),
      direction,
      directionDisplay:
        direction === "in"
          ? "received"
          : direction === "out"
            ? "sent"
            : direction === "self"
              ? "self-transfer"
              : "unrelated",
      counterparty: direction === "in" ? from : direction === "out" ? to : (to ?? from),
      from,
      to,
      tokenAddress: lowerAddress(x?.token?.address_hash ?? x?.token?.address),
      tokenSymbol: sanitizeLabel(x?.token?.symbol) || null,
      amount: amountNumber(x?.total?.value, d),
      // THE UNIT TRAVELS WITH THE NUMBER, even though the table has its own token
      // column. Measured twice: a bare "0.0425" in this column came back to the
      // reader as "$0.0425 sent" — a dollar figure that exists nowhere in this
      // result and that nothing here could compute, since no price is read. A
      // number that cannot be rendered without its unit cannot be given a currency
      // symbol by mistake.
      // A token with no symbol falls back to its short contract rather than to
      // nothing: "0.0425" alone was still being rendered as "$0.0425", because a
      // bare number invites a unit and the reader's default unit is money. There is
      // no path here that produces a number without something after it.
      amountDisplay: `${fmtTokenAmount(x?.total?.value, d)} ${
        sanitizeLabel(x?.token?.symbol) ||
        (lowerAddress(x?.token?.address_hash ?? x?.token?.address)
          ? shortHex(lowerAddress(x?.token?.address_hash ?? x?.token?.address))
          : "units")
      }`,
      txHash: x?.transaction_hash ?? x?.tx_hash ?? null,
      decimalsAssumed: decimals === null,
    };
  });
}

/**
 * How many counterparties get read in their own right, and the floor to start one.
 *
 * Two calls each — the address record for whether it is a contract, and one page
 * of its transfers for how it behaves — so this is the expensive part of the
 * lookup and it is capped hard. Measured, an address record answers in 400-800ms.
 * A counterparty that was never probed comes back UNPROBED rather than ordinary:
 * "we did not look" and "we looked and it was unremarkable" are different facts and
 * the second one is a finding.
 */
const MAX_COUNTERPARTY_PROBES = 4;
const COUNTERPARTY_PROBE_MIN_MS = 3_000;

/**
 * Read the busiest counterparties in their own right.
 *
 * WHAT COMES BACK IS ESTABLISHED OR IT IS NOTHING. `isContract` is a field on the
 * address record, not an inference. The shape is computed by classifyShape from
 * that address's OWN feed — how many distinct addresses sent to it and how many it
 * sent to — which is the only honest basis for one; a shape guessed from how an
 * address looks inside somebody else's transfer list is a claim about a sample of
 * one relationship.
 *
 * @returns {Promise<{probes: Map<string, object>, probed: number, skipped: number}>}
 */
async function probeCounterparties(addresses, calls, sanitize) {
  const probes = new Map();
  let probed = 0;
  let skipped = 0;

  const wanted = addresses.slice(0, MAX_COUNTERPARTY_PROBES);
  // CHECKED ONCE, THEN EVERY PROBE RUNS AT ONCE. Sequentially this took 54s of a
  // 54s request budget — eight round trips end to end, each waiting on the last,
  // for work that has no ordering between addresses. Concurrently it is one round
  // trip's worth of wall clock, and the budget check that gates it stays honest
  // because the decision to probe at all is made before any of them start.
  if (wanted.length && outOfTimeFor(COUNTERPARTY_PROBE_MIN_MS)) {
    noteBudgetSkip("counterparty detail");
    return { probes, probed: 0, skipped: wanted.length };
  }

  const settled = await Promise.all(
    wanted.map(async (address) => {
      // Both calls for one address are independent too — awaiting them in sequence
      // inside the map was still serialising two round trips per counterparty.
      const [recordRes, feedRes] = await Promise.all([
        attempt(() => calls.getAddress(address, deadline(ENRICHMENT_TIMEOUT_MS))),
        attempt(() => calls.getTokenTransfers(address, { type: "ERC-20" }, deadline(ENRICHMENT_TIMEOUT_MS))),
      ]);
      return { address, recordRes, feedRes };
    }),
  );

  for (const { address, recordRes, feedRes } of settled) {
    // Neither answered: unknown, and it must not be mistaken for a quiet address.
    if (!recordRes.ok && !feedRes.ok) {
      probes.set(address, { read: false });
      skipped += 1;
      continue;
    }
    probed += 1;

    const senders = new Set();
    const recipients = new Set();
    let transfersSeen = 0;
    let feedComplete = false;
    if (feedRes.ok && feedRes.data) {
      const items = itemsOf(feedRes.data);
      transfersSeen = items.length;
      feedComplete = !feedRes.data?.next_page_params;
      for (const item of items) {
        const from = lowerAddress(item?.from?.hash ?? item?.from);
        const to = lowerAddress(item?.to?.hash ?? item?.to);
        if (from && from !== address) senders.add(from);
        if (to && to !== address) recipients.add(to);
      }
    }

    const shape = feedRes.ok
      ? classifyShape({
          distinctSenders: senders.size,
          distinctRecipients: recipients.size,
          transfersSeen,
          sampleComplete: feedComplete,
        })
      : { shape: null, confident: false, why: "this address's own transfers could not be read" };

    probes.set(address, {
      read: true,
      // A field on the record, not a guess. It is the single most useful thing to
      // know about a counterparty: a contract can be read, an EOA cannot.
      isContract: recordRes.ok && recordRes.data ? Boolean(recordRes.data.is_contract) : null,
      contractName: recordRes.ok ? sanitize(recordRes.data?.name) || null : null,
      distinctSenders: feedRes.ok ? senders.size : null,
      distinctRecipients: feedRes.ok ? recipients.size : null,
      transfersSeen: feedRes.ok ? transfersSeen : null,
      feedComplete,
      shape: shape.shape,
      shapeConfident: shape.confident,
      shapeWhy: shape.why,
      // More labels, from a record we were fetching anyway.
      label: recordRes.ok && recordRes.data ? (harvestTags(recordRes.data, sanitize).get(address) ?? null) : null,
    });
  }

  return { probes, probed, skipped };
}

/** The finished sentence, with the bound already inside it. */
function flowsReading({ self, rows, outRows, tally, concentration, truncated, lifetimeTransfers }) {
  if (!rows.length) {
    return `No ERC-20 transfers were returned for ${shortHex(self)}, so nothing about where its value moved could be read.`;
  }
  const scope = truncated
    ? `the ${rows.length} most recent transfer${rows.length === 1 ? "" : "s"}${
        lifetimeTransfers !== null ? ` of ${displayNumber(lifetimeTransfers, "count")}` : ""
      }`
    : `all ${rows.length} transfer${rows.length === 1 ? "" : "s"} the indexer holds for it`;
  const head = `Across ${scope}, ${shortHex(self)} sent ${tally.sent} and received ${tally.received}, dealing with ${tally.distinct} address${tally.distinct === 1 ? "" : "es"}.`;
  if (!outRows.length) return `${head} Nothing left this wallet in what was read.`;
  return concentration?.reading ? `${head} ${concentration.reading}` : head;
}

/**
 * Where value went and where it came from, across every token this wallet touched.
 *
 * THE QUESTION THIS ANSWERS is the one somebody asks after a drain: what left, when,
 * and to whom. trace_wallet answers it inside ONE token, which is the wrong shape for
 * it — funds leave in whatever they were last swapped into, so a single-token view
 * shows an emptied balance and none of the exits. wallet_counterparties ranks who an
 * address deals with but returns no transfers, so it cannot show the sequence.
 *
 * EVERY COUNT IS AGAINST WHAT WAS READ. The walk is capped, so "everything went to
 * one address" is a claim about the transfers in hand and says so; `historyComplete`
 * is the only thing that turns it into a claim about the wallet.
 *
 * @param {string} address the wallet
 * @param {object} [options]
 * @returns {Promise<object>} an evidence envelope; never throws
 */
export async function walletFlows(address, options = {}) {
  const calls = withCalls(options);
  const checked = requireAddress(address, "where a wallet's value went");
  if (!checked.ok) return checked;
  const self = checked.value;

  try {
    const src = tracker();
    const countersPromise = attempt(() => calls.getAddressCounters(self, deadline(ENRICHMENT_TIMEOUT_MS)));
    /*
     * THE TRANSACTIONS THIS WALLET ITSELF SIGNED, started alongside the walk.
     *
     * WHAT THIS IS: whether a transfer out left in a transaction this address
     * signed. WHAT IT IS NOT, and the distinction is the whole reason this comment
     * is long: it is NOT evidence that an allowance was abused. Somebody else's
     * signature on a transfer out is the ORDINARY case on this chain, not the
     * alarming one — measured lifetime transaction counts on the contracts that
     * produce it: SwapRouter02 37,345,937, UniversalRouter 6,565,967, Permit2
     * 1,699,424. Every DEX sell, every router swap, every Permit2 flow and every
     * smart-account operation is signed by something other than the wallet whose
     * tokens moved.
     *
     * So this is reported as what was read — who signed — and never as "an approval
     * you granted was used", which would tell somebody who sold through a router
     * last week that they had been robbed. It is also not a statement that any
     * allowance is still live: no allowance is read anywhere here, and claiming one
     * survives without calling allowance(owner, spender) would be inventing the
     * only part the reader would act on.
     *
     * One extra call rather than one per transfer: the wallet's own transaction
     * hashes are a set, and an outbound transfer is either in it or it is not.
     */
    const signedPromise = attempt(() => calls.getAddressTransactions(self, {}, deadline(TIMEOUT_MS)));

    let params = { type: "ERC-20" };
    const items = [];
    /** address -> harvested explorer tags, filled as pages arrive. */
    const labels = new Map();
    let pages = 0;
    let next = null;
    let cutShort = false;
    let cutShortReason = null;

    for (; pages < MAX_FLOW_PAGES; pages += 1) {
      const res = await readPageWithRetry(
        () => calls.getTokenTransfers(self, params, deadline(TIMEOUT_MS)),
        { minMs: TRACE_PAGE_MIN_MS, label: "walletFlows" },
      );
      if (!res.ok || !res.value) {
        if (pages === 0) {
          src.miss("transfers");
          return unavailableError(`where ${shortHex(self)} moved value`, res.status);
        }
        cutShort = true;
        cutShortReason = res.stoppedForTime
          ? `page ${pages + 1} of this wallet's transfers did not answer and the request had no time left to ask again`
          : `page ${pages + 1} of this wallet's transfers did not answer on ${res.attempts} attempt${res.attempts === 1 ? "" : "s"}`;
        break;
      }

      items.push(...itemsOf(res.value));
      // Harvested from the page ITSELF rather than from the shaped rows: the tags
      // live on the embedded from/to objects, which row shaping flattens away.
      for (const [hash, entry] of harvestTags(res.value, sanitizeLabel)) {
        if (!labels.has(hash)) labels.set(hash, entry);
      }
      next = cursorParams(res.value?.next_page_params);
      if (!next || items.length >= MAX_FLOW_TRANSFERS) break;
      const following = { ...next, type: "ERC-20" };
      if (sameParams(following, params)) {
        cutShort = true;
        cutShortReason = "the indexer returned the same page cursor twice, so the walk was stopped";
        break;
      }
      params = following;
    }

    const truncated = Boolean(next) || cutShort || items.length > MAX_FLOW_TRANSFERS;
    const rows = flowRows(items.slice(0, MAX_FLOW_TRANSFERS), self);
    const tally = tallyFlows(rows);
    const concentration = outboundConcentration(tally.counterparties, {
      sent: tally.sent,
      complete: !truncated,
    });

    const countersRes = await countersPromise;
    if (!countersRes.ok) src.miss("activity");
    const lifetimeTransfers = finiteOrNull(countersRes.data?.token_transfers_count);
    const lifetimeTransactions = finiteOrNull(countersRes.data?.transactions_count);

    /*
     * A HASH THAT IS ABSENT FROM AN INCOMPLETE LIST IS UNKNOWN, NOT ABSENT.
     *
     * The same discipline hasSold runs on, and it matters more here: "moved by
     * somebody else" is close to an accusation, and reading it off a page that
     * simply did not reach far enough would manufacture one. So `false` — this
     * wallet did sign it — is safe from a single page, but `true` is only ever
     * stated when the transaction list was read to its END and the hash still is
     * not in it. Otherwise the row is null, meaning nobody checked.
     */
    const signedRes = await signedPromise;
    if (!signedRes.ok) src.miss("signedTransactions");
    const signedHashes = new Set(
      (signedRes.data ? itemsOf(signedRes.data) : [])
        .map((t) => String(t?.hash ?? "").toLowerCase())
        .filter(Boolean),
    );
    const signedListComplete =
      signedRes.ok &&
      Boolean(signedRes.data) &&
      !signedRes.data?.next_page_params &&
      (lifetimeTransactions === null || signedHashes.size >= lifetimeTransactions);

    for (const row of rows) {
      if (row.direction !== "out") {
        row.signedBySelf = null;
        continue;
      }
      const hash = String(row.txHash ?? "").toLowerCase();
      if (!hash || !signedRes.ok || !signedRes.data) row.signedBySelf = null;
      else if (signedHashes.has(hash)) row.signedBySelf = true;
      else row.signedBySelf = signedListComplete ? false : null;
    }

    const outRows = rows.filter((r) => r.direction === "out");
    const thirdPartySigned = outRows.filter((r) => r.signedBySelf === false).length;
    const signerUnknown = outRows.filter((r) => r.signedBySelf === null).length;

    /*
     * ESTABLISHED ROLES ONLY, and every one of them is a lookup rather than a
     * guess: the burn addresses are two known constants, and the equity contracts
     * come from the on-disk issuer snapshot. Nothing here infers a role from
     * behaviour — the shapes that do that carry their alternatives with them.
     */
    const enriched = tally.counterparties.slice(0, PROSE_COUNTERPARTIES).map((c) => {
      const verified = snapshotByAddress(c.address);
      const isBurn = c.address === ZERO_ADDRESS || c.address === DEAD_ADDRESS;
      const label = labels.get(c.address) ?? null;
      return {
        ...c,
        // A transfer to a burn address is supply leaving, not a payment to anyone,
        // and it is a dead end for tracing rather than a lead.
        role: isBurn ? "burn" : verified ? "equity_contract" : null,
        roleReason: isBurn
          ? c.address === ZERO_ADDRESS
            ? "the zero address — tokens sent here are burned and belong to nobody"
            : "the 0x…dEaD burn address — tokens sent here are out of circulation"
          : verified
            ? "one of Robinhood's issuer-verified tokenized-equity contracts"
            : null,
        equity: verified?.symbol ?? null,
        issuerVerified: Boolean(verified) || isCanonicalStockAddress(c.address),
        label,
        labelReading: labelReading(label),
        // PRE-RENDERED, because the raw counts kept being narrated as money.
        // Measured three times against a live model: `transfersSentTo: 3` came back
        // to the reader as "$0.15 sent", and once as "$2,449.26 received" — figures
        // that exist nowhere in this result and that nothing here could compute,
        // since no price is read anywhere in this lookup. Renaming the fields and
        // forbidding it in the description both failed; a finished sentence with
        // the unit already in it gives the model something correct to copy, which
        // is the same reason amountDisplay and holdDisplay exist.
        summary: `${c.transfers} transfer${c.transfers === 1 ? "" : "s"} (${c.transfersReceivedFrom} in, ${c.transfersSentTo} out) across ${c.distinctTokens} token${c.distinctTokens === 1 ? "" : "s"} — counts, not amounts`,
      };
    });
    const labelled = enriched.filter((c) => c.labelReading).length;

    /*
     * THE BUSIEST COUNTERPARTIES, READ IN THEIR OWN RIGHT. Two calls apiece, so
     * only a handful, and only while there is budget for them. Everything below
     * distinguishes "not probed" from "probed and unremarkable" — the first is an
     * absence of looking and the second is a finding, and a reader deciding which
     * address to chase needs to know which one they are being given.
     */
    const { probes, probed, skipped } = await probeCounterparties(
      enriched.map((c) => c.address),
      calls,
      sanitizeLabel,
    );
    for (const c of enriched) {
      const p = probes.get(c.address);
      if (!p || !p.read) {
        c.probed = false;
        c.isContract = null;
        c.shape = null;
        c.shapeReading = null;
        c.detail = p ? "this address could not be read" : "this address was not read in its own right";
        continue;
      }
      c.probed = true;
      c.isContract = p.isContract;
      c.contractName = p.contractName;
      c.shape = p.shape;
      c.shapeConfident = p.shapeConfident;
      c.shapeWhy = p.shapeWhy;
      c.shapeReading = p.shape ? SHAPE_READING[p.shape] : null;
      // A label found on the address record itself beats one glimpsed in a feed.
      if (p.label) {
        c.label = p.label;
        c.labelReading = labelReading(p.label);
      }
      c.detail = [
        p.isContract === true
          ? `A contract${p.contractName ? ` (${p.contractName})` : ""} — its code can be read, and it is not a person's wallet.`
          : p.isContract === false
            ? "An ordinary address rather than a contract."
            : null,
        p.shape ? p.shapeWhy : `no shape could be established — ${p.shapeWhy}`,
      ]
        .filter(Boolean)
        .join(" ");
    }

    // Measured from this wallet's own feed: how many distinct addresses sent to it
    // and how many it sent to, over how many transfers, and whether that feed was
    // read to the end. Under the sample floor it returns no shape rather than a guess.
    const subjectShape = classifyShape({
      distinctSenders: tally.counterparties.filter((c) => c.transfersReceivedFrom > 0).length,
      distinctRecipients: tally.counterparties.filter((c) => c.transfersSentTo > 0).length,
      transfersSeen: rows.length,
      sampleComplete: !truncated,
    });
    const distinctTokens = new Set(rows.map((r) => r.tokenAddress).filter(Boolean)).size;

    /*
     * THE TABLE IS A SLICE, AND THE COUNTS ABOVE ARE NOT.
     *
     * Measured: the full 200-row feed serialised to 71,318 characters against the
     * 24,000 this result is allowed, so the model was handed JSON cut off partway
     * through the rows — and completed the missing structure by inventing figures,
     * including dollar amounts for a lookup that reads no prices at all. Every
     * count, tally and concentration figure is still computed over ALL the
     * transfers read; only the rows shown are capped, and the table says so.
     */
    const shownRows = rows.slice(0, FLOW_TABLE_ROWS);
    const table = buildTable({
      id: "wallet-flows",
      title: `${rows.length} transfer${rows.length === 1 ? "" : "s"} in and out of ${shortHex(self)}`,
      columns: [
        col("rank", "#", "right"),
        col("time", "Time"),
        col("directionDisplay", "Direction"),
        col("tokenSymbol", "Token"),
        col("amountDisplay", "Amount", "right"),
        col("counterparty", "Counterparty"),
        col("txHash", "Transaction"),
      ],
      rows: shownRows,
      totalRows: rows.length,
      truncated: truncated || shownRows.length < rows.length,
      note: [
        `Every ERC-20 transfer in or out of this address that the indexer returned, newest first, across ${distinctTokens} token${distinctTokens === 1 ? "" : "s"}.`,
        shownRows.length < rows.length
          ? `${rows.length} transfers were read and counted; the ${shownRows.length} most recent are listed. Every count and share above covers all ${rows.length}.`
          : null,
        truncated
          ? "The walk stopped before the end of this wallet's history, so these are its most recent transfers and not all of them."
          : "The walk reached the end of what the indexer holds for this wallet.",
        "A transfer is a movement and not a trade: an airdrop, a mint and a move between one owner's own addresses all appear here exactly as a sale does.",
      ]
        .filter(Boolean)
        .join(" "),
    });

    return {
      ok: true,
      kind: "flows",
      evidence: {
        ...src.gaps(),
        wallet: self,
        transfersRead: rows.length,
        pagesRead: Math.min(pages + 1, MAX_FLOW_PAGES),
        // The whole-life total, when the counter answered. It is what says whether
        // the sample above is most of the story or a sliver of it.
        lifetimeTransfers,
        historyComplete: !truncated,
        truncated,
        truncatedReason: cutShortReason,
        distinctTokens,
        sent: tally.sent,
        received: tally.received,
        selfTransfers: tally.selfTransfers,
        distinctCounterparties: tally.distinct,
        counterparties: enriched,
        counterpartiesLabelled: labelled,
        outboundConcentration: concentration,
        /*
         * THE SUBJECT WALLET'S OWN SHAPE, MEASURED — and only its own.
         *
         * The first version handed over the whole SHAPE_READING dictionary and let
         * the model decide which entry applied. It did exactly what that invites:
         * picked "received from many, sent to few" and narrated the victim's own
         * wallet as exchange-like, with no measurement behind the choice. A shape
         * is a classification of numbers, so it is computed here or not offered.
         *
         * Counterparties get no shape at all yet. Classifying one means reading ITS
         * activity — a call apiece — and a label guessed from how it appears in this
         * wallet's feed alone would be exactly the unmeasured claim this replaces.
         */
        shape: subjectShape.shape,
        shapeConfident: subjectShape.confident,
        shapeWhy: subjectShape.why,
        shapeReading: subjectShape.shape ? SHAPE_READING[subjectShape.shape] : null,
        /*
         * WHO SIGNED THE TRANSFERS OUT — a reading, not an alarm. Somebody else's
         * signature is the ORDINARY case here: every router swap, Permit2 flow and
         * smart-account operation produces it, and the routers that do so have tens
         * of millions of transactions between them. It is reported because an
         * unexpected one is a thread worth pulling, and it is reported this way
         * because the alarming version would tell everyone who has ever sold
         * through a router that they had been robbed.
         */
        outboundSignedBySelf: outRows.length - thirdPartySigned - signerUnknown,
        outboundSignedByThirdParty: thirdPartySigned,
        outboundSignerUnknown: signerUnknown,
        signerNotice:
          outRows.length === 0
            ? null
            : `Of ${outRows.length} transfer${outRows.length === 1 ? "" : "s"} out, ${thirdPartySigned} left in a transaction this address did not sign${
                signerUnknown > 0 ? ` and ${signerUnknown} could not be checked against its transaction list` : ""
              }. That is ordinary rather than alarming on its own — a router, an aggregator or a smart account signs on the owner's behalf in most trades. It says who submitted the transaction, and nothing about whether any approval is still live, which is not read here.`,
        reading: flowsReading({ self, rows, outRows, tally, concentration, truncated, lifetimeTransfers }),
        table,
      },
    };
  } catch (e) {
    return { ok: false, error: `That wallet's transfers could not be read: ${String(e?.message ?? e).slice(0, 200)}.` };
  }
}
