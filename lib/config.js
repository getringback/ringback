"use strict";
// Ringback client config: ~/.ringback/config.json, written by pair.js.
// Shape: { phone: { name, port, hosts: [...], fp }, agent_token, machine?: {...}, ...options }
// (hosts may carry ":port", spec 03 section 4.5; ringback-join writes the machine block).
// Env RINGBACK_URL + RINGBACK_TOKEN override the phone (tests, plain http allowed).
// On a vast.ai machine no token is ever used (spec 03 section 8.1): unconfigured, blocked "vast".

const fs = require("fs");
const os = require("os");
const path = require("path");
const guard = require("./guard.js");

const DEFAULTS = Object.freeze({
  notify_on: ["permission_prompt", "idle_prompt"],
  ring_on_permission: false,
  voice_approvals: false,
  // A pending permission goes to the phone to allow or deny by a tap (PERMISSION TAP CONTRACT).
  tap_approvals: true,
  idle_notify_every_s: 600,
});

function configDir() {
  return process.env.RINGBACK_HOME || path.join(os.homedir(), ".ringback");
}

function configFile() {
  return path.join(configDir(), "config.json");
}

function readFileConfig(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new Error(`Ringback config at ${file} is not valid JSON: ${err.message}`);
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * The developer override (audit H5): RINGBACK_URL is honoured only with RINGBACK_TOKEN AND
 * RINGBACK_DEV=1, only for a loopback http:// address, and never with the config's real token
 * (a cloned repo's project env could otherwise send that token to any server in clear text).
 * Returns { url, token } or null.
 */
function devOverride(env = process.env) {
  const raw = String(env.RINGBACK_URL || "").trim();
  if (!raw || env.RINGBACK_DEV !== "1" || !env.RINGBACK_TOKEN) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" || !LOOPBACK.has(u.hostname)) return null;
  return { url: raw.replace(/\/+$/, ""), token: String(env.RINGBACK_TOKEN) };
}

function loadConfig() {
  const file = configFile();
  const fromFile = readFileConfig(file);
  const dev = devOverride();
  const envUrl = dev ? dev.url : "";
  if (guard.detectHere().vast) {
    const { agent_token: _never, ...rest } = fromFile;
    return Object.freeze({ ...DEFAULTS, ...rest, agent_token: "", url_override: "", phone: null, blocked: "vast", file });
  }
  // RINGBACK_TEST=1 (the wake reliability run and other test sessions): such a session may only
  // ever talk to a local fake phone (the developer override). Without one it is not configured at
  // all: it never registers, notifies, rings or shows on their real phone.
  if (process.env.RINGBACK_TEST === "1" && !dev) {
    const { agent_token: _never, ...rest } = fromFile;
    return Object.freeze({ ...DEFAULTS, ...rest, agent_token: "", url_override: "", phone: null, blocked: "test", file });
  }
  return Object.freeze({
    ...DEFAULTS,
    ...fromFile,
    // With the dev override only its own token; never the paired phone's token to another server.
    agent_token: dev ? dev.token : fromFile.agent_token || "",
    url_override: envUrl,
    phone: fromFile.phone || null,
    file,
  });
}

function isConfigured(cfg) {
  const hasPhone = Boolean(cfg.phone && Array.isArray(cfg.phone.hosts) && cfg.phone.hosts.length && cfg.phone.fp);
  return Boolean(cfg.agent_token && (cfg.url_override || hasPhone));
}

function saveConfig(next) {
  fs.mkdirSync(configDir(), { recursive: true });
  const { file, url_override, ...rest } = next;
  fs.writeFileSync(configFile(), JSON.stringify(rest, null, 2), { mode: 0o600 });
}

/**
 * Rewrite the config file itself (no defaults, no env): `fn(raw)` returns the new object, or
 * null to leave the file alone. Atomic, 0600 in a 0700 dir. Returns true when written.
 */
function updateRawConfig(fn) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(configFile(), "utf8")) || {};
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const next = fn(raw);
  if (!next) return false;
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const tmp = `${configFile()}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, configFile());
  return true;
}

function projectName() {
  // A client without a project folder (the Claude Desktop chat) names itself (bin/ringback-install.js).
  const named = String(process.env.RINGBACK_PROJECT || "").trim();
  if (named) return named.slice(0, 120);
  const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return path.basename(dir) || "home";
}

module.exports = { devOverride, loadConfig, isConfigured, saveConfig, updateRawConfig, configDir, configFile, projectName, DEFAULTS };
