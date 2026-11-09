"use strict";
// Codex rollout JSONL -> live view lines (FOLLOWUPS item 58). The rollout is the hook's
// transcript_path (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl). Only `event_msg` entries are
// read: they are what the Codex UI itself shows. `response_item` entries repeat the same turns
// with the injected AGENTS.md and environment text, so they are skipped to avoid doubles.
// Current Codex (0.16x) writes `item_completed` items; older builds wrote user_message,
// agent_message, exec_command_end and patch_apply_begin. Both are understood; once an item is
// seen the old event names are ignored, in case a build writes both.

const { line, toolLine, resultLine, shortPath, unifiedDiff, oneLine } = require("./view-format.js");

const NOISE = /^\s*(<environment_context|<user_instructions|<turn_aborted|# AGENTS\.md instructions)/;

const textOf = (content) =>
  (Array.isArray(content) ? content : [])
    .map((c) => (c && typeof c.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();

/** The command line a CommandExecution or exec event ran, without the shell wrapper. */
function commandOf(item) {
  const parsed = Array.isArray(item.parsed_cmd) && item.parsed_cmd[0] && item.parsed_cmd[0].cmd;
  if (typeof parsed === "string" && parsed) return parsed;
  const cmd = item.command;
  if (Array.isArray(cmd) && cmd.length) {
    const i = cmd.findIndex((a) => /^(-c|-Command|\/c|-lc)$/i.test(String(a)));
    return String(i >= 0 && cmd[i + 1] !== undefined ? cmd[i + 1] : cmd.join(" "));
  }
  return typeof cmd === "string" ? cmd : "";
}

function commandLines(item, t) {
  const out = [toolLine("Shell", commandOf(item), t)];
  const code = Number.isInteger(item.exit_code) ? item.exit_code : null;
  const text = item.aggregated_output || item.formatted_output || item.stdout || item.stderr || "";
  if (code === null && !text) return out;
  out.push(resultLine(text, t, { error: code !== null && code !== 0 }));
  return out;
}

/** One "● Edit(file)" line per changed file, each with its small diff. */
function changeLines(changes, t) {
  if (!changes || typeof changes !== "object") return [];
  return Object.entries(changes).map(([file, ch]) => {
    const c = ch && typeof ch === "object" ? ch : {};
    const kind = c.type || Object.keys(c)[0] || "update";
    if (kind === "add") {
      const content = typeof c.content === "string" ? c.content : (c.add && c.add.content) || "";
      return toolLine("Write", shortPath(file), t, `    + ${String(content).split("\n").length} lines written`, [file]);
    }
    if (kind === "delete") return toolLine("Delete", shortPath(file), t);
    const diff = c.unified_diff || (c.update && c.update.unified_diff) || "";
    return toolLine("Edit", shortPath(file), t, unifiedDiff(diff), [file]);
  });
}

function itemLines(item, t) {
  switch (item.type) {
    case "UserMessage": {
      const text = textOf(item.content);
      return text && !NOISE.test(text) ? [line("user", `> ${text}`, t)] : [];
    }
    case "AgentMessage": {
      const text = textOf(item.content);
      return text ? [line("assistant", text, t)] : [];
    }
    case "CommandExecution":
      return commandLines(item, t);
    case "FileChange": {
      const out = changeLines(item.changes, t);
      if (item.status && item.status !== "completed") out.push(resultLine(item.stderr || item.status, t, { error: true }));
      return out;
    }
    case "McpToolCall": {
      const out = [toolLine(`${item.server || "mcp"}.${item.tool || "tool"}`, (item.arguments && item.arguments.title) || oneLine(JSON.stringify(item.arguments || {})), t)];
      const r = item.result || {};
      if (r.isError || item.status === "failed") out.push(resultLine(textOf(r.content) || "failed", t, { error: true }));
      return out;
    }
    case "Extension":
      return item.kind === "web.search" ? [toolLine("Search", item.query || "", t)] : [];
    case "ImageView": {
      const file = String(item.path || "").replace(/^file:\/\/\//, "");
      return [toolLine("View image", shortPath(file), t, "", file ? [file] : [])];
    }
    case "ContextCompaction":
      return [line("system", "Conversation compacted", t)];
    default:
      return [];
  }
}

function legacyLines(p, t) {
  switch (p.type) {
    case "user_message":
      return typeof p.message === "string" && p.message.trim() && !NOISE.test(p.message) ? [line("user", `> ${p.message.trim()}`, t)] : [];
    case "agent_message":
      return typeof p.message === "string" && p.message.trim() ? [line("assistant", p.message.trim(), t)] : [];
    case "exec_command_end":
      return commandLines(p, t);
    case "patch_apply_begin":
      return changeLines(p.changes, t);
    default:
      return [];
  }
}

/** A stateful Codex rollout mapper: (entry) => lines. */
function createCodexMapper() {
  let sawItems = false;
  return (e) => {
    if (!e || typeof e !== "object" || e.type !== "event_msg" || !e.payload || typeof e.payload !== "object") return [];
    const t = Date.parse(e.timestamp) || Date.now();
    const p = e.payload;
    if (p.type === "item_completed") {
      sawItems = true;
      return p.item && typeof p.item === "object" ? itemLines(p.item, t) : [];
    }
    if (p.type === "turn_aborted") return [line("system", "Turn stopped", t)];
    return sawItems ? [] : legacyLines(p, t);
  };
}

module.exports = { createCodexMapper, commandOf };
