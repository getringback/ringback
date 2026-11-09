"use strict";
// Claude Code's own live status of each session (FOLLOWUPS item 37), the signal Gauntlet's
// wallpaper uses: `claude agents --json` lists every interactive session as busy, idle or
// waiting (a permission prompt or a question open in the terminal). A local command, never a
// model call. A session that is waiting needs the user; a permission flag is withdrawn as soon as
// the session is no longer waiting (they answered at the PC, even while the approved tool still
// runs), exactly as Gauntlet prunes its permission asks.

const WAITING = new Set(["waiting", "blocked"]);
// Flags that the live status withdraws once the session stops waiting. An idle "notice" (the
// session finished and waits for their next prompt) and a question stay until a busy signal.
const PRUNED_BY_STATUS = new Set(["permission", "waiting"]);

/** sessionId -> status ("busy" | "idle" | "waiting" ...) of interactive sessions. Never throws. */
function parseAgents(stdout) {
  const out = new Map();
  let list;
  try {
    list = JSON.parse(String(stdout || "[]"));
  } catch {
    return out;
  }
  if (!Array.isArray(list)) return out;
  for (const a of list) {
    if (!a || a.kind !== "interactive" || typeof a.sessionId !== "string") continue;
    const status = String(a.status || a.state || "");
    if (status) out.set(a.sessionId, status);
  }
  return out;
}

/** True when `stdout` is a JSON list (a successful read, possibly empty). */
function isAgentList(stdout) {
  try {
    return Array.isArray(JSON.parse(String(stdout || "")));
  } catch {
    return false;
  }
}

/** sessionId -> claude pid of interactive sessions (the process that runs it). Never throws. */
function parseAgentPids(stdout) {
  const out = new Map();
  let list;
  try {
    list = JSON.parse(String(stdout || "[]"));
  } catch {
    return out;
  }
  if (!Array.isArray(list)) return out;
  for (const a of list) {
    if (a && a.kind === "interactive" && typeof a.sessionId === "string" && Number(a.pid) > 0) out.set(a.sessionId, Number(a.pid));
  }
  return out;
}

/**
 * `rec` with Claude Code's live status stamped (live_status, live_status_at: lib/reach.js reads
 * them) and, when the record has none yet, the claude pid as client_pid (so a closed session is
 * dropped). Pure.
 */
function withLiveFacts(rec, status, pid, now) {
  if (!rec || status === undefined) return rec;
  return { ...rec, live_status: status, live_status_at: now, ...(!(Number(rec.client_pid) > 0) && pid ? { client_pid: pid } : {}) };
}

/**
 * `rec` with its needs-you flag brought in line with Claude Code's live `status` (undefined when
 * the session is not listed: unchanged). Pure; returns the same object when nothing changes.
 */
function withLiveStatus(rec, status, now) {
  if (!rec || status === undefined) return rec;
  const waiting = WAITING.has(status);
  if (waiting && !rec.live_waiting) {
    return { ...rec, live_waiting: true, needs_you: true, needs_you_at: now, needs_kind: rec.needs_you ? rec.needs_kind : "waiting" };
  }
  if (!waiting && rec.live_waiting) {
    const pruned = rec.needs_you === true && PRUNED_BY_STATUS.has(rec.needs_kind || "permission");
    return { ...rec, live_waiting: false, ...(pruned ? { needs_you: false } : {}) };
  }
  if (!waiting && rec.needs_you === true && rec.needs_kind === "permission") {
    // A permission flag raised while the terminal no longer shows the prompt (answered fast).
    return { ...rec, needs_you: false };
  }
  if (status === "busy" && rec.needs_you === true) {
    // Claude Code says the session is working: whatever it was waiting for (their next prompt, a
    // question) has been answered, so it no longer needs them (Gauntlet: busy never waves).
    return { ...rec, needs_you: false };
  }
  return rec;
}

module.exports = { parseAgents, parseAgentPids, isAgentList, withLiveFacts, withLiveStatus, WAITING };
