#!/usr/bin/env node
"use strict";

// Install the error boundary before loading any plugin code, including common.js.
if (require.main === module) {
  try {
    require("./guard.js").install("inbox", 14000);
  } catch (err) {
    try {
      const fs = require("fs"), path = require("path");
      const dir = process.env.RINGBACK_HOME || path.join(require("os").homedir(), ".ringback");
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "hooks.log"), `${new Date().toISOString()} inbox load: ${err.message}\n`);
    } catch { /* An incomplete install must stay quiet. */ }
    process.exit(0);
  }
}

// PostToolUse / UserPromptSubmit / Stop (synchronous, must stay fast): hand a busy session what
// the user said on a call to it. The network is touched only when the helper raised this session's
// pending flag, so a normal tool call costs one file check.
//   PostToolUse / UserPromptSubmit -> hookSpecificOutput.additionalContext
//   Stop -> {decision:"block", reason} so the session answers before it stops.

const { loadConfig, isConfigured } = require("../lib/config.js");
const { api } = require("../lib/client.js");
const { safeId, hasPending, setPending, drain, readGuidance, writeGuidance, phoneDown, markPhoneDown, hookCfg, describeMessages, readSession, writeSession } = require("../lib/sessions.js");
const { runHook, logError, isSubagentHook } = require("./common.js");
const { CONTEXT, GUIDANCE_VERSION } = require("./session-start.js");
const turns = require("../lib/turns.js");
const { lastAssistantText } = require("../lib/progress.js");
const { runningVersion, quietStop } = require("./claude-version.js");
const { isLiveSpeech } = require("../lib/inbox-format.js");

function markLocal(id, state, now) {
  const rec = readSession(id);
  if (rec) writeSession(id, { ...rec, state, last_hook_at: now });
}

async function take(cfg, id, deps) {
  // Stash and phone are drained together under the session's claim lock, so parallel hooks never
  // deliver the same words twice. While the phone is known down only the local stash is read.
  const network = !phoneDown();
  let locked = false;
  try {
    const got = await drain(hookCfg(cfg), id, deps, network);
    // Another process holds the lock (maybe one killed mid-drain): keep the flag so the next
    // hook, after the lock is free or stale, still delivers what is stashed.
    locked = got === null;
    return got || [];
  } catch (err) {
    if (!err.status) markPhoneDown();
    logError("inbox claim", err);
    return [];
  } finally {
    if (!locked) setPending(id, false);
  }
}

/**
 * The SessionStart call guidance, once, for a session that started before the current version
 * (it is still running from an older plugin text). Empty when it already has it.
 */
function catchUpGuidance(id) {
  try {
    if (readGuidance(id) === GUIDANCE_VERSION) return "";
    if (!isConfigured(loadConfig())) return "";
    writeGuidance(id, GUIDANCE_VERSION);
    return CONTEXT;
  } catch (err) {
    logError("inbox guidance", err);
    return "";
  }
}

/** What the user said on a call to this session, or "" (also records busy / idle for Stop). */
async function callText(input, id, deps) {
  const stop = input.hook_event_name === "Stop";
  if (!hasPending(id)) {
    if (stop) markLocal(id, "idle", deps.now);
    return { text: "", live: "", quiet: "" };
  }
  const cfg = loadConfig();
  if (!isConfigured(cfg)) return { text: "", live: "", quiet: "" };
  const msgs = await take(cfg, id, deps);
  if (stop) markLocal(id, msgs.length ? "busy" : "idle", deps.now);
  return {
    text: describeMessages(msgs),
    live: describeMessages(msgs.filter(isLiveSpeech)),
    quiet: describeMessages(msgs.filter((m) => !isLiveSpeech(m))),
  };
}

function stopOutput(text, cfg = {}, version = runningVersion()) {
  if (!text) return null;
  const mode = cfg.stop_delivery || "auto";
  return mode === "context" || (mode === "auto" && quietStop(version))
    ? { hookSpecificOutput: { hookEventName: "Stop", additionalContext: text } }
    : { decision: "block", reason: text };
}

/** Turn bookkeeping for the call-when-done nudge (FOLLOWUPS item 29). Never breaks the hook. */
function trackTurn(event, id, input, now) {
  try {
    if (event === "UserPromptSubmit") turns.onPrompt(id, now);
    else if (event === "PostToolUse") turns.onTool(id, input);
  } catch (err) {
    logError("inbox turn", err);
  }
}

function callNudge(id, input, now) {
  try {
    const cfg = loadConfig();
    if (!isConfigured(cfg)) return null;
    const reason = turns.nudge(id, { now, cfg, input, lastText: () => lastAssistantText(input.transcript_path) });
    if (!reason) turns.onStop(id);
    return reason;
  } catch (err) {
    logError("inbox nudge", err);
    return null;
  }
}

async function inbox(input, deps = { api, now: Date.now() }) {
  const id = safeId(input.session_id);
  if (!id) return null;
  // A subagent's hook carries its parent's session id (and agent_id): what it returned reached the
  // subagent, never the session, so it swallowed a whole call (live c_RJmjeKskbjHH, 2026-11-09).
  // Nothing is claimed here and the pending flag stays up for the session's own next hook.
  if (isSubagentHook(input)) return null;
  const event = input.hook_event_name || "PostToolUse";
  const guidance = event === "UserPromptSubmit" ? catchUpGuidance(id) : "";
  trackTurn(event, id, input, deps.now);
  const said = await callText(input, id, deps);
  if (event === "Stop") {
    if (said.text) return stopOutput(said.text, loadConfig());
    const call = callNudge(id, input, deps.now);
    return stopOutput(call, loadConfig());
  }
  // PostToolUse: their words go as the hook's own feedback (decision block + reason), not as context
  // inside the tool result, where models take them for text in the command output and ignore them
  // (wake reliability run 3, 2026-11-08). The tool already ran; block only shows the reason.
  if (event === "PostToolUse" && said.live) {
    const out = { decision: "block", reason: said.live };
    if (said.quiet) out.hookSpecificOutput = { hookEventName: event, additionalContext: said.quiet };
    return out;
  }
  const text = [guidance, said.text].filter(Boolean).join("\n\n");
  return text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : null;
}

if (require.main === module) runHook("inbox", (input) => inbox(input));

module.exports = { inbox, stopOutput };
