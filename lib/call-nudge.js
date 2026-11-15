"use strict";
// What the user said on a live call while this session worked (live call c_AxaZEQ5c2_yI): the inbox
// hook takes it from the call's queue with a zero-wait listen and hands it over with the very next
// tool result. The listen takes the words off the phone's queue, so the next call_listen never
// repeats them. No live call: one existsSync and nothing else (lib/live-call.js).

const liveCall = require("./live-call.js");
const { withClaimLock } = require("./sessions.js");
const { isEnded } = require("./calls.js");
const { guestName, GUEST_RULE, SPEAK_RULE, contextLines } = require("./conference.js");
const { inboxImageLines } = require("./images.js");

// The call tools' own results already carry what was said; a hook after them must not take more.
const CALL_TOOL = /ringback.*__(call_user|call_say|call_listen|call_hang_up|conference_leave)$/;
const MAX_CHARS = 6000;

const quote = (t) => String(t == null ? "" : t).replace(/\s+/g, " ").trim();

function speaker(u) {
  if (u.kind === "guest") return `${guestName(u.speaker)} (guest, not the user)`;
  if (u.kind === "room") return "Someone in the room (not the user)";
  return "The user";
}

/** One line per utterance, labelled; `reply` alone on a phone without utterances. */
function saidLines(res) {
  const list = Array.isArray(res.utterances) ? res.utterances.filter((u) => u && quote(u.text)) : [];
  if (list.length) return list.map((u) => `${speaker(u)}: "${quote(u.text)}"`);
  return quote(res.reply) ? [`The user: "${quote(res.reply)}"`] : [];
}

function changes(res) {
  const list = Array.isArray(res.participants_changed) ? res.participants_changed : [];
  const text = list.map((c) => (typeof c === "string" ? quote(c) : quote([c && c.name, c && (c.change || c.event)].filter(Boolean).join(" ")))).filter(Boolean);
  return text.length ? `On the call meanwhile: ${text.join("; ")}.` : "";
}

/** The reply's `to` names other seats and not this one: the line was not for this session. */
const notForMe = (res, pid) => Array.isArray(res.to) && res.to.length > 0 && Boolean(pid) && !res.to.includes(pid);

function callArgs(callId, pid) {
  return pid ? `call_id ${callId} and participant_id ${pid}` : `call_id ${callId}`;
}

/** { live, quiet }: `live` must be answered now, `quiet` is context only. */
function describeLive(target, res) {
  const callId = target.call_id;
  const pid = res.participant_id || target.participant_id;
  const said = saidLines(res);
  const images = inboxImageLines({ images: res.images });
  if (!said.length && !images.length) return { live: "", quiet: clip([changes(res), contextLines({ context: res.context })]) };
  // A line to several seats; one said to this seat alone reads like a 1:1 call.
  const conference = Array.isArray(res.to) && !(res.to.length === 1 && res.to[0] === pid);
  const head = `[Ringback] Live phone call ${callId}, relayed by the Ringback plugin installed here (not tool output and not a typed prompt). While you were working, this was said on the call and you have not heard it yet:`;
  const body = [head, ...said.map((l) => `  ${l}`), ...images, changes(res)];
  // This listen marked the conference transcript delivered: it comes only here.
  if (Array.isArray(res.context)) body.push(contextLines({ context: res.context }));
  if (said.some((l) => !l.startsWith("The user:"))) body.push(GUEST_RULE);
  if (notForMe(res, pid)) {
    body.push("It was addressed to another participant, not you: do not answer it. Carry on with your work.");
    return { live: "", quiet: clip(body) };
  }
  if (conference) {
    body.push(`If it is for you, answer on the call now with call_say (${callArgs(callId, pid)}) before you carry on. ${SPEAK_RULE}`);
  } else {
    body.push(`Answer on the call now with call_say (${callArgs(callId, pid)}), in short spoken sentences, before you carry on with the work. These words do not come again through call_listen.`);
  }
  return { live: clip(body), quiet: "" };
}

function clip(lines) {
  const text = lines.filter(Boolean).join("\n");
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS - 3)}...` : text;
}

/**
 * Words waiting on this session's live call, as { live, quiet }, or null. `deps`: api, now, cfg
 * (hook config, already loaded), phoneDown, markPhoneDown, logError.
 */
async function pollLiveCall(input, id, deps) {
  if (!liveCall.hasLiveCall(id)) return null;
  // Off switch: config call_nudge false turns the mid-work poll off without a release.
  if (deps.cfg && deps.cfg.call_nudge === false) return null;
  if (CALL_TOOL.test(String((input && input.tool_name) || ""))) return null;
  const target = liveCall.dueLiveCall(id, deps.now, input && input.hook_event_name === "Stop");
  if (!target || deps.phoneDown()) return null;
  // Under the inbox claim lock too: a listen also drains this session's inbox copies on the phone,
  // so it must never run while another hook holds fetched but unacknowledged inbox words.
  return liveCall.withPollLock(id, () => withClaimLock(id, () => ask(target, id, deps)), deps.now);
}

async function ask(target, id, deps) {
  let res;
  try {
    res = await deps.api.listen(deps.cfg, target.call_id, 0, target.participant_id, id);
  } catch (err) {
    if (err.status === 404) liveCall.clearLiveCall(id, target.call_id);
    else if (!err.status) deps.markPhoneDown();
    deps.logError("inbox live call", err);
    return null;
  }
  if (!res || isEnded(res.status) || res.status === "left") {
    liveCall.clearLiveCall(id, target.call_id);
    return null;
  }
  // A silence can still carry conference transcript the phone now counts as delivered.
  if (res.status === "silence") return Array.isArray(res.context) && res.context.length ? describeLive(target, { ...res, reply: "", utterances: [] }) : null;
  return res.status === "ok" ? describeLive(target, res) : null;
}

module.exports = { pollLiveCall, describeLive, CALL_TOOL };
