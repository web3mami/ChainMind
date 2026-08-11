import Link from "next/link";

export const metadata = {
  title: "Terms",
  description:
    "What ChainMind is for, what its answers can and cannot establish, and the rules for using it. Written against what the tool actually does.",
};

/**
 * THE THREE THINGS TO EDIT, and nothing else in this file.
 *
 * JURISDICTION is a placeholder until the operating entity is settled — leaving it
 * unnamed is more honest than naming the wrong one, and a governing-law clause
 * pointing somewhere nobody operates from is worse than an obvious blank.
 */
const CONTACT = "hello@chainmind.fun";
const UPDATED = "11 August 2026";
const JURISDICTION = "the jurisdiction in which ChainMind is operated";

function Section({ id, title, children }) {
  return (
    <section id={id} className="mt-14 scroll-mt-20 border-t border-cm-border-subtle pt-14">
      <h2 className="text-xl font-semibold tracking-tight text-cm-text sm:text-2xl">{title}</h2>
      <div className="mt-4 space-y-4 text-sm leading-relaxed text-cm-muted">{children}</div>
    </section>
  );
}

function Item({ title, children }) {
  return (
    <div className="border-l border-cm-border pl-5">
      <h3 className="text-base font-semibold text-cm-text">{title}</h3>
      <div className="mt-2 space-y-2 text-sm leading-relaxed text-cm-muted">{children}</div>
    </div>
  );
}

export default function TermsPage() {
  return (
    <div className="border-b border-cm-border-subtle">
      <div className="mx-auto w-full max-w-3xl px-4 pb-16 pt-28 sm:px-6 sm:pb-24 sm:pt-32">
        <p className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-widest text-cm-faint">
          Terms
        </p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight text-cm-text sm:text-4xl">Terms of use</h1>
        <p className="mt-4 text-lg leading-relaxed text-cm-muted">
          ChainMind reads Robinhood Chain and explains what it finds. Using the site means accepting what follows — most
          of which is about the difference between a measurement and a conclusion, because that difference is the whole
          product.
        </p>
        <p className="mt-3 font-[family-name:var(--font-mono)] text-[11px] text-cm-faint">Last updated {UPDATED}</p>

        <Section id="what" title="What ChainMind is">
          <p>
            An explorer with an explanation attached. You paste an address, a transaction or a ticker; it reads the
            chain live, and it tells you what the figures are and what they imply. It is free, needs no account, and
            connecting a wallet is optional.
          </p>
          <p>
            It is not affiliated with, endorsed by, or operated by Robinhood Markets, Inc. or any of its subsidiaries.
            &ldquo;Robinhood Chain&rdquo; is the name of the network it reads.
          </p>
        </Section>

        <Section id="not-advice" title="It is not financial advice">
          <p>
            Nothing here is investment, financial, legal, tax or accounting advice, and nothing here is a
            recommendation to buy, sell or hold anything. ChainMind does not know your circumstances and is not
            licensed to advise anyone.
          </p>
          <p>
            Tokenised equities, like the assets behind them, can lose value. Decisions you make after reading an answer
            are yours, and so are their outcomes. If you need advice, ask somebody qualified to give it.
          </p>
        </Section>

        <Section id="limits" title="What an answer can and cannot establish">
          <p>
            ChainMind is built to be honest about its own limits, and those limits are part of every answer rather
            than a disclaimer at the bottom. Four of them matter enough to state here.
          </p>
          <div className="mt-6 space-y-8">
            <Item title="Almost every figure is measured over a window">
              <p>
                Histories are long and answers are quick, so a lookup reads a bounded slice and says so. &ldquo;No sale
                appeared in the transfers read&rdquo; is a true statement about that slice. &ldquo;This wallet has never
                sold&rdquo; is a claim about the world, and ChainMind will not make it from a partial read. When you
                see a count, check what it was counted over — the answer will tell you.
              </p>
            </Item>
            <Item title="Unknown is not zero, and an outage is not an absence">
              <p>
                A figure that could not be read comes back as unknown, never as nought. A token nobody prices is
                unpriced, not worthless. A lookup that failed says it failed. If something reads as missing, that is
                what it means — and it is not evidence that the thing does not exist.
              </p>
            </Item>
            <Item title="Observations, never verdicts about people">
              <p>
                ChainMind reports what the chain shows. It does not conclude that a project is a scam, a rug or a
                fraud, that a wallet belongs to any particular person or company, or that anybody intended anything.
                Those are claims about people and businesses that no arrangement of transactions can establish, and the
                same on-chain shapes are produced constantly by entirely ordinary activity.
              </p>
              <p>
                Where an address carries a label from a block explorer, that is quoted as the explorer&apos;s claim and
                is not verified by us.
              </p>
            </Item>
            <Item title="The model can still be wrong">
              <p>
                Answers are written by a language model working from the data gathered for your question. It is
                instructed to ground every claim in that data, but it can misread, mis-weight or misstate it. Verify
                anything you intend to act on against the underlying records, which every answer links to.
              </p>
            </Item>
          </div>
        </Section>

        <Section id="use" title="Using the site">
          <p>Do not:</p>
          <ul className="list-inside list-disc space-y-2">
            <li>Use ChainMind to harass, dox, defame or threaten anyone, or to present its output as proof that a named person did something.</li>
            <li>Scrape, resell or redistribute the service, or run it through automated clients at a rate that degrades it for other people.</li>
            <li>Attempt to bypass rate limits, work around access controls, or interfere with the site&apos;s operation.</li>
            <li>Use it where doing so breaks the law that applies to you.</li>
          </ul>
          <p>
            Access may be rate-limited, and a daily allowance may apply to questions. Where a token gate is in force,
            holding the gating token lifts that allowance; holding it is never required to use the site.
          </p>
        </Section>

        <Section id="wallet" title="Wallets and custody">
          <p>
            Connecting a wallet asks you to sign a message proving you control an address. It is not a transaction: it
            cannot move funds, grant an allowance or spend gas.
          </p>
          <p>
            ChainMind never takes custody of assets, never holds keys, and has no ability to transact on your behalf.
            It will never ask for a private key or a seed phrase, and any page that appears to is not us. You are
            responsible for the security of your own wallet.
          </p>
        </Section>

        <Section id="availability" title="Availability and warranties">
          <p>
            The service is provided as it is, without warranties of any kind, express or implied — including
            merchantability, fitness for a particular purpose, accuracy and non-infringement. It depends on third-party
            infrastructure, and it may be slow, incomplete or unavailable without notice. Features may change or be
            withdrawn.
          </p>
        </Section>

        <Section id="liability" title="Liability">
          <p>
            To the fullest extent the law allows, ChainMind and the people who build it are not liable for any indirect,
            incidental, special or consequential loss, nor for lost profits, lost assets or trading losses, arising from
            your use of the site or from anything you did after reading an answer.
          </p>
          <p>Nothing here excludes liability that cannot lawfully be excluded.</p>
        </Section>

        <Section id="changes" title="Changes, contact and governing law">
          <p>
            These terms may change; the date at the top changes with them, and continuing to use the site means
            accepting the current version. Anything unclear, and anything you think is wrong, goes to{" "}
            <a href={`mailto:${CONTACT}`} className="font-medium text-cm-text underline-offset-4 hover:underline">
              {CONTACT}
            </a>
            .
          </p>
          <p>These terms are governed by the laws of {JURISDICTION}.</p>
          <p>
            How your data is handled is set out separately in the{" "}
            <Link href="/privacy" className="font-medium text-cm-text underline-offset-4 hover:underline">
              privacy policy
            </Link>
            .
          </p>
        </Section>
      </div>
    </div>
  );
}
