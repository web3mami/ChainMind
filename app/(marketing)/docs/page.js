import Link from "next/link";

import { CAPABILITY_GROUPS } from "@/lib/docs-capabilities";

export const metadata = {
  title: "Docs",
  description:
    "What ChainMind can be asked about Robinhood Chain, what each answer means, what it deliberately will not do, and how to run your own instance.",
};

/* -------------------------------------------------------------------------- */
/* Content                                                                    */
/*                                                                            */
/* Held as data rather than inline JSX: the page is long, and a list that can  */
/* be read top to bottom is the only way a claim on it stays checkable against */
/* the code it describes. Every figure here is measured — see the section it   */
/* sits in for where. Nothing on this page is rounded up.                      */
/* -------------------------------------------------------------------------- */

const CHAIN_ISSUER = "0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046";
const V4_POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";

/** Anchors, in reading order. Drives the index and nothing else. */
const SECTIONS = [
  { id: "ask", label: "What you can ask" },
  { id: "research", label: "Deep investigations" },
  { id: "reading", label: "How to read an answer" },
  { id: "limits", label: "What it will not do" },
  { id: "accounts", label: "Accounts & limits" },
  { id: "operator", label: "Running your own" },
];

/** The four facts a reader wants before anything else. */
const FACTS = [
  { k: "Chain", v: "Robinhood Chain · id 4663" },
  { k: "Architecture", v: "Arbitrum Orbit rollup · ETH gas" },
  { k: "Tokenized equities", v: "94 in the 2026-07-24 snapshot" },
  { k: "Lookups", v: "26, all read live" },
];

/**
 * The capability groups the "What you can ask" section renders.
 *
 * Held in lib/docs-capabilities.js rather than here so a TEST can read them: the
 * page tells a reader which lookups answer each phrasing, and
 * test/routing-corpus.test.mjs fails if a phrasing listed here has no measured
 * row in scripts/routing-corpus.mjs or routes outside the group it sits in. A
 * page that promises behaviour the router does not deliver is the same class of
 * defect as an answer that promises data the chain does not have.
 */
const GROUPS = CAPABILITY_GROUPS;

/**
 * The deep-research half. Written as rule + consequence, because every one of these is
 * a limit somebody will otherwise discover by being surprised by it.
 */
const RESEARCH_RULES = [
  {
    title: "It is a job, not an answer",
    body: "A question is answered inside 24 seconds. An investigation runs for minutes: it reads a page, then decides what to look at next from what it found — a repository named in the markup, an API endpoint, the chain record — and keeps going until it has something to say or hits a cap. You get an id and a link; the report appears there when it is done. Nothing waits on it, and the chain half of your answer arrives immediately either way.",
  },
  {
    title: "Every source says how it was reached",
    body: "A URL you pasted, a link declared on chain in the launch transaction, a link found in the project's own marketing and a path the model guessed at are four different strengths of evidence, and the report prints which on every line. A finding resting only on the subject's own pages is labelled as the subject's account of itself, whatever its figures are.",
  },
  {
    title: "A page cannot steer the investigation",
    body: "Content decides what happens next, so a page that says “full audit at …” is proposing a target. Every discovered URL is re-screened exactly as if you had pasted it, and one named in the same text as instructions addressed at an automated reviewer is refused outright — with the attempt and the refusal both printed. Imperative text found in a page is a finding, never an instruction.",
  },
  {
    title: "It will not find a project by name",
    body: "The subject is a URL or a 0x address and nothing else. There is no search engine and no “find this project's website”, permanently: reporting on a business that merely shares a name with a token would be reporting on the wrong people.",
  },
  {
    title: "A run that stopped at a cap says so",
    body: "Steps, tool calls, bytes fetched, wall clock and model tokens all have ceilings, all are printed, and any figure that hit one is shown as a bound rather than a measurement. A repository search that did not read every file cannot be used to state an absence, and a commit count that ran out of pages reads “at least N”.",
  },
  {
    title: "Findings with sources, never a verdict",
    body: "The report will not print scam, fraud, rug or LARP as a conclusion — the words are redacted from anything the model wrote, whatever the prompt said, and the redaction is listed so the edit is visible. Anonymous founders, a young domain, a small treasury and a launchpad deployment are facts a reader weighs. None of them is evidence of dishonesty and none is framed as such.",
  },
  {
    title: "Politeness is not optional",
    body: "robots.txt is honoured for pages and for endpoint probes; a disallowed path is not fetched and the report says that was the operator's stated wish rather than a finding. Requests are rate-limited per host, reads are cached so one question costs a third party once, and the crawler identifies itself honestly so it can be blocked if it is not wanted.",
  },
  {
    title: "Signing in, and a small daily number",
    body: "A job is attached to a wallet: only the wallet that started one can read its report. Non-holders get one a day by default and verified holders five — capped rather than unlimited, because the cost of a runaway lands on somebody else's server and a token balance is not their consent. Where no research service is configured, the app says so plainly instead of offering a button that cannot work.",
  },
];

/**
 * The section this product exists for. Each entry pairs a rule with the measured
 * number that makes it concrete — an abstract caveat is one nobody remembers.
 */
const READINGS = [
  {
    title: "Market cap is not what you could sell into",
    body: "A cap is supply times a quoted price. Realisable depth is capital actually sitting in the pool, read from the chain. On this chain they routinely differ by orders of magnitude.",
    figure:
      "A contract called “The Robinhood” carried 52,214 holders and a $3,855,217 notional cap with $1.03 of realisable depth behind it — about 3.7 million×. Of eighteen VLAD contracts surveyed, exactly one had more than $100 of realisable depth.",
  },
  {
    title: "“At least” means a floor, and it is deliberate",
    body: "Where a read is paginated or sampled, the figure it produces is a lower bound and the wording says so. A floor is never quietly promoted to a total.",
    figure:
      "Search reads one page and says “at least N … never say these are all of them”. A hold time reads “at least 42 days”. A co-holdings row carries its denominator — “2 of the 3 probed holders” — rather than a percentage of holders.",
  },
  {
    title: "Missing is not zero, and an outage is not an absence",
    body: "Two different gaps travel with every answer and are never merged. `unavailable` names a source that was asked and did not answer. `budgetNotice` names one that was never asked, because the request would have been killed before it returned.",
    figure:
      "The notice is a finished sentence: “These reads were skipped to keep this answer inside its time limit: … They are UNKNOWN — not zero, not empty, and not a finding that there is nothing there.”",
  },
  {
    title: "A pool is not a holder",
    body: "Balance-ranked lists contain the token's Uniswap pool, the burn address and often the token contract itself. The pool's balance is liquidity and the burn address's balance is supply that is gone.",
    figure:
      `Uniswap v4 keeps every pool on the chain inside one PoolManager (${V4_POOL_MANAGER}), so a single unlabelled row can be every v4 pool at once. Excluded addresses are listed with their role rather than dropped.`,
  },
  {
    title: "A router is not the trader",
    body: "The address that called the pool is a router or aggregator in almost every swap, and one router fronts dozens of unrelated wallets. A row with no named wallet is unnamed — not anonymous, and not the router.",
    figure: "Measured on one token: a single router address was behind 212 of 213 swaps.",
  },
  {
    title: "Only the deployer proves a tokenized equity",
    body: "A name and a ticker are free. The one mark of an official token is that Robinhood's issuer deployed it, which is why a safety check prints both addresses in full.",
    figure: `Every genuine tokenized equity in the snapshot was deployed by ${CHAIN_ISSUER}. Official names follow one convention — “NVIDIA • Robinhood Token” is NVDA. 229 distinct contracts on this chain use the symbol VLAD.`,
  },
  {
    title: "A collision verdict says how much of the field was read",
    body: "When several contracts wear one ticker, at most four get their pool measured, and four separate quantities travel with the result: attempted, measured, failed and dropped. A dropped candidate is unmeasured, which is not the same as shallow.",
    figure:
      "A live run: 4 measured of the 33 rows the explorer returned, verdict dominant, $1,324.23 of band depth against $0.31. The verdicts a reader can see are dominant, uncorroborated, shallow, partial and unmeasured.",
  },
  {
    title: "Fees here are not tiers",
    body: "A Uniswap v4 fee is charged per swap and a hook can set it, so it is quoted as charged and never rounded toward a familiar tier. A v4 pool has no contract address — only a 32-byte pool id.",
    figure:
      "Fees of 0%, 0.01%, 1%, 1.1%, 5.1%, 10.65% and 99.81% were all charged on real trades in one recent window.",
  },
  {
    title: "Observations are not verdicts, and a quiet window is not a clearance",
    body: "Concentration, co-acquisition and repeated shapes are facts about the data. Wash trading, sniping and front-running are claims about intent, and nothing in a transfer or a swap log separates a market maker, a bot rebalancing, one desk filling an order in slices, and somebody trading with themselves.",
    figure:
      "An airdrop, a contract migration, a team allocation and a bought sniper bundle all leave exactly the same co-acquisition shape. Equally, finding nothing is not a clearing: a sole liquidity provider round-tripping its own pool pays the fee to itself, so the pattern is cheap to produce and cheap to avoid.",
  },
];

/** The four fixed checks flag_patterns runs, with the thresholds as exported. */
const PATTERN_ROWS = [
  ["Near-identical amounts", "3 or more transfers within 1% of each other, inside a 30-minute window"],
  ["Dominant holder", "one address holding 50% or more of supply"],
  ["One-way distribution", "5 or more receivers fed by 2 or fewer senders"],
  ["Tight clustering", "5 or more transfers inside a 5-minute window"],
];

/** Stated plainly. `kind` decides whether it reads as a choice or as a gap. */
const NOT_DOING = [
  {
    kind: "By design",
    title: "No verdict on intent",
    body: "It will not tell you a token is a scam, that volume is wash traded, that somebody front-ran you or that a wallet sniped a launch. Those are claims about knowledge and intent that a transfer log cannot carry. You get the measurements and the denominators instead.",
  },
  {
    kind: "By design",
    title: "No advice, no targets, no predictions",
    body: "It never recommends buying, selling or holding, gives no price targets, and does not compare a tokenized equity to the underlying stock as an investment case.",
  },
  {
    kind: "By design",
    title: "No facts about people",
    body: "Founders, teams, CEOs, company history, funding, investors and roadmaps are off-chain. They are not in the snapshot and not in any lookup, and the answer says so rather than substituting a market overview.",
  },
  {
    kind: "By design",
    title: "No URL it was not given",
    body: "A project profile reads the chain. It will examine a site only when you paste the URL, or when you ask it to look at a link the launch transaction itself declared — and a declared link stays labelled as self-declared. It never guesses a site from a token's name.",
  },
  {
    kind: "Gap",
    title: "No alerts, watchlists or notifications",
    body: "Every answer is a question you asked, in the moment you asked it. Nothing runs in the background and nothing is pushed to you.",
  },
  {
    kind: "Gap",
    title: "No price history and no charts",
    body: "Figures are current. There is no series to plot, no “price 30 days ago”, and no backtest.",
  },
  {
    kind: "Choice",
    title: "Profit and loss only when it can be proven",
    body: "Profit is worked out for one wallet in one token, in ETH, from the trades themselves — a swap prices itself, so no price feed is involved. It is realised profit on closed trades, before gas; unrealised gains on a position still open are not computed. And the figure is withheld outright whenever it cannot be proven: a history longer than could be read, or tokens that arrived with no purchase to price. A truncated history is not reported as “at least”, because the part not read holds purchases and sales both. An airdrop has no cost rather than a cost of zero, so free tokens are never reported as pure profit. You always get the trades; you get the total only when it is real.",
  },
  {
    kind: "Gap",
    title: "No mempool",
    body: "This reads settled blocks on a sequencer-ordered L2. A transaction appearing earlier in a block proves it was ordered earlier and nothing about whether anyone saw another transaction — so ordering is reported as ordering, and never as front-running or sandwiching.",
  },
  {
    kind: "Gap",
    title: "No simulation and no honeypot test",
    body: "It never signs, sends or simulates a trade to see what would happen. It reads what already happened. A sell tax or a transfer restriction is not tested for.",
  },
  {
    kind: "Scope",
    title: "One chain",
    body: "Robinhood Chain only — mainnet 4663, with testnet 46630 selectable by the operator. No Solana, no Ethereum mainnet, no cross-chain view. An address is looked up here or not at all.",
  },
  {
    kind: "Gap",
    title: "No complete impostor list",
    body: "The explorer search is paginated and at most 25 rows come back, so a ticker with 229 contracts behind it can never be enumerated. That bound is stated in the answer rather than papered over.",
  },
];

const ENV_ROWS = [
  ["GROQ_API_KEY", "Required", "Answers the questions. Nothing is answered without it."],
  [
    "NEXT_PUBLIC_APP_URL",
    "Required for sign-in",
    "The domain baked into the signed message. It is never read from a Host header — that would let a caller pick the domain a victim signs. Unset, /api/auth/nonce and /api/auth/verify return 503 and nobody can sign in.",
  ],
  [
    "SESSION_SECRET",
    "Required for sign-in",
    "Signs the session cookie. Minimum 32 characters, no development default. Rotating it invalidates every session.",
  ],
  [
    "UPSTASH_REDIS_REST_URL + _TOKEN",
    "Required in production",
    "Where nonces, quota counters and saved history live. With no store configured, production fails closed on every stateful feature; /api/health reports quota.enforced false. STORE_DATABASE_URL is the postgres alternative — the driver is not bundled, so it needs npm install pg and fails closed without it.",
  ],
  [
    "ROBINHOOD_NETWORK",
    "Optional",
    "mainnet (chain 4663, the default) or testnet (chain 46630).",
  ],
  [
    "ROBINHOOD_RPC_URL / ALCHEMY_*",
    "Optional",
    "A dedicated RPC for higher limits. Precedence is ROBINHOOD_RPC_URL, then ALCHEMY_RPC_URL, then template + key, then the public RPC. No hostname is ever guessed.",
  ],
  [
    "BLOCKSCOUT_API_URL / _API_KEY",
    "Optional",
    "Override the indexer host or add a Pro key to raise rate limits.",
  ],
  [
    "GATE_TOKEN_ADDRESS / GATE_TOKEN_MIN",
    "Optional",
    "The token and whole-token threshold that lift the daily limit. Unset means no gate: nobody can be verified as a holder, so every visitor gets the free allowance.",
  ],
  ["FREE_DAILY_QUESTIONS", "Optional", "Free questions per UTC day for everyone who is not a verified holder. Default 5; 0 makes the gate a hard paywall."],
  [
    "HISTORY_ENABLED / _MAX_ITEMS / _TTL_MS",
    "Optional",
    "Saved history on or off, how many entries one wallet keeps (default 50, store ceiling 500) and how long an entry survives (default 90 days).",
  ],
  [
    "RENDER_SERVICE_URL + RENDER_SHARED_SECRET",
    "Optional, both or neither",
    "The browser render service. With neither set, the client reports “not configured” and says in words that the absence is a fact about this deployment and not about any site.",
  ],
  [
    "RESEARCH_SERVICE_URL + RESEARCH_SHARED_SECRET",
    "Optional, both or neither",
    "The deep-research service. With neither set, deep investigations are not offered at all: /api/research answers configured false, the ask path says this deployment cannot run one, and no button appears that would fail when pressed. The secret is a different value from the render service's.",
  ],
  [
    "RESEARCH_DAILY_JOBS / RESEARCH_HOLDER_DAILY_JOBS",
    "Optional",
    "Deep investigations per UTC day for a signed-in caller and for a verified holder. Defaults 1 and 5. Metered separately from questions, and capped for holders too — a job is minutes of somebody else's bandwidth, and a token balance is not their consent to be crawled. 0 switches off one tier without switching off the other.",
  ],
  [
    "TRUSTED_PROXY_HOPS / TRUSTED_IP_HEADER",
    "Optional",
    "How the caller's IP is derived. X-Forwarded-For is a list each proxy appends to, so the entry that means anything is counted from the right. Default 1 hop, which is the truth on Vercel, Railway, Fly and Render.",
  ],
];

const ENDPOINT_ROWS = [
  ["POST /api/ask", "The question. Guards, budget, lookups and the streamed answer."],
  ["GET /api/health", "Liveness, plus which stateful features are actually configured."],
  ["GET /api/quota", "What this caller has left today, and why."],
  ["GET /api/mobile/config", "Remote switches for the iOS app (walletFeatures and friends)."],
  ["POST /api/auth/nonce · /verify", "Issue a single-use challenge; redeem a signature for a session."],
  ["GET /api/auth/session · POST /api/auth/logout", "Read the current session; end it."],
  ["GET · POST · DELETE /api/history", "A signed-in wallet's saved questions. Delete means delete."],
  ["GET · POST /api/research", "Whether deep investigations are available here and what you have left; start one."],
  ["GET /api/research/[id]", "Poll one investigation and collect its report. Readable only by the wallet that started it."],
];

/* -------------------------------------------------------------------------- */
/* Small presentational pieces                                                */
/* -------------------------------------------------------------------------- */

function Eyebrow({ children }) {
  return (
    <p className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-widest text-cm-faint">
      {children}
    </p>
  );
}

function Section({ id, eyebrow, title, lede, children }) {
  return (
    <section id={id} className="scroll-mt-28 border-t border-cm-border-subtle pt-12 sm:pt-16">
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 className="mt-3 text-2xl font-bold tracking-tight text-cm-text sm:text-3xl">{title}</h2>
      {lede ? <p className="mt-4 max-w-2xl text-base leading-relaxed text-cm-muted">{lede}</p> : null}
      {children}
    </section>
  );
}

/** A question the way somebody actually types it. Mono, wrapped, never truncated. */
function Ask({ children }) {
  return (
    <li className="flex gap-2 font-[family-name:var(--font-mono)] text-[12px] leading-relaxed text-cm-subtle">
      <span aria-hidden="true" className="select-none text-cm-accent-dim">
        &rsaquo;
      </span>
      <span className="min-w-0 break-words">{children}</span>
    </li>
  );
}

/**
 * Tool names, shown so a reader can match an answer back to what ran. `mt-auto`
 * pins them to the bottom of a stretched card so the row lines up.
 */
function ToolTags({ names }) {
  return (
    <ul className="mt-auto flex flex-wrap gap-1.5 pt-5">
      {names.map((name) => (
        <li
          key={name}
          className="border border-cm-border-subtle bg-cm-bg px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[10px] text-cm-faint"
        >
          {name}
        </li>
      ))}
    </ul>
  );
}

/** Wide content scrolls inside its own box — the page itself never does. */
function Scroller({ children }) {
  return <div className="mt-6 overflow-x-auto border border-cm-border">{children}</div>;
}

/* -------------------------------------------------------------------------- */

export default function DocsPage() {
  return (
    <div className="border-b border-cm-border-subtle bg-cm-hero">
      {/* pt clears the floating header, which is absolutely positioned so the
          landing hero can run full-bleed underneath it. */}
      <div className="mx-auto w-full max-w-6xl px-4 pb-20 pt-28 sm:px-6 sm:pb-28 sm:pt-32">
        <header className="max-w-3xl">
          <Eyebrow>Documentation</Eyebrow>
          <h1 className="mt-3 text-3xl font-bold tracking-tight text-cm-text sm:text-4xl">
            What ChainMind answers, and what each answer means
          </h1>
          <p className="mt-4 text-base leading-relaxed text-cm-muted sm:text-lg">
            ChainMind is an AI explorer for Robinhood Chain — the Arbitrum Orbit L2 (chain id 4663, ETH gas) where
            Robinhood issues tokenized equities. You type a question in any phrasing or language, it reads the chain and
            the indexer live, and it answers with the figures plus the bounds on them.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-cm-muted">
            This page is the reference. For the three-step version of how a question becomes an answer, read the{" "}
            <Link href="/how-it-works" className="font-medium text-cm-text underline-offset-4 hover:underline">
              guide
            </Link>
            .
          </p>

          <dl className="mt-8 grid grid-cols-1 gap-px border border-cm-border bg-cm-border sm:grid-cols-2">
            {FACTS.map((f) => (
              <div key={f.k} className="bg-cm-elevated px-4 py-3">
                <dt className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-widest text-cm-faint">
                  {f.k}
                </dt>
                <dd className="mt-1 text-sm text-cm-subtle">{f.v}</dd>
              </div>
            ))}
          </dl>
        </header>

        <div className="mt-14 lg:grid lg:grid-cols-[12rem_minmax(0,1fr)] lg:items-start lg:gap-14">
          {/* Index. A wrapped list on phones, a sticky rail from lg up. */}
          <nav
            aria-label="On this page"
            className="border border-cm-border bg-cm-elevated/50 p-4 lg:sticky lg:top-28 lg:border-0 lg:bg-transparent lg:p-0"
          >
            <p className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-widest text-cm-faint">
              On this page
            </p>
            <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-2 lg:flex-col lg:gap-2">
              {SECTIONS.map((s) => (
                <li key={s.id}>
                  <a
                    href={`#${s.id}`}
                    className="text-sm text-cm-muted transition-colors hover:text-cm-text"
                  >
                    {s.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="mt-12 space-y-12 lg:mt-0 sm:space-y-16">
            {/* ------------------------------ ASK ------------------------------ */}
            <Section
              id="ask"
              eyebrow="Capabilities"
              title="What you can ask"
              lede="Twenty-six lookups, grouped the way a question arrives rather than the way the code is filed. Every example below is a phrasing the router was built against — you do not have to clean up your wording, name a tool, or know a ticker."
            >
              <div className="mt-10 grid grid-cols-1 gap-px border border-cm-border bg-cm-border xl:grid-cols-2">
                {GROUPS.map((g) => (
                  <div key={g.id} className="cm-panel-edge flex flex-col bg-cm-elevated/60 p-5 sm:p-6">
                    <h3 className="text-base font-semibold text-cm-text">{g.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-cm-muted">{g.lede}</p>
                    <ul className="mt-4 space-y-1.5">
                      {g.asks.map((a) => (
                        <Ask key={a}>{a}</Ask>
                      ))}
                    </ul>
                    <p className="mt-5 border-t border-cm-border-subtle pt-4 text-[13px] leading-relaxed text-cm-muted">
                      <span className="font-medium text-cm-subtle">The bound: </span>
                      {g.bound}
                    </p>
                    <ToolTags names={g.tools} />
                  </div>
                ))}
              </div>

              <div className="mt-8 border border-cm-border bg-cm-card p-5 sm:p-6">
                <h3 className="text-sm font-semibold text-cm-text">When a question has two readings, it asks you back</h3>
                <p className="mt-2 text-sm leading-relaxed text-cm-muted">
                  &ldquo;Who is the main benefactor of this coin&rdquo; can mean the largest holder, the deployer who
                  minted it, or the address that has taken the most out. Rather than silently picking one, ChainMind returns one short
                  question and two to four pressable options, worded in your own voice and your own language. It will not
                  do this when a sensible default exists, when both readings are cheap to answer, over spelling or
                  phrasing, or twice in a row.
                </p>
              </div>

              <div className="mt-6 border border-cm-border bg-cm-card p-5 sm:p-6">
                <h3 className="text-sm font-semibold text-cm-text">The four pattern checks, and their thresholds</h3>
                <p className="mt-2 text-sm leading-relaxed text-cm-muted">
                  Fixed, explainable and published, so a finding can be argued with. An empty result is a real answer:
                  the checks ran and flagged nothing, which is not a failed lookup.
                </p>
                <Scroller>
                  <table className="w-full min-w-[26rem] text-left text-xs sm:text-sm">
                    <thead className="border-b border-cm-border bg-cm-row">
                      <tr>
                        <th className="px-3 py-2 font-semibold uppercase tracking-wide text-cm-faint">Check</th>
                        <th className="px-3 py-2 font-semibold uppercase tracking-wide text-cm-faint">Fires when</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-cm-border text-cm-muted">
                      {PATTERN_ROWS.map(([name, rule]) => (
                        <tr key={name}>
                          <td className="px-3 py-2 text-cm-subtle">{name}</td>
                          <td className="px-3 py-2">{rule}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Scroller>
              </div>
            </Section>

            {/* ---------------------------- RESEARCH --------------------------- */}
            <Section
              id="research"
              eyebrow="Diligence"
              title="When a question wants an investigation"
              lede="“Check this project out properly”, “full diligence on X”, “is this a larp — https://…” are asking for something a 24-second budget cannot produce: one page, one pass, and no way to decide what to look at next. Those questions can start a bounded investigation instead — the chain half answered now, the web half delivered as a sourced report minutes later."
            >
              <ol className="mt-10 space-y-px border border-cm-border bg-cm-border">
                {RESEARCH_RULES.map((r, i) => (
                  <li key={r.title} className="bg-cm-elevated/60 p-5 sm:p-6">
                    <div className="flex gap-4">
                      <span
                        aria-hidden="true"
                        className="font-[family-name:var(--font-mono)] text-[11px] tabular-nums text-cm-accent-dim"
                      >
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <div className="min-w-0">
                        <h3 className="text-base font-semibold text-cm-text">{r.title}</h3>
                        <p className="mt-2 text-sm leading-relaxed text-cm-muted">{r.body}</p>
                      </div>
                    </div>
                  </li>
                ))}
              </ol>

              <div className="mt-8 border border-cm-border bg-cm-card p-5 sm:p-6">
                <h3 className="text-sm font-semibold text-cm-text">What the report is made of</h3>
                <p className="mt-2 text-sm leading-relaxed text-cm-muted">
                  Findings grouped and each carrying its evidence, every source with the URL it came from and how that
                  URL became a target; everything the run actually read; everything it refused to follow and which rule
                  each one broke; what it did not check, stated as loudly as what it did; and what it cost, in model
                  calls, tokens and bytes of somebody else&apos;s bandwidth. Anything quoted from the subject is marked
                  as the subject&apos;s own words rather than set in the report&apos;s voice.
                </p>
              </div>
            </Section>

            {/* ---------------------------- READING ---------------------------- */}
            <Section
              id="reading"
              eyebrow="Interpretation"
              title="How to read an answer"
              lede="This chain punishes a figure read at face value. 94 tokenized equities were deployed by one issuer, byte-identical impostors circulate beside them, holder counts are airdrop-cheap and liquidity is rentable. Every rule below exists because of something measured on chain 4663."
            >
              <ol className="mt-10 space-y-px border border-cm-border bg-cm-border">
                {READINGS.map((r, i) => (
                  <li key={r.title} className="bg-cm-elevated/60 p-5 sm:p-6">
                    <div className="flex gap-4">
                      <span
                        aria-hidden="true"
                        className="font-[family-name:var(--font-mono)] text-[11px] tabular-nums text-cm-accent-dim"
                      >
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <div className="min-w-0">
                        <h3 className="text-base font-semibold text-cm-text">{r.title}</h3>
                        <p className="mt-2 text-sm leading-relaxed text-cm-muted">{r.body}</p>
                        <p className="mt-3 border-l border-cm-accent-dim pl-4 text-[13px] leading-relaxed text-cm-subtle">
                          {r.figure}
                        </p>
                      </div>
                    </div>
                  </li>
                ))}
              </ol>

              <div className="mt-8 border border-cm-border bg-cm-card p-5 sm:p-6">
                <h3 className="text-sm font-semibold text-cm-text">Why answers are bounded in time</h3>
                <p className="mt-2 text-sm leading-relaxed text-cm-muted">
                  The platform kills a request at 30 seconds. Six of those are held back for everything outside the
                  handler and seven more are reserved for writing the answer, which leaves lookups 17 seconds. That
                  bound is not arbitrary: measured cold on this chain, a memecoin ticker took 49.0s end to end and a
                  ticker collision 31.3s — both of which the platform answered with a bare 504 that discarded every
                  second of work already done.
                </p>
                <p className="mt-3 text-sm leading-relaxed text-cm-muted">
                  So a stage that cannot fit is not started, and the skip is reported in the answer rather than left to
                  look like a finding. A degraded honest answer beats a gateway timeout. Depth probes are bounded the
                  same way — at most four contracts in a ticker collision get their pool read, and four concurrent
                  probes already cost 8.0 seconds, 16 HTTP requests and 211 JSON-RPC calls.
                </p>
              </div>
            </Section>

            {/* ---------------------------- LIMITS ----------------------------- */}
            <Section
              id="limits"
              eyebrow="Scope"
              title="What it will not do"
              lede="Some of these are choices and some are gaps. They are labelled, because dressing a gap as a principle is the same overclaiming this product exists to avoid."
            >
              <div className="mt-10 grid grid-cols-1 gap-px border border-cm-border bg-cm-border sm:grid-cols-2">
                {NOT_DOING.map((n) => (
                  <div key={n.title} className="bg-cm-elevated/60 p-5">
                    <p
                      className={`font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-widest ${
                        n.kind === "Gap" ? "text-cm-bad" : "text-cm-faint"
                      }`}
                    >
                      {n.kind}
                    </p>
                    <h3 className="mt-2 text-sm font-semibold text-cm-text">{n.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-cm-muted">{n.body}</p>
                  </div>
                ))}
              </div>

              <p className="mt-8 max-w-2xl text-sm leading-relaxed text-cm-muted">
                And the standing caveat: answers are AI-generated from public on-chain data and can be incomplete or
                wrong. The evidence behind every answer is one click away so you can check it, and nothing here is
                financial advice.
              </p>
            </Section>

            {/* --------------------------- ACCOUNTS ---------------------------- */}
            <Section
              id="accounts"
              eyebrow="Access"
              title="Accounts, allowances & history"
              lede="The explorer works with no account at all. Signing in exists for two things: lifting the daily limit if you hold the token, and keeping your questions."
            >
              <div className="mt-10 space-y-8">
                <div className="border-l border-cm-border pl-5">
                  <h3 className="text-base font-semibold text-cm-text">Signing in is a signature, and moves no funds</h3>
                  <p className="mt-2 text-sm leading-relaxed text-cm-muted">
                    You sign a plain text message. It is never a transaction, an approval, a permit or an EIP-712
                    typed-data blob — there is no code path in the flow that touches gas or an allowance, and the signed
                    text says so itself. The challenge is single-use, expires in minutes, and is bound to your browser,
                    so a signature captured elsewhere is not a login here. Recovery only proves control of an ordinary
                    key: smart-contract wallets (ERC-1271) are rejected rather than half-supported.
                  </p>
                </div>

                <div className="border-l border-cm-border pl-5">
                  <h3 className="text-base font-semibold text-cm-text">The free allowance</h3>
                  <p className="mt-2 text-sm leading-relaxed text-cm-muted">
                    Five questions per UTC calendar day by default, for everyone who is not a verified holder. A UTC day
                    is used because the server cannot know your timezone, and &ldquo;resets at 00:00 UTC&rdquo; is a
                    promise you can check against a clock. It is a speed bump rather than an anti-abuse system: an IP is
                    shared behind a NAT and changes with a VPN hop, and a fresh wallet is free to create. What the
                    server-side identity work buys is that the limit cannot be reset by setting a header.
                  </p>
                </div>

                <div className="border-l border-cm-border pl-5">
                  <h3 className="text-base font-semibold text-cm-text">What holding the token changes</h3>
                  <p className="mt-2 text-sm leading-relaxed text-cm-muted">
                    A verified holder at or above the threshold asks without a daily limit. The balance is read by the
                    server from its own RPC client, never taken from anything the browser sends, and re-read every few
                    minutes because a holder can sell the block after signing in. There are three outcomes, not two:
                    verified at the threshold, verified below it, and{" "}
                    <em className="not-italic text-cm-subtle">could not be read</em> — and the last one keeps the free
                    allowance rather than telling a holder they own nothing.
                  </p>
                </div>

                <div className="border-l border-cm-border pl-5">
                  <h3 className="text-base font-semibold text-cm-text">History, and deleting it</h3>
                  <p className="mt-2 text-sm leading-relaxed text-cm-muted">
                    Saved only while signed in, and scoped to your address. The last 50 entries are kept: at the cap the
                    oldest drops so the newest can be saved, so a save never silently fails. Entries age out after 90
                    days. You can delete one entry or all of them, immediately, and delete means delete — there is no
                    soft-delete flag. Only the question, the answer, a label and a timestamp are stored: no IP, no user
                    agent, no session id, no evidence blob.
                  </p>
                </div>
              </div>
            </Section>

            {/* --------------------------- OPERATOR ---------------------------- */}
            <Section
              id="operator"
              eyebrow="Self-hosting"
              title="Running your own instance"
              lede="Everything above is the product. This part is only for running it, and it sits at the bottom of this page rather than on its own — it is short, it changes with the app, and the readers who arrive here from a link should not have to scroll past a table of environment variables to find out what the thing does."
            >
              <h3 className="mt-10 text-sm font-semibold uppercase tracking-wide text-cm-faint">Local</h3>
              <Scroller>
                <pre className="min-w-max px-4 py-3 font-[family-name:var(--font-mono)] text-xs leading-relaxed text-cm-subtle">
                  {[
                    "npm install",
                    "cp .env.example .env.local   # fill in the values below",
                    "npm run dev                  # http://localhost:3000",
                    "",
                    "npm test                     # unit tests, no network",
                    "npm run build && npm start   # production",
                  ].join("\n")}
                </pre>
              </Scroller>

              <h3 className="mt-10 text-sm font-semibold uppercase tracking-wide text-cm-faint">Environment</h3>
              <p className="mt-3 max-w-2xl text-sm leading-relaxed text-cm-muted">
                The full annotated list is in{" "}
                <code className="border border-cm-border bg-cm-elevated px-1 font-[family-name:var(--font-mono)] text-xs text-cm-subtle">
                  .env.example
                </code>
                . What matters most is which way each one fails: nothing here degrades quietly into a weaker version of
                itself.
              </p>
              <Scroller>
                <table className="w-full min-w-[42rem] text-left text-xs sm:text-sm">
                  <thead className="border-b border-cm-border bg-cm-row">
                    <tr>
                      <th className="px-3 py-2 font-semibold uppercase tracking-wide text-cm-faint">Variable</th>
                      <th className="px-3 py-2 font-semibold uppercase tracking-wide text-cm-faint">Status</th>
                      <th className="px-3 py-2 font-semibold uppercase tracking-wide text-cm-faint">
                        What it does, and what happens without it
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-cm-border text-cm-muted">
                    {ENV_ROWS.map(([name, status, note]) => (
                      <tr key={name}>
                        <td className="whitespace-nowrap px-3 py-2 font-[family-name:var(--font-mono)] text-[11px] text-cm-subtle">
                          {name}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-[11px] text-cm-faint">{status}</td>
                        <td className="px-3 py-2 leading-relaxed">{note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroller>

              <h3 className="mt-10 text-sm font-semibold uppercase tracking-wide text-cm-faint">Endpoints</h3>
              <Scroller>
                <table className="w-full min-w-[32rem] text-left text-xs sm:text-sm">
                  <thead className="border-b border-cm-border bg-cm-row">
                    <tr>
                      <th className="px-3 py-2 font-semibold uppercase tracking-wide text-cm-faint">Route</th>
                      <th className="px-3 py-2 font-semibold uppercase tracking-wide text-cm-faint">Role</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-cm-border text-cm-muted">
                    {ENDPOINT_ROWS.map(([route, role]) => (
                      <tr key={route}>
                        <td className="px-3 py-2 font-[family-name:var(--font-mono)] text-[11px] text-cm-subtle">
                          {route}
                        </td>
                        <td className="px-3 py-2 leading-relaxed">{role}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroller>

              <h3 className="mt-10 text-sm font-semibold uppercase tracking-wide text-cm-faint">The render service</h3>
              <p className="mt-3 max-w-2xl text-sm leading-relaxed text-cm-muted">
                A separate deployment that opens a URL in a headless browser and returns what a person would actually
                see. It exists because a plain HTTP read of a client-rendered site reads a different document than
                anybody looked at: measured through this repo, one site answered 200 with 5,782 bytes of HTML containing
                four characters of visible text; through the render service the same URL yielded 76,266 bytes and 343
                characters in 2.2 seconds.
              </p>
              <p className="mt-3 max-w-2xl text-sm leading-relaxed text-cm-muted">
                It holds one credential — the shared secret — and nothing else, on purpose: it runs a browser executing
                the investigated party&apos;s JavaScript, so it is built so that a full compromise of it yields only the
                ability to render pages. Never give it a chain key, a model key or a store credential. With it
                unconfigured, the app says the absence is a fact about this deployment and not about any site.
              </p>
            </Section>
          </div>
        </div>

        <div className="mt-16 flex flex-col gap-3 border-t border-cm-border-subtle pt-10 sm:flex-row sm:items-center">
          <Link
            href="/ask"
            className="inline-flex h-12 items-center justify-center rounded-xl bg-cm-accent px-6 text-sm font-semibold text-cm-on-accent transition hover:bg-cm-accent-bright sm:min-w-[10.5rem]"
          >
            Open the explorer
          </Link>
          <Link
            href="/stocks"
            className="inline-flex h-12 items-center justify-center rounded-xl border border-cm-border px-6 text-sm font-semibold text-cm-text transition hover:bg-cm-row-hover/50 sm:min-w-[10.5rem]"
          >
            Browse the equities
          </Link>
        </div>
      </div>
    </div>
  );
}
