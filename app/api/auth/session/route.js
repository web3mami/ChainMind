import { NextResponse } from "next/server";
import { getChainConfig } from "@/lib/chain.js";
import { isSessionConfigured, readSessionCookie, sessionTokenFromRequest } from "@/lib/session.js";

export const runtime = "nodejs";
export const maxDuration = 10;

/**
 * GET — who am I.
 *
 * Reads the signed cookie and nothing else: no store, no RPC, no balance. It
 * answers "is this browser holding a session we issued", which is a question the
 * cookie alone can answer honestly. Whether that address currently HOLDS enough
 * of the gating token is a separate, server-side, periodically re-checked
 * question — and folding it in here would tempt a caller to treat this response
 * as an entitlement.
 *
 * Deliberately not cached: an expired or logged-out session must not be served
 * from an edge cache as still signed in.
 */
export async function GET(request) {
  if (!isSessionConfigured()) {
    return NextResponse.json(
      {
        authenticated: false,
        configured: false,
        error: "Wallet sign-in is not configured on this server.",
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const session = readSessionCookie(sessionTokenFromRequest(request));
  if (!session.ok) {
    return NextResponse.json(
      { authenticated: false, configured: true },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }

  return NextResponse.json(
    {
      authenticated: true,
      configured: true,
      address: session.address,
      chainId: getChainConfig().id,
      expiresAt: new Date(session.expiresAt).toISOString(),
    },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
