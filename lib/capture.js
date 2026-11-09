"use strict";
// ffmpeg argv builders for screen, desk and window streams (spec 04 sections 2.2 to 2.4).
// Pure functions: every value is an integer from a fixed preset table or a validated id, and
// the argv is spawned with shell:false. probe() reads versions and filter lists only; it never
// opens a capture device.

const PRESETS = Object.freeze({
  low: Object.freeze({ name: "low", width: 960, height: 540, fps: 5, kbps: 400, max_kbps: 600 }),
  normal: Object.freeze({ name: "normal", width: 1280, height: 720, fps: 10, kbps: 1200, max_kbps: 1500 }),
  sharp: Object.freeze({ name: "sharp", width: 1920, height: 1080, fps: 10, kbps: 2500, max_kbps: 3000 }),
});

/** The fixed preset for a name or a {name} object; anything else is "normal". */
function presetFor(p) {
  const name = typeof p === "string" ? p : p && p.name;
  return { ...(PRESETS[name] || PRESETS.normal) };
}

const int = (v, what, min = 0, max = 1e9) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max || String(v).trim() !== String(n)) throw new Error(`bad ${what}`);
  return n;
};

const COMMON_IN = ["-hide_banner", "-loglevel", "error", "-nostdin"];

/** Never upscale, keep aspect ratio, even sizes. */
const scale = (p) => `scale='min(${p.width},iw)':'min(${p.height},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;

/** Encoder + fragmented MP4 to stdout. `vf` is the filter chain (empty: scale + yuv420p only). */
function encodeArgs(p, vf) {
  const chain = vf || `${scale(p)},format=yuv420p`;
  return [
    "-vf", chain,
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "baseline", "-bf", "0",
    "-g", String(2 * p.fps), "-sc_threshold", "0",
    "-b:v", `${p.kbps}k`, "-maxrate", `${p.max_kbps}k`, "-bufsize", `${p.max_kbps}k`,
    "-an", "-f", "mp4", "-movflags", "empty_moov+default_base_moof+frag_every_frame", "-flush_packets", "1", "pipe:1",
  ];
}

function ddagrabInput(output, fps, crop) {
  let src = `ddagrab=output_idx=${output}:framerate=${fps}:draw_mouse=1`;
  if (crop) src += `:offset_x=${crop.x}:offset_y=${crop.y}:video_size=${crop.w}x${crop.h}`;
  return ["-f", "lavfi", "-i", src];
}

const DDA_VF = (p) => `hwdownload,format=bgra,${scale(p)},format=yuv420p`;

/** The real screen: win32 ddagrab (or gdigrab fallback), darwin avfoundation, linux x11grab. */
function screenArgs({ platform, method, display = 0, preset, x11 }) {
  const p = presetFor(preset);
  const d = int(display, "display", 0, 16);
  if (platform === "win32" && method === "ddagrab") return [...COMMON_IN, ...ddagrabInput(d, p.fps), ...encodeArgs(p, DDA_VF(p))];
  if (platform === "win32") return [...COMMON_IN, "-f", "gdigrab", "-framerate", String(p.fps), "-draw_mouse", "1", "-i", "desktop", ...encodeArgs(p)];
  if (platform === "darwin") {
    return [...COMMON_IN, "-f", "avfoundation", "-capture_cursor", "1", "-framerate", "30", "-i", `${d}:none`, ...encodeArgs(p, `fps=${p.fps},${scale(p)},format=yuv420p`)];
  }
  const disp = x11Display(x11 || ":0");
  return [...COMMON_IN, "-framerate", String(p.fps), "-f", "x11grab", "-draw_mouse", "1", "-i", disp, ...encodeArgs(p)];
}

function x11Display(v) {
  if (!/^:\d{1,3}$/.test(String(v))) throw new Error("bad display");
  return String(v);
}

/** The Linux desk (Xvfb :5, 1920x1080), exactly as the dex-desk rec5.sh. */
function deskArgs({ display = ":5", preset }) {
  const p = presetFor(preset);
  const disp = x11Display(display);
  return [...COMMON_IN, "-video_size", "1920x1080", "-framerate", String(p.fps), "-f", "x11grab", "-draw_mouse", "1", "-i", disp, ...encodeArgs(p)];
}

/** One window (FOLLOWUPS 22b): a ddagrab crop of its rect, or gdigrab by hwnd. */
function windowArgs({ method, rect, hwnd, preset }) {
  const p = presetFor(preset);
  if (method === "ddagrab-crop") {
    const crop = { x: int(rect.x, "rect"), y: int(rect.y, "rect"), w: int(rect.w, "rect", 16), h: int(rect.h, "rect", 16) };
    return [...COMMON_IN, ...ddagrabInput(int(rect.monitor, "display", 0, 16), p.fps, crop), ...encodeArgs(p, DDA_VF(p))];
  }
  const h = int(hwnd, "hwnd", 1, Number.MAX_SAFE_INTEGER);
  return [...COMMON_IN, "-f", "gdigrab", "-framerate", String(p.fps), "-draw_mouse", "1", "-i", `hwnd=${h}`, ...encodeArgs(p)];
}

/** One remux at the end of a machine recording: no re-encode, moov at the front. */
function remuxArgs(input, output) {
  return [...COMMON_IN, "-y", "-i", input, "-c", "copy", "-movflags", "+faststart", output];
}

/** ffmpeg version, ddagrab and libx264 presence. `exec(cmd, args)` resolves stdout. */
async function probe({ exec, ffmpeg = ["ffmpeg"] }) {
  const [cmd, ...pre] = ffmpeg;
  const run = async (args) => {
    try {
      return String(await exec(cmd, [...pre, "-hide_banner", ...args]));
    } catch {
      return null;
    }
  };
  const version = await run(["-version"]);
  const m = version && /ffmpeg version (\S+)/.exec(version);
  if (!m) return { ffmpeg: null, ddagrab: false, libx264: false };
  const filters = (await run(["-filters"])) || "";
  const encoders = (await run(["-encoders"])) || "";
  return { ffmpeg: m[1], ddagrab: /\bddagrab\b/.test(filters), libx264: /\blibx264\b/.test(encoders) };
}

module.exports = { PRESETS, presetFor, encodeArgs, screenArgs, deskArgs, windowArgs, remuxArgs, probe, scale };
