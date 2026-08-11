/**
 * WalletConnect relay WebSocket proxy.
 *
 * Phone → this Worker (Cloudflare edge) → relay.walletconnect.org
 *
 * Use a direct `fetch` rewrite for the upgrade so we return a response
 * immediately. The previous accept/pipe + waitUntil pattern hung and CF
 * canceled the isolate ("Worker's code had hung…").
 */
const UPSTREAM_HOST = "relay.walletconnect.org";

export default {
  async fetch(request) {
    const upgrade = request.headers.get("Upgrade");
    if (!upgrade || upgrade.toLowerCase() !== "websocket") {
      return new Response(
        [
          "ChainMind WalletConnect relay proxy",
          "Upgrade: websocket required for relay traffic.",
          `Upstream: wss://${UPSTREAM_HOST}`,
        ].join("\n") + "\n",
        {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      );
    }

    const incoming = new URL(request.url);
    const target = new URL(incoming.toString());
    target.protocol = "https:";
    target.hostname = UPSTREAM_HOST;
    target.port = "";

    // Forward the upgrade (incl. Authorization JWT) without holding the
    // isolate in a custom pipe loop.
    return fetch(target.toString(), request);
  },
};
