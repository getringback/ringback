"use strict";
// Phone display tools (cards, wallpaper, events) as a tools module (BUILD_PLAN A7).

const { DISPLAY_TOOLS, displayHandlers } = require("../display.js");

module.exports = { tools: DISPLAY_TOOLS, handlers: displayHandlers };
