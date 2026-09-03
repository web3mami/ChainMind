/**
 * Intent router for /api/ask.
 *
 * The product started as a target-lookup explainer: every question had to carry
 * a 0x address, a hash or a ticker, and anything else was rejected. Most real
 * questions carry none of those — "what are the top stocks by market cap?",
 * "what is trending?", "which stock has the most holders?" — so the router's
 * job is to work out what the user is ASKING FOR before anything decides what
 * to look up.
 *
 * This module is deliberately PURE: string analysis only, no network, and no
 * imports from lib/blockscout.js or lib/stock-tokens.js. That keeps it fast
 * enough to run on every request, keeps it fully unit-testable without an
 * indexer, and keeps it out of the ask-evidence <-> stock-tokens import cycle.
 *
 * Nothing here decides whether a symbol is real — only that the user typed
 * something ticker-shaped. Resolution (and the impostor check that matters) is
 * still lib/stock-tokens.js's job.
 */

/** The intent names. Frozen: callers switch on these, so they are an API. */
export const INTENTS = Object.freeze({
  EXPLAIN_TARGET: "explain_target",
  COMPARE: "compare",
  RANK_STOCKS: "rank_stocks",
  MARKET_OVERVIEW: "market_overview",
  SAFETY_CHECK: "safety_check",
  EXPLAIN_CHAIN: "explain_chain",
  // Not a lookup at all: a greeting, a thank-you, or "who are you". See
  // isSmallTalk below — classifyIntent deliberately does NOT return this.
  SMALL_TALK: "small_talk",
  // Also not a lookup: anything else a person types that no lookup answers —
  // distress, a vague ask, a question about a chain this does not read. Answered
  // by one tool-free completion (lib/ask-conversation.js), never by a template.
  // classifyIntent does NOT return this either; lib/ask-runner.js decides it.
  CONVERSATION: "conversation",
  UNKNOWN: "unknown",
});

/* --------------------------- target extraction --------------------------- */

// Both hex patterns demand a non-hex boundary on each side, mirroring
// lib/extract-target.js. An unanchored match slices a valid-looking address out
// of a longer or truncated hex run, and the user is then answered confidently
// about an account they never typed. Over- and under-length runs must yield
// nothing at all rather than a plausible prefix.
const TX_RE = /(?:^|[^0-9a-fA-F])(0x[0-9a-fA-F]{64})(?![0-9a-fA-F])/g;
const ADDRESS_RE = /(?:^|[^0-9a-fA-F])(0x[0-9a-fA-F]{40})(?![0-9a-fA-F])/g;

/**
 * A ticker candidate: 1–5 letters, optional leading "$", not glued to any other
 * letter or digit. The leading-boundary character is consumed rather than
 * matched with a lookbehind, for parity with the patterns above.
 *
 * Case matters. Bare candidates must be UPPERCASE (checked after the match), so
 * the "now" in "what is trending now" cannot become NOW (ServiceNow) and the
 * "be"/"cost" in an ordinary sentence cannot become BE or COST — all three are
 * live tickers on this chain, which is exactly why they are not stopworded.
 * A "$" prefix is an explicit ticker marker, so "$tsla" is accepted in any case
 * and skips the stopword filter ("$ALL" means Allstate, not the word "all").
 */
const SYMBOL_CANDIDATE_RE = /(?:^|[^0-9A-Za-z$])(\$?)([A-Za-z]{1,5})(?![0-9A-Za-z])/g;

/**
 * Uppercase English that would otherwise read as a ticker. Without this, "What
 * are the TOP stocks" resolves TOP, and the answer is about some random token
 * instead of a ranking.
 *
 * Curated against config/stock-tokens.json: no word here collides with any of
 * the 94 live equity tokens. Words that DO collide (BE, NOW, COST, NU, PR, F,
 * P, ELF, USO) are intentionally absent — case sensitivity already keeps their
 * lowercase English uses out, and a stopword entry would make the real ticker
 * unaskable.
 */
const STOPWORDS = new Set([
  // articles, conjunctions, prepositions
  "A", "AN", "THE", "AND", "OR", "BUT", "NOR", "FOR", "SO", "YET", "IF", "THAN",
  "THEN", "AS", "AT", "BY", "IN", "INTO", "OF", "OFF", "ON", "ONTO", "OUT",
  "OVER", "PER", "TO", "UP", "VIA", "WITH", "FROM", "UNDER", "ABOUT", "ABOVE",
  "AFTER", "SINCE", "UNTIL", "WHILE", "VS",
  // pronouns and determiners
  "I", "ME", "MY", "MINE", "WE", "US", "OUR", "YOU", "YOUR", "IT", "ITS", "HE",
  "SHE", "HIS", "HER", "THEY", "THEM", "THEIR", "THIS", "THAT", "THESE",
  "THOSE", "ALL", "ANY", "BOTH", "EACH", "EVERY", "SOME", "NONE", "SUCH",
  "OTHER", "SAME", "ONE", "TWO", "TEN",
  // question words and verbs that show up shouted
  "WHAT", "WHICH", "WHO", "WHOM", "WHOSE", "WHEN", "WHERE", "WHY", "HOW",
  "IS", "ARE", "WAS", "WERE", "AM", "BEEN", "BEING", "DO", "DOES", "DID",
  "HAS", "HAVE", "HAD", "CAN", "COULD", "WILL", "WOULD", "SHALL", "MAY",
  "MIGHT", "MUST", "GET", "GOT", "SHOW", "TELL", "FIND", "GIVE", "LIST",
  "MAKE", "MADE", "SEND", "SENT", "HOLD", "HELD", "OWN", "OWNS", "BUY",
  "SELL", "SOLD", "KEEP", "NEED", "WANT", "LOOK", "SEE", "SAY", "USE",
  // ranking / metric vocabulary — never a ticker in these questions
  "TOP", "MOST", "LEAST", "BEST", "WORST", "BIG", "HUGE", "HIGH", "LOW",
  "MORE", "LESS", "MANY", "MUCH", "GOOD", "BAD", "NEW", "OLD", "NEXT",
  "LAST", "FIRST", "NOT", "NO", "YES", "ONLY", "JUST", "ALSO", "EVEN",
  "VERY", "TOO", "NOW", // see note above: "NOW" the ticker is only reachable as $NOW
  // chain and market nouns
  "CHAIN", "STOCK", "STOCKS", "TOKEN", "COIN", "COINS", "PRICE", "CAP",
  "MCAP", "VALUE", "WORTH", "TRADE", "MOVES", "MOVE", "WHALE", "SAFE",
  "SCAM", "RUG", "REAL", "FAKE", "LEGIT", "TRUST", "RISK", "RATE", "RANK",
  "DATA", "INFO", "NAME", "TIME", "DAY", "WEEK", "YEAR", "HOUR", "TODAY",
  "USD", "ETH", "GAS", "WEI", "NFT", "AI", "API", "URL", "DEX", "CEX",
]);

/**
 * Pull every target out of a free-text question.
 *
 * Lists are de-duplicated (case-insensitively for hex, by uppercased form for
 * symbols) with first-seen order preserved, because "compare NVDA and TSLA"
 * must keep NVDA first — the user's order is the answer's order.
 *
 * @param {unknown} text
 * @returns {{ txs: string[], addresses: string[], symbols: string[] }}
 */
export function extractTargets(text) {
  const s = typeof text === "string" ? text : "";
  return {
    txs: dedupe(collect(s, TX_RE, 1), (v) => v.toLowerCase()),
    addresses: dedupe(collect(s, ADDRESS_RE, 1), (v) => v.toLowerCase()),
    symbols: dedupe(collectSymbols(s), (v) => v),
  };
}

/** All capture-group matches of a global pattern, in order. */
function collect(s, re, group) {
  const out = [];
  for (const m of s.matchAll(re)) out.push(m[group]);
  return out;
}

/** Ticker-shaped runs, uppercased, with the stopword guard applied. */
function collectSymbols(s) {
  const out = [];
  for (const m of s.matchAll(SYMBOL_CANDIDATE_RE)) {
    const marked = m[1] === "$";
    const raw = m[2];
    // No "$": the user has to have typed it as a ticker, in caps, and it must
    // not be an ordinary English word.
    if (!marked) {
      if (raw !== raw.toUpperCase()) continue;
      if (STOPWORDS.has(raw)) continue;
    }
    out.push(raw.toUpperCase());
  }
  return out;
}

function dedupe(values, key) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    const k = key(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

/* ------------------------------ classification ---------------------------- */

const SAFETY_RE =
  /\b(?:safe|safety|legit|legitimate|scam|scammy|rug|rugged|rugpull|real|fake|counterfeit|trust|trustworthy|trusted|verified|unverified|official|unofficial|impostor|imposter|genuine|authentic)\b/gi;

const COMPARE_RE = /\b(?:compare[ds]?|comparing|comparison|vs|versus|against|difference between)\b/gi;

const RANK_WORD_RE =
  /\b(?:top|biggest|largest|most|highest|lowest|best|worst|cheapest|smallest|leading|greatest|fewest|least)\b/gi;

const METRIC_HINT_RE =
  /\b(?:market\s*cap|marketcap|mcap|cap|holders?|owners?|prices?|expensive|priciest|cheap|cheapest|volumes?|traded|trading|value|valuable|worth)\b/gi;

/**
 * "top stocks", "10 biggest tokens", "best performing equities" — a ranking
 * word aimed at the universe of stock tokens is a ranking even with no metric
 * named; market cap is the sane default (see parseRankQuery).
 */
const BARE_RANK_RE =
  /\b(?:top|biggest|largest|best|worst|cheapest|smallest|most|leading)\s+(?:\d{1,3}\s+)?(?:[a-z]+\s+)?(?:stocks?|tokens?|equit(?:y|ies)|tickers?|compan(?:y|ies)|coins?)\b/gi;

const MARKET_RE =
  /\btrending\b|\bwhat(?:'s|s| is)\s+(?:happening|going on|new|hot|moving)\b|\boverview\b|\bsummary\s+of\s+the\s+chain\b|\bchain\s+summary\b|\bhow(?:'s|s| is)\s+the\s+market\b|\bmarket\s+(?:doing|today|overview|summary|update|activity)\b|\brecent\s+(?:whale\s+|big\s+|large\s+)?(?:moves|movements|activity|action|trades|transfers)\b|\bwhale\s+(?:moves|movements|activity|watch|trades|transactions|transfers)\b/gi;

/**
 * OFF-CHAIN KNOWLEDGE: people, teams, the company, its history, money, plans.
 *
 * Measured live: "who is the founder?" routed to market_overview and came back
 * with "the founder of Robinhood Chain is not specified in the provided market
 * overview" — a market tool answering a question about a person, and then
 * describing its own plumbing to the user. "who is the co founder?" got "cannot
 * be answered with the available tools", which is a tool talking about itself.
 *
 * Neither question has an on-chain answer, and none of them ever will: the chain
 * carries blocks, contracts and balances, not names. So they are recognised here
 * and sent to the tool-free explain_chain path, where the answer is one honest
 * sentence plus what CAN be looked up — never a lookup that returns something
 * else and gets described as an absence.
 */
const OFF_CHAIN_NOUN_RE =
  /\b(?:co-?\s?founders?|founders?|founded|founding\s+team|the\s+team|team\s+behind|core\s+team|dev\s+team|ceo|cto|coo|cfo|chairman|chairwoman|executives?|leadership|management\s+team|employees?|staff|headquarters|whitepaper|white\s+paper|litepaper|road\s?map|investors?|backers?|venture\s+capital|funding\s+round|tokenomics|vesting\s+schedule|linkedin)\b/gi;

/**
 * The same question asked as "who". The verb list is closed and its object list
 * is closed too, so "who made this" is off-chain knowledge while "who holds the
 * most NVDA" — a real, countable, on-chain question — is untouched.
 */
const OFF_CHAIN_WHO_RE =
  /\bwho(?:'s|s)?\s+(?:is\s+|are\s+|was\s+|were\s+)?(?:the\s+)?(?:guys?|people|person|company|group|team|org(?:anisation|anization)?)?\s*behind\b|\bwho\s+(?:made|built|created|started|founded|owns?|runs?|develops?|designed|launched|is\s+building|is\s+running)\s+(?:this|it|you|chainmind|robinhood(?:\s+chain)?|the\s+chain|the\s+project|the\s+platform|the\s+site|the\s+app|the\s+network)\b/gi;

/**
 * Words that make the question on-chain after all. "who is behind this contract"
 * and "who deployed it" ARE answerable — the deployer is a field — so the
 * off-chain reading must lose to them rather than divert a real lookup.
 * No /g: this one is used with .test(), which would otherwise carry lastIndex
 * from call to call.
 */
const ON_CHAIN_SUBJECT_RE = /\b(?:deploy|deploys|deployed|deployer|issuer|issued|minted|contracts?)\b|0x[0-9a-fA-F]{6,}/i;

/** Every off-chain-knowledge phrase the question fired, lowercased. */
function offChainHits(q) {
  if (ON_CHAIN_SUBJECT_RE.test(q)) return [];
  return unique([...hits(q, OFF_CHAIN_NOUN_RE), ...hits(q, OFF_CHAIN_WHO_RE)]);
}

/**
 * Is this a question about people, a team, a company, its history, its funding
 * or its plans — none of which the chain carries?
 *
 * Pure and total: no network, no throw, any input type. A `true` answer means the
 * caller must answer WITHOUT a lookup, and in particular must never fall back to
 * the market tool, which would return market data for a question about a person.
 *
 * @param {unknown} question
 * @returns {boolean}
 */
export function isOffChainKnowledge(question) {
  const q = typeof question === "string" ? question : "";
  if (!q.trim()) return false;
  return offChainHits(q).length > 0;
}

/* --------------------------- a length of time --------------------------- */

/** Words for a span, and what each is worth in days. */
const SPAN_DAYS = Object.freeze({ day: 1, week: 7, fortnight: 14, month: 30, year: 365 });

/**
 * The number of days a question is asking about, or null.
 *
 * WHY THIS IS PARSED IN CODE RATHER THAN LEFT TO THE MODEL. holder_hold_time
 * takes an optional thresholdDays and answers "how many have held longer than
 * that" directly. Measured: asked "how many have been holding for more than 3
 * days", the model called the tool with the ticker and NOTHING ELSE, then
 * answered from the median and the range — which is a different question wearing
 * a number, and is exactly the failure the threshold count was built to end. A
 * capability the model does not reach for is not a capability.
 *
 * Deliberately narrow. It fires on an explicit span — a number of days, or one of
 * a closed list of words — and on nothing else. "a while", "long", "ages" have no
 * defensible number behind them, and inventing one would answer a question the
 * reader never asked with a figure that looks measured.
 *
 * @param {unknown} question
 * @returns {number|null} days, or null when the question names no span
 */
export function askedSpanDays(question) {
  const q = typeof question === "string" ? question.toLowerCase() : "";
  if (!q.trim()) return null;
  // A comparison has to be present: "held for 3 days" is a statement, "more than
  // 3 days" is a threshold, and only the second one wants a count.
  if (!/\b(?:more than|over|longer than|at least|greater than|above|beyond|past)\b/.test(q)) return null;

  const numeric = q.match(
    /\b(?:more than|over|longer than|at least|greater than|above|beyond|past)\s+(\d+(?:\.\d+)?)\s*(day|days|week|weeks|month|months|year|years|hour|hours)\b/,
  );
  if (numeric) {
    const n = Number(numeric[1]);
    if (!Number.isFinite(n) || n < 0) return null;
    const unit = numeric[2].replace(/s$/, "");
    if (unit === "hour") return n / 24;
    const per = SPAN_DAYS[unit];
    return per ? n * per : null;
  }

  const worded = q.match(
    /\b(?:more than|over|longer than|at least|greater than|above|beyond|past)\s+an?\s+(day|week|fortnight|month|year)\b/,
  );
  if (worded) return SPAN_DAYS[worded[1]] ?? null;
  return null;
}

/* ------------------------------ cost basis ------------------------------ */

/**
 * Words that ask what a position COST, which is the one thing no lookup here has.
 *
 * Profit needs an entry price, an entry price needs every acquisition priced at the
 * moment it happened, and nothing in this catalogue assembles that. The gap is real
 * and permanent until something is built for it; what makes it worth detecting is
 * how the gap gets WORDED. Measured live, asked for a wallet's PnL: "I could not
 * read the wallet's transaction history for every token it holds, so whether it is
 * in profit is unknown." The history reads in one call. Nothing had failed. A gap in
 * the catalogue came out as a gap in the data, which sends the reader back to retry
 * working code — so the note this feeds exists to make the true sentence the easy one.
 */
const COST_BASIS_NOUN_RE =
  /\b(?:pnl|p\s*&\s*l|p\s*\/\s*l|profits?|profitable|unprofitable|cost\s*bas[ie]s|entry\s*(?:price|point)|avg?\s*(?:erage)?\s*entry|break[\s-]?even|roi|return\s+on\s+investment|impermanent\s+loss)\b|\b(?:un)?real(?:is|iz)ed\s+(?:gains?|losses?|pnl)\b/gi;

/**
 * The same question asked as a phrase rather than a noun.
 *
 * Deliberately NARROW. "how much is this wallet worth", "what does it hold", "has it
 * ever sold" and "its net position" are all real, answered capabilities — a rule that
 * swallowed those would replace four working answers with a refusal, which is a worse
 * defect than the one being fixed. So this matches making and losing MONEY, never
 * holding value.
 */
const COST_BASIS_PHRASE_RE =
  /\b(?:up\s+or\s+down\s+on|in\s+the\s+(?:green|red)\b|(?:made|makes?|lost|loses?)\s+(?:any\s+)?money|making\s+money|losing\s+money|how\s+much\s+(?:has|have|did)\s+\S+(?:\s+\S+){0,3}\s+(?:made|lost|gained))\b/gi;

/**
 * Is this a question about profit, loss or what a position cost?
 *
 * Pure and total: no network, no throw, any input type. A `true` answer does NOT mean
 * refuse the turn — the wallet is still worth reading, and what it holds, whether it
 * has sold and what it traded recently are all still worth saying. It means the answer
 * must FIRST state that profit is not something this works out, rather than quietly
 * answering the adjacent question or inventing a read that failed.
 *
 * @param {unknown} question
 * @returns {boolean}
 */
export function asksForCostBasis(question) {
  const q = typeof question === "string" ? question : "";
  if (!q.trim()) return false;
  return unique([...hits(q, COST_BASIS_NOUN_RE), ...hits(q, COST_BASIS_PHRASE_RE)]).length > 0;
}

/* --------------------------- somebody else's chain --------------------------- */

/**
 * A QUESTION ABOUT A CHAIN THIS DOES NOT READ.
 *
 * Measured live: "Which wallet bought catecoin on Solana 2hrs ago" came back as
 * "I couldn't tell what to look up. Try a ticker (NVDA)…". Every word of that is
 * a dodge. The question was perfectly clear; it was about Solana, and this reads
 * Robinhood Chain. Nothing in the product knew that sentence existed — grep for
 * "solana" across it found nothing at all — so the one honest answer was the one
 * answer it could not give.
 *
 * WHY THIS IS A HINT AND NOT THE ANSWER. Naming chains is brittle and always
 * incomplete: a chain launched next month is not in any list written today. So
 * the list is not what makes the product right about scope — the conversational
 * prompt is, and it states the rule in general ("you read Robinhood Chain and
 * nothing else") so an unlisted chain is handled by a model that has heard of it.
 * This function exists for the one thing a prompt cannot do: get in FRONT of the
 * router, so a question that plainly names another chain never spends a routing
 * turn looking for a Solana memecoin in a Robinhood Chain index.
 *
 * THE FAILURE THAT MATTERS MORE IS THE OTHER ONE. A token deployed on THIS chain
 * that happens to share a name with a Solana memecoin must be looked up, not
 * refused. So this is deliberately hard to trigger:
 *
 *  1. A bare token name NEVER fires it. "who bought catecoin" names no chain and
 *     goes to the router, which can search this chain for it. Only an explicit
 *     foreign venue — "on Solana", "Solana wallet", "pump.fun" — counts.
 *  2. ETHEREUM AND ARBITRUM ARE NOT IN THE LIST, on purpose. Robinhood Chain is
 *     an Arbitrum Orbit rollup that settles to Ethereum, so "does this settle on
 *     ethereum" is a question ABOUT this chain. Gating it would answer a correct
 *     chain question with a refusal, which is the expensive direction of wrong.
 *  3. Anything naming this chain, or carrying a 0x target, suppresses it
 *     entirely. A hex string is a concrete subject on some chain, and the only
 *     chain we can check it against is ours.
 *  4. It is measured, not asserted: test/ask-conversation.test.mjs runs it over
 *     all 106 rows of scripts/routing-corpus.mjs — every one of them a question
 *     the router is supposed to answer — and fails on a single hit. That test
 *     has already caught one: "wut is robinhud chain" matched the generic
 *     "<name> chain" shape until that shape was made to require a locative.
 *
 * Pure and total: no network, no throw, any input type.
 *
 * @param {unknown} question
 * @returns {{ venue: string, matched: string[] } | null} the chain or venue the
 *   question named, ready to be quoted back, or null for "this is not that".
 */
export function detectForeignVenue(question) {
  const q = typeof question === "string" ? question : "";
  if (!q.trim()) return null;
  // Names this chain, or names a concrete on-chain subject: ours to answer.
  if (SELF_REFERENCE_RE.test(q) || /0x[0-9a-fA-F]{6,}/.test(q)) return null;

  const matched = [];
  let venue = null;

  for (const m of q.matchAll(FOREIGN_VENUE_RE)) {
    const key = m[0].toLowerCase().replace(/\s+/g, " ").trim();
    venue ??= FOREIGN_VENUES[key.replace(/\s/g, "")] ?? FOREIGN_VENUES[key] ?? null;
    matched.push(key);
  }

  for (const m of q.matchAll(FOREIGN_CHAIN_RE)) {
    const alias = (m[1] ?? m[2] ?? "").toLowerCase();
    const name = FOREIGN_CHAINS[alias];
    if (!name) continue;
    venue ??= name;
    matched.push(m[0].trim().replace(/\s+/g, " ").toLowerCase());
  }

  // "on the <something> chain" for a something nobody listed. The captured word
  // is quoted back as the user wrote it rather than mapped to a canonical name —
  // we do not know what it is, and pretending to would be its own invention.
  if (!venue) {
    for (const m of q.matchAll(NAMED_CHAIN_RE)) {
      const word = (m[1] ?? "").toLowerCase();
      if (!word || NOT_A_CHAIN_NAME.has(word)) continue;
      venue = `${word[0].toUpperCase()}${word.slice(1)}`;
      matched.push(m[0].trim().replace(/\s+/g, " ").toLowerCase());
      break;
    }
  }

  return venue ? { venue, matched: unique(matched) } : null;
}

/**
 * Anything that makes the question ours after all. "here" is in it because a
 * person who says "I got rugged here" is talking about this chain, whatever
 * else the sentence mentions.
 * No /g: used with .test(), which would otherwise carry lastIndex between calls.
 */
const SELF_REFERENCE_RE =
  // `rh` and `hood` are how people abbreviate Robinhood, and without them the detector
  // refused questions about THIS product: "whats on the rh chain" answered, live, "You're
  // asking about Rh, but I read Robinhood Chain only and cannot see Rh." Telling a user
  // their own chain is one you cannot see is the worst output this feature can produce.
  //
  // Both are bounded to the chain-word forms rather than added as bare words: "rh" is two
  // letters that could be anything, and "hood" appears in every one of the 94 equity names
  // (they all end "• Robinhood Token"), so a bare \bhood\b would swallow real lookups.
  /\brobin\s?h[a-z]{0,4}d?\b|\bchainmind\b|\b(?:rh|hood)\s+(?:chain|network|l2|explorer)\b|\bthis\s+(?:chain|network|l2|site|app|explorer)\b|\bhere\b|\b4663\b/i;

/**
 * Chains this product does not read, by every alias people actually type.
 *
 * NOT A COMPLETE LIST AND NOT TRYING TO BE — see detectForeignVenue's note. It
 * omits ethereum, eth, arbitrum and orbit deliberately: those describe the chain
 * we DO read, and a "chain" list that fires on its own settlement layer is worse
 * than no list. "near", "flow", "core" and other plain English words are omitted
 * for the same reason in reverse — the cost of a false positive is a user's
 * answer.
 */
const FOREIGN_CHAINS = Object.freeze({
  solana: "Solana", sol: "Solana", bitcoin: "Bitcoin", btc: "Bitcoin",
  base: "Base", polygon: "Polygon", matic: "Polygon", bnb: "BNB Chain",
  bsc: "BNB Chain", avalanche: "Avalanche", avax: "Avalanche", sui: "Sui",
  aptos: "Aptos", tron: "Tron", cardano: "Cardano", ton: "TON",
  hyperliquid: "Hyperliquid", blast: "Blast", linea: "Linea", scroll: "Scroll",
  zksync: "zkSync", celo: "Celo", fantom: "Fantom", sei: "Sei",
  monad: "Monad", berachain: "Berachain", optimism: "Optimism",
  dogecoin: "Dogecoin", litecoin: "Litecoin", ripple: "XRP", xrp: "XRP",
  cosmos: "Cosmos", injective: "Injective", starknet: "Starknet",
  mantle: "Mantle", unichain: "Unichain", cronos: "Cronos", gnosis: "Gnosis",
  stellar: "Stellar", algorand: "Algorand", hedera: "Hedera", kaspa: "Kaspa",
  pulsechain: "PulseChain", tezos: "Tezos", polkadot: "Polkadot",
});

/**
 * A chain alias only counts in a LOCATIVE position — "on Solana", "Solana
 * wallet" — never bare. "base", "scroll", "blast" and "sol" are ordinary words
 * and a ticker; the position is what separates "on base" from "based on", and
 * it is why this pattern is not simply the alias list.
 */
const FOREIGN_CHAIN_RE = new RegExp(
  String.raw`\b(?:on|in|at|from|over|onto|via)\s+(?:the\s+)?\$?(${Object.keys(FOREIGN_CHAINS).join("|")})\b` +
    // THE NOUN LIST HERE IS CHAIN WORDS ONLY, and the ones removed were removed for cause.
    //
    // It used to include tokens?, coins?, contracts?, addresses?, wallets?, memecoins?,
    // dex and side. Those are ASSET words, not chain words, and several are this
    // product's own vocabulary — "base token" and "quote token" are what lib/tick-depth.js
    // calls the two sides of a pool. Measured live, the old list refused: "what is the
    // base token of this pair" -> "You're asking about Base, which is not a chain I have
    // access to", plus "base contract address please", "base tokens", "the sol tokens i
    // hold", "ton tokens", "sei tokens", "blast contracts", "scroll tokens".
    //
    // Unlike the first alternative, this one has no locative to disambiguate it — that is
    // exactly where the English collisions live, because these aliases are ordinary words.
    //
    // The trade is deliberate and asymmetric. Missing a foreign-chain question costs ONE
    // lookup that finds nothing and says so, which is honest. Refusing a question about
    // this chain costs the user their answer and tells them something false about what the
    // product can see. So this errs toward missing.
    String.raw`|\b(${Object.keys(FOREIGN_CHAINS).join("|")})(?:'s)?\s+(?:chain|network|blockchain|mainnet|explorer|ecosystem)\b`,
  "gi",
);

/** Venues that can only mean one chain, so they need no locative to be clear. */
const FOREIGN_VENUES = Object.freeze({
  // "jupiter" and "phantom" are deliberately absent: both are ordinary English
  // words before they are Solana products, and this list needs no locative test
  // to protect it, so every entry in it has to be unambiguous on its own.
  "pump.fun": "Solana", pumpfun: "Solana", raydium: "Solana", solscan: "Solana",
  magiceden: "Solana", bscscan: "BNB Chain", pancakeswap: "BNB Chain",
});
const FOREIGN_VENUE_RE = /\b(?:pump\s?\.?\s?fun|raydium|solscan|bscscan|pancakeswap|magic\s?eden)\b/gi;

/**
 * "on the Zorp chain" — a chain nobody listed, recognised by its shape rather
 * than by its name, which is the only way a list written today can survive a
 * chain launched next month.
 *
 * THE LOCATIVE IS REQUIRED HERE TOO, and the corpus is why. Without it, the row
 * "wut is robinhud chain" — a typo'd question about THIS chain, which the corpus
 * carries precisely because typos are how people write — matched as the "Robinhud
 * chain", and a question about us would have been refused as somebody else's.
 * "on the X chain" is a place; "X chain" on its own is just as likely to be our
 * own name, spelled by a thumb on a phone.
 */
const NAMED_CHAIN_RE =
  /\b(?:on|in|at|from|over|onto|via)\s+(?:the\s+)?([a-z][a-z0-9.'-]{1,20})\s+(?:chain|blockchain|network|mainnet)\b/gi;

/**
 * Words that precede "chain" without naming one. Everything describing THIS
 * chain is in here, so "the arbitrum orbit chain" and "this l2 network" cannot
 * be read as somebody else's.
 */
const NOT_A_CHAIN_NAME = new Set([
  "a", "an", "the", "this", "that", "these", "those", "same", "current", "main",
  "other", "another", "any", "every", "each", "one", "which", "what", "whose",
  "our", "your", "my", "its", "their", "his", "her", "no", "some", "right",
  "whole", "entire", "block", "off", "on", "cross", "multi", "side", "sub",
  "home", "l1", "l2", "layer", "evm", "testnet", "mainnet", "public", "private",
  "robinhood", "chainmind", "arbitrum", "orbit", "ethereum", "eth", "rollup",
  "supply", "value", "food", "big", "whole", "best", "top", "new", "old",
]);

/**
 * Conceptual questions the system prompt already answers. These must NOT reach
 * the indexer: "what is Robinhood Chain?" has no target to look up, and a
 * failed lookup would turn an easy answer into an error.
 */
const EXPLAIN_CHAIN_RE =
  /\bwhat\s+(?:is|are)\s+(?:a\s+|an\s+|the\s+)?(?:robinhood\s+chain|chainmind|tokenized\s+(?:equit(?:y|ies)|stocks?|shares?)|stock\s+tokens?|equity\s+tokens?)\b|\bhow\s+(?:does|do)\s+(?:this|it|they|chainmind|the\s+chain|robinhood\s+chain|stock\s+tokens?|tokenized\s+(?:stocks?|equities))\s+work\b|\bwhat\s+can\s+you\s+do\b|\bexplain\s+(?:robinhood\s+chain|the\s+chain|chainmind)\b|\bwhat\s+is\s+an?\s+(?:erc-?20|l2|rollup|orbit\s+chain)\b/gi;

/**
 * Decide what the question is asking for.
 *
 * Precedence when several signals fire:
 *   safety_check > compare > rank_stocks > explain_chain (off-chain knowledge) >
 *   market_overview > explain_target > explain_chain > unknown
 * "Is NVDA at 0x… the real one?" is a safety question that happens to name a
 * target, not a target lookup that happens to say "real" — so safety wins over
 * explain_target, and a ranking wins over the generic overview it also reads as.
 * A question about people outranks BOTH the market overview and the single
 * lookup: neither of them holds a founder's name, and answering one of them
 * anyway is how "who is the founder?" became a market summary.
 *
 * `matched` carries the trigger phrases that fired, lowercased, for logging and
 * for the caller to show its reasoning. `confidence` is a coarse 0–1 score;
 * compare in particular drops to 0.5 when the keyword fired but fewer than two
 * concrete targets were named, so a caller can fall back rather than try to
 * compare one thing with nothing.
 *
 * @param {unknown} question
 * @param {{ txs?: string[], addresses?: string[], symbols?: string[] }} [targets]
 *   result of extractTargets; recomputed from the question when omitted
 * @returns {{ intent: string, confidence: number, matched: string[] }}
 */
export function classifyIntent(question, targets) {
  const q = typeof question === "string" ? question : "";
  const t = targets && typeof targets === "object" ? targets : extractTargets(q);
  const txs = arr(t.txs);
  const addresses = arr(t.addresses);
  const symbols = arr(t.symbols);
  const targetCount = txs.length + addresses.length + symbols.length;
  const hasTarget = targetCount > 0;
  // Only named entities can be compared; two transaction hashes are a diff
  // request we do not serve, so they do not count toward the compare threshold.
  const comparableCount = addresses.length + symbols.length;

  const safety = hits(q, SAFETY_RE);
  if (safety.length && hasTarget) {
    return result(INTENTS.SAFETY_CHECK, 0.9, safety);
  }

  const compare = hits(q, COMPARE_RE);
  if (comparableCount >= 2 || compare.length) {
    const matched = compare.length ? compare : [`${comparableCount} targets`];
    // Two named targets is an unambiguous compare; the bare keyword is a guess.
    return result(INTENTS.COMPARE, comparableCount >= 2 ? 0.9 : 0.5, matched);
  }

  const rankWords = hits(q, RANK_WORD_RE);
  const metrics = hits(q, METRIC_HINT_RE);
  const bareRank = hits(q, BARE_RANK_RE);
  if ((rankWords.length && metrics.length) || bareRank.length) {
    return result(
      INTENTS.RANK_STOCKS,
      rankWords.length && metrics.length ? 0.85 : 0.7,
      unique([...rankWords, ...metrics, ...bareRank]),
    );
  }

  // Founders, teams, the company, its funding, its roadmap. Nothing on this
  // chain carries any of it, so the answer is the tool-free one — checked before
  // the market overview and before the single lookup, because both of those
  // would return real data about something the user did not ask about.
  const offChain = offChainHits(q);
  if (offChain.length) {
    return result(INTENTS.EXPLAIN_CHAIN, 0.8, offChain);
  }

  const market = hits(q, MARKET_RE);
  if (market.length && !hasTarget) {
    return result(INTENTS.MARKET_OVERVIEW, 0.75, market);
  }

  if (hasTarget) {
    // A hash or an address is exact; a bare ticker was inferred from shape.
    const exact = txs.length + addresses.length > 0;
    return result(INTENTS.EXPLAIN_TARGET, exact ? 0.9 : 0.8, [...txs, ...addresses, ...symbols]);
  }

  const chain = hits(q, EXPLAIN_CHAIN_RE);
  if (chain.length) {
    return result(INTENTS.EXPLAIN_CHAIN, 0.7, chain);
  }

  return result(INTENTS.UNKNOWN, 0, []);
}

function result(intent, confidence, matched) {
  return { intent, confidence, matched: unique(matched.map((m) => String(m).toLowerCase())) };
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function unique(values) {
  return [...new Set(values)];
}

/** Every distinct phrase a global pattern matches, lowercased and whitespace-flattened. */
function hits(s, re) {
  const out = [];
  for (const m of s.matchAll(re)) {
    const w = m[0].trim().replace(/\s+/g, " ").toLowerCase();
    if (w) out.push(w);
  }
  return unique(out);
}

/* ------------------------------- small talk ------------------------------- */

/**
 * Measured live: "hello" and "hi" both routed to the market_overview tool and
 * came back with a summary of the tokenized-equity market. That is the single
 * most robotic thing the product does — a person says hi and gets a table — and
 * it also spends a tool round trip and an indexer fan-out on a word.
 *
 * So greetings are caught BEFORE any routing, by an explicit test rather than by
 * a tool the model has to choose. Two rules make it safe to run first:
 *
 *  1. EVERY word must be social vocabulary. One unrecognised word and the answer
 *     is no: "hi, what is nvda" contains a real subject, so it goes to the token
 *     lookup exactly as before. This is why the check is a whitelist and not a
 *     "starts with hello" prefix test — the prefix test is what would swallow
 *     the subject.
 *  2. At least one word must be SOCIAL IN ITSELF. Filler alone ("is this", "what
 *     about it") is an unfinished question, not small talk, and belongs with the
 *     router that can ask the model what was meant.
 *
 * Deliberately not exhaustive across languages: a missed greeting costs one
 * ordinary routing turn, and the system prompt tells the model not to answer a
 * greeting with a market summary either. A false POSITIVE costs the user their
 * answer, which is the failure worth avoiding.
 */

/** A word that is social all by itself — a greeting, a thank-you, an identity. */
const SMALL_TALK_CORE = new Set([
  // greetings, including the shapes people actually type
  "hi", "hii", "hiii", "hiya", "hey", "heyy", "heyyy", "heya", "hello", "helo",
  "hullo", "howdy", "greetings", "yo", "sup", "wassup", "gm", "gn", "gday",
  "morning", "afternoon", "evening", "goodnight",
  // greetings in the languages this product is already asked in
  "hola", "buenos", "buenas", "bonjour", "salut", "hallo", "ciao", "oi", "ola", "privet",
  "namaste", "salam", "salaam", "shalom", "konnichiwa", "nihao", "merhaba",
  "hej", "hei", "moi", "aloha", "selam",
  // thanks
  "thanks", "thanx", "thankyou", "thank", "thx", "ty", "tysm", "cheers",
  "gracias", "merci", "danke", "obrigado", "obrigada", "spasibo", "arigato",
  "arigatou", "grazie",
  // identity — "who are you", "what are you", "your name"
  "you", "youre", "your", "yours", "yourself", "u", "ur", "who", "whos",
  "chainmind", "bot", "assistant", "robot",
  // signing off
  "bye", "byebye", "goodbye", "cya", "adios", "farewell",
]);

/**
 * A word that may keep a greeting company without making one. Nothing here names
 * a subject: no ticker, no metric, no "price", "market", "token", "holders",
 * "chain", "wallet" or "work" — any of those has to reach the router.
 */
const SMALL_TALK_FILLER = new Set([
  "a", "about", "again", "all", "alright", "am", "an", "and", "any", "anybody",
  "anyone", "are", "as", "at", "be", "been", "being", "can", "cool", "could",
  "day", "days", "dias", "did", "do", "does", "doin", "doing", "dude", "else",
  "fine", "for", "friend", "from", "get", "goin", "going", "good", "got",
  "great", "haha", "hah", "hehe", "help", "here", "hm", "hmm", "how", "hows",
  "i", "if", "im", "in", "is", "it", "its", "just", "know", "lol", "man",
  "many", "me", "much", "my", "name", "nice", "night", "no", "noches", "not",
  "now", "of", "ok", "okay", "on", "one", "please", "pls", "r", "really",
  "right", "say", "see", "so", "some", "sorry", "still", "talking", "tardes",
  "tell", "thats", "the", "then", "there", "these", "this", "those", "to",
  "today", "too", "up", "us", "was", "we", "welcome", "well", "what", "whats",
  "when", "where", "why", "yeah", "yep", "yes",
]);

/**
 * Social phrases with no socially-marked word in them — "hows it going" is made
 * entirely of words too common to whitelist on their own. Matched against the
 * WHOLE normalized question, so they can never swallow a subject.
 *
 * "whats new", "whats happening" and "whats going on" are absent on purpose:
 * MARKET_RE reads all three as a market question, and it is right to.
 */
const SMALL_TALK_PHRASES = new Set([
  "all good",
  "how are things",
  "how goes it",
  "how is it going",
  "hows everything",
  "hows it goin",
  "hows it going",
  "hows things",
  "whats good",
]);

/**
 * A social exchange is short. Six words holds "good morning, how are you" and
 * "hey there, who are you?" and excludes anything with room for a real question.
 */
const MAX_SMALL_TALK_WORDS = 6;

/**
 * Is this a greeting, a thank-you, or a question about ChainMind itself, and
 * nothing more?
 *
 * Pure and total: no network, no throw, any input type. A `true` answer means the
 * caller should reply socially with NO tool call and NO chain lookup.
 *
 * @param {unknown} question
 * @returns {boolean}
 */
export function isSmallTalk(question) {
  const raw = typeof question === "string" ? question : "";
  if (!raw.trim()) return false;
  // A digit is a figure, an address or a count — never part of small talk, and
  // this is also what keeps "0x…" and "top 10" out with no further thought.
  if (/\d/.test(raw)) return false;

  // Accents are folded rather than rejected so "buenos días" and "olá" tokenize
  // to the words in the sets above. Scripts with no Latin letters at all reduce
  // to nothing and return false — one ordinary routing turn, not a wrong answer.
  const words = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/['‘’`]/g, "")
    .split(/[^a-z]+/)
    .filter(Boolean);

  if (!words.length || words.length > MAX_SMALL_TALK_WORDS) return false;
  if (SMALL_TALK_PHRASES.has(words.join(" "))) return true;

  let social = false;
  for (const word of words) {
    if (SMALL_TALK_CORE.has(word)) {
      social = true;
      continue;
    }
    if (SMALL_TALK_FILLER.has(word)) continue;
    // A word we do not recognise is a subject. Let the router have it.
    return false;
  }
  return social;
}

/* -------------------------------- distress -------------------------------- */

/**
 * "I GOT RUGGED", AND WHAT THE PRODUCT SAID BACK.
 *
 * Before this existed it was the template: "I couldn't tell what to look up. Try
 * a ticker (NVDA)…". After the template was replaced but before this gate, it was
 * measured against the live model reaching the router — which answered it with
 * ask_clarification and a menu:
 *
 *   Q: "I got rugged"        A: "I got rugged"        (a literal echo, plus three
 *   Q: "I think I got scammed"                         radio buttons asking what
 *                                                      they meant by it)
 *
 * That is a second template wearing a nicer coat. There is nothing to clarify:
 * the sentence is clear, it names nothing, and the only thing that would help is
 * the contract address — which the conversational turn asks for, in the same
 * breath as what it will do with it.
 *
 * THE GATE IS THE WHOLE DEFINITION, NOT HALF OF IT. "Reads as distress" is not
 * enough on its own, because "is this a rug tsla" is distress vocabulary wrapped
 * around a real subject and belongs to the router. So a message qualifies only
 * when it ALSO names nothing: every word is either distress vocabulary or the
 * ordinary filler that surrounds it, exactly the whitelist discipline isSmallTalk
 * uses and for exactly the same reason — one unrecognised word is a subject, and
 * a subject is a lookup.
 *
 * Measured against the 106-row routing corpus: fires on none of them. The row
 * that proves the whitelist earns its keep is "is this a rug tsla" — case
 * sensitivity keeps lowercase "tsla" out of extractTargets, so a target-count
 * test would have swallowed it and lost the user their lookup.
 *
 * ENGLISH-ONLY, and deliberately, for the reason isSmallTalk gives: a MISSED
 * message costs one ordinary routing turn, and a false positive costs the user
 * their lookup. Measured live, "me estafaron con un token" is not caught here
 * and goes to the router — the worse outcome would be a Spanish trigger list
 * without a Spanish filler list, which would fire on real Spanish questions.
 * The conversational turn still answers in the user's own language whenever it
 * is reached by any route.
 *
 * Pure and total: no network, no throw, any input type.
 *
 * @param {unknown} question
 * @returns {boolean}
 */
export function isUnroutableDistress(question) {
  const raw = typeof question === "string" ? question : "";
  if (!raw.trim()) return false;
  // A hex string is a concrete subject. Whatever else the sentence says, there
  // is something here to read, and reading it is the better answer.
  if (/0x[0-9a-fA-F]{6,}/.test(raw)) return false;
  if (!DISTRESS_RE.test(raw)) return false;

  const words = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/['‘’`]/g, "")
    .split(/[^a-z]+/)
    .filter(Boolean);

  if (!words.length || words.length > MAX_DISTRESS_WORDS) return false;
  for (const word of words) {
    if (DISTRESS_WORDS.has(word)) continue;
    if (DISTRESS_CONTEXT.has(word)) continue;
    if (SMALL_TALK_FILLER.has(word)) continue;
    // Something in here names a thing. Let the router have it.
    return false;
  }
  return true;
}

/**
 * Does this read as somebody who has lost money? Used to pick which written reply
 * to send when the model is unreachable — the model itself reads the sentence and
 * needs no keyword list.
 *
 * @param {unknown} question
 * @returns {boolean}
 */
export function looksLikeDistress(question) {
  const q = typeof question === "string" ? question : "";
  return q.trim() ? DISTRESS_RE.test(q) : false;
}

/** No /g: used with .test(), which would otherwise carry lastIndex between calls. */
const DISTRESS_RE =
  /\brug(?:ged|ging|pull(?:ed)?|s)?\b|\bscam(?:med|mer|mers)?\b|\bdrained?\b|\bstole\b|\bstolen\b|\bhacked\b|\brekt\b|\bhoneypot\b|\blost\s+(?:my|all|everything|it)\b|\bwiped\s+out\b|\bexit\s+scam(?:med)?\b/i;

/** The words that make a message distress. At least one must be present. */
const DISTRESS_WORDS = new Set([
  "rug", "rugged", "rugging", "rugs", "rugpull", "rugpulled", "pull", "pulled",
  "scam", "scammed", "scammer", "scammers", "drain", "drained", "stole",
  "stolen", "steal", "hacked", "hack", "rekt", "honeypot", "lost", "lose",
  "losing", "wiped", "exit", "gone", "worthless", "zero", "dumped", "dump",
]);

/**
 * Words that keep distress company without naming anything a lookup could reach.
 * Generic nouns only: "my wallet got drained" names no wallet, and asking for the
 * address is the answer. Anything that could be a token, a ticker or a project is
 * deliberately absent.
 */
const DISTRESS_CONTEXT = new Set([
  // generic nouns for the thing that was lost — none of them names one
  "money", "funds", "fund", "cash", "savings", "everything", "everthing",
  "bag", "bags", "position", "positions", "portfolio", "crypto", "eth", "usd",
  "usdc", "dollars", "bucks", "wallet", "wallets", "token", "tokens", "coin",
  "coins", "liquidity", "lp", "pool", "dev", "devs", "team", "project",
  // how people actually write it
  "shit", "fuck", "fucked", "damn", "wtf", "bro", "guys", "someone", "somebody",
  "think", "thought", "guess", "feel", "believe", "maybe", "badly", "bad",
  "hard", "totally", "completely", "totaly",
  // when it happened
  "ago", "hr", "hrs", "hour", "hours", "min", "mins", "minute", "minutes",
  "sec", "secs", "week", "weeks", "month", "months", "last", "yday",
  "yesterday", "earlier", "morning", "night", "again",
  // what they did before it happened
  "buy", "bought", "sold", "aped", "ape", "invested", "put", "into", "out",
  "of", "went", "down", "all",
]);

/** Beyond this a message is telling a story, and a story usually names a thing. */
const MAX_DISTRESS_WORDS = 14;

/* ------------------------------ rank parsing ------------------------------ */

/** Sorting the caller can actually apply to a StockToken. */
const HOLDERS_RE = /\bholders?\b|\bholder\s*count\b|\bowners?\b|\bhold(?:ing|ers)\b/i;
const VOLUME_RE = /\bvolumes?\b|\btraded\b|\btrading\b|\bmost\s+active\b|\bturnover\b/i;
const PRICE_RE = /\bprices?\b|\bexpensive\b|\bpriciest\b|\bcheap(?:est)?\b|\bcosts?\b|\bper\s+share\b/i;
const MARKET_CAP_RE = /\bmarket\s*cap\b|\bmarketcap\b|\bmcap\b|\bcap\b|\bvaluable\b|\bvaluation\b|\bworth\b|\bsize\b/i;

/** Words that flip a ranking to ascending. */
const ASC_RE = /\bcheapest\b|\blowest\b|\bsmallest\b|\bworst\b|\bleast\b|\bfewest\b|\bbottom\b|\bascending\b/i;

/** "top 5", "best 3" — the count follows the ranking word. */
const COUNT_AFTER_RE = /\b(?:top|first|bottom|best|worst|cheapest|biggest|largest|smallest|highest|lowest)\s+(\d{1,3})\b/i;
/** "10 biggest", "5 stocks" — the count leads it. */
const COUNT_BEFORE_RE =
  /\b(\d{1,3})\s+(?:biggest|largest|top|best|worst|cheapest|smallest|highest|lowest|most|leading|stocks?|tokens?|equit(?:y|ies)|tickers?|compan(?:y|ies))\b/i;

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

/**
 * Turn a ranking question into sort parameters for the stock list.
 *
 * Defaults are marketCap / desc / 10: "top stocks" with nothing else said means
 * the biggest ones. Metric checks run holders -> volume -> price -> market cap
 * so the more specific word wins ("highest volume" is not a market-cap query),
 * and the limit is clamped to 1..25 because the caller pays for every row it
 * has to describe.
 *
 * @param {unknown} question
 * @returns {{ metric: "marketCap"|"holders"|"price"|"volume24h", direction: "desc"|"asc", limit: number }}
 */
export function parseRankQuery(question) {
  const q = typeof question === "string" ? question : "";

  let metric = "marketCap";
  if (HOLDERS_RE.test(q)) metric = "holders";
  else if (VOLUME_RE.test(q)) metric = "volume24h";
  else if (PRICE_RE.test(q)) metric = "price";
  else if (MARKET_CAP_RE.test(q)) metric = "marketCap";

  const direction = ASC_RE.test(q) ? "asc" : "desc";

  const m = q.match(COUNT_AFTER_RE) ?? q.match(COUNT_BEFORE_RE);
  const n = m ? Number.parseInt(m[1], 10) : NaN;
  const limit = Number.isFinite(n) ? Math.min(MAX_LIMIT, Math.max(1, n)) : DEFAULT_LIMIT;

  return { metric, direction, limit };
}
