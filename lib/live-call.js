"use strict";
// The call this session is on right now (live call c_AxaZEQ5c2_yI, 2026-11-15). On a call the agent
// placed, the phone keeps what the user says between two say/listen requests in that call's own
// queue (only calls placed TO a session route it to the session inbox), so a session that said one
// line and went back to work heard nothing until its next call_listen. The MCP call tools note the
// call here; the inbox hook then takes those words with a zero-wait listen (lib/call-nudge.js).
// Files under state/live-calls, one writer each, so no process overwrites another's fields:
//   <sid>.json      the call (call_id, participant_id, at), written by the MCP server only
//   <sid>.inflight  a call_say / call_listen of this session is running now (MCP server)
//   <sid>.polled    when a hook last asked the phone (hooks only)
//   <sid>.polling   a hook is asking the phone right now (lock, hooks only)

const fs = require("fs");
const path = require("path");
const { configDir } = require("./config.js");

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CALL = /^[A-Za-z0-9_-]{1,64}$/;
const PARTICIPANT = /^pt_[A-Za-z0-9_-]{1,64}$/;
// No call tool used for this long: the call is treated as gone (a session that never heard it end).
const STALE_MS = 2 * 60 * 60 * 1000;
// A say/listen holds the line at most its wait (120 s) plus the ring and speech; older marks are left over.
const INFLIGHT_MS = 5 * 60 * 1000;
// At most one phone request per session this often, however many tools run.
const POLL_EVERY_MS = 3000;
const LOCK_STALE_MS = 20 * 1000;

const dir = () => path.join(configDir(), "state", "live-calls");
const fileOf = (sid, ext) => path.join(dir(), `${sid}.${ext}`);
const okId = (sid) => SESSION_ID.test(String(sid || ""));

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** The fast path for every hook: one existsSync, no read, no network. */
const hasLiveCall = (sid) => okId(sid) && fs.existsSync(fileOf(sid, "json"));

function readLiveCall(sid) {
  if (!okId(sid)) return null;
  try {
    const rec = JSON.parse(fs.readFileSync(fileOf(sid, "json"), "utf8"));
    return rec && CALL.test(String(rec.call_id || "")) ? rec : null;
  } catch {
    return null;
  }
}

/** The MCP server heard the call is live (a say / listen / call_user reply). Never throws. */
function noteLiveCall(sid, callId, participantId, now = Date.now()) {
  try {
    if (!okId(sid) || !CALL.test(String(callId || ""))) return;
    const old = readLiveCall(sid);
    const pid = PARTICIPANT.test(String(participantId || "")) ? participantId : old && old.call_id === callId ? old.participant_id : undefined;
    writeAtomic(fileOf(sid, "json"), JSON.stringify({ call_id: callId, ...(pid ? { participant_id: pid } : {}), at: now }));
  } catch {
    // Only the nudge depends on it; the call itself goes on.
  }
}

/** The call ended or this session left it: stop polling. Only `callId` when given. Never throws. */
function clearLiveCall(sid, callId) {
  try {
    if (!okId(sid)) return;
    const rec = readLiveCall(sid);
    if (callId && rec && rec.call_id !== callId) return;
    for (const ext of ["json", "inflight", "polled"]) fs.rmSync(fileOf(sid, ext), { force: true });
  } catch {
    // Best effort.
  }
}

/** A call_say / call_listen of this session is running (on) or done (off). Never throws. */
function setInflight(sid, on) {
  try {
    if (!okId(sid)) return;
    if (on) writeAtomic(fileOf(sid, "inflight"), String(Date.now()));
    else fs.rmSync(fileOf(sid, "inflight"), { force: true });
  } catch {
    // A missing mark only means a hook may take words the running listen would have taken.
  }
}

/**
 * The call a hook should ask the phone about now, or null: none, stale, a say / listen of this
 * session is on the line, or another hook asked less than POLL_EVERY_MS ago (unless `force`: the
 * Stop hook, the last chance before the session goes quiet).
 */
function dueLiveCall(sid, now = Date.now(), force = false) {
  const rec = readLiveCall(sid);
  if (!rec) return null;
  if (!(now - Number(rec.at || 0) < STALE_MS)) {
    clearLiveCall(sid, rec.call_id);
    return null;
  }
  const inflight = mtime(fileOf(sid, "inflight"));
  if (inflight && now - inflight < INFLIGHT_MS) return null;
  const polled = mtime(fileOf(sid, "polled"));
  if (!force && polled && now - polled < POLL_EVERY_MS) return null;
  return rec;
}

/** Runs `fn` as the one hook of this session asking the phone; null without running when another is. */
async function withPollLock(sid, fn, now = Date.now()) {
  if (!okId(sid)) return null;
  const lock = fileOf(sid, "polling");
  fs.mkdirSync(dir(), { recursive: true });
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
  } catch (err) {
    if (err.code !== "EEXIST" || now - mtime(lock) < LOCK_STALE_MS) return null;
    fs.rmSync(lock, { force: true });
    return withPollLock(sid, fn, now);
  }
  try {
    writeAtomic(fileOf(sid, "polled"), String(now));
    return await fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/**
 * Waits (at most `maxMs`) for a hook's zero-wait listen of this session to finish, so a call_say /
 * call_listen never races it for the same words. Resolves at once when none runs.
 */
async function waitForPoll(sid, maxMs = 3000, step = 50) {
  if (!okId(sid)) return;
  const end = Date.now() + maxMs;
  while (fs.existsSync(fileOf(sid, "polling")) && Date.now() < end) await new Promise((r) => setTimeout(r, step));
}

module.exports = { waitForPoll, hasLiveCall, readLiveCall, noteLiveCall, clearLiveCall, setInflight, dueLiveCall, withPollLock, POLL_EVERY_MS, STALE_MS, INFLIGHT_MS };
