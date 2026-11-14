"use strict";
// Machine screen tools (spec 04 section 6.8, BUILD_PLAN A7): show the user this machine's screen
// or desk on their phone, record it, stop it, and run the Linux desk. The phone gates every
// capture: during an active call with this agent it starts on its own (decision D4), otherwise
// the user taps Show. None of these are in lib/allowed-tools.js (an idle -p run never starts one).

const os = require("os");
const { streamsApi } = require("../streams-api.js");
const { RingbackError } = require("../client.js");
const desk = require("../desk.js");
const { buildCaps } = require("../stream-caps.js");
const { phoneWait } = require("./phone-wait.js");
const { streamStatus, recordingStatus } = require("./stream-status.js");
const { ownSession, mcpClaudePids, mcpSessionId } = require("../sessions.js");
const { isVast } = require("../stream-guard.js");

const MACHINE = os.hostname().slice(0, 64);
const FINAL = new Set(["declined", "ended"]);

const NEXT = {
  live: "The user can see it now. Describe what you do as you go.",
  declined: "They said not now. Do not ask again in this call.",
  ended: "The stream ended; call show_my_screen again only if they ask.",
  pending: "Waiting for the user to tap Show on the phone.",
  busy: "Another screen is already live on the phone; ask the user to close it first.",
  too_many: "The user said not now several times; do not ask again for a while.",
  not_allowed: "Screens are off for this machine.",
  not_found: "This machine is not on the phone yet; it appears once the Ringback helper runs here (any Claude Code session with the plugin starts it).",
  bad_request: "Check the arguments; for a desk, start it first with the desk tool.",
  not_live: "The stream is not live; nothing to record.",
  no_space: "The phone has less than 1 GB free; record to the machine instead (save_to machine).",
  recording: "Recording. Call record_my_screen with action stop to save it.",
  saved: "Saved. If a machine path is given you can attach or upload that file.",
};

const text = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });
const withNext = (obj) => ({ ...obj, ...(!obj.next && NEXT[obj.status] ? { next: NEXT[obj.status] } : {}) });

/** A refused request (4xx with a JSON body) becomes a result the agent can act on. */
async function phoneCall(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RingbackError && err.status && err.body && err.body.status) {
      return { status: err.body.status, detail: err.body.detail || "" };
    }
    throw err;
  }
}

const PRESET = { type: "string", enum: ["low", "normal", "sharp"], description: "low 540p5, normal 720p10 (default), sharp 1080p10 for small text." };

const tools = [
  {
    name: "show_my_screen",
    description:
      "Show the user this machine's screen (or its Linux desk) live on their phone. During a call with you it starts on its own; otherwise the phone asks them to tap Show (unanswered in 2 minutes = declined). " +
      "Returns when they can see it (live), when it is paused because nobody is looking, or when they said not now (declined). While it is live, say what you are doing as you go. Use only when seeing it helps; it is not for routine progress.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["screen", "desk"], description: "screen: the real screen. desk: the Linux desk started with the desk tool." },
        display: { type: "integer", description: "Monitor index for source screen (default the first)." },
        reason: { type: "string", description: "One short line shown to the user, e.g. 'Showing the failing deploy page'." },
        preset: PRESET,
      },
      required: ["source", "reason"],
    },
  },
  {
    name: "stop_my_screen",
    description: "Stop showing this machine's screen on the phone (also finalises a recording).",
    inputSchema: { type: "object", properties: { stream_id: { type: "string" } }, required: ["stream_id"] },
  },
  {
    name: "record_my_screen",
    description:
      "Record the live screen stream to MP4 (a red REC badge shows on the phone). action start, then stop; stop returns where it was saved. save_to: phone (gallery Movies/Ringback), machine (~/.ringback/recordings), or both (default).",
    inputSchema: {
      type: "object",
      properties: {
        stream_id: { type: "string" },
        action: { type: "string", enum: ["start", "stop"] },
        save_to: { type: "string", enum: ["phone", "machine", "both"] },
      },
      required: ["stream_id", "action"],
    },
  },
  {
    name: "my_screen_status",
    description: "Check whether screen sharing is live, paused because nobody is looking, interrupted, resumed or ended, with a plain reason. Also reports whether a call with you is active.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "desk",
    description:
      "Linux only: start, stop or check the desk (a virtual 1920x1080 display :5 with Chromium you drive over CDP at http://127.0.0.1:9355, e.g. Playwright MCP --cdp-endpoint). Starting a desk shows nothing on the phone; use show_my_screen with source desk for that. Refused on Windows, macOS and any machine whose config does not allow a desk.",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string", enum: ["start", "stop", "status"] }, url: { type: "string", description: "First page to open (http or https)." } },
      required: ["action"],
    },
  },
];

function ownSessionId() {
  try {
    const own = ownSession({ cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(), pids: mcpClaudePids(), envId: mcpSessionId() });
    return own.status === "ok" ? own.id : null;
  } catch {
    return null;
  }
}

async function showMyScreen(cfg, a, deps) {
  const reason = String(a.reason || "").trim().slice(0, 200);
  if (a.source !== "screen" && a.source !== "desk") return text({ status: "bad_request", detail: "source must be screen or desk" });
  if (!reason) return text({ status: "bad_request", detail: "reason is required (one short line for the user)" });
  const sid = ownSessionId();
  const body = {
    kind: a.source,
    machine: MACHINE,
    reason,
    ...(Number.isInteger(a.display) ? { display: a.display } : {}),
    ...(a.preset ? { preset: String(a.preset) } : {}),
    ...(sid ? { session_id: sid } : {}),
  };
  const created = await phoneCall(() => deps.api.create(cfg, body));
  if (!created.stream_id) return text(withNext(streamStatus(created)));
  return waitForPicture(cfg, created.stream_id, deps);
}

// The phone answers the long-poll when the stream changes and declines an untapped request after
// two minutes, so this wait is bounded by the phone. Phones that report first_frame_received
// (newer builds) are waited on until it is true; the installed phone does not send it, and
// its "live" is taken as live, as before.
async function waitForPicture(cfg, streamId, deps) {
  let version = 0;
  for (;;) {
    const s = await phoneCall(() => deps.api.get(cfg, streamId, version, 60));
    version = Number(s.version) || version;
    const waiting = s.status === "pending" || (s.status === "live" && s.first_frame_received === false);
    if (!waiting) {
      const result = streamStatus({ ...s, stream_id: streamId });
      if (result.stream_id) deps.remember(result);
      return text(withNext(result));
    }
  }
}

async function deskTool(cfg, a, deps) {
  const action = a.action;
  let out;
  if (action === "start") out = await desk.start(a.url, { cfg });
  else if (action === "stop") out = desk.stop();
  else if (action === "status") out = desk.status();
  else return text({ status: "bad_request", detail: "action must be start, stop or status" });
  if (action !== "status" && (out.status === "running" || out.status === "stopped") && !isVast()) {
    // Tell the phone at once so Desk shows (or hides) on the machine row.
    try {
      await deps.api.putCaps(cfg, await deps.buildCaps(cfg));
    } catch {
      // The helper sends caps again within 10 minutes.
    }
  }
  const next = out.running ? "Drive it over CDP at http://127.0.0.1:9355; show it with show_my_screen source desk." : undefined;
  return text({ ...out, ...(next ? { next } : {}) });
}

const handlers = (_projectName, options = {}) => {
  const recent = new Map();
  const remember = (s) => {
    recent.set(s.stream_id, s);
    if (recent.size > 20) recent.delete(recent.keys().next().value);
  };
  const deps = { api: streamsApi, buildCaps, ...options, remember };
  return {
  show_my_screen: (cfg, a) => showMyScreen(cfg, a, deps),
  stop_my_screen: async (cfg, a) => text(withNext(await phoneCall(() => deps.api.end(cfg, String(a.stream_id || ""))))),
  record_my_screen: async (cfg, a) => {
    if (a.action !== "start" && a.action !== "stop") return text({ status: "bad_request", detail: "action must be start or stop" });
    const body = a.action === "start" ? { action: "start", save_to: ["phone", "machine", "both"].includes(a.save_to) ? a.save_to : "both" } : { action: "stop" };
    return text(withNext(recordingStatus(await phoneCall(() => deps.api.record(cfg, String(a.stream_id || ""), body)))));
  },
  my_screen_status: async (cfg) => {
    try {
      const list = await phoneWait(() => phoneCall(() => deps.api.list(cfg)), 4000);
      if (!Array.isArray(list.streams)) return text(list);
      const streams = list.streams.map((s) => streamStatus(s, recent.get(s.stream_id)));
      const missing = [...recent].filter(([id, s]) => !FINAL.has(s.status) && !streams.some((row) => row.stream_id === id));
      const checked = await Promise.all(missing.map(async ([id, prev]) => {
        try {
          const s = await phoneWait(() => phoneCall(() => deps.api.get(cfg, id, 0, 0)), 2000);
          return s.status === "not_found"
            ? { stream_id: id, status: "ended", detail: "The phone no longer has this screen share." }
            : streamStatus({ ...s, stream_id: id }, prev);
        } catch {
          return { stream_id: id, status: "unknown", detail: "The phone could not be reached to check screen sharing; the picture may still be live." };
        }
      }));
      streams.push(...checked);
      streams.forEach(remember);
      return text({ ...list, streams });
    } catch {
      for (const [id, s] of recent) if (!FINAL.has(s.status)) remember({ ...s, stream_id: id, status: "unknown" });
      return text({ status: "unknown", detail: "The phone connection was interrupted; screen sharing could not be checked and the picture may still be live.", next: "Tell the user the screen sharing status could not be checked. Check my_screen_status again when the phone is reachable." });
    }
  },
  desk: (cfg, a) => deskTool(cfg, a, deps),
  };
};

module.exports = { tools, handlers, NEXT };
