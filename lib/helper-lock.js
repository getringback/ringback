"use strict";
// Single-instance lock for the Ringback helper: ~/.ringback/state/helper.lock = {pid, version}.
// A lock whose pid is gone is stale. A running helper of another version is replaced: the new one
// takes the lock and the old one exits when it sees the lock is no longer its own.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { configDir } = require("./config.js");

const VERSION = require("../.claude-plugin/plugin.json").version;
/** true when version a is strictly newer than b (dotted numbers, missing parts count as 0). */
function newer(a, b) {
  const pa = String(a || "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

const lockFile = () => path.join(configDir(), "state", "helper.lock");

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function readLock() {
  try {
    const v = JSON.parse(fs.readFileSync(lockFile(), "utf8"));
    return v && Number.isInteger(v.pid) ? v : null;
  } catch {
    return null;
  }
}

/** The running helper's lock, or null when none is alive. */
function runningHelper() {
  const lock = readLock();
  return lock && alive(lock.pid) ? lock : null;
}

/**
 * Take the lock for `pid`. Fails when another live helper of the same version holds it, unless
 * `takeover` (a newer version replacing an older one).
 */
function acquire(pid = process.pid, version = VERSION, takeover = false) {
  fs.mkdirSync(path.dirname(lockFile()), { recursive: true });
  const body = JSON.stringify({ pid, version, started_at: Date.now() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockFile(), body, { flag: "wx" });
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const held = readLock();
      if (held && held.pid === pid) return true;
      // Only a strictly newer version takes over: an older session's hooks (old plugin cache)
      // must not replace a newer helper, or the two would keep replacing each other.
      if (held && alive(held.pid) && !(takeover && newer(version, held.version))) return false;
      fs.rmSync(lockFile(), { force: true });
    }
  }
  return false;
}

const ownsLock = (pid = process.pid) => {
  const held = readLock();
  return Boolean(held && held.pid === pid);
};

function release(pid = process.pid) {
  if (ownsLock(pid)) fs.rmSync(lockFile(), { force: true });
}

/** Start the helper detached unless the current version already runs. Never throws. */
function ensureHelper(deps = { spawn, execPath: process.execPath }) {
  if (process.env.RINGBACK_NO_HELPER === "1") return false;
  // Session registration reaches here even when the helper already runs.
  // Refresh before the version check so every new Claude Code session repairs client paths.
  let stable;
  const onError = (err) => require("../hooks/common.js").logError("install refresh", err);
  try {
    stable = (deps.refreshInstall || require("./install.js").refreshInstall)({ onError, prune: false });
  } catch (err) {
    onError(err);
  }
  const running = runningHelper();
  if (running && !newer(VERSION, running.version)) return false;
  const script = path.join(stable || path.join(__dirname, ".."), "helper", "ringback-helper.js");
  const args = [script, ...(running ? ["--takeover"] : [])];
  const child = deps.spawn(deps.execPath, args, { detached: true, stdio: "ignore", windowsHide: true, env: helperEnv(process.env) });
  if (child && typeof child.unref === "function") child.unref();
  return true;
}

/**
 * The helper must not look like it runs inside a Claude Code session (it starts new ones). Every
 * marker Claude Code sets in the processes it spawns is dropped (docs: code.claude.com/docs/en/env-vars):
 * an inherited CLAUDE_CODE_CHILD_SESSION makes a new interactive claude skip saving its transcript
 * (FOLLOWUPS item 50g). Auth and provider settings (CLAUDE_CODE_USE_*, tokens) stay.
 */
function helperEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) if (!isSessionMarker(k)) out[k] = v;
  return out;
}

// RINGBACK_HELPER_RUN too: a helper started from a background run must not mark its own lines as background.
const SESSION_MARKERS = Object.freeze([
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_JOB_DIR",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_ENV_FILE",
  "CLAUDE_PLUGIN_ROOT",
  "CLAUDE_PLUGIN_DATA",
  "RINGBACK_HELPER_RUN",
]);
// Per-session values Claude Code exports (session id, attended flag, inbox socket and token).
const SESSION_PREFIXES = Object.freeze(["CLAUDE_CODE_SESSION_", "CLAUDE_CODE_MESSAGING_"]);

/** True for an environment variable that marks "inside a Claude Code session" (any case, Windows). */
function isSessionMarker(name) {
  const k = String(name).toUpperCase();
  return SESSION_MARKERS.includes(k) || SESSION_PREFIXES.some((p) => k.startsWith(p));
}

/** Drops the session markers from this process's own environment (the helper at start). */
function scrubOwnEnv(env = process.env) {
  for (const k of Object.keys(env)) if (isSessionMarker(k)) delete env[k];
  return env;
}

module.exports = {
  VERSION,
  newer,
  lockFile,
  alive,
  readLock,
  runningHelper,
  acquire,
  ownsLock,
  release,
  ensureHelper,
  helperEnv,
  isSessionMarker,
  scrubOwnEnv,
  SESSION_MARKERS,
};
