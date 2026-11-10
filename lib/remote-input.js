"use strict";
// Taps and typing from the owner's phone onto a screen it is watching. The only way in is a
// control message on the stream socket the paired phone opened (helper/streams.js): there is no
// route and no MCP tool for it, so an agent can never send input through this.
//  - desk: xdotool on the desk's own virtual display, so nobody's real focus is touched.
//  - the real screen or one window (Windows only): SendInput, and only when a human wrote
//    "allow_phone_input": true in ~/.ringback/config.json on this computer. The phone cannot turn it on.
// Positions arrive as fractions of the video (0 to 1), so the encoder's scaling does not matter.
// Input text is never logged.

const { spawn: nodeSpawn } = require("child_process");
const desk = require("./desk.js");

const MAX_TEXT = 2000;
const MAX_NOTCHES = 20;
const MAX_PER_SECOND = 30;
const BUTTONS = Object.freeze({ left: 1, right: 3 });
const XDO_KEYS = Object.freeze({
  Enter: "Return", Backspace: "BackSpace", Escape: "Escape", Tab: "Tab",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
});
const WIN_KEYS = Object.freeze({
  Enter: 0x0d, Backspace: 0x08, Escape: 0x1b, Tab: 0x09,
  ArrowUp: 0x26, ArrowDown: 0x28, ArrowLeft: 0x25, ArrowRight: 0x27,
});

const fraction = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/** A validated action from a control message, or null. Nothing else ever reaches a driver. */
function parseAction(msg) {
  if (!msg || typeof msg !== "object") return null;
  if (msg.kind === "tap" && fraction(msg.x) && fraction(msg.y)) {
    const button = msg.button === undefined ? "left" : msg.button;
    return BUTTONS[button] ? { kind: "tap", x: msg.x, y: msg.y, button } : null;
  }
  if (msg.kind === "scroll" && fraction(msg.x) && fraction(msg.y) && Number.isInteger(msg.notches) && msg.notches !== 0) {
    return { kind: "scroll", x: msg.x, y: msg.y, notches: Math.max(-MAX_NOTCHES, Math.min(MAX_NOTCHES, msg.notches)) };
  }
  if (msg.kind === "text" && typeof msg.text === "string" && msg.text.length > 0 && msg.text.length <= MAX_TEXT) {
    return { kind: "text", text: msg.text };
  }
  if (msg.kind === "key" && Object.prototype.hasOwnProperty.call(XDO_KEYS, msg.key)) return { kind: "key", key: msg.key };
  return null;
}

/** xdotool argv for an action on a display of the given size (shell:false). */
function xdotoolArgs(a, size) {
  const px = (f, span) => String(Math.min(span - 1, Math.round(f * (span - 1))));
  const move = () => ["mousemove", px(a.x, size.width), px(a.y, size.height)];
  if (a.kind === "tap") return [...move(), "click", String(BUTTONS[a.button])];
  // Wheel: 4 is up, 5 is down. A positive notch count scrolls down.
  if (a.kind === "scroll") return [...move(), "click", "--repeat", String(Math.abs(a.notches)), a.notches > 0 ? "5" : "4"];
  if (a.kind === "text") return ["type", "--clearmodifiers", "--delay", "8", "--", a.text];
  return ["key", "--clearmodifiers", XDO_KEYS[a.key]];
}

/** One stdin line for the Windows driver. Every field is a number or base64. */
function windowsLine(a, target) {
  const rect = target.rect ? `${target.rect.x}\t${target.rect.y}\t${target.rect.w}\t${target.rect.h}` : "0\t0\t0\t0";
  const at = `${target.monitor}\t${rect}`;
  if (a.kind === "tap") return `t\t${at}\t${a.x}\t${a.y}\t${a.button === "right" ? 1 : 0}`;
  if (a.kind === "scroll") return `s\t${at}\t${a.x}\t${a.y}\t${a.notches}`;
  if (a.kind === "text") return `u\t${Buffer.from(a.text, "utf16le").toString("base64")}`;
  return `k\t${WIN_KEYS[a.key]}`;
}

// Per-monitor DPI aware, so screen bounds are the real pixels ddagrab captures.
const WINDOWS_DRIVER = String.raw`
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public static class RbInput {
  [StructLayout(LayoutKind.Sequential)] struct MI { public int dx, dy; public uint data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KI { public ushort vk, scan; public uint flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct U { [FieldOffset(0)] public MI m; [FieldOffset(0)] public KI k; }
  [StructLayout(LayoutKind.Sequential)] struct IN { public uint type; public U u; }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, IN[] i, int size);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  public static void Aware() { SetProcessDpiAwarenessContext((IntPtr)(-4)); }
  static IN Mouse(int x, int y, uint flags, uint data) { var i = new IN(); i.type = 0; i.u.m.dx = x; i.u.m.dy = y; i.u.m.flags = flags; i.u.m.data = data; return i; }
  static IN Key(ushort vk, ushort scan, uint flags) { var i = new IN(); i.type = 1; i.u.k.vk = vk; i.u.k.scan = scan; i.u.k.flags = flags; return i; }
  static void Send(params IN[] a) { SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(IN))); }
  static System.Drawing.Rectangle Monitor(int i) {
    var all = Screen.AllScreens; // the same order as the display list the phone picks from
    return all[Math.Min(i, all.Length - 1)].Bounds;
  }
  static double D(string s) { return double.Parse(s, CultureInfo.InvariantCulture); }
  static IN Move(string[] p) {
    var b = Monitor(int.Parse(p[1]));
    int rw = int.Parse(p[4]);
    double left = b.X + (rw > 0 ? double.Parse(p[2]) : 0), top = b.Y + (rw > 0 ? double.Parse(p[3]) : 0);
    double w = rw > 0 ? rw : b.Width, h = rw > 0 ? double.Parse(p[5]) : b.Height;
    double x = left + D(p[6]) * (w - 1), y = top + D(p[7]) * (h - 1);
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    return Mouse((int)((x - vx) * 65535 / (vw - 1)), (int)((y - vy) * 65535 / (vh - 1)), 0x0001 | 0x8000 | 0x4000, 0);
  }
  public static string Handle(string line) {
    var p = line.Split('\t');
    if (p[0] == "p") { var b = Monitor(0); return b.Width + "x" + b.Height; }
    if (p[0] == "t") { bool r = p[8] == "1"; Send(Move(p), Mouse(0, 0, r ? 8u : 2u, 0), Mouse(0, 0, r ? 16u : 4u, 0)); }
    else if (p[0] == "s") { Send(Move(p), Mouse(0, 0, 0x0800, unchecked((uint)(-120 * int.Parse(p[8]))))); }
    else if (p[0] == "k") { ushort v = ushort.Parse(p[1]); Send(Key(v, 0, 0), Key(v, 0, 2)); }
    else if (p[0] == "u") { foreach (char c in System.Text.Encoding.Unicode.GetString(Convert.FromBase64String(p[1]))) Send(Key(0, c, 4), Key(0, c, 4 | 2)); }
    return "";
  }
}
'@
[RbInput]::Aware()
while (($l = [Console]::In.ReadLine()) -ne $null) {
  try { $o = [RbInput]::Handle($l); if ($o) { [Console]::Out.WriteLine($o) } } catch { [Console]::Error.WriteLine('input failed') }
}
`;

const encodedDriver = () => Buffer.from(WINDOWS_DRIVER, "utf16le").toString("base64");

/** Where input for this stream goes, or null when this stream takes none. */
function targetFor(kind, ctx) {
  const { platform, cfg, env, which, display, cropRect, screenMethod } = ctx;
  if (kind === "desk") {
    if (platform !== "linux" || !which(["xdotool"], env)) return null;
    return { driver: "xdotool", display: desk.DISPLAY, size: desk.SIZE };
  }
  if (platform !== "win32" || !cfg || cfg.allow_phone_input !== true) return null;
  // The gdigrab fallback films the whole desktop, so a fraction of it is not a place on one monitor.
  if (kind === "screen") return screenMethod === "ddagrab" ? { driver: "windows", monitor: display || 0 } : null;
  if (kind === "window") {
    const rect = cropRect ? cropRect() : null;
    return rect ? { driver: "windows", monitor: rect.monitor, rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h } } : null;
  }
  return null;
}

/** Applies actions one at a time, in order, at a capped rate. close() stops anything it started. */
function createController(initialTarget, deps = {}) {
  let target = initialTarget;
  const spawn = deps.spawn || nodeSpawn;
  const env = deps.env || process.env;
  const log = deps.log || (() => {});
  const now = deps.now || Date.now;
  let child = null;
  let active = null;
  let closed = false;
  let generation = 0;
  let queue = Promise.resolve();
  let windowStart = 0;
  let count = 0;

  const overLimit = () => {
    const t = now();
    if (t - windowStart >= 1000) {
      windowStart = t;
      count = 0;
    }
    count += 1;
    return count > MAX_PER_SECOND;
  };

  const runXdotool = (action) =>
    new Promise((resolve) => {
      const c = spawn("xdotool", xdotoolArgs(action, target.size), { shell: false, windowsHide: true, stdio: "ignore", env: { ...env, DISPLAY: target.display } });
      active = c;
      const finish = () => {
        if (active === c) active = null;
        resolve();
      };
      c.once("error", (err) => {
        log(`remote input: ${err.code || "xdotool failed"}`);
        finish();
      });
      c.once("close", finish);
    });

  const windowsChild = () => {
    if (child) return child;
    child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedDriver()], { shell: false, windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
    child.once("error", (err) => log(`remote input: ${err.code || "driver failed"}`));
    child.once("close", () => {
      child = null;
    });
    child.stdin.on("error", () => {});
    return child;
  };

  const apply = (msg) => {
    if (closed) return false;
    const action = parseAction(msg);
    if (!action || overLimit()) return false;
    const mine = generation;
    if (target.driver === "xdotool") queue = queue.then(() => (closed || mine !== generation ? undefined : runXdotool(action)));
    else windowsChild().stdin.write(`${windowsLine(action, target)}\n`);
    return true;
  };

  const stopProcess = (p) => {
    if (!p) return;
    try {
      p.kill();
    } catch {
      // Already gone.
    }
  };

  /** Drops everything accepted but not finished (the stream paused); later input still works. */
  const cancel = () => {
    generation += 1;
    stopProcess(active);
    active = null;
  };

  const close = () => {
    closed = true;
    cancel();
    stopProcess(child);
    child = null;
  };

  /** The window moved between captures: taps follow the picture the phone now shows. */
  const retarget = (next) => {
    target = next;
  };

  return { apply, cancel, close, retarget };
}

module.exports = { parseAction, xdotoolArgs, windowsLine, targetFor, createController, encodedDriver, WINDOWS_DRIVER, MAX_TEXT, MAX_PER_SECOND };
