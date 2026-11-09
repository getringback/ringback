"use strict";
// Sessions on the phone (SPEC "Sessions" and "Calling a session"). Local state per session lives
// in ~/.ringback/state: sessions/<id>.json (what this machine knows about the session),
// inbox/<id>.cursor (highest message id this machine has taken) and inbox/<id>.pending (a flag the
// helper raises when a busy session has a message waiting, so hooks never poll the network).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { configDir } = require("./config.js");
const { api } = require("./client.js");
const { formatInboxMessages } = require("./inbox-format.js");
const { progressOf, clip, MAX_LINE } = require("./progress.js");
const { CLAUDE_CODE, clientOf, labelOf } = require("./clients.js");
const permissions = require("./permissions.js");

const HEARTBEAT_EVERY_MS = 30 * 1000;
const PHONE_DOWN_MS = 60 * 1000;
const HOOK_CONNECT_MS = 1500;
const REGISTER_KEEP_MS = 60 * 1000;
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
// A status an agent set itself (set_session_status) wins over the derived one this long.
const EXPLICIT_STATUS_MS = 15 * 60 * 1000;

const stateDir = () => path.join(configDir(), "state");
const sessionsDir = () => path.join(stateDir(), "sessions");
const inboxDir = () => path.join(stateDir(), "inbox");
const safeId = (id) => (SESSION_ID.test(String(id || "")) ? String(id) : null);

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  // On Windows a rename fails (EPERM, EBUSY, EACCES) while another process reads the target:
  // the helper and every hook read session files all the time. Retry briefly, never drop the write.
  for (let i = 0; ; i += 1) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (i >= 20 || !["EPERM", "EBUSY", "EACCES"].includes(err.code)) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
      const until = Date.now() + 10 + i * 5;
      while (Date.now() < until) {
        // A short spin: the reader holds the file for well under a millisecond.
      }
    }
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readSession(id) {
  const sid = safeId(id);
  return sid ? readJson(path.join(sessionsDir(), `${sid}.json`)) : null;
}

function writeSession(id, rec) {
  const sid = safeId(id);
  if (sid) atomicWrite(path.join(sessionsDir(), `${sid}.json`), JSON.stringify(rec));
}

function listSessions() {
  let names = [];
  try {
    names = fs.readdirSync(sessionsDir()).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  return names.map((n) => readJson(path.join(sessionsDir(), n))).filter((r) => r && safeId(r.id));
}

function readCursor(id) {
  try {
    const v = fs.readFileSync(path.join(inboxDir(), `${safeId(id)}.cursor`), "utf8").trim();
    return /^\d+$/.test(v) ? v : "";
  } catch {
    return "";
  }
}

function writeCursor(id, cursor) {
  if (safeId(id) && /^\d+$/.test(String(cursor))) atomicWrite(path.join(inboxDir(), `${id}.cursor`), String(cursor));
}

/** The phone restarted and counts message ids from 1 again: forget every session cursor. */
function resetCursors() {
  try {
    for (const n of fs.readdirSync(inboxDir())) if (n.endsWith(".cursor")) fs.rmSync(path.join(inboxDir(), n), { force: true });
  } catch {
    // No cursors yet.
  }
}

const pendingFile = (id) => path.join(inboxDir(), `${safeId(id)}.pending`);
const hasPending = (id) => Boolean(safeId(id)) && fs.existsSync(pendingFile(id));

function setPending(id, on) {
  if (!safeId(id)) return;
  if (on) atomicWrite(pendingFile(id), String(Date.now()));
  else fs.rmSync(pendingFile(id), { force: true });
}

// Messages the helper already took from the phone for a session that turned busy meanwhile:
// inbox/<id>.stash, read by that session's own inbox hook (with the pending flag raised).
const stashFile = (id) => path.join(inboxDir(), `${safeId(id)}.stash`);

function stashMessages(id, msgs) {
  if (!safeId(id) || !msgs.length) return;
  const held = readJson(stashFile(id)) || [];
  const known = new Set(held.map((m) => m.id));
  atomicWrite(stashFile(id), JSON.stringify([...held, ...msgs.filter((m) => !known.has(m.id))]));
  // Every delivery passes here: remember this session's own conference seat (lib/seats.js).
  require("./seats.js").rememberSeats(id, msgs);
}

const hasStash = (id) => Boolean(safeId(id)) && fs.existsSync(stashFile(id));

/** Takes (and removes) what the helper stashed for session `id`, oldest first. */
function takeStash(id) {
  if (!safeId(id)) return [];
  const held = readJson(stashFile(id));
  fs.rmSync(stashFile(id), { force: true });
  return Array.isArray(held) ? held : [];
}

// Which version of the SessionStart call guidance a session has been given: guidance/<id>. A file
// of its own, so the async registration (which rewrites sessions/<id>.json) cannot lose it.
const guidanceFile = (id) => path.join(stateDir(), "guidance", `${safeId(id)}`);

function readGuidance(id) {
  if (!safeId(id)) return "";
  try {
    return fs.readFileSync(guidanceFile(id), "utf8").trim();
  } catch {
    return "";
  }
}

function writeGuidance(id, version) {
  if (safeId(id)) atomicWrite(guidanceFile(id), String(version));
}

// After a failed request, hooks skip the network for a minute, so a phone that is off or out of
// reach costs one short connect attempt per minute instead of one per tool call.
const downFile = () => path.join(stateDir(), "phone_down_until");

function phoneDown(now = Date.now()) {
  try {
    return Number(fs.readFileSync(downFile(), "utf8")) > now;
  } catch {
    return false;
  }
}

function markPhoneDown(now = Date.now()) {
  try {
    atomicWrite(downFile(), String(now + PHONE_DOWN_MS));
  } catch {
    // Best effort only.
  }
}

const hookCfg = (cfg) => ({ ...cfg, connect_ms: HOOK_CONNECT_MS });

/** Runs a phone request from a hook: skipped while the phone is known down, marks it down on failure. */
async function guarded(fn) {
  if (phoneDown()) return null;
  try {
    return await fn();
  } catch (err) {
    if (!err.status) markPhoneDown();
    throw err;
  }
}

/** Claude Code running inside the Claude Desktop app (its Code tab); its own hooks wake it like a terminal session. */
const inDesktopApp = (env = process.env) => String(env.CLAUDE_CODE_ENTRYPOINT || "") === "claude-desktop";

function registration(input, env = process.env) {
  const cwd = input.cwd || env.CLAUDE_PROJECT_DIR || process.cwd();
  // Other clients (FOLLOWUPS item 20) are named on the phone until they have a title of their own.
  const other = input.client && input.client !== CLAUDE_CODE ? input.client : null;
  return {
    machine: os.hostname().slice(0, 64),
    project: (path.basename(cwd) || "home").slice(0, 120),
    cwd: String(cwd).slice(0, 1024),
    title: String(input.session_title || (other ? labelOf(other) : "")).slice(0, 200),
    ...(other ? { client: other } : {}),
    ...(input.transcript_path ? { transcript_path: String(input.transcript_path) } : {}),
    ...(inDesktopApp(env) ? { desktop_app: true, runs_in: "desktop" } : {}),
    ...(env.CLAUDE_CODE_ENTRYPOINT === "cli" && env.RINGBACK_HELPER_RUN !== "1" ? { runs_in: "terminal" } : {}),
  };
}

/** Summary and doing to show: what the agent set itself (recently), else what was derived. */
function shownStatus(rec, now = Date.now()) {
  const explicit = rec.status_set_at && now - rec.status_set_at < EXPLICIT_STATUS_MS;
  return explicit
    ? { summary: rec.status_done || "", doing: rec.status_doing || "" }
    : { summary: rec.summary || "", doing: derivedDoing(rec) };
}

// Never an empty doing on the phone (FOLLOWUPS item 33c): an idle session waits for its user,
// a busy one without a readable step is still working.
const IDLE_DOING = "Waiting for you";
const BUSY_DOING = "Working on it";

function derivedDoing(rec) {
  // Idle between turns while its background jobs still run (live 14:35): say so, never a stale step.
  if (rec.state === "idle") return require("./busy.js").backgroundOnly(rec) ? BACKGROUND_DOING : IDLE_DOING;
  return rec.doing || BUSY_DOING;
}
const BACKGROUND_DOING = "Idle, background jobs running";

/** The folder a session runs in, "home" for the home folder itself. */
function folderName(rec, home = os.homedir()) {
  const cwd = String((rec && rec.cwd) || "");
  if (cwd && path.resolve(cwd).toLowerCase() === path.resolve(home).toLowerCase()) return "home";
  return String((rec && rec.project) || path.basename(cwd) || "home");
}

/**
 * The name the phone shows: its own title (/rename, a hook, Claude Code's ai-title), else its
 * folder and where it runs, e.g. "ringback (terminal)" or "home (Desktop)". Never a sentence
 * guessed from what was typed.
 */
function sessionName(rec, home = os.homedir()) {
  const own = String((rec && (rec.title || rec.auto_title || rec.prompt_title)) || "").trim();
  if (own) return own;
  const where = rec && rec.desktop_app === true ? "Desktop" : rec && rec.runs_in === "chatgpt" ? "ChatGPT desktop" : rec && rec.runs_in === "terminal" ? "terminal" : "";
  const folder = folderName(rec, home);
  return where ? `${folder} (${where})` : folder;
}

// Where a session runs, for the phone's list (FOLLOWUPS item 48a): "desktop" (the Claude Desktop
// app's Code tab) or "terminal". Absent while unknown.
const runsIn = (rec) => (rec.desktop_app === true ? "desktop" : rec.runs_in === "terminal" ? "terminal" : null);

/**
 * The session body the phone stores. `extra.reach` (the helper's heartbeat) adds reachable,
 * reach_how and unreachable_reason (FOLLOWUPS 57 APP CONTRACT).
 */
const reachFields = (r) => ({ reachable: r.callable === true, reach_how: r.how || null, unreachable_reason: r.callable ? "" : String(r.reason || "") });
const wire = (rec, now = Date.now(), extra = {}) => ({
  machine: rec.machine,
  // The folder as they know it: "home" for the home folder, never the user name.
  project: folderName(rec),
  cwd: rec.cwd,
  title: sessionName(rec),
  state: rec.state,
  ...shownStatus(rec, now),
  // The phone start request this session came from (FOLLOWUPS item 21): it calls or adds it.
  ...(rec.start_id ? { start_id: rec.start_id } : {}),
  needs_you: rec.needs_you === true,
  // When this computer raised the flag (FOLLOWUPS item 37): the phone ignores a stale true after
  // it cleared the flag itself, and only a newer flag raises it again.
  ...(rec.needs_you_at ? { needs_you_at: rec.needs_you_at } : {}),
  // Which client runs it (FOLLOWUPS item 20): absent for Claude Code. The phone ignores it until it shows it.
  ...(rec.client ? { client: rec.client } : {}),
  ...(runsIn(rec) ? { runs_in: runsIn(rec) } : {}),
  // FOLLOWUPS 57: whether they can reach it on screen now (lib/reach.js); absent = keep the last.
  ...(extra && extra.reach ? reachFields(extra.reach) : {}),
});

/**
 * `rec` with title, summary and doing re-read from its transcript (FOLLOWUPS items 4, 9), when
 * the transcript changed since the last read. Pure text extraction; unchanged rec otherwise.
 */
function withProgress(rec, file = rec && rec.transcript_path) {
  if (!rec || !file) return rec;
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return rec;
  }
  if (rec.transcript_path === file && rec.progress_mtime === mtime) return rec;
  const p = progressOf(file);
  if (!p) return rec;
  // A title once seen is kept: a long transcript is read head and tail only, so a later read may
  // miss an ai-title written in the middle.
  return { ...rec, transcript_path: file, progress_mtime: mtime, auto_title: p.title || rec.auto_title || "", prompt_title: p.promptTitle || rec.prompt_title || "", summary: p.summary, doing: p.doing };
}

/** What the agent itself says it has done and is doing (set_session_status). */
async function setStatus(cfg, id, status, deps = { api, now: Date.now() }) {
  const sid = safeId(id);
  if (!sid) throw new Error("Unknown session");
  const old = readSession(sid);
  if (!old || old.ended) throw new Error("This session is not on the phone's list yet");
  const rec = {
    ...old,
    status_done: clip(status.done || "", MAX_LINE),
    status_doing: clip(status.doing || "", MAX_LINE),
    status_set_at: deps.now,
    last_beat: deps.now,
  };
  writeSession(sid, rec);
  await deps.api.putSession(hookCfg(cfg), sid, wire(rec, deps.now));
  return shownStatus(rec, deps.now);
}

// Which session a Claude Code process runs now: state/by-pid/<claude pid>, written by the
// SessionStart hook (and refreshed by activity). Hooks get CLAUDE_PID from Claude Code; the MCP
// server is a direct child of that same process. Without this, two sessions started in one
// folder (all the home-dir sessions) could not be told apart.
const OWNER_KEEP_MS = 7 * 24 * 3600 * 1000;
const ownerDir = () => path.join(stateDir(), "by-pid");
const safePid = (pid) => (Number.isInteger(Number(pid)) && Number(pid) > 0 ? Number(pid) : null);
const ownerFile = (pid) => path.join(ownerDir(), `${safePid(pid)}.json`);

/** The claude pid a hook runs under: CLAUDE_PID when set, else the hook's parent. */
const hookClaudePid = (env = process.env, ppid = process.ppid) => safePid(env.CLAUDE_PID) || safePid(ppid);

/**
 * Pids the MCP server looks up: its parent (claude itself) only. Claude Code sets CLAUDE_PID for
 * Bash and hook processes, not for stdio MCP servers (code.claude.com/docs/en/env-vars), so a
 * CLAUDE_PID an MCP server sees was inherited from some OTHER session that launched this claude:
 * using it spoke as that session on a conference (FOLLOWUPS item 50k).
 */
function mcpClaudePids(_env = process.env, ppid = process.ppid) {
  return [safePid(ppid)].filter(Boolean);
}

/**
 * The session id Claude Code gave this stdio MCP server at spawn (CLAUDE_CODE_SESSION_ID, docs:
 * code.claude.com/docs/en/env-vars), or null. Exact for this process; after /clear the pid link
 * (rewritten by the hooks) is newer, so that one is looked at first.
 */
function mcpSessionId(env = process.env) {
  if (env.RINGBACK_CLIENT && env.RINGBACK_CLIENT !== CLAUDE_CODE) return null;
  return safeId(env.CLAUDE_CODE_SESSION_ID);
}

function readOwner(pid) {
  if (!safePid(pid)) return null;
  const rec = readJson(ownerFile(pid));
  return rec && safeId(rec.session_id) ? rec.session_id : null;
}

function writeOwner(pid, id, now = Date.now()) {
  if (!safePid(pid) || !safeId(id)) return;
  if (readOwner(pid) === id) return;
  atomicWrite(ownerFile(pid), JSON.stringify({ session_id: id, at: now }));
  pruneOwners(now);
}

/** Session end drops the link, unless a newer session (after /clear) already took it over. */
function clearOwner(pid, id) {
  if (safePid(pid) && readOwner(pid) === id) fs.rmSync(ownerFile(pid), { force: true });
}

function pruneOwners(now) {
  try {
    for (const n of fs.readdirSync(ownerDir())) {
      const f = path.join(ownerDir(), n);
      if (now - fs.statSync(f).mtimeMs > OWNER_KEEP_MS) fs.rmSync(f, { force: true });
    }
  } catch {
    // Best effort only.
  }
}

const liveSession = (id) => {
  const rec = readSession(id);
  return rec && !rec.ended ? rec.id : null;
};

/**
 * The session the plugin MCP server belongs to: `explicit` when given, else the session its claude
 * process is linked to (`pids`), else the one live session on this machine in `cwd`. Two or more
 * live sessions in that folder without a link: { status: "ambiguous", candidates }.
 */
function ownSession({ cwd, explicit, pids = [], envId = null, now = Date.now(), client = CLAUDE_CODE }) {
  if (explicit) return safeId(explicit) ? { status: "ok", id: safeId(explicit) } : { status: "unknown" };
  // The Claude Desktop chat never has a session of its own; other clients only own their own kind,
  // so a Codex or Desktop MCP server never speaks as a Claude Code session in the same folder.
  if (client === "claude-desktop") return { status: "unknown" };
  const sameClient = (id) => (id && clientOf(readSession(id)) === client ? id : null);
  for (const pid of pids) {
    const linked = sameClient(liveSession(readOwner(pid)));
    if (linked) return { status: "ok", id: linked };
  }
  // The id Claude Code handed this MCP server: exact, so never replaced by a guess from the folder.
  if (client === CLAUDE_CODE && safeId(envId)) return { status: "ok", id: safeId(envId) };
  const norm = (p) => path.resolve(String(p || "")).toLowerCase();
  const mine = listSessions().filter(
    (r) =>
      !r.ended &&
      clientOf(r) === client &&
      r.cwd &&
      norm(r.cwd) === norm(cwd) &&
      now - (r.last_hook_at || 0) < 24 * 3600 * 1000,
  );
  if (mine.length === 1) return { status: "ok", id: mine[0].id };
  if (mine.length > 1) return { status: "ambiguous", candidates: mine.map((r) => r.id) };
  return { status: "unknown" };
}

/** The session id for `cwd` (see ownSession), or null when unknown or ambiguous. */
function findOwnSession(cwd, explicit, now = Date.now(), pids = []) {
  const r = ownSession({ cwd, explicit, pids, now });
  return r.status === "ok" ? r.id : null;
}

// Local only, never sent to the phone (wire() picks its fields): the claude pid finds the
// session's window and TMUX_PANE its raw terminal (spec 04, FOLLOWUPS item 22). A run marked as
// the helper's (RINGBACK_HELPER_RUN) never overwrites them.
const TMUX_PANE = /^%\d{1,6}$/;
function localIds(env = process.env, client = CLAUDE_CODE) {
  if (env.RINGBACK_HELPER_RUN === "1") return {};
  // Another client's hook may run under a claude that launched it: that CLAUDE_PID is not its own.
  if (client && client !== CLAUDE_CODE) return {};
  const pid = hookClaudePid(env);
  const pane = TMUX_PANE.test(String(env.TMUX_PANE || "")) ? env.TMUX_PANE : null;
  // client_pid: the claude process itself, only from the CLAUDE_PID Claude Code sets for hooks
  // (never the parent-pid guess), so the helper can drop the session once that process is gone.
  const own = safePid(env.CLAUDE_PID);
  return { ...(pid ? { claude_pid: pid } : {}), ...(own ? { client_pid: own } : {}), tmux_pane: pane };
}

// Interactive Claude Code entrypoints (hooks/wake-wait.js): the terminal and the Desktop Code tab.
const INTERACTIVE = Object.freeze(["cli", "claude-desktop"]);

/**
 * A Claude Code run nobody can see or call: `claude -p` ("sdk-cli"), the Agent SDK ("sdk-ts",
 * "sdk-py", ...), or a run the helper started. It never registers or heartbeats (no ghost
 * sessions on the phone). An unset entrypoint (an old Claude Code, a test) is not judged here.
 */
function headlessClaude(input, env = process.env) {
  if (input && input.client && input.client !== CLAUDE_CODE) return false;
  if (env.RINGBACK_HELPER_RUN === "1") return true;
  const entry = String(env.CLAUDE_CODE_ENTRYPOINT || "");
  return Boolean(entry) && !INTERACTIVE.includes(entry);
}

/**
 * FOLLOWUPS item 47: the permission mode the session's own window runs in, from the hook input
 * (UserPromptSubmit, PostToolUse and Stop carry it; SessionStart does not). A helper background
 * run never records its own mode over the session's.
 */
function recordPermissionMode(rec, input, env = process.env, now = Date.now()) {
  if ((env || process.env).RINGBACK_HELPER_RUN === "1") return rec;
  if (input.client && input.client !== CLAUDE_CODE) return rec;
  const mode = permissions.fromHookInput(input);
  return mode ? permissions.withPermissions(rec, { mode }, "hook", now) : rec;
}

/**
 * Record what this session is doing and tell the phone when that changed or the last heartbeat
 * is older than 30 s. `force` always tells the phone. Returns true when a heartbeat was sent.
 */
async function heartbeat(cfg, input, state, deps = { api, now: Date.now() }, force = false) {
  const id = safeId(input.session_id);
  if (!id || headlessClaude(input, deps.env || process.env)) return false;
  const now = deps.now;
  const old = readSession(id) || { id, ...registration(input), registered_at: now };
  const nextState = state || old.state || "idle";
  const due = force || old.ended || old.state !== nextState || !old.last_beat || now - old.last_beat >= HEARTBEAT_EVERY_MS;
  // A session already registered learns it runs in the Desktop app from any later hook.
  const desktop = inDesktopApp() ? { desktop_app: true, runs_in: "desktop" } : {};
  const fresh = { ...old, ...(old.machine ? {} : registration(input)), ...desktop, ...localIds(deps.env || process.env, input.client), state: nextState, last_hook_at: now, ended: false };
  const base = recordPermissionMode(fresh, input, deps.env, now);
  // The transcript is read only when a heartbeat goes out anyway (at most every 30 s).
  const rec = due ? withProgress(base, input.transcript_path || base.transcript_path) : base;
  writeSession(id, due ? { ...rec, last_beat: now } : rec);
  if (!due) return false;
  await guarded(() => deps.api.putSession(hookCfg(cfg), id, wire(rec, now)));
  return true;
}

/**
 * A permission / idle prompt waits on the user (on), or the session no longer needs them (off: any
 * busy signal, FOLLOWUPS item 37): tell the phone at once. A new flag carries its time.
 */
async function markNeedsYou(cfg, input, on, deps = { api, now: Date.now() }, kind = "notice") {
  const id = safeId(input.session_id);
  if (!id) return false;
  const old = readSession(id);
  if (!old || old.ended || (old.needs_you === true) === on) return false;
  // kind (as Gauntlet's asks): permission, question or notice; a permission flag is withdrawn by
  // Claude Code's live status once the prompt is answered (lib/live-status.js).
  writeSession(id, on ? { ...old, needs_you: true, needs_you_at: deps.now, needs_kind: kind } : { ...old, needs_you: false });
  return heartbeat(cfg, input, old.state, deps, true);
}

/** markNeedsYou(off) that never throws; for busy signals outside the hooks (waiter, MCP). */
async function clearNeedsYou(cfg, sessionId, deps = { api, now: Date.now() }) {
  try {
    return await markNeedsYou(cfg, { session_id: sessionId }, false, deps);
  } catch {
    return false;
  }
}

const IDLE_PROMPT_WINDOW_MS = 60 * 1000;

/**
 * Whether an idle_prompt notification is stale (FOLLOWUPS item 37): the session, or a subagent of
 * it (those no longer mark it busy), was seen working within the idle window, so it has not been
 * waiting on them for that long.
 */
function idlePromptIsStale(rec, now, windowMs = IDLE_PROMPT_WINDOW_MS) {
  if (!rec) return false;
  if (rec.subagent_at && now - rec.subagent_at < windowMs) return true;
  return rec.state === "busy" && !!rec.last_hook_at && now - rec.last_hook_at < windowMs;
}

async function register(cfg, input, deps = { api, now: Date.now() }) {
  const id = safeId(input.session_id);
  if (!id || headlessClaude(input, deps.env || process.env)) return false;
  const old = readSession(id) || {};
  // SessionStart also fires after a compaction in the middle of a turn, and this hook is async, so
  // a UserPromptSubmit may already have marked the session busy. Activity recorded in the last
  // minute (or any state on a compaction) wins; otherwise a start, resume or clear is idle.
  const recent = old.last_hook_at && deps.now - old.last_hook_at < REGISTER_KEEP_MS;
  const state = old.state && !old.ended && (input.source === "compact" || recent) ? old.state : "idle";
  const reg = registration(input);
  // A session the phone asked for (FOLLOWUPS item 21) takes its start id once, by folder.
  const startId = old.start_id || (input.source === "startup" || !input.source ? (deps.takeStart || require("./starts.js").takeStartFor)(reg.cwd, deps.now) : null);
  writeSession(id, { ...old, id, ...reg, state, registered_at: old.registered_at || deps.now, ...(startId ? { start_id: startId } : {}) });
  return heartbeat(cfg, input, state, deps, true);
}

async function unregister(cfg, input, deps = { api, now: Date.now() }) {
  const id = safeId(input.session_id);
  if (!id) return false;
  const old = readSession(id);
  if (old) writeSession(id, { ...old, ended: true, ended_at: deps.now });
  setPending(id, false);
  takeStash(id);
  await guarded(() => deps.api.deleteSession(hookCfg(cfg), id));
  return true;
}

// One claimer per session at a time: parallel tool calls run PostToolUse hooks side by side, and
// two claims reading the same cursor would both deliver the same words. A lock older than
// CLAIM_LOCK_STALE_MS is left over from a killed process and is taken over.
const CLAIM_LOCK_STALE_MS = 20 * 1000;
const claimLockFile = (id) => path.join(inboxDir(), `${safeId(id)}.claiming`);

function lockClaim(id, now = Date.now()) {
  fs.mkdirSync(inboxDir(), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(claimLockFile(id), String(process.pid), { flag: "wx" });
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let age = 0;
      try {
        age = now - fs.statSync(claimLockFile(id)).mtimeMs;
      } catch {
        continue;
      }
      if (age < CLAIM_LOCK_STALE_MS) return false;
      fs.rmSync(claimLockFile(id), { force: true });
    }
  }
  return false;
}

/**
 * Take every message waiting for session `id`: fetch newer than the local cursor, store the new
 * cursor, and fetch once more so the phone drops what was taken. `onFetched(msgs)` runs before
 * that acknowledgement, so a caller can persist the batch first. Returns the messages, oldest
 * first; an empty list when another process is claiming for this session right now.
 */
async function claim(cfg, id, deps = { api }, onFetched = null) {
  const sid = safeId(id);
  if (!sid) return [];
  return (await withClaimLock(sid, () => claimLocked(cfg, sid, deps, onFetched))) || [];
}

/** Runs `fn` holding this session's claim lock; null (without running it) when another holds it. */
async function withClaimLock(id, fn) {
  const sid = safeId(id);
  if (!sid || !lockClaim(sid)) return null;
  try {
    return await fn();
  } finally {
    fs.rmSync(claimLockFile(sid), { force: true });
  }
}

/**
 * Everything waiting for session `id`, under its claim lock: each batch fetched from the phone is
 * stashed on disk before the phone drops it, then the whole stash (older helper batches first)
 * is taken. A process killed in between leaves the stash for the next hook or helper. With
 * `network` false only the stash is taken. null when another process holds the lock right now.
 */
async function drain(cfg, id, deps = { api }, network = true) {
  const sid = safeId(id);
  if (!sid) return [];
  const out = await withClaimLock(sid, async () => {
    let failure = null;
    if (network) {
      try {
        await claimLocked(cfg, sid, deps, (fresh) => stashMessages(sid, fresh));
      } catch (err) {
        failure = err;
      }
    }
    const msgs = takeStash(sid);
    if (failure && !msgs.length) throw failure;
    return msgs;
  });
  return out;
}

async function claimLocked(cfg, sid, deps, onFetched) {
  const taken = [];
  let cursor = readCursor(sid);
  for (let round = 0; round < 4; round += 1) {
    let res;
    try {
      res = await deps.api.sessionInbox(cfg, sid, cursor, 0);
    } catch (err) {
      // What was already fetched is delivered now. Retry the acknowledgement once, or the phone
      // would hand the same words to the next call_listen on that call as a fresh reply.
      if (taken.length) {
        try {
          await deps.api.sessionInbox(cfg, sid, cursor, 0);
        } catch {
          // Still unreachable: the next claim (same cursor) acknowledges it.
        }
        return taken;
      }
      throw err;
    }
    // A cursor below ours means the phone restarted and counts from zero again.
    if (cursor && res.cursor !== undefined && Number(res.cursor) < Number(cursor)) cursor = "";
    const fresh = (res.messages || []).filter((m) => !cursor || Number(m.id) > Number(cursor));
    if (!fresh.length) break;
    taken.push(...fresh);
    if (onFetched) onFetched(fresh);
    cursor = String(Math.max(...fresh.map((m) => Number(m.id))));
    writeCursor(sid, cursor);
  }
  return taken;
}

/** What a session reads when the user spoke to it on a call (the shared formatter, BUILD_PLAN A5). */
const describeMessages = formatInboxMessages;

module.exports = {
  sessionName,
  folderName,
  localIds,
  headlessClaude,
  recordPermissionMode,
  runsIn,
  HEARTBEAT_EVERY_MS,
  HOOK_CONNECT_MS,
  safeId,
  readSession,
  writeSession,
  listSessions,
  readCursor,
  writeCursor,
  resetCursors,
  hasPending,
  setPending,
  stashMessages,
  takeStash,
  hasStash,
  readGuidance,
  writeGuidance,
  phoneDown,
  markPhoneDown,
  hookCfg,
  guarded,
  registration,
  inDesktopApp,
  wire,
  shownStatus,
  withProgress,
  setStatus,
  findOwnSession,
  ownSession,
  hookClaudePid,
  mcpClaudePids,
  mcpSessionId,
  readOwner,
  writeOwner,
  clearOwner,
  heartbeat,
  markNeedsYou,
  clearNeedsYou,
  idlePromptIsStale,
  register,
  unregister,
  claim,
  withClaimLock,
  drain,
  describeMessages,
  stateDir,
};
