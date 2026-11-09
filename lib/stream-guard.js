"use strict";
// Where screens, terminals and desks may run (spec 04 section 7.2, decision D6).
// BUILD_PLAN A7 wants these in step 3's lib/guard.js; that file is built in parallel, so this
// module uses its isVast() when present and carries its own detection otherwise. Fold into
// guard.js at merge time.
//  - vast.ai: never anything.
//  - a restricted host: streams only when a human set config streams.allow_dex_box === true; a desk never.
//  - desk: Linux only, and only when a human set config desk.enabled === true on that machine.

const fs = require("fs");
const os = require("os");

function defaults() {
  return {
    env: process.env,
    hostname: os.hostname(),
    platform: process.platform,
    exists: (p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    },
    readFile: (p) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return "";
      }
    },
    listEtc: () => {
      try {
        return fs.readdirSync("/etc");
      } catch {
        return [];
      }
    },
  };
}

function sharedIsVast() {
  try {
    const g = require("./guard.js");
    return typeof g.isVast === "function" ? g.isVast : null;
  } catch {
    return null;
  }
}

function isVast(deps) {
  if (!deps) {
    const shared = sharedIsVast();
    if (shared && shared()) return true;
  }
  const d = { ...defaults(), ...(deps || {}) };
  if (d.env.VAST_CONTAINERLABEL || d.env.VAST_CONTAINER_ID || d.env.VAST_TCP_PORT_22) return true;
  if (d.exists("/etc/vast_containerlabel") || d.exists("/.vast")) return true;
  if ((d.listEtc ? d.listEtc() : []).some((n) => /^vast/i.test(n))) return true;
  if (/vast\.?ai/i.test(d.readFile("/proc/1/cgroup"))) return true;
  return /^C\.\d+$/.test(String(d.hostname || "")) && Boolean(d.env.CONTAINER_ID);
}

function isDexBox(deps) {
  const d = { ...defaults(), ...(deps || {}) };
  return String(d.hostname || "").toLowerCase() === "dex-box";
}

function streamsAllowed(cfg = {}, deps) {
  if (isVast(deps)) return false;
  if (isDexBox(deps)) return Boolean(cfg && cfg.streams && cfg.streams.allow_dex_box === true);
  return true;
}

function deskAllowed(cfg = {}, deps) {
  const d = { ...defaults(), ...(deps || {}) };
  if (d.platform !== "linux") return false;
  if (isVast(deps) || isDexBox(deps)) return false;
  return Boolean(cfg && cfg.desk && cfg.desk.enabled === true);
}

module.exports = { isVast, isDexBox, streamsAllowed, deskAllowed };
