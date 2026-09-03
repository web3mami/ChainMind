import { userAgent } from "../../../lib/safe-fetch.js";

/**
 * EVERY KNOB THIS SERVICE HAS, AND EVERY CAP THE LOOP RUNS UNDER, IN ONE PLACE.
 *
 * WHY THE CAPS LIVE HERE AND NOT BESIDE THE CODE THAT SPENDS THEM. This service runs an
 * AGENTIC LOOP: a model decides what to look at next from what it has already found. That
 * is the feature, and it is also the failure mode — a loop with a model in it burns time,
 * tokens and somebody else's bandwidth, and it does so at a rate nobody chose. Caps spread
 * across nine modules are caps nobody can add up. One frozen object is a budget a reader
 * can total, and lib/budget.js is the ledger that spends it and reports which one bit.
 *
 * HOW THIS SERVICE'S THREAT MODEL DIFFERS FROM services/render's, because the difference
 * decides what it is allowed to hold.
 *
 *   services/render RUNS THE INVESTIGATED PARTY'S JAVASCRIPT. It therefore holds exactly
 *   one credential — its own shared secret — so that a full renderer compromise yields the
 *   ability to render a page and nothing else.
 *
 *   THIS SERVICE NEVER EXECUTES THIRD-PARTY CODE. It makes HTTP requests through
 *   lib/safe-fetch.js, reads the bytes, and asks a model about them. There is no
 *   browser in this process; when a page needs one, this service CALLS services/render
 *   over HTTP and the browser stays over there. That is what makes it defensible for this
 *   process to hold a Groq key, the store credentials and the render shared secret: the
 *   hostile code and the credentials are in different containers, and they stay that way.
 *   A future change that puts playwright in this package would break that separation and
 *   is the wrong change.
 *
 * WHAT IT STILL MUST NOT HOLD: any chain WRITE key, any wallet, any signing key, any
 * Vercel or Railway token. The GitHub token, if set, is read-only and public-scope — it
 * exists to raise an anonymous rate limit, not to reach anything private.
 *
 * Server-side only: no React. Never throws.
 */

/** Read an integer from the environment, or the default when it is absent or junk. */
function intFrom(env, name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/**
 * The shortest shared secret this service will start with — the same rule and the same
 * number as services/render/lib/config.js, because it is the same kind of door. Length is
 * the only property of a secret that can be checked honestly, so it is the one enforced.
 */
export const MIN_SECRET_CHARS = 32;

/**
 * THE WHOLE BUDGET OF ONE INVESTIGATION, and why each number is what it is.
 *
 * These are not defensive noise. Each one is a resource somebody else pays for, and the
 * report says which of them ran out — a job that hit a cap says so, in the result, rather
 * than quietly returning a smaller answer that reads like a complete one.
 *
 * STEPS 14. A step is one model turn that may call tools. The reference investigation this
 * feature exists to reproduce had roughly this shape: read the site, read its API, find the
 * GitHub org, list the repos, count the commits, read one source file, grep the tree,
 * conclude. Eight to eleven decisions. 14 leaves room for a wrong turn and a recovery, and
 * is small enough that a loop stuck in a rut costs minutes rather than an afternoon.
 *
 * TOOL_CALLS 44 against those 14 steps: roughly three per step, which is what a step that
 * reads three files at once actually costs. It is a SEPARATE cap from steps because a
 * single step can emit many calls, and "14 steps" would otherwise bound nothing.
 *
 * FETCHED_BYTES 12MB. lib/safe-fetch.js caps ONE response at 512KB, so this is the cap on
 * the whole investigation — about two dozen full-size reads. It is what stops a loop that
 * has found a large repository from downloading it.
 *
 * WALL_MS 7 minutes. The product promise is "minutes, not seconds": submit, work, deliver.
 * Seven is long enough for 14 steps of model latency plus real network, and short enough
 * that a wedged job is noticed by a person rather than by a bill.
 *
 * MODEL_TOKENS 320,000 prompt+completion together. Measured against the shape of this
 * loop: the transcript grows every round because each tool result stays in it, so token
 * spend is quadratic in steps, not linear. This is the cap that actually binds on a long
 * investigation, and it is reported in the cost block for exactly that reason.
 *
 * PER_HOST_REQUESTS 24 and HOST_INTERVAL_MS 900. POLITENESS, and it is not optional: this
 * loop points at a third party's server and decides for itself how many times to hit it.
 * A per-host ceiling plus a minimum gap between requests is the difference between a
 * diligence read and a small denial of service. robots.txt is honoured separately, by
 * lib/site-analysis.js robotsGate, which the fetch and probe tools both go through.
 *
 * OFF_ANCHOR_HOSTS 3 and MAX_DEPTH 2 are the WANDER CAP — see lib/targets.js. They bound
 * how far the investigation may travel from what the user actually asked about, which is
 * the cap that exists for a security reason rather than an economic one.
 */
export const RESEARCH_LIMITS = Object.freeze({
  STEPS: 14,
  TOOL_CALLS: 44,
  FETCHED_BYTES: 12_000_000,
  WALL_MS: 7 * 60_000,
  MODEL_TOKENS: 320_000,
  PER_HOST_REQUESTS: 24,
  HOST_INTERVAL_MS: 900,
  OFF_ANCHOR_HOSTS: 3,
  MAX_DEPTH: 2,
  /** One probe of one JSON endpoint. Smaller than a page cap because an API answer that
   *  needs half a megabyte is not an answer anybody is going to quote. */
  PROBE_BYTES: 256_000,
  /** One source file out of a repository. Above this the file is reported by size and
   *  NOT read: a minified bundle is not evidence, it is ballast. */
  REPO_FILE_BYTES: 192_000,
  /** How long a job may sit in the queue before it is answered rather than started. */
  QUEUE_WAIT_MS: 2 * 60_000,
  /** A running job writes a heartbeat at least this often. */
  HEARTBEAT_MS: 10_000,
  /** Past this much silence a "running" job is reported ABANDONED, never finished. */
  HEARTBEAT_STALE_MS: 60_000,
  /** How long a finished result stays readable. */
  RESULT_TTL_MS: 24 * 3_600_000,
  /** Output tokens for one model turn. */
  MAX_TURN_TOKENS: 1_400,
});

/**
 * Read the whole configuration, or say exactly what is missing.
 *
 * Returns `{ ok: false, problems: [...] }` rather than throwing, so server.js can print
 * every problem at once. A deployer who has to restart four times to discover four missing
 * variables is a deployer who will guess at the fifth.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ ok: true, config: object } | { ok: false, problems: string[] }}
 */
export function readConfig(env = process.env) {
  const problems = [];

  const secret = typeof env.RESEARCH_SHARED_SECRET === "string" ? env.RESEARCH_SHARED_SECRET.trim() : "";
  if (!secret) {
    problems.push(
      "RESEARCH_SHARED_SECRET is not set. This service will not start without it: an unauthenticated research service is a machine that will point this host's IP at any URL a stranger names, for minutes at a time, and bill somebody else's model account for it. Generate one with `node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"`.",
    );
  } else if (secret.length < MIN_SECRET_CHARS) {
    problems.push(
      `RESEARCH_SHARED_SECRET is ${secret.length} characters, under the ${MIN_SECRET_CHARS}-character minimum. Length is the only property of a secret that can be checked honestly, so it is the one that is enforced.`,
    );
  }

  const groqKey = String(env.GROQ_API_KEY ?? env.GEOQ_API_KEY ?? "").trim();
  if (!groqKey) {
    problems.push(
      "GROQ_API_KEY is not set. The loop IS a model deciding what to look at next; without a model there is no investigation to run, only a fetcher. Refusing to start rather than serving jobs that can never make progress.",
    );
  }

  if (problems.length) return { ok: false, problems };

  const renderUrl = String(env.RENDER_SERVICE_URL ?? "").trim().replace(/\/+$/, "");
  const renderSecret = String(env.RENDER_SHARED_SECRET ?? "").trim();

  return {
    ok: true,
    config: Object.freeze({
      secret,
      port: intFrom(env, "PORT", 8090, { min: 1, max: 65_535 }),
      // Same default as lib/ask-runner.js, and for the same reason: Groq removed
      // llama-3.3-70b-versatile on or before 3 September 2026 and every call to it
      // is a 404. Kept as a literal here rather than imported because this service
      // deploys on its own and must not pull the web app's module graph.
      model: String(env.GROQ_MODEL ?? "").trim() || "openai/gpt-oss-120b",
      /**
       * WHETHER THE BROWSER LEG EXISTS AT ALL, as a fact this service can state rather
       * than a failure it discovers. A deployment with no render service can still do
       * everything else; what it must never do is read a JavaScript-built page as a shell
       * and report the shell's emptiness as a finding about somebody's project. The
       * `render_page` tool is simply not offered when this is false, and the report's
       * notChecked list says why.
       */
      renderUrl: renderUrl || null,
      renderSecret: renderSecret || null,
      renderAvailable: Boolean(renderUrl && renderSecret),
      /**
       * READ-ONLY, PUBLIC-SCOPE, AND OPTIONAL. GitHub's anonymous API allows 60 requests
       * an hour per IP, which one investigation can exhaust; a token raises that to 5,000.
       * It is the ONLY thing this service sends to github.com, it is never sent anywhere
       * else, and a token with any write scope on it is a mistake — see README.md.
       */
      githubToken: String(env.RESEARCH_GITHUB_TOKEN ?? "").trim() || null,
      /**
       * The workers this process runs. ONE by default and that is deliberate: each job
       * holds a transcript, fetched bytes and a model conversation, and two of them in
       * 512MB of container is how a Railway service gets OOM-killed mid-investigation —
       * which loses the work and, worse, leaves a job that a poller cannot distinguish
       * from one still thinking. The heartbeat is what makes that detectable; a low
       * concurrency is what makes it rare.
       */
      workers: intFrom(env, "RESEARCH_WORKERS", 1, { min: 1, max: 4 }),
      maxQueued: intFrom(env, "RESEARCH_MAX_QUEUED", 24, { min: 1, max: 500 }),
      limits: Object.freeze({
        ...RESEARCH_LIMITS,
        steps: intFrom(env, "RESEARCH_MAX_STEPS", RESEARCH_LIMITS.STEPS, { min: 1, max: 60 }),
        toolCalls: intFrom(env, "RESEARCH_MAX_TOOL_CALLS", RESEARCH_LIMITS.TOOL_CALLS, { min: 1, max: 200 }),
        fetchedBytes: intFrom(env, "RESEARCH_MAX_FETCHED_BYTES", RESEARCH_LIMITS.FETCHED_BYTES, { min: 100_000, max: 200_000_000 }),
        wallMs: intFrom(env, "RESEARCH_WALL_MS", RESEARCH_LIMITS.WALL_MS, { min: 10_000, max: 30 * 60_000 }),
        modelTokens: intFrom(env, "RESEARCH_MAX_MODEL_TOKENS", RESEARCH_LIMITS.MODEL_TOKENS, { min: 1_000, max: 5_000_000 }),
        perHostRequests: intFrom(env, "RESEARCH_PER_HOST_REQUESTS", RESEARCH_LIMITS.PER_HOST_REQUESTS, { min: 1, max: 200 }),
        hostIntervalMs: intFrom(env, "RESEARCH_HOST_INTERVAL_MS", RESEARCH_LIMITS.HOST_INTERVAL_MS, { min: 0, max: 30_000 }),
        offAnchorHosts: intFrom(env, "RESEARCH_OFF_ANCHOR_HOSTS", RESEARCH_LIMITS.OFF_ANCHOR_HOSTS, { min: 0, max: 20 }),
        maxDepth: intFrom(env, "RESEARCH_MAX_DEPTH", RESEARCH_LIMITS.MAX_DEPTH, { min: 0, max: 6 }),
      }),
      /**
       * The same honest, contactable user-agent every other leg of this product uses. A
       * diligence tool that reads a third party's pages while pretending to be a browser
       * is indistinguishable from the scrapers operators block; this one wants to be
       * identifiable so it CAN be blocked if unwanted. See lib/safe-fetch.js userAgent.
       */
      userAgent: userAgent(),
    }),
  };
}
