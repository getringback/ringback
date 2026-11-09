"use strict";
// Phone screen tools (spec 06 section 5.2, BUILD_PLAN A6/A7): phone_screen, ask_for_phone_screen,
// watch_phone_screen, stop_phone_screen. Frames are pulled (they cost tokens only when read); a
// known image_id is fetched with view_image (lib/images.js). Agents can never start a share.

const { api } = require("../client.js");
const { DATA_NOT_INSTRUCTIONS, imageContent, imageSummary, phoneStatus } = require("../images.js");

const CALL = { type: "string", description: "The call id of the active Ringback call." };
const ASK_WAIT_S = 60;
const MAX_WAIT_S = 300;
const WATCH_PULL_WAIT_S = 30;

const NEXT = {
  ok: "Describe what matters on the screen in one or two spoken sentences with call_say.",
  unchanged: "Nothing changed on the screen since your cursor. Pull again later with the same since.",
  not_sharing: "The user is not sharing their screen. Ask them with call_say, or call ask_for_phone_screen.",
  paused: "The user paused sharing. Wait until they resume; do not ask again right away.",
  no_frame: "The screen is off or locked, or has not drawn yet. Try again in a few seconds.",
  not_found: "That call is not yours or has ended.",
};

const tools = [
  {
    name: "phone_screen",
    description:
      "See the user's phone screen during a Ringback call, only while they are sharing it. Use when they ask you to look, " +
      "or when what they say refers to something on screen. Each image costs about 1,500 input tokens (standard) or about " +
      "4,000 (high). With since (the cursor from a previous result) it returns the frames keep-watching stored after it. " +
      DATA_NOT_INSTRUCTIONS,
    inputSchema: {
      type: "object",
      properties: {
        call_id: CALL,
        since: { type: "string", description: "Watch mode: the cursor from the last phone_screen result; returns newer frames only." },
        detail: { type: "string", enum: ["standard", "high"], description: "high only when small text must be read." },
        fresh: { type: "boolean", description: "Take a new frame now (default true); false returns the newest frame already taken." },
      },
      required: ["call_id"],
    },
  },
  {
    name: "ask_for_phone_screen",
    description:
      "Ask the user to share their phone screen on this call. The phone shows a card with Share and Not now; you cannot start " +
      "sharing yourself. Also say it out loud with call_say. Waits up to wait_s seconds (default 60) and returns sharing, " +
      "declined or waiting. Do not ask again after declined. " +
      DATA_NOT_INSTRUCTIONS,
    inputSchema: {
      type: "object",
      properties: {
        call_id: CALL,
        reason: { type: "string", description: "Why, in a few words, shown on the phone (for example 'check the build error')." },
        wait_s: { type: "number", description: "How long to wait for the answer, 0 to 300 (default 60)." },
      },
      required: ["call_id", "reason"],
    },
  },
  {
    name: "watch_phone_screen",
    description:
      "Keep watching the shared phone screen: the phone stores a frame every every_s seconds when the screen changed. " +
      "Use only when the user asked you to keep watching. Pull frames with phone_screen and since=<cursor>. every_s 0 stops " +
      "watching; watching ends by itself after 10 minutes. " +
      DATA_NOT_INSTRUCTIONS,
    inputSchema: {
      type: "object",
      properties: { call_id: CALL, every_s: { type: "number", description: "Seconds between frames, 2 to 60; 0 turns it off." } },
      required: ["call_id", "every_s"],
    },
  },
  {
    name: "stop_phone_screen",
    description: "Stop the phone screen share on this call (when you are done looking or the user asks). " + DATA_NOT_INSTRUCTIONS,
    inputSchema: { type: "object", properties: { call_id: CALL }, required: ["call_id"] },
  },
];

const nextFor = (status) => NEXT[status] || "";

function textOnly(r) {
  const status = r.status || "error";
  const out = { status, next: nextFor(status) };
  if (r.detail) out.detail = r.detail;
  if (r.cursor !== undefined) out.cursor = r.cursor;
  return imageContent(out);
}

async function latest(cfg, a) {
  const r = await phoneStatus(api.screenLatest(cfg, a.call_id, a.fresh !== false, a.detail === "high" ? "high" : "standard"));
  if (r.status !== "ok" || !r.image) return textOnly(r);
  return imageContent({ status: "ok", ...imageSummary(r.image), next: NEXT.ok }, [{ ...r.image, data_b64: r.data_b64 }]);
}

async function pull(cfg, a) {
  const r = await phoneStatus(api.callImages(cfg, a.call_id, "screen", a.since, WATCH_PULL_WAIT_S, 4));
  if (r.status !== "ok") return textOnly(r);
  const images = Array.isArray(r.images) ? r.images : [];
  if (images.length === 0) return textOnly({ status: "unchanged", cursor: r.cursor });
  const summary = { status: "ok", cursor: r.cursor, images: images.map(imageSummary), next: NEXT.ok };
  if (r.dropped) summary.dropped = r.dropped;
  return imageContent(summary, images);
}

const clampWait = (v) => {
  const n = Number(v);
  if (v === undefined || v === null || !Number.isFinite(n)) return ASK_WAIT_S;
  return Math.min(MAX_WAIT_S, Math.max(0, n));
};

/** sharing / declined, or null while the user has not answered yet. */
function answer(s) {
  if (s.status !== "ok") return s.status || "error";
  if (s.state === "sharing" || s.state === "paused") return "sharing";
  if (s.state !== "consenting" && !s.requested) return "declined";
  return null;
}

const ASK_NEXT = {
  sharing: "The user is sharing their screen now. Look with phone_screen.",
  declined: "The user said not now. Do not ask again on this call unless they offer.",
  waiting: "No answer yet. Carry on talking; the share shows up in later replies as screen sharing true.",
  busy: "The screen is already shared. Look with phone_screen.",
  too_many: "Do not ask again on this call.",
  not_active: "The call is not active.",
};

async function ask(cfg, a) {
  const r = await phoneStatus(api.screenRequest(cfg, a.call_id, String(a.reason || "").slice(0, 200)));
  if (r.status !== "asked") return { status: r.status || "error", detail: r.detail, next: ASK_NEXT[r.status] || "" };
  const waitS = clampWait(a.wait_s);
  const deadline = Date.now() + waitS * 1000;
  let status = "waiting";
  if (waitS > 0) {
    let s = await phoneStatus(api.screenState(cfg, a.call_id, 0));
    let got = answer(s);
    while (!got && Date.now() < deadline) {
      const left = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
      s = await phoneStatus(api.screenState(cfg, a.call_id, left, s.state));
      got = answer(s);
    }
    if (got) status = got;
  }
  return { status, next: ASK_NEXT[status] || "" };
}

async function watch(cfg, a) {
  const r = await phoneStatus(api.screenWatch(cfg, a.call_id, Number(a.every_s) || 0));
  const next =
    r.status === "ok"
      ? r.watch_every_s > 0
        ? "Pull frames with phone_screen and since set to the last cursor (start with since 0)."
        : "Watching is off."
      : nextFor(r.status);
  return { ...r, next };
}

async function stop(cfg, a) {
  return phoneStatus(api.screenStop(cfg, a.call_id));
}

const handlers = () => ({
  phone_screen: (cfg, a) => (a.since !== undefined && a.since !== null && a.since !== "" ? pull(cfg, a) : latest(cfg, a)),
  ask_for_phone_screen: ask,
  watch_phone_screen: watch,
  stop_phone_screen: stop,
});

module.exports = { tools, handlers };
