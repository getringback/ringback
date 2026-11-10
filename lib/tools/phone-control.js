"use strict";
// Operating the user's phone during a live call, through Ringback's accessibility service. The
// phone decides everything: only a build that has the service, with their switch on, on a live
// call this agent owns. Not in lib/allowed-tools.js, so an idle run never gets it.

const { api } = require("../client.js");
const { imageBlock, phoneStatus, DATA_NOT_INSTRUCTIONS } = require("../images.js");

const ACTIONS = ["look", "tap", "swipe", "type", "back", "home"];

const NEXT = {
  off: "Phone control is off. Ask the user to turn it on in Ringback settings, or use adb if they prefer.",
  not_enabled: "Ask the user to turn on Ringback phone control in Android's accessibility settings.",
  not_active: "This only works during a live call with the user.",
  blocked_app: "Agents may not operate settings, permission dialogs or installers. Ask the user to do this step.",
  password_field: "Never type passwords. Ask the user to type it.",
  no_field: "Tap the text field first.",
  not_found: "No such call, or this phone's build has no phone control.",
};

const text = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });
const withNext = (r) => ({ status: r.status || "error", ...(r.detail ? { detail: r.detail } : {}), ...(r.foreground ? { foreground: r.foreground } : {}), ...(NEXT[r.status] ? { next: NEXT[r.status] } : {}) });

const tools = [
  {
    name: "use_my_phone",
    description:
      "See and operate the user's phone during a live call with them, when they asked you to. action look returns a screenshot, and tap and swipe take x, y in that screenshot's pixels, so look first. " +
      "If an app other than the one they asked about is in front, stop and ask. Confirm with them before anything that sends, pays, deletes or installs. Never used for passwords. " +
      DATA_NOT_INSTRUCTIONS,
    inputSchema: {
      type: "object",
      properties: {
        call_id: { type: "string" },
        action: { type: "string", enum: ACTIONS },
        x: { type: "number" },
        y: { type: "number" },
        x2: { type: "number", description: "swipe: where it ends." },
        y2: { type: "number", description: "swipe: where it ends." },
        ms: { type: "integer", description: "swipe: duration, 50 to 2000 (default 300)." },
        text: { type: "string", description: "type: added to the text field that has focus." },
      },
      required: ["call_id", "action"],
    },
  },
];

function bodyFor(a) {
  if (a.action === "tap") return { x: a.x, y: a.y };
  if (a.action === "swipe") return { x: a.x, y: a.y, x2: a.x2, y2: a.y2, ...(a.ms ? { ms: a.ms } : {}) };
  if (a.action === "type") return { text: String(a.text || "") };
  return {};
}

async function usePhone(cfg, a, deps) {
  if (!ACTIONS.includes(a.action)) return text({ status: "bad_request", detail: `action must be one of ${ACTIONS.join(", ")}` });
  const r = await phoneStatus(deps.api.phoneControl(cfg, String(a.call_id || ""), a.action, bodyFor(a)));
  if (a.action === "look" && r.status === "ok" && r.data_b64) {
    return { content: [{ type: "text", text: JSON.stringify({ status: "ok", foreground: r.foreground, width: r.width, height: r.height }) }, imageBlock(r)] };
  }
  return text(withNext(r));
}

const handlers = (_projectName, deps = { api }) => ({
  use_my_phone: (cfg, a) => usePhone(cfg, a, deps),
});

module.exports = { tools, handlers, NEXT };
