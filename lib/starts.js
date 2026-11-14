"use strict";
// Starting a new Claude Code session that the user asked for on their phone (FOLLOWUPS items 21, 21b,
// 25). The request rides on the helper's machine inbox answer (the helper only connects OUT). The
// helper checks it again here (folder under the home folder, never on vast.ai, a restricted host only when
// allowed, at most 3 per 10 minutes) and opens a VISIBLE terminal: a Windows Terminal window, or
// a Terminal window on macOS, or a named tmux session on Linux. The SessionStart registration carries the start
// id (state/starts/<id>.json, matched by folder), so the phone knows which session to call.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { configDir } = require("./config.js");
const { listSessions } = require("./sessions.js");
const guard = require("./guard.js");
const permissions = require("./permissions.js");
const { checkTrust } = require("./trust.js");
const { helperEnv, SESSION_MARKERS, isSessionMarker } = require("./helper-lock.js");
const connectTool = require("./connect-tool.js");

const MAX_PROMPT = 2000;
const CLAIM_MS = 3 * 60 * 1000;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 3;
const MAX_FOLDERS = 12;
const FORBIDDEN = /[";|&<>`^%!*?\u0000-\u001f]/;
const MODEL = /^[A-Za-z0-9.[\]-]{1,40}$/;
const START_ID = /^st_[A-Za-z0-9_-]{1,32}$/;

const startsDir = () => path.join(configDir(), "state", "starts");
const norm = (p) => (process.platform === "win32" ? path.resolve(String(p)).toLowerCase() : path.resolve(String(p)));

/** Plain text a terminal command line can carry: no quotes, separators, variables or control characters. */
function cleanPrompt(p) {
  return String(p || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[";|&<>`^%!$\u0000-\u001f]/g, "")
    .replace(/ +/g, " ")
    .trim()
    .slice(0, MAX_PROMPT);
}

/** `folder` resolved and checked: an existing directory inside `home`. {ok, real} or {ok:false, why}. */
function checkFolder(folder, home = os.homedir()) {
  const raw = String(folder || "").trim();
  if (!raw || raw.length > 1024 || FORBIDDEN.test(raw)) return { ok: false, why: "That folder path is not allowed." };
  const expanded = raw === "~" ? home : raw.startsWith("~/") || raw.startsWith("~\\") ? path.join(home, raw.slice(2)) : raw;
  if (!path.isAbsolute(expanded)) return { ok: false, why: "Use a full folder path." };
  let real;
  try {
    real = fs.realpathSync(path.resolve(expanded));
    if (!fs.statSync(real).isDirectory()) return { ok: false, why: "That is not a folder." };
  } catch {
    return { ok: false, why: "That folder does not exist on this computer." };
  }
  let homeReal = home;
  try {
    homeReal = fs.realpathSync(home);
  } catch {
    // Home always exists; keep the given path.
  }
  const r = norm(real);
  const h = norm(homeReal);
  if (r !== h && !r.startsWith(h.endsWith(path.sep) ? h : h + path.sep)) {
    return { ok: false, why: "Sessions can only start in a folder inside your home folder." };
  }
  return { ok: true, real };
}

/** Why this machine must not start sessions, or null. */
function refusal(cfg, env = process.env, hostname = os.hostname()) {
  if (cfg && cfg.allow_session_start === false) return "Starting sessions from the phone is turned off on this computer.";
  // The one guard (lib/guard.js, BUILD_PLAN A7): vast.ai and the never-join marker.
  const g = guard.detectHere({ env, hostname });
  if (g.vast || env.VAST_TCP_PORT_22 || fs.existsSync("/.vast_containerlabel")) return "Sessions are never started on vast.ai.";
  if (g.never_join) return "This machine is marked never-join for Ringback.";
  if (/dex-box/i.test(String(hostname)) && !(cfg && cfg.allow_session_start === true)) {
    return "This machine does not start sessions from the phone unless its Ringback config allows it.";
  }
  return null;
}

/**
 * claude's own arguments: the permission mode (item 50h), the model when asked for (item 25),
 * then the first request.
 */
function claudeArgs(prompt, model, mode = null) {
  const perm = permissions.claudeArgs({ mode });
  const m = model && MODEL.test(String(model)) ? ["--model", String(model)] : [];
  // Never a flag: a request starting with "-" would be read by claude as an option.
  const p = cleanPrompt(prompt).replace(/^-+\s*/, "");
  return [...perm, ...m, ...(p ? [p] : [])];
}

// Modes the phone may choose by itself (audit C2): never above Claude Code's own prompting.
const PHONE_SAFE_MODES = new Set(["default", "plan", "acceptEdits"]);

/**
 * The mode a phone-started session gets: the one the phone asked for, else the one their other
 * sessions on THIS computer start with (lib/permissions.js usualStartMode); null: no flag,
 * settings' defaultMode. The phone can never raise it above the local user's own setting: a
 * phone-asked auto / dontAsk / bypassPermissions counts only when the user wrote
 * `"allow_phone_bypass": true` in ~/.ringback/config.json on this computer; otherwise it is
 * ignored and the local usual mode decides.
 */
function startMode(requested, records, now = Date.now(), cfg = {}) {
  const asked = permissions.claudeMode(requested);
  if (asked && (PHONE_SAFE_MODES.has(asked) || (cfg && cfg.allow_phone_bypass === true))) return asked;
  return permissions.usualStartMode(records, now) || null;
}

/**
 * The environment of a phone-started session: no "inside a Claude Code session" markers (an
 * inherited CLAUDE_CODE_CHILD_SESSION turns off its transcript, item 50g), and the documented
 * CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1 so it is saved like any top-level session.
 */
const startEnv = (env = process.env) => ({ ...helperEnv(env), CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1" });

const shortId = (id) => String(id).replace(/^st_/, "").replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || "new";
// Single-quoted for a POSIX shell: nothing inside expands. The prompt has no quotes left anyway.
const sq = (a) => `'${String(a).replace(/'/g, "")}'`;
const shellQuote = (a) => `'${String(a).replace(/'/g, "'\\''")}'`;
const TERMINAL_SCRIPT = `on run argv
  tell application "Terminal"
    activate
    do script (item 1 of argv)
  end tell
end run`;

/** How to open the session on this platform: {cmd, args, opts}. */
function launchPlan(platform, folder, command, prompt, model, startId, launch = {}) {
  const argv = [...command, ...claudeArgs(prompt, model, launch.mode)];
  const env = startEnv(launch.env);
  if (platform === "win32") {
    return { cmd: "wt.exe", args: ["-w", "new", "-d", folder, "--title", "Ringback", ...argv], opts: { detached: true, stdio: "ignore", env } };
  }
  // Terminal types the line into the user's login shell, which may be fish, where a backslash
  // inside single quotes escapes the closing quote. A folder with one goes to tmux instead, and
  // backslashes are dropped from the arguments.
  if (platform === "darwin" && process.platform !== "win32" && String(folder).includes("\\")) {
    return { ...launchPlan("linux", folder, command, prompt, model, startId, launch), waitForExit: true };
  }
  if (platform === "darwin") {
    // Terminal has its own environment, so clear inherited session markers there too.
    const markers = new Set([...SESSION_MARKERS, ...Object.keys(launch.env || process.env).filter(isSessionMarker)]);
    const unset = [...markers].flatMap((k) => ["-u", k]);
    const line = `cd ${shellQuote(folder)} && exec ${["/usr/bin/env", ...unset, "CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1", ...argv.map((x) => String(x).replace(/\\/g, ""))].map(shellQuote).join(" ")}`;
    return {
      cmd: "/usr/bin/osascript", args: ["-e", TERMINAL_SCRIPT, "--", line],
      opts: { stdio: "ignore", env, timeout: 35000 }, waitForExit: true,
    };
  }
  return {
    cmd: "tmux",
    args: ["new-session", "-d", "-s", `rb-${shortId(startId)}`, "-c", folder, argv.map(sq).join(" ")],
    opts: { detached: true, stdio: "ignore", env },
  };
}

/** Windows without Windows Terminal: a plain console window via `start`. */
function fallbackPlan(folder, command, prompt, model, launch = {}) {
  const argv = [...command, ...claudeArgs(prompt, model, launch.mode)].map((a) => `"${String(a).replace(/"/g, "")}"`);
  return {
    cmd: "cmd.exe",
    args: ["/c", "start", '"Ringback"', "/D", `"${folder}"`, ...argv],
    opts: { detached: true, stdio: "ignore", windowsVerbatimArguments: true, env: startEnv(launch.env) },
  };
}

/** Opens `plan`; short-lived launchers must exit successfully before reporting a start. */
function spawnDetached(plan, run = spawn) {
  return new Promise((resolve) => {
    let child;
    try {
      child = run(plan.cmd, plan.args, plan.opts);
    } catch {
      resolve(false);
      return;
    }
    child.once("error", () => resolve(false));
    if (plan.waitForExit) {
      child.once("exit", (code) => resolve(code === 0));
      return;
    }
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

// Start records: matched to the new session's SessionStart by its folder.

function recordStart(id, folder, now = Date.now()) {
  if (!START_ID.test(String(id))) return;
  fs.mkdirSync(startsDir(), { recursive: true });
  fs.writeFileSync(path.join(startsDir(), `${id}.json`), JSON.stringify({ start_id: id, folder: norm(folder), at: now }));
}

function readRecords() {
  try {
    return fs
      .readdirSync(startsDir())
      .filter((n) => /^st_.*\.json$/.test(n))
      .map((n) => {
        try {
          return { file: path.join(startsDir(), n), ...JSON.parse(fs.readFileSync(path.join(startsDir(), n), "utf8")) };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** The start id for a session that just started in `cwd` (newest fresh record), taken once; else null. */
function takeStartFor(cwd, now = Date.now()) {
  const here = norm(cwd || "");
  const mine = readRecords()
    .filter((r) => {
      if (now - Number(r.at) > CLAIM_MS) {
        fs.rmSync(r.file, { force: true });
        return false;
      }
      return r.folder === here;
    })
    .sort((a, b) => b.at - a.at);
  const hit = mine[0];
  if (!hit) return null;
  fs.rmSync(hit.file, { force: true });
  return START_ID.test(String(hit.start_id)) ? hit.start_id : null;
}

// Rate limit on the computer itself (the phone has its own): state/starts/recent.json.

function allowAnother(now) {
  const file = path.join(startsDir(), "recent.json");
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(file, "utf8")).filter((t) => now - t < WINDOW_MS);
  } catch {
    list = [];
  }
  if (list.length >= MAX_PER_WINDOW) return false;
  fs.mkdirSync(startsDir(), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([...list, now]));
  return true;
}

/** The folder a Claude Code transcript was recorded in (its first lines carry `cwd`). */
function transcriptCwd(file) {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(8192);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const m = buf.toString("utf8", 0, n).match(/"cwd":"((?:[^"\\]|\\.)*)"/);
      return m ? JSON.parse(`"${m[1]}"`) : "";
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

/** Recent trusted project folders on this computer, newest first, inside `home`. */
function recentFolders(home = os.homedir(), deps = {}) {
  const seen = [];
  const add = (p, at) => {
    if (!p) return;
    const c = checkFolder(p, home);
    if (c.ok && !seen.some((s) => norm(s.p) === norm(c.real))) seen.push({ p: c.real, at });
  };
  for (const r of listSessions()) add(r.cwd, r.last_hook_at || 0);
  const projects = path.join(home, ".claude", "projects");
  let dirs = [];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    dirs = [];
  }
  for (const d of dirs) {
    let newest = null;
    try {
      for (const f of fs.readdirSync(path.join(projects, d))) {
        if (!f.endsWith(".jsonl")) continue;
        const full = path.join(projects, d, f);
        const at = fs.statSync(full).mtimeMs;
        if (!newest || at > newest.at) newest = { full, at };
      }
    } catch {
      continue;
    }
    if (newest) add(transcriptCwd(newest.full), newest.at);
  }
  // Trust is checked newest first and only until the list is full: each check reads ~/.claude.json.
  const out = [];
  for (const s of seen.sort((a, b) => b.at - a.at)) {
    if (out.length >= MAX_FOLDERS) break;
    if (checkTrust(s.p, { ...deps, home }).trusted) out.push(s.p);
  }
  return out;
}

/**
 * Start each request the phone handed this machine (once per id), answering started or refused.
 * `ctx`: { cfg, env, api, platform, home, hostname, handledStarts:Set, spawnDetached, now, log }.
 */
async function handleStarts(ctx, machine, list) {
  const log = ctx.log || (() => {});
  for (const s of list || []) {
    const id = String((s && s.start_id) || "");
    if (!START_ID.test(id) || ctx.handledStarts.has(id)) continue;
    ctx.handledStarts.add(id);
    const now = ctx.now ? ctx.now() : Date.now();
    const why = refusal(ctx.cfg, ctx.env, ctx.hostname);
    // Connect Codex / Antigravity: one fixed installer run here, no session and no folder (connect-tool.js).
    const client = connectTool.connectRequest(s.prompt);
    if (client) {
      const detail = why || (allowAnother(now) ? null : "Three sessions were started here in the last ten minutes.");
      const res = detail ? { status: "refused", detail } : await connectTool.connect({ ...ctx, cfg: ctx.cfg }, machine, id, client);
      if (detail) log(`start ${id}: connect ${client}: refused (${detail})`);
      try {
        await ctx.api.answerStart(ctx.cfg, machine, id, res.status, res.detail);
      } catch (err) {
        log(`start ${id} answer: ${err.message}`);
      }
      continue;
    }
    const folder = why ? null : checkFolder(s.folder, ctx.home);
    let detail = why || (folder && !folder.ok ? folder.why : null);
    // Item 50i: never a terminal stuck on the trust dialog. Claude Code's own trust record decides.
    if (!detail) {
      const trust = (ctx.checkTrust || checkTrust)(folder.real, { home: ctx.home, env: ctx.env });
      if (!trust.trusted) detail = trust.why;
    }
    if (!detail && !allowAnother(now)) detail = "Three sessions were started here in the last ten minutes.";
    let started = false;
    if (!detail) {
      const command = ctx.command || ["claude"];
      const launch = { env: ctx.env, mode: startMode(s.permission_mode, (ctx.listSessions || listSessions)(), now, ctx.cfg) };
      recordStart(id, folder.real, now);
      started = await (ctx.spawnDetached || spawnDetached)(launchPlan(ctx.platform, folder.real, command, s.prompt, s.model, id, launch));
      if (!started && ctx.platform === "win32") {
        started = await (ctx.spawnDetached || spawnDetached)(fallbackPlan(folder.real, command, s.prompt, s.model, launch));
      }
      if (!started && ctx.platform === "darwin") {
        started = await (ctx.spawnDetached || spawnDetached)({ ...launchPlan("linux", folder.real, command, s.prompt, s.model, id, launch), waitForExit: true });
      }
      if (started) log(`start ${id}: permissions ${launch.mode || "settings default"}`);
      if (!started) {
        fs.rmSync(path.join(startsDir(), `${id}.json`), { force: true });
        detail = ctx.platform === "darwin" ? "Could not open Terminal or start tmux. Allow Terminal automation on this Mac or install tmux."
          : ctx.platform === "win32" ? "Could not open a terminal window." : "Could not start tmux (is it installed?).";
      }
    }
    log(`start ${id} in ${folder && folder.real ? folder.real : s.folder}: ${started ? "started" : `refused (${detail})`}`);
    try {
      await ctx.api.answerStart(ctx.cfg, machine, id, started ? "started" : "refused", started ? null : detail);
    } catch (err) {
      log(`start ${id} answer: ${err.message}`);
    }
  }
}

module.exports = {
  CLAIM_MS,
  cleanPrompt,
  checkFolder,
  refusal,
  claudeArgs,
  startMode,
  startEnv,
  launchPlan,
  fallbackPlan,
  spawnDetached,
  recordStart,
  takeStartFor,
  recentFolders,
  handleStarts,
};
