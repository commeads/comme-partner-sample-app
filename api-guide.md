# Partner Gateway Integration

[Runnable demo](demo/README.md)

## Overview

The partner gateway lets an approved partner obtain a user's TikTok Business or TikTok Shop authorization and make a reviewed set of read-only TikTok API calls. The gateway operator supplies the base URL for your environment privately; examples below use the placeholder `https://gateway.example`.

The partner receives two values privately:

- a `client_id`, used only to begin browser authorization; and
- an API key, used only by the partner's backend as `Authorization: Bearer <key>`.

Never place the API key in browser JavaScript, a URL, source control, logs, or analytics. A returned `connection_id` identifies stored authorization but is not itself a credential. Store the mapping between the partner's user/account and that connection ID.

## TikTok Shop API versus the Comme proxy

The proxy deliberately keeps TikTok Shop's versioned paths, query parameters, JSON bodies, pagination, and successful response schema. It changes authentication and applies a read-only security boundary around the upstream API.

| Concern | TikTok Shop Open API | Comme partner gateway |
| --- | --- | --- |
| Base URL | TikTok Shop Open API host | `https://gateway.example/_tiktok/connections/{connection_id}/proxy-tts` |
| Caller authentication | TikTok access token plus app credentials and request signature | `Authorization: Bearer <partner-api-key>` |
| Seller authorization | Partner obtains and stores TikTok tokens | Gateway completes OAuth and stores tokens; partner stores only `connection_id` |
| Signing parameters | Caller supplies `app_key`, `timestamp`, and `sign` | Gateway removes caller-supplied credential/signing parameters and generates its own |
| Shop selection | `shop_cipher` from the authorized-shops response | Same `shop_cipher`, obtained through the proxied authorized-shops call |
| Methods and paths | Any operation granted to the TikTok app | Only the exact read operations listed in this guide; all other method/path/version combinations return `403` |
| Request body and query | Defined by each TikTok endpoint | Preserved for admitted calls, except gateway-owned authentication/signing inputs; duplicate Shop query keys are rejected |
| Response body | TikTok schema and API `code` | TikTok status and body pass through byte-for-byte in the normal case; gateway-generated failures use the separate `error` envelope below |
| Response headers | TikTok's full response header set | Only `Content-Type`, `Retry-After`, and validated TikTok request-ID headers can pass; `Cache-Control: no-store` is added |
| Rate limits | TikTok app, endpoint, seller, or other provider quotas | An additional per-partner-client fixed-minute limit, 60 requests/minute by default; TikTok limits still apply independently |
| Token refresh | Caller's responsibility | Gateway refreshes eligible Shop credentials and returns `409 reconnect_required` when authorization cannot be recovered |
| Retries | Caller's responsibility | Still the caller's responsibility; the gateway never automatically replays an upstream request |
| Size and timeout | TikTok contract | 4 MiB request, 16 MiB response, approximately 40 seconds total |

For example, change this direct TikTok Shop request:

```text
POST https://open-api.tiktokglobalshop.com/order/202309/orders/search
  ?app_key=...&timestamp=...&sign=...&shop_cipher=...&page_size=20
Headers: x-tts-access-token: <TikTok token>
Body:    {}
```

to this gateway request:

```text
POST https://gateway.example/_tiktok/connections/{connection_id}/proxy-tts/order/202309/orders/search
  ?shop_cipher=...&page_size=20
Headers: Authorization: Bearer <partner-api-key>
         Content-Type: application/json
Body:    {}
```

Do not include `app_key`, `app_id`, `app_secret`, `secret`, `sign`, `timestamp`, TikTok access or refresh tokens, authorization codes, or an additional authorization value. The gateway owns those fields and strips credential-like query parameters before signing the upstream request.

## OAuth authorization

Register every exact callback URI with the gateway operator. HTTPS is required in production; staging also permits explicitly registered HTTP loopback callbacks for local development. The callback URI must not already contain `state`, `connection_id`, or `error` query parameters.

1. The partner backend creates a cryptographically random, single-use `state`, binds it to the signed-in user and intended provider, and expires it within a few minutes.
2. Redirect the browser to:

   ```text
   GET /_tiktok/oauth/authorize
     ?client_id=<client-id>
     &provider=<business|shop>
     &redirect_uri=<url-encoded registered callback>
     &state=<opaque partner state>
   ```

3. The gateway handles provider consent and token exchange. Do not call TikTok's token endpoint from the partner application.
4. On success, the gateway redirects to the registered callback with the original `state` and `connection_id`. On a handled failure, it returns the original `state` and an `error` value.
5. The partner backend compares and consumes `state` before accepting either result. It then stores the connection mapping and redirects to a clean application URL.

Example success and failure callbacks:

```text
https://partner.example/oauth/callback?state=<original>&connection_id=ttc_<32-hex>
https://partner.example/oauth/callback?state=<original>&error=authorization_denied
```

The gateway's own provider state is single-use and expires after 15 minutes. An invalid, expired, or replayed gateway state is not redirected to the partner. If authorization or exchange fails, begin a new authorization rather than replaying the callback.

## Calling the API

All management and proxy calls are server-to-server. Set the gateway origin once, then send the partner API key on every connection-management and proxy request:

```sh
GATEWAY=https://gateway.example

curl --fail-with-body \
  -H "Authorization: Bearer $PARTNER_API_KEY" \
  "$GATEWAY/_tiktok/connections/$CONNECTION_ID"
```

The API key identifies one configured partner client. The connection must belong to that client; a missing connection and a connection owned by a different client intentionally return the same `404` response. Do not use `client_id` as API authentication: it is public and is accepted only by the browser authorization endpoint.

Provider calls retain TikTok's documented query parameters and JSON request bodies, but replace the TikTok host with the connection-specific gateway prefix:

```text
Business: /_tiktok/connections/{connection_id}/proxy-ttb{TikTok Business path}
Shop:     /_tiktok/connections/{connection_id}/proxy-tts{TikTok Shop path}
```

Do not send provider tokens, app IDs, secrets, signatures, or timestamps. The gateway strips credential-like inputs and supplies its own provider authentication. It forwards only `Accept` and `Content-Type` request headers. JSON requests must use `Content-Type: application/json`; compressed request bodies are not supported. Pagination is the partner's responsibility.

### Connection management

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/_tiktok/connections/{connection_id}` | Metadata: `id`, `provider`, `provider_identity`, `status`, `created_at`, `updated_at` |
| `DELETE` | `/_tiktok/connections/{connection_id}` | `204`; permanently erases locally stored credentials and blocks later calls |

Disconnect does not revoke the shared TikTok app authorization. Reauthorization of the same client/provider identity normally reuses the connection ID. A Business authorization may produce a new identity when its advertiser set changes; adopt the new ID and explicitly disconnect an obsolete one.

### Business read paths

All current Business proxy paths use `GET` and API version `v1.3`:

```text
/open_api/v1.3/oauth2/advertiser/get/
/open_api/v1.3/bc/get/
/open_api/v1.3/bc/asset/get/
/open_api/v1.3/bc/asset/admin/get/
/open_api/v1.3/advertiser/info/
/open_api/v1.3/campaign/get/
/open_api/v1.3/adgroup/get/
/open_api/v1.3/ad/get/
/open_api/v1.3/report/integrated/get/
/open_api/v1.3/gmv_max/report/get/
/open_api/v1.3/smart_plus/campaign/get/
/open_api/v1.3/smart_plus/adgroup/get/
/open_api/v1.3/smart_plus/ad/get/
/open_api/v1.3/file/image/ad/info/
/open_api/v1.3/file/video/ad/info/
/open_api/v1.3/file/video/ad/search/
/open_api/v1.3/creative/portfolio/get/
/open_api/v1.3/creative/portfolio/list/
/open_api/v1.3/dmp/custom_audience/get/
/open_api/v1.3/dmp/custom_audience/list/
/open_api/v1.3/dmp/custom_audience/apply/log/
/open_api/v1.3/dmp/custom_audience/share/log/
/open_api/v1.3/dmp/saved_audience/list/
/open_api/v1.3/audience/insight/overlap/
/open_api/v1.3/report/task/check/
/open_api/v1.3/smart_plus/material_report/overview/
/open_api/v1.3/smart_plus/material_report/breakdown/
```

First call `oauth2/advertiser/get/` to discover authorized advertisers. Then use returned advertiser IDs with inventory and reporting endpoints. Example:

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $PARTNER_API_KEY" \
  "$GATEWAY/_tiktok/connections/$CONNECTION_ID/proxy-ttb/open_api/v1.3/campaign/get/?advertiser_id=123456789&page_size=20"
```

### Shop read paths

| Method | TikTok Shop path |
| --- | --- |
| `GET` | `/authorization/202309/shops` |
| `GET` | `/order/202507/orders` |
| `GET` | `/fulfillment/202309/packages/{numeric-id}` |
| `GET` | `/finance/202309/statements` |
| `GET` | `/finance/202501/statements/{numeric-id}/statement_transactions` |
| `GET` | `/finance/202501/orders/{numeric-id}/statement_transactions` |
| `GET` | `/finance/202309/payments` |
| `GET` | `/finance/202309/withdrawals` |
| `GET` | `/product/202309/products/{numeric-id}` |
| `GET` | `/logistics/202309/warehouses` |
| `GET` | `/logistics/202309/warehouses/{numeric-id}/delivery_options` |
| `GET` | `/logistics/202309/delivery_options/{numeric-id}/shipping_providers` |
| `POST` | `/order/202309/orders/search` |
| `POST` | `/return_refund/202309/returns/search` |
| `POST` | `/return_refund/202602/cancellations/search` |
| `POST` | `/product/202502/products/search` |
| `POST` | `/product/202309/inventory/search` |

First call `/authorization/202309/shops` and retain each returned `shop_cipher` for calls that require it. Example:

```sh
curl --fail-with-body -X POST \
  -H "Authorization: Bearer $PARTNER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}' \
  "$GATEWAY/_tiktok/connections/$CONNECTION_ID/proxy-tts/order/202309/orders/search?shop_cipher=$SHOP_CIPHER&page_size=20"
```

Only the exact method/path combinations above are admitted. Unknown paths, different API versions, mutation endpoints, token endpoints, uploads, and report creation/cancellation fail closed. Provider permissions and market availability can still limit an admitted call.

## Statuses, limits, and retries

| Status | Meaning | Partner action |
| --- | --- | --- |
| `400` | Invalid gateway request or provider mismatch | Correct the request; do not retry unchanged |
| `401` | Missing or invalid partner API key | Correct backend configuration |
| `403` | Method/path is not admitted | Use the documented exact method/version |
| `404` | Connection is absent or owned by another client | Verify the stored connection mapping or reauthorize |
| `409` | Provider authorization requires reconnection | Start a new OAuth authorization |
| `413` / `415` | Body too large or not valid JSON | Correct the body; limit is 4 MiB |
| `429` | Gateway client limit or an upstream TikTok limit | Inspect the body; for gateway `rate_limited`, wait for `Retry-After` |
| `502` / `504` | Unsafe, failed, or timed-out upstream response | Retry with bounded exponential backoff; keep the request id for support |
| `503` | Gateway or provider integration unavailable | Retry later with bounded backoff |

Gateway-generated errors have a stable envelope that is different from TikTok's response schema:

```json
{
  "error": {
    "code": "rate_limited",
    "message": "rate limited",
    "requestId": "9f30c5dbe7dc9f681d1f16f8f95c167a"
  }
}
```

Use `error.code` for program logic and retain `error.requestId` when contacting support. Do not parse `error.message` as a stable identifier.

For a normal upstream response, the gateway preserves TikTok's HTTP status and response bytes. Continue to inspect TikTok's JSON `code`, `message`, `request_id`, and endpoint-specific `data` according to the original endpoint documentation; an HTTP `200` does not by itself mean the TikTok operation succeeded. The gateway does not wrap a successful response in another `data` object and does not rename, normalize, or enrich its fields.

The exceptions—where the gateway can return a different status or body instead of TikTok's response—are:

- gateway authentication, ownership, policy, request-validation, or local rate-limit failures;
- invalid or revoked provider authorization, normalized to `409` with `error.code: reconnect_required`;
- provider redirects, transport failures, unsupported compression, responses larger than 16 MiB, or a response that could expose credentials, normalized to a safe `502`/`504` error;
- an internal gateway or credential-refresh failure, returned as `503` or another safe gateway error.

The gateway's fixed-minute counter applies to every authenticated management or proxy request, including failed ownership and route checks. Browser OAuth authorize/callback traffic does not consume it. The default is 60 requests per minute per partner client, shared across that client's connections and gateway instances. A gateway-generated `429 rate_limited` includes `Retry-After: 60`; the counter permits bursts around minute boundaries and is not a promise about TikTok capacity. TikTok quotas remain independent and may produce their own `429`, body, and retry header.

Requests time out at approximately 40 seconds. Request bodies are limited to 4 MiB and responses to 16 MiB. The gateway does not automatically replay upstream requests. Use bounded exponential backoff with jitter only for transient `429`, `502`, `503`, and `504` failures; honor `Retry-After` when present. Do not retry an unchanged `400`, `401`, `403`, or `404`. On `409`, start OAuth again instead of retrying the proxy request.

## Demo application

The [runnable demo](demo/README.md) uses Node.js without third-party packages. It covers TikTok Business (Ads) and TikTok Shop authorization and demonstrates connection metadata, authorized advertisers, advertiser info, campaign listing, authorized shops, order search, product search, custom GET/POST calls, and disconnect. The browser constructs the complete gateway request and sends it to the same-origin demo server, which forwards the method, path, query, body, and API headers while replacing only the origin. Each call displays a curl-style request. The dedicated non-production demo key is available to the demo browser; production integrations keep partner keys server-side.

The demo keeps sessions and connection mappings in memory for clarity. A real partner service must use its authenticated session, durable encrypted storage, authorization checks around every connection mapping, HTTPS secure cookies, secret management, audit-safe logging, and a key-rotation procedure.

## Integration checklist

- Exchange the callback URI, client ID, and API key through an approved private channel.
- Keep API keys in backend secret storage and redact `Authorization` headers.
- Generate, bind, expire, compare, and consume OAuth state on the backend.
- Store connection IDs against the correct partner user/account and provider.
- Discover advertisers or shops before requesting resource-specific data.
- Implement pagination, bounded retries, `429` handling, and `409` reconnection UX.
- Never log OAuth callback query strings, provider response bodies containing private customer data, or credentials.
- Test against staging before requesting a production configuration.
