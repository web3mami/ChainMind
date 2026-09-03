import { NextResponse } from "next/server";
import { getChainConfig, getPublicClient } from "@/lib/chain.js";
import { gateStatus } from "@/lib/entitlement.js";
import { DEFAULT_MODEL, resolveModel } from "@/lib/ask-runner.js";
import { freeDailyAllowance } from "@/lib/quota.js";
import { researchAllowance, RESEARCH_TIER } from "@/lib/research-access.js";
import { researchServiceStatus } from "@/lib/research-client.js";
import { isSessionConfigured } from "@/lib/session.js";
import { storeStatus } from "@/lib/store.js";

export const maxDuration = 10;
export const runtime = "nodejs";

// A health check that outlives its own maxDuration is useless: the 503 it
// exists to emit never reaches the monitor. One RPC attempt, no retries, and a
// hard deadline well inside the 10s budget.
const RPC_TIMEOUT_MS = 3_000;
const DEADLINE_MS = 8_000;

function deadline(ms) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`RPC health check exceeded ${ms}ms.`)), ms);
  });
}

/**
 * What the app is standing on for state, without opening a connection.
 *
 * Reported here because the memory adapter's damage is invisible in normal
 * operation: everything responds 200 while quotas count per-instance and sign-in
 * nonces go missing between lambdas. A startup log line can scroll away; this is
 * the page an operator actually loads when something is odd.
 *
 * It does NOT change the status code. Liveness here means "can this process reach
 * the chain" — the explorer answers questions with no store at all, and a monitor
 * paging someone at 3am over a feature that is merely unconfigured is a monitor
 * people learn to ignore.
 */
function statefulFeatures() {
  const store = storeStatus();
  return {
    store: {
      driver: store.driver,
      durable: store.durable,
      shared: store.shared,
      timeoutMs: store.timeoutMs,
      ...(store.warnings.length ? { warnings: store.warnings } : {}),
    },
    // SAID SEPARATELY, IN ONE WORD, BECAUSE IT IS THE THING THAT GOES WRONG
    // SILENTLY. "driver: memory" only means "quotas are decorative" to someone
    // who already knows that; `enforced: false` means it to everyone. A quota
    // that looks enforced while counting per instance is worse than no quota,
    // because nobody goes looking for it.
    // THE OTHER THING THAT FAILS WITHOUT ANYONE NOTICING. A model that stops
    // being served answers 404, the tool loop throws, and lib/ask-runner.js
    // degrades to keyword routing — by design, because degrading beats failing.
    // But that degradation is invisible from outside: the site keeps answering,
    // just worse, and the only trace is one console.warn per request. Groq
    // decommissioned llama-3.1-8b-instant on 16 August 2026, so this is a real
    // way to end up serving a downgraded product for weeks. Naming the model in
    // force is what makes it a thirty-second diagnosis instead of a mystery.
    model: {
      configured: Boolean(process.env.GROQ_API_KEY),
      name: resolveModel(),
      overridden: resolveModel() !== DEFAULT_MODEL,
      ...(process.env.GROQ_API_KEY
        ? {}
        : {
            hint:
              "GROQ_API_KEY is not set, so every question is answered by the keyword router rather than the model. " +
              "The site still works and still reads the chain; the answers are the narrower ones it gave before the model existed.",
          }),
    },
    quota: {
      enforced: store.enforced,
      freeDaily: freeDailyAllowance(),
      ...(store.enforced
        ? {}
        : {
            hint:
              "The daily free-question limit is NOT enforced: no shared counter is configured, so each instance counts on its own. " +
              "Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (nothing to install) or STORE_DATABASE_URL with `pg` installed.",
          }),
    },
    // Deep investigations, because "not configured" is a STATE this product is supposed
    // to say out loud rather than a button that quietly does nothing. A rejected setting
    // is reported separately from an absent one: they have the same effect and entirely
    // different fixes.
    research: (() => {
      const status = researchServiceStatus();
      if (status.configured) {
        return {
          configured: true,
          dailyJobs: {
            signedIn: researchAllowance(RESEARCH_TIER.SIGNED_IN),
            holder: researchAllowance(RESEARCH_TIER.HOLDER),
          },
        };
      }
      return {
        configured: false,
        ...(status.problem ? { error: status.problem } : {}),
        hint:
          status.problem ??
          `${status.missing ?? "RESEARCH_SERVICE_URL and RESEARCH_SHARED_SECRET"} not set; deep investigations are unavailable and the app says so in words. See services/research/README.md.`,
      };
    })(),
    walletSignIn: isSessionConfigured()
      ? { configured: true }
      : { configured: false, hint: "SESSION_SECRET is not set; wallet sign-in is disabled." },
    // The gate, because "nobody can be verified as a holder" is invisible from the
    // outside: the app answers 200, sign-in works, and every single visitor is
    // quietly capped at the free allowance. The token and threshold are public by
    // nature (they are on chain), so there is nothing here worth withholding.
    tokenGate: (() => {
      const gate = gateStatus();
      return gate.configured
        ? { configured: true, token: gate.token, minTokens: gate.minTokens, freeDaily: freeDailyAllowance() }
        : {
            configured: false,
            freeDaily: freeDailyAllowance(),
            hint:
              gate.error ??
              "GATE_TOKEN_ADDRESS is not set; nobody can be verified as a holder and everyone gets the free daily allowance.",
          };
    })(),
  };
}

/**
 * GET liveness — confirms the app can reach Robinhood Chain over JSON-RPC.
 * Point UptimeRobot / healthchecks.io here. 200 while the RPC responds with
 * the expected chain id; 503 if the RPC is unreachable, slow or mismatched.
 */
export async function GET() {
  const cfg = getChainConfig();
  try {
    const client = getPublicClient({ timeout: RPC_TIMEOUT_MS, retryCount: 0 });
    const [chainId, blockNumber] = await Promise.race([
      Promise.all([client.getChainId(), client.getBlockNumber()]),
      deadline(DEADLINE_MS),
    ]);
    const ok = chainId === cfg.id;
    return NextResponse.json(
      {
        ok,
        network: cfg.name,
        chainId,
        expectedChainId: cfg.id,
        blockNumber: blockNumber.toString(),
        ...statefulFeatures(),
        ...(ok ? {} : { hint: "RPC chain id does not match the configured network." }),
      },
      { status: ok ? 200 : 503 },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, network: cfg.name, ...statefulFeatures(), error: String(e?.message ?? e) },
      { status: 503 },
    );
  }
}
