# ChainMind research service

A **bounded agentic investigation** behind one authenticated endpoint. Submit a URL or a
contract address; poll; collect a structured, sourced report.

It runs for **minutes, not seconds**. It is a **separate Railway deployment** from
`services/render` and from the Next.js app on Vercel.

---

## Why it exists, measured against what already ships

`lib/site-analysis.js` `analyzeSite` fetches **one page, twice** — the second read only to
compare responses for liveness — strips it, and extracts metadata, claims, contradictions,
infrastructure and domain age. One page, one pass, inside a **24-second** request budget.

It cannot probe an endpoint it was not given, cannot read a repository, cannot search
source, and — the real difference — **cannot decide what to look at next**.

The human investigation this service reproduces was a **loop**:

| the analyst did | one-shot analysis | this service |
|---|---|---|
| hit `/health`, `/api/markets`, `/api/platform-stats`, `/api/vault`, `/api/burn`, `/api/config` and quoted their JSON | ✗ — no endpoint it was not handed | `probe_endpoint` |
| found the project's GitHub org, counted commits across three repos and dated them | ✗ | `repo_overview`, `repo_commits` |
| read `src/chain.js` and quoted its comments verbatim | ✗ | `repo_file` |
| **grepped the whole repo** and established it contains exactly **one** Ethereum address — a zero placeholder — proving there is no exchange contract despite the marketing | ✗ | `repo_search`, and only when it comes back `complete` |
| decided each of those *after* the previous one | ✗ — a bounded pass has no next step | the loop |

The GitHub org only became worth reading **after** the site mentioned it. Grepping for
addresses only made sense **after** the absence of an exchange contract became a suspicion.
That ordering is the feature.

### Two real runs

**The full loop.** `https://htmx.org/` — a page, a repository found in an `href`, and the
grep step that is the whole point:

```
$ GROQ_API_KEY=… node scripts/investigate.mjs https://htmx.org/

[step 1] -> fetch_page    https://htmx.org/
[step 2] -> repo_overview https://github.com/bigskysoftware/htmx
[step 3] -> repo_tree     bigskysoftware/htmx
[step 4] -> repo_commits  bigskysoftware/htmx
[step 5] -> repo_search   bigskysoftware/htmx
[step 6] -> repo_file     bigskysoftware/htmx
[step 7] -> conclude                          (record_finding ×6 alongside)

outcome   concluded after 7 steps in 56s
findings  6 across 4 groups
targets   2 reached; the repository read 4 times —
          "repository record read", "file tree read: 671 files",
          "at least 300 commits", "searched 60 file(s), INCOMPLETE"
cost      7 model calls, 65,352 tokens, 2.7 MB fetched
caps hit  none
```

Two lines there are the honesty discipline working. `at least 300 commits` — the walk hit
its page cap, so the count is a **floor** and the model wrote it as one. `searched 60
file(s), INCOMPLETE` — the search did not read every file, so `complete: false`, and the
model's own finding says *"found 0 matches in 60 files, but the search was not complete"*
rather than *"the repository does not contain it"*.

**The boundary firing.** `https://csl.fun/` — a live memecoin site:

```
[step 1] -> fetch_page    https://csl.fun/
[step 2] -> repo_overview https://github.com/csl-fun/     ← REFUSED, invented host
[step 3] -> fetch_page    https://docs.csl.fun
[step 4] -> chain_facts   0x664f813ba5568966b8c7aaa03ef2218658a57777
[step 5-8] -> record_finding ×4
[step 9] -> conclude

outcome   concluded after 9 steps in 34s
findings  4 across 3 groups
targets   2 reached of 2 proposed; 1 declined
cost      9 model calls, 66,059 tokens, 54,643 bytes, 2 requests to the site
caps hit  none
```

Step 2 is the interesting line. The model guessed a GitHub organisation from the domain
name — `github.com/csl-fun` — and **nothing in the evidence named it**, so it was refused
and the refusal is printed in the report. A host produced from a model's own weights is a
claim about the world wearing the costume of a lookup, and following it would put a
stranger's repository into a report about somebody else. Compare step 2 of the htmx run,
where the repository was in the page's markup and was followed with provenance
`found_in_content` at depth 1.

Both reports separate what the chain says from what the site says. From csl.fun:

> **[scale]** *The CSL token has 58 holders, with 69.22% of the token held by the top 10.*
> `restsOn:` Every source behind this finding is a chain record — what was deployed, by
> whom, and when. Nobody wrote it for a reader, and it is the only class of evidence in
> this report that the subject did not author.

> **[what_it_is]** *The site claims to be a platform for trading CS:2 skins on Robinhood
> Chain.*
> `restsOn:` The sources behind this finding were chosen by the user or declared on chain,
> so the subject did not pick where to look — but the CONTENT at them was written by the
> party under examination. Read the words as their account of themselves.

---

## The endpoints

### `POST /research`

```
Authorization: Bearer $RESEARCH_SHARED_SECRET
Content-Type: application/json

{ "subject": "https://example.com/", "idempotencyKey": "optional", "requestedBy": "optional" }
```

Answers in milliseconds with `202`:

```jsonc
{ "ok": true, "status": "queued", "deduped": false,
  "id": "1f0c…", "poll": "/research/1f0c…",
  "subject": { "given": "https://example.com/", "kind": "url" },
  "wallMs": 420000, "reading": "Queued. Poll the URL above; a report takes minutes, not seconds." }
```

A **retry of the same subject returns the same job**, with `deduped: true` — the same third
party is not read twice for one question asked twice. Pass your own `idempotencyKey` to
force a genuinely fresh run.

### `GET /research/<id>`

```jsonc
{ "ok": true, "id": "1f0c…",
  "status": "queued | running | done | failed | abandoned | expired",
  "terminal": false, "reading": "…",
  "progress": { "step": 4, "findings": 2, "lastTool": "repo_search" },
  "report": null }
```

`status` is **derived from the record and the clock**, never read back from storage. See
*A crashed job must not look like a finished one* below.

### `GET /healthz`

Unauthenticated and leaks nothing — no secret, no subjects, no targets.

```json
{ "ok": true, "service": "chainmind-research", "queued": 0, "workers": 1, "active": 0,
  "model": "openai/gpt-oss-120b", "renderAvailable": true,
  "githubToken": "configured", "uptimeMs": 20848, "node": "v22.17.0" }
```

---

## The tools the loop gets, and why the set stops there

| tool | what it is for |
|---|---|
| `fetch_page` | one page as its **server** sends it — the whole `lib/site-analysis.js` pipeline per page |
| `render_page` | one page as a **browser** sees it, via `services/render`. Offered only when that service is configured |
| `probe_endpoint` | one API endpoint, **and its response body** |
| `repo_overview` / `repo_tree` / `repo_file` / `repo_commits` | a public repository: what exists, when, by whom |
| `repo_search` | **grep the whole repository** — the only tool here that can establish an absence |
| `chain_facts` | `lib/project-profile.js`: launchpad provenance by behaviour, age, market, holders, bundle clustering, links declared in the launch calldata |
| `record_finding` | write an observation into the dossier. **Refused without a citation this run can verify** |
| `conclude` | stop, with an explicit list of what was not checked |

There is **no search engine, no social-media reader, and no "find this project's website by
name"**. That last omission is permanent: reporting on a business that merely shares a name
with a token would be a claim about the wrong people.

### Reading response bodies, when the render service deliberately does not

`services/render/lib/outcome.js` says, of a page's XHR calls: *"Response bodies are the
investigated party's content and would multiply the size of the evidence without adding a
fact the page text does not already carry."* Both halves are true **there** and neither is
true **here**, and the reason is **who chose the URL**.

- **In the render service** the requests are chosen by the page's own JavaScript. The set is
  unbounded and the investigated party picks it; capturing those bodies would mean storing
  arbitrary content from arbitrary addresses nobody asked for. Counting hosts answers the
  question that matters there — *is something answering behind this page* — at a fraction of
  the size and none of the exposure.
- **Here** the URL is **one** address, named in a tool call, screened by `lib/targets.js`
  with its provenance recorded, gated on the site's own `robots.txt`, rate-limited per host,
  charged against the byte cap, and printed in the report beside whatever is quoted from it.
  It is the same act as `fetch_page` — an anonymous HTTP GET of one public URL — differing
  only in that the answer is JSON rather than HTML.

And it is **the evidence the whole feature exists for**: *one trader, nine trades, a
liquidity vault holding three dollars* are figures quoted out of `/api/platform-stats` and
`/api/vault`. A tool that could see those endpoints answer but not what they said would
reproduce the shape of the reference investigation and none of its content.

There is still **no POST, no body, no cookies, no credentials and no caller headers** —
`lib/safe-fetch.js` has no way to send any of them.

---

## The boundary: a hostile page can steer a loop

In a one-shot read a hostile page could only **lie to the reader**. In a loop, page content
**decides what happens next**. `lib/targets.js` is four rules.

**1 — Everything discovered in content is re-screened, exactly as if a user had pasted it.**
The same `lib/safe-fetch.js` `validateUrl` ladder, no "we already trust this origin"
shortcut, no second implementation. Redirects are re-validated by `safeFetch` on every hop,
and a redirect landing on a **new host** is recorded here as a discovered target so the
wander cap sees it too.

**2 — Provenance travels with every target, into the report.**

| provenance | strength | means |
|---|---|---|
| `user_supplied` | 4 | the person asking named it |
| `chain_declared` | 4 | declared in the launch transaction's calldata — public, timestamped, immutable |
| `redirect` | 2 | another target redirected here; re-screened before it was followed |
| `found_in_content` | 2 | **written by the party under examination** — materially weaker |
| `model_proposed` | 1 | a path on, or subdomain of, a site already reached. A site the model invented is **refused** |

The report's `restsOn` on each finding separates two questions that are easy to conflate:
*how was this source chosen* and *who wrote what it says*. A page the **user** pasted is
still the subject's own words. Only a chain record is unauthored by the subject.

**3 — Content adds candidates, never rules.** No tool schema has a parameter for a timeout,
a byte cap, a header, a user agent, a robots override, a port, a redirect limit or a depth
allowance. There is no field through which fetched bytes could widen the boundary.
**Imperative text found in a page is a finding, never an instruction.**

**4 — The loop cannot wander far, and says what it declined.** Anchors (user + chain hosts)
are exempt; everything else spends one of `RESEARCH_OFF_ANCHOR_HOSTS` slots; depth is capped;
per-host request counts and a minimum interval bound the load on any one server.

### The steering rule

When the text that named a target **also** contained instructions addressed at an automated
reviewer, following that target is following the instruction. Such candidates are refused
with `steering` and **both** the attempt and the refusal are reported:

```jsonc
"declined": {
  "entries": [{ "url": "https://audit-proof.example.net/report.pdf", "code": "steering",
                "reason": "REFUSED, AND THE ATTEMPT IS THE FINDING. …" }],
  "steeringAttempts": 1
}
```

It is **sticky**: a URL seen once inside steering text stays refused wherever else it later
appears. A page that tries to route its own audit does not get to have the URL in the clean
paragraph honoured and the one in the hidden div refused — the whole document is doing it.

---

## The caps, and what happens when one bites

| cap | default | env |
|---|---|---|
| decision steps | 14 | `RESEARCH_MAX_STEPS` |
| tool calls | 44 | `RESEARCH_MAX_TOOL_CALLS` |
| bytes fetched | 12 MB | `RESEARCH_MAX_FETCHED_BYTES` |
| wall clock | 7 min | `RESEARCH_WALL_MS` |
| model tokens (prompt + completion) | 320,000 | `RESEARCH_MAX_MODEL_TOKENS` |
| requests per host | 24 | `RESEARCH_PER_HOST_REQUESTS` |
| minimum gap per host | 900 ms | `RESEARCH_HOST_INTERVAL_MS` |
| off-anchor hosts | 3 | `RESEARCH_OFF_ANCHOR_HOSTS` |
| discovery depth | 2 | `RESEARCH_MAX_DEPTH` |

**A job that hits a cap says so.** The report's `caps` block names the resource, the figure
and the ceiling, marks each resource `capped: true|false`, and reads:

> *THIS INVESTIGATION STOPPED AT A CAP, NOT AT AN ANSWER. … Everything the loop had not
> reached is UNEXAMINED, and an unexamined thing is not an absent one.*

Token spend is **quadratic in steps**, not linear — the transcript grows every round because
each tool result stays in it. On a long investigation `RESEARCH_MAX_MODEL_TOKENS` is the cap
that actually binds, which is why it is in the cost block.

---

## Politeness and legality

- **`robots.txt` is honoured**, by `lib/site-analysis.js` `robotsGate`, for pages **and**
  for endpoint probes. A disallowed path is not fetched and the report says it was the
  operator's stated wish, not a finding about the project. The model is told not to look for
  another route to the same data.
- **Rate limited per host**, with a minimum interval and a hard request ceiling.
- **Cached**: page and render reads reuse `lib/store.js`, so the same URL asked about twice
  costs the third party once.
- **The crawler identifies itself honestly** — `lib/safe-fetch.js` `userAgent()`:
  `ChainMindBot/1.0 (+https://chainmind.fun; …)`. It wants to be identifiable so it *can* be
  blocked if unwanted.

---

## Harm

The output is a report about **identifiable people and businesses**.

- **No verdict on intent or honesty.** `scrubVerdictLanguage` redacts *scam, fraud, rug,
  LARP, ponzi, grift, swindle, con artist* and their inflections from every string the model
  authored, **whatever the prompt said** — a prompt is a request, this is a control. The
  redaction is listed in `languageScrubbed` so the edit is visible rather than silent, and
  the observation underneath is kept. `honeypot` is deliberately **not** on the list: it
  names a checkable contract behaviour, not a conclusion about a person.
- **Every finding carries its evidence and its source.** `record_finding` refuses a citation
  to a URL this run never fetched — refuses, not downgrades. Rejections are printed under
  `rejectedClaims`, because a reader is entitled to know the check exists and that it fired.
- **Anonymous founders, a young domain, a small vault and a launchpad deployment are facts.**
  Each is how an enormous number of honest, early projects look. None is framed otherwise.
- **Missing data is never zero, an outage is never an absence, a bound is never exact.** A
  commit count that hit the page cap is `countIsFloor: true` and reads *"at least N"*. A
  repository search that did not read every file comes back `complete: false` and states that
  **no absence may be asserted from it in any wording**.

---

## A crashed job must not look like a finished one

A worker killed for memory, a container redeployed mid-run, a process that panicked — each
leaves a record saying `running` that nothing will ever touch again.

- A running job writes a **heartbeat** every 10 s. Silence past 60 s means the worker is
  gone, and the job is reported **`abandoned`** — named, terminal, and honest that *how far
  it got is unknown*.
- The status a caller sees is **derived** by a pure function of the record and the clock, so
  a stale `running` cannot survive being read.
- **The status and the report are written in one value.** There is no instant at which a job
  says `done` and has nothing under it.
- The **wall-clock cap is enforced from both ends**: the loop stops itself, and a job past
  its deadline that is still heartbeating is reported as over-running — a bug a reader can
  see beats one they cannot.
- A **partial report travels on a failed or abandoned job**. Evidence really gathered is not
  thrown away because the run did not finish; the status is what stops it being read as
  complete.
- A submission that cannot be **recorded** is refused rather than started: a job nobody can
  poll is a job that has silently failed.

---

## Security

**This process never executes third-party code.** It fetches bytes through
`lib/safe-fetch.js`, reads them, and asks a model about them. When a page needs a browser it
**calls `services/render` over HTTP** and the browser stays over there.

That is what makes it defensible for this process to hold a Groq key, the store credentials,
the render shared secret and an optional read-only GitHub token, when the render service
holds exactly one secret and nothing else: **the hostile code and the credentials live in
different containers.**

> **The line that must not be crossed:** no browser in this package. A future `playwright`
> dependency here would put the investigated party's JavaScript in the process holding every
> credential, and would undo the whole separation. `services/research/Dockerfile` says the
> same thing where somebody adding a dependency will read it.

- **SSRF** is `lib/safe-fetch.js`, unchanged and not reimplemented, applied to every target
  including discovered ones and every redirect hop.
- **The GitHub token is read-only and public-scope.** It exists to raise the anonymous
  60-requests-per-hour limit to 5,000. A token with any write scope is a mistake, not a
  convenience. It is sent to `api.github.com` and `raw.githubusercontent.com` and nowhere
  else — both are **constants in the source**; only path segments vary, and those are
  shape-checked before they are encoded into a URL.
- **The door** is `services/render/lib/auth.js`, *imported* rather than copied: one
  timing-safe secret comparison in this repository, not two. The service refuses to boot
  without a ≥ 32-character secret rather than defaulting to open.
- **One replica.** `lib/store.js` exposes no lock strong enough to stop two workers claiming
  one job, and inventing one on top of `INCREMENT` would be a lock whose failure mode is
  silent. `startJob` narrows rather than pretending to lock, and the queue order lives in
  this process. **Do not raise `numReplicas` without adding a real lock first.**

---

## Deploying to Railway

Everything is in the repository. **You need a Railway account to do this; I cannot create
services or credentials.** Follow it literally.

### 1. Generate the secret

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### 2. Create the service

1. **Railway → your project → New → GitHub Repo →** `millw14/ChainMind`.
   (Use the **same Railway project** as the render service so private networking works.)
2. **Settings → Source → Root Directory:** leave it `/` (the repository root).
   This is required, not cosmetic: the Docker build context must include the root `lib/` and
   `config/` so the service imports the *real* modules instead of copies that would drift.
3. **Settings → Build → Config-as-code path:** `services/research/railway.json`.
   If Railway shows Nixpacks, set **Builder: Dockerfile** and **Dockerfile Path:**
   `services/research/Dockerfile` by hand.
4. **Settings → Deploy → Health Check Path:** `/healthz`, timeout `60`. Already in
   `services/research/railway.json`.
5. **Settings → Networking → Generate Domain.** Note the `…up.railway.app` hostname.
6. **Settings → Resources:** memory **1 GB**, `numReplicas` **1** (see *Security* above).

### 3. Variables

Set these on the **research** service:

| variable | required | default | what it does |
|---|---|---|---|
| `RESEARCH_SHARED_SECRET` | **yes** | — | the door. ≥ 32 chars or the service will not boot |
| `GROQ_API_KEY` | **yes** | — | the model. Without it there is no loop, only a fetcher, so it refuses to boot |
| `UPSTASH_REDIS_REST_URL` | **yes** | — | the job store. Same value as the Vercel app |
| `UPSTASH_REDIS_REST_TOKEN` | **yes** | — | same value as the Vercel app |
| `RENDER_SERVICE_URL` | no | — | the render service, e.g. `http://render.railway.internal:8080` (private) or its public domain |
| `RENDER_SHARED_SECRET` | no | — | **the render service's** secret — a different value from `RESEARCH_SHARED_SECRET` |
| `RESEARCH_GITHUB_TOKEN` | no | — | a **read-only, public-scope** GitHub token. `Settings → Developer settings → Personal access tokens → Fine-grained → Public repositories (read-only)`, no account permissions, no repository permissions |
| `GROQ_MODEL` | no | `openai/gpt-oss-120b` | |
| `PORT` | no | `8090` | Railway sets this itself |
| `RESEARCH_WORKERS` | no | `1` | concurrent investigations in this process. Raise memory with it |
| `RESEARCH_MAX_QUEUED` | no | `24` | over it, `503 at_capacity` |
| `RESEARCH_MAX_STEPS` | no | `14` | see the caps table |
| `RESEARCH_MAX_TOOL_CALLS` | no | `44` | |
| `RESEARCH_MAX_FETCHED_BYTES` | no | `12000000` | |
| `RESEARCH_WALL_MS` | no | `420000` | |
| `RESEARCH_MAX_MODEL_TOKENS` | no | `320000` | |
| `RESEARCH_PER_HOST_REQUESTS` | no | `24` | |
| `RESEARCH_HOST_INTERVAL_MS` | no | `900` | |
| `RESEARCH_OFF_ANCHOR_HOSTS` | no | `3` | the wander cap |
| `RESEARCH_MAX_DEPTH` | no | `2` | |
| `SAFE_FETCH_USER_AGENT` | no | `ChainMindBot/1.0 (…)` | honest and contactable on purpose |

**Nothing else.** In particular there is no variable that weakens TLS verification, skips
`robots.txt`, or raises the wander cap from a request body, and none should be added.

### 4. Point the app at it (two variables, on **Vercel**)

The service is useless until the Next.js app can reach it. These go in the **Vercel**
project's environment — not on the Railway service — and they are the app's half of the
same pair:

| variable | required | what it does |
|---|---|---|
| `RESEARCH_SERVICE_URL` | **yes** | the service's public `…up.railway.app` domain, **no trailing slash**. Checked the way `lib/render-client.js` checks its own service — our infrastructure, so a private hostname on a non-default port is allowed and the cloud metadata endpoint is not |
| `RESEARCH_SHARED_SECRET` | **yes** | **the same value** as on the Railway service, and a **different** value from `RENDER_SHARED_SECRET` |
| `RESEARCH_DAILY_JOBS` | no (default `1`) | deep investigations per UTC day for a signed-in caller who is not a verified holder. `0` switches the tier off |
| `RESEARCH_HOLDER_DAILY_JOBS` | no (default `5`) | the same for a verified holder. **A number, not "unlimited"**: the cost of a runaway lands on a third party's server, and a token balance is not their consent to be crawled |

Private networking does **not** work here: Vercel is not on Railway's network, so this must
be the public domain. The shared secret is the door.

**With neither of the first two set, the app behaves exactly as it did before this service
existed and says so.** `GET /api/research` answers `configured: false` with a sentence, the
ask path reports that *this deployment* cannot run one — never that a project could not be
investigated — and no control appears that would fail when pressed. `GET /api/health`
carries the same fact under `research`.

What the app adds on its side, and what it deliberately does not:

- **Sign-in is required.** A job has an owner: `lib/research-job.js` writes a record of which
  wallet started which id, and `/research/<id>` will not show a report to anybody else. The
  service itself knows nothing about wallets and should not — it is handed a shortened
  address as `requestedBy` for its log and nothing more.
- **The allowance is charged AFTER the job actually starts.** A service that is down, at
  capacity or misconfigured costs the caller nothing.
- **Polling is not metered.** The daily number buys the investigation; charging again for
  looking at the result would only punish the person waiting.
- **A question can start one.** `lib/research-intent.js` reads "full diligence on …",
  "investigate … properly", "is this a larp <url>" as a request for a job — and never turns
  a NAME into a target, because reporting on a business that merely shares a name with a
  token would be reporting on the wrong people.

### 5. Verify the deploy

```bash
curl https://<research>.up.railway.app/healthz

ID=$(curl -s -X POST https://<research>.up.railway.app/research \
  -H "Authorization: Bearer $RESEARCH_SHARED_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"subject":"https://example.com/"}' | node -pe "JSON.parse(require('fs').readFileSync(0)).id")

curl -s https://<research>.up.railway.app/research/$ID \
  -H "Authorization: Bearer $RESEARCH_SHARED_SECRET" | node -pe "
    const j = JSON.parse(require('fs').readFileSync(0));
    j.status + ' — ' + j.reading"
```

Poll every 10–20 seconds. `queued` → `running` → `done`.

---

## Running it locally

```bash
cd services/research
npm install

# one investigation, no server, no queue — prints the decision trail to stderr
# and the report to stdout
GROQ_API_KEY=… node scripts/investigate.mjs https://example.com/
GROQ_API_KEY=… RESEARCH_MAX_STEPS=6 node scripts/investigate.mjs 0x…

# the full service
RESEARCH_SHARED_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))") \
GROQ_API_KEY=… node server.js
```

`scripts/investigate.mjs` reads the repository's `.env.local` for anything not already in
the environment (exported values win). It is the runbook tool as well as the demo: the run
quoted at the top of this file is reproducible with one command.

---

## Tests

```bash
npm test          # from the repository root — runs the app's suite AND this service's
```

75 tests, **fully offline**: no network, no store, no model, no API key. The model client and
the four fetchers are injected, `lib/store.js`'s in-memory adapter backs the queue, and the
GitHub transport is a fake.

What they pin down:

- **target screening and re-screening** — a URL discovered in content meets the same ladder a
  pasted one does, including metadata endpoints, loopback, credentials-in-URL and
  non-default ports;
- **provenance labelling** — decided from the evidence, not from what a caller claims;
- **the injection path** — a page telling the loop to fetch elsewhere is reported as a
  finding, refused as a target, and the refusal is printed in the report; steering is sticky;
- **cap enforcement** — every resource stops the work, reports itself once, and marks a bound
  as a bound;
- **job lifecycle including a crashed worker** — abandoned, expired, over-running,
  idempotency, and a store that will not answer;
- **completeness** — a repository search that did not read everything forbids stating an
  absence, and a commit count that hit its page cap is a floor;
- **the report shape** — every section exists, verdict words are redacted, and what was not
  checked is always populated.
