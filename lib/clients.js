"use strict";
// The agent clients Ringback runs in (FOLLOWUPS item 20). Claude Code has the full plugin (hooks
// and MCP). Codex and Antigravity (agy) get the MCP server plus hook adapters
// (hooks/client-hook.js), so their sessions show on the phone and can be called; an idle one is
// woken in its own window (lib/visible-wake.js), never answered by a hidden run (item 57). The
// Claude Desktop chat has no hooks: it can call out but cannot be called.
// The MCP server learns its client from RINGBACK_CLIENT, which the installer writes into each
// client's MCP entry (bin/ringback-install.js).

const fs = require("fs");
const os = require("os");
const path = require("path");

const CLAUDE_CODE = "claude-code";
const LABELS = Object.freeze({
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  codex: "Codex",
  agy: "Antigravity",
});
// Clients whose sessions register on the phone (they have hooks).
const WITH_SESSIONS = Object.freeze(["claude-code", "codex", "agy"]);

const known = (id) => Object.prototype.hasOwnProperty.call(LABELS, id);

/** The client this process serves: RINGBACK_CLIENT when known, else Claude Code. */
function currentClient(env = process.env) {
  const id = String(env.RINGBACK_CLIENT || "").trim();
  return known(id) ? id : CLAUDE_CODE;
}

/** The client a stored session belongs to (records from before item 20 are Claude Code). */
const clientOf = (rec) => (rec && known(rec.client) ? rec.client : CLAUDE_CODE);

const labelOf = (id) => LABELS[id] || LABELS[CLAUDE_CODE];

const hasSessions = (id) => WITH_SESSIONS.includes(id);

function fromList(value) {
  return Array.isArray(value) && value.length ? value.map(String) : null;
}

/**
 * The Codex command as an argv prefix. The npm install is a .cmd shim on Windows, which Node can
 * only start through a shell (and the prompt is speech from the phone: never through a shell), so
 * its codex.js runs under this node instead.
 */
function codexCommand(cfg = {}, env = process.env, exists = fs.existsSync) {
  const set = fromList(cfg.codex_command);
  if (set) return set;
  if (process.platform === "win32" || env.RINGBACK_FORCE_WIN === "1") {
    const appdata = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    const js = path.join(appdata, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
    if (exists(js)) return [process.execPath, js];
  }
  return ["codex"];
}

function agyCommand(cfg = {}, env = process.env, exists = fs.existsSync) {
  const set = fromList(cfg.agy_command);
  if (set) return set;
  if (process.platform === "win32" || env.RINGBACK_FORCE_WIN === "1") {
    const local = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const exe = path.join(local, "agy", "bin", "agy.exe");
    if (exists(exe)) return [exe];
  }
  return ["agy"];
}

/**
 * The final text of `claude -p --output-format json`: one result object, or (with verbose output,
 * seen on Claude Code 2.1.319) an array of events whose last "result" event holds it. null when
 * stdout is not JSON.
 */
function claudeResult(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || "").trim());
  } catch {
    return null;
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const last = [...list].reverse().find((e) => e && typeof e.result === "string");
  return last ? last.result : "";
}

module.exports = {
  claudeResult,
  CLAUDE_CODE,
  LABELS,
  currentClient,
  clientOf,
  labelOf,
  hasSessions,
  codexCommand,
  agyCommand,
};
