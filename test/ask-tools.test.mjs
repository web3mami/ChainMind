// Tests for the model-facing tool catalogue and dispatcher (lib/ask-tools.js).
//
// Two things are being defended here. First the SCHEMAS: they are sent verbatim
// to the model and they are the router now, so a missing description or an enum
// that drifted from what the dispatcher accepts is a routing bug, not a typo.
// Second the COERCION: the model sends a string where an array belongs, a limit
// of 999, a metric of "banana", the value under the wrong key. Every one of
// those has to become a valid lookup or a recoverable sentence — never a throw,
// and never a silently different question than the user asked.
//
// Fully offline. Every dispatchTool call injects fake data modules through the
// third argument, so nothing in this file can reach Blockscout; the pure
// coercion helpers are exercised directly.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLARIFICATION_TOOL,
  TOOL_NAMES,
  TOOL_SCHEMAS,
  coerceAddressArg,
  coerceClarification,
  coerceCompareQueries,
  coerceHashArg,
  coerceRankArgs,
  coerceSafetyTarget,
  coerceTokenQuery,
  dispatchTool,
} from "../lib/ask-tools.js";

const NVDA_ADDRESS = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const FAKE_NVDA = "0x465834d5ba3af2169e49b70a139448e59e3ca492";
const TX_HASH = `0x${"ab".repeat(32)}`;

const byName = (name) => TOOL_SCHEMAS.find((s) => s.function.name === name);
const paramsOf = (name) => byName(name).function.parameters;

/**
 * Recorder standing in for the data modules. Every call is logged so a test can
 * assert what the dispatcher actually passed downstream — the coercion is only
 * correct if the coerced values are what reach rankStocks/compareTargets.
 */
function fakes(overrides = {}) {
  const calls = [];
  const log = (name, result) => (...args) => {
    calls.push({ name, args });
    return Promise.resolve(result);
  };
  const impls = {
    gatherEvidence: log("gatherEvidence", { ok: true, kind: "token", target: "NVDA", evidence: { token: {} } }),
    rankStocks: log("rankStocks", { ok: true, kind: "ranking", evidence: { rows: [] } }),
    marketOverview: log("marketOverview", { ok: true, kind: "overview", evidence: { totalStockTokens: 94 } }),
    compareTargets: log("compareTargets", { ok: true, kind: "comparison", evidence: { items: [] } }),
    safetyReport: log("safetyReport", { ok: true, kind: "safety", evidence: { verdict: "official" } }),
    tokenHolders: log("tokenHolders", { ok: true, kind: "holders", evidence: { holders: [] } }),
    tokenTransfers: log("tokenTransfers", { ok: true, kind: "transfers", evidence: { transfers: [] } }),
    flagPatterns: log("flagPatterns", { ok: true, kind: "patterns", evidence: { findings: [] } }),
    holderHoldTime: log("holderHoldTime", { ok: true, kind: "holdTime", evidence: { medianDisplay: null } }),
    bundleCheck: log("bundleCheck", { ok: true, kind: "bundle", evidence: { found: false } }),
    contractInfo: log("contractInfo", { ok: true, kind: "contract", evidence: { deployer: null } }),
    searchTokens: log("searchTokens", { ok: true, kind: "search", evidence: { results: [] } }),
    walletPortfolio: log("walletPortfolio", { ok: true, kind: "portfolio", evidence: { holdings: [] } }),
    traceWallet: log("traceWallet", { ok: true, kind: "trace", evidence: { hasSold: null } }),
    walletCounterparties: log("walletCounterparties", { ok: true, kind: "counterparties", evidence: { counterparties: [] } }),
    whaleMoves: log("whaleMoves", { ok: true, kind: "whales", evidence: { largest: [] } }),
    topMovers: log("topMovers", { ok: true, kind: "movers", evidence: { rows: [] } }),
    resolveSymbol: log("resolveSymbol", {
      ok: true,
      match: { symbol: "KO", company: "Coca-Cola", address: "0x00000000000000000000000000000000000000ko" },
      official: true,
      impostors: [],
    }),
    ...overrides,
  };
  return { impls, calls };
}

/* ------------------------------ the catalogue ------------------------------ */

test("every schema is a well-formed OpenAI/Groq function tool", () => {
  assert.ok(Array.isArray(TOOL_SCHEMAS) && TOOL_SCHEMAS.length > 0);
  for (const schema of TOOL_SCHEMAS) {
    assert.equal(schema.type, "function", "tool type must be \"function\"");
    const fn = schema.function;
    assert.ok(fn && typeof fn === "object", "function block missing");
    assert.equal(typeof fn.name, "string");
    assert.match(fn.name, /^[a-z][a-z0-9_]*$/, `${fn.name} is not a usable tool name`);
    assert.equal(typeof fn.description, "string");
    // The description IS the router: a one-liner cannot carry the casual
    // phrasings that make routing work, so a floor is enforced.
    assert.ok(fn.description.length > 120, `${fn.name} description is too thin to route on`);
    const params = fn.parameters;
    assert.ok(params && typeof params === "object" && !Array.isArray(params), `${fn.name} parameters missing`);
    assert.equal(params.type, "object", `${fn.name} parameters must be an object schema`);
    assert.ok(params.properties && typeof params.properties === "object");
    assert.ok(Array.isArray(params.required), `${fn.name} must state its required fields, even if empty`);
    for (const key of params.required) {
      assert.ok(key in params.properties, `${fn.name} requires "${key}" but does not define it`);
    }
    for (const [key, prop] of Object.entries(params.properties)) {
      assert.equal(typeof prop.type, "string", `${fn.name}.${key} has no type`);
      assert.equal(typeof prop.description, "string", `${fn.name}.${key} has no description`);
    }
  }
});

test("CLARIFICATION_TOOL names a tool that is really in the catalogue", () => {
  // lib/ask-loop.js partitions a round on this constant — it is what makes
  // ask_clarification run alone. A name that drifted out of the catalogue would
  // not throw anywhere: the partition would simply stop matching, and a
  // clarification would quietly start running lookups beside itself again.
  assert.equal(typeof CLARIFICATION_TOOL, "string");
  assert.ok(TOOL_NAMES.includes(CLARIFICATION_TOOL), "the terminal tool must be in TOOL_NAMES");
  assert.ok(byName(CLARIFICATION_TOOL), "and in the schemas the model is sent");
});

test("TOOL_NAMES matches the catalogue exactly and is frozen", () => {
  assert.deepEqual([...TOOL_NAMES], TOOL_SCHEMAS.map((s) => s.function.name));
  assert.equal(new Set(TOOL_NAMES).size, TOOL_NAMES.length, "duplicate tool name");
  assert.ok(Object.isFrozen(TOOL_NAMES));
  assert.ok(Object.isFrozen(TOOL_SCHEMAS));
});

test("the catalogue covers all twenty-nine documented tools", () => {
  // Seven that answer a whole question, seven that go deeper into one token, two
  // that span TOKENS (holder_overlap, co_holdings — the relation the app was
  // missing when it answered a two-token question about one token), five on the
  // wallet and market side, one that assembles the whole chain-side diligence
  // picture for a project (project_profile), THREE that read SWAPS rather than
  // transfers (recent_trades, real_volume, swap_detail — the first lookups here
  // that can say somebody BOUGHT or SOLD rather than that something moved), and
  // one that computes a POSITION rather than a movement (wallet_pnl, the only
  // tool here that answers "is this wallet up or down" — and the only one that
  // routinely withholds its own figure, because a cost basis that cannot be
  // proven is worse than none), and one that looks nothing up at all.
  assert.deepEqual([...TOOL_NAMES].sort(), [
    "ask_clarification",
    "bundle_check",
    "co_holdings",
    "compare_tokens",
    "contract_info",
    "flag_patterns",
    "holder_hold_time",
    "holder_overlap",
    "lookup_token",
    "lookup_transaction",
    "lookup_wallet",
    "market_overview",
    "project_profile",
    "rank_stocks",
    "real_volume",
    "recent_trades",
    "safety_check",
    "search_tokens",
    "swap_detail",
    "token_holders",
    "token_transfers",
    "top_movers",
    "trace_funds",
    "trace_wallet",
    "wallet_counterparties",
    "wallet_flows",
    "wallet_pnl",
    "wallet_portfolio",
    "whale_moves",
  ]);
});

test("rank_stocks enums match the documented values and the ranking bounds", () => {
  const props = paramsOf("rank_stocks").properties;
  assert.deepEqual(props.metric.enum, ["marketCap", "holders", "price", "volume24h"]);
  assert.deepEqual(props.direction.enum, ["desc", "asc"]);
  assert.equal(props.limit.type, "integer");
  assert.equal(props.limit.minimum, 1);
  assert.equal(props.limit.maximum, 25);
  assert.deepEqual(paramsOf("rank_stocks").required, [], "a ranking is answerable with no arguments");
});

test("every rank_stocks metric survives coercion unchanged", () => {
  // The enum promises the model these four names work; coerceRankArgs must not
  // quietly fall back to marketCap for any of them.
  for (const metric of paramsOf("rank_stocks").properties.metric.enum) {
    assert.equal(coerceRankArgs({ metric }).metric, metric);
  }
  for (const direction of paramsOf("rank_stocks").properties.direction.enum) {
    assert.equal(coerceRankArgs({ direction }).direction, direction);
  }
});

test("compare_tokens takes an array of 2 to 4 strings", () => {
  const queries = paramsOf("compare_tokens").properties.queries;
  assert.equal(queries.type, "array");
  assert.equal(queries.minItems, 2);
  assert.equal(queries.maxItems, 4);
  assert.equal(queries.items.type, "string");
  assert.deepEqual(paramsOf("compare_tokens").required, ["queries"]);
});

test("market_overview takes no arguments", () => {
  assert.deepEqual(paramsOf("market_overview").properties, {});
  assert.deepEqual(paramsOf("market_overview").required, []);
});

test("single-target tools require exactly their one documented argument", () => {
  assert.deepEqual(paramsOf("lookup_token").required, ["query"]);
  assert.deepEqual(paramsOf("lookup_wallet").required, ["address"]);
  assert.deepEqual(paramsOf("lookup_transaction").required, ["hash"]);
  assert.deepEqual(paramsOf("safety_check").required, ["target"]);
});

test("descriptions tell the model that casual and non-English phrasing is fine", () => {
  // Routing failed on "hows nvda doin", "whos got the most bags", "que es nvda"
  // and friends. Those exact phrasings live in the descriptions now, so a future
  // edit that trims them for brevity fails here instead of in production.
  assert.match(byName("lookup_token").function.description, /hows nvda doin/);
  assert.match(byName("lookup_token").function.description, /que es nvda/);
  assert.match(byName("lookup_token").function.description, /company name/i);
  assert.match(byName("rank_stocks").function.description, /most bags/);
  assert.match(byName("rank_stocks").function.description, /top 3/);
  assert.match(byName("compare_tokens").function.description, /tsla vs nvda/);
  assert.match(byName("market_overview").function.description, /poppin/);
  assert.match(byName("safety_check").function.description, /legit/);
  // Every tool, not a hand-kept list: a new one added without the phrasing note
  // is a routing regression that would otherwise only show up in production.
  for (const name of TOOL_NAMES) {
    assert.match(
      byName(name).function.description,
      /language|casual|informal|slang/i,
      `${name} does not tell the model that casual or non-English phrasing is fine`,
    );
  }
});

/* ------------------------------ token queries ------------------------------ */

test("coerceTokenQuery accepts tickers in any case, company names and addresses", () => {
  assert.deepEqual(coerceTokenQuery({ query: "nvda" }), { ok: true, value: "nvda" });
  assert.deepEqual(coerceTokenQuery({ query: "$tsla" }), { ok: true, value: "$tsla" });
  assert.deepEqual(coerceTokenQuery({ query: "apple" }), { ok: true, value: "apple" });
  assert.deepEqual(coerceTokenQuery({ query: "  coca   cola " }), { ok: true, value: "coca cola" });
  assert.deepEqual(coerceTokenQuery({ query: NVDA_ADDRESS }), { ok: true, value: NVDA_ADDRESS });
});

test("coerceTokenQuery reads the value out of the wrong key rather than failing", () => {
  // A round trip spent teaching the model the key name buys nothing.
  assert.equal(coerceTokenQuery({ symbol: "nvda" }).value, "nvda");
  assert.equal(coerceTokenQuery({ ticker: "TSLA" }).value, "TSLA");
  assert.equal(coerceTokenQuery({ company: "apple" }).value, "apple");
  assert.equal(coerceTokenQuery("nvidia").value, "nvidia", "a bare string instead of an object");
  assert.equal(coerceTokenQuery({ query: 42 }).value, "42", "a number is still a string here");
});

test("coerceTokenQuery refuses an empty or oversized query with a usable message", () => {
  for (const args of [undefined, null, {}, "", "   ", { query: "" }, { query: null }, []]) {
    const res = coerceTokenQuery(args);
    assert.equal(res.ok, false);
    assert.match(res.error, /lookup_token/);
  }
  const long = coerceTokenQuery({ query: "a".repeat(200) });
  assert.equal(long.ok, false);
  assert.match(long.error, /whole question/);
});

test("coerceTokenQuery rejects a truncated 0x value instead of searching for it", () => {
  // "0xabc" must never reach the token search, where it can match some unrelated
  // contract named after the fragment and be answered about confidently.
  const res = coerceTokenQuery({ query: "0xabc123" });
  assert.equal(res.ok, false);
  assert.match(res.error, /40 hex/);
});

test("coerceTokenQuery sends a transaction hash to the right tool", () => {
  const res = coerceTokenQuery({ query: TX_HASH });
  assert.equal(res.ok, false);
  assert.match(res.error, /lookup_transaction/);
});

test("coerceSafetyTarget mirrors it, and points a hash elsewhere", () => {
  assert.equal(coerceSafetyTarget({ target: "nvda" }).value, "nvda");
  assert.equal(coerceSafetyTarget({ address: FAKE_NVDA }).value, FAKE_NVDA);
  assert.equal(coerceSafetyTarget({}).ok, false);
  assert.match(coerceSafetyTarget({ target: TX_HASH }).error, /transaction hash/);
});

/* --------------------------- addresses and hashes --------------------------- */

test("coerceAddressArg takes only a 40-hex address", () => {
  assert.deepEqual(coerceAddressArg({ address: NVDA_ADDRESS }), { ok: true, value: NVDA_ADDRESS });
  assert.equal(coerceAddressArg({ wallet: FAKE_NVDA }).value, FAKE_NVDA);
  assert.equal(coerceAddressArg({}).ok, false);
  assert.match(coerceAddressArg({ address: "nvda" }).error, /lookup_token/, "a ticker is redirected, not just refused");
  assert.match(coerceAddressArg({ address: `${NVDA_ADDRESS}ff` }).error, /40 hex/, "an over-long hex run is not an address");
  assert.match(coerceAddressArg({ address: TX_HASH }).error, /lookup_transaction/);
});

test("coerceHashArg takes only a 64-hex hash", () => {
  assert.deepEqual(coerceHashArg({ hash: TX_HASH }), { ok: true, value: TX_HASH });
  assert.equal(coerceHashArg({ tx_hash: TX_HASH }).value, TX_HASH);
  assert.equal(coerceHashArg({}).ok, false);
  assert.match(coerceHashArg({ hash: NVDA_ADDRESS }).error, /lookup_wallet/);
  assert.match(coerceHashArg({ hash: `${TX_HASH}00` }).error, /64 hex/);
});

/* ------------------------------ rank arguments ------------------------------ */

test("coerceRankArgs defaults to the biggest ten by market cap", () => {
  assert.deepEqual(coerceRankArgs(undefined), { metric: "marketCap", direction: "desc", limit: 10 });
  assert.deepEqual(coerceRankArgs({}), { metric: "marketCap", direction: "desc", limit: 10 });
  assert.deepEqual(coerceRankArgs("nonsense"), { metric: "marketCap", direction: "desc", limit: 10 });
});

test("coerceRankArgs clamps an out-of-range limit instead of failing the call", () => {
  assert.equal(coerceRankArgs({ limit: 999 }).limit, 25);
  assert.equal(coerceRankArgs({ limit: 0 }).limit, 1);
  assert.equal(coerceRankArgs({ limit: -7 }).limit, 1);
  assert.equal(coerceRankArgs({ limit: "3" }).limit, 3, "a numeric string is still a number");
  assert.equal(coerceRankArgs({ limit: 3.9 }).limit, 3);
  assert.equal(coerceRankArgs({ limit: "loads" }).limit, 10);
  assert.equal(coerceRankArgs({ count: 5 }).limit, 5, "the wrong key still carries the count");
});

test("coerceRankArgs falls back on a bogus metric rather than sorting on nothing", () => {
  assert.equal(coerceRankArgs({ metric: "banana" }).metric, "marketCap");
  assert.equal(coerceRankArgs({ metric: null }).metric, "marketCap");
  assert.equal(coerceRankArgs({ metric: 7 }).metric, "marketCap");
});

test("coerceRankArgs understands the words a model reaches for", () => {
  assert.equal(coerceRankArgs({ metric: "market cap" }).metric, "marketCap");
  assert.equal(coerceRankArgs({ metric: "owners" }).metric, "holders");
  assert.equal(coerceRankArgs({ metric: "volume" }).metric, "volume24h");
  assert.equal(coerceRankArgs({ by: "price" }).metric, "price");
  assert.equal(coerceRankArgs({ direction: "asc" }).direction, "asc");
  assert.equal(coerceRankArgs({ direction: "lowest" }).direction, "asc");
  assert.equal(coerceRankArgs({ order: "ascending" }).direction, "asc");
  assert.equal(coerceRankArgs({ direction: "sideways" }).direction, "desc");
});

/* ---------------------------- compare arguments ---------------------------- */

test("coerceCompareQueries splits a bare string into the targets it names", () => {
  // The measured failure: "tsla vs nvda which is better" classified as a compare
  // and extracted nothing. A model that sends the phrase as one string must not
  // end up comparing one thing with nothing.
  assert.deepEqual(coerceCompareQueries("tsla vs nvda").value, ["tsla", "nvda"]);
  assert.deepEqual(coerceCompareQueries({ queries: "apple and tesla" }).value, ["apple", "tesla"]);
  assert.deepEqual(coerceCompareQueries({ queries: "NVDA, TSLA, AAPL" }).value, ["NVDA", "TSLA", "AAPL"]);
  assert.deepEqual(coerceCompareQueries({ queries: "nvda/amd" }).value, ["nvda", "amd"]);
  assert.deepEqual(coerceCompareQueries({ queries: ["tsla", "nvda"] }).value, ["tsla", "nvda"]);
});

test("coerceCompareQueries keeps the user's order and drops duplicates", () => {
  const res = coerceCompareQueries({ queries: ["NVDA", "nvda", "tsla", "  ", null, "aapl"] });
  assert.deepEqual(res.value, ["NVDA", "tsla", "aapl"], "first-seen order, one row per contract");
});

test("coerceCompareQueries reads the array out of the wrong key", () => {
  assert.deepEqual(coerceCompareQueries({ targets: ["a1", "b2"] }).value, ["a1", "b2"]);
  assert.deepEqual(coerceCompareQueries({ tokens: ["a1", "b2"] }).value, ["a1", "b2"]);
  assert.deepEqual(coerceCompareQueries(["a1", "b2"]).value, ["a1", "b2"]);
});

test("coerceCompareQueries refuses a one-sided comparison and names the right tool", () => {
  for (const args of [{ queries: ["nvda"] }, "nvda", { queries: ["nvda", "NVDA"] }]) {
    const res = coerceCompareQueries(args);
    assert.equal(res.ok, false);
    assert.match(res.error, /lookup_token/, "the model needs to be told what to call instead");
  }
  const missing = coerceCompareQueries({});
  assert.equal(missing.ok, false);
  assert.match(missing.error, /queries/);
});

test("coerceCompareQueries does not split a name that merely contains a separator word", () => {
  // Word-shaped separators need whitespace on both sides, or "AT&T" becomes two
  // targets called "at" and "t".
  assert.deepEqual(coerceCompareQueries({ queries: ["AT&T", "nvda"] }).value, ["AT&T", "nvda"]);
  assert.deepEqual(coerceCompareQueries({ queries: ["standard", "poors"] }).value, ["standard", "poors"]);
});

test("coerceCompareQueries rejects junk entries with a recoverable message", () => {
  assert.match(coerceCompareQueries({ queries: ["0xabc", "nvda"] }).error, /40 hex/);
  assert.match(coerceCompareQueries({ queries: ["a".repeat(200), "nvda"] }).error, /too long/);
  assert.match(coerceCompareQueries({ queries: new Array(30).fill("nvda") }).error, /at most 4/);
});

test("coerceCompareQueries leaves the 4-target cap to compareTargets", () => {
  // capQueries keeps four and returns a note naming the ones it dropped;
  // truncating here would drop them silently.
  const res = coerceCompareQueries({ queries: ["a1", "b2", "c3", "d4", "e5", "f6"] });
  assert.equal(res.ok, true);
  assert.equal(res.value.length, 6);
});

/* ---------------------------- clarification args ---------------------------- */

test("coerceClarification accepts a bare array of strings as the options", () => {
  // The likeliest malformed call: the schema asks for objects, and a model sends
  // the four questions as plain strings. Refusing that would cost a round trip to
  // learn a shape that carries exactly the same information.
  const res = coerceClarification({
    question: "Which of those do you mean?",
    options: ["Who holds the most?", "Who deployed it?"],
  });
  assert.equal(res.ok, true);
  assert.equal(res.question, "Which of those do you mean?");
  assert.deepEqual(res.options, [{ label: "Who holds the most?" }, { label: "Who deployed it?" }]);
});

test("coerceClarification keeps the hint when one is supplied, and only then", () => {
  const res = coerceClarification({
    question: "Which reading?",
    options: [
      { label: "Who holds the most?", hint: "the ranked holder list" },
      { label: "Who deployed it?" },
    ],
  });
  assert.deepEqual(res.options, [
    { label: "Who holds the most?", hint: "the ranked holder list" },
    { label: "Who deployed it?" },
  ]);
});

test("coerceClarification reads the option's halves out of the wrong keys", () => {
  const res = coerceClarification({
    ask: "Which reading?",
    choices: [
      { text: "Who holds the most?", description: "the holder list" },
      { question: "Who deployed it?", note: "the minting address" },
    ],
  });
  assert.equal(res.ok, true);
  assert.equal(res.question, "Which reading?");
  assert.deepEqual(res.options, [
    { label: "Who holds the most?", hint: "the holder list" },
    { label: "Who deployed it?", hint: "the minting address" },
  ]);
});

test("coerceClarification drops empty and unusable entries", () => {
  const res = coerceClarification({
    question: "Which reading?",
    options: ["Who holds the most?", "", "   ", null, undefined, {}, { hint: "no label" }, [], "Who deployed it?"],
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.options.map((o) => o.label), ["Who holds the most?", "Who deployed it?"]);
});

test("coerceClarification drops a repeated reading rather than offering it twice", () => {
  const res = coerceClarification({
    question: "Which reading?",
    options: ["Who holds the most?", "who holds the most?", "Who deployed it?"],
  });
  assert.deepEqual(res.options.map((o) => o.label), ["Who holds the most?", "Who deployed it?"]);
});

test("coerceClarification caps the options at four", () => {
  const res = coerceClarification({
    question: "Which reading?",
    options: ["one?", "two?", "three?", "four?", "five?", "six?"],
  });
  assert.equal(res.ok, true);
  assert.equal(res.options.length, 4);
  assert.deepEqual(res.options.map((o) => o.label), ["one?", "two?", "three?", "four?"]);
});

test("coerceClarification refuses fewer than two options and says to answer instead", () => {
  // A one-option question is a confirmation dialog in front of an answer the
  // model already had. The message has to send it to the answer, not to a retry.
  for (const args of [
    { question: "Which reading?", options: ["Who holds the most?"] },
    { question: "Which reading?", options: ["Who holds the most?", "who holds the most?"] },
    { question: "Which reading?", options: [] },
    { question: "Which reading?" },
    { question: "Which reading?", options: "Who holds the most?" },
  ]) {
    const res = coerceClarification(args);
    assert.equal(res.ok, false, `${JSON.stringify(args)} should not be a clarification`);
    assert.match(res.error, /at least 2 distinct options/);
    assert.match(res.error, /answer directly/, "the model must be told to answer rather than to retry forever");
  }
});

test("coerceClarification refuses a clarification with no question", () => {
  for (const args of [undefined, null, {}, "", { options: ["a?", "b?"] }, { question: "   ", options: ["a?", "b?"] }]) {
    const res = coerceClarification(args);
    assert.equal(res.ok, false);
    assert.match(res.error, /question/i);
  }
});

test("coerceClarification trims over-long strings instead of dropping the option", () => {
  // Dropping one can push the set under the two-option floor and turn a good
  // clarification into an error, so the label is cut — at a word boundary, and
  // with no ellipsis, because it is about to be SENT as the reader's question.
  const longWords = `${"word ".repeat(40)}end`;
  const res = coerceClarification({
    question: longWords,
    options: [
      { label: longWords, hint: longWords },
      { label: "Who deployed it?" },
    ],
  });
  assert.equal(res.ok, true);
  assert.ok(res.question.length <= 160, `question was ${res.question.length} characters`);
  assert.ok(res.options[0].label.length <= 80, `label was ${res.options[0].label.length} characters`);
  assert.ok(res.options[0].hint.length <= 90, `hint was ${res.options[0].hint.length} characters`);
  for (const text of [res.question, res.options[0].label, res.options[0].hint]) {
    assert.equal(text.endsWith("…"), false, "a question ending in an ellipsis reads as broken, not as shortened");
    assert.equal(text, text.trim());
  }
  // A label with no spaces in it has no boundary to cut on, and must still fit.
  const solid = coerceClarification({
    question: "Which reading?",
    options: ["x".repeat(300), "Who deployed it?"],
  });
  assert.equal(solid.options[0].label.length, 80);
});

test("coerceClarification flattens newlines and control characters out of a label", () => {
  const res = coerceClarification({
    question: "Which\nreading?",
    options: ["Who holds\tthe\u0000most?", "Who deployed it?"],
  });
  assert.equal(res.question, "Which reading?");
  assert.equal(res.options[0].label, "Who holds the most?");
});

/* ------------------------------ the dispatcher ------------------------------ */

test("dispatchTool answers ask_clarification without touching the chain", async () => {
  // TERMINAL: it gathers nothing, so not one data module may be called for it.
  const { impls, calls } = fakes();
  const res = await dispatchTool(
    "ask_clarification",
    {
      question: "Which of those do you mean by the main benefactor?",
      options: [
        { label: "Who holds the most of it?", hint: "the ranked holder list" },
        { label: "Who deployed it?", hint: "the minting address" },
        { label: "Who has taken the most out?", hint: "the largest recent sells" },
      ],
    },
    impls,
  );
  assert.deepEqual(res, {
    ok: true,
    kind: "clarification",
    evidence: {
      question: "Which of those do you mean by the main benefactor?",
      options: [
        { label: "Who holds the most of it?", hint: "the ranked holder list" },
        { label: "Who deployed it?", hint: "the minting address" },
        { label: "Who has taken the most out?", hint: "the largest recent sells" },
      ],
    },
  });
  assert.deepEqual(calls, [], "a clarification must not spend an indexer call");
});

test("dispatchTool refuses a one-option clarification, and still calls nothing", async () => {
  const { impls, calls } = fakes();
  const res = await dispatchTool("ask_clarification", { question: "Which?", options: ["Who holds the most?"] }, impls);
  assert.equal(res.ok, false);
  assert.match(res.error, /answer directly/);
  assert.deepEqual(calls, []);
});

test("dispatchTool answers ask_clarification with no test seam at all", async () => {
  // No fakes, and therefore proof that this path cannot reach the network: the
  // real data modules are never even assembled for it.
  const res = await dispatchTool("ask_clarification", {
    question: "Which reading?",
    options: ["Who holds the most?", "Who deployed it?"],
  });
  assert.equal(res.ok, true);
  assert.equal(res.kind, "clarification");
  assert.equal(res.evidence.options.length, 2);
});


test("dispatchTool rejects an unknown tool name and lists the real ones", async () => {
  for (const name of ["lookup_stonks", "", null, undefined, 42, {}, "LOOKUP_TOKEN"]) {
    const res = await dispatchTool(name, { query: "nvda" }, fakes().impls);
    assert.equal(res.ok, false);
    assert.match(res.error, /Unknown tool/);
    assert.match(res.error, /lookup_token/, "the model must be able to recover from the message");
  }
});

test("dispatchTool tolerates a padded tool name", async () => {
  const { impls, calls } = fakes();
  const res = await dispatchTool("  market_overview  ", {}, impls);
  assert.equal(res.ok, true);
  assert.equal(calls[0].name, "marketOverview");
});

test("dispatchTool sends a ticker or address straight to gatherEvidence", async () => {
  for (const query of ["nvda", "$tsla", "apple", NVDA_ADDRESS]) {
    const { impls, calls } = fakes();
    const res = await dispatchTool("lookup_token", { query }, impls);
    assert.equal(res.ok, true);
    assert.equal(res.kind, "token");
    assert.deepEqual(calls.map((c) => c.name), ["gatherEvidence"], `${query} should not need resolving first`);
    assert.deepEqual(calls[0].args, [query], "the query must reach the resolver unchanged");
  }
});

/* ---------------- asking when the depth measurement did not settle it ---------------- */

/** A gatherEvidence result carrying a resolver collision verdict. */
const withCollision = (collision) => ({
  ok: true,
  kind: "token",
  target: "VLAD",
  evidence: { stock: { symbol: "VLAD", address: "0x31be", collision }, token: {} },
});

const CONTENDERS = [
  {
    address: "0xaaaa000000000000000000000000000000000001",
    symbol: "DUAL",
    name: "Alpha",
    quoteLiquidityUsd: 50_000,
    label: '0xaaaa…0001 ("Alpha")',
    display: { quoteLiquidity: "$50.00K", marketCap: "$1.00M" },
  },
  {
    address: "0xbbbb000000000000000000000000000000000002",
    symbol: "DUAL",
    name: "Beta",
    quoteLiquidityUsd: 30_000,
    label: '0xbbbb…0002 ("Beta")',
    display: { quoteLiquidity: "$30.00K", marketCap: "$2.00M" },
  },
];

test("a lookup whose collision is genuinely ambiguous asks instead of picking", async () => {
  // Two live markets under one ticker and neither dominates. Quietly answering
  // about one reports that market's figures as though they were the ticker's.
  const { impls } = fakes({
    gatherEvidence: async () =>
      withCollision({ verdict: "ambiguous", ambiguous: true, symbol: "DUAL", contenders: CONTENDERS }),
  });
  const res = await dispatchTool("lookup_token", { query: "dual" }, impls);

  assert.equal(res.ok, true);
  assert.equal(res.kind, "clarification", "the same terminal shape ask_clarification produces");
  assert.equal(res.evidence.options.length, 2);
  // A label is sent back VERBATIM as the reader's next question, so it has to
  // carry the FULL address — the ticker is exactly what was ambiguous.
  assert.equal(res.evidence.options[0].label, `What is ${CONTENDERS[0].address}?`);
  assert.match(res.evidence.options[0].hint, /Alpha/);
  assert.match(res.evidence.options[0].hint, /\$50\.00K/);
  assert.match(res.evidence.question, /DUAL/);
});

test("a collision one contract dominates is answered directly, with no menu", async () => {
  // VLAD: $69,583.29 against $3.92. A menu for a case this clear-cut would be its
  // own failure, so the verdict has to reach the answer as an answer.
  const { impls } = fakes({
    gatherEvidence: async () =>
      withCollision({ verdict: "dominant", ambiguous: false, symbol: "VLAD", contenders: [CONTENDERS[0]] }),
  });
  const res = await dispatchTool("lookup_token", { query: "vlad" }, impls);
  assert.equal(res.kind, "token");
  assert.equal(res.evidence.stock.collision.verdict, "dominant");
});

test("shallow, unmeasured and absent collisions are all answered, never asked about", async () => {
  for (const collision of [
    { verdict: "shallow", ambiguous: false, contenders: [] },
    { verdict: "unmeasured", ambiguous: false, contenders: [] },
    // A menu needs two things to choose between; one contender is a delay.
    { verdict: "ambiguous", ambiguous: true, contenders: [CONTENDERS[0]] },
    null,
  ]) {
    const { impls } = fakes({ gatherEvidence: async () => withCollision(collision) });
    const res = await dispatchTool("lookup_token", { query: "vlad" }, impls);
    assert.equal(res.kind, "token", `verdict ${collision?.verdict ?? "null"} must not produce a menu`);
  }
});

test("dispatchTool resolves a multi-word company name, then reuses the ticker path", async () => {
  // The ticker path is the only one that carries the impostor warning, so a
  // company name is resolved to its symbol and handed back to it.
  const { impls, calls } = fakes();
  const res = await dispatchTool("lookup_token", { query: "coca cola" }, impls);
  assert.equal(res.ok, true);
  assert.deepEqual(calls.map((c) => c.name), ["resolveSymbol", "gatherEvidence"]);
  assert.deepEqual(calls[1].args, ["KO"], "gatherEvidence gets the resolved ticker");
  assert.deepEqual(res.evidence.resolvedQuery, {
    asked: "coca cola",
    symbol: "KO",
    address: "0x00000000000000000000000000000000000000ko",
  });
});

test("dispatchTool reports an unresolvable company name instead of inventing one", async () => {
  const { impls } = fakes({
    resolveSymbol: () => Promise.resolve({ ok: false, match: null, reason: "nope" }),
  });
  const res = await dispatchTool("lookup_token", { query: "not a real company" }, impls);
  assert.equal(res.ok, false);
  assert.match(res.error, /No token matching "not a real company"/);
  assert.match(res.error, /call lookup_token again/, "the model is told how to retry");
});

test("dispatchTool passes coerced rank arguments through, junk and all", async () => {
  const { impls, calls } = fakes();
  const res = await dispatchTool("rank_stocks", { metric: "banana", limit: 999, direction: "sideways" }, impls);
  assert.equal(res.ok, true);
  assert.deepEqual(calls[0].args, [{ metric: "marketCap", direction: "desc", limit: 25 }]);

  const holders = fakes();
  await dispatchTool("rank_stocks", { metric: "holders", limit: 3 }, holders.impls);
  assert.deepEqual(holders.calls[0].args, [{ metric: "holders", direction: "desc", limit: 3 }]);
});

test("dispatchTool accepts a bare string where compare_tokens wanted an array", async () => {
  const { impls, calls } = fakes();
  const res = await dispatchTool("compare_tokens", { queries: "tsla vs nvda" }, impls);
  assert.equal(res.ok, true);
  assert.equal(res.kind, "comparison");
  assert.deepEqual(calls[0].args, [["tsla", "nvda"]]);
});

test("dispatchTool refuses a one-target comparison without calling anything", async () => {
  const { impls, calls } = fakes();
  const res = await dispatchTool("compare_tokens", { queries: "nvda" }, impls);
  assert.equal(res.ok, false);
  assert.match(res.error, /lookup_token/);
  assert.deepEqual(calls, [], "a bad comparison must not spend an indexer call");
});

test("dispatchTool ignores stray arguments on market_overview", async () => {
  const { impls, calls } = fakes();
  for (const args of [undefined, null, {}, { metric: "marketCap" }, "trending"]) {
    const res = await dispatchTool("market_overview", args, impls);
    assert.equal(res.ok, true);
    assert.equal(res.kind, "overview");
  }
  assert.equal(calls.length, 5);
  assert.deepEqual(calls[0].args, [], "marketOverview takes nothing");
});

test("dispatchTool routes wallets, transactions and safety checks to their gatherers", async () => {
  const wallet = fakes();
  await dispatchTool("lookup_wallet", { address: NVDA_ADDRESS }, wallet.impls);
  assert.deepEqual(wallet.calls, [{ name: "gatherEvidence", args: [NVDA_ADDRESS] }]);

  const tx = fakes();
  await dispatchTool("lookup_transaction", { hash: TX_HASH }, tx.impls);
  assert.deepEqual(tx.calls, [{ name: "gatherEvidence", args: [TX_HASH] }]);

  const safety = fakes();
  const res = await dispatchTool("safety_check", { target: "nvda" }, safety.impls);
  assert.equal(res.kind, "safety");
  assert.deepEqual(safety.calls, [{ name: "safetyReport", args: ["nvda"] }]);
});

test("dispatchTool passes a failed lookup through unchanged", async () => {
  const { impls } = fakes({
    safetyReport: () => Promise.resolve({ ok: false, error: "indexer down" }),
  });
  assert.deepEqual(await dispatchTool("safety_check", { target: "nvda" }, impls), {
    ok: false,
    error: "indexer down",
  });
});

test("dispatchTool turns a thrown gatherer into an error the model can answer around", async () => {
  const boom = () => Promise.reject(new Error("socket hang up"));
  for (const [tool, args, key] of [
    ["lookup_token", { query: "nvda" }, "gatherEvidence"],
    ["lookup_wallet", { address: NVDA_ADDRESS }, "gatherEvidence"],
    ["lookup_transaction", { hash: TX_HASH }, "gatherEvidence"],
    ["rank_stocks", {}, "rankStocks"],
    ["compare_tokens", { queries: ["nvda", "tsla"] }, "compareTargets"],
    ["market_overview", {}, "marketOverview"],
    ["safety_check", { target: "nvda" }, "safetyReport"],
  ]) {
    const { impls } = fakes({ [key]: boom });
    const res = await dispatchTool(tool, args, impls);
    assert.equal(res.ok, false, `${tool} let an exception escape`);
    assert.match(res.error, /socket hang up/);
    assert.match(res.error, /rather than guessing/);
  }
});

test("dispatchTool never throws on junk arguments, for any tool", async () => {
  const junk = [
    undefined,
    null,
    {},
    "",
    "   ",
    0,
    42,
    true,
    [],
    ["nvda"],
    [1, 2, 3],
    { query: {} },
    { query: [] },
    { query: null },
    { queries: 5 },
    { queries: {} },
    { queries: [null, undefined] },
    { limit: {} },
    { metric: [] },
    { address: "0x" },
    { hash: "0x" },
    { target: "\u0000\u0000" },
    { query: "a".repeat(5000) },
    { unexpected: "field" },
  ];
  for (const name of TOOL_NAMES) {
    for (const args of junk) {
      const { impls } = fakes();
      const res = await dispatchTool(name, args, impls);
      assert.equal(typeof res, "object", `${name} returned a non-object for ${JSON.stringify(args)}`);
      assert.equal(typeof res.ok, "boolean", `${name} returned no ok flag for ${JSON.stringify(args)}`);
      if (!res.ok) {
        assert.equal(typeof res.error, "string", `${name} failed without a message for ${JSON.stringify(args)}`);
        assert.ok(res.error.length > 0);
      }
    }
  }
});

test("dispatchTool works without the test seam, on argument errors alone", async () => {
  // No fakes here: these paths must fail in coercion, before any real module is
  // touched, so the assertion doubles as proof that they never hit the network.
  assert.equal((await dispatchTool("nope", {})).ok, false);
  assert.equal((await dispatchTool("lookup_token", {})).ok, false);
  assert.equal((await dispatchTool("lookup_wallet", { address: "nvda" })).ok, false);
  assert.equal((await dispatchTool("lookup_transaction", { hash: NVDA_ADDRESS })).ok, false);
  assert.equal((await dispatchTool("compare_tokens", { queries: "nvda" })).ok, false);
  assert.equal((await dispatchTool("safety_check", {})).ok, false);
  assert.equal((await dispatchTool("ask_clarification", { question: "which?" })).ok, false);
});
