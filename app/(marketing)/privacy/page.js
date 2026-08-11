import Link from "next/link";

export const metadata = {
  title: "Privacy Policy",
  description: "How ChainMind handles data on the web and iOS apps.",
};

export default function PrivacyPage() {
  return (
    <div className="border-b border-cm-border-subtle">
      <div className="mx-auto w-full max-w-3xl px-4 pb-16 pt-28 sm:px-6 sm:pb-24 sm:pt-32">
        <p className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-widest text-cm-faint">Legal</p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight text-cm-text sm:text-4xl">Privacy Policy</h1>
        <p className="mt-4 text-sm text-cm-faint">Last updated: 11 August 2026</p>
        <p className="mt-6 text-base leading-relaxed text-cm-muted">
          ChainMind is an AI explorer for Robinhood Chain. This policy covers{" "}
          <Link href="https://chainmind.fun" className="text-cm-text underline-offset-4 hover:underline">
            chainmind.fun
          </Link>{" "}
          and the ChainMind iOS app (<code className="font-mono text-xs">fun.chainmind.app</code>).
        </p>

        <section className="mt-12 space-y-4">
          <h2 className="text-lg font-semibold text-cm-text">What we collect</h2>
          <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-cm-muted">
            <li>
              <strong className="text-cm-subtle">Wallet address</strong> — only after you sign a message to prove
              control (no seed phrase, no private key).
            </li>
            <li>
              <strong className="text-cm-subtle">Questions and research subjects</strong> you submit, plus saved Ask
              history when signed in.
            </li>
            <li>
              <strong className="text-cm-subtle">Device push token</strong> — if you enable research alerts on iOS.
            </li>
            <li>
              <strong className="text-cm-subtle">Technical logs</strong> — IP-based rate limits and error logs needed to
              run the service.
            </li>
          </ul>
        </section>

        <section className="mt-10 space-y-4">
          <h2 className="text-lg font-semibold text-cm-text">What we do not collect</h2>
          <p className="text-sm leading-relaxed text-cm-muted">
            We never ask for seed phrases or private keys. We do not sell personal data. We do not use App Tracking
            Transparency / IDFA advertising tracking.
          </p>
        </section>

        <section className="mt-10 space-y-4">
          <h2 className="text-lg font-semibold text-cm-text">On-chain and third parties</h2>
          <p className="text-sm leading-relaxed text-cm-muted">
            Chain lookups use public Robinhood Chain RPC / indexer data. WalletConnect (Reown) may process connection
            metadata when you connect a wallet. Model providers process prompts needed to answer your questions.
            Transactions you approve (send / swap) are signed in your wallet — ChainMind does not custody funds.
          </p>
        </section>

        <section className="mt-10 space-y-4">
          <h2 className="text-lg font-semibold text-cm-text">Retention and deletion</h2>
          <p className="text-sm leading-relaxed text-cm-muted">
            Sessions expire. Saved history can be cleared in the app. You can delete your ChainMind account data
            (history, push registration, session) from Profile → Delete account on iOS, or by contacting us. Research
            job ownership records age out automatically.
          </p>
        </section>

        <section className="mt-10 space-y-4">
          <h2 className="text-lg font-semibold text-cm-text">Contact</h2>
          <p className="text-sm leading-relaxed text-cm-muted">
            Privacy questions:{" "}
            <a href="mailto:hello@chainmind.fun" className="text-cm-text underline-offset-4 hover:underline">
              hello@chainmind.fun
            </a>
            .
          </p>
        </section>

        <p className="mt-14 text-sm text-cm-faint">
          See also{" "}
          <Link href="/terms" className="underline-offset-4 hover:underline">
            Terms of Use
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
