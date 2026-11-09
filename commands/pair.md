---
description: Pair this computer with your phone's Ringback app so agents can call you
argument-hint: "<ringback://agent?... code from the app>"
---
Pair Ringback with the code the user gave: `$ARGUMENTS`

If no code was given, tell the user: open Ringback on the phone, tap "Connect a computer", tap Copy, and paste the code after `/ringback:pair`.

Otherwise run exactly this (quote the code):

node "${CLAUDE_PLUGIN_ROOT}/pair.js" "$ARGUMENTS"

Report the one-line result. On failure, explain the fix in plain words (same Wi-Fi or Tailscale on, Ringback open on the phone). Then, if pairing worked, offer a test call with the call_user tool.

If the output contains a line starting with "Offer:", ask the user once whether Claude may see photos they show on a Ringback call without a prompt each time. Only if they say yes, run:

node "${CLAUDE_PLUGIN_ROOT}/pair.js" --allow-view-image

and report what it added.
