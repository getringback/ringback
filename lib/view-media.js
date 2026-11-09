"use strict";
// Paths in the live view and the media files the phone may open inline (FOLLOWUPS item 58).
// A file is served only when ALL hold:
//  - the session's transcript printed that path on this stream (the phone sends it back as is),
//  - its real path is inside the user's home folder,
//  - no folder or file on the way starts with "." (.ssh, .ringback, .aws, .env, ...),
//  - it is an image, mp4 or pdf under the size cap of its kind.
// Images are downscaled for the phone with ffmpeg when it is there (the original otherwise).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn: nodeSpawn } = require("child_process");

const KINDS = {
  ".png": ["image", "image/png"],
  ".jpg": ["image", "image/jpeg"],
  ".jpeg": ["image", "image/jpeg"],
  ".webp": ["image", "image/webp"],
  ".gif": ["image", "image/gif"],
  ".mp4": ["video", "video/mp4"],
  ".pdf": ["pdf", "application/pdf"],
};
const CAPS = { image: 10 * 1024 * 1024, video: 50 * 1024 * 1024, pdf: 20 * 1024 * 1024 };
const MAX_SIDE = 1600;
const MAX_PATHS = 12;
const MAX_PATH_CHARS = 1024;

const ext = (p) => path.extname(String(p)).toLowerCase();
/** "image" | "video" | "pdf" | null for a path, by its extension. */
const mediaKind = (p) => (KINDS[ext(p)] ? KINDS[ext(p)][0] : null);

const WIN_ABS = /^[A-Za-z]:[\\/]/;
const looksLikePath = (s) =>
  s.length > 2 && s.length <= MAX_PATH_CHARS && !s.startsWith("...") && !/^[a-z]+:\/\//i.test(s) && !/[\r\n<>|*?"]/.test(s) && (WIN_ABS.test(s) || s.startsWith("/") || s.startsWith("~/") || (/[\\/]/.test(s) && /\.[A-Za-z0-9]{1,5}$/.test(s)) || Boolean(mediaKind(s)));

const trimPunct = (s) => s.replace(/^[(\[{'"]+/, "").replace(/[)\]}'",;:.!]+$/, "");

/**
 * Path-like strings printed in `text`: `backticked` and "quoted" spans first (they may hold
 * spaces), then bare absolute paths and bare media file names. At most 12, in order.
 */
function extractPaths(text) {
  const s = String(text || "");
  const out = [];
  const add = (raw) => {
    const p = trimPunct(String(raw).trim());
    if (p && looksLikePath(p) && !out.includes(p) && out.length < MAX_PATHS) out.push(p);
  };
  for (const m of s.matchAll(/`([^`\n]{3,1024})`/g)) add(m[1]);
  for (const m of s.matchAll(/"([^"\n]{3,1024})"/g)) add(m[1]);
  const bare = s.replace(/`[^`\n]*`/g, " ").replace(/"[^"\n]*"/g, " ");
  // Whole whitespace-separated tokens only: never a suffix of one ("/chart.png" out of
  // "out/chart.png", "v.mp4" out of "/x/v.mp4"). Absolute paths, relative paths with a folder and an
  // extension, and bare media file names.
  for (const raw of bare.split(/\s+/)) {
    const tok = trimPunct(raw);
    if (!tok || /[<>|*?"'`]/.test(tok)) continue;
    const absolute = WIN_ABS.test(tok) || tok.startsWith("/") || tok.startsWith("~/");
    const relative = /[\\/]/.test(tok) && /\.[A-Za-z0-9]{1,5}$/.test(tok);
    if (absolute || relative || /\.(?:png|jpe?g|webp|gif|mp4|pdf)$/i.test(tok)) add(tok);
  }
  return out;
}

/** The chips a line carries: [{ path, media }] for each path (media null for other files). */
const chips = (paths) => paths.map((p) => ({ path: p, media: mediaKind(p) }));

function realOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Checks a requested path. Returns { file, kind, mime, size } or { error } (a short reason the
 * phone may show). `allowed` is the set of path strings this stream sent.
 */
function checkMedia(requested, { allowed, cwd = "", home = os.homedir(), statSync = fs.statSync } = {}) {
  const raw = String(requested || "");
  if (!allowed || !allowed.has(raw)) return { error: "That file was not shown in this session" };
  const k = KINDS[ext(raw)];
  if (!k) return { error: "Only images, mp4 videos and pdfs open here" };
  const expanded = raw.startsWith("~/") ? path.join(home, raw.slice(2)) : raw;
  const abs = path.isAbsolute(expanded) || WIN_ABS.test(expanded) ? expanded : path.resolve(cwd || home, expanded);
  const real = realOrNull(abs);
  const root = realOrNull(home);
  if (!real || !root) return { error: "File not found" };
  const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  const rel = path.relative(norm(root), norm(real));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return { error: "Only files inside the home folder open here" };
  if (rel.split(/[\\/]+/).some((seg) => seg.startsWith("."))) return { error: "Hidden folders and files never open here" };
  if (!KINDS[ext(real)] || KINDS[ext(real)][0] !== k[0]) return { error: "Only images, mp4 videos and pdfs open here" };
  let st;
  try {
    st = statSync(real);
  } catch {
    return { error: "File not found" };
  }
  if (!st.isFile()) return { error: "Not a file" };
  if (st.size > CAPS[k[0]]) return { error: `Too big to open on the phone (over ${Math.round(CAPS[k[0]] / 1048576)} MB)` };
  return { file: real, kind: k[0], mime: k[1], size: st.size };
}

/** ffmpeg argv that turns one image into a JPEG at most MAX_SIDE px on its long side, on stdout. */
function downscaleArgs(file) {
  const scale = `scale='if(gt(iw,ih),min(${MAX_SIDE},iw),-2)':'if(gt(iw,ih),-2,min(${MAX_SIDE},ih))'`;
  return ["-hide_banner", "-loglevel", "error", "-i", file, "-frames:v", "1", "-vf", scale, "-q:v", "4", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"];
}

/** The bytes to send for a checked file: images downscaled (gif kept, for its animation). */
function loadMedia(checked, { ffmpeg = null, spawn = nodeSpawn, readFile = fs.promises.readFile } = {}) {
  const original = () => readFile(checked.file).then((buf) => ({ buf, mime: checked.mime }));
  if (checked.kind !== "image" || checked.mime === "image/gif" || !ffmpeg || !ffmpeg.length) return original();
  return new Promise((resolve) => {
    const [cmd, ...pre] = ffmpeg;
    let child;
    try {
      child = spawn(cmd, [...pre, ...downscaleArgs(checked.file)], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(original());
      return;
    }
    const parts = [];
    let size = 0;
    child.stdout.on("data", (c) => {
      size += c.length;
      if (size <= CAPS.image) parts.push(c);
    });
    // A downscale that hangs must not block the stream's media queue: send the original instead.
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      resolve(original());
    }, 30000);
    child.on("error", () => (clearTimeout(timer), resolve(original())));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && size > 0 && size <= CAPS.image) resolve({ buf: Buffer.concat(parts), mime: "image/jpeg" });
      else resolve(original());
    });
  });
}

module.exports = { extractPaths, chips, mediaKind, checkMedia, loadMedia, downscaleArgs, CAPS, MAX_SIDE };
