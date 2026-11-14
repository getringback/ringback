#!/usr/bin/env node
"use strict";

// Install the error boundary before loading any plugin code, including common.js.
if (require.main === module) {
  try {
    require("./guard.js").install("session-register", 28000);
  } catch (err) {
    try {
      const fs = require("fs"), path = require("path");
      const dir = process.env.RINGBACK_HOME || path.join(require("os").homedir(), ".ringback");
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "hooks.log"), `${new Date().toISOString()} session-register load: ${err.message}\n`);
    } catch { /* An incomplete install must stay quiet. */ }
    process.exit(0);
  }
}

// SessionStart (async): put this session on the phone's Sessions list and make sure the helper
// that answers calls to idle sessions is running. Never delays the session.
// It also records the permission flags the claude process was started with (FOLLOWUPS item 47):
// SessionStart's input has no permission_mode, so until the first prompt hook reports the mode,
// the flags are the best known mode (a phone-started session uses their usual one, item 50h).

const { loadConfig, isConfigured } = require("../lib/config.js");
const { api } = require("../lib/client.js");
const { register, readSession, writeSession, safeId, hookClaudePid } = require("../lib/sessions.js");
const { ensureHelper } = require("../lib/helper-lock.js");
const permissions = require("../lib/permissions.js");
const { ancestorCommandLines } = require("../lib/proc.js");
const { ensureViewImageApproved } = require("../lib/auto-approve.js");
const { runHook, logError } = require("./common.js");

/** Records the client's start flags on the session; true when something was recorded. */
function recordStartFlags(input, deps = {}) {
  const env = deps.env || process.env;
  const id = safeId(input.session_id);
  if (!id || env.RINGBACK_HELPER_RUN === "1") return false;
  const client = input.client || "claude-code";
  const lines = (deps.lines || ancestorCommandLines)(deps.pid || hookClaudePid(env), 4);
  const facts = permissions.fromFlags(client, lines);
  const rec = readSession(id);
  if (!rec) return false;
  const withFacts = permissions.withPermissions(rec, facts, "flags", deps.now || Date.now());
  // What this session was started with ("" = no flag), for sessions started from the phone (item 50h).
  const startMode = client === "claude-code" ? facts.mode || "" : undefined;
  const next = startMode !== undefined && withFacts.start_mode !== startMode ? { ...withFacts, start_mode: startMode } : withFacts;
  if (next === rec) return false;
  writeSession(id, next);
  return true;
}

const defaultDeps = () => ({ api, now: Date.now(), ensureHelper, recordStartFlags, approve: ensureViewImageApproved });

/** FOLLOWUPS item 49: view_image never asks in this client's own sessions. Logs a change. */
function approveViewImage(client, approve) {
  if (process.env.RINGBACK_HELPER_RUN === "1") return;
  const res = approve(client);
  if (res && res.changed) logError("view_image", `pre-approved in ${res.file}${res.backup ? ` (backup ${res.backup})` : ""}`);
}

async function sessionRegister(input, deps = defaultDeps()) {
  const cfg = loadConfig();
  if (!isConfigured(cfg)) return null;
  try {
    deps.ensureHelper();
  } catch (err) {
    logError("session-register helper", err);
  }
  await register(cfg, input, deps);
  try {
    if (deps.recordStartFlags) deps.recordStartFlags(input);
  } catch (err) {
    logError("session-register permissions", err);
  }
  try {
    if (deps.approve) approveViewImage("claude-code", deps.approve);
  } catch (err) {
    logError("session-register view_image", err);
  }
  return null;
}

if (require.main === module) runHook("session-register", (input) => sessionRegister(input));

module.exports = { sessionRegister, recordStartFlags, approveViewImage };
