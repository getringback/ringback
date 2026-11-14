#!/usr/bin/env node
"use strict";

// Install the error boundary before loading any plugin code, including common.js.
if (require.main === module) {
  try {
    require("./guard.js").install("question", 590000);
  } catch (err) {
    try {
      const fs = require("fs"), path = require("path");
      const dir = process.env.RINGBACK_HOME || path.join(require("os").homedir(), ".ringback");
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "hooks.log"), `${new Date().toISOString()} question load: ${err.message}\n`);
    } catch { /* An incomplete install must stay quiet. */ }
    process.exit(0);
  }
}

// PreToolUse for AskUserQuestion (synchronous): the session's question goes to their phone with
// every option (lib/tap-approval.js askQuestion, PERMISSION TAP CONTRACT). Their pick comes back as
// the documented answer: permissionDecision "allow" with updatedInput {questions, answers}
// (code.claude.com/docs hooks.md, "Allow with updatedInput"). No answer in time, an old phone, or
// they are at the keyboard: nothing returned, and the terminal dialog asks them as usual.

const { loadConfig, isConfigured } = require("../lib/config.js");
const { api } = require("../lib/client.js");
const { runHook, projectOf, logError } = require("./common.js");
const { readSession, sessionName } = require("../lib/sessions.js");
const { askQuestion } = require("../lib/tap-approval.js");

async function question(input, deps = { api }) {
  if (!input || input.tool_name !== "AskUserQuestion") return null;
  const cfg = loadConfig();
  if (!isConfigured(cfg) || cfg.tap_approvals === false) return null;
  const sessionId = /^[A-Za-z0-9_-]{1,64}$/.test(String(input.session_id || "")) ? input.session_id : undefined;
  const rec = sessionId ? readSession(sessionId) : null;
  const answers = await (deps.askQuestion || askQuestion)(cfg, { ...input, session_id: sessionId }, {
    api: deps.api,
    sessionName: rec ? sessionName(rec) : projectOf(input),
    waitMs: deps.waitMs,
    now: deps.now,
    sleep: deps.sleep,
    atKeyboard: deps.atKeyboard,
    log: (l) => logError("question", l),
  });
  if (!answers) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...(input.tool_input || {}), answers },
    },
  };
}

if (require.main === module) runHook("question", (input) => question(input));

module.exports = { question };
