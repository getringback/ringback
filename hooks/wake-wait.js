#!/usr/bin/env node
"use strict";
// SessionStart / UserPromptSubmit / PostToolUse / Stop, registered with "asyncRewake": true (from
// any hook, so a session reloaded with /reload-plugins is armed on its next hook, FOLLOWUPS item 12). Runs in the background while the
// session sits idle (in its terminal or the Claude Desktop Code tab) and long-polls the phone for words the user says on a call to
// THIS session. When some arrive it prints them to stderr and exits 2: Claude Code then wakes
// this same session, where it runs, with the words as a system reminder (no hidden copy,
// no --channels). The next Stop starts a new waiter, so it re-arms after every turn.
// One waiter per session (exclusive slot file with a heartbeat); the helper leaves a session whose
// waiter is alive to it, and tells the phone the session cannot be reached when none is.

const fs = require("fs");
const path = require("path");
const { loadConfig, isConfigured, configDir } = require("../lib/config.js");
const { api } = require("../lib/client.js");
const { safeId, readCursor, drain, hookCfg, describeMessages, clearNeedsYou, readSession, heartbeat, hasStash, setPending, stashMessages } = require("../lib/sessions.js");
const { isBusy } = require("../lib/busy.js");
const turns = require("../lib/turns.js");
const { readStdin, logError, isSubagentHook } = require("./common.js");
const { isLeftMessage } = require("../lib/conference.js");
const { isCallStarted } = require("../lib/inbox-format.js");

const POLL_WAIT_S = 50;
// Stay a little under the hook timeout in hooks.json, so we exit cleanly instead of being killed.
const LIFETIME_MS = 23 * 60 * 60 * 1000;
const RETRY_MS = 15_000;
// A busy session's words wait for its own hooks this long at most (see waitForWords).
const HOLD_MAX_MS = 60_000;
const HOLD_POLL_MS = 2_000;

const waiterFile = (id) => path.join(configDir(), "state", "waiters", `${safeId(id)}.pid`);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// The slot is two files: <id>.pid holds only the waiter's pid (as every helper version reads it),
// <id>.beat holds {started, beat, owner}. beat is refreshed at every poll (at most every
// POLL_WAIT_S), so a killed, hung or timed-out waiter, or a pid reused by another program, stops
// counting within BEAT_STALE_MS; owner is the claude process it serves (CLAUDE_PID). A waiter
// from before 0.7.11 has no beat file and counts while its process lives.
const BEAT_STALE_MS = 3 * 60 * 1000;
const beatFile = (id) => path.join(configDir(), "state", "waiters", `${safeId(id)}.beat`);

function readWaiter(id) {
  let pid = 0;
  try {
    const raw = fs.readFileSync(waiterFile(id), "utf8").trim();
    // A JSON slot was written by a short-lived 0.7.11 build: read its pid and beat from it.
    if (raw.startsWith("{")) {
      const v = JSON.parse(raw);
      return Number(v.pid) > 0 ? { pid: Number(v.pid), beat: Number(v.beat) || 0, started: Number(v.started) || 0, owner: Number(v.owner) || 0 } : null;
    }
    pid = Number(raw);
  } catch {
    return null;
  }
  if (!(pid > 0)) return null;
  try {
    const v = JSON.parse(fs.readFileSync(beatFile(id), "utf8"));
    if (v && Number(v.pid) === pid) return { pid, beat: Number(v.beat) || 0, started: Number(v.started) || 0, owner: Number(v.owner) || 0 };
  } catch {
    // An older waiter (no beat file), or one that is writing it right now.
  }
  return { pid, beat: null, started: null, owner: 0 };
}

/**
 * True while a working waiter for session `id` runs: its process lives, it polled recently, and
 * the claude process it belongs to (owner, from CLAUDE_PID) still runs. On Windows a waiter can
 * outlive a closed session; such an orphan never counts.
 */
function waiterAlive(id, now = Date.now()) {
  const w = readWaiter(id);
  if (!w || !alive(w.pid)) return false;
  if (w.owner && !alive(w.owner)) return false;
  return w.beat === null || now - w.beat < BEAT_STALE_MS;
}

/** The waiter record for `id` with whether it counts: { pid, started, beat, owner, alive } or null. */
function waiterInfo(id, now = Date.now()) {
  const w = readWaiter(id);
  return w ? { ...w, alive: waiterAlive(id, now) } : null;
}

// The claude process this waiter serves (Claude Code sets CLAUDE_PID for hooks; agy and Codex
// hooks have none, so 0: then only the waiter's own process and beat count).
const ownerPid = (env = process.env) => (Number(env.CLAUDE_PID) > 0 ? Number(env.CLAUDE_PID) : 0);

/**
 * Writes the beat file; true when it landed. On Windows a rename fails (EPERM, EBUSY) while
 * another process reads the target, so it is tried a few times; a miss is never fatal.
 */
function writeBeat(id, pid, started, beat, owner) {
  const file = beatFile(id);
  const tmp = `${file}.${pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ pid, started, beat, ...(owner ? { owner } : {}) }));
  } catch {
    return false;
  }
  for (let i = 0; i < 5; i += 1) {
    try {
      fs.renameSync(tmp, file);
      return true;
    } catch {
      const until = Date.now() + 20;
      while (Date.now() < until) {
        // A short spin: the reader holds the file for well under a millisecond.
      }
    }
  }
  fs.rmSync(tmp, { force: true });
  return false;
}

/**
 * Takes the waiter slot for `id`; false when another working waiter holds it. Exclusive create,
 * so two hooks arming at the same moment never both become the waiter; a dead, orphaned or stale
 * holder is replaced.
 */
function claimSlot(id, pid = process.pid, now = Date.now(), owner = ownerPid()) {
  const file = waiterFile(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, String(pid), { flag: "wx" });
    } catch (err) {
      if (err.code !== "EEXIST") return false;
      if (waiterAlive(id, now)) return false;
      fs.rmSync(file, { force: true });
      continue;
    }
    // Best effort: without a beat file the slot still counts while this process lives.
    writeBeat(id, pid, now, now, owner);
    return true;
  }
  return false;
}

/** Refreshes this waiter's beat; false when the slot is no longer ours. */
function beatSlot(id, pid = process.pid, now = Date.now()) {
  const w = readWaiter(id);
  if (!w || w.pid !== pid) return false;
  // A beat that could not be written this time is retried at the next poll: still our slot.
  writeBeat(id, pid, w.started || now, now, w.owner);
  return true;
}

/** False once the claude process recorded as this slot's owner is gone (no owner: true). */
function ownerLives(id) {
  const w = readWaiter(id);
  return !w || !w.owner || alive(w.owner);
}

function releaseSlot(id, pid = process.pid) {
  const w = readWaiter(id);
  if (w && w.pid === pid) {
    fs.rmSync(waiterFile(id), { force: true });
    fs.rmSync(beatFile(id), { force: true });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PRINT_FLAG = /(^|\s)(-p|--print)(\s|$)/;

// Command lines of this process's ancestors (nearest first), shared with lib/permissions.js.
const { ancestorCommandLines } = require("../lib/proc.js");

// Entrypoints of interactive Claude Code sessions that stay open and take an asyncRewake wake
// while idle: the terminal ("cli") and the Claude Desktop app's Code tab ("claude-desktop", a
// long-lived stream-json session that runs the same hooks; Desktop has no -p mode). `claude -p`
// is "sdk-cli", the Agent SDK "sdk-ts" / "sdk-py": never armed there.
const INTERACTIVE_ENTRYPOINTS = Object.freeze(["cli", "claude-desktop"]);

const isInteractiveEntrypoint = (entry) => INTERACTIVE_ENTRYPOINTS.includes(String(entry || ""));

/**
 * True for headless runs (`claude -p`, SDK, automation). The waiter must never run there: an
 * asyncRewake hook keeps a -p process open until it exits, so every headless run would hang.
 */
function isHeadless(env = process.env, lines = null) {
  // Unknown entrypoint (not launched by an interactive Claude Code): do not linger.
  if (!isInteractiveEntrypoint(env.CLAUDE_CODE_ENTRYPOINT)) return true;
  const cmds = lines || ancestorCommandLines();
  return cmds.some((c) => /claude/i.test(c) && PRINT_FLAG.test(c));
}

/**
 * Waits until the user says something to session `id` on a call; returns the text to wake the
 * session with, or "" when the lifetime ran out or the phone is not configured.
 */
/**
 * Defaults: the real phone, clock and lifetime, this process beating its own slot, stopping once
 * its claude process is gone, and putting the session back on the phone when the phone forgot it.
 */
const waitDefaults = (id) => ({
  api,
  now: () => Date.now(),
  sleep,
  lifetimeMs: LIFETIME_MS,
  // The owner recorded in our own slot (0 for agy and Codex), not whatever CLAUDE_PID we inherited.
  beat: () => beatSlot(id) && ownerLives(id),
  reregister: () => reregister(id),
  waitingNudge: () => turns.waitingNudge(id, { cfg: loadConfig(), busy: isBusy(readSession(id), Date.now()) }),
});

const REREGISTER_EVERY_MS = 60 * 1000;
let lastReregister = 0;

/**
 * The phone answered "No such session" (it restarted, or dropped the session while this
 * computer was away): put this session back on its list from the local record, at most once a
 * minute, so they can see and call it again.
 */
async function reregister(id, now = Date.now()) {
  if (now - lastReregister < REREGISTER_EVERY_MS) return false;
  lastReregister = now;
  const rec = readSession(id);
  if (!rec || rec.ended) return false;
  const cfg = loadConfig();
  if (!isConfigured(cfg)) return false;
  await heartbeat(hookCfg(cfg), { session_id: id, cwd: rec.cwd, transcript_path: rec.transcript_path }, rec.state || "idle", { api, now }, true);
  return true;
}

async function waitForWords(id, given) {
  const deps = given || waitDefaults(id);
  const cfg = loadConfig();
  if (!isConfigured(cfg)) return "";
  const end = deps.now() + deps.lifetimeMs;
  let failures = 0;
  let heldSince = 0;
  const busyNow = deps.isBusy || (() => isBusy(readSession(id), deps.now()));
  // Words for a session that is mid-turn go to its own hooks (pending flag: the next PostToolUse,
  // or the Stop hook, which blocks so the session answers): a rewake injected into a running turn
  // was seen swallowed (reliability run, first turn). Held at most HOLD_MAX_MS, then woken anyway.
  const holdForHooks = async () => {
    if (!busyNow()) return false;
    if (!heldSince) heldSince = deps.now();
    if (deps.now() - heldSince >= HOLD_MAX_MS) return false;
    setPending(id, true);
    await deps.sleep(HOLD_POLL_MS);
    return true;
  };
  // The hold ran out on a session still mid-turn, so this wake goes into a running turn, where one
  // was seen swallowed. The call-started notice (never the words: those would be answered twice)
  // stays for its next hook; picking up twice is harmless, a call nobody picks up is not.
  const wokenBusy = (wake) => {
    const held = heldSince !== 0 && busyNow();
    heldSince = 0;
    if (!held) return;
    const notices = wake.filter(isCallStarted);
    if (!notices.length) return;
    stashMessages(id, notices);
    setPending(id, true);
  };
  while (deps.now() < end) {
    // Our slot was taken over (we were seen as dead): the other waiter delivers now.
    if (deps.beat && !deps.beat()) return "";
    // Waiting on the user with no reply: wake this session so it phones them (polls last at most 50 s).
    const waiting = deps.waitingNudge ? deps.waitingNudge() : null;
    if (waiting) return waiting;
    // Words already on this computer (kept when the session could not be reached, or claimed by
    // the helper while this waiter armed) wake it at once; the phone will not send them again.
    if (hasStash(id) && (await holdForHooks())) continue;
    if (hasStash(id)) {
      const kept = ((await drain(hookCfg(cfg), id, deps, false)) || []).filter((m) => !isLeftMessage(m));
      if (kept.length) {
        wokenBusy(kept);
        return describeMessages(kept);
      }
    }
    try {
      // Long-poll without acknowledging anything new (since = our own cursor).
      const res = await deps.api.sessionInbox(cfg, id, readCursor(id), POLL_WAIT_S);
      if ((res.messages || []).length) {
        if (await holdForHooks()) continue;
        const msgs = await drain(hookCfg(cfg), id, deps);
        // Being taken off a conference call is no reason to wake the session.
        const wake = (msgs || []).filter((m) => !isLeftMessage(m));
        if (wake.length) {
          wokenBusy(wake);
          return describeMessages(wake);
        }
        // Another hook took them under the claim lock (session was busy): keep waiting.
      }
      // Nothing waits now: a hold left over from words a hook already took must not count against
      // the next call, or that one would skip its hold and rewake a running turn at once.
      heldSince = 0;
      failures = 0;
    } catch (err) {
      logError("wake-wait poll", err);
      failures += 1;
      if (err.status === 404 && deps.reregister) await Promise.resolve(deps.reregister()).catch((e) => logError("wake-wait reregister", e));
      // The first failure retries at once: the client marked that host failed, so the retry
      // starts on another one (Tailscale first). Only repeated failures wait (FOLLOWUPS item 8).
      if (failures > 1) await deps.sleep(RETRY_MS);
    }
  }
  return "";
}

// The headless answer per claude process (state/headless/<claude pid>): the waiter now runs from
// every hook (FOLLOWUPS item 12), so the process lookup happens once per process, not per tool.
const headlessFile = (pid) => path.join(configDir(), "state", "headless", `${Number(pid) || 0}`);

// One lookup per claude process at a time: while one runs, other hooks leave without arming and a
// later hook tries again, so a slow lookup can never pile up one process per tool call.
const SCAN_HOLD_MS = 30_000;

function claimScan(marker, now) {
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  try {
    fs.writeFileSync(marker, String(process.pid), { flag: "wx" });
    return true;
  } catch (err) {
    if (err.code !== "EEXIST") return true;
  }
  try {
    if (now - fs.statSync(marker).mtimeMs < SCAN_HOLD_MS) return false;
    fs.writeFileSync(marker, String(process.pid));
  } catch {
    // Gone or being replaced: this lookup is still only a cache fill.
  }
  return true;
}

function cachedHeadless(pid, lookup, now = Date.now()) {
  const file = headlessFile(pid);
  try {
    const v = fs.readFileSync(file, "utf8").trim();
    if (v === "1" || v === "0") return v === "1";
  } catch {
    // Not decided yet for this process.
  }
  const marker = `${file}.scan`;
  if (!claimScan(marker, now)) return true;
  const answer = lookup();
  try {
    fs.writeFileSync(file, answer ? "1" : "0");
  } catch {
    // Only a cache.
  }
  fs.rmSync(marker, { force: true });
  return answer;
}

/**
 * Whether this hook should become the session's waiter: "alive" (one already waits; the common
 * case, answered from one file read), "headless" (never in -p / SDK / helper runs), or "ok".
 */
function startCheck(id, deps = {}) {
  const env = deps.env || process.env;
  if (waiterAlive(id)) return "alive";
  if (env.RINGBACK_HELPER_RUN) return "headless";
  if (!isInteractiveEntrypoint(env.CLAUDE_CODE_ENTRYPOINT)) return "headless";
  const pid = deps.pid || Number(env.CLAUDE_PID) || process.ppid;
  const lines = deps.lines || (() => ancestorCommandLines(pid));
  return cachedHeadless(pid, () => isHeadless(env, lines())) ? "headless" : "ok";
}

async function main() {
  const input = await readStdin().catch(() => ({}));
  const id = safeId(input.session_id);
  // A waiter armed from a subagent's hook could rewake that subagent instead of the session.
  if (!id || isSubagentHook(input) || startCheck(id) !== "ok" || !claimSlot(id)) process.exit(0);
  let code = 0;
  try {
    const text = await waitForWords(id);
    if (text) {
      // Woken by a call: it is busy with them now, not waiting on them (FOLLOWUPS item 37).
      await clearNeedsYou(loadConfig(), id);
      process.stderr.write(text);
      code = 2;
    }
  } catch (err) {
    logError("wake-wait", err);
  } finally {
    releaseSlot(id);
  }
  process.exit(code);
}

if (require.main === module) main();

module.exports = {
  INTERACTIVE_ENTRYPOINTS,
  isInteractiveEntrypoint,
  waitForWords,
  waiterAlive,
  waiterInfo,
  readWaiter,
  beatSlot,
  reregister,
  BEAT_STALE_MS,
  claimSlot,
  releaseSlot,
  waiterFile,
  isHeadless,
  ancestorCommandLines,
  startCheck,
};
