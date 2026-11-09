"use strict";
// Can the user reach this session from the phone right now, and how (FOLLOWUPS item 57)? Calls and
// text typed in the live view take only official paths into the REAL session:
//   next_step  busy: its next hook reads the words (Claude Code, Codex, agy)
//   wake       idle with a working waiter: Claude Code's asyncRewake hook (terminal, Desktop
//              Code tab) or agy's held Stop hook wakes it where it runs
//   queue      idle Codex whose window still runs: `codex queue` into that window
// Anything else is not reachable, with one plain sentence the phone shows as it is.
// The helper sends this with every heartbeat (sessions.wire), so the phone shows a session as
// callable only when it truly is.

const { waiterAlive } = require("../hooks/wake-wait.js");
const visibleWake = require("./visible-wake.js");
const clients = require("./clients.js");

const BUSY_STALE_MS = 30 * 60 * 1000;

const REASONS = Object.freeze({
  ended: "That session ended.",
  claude:
    "It needs one message typed in its own window to reconnect (it started before Ringback loaded, the plugin was updated or reloaded, or it sat idle for a day).",
  codexOff: "Waking idle Codex sessions is turned off on that computer (codex_visible_wake).",
  codexHooks: "Its Ringback hooks have not run in Codex yet: trust them once with /hooks in that Codex window.",
  codexClosed: "Its Codex window is closed.",
  agyOff: "Idle agy sessions can only be woken with agy_visible_wake on in ~/.ringback/config.json on that computer.",
  agyHold: "It needs one message typed in its agy window (it was stopped with Esc, or closed).",
  desktopChat: "A Claude Desktop chat cannot be called, only call you.",
});

/** The plain reason an idle session without a waiter cannot be woken. */
function idleReason(cfg, rec, deps) {
  const client = clients.clientOf(rec);
  if (client === "claude-desktop") return REASONS.desktopChat;
  if (client === "codex") {
    if (!visibleWake.codexWakeOn(cfg)) return REASONS.codexOff;
    if (!(Number(rec.owner_pid) > 0)) return REASONS.codexHooks;
    return REASONS.codexClosed;
  }
  if (client === "agy") return visibleWake.agyWakeOn(cfg) ? REASONS.agyHold : REASONS.agyOff;
  return REASONS.claude;
}

// Busy by Claude Code's own live status when fresh, else by its hooks (lib/busy.js).
const { isBusy, LIVE_FRESH_MS } = require("./busy.js");

/**
 * { callable, how, reason } for session `rec`. `deps`: now, waiterAlive, wakeDeps (process
 * lookups for Codex). `reason` is "" when callable and nothing needs saying. A live waiter wins:
 * it wakes the session whatever its last hook said.
 */
function reach(cfg, rec, deps = {}) {
  const now = deps.now || Date.now();
  const waiting = deps.waiterAlive || waiterAlive;
  if (!rec || rec.ended) return { callable: false, how: null, reason: REASONS.ended };
  if (waiting(rec.id)) return { callable: true, how: "wake", reason: "" };
  if (isBusy(rec, now)) return { callable: true, how: "next_step", reason: "" };
  let queue = false;
  try {
    queue = clients.clientOf(rec) === "codex" && visibleWake.canQueue(cfg || {}, rec, deps.wakeDeps || {});
  } catch {
    queue = false;
  }
  if (queue) return { callable: true, how: "queue", reason: "" };
  return { callable: false, how: null, reason: idleReason(cfg || {}, rec, deps) };
}

const same = (a, b) => Boolean(a && b) && a.callable === b.callable && a.how === b.how && a.reason === b.reason;

module.exports = { reach, isBusy, same, idleReason, REASONS, BUSY_STALE_MS, LIVE_FRESH_MS };
