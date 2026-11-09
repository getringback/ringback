"use strict";
// The call tools: only tools that talk on the call that is already up (BUILD_PLAN A7). Since
// FOLLOWUPS item 57 no helper run answers calls (no `claude --resume -p`), so nothing pre-approves
// these for a hidden run any more; SERVER_PREFIX names the plugin's MCP tools for lib/auto-approve.js.

const SERVER_PREFIX = "mcp__plugin_ringback_ringback__";
// conference_invite is never here: an idle run must not pull other sessions onto a call by itself.
// Step 6: view_image and phone_screen only look at a screen the user already shared; never
// ask_for_phone_screen or watch_phone_screen (an idle run must not start requests by itself).
const TOOLS = [
  "call_say",
  "call_listen",
  "call_hang_up",
  "notify_user",
  "conference_leave",
  "conference_transcript",
  "set_session_status",
  "view_image",
  "phone_screen",
];
const ALLOWED_TOOLS = TOOLS.map((t) => `${SERVER_PREFIX}${t}`);

module.exports = { SERVER_PREFIX, TOOLS, ALLOWED_TOOLS };
