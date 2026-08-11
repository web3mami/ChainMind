import Link from "next/link";

export const metadata = {
  title: "Privacy",
  description:
    "What ChainMind stores, what it does not, where your questions go, and how long anything is kept. Specific to what the code actually does.",
};

/**
 * CHANGE THESE TWO AND NOTHING ELSE, when the address or the date moves.
 *
 * The date is the day the policy last CHANGED, not the day the page was built,
 * so it must be edited by hand — a date computed at render time would silently
 * claim the policy was reviewed every deploy.
 */
const CONTACT = "privacy@chainmind.fun";
const UPDATED = "11 August 2026";

/** One section, in the same shape the other marketing pages use. */
function Section({ id, title, children }) {
  return (
    <section id={id} className="mt-14 scroll-mt-20 border-t border-cm-border-subtle pt-14">
      <h2 className="text-xl font-semibold tracking-tight text-cm-text sm:text-2xl">{title}</h2>
      <div className="mt-4 space-y-4 text-sm leading-relaxed text-cm-muted">{children}</div>
    </section>
  );
}

/** A labelled block with the left rule the guide pages use for steps. */
function Item({ title, children }) {
  return (
    <div className="border-l border-cm-border pl-5">
      <h3 className="text-base font-semibold text-cm-text">{title}</h3>
      <div className="mt-2 space-y-2 text-sm leading-relaxed text-cm-muted">{children}</div>
    </div>
  );
}

export default function PrivacyPage() {
  return (
    <div className="border-b border-cm-border-subtle">
      <div className="mx-auto w-full max-w-3xl px-4 pb-16 pt-28 sm:px-6 sm:pb-24 sm:pt-32">
        <p className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-widest text-cm-faint">
          Privacy
        </p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight text-cm-text sm:text-4xl">What ChainMind stores</h1>
        <p className="mt-4 text-lg leading-relaxed text-cm-muted">
          ChainMind reads a public blockchain and explains it. There is no signup, no email, no password and no
          payment, so most of what a privacy policy usually covers does not exist here. This page says exactly what is
          kept, for how long, and what leaves our servers.
        </p>
        <p className="mt-3 font-[family-name:var(--font-mono)] text-[11px] text-cm-faint">Last updated {UPDATED}</p>

        <Section id="collected" title="What is stored">
          <p>Four things, and nothing else.</p>
          <div className="mt-6 space-y-8">
            <Item title="Your questions">
              <p>
                The question you type is sent to the language model to be answered. A shortened copy — the first 200
                characters — is also kept in a recent-activity list so the site can show what is being asked and count
                how much it is used.
              </p>
              <p>
                Do not paste anything private into the question box. It is a search field for a public blockchain, and
                it should be treated like one.
              </p>
            </Item>

            <Item title="Your IP address, hashed">
              <p>
                Your IP is used to rate-limit requests and to count visitors. It is never stored in readable form: it is
                combined with a server-side secret and put through SHA-256, and only that hash is written down. The
                result cannot be turned back into an IP address, and the same IP produces a different hash on a
                deployment with a different secret.
              </p>
            </Item>

            <Item title="Your wallet address, only if you connect one">
              <p>
                Connecting is optional and nothing on the site requires it. If you do, your address is stored so your
                saved history can be found again, and it appears in the recent-activity list in shortened form
                (<code className="font-mono text-xs">0x1234…abcd</code>). Unlike an IP, an address is not hashed — it has
                to be readable for your own history to be returned to you.
              </p>
            </Item>

            <Item title="Your saved history, if you are signed in">
              <p>
                Questions and answers from a signed-in session are saved so you can come back to them. They are deleted
                automatically after 90 days, and you can delete them yourself at any time from the wallet menu. Signed
                out, nothing is saved against you at all.
              </p>
            </Item>
          </div>
        </Section>

        <Section id="not-collected" title="What is not stored">
          <ul className="list-inside list-disc space-y-2">
            <li>No name, email address, phone number or postal address — none is ever asked for.</li>
            <li>No password. There is no account to have one for.</li>
            <li>No payment details. Nothing on this site charges money.</li>
            <li>No private keys, seed phrases or recovery phrases. ChainMind cannot ask for them and must never be given them.</li>
            <li>No advertising or cross-site tracking cookies, and no third-party analytics script.</li>
            <li>No raw IP addresses, as described above.</li>
          </ul>
        </Section>

        <Section id="wallet" title="Connecting a wallet is a signature, never a transaction">
          <p>
            When you connect, your wallet is asked to <strong className="font-semibold text-cm-text">sign a message</strong>{" "}
            proving you control the address. That is all it is. It is not a transaction: it cannot move funds, cannot
            grant a spending allowance, cannot approve a contract and costs no gas.
          </p>
          <p>
            ChainMind never takes custody of anything and has no ability to move your assets. If any page here ever asks
            you to approve a transaction, do not sign it — and please tell us.
          </p>
        </Section>

        <Section id="where" title="Where your question goes">
          <p>
            Answering a question means sending it, along with the on-chain facts gathered for it, to a language model
            run by <strong className="font-semibold text-cm-text">Groq</strong>. Your question text leaves our servers at
            that point and is handled under Groq&apos;s own terms and privacy policy. Your wallet address, your IP and
            your saved history are not sent with it.
          </p>
          <p>The other services involved do not receive anything personal:</p>
          <ul className="list-inside list-disc space-y-2">
            <li>
              <strong className="font-semibold text-cm-text">Blockscout</strong> and the Robinhood Chain RPC — asked
              about addresses and transactions. These are public blockchain records, and they are queried whether or not
              anyone is signed in.
            </li>
            <li>
              <strong className="font-semibold text-cm-text">Upstash</strong> — the database holding the counters,
              hashed IPs and saved history described above.
            </li>
            <li>
              <strong className="font-semibold text-cm-text">Vercel</strong> — hosting. Like any web host it processes
              requests in order to serve the site.
            </li>
          </ul>
        </Section>

        <Section id="cookies" title="Cookies">
          <p>
            One cookie, and only after you connect a wallet. It holds your address and a signature proving the session
            is genuine, is marked <code className="font-mono text-xs">httpOnly</code> so no script on the page can read
            it, is restricted to this site, and expires after 24 hours. Signing out clears it immediately.
          </p>
          <p>There are no advertising cookies, so there is no consent banner to click through.</p>
        </Section>

        <Section id="retention" title="How long anything is kept">
          <ul className="list-inside list-disc space-y-2">
            <li>Saved history — 90 days, or until you delete it.</li>
            <li>Session cookie — 24 hours, or until you sign out.</li>
            <li>Daily rate-limit counters — until 00:00 UTC, when they reset.</li>
            <li>Usage counters and the recent-activity list — around six months, then they age out on their own.</li>
          </ul>
        </Section>

        <Section id="choices" title="What you can do">
          <ul className="list-inside list-disc space-y-2">
            <li>
              <strong className="font-semibold text-cm-text">Use it signed out.</strong> Every answer works without
              connecting anything. Signed out there is no address to store.
            </li>
            <li>
              <strong className="font-semibold text-cm-text">Delete your history.</strong> From the wallet menu, at any
              time, without asking anyone.
            </li>
            <li>
              <strong className="font-semibold text-cm-text">Disconnect.</strong> Signing out clears the cookie, and the
              address stops being associated with new activity.
            </li>
            <li>
              <strong className="font-semibold text-cm-text">Ask us to erase what is left.</strong> Write to{" "}
              <a href={`mailto:${CONTACT}`} className="font-medium text-cm-text underline-offset-4 hover:underline">
                {CONTACT}
              </a>{" "}
              from an address you can prove you control.
            </li>
          </ul>
        </Section>

        <Section id="chain" title="One thing we cannot delete">
          <p>
            The blockchain is not ours. Everything ChainMind shows about an address — its balances, transfers and
            transactions — is public, permanent, and was already there before you visited. Deleting your history here
            removes your questions from our database; it does not and cannot remove anything from the chain, and every
            other block explorer will still show the same records.
          </p>
        </Section>

        <Section id="changes" title="Changes, and how to reach us">
          <p>
            If this policy changes in a way that affects what is stored, the date at the top changes with it. Questions
            about any of it go to{" "}
            <a href={`mailto:${CONTACT}`} className="font-medium text-cm-text underline-offset-4 hover:underline">
              {CONTACT}
            </a>
            .
          </p>
          <p>
            Our{" "}
            <Link href="/terms" className="font-medium text-cm-text underline-offset-4 hover:underline">
              terms of use
            </Link>{" "}
            cover what ChainMind is for and the limits of what it tells you.
          </p>
        </Section>
      </div>
    </div>
  );
}
