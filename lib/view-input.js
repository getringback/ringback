"use strict";
// Whether text typed in a session's live view can reach that session now (FOLLOWUPS item 58).
// Typed text takes the same official paths as words said on a call (FOLLOWUPS 57, lib/reach.js):
// the phone puts it in the session's inbox with origin "typed"; a busy session reads it at its
// next hook, an idle one is woken by its own waiter (Claude Code asyncRewake, agy's held Stop
// hook) or by `codex queue` into its own window. Never a hidden resume, never UI automation.
// The stream tells the phone this state, so the input box can say up front when typing would
// not reach the session.

const { reach } = require("./reach.js");

/**
 * { can_type, how, reason }: how is "next_step" (busy: its next hook reads it), "wake" (its
 * waiter wakes it), "queue" (codex queue into its window) or null; reason is shown when it cannot.
 */
function inputState(cfg, rec, deps = {}) {
  const r = reach(cfg, rec, deps);
  return { can_type: r.callable, how: r.how, reason: r.reason };
}

const sameState = (a, b) => Boolean(a && b) && a.can_type === b.can_type && a.how === b.how && a.reason === b.reason;

module.exports = { inputState, sameState };
