/**
 * THE DOCS PAGE'S PROMISES, CHECKED AGAINST THE THING THAT MEASURES THEM.
 *
 * app/(marketing)/docs/page.js prints forty phrasings under six headings and
 * tells the reader which lookups answer each heading. Somebody reads one, types
 * it into the box, and expects what the page said. That is a promise, and until
 * this file existed nothing checked it: "did they just buy" sat under "Holders &
 * distribution" while the router sent it to trace_wallet, which is filed under
 * "Wallets" — the page was wrong and only a surprised reader would ever find out.
 *
 * A page that promises behaviour the router does not deliver is the same class of
 * defect as an answer that promises data the chain does not have. Both are the
 * product saying something it cannot back.
 *
 * WHAT IS ASSERTED, AND WHAT DELIBERATELY IS NOT. This file is offline and free,
 * so it cannot ask the model anything. What it CAN establish is that every
 * phrasing on the page is one scripts/route-bench.mjs actually measures, and that
 * the lookup each measured row exists to exercise is one the page names in the
 * same group. Whether the live router hits it is the bench's job, and the bench
 * costs money — but a phrasing with no row is a promise nobody has ever scored,
 * and that is catchable here.
 *
 * The link is EXPLICIT rather than fuzzy-matched. A normalizer clever enough to
 * pair "whats moving" with "whats moving in nvda" is clever enough to pair them
 * wrongly — those are two different questions filed under two different headings,
 * and one table entry is worth more than any amount of string cleaning.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CAPABILITY_GROUPS } from "../lib/docs-capabilities.js";
import { CORPUS } from "../scripts/routing-corpus.mjs";

/**
 * Every phrasing on the docs page -> the corpus row that measures it.
 *
 * Keyed by the exact string the page prints, so a phrasing that is edited on the
 * page fails here until somebody says which row now covers it. The page's
 * elliptical forms ("is 0x465… safe") map to the row that spells the same
 * question out in full.
 */
const MEASURED_BY = Object.freeze({
  // Identity & safety
  "is this the real NVDA": "coll-safety-1",
  "is 0x465… safe": "coll-safety-2",
  "who deployed this": "coll-contract-1",
  "is the contract verified": "coll-contract-2",
  "whats that nvidia one called": "search-1",
  "es real este token": "coll-safety-3",
  // Price, market & the board
  "hows nvda doin": "token-1",
  "how much apple": "token-2",
  "tsla vs nvda which is better": "compare-1",
  "top 3": "rank-1",
  "whats moving": "movers-3",
  "whats good today": "market-4",
  "que es nvda": "token-3",
  // Following the money
  "where did the funds go from 0xabc…": "flows-1",
  "my wallet was drained, show me the last transfers out": "flows-2",
  "who did this address send to": "flows-3",
  "a donde fueron los fondos": "flows-4",
  "trace the nvda that left 0xabc…": "trace-funds-1",
  // Holders & distribution
  "who holds nvda": "holders-1",
  "is this concentrated": "holders-2",
  "how long have holders held": "holdtime-1",
  "did they just buy": "holdtime-2",
  "was this bundled": "bundle-1",
  "does this look organised": "flag-1",
  "who holds both 0x31ba… and 0xa15c…": "overlap-2",
  "what else do these holders hold": "coholding-1",
  // Flow, trades & one transaction
  "whats moving in nvda": "transfers-1",
  "whos dumping nvda": "whale-1",
  "who is selling right now": "trades-1",
  "is the volume real": "volume-1",
  "why did my swap eat 97% of my bag": "swap-1",
  "what happened here 0xdead…": "tx-1",
  // Wallets
  "whats in 0xabc…": "wallet-1",
  "is this a whale": "wallet-2",
  "has this wallet ever sold nvda": "trace-1",
  "is this guy accumulating 0xabc…": "wallet-4",
  "who does this wallet trade with": "counterparty-1",
  "cuanto tiene 0xabc…": "wallet-3",
  // A whole project
  "is this project real": "live-2",
  "is this a larp": "live-3",
  "check this out for me": "notool-1",
  "whats the deal with this one": "notool-4",
  "wen moon or is it fake": "notool-5",
  "0x31be…bf81": "notool-8",
  "这个项目是真的吗 0x31be…": "lang-1",
});

const ROW_BY_ID = new Map(CORPUS.map((row) => [row.id, row]));
const asksOf = (group) => group.asks;

test("every phrasing the docs page offers has a row that measures it", () => {
  for (const group of CAPABILITY_GROUPS) {
    for (const ask of asksOf(group)) {
      const id = MEASURED_BY[ask];
      assert.ok(
        id,
        `the docs page offers "${ask}" under "${group.title}" and no corpus row measures it — ` +
          "add one to scripts/routing-corpus.mjs, or take the phrasing off the page",
      );
      assert.ok(ROW_BY_ID.has(id), `"${ask}" maps to corpus row ${id}, which does not exist`);
    }
  }
});

test("the lookup each row exists to exercise is one the page names beside it", () => {
  for (const group of CAPABILITY_GROUPS) {
    for (const ask of asksOf(group)) {
      const row = ROW_BY_ID.get(MEASURED_BY[ask]);
      // A row that demands NO tool has nothing to check against a tool list —
      // the page never offers one of those as a capability.
      if (!row.primary) continue;
      assert.ok(
        group.tools.includes(row.primary),
        `the docs page files "${ask}" under "${group.title}", whose lookups are ` +
          `${group.tools.join(", ")} — but the corpus measures it as ${row.primary}. ` +
          "Either the routing is wrong or the page is; both are defects.",
      );
    }
  }
});

test("no corpus row is claimed by two different phrasings", () => {
  // One row measuring two page entries would let a failure on one hide behind a
  // pass on the other.
  const seen = new Map();
  for (const [ask, id] of Object.entries(MEASURED_BY)) {
    assert.ok(!seen.has(id), `corpus row ${id} is claimed by both "${seen.get(id)}" and "${ask}"`);
    seen.set(id, ask);
  }
});

test("the table has no entries for phrasings the page no longer prints", () => {
  // A stale entry is a test that passes for a promise nobody makes any more, and
  // it would keep a corpus row alive for no reason.
  const printed = new Set(CAPABILITY_GROUPS.flatMap(asksOf));
  for (const ask of Object.keys(MEASURED_BY)) {
    assert.ok(printed.has(ask), `the table maps "${ask}", which is not on the docs page any more`);
  }
});

test("every lookup the page advertises is one the tool catalogue actually has", () => {
  const named = new Set(CAPABILITY_GROUPS.flatMap((g) => g.tools));
  const corpusTools = new Set(CORPUS.flatMap((row) => row.accept.flat()));
  for (const name of named) {
    assert.ok(corpusTools.has(name), `the docs page advertises "${name}", which no corpus row can reach`);
  }
});
