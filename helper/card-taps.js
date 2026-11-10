"use strict";
// The helper's watch on the phone's card log. A tap or reply on a card that a session of this
// computer showed leaves a note for that session: its own waiter or hooks deliver it in its own
// window (never a hidden run), a Codex session gets it queued. A session that is gone, or that
// does not pick the note up, is said so on the phone: a tap never just does nothing.

const fs = require("fs");
const path = require("path");
const sessions = require("../lib/sessions.js");
const cards = require("../lib/card-taps.js");
const reach = require("../lib/reach.js");
const visibleWake = require("../lib/visible-wake.js");
const lock = require("../lib/helper-lock.js");
const { loadConfig, isConfigured } = require("../lib/config.js");

const WAIT_S = 50;
// A day-old tap answers a question nobody is asking any more.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
// How long a waiter or hook has to take the note before the user is told it is still waiting.
const PICKUP_MS = 30 * 1000;
const RETRY_MS = 2500;
const RETRY_MAX_MS = 60 * 1000;
// A session's hook holds its stash for a moment: the event is asked for again this soon.
const LOCKED_RETRY_MS = 500;
const HANDLED_MAX = 300;

const stateFile = () => path.join(sessions.stateDir(), "card_taps.json");

/** { cursor, handled: { card_id: t of its last delivered event } }; null before the first look. */
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    return s && typeof s.cursor === "string" ? { cursor: s.cursor, handled: s.handled && typeof s.handled === "object" ? s.handled : {} } : null;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    return null;
  }
}

function saveState(state) {
  const newest = Object.entries(state.handled).sort((a, b) => b[1] - a[1]).slice(0, HANDLED_MAX);
  const file = stateFile();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ cursor: state.cursor, handled: Object.fromEntries(newest) }));
  fs.renameSync(tmp, file);
}

async function tell(ctx, deps, title, body) {
  try {
    await ctx.api.notify(ctx.cfg, title, body);
  } catch (err) {
    deps.log(`card taps: could not tell the phone (${err.message})`);
  }
}

/** After PICKUP_MS: a note nobody took, for a session that is not mid-turn, is said on the phone. */
function watchPickup(ctx, deps, rec, owner) {
  const check = async () => {
    const now = deps.now();
    const live = sessions.readSession(rec.id);
    if (!sessions.hasStash(rec.id) || (live && reach.isBusy(live, now))) return;
    deps.log(`card tap ${owner.card_id}: ${rec.id} has not picked it up`);
    await tell(ctx, deps, sessions.sessionName(live || rec) || "Ringback", `Has not seen your answer on "${owner.title}" yet. It will the next time it runs.`);
  };
  if (!deps.pickupMs) return;
  const timer = setTimeout(() => check().catch((err) => deps.log(`card taps: ${err.message}`)), deps.pickupMs);
  if (timer.unref) timer.unref();
}

/** false: a hook of that session holds its stash right now, so the event must be tried again. */
async function deliver(ctx, deps, owner, note) {
  const rec = sessions.readSession(owner.session_id);
  if (!rec || rec.ended) {
    deps.log(`card tap ${owner.card_id}: its session ${owner.session_id} is gone`);
    await tell(ctx, deps, "Ringback", `The session that showed "${owner.title}" is no longer running, so your answer did not reach it.`);
    return true;
  }
  // Under the session's claim lock, like every other writer of its stash: a hook that is taking
  // the stash at this moment can never delete a note it did not read.
  const left = await sessions.withClaimLock(rec.id, () => {
    sessions.stashMessages(rec.id, [note]);
    sessions.setPending(rec.id, true);
    return true;
  });
  if (!left) return false;
  deps.log(`card tap ${owner.card_id}: left for ${rec.id}`);
  if (visibleWake.canQueue(ctx.cfg, rec, ctx)) await deps.dispatch(ctx, rec);
  else watchPickup(ctx, deps, rec, owner);
  return true;
}

/** Why an event is not an answer to the card as it is now, or "" when it is. */
function stale(event, owner, now) {
  const t = Number(event.t) || 0;
  // Both times are the phone's own clock: the card was put again after this tap.
  if (owner.shown_at && t < owner.shown_at) return "answers an older card of that id";
  return now - t > MAX_AGE_MS ? "too old" : "";
}

/**
 * One look at the log. The first look only finds its end: taps from before are never replayed.
 * "retry": an event could not be left for its session yet and is asked for again.
 */
async function once(ctx, deps) {
  const alive = deps.alive || (() => true);
  const state = loadState();
  if (!state) {
    const res = await ctx.api.events(ctx.cfg, "", 0);
    if (alive()) saveState({ cursor: String(res.cursor || ""), handled: {} });
    return "ok";
  }
  const res = await ctx.api.events(ctx.cfg, state.cursor, deps.waitS === undefined ? WAIT_S : deps.waitS);
  // Another helper may have taken over during the long poll: it delivers these and owns the state.
  if (!alive()) return "stopped";
  const handled = { ...state.handled };
  let retry = false;
  for (const event of res.events || []) {
    const owner = event && event.card_id ? cards.ownerOf(event.card_id) : null;
    const t = Number(event && event.t) || 0;
    if (!owner || t <= (handled[owner.card_id] || 0)) continue;
    const why = stale(event, owner, deps.now());
    const note = why ? null : cards.noteFor(event, owner, state.cursor);
    if (why) deps.log(`card tap ${owner.card_id}: ${why}, not delivered`);
    if (note && !(await deliver(ctx, deps, owner, note))) {
      retry = true;
      break;
    }
    handled[owner.card_id] = t;
  }
  saveState({ cursor: retry || res.cursor === undefined ? state.cursor : String(res.cursor), handled });
  return retry ? "retry" : "ok";
}

/** Runs next to the helper's inbox loop until stopped or until another helper takes the lock. */
function start(ctx, given) {
  let stopped = false;
  const alive = () => !stopped && lock.ownsLock(ctx.pid);
  const deps = { now: Date.now, pickupMs: PICKUP_MS, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), alive, ...given };
  const run = async () => {
    let failures = 0;
    while (alive()) {
      try {
        const cfg = loadConfig();
        if (!isConfigured(cfg)) return;
        if ((await once({ ...ctx, cfg }, deps)) === "retry") await deps.sleep(LOCKED_RETRY_MS);
        failures = 0;
      } catch (err) {
        failures += 1;
        // The inbox loop already logs every failed poll of an unreachable phone: here only the first.
        if (failures === 1) deps.log(`card taps: ${err.message}`);
        await deps.sleep(Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** Math.min(failures - 1, 5)));
      }
    }
  };
  run().catch((err) => deps.log(`card taps stopped: ${err.message}`));
  return { stop: () => (stopped = true) };
}

module.exports = { once, start, PICKUP_MS, MAX_AGE_MS };
