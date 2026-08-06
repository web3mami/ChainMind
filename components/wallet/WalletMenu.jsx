"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import HistoryPanel from "@/components/wallet/HistoryPanel";
import {
  currentChainId,
  discoverProviders,
  requestAddress,
  signMessage,
  silentAddress,
  switchChain,
  walletError,
} from "@/components/wallet/injected-provider";

/**
 * WalletMenu — the connect button in the console header, and the panel behind it.
 *
 * WHAT IT IS ALLOWED TO ASK THE WALLET FOR: an address, and a signature over a
 * sentence. That is the entire surface. There is no transaction anywhere in this
 * flow — no approval, no permit, no typed data — and the copy says so in the two
 * places a user actually reads: on the button that starts it, and in the message
 * the wallet shows them. If a future change adds a `eth_sendTransaction` to this
 * component, this paragraph is the thing that was lied to.
 *
 * WHAT IT DOES NOT DECIDE. Nothing. The balance, the entitlement and the remaining
 * quota are all read from the server (/api/quota), which reads the chain itself.
 * This component renders numbers; it never computes one. A client that could
 * decide it was entitled would be the bypass.
 *
 * THE FOUR STATES IT HAS TO SHOW HONESTLY:
 *   unlimited      — verified holder at or above the threshold.
 *   anonymous      — no session; N free questions a day.
 *   below          — signed in, balance read, under the threshold.
 *   unverified     — signed in, balance NOT read. Shown as "could not check",
 *                    never as a balance of zero, because an outage is not a fact
 *                    about somebody's wallet.
 */

/** `0x1234…cdef` — the only form of an address worth putting in a header. */
function short(address) {
  const a = String(address ?? "");
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** The dot beside the status line. Colour carries the same meaning as the words. */
function stateDot(state) {
  if (state === "unlimited") return "bg-cm-ok";
  // Open access has no limit either, so it gets the same colour as the holder. Left on
  // the default it drew a grey "restricted" dot next to a panel saying there was no
  // limit, and the dot is what a glance actually reads.
  if (state === "open-access") return "bg-cm-ok";
  if (state === "unverified") return "bg-cm-warn";
  return "bg-cm-faint";
}

export default function WalletMenu() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [address, setAddress] = useState(null);
  const [quota, setQuota] = useState(null);
  const [entitlement, setEntitlement] = useState(null);
  const [gate, setGate] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [wallets, setWallets] = useState(null); // non-null only when picking
  const [walletChain, setWalletChain] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [showHistory, setShowHistory] = useState(false);

  const providerRef = useRef(null);
  const mountedRef = useRef(true);
  const rootRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * Ask the server where we stand. The ONLY source of truth in this component.
   *
   * `consume: false` on that route matters: opening this panel must never cost
   * somebody one of their free questions.
   */
  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/quota", { headers: { accept: "application/json" } });
      const data = await res.json().catch(() => null);
      if (!mountedRef.current || !data) return;
      setAddress(data.address ?? null);
      setQuota(data.quota ?? null);
      setEntitlement(data.entitlement ?? null);
      setGate(data.gate ?? null);
    } catch {
      // Offline. Leaving the last known state on screen is better than replacing
      // it with a zero we did not measure.
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // The ask route attaches the caller's standing to every answer as headers, and
  // components/ask/Conversation.jsx re-broadcasts them. Cheaper and fresher than
  // polling /api/quota: the number updates on the request that changed it.
  useEffect(() => {
    const onQuota = (event) => {
      const detail = event?.detail;
      if (!detail || !mountedRef.current) return;
      setQuota((prev) => ({ ...(prev ?? {}), ...detail }));
    };
    window.addEventListener("chainmind:quota", onQuota);
    return () => window.removeEventListener("chainmind:quota", onQuota);
  }, []);

  // Close on a click outside or on Escape — the same manners as any other menu.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  /**
   * Watch the wallet after a sign-in.
   *
   * A user who switches accounts is not signed in as the new one — the session is
   * bound to the address that signed — so the honest thing is to say so and offer
   * the prompt again, rather than showing a header that names an address the
   * server has never verified.
   */
  const watchProvider = useCallback((provider) => {
    if (!provider || typeof provider.on !== "function") return;
    providerRef.current = provider;
    provider.on("accountsChanged", (accounts) => {
      if (!mountedRef.current) return;
      const next = Array.isArray(accounts) ? accounts[0] : null;
      setNotice(
        next
          ? `Your wallet switched to ${short(next)}. Sign in again to use that address here.`
          : "Your wallet disconnected. Your session stays until you sign out or it expires.",
      );
    });
    provider.on("chainChanged", (hex) => {
      if (!mountedRef.current) return;
      const n = Number.parseInt(String(hex), 16);
      setWalletChain(Number.isFinite(n) ? n : null);
    });
  }, []);

  /** The one flow: address → nonce → signature → session. No transaction in it. */
  const signIn = useCallback(
    async (provider) => {
      setBusy(true);
      setError("");
      setNotice("");
      setWallets(null);
      try {
        const account = await requestAddress(provider);

        // The server issues the challenge AND renders the exact message. The
        // browser never assembles the bytes it signs: the domain, the chain id and
        // the nonce all come from the response, and the server rebuilds the same
        // string at verify time from what it stored.
        const nonceRes = await fetch("/api/auth/nonce", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: account }),
        });
        const challenge = await nonceRes.json().catch(() => null);
        if (!nonceRes.ok || !challenge) {
          setError(challenge?.error ?? "Sign-in is unavailable right now.");
          return;
        }

        const claimed = challenge.address ?? account;
        const message =
          typeof challenge.message === "string" && challenge.message
            ? challenge.message
            : String(challenge.messageTemplate ?? "").replace("{address}", claimed);
        if (!message) {
          setError("Sign-in is unavailable right now.");
          return;
        }

        const signature = await signMessage(provider, account, message);

        const verifyRes = await fetch("/api/auth/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: claimed, signature }),
        });
        const verified = await verifyRes.json().catch(() => null);
        if (!verifyRes.ok || !verified?.address) {
          setError(verified?.error ?? "Could not verify that signature. Try again.");
          return;
        }

        setChainId(Number(challenge.chainId) || null);
        setWalletChain(await currentChainId(provider));
        watchProvider(provider);
        await refresh();
      } catch (e) {
        setError(walletError(e));
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [refresh, watchProvider],
  );

  /** Find the wallets, then either use the only one or ask which. */
  const onConnect = useCallback(async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const found = await discoverProviders();
      if (!found.length) {
        setError(
          "No browser wallet found. Install one — MetaMask, Rabby or Coinbase Wallet — and reload this page.",
        );
        return;
      }
      if (found.length === 1) {
        await signIn(found[0].provider);
        return;
      }
      setWallets(found);
    } catch (e) {
      setError(walletError(e));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [signIn]);

  const onSignOut = useCallback(async () => {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // A logout that did not reach the server leaves the cookie; refresh below
      // will show that honestly rather than pretending it is gone.
    }
    setNotice("");
    setError("");
    setShowHistory(false);
    await refresh();
    if (mountedRef.current) setBusy(false);
  }, [refresh]);

  // Already-connected wallets: if the browser has one and we have no session,
  // the button says "Sign in" rather than "Connect", because the connection part
  // is already done and only the proof is missing.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const found = await discoverProviders();
      if (cancelled || !found.length) return;
      const account = await silentAddress(found[0].provider);
      if (cancelled || !account) return;
      watchProvider(found[0].provider);
      setWalletChain(await currentChainId(found[0].provider));
    })();
    return () => {
      cancelled = true;
    };
  }, [watchProvider]);

  const signedIn = Boolean(address);
  const state = quota?.state ?? (signedIn ? "unverified" : "anonymous");
  const unlimited = Boolean(quota?.unlimited);
  const remaining = quota?.remaining;
  const limit = quota?.limit;

  // Unlimited BECAUSE THIS SERVER IS NOT COUNTING, which is not a fact about the visitor.
  // Everything below has to tell the two apart: the holder earned it, the open-access
  // visitor merely arrived during the window.
  const openAccess = state === "open-access";

  const label = loading
    ? "…"
    : signedIn
      ? short(address)
      : unlimited && !openAccess
        ? "Connected"
        : remaining != null && limit
          ? `Connect · ${remaining}/${limit}`
          : "Connect";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="flex items-center gap-2 rounded-md border border-cm-border px-2.5 py-1.5 font-mono text-[11px] text-cm-muted transition-colors hover:border-cm-accent/40 hover:bg-cm-row-hover hover:text-cm-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-accent"
      >
        <span className={`h-1.5 w-1.5 rounded-full ${stateDot(state)}`} aria-hidden="true" />
        <span className="max-w-[9rem] truncate">{label}</span>
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Wallet"
          className="absolute right-0 top-full z-50 mt-2 w-[min(22rem,calc(100vw-1.5rem))] rounded-lg border border-cm-border bg-cm-card p-4 shadow-cm"
        >
          <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.2em] text-cm-faint">
            {signedIn ? "Signed in" : "Wallet"}
          </p>

          {signedIn ? (
            <p className="mt-1 break-all font-mono text-[12px] text-cm-text">{address}</p>
          ) : null}

          {/* Standing: which tier, and the number when there is one. */}
          <div className="mt-3 rounded-md border border-cm-border-subtle bg-cm-surface px-3 py-2.5">
            {openAccess ? (
              // NOT the holder line. This visitor may hold nothing and may not even have a
              // wallet connected; "verified holder" would be a claim about them that nobody
              // checked, and one they would watch evaporate the moment the switch comes off.
              <>
                <p className="font-mono text-[12px] text-cm-ok">No daily limit right now</p>
                <p className="mt-1 text-[11px] leading-relaxed text-cm-muted">
                  Questions are not being counted while ChainMind is open for public testing.
                  {signedIn ? "" : " Connecting a wallet saves your history."}
                </p>
              </>
            ) : unlimited ? (
              <p className="font-mono text-[12px] text-cm-ok">
                Unlimited questions — verified holder
                {entitlement?.balance ? ` (${entitlement.balance} ${entitlement.symbol ?? ""})`.trimEnd() : ""}
              </p>
            ) : state === "unverified" ? (
              <>
                <p className="font-mono text-[12px] text-cm-warn">Could not check your balance</p>
                <p className="mt-1 text-[11px] leading-relaxed text-cm-muted">
                  {quota?.reason === "not-configured" || quota?.reason === "bad-config"
                    ? "Token gating is not configured on this server, so nobody can be verified as a holder."
                    : "That is a failed lookup on our side — not a statement that you hold none. The free daily allowance applies meanwhile."}
                </p>
              </>
            ) : (
              <>
                <p className="font-mono text-[12px] text-cm-text">
                  {remaining != null && limit != null
                    ? `${remaining} of ${limit} free questions left today`
                    : `${limit ?? 5} free questions a day`}
                </p>
                {entitlement?.balance != null && entitlement?.threshold != null ? (
                  <p className="mt-1 text-[11px] text-cm-muted">
                    Holds {entitlement.balance} {entitlement.symbol ?? ""} of {entitlement.threshold} needed
                  </p>
                ) : null}
              </>
            )}
            {quota?.resetsAt && !unlimited ? (
              <p className="mt-1 font-mono text-[10px] text-cm-faint">Resets 00:00 UTC</p>
            ) : null}
            {quota?.degraded ? (
              <p className="mt-1 text-[10px] text-cm-warn">
                The shared counter is unavailable, so this figure is approximate.
              </p>
            ) : null}
          </div>

          {/* What connecting buys, and what it costs — which is nothing. */}
          {!unlimited && gate?.configured ? (
            <p className="mt-3 text-[11px] leading-relaxed text-cm-muted">
              Hold at least {gate.minTokens} {gate.symbol ?? "of the gating token"} in a connected wallet to
              ask without a daily limit.
            </p>
          ) : null}

          {!signedIn ? (
            <>
              <p className="mt-3 text-[11px] leading-relaxed text-cm-muted">
                Connecting asks you to <strong className="text-cm-text">sign a message</strong>, nothing
                more. It is not a transaction: it cannot move funds, grant an allowance or spend gas. This
                app never asks you to sign one.
              </p>
              {wallets ? (
                <div className="mt-3 flex flex-col gap-1.5">
                  <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-cm-faint">
                    Which wallet
                  </p>
                  {wallets.map((w) => (
                    <button
                      key={w.id}
                      type="button"
                      onClick={() => signIn(w.provider)}
                      className="flex items-center gap-2 rounded-md border border-cm-border-subtle px-3 py-2 text-left font-mono text-[12px] text-cm-muted transition-colors hover:border-cm-accent/40 hover:bg-cm-row-hover hover:text-cm-text"
                    >
                      {w.icon ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={w.icon} alt="" className="h-4 w-4 rounded" />
                      ) : null}
                      {w.name}
                    </button>
                  ))}
                </div>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={onConnect}
                  className="mt-3 w-full rounded-md border border-cm-accent/40 bg-cm-accent/10 px-3 py-2 font-mono text-[12px] text-cm-accent-bright transition-colors hover:bg-cm-accent/20 disabled:cursor-default disabled:opacity-50"
                >
                  {busy ? "Check your wallet…" : "Connect wallet"}
                </button>
              )}
            </>
          ) : (
            <div className="mt-3 flex flex-col gap-1.5">
              <button
                type="button"
                onClick={() => setShowHistory((s) => !s)}
                className="w-full rounded-md border border-cm-border-subtle px-3 py-2 font-mono text-[12px] text-cm-muted transition-colors hover:border-cm-border hover:bg-cm-row-hover hover:text-cm-text"
              >
                {showHistory ? "Hide saved questions" : "Saved questions"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={onSignOut}
                className="w-full rounded-md border border-cm-border-subtle px-3 py-2 font-mono text-[12px] text-cm-muted transition-colors hover:border-cm-border hover:bg-cm-row-hover hover:text-cm-text disabled:opacity-50"
              >
                Sign out
              </button>
            </div>
          )}

          {/* Wrong network is a NOTICE, not a blocker: signing works on any chain,
              and the balance behind the gate is read server-side on 4663 either way. */}
          {chainId && walletChain && walletChain !== chainId ? (
            <div className="mt-3 rounded-md border border-cm-border-subtle bg-cm-surface px-3 py-2">
              <p className="text-[11px] leading-relaxed text-cm-muted">
                Your wallet is on chain {walletChain}; this app reads chain {chainId}. Signing works either
                way — your balance is read server-side on {chainId}.
              </p>
              <button
                type="button"
                onClick={async () => {
                  const res = await switchChain(providerRef.current, chainId);
                  if (!res.ok) setError(res.error ?? "Could not switch network.");
                }}
                className="mt-2 font-mono text-[11px] text-cm-accent-bright underline-offset-2 hover:underline"
              >
                Switch network
              </button>
            </div>
          ) : null}

          {notice ? <p className="mt-3 text-[11px] leading-relaxed text-cm-warn">{notice}</p> : null}
          {error ? <p className="mt-3 text-[11px] leading-relaxed text-cm-bad">{error}</p> : null}

          {showHistory && signedIn ? <HistoryPanel /> : null}
        </div>
      ) : null}
    </div>
  );
}
