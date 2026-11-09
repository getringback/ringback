"use strict";
// set_session_status (FOLLOWUPS item 9): an agent says in its own words what it has done so far
// and what it is doing now. Shown under the session on the phone's Sessions list, on the call
// screen and in the home-screen widget. Without it the hooks derive both from the transcript.

const { api } = require("../client.js");
const { setStatus, ownSession, mcpClaudePids, mcpSessionId } = require("../sessions.js");
const { currentClient } = require("../clients.js");

const tools = [
  {
    name: "set_session_status",
    description:
      "Set the short progress line the user sees under this session on their phone (Sessions list, call screen, home-screen widget). " +
      "`done`: what you have finished so far, `doing`: your current step. One short plain sentence each (max 140 characters). " +
      "Optional: without it the phone shows a summary taken from your last message. Use it at milestones, not for every step.",
    inputSchema: {
      type: "object",
      properties: {
        done: { type: "string", description: "What is done so far, e.g. 'Fixed the login bug and its tests pass.'" },
        doing: { type: "string", description: "The current step, e.g. 'Building the release APK.'" },
        session_id: { type: "string", description: "Your Claude Code session id. Normally leave it out; pass it when the tool answers ambiguous." },
      },
    },
  },
];

const handlers = () => ({
  set_session_status: async (cfg, a) => {
    const own = ownSession({ cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(), explicit: a.session_id, pids: mcpClaudePids(), envId: mcpSessionId(), client: currentClient() });
    if (own.status === "ambiguous") {
      return {
        status: "ambiguous",
        detail: "Several Claude Code sessions run in this folder and this one is not linked yet. Call again with your session_id (the Claude Code session id).",
        candidates: own.candidates,
      };
    }
    const id = own.id;
    if (!id) return { status: "unknown_session", detail: "This session is not on the phone's list yet; try again after your next tool call." };
    const shown = await setStatus(cfg, id, { done: a.done, doing: a.doing }, { api, now: Date.now() });
    return { status: "ok", ...shown };
  },
});

module.exports = { tools, handlers };
