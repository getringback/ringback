"use strict";
// Is a session in a turn right now (its next hook will read their words)? One judgement for the
// helper (reach, decide, the state sent to the phone, the busy notice) and the waiter.
// Claude Code's own live status (`claude agents --json`, stamped on the record by the helper every
// 15 s) is the truth for a Claude Code session while it is fresh: the hook-reported state alone
// stays "busy" after an interrupted turn (Esc runs no Stop hook), which made idle sessions look busy
// (live regression 2026-11-08 10:25). The newer of the two signals decides.

const { clientOf } = require("./clients.js");

const BUSY_STALE_MS = 30 * 60 * 1000;
const LIVE_FRESH_MS = 60 * 1000;
const LIVE_BUSY = new Set(["busy", "waiting", "blocked"]);

// Live 14:35: `claude agents` also says "busy" for a session whose turn ended long ago but that
// still has background shells running (a Drive move). So the hooks say whether a turn is in
// progress (UserPromptSubmit / PostToolUse busy, Stop idle); Claude Code's live status may only
// turn a stale hook "busy" into idle (an Esc runs no Stop hook), never an ended turn into busy.
const liveFresh = (rec, now) => clientOf(rec) === "claude-code" && rec.live_status && rec.live_status_at && now - rec.live_status_at < LIVE_FRESH_MS;

function isBusy(rec, now = Date.now()) {
  if (!rec || rec.ended) return false;
  const hookBusy = rec.state === "busy" && Boolean(rec.last_hook_at && now - rec.last_hook_at < BUSY_STALE_MS);
  if (!hookBusy) return false;
  if (liveFresh(rec, now) && !LIVE_BUSY.has(rec.live_status) && !(rec.last_hook_at > rec.live_status_at)) return false;
  return true;
}

/** Idle between turns while Claude Code still runs its background jobs (live busy, no turn). */
function backgroundOnly(rec, now = Date.now()) {
  return Boolean(rec && !rec.ended && liveFresh(rec, now) && rec.live_status === "busy" && !isBusy(rec, now));
}

module.exports = { isBusy, backgroundOnly, BUSY_STALE_MS, LIVE_FRESH_MS, LIVE_BUSY };
