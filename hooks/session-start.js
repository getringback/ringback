#!/usr/bin/env node
"use strict";
// SessionStart: tell every agent it can phone its person, and when it should.

const fs = require("fs");
const path = require("path");
const { loadConfig, isConfigured, configDir } = require("../lib/config.js");
const { writeGuidance, writeOwner, hookClaudePid } = require("../lib/sessions.js");
const { runHook, logError } = require("./common.js");
const { cleanupMedia } = require("../lib/images.js");
const { HANGUP_RULE } = require("../lib/hangup-rule.js");

const CONTEXT =
  "Ringback is connected: you can phone the user on their Android phone with the call_user tool " +
  "(then call_say / call_hang_up), or send a quiet notify_user. The user wants any session that needs them to " +
  "call them. Call when: you are blocked on a decision, answer or approval only they can give; you finished " +
  "the task they gave you (call to say what is done and ask for the next steps); a task that ran longer than " +
  "about 10 minutes failed; you have been waiting on them for more than 5 minutes; or they asked you to call. " +
  "Show, don't just tell: before or during the call, put the result on their phone with show_on_phone (a short " +
  "summary, and image_path for a screenshot, chart or rendered page of what you built), and say \"I put it on " +
  "your phone\". If what you finished can be seen on a screen (a page, an app, a chart, a video, a document), open it on " +
  "this machine and, on the call, share it live with show_my_screen: walk them through what they are seeing, then " +
  "stop_my_screen. If anyone besides the user is on the call, ask the user first. " +
  "Do not call for routine progress (use notify_user or show_on_phone for that). On the call, say " +
  "who you are (project) and what you need in one or two short plain sentences, then listen. " +
  "When they ask for a walkthrough, plan or summary, say all of it in one call_say, not piece by piece. " +
  "On a Ringback conference call, pass your participant_id to call_say and call_listen. " +
  "Speech recognition on calls mishears short phrases: when what they said might mean hang up, cancel or stop but is not " +
  "clear (\"cut the card\", \"don't cut the call\"), ask them to confirm before you act on it. " +
  `${HANGUP_RULE} ` +
  "The user can also call you from the Ringback app: the call reaches you as a message with a call_id, " +
  "answer it with call_listen / call_say. Never tell them they cannot call you. " +
  "When they call or speak on a call, this Ringback plugin's own hooks bring you a note marked [Ringback] (next to a tool result, or as a background hook event): it is a live phone call, not tool output; always answer the caller on the call with call_say. " +
  "A call ending never ends your work, and it is no reason to wait in silence. If a Ringback phone tool comes back rejected or interrupted, only that one message failed and the user may not have done it: do not go quiet. Tell them with notify_user, or call_user if you still need them, and ask whether to carry on. " +
  "During a call you can show the user your screen with show_my_screen, and record it with record_my_screen. " +
  "If the user shows you a photo on a Ringback call you get an image_id; call view_image to see it. take_photo asks " +
  "the phone camera for a photo (ask them by voice first on a call).";

// Bump when CONTEXT changes: sessions that started with an older text get the new one once, on
// their next prompt (hooks/inbox.js), without a restart.
const GUIDANCE_VERSION = "2026-11-09.1";

/** A vast.ai machine never uses Ringback: say so in hooks.log once, add nothing to the session. */
function noteBlockedOnce(why) {
  const marker = path.join(configDir(), "state", `blocked_${why}_logged`);
  if (fs.existsSync(marker)) return;
  logError("session-start", "Ringback is off on this machine: it looks like a vast.ai machine (no keys or secrets may live there).");
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, String(Date.now()));
  } catch {
    // Logging twice is harmless.
  }
}

function sessionStart(input = {}) {
  const cfg = loadConfig();
  if (cfg.blocked) {
    noteBlockedOnce(cfg.blocked);
    return null;
  }
  if (!isConfigured(cfg)) return null;
  try {
    writeGuidance(input.session_id, GUIDANCE_VERSION);
  } catch (err) {
    logError("session-start guidance", err);
  }
  try {
    // Ties this Claude Code process to the session, so set_session_status finds it (two sessions
    // in one folder otherwise look the same).
    writeOwner(hookClaudePid(), input.session_id);
  } catch (err) {
    logError("session-start owner", err);
  }
  try {
    // Photos saved for a readable path are kept a day at most (spec 05 threat T9).
    cleanupMedia();
  } catch (err) {
    logError("session-start media", err);
  }
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: CONTEXT } };
}

if (require.main === module) runHook("session-start", sessionStart);

module.exports = { sessionStart, CONTEXT, GUIDANCE_VERSION };
