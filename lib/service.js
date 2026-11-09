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
const LABEL = "eu.nawaf.ringback.helper";
const TASK = "Ringback Helper";
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE = "RingbackHelper";
const CRON_MARK = "# ringback-helper";

const q = (s) => `"${s}"`;
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
    `Environment=HOME=${o.home}`,
    ...(o.pathEnv ? [`Environment=PATH=${o.pathEnv}`] : []),
    "",
    "[Install]",
    `WantedBy=${asRoot ? "multi-user.target" : "default.target"}`,
    "",
  ].join("\n");
}

const xmlEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function launchdPlist(o) {
  const args = argv(o).map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");
  const pathEnv = o.pathEnv
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key>\n    <string>${xmlEscape(o.pathEnv)}</string>\n  </dict>\n`
    : "";
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
  return {
    kind: "launchd",
    files: [{ path: plist, content: launchdPlist(o) }],
    commands: [
      ["launchctl", "unload", plist],
      ["launchctl", "load", "-w", plist],
    ],
    // Unloading a service that was never loaded fails; that is fine.
    ignoreFailureOf: 0,
    uninstall: [["launchctl", "unload", "-w", plist]],
    status: ["launchctl", "list", LABEL],
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
  ex.spawnDetached(p.startNow[0], p.startNow.slice(1));
  // Without cron the helper still runs now; it just will not come back after a reboot.
  return { ok: true, kind: "cron", ...(w.code !== 0 ? { warning: "Could not add the @reboot line to crontab." } : {}) };
}

/** Install (or replace) the service and start it. Never throws for a failing command. */
async function install(o, ex) {
  const p = plan(o);
  if (p.kind === "cron") return installCron(p, ex);
  for (const f of p.files) ex.writeFile(f.path, f.content);
  const err = await runAll(p.commands, ex, p.ignoreFailureOf === undefined ? -1 : p.ignoreFailureOf);
  if (err && p.fallback) {
    const ferr = await runAll(p.fallback.commands, ex);
    if (ferr) return { ok: false, kind: p.kind, error: `${err}; ${ferr}` };
    ex.spawnDetached(p.fallback.startNow[0], p.fallback.startNow.slice(1));
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
  return { kind: p.kind, running: r.code === 0 };
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
    user,
    nodePath: process.execPath,
    helperPath: helperPath || path.join(__dirname, "..", "helper", "ringback-helper.js"),
    isRoot,
    hasSystemd: process.platform === "linux" && fs.existsSync("/run/systemd/system"),
    pathEnv: env.PATH || "",
  };
}

/** The real exec layer. */
function realExec({ print = (l) => process.stdout.write(`${l}\n`) } = {}) {
  return {
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
    spawnDetached: (cmd, args) => {
      const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
    },
    print,
  };
}

module.exports = { UNIT, LABEL, TASK, systemdUnit, launchdPlist, plan, mergeCrontab, install, uninstall, status, hereOptions, realExec };
