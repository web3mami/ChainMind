/**
 * WalletConnect relay WebSocket proxy.
 *
 * Phone → this Worker (Cloudflare edge) → relay.walletconnect.org
 *
 * Critical: forward the `Authorization: Bearer <JWT>` header. Reown puts the
 * relay auth token there (aud = wss://relay.walletconnect.org). Dropping it
 * makes the upstream return 401 and pairing hangs on “waiting for wallet”.
 */
const UPSTREAM_ORIGIN = "https://relay.walletconnect.org";

export default {
  async fetch(request, _env, ctx) {
    const upgrade = request.headers.get("Upgrade");
    if (!upgrade || upgrade.toLowerCase() !== "websocket") {
      return new Response(
        [
          "ChainMind WalletConnect relay proxy",
          "Upgrade: websocket required for relay traffic.",
          `Upstream: ${UPSTREAM_ORIGIN}`,
        ].join("\n") + "\n",
        {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      );
    }

    const incoming = new URL(request.url);
    const target = new URL(
      `${incoming.pathname}${incoming.search}`,
      UPSTREAM_ORIGIN,
    );

    const headers = new Headers();
    headers.set("Upgrade", "websocket");
    headers.set("Connection", "Upgrade");
    for (const name of [
      "Authorization",
      "Origin",
      "User-Agent",
      "Sec-WebSocket-Protocol",
    ]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    let upstreamResp;
    try {
      upstreamResp = await fetch(target.toString(), { headers });
    } catch (err) {
      return new Response(`Upstream connect failed: ${String(err)}`, {
        status: 502,
      });
    }

    const upstream = upstreamResp.webSocket;
    if (!upstream) {
      const body = await upstreamResp.text().catch(() => "");
      return new Response(
        `Upstream did not accept WebSocket (${upstreamResp.status}): ${body.slice(0, 200)}`,
        {
          status: 502,
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      );
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    upstream.accept({ allowHalfOpen: true });
    server.accept({ allowHalfOpen: true });

    pipe(server, upstream);
    pipe(upstream, server);

    ctx.waitUntil(waitUntilClosed(server, upstream));

    const proto = request.headers.get("Sec-WebSocket-Protocol");
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: proto ? { "Sec-WebSocket-Protocol": proto } : undefined,
    });
  },
};

function pipe(from, to) {
  from.addEventListener("message", (event) => {
    try {
      if (to.readyState === WebSocket.OPEN || to.readyState === 1) {
        to.send(event.data);
      }
    } catch {
      // peer already closed
    }
  });
  from.addEventListener("close", (event) => {
    try {
      to.close(event.code || 1000, event.reason || "");
    } catch {
      // ignore
    }
  });
  from.addEventListener("error", () => {
    try {
      to.close(1011, "proxy error");
    } catch {
      // ignore
    }
  });
}

function waitUntilClosed(...sockets) {
  return Promise.all(
    sockets.map(
      (ws) =>
        new Promise((resolve) => {
          ws.addEventListener("close", () => resolve(), { once: true });
          ws.addEventListener("error", () => resolve(), { once: true });
        }),
    ),
  );
}
