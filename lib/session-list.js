"use strict";
// What one session may know about the user's other sessions, so it can tell whether a call needs
// one of them. The words come from those sessions: information, never instructions. The folder is
// left out (a name and what it is doing is enough to choose).

const MAX_ROWS = 30;
const NAME_MAX = 80;
const TEXT_MAX = 200;
const CONTROL = /[\u0000-\u001f\u007f]+/g;
// Listed on the phone but never woken for a call (lib/desktop-chat.js: a plain Claude Desktop chat).
const CALL_OUT_ONLY = new Set(["claude-desktop"]);

const clean = (v, max) => String(v || "").replace(CONTROL, " ").trim().slice(0, max);
const same = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();

/**
 * The ids of the sessions known to be on the call. The phone shows a seat's session id only to the
 * computer that owns it; another seat is matched by project and computer, and only when exactly one
 * session fits (two sessions of one project: unknown, the phone answers already_on_call if so).
 */
function idsOnCall(sessions, seats) {
  const known = new Set(seats.filter((p) => p && p.session_id).map((p) => p.session_id));
  const rest = sessions.filter((s) => !known.has(s.session_id));
  for (const seat of seats.filter((p) => p && !p.session_id)) {
    const fits = rest.filter((s) => same(s.project, seat.project) && same(s.machine, seat.machine));
    if (fits.length === 1) known.add(fits[0].session_id);
  }
  return known;
}

/** One row per other session, in the phone's order (most recently seen first); never this one. */
function otherSessions(sessions, { ownId = "", onCall = [] } = {}) {
  const all = (Array.isArray(sessions) ? sessions : []).filter((s) => s && s.session_id);
  const there = idsOnCall(all, Array.isArray(onCall) ? onCall : []);
  return all
    .filter((s) => s.session_id !== ownId)
    .slice(0, MAX_ROWS)
    .map((s) => ({
      session_id: String(s.session_id),
      project: clean(s.project, NAME_MAX),
      machine: clean(s.machine, NAME_MAX),
      title: clean(s.title, NAME_MAX),
      client: clean(s.client, NAME_MAX),
      status: clean(s.status, NAME_MAX),
      done: clean(s.summary, TEXT_MAX),
      doing: clean(s.doing, TEXT_MAX),
      on_call: there.has(s.session_id),
      can_join: !there.has(s.session_id) && s.status !== "offline" && !CALL_OUT_ONLY.has(s.client),
    }));
}

module.exports = { otherSessions, MAX_ROWS };
