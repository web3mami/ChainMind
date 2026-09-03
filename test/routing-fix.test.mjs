// Tests for the three mechanisms that make routing an answer instead of a guess
// (lib/ask-loop.js).
//
// WHY THIS FILE IS SEPARATE FROM ask-loop.test.mjs. That file defends the loop's
// shape — the fast path stays narrow, the rounds are capped, an endpoint without
// tool support degrades. This one defends three mechanisms added after the
// routing bench (scripts/route-bench.mjs) measured what the router actually does
// over 103 questions × 3 repetitions × 2 temperatures:
//
//  1. REFUSAL RECOVERY. 8.7% of routing turns at temperature 0.2 and 6.8% at
//     temperature 0 came back as HTTP 400 `tool_use_failed` — the model chose
//     correctly and Groq's own parser refused to serialize the call. That 400
//     used to read as "this endpoint cannot do tool calling", so the choice was
//     discarded and the keyword router answered instead, silently. Re-scoring the
//     same 618 calls with recovery on moved accuracy 85.1% -> 92.9% at 0.2 and
//     86.7% -> 93.2% at 0, and unstable rows 18 -> 6 and 14 -> 5.
//  2. THE CHAIN FLOOR. A question naming a contract, a hash or a ticker must not
//     be answered without a lookup. Measured, this never had to fire — 0 of 618
//     turns did it — so what these tests defend is that it is there for the day
//     it does, and that it stays off everything else.
//  3. TEMPERATURE. The turn that picks a tool is a classification and runs at 0;
//     the turn that writes prose is not and does not.
//
// Fully offline. Every run injects a scripted `complete` and a fake `dispatch`,
// so nothing here reaches Groq or Blockscout. The refusal bodies are verbatim
// from .route-bench — real failures, not invented ones.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHAIN_NOT_READ_NOTE,
  PNL_SCOPE_NOTE,
  ROUTING_TEMPERATURE,
  fastPathRoute,
  floorToolCalls,
  namedChainTargets,
  parseTextToolCalls,
  recoverRefusedToolCalls,
  runToolLoop,
  withAskedSpan,
} from "../lib/ask-loop.js";

const ADDRESS = "0x0eb9960654d3661d551a4536d7d425184ec81756";
const TX_HASH = `0x${"ab".repeat(32)}`;

/* ------------------------------ scripted client ------------------------------ */

function toolTurn(calls) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: calls.map((c, i) => ({
            id: c.id ?? `call_${i}`,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
          })),
        },
      },
    ],
  };
}

const proseTurn = (content) => ({ choices: [{ message: { role: "assistant", content } }] });

/** Replays scripted turns and records every payload, which is what proves intent. */
function scripted(turns) {
  const payloads = [];
  const complete = async (payload) => {
    payloads.push(payload);
    const turn = turns[payloads.length - 1];
    if (!turn) throw new Error(`no scripted turn ${payloads.length}`);
    if (turn instanceof Error) throw turn;
    return turn;
  };
  return { complete, payloads };
}

function recorder(results = {}) {
  const calls = [];
  const dispatch = async (name, args) => {
    calls.push({ name, args });
    return results[name] ?? { ok: true, kind: "token", target: "NVDA", evidence: { symbol: "NVDA" } };
  };
  return { dispatch, calls };
}

const base = { question: "anything", systemPrompt: "SYS", model: "test-model" };

/* --------------- refusals: three shapes, all verbatim from a run --------------- */

/** Shape 1: the whole call crammed into the slot where a tool NAME belongs. */
const REFUSED_NAME_SLOT = JSON.stringify({
  error: {
    message:
      "tool call validation failed: attempted to call tool " +
      "'project_profile({\"query\": \"0x0eb9960654d3661d551a4536d7d425184ec81756\", \"url\": \"https://eska.fun/\", \"examine_site\": true})' " +
      "which was not in request.tools",
    type: "invalid_request_error",
    code: "tool_use_failed",
    failed_generation:
      "<function=project_profile({\"query\": \"0x0eb9960654d3661d551a4536d7d425184ec81756\", " +
      "\"url\": \"https://eska.fun/\", \"examine_site\": true})></function>",
  },
});

/** Shape 2: an opener the parser would not take — no parentheses at all. */
const REFUSED_BAD_OPENER = JSON.stringify({
  error: {
    message: "Failed to call a function. Please adjust your prompt. See 'failed_generation' for more details.",
    type: "invalid_request_error",
    code: "tool_use_failed",
    failed_generation: "<function=safety_check{\"target\": \"nvda\"}</function>",
  },
});

/** Shape 3: a well-formed call whose ARGUMENT TYPE failed Groq's schema check. */
const REFUSED_BAD_ARG = JSON.stringify({
  error: {
    message:
      "tool call validation failed: parameters for tool recent_trades did not match schema: " +
      "errors: [`/minutes`: expected integer, but got string]",
    type: "invalid_request_error",
    code: "tool_use_failed",
    failed_generation:
      "<function=recent_trades>{\"query\": \"0x0eb9960654d3661d551a4536d7d425184ec81756\", \"minutes\": \"60\"}</function>",
  },
});

/** The 400 as app/api/ask/route.js throws it, with the body on `detail`. */
function refusal(detail) {
  const err = new Error("Groq 400");
  err.status = 400;
  err.detail = detail;
  return err;
}

test("all three refusal shapes give back the tool the model actually chose", () => {
  const one = recoverRefusedToolCalls(REFUSED_NAME_SLOT);
  assert.equal(one.length, 1);
  assert.equal(one[0].name, "project_profile");
  // The arguments survive whole. The user's own URL is the reason that call
  // exists, and a recovery that dropped it would profile the chain half only and
  // never say the site went unexamined.
  assert.deepEqual(one[0].args, {
    query: ADDRESS,
    url: "https://eska.fun/",
    examine_site: true,
  });

  const two = recoverRefusedToolCalls(REFUSED_BAD_OPENER);
  assert.deepEqual(two.map((c) => c.name), ["safety_check"]);
  assert.deepEqual(two[0].args, { target: "nvda" });

  // Shape 3 is the one lib/ask-tools.js coercion was written for and could never
  // reach: Groq validates argument types server-side, so the call was refused
  // before clampRows ever saw the string it exists to absorb.
  const three = recoverRefusedToolCalls(REFUSED_BAD_ARG);
  assert.deepEqual(three.map((c) => c.name), ["recent_trades"]);
  assert.equal(three[0].args.minutes, "60", "passed on as sent; the coercers clamp it downstream");
});

test("a truncated error body still gives the call back", () => {
  // The chat client caps `detail`. A body cut mid-JSON will not parse, so the
  // escapes are undone and the same scanners run over the fragment — one
  // truncated body must not cost a routing decision.
  const cut = REFUSED_BAD_OPENER.slice(0, REFUSED_BAD_OPENER.indexOf("</function>"));
  assert.deepEqual(recoverRefusedToolCalls(cut).map((c) => c.name), ["safety_check"]);
});

test("nothing is invented from a refusal that names no tool we have", () => {
  assert.deepEqual(recoverRefusedToolCalls(""), []);
  assert.deepEqual(recoverRefusedToolCalls("Groq 500: upstream is down"), []);
  assert.deepEqual(recoverRefusedToolCalls(null), []);
  // A name outside the catalogue means the parse is wrong, and dispatching a
  // guess is worse than degrading honestly.
  const bogus = JSON.stringify({
    error: { code: "tool_use_failed", failed_generation: "<function=summon_alpha{\"query\": \"nvda\"}</function>" },
  });
  assert.deepEqual(recoverRefusedToolCalls(bogus), []);
});

test("a refused routing turn runs the recovered lookup instead of degrading", async () => {
  const { complete, payloads } = scripted([
    refusal(REFUSED_BAD_OPENER),
    proseTurn("NVDA at 0x465… is not the issuer's contract."),
  ]);
  const { dispatch, calls } = recorder({
    safety_check: { ok: true, kind: "safety", target: "NVDA", evidence: { verdict: "impostor" } },
  });
  const res = await runToolLoop({ ...base, question: "is this legit nvda", complete, dispatch });

  assert.equal(res.ok, true, "a refused call is a routing decision, not an outage");
  assert.equal(res.fallback, undefined, "and it must not hand the question to the keyword router");
  assert.deepEqual(calls.map((c) => c.name), ["safety_check"]);
  assert.equal(res.answer, "NVDA at 0x465… is not the issuer's contract.");

  // The transcript the next turn is sent has to be well formed: one tool message
  // per tool_call_id, built from calls we synthesized rather than from a message
  // body that never arrived.
  const assistant = payloads[1].messages.find((m) => m.role === "assistant");
  assert.equal(assistant.tool_calls.length, 1);
  const tool = payloads[1].messages.find((m) => m.role === "tool");
  assert.equal(tool.tool_call_id, assistant.tool_calls[0].id);
});

test("a 400 with nothing recoverable in it still degrades to the keyword router", async () => {
  const { complete } = scripted([refusal("tool_choice is not supported for this model")]);
  const res = await runToolLoop({ ...base, complete, dispatch: recorder().dispatch });
  assert.equal(res.ok, false);
  assert.equal(res.fallback, true, "the keyword router still answers everything it always could");
});

/* ------------------------------ the chain floor ------------------------------ */

test("only an outright identifier counts as a named chain target", () => {
  assert.deepEqual(namedChainTargets(`what is ${ADDRESS}`, ""), [{ kind: "address", value: ADDRESS }]);
  assert.deepEqual(namedChainTargets(`what happened in ${TX_HASH}`, ""), [{ kind: "tx", value: TX_HASH }]);
  assert.deepEqual(namedChainTargets("tell me about $tsla", ""), [{ kind: "symbol", value: "TSLA" }]);
  // The UI's own subject counts: a question asked from a page showing a contract
  // names that contract even when its words do not.
  assert.deepEqual(namedChainTargets("is it any good", ADDRESS), [{ kind: "address", value: ADDRESS }]);

  // AND A LOWERCASE COMPANY WORD DOES NOT. "whats the roadmap for nvda" names a
  // roadmap, which is not on chain at all; forcing a price lookup out of that
  // word would answer a question nobody asked with figures that look like one.
  assert.deepEqual(namedChainTargets("whats the roadmap for nvda on this chain", ""), []);
  assert.deepEqual(namedChainTargets("what is this site", ""), []);
  assert.deepEqual(namedChainTargets("hi", ""), []);
  assert.deepEqual(namedChainTargets("wut is robinhud chain", ""), []);
});

test("the floor's own routing is the widest honest read of each identifier", () => {
  assert.deepEqual(floorToolCalls([{ kind: "tx", value: TX_HASH }])[0].name, "lookup_transaction");
  assert.deepEqual(floorToolCalls([{ kind: "address", value: ADDRESS }])[0].name, "lookup_wallet");
  assert.deepEqual(floorToolCalls([{ kind: "symbol", value: "TSLA" }])[0].args, { query: "TSLA" });
  assert.deepEqual(floorToolCalls([{ kind: "nonsense", value: "x" }]), []);
  assert.deepEqual(floorToolCalls(null), []);
});

test("a question naming a contract is never answered without a lookup", async () => {
  // Rung 1: the model chose nothing, so it is asked again with the option of
  // choosing nothing removed. WHICH tool stays the model's decision — it has the
  // question and 26 descriptions, and a rule here would have neither.
  const { complete, payloads } = scripted([
    proseTurn("That one looks like a fairly typical new token."),
    toolTurn([{ name: "project_profile", args: { query: ADDRESS } }]),
    proseTurn("Deployed by a launchpad factory 3 days ago."),
  ]);
  const { dispatch, calls } = recorder({
    project_profile: { ok: true, kind: "project", target: ADDRESS, evidence: {} },
  });
  const res = await runToolLoop({ ...base, question: `check this out for me ${ADDRESS}`, complete, dispatch });

  assert.equal(payloads[1].tool_choice, "required", "the second ask removes the do-nothing option");
  assert.equal(payloads[1].temperature, ROUTING_TEMPERATURE);
  assert.deepEqual(calls.map((c) => c.name), ["project_profile"]);
  assert.equal(res.answer, "Deployed by a launchpad factory 3 days ago.");
  assert.notEqual(res.answer, "That one looks like a fairly typical new token.");

  // AND THE GUESS DOES NOT ENTER THE RECORD. The model wrote that first sentence
  // without reading anything; echoing it into the transcript beside the lookup
  // would leave an ungrounded claim in the context for the final turn to repeat.
  const assistant = payloads[2].messages.find((m) => m.role === "assistant");
  assert.equal(assistant.content, null);
  assert.ok(
    !JSON.stringify(payloads[2].messages).includes("fairly typical"),
    "the pre-lookup guess must not survive into the answering turn",
  );
});

test("when the forced round chooses nothing either, the floor routes it itself", async () => {
  // Rung 2. Whatever else is uncertain, the chain gets read.
  const { complete } = scripted([
    proseTurn("It looks fine to me."),
    proseTurn("Still nothing."),
    proseTurn("It holds 12 tokens and 0.4 ETH."),
  ]);
  const { dispatch, calls } = recorder({
    lookup_wallet: { ok: true, kind: "wallet", target: ADDRESS, evidence: {} },
  });
  const res = await runToolLoop({ ...base, question: `is this any good ${ADDRESS}`, complete, dispatch });

  assert.deepEqual(calls.map((c) => c.name), ["lookup_wallet"]);
  assert.deepEqual(calls[0].args, { address: ADDRESS });
  assert.equal(res.answer, "It holds 12 tokens and 0.4 ETH.");
});

test("a refusal on the forced round is recovered too", async () => {
  // The forced round can be refused for exactly the reasons the first one was, so
  // it gets the same recovery — otherwise the floor would fall through to its own
  // routing while a perfectly good choice sat in the error body.
  const { complete } = scripted([proseTurn("Looks like a normal token."), refusal(REFUSED_NAME_SLOT)]);
  const { dispatch, calls } = recorder({
    project_profile: { ok: true, kind: "project", target: ADDRESS, evidence: {} },
  });
  await runToolLoop({ ...base, question: `is this a larp ${ADDRESS}`, complete, dispatch, maxRounds: 1 });

  assert.deepEqual(calls.map((c) => c.name), ["project_profile"]);
  assert.equal(calls[0].args.url, "https://eska.fun/", "the user's own URL survives the round trip");
});

test("a question naming nothing on chain is left alone by the floor", async () => {
  // Curing one failure by causing its opposite has cured nothing: "what is this
  // site" must still cost one completion and no lookup.
  const { complete, payloads } = scripted([proseTurn("ChainMind reads Robinhood Chain and explains it.")]);
  const { dispatch, calls } = recorder();
  const res = await runToolLoop({ ...base, question: "what is this site", complete, dispatch });

  assert.equal(payloads.length, 1, "one completion, no forced retry");
  assert.deepEqual(calls, []);
  assert.equal(res.answer, "ChainMind reads Robinhood Chain and explains it.");
  assert.equal(res.chainNotRead, undefined);
});

test("a floor that cannot choose a lookup says the chain was not read", async () => {
  // Rung 3. The one thing that must never happen is an answer about a named
  // contract written from memory and presented as though the chain had been read.
  const { complete, payloads } = scripted([
    proseTurn("Sure, that token is fine — it is trading around $0.02."),
    proseTurn("Still nothing."),
    proseTurn("I have not read the chain for this one."),
  ]);
  const res = await runToolLoop({
    ...base,
    question: `what about ${ADDRESS}`,
    complete,
    dispatch: recorder().dispatch,
    // Nothing routable, so rungs 1 and 2 both come back empty.
    floorRoute: () => [],
  });

  assert.equal(res.chainNotRead, true);
  assert.equal(res.answer, "I have not read the chain for this one.");
  assert.notEqual(res.answer, "Sure, that token is fine — it is trading around $0.02.");
  const note = payloads[2].messages.find((m) => m.role === "system" && m.content === CHAIN_NOT_READ_NOTE);
  assert.ok(note, "the model is told to say so, in the transcript rather than by editing its prose");
  assert.equal(payloads[2].tools, undefined, "and that turn can only produce prose");
});

/* ------------------------- routing runs at temperature 0 ------------------------- */

test("the turn that picks a tool is a classification, and the prose turn is not", async () => {
  // maxRounds 1, so the second completion is unambiguously the writing turn. At
  // the default of 2 it would still be offering tools — a turn that can choose a
  // lookup is a routing turn whatever number it is, and it is graded as one.
  const { complete, payloads } = scripted([
    toolTurn([{ name: "lookup_token", args: { query: "nvda" } }]),
    proseTurn("NVDA is up 2%."),
  ]);
  await runToolLoop({ ...base, complete, dispatch: recorder().dispatch, maxRounds: 1 });

  assert.equal(payloads[0].temperature, ROUTING_TEMPERATURE, "routing: same question, same tool, every time");
  assert.equal(payloads[0].temperature, 0);
  assert.equal(payloads[0].tool_choice, "auto");
  assert.equal(payloads[1].tools, undefined, "the writing turn cannot ask for a lookup");
  assert.equal(payloads[1].temperature, 0.2, "prose: nothing about the wording needs reproducing");
});

test("a caller can still set either temperature explicitly", async () => {
  const { complete, payloads } = scripted([
    toolTurn([{ name: "lookup_token", args: { query: "nvda" } }]),
    proseTurn("NVDA is up 2%."),
  ]);
  await runToolLoop({
    ...base,
    complete,
    dispatch: recorder().dispatch,
    maxRounds: 1,
    routingTemperature: 0.4,
    temperature: 0.9,
  });
  assert.equal(payloads[0].temperature, 0.4);
  assert.equal(payloads[1].temperature, 0.9);
});

/* ------------------- tool calls the model wrote out as text ------------------- */

test("every text-emitted call shape is salvaged, closing tag or not", () => {
  const shapes = [
    ["<function(rank_stocks)={\"metric\":\"holders\"}</function>", "rank_stocks", { metric: "holders" }],
    ["<function=safety_check{\"target\": \"nvda\"}</function>", "safety_check", { target: "nvda" }],
    ["<function=whale_moves>{\"query\": \"nvda\"}</function>", "whale_moves", { query: "nvda" }],
    ["<function=project_profile({\"query\": \"nvda\"})>", "project_profile", { query: "nvda" }],
    ["<|python_tag|>{\"name\": \"top_movers\", \"parameters\": {\"limit\": 3}}", "top_movers", { limit: 3 }],
  ];
  for (const [text, name, args] of shapes) {
    const got = parseTextToolCalls(text);
    assert.equal(got.length, 1, `nothing salvaged from ${text}`);
    assert.equal(got[0].name, name);
    assert.deepEqual(got[0].args, args);
  }
});

test("a brace inside a string value does not truncate the arguments", () => {
  // A lazy `\{[\s\S]*?\}` ends at the first `}`, which for any URL or free-text
  // argument carrying one hands back JSON that will not parse — and a call whose
  // arguments will not parse is a lookup that does not happen.
  const got = parseTextToolCalls(
    "<function=project_profile{\"query\": \"nvda\", \"url\": \"https://x.io/a}b\"}</function>",
  );
  assert.equal(got.length, 1);
  assert.equal(got[0].argsError, null);
  assert.equal(got[0].args.url, "https://x.io/a}b");
});

test("ordinary prose is never mistaken for a tool call", () => {
  assert.deepEqual(parseTextToolCalls("The contract exposes one function, and it is not a tool call: {}"), []);
  assert.deepEqual(parseTextToolCalls(""), []);
  assert.deepEqual(parseTextToolCalls("NVDA is up 2% on the day."), []);
});

test("a request with no lookup budget left says the chain was not read", async () => {
  // THE FLOOR APPLIES TO THE CLOCK TOO. A request that ran out of budget before
  // its first round has read nothing, and the model is then one completion away
  // from writing about a named contract from memory. There is no time to fix that
  // with a lookup; there is always time to say it.
  const { complete, payloads } = scripted([proseTurn("I have not read the chain for this one.")]);
  const { dispatch, calls } = recorder();

  const { runWithBudget } = await import("../lib/request-budget.js");
  // One millisecond of budget: no round can be offered at all.
  const res = await runWithBudget(
    () => runToolLoop({ ...base, question: `is this any good ${ADDRESS}`, complete, dispatch }),
    { totalMs: 1, reserveMs: 0 },
  );

  assert.equal(payloads.length, 1, "no completion is spent on a round that could not finish");
  assert.equal(payloads[0].tools, undefined);
  assert.deepEqual(calls, [], "and no lookup is started that would only be clamped into failing");
  assert.equal(res.chainNotRead, true);
  assert.ok(payloads[0].messages.some((m) => m.role === "system" && m.content === CHAIN_NOT_READ_NOTE));
});

test("a budget-starved question that names nothing on chain is untouched", async () => {
  // Same clock, no identifier: there is nothing the answer would be dishonest
  // about, so it is written the way it always was.
  const { complete, payloads } = scripted([proseTurn("ChainMind reads Robinhood Chain and explains it.")]);
  const { runWithBudget } = await import("../lib/request-budget.js");
  const res = await runWithBudget(
    () => runToolLoop({ ...base, question: "what is this site", complete, dispatch: recorder().dispatch }),
    { totalMs: 1, reserveMs: 0 },
  );

  assert.equal(res.chainNotRead, undefined);
  assert.ok(!payloads[0].messages.some((m) => m.content === CHAIN_NOT_READ_NOTE));
});

/* ---------------------------- profit and loss ---------------------------- */

test("a question about profit carries the note that says nothing computes it", async () => {
  // MEASURED TWICE. First the invented outage: "I could not read the wallet's
  // transaction history for every token it holds, so whether it is in profit is
  // unknown" — a failure that never happened, on a history that reads in one call.
  // Then, with the rule added to SYSTEM_PROMPT and nothing else, a live run
  // answered a DIFFERENT question instead: "This wallet holds 50.28 MEMECAT and 30
  // catcall…", every figure true, profit never mentioned. One bullet among a
  // hundred did not survive a wallet full of real data, so the note rides next to
  // the question the way CHAIN_NOT_READ_NOTE does.
  const { complete, payloads } = scripted([
    toolTurn([{ name: "wallet_portfolio", args: { address: ADDRESS } }]),
    proseTurn("Working out whether this address is up or down is not something I can do."),
  ]);
  const { dispatch, calls } = recorder();

  await runToolLoop({ ...base, question: `whats the pnl for ${ADDRESS}`, complete, dispatch });

  const note = payloads[0].messages.find((m) => m.role === "system" && m.content === PNL_SCOPE_NOTE);
  assert.ok(note, "the note must be present on the FIRST payload, so it shapes routing too");
  // And the lookups still run. The refusal is about profit, not about the address:
  // suppressing the wallet read would answer less than before the fix.
  assert.equal(calls.length, 1, "the wallet is still read");
  assert.equal(calls[0].name, "wallet_portfolio");
});

test("the note forbids the invented outage that started all this", () => {
  // The exact inversion that produced the bug. Anything resembling "could not read"
  // sends the reader off to retry code that works perfectly, so the note may only
  // permit that sentence when a read actually failed.
  assert.match(PNL_SCOPE_NOTE, /Never say a history, a page or a balance could not be read unless that is what actually happened/);
  assert.match(PNL_SCOPE_NOTE, /a limit of what is computed is not a failure of what was fetched/);
  // The two figures that must never be invented to fill a withheld one.
  assert.match(PNL_SCOPE_NOTE, /NOT a lower bound/);
  assert.match(PNL_SCOPE_NOTE, /never fill the gap with a\s+dollar value/);
  assert.match(PNL_SCOPE_NOTE, /airdrop is never pure profit/);
});

test("the note routes a wallet-only question to a question the reader can answer", () => {
  // A position is always in ONE token, so "whats the pnl for 0x…" cannot be
  // computed as asked — but refusing it outright was the old behaviour and it is
  // not the right one now that the figure exists. Asking which token, and naming
  // what the wallet holds, turns a dead end into one more turn.
  assert.match(PNL_SCOPE_NOTE, /A POSITION IS ALWAYS IN ONE TOKEN/);
  assert.match(PNL_SCOPE_NOTE, /do not refuse and do not guess a token/i);
  assert.match(PNL_SCOPE_NOTE, /naming what the wallet actually holds/);
});

test("the note tells the model not to recite it, or to name a tool to the reader", () => {
  // MEASURED, on the first version of this note: the model printed it back
  // verbatim — "THIS QUESTION ASKS FOR PROFIT, LOSS OR WHAT A POSITION COST, AND
  // NOTHING HERE COMPUTES THAT." — capitals and all, then closed with "use
  // wallet_portfolio", handing the reader the name of an internal function. A note
  // written as a finished sentence gets copied as one, so it now says what to do
  // rather than what to write.
  assert.match(PNL_SCOPE_NOTE, /THIS NOTE IS AN INSTRUCTION, NOT A DRAFT/);
  assert.match(PNL_SCOPE_NOTE, /do not copy a sentence from it/i);
  assert.match(PNL_SCOPE_NOTE, /Never name a tool, a lookup or a function to the reader/);
  // The note opens as prose about the reader, not as a headline the model can lift.
  assert.doesNotMatch(PNL_SCOPE_NOTE.slice(0, 90), /^[A-Z ,]{40,}/);
});

test("a question that names no profit is left alone", async () => {
  // The scoping test. "how much is this wallet worth" is answered by
  // wallet_portfolio and must not pick up a refusal about cost basis.
  const { complete, payloads } = scripted([
    toolTurn([{ name: "wallet_portfolio", args: { address: ADDRESS } }]),
    proseTurn("It holds 50.28 MEMECAT."),
  ]);
  await runToolLoop({
    ...base,
    question: `how much is ${ADDRESS} worth`,
    complete,
    dispatch: recorder().dispatch,
  });
  assert.ok(!payloads[0].messages.some((m) => m.content === PNL_SCOPE_NOTE));
});

/* ------------- the fast path must not swallow another script ------------- */

test("a question in a non-Latin script reaches the model, address or not", async () => {
  // A LIVE DEFECT THE CORPUS FOUND. residualWords used to split on `[^a-z0-9]+`,
  // which does not split Chinese, Japanese, Korean, Cyrillic, Arabic or Thai — it
  // DELETES them. So "这个项目是真的吗 0x…" ("is this project real?") reduced to
  // no residual words, fastPathRoute read it as a bare pasted address, and a
  // diligence question was answered with a wallet's ETH balance without the model
  // being asked anything. The same question in English routed correctly, which is
  // the worst shape this kind of bug can have.
  const asked = [
    `这个项目是真的吗 ${ADDRESS}`,
    `これは本物ですか ${ADDRESS}`,
    `что это ${ADDRESS}`,
    `이거 진짜야 ${ADDRESS}`,
    `هل هذا حقيقي ${ADDRESS}`,
  ];
  for (const q of asked) {
    assert.equal(fastPathRoute(q, ""), null, `the fast path swallowed ${JSON.stringify(q.slice(0, 20))}`);
  }
});

test("and the fast path still fires on everything it was built for", async () => {
  // The other half of the same change: widening the split must not cost the fast
  // path the two inputs it exists for.
  assert.equal(fastPathRoute(ADDRESS, "").toolCalls[0].name, "lookup_wallet");
  assert.equal(fastPathRoute(`what happened here ${TX_HASH}`, "").toolCalls[0].name, "lookup_transaction");
  assert.equal(fastPathRoute("is this legit?", ADDRESS).toolCalls[0].name, "safety_check");
  assert.equal(fastPathRoute("tell me about $tsla", "").toolCalls[0].name, "lookup_token");
});

/* ---------------------------- an asked-for span ---------------------------- */

test("THE SPAN THE QUESTION NAMED IS HANDED TO THE TOOL, BECAUSE THE MODEL WILL NOT", () => {
  // MEASURED THREE TIMES LIVE. holder_hold_time takes thresholdDays and answers
  // "how many have held longer than that" with the count and denominator already
  // worked out. With the argument in the schema, its use spelled out in the
  // description, AND a system note naming the number, every run still called it
  // as {query:"NVDA"} and answered from the median and the range — a different
  // question wearing a number. The threshold is in the user's sentence and is
  // parsed deterministically, so routing it through a completion buys nothing.
  assert.deepEqual(withAskedSpan({ name: "holder_hold_time", args: { query: "NVDA" } }, 3), {
    query: "NVDA",
    thresholdDays: 3,
  });
});

test("a span the model DID pass wins over the parsed one", () => {
  // If it read the question differently, that is a reading of the question. This
  // exists for the case where it read nothing at all.
  assert.deepEqual(withAskedSpan({ name: "holder_hold_time", args: { query: "NVDA", thresholdDays: 7 } }, 3), {
    query: "NVDA",
    thresholdDays: 7,
  });
});

test("no span in the question means no argument is invented", () => {
  assert.deepEqual(withAskedSpan({ name: "holder_hold_time", args: { query: "NVDA" } }, null), { query: "NVDA" });
});

test("only the tool that understands a span is given one", () => {
  // token_holders has no thresholdDays; handing it one would be an argument the
  // schema forbids and the dispatcher would have to reject.
  assert.deepEqual(withAskedSpan({ name: "token_holders", args: { query: "NVDA" } }, 3), { query: "NVDA" });
});

test("withAskedSpan is total", () => {
  for (const bad of [null, undefined, {}, { name: "holder_hold_time" }]) {
    assert.equal(typeof withAskedSpan(bad, 3), "object");
  }
});
