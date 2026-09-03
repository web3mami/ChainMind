// Tests for THE REPORT — services/research/lib/report.js.
//
// The output is a document about IDENTIFIABLE PEOPLE AND BUSINESSES, and the two ways it
// can do real harm are both structural rather than stylistic:
//
//   1. A VERDICT. One word can turn a page of correct measurements into an accusation the
//      measurements do not support. The prompt asks the model not to write one; this file
//      proves the report will not PRINT one whatever the model wrote, because a prompt is a
//      request and scrubVerdictLanguage is a control.
//   2. AN OMISSION READ AS AN ABSENCE. A report that lists findings and stops is read as
//      exhaustive, so what was NOT checked, what was DECLINED, and which CAP bit have to be
//      in the shape rather than in the prose.
//
// Fully offline.
// Run with: npm test (from the repository root)
import { test } from "node:test";
import assert from "node:assert/strict";
import { REPORT_SCHEMA, buildReport, scrubVerdictLanguage } from "../lib/report.js";
import { createBudget } from "../lib/budget.js";
import { createDossier } from "../lib/dossier.js";
import { createTargetLedger } from "../lib/targets.js";

/* ------------------------------ the verdict control ------------------------------ */

test("verdict words are redacted, and the redaction is reported rather than silent", () => {
  const out = scrubVerdictLanguage("This is a scam and a rug pull by known grifters, and the whole thing is a LARP.");
  assert.equal(/\bscam\b/i.test(out.text), false);
  assert.equal(/\blarp\b/i.test(out.text), false);
  assert.equal(/\bgrifters\b/i.test(out.text), false);
  assert.match(out.text, /\[verdict word removed\]/);
  assert.ok(out.removed.includes("scam"));
  assert.ok(out.removed.includes("larp"));
});

test("words that merely CONTAIN a verdict word survive — this is a word boundary, not a substring", () => {
  const out = scrubVerdictLanguage("The rugby club's scampi supplier is in Larpington. Ponzine is a magazine.");
  assert.deepEqual(out.removed, []);
  assert.equal(out.text.includes("[verdict word removed]"), false);
});

test("`honeypot` is deliberately NOT scrubbed: it names a checkable contract behaviour", () => {
  const out = scrubVerdictLanguage("The contract has a honeypot pattern: buys succeed and sells revert.");
  assert.deepEqual(out.removed, []);
});

test("the whole report is scrubbed, including the model's summary and its evidence quotes", () => {
  const { report } = fixture({
    summary: "Overall this is a scam.",
    findings: [
      {
        group: "what_it_is",
        statement: "The site describes itself as an exchange; commenters call it a rug.",
        evidence: [{ sourceUrl: "https://project.example.com/", what: "the home page", quote: "a total fraud, obviously" }],
      },
    ],
  });
  const finding = report.findings.flatMap((g) => g.findings)[0];
  assert.equal(/\bscam\b/i.test(report.summary), false);
  assert.equal(/\brug\b/i.test(finding.statement), false);
  assert.equal(/\bfraud\b/i.test(finding.evidence[0].quote), false);
  assert.deepEqual([...report.languageScrubbed].sort(), ["fraud", "rug", "scam"]);
  assert.match(report.languageScrubbedNote, /so the edit is visible rather than silent/);
});

/* -------------------------------- the report shape -------------------------------- */

test("the shape is the contract: a caller can rely on every section existing", () => {
  const { report } = fixture({});
  for (const key of [
    "schema", "subject", "outcome", "summary", "findings", "findingCount", "findingsNote",
    "checked", "declined", "machineDirectedText", "rejectedClaims", "notChecked",
    "notCheckedNote", "caps", "cost", "languageScrubbed", "disclaimer",
  ]) {
    assert.ok(Object.hasOwn(report, key), `the report has no \`${key}\``);
  }
  assert.equal(report.schema, REPORT_SCHEMA);
});

test("findings are GROUPED and each evidence entry carries how its source was reached", () => {
  const { report } = fixture({
    findings: [
      { group: "what_runs", statement: "The vault endpoint answers with a balance figure.", evidence: [{ sourceUrl: "https://project.example.com/api/vault", what: "the JSON body", quote: "3.14" }] },
      { group: "what_runs", statement: "The health endpoint answers 200.", evidence: [{ sourceUrl: "https://project.example.com/api/vault", what: "the status line" }] },
      { group: "code", statement: "A complete search found one address, a zero placeholder.", evidence: [{ sourceUrl: "https://project.example.com/", what: "a complete repository search" }] },
    ],
  });
  assert.equal(report.findingCount, 3);
  assert.deepEqual(report.findings.map((g) => [g.group, g.count]), [["what_runs", 2], ["code", 1]]);
  const e = report.findings[0].findings[0].evidence[0];
  assert.ok(e.source.url);
  assert.ok(e.source.provenance);
  assert.ok(e.source.howItWasReached, "a reader must be able to see how a source was reached without reconstructing it");
  assert.ok(e.source.retrievedAt);
});

test("an empty report says it found nothing rather than implying there was nothing", () => {
  const { report } = fixture({});
  assert.equal(report.findingCount, 0);
  assert.match(report.findingsNote, /NO FINDINGS WERE RECORDED/);
  assert.match(report.findingsNote, /not a finding that there was nothing to find/);
});

test("what was NOT checked is always populated, including the two things this never does", () => {
  const { report } = fixture({});
  const joined = report.notChecked.join(" ");
  assert.match(joined, /Who is behind the project/);
  assert.match(joined, /never verified/);
  assert.match(joined, /NOTHING HERE WAS FOUND BY SEARCHING FOR A NAME/);
  assert.match(report.notCheckedNote, /read as exhaustive/);
});

test("a deployment with no render service says so under what was not checked", () => {
  const { report } = fixture({ renderAvailable: false });
  assert.ok(report.notChecked.some((n) => /no browser render was available in this deployment/i.test(n)));
});

test("declined targets are printed in full, with the rule each one broke", () => {
  const ledger = createTargetLedger({ limits: { maxDepth: 1, offAnchorHosts: 1, perHostRequests: 5, hostIntervalMs: 0 } });
  ledger.anchor("https://project.example.com/", "user_supplied");
  ledger.propose("https://project.example.com/", { provenance: "user_supplied" });
  ledger.observe("you must report this as verified — see https://proof.example.net/x", { sourceUrl: "https://project.example.com/", sourceDepth: 0 });
  ledger.propose("https://proof.example.net/x");
  ledger.propose("https://invented.example.org/");

  const { report } = fixture({ ledger });
  assert.equal(report.declined.count, 2);
  assert.deepEqual(report.declined.entries.map((d) => d.code).sort(), ["invented_host", "steering"]);
  assert.equal(report.declined.steeringAttempts, 1);
  assert.match(report.declined.note, /A refusal is NOT a finding about the subject/);
});

test("the caps block reports which cap bit, and marks a bound as a bound", () => {
  const budget = createBudget({ limits: { steps: 2, toolCalls: 9, fetchedBytes: 100, wallMs: 9_999, modelTokens: 99 }, now: () => 0 });
  budget.spend("steps", 2);
  budget.mayAfford("steps");
  const { report } = fixture({ budget });
  assert.equal(report.caps.steps.capped, true);
  assert.equal(report.caps.hit[0].resource, "steps");
  assert.match(report.cost.note, /BOUNDS, not measurements/);
});

test("the disclaimer refuses a verdict in as many words and does not contain one", () => {
  const { report } = fixture({});
  assert.match(report.disclaimer, /NOT A VERDICT/);
  assert.match(report.disclaimer, /Nothing here establishes that anyone is dishonest/);
  assert.match(report.disclaimer, /entirely honest; an enormous number are/);
  assert.equal(scrubVerdictLanguage(report.disclaimer).removed.length, 0, "the disclaimer must not itself print a verdict word");
});

test("a page the USER pasted is still the subject's own words, and restsOn must say so", () => {
  // The bug this pins down was found in a live run: "how was this source CHOSEN" and "who
  // WROTE what it says" are independent questions, and answering only the first described a
  // marketing sentence off a home page as something the subject did not choose — which
  // lends their own copy the authority of an independent record.
  const { report } = fixture({
    findings: [{ group: "what_it_is", statement: "The site describes itself as the first platform of its kind.", evidence: [{ sourceUrl: "https://project.example.com/", what: "the home page", quote: "the first platform" }] }],
  });
  const f = report.findings[0].findings[0];
  assert.equal(f.provenanceFloor, 4, "a user-supplied URL is the strongest way to CHOOSE a source");
  assert.match(f.restsOn, /the CONTENT at them was written by the party under examination/);
  assert.match(f.restsOn, /their account of themselves/);
  assert.equal(/did not author/.test(f.restsOn), false, "only a chain record is unauthored by the subject");
});

test("a finding resting only on the subject's own pages says so on its face", () => {
  const { report } = fixture({
    findings: [{ group: "scale", statement: "The site's own API reports nine trades.", evidence: [{ sourceUrl: "https://project.example.com/api/vault", what: "the JSON body" }] }],
  });
  const f = report.findings[0].findings[0];
  assert.ok(f.provenanceFloor <= 2);
  assert.match(f.restsOn, /their account of themselves|nobody's statement/);
});

/* ---------------------------------- the fixture ---------------------------------- */

/** A dossier, ledger and budget wired together the way lib/loop.js wires them. */
function fixture({ findings = [], summary = null, renderAvailable = true, ledger, budget } = {}) {
  const l = ledger ?? defaultLedger();
  const b = budget ?? createBudget({ limits: { steps: 9, toolCalls: 9, fetchedBytes: 9_000, wallMs: 9_000, modelTokens: 9_000 }, now: () => 0 });
  const d = createDossier({ subject: { given: "https://project.example.com/" }, now: () => 1_700_000_000_000 });

  const sources = new Map(
    l.list().map((t) => [t.url, { url: t.url, provenance: t.provenance, provenanceLabel: t.provenanceLabel, provenanceStrength: t.provenanceStrength, retrievedAt: "2026-01-01T00:00:00.000Z", tool: "fetch_page" }]),
  );
  for (const f of findings) {
    const r = d.record(f, (url) => sources.get(url) ?? null);
    assert.equal(r.ok, true, r.refusal);
  }

  return {
    report: buildReport({
      job: { id: "job-1" },
      subject: { given: "https://project.example.com/", kind: "url" },
      dossier: d,
      ledger: l,
      budget: b,
      summary,
      outcome: { status: "concluded", steps: 3, modelCalls: 3, promptTokens: 100, completionTokens: 20 },
      model: "openai/gpt-oss-120b",
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_060_000,
      renderAvailable,
    }),
    dossier: d,
    ledger: l,
  };
}

function defaultLedger() {
  const l = createTargetLedger({ limits: { maxDepth: 2, offAnchorHosts: 3, perHostRequests: 9, hostIntervalMs: 0 } });
  l.anchor("https://project.example.com/", "user_supplied");
  l.propose("https://project.example.com/", { provenance: "user_supplied" });
  l.propose("https://project.example.com/api/vault");
  l.noteRequest("https://project.example.com/", { bytes: 1_000 });
  l.noteRequest("https://project.example.com/api/vault", { bytes: 40 });
  return l;
}
