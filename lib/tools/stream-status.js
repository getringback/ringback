"use strict";

const { CAPTURE_SETUP } = require("../stream-caps.js");

const REASONS = {
  no_ffmpeg: CAPTURE_SETUP,
  ffmpeg_failed: "This computer could not capture its screen; check screen sharing permissions and try again.",
  helper_gone: "Screen sharing ended because the computer disconnected.",
  call_ended: "Screen sharing ended because the call ended.",
  paused_too_long: "Screen sharing ended because nobody was looking for a minute.",
  not_allowed: "Screen sharing is off for this computer.",
  screen_locked: "Screen sharing is paused because the computer is locked.",
  expired: "Screen sharing reached its time limit.",
  declined: "The user chose not to share the screen.",
};

function streamStatus(s, previous) {
  const out = { ...s };
  if (s.status === "paused") {
    out.detail = s.viewer === false ? "paused: nobody is looking" : "Screen sharing is paused.";
    out.next = "Tell the user it is paused. Wait until they look at the screen again before describing it.";
  } else if (s.status === "ended" || s.status === "declined") {
    out.detail = REASONS[s.end_reason] || "Screen sharing ended on the phone.";
    out.next = s.status === "declined" ? "They said not now. Do not ask again in this call." : "Tell the user why it ended. Share again only if they ask.";
  } else if (s.status === "reconnecting" || s.interrupted === true) {
    out.detail = "Screen sharing was interrupted; the computer is trying to reconnect.";
    out.next = "Tell the user the picture was interrupted. Check my_screen_status for its return.";
  } else if (s.status === "live" && s.first_frame_received === false) {
    out.status = "connecting";
    out.detail = "The phone has connected but has not confirmed the first picture.";
    out.next = "Wait for a confirmed picture before describing the screen.";
  } else if (s.status === "live" && previous && ["interrupted", "reconnecting", "paused"].includes(previous.status)) {
    out.detail = "Screen sharing resumed; the phone has received a picture.";
    out.next = "Tell the user the picture is back, then describe what you do.";
  } else if (s.status === "live" && previous && previous.status === "unknown") {
    out.detail = "The phone is reachable again and has received a picture.";
    out.next = "Tell the user the picture is confirmed, then describe what you do.";
  }
  // These details can contain encoder diagnostics on older phones.
  if (typeof out.detail === "string" && /ffmpeg|libx264|avfoundation|ddagrab/i.test(out.detail)) out.detail = REASONS.ffmpeg_failed;
  if (typeof out.notice === "string" && /ffmpeg|libx264|avfoundation|ddagrab/i.test(out.notice)) out.notice = REASONS.ffmpeg_failed;
  return out;
}

function recordingStatus(s) {
  const out = streamStatus(s);
  let failed = false;
  let saved = false;
  for (const where of ["phone", "machine"]) {
    const part = out[where];
    if (!part || typeof part !== "object") continue;
    if (part.error) {
      failed = true;
      out[where] = { error: `The recording could not be saved ${where === "phone" ? "on the phone" : "on this computer"}.` };
    } else saved = true;
  }
  if (failed) {
    out.status = saved ? "saved" : "save_failed";
    out.detail = saved ? "The recording was saved in one place, but the other copy could not be saved." : "The recording could not be saved.";
    out.next = "Tell the user which copy was saved and which failed. Do not claim a failed copy was saved.";
  }
  return out;
}

module.exports = { streamStatus, recordingStatus };
