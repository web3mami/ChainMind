import { NextResponse } from "next/server";
import { clientIp, isSameOriginRequest, rateLimit } from "@/lib/api-guard.js";
import { clearHistory } from "@/lib/history.js";
import { clearedCookie, PRE_SESSION_COOKIE, readSessionCookie, SESSION_COOKIE, sessionTokenFromRequest } from "@/lib/session.js";
import { getStore, StoreUnconfiguredError } from "@/lib/store.js";

export const runtime = "nodejs";
export const maxDuration = 15;

const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60_000;
const NO_STORE = { "cache-control": "no-store" };

/**
 * DELETE /api/account — erase this wallet's ChainMind account data.
 *
 * Clears saved Ask history, push device registration, and the session cookie /
 * bearer. Research job ownership records age out on their own TTL; we do not
 * keep a secondary index of every job id to scrub.
 *
 * Required for App Store Guideline 5.1.1(v) when the app offers sign-in.
 */
export async function DELETE(req) {
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ ok: false, error: "Cross-origin requests are not allowed." }, { status: 403, headers: NO_STORE });
  }
  if (!rateLimit(`account-delete:${clientIp(req)}`, RATE_LIMIT, RATE_WINDOW_MS).allowed) {
    return NextResponse.json({ ok: false, error: "Too many requests." }, { status: 429, headers: NO_STORE });
  }

  const session = readSessionCookie(sessionTokenFromRequest(req));
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: "Sign in to delete account data." }, { status: 401, headers: NO_STORE });
  }

  const address = session.address;
  const cleared = { history: false, push: false };

  try {
    const store = await getStore();
    try {
      await clearHistory({ store, address });
      cleared.history = true;
    } catch (e) {
      console.error(`[account] history clear failed: ${String(e?.message ?? e)}`);
    }
    try {
      await store.delete(`push:ios:${address}`);
      cleared.push = true;
    } catch (e) {
      console.error(`[account] push clear failed: ${String(e?.message ?? e)}`);
    }
  } catch (e) {
    if (!(e instanceof StoreUnconfiguredError)) {
      console.error(`[account] store open failed: ${String(e?.stack ?? e)}`);
      return NextResponse.json({ ok: false, error: "Could not reach account storage." }, { status: 502, headers: NO_STORE });
    }
    // No store: still clear cookies so the client can finish local wipe.
  }

  const res = NextResponse.json(
    {
      ok: true,
      address,
      cleared,
      reading: "ChainMind account data for this wallet was cleared. You can disconnect locally anytime.",
    },
    { status: 200, headers: NO_STORE },
  );
  res.cookies.set(clearedCookie(SESSION_COOKIE).name, "", clearedCookie(SESSION_COOKIE).options);
  res.cookies.set(clearedCookie(PRE_SESSION_COOKIE).name, "", clearedCookie(PRE_SESSION_COOKIE).options);
  return res;
}
