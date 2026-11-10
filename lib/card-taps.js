"use strict";
// A tap or a reply on a card reaches the session that put the card on the phone. The phone keeps
// taps in one log for every computer (GET /v1/events) and knows no session, so this computer
// remembers which session showed which card: one small file per card (state/cards), written by
// that session's own MCP server. The helper watches the log (helper/card-taps.js) and leaves a
// note for the session; the session reads the answer itself with phone_events.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { stateDir, safeId } = require("./sessions.js");

const MAX_CARDS = 200;
const TITLE_MAX = 120;
const CONTROL = /[\u0000-\u001f\u007f]+/g;

const dir = () => path.join(stateDir(), "cards");
// Card ids are free text from the session: never a file name as they are.
const fileOf = (cardId) => path.join(dir(), `${crypto.createHash("sha256").update(String(cardId)).digest("hex").slice(0, 32)}.json`);
const clean = (v, max) => String(v || "").replace(CONTROL, " ").trim().slice(0, max);

function prune() {
  const files = fs.readdirSync(dir()).map((f) => path.join(dir(), f));
  if (files.length <= MAX_CARDS) return;
  const byAge = files.map((f) => ({ f, at: fs.statSync(f).mtimeMs })).sort((a, b) => a.at - b.at);
  for (const { f } of byAge.slice(0, files.length - MAX_CARDS)) fs.rmSync(f, { force: true });
}

/**
 * Session `sessionId` put card `cardId` on the phone with these buttons. Without a session: nothing.
 * `shownAt` is the phone's own time for this version of the card (its `updated_at`): a tap from
 * before it answered an older card of the same id and is never taken for this one.
 */
function remember(cardId, { sessionId, title, actions = [], reply = false, shownAt = 0 }, now = Date.now()) {
  if (!cardId || !safeId(sessionId)) return;
  const rec = {
    card_id: String(cardId),
    session_id: safeId(sessionId),
    title: clean(title, TITLE_MAX),
    actions: actions.map((a) => ({ id: String(a.id), label: clean(a.label, TITLE_MAX) })),
    reply: reply === true,
    shown_at: Number(shownAt) || 0,
    at: now,
  };
  fs.mkdirSync(dir(), { recursive: true });
  const file = fileOf(cardId);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec));
  fs.renameSync(tmp, file);
  prune();
}

function forget(cardId) {
  if (cardId) fs.rmSync(fileOf(cardId), { force: true });
}

/** Who showed card `cardId` from this computer, or null (another computer's card, or one without buttons). */
function ownerOf(cardId) {
  try {
    const rec = JSON.parse(fs.readFileSync(fileOf(cardId), "utf8"));
    return rec && rec.card_id === String(cardId) && safeId(rec.session_id) ? rec : null;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    return null;
  }
}

/**
 * The note for the session about one event of the phone's log, or null when the event is not an
 * answer that card could take. Only the session's own words are in it (title, button label):
 * what the user wrote in a reply stays on the phone until the session asks with phone_events
 * (`since` is the log cursor just before this event).
 */
function noteFor(event, owner, since) {
  if (!event || !owner) return null;
  const t = Number(event.t) || 0;
  const base = { card_id: owner.card_id, title: owner.title, since: String(since || "") };
  if (event.type === "action") {
    const button = owner.actions.find((a) => a.id === event.action_id);
    return button ? { id: `card:${owner.card_id}:${t}`, origin: "card", t, card: { card_id: base.card_id, title: base.title, kind: "action", label: button.label, since: base.since } } : null;
  }
  if (event.type === "reply" && owner.reply) {
    return { id: `card:${owner.card_id}:${t}`, origin: "card", t, card: { card_id: base.card_id, title: base.title, kind: "reply", label: "", since: base.since } };
  }
  return null;
}

/** An event of the phone's log with the button label and card title this computer knows (phone_events). */
function named(event) {
  const owner = event && event.card_id ? ownerOf(event.card_id) : null;
  if (!owner) return event;
  const button = owner.actions.find((a) => a.id === event.action_id);
  return { ...event, ...(button ? { label: button.label } : {}), title: owner.title };
}

module.exports = { remember, forget, ownerOf, noteFor, named, MAX_CARDS };
