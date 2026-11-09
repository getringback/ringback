---
description: Show what Ringback streams from this machine (terminal, screen, desk) and how to start the Linux desk
argument-hint: "[desk start <url> | desk stop | desk status]"
---
The user asked about Ringback screens: `$ARGUMENTS`

If the arguments start with `desk`, run exactly this and report the JSON result in one or two plain sentences:

node "${CLAUDE_PLUGIN_ROOT}/helper/ringback-helper.js" $ARGUMENTS

A desk runs only on a Linux machine where a human set `"desk": { "enabled": true }` in `~/.ringback/config.json` (never on vast.ai). If the result says `not_allowed` or `missing`, explain that and point to `${CLAUDE_PLUGIN_ROOT}/desk/README.md`; do not edit the config yourself.

Otherwise call the `my_screen_status` tool and tell the user, briefly:
- what is live from this machine on their phone right now, and whether a call with this session is active;
- that on the phone, Sessions > a session > View shows its Terminal, its Window (Windows) or the Full PC, and the Machines list has Screen (and Desk on a Linux machine with a desk);
- that during a call you can show the screen with `show_my_screen` and record it with `record_my_screen`; outside a call the phone asks them to tap Show first.
