#!/usr/bin/env node
"use strict";

// Install the error boundary before loading any plugin code, including common.js.
if (require.main === module) {
  try {
    require("./guard.js").install("client-hook", (process.argv[2] === "agy" ? (process.argv[3] === "Stop" ? 82800000 : 14000) : ({ end: 2200, context: 9000, inbox: 14000, beat: 28000 }[process.argv[3]] || 9000)));
  } catch (err) {
    try {
      const fs = require("fs"), path = require("path");
      const dir = process.env.RINGBACK_HOME || path.join(require("os").homedir(), ".ringback");
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "hooks.log"), `${new Date().toISOString()} client-hook load: ${err.message}\n`);
    } catch { /* An incomplete install must stay quiet. */ }
    process.exit(0);
  }
}

// Hook adapter for clients other than Claude Code (FOLLOWUPS item 20):
//   node client-hook.js codex <context|beat|inbox|end>
//   node client-hook.js agy <SessionStart|PreInvocation|Stop>
// It turns the client's hook input into the session record the Claude Code hooks keep, so the
// session shows on the phone, heartbeats, and gets what the user says on a call while it is busy.
// An idle session is woken in its own window (lib/visible-wake.js); there is no hidden answer run.
//
// Codex (hooks docs: SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd; async allowed):
//   context: SessionStart -> hookSpecificOutput.additionalContext (the call guidance)
//   beat (async): register on SessionStart, heartbeat busy on prompts and tools
//   inbox: UserPromptSubmit / PostToolUse -> additionalContext; Stop -> {decision:"block", reason},
//     then the final busy / idle heartbeat (forced, so the phone never keeps a stale busy)
//   end: SessionEnd -> off the phone
// Antigravity (hooks.json: SessionStart, PreInvocation, Stop; synchronous only, camelCase input):
//   SessionStart: register + {injectSteps:[systemMessage]} with the call guidance
//   PreInvocation: heartbeat busy + what they said as an injected system message
//   Stop: what they said -> {decision:"continue", reason}, else heartbeat idle. agy has no session
//   end hook: the helper drops a session 24 h after its last hook.
// Visible wake (lib/visible-wake.js): Codex records the process that runs the session (owner_pid),
// so the helper can `codex queue` a call into that window; agy, with config agy_visible_wake,
// keeps its Stop hook waiting while idle and continues the session when they call.

const fs = require("fs");
const path = require("path");
const { loadConfig, isConfigured } = require("../lib/config.js");
const { api } = require("../lib/client.js");
const sessions = require("../lib/sessions.js");
const { ensureHelper } = require("../lib/helper-lock.js");
const { CONTEXT } = require("./session-start.js");
const { recordStartFlags, approveViewImage } = require("./session-register.js");
const { ensureViewImageApproved } = require("../lib/auto-approve.js");
const { runHook, logError } = require("./common.js");
const wake = require("../lib/visible-wake.js");
const { ancestorProcesses } = require("../lib/proc.js");
const waiter = require("./wake-wait.js");

const noStart = () => null;

/** The Claude-Code-shaped hook input for `client`, or null when it names no usable session. */
function normalize(client, raw = {}, eventArg = "") {
  if (client === "codex") {
    const id = sessions.safeId(raw.session_id);
    if (!id) return null;
    // transcript_path is the rollout: its turn_context holds the sandbox and approval policy (item 47).
    const transcript = typeof raw.transcript_path === "string" && raw.transcript_path ? { transcript_path: raw.transcript_path } : {};
    return { client, session_id: id, cwd: raw.cwd || "", hook_event_name: raw.hook_event_name || eventArg, source: raw.source || "", ...transcript };
  }
  if (client === "agy") {
    const id = sessions.safeId(raw.conversationId);
    if (!id) return null;
    const cwd = Array.isArray(raw.workspacePaths) && raw.workspacePaths[0] ? raw.workspacePaths[0] : "";
    return {
      client,
      session_id: id,
      cwd,
      hook_event_name: eventArg,
      source: "",
      cancelled: raw.terminationReason === "USER_CANCELED",
    };
  }
  return null;
}

/** Puts the session on the phone (start) or heartbeats it. Never throws. */
async function beat(cfg, input, state, deps) {
  try {
    deps.ensureHelper();
  } catch (err) {
    logError(`${input.client} helper`, err);
  }
  try {
    if (input.hook_event_name === "SessionStart") {
      // A phone start request (item 21) opens Claude Code; another client never takes its id.
      await sessions.register(cfg, input, { ...deps, takeStart: noStart });
      // The client's start flags (sandbox, approvals, mode), kept with the session record.
      if (deps.recordStartFlags) deps.recordStartFlags(input);
      // FOLLOWUPS item 49: view_image never asks in this client either.
      if (deps.approve) approveViewImage(input.client, deps.approve);
      return;
    }
    await sessions.heartbeat(cfg, input, state, deps, input.hook_event_name === "Stop");
  } catch (err) {
    logError(`${input.client} beat`, err);
  }
}

function markLocal(id, state, now) {
  const rec = sessions.readSession(id);
  if (rec) sessions.writeSession(id, { ...rec, state, last_hook_at: now });
}

/** What the user said on a call to this busy session, or "" (the network only when flagged). */
async function said(cfg, input, deps) {
  const id = input.session_id;
  if (!sessions.hasPending(id)) return "";
  let locked = false;
  try {
    const got = await sessions.drain(sessions.hookCfg(cfg), id, deps, !sessions.phoneDown());
    locked = got === null;
    return got && got.length ? sessions.describeMessages(got) : "";
  } catch (err) {
    if (!err.status) sessions.markPhoneDown();
    logError(`${input.client} inbox`, err);
    return "";
  } finally {
    if (!locked) sessions.setPending(id, false);
  }
}

const runFile = (id) => path.join(sessions.stateDir(), "client-runs", `${sessions.safeId(id)}.json`);

/**
 * How this session's client runs: { headless, owner } (lib/visible-wake.js classify), from one
 * walk of the hook's ancestor processes per session, cached by session id. SessionStart (a start
 * or a resume in a new window) walks again. Never throws: unknown is interactive, owner 0.
 */
function runInfo(input, deps) {
  const file = runFile(input.session_id);
  // The cache holds for the process that walked it: a `codex exec resume <id>` of a real session
  // runs under another parent, so it never leaves "headless" behind for the real window.
  if (input.hook_event_name !== "SessionStart") {
    try {
      const cached = JSON.parse(fs.readFileSync(file, "utf8"));
      if (cached && typeof cached.headless === "boolean" && cached.ppid === process.ppid) return cached;
    } catch {
      // Not decided yet for this session.
    }
  }
  let info = { headless: deps.env.RINGBACK_HELPER_RUN === "1", owner: 0 };
  try {
    info = wake.classify(input.client, deps.env, (deps.ancestors || ancestorProcesses)(process.ppid, 8));
  } catch (err) {
    logError(`${input.client} run info`, err);
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...info, ppid: process.ppid }));
  } catch {
    // Only a cache.
  }
  return info;
}

/**
 * Remembers which client process runs this session (owner_pid), so a call can be queued into its
 * window while it lives (Codex) and the helper drops the session once that process is gone.
 */
function recordOwner(input, info) {
  try {
    const rec = sessions.readSession(input.session_id);
    // ChatGPT desktop threads (a codex app-server child of ChatGPT.exe) say so on the phone.
    const host = info.host === "chatgpt" ? { runs_in: "chatgpt", ...(rec && (!rec.title || rec.title === "Codex") ? { title: "ChatGPT desktop" } : {}) } : {};
    if (!rec || (rec.owner_pid === info.owner && (!host.runs_in || rec.runs_in === host.runs_in))) return false;
    sessions.writeSession(input.session_id, { ...rec, owner_pid: info.owner, ...host });
    return true;
  } catch (err) {
    logError(`${input.client} owner`, err);
    return false;
  }
}

const codexContext = (event, text) => ({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });

async function codex(mode, input, cfg, deps) {
  const event = input.hook_event_name;
  if (mode === "context") return event === "SessionStart" ? codexContext("SessionStart", CONTEXT) : null;
  if (mode === "beat") {
    // Stop's final state goes out from the inbox hook, after it knows whether the turn goes on.
    if (event !== "Stop") await beat(cfg, input, "busy", deps);
    recordOwner(input, deps.info);
    return null;
  }
  if (mode === "inbox") {
    const text = await said(cfg, input, deps);
    if (event === "Stop") {
      const state = text ? "busy" : "idle";
      markLocal(input.session_id, state, deps.now);
      await beat(cfg, input, state, deps);
      return text ? { decision: "block", reason: text } : null;
    }
    return text && (event === "UserPromptSubmit" || event === "PostToolUse") ? codexContext(event, text) : null;
  }
  if (mode === "end") {
    // A run marked as the helper's (an avatar job) ends; no session of theirs ends with it.
    if (deps.env.RINGBACK_HELPER_RUN === "1") return null;
    await sessions.unregister(cfg, input, deps);
  }
  return null;
}

const agySteps = (text) => ({ injectSteps: [{ systemMessage: { systemMessage: text } }] });

async function agy(input, cfg, deps) {
  const event = input.hook_event_name;
  // After this hook's beat has written the record (SessionStart registers it first).
  const own = (out) => (recordOwner(input, deps.info), out);
  if (event === "SessionStart") {
    await beat(cfg, input, "idle", deps);
    return own(agySteps(CONTEXT));
  }
  if (event === "PreInvocation") {
    await beat(cfg, input, "busy", deps);
    own(null);
    // Their words are not injected between model steps any more: right after a tool result agy shows
    // them as part of that output and the model ignores them (reliability run 4). The Stop hook
    // hands them over instead ({decision:"continue", reason}), which the model acts on.
    return {};
  }
  if (event === "Stop") {
    const text = input.cancelled ? "" : await said(cfg, input, deps);
    const state = text ? "busy" : "idle";
    markLocal(input.session_id, state, deps.now);
    await beat(cfg, { ...input, hook_event_name: "Stop" }, state, deps);
    own(null);
    if (text) return { decision: "continue", reason: text };
    return input.cancelled ? {} : agyHold(cfg, input, deps);
  }
  return {};
}

/**
 * agy visible wake (opt-in, config agy_visible_wake): this Stop hook becomes the session's waiter
 * (the helper leaves a session with a live waiter alone) and stays until they say something to it
 * on a call; then the session continues in its own window with their words. {} when off, headless,
 * another waiter holds the session, or the wait ran out.
 */
async function agyHold(cfg, input, deps) {
  if (!wake.agyWakeOn(cfg)) return {};
  const id = input.session_id;
  // A headless run never gets here (clientHook stops it first); this guards direct callers.
  if (deps.info && deps.info.headless) return {};
  const w = deps.waiter || waiter;
  // Owner 0: an agy started from inside a Claude Code session inherits its CLAUDE_PID; not its owner.
  if (!w.claimSlot(id, process.pid, Date.now(), 0)) return {};
  try {
    const text = await w.waitForWords(id, deps.waitDeps);
    if (!text) return {};
    await sessions.clearNeedsYou(cfg, id).catch((err) => logError("agy wake", err));
    markLocal(id, "busy", Date.now());
    return { decision: "continue", reason: text };
  } catch (err) {
    logError("agy wake", err);
    return {};
  } finally {
    w.releaseSlot(id);
  }
}

async function clientHook(client, mode, raw, deps = defaultDeps()) {
  const cfg = loadConfig();
  // Antigravity expects a JSON object on stdout from every hook.
  const empty = client === "agy" ? {} : null;
  if (!isConfigured(cfg)) return empty;
  const input = normalize(client, raw, client === "agy" ? mode : "");
  if (!input) return empty;
  // agy -p / acp, codex exec / review and the helper's own runs never show on the phone.
  const info = deps.info || runInfo(input, deps);
  if (info.headless) return empty;
  const withInfo = { ...deps, info };
  if (client === "codex") return codex(mode, input, cfg, withInfo);
  return agy(input, cfg, withInfo);
}

function defaultDeps() {
  return { api, now: Date.now(), ensureHelper, env: process.env, recordStartFlags, approve: ensureViewImageApproved };
}

if (require.main === module) {
  const [client, mode] = process.argv.slice(2);
  // runHook prints any object, so agy's empty answer goes out as "{}".
  runHook(`client-hook ${client} ${mode}`, (raw) => clientHook(client, mode, raw));
}

module.exports = { clientHook, normalize, recordOwner, runInfo, agyHold };
