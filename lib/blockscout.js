import { getChainConfig } from "./chain.js";
import { priceCacheTtlMs, withIndexerCache } from "./indexer-cache.js";
import { clampTimeout } from "./request-budget.js";

/**
 * Blockscout REST client — the indexer/explorer layer for Robinhood Chain.
 * Replaces Helius for address history, token transfers, logs, and metadata.
 *
 * Docs: https://robinhoodchain.blockscout.com/api-docs (v2 REST API).
 * A BLOCKSCOUT_API_KEY (Pro) raises rate limits but is optional for dev.
 *
 * Every getter below goes through one chokepoint, getJson, and therefore through
 * the TTL cache and single-flight gate in lib/indexer-cache.js. That is the whole
 * reason this file has a single fetch: a repeat lookup inside the TTL costs
 * nothing, and N concurrent lookups of the same URL cost one upstream call.
 */
function apiBase() {
  const custom = process.env.BLOCKSCOUT_API_URL?.trim();
  return (custom || getChainConfig().blockscoutApi).replace(/\/$/, "");
}

/** v2 REST base (richer JSON than the legacy `?module=` API). */
function v2Base() {
  return apiBase().replace(/\/api$/, "/api/v2");
}

/**
 * Per-call budget. Without it a hung indexer holds the request open until the
 * platform kills the function, so the route never gets to fail cleanly.
 */
const TIMEOUT_MS = 8_000;

/**
 * Budget for a call whose result is DETAIL rather than the answer — a token's top
 * holders, its recent transfers. Shorter than TIMEOUT_MS on purpose: measured
 * against this indexer, /tokens/{a}/transfers takes 4.5s and /holders 4.3s where
 * /tokens/{a} takes 1.1s, and "how is NVDA doing" is answered by the latter. A
 * caller that puts its enrichment on this deadline loses one field to a stalled
 * endpoint (and says so) instead of holding the whole reply for it.
 */
const ENRICHMENT_TIMEOUT_MS = 6_000;

/**
 * An options bag for the getters below that expires the request after `ms`.
 *
 * Aborting is the half that matters beyond the clock: giving up locally while the
 * fetch runs on leaves the socket held and the indexer working on an answer
 * nobody will read, which on a rate-limited key costs the NEXT question too.
 * A non-numeric or non-positive `ms` falls back to the full budget rather than
 * aborting instantly — a bad deadline must not become a hard failure.
 *
 * IT IS ALSO CAPPED BY WHAT THE REQUEST HAS LEFT, and this is the chokepoint that
 * makes that true of every indexer read in the app: each of them arrives here for
 * its signal. Eight seconds is the right budget for this endpoint in isolation and
 * the wrong one with three seconds of the request remaining — held to its own
 * number it would overrun the platform's ceiling and take the whole answer down
 * with it, where clamped it fails as one missing field the evidence names. See
 * lib/request-budget.js. With no budget open the clamp is the identity function,
 * so every test and every script behaves exactly as before.
 *
 * @param {number} ms
 * @returns {{ signal: AbortSignal }}
 */
/**
 * The agent string sent to the indexer. A current, ordinary desktop browser —
 * see the note in fetchJson for why this is load-bearing rather than cosmetic.
 */
export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export function deadline(ms) {
  const n = Number(ms);
  return { signal: AbortSignal.timeout(clampTimeout(Number.isFinite(n) && n > 0 ? n : TIMEOUT_MS)) };
}

/**
 * Carries the upstream HTTP status so callers can tell a genuine 404 ("no such
 * address") from an outage (5xx, rate limit, abort) — reporting the second as
 * the first tells the user something false about the chain. Transport failures
 * throw the platform's own error with no `status`, which reads as unknown.
 */
export class BlockscoutError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "BlockscoutError";
    this.status = status ?? null;
  }
}

async function fetchJson(url, signal) {
  const key = process.env.BLOCKSCOUT_API_KEY?.trim();
  /*
   * A BROWSER-SHAPED USER-AGENT, BECAUSE THE INDEXER NOW CHALLENGES ANYTHING ELSE.
   *
   * Measured 3 September 2026: every request from this code came back
   * `403 Forbidden` with `Cf-Mitigated: challenge` and a "Just a moment" body —
   * Cloudflare's bot interstitial, in front of the Blockscout API. The same URL
   * with a browser User-Agent returned real JSON. Node's fetch sends `undici` as
   * its agent, which is exactly the shape the challenge is tuned to stop, and it
   * took the whole product down at once: the stocks page reported "no tokenized
   * equities came back" and every lookup behind an answer failed the same way.
   *
   * This is not evasion of a rate limit — the API is public and keyed requests
   * are still sent with their key. It is the one header the interstitial keys on,
   * and without it nothing here can read the chain at all.
   */
  const headers = {
    "User-Agent": BROWSER_UA,
    Accept: "application/json",
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
  };
  // The default signal is clamped for the same reason `deadline` is: a caller that
  // passed none still must not outlive the request it belongs to.
  const res = await fetch(url, { headers, signal: signal ?? AbortSignal.timeout(clampTimeout(TIMEOUT_MS)) });
  if (!res.ok) {
    throw new BlockscoutError(`Blockscout ${res.status} ${res.statusText} for ${url}`, res.status);
  }
  return res.json();
}

/**
 * Every indexer read in the app funnels through here, cached and de-duplicated
 * by URL. The URL is the whole key: the only other input to a request is the API
 * key, which is process-wide, so two calls to the same URL cannot differ.
 *
 * A throw — 404, 5xx, rate limit, abort, transport — is never cached and never
 * shared beyond the callers already waiting on it, so a blip stays a blip. See
 * lib/indexer-cache.js for the deadline a joiner inherits.
 *
 * `cache` is the per-call TTL ceiling, and only price-bearing endpoints pass one.
 * Everything else inherits the shared default, which is what a holder list or a
 * verification flag should have.
 */
function getJson(url, { signal } = {}, cache) {
  return withIndexerCache(url, () => fetchJson(url, signal), cache);
}

/** Address overview: balance, contract flag, token metadata if it's a token. */
export function getAddress(address, opts) {
  return getJson(`${v2Base()}/addresses/${address}`, opts);
}

/** Native + ERC-20/721/1155 transactions touching an address (paginated). */
export function getAddressTransactions(address, params = {}, opts) {
  const q = new URLSearchParams(params).toString();
  return getJson(`${v2Base()}/addresses/${address}/transactions${q ? `?${q}` : ""}`, opts);
}

/** Token transfers (ERC-20/721/1155) for an address. */
export function getTokenTransfers(address, params = {}, opts) {
  const q = new URLSearchParams(params).toString();
  return getJson(`${v2Base()}/addresses/${address}/token-transfers${q ? `?${q}` : ""}`, opts);
}

/** Single transaction with decoded input and status. */
export function getTransaction(hash, opts) {
  return getJson(`${v2Base()}/transactions/${hash}`, opts);
}

/** Emitted logs for a transaction (decoded when the ABI is known). */
export function getTransactionLogs(hash, opts) {
  return getJson(`${v2Base()}/transactions/${hash}/logs`, opts);
}

/**
 * Token (ERC-20/721/1155) metadata: name, symbol, decimals, supply, holders, price.
 *
 * The one endpoint here that carries `exchange_rate`, `circulating_market_cap` and
 * `volume_24h`, so it gets the short price TTL rather than the shared default — a
 * quote a minute old reads as wrong next to any other screen, where a holder count
 * a minute old reads as fine. Shortened, not disabled: the cache is what stopped
 * this app rate-limiting itself, and a burst of identical lookups must still cost
 * one request. It does NOT make the figure fresher than the indexer publishes it;
 * that floor is upstream and is not ours to move.
 */
export function getToken(address, opts) {
  return getJson(`${v2Base()}/tokens/${address}`, opts, { ttlMs: priceCacheTtlMs() });
}

/**
 * Chain-wide stats: average block time, gas prices, totals — and `coin_price`,
 * the ETH/USD rate.
 *
 * That one field is why this getter exists. It is the ONLY dollar reference on
 * this indexer that is not per-token, so every pool-derived price in
 * lib/dex-price.js converts through it, and a stale one would move every figure
 * on the page at once. Hence the short price TTL rather than the shared default,
 * for exactly the reason getToken has it.
 */
export function getStats(opts) {
  return getJson(`${v2Base()}/stats`, opts, { ttlMs: priceCacheTtlMs() });
}

/** Token counters: holder count and total transfer count. */
export function getTokenCounters(address, opts) {
  return getJson(`${v2Base()}/tokens/${address}/counters`, opts);
}

/** Top holders of a token (address + balance), ranked by balance. */
export function getTokenHolders(address, params = {}, opts) {
  const q = new URLSearchParams(params).toString();
  return getJson(`${v2Base()}/tokens/${address}/holders${q ? `?${q}` : ""}`, opts);
}

/** Recent transfers of a token (movement of the token itself). */
export function getTokenActivity(address, params = {}, opts) {
  const q = new URLSearchParams(params).toString();
  return getJson(`${v2Base()}/tokens/${address}/transfers${q ? `?${q}` : ""}`, opts);
}

/**
 * Global token list, newest-indexed first and paginated: pass the previous
 * response's `next_page_params` straight back in as `params` to walk it.
 */
export function getTokens(params = {}, opts) {
  const q = new URLSearchParams(params).toString();
  return getJson(`${v2Base()}/tokens${q ? `?${q}` : ""}`, opts);
}

/**
 * Explorer-wide search across tokens, addresses, blocks and transactions.
 * Matches on symbol and name, so it returns impostors alongside the real
 * contract — the caller decides which is which.
 */
export function searchChain(query, opts) {
  return getJson(`${v2Base()}/search?q=${encodeURIComponent(query)}`, opts);
}

/** Address counters: total txs, token-transfer count, gas usage. */
export function getAddressCounters(address, opts) {
  return getJson(`${v2Base()}/addresses/${address}/counters`, opts);
}

/** ERC-20/721/1155 balances held by an address. */
export function getAddressTokenBalances(address, opts) {
  return getJson(`${v2Base()}/addresses/${address}/token-balances`, opts);
}

export { apiBase, v2Base, TIMEOUT_MS, ENRICHMENT_TIMEOUT_MS };
