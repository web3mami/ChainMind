// Tests for the /api/ask intent router (lib/ask-intent.js).
//
// Two failures are being guarded against, both of which shipped as real bugs:
// a question with no 0x target was rejected outright, and an ordinary English
// word in caps ("What are the TOP stocks") was resolved as a ticker, so the
// user got a confident answer about an unrelated token.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INTENTS,
  asksForCostBasis,
  classifyIntent,
  extractTargets,
  isOffChainKnowledge,
  parseRankQuery,
} from "../lib/ask-intent.js";

const TX = `0x${"a".repeat(64)}`;
const ADDR = `0x${"b".repeat(40)}`;
const FAKE_NVDA = "0x465834D5BA3af2169E49B70A139448e59e3CA492";

/** Intent name only — the phrasings matter more than the score. */
function intentOf(q) {
  return classifyIntent(q, extractTargets(q)).intent;
}

/* ------------------------------ extractTargets ---------------------------- */

test("extractTargets pulls hashes, addresses and tickers apart", () => {
  const t = extractTargets(`did ${ADDR} send NVDA in ${TX}?`);
  assert.deepEqual(t.txs, [TX]);
  assert.deepEqual(t.addresses, [ADDR]);
  assert.deepEqual(t.symbols, ["NVDA"]);
});

test("extractTargets keeps checksummed mixed case intact", () => {
  assert.deepEqual(extractTargets(`is ${FAKE_NVDA} the real one`).addresses, [FAKE_NVDA]);
});

test("extractTargets keeps multiple symbols in the order typed", () => {
  assert.deepEqual(extractTargets("Compare NVDA and TSLA").symbols, ["NVDA", "TSLA"]);
  assert.deepEqual(extractTargets("NVDA vs TSLA vs AAPL").symbols, ["NVDA", "TSLA", "AAPL"]);
});

test("extractTargets de-duplicates without reordering", () => {
  assert.deepEqual(extractTargets("NVDA vs TSLA vs NVDA").symbols, ["NVDA", "TSLA"]);
  assert.deepEqual(extractTargets(`${ADDR} and ${ADDR.toUpperCase()}`).addresses, [ADDR]);
});

test("extractTargets never treats common words as tickers", () => {
  // The shipped bug: "TOP" became a ticker and the ranking question turned into
  // a lookup of whatever token answers to TOP.
  assert.deepEqual(extractTargets("What are the TOP stocks by MARKET CAP?").symbols, []);
  assert.deepEqual(extractTargets("MY portfolio holds ALL of them").symbols, []);
  assert.deepEqual(extractTargets("WHAT IS THE BEST AND WORST TOKEN").symbols, []);
  assert.deepEqual(extractTargets("IS THIS SAFE OR IS IT A SCAM").symbols, []);
});

test("extractTargets ignores lowercase words that happen to be tickers", () => {
  // NOW, BE and COST are live equity tokens; their lowercase English uses are
  // not, which is why case is part of the match rather than a stopword entry.
  assert.deepEqual(extractTargets("what is trending now").symbols, []);
  assert.deepEqual(extractTargets("what does it cost to be listed").symbols, []);
});

test("extractTargets honours an explicit $ marker in any case", () => {
  assert.deepEqual(extractTargets("tell me about $tsla").symbols, ["TSLA"]);
  assert.deepEqual(extractTargets("how is $ALL doing").symbols, ["ALL"], "$ overrides the stopword");
  assert.deepEqual(extractTargets("$NOW vs $nvda").symbols, ["NOW", "NVDA"]);
});

test("extractTargets refuses an over-long hex run", () => {
  // An unanchored match would hand back the first 40 hex chars: a real-looking
  // address belonging to nobody the user typed.
  assert.deepEqual(extractTargets(`0x${"a".repeat(41)}`).addresses, [], "41 hex chars");
  assert.deepEqual(extractTargets(`0x${"a".repeat(65)}`).txs, [], "65 hex chars");
  assert.deepEqual(extractTargets(`0x${"A".repeat(41)}`).symbols, [], "no ticker inside hex either");
});

test("extractTargets refuses an under-long hex run", () => {
  assert.deepEqual(extractTargets(`0x${"a".repeat(39)}`).addresses, [], "39 hex chars");
  assert.deepEqual(extractTargets(`0x${"a".repeat(63)}`).txs, [], "63 hex chars");
  assert.deepEqual(extractTargets("0x").addresses, []);
});

test("extractTargets does not read a 64-hex hash as an address", () => {
  const t = extractTargets(`what happened in ${TX}`);
  assert.deepEqual(t.addresses, []);
  assert.deepEqual(t.txs, [TX]);
});

test("extractTargets tolerates non-string input", () => {
  for (const bad of [null, undefined, 42, {}]) {
    assert.deepEqual(extractTargets(bad), { txs: [], addresses: [], symbols: [] });
  }
});

/* ------------------------------ classifyIntent ---------------------------- */

test("classifyIntent: safety_check", () => {
  assert.equal(intentOf(`Is ${FAKE_NVDA} a real NVDA token or a scam?`), INTENTS.SAFETY_CHECK);
  assert.equal(intentOf("Is NVDA legit?"), INTENTS.SAFETY_CHECK);
  assert.equal(intentOf("Is this the official TSLA contract?"), INTENTS.SAFETY_CHECK);
});

test("classifyIntent: safety wins over a plain target lookup", () => {
  const r = classifyIntent(`is ${ADDR} verified`);
  assert.equal(r.intent, INTENTS.SAFETY_CHECK);
  assert.ok(r.matched.includes("verified"));
});

test("classifyIntent: safety needs a target", () => {
  // "Is it a scam?" with nothing named has nothing to check.
  assert.notEqual(intentOf("is it a scam"), INTENTS.SAFETY_CHECK);
});

test("classifyIntent: compare", () => {
  assert.equal(intentOf("Compare NVDA and TSLA"), INTENTS.COMPARE);
  assert.equal(intentOf("NVDA vs TSLA"), INTENTS.COMPARE);
  assert.equal(intentOf("What is the difference between AAPL and MSFT?"), INTENTS.COMPARE);
  assert.equal(intentOf(`${ADDR} versus ${FAKE_NVDA}`), INTENTS.COMPARE);
});

test("classifyIntent: compare is confident only with two named targets", () => {
  assert.equal(classifyIntent("Compare NVDA and TSLA").confidence, 0.9);
  assert.ok(classifyIntent("compare these for me").confidence < 0.9, "keyword alone is a guess");
});

test("classifyIntent: rank_stocks", () => {
  assert.equal(intentOf("What are the top stocks by market cap?"), INTENTS.RANK_STOCKS);
  assert.equal(intentOf("Which stock has the most holders?"), INTENTS.RANK_STOCKS);
  assert.equal(intentOf("Show me the 5 cheapest tokens"), INTENTS.RANK_STOCKS);
  assert.equal(intentOf("top stocks"), INTENTS.RANK_STOCKS, "bare ranking, no metric named");
  assert.equal(intentOf("highest volume tokens"), INTENTS.RANK_STOCKS);
});

test("classifyIntent: market_overview", () => {
  assert.equal(intentOf("What is trending on Robinhood Chain?"), INTENTS.MARKET_OVERVIEW);
  assert.equal(intentOf("Give me an overview of the chain"), INTENTS.MARKET_OVERVIEW);
  assert.equal(intentOf("How is the market doing today?"), INTENTS.MARKET_OVERVIEW);
  assert.equal(intentOf("Show me recent whale moves"), INTENTS.MARKET_OVERVIEW);
});

test("classifyIntent: a named target beats the overview reading", () => {
  assert.equal(intentOf("what is trending for NVDA"), INTENTS.EXPLAIN_TARGET);
});

test("classifyIntent: explain_target", () => {
  assert.equal(intentOf(`What happened in ${TX}?`), INTENTS.EXPLAIN_TARGET);
  assert.equal(intentOf(`Explain ${ADDR}`), INTENTS.EXPLAIN_TARGET);
  assert.equal(intentOf("Tell me about NVDA"), INTENTS.EXPLAIN_TARGET);
});

test("classifyIntent: an exact hex target outranks an inferred ticker", () => {
  assert.equal(classifyIntent(`Explain ${ADDR}`).confidence, 0.9);
  assert.equal(classifyIntent("Tell me about NVDA").confidence, 0.8);
});

test("classifyIntent: explain_chain", () => {
  assert.equal(intentOf("What is Robinhood Chain?"), INTENTS.EXPLAIN_CHAIN);
  assert.equal(intentOf("How does this work?"), INTENTS.EXPLAIN_CHAIN);
  assert.equal(intentOf("What are stock tokens?"), INTENTS.EXPLAIN_CHAIN);
  assert.equal(intentOf("What is a tokenized equity?"), INTENTS.EXPLAIN_CHAIN);
});

/* --------------------------- off-chain knowledge -------------------------- */

// Reported by a user testing the live site: "who is the founder?" was answered
// with "The founder of Robinhood Chain is not specified in the provided market
// overview". The market tool had been used as the fallback for a question about
// a person, and its evidence then got described back at the user as an absence.
// Founders, teams and roadmaps are not on-chain and never will be, so these
// questions must reach the tool-free path instead of any lookup.

test("isOffChainKnowledge: people, teams, the company and its plans", () => {
  for (const q of [
    "who is the founder?",
    "who is the co founder?",
    "whos the cofounder",
    "who is behind this?",
    "who made this",
    "who built robinhood chain",
    "who runs the project",
    "who is the ceo",
    "how big is the team",
    "tell me about the team behind it",
    "when was it founded",
    "what is the roadmap",
    "is there a whitepaper",
    "who are the investors",
    "what are the tokenomics",
  ]) {
    assert.equal(isOffChainKnowledge(q), true, q);
  }
});

test("isOffChainKnowledge leaves on-chain questions alone", () => {
  for (const q of [
    // The deployer IS a field, so "who is behind this contract" is a real lookup.
    "who deployed this contract",
    "who is behind this contract",
    "who is the issuer of NVDA",
    "who holds the most NVDA",
    "whats trending",
    "top 10 stocks by market cap",
    "what is robinhood chain",
    "hows nvda doin",
    `is ${FAKE_NVDA} legit`,
    "",
  ]) {
    assert.equal(isOffChainKnowledge(q), false, q);
  }
  // Total, like the rest of this module: any input type, never a throw.
  assert.equal(isOffChainKnowledge(null), false);
  assert.equal(isOffChainKnowledge(42), false);
});

test("classifyIntent: a question about people is never a market question", () => {
  for (const q of ["who is the founder?", "who is the co founder?", "who is behind this?", "what is the roadmap"]) {
    const r = classifyIntent(q, extractTargets(q));
    assert.equal(r.intent, INTENTS.EXPLAIN_CHAIN, q);
    assert.notEqual(r.intent, INTENTS.MARKET_OVERVIEW, q);
    assert.ok(r.matched.length, "the phrase that fired is reported");
  }
});

test("classifyIntent: off-chain knowledge outranks the overview and the lookup", () => {
  // Both of these also read as something the router would otherwise answer with
  // real data about a different question.
  assert.equal(intentOf("whats the roadmap, and whats trending"), INTENTS.EXPLAIN_CHAIN);
  assert.equal(intentOf("who is the founder of NVDA"), INTENTS.EXPLAIN_CHAIN);
});

test("classifyIntent: unknown", () => {
  assert.equal(intentOf("hello there"), INTENTS.UNKNOWN);
  assert.equal(intentOf("What is the weather?"), INTENTS.UNKNOWN);
  assert.equal(classifyIntent("").intent, INTENTS.UNKNOWN);
});

test("classifyIntent reports the phrases that fired, lowercased and unique", () => {
  const r = classifyIntent("What are the TOP stocks by market cap?");
  assert.equal(r.intent, INTENTS.RANK_STOCKS);
  assert.ok(r.matched.includes("top"));
  assert.ok(r.matched.includes("market cap"));
  assert.equal(r.matched.length, new Set(r.matched).size);
});

test("classifyIntent recomputes targets when none are passed", () => {
  assert.equal(classifyIntent("Compare NVDA and TSLA").intent, INTENTS.COMPARE);
  assert.equal(classifyIntent("Compare NVDA and TSLA", null).intent, INTENTS.COMPARE);
});

test("classifyIntent tolerates non-string input", () => {
  const r = classifyIntent(null, { txs: [], addresses: [], symbols: [] });
  assert.equal(r.intent, INTENTS.UNKNOWN);
  assert.equal(r.confidence, 0);
  assert.deepEqual(r.matched, []);
});

/* ------------------------------ parseRankQuery ---------------------------- */

test("parseRankQuery defaults to the 10 biggest by market cap", () => {
  assert.deepEqual(parseRankQuery("top stocks"), { metric: "marketCap", direction: "desc", limit: 10 });
  assert.deepEqual(parseRankQuery(""), { metric: "marketCap", direction: "desc", limit: 10 });
  assert.deepEqual(parseRankQuery(null), { metric: "marketCap", direction: "desc", limit: 10 });
});

test("parseRankQuery reads the metric", () => {
  assert.equal(parseRankQuery("top stocks by market cap").metric, "marketCap");
  assert.equal(parseRankQuery("most valuable tokens").metric, "marketCap");
  assert.equal(parseRankQuery("which stock has the most holders").metric, "holders");
  assert.equal(parseRankQuery("top stocks by holder count").metric, "holders");
  assert.equal(parseRankQuery("highest volume today").metric, "volume24h");
  assert.equal(parseRankQuery("most traded tokens").metric, "volume24h");
  assert.equal(parseRankQuery("highest price per share").metric, "price");
  assert.equal(parseRankQuery("cheapest stocks").metric, "price");
});

test("parseRankQuery reads the direction", () => {
  assert.equal(parseRankQuery("biggest stocks").direction, "desc");
  assert.equal(parseRankQuery("cheapest stocks").direction, "asc");
  assert.equal(parseRankQuery("lowest price").direction, "asc");
  assert.equal(parseRankQuery("smallest market cap").direction, "asc");
  assert.equal(parseRankQuery("worst performers").direction, "asc");
});

test("parseRankQuery reads an explicit count either side of the ranking word", () => {
  assert.equal(parseRankQuery("top 5 stocks by market cap").limit, 5);
  assert.equal(parseRankQuery("10 biggest tokens").limit, 10);
  assert.equal(parseRankQuery("bottom 3 by holders").limit, 3);
});

test("parseRankQuery clamps the count to 1..25", () => {
  assert.equal(parseRankQuery("top 100 stocks").limit, 25);
  assert.equal(parseRankQuery("top 0 stocks").limit, 1);
  assert.equal(parseRankQuery("top 999 stocks").limit, 25);
});

test("parseRankQuery combines metric, direction and count", () => {
  assert.deepEqual(parseRankQuery("show me the 5 cheapest stocks"), {
    metric: "price",
    direction: "asc",
    limit: 5,
  });
});

/* ------------------------------ cost basis ------------------------------ */

test("a question about profit or what a position cost is recognised", () => {
  // MEASURED: asked for a wallet's PnL, the answer was "I could not read the
  // wallet's transaction history for every token it holds, so whether it is in
  // profit is unknown." That history reads in one call and nothing had failed —
  // there is simply no cost-basis lookup. Detecting the question is what lets the
  // answer say that, instead of inventing an outage the reader will retry.
  for (const q of [
    "whats the pnl for 0xabc in the last 7 days",
    "is this wallet in profit",
    "P&L please",
    "what is my cost basis on nvda",
    "whats my entry price",
    "is 0xabc up or down on catcall",
    "how much has this wallet made",
    "did they make any money",
    "are they losing money",
    "am i in the green",
    "whats the roi on this",
    "unrealized gains for this address",
    "is he break even yet",
  ]) {
    assert.equal(asksForCostBasis(q), true, `"${q}" asks what a position cost`);
  }
});

test("asking what a wallet holds or whether it sold is NOT a cost-basis question", () => {
  // The rule that matters. wallet_portfolio, trace_wallet, recent_trades and
  // whale_moves all answer real questions that sit next to profit, and a detector
  // that swallowed them would trade one bad answer for four missing ones — a worse
  // product than the defect it was meant to fix. Value held is not profit.
  for (const q of [
    "how much is this wallet worth",
    "what does 0xabc hold",
    "has this wallet ever sold nvda",
    "whats its net position",
    "who holds the most nvda",
    "who is dumping",
    "show me recent trades",
    "is the volume real",
    "whats the price of tsla",
    "how many holders does it have",
    "is this a larp",
    "hows nvda doin",
  ]) {
    assert.equal(asksForCostBasis(q), false, `"${q}" is answerable and must not be diverted`);
  }
});

test("the cost-basis check is total", () => {
  for (const bad of [null, undefined, 42, {}, [], "", "   "]) {
    assert.equal(asksForCostBasis(bad), false);
  }
  // Regex state must not carry between calls — every pattern here is /g, and a
  // shared lastIndex is the classic way a detector answers differently the second
  // time it is asked the same question.
  assert.equal(asksForCostBasis("is this wallet in profit"), true);
  assert.equal(asksForCostBasis("is this wallet in profit"), true);
  assert.equal(asksForCostBasis("is this wallet in profit"), true);
});
