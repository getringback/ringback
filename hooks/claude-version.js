"use strict";
const fs = require("fs");
const path = require("path");

// Read only the running executable's location. Never probe PATH or start another Claude.
function runningVersion(env = process.env, platform = process.platform) {
  try {
    let exe = env.CLAUDE_CODE_EXECPATH;
    if (platform === "linux") exe = fs.readlinkSync(`/proc/${Number(env.CLAUDE_PID) || process.ppid}/exe`);
    if (!exe || !path.isAbsolute(exe)) return "";
    // A stable symlink or npm package can have been updated since this session started.
    const pattern = /[\\/]claude[\\/]versions[\\/](\d+\.\d+\.\d+)(?:\.exe)?$/;
    const named = pattern.exec(exe);
    const real = named && pattern.exec(fs.realpathSync(exe));
    return real && real[1] === named[1] ? real[1] : "";
  } catch {
    return "";
  }
}

function quietStop(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version || ""));
  if (!m) return false;
  const [major, minor, patch] = m.slice(1).map(Number);
  return major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 322)));
}

module.exports = { runningVersion, quietStop };
