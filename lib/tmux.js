"use strict";
// Raw terminal view for sessions running inside tmux (spec 04 section 2.1): the exact pane text,
// read once a second while a viewer has the Raw tab open, sent only when it changed.

const { execFile } = require("child_process");

const PANE = /^%\d{1,6}$/;
const MAX_RAW = 256 * 1024;
const MAX_TEXT = 2000;
// The only keys the phone may press in a pane. Typed text never reaches tmux as a key name.
const KEYS = Object.freeze({
  Enter: "Enter", Backspace: "BSpace", Escape: "Escape", Tab: "Tab",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Interrupt: "C-c",
});
// A line break inside typed text would run the line: only the Enter key presses Enter.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

const execText = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(String(out)))),
  );

const validPane = (pane) => PANE.test(String(pane || ""));

async function capturePane(pane, exec = execText) {
  if (!validPane(pane)) throw new Error("bad tmux pane id");
  const text = String(await exec("tmux", ["capture-pane", "-p", "-J", "-t", String(pane), "-S", "-300"]));
  return text.length > MAX_RAW ? text.slice(-MAX_RAW) : text;
}

/** Calls `onText(text)` when the pane changed, every `everyMs`. Returns { stop }. */
function poll(pane, onText, { exec = execText, everyMs = 1000, onError = () => {} } = {}) {
  let last = null;
  let stopped = false;
  let timer = null;
  const tick = async () => {
    try {
      const text = await capturePane(pane, exec);
      if (!stopped && text !== last) {
        last = text;
        onText(text);
      }
    } catch (err) {
      onError(err);
    }
    if (!stopped) timer = setTimeout(tick, everyMs);
  };
  tick();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/** A validated typing action from a control message, or null. */
function parseInput(msg) {
  if (!msg || typeof msg !== "object") return null;
  if (msg.kind === "key") return Object.prototype.hasOwnProperty.call(KEYS, msg.key) ? { kind: "key", key: msg.key } : null;
  if (msg.kind !== "text" || typeof msg.text !== "string" || msg.text.length === 0 || msg.text.length > MAX_TEXT) return null;
  return { kind: "text", text: msg.text };
}

/** The tmux arguments that put one parsed action into a pane, or null. */
function sendArgs(pane, action) {
  if (!validPane(pane) || !action) return null;
  if (action.kind === "key") return ["send-keys", "-t", String(pane), KEYS[action.key]];
  const text = action.text.replace(CONTROL_CHARS, " ");
  // tmux ends a command at an argument's trailing semicolon unless a backslash stands before it.
  const safe = text.endsWith(";") ? `${text.slice(0, -1)}\\;` : text;
  return ["send-keys", "-t", String(pane), "-l", "--", safe];
}

/** Types one parsed action into the pane. Resolves false when there was nothing valid to send. */
async function send(pane, action, exec = execText) {
  const args = sendArgs(pane, action);
  if (!args) return false;
  await exec("tmux", args);
  return true;
}

async function available(exec = execText) {
  try {
    await exec("tmux", ["-V"]);
    return true;
  } catch {
    return false;
  }
}

module.exports = { capturePane, poll, available, validPane, parseInput, sendArgs, send, MAX_TEXT };
