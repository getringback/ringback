#!/usr/bin/env node
"use strict";
// /ringback:join <code>: the same join as the ringback-join package (not published yet), run from inside the
// installed plugin, so the plugin install step is skipped. The helper service runs a stable copy
// of this plugin in ~/.ringback/plugin/<version>/ (the Claude Code plugin cache can move).

const path = require("path");
const guard = require("./lib/guard.js");

async function main(argv) {
  // Guard first, before anything is read or written.
  const refused = guard.refusal(guard.detectHere());
  if (refused) {
    process.stdout.write(`${refused}\n`);
    return 1;
  }
  // `--confirm <digits>`: the digits the user read off their own phone for a running join.
  const ci = argv.indexOf("--confirm");
  if (ci >= 0) {
    const ok = require("./lib/join-confirm.js").writeConfirm(argv[ci + 1]);
    process.stdout.write(`${ok ? "Passed the code on to the running join." : "That is not 6 digits. Read the code off your phone again."}\n`);
    return ok ? 0 : 1;
  }
  const code = argv.filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!code) {
    process.stdout.write("Usage: /ringback:join <code from the Ringback app (Machines, Add a machine)>\n");
    return 1;
  }
  const { runJoin, pluginInstallService } = require("./lib/join.js");
  const opts = {
    noPlugin: true,
    helperPath: path.join(__dirname, "helper", "ringback-helper.js"),
    confirmCmd: `node "${path.join(__dirname, "join.js")}" --confirm`,
  };
  // Copied only once the join was approved (finishInstall runs after the config is written).
  const deps = { installService: pluginInstallService(__dirname) };
  return runJoin(code, opts, deps);
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stdout.write(`Join failed: ${err.message}\n`);
      process.exit(3);
    },
  );
}

module.exports = { main };
