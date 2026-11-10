"use strict";
// Connect on the phone (Settings, "Codex on <computer> can't call you yet") asks this computer to
// connect Codex or Antigravity. That is one fixed installer run, so the helper does it itself: no
// Claude Code session, no folder to trust (a server's only folder is often the home folder, which
// Claude Code never lets a phone-started session use), and the result goes to the phone as a card
// so a tap never looks like it did nothing (user report, 2026-11-10: "when i click connect at least show
// the screen").

const path = require("path");
const { execFile } = require("child_process");

// The exact requests the app sends (app/src/logic/agentTools.ts CONNECT_COMMAND). Nothing else.
const CONNECT = /^\/ringback:connect (codex|agy)$/;
const NAMES = { codex: "Codex", agy: "Antigravity" };
// A local file-editing script, not an AI call: it finishes in well under a second.
const RUN_MS = 60 * 1000;
const BODY_MAX = 1500;

/** "codex" | "agy" when `prompt` is exactly a Connect request from the phone, else null. */
function connectRequest(prompt) {
  const m = CONNECT.exec(String(prompt || "").trim());
  return m ? m[1] : null;
}

/** Runs the installer for `client` with fixed arguments and no shell: { ok, text }. */
function runInstaller(client, deps = {}) {
  const run = deps.execFile || execFile;
  const script = path.join(__dirname, "..", "bin", "ringback-install.js");
  return new Promise((resolve) => {
    run(process.execPath, [script, "--client", client], { timeout: RUN_MS, windowsHide: true, env: deps.env || process.env }, (err, stdout, stderr) => {
      const text = `${stdout || ""}${stderr || ""}`.trim();
      // The installer reports some steps as "could not ..." and still exits 0: that is not connected.
      const partial = /^\s*(?:[A-Za-z_ ]+: could not |Failed: )/m.test(text);
      resolve({ ok: !err && !partial, text: text || (err ? err.message : "") });
    });
  });
}

/** What the phone shows after the run: plain lines, the installer's own notes kept. */
function resultCard(client, machine, res) {
  const name = NAMES[client];
  const lines = String(res.text || "")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^Ringback plugin: /.test(l))
    .map((l) => l.replace(/^\s+/, "").replace(/^Note: /, ""));
  const next =
    client === "codex"
      ? `Last step, once: open Codex on ${machine}, type /hooks and trust the Ringback hooks. Then send it a message and it shows on your phone.`
      : `New Antigravity sessions on ${machine} load it and show on your phone.`;
  const body = res.ok ? [next, "", ...lines].join("\n") : [`It did not finish on ${machine}:`, ...lines].join("\n");
  return {
    title: res.ok ? `${name} connected on ${machine}` : `${name} could not be connected on ${machine}`,
    body: body.slice(0, BODY_MAX),
  };
}

/**
 * Handles one Connect request: runs the installer, shows the card, answers the start.
 * Returns { status: "started" | "refused", detail }.
 */
async function connect(ctx, machine, startId, client) {
  const log = ctx.log || (() => {});
  const res = await (ctx.runInstaller || runInstaller)(client, { env: ctx.env });
  const label = ctx.hostname || "this computer";
  const card = resultCard(client, label, res);
  log(`start ${startId}: connect ${client}: ${res.ok ? "done" : "failed"}`);
  try {
    await ctx.api.putCard(ctx.cfg, `ringback-connect-${client}-${String(label).toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40)}`, {
      ...card,
      source: "Ringback",
    });
  } catch (err) {
    log(`start ${startId}: connect card: ${err.message}`);
  }
  return { status: res.ok ? "started" : "refused", detail: res.ok ? null : card.body };
}

module.exports = { connectRequest, runInstaller, resultCard, connect };
