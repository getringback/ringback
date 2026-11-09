"use strict";
// A Claude Desktop chat on the phone's Sessions list (FOLLOWUPS item 43). Claude Desktop spawns
// this MCP server (clientInfo.name "claude-ai"), but a plain Desktop chat has no hooks and no
// documented way to be woken from outside, so it is listed honestly: it can call you, it cannot be
// called. This process registers one session for "Claude Desktop" on this machine, heartbeats it
// while the process lives, and removes it when Desktop closes the server. A call the user places to it
// anyway is answered by the phone with one plain line and ended, never left ringing. No UI
// automation, no typing into windows. Never in the local sessions/ folder, so
// the helper never tries a `claude --resume` on it.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { configDir } = require("./config.js");
const { isCallStarted } = require("./inbox-format.js");
const { isConferenceMessage, isLeftMessage } = require("./conference.js");

const CLIENT = "claude-desktop";
const LABEL = "Claude Desktop";
const HEARTBEAT_MS = 30 * 1000;
const POLL_WAIT_S = 50;
const RETRY_MS = 15 * 1000;
const MIN_ROUND_MS = 1000;

// What the phone list says about this entry, and what a caller hears.
const CALL_OUT_ONLY = "Can call you, cannot be called";
const NOT_CALLABLE_LINE =
  "This Claude Desktop chat can call you, but it cannot be called. " +
  "To talk to a session, call a Claude Code session in a terminal or in the Claude Desktop Code tab.";

let active = null;
// Calls this chat placed itself (call_user): its own call, never refused or left here.
const ownCalls = new Set();

/** call_user placed `callId` from this process (lib/tools/calls.js). */
function noteOwnCall(callId) {
  if (active && callId) ownCalls.add(String(callId));
}

/** True when the client that started this server is the Claude Desktop chat. */
function isDesktopClient(clientInfo, env = process.env) {
  const name = String((clientInfo && clientInfo.name) || "").trim().toLowerCase();
  if (name === "claude-ai" || /^claude[- ]desktop/.test(name)) return true;
  // Claude Code (also inside the Desktop app) has hooks and its own path.
  if (name === "claude-code" || name.startsWith("claude-code")) return false;
  return String(env.RINGBACK_CLIENT || "").trim() === CLIENT;
}

/** The one session id for Claude Desktop on this machine. */
function desktopSessionId(machine = os.hostname()) {
  return `claude-desktop-${String(machine).replace(/[^A-Za-z0-9_-]/g, "-")}`.slice(0, 64);
}

function registrationBody(machine) {
  return {
    machine: String(machine).slice(0, 64),
    project: LABEL,
    cwd: "",
    title: LABEL,
    state: "idle",
    summary: CALL_OUT_ONLY,
    doing: CALL_OUT_ONLY,
    client: CLIENT,
    callable: false,
    needs_you: false,
  };
}

/** The session id of the Desktop chat this process serves, or null (calls.js sends it). */
const activeSessionId = () => (active ? active.sid : null);

function logLine(line) {
  try {
    const file = path.join(configDir(), "desktop.log");
    try {
      if (fs.statSync(file).size > 512 * 1024) fs.renameSync(file, `${file}.1`);
    } catch {
      // No log yet.
    }
    fs.appendFileSync(file, `${new Date().toISOString()} [${process.pid}] ${line}\n`);
  } catch {
    // Logging never stops the server.
  }
}

// One Desktop chat entry per machine: Desktop may start the server more than once.
const lockFile = () => path.join(configDir(), "state", "desktop-chat.lock");

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function takeLock(pid = process.pid) {
  try {
    const held = Number(fs.readFileSync(lockFile(), "utf8").trim());
    if (held !== pid && pidAlive(held)) return false;
  } catch {
    // No lock yet.
  }
  fs.mkdirSync(path.dirname(lockFile()), { recursive: true });
  fs.writeFileSync(lockFile(), String(pid));
  return true;
}

function releaseLock(pid = process.pid) {
  try {
    if (Number(fs.readFileSync(lockFile(), "utf8").trim()) === pid) fs.rmSync(lockFile(), { force: true });
  } catch {
    // Already gone.
  }
}

/** The calls the user placed to this chat in these messages (each once, oldest first). */
function incomingCalls(msgs) {
  const ids = [];
  for (const m of msgs || []) if (isCallStarted(m) && m.call_id && !ids.includes(m.call_id)) ids.push(m.call_id);
  return ids;
}

/** Conference seats this chat was given ({ callId, pid }, each once): it leaves them at once. */
function conferenceSeats(msgs) {
  const seats = [];
  for (const m of msgs || []) {
    if (!isConferenceMessage(m) || isLeftMessage(m) || !m.call_id) continue;
    const pid = m.conference.participant_id;
    if (pid && !seats.some((s) => s.pid === pid)) seats.push({ callId: m.call_id, pid: String(pid) });
  }
  return seats;
}

/** Leaves a conference seat with the same plain line, so no silent participant stays on the call. */
async function leaveSeat(ctx, seat) {
  try {
    await ctx.api.leave(ctx.cfg(), seat.callId, seat.pid, NOT_CALLABLE_LINE);
    ctx.log(`conference ${seat.callId}: left seat ${seat.pid} (this chat cannot be called)`);
  } catch (err) {
    ctx.log(`leave ${seat.callId}: ${err.message}`);
  }
}

/** Tells the user on the call that this chat cannot be called, then ends it (no ringing forever). */
async function refuse(ctx, callId) {
  try {
    await ctx.api.hangup(ctx.cfg(), callId, NOT_CALLABLE_LINE, undefined, ctx.sid);
    ctx.log(`call ${callId}: told them this chat cannot be called`);
  } catch (err) {
    ctx.log(`refuse ${callId}: ${err.message}`);
  }
}

/**
 * One inbox round: every message is acknowledged (nothing here can deliver it), and each call
 * placed to this chat is refused once with a plain spoken line.
 */
async function pollOnce(ctx) {
  const res = await ctx.api.sessionInbox(ctx.cfg(), ctx.sid, ctx.st.cursor, POLL_WAIT_S);
  if (ctx.st.cursor && res.cursor !== undefined && Number(res.cursor) < Number(ctx.st.cursor)) ctx.st.cursor = "";
  const fresh = (res.messages || []).filter((m) => !ctx.st.cursor || Number(m.id) > Number(ctx.st.cursor));
  if (!fresh.length) return;
  ctx.st.cursor = String(Math.max(...fresh.map((m) => Number(m.id))));
  const own = ctx.ownCalls || ownCalls;
  const theirs = fresh.filter((m) => !own.has(String(m.call_id)));
  // Added to a conference (picker or invitation): leave that seat, never end the whole call.
  const seats = conferenceSeats(theirs);
  for (const seat of seats) {
    if (ctx.st.refused.has(seat.pid)) continue;
    ctx.st.refused.add(seat.pid);
    await leaveSeat(ctx, seat);
  }
  const onConference = new Set(seats.map((s) => s.callId));
  for (const callId of incomingCalls(theirs)) {
    if (ctx.st.refused.has(callId) || onConference.has(callId)) continue;
    ctx.st.refused.add(callId);
    await refuse(ctx, callId);
  }
}

/**
 * Starts the Desktop chat's presence. deps: { cfg() -> config, api, sleep, now, log, machine }.
 * Returns { sid, stop() } or null when another process already serves Desktop.
 */
function start(deps) {
  const machine = (deps.machine || os.hostname()).slice(0, 64);
  const sid = desktopSessionId(machine);
  if (!(deps.takeLock || takeLock)()) {
    deps.log("another Ringback server already serves Claude Desktop on this machine");
    return null;
  }
  const ctx = {
    sid,
    cfg: deps.cfg,
    api: deps.api,
    sleep: deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: deps.now || Date.now,
    log: deps.log,
    st: { cursor: "", refused: new Set() },
    stopped: false,
  };
  const beat = async () => {
    try {
      await ctx.api.putSession(ctx.cfg(), sid, registrationBody(machine));
    } catch (err) {
      ctx.log(`heartbeat: ${err.message}`);
    }
  };
  const loop = async () => {
    while (!ctx.stopped) {
      try {
        const began = ctx.now();
        await pollOnce(ctx);
        // A long poll that came back at once with nothing (an older phone) must not spin.
        if (ctx.now() - began < MIN_ROUND_MS) await ctx.sleep(MIN_ROUND_MS);
      } catch (err) {
        ctx.log(`inbox: ${err.message}`);
        await ctx.sleep(RETRY_MS);
      }
    }
  };
  const timer = setInterval(beat, HEARTBEAT_MS);
  if (timer.unref) timer.unref();
  const ready = beat().then(() => {
    if (!ctx.stopped) ctx.done = loop();
  });
  active = ctx;
  ctx.log(`Claude Desktop chat on the phone as ${sid} (can call, cannot be called)`);
  return {
    sid,
    ready,
    ctx,
    stop: async () => {
      if (ctx.stopped) return;
      ctx.stopped = true;
      clearInterval(timer);
      if (active === ctx) active = null;
      try {
        await ctx.api.deleteSession(ctx.cfg(), sid);
      } catch (err) {
        ctx.log(`unregister: ${err.message}`);
      }
      (deps.releaseLock || releaseLock)();
      ctx.log("Claude Desktop chat off the phone");
    },
  };
}

module.exports = {
  CLIENT,
  LABEL,
  CALL_OUT_ONLY,
  NOT_CALLABLE_LINE,
  isDesktopClient,
  desktopSessionId,
  registrationBody,
  activeSessionId,
  incomingCalls,
  conferenceSeats,
  noteOwnCall,
  pollOnce,
  start,
  takeLock,
  releaseLock,
  log: logLine,
};
