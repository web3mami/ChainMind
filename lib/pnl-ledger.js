/**
 * Cost basis and realised profit for one wallet in one token, in ETH.
 *
 * PURE. No network, no clock, no config — every function here takes values and
 * returns values, so the arithmetic that decides whether somebody is told they
 * made money can be tested exhaustively without a chain. The I/O that feeds it
 * lives in lib/wallet-evidence.js.
 *
 * WHY ETH AND NOT DOLLARS. A profit figure needs the price at the moment of every
 * trade, and there is no historical price feed here — but a swap PRICES ITSELF:
 * the WETH that left the wallet and the tokens that arrived in the same
 * transaction are the execution price, exactly, with no feed involved. That works
 * only in ETH. Converting to dollars would need the ETH/USD rate as it was on the
 * day of each trade, which nothing here holds, so this module never produces a
 * dollar figure and the answer must not either.
 *
 * WHAT MAKES THIS SAFE, AND IT IS ALL ONE IDEA: A NUMBER IS ONLY EVER PRODUCED
 * FROM EVIDENCE THAT CANNOT MEAN ANYTHING ELSE. Everything below exists because
 * an adversarial read of an earlier design found each of these producing a
 * confident wrong figure, which is the worst output this product can emit —
 * somebody makes a money decision on it.
 *
 *   - ONLY THE WALLET'S OWN LEGS ARE READ. Never the pool's side of a swap. The
 *     pool-side amount belongs to the router, is per-hop, and is split across
 *     pools on a routed trade — reading it makes a two-hop sale through ETH look
 *     like an ETH sale that never happened, and a split route understate proceeds
 *     by however many pools it touched. What the wallet's own Transfer legs say is
 *     what the wallet actually paid and received, and nothing else needs deciding.
 *   - A TRADE IS PRICED ONLY BY A WETH LEG MOVING OPPOSITE THE TOKEN LEG. That is
 *     positive evidence of an exchange. It also excludes adding liquidity for free:
 *     an LP add sends the token AND the ETH the same way, so the directions match
 *     and it is never mistaken for a sale. A native-ETH swap leaves no WETH leg and
 *     is left UNPRICED rather than priced from the transaction's value field, which
 *     is gross of the router's refund and would quietly overstate what was paid.
 *   - A TOKEN THAT ARRIVED WITHOUT A PRICED PURCHASE HAS NO BASIS, AND NO BASIS IS
 *     NOT A BASIS OF ZERO. An airdrop costed at zero reports its entire value as
 *     profit. Any uncosted acquisition makes the whole figure unprovable instead.
 *   - EVERY SUBTRACTION IS CLAMPED AND EVERY DIVISION IS GUARDED, and a clamp that
 *     fires is recorded rather than swallowed. A basis that goes negative comes
 *     back later as fabricated gain.
 */

/**
 * Ten to the `n` as a BigInt, built by multiplying rather than with `**`, and
 * always through this CALL rather than a constant the build can fold.
 *
 * BOTH HALVES OF THAT ARE LOAD-BEARING, and neither is style. Next's file tracer
 * (@vercel/nft) statically evaluates binary expressions while walking the module,
 * and it does not carry BigInt through that evaluation: a divisor written as
 * `10n ** 18n`, and equally one written as the literal `1000000000000000000n`,
 * reaches its evaluator as zero, so `v / WEI` threw `RangeError: Division by zero`
 * and failed the production build outright. Every test passed throughout, because
 * node runs the real operator — the build was the only thing that ever saw it.
 * A function call is opaque to that folding, so the divisor stays a divisor.
 *
 * `n` is clamped by every caller before it arrives.
 */
function pow10(n) {
  let out = 1n;
  for (let i = 0; i < n; i += 1) out *= 10n;
  return out;
}

/**
 * Integer division and remainder that cannot divide by zero.
 *
 * EVERY BigInt DIVISION IN THIS FILE GOES THROUGH THESE, for two reasons that
 * happen to want the same thing. The first is correctness: a zero denominator is
 * reachable here — a position walks to nothing the moment everything is sold — and
 * `x / 0n` throws rather than returning anything, which would take out the whole
 * answer over an arithmetic edge the ledger already handles.
 *
 * The second is the build. Next's file tracer follows a `let` to its initializer,
 * so `let qtyHeld = 0n` two hundred lines up made `(ethBasis * q) / qtyHeld` look
 * like a division by zero to its static evaluator, and it failed the production
 * build with exactly that message — while all 1,504 tests passed, because node
 * runs the real operator on the real values. Behind a parameter the denominator is
 * no longer traceable to a literal, so the fold does not happen at all.
 */
function divide(numerator, denominator) {
  return denominator === 0n ? 0n : numerator / denominator;
}

/** The remainder half of the same, with the same guard and the same reason. */
function modulo(numerator, denominator) {
  return denominator === 0n ? 0n : numerator % denominator;
}

/** Reasons a transaction could not be priced. Each is a sentence the answer can use. */
export const UNPRICED = Object.freeze({
  /** No WETH leg on the wallet's side: a native-ETH trade, or not a trade at all. */
  NO_ETH_LEG: "no_eth_leg",
  /** Token and ETH moved the same way — liquidity, not an exchange. */
  SAME_DIRECTION: "same_direction",
  /** The transaction was never read, because the join budget ran out first. */
  NOT_READ: "not_read",
  /** Read, but its legs could not be understood. */
  UNREADABLE: "unreadable",
  /**
   * The transaction carries more transfer legs than the indexer returns.
   *
   * MEASURED, and it is why quantity is never taken from the transaction: a
   * disperse to more than ten recipients came back with ten legs and
   * `token_transfers_overflow: true`, and the wallet being asked about was NOT
   * among them — its own transfer, missing from its own transaction. Any ETH leg
   * could be missing the same way, so "no ETH leg here" stops being a measurement
   * and becomes an unread window.
   */
  LEGS_OVERFLOWED: "legs_overflowed",
});

/** Why a token's realised figure is not provable. */
export const NOT_PROVABLE = Object.freeze({
  /** The transfer walk stopped before the end of this wallet's history. */
  HISTORY_INCOMPLETE: "history_incomplete",
  /** At least one acquisition has no price, so there is no basis to subtract. */
  UNCOSTED_ACQUISITION: "uncosted_acquisition",
  /** More was sold than the walk ever saw arrive. */
  OVERSOLD: "oversold",
  /** Nothing was bought or sold at a readable price at all. */
  NO_PRICED_TRADES: "no_priced_trades",
});

/**
 * Order two indexer rows the way the chain did.
 *
 * ON THE SNAKE_CASE FIELDS THE INDEXER ACTUALLY SENDS. The obvious move is to
 * reuse the comparator the log reader already has, which reads `blockNumber` and
 * `logIndex` — the shape built from eth_getLogs. Blockscout sends `block_number`
 * and `log_index`. Feeding one to the other compares undefined against undefined,
 * returns NaN, and a NaN comparator leaves the order unspecified: since this feed
 * arrives newest-first the practical result is a history replayed BACKWARDS, where
 * every sale lands before the purchase that funded it. Same wallet, same data, a
 * different answer depending on the engine's sort.
 *
 * `index` is the row's position in the feed and breaks ties that the indexer left
 * tied, so the order is total and stable rather than engine-dependent.
 */
export function chainOrder(a, b) {
  const ab = Number(a?.block_number ?? a?.blockNumber);
  const bb = Number(b?.block_number ?? b?.blockNumber);
  if (Number.isFinite(ab) && Number.isFinite(bb) && ab !== bb) return ab - bb;
  const al = Number(a?.log_index ?? a?.logIndex);
  const bl = Number(b?.log_index ?? b?.logIndex);
  if (Number.isFinite(al) && Number.isFinite(bl) && al !== bl) return al - bl;
  return Number(a?.index ?? 0) - Number(b?.index ?? 0);
}

/** The raw base-unit amount of a transfer row, or null when it cannot be read. */
export function rawAmount(row) {
  const v = row?.total?.value ?? row?.value;
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return BigInt(v.trim());
  return null;
}

/** Lowercased address, or "" — so every comparison in this module is on one form. */
function addr(x) {
  return typeof x === "string" ? x.trim().toLowerCase() : "";
}

/** The address a transfer row's token lives at. */
function legToken(row) {
  return addr(row?.token?.address_hash ?? row?.token?.address ?? row?.token_address);
}

/** Which way a leg moved relative to `wallet`: 1 in, -1 out, 0 neither or both. */
function legDirection(row, wallet) {
  const from = addr(row?.from?.hash ?? row?.from);
  const to = addr(row?.to?.hash ?? row?.to);
  const inbound = to === wallet;
  const outbound = from === wallet;
  if (inbound && outbound) return 0;
  if (inbound) return 1;
  if (outbound) return -1;
  return 0;
}

/**
 * Read one transaction's transfer legs as a priced trade, or say why not.
 *
 * Only legs with `wallet` on one side are considered — see the header. The token
 * side and the WETH side are each NETTED before their directions are compared, so
 * a transaction that both sends and receives the same token (a wrap, a partial
 * refund, a router bouncing it back) is judged on what actually left or arrived
 * rather than on whichever leg happened to be read first.
 *
 * THE TOKEN QUANTITY IS PASSED IN, NOT READ FROM THE LEGS. `token_transfers` is
 * capped by the indexer and flagged with `token_transfers_overflow`, and a wallet's
 * own transfer can fall outside that cap — measured on a disperse, where the wallet
 * being asked about was absent from its own transaction. The transfer WALK is
 * wallet-scoped and paginated, so it already holds the authoritative quantity;
 * the transaction is opened for one reason only, to find the ETH that was exchanged.
 *
 * @param {object} args
 * @param {object[]} args.legs every token_transfer the transaction returned
 * @param {string} args.wallet the address being asked about
 * @param {string} args.token the subject token's contract
 * @param {string} args.weth the wrapped-native contract on this chain
 * @param {bigint} args.tokenNet net token movement for this wallet, from the walk;
 *        positive in, negative out
 * @param {boolean} [args.overflowed] the indexer capped the leg list
 * @returns {{priced: boolean, side: ("buy"|"sell"|null), qty: bigint, eth: bigint,
 *            reason: (string|null), unreadableLeg: boolean}}
 */
export function readTrade({ legs, wallet, token, weth, tokenNet, overflowed = false } = {}) {
  const w = addr(wallet);
  const t = addr(token);
  const e = addr(weth);
  const none = { priced: false, side: null, qty: 0n, eth: 0n, reason: UNPRICED.UNREADABLE, unreadableLeg: false };
  if (!Array.isArray(legs) || !w || !t || typeof tokenNet !== "bigint") return none;

  let ethNet = 0n;
  let unreadableLeg = false;

  for (const leg of legs) {
    const dir = legDirection(leg, w);
    if (dir === 0) continue;
    if (legToken(leg) !== e) continue;
    const amount = rawAmount(leg);
    // A leg on the wallet's side whose amount cannot be read would silently shrink
    // the consideration. Say so rather than pricing what is left.
    if (amount === null) {
      unreadableLeg = true;
      continue;
    }
    ethNet += dir === 1 ? amount : -amount;
  }

  if (unreadableLeg) return { ...none, unreadableLeg: true };
  if (tokenNet === 0n) return { ...none, reason: UNPRICED.UNREADABLE };
  if (ethNet === 0n) {
    // An absent ETH leg is only a FINDING when the whole list was returned. Under
    // overflow it is an unread window, and the two must not share a sentence.
    return {
      priced: false,
      side: null,
      qty: 0n,
      eth: 0n,
      reason: overflowed ? UNPRICED.LEGS_OVERFLOWED : UNPRICED.NO_ETH_LEG,
      unreadableLeg: false,
    };
  }

  // Opposite signs is the whole test: token in and ETH out is a buy, token out and
  // ETH in is a sale. Same sign is liquidity moving, never an exchange.
  const opposite = (tokenNet > 0n && ethNet < 0n) || (tokenNet < 0n && ethNet > 0n);
  if (!opposite) {
    return { priced: false, side: null, qty: 0n, eth: 0n, reason: UNPRICED.SAME_DIRECTION, unreadableLeg: false };
  }

  const abs = (x) => (x < 0n ? -x : x);
  return {
    priced: true,
    side: tokenNet > 0n ? "buy" : "sell",
    qty: abs(tokenNet),
    eth: abs(ethNet),
    reason: null,
    unreadableLeg: false,
  };
}

/**
 * Walk priced and unpriced events in chain order into a position and a figure.
 *
 * AVERAGE COST, and it is declared to the reader rather than assumed. FIFO would
 * need a lot ledger and gives a different answer on the same trades; neither is
 * more correct, but one of them has to be named or the number means nothing.
 *
 * THE REALISED FIGURE IS WITHHELD RATHER THAN APPROXIMATED. If any acquisition
 * arrived without a price — an airdrop, a native-ETH buy, a transaction the join
 * budget never read — then part of the position has no cost, and every scheme for
 * carrying on (treating it as free, prorating around it, ignoring the sale) states
 * something that was not measured. So `provable` goes false, the events are still
 * returned, and the caller shows the ledger without a total.
 *
 * @param {Array<{kind: "acquire"|"dispose", qty: bigint, eth: (bigint|null)}>} events
 *        in chain order; `eth` null means the event has no readable price
 * @returns {object}
 */
export function buildLedger(events) {
  let qtyHeld = 0n;
  let ethBasis = 0n;
  let realisedEth = 0n;
  let uncostedAcquisitions = 0;
  let unpricedDisposals = 0;
  let pricedTrades = 0;
  let oversold = false;
  let clamped = false;

  for (const ev of Array.isArray(events) ? events : []) {
    const qty = typeof ev?.qty === "bigint" ? ev.qty : 0n;
    if (qty <= 0n) continue;
    const eth = typeof ev?.eth === "bigint" ? ev.eth : null;

    if (ev.kind === "acquire") {
      qtyHeld += qty;
      if (eth === null) uncostedAcquisitions += 1;
      else {
        ethBasis += eth;
        pricedTrades += 1;
      }
      continue;
    }

    if (ev.kind !== "dispose") continue;

    // MORE SOLD THAN EVER SEEN ARRIVING. Not an error in the data — it is what a
    // history that starts mid-story looks like. Clamp so nothing below can divide
    // by a quantity that is not there, and record it: the figure is not provable.
    let q = qty;
    if (q > qtyHeld) {
      oversold = true;
      q = qtyHeld;
    }
    if (q <= 0n || qtyHeld <= 0n) {
      if (eth === null) unpricedDisposals += 1;
      else pricedTrades += 1;
      continue;
    }

    // The share of the basis this disposal retires. Guarded above, and clamped
    // below so rounding can never retire more basis than exists — a negative
    // basis comes back as unrealised gain that nobody ever earned.
    let basisOut = divide(ethBasis * q, qtyHeld);
    if (basisOut > ethBasis) {
      basisOut = ethBasis;
      clamped = true;
    }
    if (basisOut < 0n) {
      basisOut = 0n;
      clamped = true;
    }

    qtyHeld -= q;
    ethBasis -= basisOut;
    if (eth === null) unpricedDisposals += 1;
    else {
      realisedEth += eth - basisOut;
      pricedTrades += 1;
    }
  }

  if (qtyHeld < 0n) {
    qtyHeld = 0n;
    clamped = true;
  }
  if (ethBasis < 0n) {
    ethBasis = 0n;
    clamped = true;
  }
  // A position fully closed leaves no basis behind. A residue means the arithmetic
  // above drifted, so it is surfaced rather than carried into an unrealised figure.
  if (qtyHeld === 0n && ethBasis !== 0n) {
    ethBasis = 0n;
    clamped = true;
  }

  return {
    qtyHeld,
    ethBasis,
    realisedEth,
    pricedTrades,
    uncostedAcquisitions,
    unpricedDisposals,
    oversold,
    clamped,
  };
}

/**
 * May the realised figure be stated at all?
 *
 * Every condition is a way the number would be describing something other than
 * what the reader asked. The reason is returned rather than a bare false, because
 * "your history is longer than I read" and "these tokens were airdropped" send the
 * reader to completely different conclusions.
 *
 * NOTE THAT A TRUNCATED WALK IS NOT A LOWER BOUND. It is tempting to hand back
 * "at least this much", and it is wrong in both directions: the unread prefix
 * holds purchases that would raise the basis and sales that would raise the
 * proceeds, and nothing says which dominates. An unbounded figure labelled as a
 * bound is worse than no figure.
 *
 * @param {object} ledger from buildLedger
 * @param {{historyComplete: boolean, joinsComplete: boolean}} walk
 * @returns {{provable: boolean, reason: (string|null)}}
 */
export function provability(ledger, { historyComplete, joinsComplete } = {}) {
  if (!ledger) return { provable: false, reason: NOT_PROVABLE.NO_PRICED_TRADES };
  if (!historyComplete) return { provable: false, reason: NOT_PROVABLE.HISTORY_INCOMPLETE };
  if (ledger.oversold) return { provable: false, reason: NOT_PROVABLE.OVERSOLD };
  // An unread transaction and an unpriced one are the same hole in the basis: a
  // quantity moved for a consideration nobody measured.
  if (!joinsComplete || ledger.uncostedAcquisitions > 0 || ledger.unpricedDisposals > 0) {
    return { provable: false, reason: NOT_PROVABLE.UNCOSTED_ACQUISITION };
  }
  if (ledger.pricedTrades === 0) return { provable: false, reason: NOT_PROVABLE.NO_PRICED_TRADES };
  return { provable: true, reason: null };
}

/**
 * A wei amount as a decimal ETH string, exactly — no float anywhere.
 *
 * Number() on wei loses precision above 2^53 and toFixed rounds toward a value the
 * chain never held. This is string surgery on the integer instead, so what is
 * printed is what was measured.
 *
 * @param {bigint} wei
 * @param {number} [places] digits after the point
 * @returns {string}
 */
export function formatEth(wei, places = 6) {
  if (typeof wei !== "bigint") return "0";
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const unit = pow10(18);
  const whole = divide(v, unit);
  const frac = modulo(v, unit).toString().padStart(18, "0").slice(0, Math.max(0, Math.min(18, places)));
  const trimmed = frac.replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${trimmed ? `.${trimmed}` : ""}`;
}

/** The same for a token amount at its own decimals. */
export function formatUnits(raw, decimals = 18, places = 4) {
  if (typeof raw !== "bigint") return "0";
  const d = Number.isFinite(Number(decimals)) ? Math.max(0, Math.min(36, Math.floor(Number(decimals)))) : 18;
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const base = pow10(d);
  const whole = divide(v, base);
  const frac = d === 0 ? "" : modulo(v, base).toString().padStart(d, "0").slice(0, Math.max(0, places));
  const trimmed = frac.replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${trimmed ? `.${trimmed}` : ""}`;
}
