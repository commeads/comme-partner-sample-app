# Partner gateway demo

[Back to partner integration guide](../api-guide.md)

This dependency-free Node.js app demonstrates the browser OAuth handoff and common read-only TikTok Business (Ads) and TikTok Shop calls. The browser constructs each request with the gateway method, path, query parameters, body, and headers, but sends it to the same-origin demo server. The server is a thin proxy that changes only the origin before forwarding the request to the partner gateway. Each call displays a curl-style request, and the custom form accepts a method, path, query parameters, and POST body.

The demo sends `PARTNER_API_KEY` to its own browser frontend so the displayed and submitted request retains the real gateway header shape. Use only a dedicated non-production demo key. Production partner applications keep this credential exclusively server-side.

## Run

Use Node.js 24. Set `PARTNER_GATEWAY_ORIGIN` to the gateway origin supplied by the gateway operator. The operator must register the exact callback `http://localhost:4173/oauth/callback` for your client before authorization can start.

```sh
export PARTNER_GATEWAY_ORIGIN=https://gateway.example
export PARTNER_DEMO_ORIGIN=http://localhost:4173
export PARTNER_CLIENT_ID=your-client-id
export PARTNER_API_KEY='your-private-api-key'
node demo/server.mjs
```

Open <http://localhost:4173>. Restarting the process clears its in-memory browser sessions, but does not disconnect gateway connections. This is intentionally a small integration example, not a production session store.

Run its tests with:

```sh
node --test demo/server.test.mjs
```

For production, persist the partner's own mapping from user/account to `connection_id`, encrypt sensitive configuration, use secure cookies behind HTTPS, implement normal authentication and authorization, and keep the API key behind the partner's server-side boundary.
