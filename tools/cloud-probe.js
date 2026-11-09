#!/usr/bin/env node
"use strict";
// Cloud apps (spec 07) probe: checks a phone's public Funnel address from outside the tailnet.
//   node plugin/tools/cloud-probe.js https://<phone>.<tailnet>.ts.net/mcp
// Sends no token and registers nothing that could be approved (the redirect it tries is refused).
// Dev tool only, not an MCP tool, no dependencies.

const CHECKS_TIMEOUT_MS = 15000; // network probe of our own phone, not an AI call

async function get(fetchImpl, url, init = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), CHECKS_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { redirect: "manual", ...init, signal: ctrl.signal });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text };
  } finally {
    clearTimeout(t);
  }
}

function json(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Runs every check; returns [{name, ok, detail}]. `url` is the MCP URL (…/mcp). */
async function probe(url, { fetchImpl = globalThis.fetch } = {}) {
  const u = new URL(url);
  if (u.pathname !== "/mcp") throw new Error("Give the MCP address, ending in /mcp");
  const origin = u.origin;
  const out = [];
  const check = (name, ok, detail = "") => out.push({ name, ok: !!ok, detail });

  const noToken = await get(fetchImpl, url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const www = noToken.headers.get("www-authenticate") || "";
  check("POST /mcp without a token is 401", noToken.status === 401, `status ${noToken.status}`);
  check("401 points at resource_metadata", /resource_metadata="https?:\/\/[^"]+"/.test(www), www);

  const prmPath = await get(fetchImpl, `${origin}/.well-known/oauth-protected-resource/mcp`);
  const prmRoot = await get(fetchImpl, `${origin}/.well-known/oauth-protected-resource`);
  const prm = json(prmPath.text);
  check("protected resource metadata parses", prmPath.status === 200 && prm, `status ${prmPath.status}`);
  check("both metadata paths agree", prmPath.text === prmRoot.text);
  check("resource is this URL", prm && prm.resource === url, prm && prm.resource);
  const issuer = prm && Array.isArray(prm.authorization_servers) ? prm.authorization_servers[0] : null;
  check("first authorization server is this origin", issuer === origin, issuer);

  const asRes = await get(fetchImpl, `${origin}/.well-known/oauth-authorization-server`);
  const as = json(asRes.text) || {};
  check("authorization server metadata parses", asRes.status === 200 && as.issuer, `status ${asRes.status}`);
  check("issuer matches the protected resource", as.issuer === issuer, as.issuer);
  check("PKCE S256 advertised", Array.isArray(as.code_challenge_methods_supported) && as.code_challenge_methods_supported.includes("S256"));
  const methods = as.token_endpoint_auth_methods_supported || [];
  check("public clients (claude.ai, ChatGPT CIMD)", methods.includes("none") && as.client_id_metadata_document_supported === true);
  check("secret clients (Copilot Studio DCR)", methods.includes("client_secret_basic") && methods.includes("client_secret_post"));
  check("registration endpoint (DCR)", as.registration_endpoint === `${origin}/oauth/register`, as.registration_endpoint);
  check("RFC 9207 iss advertised", as.authorization_response_iss_parameter_supported === true);

  for (const p of ["/", "/v1/health", "/v1/calls", "/v1/sessions", "/.well-known/openid-configuration", "/mcp/"]) {
    const r = await get(fetchImpl, origin + p);
    check(`${p} is 404 with an empty body`, r.status === 404 && r.text === "", `status ${r.status}`);
  }

  const reg = await get(fetchImpl, `${origin}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "cloud-probe", redirect_uris: ["https://probe.invalid/cb"], token_endpoint_auth_method: "none" }),
  });
  check("registration with a foreign redirect is refused", reg.status === 400 && (json(reg.text) || {}).error === "invalid_redirect_uri", `status ${reg.status}`);

  const getMcp = await get(fetchImpl, url);
  check("GET /mcp is 405", getMcp.status === 405, `status ${getMcp.status}`);
  return out;
}

async function main() {
  const url = process.argv[2];
  if (!url) {
    process.stderr.write("usage: node cloud-probe.js https://<phone>.<tailnet>.ts.net/mcp\n");
    process.exit(2);
  }
  let results;
  try {
    results = await probe(url);
  } catch (e) {
    process.stdout.write(`FAIL could not reach ${url}: ${e.message}\n`);
    process.exit(1);
  }
  for (const r of results) process.stdout.write(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok || !r.detail ? "" : ` (${r.detail})`}\n`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

if (require.main === module) main();

module.exports = { probe };
