import { NextResponse } from "next/server";
import { clientIp, isSameOriginRequest, rateLimit } from "@/lib/api-guard.js";
import {
  clearHistory,
  deleteHistoryEntry,
  historyEnabled,
  historyMaxItems,
  listHistory,
} from "@/lib/history.js";
import { isSessionConfigured, readSessionCookie, sessionTokenFromRequest } from "@/lib/session.js";
import { getStore } from "@/lib/store.js";

export const runtime = "nodejs";
// A store read and a store write. Nothing here talks to a model or an indexer,
// so a long budget would only hold an instance open while something hangs.
export const maxDuration = 10;

// Generous: a panel that lists, then deletes three entries, is four requests in a
// few seconds and that is ordinary use. It exists so a script cannot sit on the
// store for free.
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

/** Never cached, anywhere: this is one wallet's own content. */
const NO_STORE = { "cache-control": "no-store" };

/**
 * The address whose history this request may touch — from the signed cookie and
 * from nowhere else.
 *
 * THIS IS THE WHOLE ACCESS CONTROL. Every key below is built from this value, so
 * there is no id, query parameter or body field that could reach another wallet's
 * entries. A request for someone else's history is not "rejected" so much as
 * unrepresentable.
 *
 * @returns {{ ok: true, address: string } | { ok: false, response: NextResponse }}
 */
function requireSession(request) {
  if (!isSessionConfigured()) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Wallet sign-in is not configured on this server.", configured: false },
        { status: 503, headers: NO_STORE },
      ),
    };
  }
  const session = readSessionCookie(sessionTokenFromRequest(request));
  if (!session.ok) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Connect a wallet to see saved questions." },
        { status: 401, headers: NO_STORE },
      ),
    };
  }
  return { ok: true, address: session.address };
}

/** Same-origin plus a coarse limit, on both verbs. */
function guard(request, bucket) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Not allowed from this origin." }, { status: 403, headers: NO_STORE });
  }
  if (!rateLimit(`history-${bucket}:${clientIp(request)}`, RATE_LIMIT, RATE_WINDOW_MS).allowed) {
    return NextResponse.json({ error: "Too many requests. Wait a minute." }, { status: 429, headers: NO_STORE });
  }
  return null;
}

/**
 * GET — this wallet's saved questions and answers, newest first.
 *
 * `cap` rides along so the panel can say what happens at the ceiling rather than
 * silently losing the oldest entry: the ring drops the oldest to keep the newest,
 * and a user is entitled to know that before they wonder where last month went.
 */
export async function GET(request) {
  const blocked = guard(request, "read");
  if (blocked) return blocked;

  const session = requireSession(request);
  if (!session.ok) return session.response;

  if (!historyEnabled()) {
    return NextResponse.json(
      { entries: [], cap: 0, enabled: false },
      { status: 200, headers: NO_STORE },
    );
  }

  let store;
  try {
    store = await getStore();
  } catch (e) {
    console.error(`[history] no usable store — ${e?.message ?? e}`);
    // 503, and it says the history could not be READ. An empty list here would be
    // an outage claiming the user never asked anything.
    return NextResponse.json(
      { error: "Saved history is unavailable right now." },
      { status: 503, headers: NO_STORE },
    );
  }

  try {
    const entries = await listHistory({ store, address: session.address });
    return NextResponse.json(
      { entries, cap: historyMaxItems(), enabled: true },
      { status: 200, headers: NO_STORE },
    );
  } catch (e) {
    console.error(`[history] list failed — ${e?.message ?? e}`);
    return NextResponse.json(
      { error: "Saved history is unavailable right now." },
      { status: 503, headers: NO_STORE },
    );
  }
}

/**
 * DELETE — remove one entry (`?id=…`) or all of them (`?all=1`).
 *
 * `all=1` has to be spelled out: a bare DELETE on this path erasing everything is
 * one typo away from a user losing the lot, and the two operations deserve
 * different intent.
 *
 * Deleting an id that is not in THIS wallet's history returns the same `{ deleted:
 * false }` as an id that never existed anywhere — so the response cannot be used
 * to test whether some other wallet asked something.
 */
export async function DELETE(request) {
  const blocked = guard(request, "write");
  if (blocked) return blocked;

  const session = requireSession(request);
  if (!session.ok) return session.response;

  const params = request.nextUrl.searchParams;
  const id = String(params.get("id") ?? "").trim();
  const all = params.get("all") === "1";

  if (!id && !all) {
    return NextResponse.json(
      { error: "Name an entry with ?id=…, or pass ?all=1 to delete everything." },
      { status: 400, headers: NO_STORE },
    );
  }

  let store;
  try {
    store = await getStore();
  } catch (e) {
    console.error(`[history] no usable store — ${e?.message ?? e}`);
    return NextResponse.json(
      { error: "Saved history is unavailable right now." },
      { status: 503, headers: NO_STORE },
    );
  }

  try {
    if (all) {
      await clearHistory({ store, address: session.address });
      return NextResponse.json({ deleted: true, all: true }, { status: 200, headers: NO_STORE });
    }
    const deleted = await deleteHistoryEntry({ store, address: session.address, id });
    return NextResponse.json({ deleted, all: false }, { status: 200, headers: NO_STORE });
  } catch (e) {
    console.error(`[history] delete failed — ${e?.message ?? e}`);
    // A delete that failed must never answer "deleted": the user would stop
    // asking for something that is still there.
    return NextResponse.json(
      { error: "Could not delete that just now. Try again." },
      { status: 503, headers: NO_STORE },
    );
  }
}
