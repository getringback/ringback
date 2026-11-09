"use strict";
// Per-session live view (spec 04 sections 2.1 and 6.7.3, FOLLOWUPS item 58): tail the session's
// own transcript and map entries to terminal lines. This, not a window capture, is what shows
// THAT session: on Windows every terminal tab shares one Windows Terminal window.
//  - Claude Code (terminal and the Desktop Code tab): the transcript JSONL (hook transcript_path).
//  - Codex: its rollout JSONL (lib/codex-rollout.js), also the hook's transcript_path.
// The formats are not documented, so anything unknown is skipped and nothing here throws on odd
// input. Thinking blocks are never sent; every text is redacted (lib/view-format.js).

const fs = require("fs");
const os = require("os");
const path = require("path");
const fmt = require("./view-format.js");

const { line, toolLine, resultLine, shortPath, replaceDiff, oneLine, MAX_TEXT } = fmt;
const BACKLOG = 300;
const MAX_LINES_PER_MSG = 200;
const MAX_MSG_BYTES = 256 * 1024;
const READ_TAIL_BYTES = 4 * 1024 * 1024;
const POLL_MS = 500;
const MAX_TOOL_IDS = 500;

function blocksOf(msg) {
  const c = msg && msg.content;
  if (typeof c === "string") return [{ type: "text", text: c }];
  return Array.isArray(c) ? c.filter((b) => b && typeof b === "object") : [];
}

const NOISE = /^\s*(<command-|<local-command|<system-reminder|<task-notification|Caveat: )/;
const REMINDER = /<system-reminder>[\s\S]*?(<\/system-reminder>|$)/g;
// System entries that are bookkeeping, never worth a line on the phone.
const QUIET_SYSTEM = new Set(["stop_hook_summary", "turn_duration", "api_error", "hook_success", "bridge_status"]);

const TOOL_ARG = { Bash: "command", PowerShell: "command", Read: "file_path", Write: "file_path", Edit: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path", Grep: "pattern", Glob: "pattern", WebFetch: "url", WebSearch: "query", Agent: "description", Task: "description", Skill: "skill", ToolSearch: "query" };
const EDITS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

function shortInput(name, input) {
  if (!input || typeof input !== "object") return "";
  const key = TOOL_ARG[name];
  const v = key && typeof input[key] === "string" ? input[key] : null;
  if (v) return /path$/.test(key) ? shortPath(v) : v;
  for (const k of ["command", "file_path", "pattern", "url", "path", "query", "description"]) {
    if (typeof input[k] === "string" && input[k]) return /path/.test(k) ? shortPath(input[k]) : input[k];
  }
  return JSON.stringify(input).slice(0, 120);
}

/** The small diff shown under an edit: what changed, never the whole file. */
function editDiff(name, input) {
  if (!input || typeof input !== "object") return "";
  if (name === "Edit") return replaceDiff(input.old_string, input.new_string);
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    const first = input.edits[0] || {};
    const d = replaceDiff(first.old_string, first.new_string);
    return input.edits.length > 1 ? `${d}\n    ... ${input.edits.length - 1} more edits` : d;
  }
  if (name === "Write" && typeof input.content === "string") return `    + ${input.content.split("\n").length} lines written`;
  return "";
}

/** The tool's own file as a chip: its full path (the text shows it shortened). */
function fileOf(input) {
  if (!input || typeof input !== "object") return [];
  const p = input.file_path || input.notebook_path || input.path;
  return typeof p === "string" && p ? [p] : [];
}

function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && b.type === "text" ? b.text : b && b.type === "image" ? "[image]" : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** One tool result line; edits and reads say how they went instead of echoing the file. */
function toolResult(b, tool, t) {
  const text = resultText(b.content).replace(REMINDER, "");
  const error = b.is_error === true;
  if (!error && EDITS.has(tool)) return line("result", "  ⎿ saved", t);
  if (!error && tool === "Read") return line("result", `  ⎿ read ${text.split("\n").length} lines`, t);
  return resultLine(text, t, { error });
}

function userLines(e, t, tools) {
  if (e.isMeta || e.isCompactSummary) return e.isCompactSummary ? [line("system", "Conversation compacted", t)] : [];
  const out = [];
  for (const b of blocksOf(e.message)) {
    if (b.type === "text" && typeof b.text === "string") {
      const text = b.text.replace(REMINDER, "").trim();
      if (text && !NOISE.test(text)) out.push(line("user", `> ${text}`, t));
    } else if (b.type === "tool_result") out.push(toolResult(b, tools.get(b.tool_use_id), t));
  }
  return out;
}

function assistantLines(e, t, tools) {
  const out = [];
  for (const b of blocksOf(e.message)) {
    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) out.push(line("assistant", b.text.trim(), t));
    else if (b.type === "tool_use") {
      const name = String(b.name || "tool");
      if (b.id) {
        tools.set(b.id, name);
        if (tools.size > MAX_TOOL_IDS) tools.delete(tools.keys().next().value);
      }
      out.push(toolLine(name, shortInput(name, b.input), t, editDiff(name, b.input), fileOf(b.input)));
    }
  }
  return out;
}

/**
 * A stateful Claude Code mapper: remembers tool names by id, so a result can say "saved"
 * instead of echoing a whole file. Returns (entry) => lines.
 */
function createMapper() {
  const tools = new Map();
  return (e) => {
    if (!e || typeof e !== "object" || e.isSidechain) return [];
    const t = Date.parse(e.timestamp) || Date.now();
    if (e.type === "user") return userLines(e, t, tools);
    if (e.type === "assistant") return assistantLines(e, t, tools);
    if (e.type === "system") {
      if (QUIET_SYSTEM.has(e.subtype)) return [];
      const text = typeof e.content === "string" ? e.content.trim() : "";
      return text ? [line("system", oneLine(text.split("\n")[0], 300), t)] : [];
    }
    if (e.type === "summary" && typeof e.summary === "string") return [line("system", `Summary: ${e.summary}`, t)];
    return [];
  };
}

/** Terminal lines for one transcript entry, without tool context; [] for anything not shown. */
const mapEntry = (e) => createMapper()(e);

function parseJsonLines(text, map = createMapper()) {
  const out = [];
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    try {
      out.push(...map(JSON.parse(l)));
    } catch {
      // A broken line is skipped, never fatal.
    }
  }
  return out;
}

/** Lines split into messages of at most 200 lines and 256 KB each. */
function batches(lines) {
  const out = [];
  let cur = [];
  let bytes = 40;
  for (const l of lines) {
    const n = Buffer.byteLength(JSON.stringify(l)) + 1;
    if (cur.length && (cur.length >= MAX_LINES_PER_MSG || bytes + n > MAX_MSG_BYTES)) {
      out.push(cur);
      cur = [];
      bytes = 40;
    }
    cur.push(l);
    bytes += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Tail `file`: the last 300 lines first, then whatever is appended (stat poll), surviving a
 * partial last line and truncation. `onLines(lines)` gets each batch. `mapper` turns one
 * entry into lines (Claude Code by default, lib/codex-rollout.js for Codex). Returns { stop }.
 */
function tail(file, onLines, { pollMs = POLL_MS, backlog = BACKLOG, mapper = createMapper() } = {}) {
  let offset = 0;
  let partial = "";
  let stopped = false;
  let timer = null;
  const readFrom = (start, end) => {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  };
  const consume = (text, first) => {
    const all = partial + text;
    const cut = all.lastIndexOf("\n");
    partial = cut < 0 ? all : all.slice(cut + 1);
    const lines = parseJsonLines(cut < 0 ? "" : all.slice(0, cut), mapper);
    const shown = first ? lines.slice(-backlog) : lines;
    if (shown.length) onLines(shown);
  };
  const tick = (first = false) => {
    if (stopped) return;
    try {
      const size = fs.statSync(file).size;
      if (size < offset) {
        offset = 0;
        partial = "";
      }
      if (size > offset) {
        let start = offset;
        if (first && size - start > READ_TAIL_BYTES) {
          start = size - READ_TAIL_BYTES;
          partial = "\u0000";
        }
        const text = readFrom(start, size);
        offset = size;
        if (partial === "\u0000") {
          partial = "";
          consume(text.slice(text.indexOf("\n") + 1), first);
        } else consume(text, first);
      }
    } catch {
      // The file may be mid-rotation; try again next tick.
    }
    if (!stopped) timer = setTimeout(() => tick(false), pollMs);
  };
  tick(true);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/** Folders the client keeps transcripts in: Claude Code projects, or Codex sessions (rollouts). */
function projectRoots({ home = os.homedir(), env = process.env, client = "claude-code" } = {}) {
  if (client === "codex") {
    const roots = [path.join(home, ".codex", "sessions")];
    if (env.CODEX_HOME) roots.push(path.join(env.CODEX_HOME, "sessions"));
    return roots;
  }
  const roots = [path.join(home, ".claude", "projects")];
  if (env.CLAUDE_CONFIG_DIR) roots.push(path.join(env.CLAUDE_CONFIG_DIR, "projects"));
  return roots;
}

/** realpath of `file` when it is a .jsonl under the client's transcript folder, else null (T10). */
function safeTranscript(file, opts = {}) {
  if (typeof file !== "string" || !file.endsWith(".jsonl")) return null;
  let real;
  try {
    real = fs.realpathSync(file);
  } catch {
    return null;
  }
  const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  for (const root of projectRoots(opts)) {
    let r;
    try {
      r = fs.realpathSync(root);
    } catch {
      continue;
    }
    const rel = path.relative(norm(r), norm(real));
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return real;
  }
  return null;
}

module.exports = { mapEntry, createMapper, parseJsonLines, batches, tail, safeTranscript, projectRoots, MAX_TEXT, BACKLOG };
