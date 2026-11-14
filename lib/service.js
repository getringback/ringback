"use strict";
// The helper as an OS service (spec 03 section 4.4). Pure templates and plans, plus a thin exec
// layer whose every effect goes through injected deps (tests never touch the real OS). One
// service only: install always replaces an existing one. Each runs
// `node <plugin>/helper/ringback-helper.js --service`.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");

const UNIT = "ringback-helper.service";
const LABEL = "com.getringback.helper";
const TASK = "Ringback Helper";
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE = "RingbackHelper";
const CRON_MARK = "# ringback-helper";

const q = (s) => `"${s}"`;
const unitQuote = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
const execLine = (o) => `${q(o.nodePath)} ${q(o.helperPath)} --service`;
const argv = (o) => [o.nodePath, o.helperPath, "--service"];

function systemdUnit(o, asRoot) {
  return [
    "[Unit]",
    "Description=Ringback helper (lets agents on this machine reach your phone)",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${execLine(o)}`,
    "Restart=always",
    "RestartSec=5",
    `Environment=${unitQuote(`HOME=${o.home}`)}`,
    ...(o.pathEnv ? [`Environment=${unitQuote(`PATH=${o.pathEnv}`)}`] : []),
    ...(o.ringbackHome ? [`Environment=${unitQuote(`RINGBACK_HOME=${o.ringbackHome}`)}`] : []),
    "",
    "[Install]",
    `WantedBy=${asRoot ? "multi-user.target" : "default.target"}`,
    "",
  ].join("\n");
}

const xmlEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function launchdPlist(o) {
  const args = argv(o).map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");
  const variables = { HOME: o.home, PATH: o.pathEnv, RINGBACK_HOME: o.ringbackHome };
  const pathEnv = `  <key>EnvironmentVariables</key>\n  <dict>\n` +
    Object.entries(variables).filter(([, v]) => v).map(([k, v]) => `    <key>${k}</key>\n    <string>${xmlEscape(v)}</string>\n`).join("") + "  </dict>\n";
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    args,
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>StandardOutPath</key>",
    `  <string>${xmlEscape(joinPosix(o.ringbackHome || joinPosix(o.home, ".ringback"), "helper.launchd.log"))}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xmlEscape(joinPosix(o.ringbackHome || joinPosix(o.home, ".ringback"), "helper.launchd.log"))}</string>`,
    `${pathEnv}</dict>`,
    "</plist>",
    "",
  ].join("\n");
}

const joinPosix = (...parts) => parts.join("/").replace(/\/+/g, "/");

function linuxPlan(o) {
  if (!o.hasSystemd) {
    return {
      kind: "cron",
      files: [],
      cronLine: `@reboot nohup ${execLine(o)} >/dev/null 2>&1 & ${CRON_MARK}`,
      startNow: argv(o),
      status: null,
    };
  }
  const sc = o.isRoot ? ["systemctl"] : ["systemctl", "--user"];
  const unitPath = o.isRoot ? `/etc/systemd/system/${UNIT}` : joinPosix(o.home, ".config/systemd/user", UNIT);
  return {
    kind: o.isRoot ? "systemd-system" : "systemd-user",
    files: [{ path: unitPath, content: systemdUnit(o, o.isRoot) }],
    commands: [
      [...sc, "daemon-reload"],
      [...sc, "enable", UNIT],
      [...sc, "restart", UNIT],
    ],
    uninstall: [
      [...sc, "disable", "--now", UNIT],
      [...sc, "daemon-reload"],
    ],
    status: [...sc, "is-active", UNIT],
    ...(o.isRoot ? {} : { after: { cmd: ["loginctl", "enable-linger", o.user], onFail: `sudo loginctl enable-linger ${o.user}` } }),
  };
}

function darwinPlan(o) {
  const plist = joinPosix(o.home, "Library/LaunchAgents", `${LABEL}.plist`);
  const domain = `gui/${o.uid === undefined ? process.getuid?.() || 0 : o.uid}`;
  return {
    kind: "launchd",
    files: [{ path: plist, content: launchdPlist(o) }],
    commands: [
      ["launchctl", "bootout", `${domain}/${LABEL}`],
      ["launchctl", "bootstrap", domain, plist],
      ["launchctl", "kickstart", "-k", `${domain}/${LABEL}`],
    ],
    // Unloading a service that was never loaded fails; that is fine.
    ignoreFailureOf: 0,
    legacyDirectory: joinPosix(o.home, "Library/LaunchAgents"),
    domain,
    fallback: { kind: "launchd", commands: [["launchctl", "load", "-w", plist]], startNow: argv(o) },
    uninstall: [["launchctl", "bootout", `${domain}/${LABEL}`]],
    status: ["launchctl", "print", `${domain}/${LABEL}`],
  };
}

function windowsPlan(o) {
  return {
    kind: "schtasks",
    files: [],
    commands: [
      ["schtasks", "/Create", "/SC", "ONLOGON", "/RL", "LIMITED", "/TN", TASK, "/TR", execLine(o), "/F"],
      ["schtasks", "/Run", "/TN", TASK],
    ],
    // A standard user may not create logon tasks on some Windows editions: the user Run key is
    // the no-admin fallback, started at once the same way.
    fallback: {
      kind: "run-key",
      commands: [["reg", "add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", execLine(o), "/f"]],
      startNow: argv(o),
    },
    uninstall: [
      ["schtasks", "/Delete", "/TN", TASK, "/F"],
      ["reg", "delete", RUN_KEY, "/v", RUN_VALUE, "/f"],
    ],
    status: ["schtasks", "/Query", "/TN", TASK],
  };
}

/**
 * What to install for `o` = { platform, home, user, nodePath, helperPath, isRoot, hasSystemd, pathEnv }.
 */
function plan(o) {
  if (o.platform === "win32") return windowsPlan(o);
  if (o.platform === "darwin") return darwinPlan(o);
  return linuxPlan(o);
}

/** The crontab text without any old Ringback line, plus `line` when given. */
function mergeCrontab(current, line) {
  const kept = String(current || "")
    .split("\n")
    .filter((l) => l.trim() && !l.includes(CRON_MARK));
  return `${[...kept, ...(line ? [line] : [])].join("\n")}\n`.replace(/^\n$/, "");
}

const show = (cmd) => cmd.join(" ");

async function runAll(cmds, ex, ignoreIndex = -1) {
  for (const [i, [cmd, ...args]] of cmds.entries()) {
    const r = await ex.run(cmd, args);
    if (r.code !== 0 && i !== ignoreIndex) return `${show([cmd, ...args])} failed: ${String(r.stderr || r.stdout).trim()}`;
  }
  return "";
}

async function installCron(p, ex) {
  const cur = await ex.run("crontab", ["-l"]);
  const merged = mergeCrontab(cur.code === 0 ? cur.stdout : "", p.cronLine);
  const w = await ex.run("crontab", ["-"], { input: merged });
  try { await ex.spawnDetached(p.startNow[0], p.startNow.slice(1)); }
  catch (err) { return { ok: false, kind: "cron", error: `Could not start the helper: ${err.message}` }; }
  // Without cron the helper still runs now; it just will not come back after a reboot.
  return { ok: true, kind: "cron", ...(w.code !== 0 ? { warning: "Could not add the @reboot line to crontab." } : {}) };
}

/** Install (or replace) the service and start it. Never throws for a failing command. */
async function install(o, ex) {
  if (ex.prepareHelper) {
    // Without the stable copy the service runs this plugin's own helper, as before.
    try { o = { ...o, helperPath: ex.prepareHelper(o.helperPath) }; }
    catch { /* Keep o.helperPath. */ }
  }
  const p = plan(o);
  if (p.kind === "cron") return installCron(p, ex);
  for (const f of p.files) ex.writeFile(f.path, f.content);
  if (p.legacyDirectory && ex.legacyAgents) {
    for (const file of ex.legacyAgents(p.legacyDirectory)) {
      const label = path.basename(file, ".plist");
      if (!/^[a-zA-Z0-9.-]+\.ringback\.helper$/.test(label)) continue;
      await ex.run("launchctl", ["bootout", `${p.domain}/${label}`]);
      ex.removeFile(file);
    }
  }
  const err = await runAll(p.commands, ex, p.ignoreFailureOf === undefined ? -1 : p.ignoreFailureOf);
  if (err && p.fallback) {
    const ferr = await runAll(p.fallback.commands, ex);
    if (p.kind === "launchd") {
      if (!ferr) return { ok: true, kind: p.kind, warning: "Modern launchctl failed; used the older LaunchAgent loader." };
      try { await ex.spawnDetached(p.fallback.startNow[0], p.fallback.startNow.slice(1)); }
      catch (err) { return { ok: false, kind: p.kind, error: `Could not start the helper: ${err.message}` }; }
      return { ok: true, kind: p.kind, warning: "Could not load the LaunchAgent. The helper is running now, but may not return after login." };
    }
    if (ferr) return { ok: false, kind: p.kind, error: `${err}; ${ferr}` };
    try { await ex.spawnDetached(p.fallback.startNow[0], p.fallback.startNow.slice(1)); }
    catch (err) { return { ok: false, kind: p.fallback.kind, error: `Could not start the helper: ${err.message}` }; }
    return { ok: true, kind: p.fallback.kind };
  }
  if (err) return { ok: false, kind: p.kind, error: err };
  if (p.after) {
    const r = await ex.run(p.after.cmd[0], p.after.cmd.slice(1));
    if (r.code !== 0) ex.print(`To keep the helper running after you log out, run: ${p.after.onFail}`);
  }
  return { ok: true, kind: p.kind };
}

/** Remove the service (each step best effort). */
async function uninstall(o, ex) {
  const p = plan(o);
  if (p.kind === "cron") {
    const cur = await ex.run("crontab", ["-l"]);
    if (cur.code === 0) await ex.run("crontab", ["-"], { input: mergeCrontab(cur.stdout, null) });
    return { ok: true, kind: p.kind };
  }
  for (const [cmd, ...args] of p.uninstall) await ex.run(cmd, args);
  for (const f of p.files) ex.removeFile(f.path);
  return { ok: true, kind: p.kind };
}

async function status(o, ex) {
  const p = plan(o);
  if (!p.status) return { kind: p.kind, running: null };
  const r = await ex.run(p.status[0], p.status.slice(1));
  return { kind: p.kind, running: r.code === 0 && (p.kind !== "launchd" || /\bstate\s*=\s*running\b/.test(r.stdout)) };
}

/** Resolve user-installed tools as well as binaries visible to the installer's shell. */
function toolEnvironment({ home = os.homedir(), env = process.env, platform = process.platform, nodePath = process.execPath } = {}) {
  const delimiter = platform === "win32" ? ";" : ":";
  const dirs = [path.dirname(nodePath), env.NVM_BIN, ...String(env.PATH || env.Path || "").split(delimiter),
    ...[".local/bin", ".npm-global/bin", ".npm/bin", "bin", ".cargo/bin", ".volta/bin", ".asdf/shims", ".local/share/mise/shims", ".nvm/current/bin"].map((d) => path.join(home, d)),
    ...(env.npm_config_prefix ? [path.join(env.npm_config_prefix, "bin")] : []),
    ...(platform === "win32" ? [path.join(env.APPDATA || path.join(home, "AppData/Roaming"), "npm"), path.join(env.LOCALAPPDATA || path.join(home, "AppData/Local"), "Programs/claude")] :
      ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin", "/snap/bin"]),
  ].filter(Boolean);
  const search = [...new Set(dirs)];
  // A real .exe anywhere wins over a .cmd shim. Symlinks are kept as found: the native Claude
  // installer points ~/.local/bin/claude at a versioned file that a later update removes.
  const find = (name) => {
    for (const suffix of platform === "win32" ? [".exe", ".cmd"] : [""]) for (const dir of search) {
      const file = path.join(dir, `${name}${suffix}`);
      try {
        if (!fs.statSync(file).isFile()) continue;
        if (platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
        return file;
      } catch { /* Keep looking. */ }
    }
    return null;
  };
  const claudePath = find("claude"), codexPath = find("codex");
  const resolved = [nodePath, claudePath, codexPath].filter(Boolean).map((f) => path.dirname(f));
  return { nodePath, claudePath, codexPath, pathEnv: [...new Set([...resolved, ...search])].join(delimiter) };
}

/** This machine's facts for plan(). */
function hereOptions({ helperPath, env = process.env } = {}) {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  let user = env.USER || env.USERNAME || "";
  try {
    user = os.userInfo().username || user;
  } catch {
    // Keep the env name.
  }
  return {
    platform: process.platform,
    home: os.homedir(),
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    user,
    ...toolEnvironment({ env }),
    helperPath: helperPath || path.join(__dirname, "..", "helper", "ringback-helper.js"),
    isRoot,
    hasSystemd: process.platform === "linux" && fs.existsSync("/run/systemd/system"),
    ringbackHome: env.RINGBACK_HOME,
  };
}

/** The real exec layer. */
function realExec({ print = (l) => process.stdout.write(`${l}\n`) } = {}) {
  return {
    legacyAgents: (dir) => fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".ringback.helper.plist")).map((f) => path.join(dir, f)) : [],
    prepareHelper: (helperPath) => {
      const source = path.resolve(path.dirname(helperPath), "..");
      if (path.basename(source) === "current") return helperPath;
      const root = require("./plugin-copy.js").ensureStableCopy(source);
      return path.join(root, "helper", "ringback-helper.js");
    },
    run: (cmd, args, opts = {}) =>
      new Promise((resolve) => {
        const child = execFile(cmd, args, { windowsHide: true }, (err, stdout, stderr) =>
          resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
        );
        if (opts.input !== undefined) child.stdin.end(opts.input);
      }),
    writeFile: (p, content) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, { mode: 0o644 });
    },
    removeFile: (p) => fs.rmSync(p, { force: true }),
    spawnDetached: (cmd, args) => new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
      child.once("error", reject);
      child.once("spawn", () => { child.unref(); resolve(); });
    }),
    print,
  };
}

module.exports = { UNIT, LABEL, TASK, systemdUnit, launchdPlist, plan, mergeCrontab, install, uninstall, status, hereOptions, realExec, toolEnvironment };
