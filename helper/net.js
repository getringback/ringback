"use strict";
// The machine side of the helper (spec 03 sections 4.4, 5.4): every joined helper is a machine. It
//  (a) in mode embedded supervises `ringback-net up` (restart backoff 1 s doubling to 60 s) and
//      keeps config phone.hosts[0] on the forward port net.json reports;
//  (b) reports PUT /v1/machine every 60 s;
//  (c) holds GET /v1/machine/control long-polls and acts on rename and remove.
// Starting new sessions (FOLLOWUPS 21) stays on the machine inbox (lib/starts.js), not here.
// A 401 "revoked" on any request is the same as a remove event. Outbound only; never logs a key.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");
const { loadConfig, updateRawConfig, configDir } = require("../lib/config.js");
const { api: clientApi } = require("../lib/client.js");

const VERSION = require("../.claude-plugin/plugin.json").version;
const REPORT_EVERY_MS = 60 * 1000;
const CONTROL_WAIT_S = 50;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60 * 1000;
const HEALTHY_RUN_MS = 60 * 1000;
const OLD_PHONE_RETRY_MS = 10 * 60 * 1000;
const OS_WIRE = { linux: "linux", darwin: "darwin", win32: "windows" };
const ARCH_WIRE = { x64: "amd64", arm64: "arm64" };

const stateDir = () => path.join(configDir(), "state");
const netStateFile = () => path.join(stateDir(), "net.json");
const cursorFile = () => path.join(stateDir(), "control_cursor");
const tsnetDir = () => path.join(configDir(), "tsnet");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readCursor() {
  try {
    const v = fs.readFileSync(cursorFile(), "utf8").trim();
    return /^\d+$/.test(v) ? v : "";
  } catch {
    return "";
  }
}

function writeCursor(v) {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(cursorFile(), String(v));
}

function mtimeMs(p) {
  try {
    return Math.floor(fs.statSync(p).mtimeMs);
  } catch {
    return 0;
  }
}

/** This machine's tailnet IPv4 from its interfaces (mode system), or "". */
function localTailnetIp(ifaces = os.networkInterfaces()) {
  for (const list of Object.values(ifaces || {})) {
    for (const a of list || []) {
      const v4 = a && (a.family === "IPv4" || a.family === 4);
      if (!v4 || a.internal) continue;
      const [x, y] = String(a.address).split(".").map(Number);
      if (x === 100 && (y & 0xc0) === 64) return a.address;
    }
  }
  return "";
}

function defaultFacts() {
  return {
    hostname: os.hostname().slice(0, 64),
    os: OS_WIRE[process.platform] || process.platform,
    arch: ARCH_WIRE[process.arch] || process.arch,
    tailnet_ip: localTailnetIp(),
  };
}

/** The ringback-net binary to run: the manifest version if present, else the newest one. */
function defaultNetBin() {
  const dir = path.join(configDir(), "bin");
  const manifest = readJson(path.join(__dirname, "..", "net-manifest.json"));
  const ext = process.platform === "win32" ? ".exe" : "";
  if (manifest && manifest.version) {
    const want = path.join(dir, `ringback-net-${manifest.version}${ext}`);
    if (fs.existsSync(want)) return want;
  }
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^ringback-net-[\w.-]+$/.test(n) && !n.endsWith(".tmp"));
  } catch {
    return "";
  }
  const newest = names.map((n) => path.join(dir, n)).sort((a, b) => mtimeMs(b) - mtimeMs(a))[0];
  return newest || "";
}

function defaultRunLogout(bin, args) {
  return new Promise((resolve) => execFile(bin, args, { windowsHide: true }, () => resolve()));
}

function defaultUninstall() {
  const service = require("../lib/service.js");
  return service.uninstall(service.hereOptions(), service.realExec({ print: () => {} }));
}

function defaultDeps() {
  return {
    api: clientApi,
    spawn: (cmd, args) => spawn(cmd, args, { stdio: "ignore", windowsHide: true }),
    netBin: defaultNetBin,
    runLogout: defaultRunLogout,
    uninstallService: defaultUninstall,
    exit: () => process.exit(0),
    log: () => {},
    now: () => Date.now(),
    facts: defaultFacts,
  };
}

const mode = (cfg) => (cfg.machine && cfg.machine.mode) || "paired";

function netArgs(cfg) {
  const m = cfg.machine || {};
  return [
    "up",
    "--phone",
    String(m.phone_tailnet || ""),
    ...(Number(m.forward_port) > 0 ? ["--forward-port", String(m.forward_port)] : []),
    "--dir",
    tsnetDir(),
    "--state",
    netStateFile(),
  ];
}

function reportBody(cfg, facts, netState) {
  const embedded = mode(cfg) === "embedded";
  const body = {
    hostname: facts.hostname,
    os: facts.os,
    arch: facts.arch,
    helper_version: VERSION,
    mode: mode(cfg),
  };
  if (embedded) {
    const st = netState || {};
    return {
      ...body,
      tailnet_ip: st.ip4 || "",
      key_expiry: Number(st.key_expiry) > 0 ? Number(st.key_expiry) : null,
      net_state: ["running", "needs_login", "stopped", "error"].includes(st.state) ? st.state : "stopped",
    };
  }
  return facts.tailnet_ip ? { ...body, tailnet_ip: facts.tailnet_ip } : body;
}

/** Without its key, phone and machine block: what a removed machine keeps of its config. */
const withoutMachine = ({ agent_token: _t, machine: _m, phone: _p, ...rest }) => rest;

/** The machine side of one helper. deps: see defaultDeps(). */
function createNet(overrides = {}) {
  const d = { ...defaultDeps(), ...overrides };
  const self = {
    stopped: false,
    removing: null,
    child: null,
    childStartedAt: 0,
    backoffMs: 0,
    nextStartAt: 0,
    cursor: readCursor(),
  };

  self.childExited = (code) => {
    const ranMs = d.now() - self.childStartedAt;
    self.child = null;
    if (self.stopped) return;
    self.backoffMs = ranMs >= HEALTHY_RUN_MS || !self.backoffMs ? BACKOFF_MIN_MS : Math.min(BACKOFF_MAX_MS, self.backoffMs * 2);
    self.nextStartAt = d.now() + self.backoffMs;
    d.log(`ringback-net exited (${code}); restart in ${self.backoffMs} ms`);
  };

  /** Start ringback-net when it should run and does not (mode embedded only). */
  self.supervise = () => {
    if (self.stopped || self.child) return;
    const cfg = loadConfig();
    if (mode(cfg) !== "embedded" || !cfg.machine.phone_tailnet || d.now() < self.nextStartAt) return;
    const bin = d.netBin();
    if (!bin) {
      d.log("ringback-net is not installed; add this computer to the phone again (join_this_machine or /ringback:join)");
      self.nextStartAt = d.now() + BACKOFF_MAX_MS;
      return;
    }
    self.childStartedAt = d.now();
    const child = d.spawn(bin, netArgs(cfg));
    self.child = child;
    if (child && typeof child.on === "function") {
      child.on("exit", (code) => self.child === child && self.childExited(code));
      child.on("error", () => self.child === child && self.childExited(-1));
    }
  };

  /** Keep phone.hosts[0] on the forward port ringback-net really listens on. */
  self.syncForward = () => {
    const st = readJson(netStateFile());
    const port = st && Number(st.forward_port);
    if (!port) return false;
    return updateRawConfig((raw) => {
      if (!raw.machine || raw.machine.mode !== "embedded" || !raw.phone) return null;
      const want = `127.0.0.1:${port}`;
      const hosts = Array.isArray(raw.phone.hosts) ? raw.phone.hosts : [];
      if (hosts[0] === want && Number(raw.machine.forward_port) === port) return null;
      const rest = hosts.filter((h) => !/^127\.0\.0\.1:\d+$/.test(String(h)));
      return { ...raw, phone: { ...raw.phone, hosts: [want, ...rest] }, machine: { ...raw.machine, forward_port: port } };
    });
  };

  self.stop = () => {
    self.stopped = true;
    if (self.child) {
      try {
        self.child.kill();
      } catch {
        // Already gone.
      }
    }
  };

  /** The phone removed this machine: log out, forget the key, drop the service, exit. */
  self.remove = () => {
    if (!self.removing) self.removing = doRemove();
    return self.removing;
  };

  async function doRemove() {
    const wasEmbedded = mode(loadConfig()) === "embedded";
    self.stop();
    d.log("removed on the phone; cleaning up");
    if (wasEmbedded) {
      const bin = d.netBin();
      if (bin) await Promise.resolve(d.runLogout(bin, ["logout", "--dir", tsnetDir()])).catch(() => {});
    }
    updateRawConfig((raw) => withoutMachine(raw));
    await Promise.resolve(d.uninstallService()).catch(() => {});
    d.exit();
  }

  /** Runs a phone request; a revoked key means removed. */
  async function guarded(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err && err.code === "revoked") {
        await self.remove();
        return null;
      }
      throw err;
    }
  }

  self.reportOnce = async () => {
    const cfg = loadConfig();
    if (!cfg.agent_token || self.stopped) return null;
    const body = reportBody(cfg, d.facts(), readJson(netStateFile()));
    return guarded(() => d.api.reportMachine(cfg, body));
  };

  async function onEvent(ev) {
    if (!ev || self.stopped) return;
    if (ev.type === "rename" && typeof ev.name === "string" && ev.name.trim()) {
      updateRawConfig((raw) => (raw.machine ? { ...raw, machine: { ...raw.machine, name: ev.name.trim().slice(0, 64) } } : null));
    } else if (ev.type === "remove") {
      await self.remove();
    } else if (ev.type === "announce" && typeof d.onAnnounce === "function") {
      // FOLLOWUPS item 50 app contract: the phone restarted and restores its list as "checking";
      // re-announce every live local session at once instead of waiting for the next heartbeat.
      try {
        d.onAnnounce(ev);
      } catch (err) {
        d.log(`announce: ${err.message}`);
      }
    } else if (ev.type === "avatar" && typeof d.onAvatar === "function") {
      // FOLLOWUPS item 45: their tap on "Make a picture". Runs next to the control loop (an AI run
      // takes a while); the helper tracks it and posts the pictures itself.
      try {
        d.onAvatar(ev);
      } catch (err) {
        d.log(`avatar: ${err.message}`);
      }
    }
  }

  /** One control long-poll and its events. A lower cursor than ours: the phone restarted. */
  self.controlOnce = async (waitS = CONTROL_WAIT_S) => {
    const cfg = loadConfig();
    if (!cfg.agent_token || self.stopped) return;
    const res = await guarded(() => d.api.control(cfg, self.cursor, waitS));
    if (!res || self.stopped) return;
    if (self.cursor && res.cursor !== undefined && Number(res.cursor) < Number(self.cursor)) {
      self.cursor = "";
      writeCursor("");
      return;
    }
    for (const ev of res.events || []) await onEvent(ev);
    if (res.cursor !== undefined && !self.stopped) {
      self.cursor = String(res.cursor);
      writeCursor(self.cursor);
    }
  };

  return self;
}

/**
 * Runs the machine side until stop(): supervision tick each second, a report every 60 s, and the
 * control long-poll loop with backoff on errors. Returns { net, done }.
 */
function runNet(overrides = {}) {
  const net = createNet(overrides);
  const log = overrides.log || (() => {});
  const tick = setInterval(() => {
    try {
      net.supervise();
      net.syncForward();
    } catch (err) {
      log(`net tick: ${err.message}`);
    }
  }, 1000);
  const reporter = setInterval(() => net.reportOnce().catch((err) => err.status !== 404 && log(`machine report: ${err.message}`)), REPORT_EVERY_MS);
  const stopNet = net.stop;
  net.stop = () => {
    stopNet();
    clearInterval(tick);
    clearInterval(reporter);
  };
  net.supervise();
  net.reportOnce().catch((err) => err.status !== 404 && log(`machine report: ${err.message}`));
  const done = (async () => {
    let backoff = 0;
    while (!net.stopped) {
      try {
        await net.controlOnce();
        backoff = 0;
      } catch (err) {
        // A phone without machine routes (an older app) answers 404: ask again much later.
        const old = err && err.status === 404;
        if (!old) log(`control: ${err.message}`);
        backoff = old ? OLD_PHONE_RETRY_MS : Math.min(BACKOFF_MAX_MS, backoff ? backoff * 2 : 2500);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    clearInterval(tick);
    clearInterval(reporter);
  })();
  return { net, done };
}

module.exports = { createNet, runNet, reportBody, localTailnetIp, netArgs, REPORT_EVERY_MS };
