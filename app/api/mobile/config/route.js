import { NextResponse } from "next/server";
import { clientIp, isSameOriginRequest, rateLimit } from "@/lib/api-guard.js";

export const runtime = "nodejs";
export const maxDuration = 10;

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

/**
 * Truthy only for explicit opt-in. Missing / empty / "false" → off.
 * Used so App Store builds stay wallet-free until an operator flips the env.
 */
function envFlag(name) {
  const raw = String(process.env[name] ?? "")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * GET /api/mobile/config — remote switches for the native iOS client.
 *
 * No auth. Defaults are App Store–safe (walletFeatures: false). Flip
 * `MOBILE_WALLET_FEATURES=true` on Vercel after Organization enrollment +
 * App Review approval; the next app launch picks it up without a new binary.
 */
export async function GET(request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Not allowed from this origin." }, { status: 403 });
  }
  if (!rateLimit(`mobile-config:${clientIp(request)}`, RATE_LIMIT, RATE_WINDOW_MS).allowed) {
    return NextResponse.json({ error: "Too many requests. Wait a minute." }, { status: 429 });
  }

  return NextResponse.json(
    {
      walletFeatures: envFlag("MOBILE_WALLET_FEATURES"),
    },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
