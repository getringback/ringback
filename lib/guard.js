"use strict";
// THE single guard (spec 03 section 8, BUILD_PLAN A7): vast.ai machines and machines with a
// never-join marker never get a Ringback key. Same rules and vectors as tsnet/internal/guard and
// join/ringback-join.sh (tsnet/testdata/guard-cases.json). Signals are names only, never values,
// in this fixed order, each at most once.
// Later steps add isDexBox() and streamsAllowed(cfg) here, not in a second file.

const fs = require("fs");
const os = require("os");

const VAST_REFUSAL = "Ringback never runs on vast.ai machines: no keys or secrets may live there.";
const NEVER_JOIN_REFUSAL =
  "This machine has a Ringback never-join marker (/etc/ringback/never-join or ~/.ringback/never-join), so it cannot join.";

const VAST_PORT = /^VAST_(TCP|UDP)_PORT_\d+$/;
const ETC_ENV_LINE = /^(VAST_CONTAINERLABEL=|CONTAINER_API_KEY=|VAST_TCP_PORT_)/;
const PROC1_MARK = /(VAST_CONTAINERLABEL=|CONTAINER_API_KEY=)/;
const CGROUP_MARK = /docker|containerd|kubepods/;
const VAST_HOSTNAME = /^C\.\d+$/;

/** A path under the home dir with the home dir's own separator ("/" or "\"). */
function underHome(home, rel) {
  const sep = String(home).includes("\\") && !String(home).includes("/") ? "\\" : "/";
  return `${String(home).replace(/[\\/]+$/, "")}${sep}${rel.split("/").join(sep)}`;
}

/** Contents of a file, or null when missing or unreadable (never throws). */
function safeRead(read, p) {
  try {
    const v = read(p);
    return v === null || v === undefined ? null : String(v);
  } catch {
    return null;
  }
}

function safeExists(exists, p) {
  try {
    return Boolean(exists(p));
  } catch {
    return false;
  }
}

function envSignals(env) {
  const keys = Object.keys(env || {});
  const has = (k) => Object.prototype.hasOwnProperty.call(env || {}, k);
  const out = [];
  if (has("VAST_CONTAINERLABEL")) out.push("env_vast_containerlabel");
  if (has("CONTAINER_API_KEY")) out.push("env_container_api_key");
  if (keys.some((k) => VAST_PORT.test(k))) out.push("env_vast_port");
  if (has("CONTAINER_ID") && has("PUBLIC_IPADDR")) out.push("env_container_id_public_ip");
  return out;
}

function fileSignals({ exists, read, home }) {
  const out = [];
  const etc = safeRead(read, "/etc/environment");
  if (etc && etc.split(/\r?\n/).some((l) => ETC_ENV_LINE.test(l))) out.push("etc_environment");
  const proc1 = safeRead(read, "/proc/1/environ");
  if (proc1 && PROC1_MARK.test(proc1)) out.push("proc1_environ");
  if (safeExists(exists, underHome(home, ".vast_api_key")) || safeExists(exists, "/root/.vast_api_key")) {
    out.push("vast_api_key_file");
  }
  return out;
}

/**
 * Pure detection. `env` the environment, `exists(path)` / `read(path)` the filesystem, `home` the
 * home dir, `hostname` this machine's name. Returns { vast, never_join, container, signals }.
 */
function detect({ env = {}, exists = () => false, read = () => null, home = "", hostname = "" } = {}) {
  const signals = [...envSignals(env), ...fileSignals({ exists, read, home })];
  if (VAST_HOSTNAME.test(String(hostname || ""))) signals.push("hostname");
  const vast = signals.length > 0;
  const neverJoin =
    safeExists(exists, "/etc/ringback/never-join") || safeExists(exists, underHome(home, ".ringback/never-join"));
  if (neverJoin) signals.push("never_join_marker");
  const cgroup = safeRead(read, "/proc/1/cgroup");
  const container = safeExists(exists, "/.dockerenv") || Boolean(cgroup && CGROUP_MARK.test(cgroup));
  return { vast, never_join: neverJoin, container, signals };
}

/** detect() on this machine, with the real environment and filesystem. */
function detectHere({ env = process.env, home = os.homedir(), hostname = os.hostname() } = {}) {
  return detect({
    env,
    exists: (p) => fs.existsSync(p),
    read: (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null),
    home,
    hostname,
  });
}

/** The refusal line for a guard result, or "" when the machine may join. */
function refusal(g) {
  if (g && g.vast) return VAST_REFUSAL;
  if (g && g.never_join) return NEVER_JOIN_REFUSAL;
  return "";
}

module.exports = { detect, detectHere, refusal, VAST_REFUSAL, NEVER_JOIN_REFUSAL };
