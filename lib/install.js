"use strict";
// Installs Ringback into clients other than Claude Code (FOLLOWUPS item 20). Pure merges (text
// in, text out) plus a backup-then-write step, so bin/ringback-install.js stays a thin shell.
// No token ever goes into a client config: the MCP server and hooks read ~/.ringback/config.json.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { labelOf } = require("./clients.js");

const ALL = Object.freeze(["claude-desktop", "codex", "agy"]);
const HOOK_MARK = "hooks/client-hook.js";

/** The MCP server entry for `client`: node runs mcp.js; RINGBACK_CLIENT tells it who it serves. */
function mcpEntry(root, client, node = process.execPath) {
  const env = { RINGBACK_CLIENT: client };
  // The Desktop chat has no project folder: calls from it say "Claude Desktop".
  if (client === "claude-desktop") env.RINGBACK_PROJECT = labelOf(client);
  return { command: node, args: [path.join(root, "mcp.js")], env };
}

function parseJson(text, file) {
  if (!String(text || "").trim()) return {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {
    // Reported below.
  }
  throw new Error(`${file} is not valid JSON; left unchanged`);
}

const pretty = (obj) => `${JSON.stringify(obj, null, 2)}\n`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function desktopConfigPath(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "Claude", "claude_desktop_config.json");
}

function mergeDesktopConfig(text, entry, file = "claude_desktop_config.json") {
  const cfg = parseJson(text, file);
  const servers = cfg.mcpServers && typeof cfg.mcpServers === "object" ? cfg.mcpServers : {};
  if (same(servers.ringback, entry)) return { text, changed: false };
  return { text: pretty({ ...cfg, mcpServers: { ...servers, ringback: entry } }), changed: true };
}

/** A TOML basic string (paths may hold quotes and apostrophes). */
const tomlString = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

function codexBlock(entry) {
  const env = Object.entries(entry.env).map(([k, v]) => `${k} = ${tomlString(v)}`).join(", ");
  return [
    "# Ringback (plugin/bin/ringback-install.js): phone calls and notifications from Codex.",
    "[mcp_servers.ringback]",
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(", ")}]`,
    `env = { ${env} }`,
  ].join("\n");
}

const RB = `(?:ringback|"ringback"|'ringback')`;
const MAIN_HEADER = new RegExp(String.raw`^\s*\[\s*mcp_servers\s*\.\s*${RB}\s*\]\s*(#.*)?$`);
const isHeader = (line) => /^\s*\[/.test(line);
const isNote = (line) => /^\s*(#.*)?$/.test(line);
const isOurComment = (line) => /^# Ringback \(plugin\/bin\/ringback-install\.js\)/.test(line);

/** Ringback defined some other way (inline under [mcp_servers], or dotted keys): never guessed at. */
function otherForm(lines) {
  let table = "";
  for (const line of lines) {
    if (isHeader(line)) table = line.trim().replace(/\s+/g, "");
    else if (table === "[mcp_servers]" && new RegExp(String.raw`^\s*${RB}\s*[.=]`).test(line)) return line.trim();
    else if (!table && new RegExp(String.raw`^\s*mcp_servers\s*\.\s*${RB}\s*[.=]`).test(line)) return line.trim();
  }
  return null;
}

/**
 * The lines without the body of our [mcp_servers.ringback] table, and where it stood. Its own
 * subtables (per-tool approvals and the like) stay, and so do the comments and blank lines just
 * before the next table, which belong to that table.
 */
function withoutRingback(lines) {
  const at = lines.findIndex((l) => MAIN_HEADER.test(l));
  if (at < 0) return { kept: lines, at: -1 };
  let end = at + 1;
  while (end < lines.length && !isHeader(lines[end])) end += 1;
  let cut = end;
  while (cut > at + 1 && isNote(lines[cut - 1])) cut -= 1;
  let from = at;
  while (from > 0 && isOurComment(lines[from - 1])) from -= 1;
  return { kept: [...lines.slice(0, from), ...lines.slice(cut)], at: from };
}

function mergeCodexToml(text, entry) {
  const raw = String(text || "");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const src = raw.replace(/\r\n/g, "\n");
  const lines = src.split("\n");
  const other = otherForm(lines);
  if (other) throw new Error(`config.toml already defines ringback another way (${other}); left unchanged. Remove it and run again.`);
  const block = codexBlock(entry).split("\n");
  const { kept, at } = withoutRingback(lines);
  const gap = at >= 0 && at < kept.length && kept[at].trim() !== "" ? [""] : [];
  const next = at < 0 ? `${src.trimEnd()}\n\n${block.join("\n")}\n` : [...kept.slice(0, at), ...block, ...gap, ...kept.slice(at)].join("\n");
  if (next === src) return { text, changed: false };
  return { text: next.replace(/\n/g, eol), changed: true };
}

/**
 * The hook command line. Codex and agy hand it to cmd.exe on Windows with quotes escaped (cmd then
 * reads them literally), so nothing is quoted: a root with spaces uses its short 8.3 form.
 */
function hookCommand(root, client, mode, short = (p) => p, platform = process.platform) {
  // Preserve Windows command rules when merging a Windows config on another OS.
  if (platform !== "win32" && !/^[a-z]:[\\/]/i.test(root)) {
    const file = path.posix.join(root, "hooks", "client-hook.js");
    const quoted = /^[a-zA-Z0-9_./-]+$/.test(file) ? file : `'${file.replace(/'/g, `'"'"'`)}'`;
    return `node ${quoted} ${client} ${mode}`;
  }
  const dir = /\s/.test(root) ? short(root) : root;
  if (/[\s&|<>^%"]/.test(dir)) {
    throw new Error(`Hook commands cannot run from ${dir} (spaces or cmd characters and no short name). Pass --root <a plain path>.`);
  }
  return `node ${path.join(dir, "hooks", "client-hook.js").replace(/\\/g, "/")} ${client} ${mode}`;
}

/** Windows' short (8.3) form of a path, or the path itself where there is none. */
const shortNames = new Map();
function shortPath(p) {
  if (process.platform !== "win32") return p;
  if (shortNames.has(p)) return shortNames.get(p);
  const out = shortPathUncached(p);
  shortNames.set(p, out);
  return out;
}

function shortPathUncached(p) {
  try {
    const { execFileSync } = require("child_process");
    const out = execFileSync("cmd.exe", ["/d", "/c", `for %I in ("${p}") do @echo %~sI`], { encoding: "utf8", windowsHide: true }).trim();
    return out && !/\s/.test(out) ? out : p;
  } catch {
    return p;
  }
}

function codexHandler(root, mode, extra, short) {
  const cmd = hookCommand(root, "codex", mode, short);
  return { type: "command", command: cmd, commandWindows: cmd, ...extra };
}

/** Our Codex hook groups per event (see hooks/client-hook.js for what each mode does). */
function codexGroups(root, short) {
  const h = (mode, extra) => codexHandler(root, mode, extra, short);
  const beat = h("beat", { async: true, timeout: 30 });
  const inbox = h("inbox", { timeout: 15 });
  return {
    SessionStart: [{ hooks: [h("context", { timeout: 10, statusMessage: "Connecting Ringback" }), h("beat", { async: true, timeout: 30 })] }],
    UserPromptSubmit: [{ hooks: [beat, inbox] }],
    PostToolUse: [{ hooks: [beat, inbox] }],
    Stop: [{ hooks: [inbox] }],
    SessionEnd: [{ hooks: [h("end", { timeout: 3 })] }],
  };
}

const ours = (group) => JSON.stringify(group).includes(HOOK_MARK);

/**
 * Codex trusts each hook by its position and hash, so other hooks keep their place: our groups
 * are rewritten where they are, or appended after everything else.
 */
function mergeCodexHooks(text, root, short = (p) => p, file = "hooks.json") {
  const cfg = parseJson(text, file);
  const hooks = cfg.hooks && typeof cfg.hooks === "object" ? cfg.hooks : {};
  const want = codexGroups(root, short);
  const next = { ...hooks };
  for (const [event, groups] of Object.entries(want)) {
    const have = Array.isArray(hooks[event]) ? hooks[event] : [];
    const at = have.findIndex(ours);
    const rest = have.filter((g, i) => !ours(g) || i === at);
    next[event] = at < 0 ? [...have, ...groups] : rest.flatMap((g) => (ours(g) ? groups : [g]));
  }
  if (same(next, hooks)) return { text, changed: false };
  return { text: pretty({ ...cfg, hooks: next }), changed: true };
}

// A day, like Claude Code's waiter (hooks.json); the wait itself ends an hour before (wake-wait.js).
const AGY_STOP_TIMEOUT_S = 86400;

function mergeAgyHooks(text, root, short = (p) => p, file = "hooks.json") {
  const cfg = parseJson(text, file);
  const h = (event, timeout) => [{ type: "command", command: hookCommand(root, "agy", event, short), timeout }];
  // Stop may wait for a call while the session is idle (config agy_visible_wake, lib/visible-wake.js).
  const entry = { enabled: true, SessionStart: h("SessionStart", 15), PreInvocation: h("PreInvocation", 15), Stop: h("Stop", AGY_STOP_TIMEOUT_S) };
  if (same(cfg.ringback, entry)) return { text, changed: false };
  return { text: pretty({ ...cfg, ringback: entry }), changed: true };
}

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

/** Writes `text` to `file` when it differs, after copying the old file to <file>.bak-ringback-<stamp>. */
function writeIfChanged(file, text, when = stamp()) {
  let old = null;
  try {
    old = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (old === text) return { file, changed: false, backup: null };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup = null;
  if (old !== null) {
    backup = `${file}.bak-ringback-${when}`;
    fs.copyFileSync(file, backup);
  }
  // Write then rename, so a crash never leaves half a config behind.
  const tmp = `${file}.ringback-${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return { file, changed: true, backup };
}

/** Copies `file` (when it exists) to <file>.bak-ringback-<stamp>; the path, or null. */
function backupFile(file, when = stamp()) {
  if (!fs.existsSync(file)) return null;
  const backup = `${file}.bak-ringback-${when}`;
  fs.copyFileSync(file, backup);
  return backup;
}

/**
 * Source for the stable copy: explicit root, environment override, or this running plugin.
 */
function pluginRoot(opts = {}, env = process.env, home = os.homedir(), exists = fs.existsSync) {
  if (opts.root) return path.resolve(opts.root);
  if (env.RINGBACK_PLUGIN_ROOT) return path.resolve(env.RINGBACK_PLUGIN_ROOT);
  return path.resolve(__dirname, "..");
}

/** Repair only clients that already have Ringback entries. Never opts a new client in. */
function refreshClientPaths(root, { home = os.homedir(), env = process.env, platform = process.platform, onError = () => {} } = {}) {
  const changed = [];
  const update = (file, merge, present) => {
    try {
      if (!fs.existsSync(file)) return;
      const text = fs.readFileSync(file, "utf8");
      if (!present(text)) return;
      const next = merge(text);
      if (next.changed) { writeIfChanged(file, next.text); changed.push(file); }
    } catch (err) { onError(err); }
  };
  const codex = env.CODEX_HOME || path.join(home, ".codex");
  update(path.join(codex, "hooks.json"), (t) => mergeCodexHooks(t, root, shortPath), (t) => t.includes(HOOK_MARK));
  update(path.join(codex, "config.toml"), (t) => mergeCodexToml(t, mcpEntry(root, "codex")),
    (t) => t.split(/\r?\n/).some((l) => MAIN_HEADER.test(l)));
  const hasServer = (t) => Boolean(parseJson(t, "MCP config").mcpServers?.ringback);
  update(desktopConfigPath(platform, env, home), (t) => mergeDesktopConfig(t, mcpEntry(root, "claude-desktop")), hasServer);
  const agy = path.join(home, ".gemini", "config");
  update(path.join(agy, "hooks.json"), (t) => mergeAgyHooks(t, root, shortPath), (t) => Boolean(parseJson(t, "agy hooks").ringback));
  update(path.join(agy, "mcp_config.json"), (t) => mergeDesktopConfig(t, mcpEntry(root, "agy")), hasServer);
  return changed;
}

function refreshInstall(options = {}) {
  const copies = require("./plugin-copy.js");
  const root = copies.ensureStableCopy(options.source || path.resolve(__dirname, ".."), options);
  refreshClientPaths(root, { ...options, home: options.clientHome });
  // Hooks call this on every event: pruning runs from the installer and the helper only.
  if (options.prune !== false) copies.pruneHome(options.home, options);
  return root;
}

function parseArgs(argv) {
  const opts = { clients: null, root: "", dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const value = () => (inline !== undefined ? inline : argv[(i += 1)]);
    if (flag === "--client") {
      const v = String(value() || "");
      if (v === "all") opts.clients = [...ALL];
      else if (ALL.includes(v)) opts.clients = [v];
      else throw new Error(`Unknown client "${v}". Use claude-desktop, codex, agy or all.`);
    } else if (flag === "--root") opts.root = value();
    else if (flag === "--dry-run") opts.dryRun = true;
    else throw new Error(`Unknown option ${argv[i]}`);
  }
  if (!opts.clients) throw new Error("Usage: ringback-install --client claude-desktop|codex|agy|all [--root <plugin dir>] [--dry-run]");
  return opts;
}

/** `agy mcp add` (add or update); flags go before the name. Never through a shell. */
function agyMcpAdd(agy, entry, run) {
  const env = Object.entries(entry.env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
  return run(agy, ["mcp", "add", ...env, "ringback", entry.command, ...entry.args]);
}

module.exports = {
  ALL,
  mcpEntry,
  desktopConfigPath,
  mergeDesktopConfig,
  tomlString,
  mergeCodexToml,
  hookCommand,
  shortPath,
  mergeCodexHooks,
  mergeAgyHooks,
  writeIfChanged,
  backupFile,
  stamp,
  pluginRoot,
  parseArgs,
  agyMcpAdd,
  refreshClientPaths,
  refreshInstall,
};
