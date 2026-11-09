"use strict";
// Command lines of a process and its ancestors (best effort, never throws). Used to tell headless
// runs apart (hooks/wake-wait.js), to read the permission flags a session was started with
// (lib/permissions.js, FOLLOWUPS item 47) and to see that a Claude Code process runs inside the
// Claude Desktop app (FOLLOWUPS item 48b). Local reads only: never a model call.

const { spawnSync } = require("child_process");

// Windows process queries can stall for minutes on a loaded machine, and hooks wait on them: without
// a limit every tool call added another stuck PowerShell (64 at once, 8 GB, 2026-11-09).
const LOOKUP_LIMIT_MS = 8000;
const LOOKUP = { encoding: "utf8", windowsHide: true, timeout: LOOKUP_LIMIT_MS };

/** Command lines of `pid` and its ancestors (nearest first), up to `depth`. */
function ancestorCommandLines(pid = process.ppid, depth = 6, deps = {}) {
  const run = deps.spawnSync || spawnSync;
  const platform = deps.platform || process.platform;
  const out = [];
  try {
    if (platform === "win32") {
      const ps =
        `$p=${Number(pid)};for($i=0;$i -lt ${Number(depth)} -and $p;$i++){$x=Get-CimInstance Win32_Process -Filter "ProcessId=$p";` +
        `if(-not $x){break};([string]$x.CommandLine -replace "[\\r\\n]+"," ");$p=$x.ParentProcessId}`;
      const r = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], LOOKUP);
      out.push(...String((r && r.stdout) || "").split(/\r?\n/).filter(Boolean));
    } else {
      let p = Number(pid);
      for (let i = 0; i < depth && p > 1; i += 1) {
        const r = run("ps", ["-o", "ppid=,args=", "-p", String(p)], { encoding: "utf8" });
        const line = String((r && r.stdout) || "").trim();
        if (!line) break;
        const m = line.match(/^(\d+)\s+(.*)$/);
        if (!m) break;
        out.push(m[2]);
        p = Number(m[1]);
      }
    }
  } catch {
    // Unknown: callers treat an empty list as "nothing known".
  }
  return out;
}

/**
 * `pid` and its ancestors (nearest first) as { pid, name, cmd }, up to `depth`. `name` is the
 * executable's base name (codex.exe, codex, node, ...), `cmd` its command line. Best effort: []
 * when nothing is known.
 */
function ancestorProcesses(pid = process.ppid, depth = 6, deps = {}) {
  const run = deps.spawnSync || spawnSync;
  const platform = deps.platform || process.platform;
  const out = [];
  try {
    if (platform === "win32") {
      const ps =
        `$p=${Number(pid)};for($i=0;$i -lt ${Number(depth)} -and $p;$i++){$x=Get-CimInstance Win32_Process -Filter "ProcessId=$p";` +
        `if(-not $x){break};"$($x.ProcessId)\`t$($x.Name)\`t$(([string]$x.CommandLine) -replace '[\\r\\n\\t]+',' ')";$p=$x.ParentProcessId}`;
      const r = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], LOOKUP);
      for (const line of String((r && r.stdout) || "").split(/\r?\n/)) {
        const m = line.match(/^(\d+)\t([^\t]+)(?:\t(.*))?$/);
        if (m) out.push({ pid: Number(m[1]), name: m[2].trim(), cmd: (m[3] || "").trim() });
      }
    } else {
      let p = Number(pid);
      for (let i = 0; i < depth && p > 1; i += 1) {
        const r = run("ps", ["-o", "ppid=,comm=", "-p", String(p)], { encoding: "utf8" });
        const m = String((r && r.stdout) || "").trim().match(/^(\d+)\s+(.+)$/);
        if (!m) break;
        const args = run("ps", ["-o", "args=", "-p", String(p)], { encoding: "utf8" });
        out.push({ pid: p, name: m[2].trim().split("/").pop(), cmd: String((args && args.stdout) || "").trim() });
        p = Number(m[1]);
      }
    }
  } catch {
    // Unknown: callers treat an empty list as "nothing known".
  }
  return out;
}

/** The executable base name of a running process, or "" when it is gone or unknown. */
function processName(pid, deps = {}) {
  const run = deps.spawnSync || spawnSync;
  const platform = deps.platform || process.platform;
  const n = Number(pid);
  if (!(n > 0)) return "";
  try {
    if (platform === "win32") {
      const r = run("tasklist.exe", ["/FI", `PID eq ${n}`, "/FO", "CSV", "/NH"], LOOKUP);
      const m = String((r && r.stdout) || "").match(/^"([^"]+)","(\d+)"/m);
      return m && Number(m[2]) === n ? m[1] : "";
    }
    const r = run("ps", ["-o", "comm=", "-p", String(n)], { encoding: "utf8" });
    return String((r && r.stdout) || "").trim().split("/").pop();
  } catch {
    return "";
  }
}

module.exports = { ancestorCommandLines, ancestorProcesses, processName, LOOKUP_LIMIT_MS };
