import { NextResponse } from "next/server";
import { clientIp, isSameOriginRequest, rateLimit } from "@/lib/api-guard.js";
import { listStockTokens } from "@/lib/stock-tokens.js";

export const runtime = "nodejs";
// The page walk behind listStockTokens is ~8-15s COLD (see lib/stock-tokens.js);
// warm hits are a cache read. 30s clears the cold case with room, and the edge
// cache below means almost nobody pays it.
export const maxDuration = 30;

// Same shape of guard as /api/quota: this route exists for the app's own
// clients (the iOS app reads it), and while the data is public, the page walk
// behind a cold read is not free — third-party sites don't get to spend it.
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

/**
 * GET — the issuer-verified tokenized equities, as JSON.
 *
 * The same list the /stocks page renders, for clients that are not this web
 * app (the iOS app is the first). Figures are raw numbers or null — null is
 * "the indexer said nothing", never zero — and `partial` travels with the list
 * so a walk the indexer cut short is never presented as the whole registry.
 */
export async function GET(request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ ok: false, error: "Not allowed from this origin." }, { status: 403 });
  }
  if (!rateLimit(`stocks:${clientIp(request)}`, RATE_LIMIT, RATE_WINDOW_MS).allowed) {
    return NextResponse.json({ ok: false, error: "Too many requests. Wait a minute." }, { status: 429 });
  }

  let tokens;
  try {
    tokens = await listStockTokens();
  } catch {
    // A dead indexer reads as "could not look this up", never as an empty
    // market — same rule as everywhere else in this codebase.
    return NextResponse.json(
      { ok: false, error: "Couldn't reach the chain indexer just now. Try again in a minute." },
      { status: 502 },
    );
  }

  const items = Array.isArray(tokens) ? tokens : [];
  return NextResponse.json(
    { ok: true, count: items.length, partial: Boolean(tokens?.partial), items },
    {
      // Public data on a five-minute in-memory TTL upstream; the edge may hold
      // it for the same window. stale-while-revalidate keeps a burst of app
      // launches from queueing on one cold page-walk.
      headers: { "cache-control": "public, s-maxage=300, stale-while-revalidate=600" },
    },
  );
}
