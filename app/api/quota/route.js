import { NextResponse } from "next/server";
import { clientIp, isSameOriginRequest, rateLimit } from "@/lib/api-guard.js";
import { publicEntitlement, publicQuota, resolveAccess } from "@/lib/ask-access.js";
import { gateStatus } from "@/lib/entitlement.js";
import { quotaMessage } from "@/lib/quota.js";
import { sessionTokenFromRequest } from "@/lib/session.js";

export const runtime = "nodejs";
export const maxDuration = 10;

// The header widget asks for this on load and after a sign-in, so it is a few
// requests per session. The limit is only here to stop it being a free way to
// make the server do a balance read on a loop.
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

/**
 * GET — where this caller stands, WITHOUT spending a question.
 *
 * It answers the three things the UI has to be able to say honestly:
 *   - which tier: unlimited, anonymous, below the threshold, or unverifiable;
 *   - how many free questions are left today, or `null` when the counter could
 *     not be read — because a client that renders `0` from a failed read is the
 *     same bug as an outage reading as absence, one layer up;
 *   - what the gate is set to, so the copy can name the token and the number.
 *
 * `consume: false` is the whole difference from /api/ask. Loading a page must
 * never cost somebody a question.
 */
export async function GET(request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Not allowed from this origin." }, { status: 403 });
  }
  if (!rateLimit(`quota:${clientIp(request)}`, RATE_LIMIT, RATE_WINDOW_MS).allowed) {
    return NextResponse.json({ error: "Too many requests. Wait a minute." }, { status: 429 });
  }

  const access = await resolveAccess({
    sessionCookie: sessionTokenFromRequest(request),
    ip: clientIp(request),
    consume: false,
  });

  const gate = gateStatus();
  return NextResponse.json(
    {
      // The address is the caller's own, read back from the cookie they hold.
      address: access.address,
      quota: publicQuota(access.quota),
      entitlement: publicEntitlement(access.entitlement),
      gate: { configured: gate.configured, token: gate.token, symbol: gate.symbol, minTokens: gate.minTokens },
      // The same sentence /api/ask would send on a 429, so the panel and the
      // transcript never disagree about why someone is limited.
      message: access.quota.unlimited ? "" : quotaMessage(access.quota, access.entitlement),
    },
    // Never cached: an entitlement that changed a minute ago must not be served
    // from an edge cache as still true.
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
