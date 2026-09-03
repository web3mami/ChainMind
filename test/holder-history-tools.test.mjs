// Tests for the two holder-history lookups — holder_hold_time and bundle_check —
// as the model and the reader actually meet them: the tool catalogue
// (lib/ask-tools.js), the evidence assembly (lib/token-evidence.js) and the
// prompt rules that govern how the figures may be quoted (lib/ask-runner.js).
//
// lib/holder-history.js has its own 33 tests for the maths. What is defended
// HERE is the handover, which is where a qualifier gets dropped:
//
//  1. A LOWER BOUND MUST ARRIVE AS "AT LEAST N DAYS". Every quotable figure is a
//     STRING with the qualifier already inside it, and the raw days sit under
//     names that cannot be mistaken for one ("medianDaysRaw"). A median computed
//     over any bounded member is itself a lower bound and says so.
//  2. AN UNREAD HISTORY MUST NOT READ AS A FRESH BUY. The cell says so in words,
//     because a blank one reads as zero.
//  3. THE POOL, THE BURN ADDRESS AND THE TOKEN CONTRACT MUST NOT VANISH. They are
//     not holders and are out of the statistics, but they stay in the table with
//     their role named — measured on chain 4663, three of The Green Bull's top ten
//     were exactly those, and a median that quietly included the pool would be a
//     median of nobody.
//  4. NOTHING MAY HARDEN INTO AN ACCUSATION. bundle_check's description and its
//     evidence both have to say that co-acquisition is not intent, and the prompt
//     has to forbid the word the model would otherwise reach for.
//
// Fully offline: every indexer call and the pool resolver are injected, so
// nothing in this file can reach Blockscout or an RPC.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TOOL_NAMES,
  TOOL_SCHEMAS,
  coerceBundleQuery,
  coerceHoldTimeQuery,
  dispatchTool,
  toolSubject,
} from "../lib/ask-tools.js";
import { bundleCheck, holderHoldTime } from "../lib/token-evidence.js";
import { DEAD_ADDRESS, ZERO_ADDRESS, holdersOverThreshold } from "../lib/holder-history.js";
import { PHRASE_STEPS, progressLabel, stepForTool } from "../lib/thinking-phrases.js";
import { SYSTEM_PROMPT } from "../lib/ask-runner.js";
import { isTable } from "../lib/table-shape.js";

/** The measured subject: The Green Bull, chain 4663. */
const TOKEN = "0x31be8f7485e36928c9de86566c62da82d4b6bf81";
const POOL = "0x8f450b8ee3e5b0e2ab84b6a3a5a2b4f1c6d7e8a9";
const A = "0x42607b2e4f00000000000000000000000000000a";
const B = "0x71f2f1c2dc00000000000000000000000000000b";
const C = "0x875813ae0a00000000000000000000000000000c";
const D = "0xa226c8cd4a00000000000000000000000000000d";
const E = "0xfa23da506500000000000000000000000000000e";

const DAY = 86_400_000;
const NOW = Date.parse("2026-07-29T00:00:00.000Z");
const at = (days) => new Date(NOW - days * DAY).toISOString();

/** 18-decimal base units for a whole-token amount. */
const units = (n) => `${BigInt(Math.round(n * 1000))}${"0".repeat(15)}`;

const paramsOf = (name) => TOOL_SCHEMAS.find((s) => s.function.name === name).function.parameters;
const descOf = (name) => TOOL_SCHEMAS.find((s) => s.function.name === name).function.description;

const holderItem = (address, whole) => ({ address: { hash: address }, value: units(whole) });

/** One page of an address's transfers of this token, newest first as the indexer sends it. */
const page = (rows, { truncated = false } = {}) => ({
  items: rows.map(([block, days]) => ({ block_number: block, timestamp: at(days) })),
  ...(truncated ? { next_page_params: { block_number: rows[rows.length - 1][0] } } : {}),
});

/**
 * The indexer stand-in. Anything a lookup reaches for that this fixture did not
 * script rejects loudly, so a call that escaped to the network fails the test
 * rather than passing it slowly.
 */
function chain({ holders, transfers }) {
  const boom = (name) => () => Promise.reject(new Error(`unscripted call: ${name}`));
  return {
    getAddress: boom("getAddress"),
    getTokenActivity: boom("getTokenActivity"),
    getTokenCounters: boom("getTokenCounters"),
    getTransaction: boom("getTransaction"),
    searchChain: boom("searchChain"),
    getAddressTransactions: boom("getAddressTransactions"),
    listStockTokens: () => Promise.resolve([]),
    resolveSymbol: () => Promise.resolve({ ok: false, match: null }),
    verifiedByIssuer: () => Promise.resolve(false),
    getToken: () =>
      Promise.resolve({ name: "The Green Bull", symbol: "VLAD", type: "ERC-20", decimals: "18", total_supply: units(1000) }),
    getTokenHolders: () => Promise.resolve({ items: holders }),
    getTokenTransfers: (address) => Promise.resolve(transfers[String(address).toLowerCase()] ?? { items: [] }),
  };
}

/** The pool sweep's seam — the RPC leg, answered without an RPC. */
const poolsFound = () => Promise.resolve({ found: { pool: POOL }, pools: [{ pool: POOL }], reason: null });
const poolsUnread = () => Promise.resolve({ found: null, pools: [], reason: "rpc_error" });

/**
 * The measured shape of The Green Bull's top ten, reduced to what these two
 * lookups read: a launch cluster of three, a truncated pool, the burn address,
 * the token contract, a later buyer and one address whose history came back empty.
 */
function greenBull(resolvePool = poolsFound) {
  const holders = [
    holderItem(A, 210),
    holderItem(POOL, 180),
    holderItem(ZERO_ADDRESS, 150),
    holderItem(TOKEN, 90),
    holderItem(B, 80),
    holderItem(C, 70),
    holderItem(E, 60),
    holderItem(D, 40),
  ];
  const transfers = {
    [A]: page([[4_050_099, 21.5], [4_400_000, 12]]),
    [POOL]: page(
      Array.from({ length: 50 }, (_, i) => [21_538_348 + i, 1.2]),
      { truncated: true },
    ),
    [ZERO_ADDRESS]: page([[4_052_329, 21.5]]),
    [TOKEN]: page([[4_175_794, 21.4]]),
    [B]: page([[4_052_329, 21.5]]),
    [C]: page([[4_051_000, 21.5]]),
    [E]: page([[9_142_261, 15.6]]),
    // The one that told us nothing. Never a fresh buy.
    [D]: { items: [] },
  };
  return { calls: chain({ holders, transfers }), client: null, resolvePool, now: NOW };
}

/* ============================== the catalogue ============================== */

test("both holder-history tools are registered with usable schemas", () => {
  for (const name of ["holder_hold_time", "bundle_check"]) {
    assert.ok(TOOL_NAMES.includes(name), `${name} is missing from TOOL_NAMES`);
    const params = paramsOf(name);
    assert.deepEqual(params.required, ["query"], `${name} must require its one target`);
    assert.equal(typeof params.properties.query.description, "string");
    // The probe depth and the cluster window are fixed in lib/holder-history.js:
    // a threshold the model chose per question makes the finding unreproducible.
    assert.equal(params.properties.limit, undefined, `${name} must not let the caller tune the probe`);
    assert.equal(params.properties.windowBlocks, undefined, `${name} must not let the caller tune the window`);
  }
});

test("each description quotes the phrasings that must route to it", () => {
  // The description IS the router. These exact phrasings are the ones the feature
  // was asked for, so an edit that trims them fails here and not in production.
  for (const phrase of ["how long have holders held", "hold time", "diamond handing", "did they just buy", "paper hands"]) {
    assert.ok(descOf("holder_hold_time").includes(phrase), `holder_hold_time drops "${phrase}"`);
  }
  for (const phrase of ["who bundled this", "was this bundled", "is this a bundle", "snipe their own launch", "insiders"]) {
    assert.ok(descOf("bundle_check").includes(phrase), `bundle_check drops "${phrase}"`);
  }
  // And both have to say non-English and casual wording is fine, like every other
  // tool in the catalogue.
  assert.match(descOf("holder_hold_time"), /language|casual|informal|slang/i);
  assert.match(descOf("bundle_check"), /language|casual|informal|slang/i);
});

test("each description states what the tool CANNOT establish", () => {
  const hold = descOf("holder_hold_time");
  assert.match(hold, /WHAT IT CANNOT ESTABLISH/);
  assert.match(hold, /at least N days/, "a bounded hold time is never exact");
  assert.match(hold, /UNKNOWN hold time, never a short one/);
  assert.match(hold, /TOP ADDRESSES BY BALANCE/, "it is not the holder base");
  assert.match(hold, /pool/i);

  const bundle = descOf("bundle_check");
  assert.match(bundle, /WHAT IT CANNOT ESTABLISH/);
  assert.match(bundle, /never proof of intent/);
  assert.match(bundle, /airdrop/i, "the alternative explanations have to be named");
  assert.match(bundle, /never call the result a scam/);
  assert.match(bundle, /finding none is not a clearing/);
});

test("both tools name their own kind of work in the status line", () => {
  assert.equal(stepForTool("holder_hold_time"), PHRASE_STEPS.HOLD_TIME);
  assert.equal(stepForTool("bundle_check"), PHRASE_STEPS.BUNDLE);
  assert.equal(toolSubject("holder_hold_time", { symbol: "$vlad" }), "VLAD");
  assert.equal(toolSubject("bundle_check", { contract: TOKEN }), "0x31be…bf81");
  assert.equal(toolSubject("bundle_check", { query: "0xabc" }), null, "a malformed call has no honest subject");
  for (const step of [PHRASE_STEPS.HOLD_TIME, PHRASE_STEPS.BUNDLE]) {
    assert.ok(progressLabel(step, "VLAD").length <= 64, "a status row must not wrap");
    assert.ok(progressLabel(step).length > 0, "and must never be empty");
  }
});

/* ============================== coercion ============================== */

test("the two coercers take the target out of whichever key it arrived under", () => {
  for (const coerce of [coerceHoldTimeQuery, coerceBundleQuery]) {
    assert.equal(coerce({ query: "vlad" }).value, "vlad");
    assert.equal(coerce({ symbol: "$vlad" }).value, "$vlad");
    assert.equal(coerce({ contract: TOKEN }).value, TOKEN);
    assert.equal(coerce("the green bull").value, "the green bull");
  }
});

test("the two coercers refuse a truncated 0x and name themselves on an empty call", () => {
  for (const [coerce, name] of [[coerceHoldTimeQuery, "holder_hold_time"], [coerceBundleQuery, "bundle_check"]]) {
    assert.match(coerce({ query: "0xabc123" }).error, /40 hex/);
    assert.match(coerce({}).error, new RegExp(name));
    assert.match(coerce({ query: "a".repeat(200) }).error, /whole question/);
  }
});

test("dispatchTool routes both tools to their gatherers", async () => {
  const seen = [];
  const impls = {
    holderHoldTime: (q) => {
      seen.push(["holderHoldTime", q]);
      return Promise.resolve({ ok: true, kind: "holdTime", evidence: {} });
    },
    bundleCheck: (q) => {
      seen.push(["bundleCheck", q]);
      return Promise.resolve({ ok: true, kind: "bundle", evidence: {} });
    },
  };
  assert.equal((await dispatchTool("holder_hold_time", { query: "vlad" }, impls)).kind, "holdTime");
  assert.equal((await dispatchTool("bundle_check", { token: TOKEN }, impls)).kind, "bundle");
  assert.deepEqual(seen, [["holderHoldTime", "vlad"], ["bundleCheck", TOKEN]]);
});

/* ============================== hold time ============================== */

test("hold time reports a median over real holders and keeps the excluded rows visible", async () => {
  const res = await holderHoldTime(TOKEN, greenBull());
  assert.equal(res.ok, true);
  const e = res.evidence;

  // Five real holders: A, B, C, E measured and D unread. The pool, the burn
  // address and the token contract are labelled out of the statistics.
  assert.equal(e.countedHolders, 5);
  assert.equal(e.holdersWithReadableAge, 4);
  assert.equal(e.ageUnreadable, 1);
  assert.equal(e.excludedCount, 3);
  assert.deepEqual(
    e.excluded.map((x) => x.role).sort(),
    ["burn", "contract", "pool"],
    "the three non-holders must be named, not dropped",
  );
  for (const row of e.excluded) {
    assert.ok(row.roleLabel.length > 0, "an excluded row must say what it is");
    assert.ok(row.reason, "and why it is not a holder");
  }
  assert.match(e.excluded.find((x) => x.role === "pool").roleLabel, /liquidity, not a holder/i);

  // Every excluded address is still in the table the reader sees, so the rows
  // reconcile against the explorer's top list.
  assert.ok(isTable(e.table));
  assert.equal(e.table.rowCount, 8);
  for (const address of [POOL, ZERO_ADDRESS, TOKEN]) {
    assert.ok(e.table.rows.some((r) => r.address === address), `${address} vanished from the table`);
  }

  // A, B, C at 21.5 days and E at 15.6: the median of four is the middle pair,
  // both of which are 21.5.
  assert.equal(e.medianDisplay, "21.5 days");
  assert.equal(e.isLowerBound, false, "no REAL holder here was truncated");
  assert.equal(e.rangeDisplay, "15.6 days to 21.5 days");
  assert.ok(e.reading.includes("median hold time"));
});

test("a truncated history reaches the reader as \"at least N days\", never as a figure", async () => {
  // E's page comes back full, so its true first acquisition is EARLIER than the
  // block read and its hold time is LONGER than the number. Because every order
  // statistic is monotone in its inputs, the median is a lower bound too.
  const withPages = greenBull();
  const inner = withPages.calls.getTokenTransfers;
  withPages.calls.getTokenTransfers = (address) =>
    String(address).toLowerCase() === E
      ? Promise.resolve(page(Array.from({ length: 50 }, (_, i) => [9_142_261 + i, 15.6]), { truncated: true }))
      : inner(address);

  const res = await holderHoldTime(TOKEN, withPages);
  assert.equal(res.ok, true);
  const e = res.evidence;
  assert.equal(e.ageFloorOnly, 1);
  assert.equal(e.isLowerBound, true);
  assert.match(e.medianDisplay, /^at least /, "a bounded median must not be quotable as an exact figure");
  assert.match(e.rangeDisplay, /at least 15.6 days/);
  assert.match(e.reading, /LOWER BOUND/i);

  // The raw days exist for comparison and are deliberately NOT the quotable form.
  assert.equal(typeof e.medianDaysRaw, "number");
  assert.ok(!("medianDays" in e), "the unqualified name must not exist, or it will get printed");

  const row = e.table.rows.find((r) => r.address === E);
  assert.match(row.holdDisplay, /^at least /);
});

test("an unread history is unknown in words, never a blank cell and never a fresh buy", async () => {
  const res = await holderHoldTime(TOKEN, greenBull());
  const e = res.evidence;
  const row = e.table.rows.find((r) => r.address === D);
  assert.match(row.holdDisplay, /unknown/i);
  assert.ok(!/^0/.test(String(row.holdDisplay)), "an unread row must never render as a number");
  assert.equal(row.firstBlock, "unknown");
  assert.equal(e.unknownRows.length, 1);
  assert.equal(e.unknownRows[0].address, D);
  assert.ok(e.unknownRows[0].reason.includes("unread history"), "and it must say why");
  assert.match(e.table.note, /never a fresh buy/i);
  assert.match(e.disclaimer, /never probed/i);
});

test("the 0x…dEaD sink is a burn address, not a holder", async () => {
  // MEASURED, and the reason this test exists: The Green Bull's live top ten
  // carries 0x0000…dEaD holding 0.9% of supply, and the zero address is nowhere
  // in it. Matching only the zero address counted supply that is GONE toward the
  // hold-time figures and printed a burn as somebody's position.
  const fixture = {
    calls: chain({
      holders: [holderItem(A, 300), holderItem(DEAD_ADDRESS, 200), holderItem(B, 100)],
      transfers: {
        [A]: page([[4_050_099, 21.5]]),
        [DEAD_ADDRESS]: page([[4_052_329, 21.5]]),
        [B]: page([[8_000_000, 17]]),
      },
    }),
    client: null,
    resolvePool: poolsUnread,
    now: NOW,
  };
  const res = await holderHoldTime(TOKEN, fixture);
  const burn = res.evidence.excluded.find((x) => x.address === DEAD_ADDRESS);
  assert.ok(burn, "0x…dEaD must be excluded from the holder statistics");
  assert.equal(burn.role, "burn");
  assert.match(burn.reason, /burned, not held/);
  assert.equal(res.evidence.countedHolders, 2, "the burn must not be counted as a holder");
  // Still on screen, so the rows reconcile against the explorer's top list.
  assert.ok(res.evidence.table.rows.some((r) => r.address === DEAD_ADDRESS));
});

test("a pool that could not be identified is a stated caveat, not a silent absence", async () => {
  const res = await holderHoldTime(TOKEN, greenBull(poolsUnread));
  assert.equal(res.ok, true);
  const e = res.evidence;
  assert.equal(e.poolStatus, "unread");
  assert.match(e.poolCaveat, /may in fact be the pool/);
  assert.match(e.reading, /provisional/i);
  assert.ok(e.unavailable.includes("pool_identification"), "the gap has to be named to the model");
  // With the pool unlabelled it counts as a holder — which is exactly why the
  // caveat has to travel: the figures are wider than they should be, and said so.
  assert.equal(e.excludedCount, 2);
});

test("an indexer that will not answer the holder list is an outage, never an empty token", async () => {
  const fixture = greenBull();
  fixture.calls.getTokenHolders = () => Promise.reject(new Error("boom"));
  const res = await holderHoldTime(TOKEN, fixture);
  assert.equal(res.ok, false);
  assert.match(res.error, /unknown, not absent/);
});

/* ============================== bundling ============================== */

test("a cluster of first acquisitions is reported with its denominator and its alternatives", async () => {
  const res = await bundleCheck(TOKEN, greenBull());
  assert.equal(res.ok, true);
  const e = res.evidence;

  // A (4,050,099), C (4,051,000) and B (4,052,329) sit inside 2,230 blocks; E at
  // 9.1M does not. The pool is truncated and D is unread, so neither is eligible.
  assert.equal(e.found, true);
  assert.equal(e.clusterSize, 3);
  assert.deepEqual(e.cluster.map((c) => c.address).sort(), [A, C, B].sort());
  assert.equal(e.firstBlock, 4_050_099);
  assert.equal(e.lastBlock, 4_052_329);
  assert.equal(e.blockSpanDisplay, "2,230 blocks");
  assert.equal(e.eligible, 4, "only exactly-pinned acquisitions can be clustered on");
  assert.equal(e.holdersConsidered, 5);
  assert.equal(e.ineligible.length, 1);
  assert.ok(e.ineligible[0].reason.length > 0);
  assert.equal(e.clusterKind, "launch");
  assert.match(e.supplyDisplay, /% of supply/);

  // The sentence that keeps this an observation.
  assert.match(e.reading, /EVIDENCE OF COORDINATION, not proof of intent/);
  assert.match(e.disclaimer, /never proof of intent/);
  assert.match(e.disclaimer, /airdrop/i);
  assert.ok(isTable(e.table));
  assert.match(e.table.note, /EXACTLY pinned/);
});

test("a cluster after the earliest activity in view is a later buy, not a launch bundle", async () => {
  // One address demonstrably held before the window, so the cluster cannot be the
  // launch — and the distinction is stated rather than assumed.
  const fixture = greenBull();
  const inner = fixture.calls.getTokenTransfers;
  fixture.calls.getTokenTransfers = (address) =>
    String(address).toLowerCase() === E ? Promise.resolve(page([[3_000_000, 25]])) : inner(address);

  const res = await bundleCheck(TOKEN, fixture);
  assert.equal(res.evidence.found, true);
  assert.equal(res.evidence.clusterKind, "later");
  assert.match(res.evidence.reading, /AFTER launch/);
});

test("no cluster is reported as no cluster, and too few pinned reads as \"could not tell\"", async () => {
  const spread = {
    calls: chain({
      holders: [holderItem(A, 300), holderItem(B, 200), holderItem(C, 100)],
      transfers: {
        [A]: page([[4_050_099, 21.5]]),
        [B]: page([[8_000_000, 17]]),
        [C]: page([[15_000_000, 8]]),
      },
    }),
    client: null,
    resolvePool: poolsUnread,
    now: NOW,
  };
  const res = await bundleCheck(TOKEN, spread);
  assert.equal(res.evidence.found, false);
  assert.equal(res.evidence.cluster.length, 0);
  assert.equal(res.evidence.funding, null, "there is nothing to attribute");
  assert.match(res.evidence.reading, /No bundle/);
  assert.match(res.evidence.disclaimer, /not a clearing/);

  // Two unreadable histories leaves one pinned acquisition — below the floor. That
  // is a finding that we could not tell, and it must not read as "they arrived
  // separately".
  const thin = {
    calls: chain({
      holders: [holderItem(A, 300), holderItem(B, 200), holderItem(C, 100)],
      transfers: { [A]: page([[4_050_099, 21.5]]), [B]: { items: [] }, [C]: { items: [] } },
    }),
    client: null,
    resolvePool: poolsUnread,
    now: NOW,
  };
  const thinRes = await bundleCheck(TOKEN, thin);
  assert.equal(thinRes.evidence.found, false);
  assert.match(thinRes.evidence.reading, /could not tell/);
});

test("funding attribution runs only on a cluster and names a shared funder as plumbing", async () => {
  const funder = "0xfeed000000000000000000000000000000000001";
  const fixture = greenBull();
  fixture.calls.getAddressTransactions = (address) =>
    Promise.resolve({
      items: [{ block_number: 4_000_000, from: { hash: funder }, to: { hash: address } }],
    });

  const res = await bundleCheck(TOKEN, fixture);
  assert.equal(res.evidence.found, true);
  assert.equal(res.evidence.funding.ran, true);
  assert.equal(res.evidence.funding.commonFunder, funder);
  assert.equal(res.evidence.funding.covered, 3);
  assert.match(res.evidence.funding.reading, /not proof of intent/);
  assert.match(res.evidence.funding.reading, /exchanges, bridges/);

  // Opting out costs nothing and is not a finding of separate funding.
  const off = await bundleCheck(TOKEN, { ...greenBull(), funding: false });
  assert.equal(off.evidence.funding, null);
});

/* ============================== the prompt ============================== */

test("the prompt forbids the claims these two lookups make easy to overstate", () => {
  assert.match(SYSTEM_PROMPT, /holder_hold_time/);
  assert.match(SYSTEM_PROMPT, /bundle_check/);
  // The four rules the feature was asked for.
  assert.match(SYSTEM_PROMPT, /"AT LEAST", NOT "IS"/);
  assert.match(SYSTEM_PROMPT, /IS NOT ZERO DAYS AND NOT A FRESH BUY/);
  assert.match(SYSTEM_PROMPT, /WHEN THE POOL IS AMONG THE TOP HOLDERS, SAY WHAT IT IS/);
  assert.match(SYSTEM_PROMPT, /LIQUIDITY/);
  assert.match(SYSTEM_PROMPT, /AS AN OBSERVATION, NEVER AS INTENT/);
  assert.match(SYSTEM_PROMPT, /NEVER CALL A TOKEN A SCAM ON THIS EVIDENCE/);
  assert.match(SYSTEM_PROMPT, /QUOTE THE BUNDLE DENOMINATOR/);
  // The raw-days trap: the prompt must say which field is quotable.
  assert.match(SYSTEM_PROMPT, /medianDaysRaw/);
});

/* --------------------------- the threshold count --------------------------- */

test("A LOWER BOUND ABOVE THE THRESHOLD IS A DEFINITE YES", () => {
  // "at least 12 days" against a 3-day mark clears it and would clear it by more,
  // because the true age is larger than the figure. Counting that as anything but
  // a yes throws away the one thing the bound does tell us.
  const r = holdersOverThreshold([{ holdDays: 12, isLowerBound: true }], 0, 3);
  assert.equal(r.over, 1);
  assert.equal(r.undetermined, 0);
  assert.equal(r.under, 0);
});

test("A LOWER BOUND BELOW THE THRESHOLD IS UNDETERMINED, NEVER A NO", () => {
  // The inversion this exists to prevent. "at least 2 days" against a 3-day mark
  // settles nothing: that address's history ran past the page read, so its true
  // age is larger by an unknown amount and may well clear the mark. Filing it
  // under "did not qualify" would report holders as short-term on the strength of
  // us having stopped looking — the same defect as reading an unknown as a zero,
  // and it fails in the direction that makes a token look worse than it is.
  const r = holdersOverThreshold([{ holdDays: 2, isLowerBound: true }], 0, 3);
  assert.equal(r.under, 0, "a floor below the mark is not a holder who failed it");
  assert.equal(r.undetermined, 1);
  assert.equal(r.over, 0);
});

test("an exact figure below the threshold IS a no", () => {
  const r = holdersOverThreshold([{ holdDays: 2, isLowerBound: false }], 0, 3);
  assert.equal(r.under, 1);
  assert.equal(r.undetermined, 0);
});

test("every count is out of ONE denominator that reconciles", () => {
  // The reported failure took `exact` (3) against `holdersProbed` (10) and made
  // the remainder by subtraction — three scopes in one sentence. Every figure here
  // shares a denominator so no remainder ever has to be reconstructed.
  const rows = [
    { holdDays: 39.4, isLowerBound: false },
    { holdDays: 12, isLowerBound: true },
    { holdDays: 2, isLowerBound: true },
    { holdDays: 0.1, isLowerBound: false },
  ];
  const r = holdersOverThreshold(rows, 1, 3);
  assert.equal(r.over + r.under + r.undetermined, r.outOf);
  assert.equal(r.outOf, 5, "four measured rows plus one unreadable");
  assert.match(r.reading, /of the 5 holding addresses/);
});

test("an address with no readable history is undetermined, never a short hold", () => {
  const r = holdersOverThreshold([], 4, 3);
  assert.equal(r.undetermined, 4);
  assert.equal(r.under, 0);
  assert.equal(r.over, 0);
  assert.match(r.reading, /unread, not none/);
});

test("the threshold reading refuses to say anyone held WITHOUT SELLING", () => {
  // Age since first acquisition is not continuous holding: an address that bought
  // a month ago, sold out and bought back yesterday still reads as a month. The
  // reported answer said "held for at least 0.1 to 39.4 days without selling",
  // which the measurement cannot support in any part.
  const r = holdersOverThreshold([{ holdDays: 39.4, isLowerBound: false }], 0, 3);
  assert.doesNotMatch(r.reading, /without selling|never sold|still hold/i);
  assert.match(r.reading, /counts AGE since a first acquisition/i);
  assert.match(r.reading, /bought, sold out and bought back/i);
});

test("an unusable threshold yields no block at all rather than a default", () => {
  // Defaulting a malformed value would answer a question nobody asked with a
  // figure that looks measured.
  for (const bad of [null, undefined, "abc", NaN, -1, {}]) {
    assert.equal(holdersOverThreshold([{ holdDays: 5, isLowerBound: false }], 0, bad), null, `threshold ${String(bad)}`);
  }
  assert.ok(holdersOverThreshold([{ holdDays: 5, isLowerBound: false }], 0, 0), "zero is a usable threshold");
});
