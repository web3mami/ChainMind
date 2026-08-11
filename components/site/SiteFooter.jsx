import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="border-t border-cm-border bg-cm-bg">
      <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
        <div className="flex flex-col gap-10 md:flex-row md:items-start md:justify-between">
          <div className="max-w-sm">
            <p className="text-sm font-semibold text-cm-text">ChainMind</p>
            <p className="mt-2 text-xs leading-relaxed text-cm-faint sm:text-sm">
              An AI explorer for Robinhood Chain—ask about any wallet, token, or transaction and get the figures, plus
              what they imply, grounded in live on-chain data.
            </p>
          </div>
          <div className="flex flex-col gap-10 text-sm sm:flex-row sm:gap-14">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-cm-faint">Product</p>
              <ul className="mt-2 space-y-1.5 text-cm-muted">
                <li>
                  <Link href="/ask" className="hover:text-cm-text">
                    Ask AI
                  </Link>
                </li>
                <li>
                  <Link href="/docs" className="hover:text-cm-text">
                    Docs
                  </Link>
                </li>
                <li>
                  <Link href="/#how-it-works" className="hover:text-cm-text">
                    How it works
                  </Link>
                </li>
                <li>
                  <Link href="/how-it-works" className="hover:text-cm-text">
                    Guide
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-cm-faint">Legal</p>
              <ul className="mt-2 space-y-1.5 text-cm-muted">
                <li>
                  <Link href="/privacy" className="hover:text-cm-text">
                    Privacy
                  </Link>
                </li>
                <li>
                  <Link href="/terms" className="hover:text-cm-text">
                    Terms
                  </Link>
                </li>
              </ul>
            </div>
            <div className="max-w-md">
              <p className="text-xs font-semibold uppercase tracking-wide text-cm-faint">About the answers</p>
              <p className="mt-2 text-xs leading-relaxed text-cm-muted">
                Answers are AI-generated from public on-chain data and can be incomplete or wrong. This is not financial
                advice. Verify anything important against the block explorer before acting on it.
              </p>
            </div>
          </div>
        </div>
        <p className="mt-10 border-t border-cm-border-subtle pt-6 text-center text-[11px] leading-relaxed text-cm-faint">
          © {new Date().getFullYear()} ChainMind · AI explorer for Robinhood Chain · Answers may be incomplete — verify
          on-chain
        </p>
      </div>
    </footer>
  );
}
