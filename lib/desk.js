"use strict";
// The Linux desk (spec 04 section 2.3, dex-desk recipe): Xvfb :5 at 1920x1080 plus a Chromium
// that Claude drives over CDP on 127.0.0.1:9355. Starting a desk captures nothing; the phone
// still has to ask for a stream through the gate. Only where stream-guard deskAllowed() says so
// (Linux, never vast.ai, never a restricted host, and a human set desk.enabled in ~/.ringback/config.json).
// Differences from start5.sh on purpose: a fresh profile (no signed-in profile copied), no
// extensions, --no-sandbox only as root, CDP never bound beyond 127.0.0.1.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { configDir } = require("./config.js");
const guard = require("./stream-guard.js");

const DISPLAY = ":5";
const CDP_PORT = 9355;
const SIZE = Object.freeze({ width: 1920, height: 1080 });
const CDP = `http://127.0.0.1:${CDP_PORT}`;
const XVFB = ["Xvfb"];
const BROWSERS = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"];
const INSTALL_HINT = "Install it once: sudo apt install -y xvfb chromium ffmpeg (or chromium-browser on older Ubuntu).";

const deskDir = () => path.join(configDir(), "desk");
const pidFile = (name) => path.join(deskDir(), `${name}.pid`);

function which(names, env = process.env) {
  const dirs = String(env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const n of names) {
    for (const d of dirs) {
      const f = path.join(d, n);
      try {
        if (fs.statSync(f).isFile()) return f;
      } catch {
        // Not here.
      }
    }
  }
  return null;
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function readPid(name) {
  try {
    const n = Number(fs.readFileSync(pidFile(name), "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function writePid(name, pid) {
  fs.mkdirSync(deskDir(), { recursive: true });
  fs.writeFileSync(pidFile(name), String(pid));
}

function status(deps = {}) {
  const isAlive = deps.alive || alive;
  const x = readPid("xvfb");
  const c = readPid("chromium");
  const running = Boolean(x && isAlive(x) && c && isAlive(c));
  return { status: running ? "running" : "stopped", running, display: DISPLAY, cdp: CDP, size: running ? { ...SIZE } : null };
}

function checkUrl(url) {
  if (url === undefined || url === null || url === "") return "about:blank";
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return null;
  }
  return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForX(deps, ms = 5000) {
  const sock = `/tmp/.X11-unix/X${DISPLAY.slice(1)}`;
  const exists = deps.exists || fs.existsSync;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (exists(sock)) return true;
    await sleep(100);
  }
  return false;
}

function chromiumArgs(url, root) {
  return [
    `--window-size=${SIZE.width},${SIZE.height}`,
    "--window-position=0,0",
    "--force-device-scale-factor=1",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${path.join(deskDir(), "profile")}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    ...(root ? ["--no-sandbox"] : []),
    url,
  ];
}

/** Start Xvfb and Chromium (or report the running desk). Never on a machine the guard refuses. */
async function start(url, deps = {}) {
  const cfg = deps.cfg || {};
  if (!guard.deskAllowed(cfg, deps.guardDeps)) {
    return { status: "not_allowed", detail: "No desk on this machine. A desk runs only on a Linux machine where desk.enabled is true in ~/.ringback/config.json (never on vast.ai)." };
  }
  const target = checkUrl(url);
  if (!target) return { status: "bad_request", detail: "url must be an http or https address" };
  const now = status(deps);
  if (now.running) return { ...now, status: "already_running" };
  const find = deps.which || which;
  const xvfb = find(XVFB);
  const browser = find(BROWSERS);
  if (!xvfb || !browser) return { status: "missing", detail: `${!xvfb ? "Xvfb" : "Chromium"} is not installed. ${INSTALL_HINT}` };
  const run = deps.spawn || spawn;
  const opts = { detached: true, stdio: "ignore", shell: false };
  const x = run(xvfb, [DISPLAY, "-screen", "0", `${SIZE.width}x${SIZE.height}x24`, "-nolisten", "tcp"], opts);
  if (x.unref) x.unref();
  writePid("xvfb", x.pid);
  if (!(await waitForX(deps, deps.waitMs || 5000))) {
    stop(deps);
    return { status: "failed", detail: "Xvfb did not start on :5" };
  }
  const root = typeof process.getuid === "function" && process.getuid() === 0;
  const c = run(browser, chromiumArgs(target, deps.root !== undefined ? deps.root : root), { ...opts, env: { ...process.env, DISPLAY } });
  if (c.unref) c.unref();
  writePid("chromium", c.pid);
  return { status: "running", running: true, display: DISPLAY, cdp: CDP, size: { ...SIZE } };
}

/** Stop the desk processes this module started (only the pids it wrote). */
function stop(deps = {}) {
  const kill = deps.kill || ((pid) => process.kill(pid, "SIGTERM"));
  const isAlive = deps.alive || alive;
  for (const name of ["chromium", "xvfb"]) {
    const pid = readPid(name);
    if (pid && isAlive(pid)) {
      try {
        kill(pid);
      } catch {
        // Already gone.
      }
    }
    fs.rmSync(pidFile(name), { force: true });
  }
  return { status: "stopped", running: false, display: DISPLAY, cdp: CDP, size: null };
}

module.exports = { start, stop, status, which, checkUrl, chromiumArgs, DISPLAY, CDP, CDP_PORT, SIZE, BROWSERS, XVFB, INSTALL_HINT };
