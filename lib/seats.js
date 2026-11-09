"use strict";
// This session's own seat on each conference call (FOLLOWUPS item 57, live call c_tJ3FmkRe7eHP):
// every conference message that reaches a session carries its participant_id. The phone refuses
// a conference call_say / call_listen without it, and agents forget it. The seat is remembered
// here when the message arrives (sessions.stashMessages, the one path every delivery takes) and
// the call tools fill it in when the agent left it out. Only ever this session's own seat.

const fs = require("fs");
const path = require("path");
const { configDir } = require("./config.js");

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PARTICIPANT = /^pt_[A-Za-z0-9_-]{1,64}$/;
const CALL = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_CALLS = 20;

const seatsFile = (sid) => path.join(configDir(), "state", "seats", `${sid}.json`);

function readSeats(sid) {
  if (!SESSION_ID.test(String(sid || ""))) return {};
  try {
    const v = JSON.parse(fs.readFileSync(seatsFile(sid), "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** Records the seat of every conference message for session `sid`. Never throws. */
function rememberSeats(sid, msgs) {
  try {
    if (!SESSION_ID.test(String(sid || ""))) return;
    const seen = (msgs || []).filter((m) => m && m.conference && CALL.test(String(m.call_id || "")) && PARTICIPANT.test(String(m.conference.participant_id || "")));
    if (!seen.length) return;
    const seats = { ...readSeats(sid) };
    for (const m of seen) seats[m.call_id] = { participant_id: m.conference.participant_id, at: Number(m.t) || Date.now() };
    const kept = Object.entries(seats).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_CALLS);
    const file = seatsFile(sid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(kept)));
    fs.renameSync(tmp, file);
  } catch {
    // Only a convenience: the agent can still pass participant_id itself.
  }
}

/** This session's participant_id on `callId`, or undefined. */
function seatFor(sid, callId) {
  const s = readSeats(sid)[String(callId || "")];
  return s && PARTICIPANT.test(String(s.participant_id)) ? s.participant_id : undefined;
}

module.exports = { rememberSeats, seatFor, readSeats };
