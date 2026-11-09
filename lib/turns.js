"use strict";
// FOLLOWUPS item 29: calling must not depend on the agent remembering to. Each session's current
// turn is tracked in ~/.ringback/state/turns/<id>.json (when the prompt came, whether the session
// used a call tool since). When a long turn (default 5 min) ends without a call, the Stop hook
// asks the session, once, to call the user with what is done. Only for a task that is finished: not
// mid-conversation, not when it ends asking a question in the terminal, never in headless runs.

const fs = require("fs");
const path = require("path");
const { configDir } = require("./config.js");

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_MIN = 5;
const CALL_TOOL = /ringback.*__(call_user|call_say|call_listen)$/;

const NUDGE =
  "You finished a task that took a while. Call the user with call_user: say in one or two short sentences what is done, " +
  "put the result on their phone with show_on_phone (a short summary, and image_path for a screenshot if there is one). " +
  "If the result can be seen on a screen, open it and share it live on the call with show_my_screen, walk them through it, " +
  "then stop_my_screen (with anyone else on the call, ask them first). Then ask for next steps. If the task is not finished or you still need their answer in the terminal, end your turn instead.";

const file = (id) => path.join(configDir(), "state", "turns", `${id}.json`);

function read(id) {
  try {
    return JSON.parse(fs.readFileSync(file(id), "utf8"));
  } catch {
    return null;
  }
}

function write(id, rec) {
  fs.mkdirSync(path.dirname(file(id)), { recursive: true });
  const tmp = `${file(id)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec));
  fs.renameSync(tmp, file(id));
}

/** UserPromptSubmit: a new task starts now. */
function onPrompt(id, now = Date.now()) {
  if (!SESSION_ID.test(String(id || ""))) return;
  write(id, { started_at: now, called: false, nudged: false });
}

/** PostToolUse: remember when the session used a call tool this turn. One file read otherwise. */
function onTool(id, input) {
  if (!SESSION_ID.test(String(id || "")) || !CALL_TOOL.test(String((input && input.tool_name) || ""))) return;
  const rec = read(id);
  if (rec && !rec.called) write(id, { ...rec, called: true });
}

/**
 * Stop without a nudge: this turn is over. A later wake-up by a call (no UserPromptSubmit) must
 * not count the hours in between as one long task.
 */
function onStop(id) {
  if (!SESSION_ID.test(String(id || ""))) return;
  const rec = read(id);
  if (rec && !rec.ended) write(id, { ...rec, ended: true, stopped_at: Date.now() });
}

const WAITING =
  "[Ringback] Your last turn ended several minutes ago and the user has not replied. This is an automatic check, not a message from them. " +
  "If you are blocked on something only they can do or decide, phone them now with call_user and say what you need in one or two short sentences; " +
  "if they decline, leave one show_on_phone card and do not ring again. If you need nothing from them, end your turn without calling and without a message.";

/**
 * The wake-up for a turn that ended and got no reply within `waiting_call_min` minutes (default 5),
 * once per turn, or null. A turn can end still needing the user, and the Stop hook cannot tell.
 */
function waitingNudge(id, { now = Date.now(), cfg = {}, busy = false } = {}) {
  if (!SESSION_ID.test(String(id || "")) || busy || cfg.call_when_done === false) return null;
  const rec = read(id);
  if (!rec || !rec.ended || !rec.stopped_at || rec.waiting_nudged) return null;
  const min = Number(cfg.waiting_call_min) > 0 ? Number(cfg.waiting_call_min) : DEFAULT_MIN;
  if (now - rec.stopped_at < min * 60 * 1000) return null;
  write(id, { ...rec, waiting_nudged: true });
  return WAITING;
}

/** Interactive Claude Code only: a block in a `claude -p` or helper run would only lengthen it. */
function interactive(env) {
  return env.CLAUDE_CODE_ENTRYPOINT === "cli" && !env.RINGBACK_HELPER_RUN;
}

/** The session ended asking something it waits on in the terminal: not done, no call. */
const asksQuestion = (text) => /\?\s*["')\]]*\s*$/.test(String(text || "").trim());

/**
 * The Stop reason that asks the session to call, or null. At most once per turn; off with
 * config `call_when_done: false`; threshold `call_when_done_min` (minutes, default 5).
 */
function nudge(id, { now = Date.now(), cfg = {}, input = {}, env = process.env, lastText = null } = {}) {
  if (!SESSION_ID.test(String(id || ""))) return null;
  if (cfg.call_when_done === false || input.stop_hook_active || !interactive(env)) return null;
  const rec = read(id);
  if (!rec || rec.called || rec.nudged || rec.ended || !rec.started_at) return null;
  const min = Number(cfg.call_when_done_min) > 0 ? Number(cfg.call_when_done_min) : DEFAULT_MIN;
  if (now - rec.started_at < min * 60 * 1000) return null;
  // Read only now: the transcript tail is opened only for a turn long enough to matter.
  const last = input.last_assistant_message != null ? input.last_assistant_message : typeof lastText === "function" ? lastText() : lastText;
  if (asksQuestion(last)) return null;
  write(id, { ...rec, nudged: true });
  return NUDGE;
}

module.exports = { read, onPrompt, onTool, onStop, nudge, waitingNudge, NUDGE, WAITING, DEFAULT_MIN };
