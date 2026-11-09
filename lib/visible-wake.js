"use strict";
// Waking an idle Codex or Antigravity (agy) session in its OWN window when the user calls it, the
// way Claude Code's asyncRewake waiter does (hooks/wake-wait.js). Official mechanisms only
// (FOLLOWUPS item 50): no typing into windows, no UI automation.
//
// Codex: `codex queue --thread <id> --message <text>` (documented CLI command, Codex 0.149+).
//   The process that has the thread loaded (the interactive TUI, or the app-server daemon for
//   app sessions) takes the queued message as a new user turn and runs it where it is shown.
//   Codex hooks run as children of that process, so the client hook records it (owner_pid) and
//   the helper queues only while it lives. A thread nobody has loaded keeps the message until
//   its next resume, so a closed session is never queued to.
// agy: hooks have no async form and nothing can start a turn from outside, but a Stop hook may
//   answer {decision:"continue", reason} to re-enter the loop (antigravity.google/docs/hooks). With
//   config agy_visible_wake: true the Stop hook stays running while the session is idle and
//   continues it with their words when they call. Opt-in: while it waits agy shows "Working..."
//   (Esc frees the session until its next turn).
// There is no hidden or forked answer run (FOLLOWUPS item 57): a session none of this reaches is
// reported on the call as "could not be reached on screen", with unreachableReason() in the log.

const fs = require("fs");
const proc = require("./proc.js");
const clients = require("./clients.js");
const { tokens } = require("./permissions.js");

const isCodexName = (name) => /^codex(\.exe)?$/i.test(String(name || "").trim());

/** The nearest Codex process among a hook's ancestors (the process running the session), or 0. */
function codexOwnerPid(ancestors) {
  const hit = (ancestors || []).find((p) => isCodexName(p.name));
  return hit ? Number(hit.pid) || 0 : 0;
}

/** Codex visible wake is on unless config codex_visible_wake is false. */
const codexWakeOn = (cfg = {}) => cfg.codex_visible_wake !== false;

/** agy visible wake (a held Stop hook) is opt-in: config agy_visible_wake true. */
const agyWakeOn = (cfg = {}) => cfg.agy_visible_wake === true;

/**
 * True while the client process recorded for `rec` (owner_pid) still runs and is still that
 * client (a reused pid of another program does not count).
 */
function ownerAlive(rec, deps = {}) {
  const pid = Number(rec && rec.owner_pid) || 0;
  if (!(pid > 0)) return false;
  const name = (deps.processName || proc.processName)(pid);
  return clients.clientOf(rec) === "agy" ? isAgyName(name) : isCodexName(name);
}

/** Whether a call to idle session `rec` should be queued into its own Codex window. */
function canQueue(cfg, rec, deps = {}) {
  if (!rec || rec.ended || clients.clientOf(rec) !== "codex") return false;
  return codexWakeOn(cfg) && ownerAlive(rec, deps);
}

/**
 * The argv that queues `text` into Codex thread `id`. `--message=` keeps text that starts with
 * a dash a value. Never a shell: the text is speech from the phone.
 */
function queueArgv(cfg, id, text, env = process.env, exists = fs.existsSync) {
  return [...clients.codexCommand(cfg, env, exists), "queue", "--thread", String(id), `--message=${text}`];
}

/** The rollout's size in bytes (transcript_path, a documented hook input), or -1 when unknown. */
function transcriptSize(rec, deps = {}) {
  if (!rec || !rec.transcript_path) return -1;
  try {
    return (deps.statSync || fs.statSync)(rec.transcript_path).size;
  } catch {
    return -1;
  }
}

/**
 * True when the session started a turn after the queue: one of its hooks ran at or after `since`,
 * or its rollout grew past `baseSize`. Size, not mtime: Windows keeps the old mtime of a file
 * Codex holds open while appending (measured on Codex 0.165), the size is current.
 */
function turnStarted(rec, since, baseSize = -1, deps = {}) {
  if (!rec) return false;
  if (Number(rec.last_hook_at) >= since) return true;
  if (!(baseSize >= 0)) return false;
  return transcriptSize(rec, deps) > baseSize;
}

/** Why an idle session cannot be woken on screen, for the helper log. */
function unreachableReason(cfg, rec, deps = {}) {
  const client = clients.clientOf(rec);
  if (client === "codex") {
    if (!codexWakeOn(cfg)) return "codex_visible_wake is off in ~/.ringback/config.json";
    if (!(Number(rec && rec.owner_pid) > 0)) return "its Codex process is unknown (its Ringback hooks have not run: trust them with /hooks in Codex)";
    if (!ownerAlive(rec, deps)) return `its Codex window is closed (process ${rec.owner_pid} is gone)`;
    return "Codex could not take the message";
  }
  if (client === "agy") {
    return agyWakeOn(cfg)
      ? "its Stop hook is not waiting (the session is closed, was stopped with Esc, or ran headless)"
      : "agy_visible_wake is off in ~/.ringback/config.json, and agy has no other official way to wake an idle session";
  }
  if (client === "claude-desktop") return "a Claude Desktop chat has no hooks and cannot be woken";
  return "no live wake-wait hook (the session is closed, runs headless, or has not run a hook since the plugin loaded)";
}

const PRINT_FLAG = /(^|\s)(-p|--print|--prompt)(\s|=|$)/;

/**
 * True when an agy hook runs inside a run nobody watches: the helper's own answer run, `agy -p`
 * (print mode) or `agy acp` (an editor drives it). A held Stop hook there would only hang it.
 */
function agyHeadless(env, lines) {
  if (env.RINGBACK_HELPER_RUN === "1") return true;
  // Only a process whose executable is agy counts (the hook's own line says "agy Stop" too).
  const agy = (lines || []).map(agyArgs).filter((rest) => rest !== null);
  if (!agy.length) return true;
  return agy.some((rest) => PRINT_FLAG.test(` ${rest}`) || /^acp(\s|$)/i.test(rest));
}

/** The arguments of a command line whose executable is agy, else null. */
function agyArgs(line) {
  const m = String(line || "").trim().match(/^(?:"([^"]+)"|(\S+))\s*(.*)$/);
  if (!m) return null;
  const exe = (m[1] || m[2]).split(/[\\/]/).pop();
  return /^agy(\.exe)?$/i.test(exe) ? m[3] : null;
}

const isAgyName = (name) => /^agy(\.exe)?$/i.test(String(name || "").trim());
const isChatGptName = (name) => /^chatgpt(\.exe)?$/i.test(String(name || "").trim());

// Codex options that take a value (so their value is never read as the subcommand).
const CODEX_VALUE_OPTS = new Set(["-c", "--config", "-m", "--model", "-p", "--profile", "-s", "--sandbox", "-a", "--ask-for-approval", "-C", "--cd", "-i", "--image", "--enable", "--disable", "--add-dir", "--local-provider", "--remote", "--remote-auth-token-env"]);
const CODEX_HEADLESS = new Set(["exec", "e", "review"]);

/** The first positional word of a command line's arguments (after the executable). */
function codexSubcommand(cmd) {
  const toks = tokens(cmd).slice(1);
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if (CODEX_VALUE_OPTS.has(t)) {
      i += 1;
      continue;
    }
    if (t.startsWith("-")) continue;
    return t;
  }
  return "";
}

/**
 * How a client hook runs, from one walk of its ancestor processes (nearest first, with command
 * lines): { headless, owner }. `owner` is the pid of the client process that runs the session
 * (0 when none was found). Headless runs (agy -p / --print / acp, codex exec / review, any run the
 * helper started) never register on the phone: nobody can see or call them, and they would
 * linger on the list as idle ghosts.
 */
function classify(client, env, ancestors) {
  const list = ancestors || [];
  if (client === "codex") {
    const proc = list.find((p) => isCodexName(p.name));
    const headless = env.RINGBACK_HELPER_RUN === "1" || Boolean(proc && CODEX_HEADLESS.has(codexSubcommand(proc.cmd)));
    // ChatGPT desktop (the merged app, OpenAI.Codex package): its Codex-mode and local Work chats
    // run on a `codex app-server` child of ChatGPT.exe, with the same hooks; `codex queue` reaches
    // that thread while the app-server lives.
    const at = proc ? list.indexOf(proc) : -1;
    const chatgpt = Boolean(proc && codexSubcommand(proc.cmd) === "app-server" && list.slice(at + 1).some((p) => isChatGptName(p.name)));
    return { headless, owner: proc ? Number(proc.pid) || 0 : 0, ...(chatgpt ? { host: "chatgpt" } : {}) };
  }
  if (client === "agy") {
    const proc = list.find((p) => isAgyName(p.name));
    // Only an agy process seen in print or acp mode is headless: a walk that found no agy (it
    // failed, or an unusual launcher) must never hide a real session from the phone.
    const headless = env.RINGBACK_HELPER_RUN === "1" || Boolean(proc && agyHeadless(env, [proc.cmd || ""]));
    return { headless, owner: proc ? Number(proc.pid) || 0 : 0 };
  }
  return { headless: false, owner: 0 };
}

module.exports = {
  isAgyName,
  classify,
  codexSubcommand,
  isCodexName,
  codexOwnerPid,
  codexWakeOn,
  agyWakeOn,
  ownerAlive,
  canQueue,
  queueArgv,
  unreachableReason,
  transcriptSize,
  turnStarted,
  agyHeadless,
};
