"use strict";
// The human check of a code join (audit C2 part 3): before the phone's answer is accepted, the
// person at this computer must confirm the 6-digit match code that their own phone shows.
// - In a terminal: the code is printed and they type "yes" (they compare it with the phone).
// - Run by an agent (no terminal): the code is NOT printed (the agent must not be able to copy
//   it). The person reads the digits off their phone, the agent runs `--confirm <digits>`, which
//   writes ~/.ringback/state/join-confirm.json, and the join compares them with its own.
// A fake "phone" (an attacker's server) cannot make the owner's real phone show anything, so the
// digits never match and nothing is saved.

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { configDir } = require("./config.js");

const POLL_MS = 1000;

const file = () => path.join(configDir(), "state", "join-confirm.json");
const digitsOf = (v) => String(v || "").replace(/\D/g, "");

/** `--confirm <digits>`: what the agent runs with the digits the person read off the phone. */
function writeConfirm(raw, now = Date.now()) {
  const digits = digitsOf(raw);
  if (digits.length !== 6) return false;
  fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ digits, at: now }), { mode: 0o600 });
  fs.renameSync(tmp, file());
  return true;
}

function clearConfirm() {
  try {
    fs.rmSync(file(), { force: true });
  } catch {
    // Nothing to clear.
  }
}

function readConfirm(since) {
  try {
    const v = JSON.parse(fs.readFileSync(file(), "utf8"));
    return v && Number(v.at) >= since && /^\d{6}$/.test(String(v.digits)) ? String(v.digits) : "";
  } catch {
    return "";
  }
}

/** Terminal: show the code, wait for "yes". */
function askYes(display, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output });
    rl.question(`Your phone must show the code ${display} right now. If it does, type yes to continue: `, (answer) => {
      rl.close();
      resolve(String(answer || "").trim().toLowerCase() === "yes");
    });
    rl.on("close", () => resolve(false));
  });
}

/** No terminal: wait for `--confirm <digits>` until `deadline`; "" when none came. */
async function waitDigits(since, deadline, sleep, now = Date.now) {
  for (;;) {
    const d = readConfirm(since);
    if (d) return d;
    if (now() > deadline) return "";
    await sleep(POLL_MS);
  }
}

/**
 * Confirms `match` (6 digits) with the person. Returns "ok", "no" (they said no, or the digits
 * differ) or "none" (nobody confirmed in time). `out(line)` prints; `tty` picks the terminal way.
 */
async function confirmMatch(match, { tty, out, sleep, deadline, now = Date.now, confirmCmd, display }) {
  if (tty) return (await askYes(display)) ? "ok" : "no";
  const since = now();
  clearConfirm();
  out(`Your phone now shows a 6-digit code for this join. Ask the user to read it to you from their phone (never guess it), then run: ${confirmCmd} <the 6 digits>`);
  const got = await waitDigits(since, deadline, sleep, now);
  clearConfirm();
  if (!got) return "none";
  return got === String(match) ? "ok" : "no";
}

module.exports = { writeConfirm, clearConfirm, readConfirm, confirmMatch, waitDigits, file, digitsOf };
