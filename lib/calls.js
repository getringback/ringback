"use strict";
// Call flows shared by the MCP tools and the hooks.

const { api } = require("./client.js");

const ENDED = new Set(["no_answer", "declined", "hung_up", "ended", "busy"]);

function callerName(project) {
  return `Claude - ${project}`;
}

// Ring and wait for the reply. The phone itself speaks `message` the moment the call is
// answered (SPEC: POST /v1/calls opening line), so the follow-up say only listens. Sending the
// message again here made every call say its opening twice (first real call, 2026-11-07).
async function callAndAsk(cfg, { project, reason, message, waitS, sessionId, from, onPlaced }, deps = { api }) {
  const placed = await deps.api.placeCall(cfg, callerName(project), reason, message, sessionId);
  // The Claude Desktop chat keeps its own calls apart from calls placed to it (lib/desktop-chat.js).
  if (placed.call_id && typeof onPlaced === "function") onPlaced(placed.call_id);
  if (placed.status === "busy" || !placed.call_id) {
    return { call_id: placed.call_id || null, status: placed.status || "busy", reply: null };
  }
  const said = from
    ? await deps.api.say(cfg, placed.call_id, "", true, waitS, undefined, sessionId, from)
    : await deps.api.say(cfg, placed.call_id, "", true, waitS, undefined, sessionId);
  const out = { call_id: placed.call_id, status: said.status, reply: said.reply ?? null };
  // Spec 02: who said what, and who joined, only when the phone sent them.
  if (Array.isArray(said.utterances)) out.utterances = said.utterances;
  if (Array.isArray(said.participants_changed)) out.participants_changed = said.participants_changed;
  if (said.detail) out.detail = said.detail;
  // Spec 05: images they showed ride along.
  if (Array.isArray(said.images) && said.images.length) out.images = said.images;
  return out;
}

/**
 * The owner's own words in a reply (spec 02 section 7.4). With `utterances`, only kind "owner";
 * an old phone without them can have no guests (guests need the new app), so `reply` is the owner's.
 */
function ownerText(said) {
  if (!said) return "";
  if (Array.isArray(said.utterances)) return said.utterances.filter((u) => u && u.kind === "owner").map((u) => u.text).join(" ");
  return said.reply || "";
}

function isEnded(status) {
  return ENDED.has(status);
}

module.exports = { callAndAsk, callerName, isEnded, ownerText };
