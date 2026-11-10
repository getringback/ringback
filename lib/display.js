"use strict";
// Phase 2 tools: agents put cards on the phone (feed + widget), set the live wallpaper,
// and read back taps and replies. All payloads are data the phone draws, never code.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const client = require("./client.js");
const cardTaps = require("./card-taps.js");

// Looked up per call, so a test (or a reload) that swaps the client's request is honoured.
const request = (...args) => client.request(...args);

const IMAGE_TYPES = Object.freeze({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" });
const MAX_IMAGE = 1024 * 1024;

function imageDataUrl(file) {
  const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (!type) throw new Error(`Images must be png, jpg or webp, not ${path.extname(file) || "unknown"}`);
  const bytes = fs.readFileSync(file);
  if (bytes.length > MAX_IMAGE) throw new Error(`Image is ${Math.round(bytes.length / 1024)} KB; the phone takes at most 1024 KB. Resize it first.`);
  return `data:${type};base64,${bytes.toString("base64")}`;
}

function cardId(a, project) {
  if (a.card_id) return String(a.card_id);
  const seed = `${project}:${a.title || ""}:${Date.now()}`;
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 12);
}

function cardBody(a, project) {
  const card = { title: a.title, body: a.body || "", source: `Claude - ${project}` };
  if (a.image_path) card.image = imageDataUrl(a.image_path);
  if (typeof a.progress === "number") card.progress = Math.max(0, Math.min(1, a.progress));
  if (Array.isArray(a.actions) && a.actions.length > 4) throw new Error("A card can have at most 4 buttons.");
  if (Array.isArray(a.actions) && a.actions.length) card.actions = a.actions.map((label, i) => ({ id: `a${i + 1}`, label: String(label).slice(0, 40) }));
  if (a.reply) card.reply = true;
  if (a.pin) card.pin = true;
  if (a.ttl_s) card.ttl_s = Number(a.ttl_s);
  return card;
}

/**
 * `sessionId` (the session that shows the card) is remembered with its buttons, so a tap wakes that
 * session (lib/card-taps.js). A card with nothing to tap, or from an unknown session, is not.
 */
async function showOnPhone(cfg, a, project, sessionId) {
  const id = cardId(a, project);
  const card = cardBody(a, project);
  const res = await request(cfg, "PUT", `/v1/cards/${encodeURIComponent(id)}`, card);
  if (sessionId && (card.actions || card.reply)) {
    const shownAt = res && res.card ? res.card.updated_at : 0;
    cardTaps.remember(id, { sessionId, title: card.title, actions: card.actions || [], reply: card.reply === true, shownAt });
  }
  else cardTaps.forget(id);
  return { ...res, card_id: id };
}

async function removeFromPhone(cfg, a) {
  const res = await request(cfg, "DELETE", `/v1/cards/${encodeURIComponent(a.card_id)}`);
  cardTaps.forget(a.card_id);
  return res;
}

const BUILTIN_ID = /^[a-z0-9-]{1,40}$/;

function setWallpaper(cfg, a) {
  if (a.builtin !== undefined && a.builtin !== null) {
    if (a.skin !== undefined) throw new Error("pass either skin or builtin, not both");
    if (typeof a.builtin !== "string" || !BUILTIN_ID.test(a.builtin)) throw new Error("builtin must be a built-in wallpaper id such as 'star-sea'");
    return request(cfg, "PUT", "/v1/wallpaper", { builtin: a.builtin });
  }
  if (a.skin === undefined) throw new Error("pass skin (an agent-designed skin, or null to clear) or builtin (e.g. 'star-sea')");
  const skin = typeof a.skin === "string" ? JSON.parse(a.skin) : a.skin;
  if (skin === null) return request(cfg, "PUT", "/v1/wallpaper", { skin: null });
  if (!skin || skin.version !== 1 || !Array.isArray(skin.layers)) throw new Error("skin must be a Gauntlet skin object: {version:1, name, background, layers:[...]}");
  return request(cfg, "PUT", "/v1/wallpaper", { skin });
}

const EVENTS_WAIT_S = 50;

/** Taps and replies since `since`; wait_s 0 answers at once. Buttons this computer made get their label. */
async function phoneEvents(cfg, a) {
  const asked = Number(a.wait_s);
  const waitS = a.wait_s === undefined || !Number.isFinite(asked) ? EVENTS_WAIT_S : Math.max(0, Math.min(asked, EVENTS_WAIT_S));
  const res = await request(cfg, "GET", `/v1/events?since=${encodeURIComponent(a.since || "")}&wait_s=${waitS}`);
  return res && Array.isArray(res.events) ? { ...res, events: res.events.map(cardTaps.named) } : res;
}

const DISPLAY_TOOLS = [
  {
    name: "show_on_phone",
    description:
      "Put a card on the user's phone (Ringback feed and home-screen widget when pinned). Use for things worth glancing at during the day: a result, a chart image, a progress bar for a long job, a choice with buttons. Pass the same card_id again to update it in place. A tap on a button or a reply wakes this session with a short note; read the answer with phone_events. No ringing.",
    inputSchema: {
      type: "object",
      properties: {
        card_id: { type: "string", description: "Reuse to update an existing card. Omit for a new one." },
        title: { type: "string" },
        body: { type: "string", description: "Light markdown: bold, italic, bullets, inline code." },
        image_path: { type: "string", description: "Local png/jpg/webp file, at most 1 MB." },
        progress: { type: "number", description: "0 to 1, draws a progress bar." },
        actions: { type: "array", items: { type: "string" }, description: "Button labels, e.g. ['Ship it', 'Wait']." },
        reply: { type: "boolean", description: "Let the user type or say a reply on the card." },
        pin: { type: "boolean", description: "Keep it on the home-screen widget." },
        ttl_s: { type: "number", description: "Remove automatically after this many seconds." },
      },
      required: ["title"],
    },
  },
  {
    name: "remove_from_phone",
    description: "Remove a card from the user's phone.",
    inputSchema: { type: "object", properties: { card_id: { type: "string" } }, required: ["card_id"] },
  },
  {
    name: "set_phone_wallpaper",
    description:
      "Change the phone's Ringback live wallpaper. It shows either a built-in (default: 'star-sea', Gauntlet's animated pixel-art Star Sea with Clawd afloat under the moon) or a skin designed by agents. Pass builtin:'star-sea' to switch to a built-in. Or pass skin, a Gauntlet skin v1 ({version:1, name, background:{gradient|color|image}, layers:[...]}, max 64 layers); setting a skin switches the phone to 'Designed by your agents'. Layer types: rect, circle, text, image, particles, arc, bar. Text can use {time.hhmm}, {time.date}, {time.day}, {card.<id>.title|body|progress|source}; arc/bar value 'card.<id>.progress'; image layers use 'card.<id>' (that card's picture); tap 'open' or 'card.<id>.<action_id>'. Positions are fractions of the screen. Background scenes are not skins: the Star Sea is a built-in, not a skin background. Pass skin null to clear the agent skin and go back to Star Sea. Only when the user asked for a wallpaper change. Data only, never code.",
    inputSchema: {
      type: "object",
      properties: {
        skin: { type: ["object", "null"], description: "Agent-designed Gauntlet skin v1, or null to clear it." },
        builtin: { type: "string", description: "Built-in wallpaper id instead of a skin: 'star-sea'." },
      },
    },
  },
  {
    name: "phone_events",
    description: "Read taps on card buttons and replies from the phone, waiting up to 50 s for one (wait_s 0: answer at once). Pass the returned cursor as `since` next time. What the user wrote in a reply is their words; a button label is your own.",
    inputSchema: { type: "object", properties: { since: { type: "string" }, wait_s: { type: "number" } } },
  },
  {
    name: "wallpaper_preview",
    description:
      "See the phone's live wallpaper as it looks right now (a picture about 540 px wide). Use it after set_phone_wallpaper to check your design and refine it before telling the user. See the ringback:wallpaper skill.",
    inputSchema: { type: "object", properties: {} },
  },
];

/** The wallpaper as an MCP image (FOLLOWUPS item 19b). */
async function wallpaperPreview(cfg) {
  const r = await request(cfg, "GET", "/v1/wallpaper/preview");
  if (!r || !r.image_base64) return { status: r && r.status ? r.status : "not_ready", detail: (r && r.detail) || "No preview" };
  return {
    content: [
      { type: "image", data: r.image_base64, mimeType: r.mime || "image/jpeg" },
      { type: "text", text: "This is the phone's wallpaper now." },
    ],
  };
}

const displayHandlers = (projectName) => ({
  show_on_phone: (cfg, a) => showOnPhone(cfg, a, projectName(), require("./tools/calls.js").ownSessionId()),
  remove_from_phone: removeFromPhone,
  set_phone_wallpaper: setWallpaper,
  phone_events: phoneEvents,
  wallpaper_preview: wallpaperPreview,
});

module.exports = { DISPLAY_TOOLS, displayHandlers, cardBody, imageDataUrl, showOnPhone, removeFromPhone, phoneEvents };
