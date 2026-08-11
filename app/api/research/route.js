import { NextResponse } from "next/server";
import { clientIp, isSameOriginRequest, rateLimit } from "@/lib/api-guard.js";
import { publicResearchAccess, resolveResearchAccess } from "@/lib/research-access.js";
import { RESEARCH_JOB, startResearch } from "@/lib/research-job.js";
import { researchConfigured } from "@/lib/research-client.js";
import { sessionTokenFromRequest } from "@/lib/session.js";

/**
 * START A DEEP INVESTIGATION, AND SAY WHAT ONE COSTS.
 *
 * THIS ROUTE IS A GUARD AND AN ADAPTER, nothing else — the same division
 * app/api/ask/route.js keeps. Everything about who may start a job, what a subject is,
 * what happens when the service is down and who may read the result lives in
 * lib/research-job.js, because this file imports "next/server" and the "@/" alias and so
 * cannot be loaded by `node --test`.
 *
 * WHY IT ANSWERS IN MILLISECONDS FOR WORK THAT TAKES MINUTES. There is no honest HTTP
 * shape for a seven-minute request: the platform kills it at 30 seconds (see
 * `maxDuration` in app/api/ask/route.js), a proxy times it out, a client gives up, and
 * each of those discards work that was really done and bandwidth somebody else really
 * paid for. So this returns an id and a poll path, and GET /api/research/<id> is where
 * the report arrives.
 *
 * WHY GET EXISTS ON THIS ROUTE TOO. A button that submits and then fails is a worse
 * product than a button that was never offered. GET answers "can this deployment do this
 * at all, and have you got one left today" without contacting the service and without
 * spending anything, so the UI can render the honest state before anybody presses
 * anything. NOT CONFIGURED IS A STATE, and it is this route's job to say so plainly.
 */

export const maxDuration = 20;
export const runtime = "nodejs";

/**
 * Submissions per minute per caller. Low on purpose: each accepted one is minutes of
 * crawling somebody else's server, and the daily allowance in lib/research-access.js is
 * the real limit — this only stops a loop from hammering the gate itself.
 */
const RATE_LIMIT = 4;
const RATE_WINDOW_MS = 60_000;

/** What this deployment can do, and what this caller has left. Spends nothing. */
export async function GET(req) {
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ ok: false, error: "Cross-origin requests are not allowed." }, { status: 403 });
  }

  const configured = researchConfigured();
  if (!configured) {
    return NextResponse.json(
      {
        ok: true,
        configured: false,
        access: null,
        reading:
          "Deep investigations are not available on this deployment: no research service is configured. That is a fact about THIS INSTALLATION and nothing about any project — every chain lookup is unaffected. See services/research/README.md.",
      },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }

  const access = await resolveResearchAccess({
    sessionCookie: sessionTokenFromRequest(req),
    ip: clientIp(req),
  });

  return NextResponse.json(
    {
      ok: true,
      configured: true,
      access: publicResearchAccess(access),
      reading: access.allowed
        ? "A deep investigation runs for minutes. It reads the site, any repository it finds named in the content, endpoints it is pointed at, and the chain — and reports what it found with a source for every line."
        : access.message,
    },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}

export async function POST(req) {
  // Requiring a JSON content-type takes this route out of CORS "simple request"
  // territory: a cross-origin page now needs a preflight we never answer.
  if (!String(req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return NextResponse.json({ ok: false, error: "Content-Type must be application/json." }, { status: 415 });
  }
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ ok: false, error: "Cross-origin requests are not allowed." }, { status: 403 });
  }

  const { allowed } = rateLimit(`research:${clientIp(req)}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!allowed) {
    return NextResponse.json(
      { ok: false, error: `Too many research submissions — limit is ${RATE_LIMIT} per minute.` },
      { status: 429 },
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Body must be JSON." }, { status: 400 });
  }

  const started = await startResearch({
    subject: String(body?.subject ?? ""),
    sessionCookie: sessionTokenFromRequest(req),
    ip: clientIp(req),
  });

  return NextResponse.json(
    {
      ok: started.state === RESEARCH_JOB.STARTED || started.state === RESEARCH_JOB.DEDUPED,
      state: started.state,
      reading: started.reading,
      id: started.id,
      pollPath: started.pollPath,
      reportPath: started.reportPath,
      subject: started.subject,
      wallMs: started.wallMs ?? null,
      access: started.access,
      ...(started.warning ? { warning: started.warning } : {}),
    },
    { status: statusFor(started.state), headers: { "cache-control": "no-store" } },
  );
}

/**
 * The HTTP status for each outcome.
 *
 * 202 rather than 200 for a started job, because nothing has been produced yet and the
 * caller must go somewhere else for the result. The refusals are split apart rather than
 * collapsed into 400: a client has to be able to tell "sign in" from "you have used
 * today's" from "this server cannot do that at all", and a single status for all three
 * would send every one of them to the same dead end.
 */
function statusFor(state) {
  switch (state) {
    case RESEARCH_JOB.STARTED:
    case RESEARCH_JOB.DEDUPED:
      return 202;
    case RESEARCH_JOB.NEEDS_SIGN_IN:
      return 401;
    case RESEARCH_JOB.OUT_OF_ALLOWANCE:
      return 429;
    case RESEARCH_JOB.DISABLED:
    case RESEARCH_JOB.NOT_CONFIGURED:
      // 501: this installation does not implement it. Not the caller's fault and not
      // something a retry fixes.
      return 501;
    case RESEARCH_JOB.REFUSED_SUBJECT:
      return 400;
    case RESEARCH_JOB.AT_CAPACITY:
      return 503;
    default:
      return 502;
  }
}
