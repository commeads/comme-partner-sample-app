const result = document.querySelector("#result");
const requestPreview = document.querySelector("#request-preview");
const connections = document.querySelector("#connections");
const customMethod = document.querySelector("#custom-method");
const customBody = document.querySelector("#custom-body-field");
const message = new URLSearchParams(location.search).get("message");
let configuration;
let connectionID;

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

function gatewayURL(path, query = "") {
  const segments = path.split("/");
  if (
    path !== "metadata" &&
    (!path ||
      segments.some((segment) =>
        !segment || segment === "." || segment === ".." || !/^[A-Za-z0-9._~-]+$/.test(segment),
      ))
  ) {
    throw new Error("Path must contain only gateway path segments, without a query string.");
  }
  const suffix = path === "metadata" ? "" : `/proxy-tts/${path.replace(/^\/+/, "")}`;
  const url = new URL(`/_tiktok/connections/${connectionID}${suffix}`, location.origin);
  const raw = query.trim().replace(/^\?/, "");
  if (raw) url.search = raw;
  return url;
}

async function callGateway({ method, path, query, body }) {
  if (!connectionID) {
    result.textContent = "Connect a TikTok Shop account first.";
    return { ok: false };
  }
  let bodyText;
  try {
    if (method === "POST") {
      const parsed = JSON.parse(body.trim() || "{}");
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("Body must be a JSON object.");
      bodyText = JSON.stringify(parsed);
    }
    const url = gatewayURL(path, query);
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

function fillFirstShopCipher(data) {
  const firstShop = data?.data?.shops?.[0] ?? data?.shops?.[0];
  const cipher = firstShop?.shop_cipher ?? firstShop?.cipher;
  if (!cipher) return;
  document.querySelectorAll("[data-shop-cipher]").forEach((input) => {
    if (!input.value) input.value = cipher;
  });
}

async function refresh() {
  const [configResponse, connectionsResponse] = await Promise.all([fetch("/api/config"), fetch("/api/connections")]);
  configuration = await configResponse.json();
  const saved = await connectionsResponse.json();
  connectionID = saved.shop;
  document.querySelector("#gateway-origin").textContent = configuration.gateway_origin;
  connections.textContent = connectionID || "Not connected";
  document.querySelector("#disconnect").disabled = !connectionID;
}

document.querySelectorAll("button[data-request]").forEach((button) =>
  button.addEventListener("click", async () => {
    const response = await callGateway({
      method: button.dataset.method,
      path: button.dataset.path,
      query: button.dataset.query || "",
      body: button.dataset.body,
    });
    if (button.dataset.path === "authorization/202309/shops" && response.ok) {
      fillFirstShopCipher(response.data);
    }
  }),
);

document.querySelectorAll("form[data-shop-search]").forEach((form) =>
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = new URLSearchParams(new FormData(form)).toString();
    callGateway({
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
  callGateway({ method: input.method, path: input.path, query: input.query, body: input.body });
});

customMethod.addEventListener("change", () => {
  customBody.hidden = customMethod.value !== "POST";
});

document.querySelector("#disconnect").addEventListener("click", async () => {
  if (!connectionID || !confirm("Disconnect this TikTok Shop connection?")) return;
  if ((await callGateway({ method: "DELETE", path: "metadata", query: "" })).ok) {
    await fetch("/api/connections/shop", { method: "DELETE" });
    location.reload();
  }
});

refresh();
