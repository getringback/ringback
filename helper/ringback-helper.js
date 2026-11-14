#!/usr/bin/env node
"use strict";
// Ringback helper: one per machine, started detached by the SessionStart hook. It only connects
// OUT to the phone and never listens. It does two things:
//  1. Heartbeats the sessions of this machine (so idle sessions stay on the phone's list).
//  2. Long-polls the phone for what the user said on calls to this machine's sessions. A busy session
//     gets a pending flag its own hooks pick up; an idle one is woken in its own window through an
//     official mechanism (Claude Code's asyncRewake waiter, `codex queue`, agy's held Stop hook).
//     There is never a hidden or forked answer run (FOLLOWUPS item 57): a session that cannot be
//     woken on screen is reported on the call as "<name> could not be reached on screen".
// It never starts a model run itself.
// Every helper is also this machine on the phone (helper/net.js, spec 03): machine report,
// control events (rename, remove, start a session) and, in mode embedded, the built-in Tailscale.
// `--service` (the OS service ringback-join installs) keeps running with no live sessions; the
// ad-hoc helper a SessionStart hook starts still exits when no session is live.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { loadConfig, isConfigured, configDir } = require("../lib/config.js");
const { api } = require("../lib/client.js");
const sessions = require("../lib/sessions.js");
const lock = require("../lib/helper-lock.js");
const { isLeftMessage } = require("../lib/conference.js");
const { waiterAlive } = require("../hooks/wake-wait.js");
const starts = require("../lib/starts.js");
const clients = require("../lib/clients.js");
const { detectTools } = require("../lib/agent-tools.js");
const origin = require("../lib/origin.js");

const liveStatus = require("../lib/live-status.js");
const visibleWake = require("../lib/visible-wake.js");
const reachLib = require("../lib/reach.js");
const proc = require("../lib/proc.js");
const { isCallStarted } = require("../lib/inbox-format.js");

const MACHINE = os.hostname().slice(0, 64);
const BEAT_EVERY_MS = 60 * 1000;
// Claude Code's live session status (waiting on a prompt) is read this often (FOLLOWUPS item 37).
const STATUS_EVERY_MS = 15 * 1000;
// A session's reach (lib/reach.js) is re-checked this often and sent when it changed.
const REACH_EVERY_MS = 10 * 1000;
// The phone's New session sheet lists this machine's recent folders; refreshed this often.
const MACHINE_EVERY_BEATS = 10;
const LIVE_FOR_MS = 24 * 60 * 60 * 1000;
const BUSY_STALE_MS = 30 * 60 * 1000;
const POLL_WAIT_S = 50;
const POLL_WAIT_PENDING_S = 5;
const MAX_STDOUT = 1024 * 1024;
// A call queued into a Codex window must start a turn there within this, else they hear it was not reached.
const QUEUE_CONFIRM_MS = 20 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(line) {
  try {
    require("../hooks/log.js").write("helper.log", line);
  } catch {
    // Logging never stops the helper.
  }
}

/** The claude command as an argv prefix: config `claude_command`, env RINGBACK_CLAUDE_COMMAND (JSON array), or `claude`. */
function claudeCommand(cfg, env = process.env) {
  if (Array.isArray(cfg.claude_command) && cfg.claude_command.length) return cfg.claude_command.map(String);
  if (env.RINGBACK_CLAUDE_COMMAND) {
    try {
      const v = JSON.parse(env.RINGBACK_CLAUDE_COMMAND);
      if (Array.isArray(v) && v.length) return v.map(String);
    } catch {
      log("RINGBACK_CLAUDE_COMMAND is not a JSON array; using claude");
    }
  }
  const tools = require("../lib/service.js").toolEnvironment({ env, home: env.HOME || env.USERPROFILE || os.homedir() });
  if (tools.claudePath && /\.cmd$/i.test(tools.claudePath)) {
    const cli = path.join(path.dirname(tools.claudePath), "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    if (fs.existsSync(cli)) return [process.execPath, cli];
  }
  return [tools.claudePath || "claude"];
}

function missingBinary(ctx, name) {
  if (!ctx.missingBinaries) ctx.missingBinaries = new Set();
  if (ctx.missingBinaries.has(name)) return;
  ctx.missingBinaries.add(name);
  (ctx.log || log)(`${name} was not found. Install ${name} for this user, then run the Ringback installer again.`);
}

function prepareRuntime({ env = process.env, refresh = require("../lib/install.js").refreshInstall, writeLog = log } = {}) {
  try { refresh({ onError: (err) => writeLog(`install refresh: ${err.message}`) }); }
  catch (err) { writeLog(`install refresh: ${err.message}`); }
  const tools = require("../lib/service.js").toolEnvironment({ env, home: env.HOME || env.USERPROFILE || os.homedir() });
  env.PATH = tools.pathEnv;
  return tools;
}

/**
 * What to do with a waiting message for this session: wake it, flag it for its own hooks, or
 * skip. A session whose own waiter (hooks/wake-wait.js asyncRewake, or agy's held Stop hook) is
 * alive is woken by its client itself, where it runs.
 */
function decide(rec, running, now, waiting = waiterAlive) {
  if (!rec || rec.ended) return "skip";
  if (waiting(rec.id)) return "skip";
  if (running.has(rec.id)) return "flag";
  // Busy by Claude Code's own live status when fresh, else by its hooks (lib/reach.js isBusy).
  if (reachLib.isBusy(rec, now)) return "flag";
  return "wake";
}

/** The state to report for a local session, or null when it should no longer be heartbeated. */
function beatState(rec, running, now) {
  if (!rec || rec.ended) return null;
  if (running.has(rec.id)) return "busy";
  if (!rec.last_hook_at || now - rec.last_hook_at > LIVE_FOR_MS) return null;
  return reachLib.isBusy(rec, now) ? "busy" : "idle";
}

/** `claude agents --json` (a local listing, never a model call); "" when it could not run. */
function readAgents(ctx) {
  const [cmd, ...pre] = claudeCommand(ctx.cfg, ctx.env);
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = ctx.spawn(cmd, [...pre, "agents", "--json"], { env: lock.helperEnv(ctx.env), stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch (err) {
      if (err.code === "ENOENT") missingBinary(ctx, "claude");
      else log(`claude agents: ${err.message}`);
      resolve("");
      return;
    }
    child.stdout.on("data", (c) => {
      if (out.length < MAX_STDOUT) out += c.toString("utf8");
    });
    child.on("error", (err) => {
      if (err.code === "ENOENT") missingBinary(ctx, "claude");
      else log(`claude agents: ${err.message}`);
      resolve("");
    });
    child.on("close", () => resolve(out));
  });
}

/**
 * Brings each local session's "needs you" flag in line with Claude Code's live status, the
 * signal Gauntlet's wallpaper uses (FOLLOWUPS item 37): a waiting session raises it, and a
 * permission flag drops as soon as the prompt is answered. Tells the phone only on a change.
 */
async function watchStatus(ctx) {
  if (ctx.statusBusy) return;
  const live = sessions.listSessions().filter((r) => beatState(r, ctx.running, Date.now()) && clients.clientOf(r) === clients.CLAUDE_CODE);
  if (!live.length) return;
  ctx.statusBusy = true;
  try {
    const raw = await (ctx.readAgents || readAgents)(ctx);
    const statuses = liveStatus.parseAgents(raw);
    // A failed read ("" or not a JSON list) decides nothing; a real empty list ("[]": the last
    // session closed) still lets unlisted records go (Codex review).
    if (!liveStatus.isAgentList(raw)) return;
    const pids = liveStatus.parseAgentPids(raw);
    const now = Date.now();
    for (const stored of live) {
      const rec = sessions.readSession(stored.id) || stored;
      // Claude Code's own busy / idle (lib/reach.js isBusy) and its claude pid, every read.
      if (!statuses.has(rec.id)) {
        await dropUnlisted(ctx, rec, now);
        continue;
      }
      if (ctx.unlisted) ctx.unlisted.delete(rec.id);
      const stamped = liveStatus.withLiveFacts(rec, statuses.get(rec.id), pids.get(rec.id), now);
      const next = liveStatus.withLiveStatus(stamped, statuses.get(rec.id), now);
      if (next === rec) continue;
      sessions.writeSession(rec.id, next);
      if ((next.needs_you === true) === (rec.needs_you === true)) continue;
      log(`needs you ${next.needs_you ? "on" : "off"} for ${rec.id} (${statuses.get(rec.id)})`);
      try {
        await ctx.api.putSession(ctx.cfg, rec.id, sessions.wire({ ...next, state: beatState(next, ctx.running, now) || next.state }, now));
      } catch (err) {
        log(`needs you ${rec.id}: ${err.message}`);
      }
    }
  } finally {
    ctx.statusBusy = false;
  }
}

/**
 * A Claude Code record that Claude Code's own session list (claude agents --json) no longer has,
 * three reads in a row (45 s), with no live waiter and no hook for GHOST_QUIET_MS: a closed
 * window, a headless run or a stale record. Dropped from the phone; a live one comes back with
 * its next hook.
 */
async function dropUnlisted(ctx, rec, now) {
  if (!ctx.unlisted) ctx.unlisted = new Map();
  const n = (ctx.unlisted.get(rec.id) || 0) + 1;
  ctx.unlisted.set(rec.id, n);
  if (n < 3 || waiterAlive(rec.id)) return;
  if (rec.last_hook_at && now - rec.last_hook_at < GHOST_QUIET_MS) return;
  ctx.unlisted.delete(rec.id);
  await dropSession(ctx, rec, "Claude Code no longer lists it (a closed window or a headless run)");
}

// agy and Codex sessions carry the pid of the client process that runs them (owner_pid).
const OWNED_CLIENTS = Object.freeze(["codex", "agy"]);
// A session without a recorded process that ran no hook this long is a ghost at helper start.
const GHOST_QUIET_MS = 3 * 60 * 1000;

/** Takes a session off the phone and marks it ended locally. A live one returns at its next hook. */
async function dropSession(ctx, rec, why) {
  log(`drop ${rec.id} (${clients.labelOf(clients.clientOf(rec))}): ${why}`);
  try {
    await sessions.unregister(ctx.cfg, { session_id: rec.id }, { api: ctx.api, now: Date.now() });
  } catch (err) {
    log(`drop ${rec.id}: ${err.message}`);
  }
}

const NAME_TTL_MS = 30 * 1000;

/**
 * Process names by pid, cached for NAME_TTL_MS (each lookup is a tasklist / ps run), so the
 * heartbeat and the reach watch can ask every few seconds.
 */
function cachedNames(lookup = proc.processName, now = Date.now) {
  const seen = new Map();
  return (pid) => {
    const hit = seen.get(pid);
    if (hit && now() - hit.at < NAME_TTL_MS) return hit.name;
    const name = lookup(pid);
    seen.set(pid, { name, at: now() });
    if (seen.size > 500) seen.delete(seen.keys().next().value);
    return name;
  };
}

const isClaudeName = (name) => /^(claude|node|bun)(\.exe)?$/i.test(String(name || "").trim());

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/**
 * A session whose own process is gone (closed window, finished run): drop it. agy / Codex use
 * owner_pid (their client process); Claude Code its client_pid (the CLAUDE_PID its hooks got).
 * A name lookup that fails never drops anything.
 */
function ownerGone(ctx, rec) {
  const client = clients.clientOf(rec);
  const names = ctx.processName || proc.processName;
  if (OWNED_CLIENTS.includes(client)) {
    const pid = Number(rec.owner_pid) || 0;
    if (!(pid > 0)) return false;
    if (!(ctx.pidAlive || pidAlive)(pid)) return true;
    return !visibleWake.ownerAlive(rec, { processName: names });
  }
  if (client !== "claude-code") return false;
  const pid = Number(rec.client_pid) || 0;
  if (!(pid > 0)) return false;
  if (!(ctx.pidAlive || pidAlive)(pid)) return true;
  const name = names(pid);
  return Boolean(name) && !isClaudeName(name);
}

/** Whether they can reach session `rec` on screen now (lib/reach.js), with cached process lookups. */
const reachOf = (ctx, rec) => reachLib.reach(ctx.cfg, rec, { wakeDeps: { processName: ctx.processName || proc.processName } });

/** Remembers what the phone was last told about a session's reach, and logs every change. */
function noteReach(ctx, rec, reach) {
  if (!ctx.reachSent) ctx.reachSent = new Map();
  const old = ctx.reachSent.get(rec.id);
  if (!reachLib.same(old, reach)) {
    log(`reach ${rec.id} (${clients.labelOf(clients.clientOf(rec))}): ${reach.callable ? reach.how : `unreachable: ${reach.reason}`}`);
  }
  ctx.reachSent.set(rec.id, reach);
}

/**
 * Between heartbeats (every REACH_EVERY_MS): a session whose reach changed (its waiter armed,
 * died or timed out, its Codex window closed) is told to the phone at once, so the phone shows a
 * session as callable only while it truly is.
 */
async function watchReach(ctx) {
  const now = Date.now();
  for (const rec of sessions.listSessions()) {
    const state = beatState(rec, ctx.running, now);
    if (!state) continue;
    const reach = reachOf(ctx, { ...rec, state });
    if (reachLib.same(ctx.reachSent && ctx.reachSent.get(rec.id), reach)) continue;
    try {
      await ctx.api.putSession(ctx.cfg, rec.id, sessions.wire({ ...rec, state }, now, { reach }));
      noteReach(ctx, rec, reach);
    } catch (err) {
      log(`reach ${rec.id}: ${err.message}`);
      if (!err.status) return;
    }
  }
}

/**
 * At helper start: a Claude Code record from before client_pid existed whose recorded claude pid
 * is gone, with no live waiter and no hook for GHOST_QUIET_MS (a closed window that never sent
 * SessionEnd). A live one comes back with its next hook.
 */
function claudeGhost(ctx, rec, now) {
  if (clients.clientOf(rec) !== "claude-code" || Number(rec.client_pid) > 0) return false;
  const pid = Number(rec.claude_pid) || 0;
  if (!(pid > 0) || (ctx.pidAlive || pidAlive)(pid)) return false;
  if (rec.last_hook_at && now - rec.last_hook_at < GHOST_QUIET_MS) return false;
  return !waiterAlive(rec.id);
}

/**
 * At helper start: agy / Codex records from before owner_pid existed (headless `agy -p` runs
 * registered as sessions and never ended) that no hook touched for GHOST_QUIET_MS. A live
 * session among them comes back with its next hook, now with its process recorded.
 */
async function dropGhosts(ctx, now = Date.now()) {
  for (const rec of sessions.listSessions()) {
    if (rec && !rec.ended && claudeGhost(ctx, rec, now)) {
      await dropSession(ctx, rec, `its claude process ${rec.claude_pid} is gone (a closed session from before 0.7.11)`);
      continue;
    }
    if (!rec || rec.ended || !OWNED_CLIENTS.includes(clients.clientOf(rec))) continue;
    if (Number(rec.owner_pid) > 0) continue;
    if (rec.last_hook_at && now - rec.last_hook_at < GHOST_QUIET_MS) continue;
    if (waiterAlive(rec.id)) continue;
    await dropSession(ctx, rec, "no client process recorded and no hook for a while (a headless run or a closed session)");
  }
}

async function beatAll(ctx) {
  const now = Date.now();
  for (const stored of sessions.listSessions()) {
    const state = beatState(stored, ctx.running, now);
    if (!state) continue;
    if (!ctx.running.has(stored.id) && ownerGone(ctx, stored)) {
      await dropSession(ctx, stored, `its process ${stored.owner_pid || stored.client_pid} is gone`);
      continue;
    }
    // Idle sessions get their title (Claude Code writes ai-title later) and progress refreshed
    // here too, from the transcript, only when it changed (FOLLOWUPS items 4, 9).
    const rec = sessions.withProgress(stored);
    if (rec !== stored) sessions.writeSession(rec.id, rec);
    const reach = reachOf(ctx, { ...rec, state });
    try {
      await ctx.api.putSession(ctx.cfg, rec.id, sessions.wire({ ...rec, state }, now, { reach }));
      noteReach(ctx, rec, reach);
    } catch (err) {
      log(`heartbeat ${rec.id}: ${err.message}`);
      if (!err.status) return;
    }
  }
}

/** Waiting messages per session: flag busy ones, wake idle ones. */
async function processPending(ctx) {
  const now = Date.now();
  for (const [sid, msgs] of [...ctx.pending.entries()]) {
    const cursor = sessions.readCursor(sid);
    const live = msgs.filter((m) => !cursor || Number(m.id) > Number(cursor));
    if (!live.length) {
      ctx.pending.delete(sid);
      continue;
    }
    ctx.pending.set(sid, live);
    const rec = sessions.readSession(sid);
    const action = decide(rec, ctx.running, now, waiterAlive);
    if (action === "flag") sessions.setPending(sid, true);
    if (action === "skip") ctx.pending.delete(sid);
    if (action !== "wake") {
      if (ctx.armGrace) ctx.armGrace.delete(sid);
      continue;
    }
    // No waiter yet: the words stay on the phone a few seconds for one that is arming.
    if (inArmGrace(ctx, rec, now)) continue;
    // Each fetched batch is stashed on disk before the phone drops it, so a helper that dies
    // between the claim and the run loses nothing (recoverStashes picks it up at the next start).
    try {
      await sessions.claim(ctx.cfg, sid, ctx, (fresh) => sessions.stashMessages(sid, fresh));
    } catch (err) {
      log(`claim ${sid}: ${err.message}; will retry`);
      continue;
    }
    ctx.pending.delete(sid);
    if (ctx.armGrace) ctx.armGrace.delete(sid);
    await dispatchStash(ctx, sessions.readSession(sid) || rec);
  }
}

/**
 * Hand what is stashed for a session to the right path. A terminal prompt may have made the
 * session busy while the claim waited on the phone: then its own hooks deliver the stash.
 * Otherwise the session is woken in its own window, or they hear it could not be reached on
 * screen. Never a hidden or forked run (FOLLOWUPS item 57).
 */
async function dispatchStash(ctx, rec) {
  if (!rec || !sessions.hasStash(rec.id)) return;
  const now = Date.now();
  const action = decide(rec, ctx.running, now, waiterAlive);
  // Busy, or a waiter armed while the words were being claimed: they stay in the stash for the
  // session's own hooks or waiter (which reads the stash too). Never deleted undelivered.
  if (action === "flag" || action === "skip") {
    sessions.setPending(rec.id, true);
    return;
  }
  // Under the claim lock, so a hook of the same session cannot take the same stash meanwhile.
  const taken = (await sessions.withClaimLock(rec.id, () => sessions.takeStash(rec.id))) || [];
  // Being taken off a conference call never wakes an idle session (spec 01 section 4).
  const wake = taken.filter((m) => !isLeftMessage(m));
  if (!wake.length) return;
  const answer = visibleWake.canQueue(ctx.cfg, rec, ctx)
    ? queueToCodex(ctx, rec, wake)
    : unreachable(ctx, rec, wake, visibleWake.unreachableReason(ctx.cfg, rec, ctx));
  const run = answer.finally(() => ctx.runs.delete(run));
  ctx.runs.add(run);
}

// A waiter is (re)armed by the session's own hooks: right after it starts, and after every turn
// (the Stop hook starts a new one), there are a few seconds with none. Words for a Claude Code or
// agy session that land in that gap stay on the phone this long (so the waiter, once armed, takes
// them itself) before they hear the session could not be reached.
const ARM_GRACE_MS = 20 * 1000;

/** True while words for `rec` should stay on the phone for a waiter that is about to arm. */
function inArmGrace(ctx, rec, now) {
  const client = clients.clientOf(rec);
  if (client !== "claude-code" && !(client === "agy" && visibleWake.agyWakeOn(ctx.cfg))) return false;
  if (!ctx.armGrace) ctx.armGrace = new Map();
  const grace = ctx.armGraceMs === undefined ? ARM_GRACE_MS : ctx.armGraceMs;
  if (!ctx.armGrace.has(rec.id)) ctx.armGrace.set(rec.id, now + grace);
  // The entry is cleared only once the words were claimed, so a failed claim does not restart it.
  return now < ctx.armGrace.get(rec.id);
}

/** Adds `key` to a once-per-call set, keeping at most the newest 500 keys. */
function rememberOnce(set, key) {
  set.add(key);
  if (set.size > 500) set.delete(set.values().next().value);
}

/**
 * The session cannot be woken on screen: the call hears "<name> could not be reached on screen"
 * (on a conference, under that session's seat) and the helper log says why. Resolves "unreachable".
 */
async function unreachable(ctx, rec, msgs, reason, opts = {}) {
  const last = msgs[msgs.length - 1];
  const name = sessions.sessionName(rec) || "That session";
  log(`unreachable ${rec.id} (${clients.labelOf(clients.clientOf(rec))}): ${reason}`);
  // Their words are kept for the session's own hooks: the next time it runs a hook (they type in
  // its window) it still hears what they said. Never a hidden run.
  const keep = opts.keep === false ? [] : msgs.filter((m) => !isCallStarted(m));
  if (keep.length) {
    sessions.stashMessages(rec.id, keep);
    sessions.setPending(rec.id, true);
  }
  // Once per session per call: the call-started notice and their first words must not both say it.
  const key = `${rec.id}:${last.call_id}`;
  if (!ctx.unreachableSaid) ctx.unreachableSaid = new Set();
  if (ctx.unreachableSaid.has(key)) return "unreachable";
  rememberOnce(ctx.unreachableSaid, key);
  // FOLLOWUPS 57 APP CONTRACT: the phone itself says "<name> could not be reached on screen right
  // now." and ends a 1:1 call. Only when that PUT fails does the helper say it on the call.
  const plain = reachLib.idleReason(ctx.cfg || {}, rec);
  const down = { callable: false, how: null, reason: plain };
  try {
    const body = { ...sessions.wire(rec, Date.now(), { reach: down }), wake_failed: plain, ...(last.call_id ? { call_id: last.call_id } : {}) };
    await ctx.api.putSession(ctx.cfg, rec.id, body);
    noteReach(ctx, rec, down);
    return "unreachable";
  } catch (err) {
    log(`unreachable ${rec.id}: the phone did not take wake_failed (${err.message}); saying it on the call`);
  }
  try {
    const pid = last.conference && last.conference.participant_id;
    await ctx.api.say(ctx.cfg, last.call_id, `${name} could not be reached on screen.`, false, 30, pid || undefined);
  } catch (err) {
    log(`unreachable ${rec.id}: could not tell the call (${err.message})`);
  }
  return "unreachable";
}

/** Runs a short local command (never a model call, never a shell); resolves { code, out }. */
function runLocal(ctx, argv, cwd) {
  const [cmd, ...args] = argv;
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = ctx.spawn(cmd, args, { cwd, env: lock.helperEnv(ctx.env), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      resolve({ code: -1, out: err.message });
      return;
    }
    const add = (c) => {
      if (out.length < 4096) out += c.toString("utf8");
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    child.on("error", (err) => resolve({ code: -1, out: err.message }));
    child.on("close", (code) => resolve({ code, out }));
  });
}

/**
 * Visible wake for an idle Codex session whose own process still runs (lib/visible-wake.js):
 * `codex queue` hands their words to that session, which answers in its own window. When the queue
 * fails, or no turn starts there within QUEUE_CONFIRM_MS, they hear it could not be reached.
 */
async function queueToCodex(ctx, rec, msgs) {
  ctx.running.add(rec.id);
  try {
    return await queueOnce(ctx, rec, msgs);
  } finally {
    ctx.running.delete(rec.id);
  }
}

async function queueOnce(ctx, rec, msgs) {
  const sid = rec.id;
  const since = Date.now();
  const base = visibleWake.transcriptSize(sessions.readSession(sid) || rec);
  const cwd = rec.cwd && fs.existsSync(rec.cwd) ? rec.cwd : os.homedir();
  const argv = visibleWake.queueArgv(ctx.cfg, sid, sessions.describeMessages(msgs), ctx.env);
  const res = await runLocal(ctx, argv, cwd);
  if (res.code !== 0) {
    return unreachable(ctx, rec, msgs, `codex queue failed (exit ${res.code}): ${String(res.out).trim().slice(0, 300)}`);
  }
  log(`codex queue ${sid}: woke it in its own window (pid ${rec.owner_pid})`);
  const wait = ctx.queueConfirmMs === undefined ? QUEUE_CONFIRM_MS : ctx.queueConfirmMs;
  const end = Date.now() + wait;
  while (Date.now() < end) {
    if (visibleWake.turnStarted(sessions.readSession(sid), since, base)) return "visible";
    await (ctx.sleep || sleep)(Math.min(1000, Math.max(1, end - Date.now())));
  }
  if (visibleWake.turnStarted(sessions.readSession(sid), since, base)) return "visible";
  // Codex holds the queued message and may still run it: the words are not kept a second time.
  return unreachable(ctx, rec, msgs, `queued, but no turn started in its window within ${Math.round(wait / 1000)} s (it may still run the message later)`, { keep: false });
}

/** At startup: stashes a previous helper took from the phone but never delivered. */
async function recoverStashes(ctx) {
  // A stash with the pending flag up waits for that session's own hooks (kept when it could not
  // be reached on screen): it is not dispatched again.
  for (const rec of sessions.listSessions()) if (rec && !sessions.hasPending(rec.id)) await dispatchStash(ctx, rec);
}

const cursorFile = () => path.join(sessions.stateDir(), "helper_cursor");

function loadMachineCursor() {
  try {
    const v = fs.readFileSync(cursorFile(), "utf8").trim();
    return /^\d+$/.test(v) ? v : "";
  } catch {
    return "";
  }
}

function saveMachineCursor(cursor) {
  try {
    fs.mkdirSync(path.dirname(cursorFile()), { recursive: true });
    fs.writeFileSync(cursorFile(), cursor);
  } catch (err) {
    log(`cursor: ${err.message}`);
  }
}

function mergeMessages(ctx, res) {
  if (res.cursor !== undefined) {
    // A lower cursor means the phone restarted; its ids start again from 1, so every stored
    // cursor (this one and each session's) is meaningless now.
    if (ctx.cursor && Number(res.cursor) < Number(ctx.cursor)) {
      ctx.pending.clear();
      sessions.resetCursors();
      log("phone restarted; cursors reset");
    }
    ctx.cursor = String(res.cursor);
    saveMachineCursor(ctx.cursor);
  }
  for (const m of res.messages || []) {
    if (!sessions.safeId(m.session_id)) continue;
    const list = ctx.pending.get(m.session_id) || [];
    if (!list.some((x) => x.id === m.id)) ctx.pending.set(m.session_id, [...list, m]);
  }
}

/**
 * At startup: what is still waiting on the phone for this machine, whatever the stored cursor
 * says. The machine poll acknowledges nothing, so anything a previous helper saw but never
 * claimed (it crashed, or its claim failed) is still there. Already-taken ids are filtered by the
 * session cursors in processPending. The stored cursor is left alone: it detects a phone restart.
 */
async function replayUnclaimed(ctx) {
  try {
    const res = await ctx.api.machineInbox(ctx.cfg, MACHINE, "", 0);
    for (const m of res.messages || []) {
      if (!sessions.safeId(m.session_id)) continue;
      const list = ctx.pending.get(m.session_id) || [];
      if (!list.some((x) => x.id === m.id)) ctx.pending.set(m.session_id, [...list, m]);
    }
  } catch (err) {
    log(`replay: ${err.message}`);
  }
}

/** Tells the phone this helper is here, its recent folders and whether it may start sessions (item 21). */
async function reportMachine(ctx) {
  try {
    await ctx.api.putMachine(ctx.cfg, MACHINE, {
      platform: process.platform,
      folders: starts.recentFolders(),
      can_start: !starts.refusal(ctx.cfg, ctx.env),
      tools: detectTools(),
    });
  } catch (err) {
    log(`machine report: ${err.message}`);
  }
}

/** Start requests from the phone that rode on the inbox answer (FOLLOWUPS items 21, 21b). */
async function runStarts(ctx, list) {
  if (!list || !list.length) return;
  await starts.handleStarts(
    {
      cfg: ctx.cfg,
      env: ctx.env,
      api: ctx.api,
      platform: process.platform,
      home: os.homedir(),
      hostname: os.hostname(),
      handledStarts: ctx.handledStarts,
      command: claudeCommand(ctx.cfg, ctx.env),
      spawnDetached: ctx.spawnDetached,
      log,
    },
    MACHINE,
    list,
  );
}

/** One poll and its follow-up. Returns false when the helper should exit. */
async function step(ctx) {
  if (!lock.ownsLock(ctx.pid)) return false;
  const cfg = loadConfig();
  if (!isConfigured(cfg)) return false;
  if (ctx.net && ctx.net.stopped) return false;
  ctx.cfg = cfg;
  try {
    const wait = ctx.pending.size ? POLL_WAIT_PENDING_S : POLL_WAIT_S;
    const res = await ctx.api.machineInbox(cfg, MACHINE, ctx.cursor, wait);
    // A newer helper may have taken over during the long poll; it handles these messages.
    if (!lock.ownsLock(ctx.pid)) return false;
    mergeMessages(ctx, res);
    await runStarts(ctx, res.starts);
    ctx.backoffMs = 0;
    ctx.failures = 0;
  } catch (err) {
    ctx.failures = (ctx.failures || 0) + 1;
    log(`poll: ${err.message}`);
    // First failure: retry at once on another host (the client marked this one failed).
    if (ctx.failures > 1) {
      ctx.backoffMs = Math.min(60_000, (ctx.backoffMs || 2_500) * 2);
      await (ctx.sleep || sleep)(ctx.backoffMs);
    }
  }
  await processPending(ctx);
  if (ctx.service) return true;
  const anyLive = sessions.listSessions().some((r) => beatState(r, ctx.running, Date.now()));
  return anyLive || ctx.running.size > 0;
}

const SERVICE_RETRY_MS = 30 * 1000;

/**
 * The service waits instead of exiting while it cannot run: not configured yet, or another
 * helper (an ad-hoc one of the same version, or a newer one) holds the lock. Exiting would only
 * make the OS restart it in a loop. Resolves with the config once this process holds the lock.
 */
async function serviceWaitForLock(argv, wait = sleep) {
  for (;;) {
    const cfg = loadConfig();
    if (isConfigured(cfg) && lock.acquire(process.pid, lock.VERSION, argv.includes("--takeover"))) return cfg;
    await wait(SERVICE_RETRY_MS);
  }
}

/**
 * FOLLOWUPS item 48b: sessions recorded before 0.7.2 learn where they run (the Desktop app's Code
 * tab or a terminal) from their transcript's entrypoint or their claude process.
 */
function remarkOrigins(deps = {}) {
  let changed = 0;
  for (const rec of sessions.listSessions()) {
    if (rec.ended || clients.clientOf(rec) !== clients.CLAUDE_CODE) continue;
    const next = origin.withOrigin(rec, deps);
    if (next === rec) continue;
    sessions.writeSession(rec.id, next);
    changed += 1;
    log(`origin ${rec.id}: ${next.runs_in}`);
  }
  return changed;
}

/** The machine side (helper/net.js) for this helper; null when it cannot start. */
function startMachine(ctx) {
  try {
    const { runNet } = require("./net.js");
    const onAvatar = (ev) => {
      const run = require("../lib/avatar.js")
        .handleAvatar(ev, { cfg: loadConfig(), api: ctx.api, env: ctx.env, log, claudeCommand: claudeCommand(ctx.cfg, ctx.env), handled: ctx.handledAvatars })
        .catch((err) => log(`avatar: ${err.message}`))
        .finally(() => ctx.runs.delete(run));
      ctx.runs.add(run);
    };
    const onAnnounce = () => {
      beatAll(ctx).catch((err) => log(`announce: ${err.message}`));
    };
    return runNet({ log, onAvatar, onAnnounce }).net;
  } catch (err) {
    log(`machine: ${err.message}`);
    return null;
  }
}

function newContext(overrides = {}) {
  return {
    pid: process.pid,
    cfg: loadConfig(),
    env: process.env,
    api,
    spawn,
    cursor: "",
    pending: new Map(),
    running: new Set(),
    runs: new Set(),
    processName: cachedNames(),
    handledStarts: new Set(),
    handledAvatars: new Set(),
    backoffMs: 0,
    service: false,
    net: null,
    ...overrides,
  };
}

async function main(argv) {
  // FOLLOWUPS item 50g: nothing this helper starts may inherit "inside a Claude Code session" markers.
  lock.scrubOwnEnv(process.env);
  // Step 4: `desk start [url] | stop | status` is a local command, not a helper run.
  if (argv[0] === "desk") {
    await require("./desk-cli.js").deskCli(argv.slice(1));
    return;
  }
  const tools = prepareRuntime();
  const service = argv.includes("--service");
  let cfg = loadConfig();
  if (service) {
    cfg = await serviceWaitForLock(argv);
  } else {
    if (!isConfigured(cfg)) return;
    if (!lock.acquire(process.pid, lock.VERSION, argv.includes("--takeover"))) return;
  }
  process.on("exit", () => lock.release(process.pid));
  const ctx = newContext({ cfg, cursor: loadMachineCursor(), service });
  if (!tools.claudePath && !cfg.claude_command && !process.env.RINGBACK_CLAUDE_COMMAND) missingBinary(ctx, "claude");
  if (!tools.codexPath) missingBinary(ctx, "codex");
  ctx.net = startMachine(ctx);
  log(`helper ${lock.VERSION} started on ${MACHINE} (pid ${process.pid}${service ? ", service" : ""})`);
  remarkOrigins();
  await beatAll(ctx);
  await reportMachine(ctx);
  await dropGhosts(ctx);
  await recoverStashes(ctx);
  await replayUnclaimed(ctx);
  let beats = 0;
  const beat = setInterval(() => {
    beats += 1;
    beatAll(ctx).catch((err) => log(`heartbeat: ${err.message}`));
    if (beats % MACHINE_EVERY_BEATS === 0) reportMachine(ctx);
    if (beats % 60 === 0) require("../lib/plugin-copy.js").pruneHome(configDir(), { onError: (err) => log(`state cleanup: ${err.message}`) });
  }, BEAT_EVERY_MS);
  const status = setInterval(() => {
    watchStatus(ctx).catch((err) => log(`status: ${err.message}`));
  }, STATUS_EVERY_MS);
  const reachTimer = setInterval(() => {
    watchReach(ctx).catch((err) => log(`reach: ${err.message}`));
  }, REACH_EVERY_MS);
  // Step 4: live terminals and screens, in the background next to the inbox loop.
  const streams = require("./streams.js").startStreams({ log: (l) => log(l) });
  // A tap on a card reaches the session that showed it (helper/card-taps.js).
  const cardTaps = require("./card-taps.js").start(ctx, { log, dispatch: dispatchStash });
  try {
    while (await step(ctx)) {
      // Keep polling while this machine has live sessions.
    }
  } finally {
    clearInterval(beat);
    clearInterval(status);
    clearInterval(reachTimer);
    if (ctx.net) ctx.net.stop();
    streams.stop();
    cardTaps.stop();
    await Promise.allSettled([...ctx.runs]);
    log("helper exiting");
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .catch((err) => log(`helper crashed: ${err && err.stack ? err.stack : err}`))
    .finally(() => process.exit(0));
}

module.exports = {
  MACHINE,
  claudeCommand,
  decide,
  beatState,
  unreachable,
  watchReach,
  ownerGone,
  cachedNames,
  dropGhosts,
  dropSession,
  processPending,
  mergeMessages,
  replayUnclaimed,
  recoverStashes,
  dispatchStash,
  step,
  newContext,
  serviceWaitForLock,
  main,
  beatAll,
  watchStatus,
  readAgents,
  reportMachine,
  runStarts,
  remarkOrigins,
  queueToCodex,
  QUEUE_CONFIRM_MS,
  prepareRuntime,
};
