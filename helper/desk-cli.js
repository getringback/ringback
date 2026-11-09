"use strict";
// `node ringback-helper.js desk start [url] | stop | status`: the Linux desk by hand (spec 04
// section 5.3). Prints JSON. Starting a desk captures nothing; the phone still asks for a stream.

const { loadConfig, isConfigured } = require("../lib/config.js");
const desk = require("../lib/desk.js");
const { streamsApi } = require("../lib/streams-api.js");
const { buildCaps } = require("../lib/stream-caps.js");
const { isVast } = require("../lib/stream-guard.js");

async function deskCli(args, deps = { out: (s) => process.stdout.write(`${s}\n`), api: streamsApi, buildCaps }) {
  const [action, url] = args;
  const cfg = loadConfig();
  let res;
  if (action === "start") res = await desk.start(url, { cfg });
  else if (action === "stop") res = desk.stop();
  else if (action === "status") res = desk.status();
  else res = { status: "usage", detail: "node ringback-helper.js desk start [url] | stop | status" };
  if ((action === "start" || action === "stop") && isConfigured(cfg) && !isVast() && (res.status === "running" || res.status === "stopped")) {
    try {
      await deps.api.putCaps(cfg, await deps.buildCaps(cfg));
    } catch (err) {
      res = { ...res, phone: `caps not sent: ${err.message}` };
    }
  }
  deps.out(JSON.stringify(res, null, 2));
  return res;
}

module.exports = { deskCli };
