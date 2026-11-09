"use strict";
// FOLLOWUPS item 49: view_image never asks for permission. The user sent the
// picture; that is the consent. take_photo keeps asking by voice. This pre-approves view_image in
// each client's own settings, once, and touches nothing else in those files:
//   Claude Code: "mcp__plugin_ringback_ringback__view_image" in permissions.allow of
//                ~/.claude/settings.json (inserted as text: every other byte stays as it was)
//   Codex:       [mcp_servers.ringback.tools.view_image] approval_mode = "approve" in config.toml
//                (only when the ringback server is installed there)
//   agy:         "mcp(ringback/view_image)" in permissions.allow of ~/.gemini/antigravity-cli/settings.json
// Each write backs the file up first (<file>.bak-ringback-<stamp>) and is atomic. Background
// answer runs already pre-approve it (lib/allowed-tools.js).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { SERVER_PREFIX } = require("./allowed-tools.js");

const TOOL = "view_image";
const CLAUDE_RULE = `${SERVER_PREFIX}${TOOL}`;
const AGY_RULE = `mcp(ringback/${TOOL})`;

const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);

function parse(text) {
  try {
    const v = JSON.parse(text);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

/** The index just after the `{` that opens the value of key `key`, searching from `from`. */
function objectOpenAfter(text, key, from = 0) {
  const re = new RegExp(`"${key}"\\s*:\\s*\\{`, "g");
  re.lastIndex = from;
  const m = re.exec(text);
  return m ? m.index + m[0].length : -1;
}

/** The indentation of the first non-blank line after `at`, or `fallback`. */
function indentAfter(text, at, fallback) {
  const m = text.slice(at).match(/\r?\n([ \t]*)\S/);
  return m ? m[1] : fallback;
}

/**
 * `text` (a JSON settings file) with `rule` added to permissions.allow, every other byte kept.
 * Returns { text, changed }. Unparseable JSON, or an insert that would not give exactly the old
 * settings plus this one rule, leaves the file alone ({ changed: false, skipped: reason }).
 */
function addAllowRule(text, rule) {
  const src = String(text || "");
  const before = src.trim() ? parse(src) : {};
  if (!before) return { text: src, changed: false, skipped: "not valid JSON" };
  const perms = before.permissions;
  if (isObject(perms) && Array.isArray(perms.allow) && perms.allow.includes(rule)) return { text: src, changed: false };
  if (perms !== undefined && !isObject(perms)) return { text: src, changed: false, skipped: "permissions is not an object" };
  if (isObject(perms) && perms.allow !== undefined && !Array.isArray(perms.allow)) return { text: src, changed: false, skipped: "permissions.allow is not a list" };
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  const quoted = JSON.stringify(rule);
  let next;
  if (!src.trim()) {
    next = `{${eol}  "permissions": {${eol}    "allow": [${eol}      ${quoted}${eol}    ]${eol}  }${eol}}${eol}`;
  } else if (isObject(perms) && Array.isArray(perms.allow)) {
    const open = objectOpenAfter(src, "permissions");
    const m = open < 0 ? null : /"allow"\s*:\s*\[/.exec(src.slice(open));
    if (!m) return { text: src, changed: false, skipped: "permissions.allow not found" };
    const at = open + m.index + m[0].length;
    const empty = /^\s*\]/.test(src.slice(at));
    const ind = indentAfter(src, at, "      ");
    // The new rule goes first, on its own line with the list's indentation.
    next = empty ? `${src.slice(0, at)}${quoted}${src.slice(at)}` : `${src.slice(0, at)}${eol}${ind}${quoted},${eol}${ind}${src.slice(at).replace(/^\s*/, "")}`;
  } else if (isObject(perms)) {
    const at = objectOpenAfter(src, "permissions");
    if (at < 0) return { text: src, changed: false, skipped: "permissions not found" };
    const ind = indentAfter(src, at, "    ");
    const rest = src.slice(at);
    const hasKeys = !/^\s*\}/.test(rest);
    next = `${src.slice(0, at)}${eol}${ind}"allow": [${quoted}]${hasKeys ? "," : ""}${hasKeys ? `${eol}${ind}${rest.replace(/^\s*/, "")}` : rest}`;
  } else {
    const at = src.indexOf("{") + 1;
    const ind = indentAfter(src, at, "  ");
    const rest = src.slice(at);
    const hasKeys = !/^\s*\}/.test(rest);
    next = `${src.slice(0, at)}${eol}${ind}"permissions": { "allow": [${quoted}] }${hasKeys ? "," : ""}${hasKeys ? `${eol}${ind}${rest.replace(/^\s*/, "")}` : rest}`;
  }
  // The result must be exactly the old settings plus this one rule.
  const after = parse(next);
  const want = { ...before, permissions: { ...(isObject(perms) ? perms : {}), allow: [rule, ...((isObject(perms) && perms.allow) || [])] } };
  if (!after || JSON.stringify(sortKeys(after)) !== JSON.stringify(sortKeys(want))) return { text: src, changed: false, skipped: "could not insert safely" };
  return { text: next, changed: true };
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (!isObject(v)) return v;
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
}

const CODEX_SERVER = /^\s*\[\s*mcp_servers\s*\.\s*(?:ringback|"ringback")\s*\]\s*(#.*)?$/m;
const CODEX_TOOL = /^\s*\[\s*mcp_servers\s*\.\s*(?:ringback|"ringback")\s*\.\s*tools\s*\.\s*(?:view_image|"view_image")\s*\]\s*(#.*)?$/m;

const CODEX_OTHER_TOOLS = /^\s*\[\s*mcp_servers\s*\.\s*(?:ringback|"ringback")\s*\.\s*tools\s*\]|^\s*mcp_servers\s*\.\s*(?:ringback|"ringback")\s*\.\s*tools\s*[.=]/m;

/** True when the [mcp_servers.ringback] table itself has a tools key (inline or dotted). */
function inlineTools(src) {
  let inside = false;
  for (const line of src.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) inside = CODEX_SERVER.test(line);
    else if (inside && /^\s*(tools|"tools")\s*[.=]/.test(line)) return true;
  }
  return false;
}

/** config.toml with view_image approved for the ringback server (appended; nothing else changes). */
function addCodexApproval(text) {
  const src = String(text || "");
  if (!CODEX_SERVER.test(src)) return { text: src, changed: false, skipped: "ringback is not installed in Codex" };
  if (CODEX_TOOL.test(src)) return { text: src, changed: false };
  // Tools defined another way (an inline tools table, a [..ringback.tools] table, dotted keys):
  // appending a table could declare view_image twice, so the file is left alone.
  if (CODEX_OTHER_TOOLS.test(src) || inlineTools(src)) return { text: src, changed: false, skipped: "ringback tools are defined another way" };
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  const sep = src.endsWith("\n") ? "" : eol;
  const block = `${eol}# Ringback: view_image never asks (FOLLOWUPS item 49).${eol}[mcp_servers.ringback.tools.view_image]${eol}approval_mode = "approve"${eol}`;
  return { text: `${src}${sep}${block}`, changed: true };
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");

/** Applies `merge` to `file` when it changes it: backup first, then an atomic write. */
function applyToFile(file, merge, deps = {}) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") return { file, changed: false, skipped: err.message };
    if (!deps.create) return { file, changed: false, skipped: "no such file" };
  }
  const res = merge(text);
  if (!res.changed) return { file, ...res, text: undefined };
  let backup = null;
  if (fs.existsSync(file)) {
    backup = `${file}.bak-ringback-${deps.stamp || stamp()}`;
    fs.copyFileSync(file, backup);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, res.text);
  fs.renameSync(tmp, file);
  return { file, changed: true, backup };
}

const claudeSettings = (home = os.homedir(), env = process.env) => path.join(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "settings.json");
const codexConfig = (home = os.homedir(), env = process.env) => path.join(env.CODEX_HOME || path.join(home, ".codex"), "config.toml");
const agySettings = (home = os.homedir()) => path.join(home, ".gemini", "antigravity-cli", "settings.json");

/** Pre-approves view_image for `client` ("claude-code", "codex" or "agy"). Never throws. */
function ensureViewImageApproved(client, deps = {}) {
  const home = deps.home || os.homedir();
  const env = deps.env || process.env;
  try {
    if (client === "codex") return applyToFile(codexConfig(home, env), addCodexApproval, deps);
    if (client === "agy") return applyToFile(agySettings(home), (t) => addAllowRule(t, AGY_RULE), deps);
    return applyToFile(claudeSettings(home, env), (t) => addAllowRule(t, CLAUDE_RULE), { ...deps, create: true });
  } catch (err) {
    return { changed: false, skipped: err.message };
  }
}

module.exports = { CLAUDE_RULE, AGY_RULE, addAllowRule, addCodexApproval, applyToFile, ensureViewImageApproved, claudeSettings, codexConfig, agySettings };
