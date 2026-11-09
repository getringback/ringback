#!/usr/bin/env node
"use strict";
// SessionEnd (synchronous so it finishes before Claude Code exits; short connect bound): take this session off the phone. A run marked as
// the helper's (RINGBACK_HELPER_RUN, an avatar job) is ignored: no session of theirs ends with it.

const { loadConfig, isConfigured } = require("../lib/config.js");
const { api } = require("../lib/client.js");
const { unregister, clearOwner, hookClaudePid } = require("../lib/sessions.js");
const { runHook } = require("./common.js");

async function sessionEnd(input, deps = { api, now: Date.now(), env: process.env }) {
  if (deps.env.RINGBACK_HELPER_RUN === "1") return null;
  // /clear and resume switch to another session id; the new one registers itself.
  const cfg = loadConfig();
  if (!isConfigured(cfg)) return null;
  clearOwner(hookClaudePid(deps.env), input.session_id);
  await unregister(cfg, input, deps);
  return null;
}

if (require.main === module) runHook("session-end", (input) => sessionEnd(input));

module.exports = { sessionEnd };
