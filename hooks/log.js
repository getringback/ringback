"use strict";
// Shared by hook processes and the helper. No plugin dependencies: safe during an update.
const fs = require("fs");
const path = require("path");
const os = require("os");
const SUMMARY_MS = 10 * 60 * 1000;
const MAX_BYTES = 1024 * 1024;
const home = () => process.env.RINGBACK_HOME || path.join(os.homedir(), ".ringback");

function append(file, text, now) {
  try {
    if (fs.statSync(file).size >= MAX_BYTES) {
      for (let n = 3; n >= 1; n -= 1) {
        try {
          fs.renameSync(n === 1 ? file : `${file}.${n - 1}`, `${file}.${n}`);
        } catch {
          // Another process may have rotated, or a generation does not exist yet.
        }
      }
    }
  } catch {
    // No log yet.
  }
  fs.appendFileSync(file, `${new Date(now).toISOString()} ${text}\n`);
}

function withOutage(file, fn) {
  const lock = `${file}.lock`;
  try {
    fs.mkdirSync(home(), { recursive: true });
    const until = Date.now() + 250;
    for (;;) {
      try {
        fs.mkdirSync(lock);
        break;
      } catch (err) {
        if (err.code !== "EEXIST" || Date.now() >= until) return;
        try { if (Date.now() - fs.statSync(lock).mtimeMs >= 5000) fs.rmdirSync(lock); } catch { /* Released meanwhile. */ }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      }
    }
    try {
      const state = `${file}.outage`;
      let old = null;
      try { old = JSON.parse(fs.readFileSync(state, "utf8")); } catch { /* No outage. */ }
      fn(old, state);
    } finally {
      fs.rmdirSync(lock);
    }
  } catch {
    // Logging never stops a hook or the helper.
  }
}

const summary = (old, now) => `phone unreachable for ${Math.max(0, Math.round((now - old.since) / 1000))} s, ${old.attempts} attempts`;

function write(name, line, now = Date.now()) {
  const file = path.join(home(), name);
  if (!/Cannot reach\b/i.test(String(line))) {
    try { fs.mkdirSync(home(), { recursive: true }); append(file, line, now); } catch { /* Best effort. */ }
    return;
  }
  withOutage(file, (old, state) => {
    const next = old || { since: now, last: now, attempts: 0 };
    next.attempts += 1;
    if (!old) append(file, line, now);
    else if (now - next.last >= SUMMARY_MS) {
      append(file, summary(next, now), now);
      next.last = now;
    }
    fs.writeFileSync(state, JSON.stringify(next));
  });
}

function recovered(now = Date.now()) {
  for (const name of ["hooks.log", "helper.log"]) {
    const file = path.join(home(), name);
    if (!fs.existsSync(`${file}.outage`)) continue;
    withOutage(file, (old, state) => {
      if (!old) return;
      append(file, `phone reachable again after ${Math.max(0, Math.round((now - old.since) / 1000))} s, ${old.attempts} attempts`, now);
      fs.unlinkSync(state);
    });
  }
}

module.exports = { write, recovered, SUMMARY_MS };
