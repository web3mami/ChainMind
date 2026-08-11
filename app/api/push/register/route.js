import { NextResponse } from "next/server";
import { clientIp, isSameOriginRequest, rateLimit } from "@/lib/api-guard.js";
import { readSessionCookie, sessionTokenFromRequest } from "@/lib/session.js";
import { getStore, StoreUnconfiguredError } from "@/lib/store.js";

export const runtime = "nodejs";
export const maxDuration = 10;

const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;
/** Device tokens live a year; iOS refreshes them periodically. */
const TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;

/**
 * POST /api/push/register — store an APNs device token for the signed-in wallet.
 *
 * Remote delivery still needs an APNs key on the server; registering the token
 * now means research-complete pushes can land once that is configured.
 */
export async function POST(req) {
  if (!String(req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return NextResponse.json({ ok: false, error: "Content-Type must be application/json." }, { status: 415 });
  }
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ ok: false, error: "Cross-origin requests are not allowed." }, { status: 403 });
  }
  if (!rateLimit(`push-register:${clientIp(req)}`, RATE_LIMIT, RATE_WINDOW_MS).allowed) {
    return NextResponse.json({ ok: false, error: "Too many requests." }, { status: 429 });
  }

  const session = readSessionCookie(sessionTokenFromRequest(req));
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: "Sign in to register for push." }, { status: 401 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Body must be JSON." }, { status: 400 });
  }

  const token = String(body?.token ?? "").trim().toLowerCase();
  const platform = String(body?.platform ?? "ios").trim().toLowerCase() || "ios";
  if (!/^[0-9a-f]{32,200}$/.test(token)) {
    return NextResponse.json(
      { ok: false, error: "token must be a hex APNs device token." },
      { status: 400 },
    );
  }
  if (platform !== "ios") {
    return NextResponse.json({ ok: false, error: "Only ios is supported right now." }, { status: 400 });
  }

  try {
    const store = await getStore();
    const key = `push:${platform}:${session.address}`;
    await store.set(
      key,
      {
        token,
        platform,
        address: session.address,
        updatedAt: Date.now(),
      },
      { ttlMs: TOKEN_TTL_SECONDS * 1000 },
    );
    return NextResponse.json(
      { ok: true, reading: "Device registered for research alerts." },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    if (e instanceof StoreUnconfiguredError) {
      return NextResponse.json(
        { ok: false, error: "Push registration needs a configured store on this deployment." },
        { status: 501 },
      );
    }
    console.error(`[push] register failed: ${String(e?.stack ?? e)}`);
    return NextResponse.json({ ok: false, error: "Could not save the device token." }, { status: 502 });
  }
}

/** DELETE — clear the token for this wallet (opt out). */
export async function DELETE(req) {
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ ok: false, error: "Cross-origin requests are not allowed." }, { status: 403 });
  }
  const session = readSessionCookie(sessionTokenFromRequest(req));
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: "Sign in first." }, { status: 401 });
  }
  try {
    const store = await getStore();
    await store.delete(`push:ios:${session.address}`);
    return NextResponse.json({ ok: true }, { status: 200, headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof StoreUnconfiguredError) {
      return NextResponse.json({ ok: false, error: "Store not configured." }, { status: 501 });
    }
    return NextResponse.json({ ok: false, error: "Could not clear the token." }, { status: 502 });
  }
}
