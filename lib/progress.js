"use strict";
// What a session has done so far and what it is doing now, plus its title, read from its own
// Claude Code transcript (FOLLOWUPS items 4 and 9). Pure text extraction: no AI call, no network.
//   title:   /rename (custom-title), else Claude Code's ai-title / summary, trimmed to about 40
//            characters; "" when it has none (never a guess from a message: lib/sessions.js
//            names it from its folder and where it runs instead).
//   summary: the first sentence of the last assistant message (max 140 chars).
//   doing:   the task / todo item in progress (with done/total), else the latest tool step of
//            the current turn, in plain words (max 140 chars).

const fs = require("fs");

const MAX_LINE = 140;
const MAX_TITLE = 40;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 512 * 1024;

const plain = (t) =>
  String(t || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/[–—]/g, ",")
    .replace(/\s+/g, " ")
    .trim();

function clip(text, max) {
  const t = plain(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 3);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, "")}...`;
}

/** The first sentence of `text`, at most `max` characters. */
function firstSentence(text, max = MAX_LINE) {
  const t = plain(text);
  const m = t.match(/^(.+?[.!?])(\s|$)/);
  return clip(m ? m[1] : t, max);
}

function parseLines(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      // A line cut by the tail window, or a partial write.
    }
  }
  return out;
}

const blocks = (msg) => {
  const c = msg && msg.message && msg.message.content;
  if (typeof c === "string") return [{ type: "text", text: c }];
  return Array.isArray(c) ? c : [];
};

/** A message the user typed (not a tool result, command wrapper or injected reminder). */
function userText(entry) {
  if (!entry || entry.type !== "user" || entry.isMeta || entry.isSidechain) return "";
  const text = blocks(entry)
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join(" ")
    .trim();
  if (!text || text.startsWith("<") || text.startsWith("Caveat:")) return "";
  return text;
}

function assistantText(entry) {
  if (!entry || entry.type !== "assistant" || entry.isSidechain) return "";
  return blocks(entry)
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join(" ")
    .trim();
}

function todoDoing(todos) {
  if (!Array.isArray(todos) || !todos.length) return "";
  const now = todos.find((t) => t && t.status === "in_progress");
  if (!now) return "";
  const done = todos.filter((t) => t && t.status === "completed").length;
  return `${clip(now.activeForm || now.content || "", MAX_LINE - 10)} (${done}/${todos.length})`;
}

const baseName = (p) => String(p || "").split(/[\\/]+/).filter(Boolean).pop() || "";

function hostOf(url) {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return "";
  }
}

// What a tool without its own description is doing, in a few plain words (FOLLOWUPS item 33c).
const TOOL_STEPS = {
  Read: (i) => (i.file_path ? `Reading ${baseName(i.file_path)}` : "Reading a file"),
  Edit: (i) => (i.file_path ? `Editing ${baseName(i.file_path)}` : "Editing a file"),
  MultiEdit: (i) => (i.file_path ? `Editing ${baseName(i.file_path)}` : "Editing a file"),
  Write: (i) => (i.file_path ? `Writing ${baseName(i.file_path)}` : "Writing a file"),
  NotebookEdit: (i) => (i.notebook_path ? `Editing ${baseName(i.notebook_path)}` : "Editing a notebook"),
  Grep: (i) => (i.pattern ? `Searching the code for ${i.pattern}` : "Searching the code"),
  Glob: (i) => (i.pattern ? `Looking for files ${i.pattern}` : "Looking for files"),
  WebFetch: (i) => (hostOf(i.url) ? `Reading ${hostOf(i.url)}` : "Reading a web page"),
  WebSearch: (i) => (i.query ? `Searching the web for ${i.query}` : "Searching the web"),
  Skill: (i) => (i.skill ? `Using the ${i.skill} skill` : "Using a skill"),
};

/** The current step for one tool_use block; "" for bookkeeping tools (todos, tasks). */
function toolStep(b) {
  const name = String(b.name || "");
  const input = b.input && typeof b.input === "object" ? b.input : {};
  if (/^(TodoWrite|Task(Create|Update|List|Get|Output|Stop))$/.test(name)) return "";
  if (typeof input.description === "string" && input.description.trim()) return input.description;
  if (TOOL_STEPS[name]) return TOOL_STEPS[name](input);
  const mcp = name.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) {
    if (/ringback/.test(mcp[1]) && /^call_/.test(mcp[2])) return "On a call with you";
    const server = mcp[1].replace(/^plugin_[^_]+_/, "");
    return `Using ${server} ${mcp[2]}`.replace(/_/g, " ");
  }
  return name ? `Using ${name}` : "";
}

/** Task tools (TaskCreate / TaskUpdate): ids are 1, 2, 3 in creation order. */
function applyTask(tasks, b) {
  const input = b.input || {};
  if (b.name === "TaskCreate") {
    return [...tasks, { id: String(tasks.length + 1), subject: input.subject || "", activeForm: input.activeForm || "", status: "pending" }];
  }
  if (b.name === "TaskUpdate" && input.taskId) {
    return tasks.map((t) => (t.id === String(input.taskId) ? { ...t, ...(input.status ? { status: input.status } : {}) } : t));
  }
  return tasks;
}

function taskDoing(tasks) {
  const live = tasks.filter((t) => t.status !== "deleted");
  const now = live.find((t) => t.status === "in_progress");
  if (!now) return "";
  const done = live.filter((t) => t.status === "completed").length;
  return `${clip(now.activeForm || now.subject, MAX_LINE - 10)} (${done}/${live.length})`;
}

/**
 * Title, summary and doing from parsed transcript entries (oldest first). Claude Code writes one
 * content block per entry, so the step of the latest tool in the current turn holds through the
 * thinking and text entries after it; a new prompt from the user starts a new turn.
 */
function fromEntries(entries) {
  let custom = "";
  let aiTitle = "";
  let summary = "";
  let step = "";
  let todo = "";
  let tasks = [];
  let firstPrompt = "";
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    if (e.type === "custom-title" && e.customTitle) custom = String(e.customTitle);
    else if (e.type === "ai-title" && e.aiTitle) aiTitle = String(e.aiTitle);
    else if (e.type === "summary" && e.summary && !aiTitle) aiTitle = String(e.summary);
    const typed = userText(e);
    if (typed) step = "";
    if (typed && !firstPrompt && !e.isSidechain) firstPrompt = typed;
    if (e.type !== "assistant" || e.isSidechain) continue;
    const said = assistantText(e);
    if (said) summary = said;
    for (const b of blocks(e)) {
      if (!b || b.type !== "tool_use") continue;
      if (b.name === "TodoWrite" && b.input) todo = todoDoing(b.input.todos);
      tasks = applyTask(tasks, b);
      step = toolStep(b) || step;
    }
  }
  const title = clip(custom || aiTitle, MAX_TITLE);
  const doing = taskDoing(tasks) || todo || step;
  // The last fallback before the folder: their first prompt, trimmed (plain text, no model call).
  const promptTitle = firstPrompt ? clip(firstSentence(firstPrompt, MAX_TITLE), MAX_TITLE) : "";
  return { title, promptTitle, summary: summary ? firstSentence(summary) : "", doing: clip(doing, MAX_LINE) };
}

/** The same from a transcript's text. */
function summarize(text) {
  return fromEntries(parseLines(text));
}

/** Reads the head (first user message) and tail (latest state) of a transcript file. */
function readTranscript(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= HEAD_BYTES + TAIL_BYTES) {
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, 0);
      return buf.toString("utf8");
    }
    const head = Buffer.alloc(HEAD_BYTES);
    fs.readSync(fd, head, 0, HEAD_BYTES, 0);
    const tail = Buffer.alloc(TAIL_BYTES);
    fs.readSync(fd, tail, 0, TAIL_BYTES, size - TAIL_BYTES);
    return `${head.toString("utf8")}\n${tail.toString("utf8")}`;
  } finally {
    fs.closeSync(fd);
  }
}

/** Progress of the session whose transcript is `file`; null when it cannot be read. */
function progressOf(file) {
  if (!file || typeof file !== "string") return null;
  try {
    return summarize(readTranscript(file));
  } catch {
    return null;
  }
}

/** The last thing the assistant wrote in transcript `file` ("" when unknown). */
function lastAssistantText(file) {
  if (!file || typeof file !== "string") return "";
  try {
    let last = "";
    for (const e of parseLines(readTranscript(file))) {
      const t = assistantText(e);
      if (t) last = t;
    }
    return last;
  } catch {
    return "";
  }
}

module.exports = { MAX_LINE, MAX_TITLE, clip, firstSentence, summarize, fromEntries, progressOf, toolStep, lastAssistantText };
