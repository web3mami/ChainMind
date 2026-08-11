import { NextResponse } from "next/server";
import { clientIp, isSameOriginRequest, rateLimit } from "@/lib/api-guard.js";
import { getStore } from "@/lib/store.js";
import {
  clearedCookie,
  createSessionCookie,
  isSessionConfigured,
  PRE_SESSION_COOKIE,
  preSessionTokenFromRequest,
  readPreSessionCookie,
  shortAddress,
} from "@/lib/session.js";
import { authDomain, GENERIC_REJECTION, verifySignIn } from "@/lib/wallet-auth.js";

export const runtime = "nodejs";
export const maxDuration = 10;

// Tighter than the nonce route on purpose. Issuing a challenge is harmless;
// redeeming one is where guessing would happen, and a wallet that is working
// needs exactly one attempt per challenge.
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;

/** Address + signature + optional challengeToken (signed pre-session envelope). */
const MAX_BODY_CHARS = 4_000;

/**
 * POST { address, signature } — finish a sign-in.
 *
 * The nonce is NOT in the body. It is looked up under the httpOnly pre-session
 * cookie this browser was given, which is what stops a challenge issued to one
 * visitor being redeemed by another.
 *
 * Every failure returns the SAME sentence with the same status. The precise
 * reason goes to the log, never to the caller: "that nonce expired" and "that
 * signature is for another address" together are a working oracle for probing
 * how the gate is built.
 */
export async function POST(request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Not allowed from this origin." }, { status: 403 });
  }
  if (!rateLimit(`auth-verify:${clientIp(request)}`, RATE_LIMIT, RATE_WINDOW_MS).allowed) {
    return NextResponse.json({ error: "Too many sign-in attempts. Wait a minute." }, { status: 429 });
  }
  if (!isSessionConfigured()) {
    return NextResponse.json(
      { error: "Wallet sign-in is not configured on this server.", configured: false },
      { status: 503 },
    );
  }

  // The SECOND half of the domain binding. The challenge was minted under this
  // same configured value; checking it again here is what makes a challenge
  // naming any other domain unredeemable, and checking it BEFORE the signature
  // work means an unconfigured deploy reads as "not configured" rather than as a
  // wallet the user should go and debug.
  const domain = authDomain();
  if (!domain) {
    return NextResponse.json(
      { error: "Wallet sign-in is not configured on this server.", configured: false },
      { status: 503 },
    );
  }

  const raw = await request.text().catch(() => "");
  if (raw.length > MAX_BODY_CHARS) {
    return NextResponse.json({ error: GENERIC_REJECTION }, { status: 401 });
  }
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: GENERIC_REJECTION }, { status: 401 });
  }

  let store;
  try {
    store = await getStore();
  } catch (e) {
    console.error(`[auth] verify: no usable store — ${e?.message ?? e}`);
    // 503, not 401. An outage must never read to the user as "your signature was
    // wrong" — they would go looking for a problem with their wallet.
    return NextResponse.json({ error: "Sign-in is unavailable right now." }, { status: 503 });
  }

  const challengeToken =
    typeof body?.challengeToken === "string" ? body.challengeToken : null;
  const pre = readPreSessionCookie(preSessionTokenFromRequest(request, challengeToken));
  let result;
  try {
    result = await verifySignIn({
      store,
      address: body?.address,
      signature: body?.signature,
      preSessionId: pre.ok ? pre.id : null,
      domain,
    });
  } catch (e) {
    console.error(`[auth] verify: unexpected failure — ${e?.message ?? e}`);
    return NextResponse.json({ error: "Sign-in is unavailable right now." }, { status: 503 });
  }

  if (!result.ok) {
    return NextResponse.json({ error: GENERIC_REJECTION }, { status: 401 });
  }

  const session = createSessionCookie(result.address);
  console.info(`[auth] signed in address=${shortAddress(result.address)}`);

  // `token` is the session cookie value — native clients store it in the
  // Keychain and send `Authorization: Bearer <token>`. Browsers keep using the
  // Set-Cookie path and ignore the field.
  const res = NextResponse.json({
    address: result.address,
    expiresAt: new Date(session.expiresAt).toISOString(),
    token: session.value,
  });
  res.cookies.set(session.name, session.value, session.options);
  // The challenge is spent; the pre-session that carried it has no further use
  // and a stale one would only make the next sign-in reuse a dead binding.
  const cleared = clearedCookie(PRE_SESSION_COOKIE);
  res.cookies.set(cleared.name, cleared.value, cleared.options);
  return res;
}
