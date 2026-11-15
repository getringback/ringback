"use strict";
// Does Codex run our hooks yet? Codex asks the user once to trust new or changed hooks ("Hooks need
// review"), and until they do, a Codex session never shows on the phone. Codex keeps that trust by
// a hash we cannot recompute, so we record what we saw instead: a Ringback hook that RUNS proves
// Codex trusts the hooks as they are now. The fingerprint is of our own hook definitions in
// ~/.codex/hooks.json; it changes only when that text changes (since 0.7.38 the commands name the
// stable ~/.ringback/plugin/current path, so plugin updates leave it alone).

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { configDir } = require("./config.js");

const HOOK_MARK = "hooks/client-hook.js";

const codexHome = (env = process.env, home = os.homedir()) => env.CODEX_HOME || path.join(home, ".codex");
const hooksFile = (env, home) => path.join(codexHome(env, home), "hooks.json");
const seenFile = () => path.join(configDir(), "state", "codex-hooks-trusted.json");

/** sha256 of our hook groups per event in a hooks.json text, or null when it has none. */
function fingerprint(text) {
  let cfg;
  try {
    cfg = JSON.parse(String(text || ""));
  } catch {
    return null;
  }
  const hooks = cfg && typeof cfg.hooks === "object" && cfg.hooks ? cfg.hooks : {};
  const ours = {};
  for (const event of Object.keys(hooks).sort()) {
    const groups = (Array.isArray(hooks[event]) ? hooks[event] : []).filter((g) => JSON.stringify(g).includes(HOOK_MARK));
    if (groups.length) ours[event] = groups;
  }
  if (!Object.keys(ours).length) return null;
  return crypto.createHash("sha256").update(JSON.stringify(ours)).digest("hex");
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Called from a Codex hook that runs: Codex trusts the hooks as they are now. Never throws. */
function recordTrusted({ env = process.env, home = os.homedir(), now = Date.now() } = {}) {
  try {
    const fp = fingerprint(readText(hooksFile(env, home)));
    if (!fp) return null;
    const file = seenFile();
    let old = null;
    try {
      old = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      old = null;
    }
    if (old && old.fingerprint === fp) return fp;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ fingerprint: fp, at: now }));
    return fp;
  } catch {
    return null;
  }
}

/**
 * { installed, trusted } for this computer: installed when hooks.json holds our hooks, trusted
 * when one of them ran since they last changed. `text` overrides the file (installer dry runs).
 */
function trustState({ env = process.env, home = os.homedir(), text } = {}) {
  const fp = fingerprint(text !== undefined ? text : readText(hooksFile(env, home)));
  if (!fp) return { installed: false, trusted: false };
  let seen = null;
  try {
    seen = JSON.parse(fs.readFileSync(seenFile(), "utf8"));
  } catch {
    seen = null;
  }
  return { installed: true, trusted: Boolean(seen && seen.fingerprint === fp) };
}

const TRUST_NEEDED =
  "Codex still needs its one-time trust of the Ringback hooks: open Codex on this computer, type /hooks (or press Enter on \"Hooks need review\") and trust all of them. Until then Codex sessions do not show on the phone and cannot be called.";
const TRUSTED = "Codex already trusts these Ringback hooks; plugin updates keep them unchanged.";

module.exports = { fingerprint, recordTrusted, trustState, TRUST_NEEDED, TRUSTED, HOOK_MARK };
