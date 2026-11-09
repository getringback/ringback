"use strict";
// Which AI coding tools this computer has and whether each is connected to Ringback, so the phone
// can say so in plain words. File checks only: this runs on a timer, so it never starts a process.

const fs = require("fs");
const os = require("os");
const path = require("path");

const read = (file, f) => {
  try {
    return f.readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

/** True when `name` is an executable on PATH (with Windows' .exe / .cmd endings). */
function onPath(name, { env, platform, fs: f }) {
  const sep = platform === "win32" ? ";" : ":";
  const endings = platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  return String(env.PATH || env.Path || "")
    .split(sep)
    .filter(Boolean)
    .some((dir) => endings.some((end) => f.existsSync(path.join(dir, name + end))));
}

function claudeConnected(home, f) {
  try {
    const plugins = JSON.parse(read(path.join(home, ".claude", "settings.json"), f)).enabledPlugins || {};
    return Object.entries(plugins).some(([k, on]) => k.startsWith("ringback@") && on === true);
  } catch {
    return false;
  }
}

/** A client counts as connected when its hooks file runs Ringback's client hook for it. */
const hooksConnected = (file, client, f) => {
  const text = read(file, f);
  return text.includes("client-hook.js") && text.includes(client);
};

/** [{ id, installed, connected }] for each tool the phone can talk about. */
function detectTools(deps = {}) {
  const ctx = { env: deps.env || process.env, platform: deps.platform || process.platform, fs: deps.fs || fs };
  const home = deps.home || os.homedir();
  const f = ctx.fs;
  const codexHome = ctx.env.CODEX_HOME || path.join(home, ".codex");
  const local = ctx.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  return [
    {
      id: "claude-code",
      installed: onPath("claude", ctx) || f.existsSync(path.join(home, ".local", "bin", ctx.platform === "win32" ? "claude.exe" : "claude")),
      connected: claudeConnected(home, f),
    },
    {
      id: "codex",
      installed: onPath("codex", ctx) || f.existsSync(path.join(codexHome, "config.toml")),
      connected: hooksConnected(path.join(codexHome, "hooks.json"), "codex", f),
    },
    {
      id: "agy",
      installed: onPath("agy", ctx) || (ctx.platform === "win32" && f.existsSync(path.join(local, "agy", "bin", "agy.exe"))),
      connected: hooksConnected(path.join(home, ".gemini", "config", "hooks.json"), "agy", f),
    },
  ];
}

module.exports = { detectTools };
