"use strict";
// "Its window" view (FOLLOWUPS item 22b), Windows only: the window hosting a session, found from
// the session's claude pid by walking its process ancestors (Windows Terminal, VS Code, Claude
// Desktop, a console window...). Also the display list, read as geometry only (never a capture).
// One PowerShell call each; the pid is a validated integer, nothing else goes into the script.
// FOLLOWUPS item 58: a window counts as the session's own only when a console of the session's
// own process chain owns it. Windows Terminal, VS Code, Claude Desktop and the like host every
// tab in ONE window (the shells run in ConPTY with no window of their own), so capturing them
// would show whichever session is focused. Those come back marked shared and are never streamed.

const { execFile } = require("child_process");

const runPs = (script) =>
  new Promise((resolve, reject) =>
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 },
      (err, out) => (err ? reject(err) : resolve(String(out))),
    ),
  );

const NATIVE = `Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class RbWin {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[void][RbWin]::SetProcessDPIAware()
`;

function findScript(pid) {
  return `$ErrorActionPreference = 'SilentlyContinue'
${NATIVE}$p = ${pid}; $hit = $null
for ($i = 0; $i -lt 8 -and $p -gt 0; $i++) {
  $proc = Get-Process -Id $p
  if ($proc -and $proc.MainWindowHandle -ne 0) { $hit = $proc; break }
  $c = Get-CimInstance Win32_Process -Filter "ProcessId=$p"
  if (-not $c) { break }
  $p = [int]$c.ParentProcessId
}
if (-not $hit) { '{}'; exit 0 }
$h = $hit.MainWindowHandle
$r = New-Object RbWin+RECT
[void][RbWin]::GetWindowRect($h, [ref]$r)
$all = [System.Windows.Forms.Screen]::AllScreens
$s = [System.Windows.Forms.Screen]::FromHandle($h)
$idx = 0
for ($k = 0; $k -lt $all.Length; $k++) { if ($all[$k].DeviceName -eq $s.DeviceName) { $idx = $k } }
$b = $s.Bounds
@{ hwnd = [int64]$h; title = [string]$hit.MainWindowTitle; process = [string]$hit.ProcessName; x = $r.Left; y = $r.Top; w = $r.Right - $r.Left; h = $r.Bottom - $r.Top;
   minimized = [bool][RbWin]::IsIconic($h);
   monitor = @{ index = $idx; x = $b.X; y = $b.Y; w = $b.Width; h = $b.Height } } | ConvertTo-Json -Compress
`;
}

const DISPLAYS = `$ErrorActionPreference = 'SilentlyContinue'
${NATIVE}$all = [System.Windows.Forms.Screen]::AllScreens
$out = @()
for ($k = 0; $k -lt $all.Length; $k++) { $out += @{ index = $k; width = $all[$k].Bounds.Width; height = $all[$k].Bounds.Height; primary = [bool]$all[$k].Primary } }
ConvertTo-Json -Compress -InputObject @($out)
`;

const parse = (text) => {
  try {
    return JSON.parse(String(text).trim());
  } catch {
    return null;
  }
};

// Processes whose own console window shows one session only: a classic console (conhost) is
// owned by the shell or the agent that runs in it. Anything else is treated as a shared host.
const OWN_CONSOLE = new Set(["claude", "node", "codex", "agy", "cmd", "powershell", "pwsh", "bash", "sh", "wsl", "conhost", "python", "py"]);

/** True when the window may show other sessions than this one (unknown counts as shared). */
function isShared(w) {
  const name = String((w && w.process) || "").toLowerCase().replace(/.exe$/, "");
  return !OWN_CONSOLE.has(name);
}

/** The window hosting `pid` (or an ancestor) with `shared` set (see isShared), or null. */
async function findWindow(pid, { run = runPs } = {}) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0 || String(pid).trim() !== String(n)) throw new Error("bad pid");
  const w = parse(await run(findScript(n)));
  if (!w || !Number.isInteger(w.hwnd) || w.hwnd <= 0 || !w.monitor) return null;
  return { ...w, shared: isShared(w) };
}

const even = (v) => v - (v % 2);

/** The window rect relative to its monitor, clamped to it, even sizes; null when nothing is visible. */
function cropRect(w) {
  const m = w.monitor;
  const x0 = Math.max(0, w.x - m.x);
  const y0 = Math.max(0, w.y - m.y);
  const x1 = Math.min(m.w, w.x - m.x + w.w);
  const y1 = Math.min(m.h, w.y - m.y + w.h);
  const cw = even(x1 - x0);
  const ch = even(y1 - y0);
  if (cw < 16 || ch < 16) return null;
  return { monitor: m.index, x: x0, y: y0, w: cw, h: ch };
}

/** [{index, width, height, primary}] in Screen.AllScreens order; [] when unknown. */
async function listDisplays({ run = runPs } = {}) {
  const v = parse(await run(DISPLAYS).catch(() => ""));
  const arr = Array.isArray(v) ? v : v && typeof v === "object" ? [v] : [];
  return arr
    .filter((d) => d && Number.isInteger(d.index) && Number.isInteger(d.width) && Number.isInteger(d.height))
    .map((d) => ({ index: d.index, width: d.width, height: d.height, primary: Boolean(d.primary) }));
}

module.exports = { findWindow, isShared, cropRect, listDisplays, runPs };
