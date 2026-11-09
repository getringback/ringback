"use strict";
// Profile pictures for sessions (FOLLOWUPS item 45, laptop side). Contract shared with the app:
//   The phone queues a machine control event (GET /v1/machine/control) of type "avatar":
//     { type: "avatar", request_id, session_id, generator: "claude" | "codex" | "agy", style, count: 3 }
//   The helper makes `count` (at most 3) PNGs of 512x512 and posts each one to
//     POST /v1/sessions/{session_id}/avatar-options { request_id, generator, png_base64 }
//   and on failure { request_id, generator, error } (once, with the reason).
// Generators, each through that tool's own CLI and login (spends its plan, only on their tap):
//   claude: `claude -p` draws SVGs (no tools, safe mode: no hooks, plugins or MCP, nothing saved),
//           rendered to PNG locally.
//   codex:  `codex exec` with its built-in image generation; images saved in the run folder, or
//           found in $CODEX_HOME/generated_images/<thread id>.
//   agy:    `agy -p` with its own image generation, saved in the run folder.
// Rendering and resizing to 512x512 use a headless Chromium browser already on the machine (Edge,
// Chrome or Brave; config `avatar_browser` overrides). The picture is shown through an <img>, so an
// SVG never runs scripts or loads anything. No timeouts on the AI runs; the browser has a guard.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const sessions = require("./sessions.js");
const clients = require("./clients.js");
const { helperEnv } = require("./helper-lock.js");

const GENERATORS = Object.freeze(["claude", "codex", "agy"]);
const SIZE = 512;
const MAX_COUNT = 3;
const MAX_STYLE = 300;
const MAX_OUT = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_PNG_BYTES = 3 * 1024 * 1024;
// A guard against a hung headless browser (not an AI call).
const RENDER_GUARD_MS = 60 * 1000;
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const IMAGE_FILE = /\.(png|jpe?g|webp)$/i;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const clip = (t, n) => String(t || "").replace(/\s+/g, " ").trim().slice(0, n);

/** The validated request, or { error } when it cannot be served. */
function parseRequest(ev) {
  const sid = sessions.safeId(ev && ev.session_id);
  if (!sid) return { error: "no session_id" };
  const generator = String((ev && ev.generator) || "").trim();
  if (!GENERATORS.includes(generator)) return { error: `unknown generator ${generator || "(none)"}`, sid };
  const rid = String((ev && ev.request_id) || "");
  const requestId = REQUEST_ID.test(rid) ? rid : `av_${Date.now()}`;
  const count = Math.max(1, Math.min(MAX_COUNT, Math.floor(Number(ev.count) || MAX_COUNT)));
  return { sid, generator, requestId, count, style: clip(ev.style, MAX_STYLE) };
}

/** What the picture is of: the session's name and project from this machine's record. */
function subjectOf(sid, ev = {}) {
  const rec = sessions.readSession(sid) || {};
  const name = clip(rec.title || rec.auto_title || ev.name || ev.title || "", 120);
  const project = clip(rec.project || ev.project || "", 120);
  return { name: name || project || "an AI coding session", project };
}

function describe(subject, style) {
  const about = subject.project && subject.project !== subject.name ? `"${subject.name}" (project folder "${subject.project}")` : `"${subject.name}"`;
  const look = style ? `Style: ${style}.` : "Style: friendly, bold, simple, readable at small sizes.";
  return `a square profile picture (avatar) for an AI agent session named ${about}. ${look} Centered subject, plain or simple background, no text or letters, no words.`;
}

function claudePrompt(subject, style, count) {
  return (
    `Draw ${count} different SVG images, each ${describe(subject, style)} ` +
    `Each SVG: viewBox="0 0 512 512", width="512" height="512", only shapes, paths and gradients, no <text>, no <image>, no scripts, no external links. ` +
    `Reply with the ${count} SVG documents one after another and nothing else.`
  );
}

function imagePrompt(subject, style, count) {
  return (
    `Use your image generation tool to create ${count} different images, each ${describe(subject, style)} ` +
    `Save them as PNG files avatar-1.png to avatar-${count}.png in the current folder. Do nothing else: no other files, no commands beyond saving these images.`
  );
}

/** The SVG documents in a model reply, without anything that could run or load. */
function extractSvgs(text, max = MAX_COUNT) {
  const found = String(text || "").match(/<svg[\s\S]*?<\/svg>/gi) || [];
  return found.slice(0, max).map(cleanSvg);
}

function cleanSvg(svg) {
  let out = String(svg)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, "")
    .replace(/(href\s*=\s*)("|')\s*(?!#)[^"']*\2/gi, '$1"#"');
  if (!/xmlns=/.test(out)) out = out.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return out;
}

/** Runs a CLI to the end (no timeout: it is an AI run), collecting stdout. */
function runCli(argv, opts, deps = {}) {
  const run = deps.spawn || spawn;
  const [cmd, ...args] = argv;
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = run(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      resolve({ code: -1, out: "", error: err.message });
      return;
    }
    child.stdout.on("data", (c) => {
      if (out.length < MAX_OUT) out += c.toString("utf8");
    });
    child.stderr.on("data", () => {});
    child.on("error", (err) => resolve({ code: -1, out, error: err.message }));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const runEnv = (env) => ({ ...helperEnv(env || process.env), RINGBACK_HELPER_RUN: "1" });

function claudeResult(stdout) {
  const result = clients.claudeResult(stdout);
  return result === null ? String(stdout || "") : result;
}

/** claude: SVG files in `dir`. */
async function generateClaude(job, deps) {
  const argv = [...deps.claudeCommand, "-p", claudePrompt(job.subject, job.style, job.count), "--output-format", "json", "--tools", "", "--safe-mode", "--no-session-persistence"];
  const res = await runCli(argv, { cwd: job.dir, env: runEnv(deps.env) }, deps);
  if (res.error) throw new Error(`claude could not start: ${res.error}`);
  const svgs = extractSvgs(claudeResult(res.out), job.count);
  if (!svgs.length) throw new Error(res.code ? `claude exited ${res.code}` : "claude drew no SVG");
  return svgs.map((svg, i) => {
    const file = path.join(job.dir, `avatar-${i + 1}.svg`);
    fs.writeFileSync(file, svg, "utf8");
    return file;
  });
}

/** Image files a run left in `dir`, by name. */
function imagesIn(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => IMAGE_FILE.test(n))
      .sort()
      .map((n) => path.join(dir, n))
      .filter((f) => {
        const st = fs.statSync(f);
        return st.isFile() && st.size > 0 && st.size <= MAX_IMAGE_BYTES;
      });
  } catch {
    return [];
  }
}

/** The thread id from `codex exec --json` events, or "". */
function codexThreadId(stdout) {
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const m = line.match(/"thread_id"\s*:\s*"([A-Za-z0-9-]{8,80})"/);
    if (m) return m[1];
  }
  return "";
}

const codexHome = (env = process.env) => env.CODEX_HOME || path.join(os.homedir(), ".codex");

async function generateCodex(job, deps) {
  const prompt = imagePrompt(job.subject, job.style, job.count);
  const argv = [...clients.codexCommand(deps.cfg, deps.env), "exec", "--json", "--skip-git-repo-check", "-s", "workspace-write", "-C", job.dir, "--", prompt];
  const res = await runCli(argv, { cwd: job.dir, env: runEnv(deps.env) }, deps);
  if (res.error) throw new Error(`codex could not start: ${res.error}`);
  let files = imagesIn(job.dir);
  const thread = codexThreadId(res.out);
  if (files.length < job.count && thread) files = [...files, ...imagesIn(path.join(codexHome(deps.env), "generated_images", thread))];
  if (!files.length) throw new Error(res.code ? `codex exited ${res.code}` : "codex made no image");
  return files.slice(0, job.count);
}

async function generateAgy(job, deps) {
  const prompt = imagePrompt(job.subject, job.style, job.count);
  // Audit M6: never --dangerously-skip-permissions on phone-supplied text; agy runs sandboxed in
  // the empty run folder (an image tool that needs a yes then fails, and the phone hears so).
  const argv = [...clients.agyCommand(deps.cfg, deps.env), "--add-dir", job.dir, "--sandbox", "-p", prompt];
  const res = await runCli(argv, { cwd: job.dir, env: runEnv(deps.env) }, deps);
  if (res.error) throw new Error(`agy could not start: ${res.error}`);
  const files = imagesIn(job.dir);
  if (!files.length) throw new Error(res.code ? `agy exited ${res.code}` : "agy made no image");
  return files.slice(0, job.count);
}

const GENERATE = { claude: generateClaude, codex: generateCodex, agy: generateAgy };

/** A headless Chromium browser on this machine, or null. */
function findBrowser(cfg = {}, env = process.env, exists = fs.existsSync, platform = process.platform) {
  if (typeof cfg.avatar_browser === "string" && cfg.avatar_browser && exists(cfg.avatar_browser)) return cfg.avatar_browser;
  const win = () => {
    const pf = [env.ProgramFiles || "C:\\Program Files", env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", env.LOCALAPPDATA || ""].filter(Boolean);
    const rel = ["Microsoft\\Edge\\Application\\msedge.exe", "Google\\Chrome\\Application\\chrome.exe", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"];
    return rel.flatMap((r) => pf.map((p) => path.win32.join(p, r)));
  };
  const mac = () => [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  const unix = () =>
    String(env.PATH || "")
      .split(path.delimiter)
      .filter(Boolean)
      .flatMap((d) => ["chromium", "chromium-browser", "google-chrome", "microsoft-edge", "brave-browser"].map((n) => path.join(d, n)));
  const list = platform === "win32" ? win() : platform === "darwin" ? [...mac(), ...unix()] : unix();
  return list.find((p) => exists(p)) || null;
}

const fileUrl = (p) => `file:///${path.resolve(p).replace(/\\/g, "/").replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/").replace(/^([A-Za-z])%3A/, "$1:")}`;

/** The page that shows one picture at 512x512 (an <img>: SVG scripts and loads never run). */
function pageFor(imageName) {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;width:${SIZE}px;height:${SIZE}px;overflow:hidden;background:transparent}` +
    `img{display:block;width:${SIZE}px;height:${SIZE}px;object-fit:cover}</style></head><body><img src="${encodeURIComponent(imageName)}"></body></html>`
  );
}

function browserArgs(profile, out, url) {
  return [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--hide-scrollbars",
    "--mute-audio",
    `--user-data-dir=${profile}`,
    `--window-size=${SIZE},${SIZE}`,
    "--default-background-color=00000000",
    `--screenshot=${out}`,
    url,
  ];
}

/** Width and height from a PNG header, or null. */
function pngSize(buf) {
  if (!buf || buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Renders one picture file to a 512x512 PNG with the headless browser; resolves to the PNG bytes. */
function renderPng(browser, image, dir, index, deps = {}) {
  const run = deps.spawn || spawn;
  const page = path.join(dir, `page-${index}.html`);
  const out = path.join(dir, `out-${index}.png`);
  fs.writeFileSync(page, pageFor(path.basename(image)), "utf8");
  if (path.dirname(path.resolve(image)) !== path.resolve(dir)) fs.copyFileSync(image, path.join(dir, path.basename(image)));
  return new Promise((resolve, reject) => {
    let child;
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      if (err) return reject(err);
      let buf;
      try {
        buf = fs.readFileSync(out);
      } catch {
        return reject(new Error("the browser wrote no picture"));
      }
      const size = pngSize(buf);
      if (!size || size.width !== SIZE || size.height !== SIZE || buf.length > MAX_PNG_BYTES) return reject(new Error("the rendered picture is not a 512x512 PNG"));
      resolve(buf);
    };
    const guard = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      finish(new Error("the browser did not finish"));
    }, deps.guardMs || RENDER_GUARD_MS);
    try {
      child = run(browser, browserArgs(path.join(dir, "profile"), out, fileUrl(page)), { stdio: "ignore", windowsHide: true });
    } catch (err) {
      finish(new Error(`could not start the browser: ${err.message}`));
      return;
    }
    child.on("error", (err) => finish(new Error(`could not start the browser: ${err.message}`)));
    child.on("close", () => finish(null));
  });
}

async function post(deps, job, body) {
  try {
    await deps.api.avatarOption(deps.cfg, job.sid, { request_id: job.requestId, generator: job.generator, ...body });
    return true;
  } catch (err) {
    deps.log(`avatar ${job.requestId}: post failed: ${err.message}`);
    return false;
  }
}

/**
 * Serves one avatar control event: generate, render, post each PNG (or the error). deps: cfg,
 * api, env, log, claudeCommand, handled (Set of request ids), and for tests spawn, browser,
 * generate, render, tmpdir. Resolves to { posted, error? }.
 */
async function handleAvatar(ev, deps) {
  const log = deps.log || (() => {});
  const req = parseRequest(ev);
  if (req.error) {
    log(`avatar: ${req.error}`);
    if (req.sid) await post({ ...deps, log }, { ...req, requestId: String((ev && ev.request_id) || ""), generator: String((ev && ev.generator) || "") }, { error: req.error });
    return { posted: 0, error: req.error };
  }
  if (deps.handled) {
    if (deps.handled.has(req.requestId)) return { posted: 0, error: "already handled" };
    deps.handled.add(req.requestId);
  }
  const ctx = { ...deps, log };
  const job = { ...req, subject: subjectOf(req.sid, ev), dir: fs.mkdtempSync(path.join(deps.tmpdir || os.tmpdir(), "ringback-avatar-")) };
  log(`avatar ${job.requestId}: ${job.generator} x${job.count} for ${job.sid}`);
  try {
    const browser = deps.browser || findBrowser(deps.cfg, deps.env);
    if (!browser && !deps.render) throw new Error("no headless browser (Edge, Chrome or Brave) found to render the picture");
    const files = await (deps.generate || GENERATE[job.generator])(job, ctx);
    let posted = 0;
    let lastError = "";
    for (let i = 0; i < files.length && posted < job.count; i += 1) {
      try {
        const png = await (deps.render || renderPng)(browser, files[i], job.dir, i + 1, ctx);
        if (await post(ctx, job, { png_base64: png.toString("base64") })) posted += 1;
      } catch (err) {
        lastError = err.message;
        log(`avatar ${job.requestId}: picture ${i + 1}: ${err.message}`);
      }
    }
    if (!posted) throw new Error(lastError || "no picture came out");
    if (posted < job.count) await post(ctx, job, { error: `only ${posted} of ${job.count} pictures came out` });
    log(`avatar ${job.requestId}: posted ${posted}`);
    return { posted };
  } catch (err) {
    log(`avatar ${job.requestId}: ${err.message}`);
    await post(ctx, job, { error: err.message });
    return { posted: 0, error: err.message };
  } finally {
    fs.rmSync(job.dir, { recursive: true, force: true });
  }
}

module.exports = {
  GENERATORS,
  SIZE,
  parseRequest,
  subjectOf,
  claudePrompt,
  imagePrompt,
  extractSvgs,
  cleanSvg,
  codexThreadId,
  imagesIn,
  findBrowser,
  fileUrl,
  pageFor,
  browserArgs,
  pngSize,
  renderPng,
  generateClaude,
  generateCodex,
  generateAgy,
  handleAvatar,
};
