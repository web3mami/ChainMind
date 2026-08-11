import { NextResponse } from "next/server";
import { clientIp, isSameOriginRequest, rateLimit } from "@/lib/api-guard.js";
import { RESEARCH_JOB, readResearch } from "@/lib/research-job.js";
import { viewJob, viewReport } from "@/lib/research-view.js";
import { sessionTokenFromRequest } from "@/lib/session.js";

/**
 * POLL ONE INVESTIGATION, AND COLLECT ITS REPORT.
 *
 * A GUARD AND AN ADAPTER. The ownership check, the poll and every named failure are
 * lib/research-job.js; the arrangement of a report for reading is lib/research-view.js;
 * what is left here is the part that needs a Request.
 *
 * WHY THE VIEW IS BUILT SERVER-SIDE AND NOT IN THE COMPONENT. The three rules this
 * feature can most easily break — missing is not zero, an outage is not an absence, a
 * bound is not exact — are all decided at the moment a report becomes something a person
 * reads. Deciding them in a module `node --test` can load is the only way they are
 * actually held. See lib/research-view.js.
 *
 * POLLING IS NOT METERED. A daily allowance buys the investigation; charging somebody
 * again for looking at the result they already paid for would be a limit that only
 * punishes the person waiting. The per-minute limiter below is what stops a poll loop
 * from becoming a hammer.
 */

export const maxDuration = 20;
export const runtime = "nodejs";

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

export async function GET(req, { params }) {
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ ok: false, error: "Cross-origin requests are not allowed." }, { status: 403 });
  }

  const { allowed } = rateLimit(`research-poll:${clientIp(req)}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!allowed) {
    return NextResponse.json(
      { ok: false, error: "Too many polls — slow down. The job is unaffected by this and is still running." },
      { status: 429 },
    );
  }

  // Next 15 hands route params in as a promise.
  const resolved = await params;
  const id = String(resolved?.id ?? "");

  const got = await readResearch({
    id,
    sessionCookie: sessionTokenFromRequest(req),
  });

  const job = got.job ?? null;
  const status = job?.state ?? got.state;

  return NextResponse.json(
    {
      ok: got.state === "job",
      state: got.state,
      reading: got.reading,
      /** The header the page renders from: label, tone, and whether to keep polling. */
      job: viewJob(job ? { ...job, status: job.state } : { state: got.state, terminal: got.terminal, reading: got.reading }),
      /**
       * THE REPORT TRAVELS ON A FAILED OR ABANDONED JOB TOO, with the status beside it —
       * evidence that was really gathered is not thrown away because the run did not
       * finish, and the status is what stops it being read as complete.
       */
      report: job ? viewReport(job.report, { status: job.state }) : null,
    },
    { status: statusFor(got.state), headers: { "cache-control": "no-store" } },
  );
}

function statusFor(state) {
  switch (state) {
    case "job":
      return 200;
    case RESEARCH_JOB.NEEDS_SIGN_IN:
      return 401;
    case RESEARCH_JOB.NOT_YOURS:
      return 404;
    case RESEARCH_JOB.NOT_CONFIGURED:
      return 501;
    default:
      // The service did not answer. NOT a 404 and not a 500: the job may well still be
      // running, and the client is told to keep polling rather than to give up.
      return 503;
  }
}
