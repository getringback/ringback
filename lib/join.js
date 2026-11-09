"use strict";
// The whole join client (spec 03 sections 3.2, 4.4, 4.5, 7; contract "Join code string" and
// "Machine side files"): guard, environment, reachability and mode, built-in Tailscale when
// needed, the rbj1 protocol, config write, plugin (optional, from ringback-join), helper service,
// health check. Every effect goes through `deps`, so tests run with fakes only.
// Exit codes (spec 7.3): 0 joined, 1 refused/denied/expired, 2 environment problem, 3 network.

const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const { spawn, exec } = require("child_process");
const guard = require("./guard.js");
const jc = require("./joincrypto.js");
const { configDir, configFile } = require("./config.js");
const { api: clientApi, normFp } = require("./client.js");

const VERSION = require("../.claude-plugin/plugin.json").version;
const PROBE_MS = 1500;
const NET_POLL_MS = 1000;
const POLL_WAIT_S = 50;
const POLL_RETRY_MS = 3000;
const HEALTH_TRIES = 10;
const HEALTH_EVERY_MS = 3000;
const KEY_EXPIRY_URL = "https://login.tailscale.com/admin/machines";

const OS_WIRE = { linux: "linux", darwin: "darwin", win32: "windows" };
const OS_LABEL = { linux: "Linux", darwin: "macOS", win32: "Windows" };
const ARCH_WIRE = { x64: "amd64", arm64: "arm64" };

const LINES = {
  notTailscale: "This machine is not on Tailscale yet. Starting the built-in Tailscale.",
  waiting: "Waiting for sign-in...",
  denied: "The phone said no.",
  expired: "The code expired. Make a new one in the app.",
  used: "That code was already used. Make a new one in the app.",
  noCode: "The phone has no join code open right now. Make a new one in the app.",
  notProven: "The phone's answer did not prove it knows the join code, so nothing was saved. Make a new code and try again.",
  gone: "The phone no longer knows this join. Make a new code in the app.",
  installed: "Installed the Ringback plugin for Claude Code (user scope) and the helper service.",
  installedService: "Installed the helper service.",
  mismatch: "That is not the code this computer expects, so this is not your phone (or not this join). Nothing was saved; tap Deny on your phone if it asks.",
  noConfirm: "Nobody confirmed the code from the phone, so nothing was saved. Make a new code on your own phone to try again.",
};

class JoinExit extends Error {
  constructor(code, line) {
    super(line);
    this.exitCode = code;
  }
}
const fail = (code, line) => {
  throw new JoinExit(code, line);
};

const { isIPv4, isCgnat } = jc;
/** A tailnet address in a join code: 100.64/10 or a MagicDNS name (parseCode allows only those). */
const isTailnetHost = (h) => isCgnat(h) || !isIPv4(h);
const uniq = (list) => [...new Set(list.filter(Boolean).map(String))];

function versionAtLeast(v, major) {
  return Number(String(v || "0").split(".")[0]) >= major;
}

/** Check this machine: guard first (before any network or disk write), then node and claude. */
async function checkMachine(opts, d) {
  const g = d.guard();
  const refused = guard.refusal(g);
  if (refused) fail(1, refused);
  if (!versionAtLeast(d.nodeVersion, 18)) fail(2, `Ringback needs Node 18 or newer (this machine has ${d.nodeVersion}).`);
  if (!OS_WIRE[d.platform] || !ARCH_WIRE[d.arch]) fail(2, `Ringback does not support this machine yet (${d.platform}/${d.arch}).`);
  if (!opts.noPlugin && !(await d.hasClaude())) {
    fail(2, "The claude command was not found. Install Claude Code first, then run this again (or pass --no-plugin).");
  }
  return g;
}

/**
 * A tailnet host as an address to dial: an IP as it is; a MagicDNS name only when every address
 * it resolves to is in 100.64/10 (audit C2: a name never leads outside the user's tailnet). The
 * resolved address is dialled, so a later DNS answer cannot move the join elsewhere.
 */
async function tailnetAddress(h, d) {
  if (isIPv4(h)) return isCgnat(h) ? h : "";
  let addrs = [];
  try {
    addrs = (await d.resolve(h)) || [];
  } catch {
    return "";
  }
  return addrs.length && addrs.every(isCgnat) ? addrs[0] : "";
}

/** Mode and target from a reachability probe of the code's hosts (tailnet first, then LAN). */
async function chooseMode(code, d) {
  const tailnet = code.hosts.filter(isTailnetHost);
  const lan = code.hosts.filter((h) => !isTailnetHost(h));
  for (const name of tailnet) {
    const h = await tailnetAddress(name, d);
    if (h && (await d.probe(h, code.port, PROBE_MS))) return { mode: "system", target: { host: h, port: code.port } };
  }
  for (const h of lan) if (await d.probe(h, code.port, PROBE_MS)) return { mode: "lan", target: { host: h, port: code.port } };
  if (!tailnet.length) {
    fail(3, `Cannot reach the phone at ${code.hosts.join(", ")}. Is it on the same Wi-Fi, with Ringback open?`);
  }
  return { mode: "embedded", target: null };
}

const phoneTailnetHost = (hosts) => hosts.find(isCgnat) || hosts.find(isTailnetHost) || "";

/** Starts ringback-net for the sign-in and waits until it runs. No timeout: the human signs in. */
async function startEmbedded(code, d, ctx) {
  d.out(LINES.notTailscale);
  let bin;
  try {
    bin = await d.ensureNet();
  } catch (err) {
    fail(3, `Could not get the built-in Tailscale: ${err.message}`);
  }
  const home = configDir();
  const args = ["up", "--phone", `${phoneTailnetHost(code.hosts)}:${code.port}`, "--dir", path.join(home, "tsnet"), "--state", path.join(home, "state", "net.json")];
  const startedAt = Date.now();
  ctx.net = d.spawnNet(bin, args);
  let waitingShown = false;
  for (;;) {
    if (ctx.net.exited !== null && ctx.net.exited !== undefined) {
      fail(3, `The built-in Tailscale stopped before sign-in finished (exit ${ctx.net.exited}).`);
    }
    const st = d.readNetState();
    const ours = st && (st.pid ? st.pid === ctx.net.pid : Number(st.updated_at) >= startedAt);
    if (ours && st.state === "running" && st.ip4 && Number(st.forward_port) > 0) {
      d.out(`Signed in as ${st.short_name || String(st.dns_name || "").split(".")[0] || d.hostname} (${st.ip4}).`);
      return st;
    }
    if (ours && st.state === "needs_login" && !waitingShown) {
      d.out(LINES.waiting);
      waitingShown = true;
    }
    await d.sleep(NET_POLL_MS);
  }
}

function machineBody(d, mode) {
  return {
    hostname: String(d.hostname || "machine").slice(0, 64),
    os: OS_WIRE[d.platform],
    arch: ARCH_WIRE[d.arch],
    user: String(d.user || "").slice(0, 64),
    mode,
    join_version: VERSION,
    helper_version: VERSION,
    // This computer's lasting identity, so the phone can block it under any name (app 26ffd87).
    machine_key: (d.machineKey || require("./machine-key.js").machineKey)(),
  };
}

function refusedLine(status, body) {
  const b = body || {};
  if (status === 401) {
    const left = Number.isInteger(b.attempts_left) ? ` (${b.attempts_left} tries left)` : "";
    return `That join code is wrong${left}. Check it, or make a new one in the app.`;
  }
  if (status === 410) return b.status === "used" ? LINES.used : b.status === "no_code" ? LINES.noCode : LINES.expired;
  if (status === 403) {
    if (b.reason === "vast") return guard.VAST_REFUSAL;
    if (b.reason === "never_join") return guard.NEVER_JOIN_REFUSAL;
    if (b.reason === "tailnet_off") return "Tailscale is off in the Ringback app. Turn it on and make a new code.";
    if (b.reason === "not_tailnet") return "The phone accepts this join only over Tailscale.";
  }
  if (status === 429) return b.detail || "Too many join attempts. Wait a minute.";
  return `The phone refused the join${b.detail ? `: ${b.detail}` : ` (HTTP ${status})`}.`;
}

/** POST /v1/join; returns the proven pending join or exits. */
async function startJoin(code, target, mode, g, d) {
  const nonce = jc.newNonce();
  const machine = machineBody(d, mode);
  const body = {
    v: 1,
    client_nonce: nonce,
    client_mac: jc.clientMac(code.secret, nonce, machine),
    machine,
    guard: { vast: Boolean(g.vast), container: Boolean(g.container), never_join: Boolean(g.never_join), signals: [...(g.signals || [])] },
  };
  let r;
  try {
    r = await d.api.joinStart(target, body);
  } catch (err) {
    fail(3, `Cannot reach the phone: ${err.code || err.message}`);
  }
  if (r.status !== 202) fail(1, refusedLine(r.status, r.body));
  const p = r.body || {};
  const fp = normFp(r.fp);
  const proven =
    fp.length === 64 &&
    normFp(p.fp) === fp &&
    typeof p.join_id === "string" &&
    typeof p.server_nonce === "string" &&
    jc.verifyServerMac(code.secret, nonce, p.server_nonce, p.join_id, fp, p.server_mac);
  if (!proven) fail(1, LINES.notProven);
  return { joinId: p.join_id, fp, match: jc.matchCode(code.secret, nonce, p.server_nonce), expiresAt: Number(p.expires_at) || 0 };
}

/** Long-polls the decision on the pinned socket. Returns the approved body or exits. */
async function pollDecision(auth, target, pending, d) {
  const pinned = { ...target, fp: pending.fp };
  const giveUpAt = (pending.expiresAt || Date.now() + 11 * 60 * 1000) + 60 * 1000;
  for (;;) {
    let r;
    try {
      r = pending.confirm
        ? await d.api.joinPoll(pinned, pending.joinId, auth, POLL_WAIT_S, pending.confirm)
        : await d.api.joinPoll(pinned, pending.joinId, auth, POLL_WAIT_S);
    } catch (err) {
      if (err.status === 404) fail(1, LINES.gone);
      if (err.status === 401) fail(1, refusedLine(401, err.body));
      if (err.status) fail(1, refusedLine(err.status, err.body));
      if (Date.now() > giveUpAt) fail(3, `Lost the phone while waiting: ${err.message}`);
      await d.sleep(POLL_RETRY_MS);
      continue;
    }
    if (r.status === "approved") return r;
    if (r.status === "denied") fail(1, LINES.denied);
    if (r.status === "expired") fail(1, LINES.expired);
  }
}

/** phone.hosts per mode (spec 4.5): embedded forward first; LAN only when allowed or mode lan. */
// Hosts the phone hands back are kept only inside the user's own network (audit C2).
const hostPart = (e) => {
  const v = String(e || "").trim();
  const m = /^(.*):(\d{1,5})$/.exec(v);
  return m && !m[1].includes(":") ? m[1] : v;
};
const ownHosts = (list) => (Array.isArray(list) ? list : []).filter((e) => jc.isOwnNetworkHost(hostPart(e)));

function configHosts(mode, approved, { forwardPort, reached } = {}) {
  const tail = ownHosts(approved.phone && approved.phone.hosts);
  const lan = ownHosts(approved.lan_hosts);
  if (mode === "lan") return uniq([reached, ...lan, ...tail]);
  const lanPart = approved.lan_allowed ? lan : [];
  if (mode === "embedded") return uniq([`127.0.0.1:${forwardPort}`, ...tail, ...lanPart]);
  return uniq([...tail, ...lanPart]);
}

function readRawConfig() {
  try {
    const v = JSON.parse(fs.readFileSync(configFile(), "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** ~/.ringback/config.json 0600 in a 0700 dir, atomically; unrelated keys kept. */
function writeJoinedConfig(next) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const { phone: _p, agent_token: _t, machine: _m, file: _f, url_override: _u, blocked: _b, ...keep } = readRawConfig();
  const tmp = `${configFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...keep, ...next }, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, configFile());
  // The phone the user approved this join on: a later Wi-Fi-only join may trust it (item 51).
  if (next.phone) require("./known-phones.js").remember(next.phone.fp, next.phone.name);
}

function buildConfig(code, mode, choice, netState, approved, fp) {
  const port = Number(approved.phone && approved.phone.port) || code.port;
  const forwardPort = netState ? Number(netState.forward_port) : 0;
  const hosts = configHosts(mode, approved, { forwardPort, reached: choice.target && choice.target.host });
  const tailIp = phoneTailnetHost([...((approved.phone && approved.phone.hosts) || []), ...code.hosts].filter(isCgnat));
  return {
    phone: { name: (approved.phone && approved.phone.name) || "Phone", port, hosts, fp },
    agent_token: approved.agent_token,
    machine: {
      id: String(approved.machine_id || ""),
      name: String(approved.name || ""),
      mode,
      ...(mode === "embedded" ? { forward_port: forwardPort } : {}),
      ...(tailIp ? { phone_tailnet: `${tailIp}:${port}` } : {}),
    },
  };
}

function stopNet(ctx) {
  if (ctx.net && !ctx.stopped) {
    ctx.stopped = true;
    try {
      ctx.net.kill();
    } catch {
      // Already gone.
    }
  }
}

async function healthCheck(cfg, d) {
  let last = null;
  for (let i = 0; i < HEALTH_TRIES; i += 1) {
    try {
      await d.api.machine({ ...cfg, url_override: "" });
      return true;
    } catch (err) {
      last = err;
      if (err.status === 401) break;
      await d.sleep(HEALTH_EVERY_MS);
    }
  }
  d.out(`The phone did not answer the health check yet (${last ? last.message : "no answer"}). The helper keeps trying in the background.`);
  return false;
}

async function finishInstall(cfg, mode, netState, opts, d, ctx) {
  let pluginOk = true;
  if (!opts.noPlugin && d.installPlugin) {
    const r = await d.installPlugin();
    pluginOk = Boolean(r && r.ok);
    if (!pluginOk) d.out(`Could not install the Claude Code plugin: ${(r && r.error) || "unknown error"}`);
  }
  // The service's helper supervises its own ringback-net: stop the sign-in one first.
  stopNet(ctx);
  if (ctx.net) await d.sleep(NET_POLL_MS);
  const s = await d.installService();
  const serviceOk = Boolean(s && s.ok);
  if (serviceOk) d.out(pluginOk && !opts.noPlugin && d.installPlugin ? LINES.installed : LINES.installedService);
  else d.out(`Could not install the helper service: ${(s && s.error) || "unknown error"}`);
  const healthOk = await healthCheck(cfg, d);
  if (mode !== "lan") {
    const node = (netState && netState.short_name) || d.hostname;
    d.out(`Tip: turn off key expiry for ${node}: ${KEY_EXPIRY_URL}`);
  }
  return { serviceOk, serviceError: serviceOk ? "" : String((s && s.error) || "unknown error"), healthOk };
}

async function joinSteps(raw, opts, d, ctx) {
  d.out(`Ringback join ${VERSION}`);
  const g = await checkMachine(opts, d);
  const code = jc.parseCode(raw);
  d.out(`Checking this machine... ok (${OS_LABEL[d.platform]} ${d.arch})`);
  const choice = await chooseMode(code, d);
  let netState = null;
  let target = choice.target;
  if (choice.mode === "embedded") {
    netState = await startEmbedded(code, d, ctx);
    target = { host: "127.0.0.1", port: Number(netState.forward_port) };
  }
  const pending = await startJoin(code, target, choice.mode, g, d);
  d.out("Asking the phone.");
  // Audit C2: the person confirms the code their own phone shows before anything is accepted.
  const giveUpAt = pending.expiresAt || Date.now() + 10 * 60 * 1000;
  const confirmed = await d.confirmMatch(pending.match, { display: jc.displayMatch(pending.match), deadline: giveUpAt, out: d.out, sleep: d.sleep });
  if (confirmed === "no") fail(1, LINES.mismatch);
  if (confirmed !== "ok") fail(1, LINES.noConfirm);
  const approved = await pollDecision(jc.pollAuth(code.secret, pending.joinId), target, pending, d);
  if (!/^rbk_/.test(String(approved.agent_token || "")) || normFp(approved.phone && approved.phone.fp) !== pending.fp) {
    fail(1, LINES.notProven);
  }
  const cfg = buildConfig(code, choice.mode, choice, netState, approved, pending.fp);
  writeJoinedConfig(cfg);
  d.out(`Joined as ${cfg.machine.name || d.hostname}. Agents here can now call you.`);
  await finishInstall(cfg, choice.mode, netState, opts, d, ctx);
  return 0;
}

/** Runs the join. Returns the exit code; prints every line through d.out. */
async function runJoin(raw, opts = {}, deps = realDeps(opts)) {
  const d = { ...realDeps(opts), ...deps };
  const ctx = { net: null, stopped: false };
  try {
    return await joinSteps(raw, opts, d, ctx);
  } catch (err) {
    if (err instanceof JoinExit) {
      d.out(err.message);
      return err.exitCode;
    }
    if (err && (err.message === jc.BAD_CODE || err.message === jc.OUTSIDE)) {
      d.out(err.message);
      return 1;
    }
    d.out(`Join failed: ${err && err.message ? err.message : err}`);
    return 3;
  } finally {
    stopNet(ctx);
  }
}

function probe(host, port, ms) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => {
      clearTimeout(timer);
      s.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), ms);
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

function hasClaude() {
  // A fixed command string (no user input): finds claude, claude.exe or claude.cmd on PATH.
  return new Promise((resolve) => exec("claude --version", { windowsHide: true }, (err) => resolve(!err)));
}

function spawnNet(bin, args) {
  const child = spawn(bin, args, { stdio: ["ignore", "ignore", "inherit"], windowsHide: true });
  const handle = { pid: child.pid, exited: null, kill: () => child.kill() };
  child.on("exit", (code) => (handle.exited = code === null ? -1 : code));
  child.on("error", () => (handle.exited = -1));
  return handle;
}

function readNetState() {
  try {
    return JSON.parse(fs.readFileSync(path.join(configDir(), "state", "net.json"), "utf8"));
  } catch {
    return null;
  }
}

function userName() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER || process.env.USERNAME || "";
  }
}

/** The real effects. `opts.helperPath` is the helper the service runs (default: this plugin's). */
function realDeps(opts = {}) {
  const pluginRoot = path.join(__dirname, "..");
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    guard: () => guard.detectHere(),
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    user: userName(),
    hasClaude,
    probe,
    confirmMatch: (match, o) =>
      require("./join-confirm.js").confirmMatch(match, {
        ...o,
        tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
        confirmCmd: opts.confirmCmd || `node "${process.argv[1] || "ringback-join"}" --confirm`,
      }),
    resolve: async (name) => (await require("dns").promises.lookup(name, { all: true, family: 4 })).map((a) => a.address),
    api: clientApi,
    ensureNet: () => {
      const dl = require("./download.js");
      const manifest = dl.readManifest(path.join(pluginRoot, "net-manifest.json"));
      return dl.ensureNet({ manifest, dir: path.join(configDir(), "bin") });
    },
    spawnNet,
    readNetState,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    installPlugin: null,
    installService: () => {
      const service = require("./service.js");
      return service.install(service.hereOptions({ helperPath: opts.helperPath }), service.realExec());
    },
  };
}

/**
 * The helper service for a join run from inside an installed plugin (/ringback:join and the
 * join_this_machine tool): a stable copy in ~/.ringback/plugin/<version>/ (the Claude Code plugin
 * cache can move), made only once the join was approved.
 */
function pluginInstallService(pluginRoot, { print } = {}) {
  return async () => {
    let helperPath = path.join(pluginRoot, "helper", "ringback-helper.js");
    try {
      const { installCopy, defaultBase } = require("./plugin-copy.js");
      helperPath = path.join(installCopy(pluginRoot, defaultBase(), VERSION), "helper", "ringback-helper.js");
    } catch {
      // Fall back to this plugin's own helper.
    }
    const service = require("./service.js");
    return service.install(service.hereOptions({ helperPath }), service.realExec(print ? { print } : {}));
  };
}

module.exports = {
  VERSION,
  runJoin,
  configHosts,
  buildConfig,
  writeJoinedConfig,
  chooseMode,
  isTailnetHost,
  refusedLine,
  realDeps,
  LINES,
  JoinExit,
  checkMachine,
  machineBody,
  pollDecision,
  finishInstall,
  stopNet,
  pluginInstallService,
  NET_POLL_MS,
};
