"use strict";
// What this machine can stream (PUT /v1/streams/caps, spec 04 section 6.1 plus the window view
// from FOLLOWUPS item 22b). Probing reads versions, filter lists and screen geometry only: it
// never opens a capture (a test grab would be a capture without a tap).

const os = require("os");
const { execFile } = require("child_process");
const capture = require("./capture.js");
const guard = require("./stream-guard.js");
const desk = require("./desk.js");
const tmux = require("./tmux.js");
const win = require("./window.js");

const MACHINE = os.hostname().slice(0, 64);
const CAPTURE_SETUP = "This computer cannot share its screen yet; ask your agent to set up screen sharing.";

const execText = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, out, errOut) => (err && !out && !errOut ? reject(err) : resolve(`${out}${errOut}`))),
  );

/** macOS avfoundation screen devices from `-list_devices` (a device list, not a capture). */
function parseAvfScreens(text) {
  const out = [];
  for (const m of String(text).matchAll(/\[(\d+)\] Capture screen (\d+)/g)) out.push({ index: Number(m[1]), width: 0, height: 0, primary: m[2] === "0" });
  return out;
}

async function screenCaps(platform, p, deps) {
  if (!p.ffmpeg || !p.libx264) return { available: false, method: null, displays: [], reason: CAPTURE_SETUP };
  if (platform === "win32") {
    const displays = await (deps.listDisplays || win.listDisplays)();
    return { available: true, method: p.ddagrab ? "ddagrab" : "gdigrab", displays: displays.length ? displays : [{ index: 0, width: 0, height: 0, primary: true }] };
  }
  if (platform === "darwin") {
    const list = await (deps.exec || execText)(deps.ffmpeg[0], [...deps.ffmpeg.slice(1), "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]).catch(() => "");
    const displays = parseAvfScreens(list);
    return displays.length
      ? { available: true, method: "avfoundation", displays }
      : { available: false, method: null, displays: [], reason: "No screen found (allow Screen Recording for the terminal in System Settings)" };
  }
  const disp = String((deps.env || process.env).DISPLAY || "");
  if (/^:\d{1,3}$/.test(disp)) return { available: true, method: "x11grab", displays: [{ index: 0, width: 0, height: 0, primary: true }] };
  return { available: false, method: null, displays: [], reason: "No display on this machine; use the desk" };
}

// FOLLOWUPS item 58: each session's view is its own transcript (Terminal). A window capture
// showed whichever tab Windows Terminal had focused, so it is off unless a human sets
// streams.window_view in ~/.ringback/config.json; even then shared hosts are refused per stream.
const WINDOW_OFF = "Each session shows its own transcript under Terminal (set streams.window_view to also offer its console window)";

function windowView(cfg, platform, p) {
  if (platform !== "win32") return { available: false, method: null, reason: "Window view is Windows only; use Terminal (Raw shows the tmux pane)" };
  if (!p.ffmpeg || !p.libx264) return { available: false, method: null, reason: CAPTURE_SETUP };
  if (!(cfg && cfg.streams && cfg.streams.window_view === true)) return { available: false, method: null, reason: WINDOW_OFF };
  return { available: true, method: p.ddagrab ? "ddagrab-crop" : "gdigrab-hwnd" };
}

/** The caps body. `deps` injects probe results and lookups for tests. */
async function buildCaps(cfg = {}, deps = {}) {
  const platform = deps.platform || process.platform;
  const ffmpeg = deps.ffmpeg || ffmpegCommand(cfg);
  const allowed = guard.streamsAllowed(cfg, deps.guardDeps);
  const p = deps.probe || (await capture.probe({ exec: deps.exec || execText, ffmpeg }));
  const off = { available: false, method: null, reason: "Screens are off for this machine" };
  const screen = allowed ? await screenCaps(platform, p, { ...deps, ffmpeg }) : { ...off, displays: [] };
  const deskOk = allowed && guard.deskAllowed(cfg, { ...(deps.guardDeps || {}), platform }) && p.ffmpeg && p.libx264;
  const deskNow = (deps.deskStatus || desk.status)();
  const deskCaps = deskOk
    ? { available: true, running: Boolean(deskNow.running), size: deskNow.running ? deskNow.size : null }
    : { available: false, running: false, size: null, reason: platform === "linux" && (!p.ffmpeg || !p.libx264) ? CAPTURE_SETUP : platform === "linux" ? "Desk is off here (set desk.enabled in ~/.ringback/config.json on the desk machine)" : "Desks run on Linux only" };
  const windowCaps = !allowed ? off : windowView(cfg, platform, p);
  const hasTmux = platform === "win32" ? false : await (deps.tmuxAvailable || tmux.available)();
  return {
    machine: deps.machine || MACHINE,
    platform,
    ffmpeg: p.ffmpeg,
    encoder: p.libx264 ? "libx264" : null,
    screen,
    desk: deskCaps,
    window: windowCaps,
    terminal: { transcript: true, tmux: Boolean(hasTmux) },
    streams_allowed: allowed,
  };
}

/** ffmpeg argv prefix: config ffmpeg_command (array), env RINGBACK_FFMPEG_COMMAND (JSON array), or ffmpeg. */
function ffmpegCommand(cfg = {}, env = process.env) {
  if (Array.isArray(cfg.ffmpeg_command) && cfg.ffmpeg_command.length) return cfg.ffmpeg_command.map(String);
  if (env.RINGBACK_FFMPEG_COMMAND) {
    try {
      const v = JSON.parse(env.RINGBACK_FFMPEG_COMMAND);
      if (Array.isArray(v) && v.length) return v.map(String);
    } catch {
      // Fall through to the default.
    }
  }
  return ["ffmpeg"];
}

async function screenShareReady(cfg, deps = {}) {
  const exec = deps.exec || ((cmd, args) => new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => err ? reject(err) : resolve(out));
  }));
  const p = await capture.probe({ exec, ffmpeg: ffmpegCommand(cfg) });
  return { available: Boolean(p.ffmpeg && p.libx264) };
}

module.exports = { buildCaps, ffmpegCommand, parseAvfScreens, MACHINE, screenShareReady, CAPTURE_SETUP };
