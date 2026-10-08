import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { configFromEnv, createDemo } from "./server.mjs";

const config = {
  origin: "https://gateway.example",
  demoOrigin: "http://127.0.0.1",
  clientID: "partner-demo",
  apiKey: "k".repeat(32),
};

test("requires the gateway origin", () => {
  assert.throws(
    () =>
      configFromEnv({
        PARTNER_CLIENT_ID: "partner-demo",
        PARTNER_API_KEY: "k".repeat(32),
      }),
    /PARTNER_GATEWAY_ORIGIN is required/,
  );
});

async function running(run, fakeFetch) {
  const server = createDemo(config, fakeFetch);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

async function connect(base, provider, connectionID, cookie) {
  const start = await fetch(`${base}/oauth/start?provider=${provider}`, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
  cookie ??= start.headers.get("set-cookie").split(";")[0];
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  await fetch(
    `${base}/oauth/callback?state=${encodeURIComponent(state)}&connection_id=${connectionID}`,
    { headers: { cookie }, redirect: "manual" },
  );
  return { cookie, connectionID };
}

function connectShop(base) {
  return connect(base, "shop", `ttc_${"b".repeat(32)}`);
}

test("Shop OAuth state is session-bound, single-use, and stores the connection", async () => {
  await running(
    async (base) => {
      const start = await fetch(`${base}/oauth/start?provider=shop`, {
        redirect: "manual",
      });
      const cookie = start.headers.get("set-cookie").split(";")[0];
      const target = new URL(start.headers.get("location"));
      assert.equal(target.origin, config.origin);
      assert.equal(target.searchParams.get("client_id"), config.clientID);
      assert.equal(
        target.searchParams.get("redirect_uri"),
        `${config.demoOrigin}/oauth/callback`,
      );
      assert.ok(!target.toString().includes(config.apiKey));

      const callback = `${base}/oauth/callback?state=${encodeURIComponent(target.searchParams.get("state"))}&connection_id=ttc_${"a".repeat(32)}`;
      assert.equal(
        (await fetch(callback, { headers: { cookie }, redirect: "manual" }))
          .status,
        302,
      );
      const connections = await fetch(`${base}/api/connections`, {
        headers: { cookie },
      });
      assert.deepEqual(await connections.json(), {
        shop: `ttc_${"a".repeat(32)}`,
      });
      assert.equal(
        (
          await fetch(`${base}/api/connections/shop`, {
            method: "DELETE",
            headers: { cookie, Origin: config.demoOrigin },
          })
        ).status,
        204,
      );
      assert.deepEqual(
        await (
          await fetch(`${base}/api/connections`, { headers: { cookie } })
        ).json(),
        {},
      );
      assert.equal(
        (await fetch(callback, { headers: { cookie }, redirect: "manual" }))
          .status,
        400,
      );
    },
  );
});

test("configuration gives the browser what it needs to construct calls", async () => {
  await running(
    async (base) => {
      const response = await fetch(`${base}/api/config`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        gateway_origin: config.origin,
        api_key: config.apiKey,
      });
    },
  );
});

test("thin proxy preserves method, path, query, body, and API headers", async () => {
  const calls = [];
  await running(
    async (base) => {
      const { cookie, connectionID } = await connectShop(base);
      const path = `/_tiktok/connections/${connectionID}/proxy-tts/order/202309/orders/search?shop_cipher=cipher&page_size=20`;
      const response = await fetch(base + path, {
        method: "POST",
        headers: {
          cookie,
          Authorization: `Bearer ${config.apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: '{"order_status":"UNPAID"}',
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { code: 0 });
      assert.equal(calls[0].url, config.origin + path);
      assert.equal(calls[0].init.method, "POST");
      assert.deepEqual(calls[0].init.headers, {
        authorization: `Bearer ${config.apiKey}`,
        accept: "application/json",
        "content-type": "application/json",
      });
      assert.equal(calls[0].init.body.toString(), '{"order_status":"UNPAID"}');
    },
    async (url, init) => {
      calls.push({ url, init });
      return new Response('{"code":0}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  );
});

test("Business connection proxies Ads paths and keeps provider prefixes separate", async () => {
  const calls = [];
  await running(
    async (base) => {
      const business = `ttc_${"c".repeat(32)}`;
      const { cookie, connectionID: shop } = await connectShop(base);
      await connect(base, "business", business, cookie);
      assert.deepEqual(
        await (await fetch(`${base}/api/connections`, { headers: { cookie } })).json(),
        { shop, business },
      );

      const path = `/_tiktok/connections/${business}/proxy-ttb/open_api/v1.3/campaign/get/?advertiser_id=123&page_size=20`;
      const response = await fetch(base + path, {
        headers: { cookie, Authorization: `Bearer ${config.apiKey}` },
      });
      assert.equal(response.status, 200);
      assert.equal(calls[0].url, config.origin + path);
      assert.equal(calls[0].init.method, "GET");

      for (const crossed of [
        `/_tiktok/connections/${business}/proxy-tts/authorization/202309/shops`,
        `/_tiktok/connections/${shop}/proxy-ttb/open_api/v1.3/campaign/get/`,
      ]) {
        assert.equal((await fetch(base + crossed, { headers: { cookie } })).status, 400);
      }
      assert.equal(calls.length, 1);

      assert.equal(
        (
          await fetch(`${base}/api/connections/business`, {
            method: "DELETE",
            headers: { cookie, Origin: config.demoOrigin },
          })
        ).status,
        204,
      );
      assert.deepEqual(
        await (await fetch(`${base}/api/connections`, { headers: { cookie } })).json(),
        { shop },
      );
    },
    async (url, init) => {
      calls.push({ url, init });
      return new Response('{"code":0}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  );
});

test("rejects unknown providers and the old operation endpoint", async () => {
  await running(
    async (base) => {
      assert.equal((await fetch(`${base}/oauth/start?provider=other`)).status, 400);
      assert.equal((await fetch(`${base}/api/call`, { method: "POST" })).status, 404);
    },
  );
});
