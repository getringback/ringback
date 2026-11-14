#!/usr/bin/env node
"use strict";

// Install the error boundary before loading any plugin code, including common.js.
if (require.main === module) {
  try {
    require("./guard.js").install("permission", 590000);
  } catch (err) {
    try {
      const fs = require("fs"), path = require("path");
      const dir = process.env.RINGBACK_HOME || path.join(require("os").homedir(), ".ringback");
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "hooks.log"), `${new Date().toISOString()} permission load: ${err.message}\n`);
    } catch { /* An incomplete install must stay quiet. */ }
    process.exit(0);
  }
}

// PermissionRequest: the pending permission goes to their phone (lib/tap-approval.js, PERMISSION TAP
// CONTRACT), where they tap Allow once or Deny; that is the decision. No tap in time, or an old
// phone, leaves the normal terminal prompt in place. A spoken yes never approves by itself.
// isClearYes stays for the phone-side voice step (a yes there only opens the tap screen).

const { loadConfig, isConfigured } = require("../lib/config.js");
const { api } = require("../lib/client.js");
const { callAndAsk } = require("../lib/calls.js");
const { runHook, projectOf, logError } = require("./common.js");
const { clearNeedsYou, readSession, sessionName } = require("../lib/sessions.js");
const { askByTap } = require("../lib/tap-approval.js");

// The whole reply must be a short, unqualified yes: every word from this vocabulary and
// at least one core affirmative. "Yes, if the tests pass" or "okay but ask me first" fail.
const CORE_YES = new Set(["yes", "yeah", "yep", "yup", "sure", "ok", "okay", "approve", "approved", "allow", "allowed"]);
const FILLER = new Set(["go", "ahead", "it", "do", "please", "allow", "fine", "sounds", "good", "thats", "that's"]);

function isClearYes(reply) {
  const words = String(reply || "").toLowerCase().replace(/[^a-z' ]+/g, " ").split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 6) return false;
  const allKnown = words.every((w) => CORE_YES.has(w) || FILLER.has(w));
  return allKnown && words.some((w) => CORE_YES.has(w) || w === "go");
}

function describe(input) {
  const tool = input.tool_name || "a tool";
  const ti = input.tool_input || {};
  const detail = ti.description || ti.command || ti.file_path || ti.url || "";
  const short = String(detail).replace(/\s+/g, " ").slice(0, 160);
  return short ? `${tool}: ${short}` : tool;
}

/**
 * Ends the approval call with a closing line. The phone refuses a hang-up while they are still talking
 * (409 he_is_talking): the call is then still open and the phone ends it itself once they are done,
 * so this never retries and never reports it ended. A failure never costs the approval itself.
 * Resolves "ended" | "he_is_talking" | "failed".
 */
async function closeCall(deps, cfg, callId, text) {
  try {
    const r = await deps.api.hangup(cfg, callId, text);
    if (r && r.status === "he_is_talking") {
      logError("permission", `call ${callId}: the user is still talking; the phone ends the call when they are done`);
      return "he_is_talking";
    }
    return "ended";
  } catch (err) {
    logError("permission hangup", err);
    return "failed";
  }
}

const out = (decision) => ({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });

/**
 * PERMISSION TAP CONTRACT (live 14:45): the pending permission goes to their phone; their tap (Allow
 * once / Deny) is the decision. Default on (tap_approvals), separate from voice_approvals. A spoken
 * yes never approves by itself: with voice_approvals the phone asks on a call and a yes only opens
 * the same tap screen. No tap in time, or an old phone: the terminal prompt, as without Ringback.
 */
async function permission(input, deps = { api, callAndAsk }) {
  const cfg = loadConfig();
  if (!isConfigured(cfg) || cfg.tap_approvals === false) return null;
  const sessionId = /^[A-Za-z0-9_-]{1,64}$/.test(String(input.session_id || "")) ? input.session_id : undefined;
  const rec = sessionId ? readSession(sessionId) : null;
  const decision = await (deps.askByTap || askByTap)(cfg, { ...input, session_id: sessionId }, {
    api: deps.api,
    sessionName: rec ? sessionName(rec) : projectOf(input),
    waitMs: deps.waitMs,
    now: deps.now,
    sleep: deps.sleep,
    log: (l) => logError("permission", l),
    atKeyboard: deps.atKeyboard,
  });
  if (!decision) return null;
  if (decision.behavior === "deny") return out(decision);
  // They allowed it on the phone: the prompt no longer waits on them (FOLLOWUPS item 37).
  if (sessionId) await (deps.clear || clearNeedsYou)(cfg, sessionId);
  return out(decision);
}

if (require.main === module) runHook("permission", (input) => permission(input));

module.exports = { permission, closeCall, isClearYes, describe };
