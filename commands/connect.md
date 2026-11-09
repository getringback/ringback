---
description: Connect another AI tool on this computer (Codex or Antigravity) to your phone's Ringback app
argument-hint: "codex | agy"
---
The user wants to connect this tool to Ringback: `$ARGUMENTS`

The argument must be exactly `codex` or `agy`. For anything else, change nothing and say: "I can connect codex or agy."

Otherwise run exactly this, with that one word and nothing added:

node "${CLAUDE_PLUGIN_ROOT}/bin/ringback-install.js" --client <codex or agy>

Report what happened in one or two plain sentences. It backs up every file it changes. For codex, also say: "Open Codex, type /hooks and trust the Ringback hooks once, then send it a message. It will appear on your phone."
