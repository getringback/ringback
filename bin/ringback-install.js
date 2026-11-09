#!/usr/bin/env node
"use strict";
// One command that puts Ringback into the other clients (FOLLOWUPS item 20):
//   node plugin/bin/ringback-install.js --client claude-desktop|codex|agy|all [--root <dir>] [--dry-run]
// Idempotent: a second run changes nothing. Every file it changes is copied to
// <file>.bak-ringback-<time> first. No token goes into any client config; Ringback reads its
// pairing from ~/.ringback/config.json (pair once with /ringback:pair in Claude Code).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const inst = require("../lib/install.js");
const approve = require("../lib/auto-approve.js");
const { loadConfig, isConfigured } = require("../lib/config.js");

function read(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
}

/** Applies one merge to one file and says what happened. */
function apply(ctx, file, merge, what) {
  const r = merge(read(file));
  if (!r.changed) return `  ${what}: already set (${file})`;
  if (ctx.dryRun) return `  ${what}: would update ${file}`;
  const w = inst.writeIfChanged(file, r.text, ctx.when);
  return `  ${what}: updated ${file}${w.backup ? ` (backup ${w.backup})` : " (new file)"}`;
}

function claudeDesktop(ctx) {
  const file = inst.desktopConfigPath();
  const entry = inst.mcpEntry(ctx.root, "claude-desktop");
  return {
    lines: [apply(ctx, file, (t) => inst.mergeDesktopConfig(t, entry, file), "MCP server")],
    notes: [
      "Quit Claude Desktop fully (tray icon > Quit) and open it again to load the Ringback tools.",
      "Desktop chats can call and notify you, and you can call them from the phone (\"Claude Desktop\" on the Sessions list while Desktop runs; Windows types the call into the open chat).",
    ],
  };
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function codex(ctx) {
  const home = codexHome();
  const entry = inst.mcpEntry(ctx.root, "codex");
  const toml = path.join(home, "config.toml");
  const hooks = path.join(home, "hooks.json");
  return {
    lines: [
      apply(ctx, toml, (t) => inst.mergeCodexToml(t, entry), "MCP server"),
      apply(ctx, hooks, (t) => inst.mergeCodexHooks(t, ctx.root, inst.shortPath, hooks), "hooks"),
      // FOLLOWUPS item 49: view_image never asks (they sent the picture).
      apply(ctx, toml, approve.addCodexApproval, "view_image approval"),
    ],
    notes: [
      "Codex runs new hooks only after you trust them: in Codex type /hooks and trust the Ringback hooks (once, and again after an update changes them).",
      "Codex sessions then show on the phone; calling one that is busy reaches it at its next step, an idle one whose window is open is woken there with `codex queue`, and a closed one cannot be called (the phone says so).",
    ],
  };
}

function findAgy() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const exe = path.join(local, "agy", "bin", "agy.exe");
  return process.platform === "win32" && fs.existsSync(exe) ? exe : "agy";
}

function agy(ctx) {
  const hooks = path.join(os.homedir(), ".gemini", "config", "hooks.json");
  const mcpFile = path.join(os.homedir(), ".gemini", "config", "mcp_config.json");
  const entry = inst.mcpEntry(ctx.root, "agy");
  const lines = [];
  if (ctx.dryRun) lines.push(`  MCP server: would run agy mcp add ringback (${mcpFile})`);
  else {
    const before = read(mcpFile);
    const backup = before ? inst.backupFile(mcpFile, ctx.when) : null;
    try {
      inst.agyMcpAdd(findAgy(), entry, (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }));
      const changed = read(mcpFile) !== before;
      if (backup && !changed) fs.rmSync(backup, { force: true });
      lines.push(`  MCP server: ${changed ? "updated" : "already set"} via agy mcp add (${mcpFile})${changed && backup ? ` (backup ${backup})` : ""}`);
    } catch (err) {
      if (backup) fs.rmSync(backup, { force: true });
      lines.push(`  MCP server: could not run agy mcp add (${err.message.split("\n")[0]}); is agy installed?`);
    }
  }
  lines.push(apply(ctx, hooks, (t) => inst.mergeAgyHooks(t, ctx.root, inst.shortPath, hooks), "hooks"));
  // FOLLOWUPS item 49: view_image never asks (they sent the picture).
  lines.push(apply(ctx, approve.agySettings(), (t) => approve.addAllowRule(t, approve.AGY_RULE), "view_image approval"));
  return {
    lines,
    notes: [
      "New agy sessions load it. agy sessions show on the phone; a busy one hears you at its next model step, an idle one is woken in its own window only with \"agy_visible_wake\": true in ~/.ringback/config.json (else the phone says it could not be reached on screen).",
      "agy has no session-end hook: a closed agy session leaves the phone's list 24 hours after its last activity.",
    ],
  };
}

const STEPS = { "claude-desktop": claudeDesktop, codex, agy };
const NAMES = { "claude-desktop": "Claude Desktop", codex: "Codex", agy: "Antigravity (agy)" };

function main(argv) {
  let opts;
  try {
    opts = inst.parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  const ctx = { root: inst.pluginRoot(opts), dryRun: opts.dryRun, when: inst.stamp() };
  if (!fs.existsSync(path.join(ctx.root, "mcp.js"))) {
    process.stderr.write(`No Ringback plugin at ${ctx.root} (mcp.js missing). Pass --root <plugin dir>.\n`);
    return 1;
  }
  const out = [`Ringback plugin: ${ctx.root}${ctx.dryRun ? " (dry run, nothing written)" : ""}`];
  let failed = false;
  for (const client of opts.clients) {
    out.push(`${NAMES[client]}:`);
    try {
      const r = STEPS[client](ctx);
      out.push(...r.lines, ...r.notes.map((n) => `  Note: ${n}`));
    } catch (err) {
      failed = true;
      out.push(`  Failed: ${err.message}`);
    }
  }
  if (!isConfigured(loadConfig())) out.push("Not paired yet: in Claude Code run /ringback:pair <code> (from the Ringback app, Connect a computer).");
  process.stdout.write(`${out.join("\n")}\n`);
  return failed ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main };
