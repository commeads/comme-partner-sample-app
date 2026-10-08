const result = document.querySelector("#result");
const requestPreview = document.querySelector("#request-preview");
const connections = document.querySelector("#connections");
const customProvider = document.querySelector("#custom-provider");
const customMethod = document.querySelector("#custom-method");
const customPath = document.querySelector("#custom-path");
const customBody = document.querySelector("#custom-body-field");
const message = new URLSearchParams(location.search).get("message");
const providers = {
  business: { label: "TikTok Business", prefix: "proxy-ttb", examplePath: "open_api/v1.3/oauth2/advertiser/get/" },
  shop: { label: "TikTok Shop", prefix: "proxy-tts", examplePath: "authorization/202309/shops" },
};
let configuration;
let connectionIDs = {};

if (message) document.querySelector("#message").textContent = message;

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function showRequest({ method, url, body }) {
  const parts = [
    `curl -X ${method} ${shellQuote(url)}`,
    `  -H 'Accept: application/json'`,
    `  -H ${shellQuote(`Authorization: Bearer ${configuration.api_key}`)}`,
  ];
  if (body !== undefined) {
    parts.push(`  -H 'Content-Type: application/json'`);
    parts.push(`  --data ${shellQuote(body)}`);
  }
  requestPreview.textContent = parts.join(" \\\n");
}

function gatewayURL(provider, path, query = "") {
  const segments = path.replace(/\/$/, "").split("/");
  if (
    path !== "metadata" &&
    (!path ||
      segments.some((segment) =>
        !segment || segment === "." || segment === ".." || !/^[A-Za-z0-9._~-]+$/.test(segment),
      ))
  ) {
    throw new Error("Path must contain only gateway path segments, without a query string.");
  }
  const suffix = path === "metadata" ? "" : `/${providers[provider].prefix}/${path.replace(/^\/+/, "")}`;
  const url = new URL(`/_tiktok/connections/${connectionIDs[provider]}${suffix}`, location.origin);
  const raw = query.trim().replace(/^\?/, "");
  if (raw) url.search = raw;
  return url;
}

async function callGateway({ provider, method, path, query, body }) {
  if (!connectionIDs[provider]) {
    result.textContent = `Connect a ${providers[provider].label} account first.`;
    return { ok: false };
  }
  let bodyText;
  try {
    if (method === "POST") {
      const parsed = JSON.parse(body.trim() || "{}");
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("Body must be a JSON object.");
      bodyText = JSON.stringify(parsed);
    }
    const url = gatewayURL(provider, path, query);
    const curlURL = new URL(url.pathname + url.search, configuration.gateway_origin);
    showRequest({ method, url: curlURL.toString(), body: bodyText });
    result.textContent = "Loading…";
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${configuration.api_key}`,
        Accept: "application/json",
        ...(bodyText ? { "Content-Type": "application/json" } : {}),
      },
      body: bodyText,
      signal: AbortSignal.timeout(45_000),
    });
    const text = await response.text();
    let data;
    let formatted = text;
    try {
      data = JSON.parse(text);
      formatted = JSON.stringify(data, null, 2);
    } catch { /* Show text as returned. */ }
    result.textContent = `${response.status} ${response.statusText}\n\n${formatted}`;
    return { ok: response.ok, data };
  } catch (error) {
    result.textContent = error.message || "Request failed";
    return { ok: false };
  }
}

function fillFirst(selector, value) {
  if (!value) return;
  document.querySelectorAll(selector).forEach((input) => {
    if (!input.value) input.value = value;
  });
}

const autofill = {
  "open_api/v1.3/oauth2/advertiser/get/": (data) =>
    fillFirst("[data-advertiser-id]", data?.data?.list?.[0]?.advertiser_id),
  "authorization/202309/shops": (data) => {
    const firstShop = data?.data?.shops?.[0] ?? data?.shops?.[0];
    fillFirst("[data-shop-cipher]", firstShop?.shop_cipher ?? firstShop?.cipher);
  },
};

async function refresh() {
  const [configResponse, connectionsResponse] = await Promise.all([fetch("/api/config"), fetch("/api/connections")]);
  configuration = await configResponse.json();
  connectionIDs = await connectionsResponse.json();
  document.querySelector("#gateway-origin").textContent = configuration.gateway_origin;
  connections.textContent = Object.keys(providers)
    .map((provider) => `${provider}: ${connectionIDs[provider] || "Not connected"}`)
    .join("\n");
  document.querySelectorAll("button[data-disconnect]").forEach((button) => {
    button.disabled = !connectionIDs[button.dataset.disconnect];
  });
}

document.querySelectorAll("button[data-request]").forEach((button) =>
  button.addEventListener("click", async () => {
    const response = await callGateway({
      provider: button.dataset.provider,
      method: button.dataset.method,
      path: button.dataset.path,
      query: button.dataset.query || "",
      body: button.dataset.body,
    });
    if (response.ok) autofill[button.dataset.path]?.(response.data);
  }),
);

document.querySelectorAll("form[data-business-query]").forEach((form) =>
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = new URLSearchParams(new FormData(form));
    const listParam = form.dataset.listParam;
    if (listParam) query.set(listParam, JSON.stringify([query.get(listParam)]));
    callGateway({
      provider: "business",
      method: "GET",
      path: form.dataset.path,
      query: query.toString(),
    });
  }),
);

document.querySelectorAll("form[data-shop-search]").forEach((form) =>
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = new URLSearchParams(new FormData(form)).toString();
    callGateway({
      provider: "shop",
      method: "POST",
      path: form.dataset.path,
      query,
      body: "{}",
    });
  }),
);

document.querySelector("#custom-request").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = Object.fromEntries(new FormData(event.currentTarget));
  callGateway({ provider: input.provider, method: input.method, path: input.path, query: input.query, body: input.body });
});

customProvider.addEventListener("change", () => {
  customPath.value = providers[customProvider.value].examplePath;
});

customMethod.addEventListener("change", () => {
  customBody.hidden = customMethod.value !== "POST";
});

document.querySelectorAll("button[data-disconnect]").forEach((button) =>
  button.addEventListener("click", async () => {
    const provider = button.dataset.disconnect;
    if (!connectionIDs[provider] || !confirm(`Disconnect this ${providers[provider].label} connection?`)) return;
    if ((await callGateway({ provider, method: "DELETE", path: "metadata", query: "" })).ok) {
      await fetch(`/api/connections/${provider}`, { method: "DELETE" });
      location.reload();
    }
  }),
);

refresh();
