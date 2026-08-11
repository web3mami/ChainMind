import { NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import { clientIp, isSameOriginRequest, rateLimit } from "@/lib/api-guard.js";
import { getChainConfig } from "@/lib/chain.js";
import { getStore } from "@/lib/store.js";
import {
  createPreSessionCookie,
  isSessionConfigured,
  readPreSessionCookie,
  PRE_SESSION_COOKIE,
} from "@/lib/session.js";
import { authDomain, buildSignInMessage, issueNonce } from "@/lib/wallet-auth.js";

export const runtime = "nodejs";
// Nothing here talks to an LLM or an indexer: a store write and a random number.
// A long budget would only hold a lambda open while something upstream hangs.
export const maxDuration = 10;

// This route is the GUARD and the ADAPTER, nothing else — same split as
// app/api/ask/route.js. The challenge itself is built in lib/wallet-auth.js so
// that `node --test` can exercise it without next/server or the "@/" alias.
//
// The limit is per-IP and generous, because issuing a nonce is cheap and the
// honest failure mode (a user retrying a wallet prompt) looks like a burst. It
// exists so nobody can fill the store with challenges for free. Per invariant:
// this is a speed bump, not an access control — an IP is shared behind NAT and
// changes behind a VPN.
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;

/** Enough for `{"address":"0x…"}` and nothing else. */
const MAX_BODY_CHARS = 200;

/**
 * The address the caller says it is about to sign with, if it sent one.
 *
 * It is used for ONE thing: rendering the message with a checksummed address so
 * the browser does not have to compute a checksum itself (which would mean
 * shipping keccak to every visitor for one string). It is NOT stored with the
 * nonce and it does not commit the challenge to anybody — verify rebuilds the
 * message around whichever address is claimed THEN, and recovers the signer from
 * that. A caller who lies here only gets a message that will not verify.
 */
async function claimedAddress(request) {
  const raw = await request.text().catch(() => "");
  if (!raw || raw.length > MAX_BODY_CHARS) return null;
  try {
    const body = JSON.parse(raw);
    const addr = typeof body?.address === "string" ? body.address.trim() : "";
    return isAddress(addr) ? getAddress(addr) : null;
  } catch {
    // No body, or not JSON. Both are fine — the template below still works.
    return null;
  }
}

/**
 * POST — start a sign-in.
 *
 * Returns the EXACT message to sign. The client must not build its own: the
 * server rebuilds these bytes at verify time from what it stored, so any message
 * assembled elsewhere simply will not match.
 */
export async function POST(request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Not allowed from this origin." }, { status: 403 });
  }
  if (!rateLimit(`auth-nonce:${clientIp(request)}`, RATE_LIMIT, RATE_WINDOW_MS).allowed) {
    return NextResponse.json({ error: "Too many sign-in attempts. Wait a minute." }, { status: 429 });
  }

  // Fail closed and SAY SO. An unconfigured deploy must not look like a wallet
  // that refused — the operator is missing an env var and needs to read that.
  if (!isSessionConfigured()) {
    return NextResponse.json(
      { error: "Wallet sign-in is not configured on this server.", configured: false },
      { status: 503 },
    );
  }

  // The domain baked into the signed message comes from server config and never
  // from this request's Host / X-Forwarded-Host — those are attacker-writable,
  // and a challenge naming an attacker's site is a signature they can farm there
  // and redeem here. No configured domain, no challenge: an unconfigured deploy
  // must be unable to sign anyone in rather than able to do it unsafely.
  const domain = authDomain();
  if (!domain) {
    return NextResponse.json(
      {
        error: "Wallet sign-in is not configured on this server.",
        configured: false,
      },
      { status: 503 },
    );
  }

  let store;
  try {
    store = await getStore();
  } catch (e) {
    console.error(`[auth] nonce: no usable store — ${e?.message ?? e}`);
    return NextResponse.json(
      { error: "Wallet sign-in is not configured on this server.", configured: false },
      { status: 503 },
    );
  }

  // Reuse the pre-session when the browser already has a valid one, so a user who
  // dismisses the wallet prompt and tries again does not accumulate cookies.
  const existing = readPreSessionCookie(request.cookies.get(PRE_SESSION_COOKIE)?.value);
  const fresh = existing.ok ? null : createPreSessionCookie();
  const preSessionId = existing.ok ? existing.id : fresh.id;

  const address = await claimedAddress(request);
  const chainId = getChainConfig().id;
  let challenge;
  try {
    challenge = await issueNonce({ store, domain, preSessionId, chainId });
  } catch (e) {
    console.error(`[auth] nonce: store write failed — ${e?.message ?? e}`);
    // An outage is not "you may not sign in". 503 says try again; 403 would not.
    return NextResponse.json({ error: "Sign-in is unavailable right now." }, { status: 503 });
  }

  // Native clients cannot read httpOnly cookies, so the pre-session value is
  // also returned in the body as `challengeToken`. They send it back on verify.
  // Browsers ignore it and keep using the cookie — same bytes either way.
  const challengeToken =
    fresh?.value ?? request.cookies.get(PRE_SESSION_COOKIE)?.value ?? null;

  const res = NextResponse.json({
    domain,
    chainId,
    nonce: challenge.nonce,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    ...(challengeToken ? { challengeToken } : {}),
    // Address is filled in by the client from the connected account; the server
    // rebuilds this same string around whichever address is claimed at verify.
    messageTemplate: buildSignInMessage({
      domain,
      address: "{address}",
      chainId,
      nonce: challenge.nonce,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
    }),
    // The same string with the caller's address already checksummed in, when it
    // told us one. Present so the browser signs bytes IT did not assemble.
    ...(address
      ? {
          address,
          message: buildSignInMessage({
            domain,
            address,
            chainId,
            nonce: challenge.nonce,
            issuedAt: challenge.issuedAt,
            expiresAt: challenge.expiresAt,
          }),
        }
      : {}),
  });
  if (fresh) res.cookies.set(fresh.name, fresh.value, fresh.options);
  return res;
}
