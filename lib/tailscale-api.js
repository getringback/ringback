"use strict";
// The few documented Tailscale API v2 calls remote-guest setup needs (api.tailscale.com, OpenAPI
// "Tailscale API"): OAuth client-credentials token, policy file get / validate / set with If-Match,
// device list and tags, trust-credential (OAuth client) create and delete. Nothing else.
// The base URL is api.tailscale.com; tests point it at a local fake only with RINGBACK_DEV=1 and
// a loopback http:// address (the same rule as RINGBACK_URL, audit H5). Secrets are never logged.

const https = require("https");
const http = require("http");

const BASE = "https://api.tailscale.com";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** The API base: api.tailscale.com, or a loopback test fake when RINGBACK_DEV=1. */
function apiBase(env = process.env) {
  const raw = String(env.RINGBACK_TS_API || "").trim();
  if (!raw || env.RINGBACK_DEV !== "1") return BASE;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" && LOOPBACK.has(u.hostname) ? raw.replace(/\/+$/, "") : BASE;
  } catch {
    return BASE;
  }
}

class TailscaleError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function send(base, method, path, { headers = {}, body, form } = {}) {
  const u = new URL(path, base);
  const lib = u.protocol === "https:" ? https : http;
  const payload = form ? new URLSearchParams(form).toString() : body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
  const h = { Accept: "application/json", ...headers };
  if (payload !== null) {
    h["Content-Type"] = form ? "application/x-www-form-urlencoded" : "application/json";
    h["Content-Length"] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = lib.request(u, { method, headers: h, timeout: 30000 }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        if (raw.length < 4 * 1024 * 1024) raw += c;
      });
      res.on("end", () => {
        let json = null;
        try {
          json = raw ? JSON.parse(raw) : null;
        } catch {
          json = null;
        }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ status: res.statusCode, json, etag: res.headers.etag || "" });
        const detail = (json && (json.message || json.error)) || `HTTP ${res.statusCode}`;
        return reject(new TailscaleError(`Tailscale said: ${String(detail).slice(0, 300)}`, res.statusCode, json));
      });
    });
    req.on("timeout", () => req.destroy(new Error("Tailscale did not answer in 30 s")));
    req.on("error", reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** A client bound to one OAuth client id and secret. The secret only ever goes to the token call. */
function createTailscale({ clientId, clientSecret, env = process.env, base = apiBase(env) }) {
  let token = null;
  const auth = async () => {
    if (token) return token;
    const r = await send(base, "POST", "/api/v2/oauth/token", { form: { client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" } });
    token = { access: r.json && r.json.access_token, scope: String((r.json && r.json.scope) || "") };
    if (!token.access) throw new TailscaleError("Tailscale gave no access token for that client.", r.status, null);
    return token;
  };
  const call = async (method, path, opts = {}) => {
    const t = await auth();
    return send(base, method, path, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${t.access}` } });
  };
  return {
    base,
    /** The same API as another OAuth client (one this setup just made). */
    withClient: (id, key) => createTailscale({ clientId: id, clientSecret: key, env, base }),
    /** The scopes the token was granted (space separated in the token response). */
    scopes: async () => (await auth()).scope.split(/\s+/).filter(Boolean),
    getPolicy: async () => {
      const r = await call("GET", "/api/v2/tailnet/-/acl");
      return { policy: r.json, etag: r.etag };
    },
    validatePolicy: (policy) => call("POST", "/api/v2/tailnet/-/acl/validate", { body: policy }).then((r) => r.json || {}),
    setPolicy: (policy, etag) => call("POST", "/api/v2/tailnet/-/acl", { body: policy, headers: etag ? { "If-Match": etag } : {} }).then((r) => r.json),
    devices: () => call("GET", "/api/v2/tailnet/-/devices").then((r) => (r.json && r.json.devices) || []),
    setDeviceTags: (id, tags) => call("POST", `/api/v2/device/${encodeURIComponent(id)}/tags`, { body: { tags } }),
    createClient: (description, scopes, tags) => call("POST", "/api/v2/tailnet/-/keys", { body: { keyType: "client", description, scopes, tags } }).then((r) => r.json || {}),
    deleteKey: (id) => call("DELETE", `/api/v2/tailnet/-/keys/${encodeURIComponent(id)}`),
  };
}

module.exports = { apiBase, createTailscale, TailscaleError, BASE };
