#!/usr/bin/env node
"use strict";
// Set up Ringback remote guests (FOLLOWUPS 51 SETUP CONTRACT). Run it yourself in a terminal:
//   node "<plugin>/bin/guests-setup.js"
// It needs a real terminal: the Tailscale secret is typed at a hidden prompt and the policy change
// needs your typed yes, so no agent can run or answer it. See lib/guests-setup.js for the steps.

const readline = require("readline");
const { loadConfig, isConfigured } = require("../lib/config.js");
const { api } = require("../lib/client.js");
const { createTailscale } = require("../lib/tailscale-api.js");
const { runSetup, SAY } = require("../lib/guests-setup.js");

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** A prompt that echoes nothing (raw mode); Ctrl+C cancels. */
function askSecret(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const input = process.stdin;
    let value = "";
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          input.setRawMode(false);
          input.pause();
          input.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          input.setRawMode(false);
          process.stdout.write("\n");
          process.exit(1);
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    input.on("data", onData);
  });
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write("Run this yourself in a terminal window: it asks for a secret and for your yes.\n");
    return 2;
  }
  const cfg = loadConfig();
  if (!isConfigured(cfg)) {
    process.stdout.write(`${SAY.notJoined}\n`);
    return 1;
  }
  const res = await runSetup({
    phone: { get: () => api.guestsSetup(cfg), save: (body) => api.saveGuestsSetup(cfg, body) },
    tailscale: (clientId, clientSecret) => createTailscale({ clientId, clientSecret }),
    ask,
    askSecret,
    out: (text) => process.stdout.write(`${text}\n`),
  });
  process.stdout.write(`${res.say}\n`);
  return res.status === "done" || res.status === "already" || res.status === "saved" ? 0 : 1;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      // Never the secret: only the message of what failed.
      process.stdout.write(`Setup failed: ${err && err.message ? err.message : err}\n`);
      process.exit(1);
    });
}

module.exports = { main };
