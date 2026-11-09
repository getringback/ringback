"use strict";
// The permission mode a session runs with. Recorded for sessions the phone starts (FOLLOWUPS item
// 50h: their usual mode). Item 47's hidden answer runs that inherited it are gone (item 57).
//
// Where it comes from, most trusted first:
//  - Claude Code: `permission_mode` in the hook input. Verified 2026-11-08 on Claude Code 2.1.319:
//    UserPromptSubmit and Stop carry it, SessionStart does not (keys: session_id, transcript_path,
//    cwd, hook_event_name, source). The docs list "default", "plan", "acceptEdits", "auto",
//    "dontAsk", "bypassPermissions" (the Manual mode arrives as "default").
//    Then the flags of the claude process (--dangerously-skip-permissions, --permission-mode), read
//    at SessionStart, then the transcript's last `permissionMode` (sessions from before 0.7.2).
//    Nothing known: no flag at all, so Claude Code applies the settings' defaultMode itself.
//  - Codex: the rollout's last turn_context (approval_policy, sandbox_policy.type), else the codex
//    flags (--sandbox, --ask-for-approval, --full-auto, --dangerously-bypass-approvals-and-sandbox,
//    -c sandbox_mode / approval_policy). Nothing known: config.toml applies.
//  - Antigravity (agy): its flags (--dangerously-skip-permissions, --mode, --sandbox) and the
//    permissions.allow of its own settings.json.

const fs = require("fs");

const CLAUDE_MODES = Object.freeze(["default", "plan", "acceptEdits", "auto", "dontAsk", "bypassPermissions"]);
const CODEX_SANDBOX = Object.freeze(["read-only", "workspace-write", "danger-full-access"]);
const CODEX_APPROVAL = Object.freeze(["untrusted", "on-failure", "on-request", "never"]);
const AGY_MODES = Object.freeze(["accept-edits", "auto", "plan"]);
const TAIL_BYTES = 4 * 1024 * 1024;

/** A Claude Code mode name, or null. The CLI calls the default mode "manual". */
function claudeMode(value) {
  const v = String(value || "").trim();
  if (v === "manual") return "default";
  return CLAUDE_MODES.includes(v) ? v : null;
}

const pick = (value, allowed) => {
  const v = String(value || "").trim().replace(/^["']|["']$/g, "");
  return allowed.includes(v) ? v : null;
};

/** Argv-like tokens of one command line (double or single quotes group). */
function tokens(line) {
  return (String(line || "").match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.replace(/^["']|["']$/g, ""));
}

/** The value of `--flag v` or `--flag=v` in tokens, for any of `names`. */
function flagValue(toks, names) {
  for (let i = 0; i < toks.length; i += 1) {
    for (const n of names) {
      if (toks[i] === n && i + 1 < toks.length) return toks[i + 1];
      if (toks[i].startsWith(`${n}=`)) return toks[i].slice(n.length + 1);
    }
  }
  return null;
}

/** `-c key=value` overrides in tokens (Codex). */
function codexOverride(toks, key) {
  for (let i = 0; i < toks.length - 1; i += 1) {
    if ((toks[i] === "-c" || toks[i] === "--config") && toks[i + 1].startsWith(`${key}=`)) return toks[i + 1].slice(key.length + 1);
  }
  return null;
}

const EXE = Object.freeze({
  "claude-code": /(^|[\\/\s"])claude(\.exe)?("|\s|$)/i,
  codex: /(^|[\\/\s"])codex(\.exe|\.js|\.cmd)?("|\s|$)/i,
  agy: /(^|[\\/\s"])agy(\.exe)?("|\s|$)/i,
});

/** The nearest ancestor command line that is the client's own process, or "". */
function clientLine(client, lines) {
  const re = EXE[client] || EXE["claude-code"];
  // The Desktop app's Electron processes are named claude.exe too; they never carry these flags.
  return (lines || []).find((l) => re.test(l) && !/\s--type=/.test(l)) || "";
}

/** Permission facts from the client's command line ({} when nothing is set there). */
function fromFlags(client, lines) {
  const toks = tokens(clientLine(client, lines));
  if (!toks.length) return {};
  if (client === "codex") {
    if (toks.includes("--dangerously-bypass-approvals-and-sandbox") || toks.includes("--yolo")) return { bypass: true };
    const full = toks.includes("--full-auto");
    const sandbox = pick(flagValue(toks, ["--sandbox", "-s"]) || codexOverride(toks, "sandbox_mode"), CODEX_SANDBOX) || (full ? "workspace-write" : null);
    const approval = pick(flagValue(toks, ["--ask-for-approval", "-a"]) || codexOverride(toks, "approval_policy"), CODEX_APPROVAL) || (full ? "on-request" : null);
    return { ...(sandbox ? { sandbox } : {}), ...(approval ? { approval } : {}) };
  }
  if (client === "agy") {
    const mode = pick(flagValue(toks, ["--mode"]), AGY_MODES);
    return {
      ...(toks.includes("--dangerously-skip-permissions") ? { skip: true } : {}),
      ...(mode ? { mode } : {}),
      ...(toks.includes("--sandbox") ? { sandbox: true } : {}),
    };
  }
  if (toks.includes("--dangerously-skip-permissions")) return { mode: "bypassPermissions" };
  const mode = claudeMode(flagValue(toks, ["--permission-mode"]));
  return mode ? { mode } : {};
}

/** The mode a Claude Code hook input reports, or null. */
const fromHookInput = (input) => claudeMode(input && input.permission_mode);

/** The last `limit` bytes of a file as text ("" when unreadable). */
function tail(file, limit = TAIL_BYTES) {
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, "r");
    try {
      const len = Math.min(size, limit);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

/**
 * The last permissionMode the session's own window used, from its transcript. Lines of helper runs
 * (entrypoint sdk-cli) count only when there is nothing else.
 */
function fromClaudeTranscript(file) {
  if (!file) return null;
  let own = null;
  let any = null;
  for (const line of tail(file).split(/\r?\n/)) {
    const m = line.match(/"permissionMode":"([A-Za-z]+)"/);
    if (!m) continue;
    const mode = claudeMode(m[1]);
    if (!mode) continue;
    any = mode;
    if (!/"entrypoint":"sdk-cli"/.test(line)) own = mode;
  }
  return own || any;
}

/** Codex sandbox and approval from the rollout's last turn context ({} when none). */
function fromCodexRollout(file) {
  if (!file) return {};
  let out = {};
  for (const line of tail(file).split(/\r?\n/)) {
    if (!line.includes("turn_context")) continue;
    const approval = pick((line.match(/"approval_policy":"([a-z-]+)"/) || [])[1], CODEX_APPROVAL);
    const sandbox = pick((line.match(/"sandbox_policy":\{"type":"([a-z-]+)"/) || [])[1], CODEX_SANDBOX);
    if (approval || sandbox) out = { ...(sandbox ? { sandbox } : {}), ...(approval ? { approval } : {}) };
  }
  return out;
}

/** `rec` with these permission facts recorded (a hook report always wins over flags). */
function withPermissions(rec, facts, source, now = Date.now()) {
  if (!facts || !Object.keys(facts).length) return rec;
  const old = rec.permissions || {};
  if (old.source === "hook" && source !== "hook") return rec;
  const same = old.source === source && JSON.stringify({ ...old, source: undefined, at: undefined }) === JSON.stringify({ ...facts, source: undefined, at: undefined });
  if (same) return rec;
  return { ...rec, permissions: { ...facts, source, at: now } };
}

const USUAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const USUAL_SAMPLE = 10;

/** The most frequent value among recent rows (newest first); a tie goes to the newest. */
function mostUsed(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null;
  for (const v of values) if (best === null || counts.get(v) > counts.get(best)) best = v;
  return best;
}

/**
 * The permission mode the user starts their Claude Code sessions with (FOLLOWUPS item 50h), from the
 * recorded session records: their start flags (start_mode, "" for no flag, so the settings'
 * defaultMode applied), else the modes their hooks reported (item 47). Recent sessions only, newest
 * first. Returns a mode name, "" (start without a flag) or null when nothing is known.
 */
function usualStartMode(records, now = Date.now()) {
  const recent = (records || [])
    .filter((r) => r && !r.client && now - Number(r.last_hook_at || 0) < USUAL_WINDOW_MS)
    .sort((a, b) => Number(b.last_hook_at || 0) - Number(a.last_hook_at || 0));
  const flags = recent.filter((r) => typeof r.start_mode === "string" && (r.start_mode === "" || claudeMode(r.start_mode))).slice(0, USUAL_SAMPLE);
  if (flags.length) return mostUsed(flags.map((r) => claudeMode(r.start_mode) || ""));
  const seen = recent.map((r) => claudeMode(r.permissions && r.permissions.mode)).filter(Boolean).slice(0, USUAL_SAMPLE);
  return seen.length ? mostUsed(seen) : null;
}

/** Claude Code flags for a permission mode (a phone-started session, item 50h). */
function claudeArgs(perms) {
  const mode = claudeMode(perms && perms.mode);
  if (!mode) return [];
  return mode === "bypassPermissions" ? ["--dangerously-skip-permissions"] : ["--permission-mode", mode];
}

module.exports = {
  CLAUDE_MODES,
  CODEX_SANDBOX,
  CODEX_APPROVAL,
  AGY_MODES,
  claudeMode,
  tokens,
  clientLine,
  fromFlags,
  fromHookInput,
  fromClaudeTranscript,
  fromCodexRollout,
  withPermissions,
  claudeArgs,
  usualStartMode,
};
