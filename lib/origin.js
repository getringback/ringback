"use strict";
// Where a Claude Code session runs (FOLLOWUPS item 48): the Claude Desktop app's Code tab or a
// terminal. New sessions know it from CLAUDE_CODE_ENTRYPOINT in their hooks ("claude-desktop" or
// "cli"). Sessions recorded before 0.7.2 are marked on helper start from what is on disk:
//  1. the transcript's own entrypoint (each JSONL entry carries one; helper runs add "sdk-cli"
//     lines, which are skipped). Seen on this laptop: d5a47009 has "claude-desktop" entries.
//  2. the live claude process: Desktop runs Claude Code from %APPDATA%\Claude\claude-code\<ver>\
//     with the AnthropicClaude app as its parent.

const fs = require("fs");
const { ancestorCommandLines } = require("./proc.js");

const HEAD_BYTES = 256 * 1024;
const DESKTOP_PROCESS = /[\\/]Claude[\\/]claude-code[\\/]|[\\/]AnthropicClaude[\\/]/i;

function head(file, limit = HEAD_BYTES) {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(limit);
      const n = fs.readSync(fd, buf, 0, limit, 0);
      return buf.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

/** The session's own entrypoint from its transcript ("claude-desktop", "cli", ...), or null. */
function transcriptEntrypoint(file) {
  if (!file) return null;
  for (const line of head(file).split(/\r?\n/)) {
    const m = line.match(/"entrypoint":"([a-z-]+)"/);
    if (m && m[1] !== "sdk-cli") return m[1];
  }
  return null;
}

/** "desktop" when a live claude process (or its parent) is the Desktop app's Claude Code. */
function processOrigin(pid, lines = ancestorCommandLines) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return null;
  const cmds = lines(Number(pid), 2) || [];
  if (!cmds.length) return null;
  return cmds.some((c) => DESKTOP_PROCESS.test(c)) ? "desktop" : "terminal";
}

const marked = (rec, where) =>
  where === "desktop" ? { ...rec, desktop_app: true, runs_in: "desktop" } : { ...rec, runs_in: "terminal" };

/**
 * `rec` with desktop_app / runs_in filled in when they were unknown; the same object otherwise.
 * deps.lines: ancestor command lines (tests); deps.processes false skips the process lookup.
 */
function withOrigin(rec, deps = {}) {
  if (!rec || rec.desktop_app === true || rec.runs_in) return rec;
  const entry = transcriptEntrypoint(rec.transcript_path);
  if (entry === "claude-desktop") return marked(rec, "desktop");
  if (entry === "cli") return marked(rec, "terminal");
  if (deps.processes === false) return rec;
  const where = processOrigin(rec.claude_pid, deps.lines || ancestorCommandLines);
  return where ? marked(rec, where) : rec;
}

/** From a hook's own environment: "desktop", "terminal" or null (other entrypoints). */
function envOrigin(env = process.env) {
  const entry = String(env.CLAUDE_CODE_ENTRYPOINT || "");
  if (entry === "claude-desktop") return "desktop";
  return entry === "cli" ? "terminal" : null;
}

module.exports = { DESKTOP_PROCESS, transcriptEntrypoint, processOrigin, withOrigin, envOrigin };
