#!/usr/bin/env node
"use strict";

// Install the error boundary before loading any plugin code, including common.js.
if (require.main === module) {
  try {
    require("./guard.js").install("notification", 28000);
  } catch (err) {
    try {
      const fs = require("fs"), path = require("path");
      const dir = process.env.RINGBACK_HOME || path.join(require("os").homedir(), ".ringback");
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "hooks.log"), `${new Date().toISOString()} notification load: ${err.message}\n`);
    } catch { /* An incomplete install must stay quiet. */ }
    process.exit(0);
  }
}

// Notification: when a session waits on the user (permission prompt, idle), tell their
// phone quietly. Idle pings are throttled per session; `ring_on_permission` turns a
// permission prompt into a real call.

const { loadConfig, isConfigured } = require("../lib/config.js");
const { api } = require("../lib/client.js");
const { callerName } = require("../lib/calls.js");
const { runHook, readState, writeState, projectOf, logError } = require("./common.js");
const { markNeedsYou, idlePromptIsStale, readSession, safeId } = require("../lib/sessions.js");
const { backgroundOnly } = require("../lib/busy.js");

const NEEDS_YOU = new Set(["permission_prompt", "idle_prompt"]);

function shouldSend(cfg, input, now) {
  const type = input.notification_type || "";
  if (!cfg.notify_on.includes(type)) return false;
  if (type !== "idle_prompt") return true;
  const last = readState(input.session_id).last_idle_notify || 0;
  return now - last >= cfg.idle_notify_every_s * 1000;
}

async function markQuietly(cfg, input, deps, kind) {
  try {
    await markNeedsYou(cfg, input, true, deps, kind);
  } catch (err) {
    logError("notification needs_you", err);
  }
}

async function notification(input, deps = { api, now: Date.now() }) {
  const cfg = loadConfig();
  if (!isConfigured(cfg)) return null;
  // Wallpapers show Clawd waving while a session waits on the user (FOLLOWUPS items 19c, 37); any busy
  // signal clears it. An idle ping for a session seen working within the idle window is stale.
  // A question (AskUserQuestion) waits on them too, as in Gauntlet; its PostToolUse clears it.
  if (input.hook_event_name === "PreToolUse") {
    if (input.tool_name === "AskUserQuestion") await markQuietly(cfg, input, deps, "question");
    return null;
  }
  const rec = readSession(input.session_id);
  // The ping itself is held back too: only the flag used to be, so a stale idle ping still put
  // "Claude needs your input" on the phone while every session said needs_you=false (2026-11-09).
  if (input.notification_type === "idle_prompt" && (idlePromptIsStale(rec, deps.now) || backgroundOnly(rec, deps.now))) return null;
  if (NEEDS_YOU.has(input.notification_type)) {
    await markQuietly(cfg, input, deps, input.notification_type === "permission_prompt" ? "permission" : "notice");
  }
  if (!shouldSend(cfg, input, deps.now)) return null;
  const project = projectOf(input);
  const body = input.message || "Claude is waiting for you.";
  // With tap approvals the phone already asked (and rang, with ring_on_permission) before this
  // terminal prompt appeared; a second call that only says "check the terminal" is no help.
  if (input.notification_type === "permission_prompt" && cfg.ring_on_permission && cfg.tap_approvals === false) {
    const sid = /^[A-Za-z0-9_-]{1,64}$/.test(String(input.session_id || "")) ? input.session_id : undefined;
    const placed = await deps.api.placeCall(cfg, callerName(project), "Needs your permission", body, sid);
    if (!placed.call_id) return null;
    // The phone already speaks `body` as the opening line on answer; only add the nudge.
    const said = await deps.api.say(cfg, placed.call_id, "Check the terminal when you can.", false, 45);
    if (said.status === "ok") await deps.api.hangup(cfg, placed.call_id);
    return null;
  }
  // Tagged with the session, so the phone withdraws this note once that session no longer needs them.
  await deps.api.notify(cfg, callerName(project), body, safeId(input.session_id) || undefined);
  if (input.notification_type === "idle_prompt") {
    writeState(input.session_id, { ...readState(input.session_id), last_idle_notify: deps.now });
  }
  return null;
}

if (require.main === module) runHook("notification", (input) => notification(input));

module.exports = { notification, shouldSend };
