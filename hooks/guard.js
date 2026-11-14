"use strict";
// Loaded before any plugin dependency. This module uses only Node builtins.
const fs = require("fs");
const path = require("path");
const os = require("os");

function emergency(name, err) {
  const line = `${name}: ${err && err.message || err}`;
  try {
    require("./log.js").write("hooks.log", line);
    return;
  } catch {
    // The log module itself may be missing during an incomplete update.
  }
  try {
    const dir = process.env.RINGBACK_HOME || path.join(os.homedir(), ".ringback");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "hooks.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Even an incomplete install or unwritable home must stay quiet.
  }
}

function install(name, budgetMs) {
  const fail = (err) => {
    emergency(name, err);
    process.exit(0);
  };
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);
  globalThis[Symbol.for("ringback.hookDeadline")] = Date.now() + budgetMs;
  setTimeout(() => fail(new Error("hook budget exhausted")), budgetMs).unref();
}

module.exports = { install, emergency };
