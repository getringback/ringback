"use strict";
// Whether Claude Code already trusts a folder, so a session started from the phone never sits on
// the workspace trust dialog in a terminal nobody is looking at (FOLLOWUPS item 50i). Read-only,
// from Claude Code's own documented trust record (code.claude.com/docs/en/permissions.md,
// "Project allow rules and workspace trust"):
//  - the record is `projects["<path>"].hasTrustDialogAccepted` in ~/.claude.json
//    ($CLAUDE_CONFIG_DIR/.claude.json when that is set);
//  - in a git repository the trust is keyed on the repository root (a worktree: the main
//    checkout's root) and covers the whole repository;
//  - outside a repository it is keyed on the folder Claude Code started in and covers every
//    subdirectory apart from a git repository nested inside it;
//  - in the home folder itself the trust is held for one session only and never written to disk,
//    so the dialog comes back on every start (code.claude.com/docs/en/security.md).
// Never writes the record: trusting a folder stays the user's own click.

const fs = require("fs");
const os = require("os");
const path = require("path");

/** Where Claude Code keeps its global state, including the trust record. */
function claudeJsonPath(env = process.env, home = os.homedir()) {
  return env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(home, ".claude.json");
}

/** The trust record's keys that were accepted, normalized (forward slashes, lower case on Windows). */
function trustedKeys(file, platform = process.platform) {
  try {
    const projects = JSON.parse(fs.readFileSync(file, "utf8")).projects || {};
    return new Set(Object.keys(projects).filter((k) => projects[k] && projects[k].hasTrustDialogAccepted === true).map((k) => norm(k, platform)));
  } catch {
    return new Set();
  }
}

function norm(p, platform = process.platform) {
  let s = String(p).replace(/\\/g, "/");
  if (s.length > 3 && s.endsWith("/")) s = s.slice(0, -1);
  if (/^[A-Za-z]:$/.test(s)) s += "/";
  return platform === "win32" ? s.toLowerCase() : s;
}

/** The main checkout root a `.git` file of a worktree points at, or null. */
function worktreeMain(gitFile) {
  try {
    const m = fs.readFileSync(gitFile, "utf8").match(/^gitdir:\s*(.+)$/m);
    if (!m) return null;
    const gitdir = path.resolve(path.dirname(gitFile), m[1].trim());
    const parts = gitdir.split(/[\\/]+/);
    const i = parts.lastIndexOf("worktrees");
    // <main>/.git/worktrees/<name>: the main checkout is two levels above "worktrees".
    if (i >= 2 && parts[i - 1] === ".git") return parts.slice(0, i - 1).join(path.sep) || path.sep;
    return null;
  } catch {
    return null;
  }
}

/** The git repository root `folder` is in (the main checkout for a worktree), or null. */
function repoRoot(folder) {
  let dir = path.resolve(folder);
  for (;;) {
    const git = path.join(dir, ".git");
    try {
      const st = fs.statSync(git);
      if (st.isDirectory()) return dir;
      if (st.isFile()) return worktreeMain(git) || dir;
    } catch {
      // No .git here.
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * { trusted: true } or { trusted: false, why } for starting an interactive Claude Code session in
 * `folder` without the trust dialog. deps: { home, env, platform, file }.
 */
function checkTrust(folder, deps = {}) {
  const home = deps.home || os.homedir();
  const platform = deps.platform || process.platform;
  const real = path.resolve(folder);
  const n = (p) => norm(p, platform);
  if (n(real) === n(home)) {
    return {
      trusted: false,
      why: "Claude Code asks to trust the home folder at every start, so a session cannot start there from the phone. Pick a project folder.",
    };
  }
  const keys = trustedKeys(deps.file || claudeJsonPath(deps.env || process.env, home), platform);
  const root = repoRoot(real);
  if (root && n(root) !== n(home)) {
    if (keys.has(n(root))) return { trusted: true };
    return { trusted: false, why: needsTrust(root) };
  }
  // Outside a repository: this folder, or a parent whose trust extends to it (never home itself,
  // whose trust is not kept).
  for (let dir = real; ; dir = path.dirname(dir)) {
    if (n(dir) !== n(home) && keys.has(n(dir))) return { trusted: true };
    if (path.dirname(dir) === dir) break;
  }
  return { trusted: false, why: needsTrust(real) };
}

const needsTrust = (dir) =>
  `That folder needs a one-time trust on the laptop: open Claude Code in ${path.basename(dir) || dir} there once and accept the trust prompt, then start it from the phone again.`;

module.exports = { claudeJsonPath, trustedKeys, repoRoot, worktreeMain, checkTrust, norm };
