#!/usr/bin/env node
"use strict";
// UserPromptSubmit / PostToolUse / Stop (async): heartbeat this session to the phone, at most one
// request per 30 s unless busy/idle changed. On Stop the synchronous inbox hook decides whether
// the session really stops, so this waits a moment and then reports whatever it recorded.

const { loadConfig, isConfigured } = require("../lib/config.js");
const { api } = require("../lib/client.js");
const { heartbeat, readSession, writeSession, safeId, writeOwner, hookClaudePid } = require("../lib/sessions.js");
const { ensureHelper } = require("../lib/helper-lock.js");
const { runHook, logError, isSubagentHook } = require("./common.js");

const STOP_SETTLE_MS = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function activity(input, deps = { api, now: Date.now(), ensureHelper, settleMs: STOP_SETTLE_MS }) {
  const cfg = loadConfig();
  if (!isConfigured(cfg) || !safeId(input.session_id)) return null;
  try {
    deps.ensureHelper();
  } catch (err) {
    logError("activity helper", err);
  }
  try {
    // Sessions that started before this plugin version get their pid link here (a read when unchanged).
    writeOwner(hookClaudePid(), input.session_id);
  } catch (err) {
    logError("activity owner", err);
  }
  // A subagent working is not a turn of this session: marked busy, an idle session's waiter held a
  // call for hooks that never came. Only remembered, so an idle ping meanwhile counts as stale.
  if (isSubagentHook(input)) {
    const rec = readSession(input.session_id);
    if (rec) writeSession(input.session_id, { ...rec, subagent_at: deps.now || Date.now() });
    return null;
  }
  if (input.hook_event_name === "Stop") {
    await sleep(deps.settleMs);
    const rec = readSession(input.session_id);
    // A turn just ended, so no prompt is open: whatever raised the flag is over (FOLLOWUPS item
    // 37). If they do not answer, the idle_prompt notification raises it again.
    if (rec && rec.needs_you === true) writeSession(input.session_id, { ...rec, needs_you: false });
    await heartbeat(cfg, input, (rec && rec.state) || "idle", { ...deps, now: Date.now() }, true);
    return null;
  }
  // They answered (a prompt, or a tool ran after their permission): no longer waiting on them.
  const rec = readSession(input.session_id);
  const answered = rec && rec.needs_you === true;
  if (answered) writeSession(input.session_id, { ...rec, needs_you: false });
  await heartbeat(cfg, input, "busy", deps, answered);
  return null;
}

if (require.main === module) runHook("activity", (input) => activity(input));

module.exports = { activity };
