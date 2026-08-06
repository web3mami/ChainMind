/**
 * The corpus's own shape, checked offline and for free.
 *
 * scripts/route-bench.mjs costs money and needs the network, so it can never be
 * part of `node --test`. Its INPUT can be, and should: a corpus that names a tool
 * which no longer exists, or scores a row against an outcome the router could not
 * produce, would quietly measure nothing and nobody would find out until the
 * numbers were already being quoted.
 *
 * What is deliberately NOT asserted here: whether any particular row's `accept`
 * is the RIGHT answer. That is a judgement about the product, argued in the
 * comments beside each row, and freezing it into a test would make the corpus
 * harder to correct than it should be.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CORPUS, coveredTools } from "../scripts/routing-corpus.mjs";
import { TOOL_NAMES } from "../lib/ask-tools.js";

test("every corpus id is unique — the bench keys its resumable log on them", () => {
  const seen = new Set();
  for (const row of CORPUS) {
    assert.ok(!seen.has(row.id), `duplicate corpus id: ${row.id}`);
    seen.add(row.id);
  }
});

test("every accepted outcome names tools that actually exist", () => {
  for (const row of CORPUS) {
    for (const outcome of row.accept) {
      for (const name of outcome) {
        assert.ok(
          TOOL_NAMES.includes(name),
          `${row.id} accepts "${name}", which is not one of the ${TOOL_NAMES.length} tools`,
        );
      }
    }
  }
});

test("every row has a question and at least one acceptable outcome", () => {
  for (const row of CORPUS) {
    assert.ok(row.q && typeof row.q === "string", `${row.id} has no question`);
    assert.ok(Array.isArray(row.accept) && row.accept.length, `${row.id} accepts nothing`);
    for (const outcome of row.accept) {
      assert.ok(Array.isArray(outcome), `${row.id} has a non-array outcome`);
    }
  }
});

test("a row's `primary` is one of its own accepted outcomes, or blank for a no-tool row", () => {
  for (const row of CORPUS) {
    if (!row.primary) {
      assert.ok(
        row.accept.some((outcome) => outcome.length === 0),
        `${row.id} names no primary tool but does not accept a tool-free answer either`,
      );
      continue;
    }
    assert.ok(
      row.accept.some((outcome) => outcome.includes(row.primary)),
      `${row.id} exists to exercise ${row.primary} but does not accept it`,
    );
  }
});

test("a row that admits more than one answer says why — an unexplained set is a hidden judgement", () => {
  for (const row of CORPUS) {
    if (row.accept.length < 2) continue;
    assert.ok(
      typeof row.why === "string" && row.why.length > 20,
      `${row.id} accepts ${row.accept.length} different outcomes with no explanation`,
    );
  }
});

test("all 27 tools are reachable from the corpus — an unreached tool is an unmeasured tool", () => {
  const covered = coveredTools();
  const missing = TOOL_NAMES.filter((name) => !covered.has(name));
  assert.deepEqual(missing, [], `no corpus row can route to: ${missing.join(", ")}`);
});

test("some rows require NO tool at all, so a fix cannot pass by calling something every time", () => {
  const toolFree = CORPUS.filter((row) => row.accept.every((outcome) => outcome.length === 0));
  assert.ok(toolFree.length >= 5, `only ${toolFree.length} rows demand a tool-free answer`);
});

test("every row declares where its phrasing came from", () => {
  const allowed = new Set(["tool", "prompt", "docs", "live", "gap"]);
  for (const row of CORPUS) {
    assert.ok(allowed.has(row.source), `${row.id} has source "${row.source}"`);
  }
});
