"use strict";
// Shared helpers for Ringback hooks. Hooks never break a session: any failure is
// written to ~/.ringback/hooks.log and the hook exits 0 with no decision.

const fs = require("fs");
const path = require("path");
const { configDir } = require("../lib/config.js");

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(text.trim() ? JSON.parse(text) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function logError(where, err) {
  try {
    require("./log.js").write("hooks.log", `${where}: ${err && err.message ? err.message : err}`);
  } catch {
    // Logging must never be the thing that breaks a hook.
  }
}

function stateFile(sessionId) {
  const safe = String(sessionId || "unknown").replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(configDir(), "state", `${safe}.json`);
}

function readState(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(sessionId), "utf8"));
  } catch {
    return {};
  }
}

function writeState(sessionId, state) {
  const file = stateFile(sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
}

function projectOf(input) {
  const dir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return path.basename(dir) || "home";
}

async function runHook(name, fn) {
  try {
    const input = await readStdin();
    const out = await fn(input);
    if (out) process.stdout.write(JSON.stringify(markOutput(out)));
  } catch (err) {
    logError(name, err);
  }
  process.exit(0);
}

function markOutput(out) {
  const mark = (text) => typeof text === "string" && text && !text.startsWith("[Ringback]") ? `[Ringback] ${text}` : text;
  if (typeof out.reason === "string") out.reason = mark(out.reason);
  const specific = out.hookSpecificOutput;
  if (specific) {
    if (typeof specific.additionalContext === "string") specific.additionalContext = mark(specific.additionalContext);
    if (specific.decision && typeof specific.decision.message === "string") specific.decision.message = mark(specific.decision.message);
  }
  for (const step of out.injectSteps || []) {
    if (step.systemMessage) step.systemMessage.systemMessage = mark(step.systemMessage.systemMessage);
  }
  return out;
}

/** True when a hook fired inside a subagent: Claude Code then adds agent_id to the session's input. */
const isSubagentHook = (input) => Boolean(input && input.agent_id);

module.exports = { readStdin, logError, readState, writeState, projectOf, runHook, isSubagentHook, markOutput };
