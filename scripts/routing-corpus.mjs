/**
 * THE ROUTING CORPUS — questions paired with the lookup that should handle them.
 *
 * WHY THIS FILE EXISTS. A question naming a contract routes to a different tool
 * on different days, and sometimes to no tool at all. Nobody could see that,
 * because there was no score. This is the score's input: the ground truth a
 * routing turn is measured against. scripts/route-bench.mjs runs it.
 *
 * WHERE THE PHRASINGS COME FROM. Almost none of them are invented. Each row
 * carries a `source`:
 *   "tool"   — verbatim from the trigger phrasings inside a tool's own
 *              description in lib/ask-tools.js. If routing cannot reach a
 *              phrasing the tool advertises, the description is a lie.
 *   "prompt" — verbatim from SYSTEM_PROMPT in lib/ask-runner.js, which lists
 *              its own trigger phrasings and sometimes contradicts the tool.
 *   "docs"   — verbatim from app/(marketing)/docs/page.js, the page people read
 *              to learn what the product does. A miss here is a broken promise
 *              made in public.
 *   "live"   — a phrasing measured failing on chainmind.fun or against Groq.
 *   "gap"    — written here because a tool had no advertised phrasing worth
 *              testing, or because a collision needed a probe from both sides.
 *
 * ACCEPT IS A SET, NOT A NAME. `accept` holds every tool-call outcome a
 * defensible router could produce, each as its own array of tool names (an
 * empty array is "no tool at all"). A corpus that scores a defensible choice as
 * wrong drives the fix in a bad direction — so where two lookups honestly both
 * answer the question, both are in, and `why` says what the reader loses by
 * getting one rather than the other. Where the answer really is one tool, there
 * is one entry and the row is worth failing on.
 *
 * PRIMARY IS FOR REPORTING, NOT FOR SCORING. `primary` is the tool the row was
 * written to exercise, so the bench can say "co_holdings: 3 rows, 2 correct". A
 * row is CORRECT if its outcome matches ANY entry in `accept`; `primary` never
 * decides that.
 *
 * THE ADDRESSES ARE SHAPE-VALID AND DRAWN FROM THIS REPO'S OWN FIXTURES. Routing
 * happens before any lookup runs, so nothing here is dereferenced and no row's
 * correctness depends on what is at the address — but using real ones keeps the
 * questions honest and lets a failing row be re-run by hand against the live site.
 */

/** The token from the live defect report — "Eska", chain 4663. See lib/project-profile.js. */
export const ESKA = "0x0eb9960654d3661d551a4536d7d425184ec81756";
/** The site the user pasted alongside it in the live failures. */
export const ESKA_SITE = "https://eska.fun/";
/** The two contracts SYSTEM_PROMPT and the docs page use for overlap examples. */
export const TOKEN_A = "0x31ba1d706d9e6a4f183651d0f3631b6cfb2ac6cc";
export const TOKEN_B = "0xa15cd06dd305269a0f48bebeb30aa3588fba7b32";
/** A third contract, used where the docs page shows a bare pasted address. */
export const TOKEN_C = "0x31be8f7485e36928c9de86566c62da82d4b6bf81";
/** An ordinary address, used where the subject is a wallet rather than a token. */
export const WALLET = "0x4783c67b63de2b358ac5951a7d41f47a38f3c046";
/** A second wallet, for questions that name a wallet and a token. */
export const WALLET_B = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
/** A transaction hash — 64 hex, so the shape itself rules out lookup_wallet. */
export const TXHASH = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

/**
 * The collisions that actually happen, named so the bench can report each one as
 * its own confusion matrix rather than burying it in a global average.
 *
 * These are not every pair of tools that could be confused — they are the pairs
 * measured colliding, plus the two the tool descriptions themselves flag.
 */
export const COLLISIONS = Object.freeze({
  DILIGENCE: "project_profile / lookup_token / safety_check / contract_info",
  FLOW: "recent_trades / token_transfers / whale_moves",
  CROSS: "holder_overlap / co_holdings",
  WALLET: "lookup_wallet / wallet_portfolio",
  BOARD: "rank_stocks / top_movers / market_overview",
});

/**
 * @typedef {object} CorpusRow
 * @property {string} id           - stable, so a failing row can be named in a commit message
 * @property {string} q            - the question, exactly as a user would type it
 * @property {string} [target]     - body.target, when the row is asked from a page showing something
 * @property {string} primary      - the tool this row exists to exercise (reporting only)
 * @property {string[][]} accept   - every defensible outcome; [] inside means "no tool"
 * @property {string} source       - tool | prompt | docs | live | gap
 * @property {string} [collision]  - a COLLISIONS key, when the row probes a known pair
 * @property {string} [why]        - required whenever accept has more than one entry
 */

/** @type {ReadonlyArray<CorpusRow>} */
export const CORPUS = Object.freeze([
  /* ---------------------------------------------------------------------- *
   * 1. THE LIVE DEFECT. Four phrasings of one intent, measured routing four
   *    different ways on chainmind.fun. Every one of them is the same request:
   *    tell me whether this project is what it says it is.
   * ---------------------------------------------------------------------- */
  {
    id: "live-1",
    q: `check out this project ${ESKA} and look at ${ESKA_SITE}`,
    primary: "project_profile",
    accept: [["project_profile"]],
    source: "live",
    collision: "DILIGENCE",
    why:
      "The user supplied the URL themselves, which is the one case project_profile's `url` parameter exists for. " +
      "Routed to lookup_token live — an answer about price and holders to a question about whether a project is real.",
  },
  {
    id: "live-2",
    q: `is this project real? ${ESKA} — examine the site ${ESKA_SITE}`,
    primary: "project_profile",
    accept: [["project_profile"]],
    source: "live",
    collision: "DILIGENCE",
    why: "\"is this project real\" is verbatim in project_profile's description. Routed to safety_check live.",
  },
  {
    id: "live-3",
    q: `is this a larp ${ESKA} ${ESKA_SITE}`,
    primary: "project_profile",
    accept: [["project_profile"]],
    source: "live",
    collision: "DILIGENCE",
    why: "\"is this a larp\" is verbatim in project_profile's description AND in SYSTEM_PROMPT. Routed to lookup_token live.",
  },
  {
    id: "live-4",
    q: `give me the full diligence picture for ${ESKA}`,
    primary: "project_profile",
    accept: [["project_profile"]],
    source: "live",
    collision: "DILIGENCE",
    why: "The only one of the four that routed correctly live. It is in the corpus as the control.",
  },

  /* ---------------------------------------------------------------------- *
   * 2. THE NO_TOOL DEFECT. Every row here names a 0x contract. A routing turn
   *    that answers one of these with no tool call has answered about a named
   *    on-chain target without reading the chain, which is the failure this
   *    product cannot have. The bench counts these separately and by name.
   * ---------------------------------------------------------------------- */
  {
    id: "notool-1",
    q: `check this out for me ${ESKA}`,
    primary: "project_profile",
    accept: [["project_profile"]],
    source: "tool",
    collision: "DILIGENCE",
    why: "\"check this out for me\" is verbatim in project_profile's description, in SYSTEM_PROMPT and on the docs page. Measured NO_TOOL 3/3 at both temperatures.",
  },
  {
    id: "notool-2",
    q: `is this legit ${ESKA}`,
    primary: "safety_check",
    accept: [["safety_check"], ["project_profile"]],
    source: "tool",
    collision: "DILIGENCE",
    why:
      "\"is this legit\" is verbatim in BOTH safety_check's and project_profile's descriptions, and SYSTEM_PROMPT lists it under project_profile. " +
      "Both are defensible readings of a two-word question, so both are accepted — the failure worth catching is NO_TOOL, which was measured 1/3 at 0.2 and 2/3 at temperature 0.",
  },
  {
    id: "notool-3",
    q: `is this a larp ${ESKA}`,
    primary: "project_profile",
    accept: [["project_profile"]],
    source: "tool",
    collision: "DILIGENCE",
    why: "Same phrasing as live-3 with the URL removed, to separate 'the URL confused it' from 'the phrasing did'.",
  },
  {
    id: "notool-4",
    q: `whats the deal with this one ${ESKA}`,
    primary: "project_profile",
    accept: [["project_profile"]],
    source: "tool",
    collision: "DILIGENCE",
  },
  {
    id: "notool-5",
    q: `wen moon or is it fake ${ESKA}`,
    primary: "project_profile",
    accept: [["project_profile"], ["safety_check"]],
    source: "docs",
    collision: "DILIGENCE",
    why: "On the docs page under \"A whole project\". \"fake\" also reads as an authenticity question, so safety_check is defensible.",
  },
  {
    id: "notool-6",
    q: `is there anything behind this ${ESKA}`,
    primary: "project_profile",
    accept: [["project_profile"]],
    source: "tool",
    collision: "DILIGENCE",
  },
  {
    id: "notool-7",
    q: `tell me about this project ${ESKA}`,
    primary: "project_profile",
    accept: [["project_profile"]],
    source: "tool",
    collision: "DILIGENCE",
  },
  {
    id: "notool-8",
    // CHANGED FROM project_profile, and only this field: `accept` is untouched, so
    // every accuracy figure this row contributes to is the same before and after.
    // `primary` is the tool the row exists to EXERCISE, and the contradiction the
    // previous note describes has since been settled — in favour of the code.
    // Measured 3/3 as lookup_wallet, deterministically, because the fast path
    // decides it and the fast path does not sample. So this row exercises that.
    primary: "lookup_wallet",
    q: TOKEN_C,
    accept: [["project_profile"], ["lookup_wallet"], ["lookup_token"]],
    source: "docs",
    collision: "DILIGENCE",
    why:
      "A bare pasted address with no question. project_profile's description and SYSTEM_PROMPT both claim it; the docs page listed it under \"A whole project\". " +
      "But lib/ask-loop.js fastPathRoute intercepts a bare address to lookup_wallet before the model ever sees it, so the product's own answer is lookup_wallet — and it always is, on every repetition, because no model is asked. " +
      "SETTLED IN FAVOUR OF THE CODE: the docs page now files a bare address under Wallets and says it skips the routing turn, because the fast path is why a pasted address answers in seconds and buying it a full diligence profile instead would be a latency change dressed up as a docs fix. " +
      "The claims left in project_profile's description and in SYSTEM_PROMPT are harmless but unreachable — worth knowing when reading either file. " +
      "All three outcomes stay accepted because the disagreement was between our own components, not a routing mistake.",
  },

  /* ---------------------------------------------------------------------- *
   * 3. THE DILIGENCE COLLISION FROM THE OTHER SIDE. Rows that must NOT become
   *    project_profile. Without these the corpus could be satisfied by a router
   *    that sends everything with a 0x in it to project_profile, which would be
   *    a different bug with the same score.
   * ---------------------------------------------------------------------- */
  {
    id: "coll-safety-1",
    q: "is this the real NVDA",
    primary: "safety_check",
    accept: [["safety_check"]],
    source: "docs",
    collision: "DILIGENCE",
    why: "A real company's ticker plus an authenticity question is exactly the line safety_check's description draws against project_profile.",
  },
  {
    id: "coll-safety-2",
    q: `is ${TOKEN_A} safe`,
    primary: "safety_check",
    accept: [["safety_check"]],
    source: "docs",
    collision: "DILIGENCE",
  },
  {
    id: "coll-safety-3",
    q: "es real este token nvda",
    primary: "safety_check",
    accept: [["safety_check"]],
    source: "docs",
    collision: "DILIGENCE",
    why: "Spanish. The tool descriptions promise every language; this row is what holds them to it.",
  },
  {
    id: "coll-safety-4",
    q: "is this a rug tsla",
    primary: "safety_check",
    accept: [["safety_check"]],
    source: "tool",
    collision: "DILIGENCE",
  },
  {
    id: "coll-contract-1",
    q: `who deployed this ${ESKA}`,
    primary: "contract_info",
    accept: [["contract_info"]],
    source: "docs",
    collision: "DILIGENCE",
    why: "The deployment record alone. project_profile would answer it too, but at several times the cost and with a page of unasked-for findings — contract_info's description says so explicitly.",
  },
  {
    id: "coll-contract-2",
    q: "is the contract verified nvda",
    primary: "contract_info",
    accept: [["contract_info"]],
    source: "docs",
    collision: "DILIGENCE",
  },
  {
    id: "coll-contract-3",
    q: `how old is this token ${ESKA}`,
    primary: "contract_info",
    accept: [["contract_info"]],
    source: "tool",
    collision: "DILIGENCE",
  },
  {
    id: "coll-contract-4",
    q: `quien lo desplego ${ESKA}`,
    primary: "contract_info",
    accept: [["contract_info"]],
    source: "tool",
    collision: "DILIGENCE",
    why: "Spanish, verbatim from contract_info's description.",
  },
  {
    id: "coll-token-1",
    q: `whats the price of ${ESKA}`,
    primary: "lookup_token",
    accept: [["lookup_token"]],
    source: "gap",
    collision: "DILIGENCE",
    why: "A 0x address with a question about ONE figure. project_profile here would be the substitution its own description warns against.",
  },
  {
    id: "coll-token-2",
    q: `what is ${ESKA}`,
    primary: "lookup_token",
    accept: [["lookup_token"], ["project_profile"], ["lookup_wallet"]],
    source: "tool",
    collision: "DILIGENCE",
    why:
      "\"what is 0x1234...\" is verbatim in lookup_token's description, and a bare address with a bare question is project_profile's advertised case. " +
      "Genuinely two readings of four words; lookup_wallet is here because the fast path may reach this row.",
  },

  /* ---------------------------------------------------------------------- *
   * 4. lookup_token — one company, one ticker, one figure.
   * ---------------------------------------------------------------------- */
  { id: "token-1", q: "hows nvda doin", primary: "lookup_token", accept: [["lookup_token"]], source: "docs" },
  { id: "token-2", q: "how much apple", primary: "lookup_token", accept: [["lookup_token"]], source: "docs" },
  { id: "token-3", q: "que es nvda", primary: "lookup_token", accept: [["lookup_token"]], source: "docs" },
  { id: "token-4", q: "i wanna know about apple", primary: "lookup_token", accept: [["lookup_token"]], source: "tool" },
  {
    id: "token-5",
    q: "nvdia",
    primary: "lookup_token",
    accept: [["lookup_token"], ["search_tokens"]],
    source: "tool",
    why: "A typo'd bare company name. lookup_token's description says to fix the typo and call it; search_tokens' says to use it when the user cannot name the ticker. Both leave the reader better off.",
  },

  /* ---------------------------------------------------------------------- *
   * 5. lookup_wallet / wallet_portfolio — the collision the two descriptions
   *    create between themselves.
   * ---------------------------------------------------------------------- */
  {
    id: "wallet-1",
    q: `whats in ${WALLET}`,
    primary: "lookup_wallet",
    accept: [["lookup_wallet"], ["wallet_portfolio"]],
    source: "tool",
    collision: "WALLET",
    why: "\"whats in 0xabc...\" is verbatim in lookup_wallet's description and \"whats in this wallet\" is verbatim in wallet_portfolio's. Both answer it; the corpus refuses to score a real ambiguity as a mistake.",
  },
  {
    id: "wallet-2",
    q: `is this a whale ${WALLET}`,
    primary: "lookup_wallet",
    accept: [["lookup_wallet"], ["wallet_portfolio"]],
    source: "docs",
    collision: "WALLET",
    why: "\"is this a whale\" is verbatim in lookup_wallet's description, but the answer is what the address holds and what it is worth, which is wallet_portfolio's whole job.",
  },
  {
    id: "wallet-3",
    q: `cuanto tiene ${WALLET}`,
    primary: "lookup_wallet",
    accept: [["lookup_wallet"], ["wallet_portfolio"]],
    source: "docs",
    collision: "WALLET",
    why: "Spanish, verbatim from both descriptions.",
  },
  {
    id: "portfolio-1",
    q: `show me the bags in ${WALLET}`,
    primary: "wallet_portfolio",
    accept: [["wallet_portfolio"], ["lookup_wallet"]],
    source: "tool",
    collision: "WALLET",
    why: "\"show me the bags\" is verbatim in wallet_portfolio's description; lookup_wallet returns a shorter version of the same holdings and is not a wrong answer to it.",
  },
  {
    id: "portfolio-2",
    q: `does ${WALLET} hold any nvda`,
    primary: "wallet_portfolio",
    accept: [["wallet_portfolio"], ["trace_wallet"]],
    source: "tool",
    collision: "WALLET",
    why:
      "wallet_portfolio's description claims \"does it hold any nvda\" and SYSTEM_PROMPT says one portfolio read settles whether a wallet holds a named token. " +
      "trace_wallet also answers it and adds whether the wallet ever sold, so it is defensible rather than wrong.",
  },

  /* ---------------------------------------------------------------------- *
   * 6. lookup_transaction / swap_detail — the same 64-hex input, two questions.
   * ---------------------------------------------------------------------- */
  {
    id: "tx-1",
    q: `what happened here ${TXHASH}`,
    primary: "lookup_transaction",
    accept: [["lookup_transaction"]],
    source: "docs",
  },
  {
    id: "tx-2",
    q: `did this go through ${TXHASH}`,
    primary: "lookup_transaction",
    accept: [["lookup_transaction"]],
    source: "tool",
  },
  {
    id: "swap-1",
    q: `why did my swap eat 97% of my bag ${TXHASH}`,
    primary: "swap_detail",
    accept: [["swap_detail"]],
    source: "docs",
    why: "The fee is the answer and only swap_detail reads it. lookup_transaction would return a transfer list and leave the reader none the wiser — the substitution SYSTEM_PROMPT forbids.",
  },
  {
    id: "swap-2",
    q: `what fee did I pay on ${TXHASH}`,
    primary: "swap_detail",
    accept: [["swap_detail"]],
    source: "tool",
  },
  {
    id: "swap-3",
    q: `por que recibi tan poco ${TXHASH}`,
    primary: "swap_detail",
    accept: [["swap_detail"]],
    source: "tool",
    why: "Spanish, verbatim from swap_detail's description.",
  },

  /* ---------------------------------------------------------------------- *
   * 7. The board: rank_stocks / top_movers / market_overview. Three tools over
   *    one dataset, separated only by what the question asks for.
   * ---------------------------------------------------------------------- */
  {
    id: "rank-1",
    q: "top 3",
    primary: "rank_stocks",
    accept: [["rank_stocks"], ["top_movers"]],
    source: "docs",
    collision: "BOARD",
    why: "\"top 3\" is verbatim in rank_stocks' description; with no metric named, top_movers' default ranking answers the same question a reader would accept.",
  },
  {
    id: "rank-2",
    q: "whos got the most bags",
    primary: "rank_stocks",
    accept: [["rank_stocks"], ["top_movers"]],
    source: "tool",
    collision: "BOARD",
    why: "rank_stocks' description names this exact phrasing and says it means the holders metric. top_movers can rank on holders too.",
  },
  {
    id: "rank-3",
    q: "cheapest stock",
    primary: "rank_stocks",
    accept: [["rank_stocks"]],
    source: "tool",
    collision: "BOARD",
    why: "Ascending by price. top_movers has no ascending direction, so this one really is rank_stocks alone.",
  },
  {
    id: "rank-4",
    q: "los mas grandes",
    primary: "rank_stocks",
    accept: [["rank_stocks"], ["top_movers"], ["market_overview"]],
    source: "tool",
    collision: "BOARD",
    why: "Spanish, verbatim from rank_stocks. \"the biggest ones\" with no count is close enough to an overview that market_overview is defensible.",
  },
  {
    id: "movers-1",
    q: "whats hot today",
    primary: "top_movers",
    accept: [["top_movers"], ["market_overview"]],
    source: "tool",
    collision: "BOARD",
    why: "top_movers' description claims it; market_overview's claims \"whats good today\". The two descriptions overlap by construction.",
  },
  {
    id: "movers-2",
    q: "most active stocks",
    primary: "top_movers",
    accept: [["top_movers"], ["rank_stocks"]],
    source: "tool",
    collision: "BOARD",
    why: "Both descriptions claim \"most active\" and both rank on volume24h. The two tools return the same ordering for this question.",
  },
  {
    id: "movers-3",
    q: "whats moving",
    primary: "top_movers",
    accept: [["top_movers"], ["market_overview"]],
    source: "docs",
    collision: "BOARD",
    why: "\"whats moving\" is verbatim in top_movers' description; with nothing named, the market-as-a-whole reading market_overview claims is also fair.",
  },
  {
    id: "market-1",
    q: "hows the market",
    primary: "market_overview",
    accept: [["market_overview"], ["top_movers"]],
    source: "tool",
    collision: "BOARD",
    why: "market_overview's description claims it. top_movers answers the same question one metric at a time and loses the aggregate totals, which is a thinner answer rather than a wrong one.",
  },
  {
    id: "market-2",
    q: "show me whats poppin",
    primary: "market_overview",
    accept: [["market_overview"], ["top_movers"]],
    source: "tool",
    collision: "BOARD",
    why: "Verbatim in market_overview's description; \"poppin\" also reads straightforwardly as activity, which is top_movers.",
  },
  {
    id: "market-3",
    q: "give me an overview",
    primary: "market_overview",
    accept: [["market_overview"]],
    source: "tool",
    collision: "BOARD",
    why: "Asks for the board as a whole and names no metric and no count, which is the one shape only market_overview fits.",
  },

  /* ---------------------------------------------------------------------- *
   * 8. compare_tokens — two or more named subjects.
   * ---------------------------------------------------------------------- */
  {
    id: "compare-1",
    q: "tsla vs nvda which is better",
    primary: "compare_tokens",
    accept: [["compare_tokens"]],
    source: "docs",
    why: "Two subjects. SYSTEM_PROMPT: answering about one and ignoring the other is the worst failure available here.",
  },
  {
    id: "compare-2",
    q: "cual es mejor, tsla o nvda",
    primary: "compare_tokens",
    accept: [["compare_tokens"]],
    source: "tool",
    why: "Spanish, verbatim from compare_tokens' description.",
  },
  {
    id: "compare-3",
    q: "aapl vs msft vs googl",
    primary: "compare_tokens",
    accept: [["compare_tokens"]],
    source: "tool",
  },

  /* ---------------------------------------------------------------------- *
   * 9. search_tokens — the user cannot name the ticker.
   * ---------------------------------------------------------------------- */
  {
    id: "search-1",
    q: "whats that nvidia one called",
    primary: "search_tokens",
    accept: [["search_tokens"], ["lookup_token"]],
    source: "docs",
    why: "search_tokens' description claims the phrasing; lookup_token resolves \"nvidia\" directly and would also land on the answer.",
  },
  {
    id: "search-2",
    q: "find tokens with berk in the name",
    primary: "search_tokens",
    accept: [["search_tokens"]],
    source: "tool",
    why: "A fragment, not a name. Only search_tokens takes a partial.",
  },
  {
    id: "search-3",
    q: "which tickers start with mc",
    primary: "search_tokens",
    accept: [["search_tokens"]],
    source: "tool",
  },

  /* ---------------------------------------------------------------------- *
   * 10. Holders and distribution.
   * ---------------------------------------------------------------------- */
  {
    id: "holders-1",
    q: "who holds nvda",
    primary: "token_holders",
    accept: [["token_holders"]],
    source: "docs",
  },
  {
    id: "holders-2",
    q: `is this concentrated ${ESKA}`,
    primary: "token_holders",
    accept: [["token_holders"]],
    source: "docs",
  },
  {
    id: "holders-3",
    q: "quien tiene mas nvda",
    primary: "token_holders",
    accept: [["token_holders"]],
    source: "tool",
    why: "Spanish, verbatim from token_holders' description.",
  },
  {
    id: "holdtime-1",
    q: "how long have holders held nvda",
    primary: "holder_hold_time",
    accept: [["holder_hold_time"]],
    source: "docs",
  },
  {
    id: "holdtime-2",
    q: `did they just buy ${ESKA}`,
    primary: "holder_hold_time",
    accept: [["holder_hold_time"], ["bundle_check"]],
    source: "docs",
    why: "holder_hold_time's description claims the phrasing. \"just buy\" also reads as \"did they all arrive at once\", which is bundle_check — the two are read off the same measurement.",
  },
  {
    id: "holdtime-3",
    q: `are they diamond handing ${ESKA}`,
    primary: "holder_hold_time",
    accept: [["holder_hold_time"]],
    source: "tool",
  },
  {
    id: "bundle-1",
    q: `was this bundled ${ESKA}`,
    primary: "bundle_check",
    accept: [["bundle_check"]],
    source: "docs",
  },
  {
    id: "bundle-2",
    q: `did they snipe their own launch ${ESKA}`,
    primary: "bundle_check",
    accept: [["bundle_check"]],
    source: "tool",
  },
  {
    id: "bundle-3",
    q: `esto fue bundleado ${ESKA}`,
    primary: "bundle_check",
    accept: [["bundle_check"]],
    source: "tool",
    why: "Spanish, verbatim from bundle_check's description.",
  },
  {
    id: "flag-1",
    q: `does this look organised ${ESKA}`,
    primary: "flag_patterns",
    accept: [["flag_patterns"]],
    source: "docs",
  },
  {
    id: "flag-2",
    q: `anything weird here ${ESKA}`,
    primary: "flag_patterns",
    accept: [["flag_patterns"]],
    source: "tool",
  },
  {
    id: "flag-3",
    q: `is this wash trading ${ESKA}`,
    primary: "flag_patterns",
    accept: [["flag_patterns"], ["real_volume"]],
    source: "tool",
    why:
      "\"is this wash trading\" is verbatim in BOTH flag_patterns' and real_volume's descriptions. flag_patterns reads transfers, real_volume reads swaps; " +
      "the swap reading is the better one and the transfer reading is the advertised one, so both stand until one description is changed.",
  },

  /* ---------------------------------------------------------------------- *
   * 11. Cross-token: holder_overlap vs co_holdings. The distinction is whether
   *     the OTHER token is named — the one collision SYSTEM_PROMPT spells out.
   * ---------------------------------------------------------------------- */
  {
    id: "overlap-1",
    q: `what wallet in this coin ${TOKEN_A} also bought this: ${TOKEN_B}`,
    primary: "holder_overlap",
    accept: [["holder_overlap"]],
    source: "tool",
    collision: "CROSS",
    why: "Verbatim from holder_overlap's description. Two tokens named, so the subject is the relation — answering about one of them is the failure this lookup exists to fix.",
  },
  {
    id: "overlap-2",
    q: `who holds both ${TOKEN_A} and ${TOKEN_B}`,
    primary: "holder_overlap",
    accept: [["holder_overlap"]],
    source: "docs",
    collision: "CROSS",
  },
  {
    id: "overlap-3",
    q: `do these two share holders — ${TOKEN_A} ${TOKEN_B}`,
    primary: "holder_overlap",
    accept: [["holder_overlap"]],
    source: "tool",
    collision: "CROSS",
  },
  {
    id: "overlap-4",
    q: `welche wallets halten beide ${TOKEN_A} ${TOKEN_B}`,
    primary: "holder_overlap",
    accept: [["holder_overlap"]],
    source: "tool",
    collision: "CROSS",
    why: "German, verbatim from holder_overlap's description.",
  },
  {
    id: "coholding-1",
    q: `what else do these holders hold ${ESKA}`,
    primary: "co_holdings",
    accept: [["co_holdings"]],
    source: "docs",
    collision: "CROSS",
    why: "ONE token named and the other side left open — the exact line co_holdings' description draws against holder_overlap.",
  },
  {
    id: "coholding-2",
    q: `what other coins do the top holders own ${ESKA}`,
    primary: "co_holdings",
    accept: [["co_holdings"]],
    source: "tool",
    collision: "CROSS",
  },
  {
    id: "coholding-3",
    q: `que mas tienen estos holders ${ESKA}`,
    primary: "co_holdings",
    accept: [["co_holdings"]],
    source: "tool",
    collision: "CROSS",
    why: "Spanish, verbatim from co_holdings' description.",
  },

  /* ---------------------------------------------------------------------- *
   * 12. Flow: token_transfers / whale_moves / recent_trades. A transfer says
   *     something moved; a swap says somebody bought or sold. The descriptions
   *     of all three claim "who is dumping".
   * ---------------------------------------------------------------------- */
  {
    id: "transfers-1",
    q: "whats moving in nvda",
    primary: "token_transfers",
    accept: [["token_transfers"]],
    source: "docs",
    collision: "FLOW",
    why: "Movement in one token, no size and no time window named — token_transfers' plain case.",
  },
  {
    id: "transfers-2",
    q: `recent transfers ${ESKA}`,
    primary: "token_transfers",
    accept: [["token_transfers"]],
    source: "tool",
    collision: "FLOW",
  },
  {
    id: "transfers-3",
    q: `que se ha movido en ${ESKA}`,
    primary: "token_transfers",
    accept: [["token_transfers"]],
    source: "tool",
    collision: "FLOW",
    why: "Spanish, verbatim from token_transfers' description.",
  },
  {
    id: "whale-1",
    q: "whos dumping nvda",
    primary: "whale_moves",
    accept: [["whale_moves"], ["recent_trades"]],
    source: "docs",
    collision: "FLOW",
    why:
      "\"who is dumping\" is verbatim in BOTH whale_moves' and recent_trades' descriptions — whale_moves calls itself \"the lookup for who is dumping\" and recent_trades opens with the same words. " +
      "The reader is served either way; a corpus that picked one would be inventing a distinction the tools do not make.",
  },
  {
    id: "whale-2",
    q: `biggest transfers today ${ESKA}`,
    primary: "whale_moves",
    accept: [["whale_moves"]],
    source: "tool",
    collision: "FLOW",
    why: "\"biggest transfers\" is size over a long history, which is whale_moves and not the swap window.",
  },
  {
    id: "whale-3",
    q: `has someone sold a load of ${ESKA}`,
    primary: "whale_moves",
    accept: [["whale_moves"], ["recent_trades"]],
    source: "tool",
    collision: "FLOW",
    why: "Verbatim in whale_moves' description. \"sold\" is a swap word and no time is named, so the swap reading stands too.",
  },
  {
    id: "trades-1",
    q: `who is selling right now ${ESKA}`,
    primary: "recent_trades",
    accept: [["recent_trades"]],
    source: "docs",
    collision: "FLOW",
    why: "\"right now\" is a block window, which is the swap lookup. whale_moves reads a long transfer history and cannot answer \"now\".",
  },
  {
    id: "trades-2",
    q: `who bought in the last hour ${ESKA}`,
    primary: "recent_trades",
    accept: [["recent_trades"]],
    source: "tool",
    collision: "FLOW",
  },
  {
    id: "trades-3",
    q: `is anyone actually trading this ${ESKA}`,
    primary: "recent_trades",
    accept: [["recent_trades"], ["real_volume"]],
    source: "tool",
    collision: "FLOW",
    why: "recent_trades' description claims the phrasing; real_volume answers the fuller version of the same doubt.",
  },
  {
    id: "volume-1",
    q: `is the volume real ${ESKA}`,
    primary: "real_volume",
    accept: [["real_volume"]],
    source: "docs",
    collision: "FLOW",
  },
  {
    id: "volume-2",
    q: `is one guy trading with himself ${ESKA}`,
    primary: "real_volume",
    accept: [["real_volume"]],
    source: "tool",
    collision: "FLOW",
  },
  {
    id: "volume-3",
    q: `es volumen real ${ESKA}`,
    primary: "real_volume",
    accept: [["real_volume"]],
    source: "tool",
    collision: "FLOW",
    why: "Spanish, verbatim from real_volume's description.",
  },

  /* ---------------------------------------------------------------------- *
   * 13. Wallet behaviour: trace_wallet and wallet_counterparties.
   * ---------------------------------------------------------------------- */
  {
    id: "trace-1",
    q: `has ${WALLET} ever sold nvda`,
    primary: "trace_wallet",
    accept: [["trace_wallet"]],
    source: "docs",
    why: "One wallet and one token, and only trace_wallet carries hasSold.",
  },
  {
    id: "pnl-1",
    q: `is ${WALLET} in profit on nvda`,
    primary: "wallet_pnl",
    accept: [["wallet_pnl"]],
    source: "tool",
    why: "Profit needs a cost basis, and wallet_pnl is the only tool that computes one.",
  },
  {
    id: "pnl-2",
    q: `whats the pnl for ${WALLET_B} on tsla`,
    primary: "wallet_pnl",
    accept: [["wallet_pnl"]],
    source: "live",
    why: "The live phrasing that produced an invented \"could not read the history\" excuse before this tool existed.",
  },
  {
    id: "pnl-3",
    q: `how much has ${WALLET} made on nvda`,
    primary: "wallet_pnl",
    // trace_wallet is defensible: it names the same two subjects and answers what
    // the wallet DID, which is the honest neighbour when no basis can be proven.
    accept: [["wallet_pnl"], ["trace_wallet"]],
    source: "tool",
    why: "Made-money phrasing is wallet_pnl; trace_wallet reads the same two subjects and is the nearest honest answer.",
  },
  {
    id: "trace-2",
    q: `when did ${WALLET_B} start buying tsla`,
    primary: "trace_wallet",
    accept: [["trace_wallet"]],
    source: "tool",
  },
  {
    id: "counterparty-1",
    q: `who does ${WALLET} trade with`,
    primary: "wallet_counterparties",
    accept: [["wallet_counterparties"]],
    source: "docs",
    why:
      "lookup_wallet's description also lists \"who does this wallet trade with\", but wallet_counterparties is the ranked answer and lookup_wallet only shows a sample. " +
      "Scored strictly on purpose: this is a description collision worth fixing rather than tolerating.",
  },
  {
    id: "counterparty-2",
    q: `whos on the other side of ${WALLET}`,
    primary: "wallet_counterparties",
    accept: [["wallet_counterparties"]],
    source: "tool",
  },
  {
    id: "counterparty-3",
    q: `con quien opera ${WALLET}`,
    primary: "wallet_counterparties",
    accept: [["wallet_counterparties"]],
    source: "tool",
    why: "Spanish, verbatim from wallet_counterparties' description.",
  },

  /* ---------------------------------------------------------------------- *
   * 14. ask_clarification — the one tool that looks nothing up. Its bar is
   *     deliberately high, so there is one row that should reach it and two
   *     that must NOT, because over-asking is the failure mode it invites.
   * ---------------------------------------------------------------------- */
  {
    id: "clarify-1",
    q: `who is the main benefactor of this coin ${ESKA}`,
    primary: "ask_clarification",
    accept: [["ask_clarification"], ["token_holders"], ["contract_info"]],
    source: "prompt",
    why:
      "The case ask_clarification was built for, named in both its description and SYSTEM_PROMPT. " +
      "But SYSTEM_PROMPT also says an assistant that checks before every answer is worse than one that commits, and both token_holders and contract_info are committed readings the prompt would defend.",
  },
  {
    id: "clarify-2",
    q: "hows nvda doin?",
    primary: "lookup_token",
    accept: [["lookup_token"]],
    source: "prompt",
    why: "Named in ask_clarification's description as the case NOT to ask about — a sensible default exists. A clarification here is a wasted turn charged to the user's daily quota.",
  },
  {
    id: "clarify-3",
    q: "wut is robinhud chain",
    primary: "",
    accept: [[]],
    source: "docs",
    why:
      "A typo'd question about the chain itself. SYSTEM_PROMPT answers it from the static factsheet with no lookup, and explicitly forbids asking the user to rewrite their spelling. " +
      "market_overview would be the substitution its own description forbids.",
  },

  /* ---------------------------------------------------------------------- *
   * 15. NO TOOL, LEGITIMATELY. Greetings, questions about the product, and
   *     questions about people. Every one of these is a row where calling ANY
   *     lookup is the mistake — which is the opposite failure from section 2,
   *     and a fix that cures one by causing the other has fixed nothing.
   * ---------------------------------------------------------------------- */
  { id: "social-1", q: "hi", primary: "", accept: [[]], source: "prompt" },
  { id: "social-2", q: "gm", primary: "", accept: [[]], source: "prompt" },
  { id: "social-3", q: "buenos días", primary: "", accept: [[]], source: "prompt" },
  { id: "social-4", q: "thanks, that was useful", primary: "", accept: [[]], source: "prompt" },
  {
    id: "social-5",
    q: "what is this site",
    primary: "",
    accept: [[]],
    source: "gap",
    why: "A question about the product. SYSTEM_PROMPT: a question about who or what you are gets a reply with NO tool call at all.",
  },
  {
    id: "social-6",
    q: "how do you work",
    primary: "",
    accept: [[]],
    source: "gap",
  },
  {
    id: "social-7",
    q: "what can you do",
    primary: "",
    accept: [[]],
    source: "gap",
  },
  {
    id: "offchain-1",
    q: "who is the founder of robinhood chain",
    primary: "",
    accept: [[]],
    source: "prompt",
    why: "market_overview's description names this exact case and forbids itself for it: people are off-chain, and a market snapshot is an answer to a different question.",
  },
  {
    id: "offchain-2",
    q: `who is behind this token ${ESKA}`,
    primary: "",
    accept: [[], ["project_profile"]],
    source: "tool",
    collision: "DILIGENCE",
    why:
      "GENUINELY BOTH, and the two tool files disagree. market_overview's description says \"who is behind this project\" is off-chain and must get no tool call; " +
      "project_profile's description lists \"who is behind this token\" as one of its own trigger phrasings. Until that contradiction is settled, either outcome is defensible.",
  },
  {
    id: "offchain-3",
    q: "whats the roadmap for nvda on this chain",
    primary: "",
    accept: [[]],
    source: "prompt",
    why: "A roadmap is a published plan and is not on chain. Answering with the token's figures would be the silent substitution SYSTEM_PROMPT calls the worst failure available.",
  },
  {
    id: "social-8",
    q: "hi, what is nvda",
    primary: "lookup_token",
    accept: [["lookup_token"]],
    source: "prompt",
    why: "SYSTEM_PROMPT: a greeting that also names a subject is a real question. This row is here so a fix for the greetings above cannot pass by swallowing this one too.",
  },

  /* ---------------------------------------------------------------------- *
   * 16. THE DOCS PAGE'S LAST THREE UNMEASURED PROMISES. Cross-checking
   *     lib/docs-capabilities.js against this file found three phrasings the
   *     page offers a reader that nothing here had ever measured. A promise
   *     nobody scored is a promise that rots quietly, so they are scored now.
   *     Two of them also made the PAGE change: "is this guy accumulating" and
   *     "这个项目是真的吗" were printed with no subject at all, and neither
   *     lookup they are filed under can run without one — the page now carries
   *     the same 0x placeholder its neighbours already did.
   * ---------------------------------------------------------------------- */
  {
    id: "market-4",
    q: "whats good today",
    primary: "market_overview",
    accept: [["market_overview"], ["top_movers"]],
    source: "docs",
    collision: "BOARD",
    why:
      "market_overview's description claims this phrasing verbatim, and the docs page files it beside top_movers. " +
      "Either is defensible: the reader wants to know what is worth looking at, and the board as a whole and the busiest names are two honest readings of that.",
  },
  {
    id: "wallet-4",
    q: `is this guy accumulating ${WALLET}`,
    primary: "wallet_portfolio",
    accept: [["wallet_portfolio"], ["lookup_wallet"]],
    source: "docs",
    collision: "WALLET",
    why:
      "trace_wallet's description claims this phrasing, but trace_wallet needs a WALLET AND A TOKEN and this question names only the wallet — so the tool that advertises it cannot answer it as asked. " +
      "What can: the address's positions, either as the full portfolio or as the general wallet lookup.",
  },
  {
    id: "lang-1",
    q: `这个项目是真的吗 ${ESKA}`,
    primary: "project_profile",
    accept: [["project_profile"]],
    source: "docs",
    collision: "DILIGENCE",
    why:
      "Verbatim in project_profile's description and on the docs page, and the only row in the corpus written in a non-Latin script. " +
      "The prompt promises an answer in the language the question was asked in, which is worth nothing if the question does not route.",
  },
]);

/** Every tool name the corpus expects to reach, for the bench's coverage check. */
export function coveredTools() {
  const seen = new Set();
  for (const row of CORPUS) {
    for (const outcome of row.accept) for (const name of outcome) seen.add(name);
  }
  return seen;
}
