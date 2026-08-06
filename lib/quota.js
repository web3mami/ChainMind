/**
 * How many questions this caller may still ask today, and what would change that.
 *
 * WHAT THIS IS. A paywall with a free tier: holders of the gating token ask
 * without a daily limit, everyone else gets a small daily allowance. The decision
 * is made HERE, on the server, from a session cookie the server signed and a
 * balance the server read (lib/entitlement.js). Nothing a client sends can raise
 * a limit — a request claiming to be a holder, carrying a balance, or setting a
 * header is counted exactly like any other.
 *
 * WHAT THIS IS NOT. An anti-abuse system. Every identifier available for an
 * anonymous caller is weak, and the per-wallet one is no better:
 *
 *   IP        — shared by everyone behind a NAT or a corporate proxy (one office
 *               burns one allowance) and changes with a VPN hop or a phone moving
 *               between cells. It is worth exactly what the proxy that set it is
 *               worth: lib/api-guard.js clientIdentity takes the hop OUR proxy
 *               appended rather than the leftmost value the caller wrote, so a
 *               spoofed X-Forwarded-For no longer buys a fresh allowance — but a
 *               genuinely new address still does, and buying one is cheap.
 *   Cookie    — cleared by one keypress, absent in every incognito window.
 *   Wallet    — free to create. A hundred fresh addresses are a hundred allowances,
 *               and signing in with a throwaway wallet resets a spent IP bucket.
 *
 * WE PICK IP for anonymous callers, because a cookie costs an attacker nothing at
 * all while an IP costs them at least a proxy, and because a cookie-keyed quota
 * silently resets for ordinary privacy-conscious users, which is the worse failure
 * of the two.
 *
 * IT IS A SPEED BUMP AND THE CODE SHOULD NOT PRETEND OTHERWISE. Anyone willing to
 * rotate an address or an exit node can have more than the free allowance; the
 * Sybil is not solved here and is not meant to be. What the identity work buys is
 * that the limit cannot be reset by setting a header, which is the difference
 * between a bump and nothing at all. The product's real cost control is the
 * per-minute limiter in lib/api-guard.js plus the upstream budget — not this file.
 *
 * THE DAY IS A UTC CALENDAR DAY, and that is a deliberate choice over a rolling
 * window. The server cannot know a visitor's timezone (a browser-reported one is
 * client-supplied input, which is the category this whole module refuses to trust),
 * so "resets at midnight local" is not implementable. Between the two things that
 * ARE implementable:
 *   - a UTC day gives every user one instant they can be TOLD, in advance, and
 *     check against a clock: "resets at 00:00 UTC, in 3h 12m";
 *   - a rolling 24h window is fairer against bursts but has a different reset
 *     instant per question, so the honest message becomes "some of your questions
 *     come back at some point", which helps nobody.
 * The counter key carries the UTC date and the counter expires at midnight UTC, so
 * the reset is the same event in the store and in the sentence the user reads.
 */
import { rateLimit } from "./api-guard.js";
import { ENTITLEMENT, UNVERIFIED_REASON, isEntitled } from "./entitlement.js";

/** Which tier a caller is in. The 429 says which one; a bare "rate limited" does not. */
export const QUOTA_STATE = Object.freeze({
  /** Verified holder at or above the threshold. No daily limit. */
  UNLIMITED: "unlimited",
  /**
   * The daily limit is switched off for EVERYONE by configuration — see openAccess().
   * Deliberately NOT the same value as UNLIMITED: that one is a statement about the
   * caller (they hold the token and we verified it), this one is a statement about
   * the server (nobody is being counted today). Reporting open access as UNLIMITED
   * would tell an anonymous visitor they are a verified holder, which is a claim we
   * have not checked and would have to walk back the moment the switch comes off.
   */
  OPEN: "open-access",
  /** No session at all. */
  ANONYMOUS: "anonymous",
  /** Signed in, balance read, under the threshold. */
  BELOW_THRESHOLD: "below-threshold",
  /** Signed in, and we could NOT read the balance. Not the same as holding none. */
  UNVERIFIED: "unverified",
});

/** Free questions per UTC day for everyone who is not a verified holder. */
const DEFAULT_FREE_DAILY = 5;

/**
 * Is the daily limit switched off for everyone right now?
 *
 * A SEPARATE SWITCH RATHER THAN `FREE_DAILY_QUESTIONS=0`, because zero already means
 * the opposite: freeDailyAllowance() documents 0 as a hard paywall, and consumeQuestion
 * turns it into `allowed: false`. Setting the allowance to zero to "remove the limit"
 * would lock every visitor out instead of letting them in — the exact inversion this
 * split exists to prevent.
 *
 * Nor is it a very large number. A limit of 1e9 still counts, still writes a counter per
 * caller per day, and still renders "999999995 of 1000000000 free questions left today",
 * which is a limit wearing a disguise. Open access short-circuits before any of that.
 *
 * NOTHING IS DELETED. Every counter, message and header path below stays exactly as it
 * was; unset OPEN_ACCESS and the allowance is back, same day, no code change.
 */
export function openAccess() {
  const v = String(process.env.OPEN_ACCESS ?? "")
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** How many free questions a non-holder gets per UTC day. */
export function freeDailyAllowance() {
  const n = Number(process.env.FREE_DAILY_QUESTIONS);
  // 0 is meaningful — it makes the gate a hard paywall — so only NaN and
  // negatives fall back to the default.
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_FREE_DAILY;
}

/** `2026-07-28` — the UTC date, which is what makes a counter a DAILY counter. */
export function utcDayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

/** Milliseconds from `now` to the next 00:00 UTC. Also the counter's TTL. */
export function msUntilUtcReset(now = Date.now()) {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
  return Math.max(1, next - now);
}

/** The instant the allowance comes back, as an ISO string for the client. */
export function utcResetAt(now = Date.now()) {
  return new Date(now + msUntilUtcReset(now)).toISOString();
}

/**
 * The counter key for one caller.
 *
 * The address branch uses the SESSION address — never a request field — so a
 * caller cannot spend someone else's allowance or point the counter somewhere
 * empty. The date is in the key rather than only in the TTL so that a clock skew
 * between instances can at worst split a day, never merge two.
 *
 * @param {{ address?: string|null, ip?: string, now?: number }} args
 * @returns {{ kind: "wallet"|"ip", key: string }}
 */
export function quotaKey({ address = null, ip = "unknown", now = Date.now() } = {}) {
  const day = utcDayKey(now);
  const addr = typeof address === "string" ? address.trim().toLowerCase() : "";
  if (/^0x[0-9a-f]{40}$/.test(addr)) return { kind: "wallet", key: `quota:${day}:addr:${addr}` };
  const id = String(ip ?? "").trim() || "unknown";
  return { kind: "ip", key: `quota:${day}:ip:${id}` };
}

/** Which tier a caller with this session and this entitlement is in. */
function stateFor(address, entitlement) {
  if (!address) return QUOTA_STATE.ANONYMOUS;
  if (isEntitled(entitlement)) return QUOTA_STATE.UNLIMITED;
  if (entitlement?.state === ENTITLEMENT.BELOW) return QUOTA_STATE.BELOW_THRESHOLD;
  // No entitlement object, or an unverified one: we did not measure this wallet.
  // It is NOT reported as below the threshold — see lib/entitlement.js.
  return QUOTA_STATE.UNVERIFIED;
}

/** The report shape, so no branch can quietly omit a field. */
function report(fields) {
  return {
    allowed: true,
    unlimited: false,
    state: QUOTA_STATE.ANONYMOUS,
    /** From the entitlement, when there is one: why we could not verify. */
    reason: null,
    limit: 0,
    used: 0,
    remaining: 0,
    resetsAt: null,
    /** True when the durable counter was unavailable and a per-process one stood in. */
    degraded: false,
    identity: "ip",
    ...fields,
  };
}

/**
 * The report for a caller who is not being counted, whatever the reason.
 *
 * ONE function for both no-limit paths — the verified holder and the open-access
 * switch — because consumeQuestion and peekQuota each built this block separately and
 * two more hand-written copies is how `remaining` ends up 0 in one of them and null in
 * the other. `limit: null` and `remaining: null` are load-bearing: null is "there is no
 * number here", which the client renders as no counter at all, where 0 would render as
 * an exhausted allowance.
 */
function noLimitReport(state, identity) {
  return report({
    allowed: true,
    unlimited: true,
    state,
    limit: null,
    used: 0,
    remaining: null,
    resetsAt: null,
    identity,
  });
}

/**
 * Spend one question from this caller's allowance.
 *
 * Verified holders spend nothing and touch no store: the unlimited path is one
 * comparison, which matters because this runs before every question.
 *
 * FAILING OPEN, WITH A FLOOR. If the durable store cannot be reached the request
 * is not refused — a counter outage taking the whole product down would be a
 * far worse failure than a day of overshooting a free tier — but it does not
 * become unlimited either: the per-process fixed-window limiter in
 * lib/api-guard.js stands in with the same allowance and the same reset. That
 * backstop is per-instance, so on serverless the effective cap is the allowance
 * times the number of warm lambdas. `degraded: true` says so rather than letting
 * the number be quietly wrong.
 *
 * @param {{ store: object, address?: string|null, entitlement?: object|null,
 *           ip?: string, now?: number }} args
 * @returns {Promise<object>} see report(); never throws
 */
export async function consumeQuestion({
  store,
  address = null,
  entitlement = null,
  ip = "unknown",
  now = Date.now(),
} = {}) {
  const state = stateFor(address, entitlement);
  const identity = address ? "wallet" : "ip";

  if (state === QUOTA_STATE.UNLIMITED) return noLimitReport(state, identity);
  // Checked AFTER the holder branch so a verified holder is still reported as a holder:
  // the switch lifts the limit for everyone, it does not erase who was entitled anyway.
  // Like the holder path this returns before the store is touched, so open access costs
  // no round trip and writes no counters to clean up when it comes off.
  if (openAccess()) return noLimitReport(QUOTA_STATE.OPEN, identity);

  const limit = freeDailyAllowance();
  const resetsAt = utcResetAt(now);
  const reason = entitlement?.state === ENTITLEMENT.UNVERIFIED ? entitlement.reason : null;

  // An allowance of zero is a hard paywall by configuration. Nothing to count.
  if (limit <= 0) {
    return report({
      allowed: false,
      state,
      reason,
      limit: 0,
      used: 0,
      remaining: 0,
      resetsAt,
      identity,
    });
  }

  const { key } = quotaKey({ address, ip, now });
  const ttlMs = msUntilUtcReset(now);

  try {
    // A store that is absent or not a store is the same event as one that is
    // down: the counter cannot be kept, and the fallback below takes over.
    if (typeof store?.increment !== "function") throw new Error("no store is configured");
    const { value } = await store.increment(key, { ttlMs });
    const used = Number(value) || 0;
    return report({
      allowed: used <= limit,
      state,
      reason,
      limit,
      used,
      remaining: Math.max(0, limit - used),
      resetsAt,
      identity,
    });
  } catch (e) {
    console.error(`[quota] durable counter unavailable — ${String(e?.message ?? e)}`);
    const fallback = rateLimit(`quota-fallback:${key}`, limit, ttlMs);
    return report({
      allowed: fallback.allowed,
      state,
      reason,
      limit,
      used: limit - fallback.remaining,
      remaining: fallback.remaining,
      resetsAt,
      degraded: true,
      identity,
    });
  }
}

/**
 * The same report WITHOUT spending anything — what the UI asks for on load.
 *
 * A store with no counter read, or one that fails, yields `remaining: null`. Null
 * is not zero: the client renders "5 free questions a day" rather than inventing
 * a figure it was never given.
 *
 * @param {{ store: object, address?: string|null, entitlement?: object|null,
 *           ip?: string, now?: number }} args
 * @returns {Promise<object>}
 */
export async function peekQuota({
  store,
  address = null,
  entitlement = null,
  ip = "unknown",
  now = Date.now(),
} = {}) {
  const state = stateFor(address, entitlement);
  const identity = address ? "wallet" : "ip";

  if (state === QUOTA_STATE.UNLIMITED) return noLimitReport(state, identity);
  // Both readers agree or the counter the UI shows contradicts the one the API enforces.
  if (openAccess()) return noLimitReport(QUOTA_STATE.OPEN, identity);

  const limit = freeDailyAllowance();
  const resetsAt = utcResetAt(now);
  const reason = entitlement?.state === ENTITLEMENT.UNVERIFIED ? entitlement.reason : null;
  const { key } = quotaKey({ address, ip, now });

  let used = null;
  if (typeof store?.counter === "function") {
    try {
      const row = await store.counter(key);
      used = row ? Number(row.value) || 0 : 0;
    } catch (e) {
      console.error(`[quota] counter read failed — ${String(e?.message ?? e)}`);
      used = null;
    }
  }

  return report({
    allowed: used == null ? true : used < limit,
    state,
    reason,
    limit,
    used: used ?? 0,
    remaining: used == null ? null : Math.max(0, limit - used),
    resetsAt,
    degraded: used == null,
    identity,
  });
}

/** "3h 12m" / "14m" — how long until the allowance comes back. */
function untilReset(resetsAt, now = Date.now()) {
  const ms = new Date(resetsAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return "shortly";
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * What the gate is worth holding, in words, when we know the token's name.
 *
 * AND NOTHING AT ALL WHEN NO GATE IS CONFIGURED. This told every rate-limited visitor to
 * "hold the gating token in a connected wallet to ask without a daily limit" on a
 * deployment where GATE_TOKEN_ADDRESS is unset — so there IS no gating token, nobody can
 * be verified as a holder, and the sentence sent people looking for a way to lift a limit
 * that cannot be lifted. Measured live: /api/health reported tokenGate.configured false
 * while /api/ask printed that line in its 429.
 *
 * The wallet menu already got this right (it only offers the upgrade when gate.configured
 * is true); this path did not, which is the usual shape of the bug — one surface checks a
 * precondition and another repeats the promise from memory.
 */
function holdingLine(entitlement) {
  const symbol = entitlement?.symbol;
  const threshold = entitlement?.thresholdTokens;
  // `unverified` with reason not-configured/bad-config means there is no gate to hold
  // anything against. Say nothing rather than advertise a door that does not exist.
  const reason = entitlement?.reason;
  if (reason === "not-configured" || reason === "bad-config") return null;
  if (!threshold) {
    return "Hold the gating token in a connected wallet to ask without a daily limit.";
  }
  const name = symbol ? ` ${symbol}` : " of the gating token";
  return `Hold at least ${threshold}${name} in a connected wallet to ask without a daily limit.`;
}

/**
 * The sentence a blocked caller reads.
 *
 * It has to answer two questions — which state am I in, and what would change it —
 * because someone who would happily connect a wallet cannot act on "rate limited".
 * Signing is named as a signature explicitly: the one thing a visitor being asked
 * to connect a wallet needs to know is that nothing here moves funds.
 *
 * @param {object} quota a report from consumeQuestion / peekQuota
 * @param {object|null} entitlement the entitlement the report was built from
 * @param {number} [now]
 * @returns {string}
 */
export function quotaMessage(quota, entitlement = null, now = Date.now()) {
  if (!quota || quota.unlimited) return "";

  const when = `They come back at 00:00 UTC (in ${untilReset(quota.resetsAt, now)}).`;
  // "Spent" covers the three ways a caller has nothing left: the allowance is
  // configured to zero, the counter says zero, or this very request was refused.
  const spent = quota.limit <= 0 || quota.remaining === 0 || quota.allowed === false;
  const standing = spent
    ? quota.limit <= 0
      ? "There is no free allowance on this server."
      : `You have used all ${quota.limit} free question${quota.limit === 1 ? "" : "s"} for today. ${when}`
    : quota.remaining == null
      ? `You get ${quota.limit} free question${quota.limit === 1 ? "" : "s"} a day. ${when}`
      : `${quota.remaining} of ${quota.limit} free questions left today. ${when}`;

  if (quota.state === QUOTA_STATE.ANONYMOUS) {
    const hold = holdingLine(entitlement);
    // No gate configured: connecting is still worth doing — it saves history — but it does
    // NOT lift the limit, because signed-in and anonymous share the same allowance until a
    // gate exists. Offering "ask without a daily limit" here would be selling a door that
    // is not there, and the signature reassurance is worth keeping either way.
    const offer = hold
      ? `${hold} `
      : "Token gating is not configured on this server, so connecting a wallet saves your history but does not lift the daily limit. ";
    return `${standing} ${offer}Connecting only asks you to SIGN a message — it is not a transaction, it cannot move funds, grant an allowance or spend gas.`;
  }

  if (quota.state === QUOTA_STATE.BELOW_THRESHOLD) {
    const balance =
      entitlement?.balanceTokens != null
        ? `This wallet holds ${entitlement.balanceTokens}${entitlement.symbol ? ` ${entitlement.symbol}` : ""}, below the ${entitlement.thresholdTokens} needed for unlimited questions. `
        : "";
    return `${balance}${standing}`;
  }

  // Unverified. The one thing this must never say is "you hold nothing".
  const why =
    quota.reason === UNVERIFIED_REASON.NOT_CONFIGURED || quota.reason === UNVERIFIED_REASON.BAD_CONFIG
      ? "Token gating is not configured on this server, so nobody can be verified as a holder right now."
      : "We could not read your token balance just now — that is a failed lookup on our side, not a statement that you hold none. Try again in a few minutes.";
  return `${standing} ${why}`;
}
