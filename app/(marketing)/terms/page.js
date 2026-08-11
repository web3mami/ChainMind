import Link from "next/link";

export const metadata = {
  title: "Terms of Use",
  description: "Terms for using ChainMind on the web and iOS.",
};

export default function TermsPage() {
  return (
    <div className="border-b border-cm-border-subtle">
      <div className="mx-auto w-full max-w-3xl px-4 pb-16 pt-28 sm:px-6 sm:pb-24 sm:pt-32">
        <p className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-widest text-cm-faint">Legal</p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight text-cm-text sm:text-4xl">Terms of Use</h1>
        <p className="mt-4 text-sm text-cm-faint">Last updated: 11 August 2026</p>

        <section className="mt-10 space-y-4">
          <h2 className="text-lg font-semibold text-cm-text">The service</h2>
          <p className="text-sm leading-relaxed text-cm-muted">
            ChainMind provides AI-assisted exploration of public Robinhood Chain data. Answers and research reports
            are informational. They are not investment, legal, or tax advice. Always verify on-chain facts yourself.
          </p>
        </section>

        <section className="mt-10 space-y-4">
          <h2 className="text-lg font-semibold text-cm-text">Wallets and transactions</h2>
          <p className="text-sm leading-relaxed text-cm-muted">
            Connecting a wallet proves address control via a signed message. Sending or swapping assets happens in
            your wallet app. You are responsible for reviewing every transaction. Sample or placeholder token flows
            (for example pre-launch $CMIND) are clearly labeled and may fail on-chain until live contracts exist.
          </p>
        </section>

        <section className="mt-10 space-y-4">
          <h2 className="text-lg font-semibold text-cm-text">Acceptable use</h2>
          <p className="text-sm leading-relaxed text-cm-muted">
            Do not abuse rate limits, attempt to disrupt the service, or use ChainMind to break the law. We may limit
            or refuse access when abuse or misconfiguration requires it.
          </p>
        </section>

        <section className="mt-10 space-y-4">
          <h2 className="text-lg font-semibold text-cm-text">Availability</h2>
          <p className="text-sm leading-relaxed text-cm-muted">
            The product is provided as-is. Indexers, model providers, and WalletConnect relays can fail. We do not
            guarantee uninterrupted access.
          </p>
        </section>

        <section className="mt-10 space-y-4">
          <h2 className="text-lg font-semibold text-cm-text">Contact</h2>
          <p className="text-sm leading-relaxed text-cm-muted">
            <a href="mailto:hello@chainmind.fun" className="text-cm-text underline-offset-4 hover:underline">
              hello@chainmind.fun
            </a>
          </p>
        </section>

        <p className="mt-14 text-sm text-cm-faint">
          See also{" "}
          <Link href="/privacy" className="underline-offset-4 hover:underline">
            Privacy Policy
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
