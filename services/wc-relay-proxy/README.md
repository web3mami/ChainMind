# WalletConnect relay proxy (Cloudflare Worker)

Bridges `wss://` from the ChainMind iOS app to `relay.walletconnect.org` via
Cloudflare’s edge so mobile ISPs that block/throttle direct relay WebSockets
(common on MTN/Airtel/Glo) can still complete WalletConnect pairing.

## Why a proxy (not custom `relayHost`)

WalletConnect JWTs use `aud = wss://relay.walletconnect.org`. Pointing the SDK
at a different hostname breaks auth. This Worker keeps JWT/`aud` unchanged: the
app still configures the official relay host, and only the socket transport is
rewired to this Worker.

## Deploy

```bash
cd services/wc-relay-proxy
npx wrangler deploy
```

Note the `*.workers.dev` URL and set it in the iOS app Info.plist key
`WalletConnectRelayProxyHost` (hostname only, no `wss://`).

## Health

`GET https://<worker>/` → plain-text OK. WebSocket upgrades are proxied upstream.
