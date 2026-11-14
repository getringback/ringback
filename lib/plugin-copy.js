"use strict";
// Copy the plugin tree (for ~/.ringback/plugin/<version>/ and the npm package), without tests,
// dependencies or VCS folders. Used by plugin/join.js, join/bin and join/scripts/copy-plugin.js.

const fs = require("fs");
const os = require("os");
const path = require("path");

const SKIP = new Set(["tests", "node_modules", ".git"]);

function copyTree(src, dest, skip = SKIP) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.has(ent.name) || ent.name === ".ringback-managed" || /^\.running-\d+$/.test(ent.name)) continue;
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) copyTree(from, to, new Set(["node_modules", ".git"]));
    else if (ent.isFile()) fs.copyFileSync(from, to);
  }
}

/**
 * Install a copy of the plugin at `<base>/<version>/` (atomic: copy to a temp dir, then rename).
 * Copies are immutable: reinstalling the same version leaves running processes alone.
 */
function installCopy(src, base, version, copy = copyTree) {
  if (!validVersion(version)) throw new Error("Invalid plugin version");
  const final = path.join(base, version);
  if (fs.existsSync(final)) {
    validateCopy(final, version);
    return final;
  }
  fs.mkdirSync(base, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(base, `.${version}.`));
  try {
    copy(src, tmp);
    validateCopy(tmp, version);
    try {
      fs.renameSync(tmp, final);
    } catch (err) {
      // Another process installed the same version first: use its complete copy.
      if (!fs.existsSync(final)) throw err;
      validateCopy(final, version);
    }
    return final;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const defaultBase = () => path.join(process.env.RINGBACK_HOME || path.join(os.homedir(), ".ringback"), "plugin");

const MANAGED = ".ringback-managed";
const validVersion = (v) => typeof v === "string" && /^\d+(?:\.\d+){1,3}(?:[-+][a-zA-Z0-9.-]+)?$/.test(v);
const versionOf = (root) => JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8")).version;
const compare = (a, b) => a.localeCompare(b, "en", { numeric: true });

function validateCopy(root, version) {
  if (versionOf(root) !== version) throw new Error("Plugin copy has the wrong version");
  for (const file of ["mcp.js", "hooks/client-hook.js", "helper/ringback-helper.js"])
    if (!fs.statSync(path.join(root, file)).isFile()) throw new Error(`Plugin copy is missing ${file}`);
}

function readActive(root) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(root, "active.json"), "utf8"));
    return validVersion(v.current) ? v : null;
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

function atomicFile(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// A permanent launcher selects one immutable tree before any plugin module is loaded.
// Only active.json changes on upgrade, by file rename (including on Windows).
function launcher(file) {
  const up = file.includes("/") ? ".." : ".";
  return `"use strict";\nconst fs = require("fs");\nconst path = require("path");\n` +
    `const root = path.resolve(__dirname, ${JSON.stringify(up)});\n` +
    `const active = JSON.parse(fs.readFileSync(path.join(root, "active.json"), "utf8"));\n` +
    `if (!/^\\d+(?:\\.\\d+){1,3}(?:[-+][a-zA-Z0-9.-]+)?$/.test(active.current)) throw new Error("Invalid plugin version");\n` +
    `const target = path.join(root, "..", active.current, ${JSON.stringify(file)});\n` +
    `const lease = path.join(root, "..", active.current, ".running-" + process.pid);\n` +
    `try { fs.writeFileSync(lease, "", { mode: 0o600 }); process.on("exit", () => { try { fs.unlinkSync(lease); } catch {} }); } catch {}\n` +
    `process.argv[1] = target;\nrequire("module")._load(target, null, true);\n`;
}

function safeDirectory(home, dir) {
  if (path.dirname(home) === home) throw new Error("Ringback home cannot be a filesystem root");
  const rel = path.relative(home, dir);
  if (!rel || rel.startsWith(`..${path.sep}`) || rel === ".." || path.isAbsolute(rel)) throw new Error("Path is outside Ringback home");
  let at = home;
  for (const part of rel.split(path.sep)) {
    at = path.join(at, part);
    try {
      if (fs.lstatSync(at).isSymbolicLink()) throw new Error("Ringback cleanup does not follow linked folders");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
}

/** Fixed client entry points under Ringback home. Old sessions never roll back a newer copy. */
function ensureStableCopy(src, { home = path.dirname(defaultBase()), copyTree: copy = copyTree } = {}) {
  home = path.resolve(home);
  const base = path.join(home, "plugin"), root = path.join(base, "current");
  safeDirectory(home, root);
  const version = versionOf(src);
  if (!validVersion(version)) throw new Error("Invalid plugin version");
  let active = readActive(root);
  if (active && compare(active.current, version) >= 0) {
    validateCopy(path.join(base, active.current), active.current);
    return root;
  }
  fs.mkdirSync(root, { recursive: true });
  const lock = path.join(base, ".install-lock");
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    const pid = Number(fs.readFileSync(lock, "utf8"));
    try { process.kill(pid, 0); } catch (e) {
      if (e.code === "ESRCH") {
        fs.rmSync(lock, { force: true });
        return ensureStableCopy(src, { home, copyTree: copy });
      }
    }
    throw new Error("Another Ringback install is in progress; try again shortly");
  }
  try {
    active = readActive(root);
    if (active && compare(active.current, version) >= 0) return root;
    // The marker lets pruning tell copies made here from older copies a service may run directly.
    installCopy(src, base, version, (from, to) => { copy(from, to); fs.writeFileSync(path.join(to, MANAGED), ""); });
    for (const file of ["mcp.js", "hooks/client-hook.js", "helper/ringback-helper.js"]) {
      const dest = path.join(root, file);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (!fs.existsSync(dest)) atomicFile(dest, launcher(file));
    }
    atomicFile(path.join(root, "active.json"), JSON.stringify({ current: version, previous: active ? active.current : null }));
  } finally {
    fs.rmSync(lock, { force: true });
  }
  return root;
}

/** Delete only old regular state files and known version directories inside Ringback home. */
function pruneHome(home = path.dirname(defaultBase()), { now = Date.now(), onError = () => {} } = {}) {
  home = path.resolve(home);
  const attempt = (fn) => { try { fn(); } catch (err) { onError(err); } };
  // Top-level state files (net.json, helper_cursor, last_host and others) are long-lived: only
  // per-session files in subfolders and leftover .tmp files are removed.
  const pruneState = (dir, top) => {
    safeDirectory(home, dir);
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) attempt(() => {
      const file = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) return;
      if (ent.isDirectory()) pruneState(file, false);
      else if (ent.isFile() && (!top || ent.name.endsWith(".tmp")) && ent.name !== "helper.lock" && fs.statSync(file).mtimeMs < now - 14 * 86400000) fs.unlinkSync(file);
    });
  };
  for (const sub of ["state", "waiters"]) attempt(() => pruneState(path.join(home, sub), true));
  attempt(() => {
    const base = path.join(home, "plugin");
    safeDirectory(home, base);
    if (!fs.existsSync(base)) return;
    const lock = path.join(base, ".install-lock");
    try { fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 }); }
    catch (err) { if (err.code === "EEXIST") return; throw err; }
    try {
      safeDirectory(home, path.join(base, "current"));
      const active = readActive(path.join(base, "current"));
      const versions = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && validVersion(e.name)).map((e) => e.name).sort(compare).reverse();
      const keep = active ? [active.current, active.previous] : versions.slice(0, 2);
      // Never the copy this process runs from.
      const own = path.relative(base, path.resolve(__dirname, ".."));
      if (validVersion(own)) keep.push(own);
      for (const v of versions) if (!keep.includes(v)) attempt(() => {
        const dir = path.join(base, v);
        safeDirectory(home, dir);
        // Copies not made by ensureStableCopy (older installs, join) may back a service unit.
        if (!fs.existsSync(path.join(dir, MANAGED))) return;
        // A long-lived MCP server may still load modules from this version.
        // Defer its deletion until it exits, even after more than one upgrade.
        for (const file of fs.readdirSync(dir).filter((n) => /^\.running-\d+$/.test(n))) {
          const pid = Number(file.slice(".running-".length));
          try { process.kill(pid, 0); return; }
          catch (err) { if (err.code !== "ESRCH") return; }
          fs.unlinkSync(path.join(dir, file));
        }
        fs.rmSync(dir, { recursive: true, force: true });
      });
    } finally { fs.rmSync(lock, { force: true }); }
  });
}

module.exports = { copyTree, installCopy, defaultBase, SKIP, ensureStableCopy, pruneHome };
