/**
 * Signed cookies: the only thing standing between "this browser says it is
 * 0xabc" and "this browser proved it, once, and we wrote it down".
 *
 * WHAT IS IN A SESSION. An address, an issued-at and an expiry — nothing else.
 * No balance, no entitlement, no quota remaining. The moment a number that
 * decides access lives in a cookie, the cookie becomes the thing worth forging,
 * and the server stops being the authority on it. The balance check is a
 * server-side read against our own RPC client, every time it matters; this file
 * only answers "whose session is this".
 *
 * WHY HMAC AND NOT ENCRYPTION. The payload is not secret — the user's own address
 * is not a secret from the user. What must be impossible is CHANGING it, so the
 * cookie is signed with HMAC-SHA-256 over the encoded payload and compared in
 * constant time. Nothing in it is worth hiding from the person holding it.
 *
 * FAIL CLOSED. With no SESSION_SECRET there is no signing key, and a cookie
 * signed with nothing is a cookie anyone can write. Every entry point here throws
 * SessionUnconfiguredError instead, so a misconfigured deploy serves a clear 503
 * rather than an open door. There is deliberately no development fallback secret:
 * the one that ships is the one that leaks.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** The session itself. Short name, no dots — cookie prefixes are not free here. */
export const SESSION_COOKIE = "cm_session";

/** The pre-session that a nonce is bound to. Cleared the moment sign-in lands. */
export const PRE_SESSION_COOKIE = "cm_auth";

/** Minimum secret length. 32 chars of base64 is ~192 bits; below that, no. */
export const MIN_SECRET_CHARS = 32;

/** Default session lifetime. Long enough not to nag, short enough to matter. */
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Default pre-session lifetime — it only has to outlive one signing prompt. */
const DEFAULT_PRE_SESSION_TTL_MS = 15 * 60 * 1000;

/** Clock seam; see lib/store.js for why. Production never touches it. */
let clock = () => Date.now();

/**
 * Swap the clock for a test, and get a restore function back.
 * @param {() => number} fn
 * @returns {() => void}
 */
export function setSessionClock(fn) {
  const previous = clock;
  clock = typeof fn === "function" ? fn : previous;
  return () => {
    clock = previous;
  };
}

/** Missing or unusable SESSION_SECRET. Routes turn this into a 503, never a 500. */
export class SessionUnconfiguredError extends Error {
  constructor(message) {
    super(message);
    this.name = "SessionUnconfiguredError";
    this.code = "SESSION_UNCONFIGURED";
  }
}

/**
 * The signing key, read per call so a rotated secret takes effect on redeploy
 * without a rebuild.
 *
 * @throws {SessionUnconfiguredError} when absent or too short
 */
export function getSessionSecret() {
  const raw = process.env.SESSION_SECRET;
  const secret = raw == null ? "" : String(raw).trim();
  if (!secret) {
    throw new SessionUnconfiguredError(
      "SESSION_SECRET is not set, so sessions cannot be signed. Generate one with " +
        "`node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"` " +
        "and set it in the environment. Wallet sign-in stays disabled until it is.",
    );
  }
  if (secret.length < MIN_SECRET_CHARS) {
    throw new SessionUnconfiguredError(
      `SESSION_SECRET is too short (${secret.length} chars; need at least ${MIN_SECRET_CHARS}). ` +
        "A guessable signing key is the same as no signing key.",
    );
  }
  return secret;
}

/** True when sessions can be issued. For a route that wants a 503, not a throw. */
export function isSessionConfigured() {
  try {
    getSessionSecret();
    return true;
  } catch {
    return false;
  }
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

/**
 * Sign a payload for one PURPOSE.
 *
 * The purpose is mixed into the MAC input, not just stored in the payload, so a
 * pre-session token cannot be pasted into the session cookie slot and verify.
 * Both are signed with the same secret; without domain separation the pre-session
 * — which is handed out to anyone who asks for a nonce — would be a valid session
 * envelope, and the only thing left stopping a forged login would be a field
 * check that a later refactor could quietly drop.
 *
 * @param {string} purpose
 * @param {object} payload - JSON-serialisable; must not contain secrets
 * @returns {string} "<b64url payload>.<b64url mac>"
 */
export function signPayload(purpose, payload) {
  const secret = getSessionSecret();
  const encoded = b64url(JSON.stringify(payload));
  const mac = createHmac("sha256", secret).update(`${purpose}.${encoded}`).digest();
  return `${encoded}.${b64url(mac)}`;
}

/**
 * Verify and decode a token produced by signPayload.
 *
 * Never throws on bad input — a mangled cookie is an ordinary event (a rotated
 * secret, a truncating proxy, an attacker with a hex editor) and all three should
 * read the same way to the caller: no session.
 *
 * @returns {{ ok: true, payload: object } | { ok: false, reason: string }}
 */
export function verifyPayload(purpose, token) {
  let secret;
  try {
    secret = getSessionSecret();
  } catch {
    return { ok: false, reason: "unconfigured" };
  }
  const raw = typeof token === "string" ? token : "";
  if (!raw) return { ok: false, reason: "missing" };

  const dot = raw.lastIndexOf(".");
  if (dot <= 0 || dot === raw.length - 1) return { ok: false, reason: "malformed" };
  const encoded = raw.slice(0, dot);
  const provided = Buffer.from(raw.slice(dot + 1), "base64url");

  const expected = createHmac("sha256", secret).update(`${purpose}.${encoded}`).digest();
  // Length check first: timingSafeEqual throws on a length mismatch, and a
  // truncated MAC must be a rejection, not an exception.
  if (provided.length !== expected.length) return { ok: false, reason: "bad-signature" };
  if (!timingSafeEqual(provided, expected)) return { ok: false, reason: "bad-signature" };

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    // A valid MAC over an unparseable body means our own writer changed shape.
    return { ok: false, reason: "malformed" };
  }
  if (!payload || typeof payload !== "object") return { ok: false, reason: "malformed" };
  if (payload.exp != null && Number(payload.exp) <= clock()) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

/**
 * Cookie attributes shared by both cookies.
 *
 * httpOnly: script must not be able to read a session, so an XSS bug costs the
 *   page, not the account.
 * sameSite lax: the app never needs the cookie on a cross-site POST, and lax
 *   stops another origin's form from acting as the user.
 * secure: on in production. NOT in development, because a Secure cookie is not
 *   sent over http://localhost by every browser and a dev login that silently
 *   never persists is a day lost to the wrong bug.
 */
function cookieOptions(maxAgeSeconds) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/** Session lifetime, overridable per deploy. */
export function sessionTtlMs() {
  const n = Number(process.env.AUTH_SESSION_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SESSION_TTL_MS;
}

/** Pre-session lifetime, overridable per deploy. */
export function preSessionTtlMs() {
  const n = Number(process.env.AUTH_PRE_SESSION_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PRE_SESSION_TTL_MS;
}

/**
 * Build the session cookie for a proven address.
 *
 * The address is lowercased on the way in and the caller is expected to have
 * checksum-validated it already: one canonical form in the payload means a
 * comparison somewhere else cannot fail on casing alone.
 *
 * @param {string} address
 * @param {{ ttlMs?: number }} [options]
 * @returns {{ name: string, value: string, options: object, expiresAt: number }}
 */
export function createSessionCookie(address, options = {}) {
  const ttl = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : sessionTtlMs();
  const now = clock();
  const expiresAt = now + ttl;
  const value = signPayload("session", {
    v: 1,
    address: String(address).toLowerCase(),
    iat: now,
    exp: expiresAt,
  });
  return {
    name: SESSION_COOKIE,
    value,
    options: cookieOptions(Math.floor(ttl / 1000)),
    expiresAt,
  };
}

/**
 * Read a session cookie value.
 *
 * @param {string|null|undefined} value
 * @returns {{ ok: true, address: string, issuedAt: number, expiresAt: number }
 *          | { ok: false, reason: string }}
 */
export function readSessionCookie(value) {
  const res = verifyPayload("session", value);
  if (!res.ok) return res;
  const address = String(res.payload.address ?? "").toLowerCase();
  // A signed payload we cannot make sense of is still a rejection: the address is
  // the entire content of a session, so an absent one is not a session.
  if (!/^0x[0-9a-f]{40}$/.test(address)) return { ok: false, reason: "malformed" };
  return {
    ok: true,
    address,
    issuedAt: Number(res.payload.iat) || 0,
    expiresAt: Number(res.payload.exp) || 0,
  };
}

/**
 * Mint a pre-session: a random id, signed, that a nonce can be bound to.
 *
 * WHY IT EXISTS. Without it a nonce is a bearer token — anyone who sees one can
 * present a matching signature. Binding it to a cookie this browser was given
 * means a nonce farmed from someone else's page is useless here.
 *
 * @returns {{ name: string, value: string, options: object, id: string, expiresAt: number }}
 */
export function createPreSessionCookie() {
  const ttl = preSessionTtlMs();
  const now = clock();
  const expiresAt = now + ttl;
  const id = randomBytes(16).toString("base64url");
  const value = signPayload("pre-session", { v: 1, id, iat: now, exp: expiresAt });
  return { name: PRE_SESSION_COOKIE, value, options: cookieOptions(Math.floor(ttl / 1000)), id, expiresAt };
}

/**
 * Read a pre-session cookie value.
 * @returns {{ ok: true, id: string } | { ok: false, reason: string }}
 */
export function readPreSessionCookie(value) {
  const res = verifyPayload("pre-session", value);
  if (!res.ok) return res;
  const id = typeof res.payload.id === "string" ? res.payload.id : "";
  if (!id) return { ok: false, reason: "malformed" };
  return { ok: true, id };
}

/**
 * The cookie that removes a cookie.
 *
 * Empty value AND maxAge 0: some clients keep an expired-but-present cookie
 * around long enough to be re-sent once, and an empty value fails verification
 * anyway, so the two together mean logout cannot half-happen.
 *
 * @param {string} name
 */
export function clearedCookie(name) {
  return { name, value: "", options: { ...cookieOptions(0), expires: new Date(0) } };
}

/** `0x1234…cdef` — the only form of an address that belongs in a log line. */
export function shortAddress(address) {
  const a = String(address ?? "");
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "(none)";
}

/**
 * `Authorization: Bearer <token>` value, or null.
 *
 * Native clients cannot rely on httpOnly cookies the way a browser can: the
 * session is stored in the Keychain and replayed as a bearer token. The token
 * bytes are the same signed envelope the cookie carries — there is no second
 * session format — so a bearer and a cookie are interchangeable at verify time.
 *
 * @param {Request|{ headers?: { get?: (name: string) => string|null } }} request
 * @returns {string|null}
 */
export function bearerAuthorization(request) {
  const h = request?.headers;
  if (!h || typeof h.get !== "function") return null;
  const raw = String(h.get("authorization") ?? "").trim();
  const match = /^Bearer\s+(\S+)$/i.exec(raw);
  return match ? match[1] : null;
}

/**
 * Session token from cookie first, then Bearer — never from the body.
 *
 * Cookie wins when both are present so a browser that still has an old bearer
 * cached in a client cannot override a fresher cookie logout.
 *
 * @param {Request|{ cookies?: { get?: (name: string) => { value?: string }|undefined },
 *                   headers?: { get?: (name: string) => string|null } }} request
 * @returns {string|null}
 */
export function sessionTokenFromRequest(request) {
  const cookie = request?.cookies?.get?.(SESSION_COOKIE)?.value;
  if (typeof cookie === "string" && cookie) return cookie;
  return bearerAuthorization(request);
}

/**
 * Pre-session token from cookie first, then an explicit challengeToken body
 * field — the latter is how a native client that has no cookie jar binds a
 * nonce to the same pre-session the server minted for it.
 *
 * @param {Request|{ cookies?: { get?: (name: string) => { value?: string }|undefined } }} request
 * @param {string|null|undefined} challengeToken
 * @returns {string|null}
 */
export function preSessionTokenFromRequest(request, challengeToken = null) {
  const cookie = request?.cookies?.get?.(PRE_SESSION_COOKIE)?.value;
  if (typeof cookie === "string" && cookie) return cookie;
  return typeof challengeToken === "string" && challengeToken ? challengeToken : null;
}
