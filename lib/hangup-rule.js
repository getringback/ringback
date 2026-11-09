"use strict";
// When a session ends a call (waiting for the word "goodbye" felt like a command, not a
// conversation). The one wording every tool description, hint and hook uses.
// The phone also refuses a hang-up while the user is speaking and gives them 2 s to say "wait".

const HANGUP_RULE =
  "End the call like a person would: when the conversation has clearly wrapped up from context " +
  "(\"okay, get on with it\", \"that's all\", \"cool, thanks\", \"call me when done\", \"nothing else\", \"bye\"), " +
  "say one short natural closing line and hang up with call_hang_up. Never hang up on an unclear one-word reply alone " +
  "(\"No\" or \"Okay\" right after you asked something: ask once more), never while they are still talking, and never right after they asked you something.";

// The short form for hints after call_say / call_listen.
const HANGUP_HINT =
  "Keep going with call_say. When the conversation has clearly wrapped up from context, say a short natural closing line and call_hang_up; " +
  "a bare \"No\" or \"Okay\" right after your question is not an ending: ask once more.";

module.exports = { HANGUP_RULE, HANGUP_HINT };
