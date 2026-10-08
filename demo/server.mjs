import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const connectionPattern = /^ttc_[a-f0-9]{32}$/;
const sessionPattern = /^[a-f0-9]{64}$/;
const proxyPrefixes = { business: "proxy-ttb", shop: "proxy-tts" };

class RequestError extends Error {}

export function configFromEnv(env = process.env) {
  if (!env.PARTNER_GATEWAY_ORIGIN)
    throw new Error("PARTNER_GATEWAY_ORIGIN is required");
  const origin = new URL(env.PARTNER_GATEWAY_ORIGIN).origin;
  const demoOrigin = new URL(env.PARTNER_DEMO_ORIGIN || "http://localhost:4173")
    .origin;
  const clientID = env.PARTNER_CLIENT_ID || "";
  const apiKey = env.PARTNER_API_KEY || "";
  if (!clientID || !apiKey)
    throw new Error("PARTNER_CLIENT_ID and PARTNER_API_KEY are required");
  return {
    origin,
    demoOrigin,
    clientID,
    apiKey,
    port: Number(env.PORT || new URL(demoOrigin).port || 4173),
  };
}

export function createDemo(config, fetchImpl = fetch) {
  const sessions = new Map();
  const states = new Map();

  function session(req, res) {
    const cookie = Object.fromEntries(
      (req.headers.cookie || "")
        .split(";")
        .map((item) => item.trim().split("=")),
    );
    let id = cookie.partner_demo_session;
    if (!sessionPattern.test(id || "")) {
      id = randomBytes(32).toString("hex");
      const secure = config.demoOrigin.startsWith("https:") ? "; Secure" : "";
      res.setHeader(
        "Set-Cookie",
        `partner_demo_session=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600${secure}`,
      );
    }
    if (!sessions.has(id)) sessions.set(id, { connections: {} });
    return { id, value: sessions.get(id) };
  }

  async function handler(req, res) {
    try {
      const url = new URL(req.url, config.demoOrigin);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (req.method === "GET" && url.pathname === "/")
        return staticFile(res, "index.html", "text/html; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/app.js")
        return staticFile(res, "app.js", "text/javascript; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/style.css")
        return staticFile(res, "style.css", "text/css; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/api/config")
        return json(res, 200, {
          gateway_origin: config.origin,
          api_key: config.apiKey,
        });

      const current = session(req, res);
      if (req.method === "GET" && url.pathname === "/oauth/start") {
        const provider = url.searchParams.get("provider");
        if (!Object.hasOwn(proxyPrefixes, provider))
          throw new RequestError("provider must be business or shop");
        const state = randomBytes(32).toString("base64url");
        states.set(hash(state), {
          sessionID: current.id,
          provider,
          expiresAt: Date.now() + 10 * 60_000,
        });
        const target = new URL("/_tiktok/oauth/authorize", config.origin);
        target.search = new URLSearchParams({
          client_id: config.clientID,
          provider,
          redirect_uri: `${config.demoOrigin}/oauth/callback`,
          state,
        });
        res.writeHead(302, { Location: target.toString() }).end();
        return;
      }
      if (req.method === "GET" && url.pathname === "/oauth/callback") {
        const state = url.searchParams.get("state") || "";
        const pending = states.get(hash(state));
        states.delete(hash(state));
        if (
          !pending ||
          pending.sessionID !== current.id ||
          pending.expiresAt < Date.now()
        )
          throw new RequestError("OAuth state is invalid or expired");
        const error = url.searchParams.get("error");
        if (error) return redirectResult(res, `Authorization failed: ${error}`);
        const connectionID = url.searchParams.get("connection_id") || "";
        if (!connectionPattern.test(connectionID))
          throw new RequestError("connection_id is invalid");
        current.value.connections[pending.provider] = connectionID;
        return redirectResult(res, `${pending.provider} connected`);
      }
      if (req.method === "GET" && url.pathname === "/api/connections")
        return json(res, 200, current.value.connections);
      const saved = url.pathname.match(/^\/api\/connections\/(business|shop)$/);
      if (req.method === "DELETE" && saved) {
        checkOrigin(req, config.demoOrigin);
        delete current.value.connections[saved[1]];
        res.writeHead(204).end();
        return;
      }
      if (
        ["GET", "POST", "DELETE"].includes(req.method) &&
        url.pathname.startsWith("/_tiktok/connections/")
      ) {
        const allowed = Object.entries(current.value.connections).some(
          ([provider, connectionID]) => {
            const basePath = `/_tiktok/connections/${connectionID}`;
            return (
              url.pathname === basePath ||
              url.pathname.startsWith(`${basePath}/${proxyPrefixes[provider]}/`)
            );
          },
        );
        if (!allowed) throw new RequestError("connection path is invalid");
        const body = req.method === "POST" ? await readBody(req) : undefined;
        const headers = {};
        for (const name of ["authorization", "accept", "content-type"]) {
          if (req.headers[name]) headers[name] = req.headers[name];
        }
        const upstream = await fetchImpl(`${config.origin}${url.pathname}${url.search}`, {
          method: req.method,
          headers,
          body,
          signal: AbortSignal.timeout(45_000),
        });
        res.statusCode = upstream.status;
        for (const [name, value] of upstream.headers) {
          if (!["connection", "content-encoding", "content-length", "set-cookie", "transfer-encoding"].includes(name)) {
            res.setHeader(name, value);
          }
        }
        res.end(Buffer.from(await upstream.arrayBuffer()));
        return;
      }
      json(res, 404, { error: "not_found" });
    } catch (error) {
      const status =
        error instanceof RequestError || error instanceof SyntaxError
          ? 400
          : 502;
      json(res, status, { error: error.message || "request_failed" });
    }
  }
  return createServer(handler);
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
function checkOrigin(req, expected) {
  if (req.headers.origin !== expected)
    throw new RequestError("origin is not allowed");
}
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024)
      throw new RequestError("request is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function json(res, status, value) {
  res
    .writeHead(status, { "Content-Type": "application/json" })
    .end(JSON.stringify(value));
}
function redirectResult(res, message) {
  res
    .writeHead(302, { Location: `/?message=${encodeURIComponent(message)}` })
    .end();
}
async function staticFile(res, name, contentType) {
  res.setHeader("Content-Type", contentType);
  res.end(await readFile(join(here, "public", name)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = configFromEnv();
  createDemo(config).listen(config.port, () =>
    console.log(`Partner gateway demo: ${config.demoOrigin}`),
  );
}
