// Tests for the five wallet-and-market lookups (lib/wallet-evidence.js, plus
// whaleMoves in lib/token-evidence.js and topMovers in lib/market-evidence.js)
// and the arguments they are reached through (lib/ask-tools.js).
//
// Four things are being defended here, and every one of them is a specific
// sentence this product must never be able to produce.
//
//  1. "THIS WALLET'S SMALLEST POSITION IS X." A token nobody quotes has no
//     value, and coercing that to $0 both sorts it to the bottom of a portfolio
//     and drags the total down. Unpriced rows sort LAST without being called
//     small, and the total says how many holdings it could not value.
//  2. "THIS WALLET HAS NEVER SOLD." trace_wallet walks a capped history, so the
//     absence of a sale in what it read is not the absence of a sale. hasSold is
//     true, false or NULL, and only a walk that reached the end of the history
//     may return false.
//  3. "ITS BIGGEST COUNTERPARTY IS X." The counterparty tally is over a recent
//     sample, and the evidence has to carry what was sampled and what the
//     address's real totals are.
//  4. "NOTHING IS TRADING." An equity the indexer published no volume for is
//     unmeasured, not idle: top_movers counts those out loud rather than
//     ranking them last at zero.
//
// Plus the coercion, which is where a model's malformed call becomes either a
// valid lookup or a sentence it can act on — trace_wallet especially, because it
// is the only tool in the catalogue that needs TWO arguments in one object.
//
// Fully offline. Every lookup injects fake indexer calls through `calls`, and
// every dispatchTool call injects fake data modules through the third argument,
// so nothing in this file can reach Blockscout.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TOOL_NAMES,
  TOOL_SCHEMAS,
  coerceCounterpartyArgs,
  coerceMoverArgs,
  coercePortfolioArgs,
  coerceTraceArgs,
  coerceWhaleArgs,
  dispatchTool,
  toolSubject,
} from "../lib/ask-tools.js";
import {
  MAX_COUNTERPARTY_ROWS,
  clampCount,
  counterpartyRows,
  portfolioRows,
  traceRows,
  traceWallet,
  walletCounterparties,
  walletFlows,
  walletPortfolio,
} from "../lib/wallet-evidence.js";
import { whaleMoves } from "../lib/token-evidence.js";
import { buildMovers, compareByField, metricOrNull, topMovers } from "../lib/market-evidence.js";
import { PHRASE_STEPS, progressLabel, stepForTool } from "../lib/thinking-phrases.js";
import { isTable } from "../lib/table-shape.js";

/** A snapshotted, issuer-verified equity contract — Apple's, from the registry. */
const AAPL = "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9";
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const TX_HASH = `0x${"ab".repeat(32)}`;
const ZERO = `0x${"0".repeat(40)}`;
const WALLET = (n) => `0x${String(n).padStart(40, "0")}`;
const SELF = WALLET(1);

/** 18-decimal base units for a whole-token amount. */
const units = (n) => `${BigInt(Math.round(n * 1000))}${"0".repeat(15)}`;

const paramsOf = (name) => TOOL_SCHEMAS.find((s) => s.function.name === name).function.parameters;

/**
 * Indexer stand-in. Every getter left undefined throws, so a lookup that reaches
 * for a call this test did not script fails loudly instead of silently hitting
 * the network.
 */
function chain(overrides = {}) {
  const boom = (name) => () => Promise.reject(new Error(`unscripted call: ${name}`));
  return {
    getAddress: boom("getAddress"),
    getAddressCounters: boom("getAddressCounters"),
    getAddressTokenBalances: boom("getAddressTokenBalances"),
    getAddressTransactions: boom("getAddressTransactions"),
    getTokenTransfers: boom("getTokenTransfers"),
    listStockTokens: () => Promise.resolve([]),
    resolveSymbol: () => Promise.resolve({ ok: false, match: null }),
    snapshotMatch: () => null,
    ...overrides,
  };
}

/** One /addresses/{a}/token-balances entry. */
const balance = (symbol, address, whole, rate) => ({
  value: units(whole),
  token: { symbol, name: `${symbol} token`, address, decimals: "18", exchange_rate: rate },
});

/** One /addresses/{a}/token-transfers entry, keyed to a token contract. */
const transfer = (from, to, whole, timestamp, token = NVDA) => ({
  from: { hash: from },
  to: { hash: to },
  total: { value: units(whole), decimals: "18" },
  timestamp,
  transaction_hash: TX_HASH,
  token: { address: token, decimals: "18", symbol: "NVDA" },
});

/** A registry row, as lib/stock-tokens.js shapes one. */
const stock = (symbol, extra = {}) => ({
  symbol,
  company: `${symbol} Inc`,
  address: WALLET(symbol.length + 20),
  price: 10,
  marketCap: 1000,
  holders: 100,
  volume24h: 500,
  ...extra,
});

/* ============================ the catalogue ============================ */

test("the five wallet-and-market tools are registered with usable schemas", () => {
  for (const name of ["wallet_portfolio", "trace_wallet", "wallet_counterparties", "whale_moves", "top_movers"]) {
    assert.ok(TOOL_NAMES.includes(name), `${name} is missing from TOOL_NAMES`);
  }
  assert.deepEqual(paramsOf("wallet_portfolio").required, ["address"]);
  assert.deepEqual(paramsOf("trace_wallet").required, ["address", "token"], "a trace needs both halves");
  assert.deepEqual(paramsOf("wallet_counterparties").required, ["address"]);
  assert.deepEqual(paramsOf("whale_moves").required, ["query"]);
  assert.deepEqual(paramsOf("top_movers").required, [], "what's moving is answerable with no arguments");
  assert.equal(paramsOf("wallet_counterparties").properties.limit.maximum, MAX_COUNTERPARTY_ROWS);
  assert.equal(paramsOf("whale_moves").properties.limit.maximum, 25);
  assert.deepEqual(paramsOf("top_movers").properties.metric.enum, ["volume24h", "marketCap", "holders", "price"]);
});

test("the descriptions carry the bound each tool's answer depends on", () => {
  const d = (name) => TOOL_SCHEMAS.find((s) => s.function.name === name).function.description;
  // Each of these is the sentence that stops a true result becoming a false claim.
  assert.match(d("wallet_portfolio"), /never worthless|unpriced/i);
  assert.match(d("trace_wallet"), /never as "never sold"|UNKNOWN/);
  assert.match(d("wallet_counterparties"), /not its whole life|LATELY/i);
  assert.match(d("whale_moves"), /never the largest in the token's history/i);
  assert.match(d("top_movers"), /not zero activity|unmeasured/i);
});

test("each new tool names its own kind of work in the status line", () => {
  assert.equal(stepForTool("wallet_portfolio"), PHRASE_STEPS.PORTFOLIO);
  assert.equal(stepForTool("trace_wallet"), PHRASE_STEPS.TRACE);
  assert.equal(stepForTool("wallet_counterparties"), PHRASE_STEPS.COUNTERPARTIES);
  assert.equal(stepForTool("whale_moves"), PHRASE_STEPS.WHALES);
  assert.equal(stepForTool("top_movers"), PHRASE_STEPS.MOVERS);
});

test("the status subject comes off the coerced arguments, and a trace names both halves", () => {
  assert.equal(toolSubject("wallet_portfolio", { wallet: SELF }), "0x0000…0001");
  assert.equal(toolSubject("wallet_counterparties", { address: SELF }), "0x0000…0001");
  assert.equal(toolSubject("whale_moves", { symbol: "$nvda" }), "NVDA");
  // "tracing NVDA" does not say whose position and "tracing 0x…" does not say in
  // what, so the subject carries both — and still fits the status row.
  assert.equal(toolSubject("trace_wallet", { address: SELF, token: "nvda" }), "NVDA in 0x0000…0001");
  assert.ok(progressLabel(PHRASE_STEPS.TRACE, toolSubject("trace_wallet", { address: SELF, token: "nvda" })).length <= 64);
  assert.equal(toolSubject("top_movers", {}), "24h volume", "no arguments still names the axis");
  assert.equal(toolSubject("trace_wallet", { token: "nvda" }), null, "half a call has no honest subject");
});

/* ============================== coercion ============================== */

test("the wallet coercers take only a 40-hex address and redirect everything else", () => {
  for (const coerce of [coercePortfolioArgs, coerceCounterpartyArgs]) {
    assert.equal(coerce({ address: SELF }).value, SELF);
    assert.equal(coerce({ wallet: SELF }).value, SELF, "the wrong key still carries it");
    assert.equal(coerce(SELF).value, SELF, "a bare string instead of an object");
    assert.match(coerce({ address: "nvda" }).error, /lookup_token/, "a ticker is redirected, not just refused");
    assert.match(coerce({ address: TX_HASH }).error, /lookup_transaction/);
    assert.match(coerce({ address: `${SELF}ff` }).error, /40 hex/);
    for (const args of [undefined, null, {}, "", "   ", { address: "" }, []]) {
      assert.equal(coerce(args).ok, false);
    }
  }
  assert.match(coercePortfolioArgs({}).error, /wallet_portfolio/);
  assert.match(coerceCounterpartyArgs({}).error, /wallet_counterparties/);
});

test("a counterparty row count is clamped rather than failing the call", () => {
  assert.equal(coerceCounterpartyArgs({ address: SELF }).limit, 15);
  assert.equal(coerceCounterpartyArgs({ address: SELF, limit: 999 }).limit, MAX_COUNTERPARTY_ROWS);
  assert.equal(coerceCounterpartyArgs({ address: SELF, limit: 0 }).limit, 1);
  assert.equal(coerceCounterpartyArgs({ address: SELF, count: 5 }).limit, 5);
  assert.equal(coerceCounterpartyArgs({ address: SELF, limit: "loads" }).limit, 15);
  for (const raw of [undefined, null, "", "x", {}, [], true, NaN, Infinity, 1e9, -1e9]) {
    const n = clampCount(raw, 15, 50);
    assert.ok(Number.isInteger(n) && n >= 1 && n <= 50, `clampCount(${JSON.stringify(raw)}) = ${n}`);
  }
});

test("trace_wallet gets both halves out of whichever keys the model used", () => {
  assert.deepEqual(coerceTraceArgs({ address: SELF, token: "nvda" }), { ok: true, address: SELF, token: "nvda" });
  assert.deepEqual(coerceTraceArgs({ wallet: SELF, symbol: "$tsla" }), { ok: true, address: SELF, token: "$tsla" });
  // The address hiding under `query` while the ticker sits under `symbol`.
  assert.deepEqual(coerceTraceArgs({ query: SELF, symbol: "nvda" }), { ok: true, address: SELF, token: "nvda" });
  assert.deepEqual(coerceTraceArgs({ address: SELF, contract: NVDA }), { ok: true, address: SELF, token: NVDA });
  assert.equal(coerceTraceArgs({ address: SELF, company: "coca  cola" }).token, "coca cola");
});

test("trace_wallet refuses half a call, and names the tool that answers it instead", () => {
  const noToken = coerceTraceArgs({ address: SELF });
  assert.equal(noToken.ok, false);
  assert.match(noToken.error, /wallet_portfolio/, "a wallet with no token is a portfolio question");
  const noWallet = coerceTraceArgs({ token: "nvda" });
  assert.equal(noWallet.ok, false);
  assert.match(noWallet.error, /trace_wallet/);
  // One value cannot be both halves: an address alone is not a trace of itself.
  assert.equal(coerceTraceArgs({ query: SELF }).ok, false);
  assert.equal(coerceTraceArgs(SELF).ok, false);
  for (const args of [undefined, null, {}, "", [], { address: "nvda", token: "tsla" }]) {
    assert.equal(coerceTraceArgs(args).ok, false);
  }
  assert.match(coerceTraceArgs({ address: SELF, token: TX_HASH }).error, /lookup_transaction/);
  assert.match(coerceTraceArgs({ address: SELF, token: "0xabc123" }).error, /40 hex/);
  assert.match(coerceTraceArgs({ address: SELF, token: "a".repeat(200) }).error, /whole question/);
});

test("whale_moves takes the same token target as the other token tools", () => {
  assert.equal(coerceWhaleArgs({ query: "nvda" }).value, "nvda");
  assert.equal(coerceWhaleArgs({ symbol: "$tsla" }).value, "$tsla");
  assert.equal(coerceWhaleArgs("nvidia").value, "nvidia");
  assert.equal(coerceWhaleArgs({ query: "nvda" }).limit, 15);
  assert.equal(coerceWhaleArgs({ query: "nvda", limit: 999 }).limit, 25, "its own tighter bound");
  assert.equal(coerceWhaleArgs({ query: "nvda", top: 3 }).limit, 3);
  assert.match(coerceWhaleArgs({ query: "0xabc123" }).error, /40 hex/);
  assert.match(coerceWhaleArgs({}).error, /whale_moves/);
});

test("top_movers defaults to activity, not to size", () => {
  // resolveMetric falls back to market cap for anything it does not recognize,
  // which would answer "what's moving" with a size ranking.
  assert.deepEqual(coerceMoverArgs(undefined), { metric: "volume24h", limit: 10 });
  assert.deepEqual(coerceMoverArgs({}), { metric: "volume24h", limit: 10 });
  assert.deepEqual(coerceMoverArgs("nonsense"), { metric: "volume24h", limit: 10 });
  assert.equal(coerceMoverArgs({ metric: "banana" }).metric, "volume24h");
  // The words a model reaches for still resolve.
  assert.equal(coerceMoverArgs({ metric: "market cap" }).metric, "marketCap");
  assert.equal(coerceMoverArgs({ by: "owners" }).metric, "holders");
  assert.equal(coerceMoverArgs({ metric: "price" }).metric, "price");
  assert.equal(coerceMoverArgs({ limit: 999 }).limit, 25);
  assert.equal(coerceMoverArgs({ limit: 0 }).limit, 1);
  assert.equal(coerceMoverArgs({ count: 3 }).limit, 3);
  assert.equal(metricOrNull("banana"), null, "the null is what lets two tools keep two defaults");
});

/* ============================= the dispatcher ============================= */

function toolFakes() {
  const calls = [];
  const log = (name, result) => (...args) => {
    calls.push({ name, args });
    return Promise.resolve(result);
  };
  return {
    calls,
    impls: {
      walletPortfolio: log("walletPortfolio", { ok: true, kind: "portfolio", evidence: {} }),
      traceWallet: log("traceWallet", { ok: true, kind: "trace", evidence: {} }),
      walletCounterparties: log("walletCounterparties", { ok: true, kind: "counterparties", evidence: {} }),
      whaleMoves: log("whaleMoves", { ok: true, kind: "whales", evidence: {} }),
      topMovers: log("topMovers", { ok: true, kind: "movers", evidence: {} }),
    },
  };
}

test("dispatchTool hands each wallet-and-market tool its coerced arguments", async () => {
  const portfolio = toolFakes();
  assert.equal((await dispatchTool("wallet_portfolio", { wallet: SELF }, portfolio.impls)).kind, "portfolio");
  assert.deepEqual(portfolio.calls, [{ name: "walletPortfolio", args: [SELF] }]);

  const trace = toolFakes();
  await dispatchTool("trace_wallet", { address: SELF, symbol: "$nvda" }, trace.impls);
  assert.deepEqual(trace.calls, [{ name: "traceWallet", args: [SELF, "$nvda"] }]);

  const counter = toolFakes();
  await dispatchTool("wallet_counterparties", { address: SELF, limit: 999 }, counter.impls);
  assert.deepEqual(counter.calls, [{ name: "walletCounterparties", args: [SELF, { limit: MAX_COUNTERPARTY_ROWS }] }]);

  const whales = toolFakes();
  await dispatchTool("whale_moves", "nvda", whales.impls);
  assert.deepEqual(whales.calls, [{ name: "whaleMoves", args: ["nvda", { limit: 15 }] }]);

  const movers = toolFakes();
  await dispatchTool("top_movers", { metric: "banana", limit: 3 }, movers.impls);
  assert.deepEqual(movers.calls, [{ name: "topMovers", args: [{ metric: "volume24h", limit: 3 }] }]);
});

test("a badly formed wallet-side call spends no indexer time", async () => {
  for (const [tool, args] of [
    ["wallet_portfolio", { address: "0xabc" }],
    ["trace_wallet", { address: SELF }],
    ["trace_wallet", { token: "nvda" }],
    ["wallet_counterparties", {}],
    ["whale_moves", { query: TX_HASH }],
  ]) {
    const { impls, calls } = toolFakes();
    const res = await dispatchTool(tool, args, impls);
    assert.equal(res.ok, false, `${tool} accepted junk`);
    assert.equal(typeof res.error, "string");
    assert.deepEqual(calls, [], `${tool} called downstream on a bad argument`);
  }
});

test("a thrown wallet-side gatherer becomes an error the model can answer around", async () => {
  const boom = () => Promise.reject(new Error("socket hang up"));
  for (const [tool, args, key] of [
    ["wallet_portfolio", { address: SELF }, "walletPortfolio"],
    ["trace_wallet", { address: SELF, token: "nvda" }, "traceWallet"],
    ["wallet_counterparties", { address: SELF }, "walletCounterparties"],
    ["whale_moves", { query: "nvda" }, "whaleMoves"],
    ["top_movers", {}, "topMovers"],
  ]) {
    const { impls } = toolFakes();
    const res = await dispatchTool(tool, args, { ...impls, [key]: boom });
    assert.equal(res.ok, false, `${tool} let an exception escape`);
    assert.match(res.error, /socket hang up/);
    assert.match(res.error, /rather than guessing/);
  }
});

/* ============================== portfolio ============================== */

const portfolioChain = (extra = {}) =>
  chain({
    getAddress: () => Promise.resolve({ hash: SELF, is_contract: false, coin_balance: "1500000000000000000" }),
    getAddressCounters: () => Promise.resolve({ transactions_count: "42", token_transfers_count: "19" }),
    getAddressTokenBalances: () =>
      Promise.resolve([
        balance("NVDA", NVDA, 10, "100"),
        balance("JUNK", WALLET(6), 1_000_000, null),
        balance("AAPL", AAPL, 5, "400"),
      ]),
    ...extra,
  });

test("wallet_portfolio emits a table sorted by value with the unpriced last", async () => {
  const res = await walletPortfolio(SELF, { calls: portfolioChain() });

  assert.equal(res.ok, true);
  assert.equal(res.kind, "portfolio");
  const t = res.evidence.table;
  assert.ok(isTable(t), "a renderer must be able to draw it");
  assert.equal(t.id, "wallet-portfolio");
  assert.deepEqual(t.columns.map((c) => c.key), ["rank", "symbol", "amountDisplay", "priceDisplay", "valueDisplay", "address"]);
  // A million unpriced tokens is not the smallest position in the wallet.
  assert.deepEqual(t.rows.map((r) => r.symbol), ["AAPL", "NVDA", "JUNK"]);
  assert.equal(t.rows[0].valueDisplay, "$2.00K");
  assert.equal(t.rows[2].valueDisplay, null, "an unpriced holding has no value, not a zero one");
  assert.equal(t.rows[2].priceDisplay, null);
  assert.equal(t.totalRows, 3);
  assert.equal(t.truncated, false);
  assert.equal(res.evidence.balanceEthDisplay, "1.5 ETH");
  // Two of the three are snapshotted equity contracts; the made-up one is not.
  assert.equal(res.evidence.issuerVerifiedHoldings, 2);
  assert.equal(res.evidence.holdings.find((h) => h.symbol === "JUNK").issuerVerified, false);
});

test("the portfolio total covers the priced holdings only, and says how many it could not value", async () => {
  const res = await walletPortfolio(SELF, { calls: portfolioChain() });
  // $2,000 of AAPL + $1,000 of NVDA. The million JUNK is not $0 and not counted.
  assert.equal(res.evidence.totalValueUsd, 3000);
  assert.equal(res.evidence.totalValueDisplay, "$3.00K");
  assert.equal(res.evidence.pricedCount, 2);
  assert.equal(res.evidence.unpricedCount, 1);
  assert.match(res.evidence.valuationNote, /could not be valued/);
  assert.match(res.evidence.valuationNote, /not worthless/);
  assert.match(res.evidence.table.note, /unpriced is not zero-value/);
});

test("a portfolio with nothing priced has an unknown total, never a zero one", async () => {
  const res = await walletPortfolio(SELF, {
    calls: portfolioChain({
      getAddressTokenBalances: () => Promise.resolve([balance("JUNK", WALLET(6), 5, null)]),
    }),
  });
  assert.equal(res.evidence.totalValueUsd, null, "nothing priced is not a portfolio worth $0");
  assert.equal(res.evidence.totalValueDisplay, null);
  assert.equal(res.evidence.pricedCount, 0);
  assert.equal(res.evidence.unpricedCount, 1);
});

test("a balances call that failed is an outage, never \"this wallet holds nothing\"", async () => {
  const res = await walletPortfolio(SELF, {
    calls: portfolioChain({ getAddressTokenBalances: () => Promise.reject(new Error("timeout")) }),
  });
  // The overview landed, so there is still an ETH balance to report.
  assert.equal(res.ok, true);
  assert.equal(res.evidence.holdings, null, "null, not [] — [] would assert an empty wallet");
  assert.equal(res.evidence.holdingsRead, null);
  assert.equal(res.evidence.totalValueUsd, null);
  assert.equal(res.evidence.table, undefined, "an empty table would draw a wallet holding nothing");
  assert.ok(res.evidence.unavailable.includes("holdings"));

  const both = await walletPortfolio(SELF, {
    calls: chain({
      getAddress: () => Promise.reject(Object.assign(new Error("gateway"), { status: 502 })),
      getAddressTokenBalances: () => Promise.reject(new Error("timeout")),
      getAddressCounters: () => Promise.reject(new Error("timeout")),
    }),
  });
  assert.equal(both.ok, false);
  assert.match(both.error, /unknown, not absent/);
  assert.match(both.error, /502/);
});

test("a wallet the indexer returns no balances for is a measured empty wallet", async () => {
  const res = await walletPortfolio(SELF, {
    calls: portfolioChain({ getAddressTokenBalances: () => Promise.resolve([]) }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.evidence.holdingsRead, 0, "a body that arrived saying nothing is a real answer");
  assert.deepEqual(res.evidence.holdings, []);
  assert.match(res.evidence.valuationNote, /not a failed lookup/);
});

test("portfolioRows never emits a nested cell and keeps unknowns unknown", () => {
  const rows = portfolioRows([
    balance("NVDA", NVDA, 10, "100"),
    { value: null, token: {} },
    "not an object",
  ]);
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      assert.ok(
        value === null || ["string", "number", "boolean"].includes(typeof value),
        `${key} is a ${typeof value}, which renders as "[object Object]"`,
      );
    }
  }
  assert.deepEqual(portfolioRows(null), []);
  assert.deepEqual(portfolioRows(undefined), []);
});

/* ================================ trace ================================ */

const traceChain = (transfers, extra = {}) =>
  chain({
    snapshotMatch: () => ({ symbol: "NVDA", company: "NVIDIA", address: NVDA }),
    getAddressTokenBalances: () => Promise.resolve([balance("NVDA", NVDA, 30, "10")]),
    getTokenTransfers: () => Promise.resolve(transfers),
    ...extra,
  });

test("trace_wallet counts both sides and, on a complete history, may say it never sold", async () => {
  const res = await traceWallet(SELF, "NVDA", {
    calls: traceChain({
      items: [
        transfer(WALLET(9), SELF, 10, "2026-07-27T10:00:00Z"),
        transfer(WALLET(8), SELF, 20, "2026-07-26T10:00:00Z"),
        // Another token in the same feed: matched on the contract, so dropped.
        transfer(WALLET(3), SELF, 99, "2026-07-25T10:00:00Z", WALLET(77)),
      ],
    }),
  });

  assert.equal(res.ok, true);
  assert.equal(res.kind, "trace");
  assert.equal(res.evidence.transfersRead, 2);
  assert.equal(res.evidence.transfersScanned, 3, "the other token was read and not counted");
  assert.equal(res.evidence.buys, 2);
  assert.equal(res.evidence.sells, 0);
  assert.equal(res.evidence.netPosition, 30);
  assert.equal(res.evidence.historyComplete, true);
  assert.equal(res.evidence.hasSold, false, "the walk reached the end, so false is earned");
  assert.match(res.evidence.reading, /accumulated and never distributed/);
  assert.equal(res.evidence.firstSeen, "2026-07-26T10:00:00.000Z");
  assert.equal(res.evidence.lastSeen, "2026-07-27T10:00:00.000Z");
  assert.equal(res.evidence.currentBalance.amount, 30);
  const t = res.evidence.table;
  assert.ok(isTable(t));
  assert.equal(t.id, "wallet-trace");
  assert.deepEqual(t.columns.map((c) => c.key), ["rank", "time", "directionDisplay", "counterparty", "amountDisplay", "txHash"]);
  assert.equal(t.rows[0].directionDisplay, "received");
  assert.equal(t.rows[0].counterparty, WALLET(9));
});

test("a truncated history cannot say a wallet never sold — hasSold goes unknown", async () => {
  let page = 0;
  const res = await traceWallet(SELF, "NVDA", {
    calls: traceChain(null, {
      getTokenTransfers: () =>
        Promise.resolve({
          items: [transfer(WALLET(9), SELF, 10, "2026-07-27T10:00:00Z")],
          next_page_params: { index: (page += 1) },
        }),
    }),
  });

  assert.equal(res.evidence.buys, 3, "the walk is capped at three pages");
  assert.equal(res.evidence.sells, 0);
  assert.equal(res.evidence.truncated, true);
  assert.equal(res.evidence.historyComplete, false);
  assert.equal(res.evidence.hasSold, null, "no sale in a partial history is UNKNOWN, not never");
  assert.equal(res.evidence.soldInSample, false);
  assert.match(res.evidence.reading, /unknown rather than no/);
  assert.doesNotMatch(res.evidence.reading, /never distributed/);
  assert.equal(res.evidence.table.truncated, true);
});

test("a sale anywhere in the sample is a sale, and the net reflects both sides", async () => {
  const res = await traceWallet(SELF, "NVDA", {
    calls: traceChain({
      items: [
        transfer(SELF, WALLET(9), 5, "2026-07-27T10:00:00Z"),
        transfer(WALLET(8), SELF, 20, "2026-07-26T10:00:00Z"),
      ],
    }),
  });
  assert.equal(res.evidence.buys, 1);
  assert.equal(res.evidence.sells, 1);
  assert.equal(res.evidence.hasSold, true);
  assert.equal(res.evidence.netPosition, 15);
  assert.equal(res.evidence.sent.total, 5);
  assert.equal(res.evidence.received.total, 20);
  assert.match(res.evidence.reading, /not a wallet that has only ever accumulated/);
});

test("a wallet with no transfers of the token is only \"never touched it\" on a full walk", async () => {
  const clean = await traceWallet(SELF, "NVDA", { calls: traceChain({ items: [] }) });
  assert.equal(clean.evidence.transfersRead, 0);
  assert.equal(clean.evidence.hasSold, false);
  assert.match(clean.evidence.reading, /no transfers of NVDA/);

  const partial = await traceWallet(SELF, "NVDA", {
    calls: traceChain({ items: [transfer(WALLET(2), WALLET(3), 1, "2026-07-27T10:00:00Z", WALLET(77))], next_page_params: { index: 1 } }),
  });
  assert.equal(partial.evidence.transfersRead, 0);
  assert.equal(partial.evidence.hasSold, null);
  assert.match(partial.evidence.reading, /none found in the sample/);
});

test("a transfers call that never answered is an outage, not an untouched wallet", async () => {
  const res = await traceWallet(SELF, "NVDA", {
    calls: traceChain(null, {
      getTokenTransfers: () => Promise.reject(Object.assign(new Error("gateway"), { status: 502 })),
    }),
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /unknown, not absent/);
  assert.match(res.error, /502/);
});

test("trace_wallet refuses anything that is not an address, and reports an unresolved token honestly", async () => {
  const bad = await traceWallet("nvda", "NVDA", { calls: chain() });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /40 hex/);

  // resolveSymbol reports "no token matching X" both when the ticker does not
  // exist and when nothing answered at all; an empty registry means the latter.
  const down = await traceWallet(SELF, "ZZZZ", {
    calls: chain({ resolveSymbol: () => Promise.resolve({ ok: false, match: null }), listStockTokens: () => Promise.resolve([]) }),
  });
  assert.equal(down.ok, false);
  assert.match(down.error, /unknown, not absent/);
});

test("traceRows reads direction from the wallet's own point of view", () => {
  const rows = traceRows(
    [
      transfer(WALLET(9), SELF, 10, "2026-07-27T10:00:00Z"),
      transfer(SELF, WALLET(9), 4, "2026-07-27T11:00:00Z"),
      transfer(SELF, SELF, 1, "2026-07-27T12:00:00Z"),
      transfer(WALLET(2), WALLET(3), 1, "2026-07-27T13:00:00Z"),
    ],
    SELF,
  );
  assert.deepEqual(rows.map((r) => r.direction), ["in", "out", "self", "other"]);
  assert.deepEqual(rows.map((r) => r.directionDisplay), ["received", "sent", "self-transfer", "unrelated"]);
  assert.equal(rows[0].counterparty, WALLET(9));
  assert.deepEqual(traceRows(null, SELF), []);
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      assert.ok(value === null || ["string", "number", "boolean"].includes(typeof value), `${key} is a ${typeof value}`);
    }
  }
});

/* ============================ counterparties ============================ */

test("wallet_counterparties ranks by interaction count and names the equity contracts", async () => {
  const res = await walletCounterparties(SELF, {
    limit: 5,
    calls: chain({
      getAddressCounters: () => Promise.resolve({ transactions_count: "9000", token_transfers_count: "800" }),
      getAddressTransactions: () =>
        Promise.resolve({
          items: [
            { from: { hash: SELF }, to: { hash: WALLET(2) }, timestamp: "2026-07-27T10:00:00Z" },
            { from: { hash: WALLET(2) }, to: { hash: SELF }, timestamp: "2026-07-27T11:00:00Z" },
            { from: { hash: SELF }, to: { hash: WALLET(3) }, timestamp: "2026-07-27T12:00:00Z" },
          ],
        }),
      getTokenTransfers: () =>
        Promise.resolve({
          items: [
            { from: { hash: AAPL }, to: { hash: SELF }, timestamp: "2026-07-27T13:00:00Z" },
            { from: { hash: SELF }, to: { hash: WALLET(2) }, timestamp: "2026-07-27T14:00:00Z" },
          ],
        }),
    }),
  });

  assert.equal(res.ok, true);
  assert.equal(res.kind, "counterparties");
  const t = res.evidence.table;
  assert.ok(isTable(t));
  assert.equal(t.id, "wallet-counterparties");
  assert.deepEqual(t.columns.map((c) => c.key), ["rank", "address", "equity", "direction", "interactions", "lastSeen"]);
  assert.equal(t.rows[0].address, WALLET(2));
  assert.equal(t.rows[0].interactions, 3);
  assert.equal(t.rows[0].direction, "both", "sent to and received from");
  const apple = t.rows.find((r) => r.address === AAPL);
  assert.equal(apple.equity, "AAPL", "a snapshotted equity contract is named, not left as hex");
  assert.equal(apple.direction, "received from");
  assert.equal(res.evidence.equityCounterparties, 1);
  assert.equal(res.evidence.distinctCounterparties, 3);
});

test("a counterparty ranking says what it was counted over, and never claims a lifetime", async () => {
  const res = await walletCounterparties(SELF, {
    calls: chain({
      getAddressCounters: () => Promise.resolve({ transactions_count: "9000" }),
      getAddressTransactions: () =>
        Promise.resolve({
          items: [{ from: { hash: SELF }, to: { hash: WALLET(2) }, timestamp: "2026-07-27T10:00:00Z" }],
          next_page_params: { index: 2 },
        }),
      getTokenTransfers: () => Promise.resolve({ items: [] }),
    }),
  });
  assert.equal(res.evidence.sampled.transactions, 1);
  assert.equal(res.evidence.sampled.moreUpstream, true);
  assert.equal(res.evidence.totalTransactions, 9000);
  assert.equal(res.evidence.table.truncated, true, "one page of nine thousand is a prefix");
  assert.match(res.evidence.table.note, /out of 9,000 transactions in total/);
  assert.match(res.evidence.note, /not over the address's whole history/);
});

test("both counterparty feeds failing is an outage; one failing still answers", async () => {
  const down = await walletCounterparties(SELF, {
    calls: chain({
      getAddressCounters: () => Promise.reject(new Error("timeout")),
      getAddressTransactions: () => Promise.reject(new Error("timeout")),
      getTokenTransfers: () => Promise.reject(new Error("timeout")),
    }),
  });
  assert.equal(down.ok, false);
  assert.match(down.error, /unknown, not absent/);

  const half = await walletCounterparties(SELF, {
    calls: chain({
      getAddressCounters: () => Promise.resolve({}),
      getAddressTransactions: () => Promise.reject(new Error("timeout")),
      getTokenTransfers: () =>
        Promise.resolve({ items: [{ from: { hash: WALLET(4) }, to: { hash: SELF }, timestamp: "2026-07-27T10:00:00Z" }] }),
    }),
  });
  assert.equal(half.ok, true);
  assert.equal(half.evidence.sampled.transactions, null, "a failed feed is not a feed of zero rows");
  assert.equal(half.evidence.sampled.tokenTransfers, 1);
  assert.ok(half.evidence.unavailable.includes("transactions"));
  assert.doesNotMatch(half.evidence.table.note, /0 (most recent )?transaction/, "a failed feed must not be described as zero rows");
  assert.match(half.evidence.table.note, /did not answer/);
});

test("counterpartyRows drops the wallet itself and rows that touch neither side", () => {
  const rows = counterpartyRows(
    [
      {
        kind: "transaction",
        items: [
          { from: { hash: SELF }, to: { hash: SELF } },
          { from: { hash: WALLET(5) }, to: { hash: WALLET(6) } },
          { from: { hash: SELF }, to: null },
          { from: { hash: SELF }, to: { hash: ZERO }, timestamp: "2026-07-27T10:00:00Z" },
        ],
      },
    ],
    SELF,
  );
  assert.equal(rows.length, 1, "only the zero-address burn is this wallet's counterparty here");
  assert.equal(rows[0].address, ZERO);
  assert.equal(rows[0].isZeroAddress, true);
  assert.deepEqual(counterpartyRows(null, SELF), []);
});

/* ============================== whale moves ============================== */

const whaleChain = (extra = {}) => ({
  getAddress: () => Promise.reject(new Error("unscripted")),
  getToken: () => Promise.resolve({ name: "NVIDIA • Robinhood Token", symbol: "NVDA", decimals: "18", total_supply: units(1000) }),
  getTokenActivity: () =>
    Promise.resolve({
      items: [
        transfer(WALLET(1), WALLET(2), 10, "2026-07-27T10:00:00Z"),
        transfer(ZERO, WALLET(3), 400, "2026-07-27T09:00:00Z"),
        transfer(WALLET(4), WALLET(5), 100, "2026-07-27T08:00:00Z"),
      ],
    }),
  getTokenCounters: () => Promise.resolve({ transfers_count: "81234" }),
  getTokenHolders: () => Promise.reject(new Error("unscripted")),
  getTransaction: () => Promise.reject(new Error("unscripted")),
  searchChain: () => Promise.reject(new Error("unscripted")),
  listStockTokens: () => Promise.resolve([]),
  resolveSymbol: () => Promise.resolve({ ok: false, match: null }),
  snapshotMatch: () => ({ symbol: "NVDA", company: "NVIDIA", address: NVDA }),
  verifiedByIssuer: () => Promise.resolve(false),
  ...extra,
});

test("whale_moves ranks by size, not by time, and measures each move against supply", async () => {
  const res = await whaleMoves("NVDA", { limit: 2, calls: whaleChain() });

  assert.equal(res.ok, true);
  assert.equal(res.kind, "whales");
  const t = res.evidence.table;
  assert.ok(isTable(t));
  assert.equal(t.id, "whale-moves");
  assert.deepEqual(t.columns.map((c) => c.key), ["rank", "time", "kind", "from", "to", "amountDisplay", "percentDisplay"]);
  assert.equal(t.rowCount, 2);
  assert.equal(t.rows[0].amountDisplay, "400", "biggest first, though it is not the newest");
  assert.equal(t.rows[0].percentDisplay, "40%");
  assert.equal(t.rows[0].kind, "mint", "out of the zero address is not somebody selling");
  assert.equal(t.rows[1].amountDisplay, "100");
  assert.equal(t.totalRows, 81234, "the token's whole transfer history, so 2 of 81,234 is measured");
  assert.equal(t.truncated, true);
  assert.equal(res.evidence.sampleSize, 3, "what the ranking is actually over");
  assert.match(t.note, /not the largest in the token's history/);
  assert.match(res.evidence.movedPercentDisplay, /50% of supply/);

  // A token whose whole history fits in the sample is NOT a truncated list, and
  // a table that claims otherwise is as wrong as one that hides a prefix.
  const whole = await whaleMoves("NVDA", { calls: whaleChain({ getTokenCounters: () => Promise.resolve({ transfers_count: 3 }) }) });
  assert.equal(whole.evidence.table.rowCount, 3);
  assert.equal(whole.evidence.table.totalRows, 3);
  assert.equal(whole.evidence.table.truncated, false);
});

test("a move with no supply to measure it against has no percent, never zero percent", async () => {
  const res = await whaleMoves("NVDA", {
    calls: whaleChain({
      getToken: () => Promise.resolve({ name: "NVIDIA • Robinhood Token", symbol: "NVDA", decimals: "18", total_supply: null }),
      getTokenCounters: () => Promise.resolve({ transfers_count: "" }),
    }),
  });
  for (const row of res.evidence.table.rows) assert.equal(row.percentDisplay, null);
  assert.equal(res.evidence.movedPercent.percent, null);
  assert.equal(res.evidence.movedPercentDisplay, null);
  assert.equal(res.evidence.transferCount, null, "an uncounted history is not an empty one");
  assert.equal(res.evidence.table.totalRows, null);
  assert.match(res.evidence.table.note, /not a move of 0% of supply/);
});

test("a whale lookup whose transfers never arrived is an outage, not a quiet token", async () => {
  const res = await whaleMoves("NVDA", {
    calls: whaleChain({ getTokenActivity: () => Promise.reject(Object.assign(new Error("gateway"), { status: 503 })) }),
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /unknown, not absent/);
  assert.match(res.error, /503/);
});

/* =============================== top movers =============================== */

test("top_movers ranks only what carries a figure, and counts the rest as unmeasured", () => {
  const built = buildMovers(
    [
      stock("AAA", { volume24h: 1000 }),
      stock("BBB", { volume24h: 3000 }),
      stock("CCC", { volume24h: null }),
      stock("DDD", { volume24h: "" }),
    ],
    { metric: "volume24h", limit: 10 },
  );
  assert.deepEqual(built.rows.map((r) => r.symbol), ["BBB", "AAA"]);
  assert.equal(built.measured, 2);
  assert.equal(built.unmeasured, 2, "an unpublished volume is not zero volume, and is not ranked last");
  assert.equal(built.combined, 4000);
  assert.equal(built.rows[0].shareDisplay, "75%");
  assert.equal(built.rows[1].shareDisplay, "25%");
  assert.equal(built.rows[0].metricDisplay, "$3.00K");
});

test("a share is only offered for a metric that can honestly be summed", () => {
  const byPrice = buildMovers([stock("AAA", { price: 10 }), stock("BBB", { price: 90 })], { metric: "price" });
  assert.equal(byPrice.combined, null, "a total of prices is not a figure");
  assert.equal(byPrice.rows[0].shareDisplay, null);
  const byHolders = buildMovers([stock("AAA", { holders: 10 })], { metric: "holders" });
  assert.equal(byHolders.combined, null, "summed holder counts double-count every address");
  assert.equal(byHolders.rows[0].metricDisplay, "10", "a holder count is a count, not money");
});

test("top_movers emits a table whose caption cannot imply it saw the whole board", async () => {
  const list = [
    stock("AAA", { volume24h: 900 }),
    stock("BBB", { volume24h: 800 }),
    stock("CCC", { volume24h: null }),
  ];
  const res = await topMovers({ metric: "volume24h", limit: 1, calls: { listStockTokens: () => Promise.resolve(list) } });

  assert.equal(res.ok, true);
  assert.equal(res.kind, "movers");
  const t = res.evidence.table;
  assert.ok(isTable(t));
  assert.equal(t.id, "top-movers");
  assert.deepEqual(t.columns.map((c) => c.key), ["rank", "symbol", "company", "metricDisplay", "shareDisplay", "priceDisplay", "address"]);
  assert.equal(t.rowCount, 1);
  assert.equal(t.rows[0].symbol, "AAA");
  assert.equal(t.totalRows, 2, "the rankable population, not the three listed equities");
  assert.equal(t.truncated, true);
  assert.match(t.note, /carried no 24h volume figure/);
  assert.match(t.note, /unmeasured, not inactive/);
  assert.match(res.evidence.note, /not zero activity/);
});

test("a price ranking drops the duplicate price column rather than printing it twice", async () => {
  const res = await topMovers({
    metric: "price",
    calls: { listStockTokens: () => Promise.resolve([stock("AAA", { price: 10 })]) },
  });
  const keys = res.evidence.table.columns.map((c) => c.key);
  assert.deepEqual(keys, ["rank", "symbol", "company", "metricDisplay", "address"]);
});

test("an indexer that returned no registry cannot be reported as an empty market", async () => {
  const res = await topMovers({ calls: { listStockTokens: () => Promise.resolve([]) } });
  assert.equal(res.ok, false, "zero equities means nobody answered, not that none are listed");
  assert.match(res.error, /did not return the tokenized-equity list/);
});

test("a board where nothing carries the metric is a missing feed, not a still market", () => {
  const built = buildMovers([stock("AAA", { volume24h: null }), stock("BBB", { volume24h: null })], {});
  assert.deepEqual(built.rows, []);
  assert.equal(built.measured, 0);
  assert.equal(built.unmeasured, 2);
  assert.equal(built.combined, null, "no rows to sum is not a combined volume of $0");
  assert.equal(built.totalStockTokens, 2);
});

/* ========================= the shared evidence budget ========================= */

test("every wallet-side result at its widest still fits the prompt's evidence budget", async () => {
  // The budget (lib/ask-loop.js MAX_EVIDENCE_CHARS, 24,000) is SHARED across
  // every tool result in a turn, so a single one that fills it starves the rest
  // — and the table, being last in the object, is the half that gets cut. Each
  // of these carries its rows once, in the table, with a short prose slice.
  const wallets = Array.from({ length: 60 }, (_, i) => WALLET(i + 2));

  const portfolio = await walletPortfolio(SELF, {
    calls: chain({
      getAddress: () => Promise.resolve({ coin_balance: "1500000000000000000" }),
      getAddressCounters: () => Promise.resolve({ transactions_count: "9" }),
      getAddressTokenBalances: () =>
        Promise.resolve(wallets.map((a, i) => balance(`SYMBOL${i}`, a, 1234.5, i % 2 ? "123.45" : null))),
    }),
  });
  assert.equal(portfolio.evidence.holdings.length, 10, "the prose slice does not repeat the whole table");

  let page = 0;
  const trace = await traceWallet(SELF, "NVDA", {
    calls: traceChain(null, {
      getTokenTransfers: () =>
        Promise.resolve({
          items: wallets.slice(0, 50).map((a) => transfer(a, SELF, 12.5, "2026-07-27T10:00:00Z")),
          next_page_params: { index: (page += 1) },
        }),
    }),
  });
  assert.equal(trace.evidence.transfersRead, 150, "the walk is capped at MAX_TRACE_TRANSFERS");
  assert.equal(trace.evidence.table.rowCount, 40);

  const counterparties = await walletCounterparties(SELF, {
    limit: 50,
    calls: chain({
      getAddressCounters: () => Promise.resolve({ transactions_count: "9000" }),
      getAddressTransactions: () =>
        Promise.resolve({ items: wallets.map((a) => ({ from: { hash: a }, to: { hash: SELF }, timestamp: "2026-07-27T10:00:00Z" })) }),
      getTokenTransfers: () => Promise.resolve({ items: [] }),
    }),
  });
  assert.equal(counterparties.evidence.table.rowCount, 50);
  assert.equal(counterparties.evidence.counterparties.length, 12);

  const movers = await topMovers({
    limit: 25,
    calls: { listStockTokens: () => Promise.resolve(Array.from({ length: 94 }, (_, i) => stock(`SYMBOL${i}`, { volume24h: 5000 + i }))) },
  });

  for (const [name, res] of [
    ["wallet_portfolio", portfolio],
    ["trace_wallet", trace],
    ["wallet_counterparties", counterparties],
    ["top_movers", movers],
  ]) {
    const size = JSON.stringify(res.evidence).length;
    assert.ok(size < 24_000, `${name} evidence is ${size} chars, past the shared budget`);
  }
});

test("the shared comparator keeps unknowns last in BOTH directions", () => {
  const rows = [{ v: null, symbol: "B" }, { v: 5, symbol: "C" }, { v: 1, symbol: "A" }];
  assert.deepEqual([...rows].sort(compareByField("v", "desc")).map((r) => r.symbol), ["C", "A", "B"]);
  // The one that matters: "smallest first" must not put the unpriced row first.
  assert.deepEqual([...rows].sort(compareByField("v", "asc")).map((r) => r.symbol), ["A", "C", "B"]);
  assert.deepEqual([...rows].sort(compareByField("nope", "desc")).map((r) => r.symbol), ["A", "B", "C"], "all unknown ties break on symbol");
});

/* ============================== value flows ============================== */

/** One cross-token transfer row in the indexer's shape. */
function xfer(from, to, { symbol = "AAA", token = "0xtoken", value = "1000000000000000000", time = "2026-08-01T00:00:00Z", hash = "0xtx" } = {}) {
  return {
    from: { hash: from },
    to: { hash: to },
    token: { address_hash: token, symbol, decimals: "18" },
    total: { value, decimals: "18" },
    timestamp: time,
    transaction_hash: hash,
  };
}

test("wallet_flows counts every transfer read, and lists far fewer", async () => {
  // The counts and the listing are different sets on purpose: at 200 rows this
  // result serialised to 71,318 characters against a 24,000 budget, so the model
  // was handed JSON cut off partway through and invented figures to finish it.
  const many = Array.from({ length: 60 }, (_, i) => xfer(WALLET(9), SELF, { hash: `0xtx${i}` }));
  const res = await walletFlows(SELF, {
    calls: chain({
      getAddressCounters: () => Promise.resolve({ token_transfers_count: "60", transactions_count: "5" }),
      getTokenTransfers: () => Promise.resolve({ items: many }),
      getAddress: () => Promise.resolve({ is_contract: false }),
      getAddressTransactions: () => Promise.resolve({ items: [] }),
    }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.evidence.transfersRead, 60, "every transfer read is counted");
  assert.ok(res.evidence.table.rows.length < 60, "and far fewer are listed");
  assert.equal(res.evidence.table.totalRows, 60, "the table still says how many there were");
  assert.match(res.evidence.table.note, /Every count and share above covers all 60/);
});

test("every amount carries its unit, and a token with no symbol still gets one", async () => {
  // Measured twice against a live model: a bare "0.0425" in the amount column came
  // back to the reader as "$0.0425 sent" — a dollar figure this lookup cannot
  // compute, because it reads no price at all. No path may emit a naked number.
  const res = await walletFlows(SELF, {
    calls: chain({
      getAddressCounters: () => Promise.resolve({ token_transfers_count: "2" }),
      getTokenTransfers: () =>
        Promise.resolve({
          items: [xfer(WALLET(2), SELF, { symbol: "AAA" }), xfer(WALLET(3), SELF, { symbol: null, token: "0xdeadbeef" })],
        }),
      getAddress: () => Promise.resolve({ is_contract: false }),
      getAddressTransactions: () => Promise.resolve({ items: [] }),
    }),
  });
  for (const row of res.evidence.table.rows) {
    assert.doesNotMatch(String(row.amountDisplay).trim(), /^[\d.,]+$/, `"${row.amountDisplay}" is a bare number`);
  }
});

test("a counterparty that was not read is UNPROBED, never ordinary", async () => {
  // "We did not look" and "we looked and it was unremarkable" are different facts,
  // and only the second is a finding. A reader deciding which address to chase has
  // to be able to tell them apart.
  const items = [];
  for (let i = 2; i < 12; i += 1) {
    for (let n = 0; n < 3; n += 1) items.push(xfer(WALLET(i), SELF, { hash: `0xtx${i}-${n}` }));
  }
  const res = await walletFlows(SELF, {
    calls: chain({
      getAddressCounters: () => Promise.resolve({ token_transfers_count: String(items.length) }),
      getTokenTransfers: () => Promise.resolve({ items }),
      getAddress: () => Promise.resolve({ is_contract: true }),
      getAddressTransactions: () => Promise.resolve({ items: [] }),
    }),
  });
  const probed = res.evidence.counterparties.filter((c) => c.probed);
  const unprobed = res.evidence.counterparties.filter((c) => !c.probed);
  assert.ok(probed.length > 0 && unprobed.length > 0, "this fixture must exercise both");
  for (const c of unprobed) {
    assert.equal(c.shape, null, "an unprobed counterparty has no shape");
    assert.equal(c.isContract, null, "and no contract verdict");
    assert.match(c.detail, /not read in its own right/);
  }
});

test("an outbound transfer this wallet did not sign is UNKNOWN unless its own list was complete", async () => {
  // Close to an accusation, so it runs hasSold's discipline. Somebody else's
  // signature is also the ordinary case — routers and smart accounts produce it in
  // most trades — so it is never reported as a stolen approval.
  const out = [xfer(SELF, WALLET(2), { hash: "0xmoved" })];
  const partial = await walletFlows(SELF, {
    calls: chain({
      getAddressCounters: () => Promise.resolve({ token_transfers_count: "1", transactions_count: "9000" }),
      getTokenTransfers: () => Promise.resolve({ items: out }),
      getAddress: () => Promise.resolve({ is_contract: false }),
      // A page that does not contain the hash, and more upstream.
      getAddressTransactions: () => Promise.resolve({ items: [{ hash: "0xsomethingelse" }], next_page_params: { x: 1 } }),
    }),
  });
  assert.equal(partial.evidence.outboundSignedByThirdParty, 0, "an incomplete list cannot establish it");
  assert.equal(partial.evidence.outboundSignerUnknown, 1);
  assert.match(partial.evidence.signerNotice, /ordinary rather than alarming/);
  assert.doesNotMatch(partial.evidence.signerNotice, /stolen|approval you granted|drain/i);
  // And it must actively DENY the claim rather than merely omit it, because the
  // reader's next move on "your approval is still live" is to go and revoke — and
  // no allowance is read anywhere here, so asserting it would invent the one part
  // they would act on.
  assert.match(partial.evidence.signerNotice, /nothing about whether any approval is still live/);
});

test("the wallet's own shape is measured, and is null when too little was read", async () => {
  // The first version shipped the whole shape dictionary and let the model pick,
  // which narrated a user's own drained wallet as exchange-like with no
  // measurement behind the choice.
  const quiet = await walletFlows(SELF, {
    calls: chain({
      getAddressCounters: () => Promise.resolve({ token_transfers_count: "2" }),
      getTokenTransfers: () => Promise.resolve({ items: [xfer(WALLET(2), SELF), xfer(WALLET(3), SELF)] }),
      getAddress: () => Promise.resolve({ is_contract: false }),
      getAddressTransactions: () => Promise.resolve({ items: [] }),
    }),
  });
  assert.equal(quiet.evidence.shape, null, "two transfers cannot support a shape");
  assert.equal(quiet.evidence.shapeReading, null);
});
