// Tests for the daily quota (lib/quota.js) and the gate decision that uses it
// (lib/ask-access.js). The three things being pinned down: a verified holder is
// not counted at all, everyone else is counted SERVER-SIDE from a signed cookie,
// and an unverifiable balance neither grants unlimited access nor is treated as
// a balance of zero. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { ENTITLEMENT, UNVERIFIED_REASON } from "../lib/entitlement.js";
import {
  QUOTA_STATE,
  consumeQuestion,
  freeDailyAllowance,
  msUntilUtcReset,
  openAccess,
  peekQuota,
  quotaKey,
  quotaMessage,
  utcDayKey,
} from "../lib/quota.js";
import { clientIp } from "../lib/api-guard.js";
import { gateWorstCaseMs, publicQuota, quotaHeaders, resolveAccess } from "../lib/ask-access.js";
import { PLATFORM_MARGIN_MS } from "../lib/request-budget.js";
import { createMemoryStore, withStoreDeadline } from "../lib/store.js";
import { createSessionCookie, signPayload } from "../lib/session.js";

// Almost every test in this file asserts on COUNTING, which the open-access switch turns
// off wholesale. Left set in a developer's shell it would fail twenty-odd tests at once
// with "expected 2, got null" and nothing pointing at the cause; the tests that do want
// it set it themselves through withEnv.
delete process.env.OPEN_ACCESS;

const SECRET = "test-secret-that-is-long-enough-to-be-allowed";
const ADDRESS = "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB";
const OTHER = "0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046";

/** Run a body with a controlled set of env vars, restoring whatever was there. */
async function withEnv(vars, body) {
  const previous = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await body();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Silence the deliberate operator-facing errors while asserting on them. */
async function quiet(body) {
  const { warn, error } = console;
  console.warn = () => {};
  console.error = () => {};
  try {
    return await body();
  } finally {
    console.warn = warn;
    console.error = error;
  }
}

const entitled = { state: ENTITLEMENT.ENTITLED, symbol: "COVENANT", balanceTokens: "5000", thresholdTokens: "1000" };
const below = { state: ENTITLEMENT.BELOW, symbol: "COVENANT", balanceTokens: "12", thresholdTokens: "1000" };
const unverified = {
  state: ENTITLEMENT.UNVERIFIED,
  reason: UNVERIFIED_REASON.READ_FAILED,
  symbol: "COVENANT",
  balanceTokens: null,
  thresholdTokens: "1000",
};

/** A unique IP per test, so the process-local fallback bucket cannot leak between them. */
let ipCounter = 0;
function freshIp() {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

/* ------------------------------- the calendar ------------------------------ */

test("the day is a UTC calendar day, and the reset is an instant we can name", () => {
  const noon = Date.UTC(2026, 6, 28, 12, 0, 0);
  assert.equal(utcDayKey(noon), "2026-07-28");
  assert.equal(msUntilUtcReset(noon), 12 * 60 * 60 * 1000);

  // One minute before midnight the counter has a minute left, and the key for the
  // next minute is a different day — a rollover cannot merge two days into one.
  const late = Date.UTC(2026, 6, 28, 23, 59, 0);
  assert.equal(msUntilUtcReset(late), 60 * 1000);
  assert.notEqual(quotaKey({ ip: "1.2.3.4", now: late }).key, quotaKey({ ip: "1.2.3.4", now: late + 60_000 }).key);
});

test("the allowance is configurable, and zero is a legitimate setting", async () => {
  await withEnv({ FREE_DAILY_QUESTIONS: null }, () => assert.equal(freeDailyAllowance(), 5));
  await withEnv({ FREE_DAILY_QUESTIONS: "12" }, () => assert.equal(freeDailyAllowance(), 12));
  await withEnv({ FREE_DAILY_QUESTIONS: "0" }, () => assert.equal(freeDailyAllowance(), 0));
  await withEnv({ FREE_DAILY_QUESTIONS: "banana" }, () => assert.equal(freeDailyAllowance(), 5));
});

/* -------------------------------- the tiers ------------------------------- */

test("a verified holder is unlimited and is not counted at all", async () => {
  // A store that throws if touched: the unlimited path must cost nothing, because
  // it runs before every question a paying holder asks.
  const store = {
    async increment() {
      throw new Error("the unlimited path must not touch the store");
    },
  };
  const res = await consumeQuestion({ store, address: ADDRESS, entitlement: entitled, ip: freshIp() });
  assert.equal(res.allowed, true);
  assert.equal(res.unlimited, true);
  assert.equal(res.state, QUOTA_STATE.UNLIMITED);
  assert.equal(res.remaining, null, "unlimited has no remaining count to invent");
  assert.equal(quotaHeaders(res)["x-quota-limit"], "unlimited");
});

test("a below-threshold wallet gets the free allowance and then a 429's worth of no", async () => {
  await withEnv({ FREE_DAILY_QUESTIONS: "3" }, async () => {
    const store = createMemoryStore();
    const args = { store, address: ADDRESS, entitlement: below, ip: freshIp() };

    const first = await consumeQuestion(args);
    assert.equal(first.allowed, true);
    assert.equal(first.state, QUOTA_STATE.BELOW_THRESHOLD);
    assert.equal(first.remaining, 2);

    await consumeQuestion(args);
    const third = await consumeQuestion(args);
    assert.equal(third.allowed, true);
    assert.equal(third.remaining, 0);

    const fourth = await consumeQuestion(args);
    assert.equal(fourth.allowed, false, "the fourth question is refused");
    assert.equal(fourth.remaining, 0);

    const message = quotaMessage(fourth, below);
    assert.match(message, /12 COVENANT/, "it says what the wallet holds");
    assert.match(message, /1000/, "and what it would need");
    assert.match(message, /00:00 UTC/, "and when the allowance comes back");
  });
});

test("an UNVERIFIABLE balance grants the free allowance — not unlimited, not zero", async () => {
  await withEnv({ FREE_DAILY_QUESTIONS: "2" }, async () => {
    const store = createMemoryStore();
    const args = { store, address: ADDRESS, entitlement: unverified, ip: freshIp() };

    const first = await consumeQuestion(args);
    assert.equal(first.allowed, true);
    assert.equal(first.unlimited, false, "an outage must never hand out unlimited access");
    assert.equal(first.state, QUOTA_STATE.UNVERIFIED);
    assert.notEqual(first.state, QUOTA_STATE.BELOW_THRESHOLD, "unverified is its own state");

    await consumeQuestion(args);
    const third = await consumeQuestion(args);
    assert.equal(third.allowed, false, "and it is still bounded");

    const message = quotaMessage(third, unverified);
    assert.match(message, /could not read your token balance/i);
    assert.doesNotMatch(message, /you hold none of/i);
    assert.doesNotMatch(message, /below the/i, "an outage must not be reported as a measured shortfall");
  });
});

test("an unconfigured gate is reported as unconfigured, not as an empty wallet", async () => {
  const store = createMemoryStore();
  const res = await consumeQuestion({
    store,
    address: ADDRESS,
    entitlement: { state: ENTITLEMENT.UNVERIFIED, reason: UNVERIFIED_REASON.NOT_CONFIGURED },
    ip: freshIp(),
  });
  assert.equal(res.state, QUOTA_STATE.UNVERIFIED);
  assert.match(quotaMessage(res, { state: ENTITLEMENT.UNVERIFIED, reason: UNVERIFIED_REASON.NOT_CONFIGURED }), /not configured/i);
});

test("an anonymous caller is told what would change it, and that signing moves nothing", async () => {
  await withEnv({ FREE_DAILY_QUESTIONS: "1" }, async () => {
    const store = createMemoryStore();
    const ip = freshIp();
    await consumeQuestion({ store, ip });
    const denied = await consumeQuestion({ store, ip });
    assert.equal(denied.allowed, false);
    assert.equal(denied.state, "anonymous");

    const message = quotaMessage(denied, below);
    assert.match(message, /free question/i);
    assert.match(message, /not a transaction/i);
    assert.match(message, /cannot move funds/i);
  });
});

/* ------------------------------- the counters ----------------------------- */

test("anonymous callers are counted per IP, and two IPs do not share an allowance", async () => {
  await withEnv({ FREE_DAILY_QUESTIONS: "1" }, async () => {
    const store = createMemoryStore();
    const a = freshIp();
    const b = freshIp();
    assert.equal((await consumeQuestion({ store, ip: a })).allowed, true);
    assert.equal((await consumeQuestion({ store, ip: a })).allowed, false);
    assert.equal((await consumeQuestion({ store, ip: b })).allowed, true, "a different IP is a different bucket");
  });
});

test("a signed-in caller is counted per WALLET, wherever they ask from", async () => {
  await withEnv({ FREE_DAILY_QUESTIONS: "1" }, async () => {
    const store = createMemoryStore();
    const first = await consumeQuestion({ store, address: ADDRESS, entitlement: below, ip: freshIp() });
    assert.equal(first.allowed, true);
    // Same wallet, different network. Changing IP must not refill a wallet's day.
    const second = await consumeQuestion({ store, address: ADDRESS, entitlement: below, ip: freshIp() });
    assert.equal(second.allowed, false);
    // A different wallet is a different bucket — Sybil-able, and documented as such.
    const other = await consumeQuestion({ store, address: OTHER, entitlement: below, ip: freshIp() });
    assert.equal(other.allowed, true);
  });
});

test("the counter rolls over at midnight UTC", async () => {
  await withEnv({ FREE_DAILY_QUESTIONS: "1" }, async () => {
    const store = createMemoryStore();
    const ip = freshIp();
    const late = Date.UTC(2026, 6, 28, 23, 59, 0);
    assert.equal((await consumeQuestion({ store, ip, now: late })).allowed, true);
    assert.equal((await consumeQuestion({ store, ip, now: late })).allowed, false);
    const tomorrow = Date.UTC(2026, 6, 29, 0, 1, 0);
    assert.equal((await consumeQuestion({ store, ip, now: tomorrow })).allowed, true);
  });
});

test("a store outage degrades to the per-process floor rather than to unlimited", async () => {
  await withEnv({ FREE_DAILY_QUESTIONS: "2" }, async () => {
    await quiet(async () => {
      const store = {
        async increment() {
          throw new Error("postgres is down");
        },
      };
      const ip = freshIp();
      const first = await consumeQuestion({ store, ip });
      assert.equal(first.allowed, true);
      assert.equal(first.degraded, true, "and it SAYS the figure is approximate");
      await consumeQuestion({ store, ip });
      const third = await consumeQuestion({ store, ip });
      assert.equal(third.allowed, false, "an outage must not become an unlimited plan");
    });
  });
});

test("peeking never spends a question", async () => {
  await withEnv({ FREE_DAILY_QUESTIONS: "2" }, async () => {
    const store = createMemoryStore();
    const ip = freshIp();
    await consumeQuestion({ store, ip });

    const peeked = await peekQuota({ store, ip });
    assert.equal(peeked.used, 1);
    assert.equal(peeked.remaining, 1);

    // Reading it again reports the same thing: the read has no side effect.
    assert.equal((await peekQuota({ store, ip })).used, 1);
  });
});

test("a counter that cannot be read reports null remaining, never a fabricated zero", async () => {
  await quiet(async () => {
    const store = {
      async counter() {
        throw new Error("down");
      },
    };
    const res = await peekQuota({ store, ip: freshIp() });
    assert.equal(res.remaining, null);
    assert.equal(res.degraded, true);
    assert.equal(publicQuota(res).remaining, null);
  });
});

/* ----------------------- the client does not get a vote -------------------- */

test("the address comes from a signed cookie — a forged one is simply anonymous", async () => {
  await withEnv({ SESSION_SECRET: SECRET, FREE_DAILY_QUESTIONS: "5", GATE_TOKEN_ADDRESS: null }, async () => {
    const store = createMemoryStore();

    // A cookie the server did not sign.
    const forged = Buffer.from(JSON.stringify({ v: 1, address: ADDRESS.toLowerCase() })).toString("base64url") + ".not-a-mac";
    const fake = await resolveAccess({ sessionCookie: forged, ip: freshIp(), store });
    assert.equal(fake.address, null);
    assert.equal(fake.quota.state, "anonymous");

    // A cookie signed with somebody else's secret is no better.
    const wrongKey = await withEnv({ SESSION_SECRET: "another-secret-that-is-long-enough-here" }, () =>
      signPayload("session", { v: 1, address: ADDRESS.toLowerCase(), exp: Date.now() + 60_000 }),
    );
    const spoofed = await resolveAccess({ sessionCookie: wrongKey, ip: freshIp(), store });
    assert.equal(spoofed.address, null);

    // And the real one is honoured.
    const real = createSessionCookie(ADDRESS).value;
    const session = await resolveAccess({ sessionCookie: real, ip: freshIp(), store });
    assert.equal(session.address, ADDRESS.toLowerCase());
  });
});

test("a signed-in caller with no gate configured is unverified, and stays limited", async () => {
  await withEnv({ SESSION_SECRET: SECRET, FREE_DAILY_QUESTIONS: "1", GATE_TOKEN_ADDRESS: null }, async () => {
    const store = createMemoryStore();
    const cookie = createSessionCookie(ADDRESS).value;
    const first = await resolveAccess({ sessionCookie: cookie, ip: freshIp(), store });
    assert.equal(first.quota.state, QUOTA_STATE.UNVERIFIED);
    assert.equal(first.quota.unlimited, false);

    const second = await resolveAccess({ sessionCookie: cookie, ip: freshIp(), store });
    assert.equal(second.quota.allowed, false);
    assert.match(second.message, /not configured/i);
  });
});

test("the 429 headers carry the state, and omit what was never measured", async () => {
  const known = quotaHeaders({ state: "anonymous", unlimited: false, limit: 5, remaining: 2, resetsAt: "2026-07-29T00:00:00.000Z" });
  assert.equal(known["x-quota-state"], "anonymous");
  assert.equal(known["x-quota-remaining"], "2");

  const unknown = quotaHeaders({ state: "anonymous", unlimited: false, limit: 5, remaining: null, degraded: true });
  assert.equal("x-quota-remaining" in unknown, false, "a figure we do not have is not sent as 0");
  assert.equal(unknown["x-quota-degraded"], "1");
});

/* ------------------ the identity the counter is keyed on ------------------- */

test("a spoofed X-Forwarded-For cannot buy a fresh allowance", async () => {
  // H2 end to end. The caller prepends whatever they like to X-Forwarded-For;
  // the edge still appends the address it saw, and that is the hop the quota is
  // keyed on. Ten spoofs spend ONE allowance, not ten.
  await withEnv({ FREE_DAILY_QUESTIONS: "2" }, async () => {
    const store = createMemoryStore();
    const real = freshIp();
    const attempt = (spoof) =>
      consumeQuestion({ store, ip: clientIp({ headers: new Headers({ "x-forwarded-for": `${spoof}, ${real}` }) }) });

    assert.equal((await attempt("1.1.1.1")).allowed, true);
    assert.equal((await attempt("2.2.2.2")).allowed, true);
    const third = await attempt("3.3.3.3");
    assert.equal(third.allowed, false, "a new header value is not a new caller");
    assert.equal(third.used, 3);
  });
});

test("callers we cannot identify share one bucket rather than getting one each", async () => {
  // "I have no identity" is the claim every caller can always make, so it must
  // not be the cheapest route to a fresh allowance.
  await withEnv({ FREE_DAILY_QUESTIONS: "1" }, async () => {
    const store = createMemoryStore();
    const anonymous = () => clientIp({ headers: new Headers() });
    assert.equal((await consumeQuestion({ store, ip: anonymous() })).allowed, true);
    assert.equal((await consumeQuestion({ store, ip: anonymous() })).allowed, false);
  });
});

/* ------------------------- the gate has a deadline ------------------------- */

test("a hanging store degrades the gate instead of blocking the question", async () => {
  // H3b. Without a deadline this call sits there until the platform kills the
  // whole invocation — the 504 the request budget exists to prevent, arriving
  // from the one place the budget cannot see. With one, the per-process limiter
  // stands in and the report says `degraded`.
  await withEnv({ FREE_DAILY_QUESTIONS: "2" }, async () => {
    await quiet(async () => {
      const hanging = withStoreDeadline(
        {
          async increment() {
            return new Promise(() => {});
          },
        },
        25,
      );
      const ip = freshIp();
      const started = Date.now();
      const first = await consumeQuestion({ store: hanging, ip });
      const took = Date.now() - started;

      assert.equal(first.allowed, true, "a store outage must not refuse the question");
      assert.equal(first.degraded, true, "and it must say the figure is approximate");
      assert.ok(took < 2_000, `the gate returned in ${took}ms rather than hanging`);

      // Still a limit, and still the same one: the floor is not unlimited.
      await consumeQuestion({ store: hanging, ip });
      assert.equal((await consumeQuestion({ store: hanging, ip })).allowed, false);
    });
  });
});

test("the gate's worst case fits inside the margin outside the ask budget", async () => {
  // The gate runs BEFORE app/api/ask opens its 24s budget, so everything it can
  // spend comes out of PLATFORM_MARGIN_MS along with cold start and the response
  // write. If this ever stops holding, a slow gate reintroduces the platform 504
  // — which is exactly the drift a test is cheaper than a comment about.
  assert.ok(
    gateWorstCaseMs() < PLATFORM_MARGIN_MS,
    `gate worst case ${gateWorstCaseMs()}ms must stay under the ${PLATFORM_MARGIN_MS}ms margin`,
  );
});

test("a caller within quota pays the same round trips as one who is not", async () => {
  // "The gate must not make the ask path slower for someone within quota": the
  // permitted and the refused request both cost exactly one increment.
  await withEnv({ FREE_DAILY_QUESTIONS: "1" }, async () => {
    let calls = 0;
    const store = {
      async increment(key, opts) {
        calls += 1;
        return createCounter(key, opts);
      },
    };
    const counters = new Map();
    function createCounter(key) {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return { value: next, expiresAt: Date.now() + 1000 };
    }
    const ip = freshIp();
    assert.equal((await consumeQuestion({ store, ip })).allowed, true);
    assert.equal(calls, 1);
    assert.equal((await consumeQuestion({ store, ip })).allowed, false);
    assert.equal(calls, 2, "one round trip either way — never an extra read to confirm a refusal");
  });
});

test("a verified holder is not counted at all, so the gate costs them no store call", async () => {
  const store = {
    async increment() {
      throw new Error("a holder must never reach the counter");
    },
    async counter() {
      throw new Error("a holder must never reach the counter");
    },
  };
  const entitlement = { state: ENTITLEMENT.ENTITLED };
  const spent = await consumeQuestion({ store, address: ADDRESS, entitlement, ip: freshIp() });
  assert.equal(spent.unlimited, true);
  assert.equal(spent.degraded, false);
});

test("with no gate configured, the denial does not advertise holding a token", () => {
  // Measured live: /api/health reported tokenGate.configured false while a 429 from
  // /api/ask told the visitor to "Hold the gating token in a connected wallet to ask
  // without a daily limit" — a door that does not exist on that deployment. The wallet
  // menu already gated this on gate.configured; this path repeated the promise from
  // memory, which is the usual shape of the bug.
  const quota = { state: "anonymous", limit: 5, used: 5, remaining: 0, resetsAt: new Date(Date.now() + 3_600_000).toISOString() };
  const line = quotaMessage(quota, { state: "unverified", reason: "not-configured" });

  assert.doesNotMatch(line, /hold .*token .*without a daily limit/i, "an unconfigured gate was advertised as a way to lift the limit");
  assert.doesNotMatch(line, /\bnull\b/, "a null holding line was interpolated into the sentence");
  assert.match(line, /not configured/i, "the reader is not told why connecting will not lift the limit");
  // The signature reassurance is the reason people connect at all — it must survive.
  assert.match(line, /SIGN a message/);
});

test("with a gate configured, the denial still says what to hold", () => {
  const quota = { state: "anonymous", limit: 5, used: 5, remaining: 0, resetsAt: new Date(Date.now() + 3_600_000).toISOString() };
  const line = quotaMessage(quota, { state: "below", thresholdTokens: "1,000", symbol: "CMIND" });
  assert.match(line, /1,000 CMIND/);
  assert.match(line, /without a daily limit/i);
});

/* ------------------------------- open access ------------------------------ */

test("OPEN_ACCESS is read as a switch, and is off unless it is deliberately on", async () => {
  await withEnv({ OPEN_ACCESS: null }, () => assert.equal(openAccess(), false));
  await withEnv({ OPEN_ACCESS: "" }, () => assert.equal(openAccess(), false));
  await withEnv({ OPEN_ACCESS: "1" }, () => assert.equal(openAccess(), true));
  await withEnv({ OPEN_ACCESS: "true" }, () => assert.equal(openAccess(), true));
  await withEnv({ OPEN_ACCESS: "ON" }, () => assert.equal(openAccess(), true, "the switch is case-insensitive"));
  await withEnv({ OPEN_ACCESS: " yes " }, () => assert.equal(openAccess(), true, "a value with whitespace still counts"));
  // The one that matters: anything unrecognised leaves the limit ON. A typo in a
  // dashboard variable must not silently uncap the product.
  await withEnv({ OPEN_ACCESS: "0" }, () => assert.equal(openAccess(), false));
  await withEnv({ OPEN_ACCESS: "false" }, () => assert.equal(openAccess(), false));
  await withEnv({ OPEN_ACCESS: "banana" }, () => assert.equal(openAccess(), false));
});

test("open access lets an anonymous visitor ask without counting anything", async () => {
  await withEnv({ OPEN_ACCESS: "1", FREE_DAILY_QUESTIONS: "5" }, async () => {
    // Same proof the holder path uses: a store that throws if it is touched at all.
    const store = {
      async increment() {
        throw new Error("open access must not touch the store");
      },
      async counter() {
        throw new Error("open access must not touch the store");
      },
    };
    const args = { store, address: null, entitlement: null, ip: freshIp() };

    // Well past the configured allowance of 5.
    for (let i = 0; i < 12; i += 1) {
      const res = await consumeQuestion(args);
      assert.equal(res.allowed, true, `question ${i + 1} was refused under open access`);
      assert.equal(res.unlimited, true);
    }

    const res = await consumeQuestion(args);
    assert.equal(res.limit, null, "a lifted limit has no number, and 0 would read as exhausted");
    assert.equal(res.remaining, null);
    assert.equal(quotaHeaders(res)["x-quota-limit"], "unlimited");
    assert.equal(quotaMessage(res, null), "", "open access must not print a limit sentence");
  });
});

test("open access does not tell an anonymous visitor they are a verified holder", async () => {
  await withEnv({ OPEN_ACCESS: "1" }, async () => {
    const store = createMemoryStore();
    const open = await consumeQuestion({ store, address: null, entitlement: null, ip: freshIp() });
    assert.equal(open.state, QUOTA_STATE.OPEN);
    assert.notEqual(open.state, QUOTA_STATE.UNLIMITED, "unverified visitors were reported as holders");

    // And the holder keeps their own state — the switch lifts the limit for everyone,
    // it does not overwrite who was entitled on their own merits.
    const holder = await consumeQuestion({ store, address: ADDRESS, entitlement: entitled, ip: freshIp() });
    assert.equal(holder.state, QUOTA_STATE.UNLIMITED);
  });
});

test("both quota readers agree under open access", async () => {
  await withEnv({ OPEN_ACCESS: "1" }, async () => {
    const store = createMemoryStore();
    const args = { store, address: null, entitlement: null, ip: freshIp() };
    const spent = await consumeQuestion(args);
    const peeked = await peekQuota(args);
    // A UI counter that disagrees with the API's enforcement is the bug this pins:
    // the panel would draw "0 of 5 left" over an endpoint that is letting everyone in.
    assert.deepEqual(
      { u: peeked.unlimited, s: peeked.state, l: peeked.limit, r: peeked.remaining },
      { u: spent.unlimited, s: spent.state, l: spent.limit, r: spent.remaining },
    );
    assert.equal(peeked.degraded, false, "open access is not a store outage and must not be reported as one");
  });
});

test("an allowance of zero is still a paywall — it is not a way to remove the limit", async () => {
  // The inversion the separate switch exists to prevent. Anyone reaching for
  // "set the limit to 0 to turn it off" gets the opposite, so it is pinned here.
  await withEnv({ FREE_DAILY_QUESTIONS: "0", OPEN_ACCESS: null }, async () => {
    const res = await consumeQuestion({ store: createMemoryStore(), address: null, entitlement: null, ip: freshIp() });
    assert.equal(res.allowed, false, "zero locked nobody out, so it is no longer a paywall");
    assert.equal(res.unlimited, false);
  });
  // And with the switch on, that same zero is overridden rather than obeyed.
  await withEnv({ FREE_DAILY_QUESTIONS: "0", OPEN_ACCESS: "1" }, async () => {
    const res = await consumeQuestion({ store: createMemoryStore(), address: null, entitlement: null, ip: freshIp() });
    assert.equal(res.allowed, true, "open access did not win over a configured paywall");
    assert.equal(res.state, QUOTA_STATE.OPEN);
  });
});
