/**
 * WHAT THE PRODUCT PROMISES IT CAN BE ASKED — the capability groups the docs page
 * renders, held here as plain data rather than inline in the page.
 *
 * WHY IT MOVED OUT OF THE PAGE. Every `asks` entry is a phrasing somebody reads
 * on app/(marketing)/docs/page.js and then types into the box, and the page tells
 * them which lookups answer it. That is a promise, and a promise nothing checks
 * is a promise that rots: a phrasing can stop routing where the page says it
 * goes, and the only way anyone would find out is by a reader being surprised.
 * As data it can be cross-checked offline against scripts/routing-corpus.mjs —
 * see test/routing-corpus.test.mjs, which fails if a listed phrasing has no
 * measured row or if the row's accepted lookups are not in the group beside it.
 *
 * A doc that promises behaviour the router does not deliver is the same class of
 * defect as an answer that promises data the chain does not have. Both are the
 * product saying something it cannot back.
 *
 * `asks` are verbatim from the tool descriptions in lib/ask-tools.js and from
 * measured phrasings — not invented examples. Ordered the way somebody arriving
 * from a link thinks rather than the way the tool file is organised.
 *
 * Plain data: no React, no next/*, importable by a test and by the page alike.
 */
export const CAPABILITY_GROUPS = Object.freeze([
  {
    id: "identity",
    title: "Identity & safety",
    lede: "Which contract is the real one, who deployed it, and how many others are wearing the same ticker.",
    asks: [
      "is this the real NVDA",
      "is 0x465… safe",
      "who deployed this",
      "is the contract verified",
      "whats that nvidia one called",
      "es real este token",
    ],
    tools: ["lookup_token", "safety_check", "contract_info", "search_tokens"],
    bound:
      "A safety check answers on one contract at a time and prints addresses in full so you can compare them character by character. Search is paginated: it reads at most 25 rows and, when there are more upstream, reports “at least N” — it can never list every impostor.",
  },
  {
    id: "market",
    title: "Price, market & the board",
    lede: "One token, two side by side, or the whole tokenized-equity market as it stands right now.",
    asks: [
      "hows nvda doin",
      "how much apple",
      "tsla vs nvda which is better",
      "top 3",
      "whats moving",
      "whats good today",
      "que es nvda",
    ],
    tools: ["lookup_token", "compare_tokens", "rank_stocks", "top_movers", "market_overview"],
    bound:
      "Only the equities the indexer published a figure for can be ranked; the rest come back counted as unmeasured, which is missing data and not zero activity. Aggregates say how many entries they cover.",
  },
  {
    id: "holders",
    title: "Holders & distribution",
    lede: "Who owns it, how long they have held, whether they arrived together, and what else that crowd holds.",
    asks: [
      "who holds nvda",
      "is this concentrated",
      "how long have holders held",
      "did they just buy",
      "was this bundled",
      "does this look organised",
      "who holds both 0x31ba… and 0xa15c…",
      "what else do these holders hold",
    ],
    tools: [
      "token_holders",
      "holder_hold_time",
      "bundle_check",
      "flag_patterns",
      "holder_overlap",
      "co_holdings",
    ],
    bound:
      "Hold times and bundle checks read the top addresses by balance, never the whole holder base. The pool, the burn address and the token contract itself are labelled and left out of the figures — none of them is a holder.",
  },
  {
    id: "flow",
    title: "Flow, trades & one transaction",
    lede: "What moved, and separately, who actually bought or sold — at a price, for a fee.",
    asks: [
      "whats moving in nvda",
      "whos dumping nvda",
      "who is selling right now",
      "is the volume real",
      "why did my swap eat 97% of my bag",
      "what happened here 0xdead…",
    ],
    tools: [
      "lookup_transaction",
      "token_transfers",
      "whale_moves",
      "recent_trades",
      "real_volume",
      "swap_detail",
    ],
    bound:
      "A transfer says something moved; a swap says somebody bought or sold. Swaps are read over a block window, so the only negative that can be stated is “no sell was observed in the N blocks read”. Uniswap v3 and v4 are read over different windows and their counts are never added.",
  },
  {
    id: "wallets",
    title: "Wallets",
    lede: "What one address holds, what it has done in one token, and who it deals with. A bare pasted address with nothing typed beside it is this, and it skips the routing turn to get there.",
    asks: [
      "whats in 0xabc…",
      // Moved from "A whole project", which is where the page used to promise it
      // and is not where it goes: lib/ask-loop.js fastPathRoute answers a bare
      // address with the account lookup without asking the model anything.
      "0x31be…bf81",
      "is this a whale",
      "has this wallet ever sold nvda",
      // WAS "is this guy accumulating", with no subject at all. Measured, the
      // lookup it is filed under cannot answer that: trace_wallet needs a wallet
      // AND a token, and a question naming neither routes anywhere it likes. The
      // placeholder its neighbours already carried is the honest form.
      "is this guy accumulating 0xabc…",
      "who does this wallet trade with",
      "cuanto tiene 0xabc…",
    ],
    tools: ["lookup_wallet", "wallet_portfolio", "trace_wallet", "wallet_counterparties"],
    bound:
      "A trace walks at most 150 transfers over three pages, so “no sale in the transfers read” is the honest answer and “never sold” is not. A portfolio total covers the priced holdings only; an unpriced token is unquoted, never worthless.",
  },
  {
    id: "investigation",
    title: "Following the money",
    lede: "Where value went and where it came from, across every token, with what can be established about each address on the other side. This is the one to reach for after a drain: what left, when, to whom, and which trails are worth chasing.",
    asks: [
      "where did the funds go from 0xabc…",
      "my wallet was drained, show me the last transfers out",
      "trace the nvda that left 0xabc…",
      "who did this address send to",
      "a donde fueron los fondos",
    ],
    tools: ["wallet_flows", "trace_funds"],
    bound:
      "An address's role is established where it can be — a burn address, an issuer-verified equity contract, whether it is a contract at all — and everything about behaviour is a SHAPE carried with the ordinary explanations that produce it, because an exchange deposit, a payment processor and somebody's own consolidation wallet are identical from here. Explorer labels are quoted as the explorer's claim, never as fact. Two addresses are never said to share an owner. In a trace, value that reached a pool was traded rather than paid to anyone and is counted apart from value that stopped; a trail that could not be read to the end is open, which is not the same as held.",
  },
  {
    id: "projects",
    title: "A whole project",
    // WAS "…A bare pasted address with no question attached is this one." It is
    // not, and the routing bench is what established that: a bare address never
    // reaches the model at all. lib/ask-loop.js fastPathRoute intercepts it and
    // spends one completion on the address lookup, which is why a pasted address
    // answers in a couple of seconds instead of ten. Measured 3/3 as lookup_wallet.
    // The page said project_profile, so the page was wrong — and so, harmlessly,
    // are the same words in project_profile's own description and in
    // SYSTEM_PROMPT, which describe a turn the fast path never lets happen.
    // Whatever a reader types BESIDE the address is what reaches this lookup.
    lede: "One lookup for the question people actually ask about a token they were sent. Type anything at all beside the address — “is this legit”, “check this out” — and this is what answers it; a bare address on its own goes to the faster account lookup instead.",
    asks: [
      "is this project real",
      "is this a larp",
      "check this out for me",
      "whats the deal with this one",
      "wen moon or is it fake",
      // "0x31be…bf81" used to sit here. It moved to the Wallets group, where the
      // fast path actually sends it — see the lede above.
      //
      // Same correction as the wallets group: project_profile profiles a
      // CONTRACT, so the bare question had nothing to profile. The address is
      // what makes the promise keepable.
      "这个项目是真的吗 0x31be…",
    ],
    tools: ["project_profile", "ask_clarification"],
    bound:
      "It produces observations, never a verdict and never intent. A launchpad deployment is an ordinary, cheap way to launch a token and is not evidence of dishonesty; being new, small, thinly traded or concentrated is not either. Links found in the launch calldata are self-declared by whoever launched the token and are not fetched or verified.",
  },
]);
