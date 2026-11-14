# Ringback plugin

Lets an agent phone you on Android (a real ringing call with a local voice), send quiet
notifications and cards, and lets you call a running session from the phone.

Claude Code gets everything from the plugin itself (`/plugin` install, then `/ringback:pair <code>`).

Node 20 or newer must be on PATH for the client, hooks and helper.

| Computer | Available | Limits |
|---|---|---|
| Windows | Calls, cards, hooks, idle wake, phone-started terminal windows, terminal transcript and screen sharing | Window view and phone input need a supported session window; the desk is Linux only |
| Linux | Calls, cards, hooks, idle wake, phone-started tmux sessions, terminal transcript, screen sharing and the optional desk | New sessions need tmux; screen sharing needs a display |
| macOS | Calls, cards, hooks, idle wake, terminal transcript and phone starts in Terminal, with tmux as a fallback | Window view, phone input and the desk are not on Mac yet; screen sharing needs Screen Recording permission for the helper's Node process |

The Mac Terminal route needs a GUI login and permission to control Terminal in System Settings
under Privacy & Security > Automation. Without it, Ringback tries tmux. Raw terminal view needs
tmux on Linux or macOS. Mac GUI permissions and real calls still need testing on a real Mac.

Screen sharing needs ffmpeg with libx264 on PATH:

- Windows: install ffmpeg with `winget install Gyan.FFmpeg`, then reopen the terminal.
- Linux (Debian/Ubuntu): install it with `sudo apt install ffmpeg`.
- macOS: install it with `brew install ffmpeg`, then allow Screen Recording for Node.

Adding a machine needs nothing typed: tell any session with the plugin (Claude Code, Codex, agy)
"add this computer to my phone". Its `join_this_machine` tool finds the phone (same Wi-Fi via mDNS,
or this machine's Tailscale), the phone shows "<machine> wants to
join" and you tap Allow. vast.ai machines and machines with a never-join marker are refused.
`/ringback:join <code>` stays for phones whose app does not take join requests yet.
The standalone npm join installer and built-in Tailscale download are not available yet.

## Other clients: Claude Desktop, Codex, Antigravity

Pair once in Claude Code first. The pairing lives in `~/.ringback/config.json`; no client config
ever holds the token. Then run one command:

```
node bin/ringback-install.js --client codex
```

It is idempotent (a second run changes nothing), copies every file it changes to
`<file>.bak-ringback-<time>` first, and prints what it changed. `--dry-run` only shows what it
would do. `--root <dir>` picks the plugin copy the configs point at; by default that is the stable
release copy `~/.ringback/release-plugin` when it exists, else this plugin folder.
Run it from the plugin folder; choose `claude-desktop`, `codex`, `agy` or `all` for `--client`.

| Client | What it writes | Call out (call_user, notify_user, show_on_phone...) | On the phone's Sessions list | Can be called |
|---|---|---|---|---|
| Claude Code (terminal or inside the Desktop app) | nothing (the plugin) | yes | yes | yes, busy or idle: the session's own hook (`asyncRewake`) wakes it where it runs, in the terminal or the Desktop app's Code tab |
| Claude Desktop chat | `mcpServers.ringback` in `claude_desktop_config.json` | yes | yes, as "Claude Desktop" while Desktop runs, marked "Can call you, cannot be called" | no: a plain chat has no hooks, so the phone says so and ends the call |
| Codex CLI | `[mcp_servers.ringback]` in `~/.codex/config.toml`, hooks in `~/.codex/hooks.json` | yes | yes | yes, busy or idle: an idle session whose window is open is woken there with `codex queue` (Codex 0.149+); a closed one cannot be called (the phone says it could not be reached on screen) |
| Antigravity (agy) | `agy mcp add ringback`, a `ringback` entry in `~/.gemini/config/hooks.json` | yes | yes | yes: busy at its next model step; idle only in its own window with `agy_visible_wake` on (below); otherwise the phone says it could not be reached on screen |

After installing:

- Claude Desktop: quit it fully and open it again. Run the installer while
  Desktop is closed: a running Desktop rewrites `claude_desktop_config.json` from memory.

Calling Claude Desktop: Ringback never automates a window, types into an app or reads the screen.
Waking a session goes only through Claude Code's documented hooks, the same on Windows, macOS and
Linux. A Claude Code session in the Desktop app's Code tab runs those hooks, so it is called like a
terminal session. A plain Desktop chat (MCP only, no hooks) can call you but cannot be called: a
call to it hears one plain line and ends.
- Codex: hooks run only once you trust them. In Codex type `/hooks` and trust the Ringback hooks
  (again after an update changes them). Until then Codex has the tools but is not on the list.
- agy: new sessions load it. agy has no session-end hook, so a closed agy session leaves the
  phone's list 24 hours after its last activity.

How a call reaches a non-Claude session: the Ringback helper (one per machine) holds what you
said. A busy session gets it from its own hooks (Codex: `additionalContext` after a tool, or a
`Stop` block; agy: an injected system message before the next model call, or a `Stop` continue).
An idle session is woken in its own window where the client has an official way to do that:

- Codex: the session's hooks record which Codex process runs it. While that process lives, the
  helper runs `codex queue --thread <id> --message <what you said>` (a documented Codex command):
  the session takes it as a new turn and answers in its own window. If the queue fails or no turn
  starts there within 20 seconds, you hear it could not be reached on screen. Turn it off with
  `"codex_visible_wake": false` in `~/.ringback/config.json`.
- agy: its hooks cannot start a turn from outside, but a `Stop` hook may continue the session.
  With `"agy_visible_wake": true` in `~/.ringback/config.json`, the Stop hook keeps waiting while
  the session is idle and continues it with your words when you call. Off by default: while it
  waits agy shows "Working..." (press Esc to use the session; it waits again after its next turn).
  Interactive sessions only, never `agy -p` or `agy acp`.

There is never a hidden or forked answer run: a call is answered only by the real session in its
own window. When a session cannot be woken there (closed, headless, a Claude Desktop chat, an agy
session without `agy_visible_wake`, or a Codex window whose Ringback hooks are not trusted yet), the
phone hears "<name> could not be reached on screen" and `~/.ringback/helper.log` says why
(`unreachable <id> ...`).

## What the [Ringback] lines in your terminal mean

Lines such as "Stop hook feedback" with a `[Ringback]` note mean a phone call or a card tap
has arrived through the session's hooks. They are normal messages from your phone, not an error.
The session reads them and continues with your request.
