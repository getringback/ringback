"use strict";
// Phones this machine has been joined or paired with before (FOLLOWUPS item 51 security): the
// certificate fingerprints, so a Ringback phone seen on a Wi-Fi is only trusted for a join with
// nothing typed when it is provably the user's own. ~/.ringback/known-phones.json, 0600. A
// removed machine keeps the record, so it can rejoin its own phone later.

const fs = require("fs");
const path = require("path");
const { configDir, configFile } = require("./config.js");

const file = () => path.join(configDir(), "known-phones.json");
const HEX64 = /^[0-9a-f]{64}$/;
const MAX = 20;

function readJson(p) {
  try {
    const v = JSON.parse(fs.readFileSync(p, "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** Fingerprints known on this machine (the record plus a phone in config.json, paired or not). */
function knownFps() {
  const list = Array.isArray(readJson(file()).phones) ? readJson(file()).phones : [];
  const cfg = readJson(configFile());
  const fromCfg = cfg.phone && cfg.phone.fp ? [String(cfg.phone.fp)] : [];
  const norm = (fp) => String(fp || "").replace(/[^0-9a-f]/gi, "").toLowerCase();
  return new Set([...list.map((p) => norm(p && p.fp)), ...fromCfg.map(norm)].filter((fp) => HEX64.test(fp)));
}

/** Records a phone after a join the user approved on it. Never throws. */
function remember(fp, name) {
  try {
    const norm = String(fp || "").replace(/[^0-9a-f]/gi, "").toLowerCase();
    if (!HEX64.test(norm)) return;
    const cur = Array.isArray(readJson(file()).phones) ? readJson(file()).phones : [];
    const next = [{ fp: norm, name: String(name || "").slice(0, 60), at: Date.now() }, ...cur.filter((p) => p && p.fp !== norm)].slice(0, MAX);
    fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    const tmp = `${file()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ phones: next }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file());
  } catch {
    // A missing record only means a later Wi-Fi-only join needs Tailscale.
  }
}

module.exports = { knownFps, remember, file };
