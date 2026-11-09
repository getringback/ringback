"use strict";
// Camera tools (spec 05 section 9, BUILD_PLAN A6/A7): take_photo and view_image. Results are
// { json, images } so callTool returns text + image blocks (never structuredContent).

const { api } = require("../client.js");
const { imageBlock, imageMeta, isImageId, VIEW_IMAGE_TOOL, DATA_NOT_INSTRUCTIONS } = require("../images.js");

const tools = [
  {
    name: "take_photo",
    description:
      "Take a photo with the user's phone camera and see it. During a Ringback call you are on, ask them by voice first (call_say: 'Can you point the phone at ...?'); the phone captures when its call screen is open or after they tap Show. Outside a call the phone asks them to tap to allow; this can take minutes and may come back as a background task result. Each photo costs about 2,400 input tokens. Never call it in a loop.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "One short line shown on the phone, e.g. 'See the router lights'." },
        camera: { type: "string", enum: ["back", "front"], description: "Default back." },
        call_id: { type: "string", description: "The active call, if you are on one." },
        max_edge: { type: "integer", minimum: 512, maximum: 2576, description: "Long edge in px, default 1568." },
      },
      required: ["reason"],
    },
  },
  // The one view_image (camera photos and phone screen frames), defined with the shared image code.
  VIEW_IMAGE_TOOL,
];

const HINTS = {
  ok: "You can see the photo. Talk about it on the call with call_say if you are on one.",
  denied: "They said no; do not ask again unless they offer.",
  no_answer: "They did not respond; carry on or ask by voice.",
  not_shown: "They did not respond; carry on or ask by voice.",
  camera_off: "Camera is off in Ringback settings.",
  camera_busy: "Another request is waiting on the phone.",
  no_permission: "Ringback has no camera permission on the phone; ask them to tap Look on the call screen once.",
  ended: "The call ended while waiting.",
  too_many: "Too many photo requests; wait a few minutes.",
  not_found: "No such call or image (it may have expired).",
  camera_failed: "The phone camera failed; ask by voice what they see instead.",
  bad_request: "Check the arguments.",
};

const withHint = (o) => ({ ...o, next: HINTS[o.status] || "" });

/** Phone answers that are statuses (404, 500, 400) become plain results, not tool errors. */
async function asStatus(run) {
  try {
    return await run();
  } catch (err) {
    if (err && err.body && typeof err.body.status === "string") return { status: err.body.status, detail: err.body.detail };
    throw err;
  }
}

async function takePhoto(cfg, a) {
  const body = { reason: String(a.reason || "").trim(), camera: a.camera === "front" ? "front" : "back" };
  if (a.call_id) body.call_id = String(a.call_id);
  if (a.max_edge !== undefined) body.max_edge = Number(a.max_edge);
  const res = await asStatus(() => api.takePhoto(cfg, body));
  if (res.status !== "ok" || !res.data_b64) return withHint({ status: res.status || "camera_failed", detail: res.detail });
  return { json: withHint(imageMeta(res, { origin: res.origin })), images: [imageBlock(res)] };
}

async function viewImage(cfg, a) {
  if (!isImageId(a.image_id)) return withHint({ status: "bad_request", detail: "image_id looks like img_ followed by 16 characters" });
  const detail = a.detail === "meta" ? "meta" : a.detail ? String(a.detail) : undefined;
  const res = await asStatus(() => api.getImage(cfg, a.image_id, detail));
  if (res.status !== "ok") return withHint({ status: res.status || "not_found", detail: res.detail });
  const meta = screenHint(withHint(imageMeta(res)));
  if (!res.data_b64) return meta;
  return { json: meta, images: [imageBlock(res)] };
}

/** A phone screen frame (step 6) is not a photo the user showed: say what it is, and when its app was hidden. */
function screenHint(o) {
  if (o.source !== "screen") return o;
  const hidden = o.content_visible === false ? " The shared app was hidden when it was taken, so it may show nothing useful." : "";
  return { ...o, next: `This is a frame of the user's phone screen.${hidden} ${DATA_NOT_INSTRUCTIONS}` };
}

const handlers = () => ({ take_photo: takePhoto, view_image: viewImage });

module.exports = { tools, handlers, HINTS };
