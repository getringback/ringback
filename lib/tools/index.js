"use strict";
// The plugin's tool modules, in tools/list order. Each exports { tools, handlers(projectName) }.
// Later steps add conference, machine-screen, camera and phone-screen modules here.

const MODULES = [
  require("./calls.js"),
  require("./conference.js"),
  require("./display.js"),
  require("./status.js"),
  require("./history.js"),
  // Step 4: machine screens, recording, desk.
  require("./machine-screen.js"),
  // Step 5: camera and images (the one view_image for camera photos and phone screen frames).
  require("./camera.js"),
  // Step 6: the phone screen tools.
  require("./phone-screen.js"),
  // Operating the phone on a live call (needs a build with the service and his switch on).
  require("./phone-control.js"),
  // FOLLOWUPS item 51: add this machine to the phone with nothing typed.
  require("./join.js"),
  // FOLLOWUPS 51 SETUP CONTRACT: remote guests, set up from their own terminal.
  require("./guests.js"),
];

/** Tools that run before this machine is paired with a phone. */
function noConfigTools() {
  return new Set(MODULES.flatMap((m) => m.NO_CONFIG || []));
}

function allTools() {
  return MODULES.flatMap((m) => m.tools);
}

function allHandlers(projectName) {
  return Object.assign({}, ...MODULES.map((m) => m.handlers(projectName)));
}

module.exports = { MODULES, allTools, allHandlers, noConfigTools };
