// Tests for the whole /api/ask pipeline (lib/ask-runner.js), one layer above
// test/ask-loop.test.mjs.
//
// ask-loop.test.mjs proves the LOOP behaves — rounds capped, junk coerced,
// evidence budgeted. This file proves the REQUEST behaves: what a caller gets
// back, with which status, from a question a real user would type. That is the
// part app/api/ask/route.js used to own and that nothing could test, because the
// route imports "next/server" and `node --test` cannot load it.
//
// What is real here and what is not, stated plainly because it matters:
//
//  - REAL: the pipeline (fast path vs model routing vs keyword fallback), the
//    prompt assembly, the tool-call transcript, the evidence budget, the status
//    codes, and — in the last two tests — the real lib/ask-tools.js dispatcher
//    with its argument coercion.
//  - FAKE: the model and the chain. `chat` is a scripted function with the
//    upstream's contract (takes a payload, resolves to a parsed body, throws
//    with `status`), and the gatherers are stubs. There is no GROQ_API_KEY in
//    this environment and none is needed.
//  - NOT COVERED BY ANYTHING HERE: whether a real model actually picks the right
//    tool for "hows nvda doin". That needs a live key. These tests prove the
//    machinery around that decision is correct and cannot crash; they cannot
//    prove the decision itself.
//
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { INTENTS } from "../lib/ask-intent.js";
import { BUDGET_EXHAUSTED_RESULT, MAX_EVIDENCE_CHARS } from "../lib/ask-loop.js";
import {
  GUIDANCE,
  MISSING_INFO_GUIDANCE,
  OFF_CHAIN_BRIEF,
  SMALL_TALK_FALLBACK,
  SYSTEM_PROMPT,
  runAsk,
} from "../lib/ask-runner.js";

const ADDRESS = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const TX_HASH = `0x${"ab".repeat(32)}`;
const MODEL = "test-model";

/* ------------------------------ the fake model ------------------------------ */

/** An assistant turn that asks for tools, in the exact shape Groq returns. */
function toolTurn(calls, content = null) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content,
          tool_calls: calls.map((c, i) => ({
            id: c.id ?? `call_${i}`,
            type: "function",
            // `arguments` is a JSON STRING on the wire, never an object — a
            // malformed one is a string that will not parse, not a bad object.
            function: { name: c.name, arguments: c.arguments ?? JSON.stringify(c.args ?? {}) },
          })),
        },
      },
    ],
  };
}

/** An assistant turn that answers. */
function proseTurn(content) {
  return { choices: [{ message: { role: "assistant", content } }] };
}

/** An assistant turn with nothing in it at all — no call, no text. */
function emptyTurn() {
  return { choices: [{ message: { role: "assistant", content: null } }] };
}

/**
 * A `chat` with the upstream's contract: takes the request payload, resolves to
 * the parsed body, throws with `status` on failure. Records every payload, which
 * is what proves the transcript stayed well formed and that tools were offered
 * (or withheld) when they should have been.
 */
function scriptedChat(turns) {
  const payloads = [];
  const chat = async (payload) => {
    payloads.push(payload);
    const turn = turns[payloads.length - 1];
    if (!turn) throw new Error(`no scripted turn ${payloads.length}`);
    if (turn instanceof Error) throw turn;
    return typeof turn === "function" ? turn(payload) : turn;
  };
  return { chat, payloads };
}

/** An upstream failure carrying the status the loop reads. */
function upstream(status, message, detail) {
  const err = new Error(message);
  err.status = status;
  if (detail) err.detail = detail;
  return err;
}

/** A `dispatch` that records calls and returns canned tool results. */
function recorder(results = {}) {
  const calls = [];
  const dispatch = async (name, args) => {
    calls.push({ name, args });
    const canned = results[name];
    if (typeof canned === "function") return await canned(args);
    return canned ?? { ok: true, kind: "token", target: "NVDA", evidence: { symbol: "NVDA" } };
  };
  return { dispatch, calls };
}

/** Every tool message in a completion payload, in order. */
function toolMessages(payload) {
  return payload.messages.filter((m) => m.role === "tool");
}

/* ------------------------------ the fast path ------------------------------ */

test("a pasted address skips the routing turn and spends one completion", async () => {
  const { chat, payloads } = scriptedChat([proseTurn("That wallet holds 2 ETH.")]);
  const gathered = [];
  const res = await runAsk({
    question: ADDRESS,
    chat,
    model: MODEL,
    deps: {
      gatherEvidence: async (t) => {
        gathered.push(t);
        return { ok: true, kind: "address", target: ADDRESS, evidence: { balance: "2" } };
      },
      dispatch: async () => assert.fail("the fast path must not reach the tool loop"),
    },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.intent, INTENTS.EXPLAIN_TARGET);
  assert.equal(res.body.answer, "That wallet holds 2 ETH.");
  assert.deepEqual(res.body.toolCalls, [{ name: "lookup_wallet", args: { address: ADDRESS } }]);
  assert.deepEqual(gathered, [ADDRESS]);
  assert.equal(payloads.length, 1, "one completion, exactly as before the tool path existed");
  assert.equal(payloads[0].tools, undefined, "the fast path offers no tools — the lookup already happened");
});

test("a fast-path lookup that finds nothing is a 404, not a 500", async () => {
  const { chat, payloads } = scriptedChat([]);
  const res = await runAsk({
    question: `what happened in ${TX_HASH}`,
    chat,
    model: MODEL,
    deps: { gatherEvidence: async () => ({ ok: false, kind: "not_found", error: "No such transaction." }) },
  });

  assert.equal(res.status, 404);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, "No such transaction.");
  assert.equal(payloads.length, 0, "nothing to say means no completion is paid for");
});

test("an indexer outage on the fast path is a retryable 503", async () => {
  const { chat } = scriptedChat([]);
  const res = await runAsk({
    question: ADDRESS,
    chat,
    model: MODEL,
    deps: {
      gatherEvidence: async () => {
        throw new Error("blockscout timed out");
      },
    },
  });

  assert.equal(res.status, 503);
  assert.match(res.body.error, /Could not read chain data: blockscout timed out/);
});

/* ------------------------------ model routing ------------------------------ */

test("one tool call, then the answer: two completions and the evidence comes back", async () => {
  const { chat, payloads } = scriptedChat([
    toolTurn([{ id: "a", name: "lookup_token", args: { query: "apple" } }]),
    proseTurn("Apple (AAPL) trades at $214.10."),
  ]);
  const { dispatch, calls } = recorder({
    lookup_token: { ok: true, kind: "token", target: "AAPL", evidence: { symbol: "AAPL", price: 214.1 } },
  });

  const res = await runAsk({ question: "i wanna know about apple", chat, model: MODEL, deps: { dispatch } });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.answer, "Apple (AAPL) trades at $214.10.");
  assert.equal(res.body.intent, INTENTS.EXPLAIN_TARGET);
  assert.equal(res.body.kind, "token");
  assert.equal(res.body.target, "AAPL");
  assert.deepEqual(res.body.evidence, { symbol: "AAPL", price: 214.1 });
  assert.deepEqual(res.body.toolCalls, [{ name: "lookup_token", args: { query: "apple" } }]);
  assert.equal(res.body.model, MODEL);

  // The argument reached the tool exactly as the model wrote it: lowercase and a
  // company name, because resolveSymbol is what normalizes, not the router.
  assert.deepEqual(calls, [{ name: "lookup_token", args: { query: "apple" } }]);

  assert.equal(payloads.length, 2);
  assert.ok(payloads[0].tools?.length, "the routing turn offers the catalogue");
  const [toolMsg] = toolMessages(payloads[1]);
  assert.match(toolMsg.content, /"AAPL"/, "the result is handed back for the prose turn");
});

// The timeout is load-bearing: a sequential dispatcher would deadlock on the
// barrier below rather than fail, and a hung test is a stalled CI job.
test("two tool calls in one turn are dispatched in parallel and keyed by tool name", { timeout: 5_000 }, async () => {
  // Both dispatches must be IN FLIGHT at once, so neither can resolve until the
  // other has started. A sequential dispatcher deadlocks here instead of passing
  // slowly, which is the only way to prove concurrency rather than assume it.
  let entered = 0;
  let release;
  const bothStarted = new Promise((r) => {
    release = r;
  });
  const barrier = async (result) => {
    entered += 1;
    if (entered === 2) release();
    await bothStarted;
    return result;
  };

  const { chat, payloads } = scriptedChat([
    toolTurn([
      { id: "a", name: "compare_tokens", args: { queries: ["tsla", "nvda"] } },
      { id: "b", name: "safety_check", args: { target: "nvda" } },
    ]),
    proseTurn("NVDA is bigger, and the contract you asked about is the official one."),
  ]);
  const { dispatch, calls } = recorder({
    compare_tokens: () => barrier({ ok: true, kind: "comparison", evidence: { entries: ["TSLA", "NVDA"] } }),
    safety_check: () => barrier({ ok: true, kind: "safety", evidence: { verdict: "official" } }),
  });

  const res = await runAsk({
    question: "tsla vs nvda which is better, and are they legit?",
    chat,
    model: MODEL,
    deps: { dispatch },
  });

  assert.equal(entered, 2, "both tools must have been entered before either returned");
  assert.equal(calls.length, 2);
  assert.equal(res.status, 200);
  // Two different tools is not one of the six intents, and saying so beats
  // labelling half the evidence wrong.
  assert.equal(res.body.intent, "multi_lookup");
  assert.equal(res.body.kind, "multi");
  assert.deepEqual(res.body.evidence, {
    compare_tokens: { entries: ["TSLA", "NVDA"] },
    safety_check: { verdict: "official" },
  });
  assert.deepEqual(res.body.toolCalls, [
    { name: "compare_tokens", args: { queries: ["tsla", "nvda"] } },
    { name: "safety_check", args: { target: "nvda" } },
  ]);
  assert.equal(toolMessages(payloads[1]).length, 2, "one tool message per tool_call_id, or the next call 400s");
});

test("arguments that are not valid JSON produce a readable error, never a crash", async () => {
  const { chat, payloads } = scriptedChat([
    // A truncated arguments string — what a model emits when it runs out of
    // tokens mid-call. It is a string on the wire, so nothing type-checks it.
    toolTurn([{ id: "a", name: "lookup_token", arguments: '{"query": "nvd' }]),
    toolTurn([{ id: "b", name: "lookup_token", args: { query: "nvda" } }]),
    proseTurn("NVDA is at $206.85."),
  ]);
  const { dispatch, calls } = recorder({
    lookup_token: { ok: true, kind: "token", target: "NVDA", evidence: { symbol: "NVDA" } },
  });

  const res = await runAsk({ question: "hows nvda doin", chat, model: MODEL, deps: { dispatch } });

  // The broken call is never dispatched — a guessed argument would answer a
  // question the user did not ask.
  assert.deepEqual(calls, [{ name: "lookup_token", args: { query: "nvda" } }]);

  const [failed] = toolMessages(payloads[1]);
  assert.match(failed.content, /not valid JSON/, "the model is told what was wrong");
  assert.match(failed.content, /Call it again/, "and what to do about it");

  // And the recovery actually worked: the retry ran and the answer stands.
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.answer, "NVDA is at $206.85.");
  assert.deepEqual(res.body.toolCalls, [
    { name: "lookup_token", args: null },
    { name: "lookup_token", args: { query: "nvda" } },
  ]);
});

test("a reply with neither a tool call nor any text falls back to keyword routing", async () => {
  // The signature of a model that ignored `tools` entirely. It must not become a
  // 500: the keyword router still answers everything it ever answered.
  const { chat, payloads } = scriptedChat([emptyTurn(), proseTurn("The three biggest are NVDA, TSLA and AAPL.")]);
  const ranked = [];
  const res = await runAsk({
    question: "top 3 stocks by market cap",
    chat,
    model: MODEL,
    deps: {
      rankStocks: async (args) => {
        ranked.push(args);
        return { ok: true, kind: "ranking", evidence: { rows: [{ symbol: "NVDA" }] } };
      },
      dispatch: async () => assert.fail("no tool call was made, so nothing may be dispatched"),
    },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.intent, INTENTS.RANK_STOCKS);
  assert.equal(res.body.answer, "The three biggest are NVDA, TSLA and AAPL.");
  assert.deepEqual(ranked, [{ metric: "marketCap", direction: "desc", limit: 3 }]);
  assert.equal(payloads.length, 2, "the routing turn, then the fallback's single-shot turn");
  assert.equal(payloads[1].tools, undefined, "the fallback path never offers tools");
});

test("a silent model on a question the keyword router cannot route is ANSWERED, not rejected", async () => {
  // WHAT THIS TEST USED TO ASSERT, AND WHY IT CHANGED. It asserted a 400 whose
  // body was `I couldn't tell what to look up. Try ${GUIDANCE}.` — the same
  // sentence for every unroutable question, which is the defect this path now
  // exists to fix. "hows nvda doin" is exactly what the keyword router gets
  // wrong, so falling back to it still cannot ROUTE this; what it can do is
  // answer it. The floor of the degraded path is now a reply, not a rejection.
  const { chat, payloads } = scriptedChat([
    emptyTurn(),
    proseTurn("Sounds like you want NVDA — send it over and I'll pull the token."),
  ]);
  const res = await runAsk({ question: "hows nvda doin", chat, model: MODEL, deps: { dispatch: async () => ({ ok: true }) } });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.intent, INTENTS.CONVERSATION);
  assert.equal(res.body.answer, "Sounds like you want NVDA — send it over and I'll pull the token.");
  assert.equal(res.body.evidence, null, "nothing was looked up, so no evidence card may render");
  assert.deepEqual(res.body.toolCalls, []);
  assert.equal(payloads[1].tools, undefined, "the conversational turn is never offered tools");
  assert.ok(
    !JSON.stringify(payloads[1].messages).includes("I couldn't tell what to look up"),
    "the template is gone from the path entirely, not merely unreachable",
  );
});

test("the guidance template is no longer any answer's text", async () => {
  // GUIDANCE still exists — app/api/ask/route.js quotes it for an EMPTY request,
  // which is a genuine client error and the one place a syntax hint belongs.
  // What must never come back is that string as the answer to a question someone
  // actually asked. Two questions, and the reply must differ between them.
  // Both are intercepted before routing and spend their one completion on the
  // conversational turn. See test/ask-conversation.test.mjs for why each one is.
  const rugged = await runAsk({
    question: "I got rugged",
    chat: scriptedChat([proseTurn("Send me the contract and I'll show you who held it and who sold.")]).chat,
    model: MODEL,
    deps: { dispatch: async () => assert.fail("nothing was named, so nothing may be dispatched") },
  });
  const solana = await runAsk({
    question: "Which wallet bought catecoin on Solana 2hrs ago",
    chat: scriptedChat([proseTurn("I read Robinhood Chain only, so Solana is outside what I can see.")]).chat,
    model: MODEL,
    deps: { dispatch: async () => assert.fail("a Solana question must not reach a lookup") },
  });

  for (const res of [rugged, solana]) {
    assert.equal(res.status, 200);
    assert.ok(!String(res.body.answer).includes(GUIDANCE), "the template is never the answer");
  }
  assert.notEqual(rugged.body.answer, solana.body.answer, "two different questions, two different replies");
});

test("a model that keeps asking for tools still terminates with an answer", async () => {
  // Every turn asks for another lookup AND carries prose. The cap has to be
  // enforced on our side: after two rounds the completion is sent with no
  // `tools` key at all, so the third reply can only be the answer.
  let turns = 0;
  const chat = async (payload) => {
    turns += 1;
    if (turns > 6) throw new Error("the loop did not terminate");
    return toolTurn(
      [{ id: `c${turns}`, name: "market_overview", args: {} }],
      `Round ${turns}: here is the market.`,
    );
  };
  const { dispatch, calls } = recorder({ market_overview: { ok: true, kind: "overview", evidence: { count: 94 } } });

  const res = await runAsk({ question: "show me whats poppin", chat, model: MODEL, deps: { dispatch } });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.answer, "Round 3: here is the market.");
  assert.equal(turns, 3, "two tool rounds plus the tools-free answering turn — never more");
  assert.equal(calls.length, 2, "the third turn's tool call is ignored, because no tools were offered");
  assert.equal(res.body.intent, INTENTS.MARKET_OVERVIEW);
});

test("tool results across a whole conversation fit one shared 24k budget", async () => {
  // Four fat results over two rounds. The cap is on the CONVERSATION, not on each
  // result — three tools each granted the full budget is three times the spend,
  // and the model only ever sees one prompt.
  const fat = (tag) => ({
    ok: true,
    kind: "token",
    target: tag,
    evidence: { symbol: tag, blob: `${tag}:`.repeat(4_000) },
  });
  const { chat, payloads } = scriptedChat([
    toolTurn([
      { id: "a", name: "lookup_token", args: { query: "nvda" } },
      { id: "b", name: "lookup_token", args: { query: "tsla" } },
    ]),
    toolTurn([
      { id: "c", name: "lookup_token", args: { query: "aapl" } },
      { id: "d", name: "lookup_token", args: { query: "spy" } },
    ]),
    proseTurn("Here are all four."),
  ]);
  const dispatch = async (_name, args) => fat(String(args.query).toUpperCase());

  const res = await runAsk({
    question: "compare nvda tsla aapl and spy",
    chat,
    model: MODEL,
    deps: { dispatch },
  });

  assert.equal(res.status, 200);
  // The last payload carries the whole transcript, which is the prompt whose size
  // is actually being paid for.
  const sent = toolMessages(payloads[2]);
  assert.equal(sent.length, 4, "every tool_call_id is answered even when the budget is gone");

  // The cap bounds EVIDENCE. A slot the budget can no longer fit carries a fixed
  // notice rather than an empty message, and those notices are not evidence, so
  // they are counted out before the budget is checked.
  const notices = sent.filter((m) => m.content === BUDGET_EXHAUSTED_RESULT);
  const evidenceChars = sent.reduce((n, m) => n + m.content.length, 0) - notices.length * BUDGET_EXHAUSTED_RESULT.length;
  assert.ok(
    evidenceChars <= MAX_EVIDENCE_CHARS,
    `tool evidence totalled ${evidenceChars}, over the ${MAX_EVIDENCE_CHARS} budget`,
  );
  // Round 1 spent the budget, so round 2's results are the ones that say so —
  // and no result is silently a lie: whatever was cut short says it was.
  assert.equal(notices.length, 2, "a spent budget must not hand the next round a fresh one");
  const cut = sent.filter((m) => m.content.includes("truncated: evidence too large"));
  assert.ok(cut.length >= 1, "a shortened result must be marked as shortened");
  for (const m of sent) assert.ok(m.content.length > 0, "an empty tool message is rejected by the API");
  // The full evidence still reaches the CLIENT — the budget is a prompt budget.
  assert.equal(Object.keys(res.body.evidence).length, 4);
});

/* ------------------------------ upstream failure ------------------------------ */

test("an endpoint that rejects the tools request degrades instead of failing", async () => {
  // A 400 mentioning tools is a rejected request SHAPE, and the same prompt
  // without `tools` is very likely to work — so it is worth another completion.
  const { chat, payloads } = scriptedChat([
    upstream(400, "Groq 400", "tool_choice is not supported for this model"),
    proseTurn("NVDA and TSLA, compared."),
  ]);
  const res = await runAsk({
    question: "compare NVDA and TSLA",
    chat,
    model: MODEL,
    deps: {
      compareTargets: async (list) => ({ ok: true, kind: "comparison", evidence: { asked: list } }),
      dispatch: async () => assert.fail("the tools request never succeeded"),
    },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.intent, INTENTS.COMPARE);
  assert.equal(res.body.answer, "NVDA and TSLA, compared.");
  assert.deepEqual(res.body.evidence, { asked: ["NVDA", "TSLA"] });
  assert.equal(payloads.length, 2);
});

test("an outage is a 502 and is never retried as a fallback", async () => {
  // Retrying a 500 only doubles the latency of the same failure.
  const { chat, payloads } = scriptedChat([upstream(500, "Groq 500", "upstream is down")]);
  const res = await runAsk({
    question: "whos got the most bags",
    chat,
    model: MODEL,
    deps: { dispatch: async () => assert.fail("no tool call was made") },
  });

  assert.equal(res.status, 502);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, "Groq 500");
  assert.equal(res.body.detail, "upstream is down");
  assert.equal(payloads.length, 1, "one failed completion, not two");
});

test("runAsk needs a client and says so", async () => {
  await assert.rejects(() => runAsk({ question: "nvda" }), /requires a chat\(payload\) client/);
});

/* ------------------------------ the measured failure ------------------------------ */

test("the question that compared nothing now compares two things, through the real dispatcher", async () => {
  // "tsla vs nvda which is better" is the worst of the 16 measured failures: the
  // keyword router classified it as a comparison and then extracted ZERO targets,
  // because a bare ticker has to be uppercase to survive the stopword guard — so
  // it would have compared nothing and said so confidently.
  //
  // No `dispatch` override here: the real lib/ask-tools.js runs, coercion and
  // all. Only the chain itself is stubbed.
  const { chat } = scriptedChat([
    // The model is also allowed to get the shape wrong: this sends the whole
    // comparison as ONE string where an array belongs, which coercion splits.
    toolTurn([{ id: "a", name: "compare_tokens", args: { queries: "tsla vs nvda" } }]),
    proseTurn("NVDA is the larger of the two."),
  ]);
  const asked = [];
  const res = await runAsk({
    question: "tsla vs nvda which is better",
    chat,
    model: MODEL,
    deps: {
      dispatch: (name, args) =>
        import("../lib/ask-tools.js").then((m) =>
          m.dispatchTool(name, args, {
            compareTargets: async (queries) => {
              asked.push(queries);
              return { ok: true, kind: "comparison", evidence: { entries: queries.map((q) => ({ query: q })) } };
            },
          }),
        ),
    },
  });

  assert.deepEqual(asked, [["tsla", "nvda"]], "two lowercase targets, in the order the user said them");
  assert.equal(res.status, 200);
  assert.equal(res.body.intent, INTENTS.COMPARE);
  assert.equal(res.body.evidence.entries.length, 2);
});

test("a company name reaches the resolver untouched, through the real dispatcher", async () => {
  // The other half of the claim: extraction was the bottleneck, resolution was
  // never broken. Once the model passes "apple" as an argument, the existing
  // lib/stock-tokens.js path takes it from there.
  const { chat } = scriptedChat([
    toolTurn([{ id: "a", name: "lookup_token", args: { query: "apple" } }]),
    proseTurn("Apple's tokenized share (AAPL) is on the chain."),
  ]);
  const seen = [];
  const res = await runAsk({
    question: "i wanna know about apple",
    chat,
    model: MODEL,
    deps: {
      dispatch: (name, args) =>
        import("../lib/ask-tools.js").then((m) =>
          m.dispatchTool(name, args, {
            gatherEvidence: async (handle) => {
              seen.push(handle);
              return { ok: true, kind: "token", target: "AAPL", evidence: { symbol: "AAPL" } };
            },
          }),
        ),
    },
  });

  // "apple" is ticker-shaped (one word, no separators), so it goes straight to
  // gatherEvidence, which resolves it — no cleanup happened on the way.
  assert.deepEqual(seen, ["apple"]);
  assert.equal(res.status, 200);
  assert.equal(res.body.target, "AAPL");
});

/* ------------------------------ small talk ------------------------------ */

// Measured live before this branch existed: "hello" and "hi" both fired the
// market_overview tool and came back with a summary of the tokenized-equity
// market. A greeting answered with a table is the single most robotic thing the
// product did, and it also spent a tool round trip and an indexer fan-out on one
// word. These tests pin the JSON path; test/ask-stream.test.mjs pins the streamed
// one and isSmallTalk itself.

test("a greeting is answered socially, with no tool call and no chain lookup", async () => {
  const { chat, payloads } = scriptedChat([proseTurn("Hey! Ask me about a ticker like NVDA.")]);
  const forbidden = async () => assert.fail("small talk must not reach the chain");

  const res = await runAsk({
    question: "hello",
    chat,
    model: MODEL,
    deps: {
      gatherEvidence: forbidden,
      marketOverview: forbidden,
      rankStocks: forbidden,
      compareTargets: forbidden,
      safetyReport: forbidden,
      dispatch: forbidden,
    },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.intent, "small_talk", "the client labels the turn with this");
  assert.equal(res.body.intent, INTENTS.SMALL_TALK);
  assert.equal(res.body.answer, "Hey! Ask me about a ticker like NVDA.");
  assert.equal(res.body.evidence, null, "nothing was looked up, so there is no evidence card");
  assert.deepEqual(res.body.toolCalls, []);

  // One completion, and no `tools` on it: a greeting cannot cost a tool round trip.
  assert.equal(payloads.length, 1);
  assert.equal("tools" in payloads[0], false);
});

test("a greeting still gets a warm answer when the model is down", async () => {
  const { chat } = scriptedChat([upstream(503, "Groq 503")]);
  const res = await runAsk({ question: "gm", chat, model: MODEL });

  // The one question in the product that needs no upstream at all. A 502 in reply
  // to "gm" would be absurd, so it degrades to the fixed sentence.
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.answer, SMALL_TALK_FALLBACK);
});

test("a greeting that also names a subject is routed as the question it is", async () => {
  const { chat, payloads } = scriptedChat([
    toolTurn([{ id: "a", name: "lookup_token", args: { query: "nvda" } }]),
    proseTurn("NVDA trades at $206.71."),
  ]);
  const { dispatch, calls } = recorder({
    lookup_token: { ok: true, kind: "token", target: "NVDA", evidence: { symbol: "NVDA" } },
  });

  const res = await runAsk({ question: "hi, what is nvda", chat, model: MODEL, deps: { dispatch } });

  assert.equal(res.status, 200);
  assert.equal(res.body.intent, INTENTS.EXPLAIN_TARGET);
  assert.deepEqual(calls, [{ name: "lookup_token", args: { query: "nvda" } }]);
  assert.equal(payloads.length, 2, "the greeting did not short-circuit the lookup");
});

test("an explicit target keeps even a chatty question on the lookup path", async () => {
  const { chat } = scriptedChat([proseTurn("That wallet holds 2 ETH.")]);
  const gathered = [];
  // The interface has something in view, so "hi" about it is about that thing.
  const res = await runAsk({
    question: "hi",
    target: ADDRESS,
    chat,
    model: MODEL,
    deps: {
      gatherEvidence: async (t) => {
        gathered.push(t);
        return { ok: true, kind: "address", target: ADDRESS, evidence: { balance: "2" } };
      },
    },
  });

  assert.deepEqual(gathered, [ADDRESS]);
  assert.equal(res.body.intent, INTENTS.EXPLAIN_TARGET);
});

/* --------------------------- off-chain knowledge --------------------------- */

// Reported by a user testing the live site, verbatim: "AI still needs work too /
// This is a very basic question". The question was "who is the founder?", it was
// routed to market_overview, and the answer was "The founder of Robinhood Chain
// is not specified in the provided market overview". The follow-up, "who is the
// co founder?", got "cannot be answered with the available tools".
//
// Neither has an on-chain answer — founders are not a field a block carries —
// and inventing one would be far worse than admitting it. So two things change,
// and these tests pin both: WHERE the question goes (never to a market tool) and
// HOW the gap is worded (never in the vocabulary of the plumbing).

test("a question about the founder never reaches a market lookup", async () => {
  const { chat, payloads } = scriptedChat([
    proseTurn("I read Robinhood Chain itself, and who founded it isn't recorded on it."),
  ]);
  const forbidden = async () => assert.fail("a question about people must not reach the chain");

  const res = await runAsk({
    question: "who is the founder?",
    chat,
    model: MODEL,
    deps: {
      gatherEvidence: forbidden,
      marketOverview: forbidden,
      rankStocks: forbidden,
      compareTargets: forbidden,
      safetyReport: forbidden,
      dispatch: forbidden,
    },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.intent, INTENTS.EXPLAIN_CHAIN);
  assert.equal(res.body.kind, "chain");
  assert.deepEqual(res.body.toolCalls, [], "nothing was looked up, and nothing claims to have been");

  // One completion, with no tools on it at all: the model never gets the chance
  // to route a question about a person to market_overview.
  assert.equal(payloads.length, 1);
  assert.equal("tools" in payloads[0], false);

  // The factsheet is what it answers from, and the factsheet says outright that
  // this is off-chain rather than leaving the model to work it out.
  assert.equal(typeof res.body.evidence.notOnChain, "string");
  assert.equal(res.body.evidence.chainId, 4663);
});

test("the co-founder follow-up takes the same path, not a different one", async () => {
  const { chat } = scriptedChat([proseTurn("Same answer: that's off-chain.")]);
  const res = await runAsk({
    question: "who is the co founder?",
    chat,
    model: MODEL,
    deps: { dispatch: async () => assert.fail("no tool call for a question about people") },
  });

  assert.equal(res.body.intent, INTENTS.EXPLAIN_CHAIN);
  assert.deepEqual(res.body.toolCalls, []);
});

test("the off-chain brief tells the model to answer, not to recite the factsheet", async () => {
  const { chat, payloads } = scriptedChat([proseTurn("That's not on-chain.")]);
  await runAsk({ question: "who is behind this?", chat, model: MODEL });

  const user = payloads[0].messages.at(-1).content;
  assert.ok(user.includes(OFF_CHAIN_BRIEF), "the brief for this case, not the generic chain one");
  assert.ok(user.includes("who is behind this?"), "the question is still quoted verbatim");
});

test("the missing-information guidance never speaks in the vocabulary of the plumbing", () => {
  // The exact sentences the user was shown came from this vocabulary. A reader
  // does not know what a tool or an evidence block is and must not find out from
  // a failure, so none of these words may appear in the guidance that produces
  // the answer for a question we cannot answer.
  for (const phrase of ["available tools", "provided market overview", "evidence"]) {
    assert.equal(
      MISSING_INFO_GUIDANCE.toLowerCase().includes(phrase),
      false,
      `"${phrase}" must not appear in the missing-information guidance`,
    );
    assert.equal(
      OFF_CHAIN_BRIEF.toLowerCase().includes(phrase),
      false,
      `"${phrase}" must not appear in the off-chain brief`,
    );
  }

  // And it is actually in force, rather than an unused export.
  assert.ok(SYSTEM_PROMPT.includes(MISSING_INFO_GUIDANCE));
  // It has to say the two things that make the answer usable: what is not known,
  // and what can be done instead.
  assert.match(MISSING_INFO_GUIDANCE, /not on it/i);
  assert.match(MISSING_INFO_GUIDANCE, /offer/i);
});

test("the prompt names profit and loss as a missing capability, never as a failed read", () => {
  // MEASURED, and the reason this rule exists: asked for a wallet's PnL, the answer
  // was "I could not read the wallet's transaction history for every token it holds,
  // so whether it is in profit is unknown." Nothing had failed — that history reads
  // in one call. There is no PnL tool, so a gap in the CATALOGUE was reported as a
  // gap in the DATA, which sends the reader off to retry working code forever.
  assert.match(SYSTEM_PROMPT, /PROFIT AND LOSS IS wallet_pnl/);
  assert.match(SYSTEM_PROMPT, /cost basis/i);
  // The distinction itself has to be stated, not merely implied by the example.
  assert.match(SYSTEM_PROMPT, /A limit on what is COMPUTED is never reported as a failure of what was FETCHED/);
  // The two numbers that must never be invented to fill a withheld one.
  assert.match(SYSTEM_PROMPT, /NOT A LOWER BOUND AND MUST NEVER BE REPORTED AS "AT LEAST"/);
  assert.match(SYSTEM_PROMPT, /HAS NO COST, WHICH IS NOT A COST OF ZERO/);
  // The three-way split lives in the shared guidance, so every gap goes through it
  // and not just this one.
  assert.match(MISSING_INFO_GUIDANCE, /THREE KINDS OF GAP/);
  assert.match(MISSING_INFO_GUIDANCE, /nothing here computes that at all/i);
});

test("the prompt does not offer a clarification option that nothing can answer", () => {
  // A clarification's option label is sent back VERBATIM as the next question, so an
  // option is a promise the question on it is answerable. "the address most in
  // profit" shipped as the canonical third reading in the prompt, in the tool
  // description and in the docs — pressing it asked for cost basis, which nothing
  // computes, so the reader spent a turn discovering the button was a dead end.
  assert.doesNotMatch(SYSTEM_PROMPT, /the address most in profit are three different questions/);
  assert.match(SYSTEM_PROMPT, /taken the most out of it are three different questions/);
  assert.match(SYSTEM_PROMPT, /EVERY OPTION YOU OFFER MUST BE ONE YOU CAN ACTUALLY ANSWER/);
});

test("the prompt makes a pool-derived price distinguishable from a quoted one", () => {
  // A price computed off a Uniswap v3 pool and a price published by a feed are
  // different measurements of different things. The reader has to be able to tell
  // which one they are looking at, so the rule names the source, the sentence that
  // carries it, and the quote asset it is denominated against.
  assert.match(SYSTEM_PROMPT, /pool_priced/);
  assert.match(SYSTEM_PROMPT, /pool\.sourceNotice/);
  assert.match(SYSTEM_PROMPT, /quote asset/i);
  assert.match(SYSTEM_PROMPT, /not published by a price feed/i);
});

test("the prompt qualifies a pool price by the liquidity under it", () => {
  assert.match(SYSTEM_PROMPT, /pool\.thinLiquidity/);
  assert.match(SYSTEM_PROMPT, /pool\.liquidityNotice/);
  assert.match(SYSTEM_PROMPT, /a small trade moves it/i);
  // Reported, not editorialised: depth is a figure, never an accusation.
  assert.match(SYSTEM_PROMPT, /not evidence of a scam, a rug, manipulation or intent/i);
  // And a depth that is unmeasured — or a lower bound that has not reached the floor
  // — is neither thin nor deep.
  assert.match(SYSTEM_PROMPT, /thinness is NOT ESTABLISHED/);
  assert.match(SYSTEM_PROMPT, /never call the pool thin or deep/i);
});

test("the prompt never tells the model to assert an unmeasured absence", () => {
  // THE F3 SENTENCE. "shallow" used to be described as "say plainly that nothing
  // wearing this ticker has a market of any size" — an instruction to state an
  // absence, reached on a verdict that could be produced by five failed probes and
  // one answer. The verdict is now gated on every probe having answered, and the
  // wording is scoped to what was measured.
  assert.match(SYSTEM_PROMPT, /"partial" means some probes came back and some did not/);
  assert.match(SYSTEM_PROMPT, /assert NEITHER dominance NOR absence/);
  assert.doesNotMatch(SYSTEM_PROMPT, /say plainly that nothing wearing this ticker has a market/i);
  // The four counts are named, and named as four different things.
  assert.match(SYSTEM_PROMPT, /"measuredCount" is how many contracts actually produced a figure/);
  assert.match(SYSTEM_PROMPT, /"failedCount" is how many ran and could not be read/);
  assert.doesNotMatch(SYSTEM_PROMPT, /"probed", "candidateCount" and "dropped"/);
});

test("the prompt does not state an unmeasured proportionality as fact", () => {
  // THE F7 SENTENCE: "Where there is no capNotice the cap is proportionate to its
  // depth and needs no qualifier" asserted a measurement that, for a sole-candidate
  // token, nobody had made.
  assert.doesNotMatch(SYSTEM_PROMPT, /the cap is proportionate to its depth and needs no qualifier/i);
  assert.match(SYSTEM_PROMPT, /The absence of a capNotice is not itself evidence about the depth/);
});

test("the prompt keeps realisable depth apart from what a pool merely holds", () => {
  // F2: balanceOf counts positions parked outside the band, which cannot be
  // realised there, so "held" and "realisable" are two figures and only one is
  // depth.
  assert.match(SYSTEM_PROMPT, /"quoteBalanceUsd" is what the pool HOLDS/);
  assert.match(SYSTEM_PROMPT, /parked outside both bands/);
  assert.match(SYSTEM_PROMPT, /only one you may call depth/i);
  assert.match(SYSTEM_PROMPT, /integrated over the pool's tick ladder/);
});

test("the prompt says the WIDE band is context and never the depth", () => {
  // G2: capital one tick-spacing wide at the far edge of a 10% band counts toward
  // that figure in full and is never traded through — measured, $1,324 placed at
  // -9.16% matched the honest token's headline figure. The model must not quote the
  // wide figure as depth just because it is the larger of the two.
  assert.match(SYSTEM_PROMPT, /"wideDepthUsd" is the same measurement out to the much wider/);
  assert.match(SYSTEM_PROMPT, /CONTEXT ONLY, never the depth/);
  assert.match(SYSTEM_PROMPT, /would never be traded through/);
});

test("the prompt makes a lower-bound depth read as 'at least', never as a measurement", () => {
  // G1: a truncated tick walk returns a real integral over a shorter range. It can
  // show that a pool clears a bar; it can never show that one is thin or empty.
  assert.match(SYSTEM_PROMPT, /A DEPTH MARKED AS A LOWER BOUND IS "AT LEAST", NOT "IS"/);
  assert.match(SYSTEM_PROMPT, /Write "at least \$X", never a bare "\$X"/);
  assert.match(SYSTEM_PROMPT, /can never establish that a pool is thin/);
});

test("the prompt forbids reading held == realisable as a mark of honesty", () => {
  // The evidence layer used to qualify a pool only when held EXCEEDED realisable,
  // so a forged pool — everything in one narrow position, held == realisable —
  // carried no caveat while the honest one did. The model must not re-derive that
  // inference from the two figures itself.
  assert.match(SYSTEM_PROMPT, /absence of one signal, not evidence of anything/);
  assert.match(SYSTEM_PROMPT, /never read it as a mark of a healthy or honest pool/i);
});

test("the prompt requires two agreeing measurements before a ticker is settled", () => {
  // Depth is rentable and volume is not, so dominance rests on both legs. The two
  // verdicts that exist because the legs did NOT agree have to be described.
  assert.match(SYSTEM_PROMPT, /TWO MEASUREMENTS AGREEING/);
  assert.match(SYSTEM_PROMPT, /"uncorroborated" means the depth gap is there but the indexer is silent/);
  assert.match(SYSTEM_PROMPT, /never averaged into a score/);
  assert.match(SYSTEM_PROMPT, /"ambiguous" and "conflicted" never reach you as an answer/);
  // …and the absence sentence is withdrawn when the second leg contradicts it.
  assert.match(SYSTEM_PROMPT, /"tradingContradiction" is true/);
  assert.match(SYSTEM_PROMPT, /do NOT state the absence/);
});

test("reading a price off the chain does not loosen the freshness rule", () => {
  // A pool read is one read of one block. The old rule was written about the
  // indexer, and a second source must not arrive with an implicit exemption.
  assert.match(SYSTEM_PROMPT, /THE SAME RULE COVERS A POOL PRICE/);
  assert.match(SYSTEM_PROMPT, /not a stream and not a feed/i);
  assert.match(SYSTEM_PROMPT, /Never call a price live, real-time/i);
});

test("scope refuses foreign chains without refusing our own vocabulary", async () => {
  const { detectForeignVenue } = await import("../lib/ask-intent.js");

  // FALSE REFUSAL IS THE WORSE DIRECTION. The alias+noun branch has no locative to
  // disambiguate it, and these aliases are ordinary English. "base token" and "quote
  // token" are what lib/tick-depth.js calls the two sides of a pool — the product's own
  // words. Measured live, the old noun list answered "what is the base token of this
  // pair" with "You're asking about Base, which is not a chain I have access to."
  for (const q of [
    "what is the base token of this pair",
    "whats the quote token here",
    "base contract address please",
    "the sol tokens i hold",
    "blast contracts",
    "scroll tokens",
  ]) {
    assert.equal(detectForeignVenue(q), null, `refused our own vocabulary: ${q}`);
  }

  // And it must never refuse a question about THIS chain, however it is abbreviated.
  for (const q of ["whats on the rh chain", "whats on the hood chain", "wut is robinhud chain"]) {
    assert.equal(detectForeignVenue(q), null, `refused our own chain: ${q}`);
  }

  // A genuine foreign chain is still named, including one nobody listed.
  for (const [q, want] of [
    ["which wallet bought catecoin on Solana", "Solana"],
    ["who bought this on the zorp chain", "Zorp"],
  ]) {
    const v = detectForeignVenue(q);
    assert.ok(v, `missed a foreign chain: ${q}`);
    assert.equal(v.venue ?? v, want);
  }
});
