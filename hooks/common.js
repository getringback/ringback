"use strict";
// Shared helpers for Ringback hooks. Hooks never break a session: any failure is
// written to ~/.ringback/hooks.log and the hook exits 0 with no decision.

const fs = require("fs");
const path = require("path");
const { configDir } = require("../lib/config.js");

const MAX_LOG_BYTES = 1024 * 1024;

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
    fs.mkdirSync(configDir(), { recursive: true });
    const line = `${new Date().toISOString()} ${where}: ${err && err.message ? err.message : err}\n`;
    const file = path.join(configDir(), "hooks.log");
    // Audit L4: the same 1 MB rotation as helper.log (one line every poll per idle session adds up).
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {
      // No log yet, or another hook rotated it first.
    }
    fs.appendFileSync(file, line);
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
    if (out) process.stdout.write(JSON.stringify(out));
  } catch (err) {
    logError(name, err);
  }
  process.exit(0);
}

/** True when a hook fired inside a subagent: Claude Code then adds agent_id to the session's input. */
const isSubagentHook = (input) => Boolean(input && input.agent_id);

module.exports = { readStdin, logError, readState, writeState, projectOf, runHook, isSubagentHook };
