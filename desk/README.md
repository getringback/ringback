# Ringback desk (Linux)

A desk is a virtual screen on a Linux server: Xvfb display `:5` at 1920x1080 with a Chromium that
Claude drives over the Chrome DevTools Protocol. The user watches it live on the phone (Machines > Desk,
or in a call when Claude calls `show_my_screen` with `source: "desk"`) and can record it.

Meant for a dedicated Linux server only. Never on vast.ai or on a restricted shared host: the plugin
refuses both in code, whatever the config says.

## One-time setup (by hand, on the server)

1. Packages (Ubuntu/Debian):

   ```bash
   sudo apt update
   sudo apt install -y xvfb chromium ffmpeg     # older Ubuntu: chromium-browser
   ```

   `ffmpeg` must have libx264 (the Ubuntu/Debian package has it). Check with
   `ffmpeg -hide_banner -encoders | grep libx264`.

2. The Ringback plugin is installed and paired on that server (`/ringback:pair <code>`), so the helper
   runs whenever a Claude Code session is open there.

3. Turn the desk on for this machine only, in `~/.ringback/config.json` (a human edits this file; no
   tool sets it):

   ```json
   { "desk": { "enabled": true } }
   ```

   Keep the existing keys (`phone`, `agent_token`, ...) in the file; just add `desk`.

## Start and stop

```bash
node ~/.claude/plugins/.../ringback/helper/ringback-helper.js desk start https://example.com
node ~/.claude/plugins/.../ringback/helper/ringback-helper.js desk status
node ~/.claude/plugins/.../ringback/helper/ringback-helper.js desk stop
```

Or from a session: `/ringback:screen desk start https://example.com`, or the `desk` tool.

What start does: `Xvfb :5 -screen 0 1920x1080x24 -nolisten tcp`, then Chromium with
`--window-size=1920,1080 --force-device-scale-factor=1 --remote-debugging-port=9355` and a fresh profile in
`~/.ringback/desk/profile` (no signed-in profile is copied, no extensions, `--no-sandbox` only when
running as root). Pid files live in `~/.ringback/desk/`; stop kills only those processes.

Starting a desk captures nothing. The phone sees a picture only after it asks for a Desk stream (a tap,
or Claude's `show_my_screen` during a call with that session, or outside a call after the user taps Show).

## How Claude drives it

CDP stays on `127.0.0.1:9355` (Chromium's default bind; `--remote-debugging-address` is never passed),
so only processes on the server reach it. For example the Playwright MCP:

```bash
claude mcp add playwright -s local -- npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:9355
```

Then: `desk start`, `show_my_screen {source: "desk", reason: "..."}`, drive the browser, talk on the call,
`record_my_screen` to keep a clip (saved to the phone gallery and/or `~/.ringback/recordings/`).

## Bandwidth

The phone defaults to Low (960x540, 5 fps, about 180 MB per hour) on mobile data and Normal
(1280x720, 10 fps, about 540 MB per hour) on Wi-Fi. Nothing runs while nobody watches: the phone sends
pause when the viewer is hidden and the helper stops ffmpeg.
