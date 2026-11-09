"use strict";
// Raw terminal view for sessions running inside tmux (spec 04 section 2.1): the exact pane text,
// read once a second while a viewer has the Raw tab open, sent only when it changed.

const { execFile } = require("child_process");

const PANE = /^%\d{1,6}$/;
const MAX_RAW = 256 * 1024;

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

async function available(exec = execText) {
  try {
    await exec("tmux", ["-V"]);
    return true;
  } catch {
    return false;
  }
}

module.exports = { capturePane, poll, available, validPane };
