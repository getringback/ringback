"use strict";
// Shared text shapes of the per-session live view (FOLLOWUPS item 58): one terminal line per
// prompt, reply, tool call and result, kept short enough to read on a phone. Every text is
// redacted here, so no caller can forget it.

const { redact } = require("./redact.js");
const { extractPaths, chips } = require("./view-media.js");

const MAX_TEXT = 4000;
const RESULT_LINES = 8;
const DIFF_LINES = 10;
const ARG_CHARS = 160;
const PATH_CHARS = 70;

const clip = (t, max = MAX_TEXT) => (t.length > max ? `${t.slice(0, max - 3)}...` : t);
/**
 * One view line. `paths` (file chips, FOLLOWUPS item 58) are the paths printed in the text
 * plus `extra` (a tool's full file path, shown shortened in the text); a path the redactor
 * would change is never offered. Tool lines carry only their own file (not every path in a command). Assistant text is Markdown (`md: true`).
 */
function line(kind, text, t, extra = []) {
  const shown = clip(redact(String(text)));
  const found = [...extra.filter((p) => typeof p === "string" && p && redact(p) === p), ...(kind === "tool" ? [] : extractPaths(shown))];
  const paths = [...new Set(found)].slice(0, 12);
  return { kind, text: shown, t, ...(kind === "assistant" ? { md: true } : {}), ...(paths.length ? { paths: chips(paths) } : {}) };
}
const oneLine = (s, max = ARG_CHARS) => clip(String(s).replace(/\s*[\r\n]+\s*/g, " ").trim(), max);

/** A long path cut to its last folders, so the file name stays visible on a narrow screen. */
function shortPath(p) {
  const s = String(p || "");
  if (s.length <= PATH_CHARS) return s;
  const parts = s.split(/[\\/]+/).filter(Boolean);
  const keep = [];
  let len = 4;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (keep.length && len + parts[i].length + 1 > PATH_CHARS) break;
    keep.unshift(parts[i]);
    len += parts[i].length + 1;
  }
  return `.../${keep.join("/")}`;
}

/** Up to `max` lines of `text`, indented, with a "... N more lines" tail. */
function snippet(text, max = RESULT_LINES) {
  const all = String(text || "").replace(/\r/g, "").split("\n");
  while (all.length && !all[all.length - 1].trim()) all.pop();
  while (all.length && !all[0].trim()) all.shift();
  const shown = all.slice(0, max).join("\n    ");
  const more = all.length > max ? `\n    ... ${all.length - max} more lines` : "";
  return { shown, more, count: all.length };
}

/** "- old" / "+ new" lines of a replacement, at most DIFF_LINES in all. */
function replaceDiff(oldText, newText) {
  const minus = String(oldText || "").replace(/\r/g, "").split("\n").map((l) => `- ${l}`);
  const plus = String(newText || "").replace(/\r/g, "").split("\n").map((l) => `+ ${l}`);
  return capDiff([...(oldText ? minus : []), ...(newText ? plus : [])]);
}

/** The +/- lines of a unified diff (hunk headers dropped), at most DIFF_LINES. */
function unifiedDiff(diff) {
  const rows = String(diff || "")
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---"))
    .map((l) => `${l[0]} ${l.slice(1)}`);
  return capDiff(rows);
}

function capDiff(rows) {
  if (!rows.length) return "";
  const shown = rows.slice(0, DIFF_LINES).map((r) => `    ${clip(r, 200)}`);
  const more = rows.length > DIFF_LINES ? [`    ... ${rows.length - DIFF_LINES} more changed lines`] : [];
  return [...shown, ...more].join("\n");
}

/** "● Name(arg)" plus an optional diff block under it. */
function toolLine(name, arg, t, diff = "", paths = []) {
  const head = `● ${name}(${oneLine(arg)})`;
  return line("tool", diff ? `${head}\n${diff}` : head, t, paths);
}

/** "  ⎿ ..." for a tool result: errors say so, long output is cut to a few lines. */
function resultLine(text, t, { error = false, max = RESULT_LINES } = {}) {
  const { shown, more } = snippet(text, max);
  const body = shown || (error ? "failed" : "(no output)");
  return line("result", `  ⎿ ${error ? "Error: " : ""}${body}${more}`, t);
}

module.exports = { line, clip, oneLine, shortPath, snippet, replaceDiff, unifiedDiff, toolLine, resultLine, MAX_TEXT, RESULT_LINES, DIFF_LINES };
