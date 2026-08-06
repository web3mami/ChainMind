// Tests for the cost-basis arithmetic (lib/pnl-ledger.js).
//
// Every test here is an attack that an adversarial read of the design found
// producing a CONFIDENT WRONG NUMBER — a liquidity deposit booked as a sale, an
// airdrop costed at zero and sold for pure fabricated profit, a basis driven
// negative and coming back as unrealised gain, a history replayed backwards by a
// NaN comparator. A wrong profit figure is the worst output this product can
// emit, because somebody makes a money decision on it, so the bar here is not
// "the happy path adds up" but "none of these produces a number at all".
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NOT_PROVABLE,
  UNPRICED,
  buildLedger,
  chainOrder,
  formatEth,
  formatUnits,
  provability,
  rawAmount,
  readTrade,
} from "../lib/pnl-ledger.js";

const WALLET = "0xde358e0a0afe80c081121bc7e2bf8852fc6827d6";
const TOKEN = "0x37d71479b201bf4e86c6369508f3d7a789f10f68";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const POOL = "0x1111111111111111111111111111111111111111";
const ROUTER = "0x2222222222222222222222222222222222222222";

const ETH = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

/** One transfer leg in the indexer's shape. */
function leg(token, from, to, value) {
  return { token: { address_hash: token }, from: { hash: from }, to: { hash: to }, total: { value: String(value) } };
}

/* ------------------------------- readTrade ------------------------------- */

test("a WETH leg opposite the token leg prices the trade", () => {
  const buy = readTrade({
    legs: [leg(WETH, WALLET, POOL, 10n ** 18n), leg(TOKEN, POOL, WALLET, 500n * 10n ** 18n)],
    tokenNet: 500n * 10n ** 18n,
    wallet: WALLET,
    token: TOKEN,
    weth: WETH,
  });
  assert.equal(buy.priced, true);
  assert.equal(buy.side, "buy");
  assert.equal(buy.qty, 500n * 10n ** 18n);
  assert.equal(buy.eth, 10n ** 18n);

  const sell = readTrade({
    legs: [leg(TOKEN, WALLET, POOL, 500n * 10n ** 18n), leg(WETH, POOL, WALLET, 2n * 10n ** 18n)],
    tokenNet: -500n * 10n ** 18n,
    wallet: WALLET,
    token: TOKEN,
    weth: WETH,
  });
  assert.equal(sell.side, "sell");
  assert.equal(sell.eth, 2n * 10n ** 18n);
});

test("ADDING LIQUIDITY IS NEVER READ AS A SALE", () => {
  // The attack: an LP deposit sends the token out AND the ETH out, so anything
  // that sees "token left, ETH involved" books a sale at a price equal to the ETH
  // the wallet also deposited — a fabricated realised profit with every honesty
  // flag still green. Same direction is the discriminator, and it is free.
  const add = readTrade({
    legs: [leg(TOKEN, WALLET, POOL, 500n * 10n ** 18n), leg(WETH, WALLET, POOL, 10n ** 18n)],
    tokenNet: -500n * 10n ** 18n,
    wallet: WALLET,
    token: TOKEN,
    weth: WETH,
  });
  assert.equal(add.priced, false);
  assert.equal(add.reason, UNPRICED.SAME_DIRECTION);
  assert.equal(add.eth, 0n, "no consideration is invented for a deposit");

  // And removing liquidity is the mirror: both arrive, and it is not a purchase.
  const remove = readTrade({
    legs: [leg(TOKEN, POOL, WALLET, 500n * 10n ** 18n), leg(WETH, POOL, WALLET, 10n ** 18n)],
    tokenNet: 500n * 10n ** 18n,
    wallet: WALLET,
    token: TOKEN,
    weth: WETH,
  });
  assert.equal(remove.priced, false);
  assert.equal(remove.reason, UNPRICED.SAME_DIRECTION);
});

test("an airdrop is unpriced, never a purchase at zero", () => {
  // Measured on this chain: a disperseToken transaction, ten recipients, identical
  // amounts, no consideration anywhere. Costed at zero it would report the whole
  // current value as profit — the single most dangerous figure available here.
  const drop = readTrade({
    legs: [leg(TOKEN, ROUTER, WALLET, 30n * 10n ** 18n)],
    tokenNet: 30n * 10n ** 18n,
    wallet: WALLET,
    token: TOKEN,
    weth: WETH,
  });
  assert.equal(drop.priced, false);
  assert.equal(drop.reason, UNPRICED.NO_ETH_LEG);
});

test("a native-ETH trade is left unpriced rather than priced from the value field", () => {
  // There is no WETH leg on a native swap. The transaction's `value` looks like the
  // answer and is gross of the router's refund, so it overstates what was paid and
  // manufactures a loss. Unpriced is the honest reading until internal transactions
  // can be read.
  const native = readTrade({
    legs: [leg(TOKEN, POOL, WALLET, 500n * 10n ** 18n)],
    tokenNet: 500n * 10n ** 18n,
    wallet: WALLET,
    token: TOKEN,
    weth: WETH,
  });
  assert.equal(native.priced, false);
  assert.equal(native.reason, UNPRICED.NO_ETH_LEG);
});

test("only the wallet's own legs count, so a router's leg cannot become the price", () => {
  // The pool-side amount belongs to the router, is per-hop and is split across
  // pools on a routed trade. A wallet that is not on either side of the WETH leg
  // did not receive that WETH.
  const t = readTrade({
    legs: [leg(TOKEN, POOL, WALLET, 500n * 10n ** 18n), leg(WETH, POOL, ROUTER, 9n * 10n ** 18n)],
    tokenNet: 500n * 10n ** 18n,
    wallet: WALLET,
    token: TOKEN,
    weth: WETH,
  });
  assert.equal(t.priced, false, "the router's WETH is not the wallet's consideration");
  assert.equal(t.reason, UNPRICED.NO_ETH_LEG);
});

test("legs are netted before their directions are compared", () => {
  // A router that bounces part of the token back, or a wrap alongside the swap,
  // leaves several legs on the wallet's side. What matters is what actually left.
  const t = readTrade({
    legs: [
      leg(TOKEN, POOL, WALLET, 600n * 10n ** 18n),
      leg(TOKEN, WALLET, POOL, 100n * 10n ** 18n),
      leg(WETH, WALLET, POOL, 10n ** 18n),
    ],
    tokenNet: 500n * 10n ** 18n,
    wallet: WALLET,
    token: TOKEN,
    weth: WETH,
  });
  assert.equal(t.priced, true);
  assert.equal(t.qty, 500n * 10n ** 18n, "net 500 in, not 600");
});

test("an unreadable amount on the wallet's side stops the trade being priced", () => {
  const t = readTrade({
    legs: [leg(TOKEN, POOL, WALLET, 500n * 10n ** 18n), { token: { address_hash: WETH }, from: { hash: WALLET }, to: { hash: POOL }, total: { value: null } }],
    tokenNet: 500n * 10n ** 18n,
    wallet: WALLET,
    token: TOKEN,
    weth: WETH,
  });
  assert.equal(t.priced, false);
  assert.equal(t.unreadableLeg, true, "a leg that shrank the trade silently is worse than no figure");
});

test("a capped leg list is an unread window, not a finding that there was no ETH", () => {
  // MEASURED on this chain: a disperse to more than ten recipients came back with
  // ten legs and token_transfers_overflow true, and the wallet being asked about
  // was NOT among them — its own transfer missing from its own transaction. Any
  // ETH leg can be cut the same way, so "no ETH leg here" stops being a
  // measurement. Both cases are unpriced; they must not share a sentence, because
  // one says the trade was free and the other says we did not see it.
  const t = readTrade({
    legs: [leg(TOKEN, ROUTER, WALLET, 30n * 10n ** 18n)],
    tokenNet: 30n * 10n ** 18n,
    wallet: WALLET,
    token: TOKEN,
    weth: WETH,
    overflowed: true,
  });
  assert.equal(t.priced, false);
  assert.equal(t.reason, UNPRICED.LEGS_OVERFLOWED);
  assert.notEqual(t.reason, UNPRICED.NO_ETH_LEG);
});

test("the quantity comes from the caller, never from the capped leg list", () => {
  // The wallet's own leg is absent from the legs here — exactly the overflow case.
  // The quantity must still be the one the walk measured, or the position silently
  // disappears and a later sale has nothing to have been sold.
  const t = readTrade({
    legs: [leg(TOKEN, ROUTER, "0x3333333333333333333333333333333333333333", 30n * 10n ** 18n)],
    tokenNet: 30n * 10n ** 18n,
    wallet: WALLET,
    token: TOKEN,
    weth: WETH,
    overflowed: true,
  });
  assert.equal(t.priced, false, "nothing priceable, but the caller still holds the quantity");
});

test("readTrade is total", () => {
  for (const bad of [undefined, {}, { legs: null, wallet: WALLET, token: TOKEN, weth: WETH, tokenNet: 1n }]) {
    const t = readTrade(bad);
    assert.equal(t.priced, false);
    assert.equal(t.eth, 0n);
  }
});

/* ------------------------------- chainOrder ------------------------------ */

test("events sort on the snake_case fields the indexer actually sends", () => {
  // The bug this pins: the existing comparator reads blockNumber/logIndex, which is
  // the eth_getLogs shape. Blockscout sends block_number/log_index. Comparing the
  // wrong pair returns NaN, a NaN comparator leaves order unspecified, and since
  // this feed is newest-first the history replays BACKWARDS — every sale landing
  // before the purchase that funded it, from the same data.
  const rows = [
    { block_number: 20, log_index: 1, index: 0 },
    { block_number: 10, log_index: 5, index: 1 },
    { block_number: 10, log_index: 2, index: 2 },
  ];
  const sorted = [...rows].sort(chainOrder);
  assert.deepEqual(
    sorted.map((r) => [r.block_number, r.log_index]),
    [
      [10, 2],
      [10, 5],
      [20, 1],
    ],
  );
});

test("rows the indexer left tied keep a stable order rather than an engine-defined one", () => {
  const rows = [
    { block_number: 7, index: 0 },
    { block_number: 7, index: 1 },
    { block_number: 7, index: 2 },
  ];
  assert.deepEqual([...rows].sort(chainOrder).map((r) => r.index), [0, 1, 2]);
});

/* ------------------------------- buildLedger ----------------------------- */

test("a straightforward buy then sell realises the difference", () => {
  const l = buildLedger([
    { kind: "acquire", qty: 100n, eth: ETH(1) },
    { kind: "dispose", qty: 100n, eth: ETH(3) },
  ]);
  assert.equal(l.realisedEth, ETH(2));
  assert.equal(l.qtyHeld, 0n);
  assert.equal(l.ethBasis, 0n, "a closed position leaves no basis behind");
  assert.equal(l.oversold, false);
  assert.equal(l.clamped, false);
});

test("a partial sell retires its share of the basis and no more", () => {
  const l = buildLedger([
    { kind: "acquire", qty: 100n, eth: ETH(2) },
    { kind: "dispose", qty: 25n, eth: ETH(1) },
  ]);
  // A quarter of the position cost 0.5 ETH and sold for 1.
  assert.equal(l.realisedEth, ETH(0.5));
  assert.equal(l.qtyHeld, 75n);
  assert.equal(l.ethBasis, ETH(1.5));
});

test("SELLING MORE THAN THE WALK SAW ARRIVE NEVER DIVIDES BY ZERO", () => {
  // A history that starts mid-story sells a position it never saw bought. The
  // attack is qtyHeld of 0 as a divisor: a crash at best, and at worst a basis
  // driven negative that returns later as unrealised gain nobody earned.
  const l = buildLedger([{ kind: "dispose", qty: 100n, eth: ETH(5) }]);
  assert.equal(l.oversold, true);
  assert.equal(l.qtyHeld, 0n);
  assert.ok(l.ethBasis >= 0n, "basis must never go negative");
  assert.equal(provability(l, { historyComplete: true, joinsComplete: true }).provable, false);
});

test("an oversell after a real buy is clamped and flagged, not absorbed", () => {
  const l = buildLedger([
    { kind: "acquire", qty: 10n, eth: ETH(1) },
    { kind: "dispose", qty: 110n, eth: ETH(12) },
  ]);
  assert.equal(l.oversold, true);
  assert.ok(l.ethBasis >= 0n);
  assert.ok(l.qtyHeld >= 0n);
  assert.equal(provability(l, { historyComplete: true, joinsComplete: true }).reason, NOT_PROVABLE.OVERSOLD);
});

test("the basis never goes negative however the events are ordered", () => {
  // Property-ish sweep: the invariant is not about one scenario, it is that no
  // sequence of events can drive the accumulators below zero.
  const kinds = ["acquire", "dispose"];
  for (let mask = 0; mask < 64; mask += 1) {
    const events = [];
    for (let i = 0; i < 6; i += 1) {
      events.push({
        kind: kinds[(mask >> i) & 1],
        qty: BigInt(10 * (i + 1)),
        eth: i % 3 === 0 ? null : ETH(i + 1),
      });
    }
    const l = buildLedger(events);
    assert.ok(l.ethBasis >= 0n, `basis went negative on mask ${mask}`);
    assert.ok(l.qtyHeld >= 0n, `quantity went negative on mask ${mask}`);
  }
});

test("an uncosted acquisition is counted, never treated as free", () => {
  const l = buildLedger([
    { kind: "acquire", qty: 100n, eth: null },
    { kind: "dispose", qty: 100n, eth: ETH(5) },
  ]);
  assert.equal(l.uncostedAcquisitions, 1);
  // The arithmetic still runs — but the figure it produced may not be stated.
  const p = provability(l, { historyComplete: true, joinsComplete: true });
  assert.equal(p.provable, false);
  assert.equal(p.reason, NOT_PROVABLE.UNCOSTED_ACQUISITION);
});

/* ------------------------------- provability ----------------------------- */

test("a complete, fully priced history is the only case that states a figure", () => {
  const l = buildLedger([
    { kind: "acquire", qty: 100n, eth: ETH(1) },
    { kind: "dispose", qty: 50n, eth: ETH(2) },
  ]);
  assert.deepEqual(provability(l, { historyComplete: true, joinsComplete: true }), { provable: true, reason: null });
});

test("a truncated walk withholds the figure rather than calling it a lower bound", () => {
  // The tempting move is "at least this much", and it is wrong in both directions:
  // the unread prefix holds purchases that would raise the basis AND sales that
  // would raise the proceeds, and nothing says which dominates. An unbounded figure
  // wearing the word "bound" is worse than no figure.
  const l = buildLedger([
    { kind: "acquire", qty: 100n, eth: ETH(1) },
    { kind: "dispose", qty: 100n, eth: ETH(3) },
  ]);
  const p = provability(l, { historyComplete: false, joinsComplete: true });
  assert.equal(p.provable, false);
  assert.equal(p.reason, NOT_PROVABLE.HISTORY_INCOMPLETE);
});

test("a transaction the join budget never read is the same hole as an unpriced one", () => {
  const l = buildLedger([{ kind: "acquire", qty: 100n, eth: ETH(1) }]);
  assert.equal(provability(l, { historyComplete: true, joinsComplete: false }).provable, false);
});

test("a wallet with no priced trades gets no figure and says which", () => {
  const l = buildLedger([]);
  assert.equal(provability(l, { historyComplete: true, joinsComplete: true }).reason, NOT_PROVABLE.NO_PRICED_TRADES);
});

/* -------------------------------- formatting ----------------------------- */

test("wei is printed exactly, with no float anywhere in the path", () => {
  assert.equal(formatEth(10n ** 18n), "1");
  assert.equal(formatEth(1_500_000_000_000_000_000n), "1.5");
  assert.equal(formatEth(-2n * 10n ** 18n), "-2");
  assert.equal(formatEth(0n), "0");
  // Above 2^53 a Number would round to a value the chain never held.
  assert.equal(formatEth(123_456_789_012_345_678_901_234_567_890n, 6), "123456789012.345678");
});

test("token amounts respect their own decimals", () => {
  assert.equal(formatUnits(30n * 10n ** 18n, 18), "30");
  assert.equal(formatUnits(1_500_000n, 6), "1.5");
  assert.equal(formatUnits(42n, 0), "42");
});

test("rawAmount reads the shapes the indexer sends, and refuses the rest", () => {
  assert.equal(rawAmount({ total: { value: "500" } }), 500n);
  assert.equal(rawAmount({ value: "7" }), 7n);
  assert.equal(rawAmount({ total: { value: null } }), null);
  assert.equal(rawAmount({ total: { value: "12.5" } }), null, "a decimal is not a base-unit amount");
  assert.equal(rawAmount({}), null);
  assert.equal(rawAmount(null), null);
});
