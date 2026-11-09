"use strict";
// Masks likely secrets in terminal text before it leaves the machine (spec 04 section 5.3, T5).
// Patterns are deliberately specific (prefix + enough characters) so ordinary code and paths
// pass unchanged.

const MASK = "[redacted]";

// [regex, replacer]. Order matters: PEM blocks and key=value pairs before the token shapes.
const RULES = [
  // PEM private key blocks, complete or cut off at the end of the text.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, () => `-----BEGIN PRIVATE KEY----- ${MASK}`],
  // ENV_STYLE_SECRET=value or ENV_STYLE_SECRET: value (upper-case names only, so code like
  // `primaryKey = id` is untouched).
  [/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*)(\s*[=:]\s*)(["']?)([^\s"']{4,})\3/g, (_, name, sep, q) => `${name}${sep}${q}${MASK}${q}`],
  // "api_key": "value" style JSON / YAML with a quoted value.
  [/(["']?)\b(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password)\1(\s*[:=]\s*)(["'])([^"'\s]{6,})\4/gi, (_, q1, name, sep, q) => `${q1}${name}${q1}${sep}${q}${MASK}${q}`],
  // password=hunter2 / passwd: x / pwd=... unquoted, any case (FOLLOWUPS item 58).
  [/\b(password|passwd|pwd)(\s*[=:]\s*)(?!\[redacted\])([^\s"'`,;]{4,})/gi, (_, name, sep) => `${name}${sep}${MASK}`],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, () => `Bearer ${MASK}`],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, () => `sk-ant-${MASK}`],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, () => `sk-${MASK}`],
  [/\brb(?:k|p|ca|cr|cc|cd|cs)_[A-Za-z0-9_-]{8,}/g, (m) => `${m.slice(0, m.indexOf("_") + 1)}${MASK}`],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, () => `github_pat_${MASK}`],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, (m) => `${m.slice(0, 4)}${MASK}`],
  [/\bAKIA[0-9A-Z]{16}\b/g, () => `AKIA${MASK}`],
  // Tailscale auth keys and OAuth client secrets (audit G9).
  [/\btskey-(?:client-|auth-|api-)?[A-Za-z0-9_-]{8,}/g, () => `tskey-${MASK}`],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, (m) => `${m.slice(0, 5)}${MASK}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, () => `eyJ${MASK}`],
];

function redact(text) {
  let out = String(text == null ? "" : text);
  for (const [re, fn] of RULES) out = out.replace(re, fn);
  return out;
}

module.exports = { redact, MASK };
