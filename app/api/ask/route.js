import { NextResponse, after } from "next/server";
import { getGeoqApiKey, geoqFetch } from "@/lib/geoq.js";
import { clientIp, isSameOriginRequest, rateLimit } from "@/lib/api-guard.js";
import { quotaDenial, quotaHeaders, resolveAccess } from "@/lib/ask-access.js";
import { publicResearchBlock, researchForAsk } from "@/lib/research-job.js";
import { saveHistoryEntry } from "@/lib/history.js";
import { sessionTokenFromRequest, shortAddress } from "@/lib/session.js";
import { getStore } from "@/lib/store.js";
import { recordSearch } from "@/lib/usage.js";
import { GUIDANCE, runAsk, runAskStream } from "@/lib/ask-runner.js";
import {
  ASK_BUDGET_MS,
  clampTimeout,
  generatorWithBudget,
  runWithBudget,
} from "@/lib/request-budget.js";

/**
 * The platform's kill switch.
 *
 * IT MUST BE A LITERAL. Next reads this by static analysis of the module's
 * segment config, before any import is resolved, so `= MAX_DURATION_S` does not
 * merely fail at runtime — it fails the BUILD outright with `Unknown identifier
 * "MAX_DURATION_S" at "maxDuration"`, and no test catches it because the tests
 * import the module rather than compile it.
 *
 * So the number is written in two places, here and in lib/request-budget.js, and
 * test/request-budget.test.mjs asserts the two agree. That is deliberate: the
 * failure mode being guarded against is the budget drifting to the WRONG SIDE of
 * the kill, and a test that fails loudly on drift buys that safety without the
 * import the compiler forbids. Measured before the budget existed: a memecoin
 * ticker took 49.0s cold and a ticker collision 31.3s against this 30s ceiling,
 * and the platform's answer to both was a 504 that discarded every second of work
 * already done.
 */
export const maxDuration = 60;
export const runtime = "nodejs";

// This route is the GUARD and the ADAPTER, nothing else.
//
// Everything about how a question gets answered — fast path, model routing, the
// keyword fallback, small talk, which status a missed lookup deserves — lives in
// lib/ask-runner.js, because this file imports "next/server" and the "@/" alias
// and so cannot be loaded by `node --test`. What is left here is exactly the
// part that needs a Request: the checks that decide whether any upstream work
// happens at all, and the conversion of the runner's output into a response —
// { status, body } into a NextResponse for a normal request, or a stream of
// events into SSE frames for one that asked for `stream: true`.
//
// The gate matters MORE than it used to. The model-routed path costs one
// completion when the model needs no lookup, two in the normal case — the
// routing turn plus the prose turn — and three at its hard ceiling, against the
// single completion the old keyword path always spent. The limit is unchanged
// because it is a per-question limit and questions are what users send; but a
// permitted question is now worth up to three times as much upstream, which is
// exactly why nothing below runs before the limiter has.
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;

// Input spend is bounded here by question length; the evidence budget and the
// answer's max_tokens are bounded in lib/ask-runner.js and lib/ask-loop.js.
const MAX_QUESTION_CHARS = 500;

/**
 * One /chat/completions round trip — the client lib/ask-runner.js is given.
 *
 * Throws on failure with `status` and `detail` attached, because the tool loop
 * has to tell "this endpoint will not accept a tools request" (degrade to
 * keyword routing, which still works) from "the upstream is down" (a second
 * completion would only fail again more slowly). A transport error carries
 * status 0.
 */
async function completeChat(payload, signal) {
  const res = await postCompletion(payload, signal);
  const body = await res.json().catch(() => null);
  if (!body) {
    const err = new Error("Groq returned a body that was not JSON.");
    err.status = 502;
    throw err;
  }
  return body;
}

/**
 * ONE streamed /chat/completions round trip — the client lib/ask-runner.js is
 * given for the final answer turn.
 *
 * Same failure contract as completeChat (throws with `status`, transport is 0),
 * because a stream that never starts is an ordinary request failure and the
 * runner's fallbacks depend on being able to tell one from the other. On success
 * it resolves to an async iterable of DECODED SSE text: the runner does the
 * framing, this only turns bytes into strings.
 */
async function streamChat(payload, signal) {
  const res = await postCompletion(payload, signal);
  if (!res.body) {
    const err = new Error("Groq returned no response body to stream.");
    err.status = 502;
    throw err;
  }
  return decodedChunks(res.body);
}

/**
 * Upstream deadline for a streamed turn. The same 20s lib/geoq.js gives every
 * other completion — an `init.signal` REPLACES geoqFetch's own timeout, so
 * forwarding the client's abort signal on its own would quietly remove the only
 * thing that stops a stalled upstream from holding the route open until the
 * platform kills it. 700 output tokens arrive in a few seconds; 20s is a stall.
 *
 * Capped by the request's remaining time as well, against its HARD end: this is the
 * turn the answer reserve was held back for, so it may spend the rest of the budget
 * and not a millisecond past it. A stream cut short still delivers every word that
 * arrived — see lib/ask-runner.js streamCompletion — which is the whole point of
 * bounding it here rather than letting the platform do it.
 */
const STREAM_TIMEOUT_MS = 20_000;

/** The caller's abort signal, still carrying geoqFetch's timeout. */
function withDeadline(signal) {
  const deadline = AbortSignal.timeout(clampTimeout(STREAM_TIMEOUT_MS, { hard: true }));
  if (!signal) return deadline;
  // AbortSignal.any landed in Node 20.3. On anything older the client's own
  // signal is the better half to keep — a hung-up client is the common case.
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, deadline]) : signal;
}

/** The POST both clients share, with the HTTP failure contract they both need. */
async function postCompletion(payload, signal) {
  let res;
  try {
    res = await geoqFetch("/chat/completions", {
      method: "POST",
      body: JSON.stringify(payload),
      ...(signal ? { signal: withDeadline(signal) } : {}),
    });
  } catch (e) {
    const err = new Error(String(e?.message ?? e));
    err.status = 0;
    throw err;
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const err = new Error(`Groq ${res.status}`);
    err.status = res.status;
    // NOT 500 CHARACTERS ANY MORE, AND THE REASON IS A MEASUREMENT. A 400 with
    // `tool_use_failed` carries the model's whole tool call in `failed_generation`,
    // and lib/ask-loop.js recoverRefusedToolCalls reads it back out rather than
    // throwing the routing decision away. Measured over 48 real refusals those
    // bodies ran 269–495 characters, so 500 was one long URL away from cutting the
    // call in half and turning a recoverable route into a silent degradation.
    // Nothing downstream renders this to a user — ask-loop re-slices it for its own
    // error field — so the only cost of the wider cap is log volume on a failure.
    err.detail = detail.slice(0, 4_000);
    throw err;
  }
  return res;
}

/**
 * A byte stream as decoded text, in whatever slices arrive.
 *
 * The reader is released in `finally`, which runs on a normal end AND when the
 * consumer abandons the generator — breaking out of a `for await` calls
 * `.return()` on it. That is the only thing standing between a client hanging up
 * mid-answer and a socket left holding a locked reader nobody will ever read.
 *
 * `decoder.decode(value, { stream: true })` matters: a multi-byte character can
 * be split across two network chunks, and decoding each chunk independently would
 * turn any non-ASCII answer — every Spanish or French one — into mojibake.
 */
async function* decodedChunks(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text) yield text;
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed: nothing to release */
    }
  }
}

/** SSE headers. Every one of them is load-bearing; see the comments. */
const SSE_HEADERS = Object.freeze({
  "Content-Type": "text/event-stream; charset=utf-8",
  // no-transform as well as no-store: a transforming proxy is free to buffer a
  // body it thinks it may rewrite, which is exactly what breaks a stream.
  "Cache-Control": "no-store, no-transform",
  Connection: "keep-alive",
  // nginx (and every proxy that copied it) buffers proxied responses by default,
  // which would hold the whole answer back and deliver it in one piece — the very
  // behaviour streaming exists to remove.
  "X-Accel-Buffering": "no",
});

/**
 * The streaming reply: the runner's events as SSE frames.
 *
 * Three things it must not do, each of which has one line here:
 *  - leave the response open after the answer ends (the frame loop always reaches
 *    `controller.close()` through `finally`);
 *  - keep working for a client that has gone (the request's abort signal is
 *    forwarded to the upstream fetch AND breaks the frame loop, which returns the
 *    generator and so cancels the reader beneath it);
 *  - throw. A rejection inside `start` would tear the response down with no
 *    explanation, so the last resort is an `error` frame.
 */
function streamingResponse(req, { question, target, headers = {}, record = null, research = null }) {
  // One controller for the whole request: the client hanging up must cancel the
  // routing completion and the streamed one, not just whichever is in flight.
  const upstream = new AbortController();
  const abort = () => upstream.abort();
  if (req.signal) {
    if (req.signal.aborted) upstream.abort();
    else req.signal.addEventListener("abort", abort, { once: true });
  }

  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      let open = true;
      const send = (frame) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        } catch {
          // The consumer is gone. Stop writing rather than throwing per frame.
          open = false;
        }
      };

      // THE INVESTIGATION FRAME, SENT WHENEVER IT LANDS AND NEVER WAITED FOR.
      //
      // Attached with `.then` rather than awaited because the answer must not be held
      // back by one millisecond for a job that is not part of it — this is the whole
      // "never block the request on the job" rule, expressed in the one place it could
      // be broken. A frame that arrives after the stream has closed is dropped by
      // `send`, which is the right outcome: the job is running either way, and the
      // JSON reply and the report page both still carry it.
      //
      // An older client bundle sitting in somebody's cache ignores a frame type it does
      // not know, so this is safe to send to every version.
      if (research) {
        research
          .then((block) => {
            const payload = publicResearchBlock(block);
            if (payload) send({ type: "research", block: payload });
          })
          .catch(() => {
            /* researchForAsk answers its own failures; nothing to report here */
          });
      }

      // THE BUDGET IS OPENED AROUND THE GENERATOR, NOT AROUND THE CALL THAT MAKES
      // IT. A generator body runs on whoever calls `next()`, so wrapping the
      // construction would attach the deadline for exactly as long as it took to
      // reach the first `yield` and lose it for every second after that — which is
      // all of the seconds that matter. generatorWithBudget re-enters the context
      // per step, so every indexer read, pool probe and completion below inherits
      // the same clock. See lib/request-budget.js.
      const events = generatorWithBudget(() =>
        runAskStream({
          question,
          target,
          chat: (payload) => completeChat(payload, upstream.signal),
          streamChat: (payload) => streamChat(payload, upstream.signal),
          // Say what is being read while it is being read. A ticker question is
          // ~5.6s of measured indexer time, almost all of it before the first word
          // of the answer exists, and `progress` frames are what the transcript
          // shows instead of three dots for those five seconds. Frames the client
          // does not understand are ignored by it, so this is safe to send to an
          // older bundle sitting in someone's cache.
          //
          // AND THEY DO NOT PROTECT THE REQUEST. A progress frame goes out before
          // the lookups start, so the response has genuinely begun — but the
          // platform still kills the invocation at maxDuration, the client sees a
          // stream that ended without a single `delta`, discards the empty bubble
          // and RETRIES on the plain JSON route (components/ask/Conversation.jsx
          // runStream -> "retry"). That retry pays the whole cost again and is the
          // 504 the user actually sees. Streaming buys perceived speed; only the
          // budget above stops the kill.
          progress: true,
        }),
        { totalMs: ASK_BUDGET_MS },
      );

      try {
        for await (const event of events) {
          if (upstream.signal.aborted) break;
          // The saved-history copy is taken from the SAME events the reader gets,
          // as they go past: the answer is assembled by the runner and only the
          // `done` frame holds it whole. Recording it here costs nothing and adds
          // no round trip — the write itself happens after the response, see the
          // `after()` in POST.
          if (record) {
            if (event?.type === "done" && typeof event.answer === "string") record.answer = event.answer;
            else if (event?.type === "meta" && typeof event.intent === "string") record.intent = event.intent;
          }
          send(event);
          if (!open) break;
        }
        if (open && !upstream.signal.aborted) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }
      } catch (e) {
        console.error(`[ask] streaming response failed: ${String(e?.stack ?? e)}`);
        send({ type: "error", error: "Something went wrong answering that. Try again.", status: 500 });
      } finally {
        // Breaking or throwing out of the loop above already returns the
        // generator; this is belt and braces for the paths that did neither.
        try {
          await events.return();
        } catch {
          /* already finished */
        }
        req.signal?.removeEventListener?.("abort", abort);
        open = false;
        try {
          controller.close();
        } catch {
          /* already closed by a cancelling consumer */
        }
      }
    },
    cancel() {
      // The client closed the connection: stop paying Groq for an answer nobody
      // is reading.
      upstream.abort();
    },
  });

  return new Response(body, { status: 200, headers: { ...SSE_HEADERS, ...headers } });
}

/**
 * Write one turn into the asker's saved history.
 *
 * Called from `after()`, which runs once the response has been delivered, so a
 * store write never sits between the answer and the reader. Failures are logged
 * and dropped: history not being saved is a disappointment, not an error worth
 * failing an answer that already arrived over.
 *
 * The address comes from the session resolved at the top of POST — never from the
 * body — so there is no request field that could aim this write at someone else's
 * history.
 */
async function rememberAnswer({ address, question, answer, intent }) {
  if (!address || !String(answer ?? "").trim()) return;
  try {
    const store = await getStore();
    await saveHistoryEntry({ store, address, question, answer, intent });
  } catch (e) {
    console.warn(`[history] save failed for ${shortAddress(address)} — ${String(e?.message ?? e)}`);
  }
}

export async function POST(req) {
  // Requiring a JSON content-type takes the route out of CORS "simple request"
  // territory: a cross-origin page now needs a preflight we never answer.
  if (!String(req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return NextResponse.json(
      { ok: false, error: "Content-Type must be application/json." },
      { status: 415 },
    );
  }

  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ ok: false, error: "Cross-origin requests are not allowed." }, { status: 403 });
  }

  const { allowed } = rateLimit(clientIp(req), RATE_LIMIT, RATE_WINDOW_MS);
  if (!allowed) {
    return NextResponse.json(
      { ok: false, error: `Too many questions — limit is ${RATE_LIMIT} per minute. Try again shortly.` },
      { status: 429 },
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Body must be JSON." }, { status: 400 });
  }

  const question = String(body?.question ?? "").trim();
  if (question.length > MAX_QUESTION_CHARS) {
    return NextResponse.json(
      { ok: false, error: `Question is too long — keep it under ${MAX_QUESTION_CHARS} characters.` },
      { status: 400 },
    );
  }

  // `target` is optional. Most real questions — "what are the top stocks by
  // market cap", "what's trending" — name nothing to look up, and rejecting them
  // for it was the product answering five questions in eight. Only a request
  // carrying neither a question nor a target has nothing to work with.
  const target = String(body?.target ?? "").trim();
  if (!question && !target) {
    return NextResponse.json(
      { ok: false, error: `Ask a question, or provide an address — ${GUIDANCE}.` },
      { status: 400 },
    );
  }

  try {
    getGeoqApiKey(); // fail fast with a clear message if unconfigured
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
  }

  // THE GATE. Last of the guards and first of the costs, in that order on purpose:
  // everything above is free, everything below spends upstream tokens and indexer
  // reads, and a caller who is out of questions must be turned away before any of
  // it. It is also the only guard that can say anything about a WALLET, which is
  // why nothing here is taken from the body — the address comes from the signed
  // cookie and the balance from our own RPC client (see lib/ask-access.js).
  const access = await resolveAccess({
    sessionCookie: sessionTokenFromRequest(req),
    ip: clientIp(req),
  });
  const gateHeaders = quotaHeaders(access.quota);
  if (!access.quota.allowed) {
    // 429 with the STATE in it. "Rate limited" tells someone who would happily
    // connect a wallet nothing they can act on; this says which tier they are in,
    // when it resets, and what would lift it.
    return NextResponse.json(quotaDenial(access), { status: 429, headers: gateHeaders });
  }

  // Usage tracking for the admin page: one record per ACCEPTED question, past the
  // gate so denied and rate-limited attempts never enter it, and after the
  // response so it costs the answer nothing. Failures inside are swallowed.
  after(() => recordSearch({ question, target, ip: clientIp(req), address: access.address }));

  /**
   * A QUESTION THAT WANTS AN INVESTIGATION GETS ONE STARTED, IN PARALLEL WITH THE ANSWER.
   *
   * "Is this a larp", "check this project out properly", "full diligence on X" are asking
   * for something a 24-second budget structurally cannot produce: one page, one pass, no
   * way to decide what to look at next. Answering them inside this request answers a
   * smaller question without saying so. So the chain half is answered here, now, exactly
   * as it always was, and the web half is submitted to the research service as a job the
   * reader collects in minutes.
   *
   * STARTED HERE AND AWAITED WITH THE ANSWER, never before it: `researchForAsk` is one
   * bounded 202 and returns a named block for every failure, including "this deployment
   * has no research service", so the answer's latency is unchanged and no branch of it
   * can fail because of this. It spends a DIFFERENT allowance from the question — see
   * lib/research-access.js — and spends nothing at all when the question was not asking
   * for one.
   */
  const research = researchForAsk({
    question,
    target,
    sessionCookie: sessionTokenFromRequest(req),
    ip: clientIp(req),
  }).catch((e) => {
    // It is written never to throw. If it does, the answer is unaffected and the
    // investigation simply did not start — which is reported as nothing rather than as a
    // failure of the subject.
    console.error(`[research] ask-path submission failed: ${String(e?.stack ?? e)}`);
    return null;
  });

  // Streaming is opt-in and changes nothing above it: every guard has already
  // run, in the same order, with the same limits. A request that does not ask for
  // a stream gets exactly the JSON reply it always got.
  if (body?.stream === true) {
    // Filled by the frame loop as the answer streams past, read by `after()` once
    // the stream has closed. Registered here, in the handler's own scope, because
    // that is where `after` is defined to be callable.
    const record = { answer: "", intent: null };
    if (access.address) {
      after(() =>
        rememberAnswer({
          address: access.address,
          question,
          answer: record.answer,
          intent: record.intent,
        }),
      );
    }
    return streamingResponse(req, { question, target, headers: gateHeaders, record, research });
  }

  // runAsk returns its failures rather than throwing them, so there is nothing
  // left to catch: every outcome is already a { status, body } this can send.
  //
  // Inside the budget, which is what turns "the platform killed us and the client
  // got a bodyless 504" into "here is the answer, with the fields nobody had time
  // to read named as unavailable". This is also the path the client RETRIES on when
  // a streamed attempt dies, so it is the one that must not be able to overrun.
  //
  // The investigation block is awaited ALONGSIDE the answer rather than after it, so the
  // two clocks overlap and the reply is no later than it would have been without it.
  const [{ status, body: payload }, researchBlock] = await Promise.all([
    runWithBudget(() => runAsk({ question, target, chat: completeChat }), { totalMs: ASK_BUDGET_MS }),
    research,
  ]);

  // Attached to whatever the answer turned out to be, including a failure: "your question
  // could not be answered, and a deep investigation of the URL in it is running" is a
  // true and useful pair of sentences.
  const researchPayload = publicResearchBlock(researchBlock);
  if (researchPayload && payload && typeof payload === "object") payload.research = researchPayload;

  // After the response, never before it: a signed-in user's history is worth one
  // store write, and it is not worth a millisecond of the answer's latency.
  if (access.address && payload?.ok) {
    after(() =>
      rememberAnswer({
        address: access.address,
        question,
        answer: payload.answer,
        intent: payload.intent,
      }),
    );
  }

  return NextResponse.json(payload, { status, headers: gateHeaders });
}
