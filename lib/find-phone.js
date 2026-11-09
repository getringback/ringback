"use strict";
// Where is the phone? (FOLLOWUPS item 51: a join with nothing typed.) Two documented ways, no UI
// automation: the phone's mDNS service `_ringback._tcp` on the same Wi-Fi, and this machine's
// own Tailscale (`tailscale status --json`, the documented CLI) for the phone's node. Every
// candidate is confirmed with the phone's unauthenticated GET /v1/health and its TLS fingerprint
// is recorded; on the LAN it must equal the fp the mDNS TXT record carries.
// Ownership (security): only a phone that is provably the user's own is ever asked. A tailnet
// phone counts when its node belongs to the same Tailscale user as this machine (never a node
// shared in from another tailnet). A Wi-Fi phone counts only when its fingerprint is already known
// on this machine or the same phone is also on the user's own tailnet. Nothing a conversation,
// file or web page says can add a phone: the tool takes no address, code or link.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { normFp } = require("./client.js");

const PHONE_PORT = 47870;
const PROBE_MS = 2500;
const TS_STATUS_MS = 8000;
// The phone's built-in Tailscale node is "rb-phone" (Tailnet.kt HOSTNAME); Tailscale may add "-1".
const PHONE_NODE = /^rb-phone(-\d+)?$/i;

/** Where the Tailscale CLI lives when it is not on PATH (official installers). */
function tailscaleCandidates(platform = process.platform, env = process.env) {
  if (platform === "win32") {
    const pf = env.ProgramFiles || "C:\\Program Files";
    return ["tailscale", path.join(pf, "Tailscale", "tailscale.exe")];
  }
  if (platform === "darwin") return ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale"];
  return ["tailscale", "/usr/bin/tailscale", "/usr/local/bin/tailscale"];
}

function runStatus(bin) {
  return new Promise((resolve) => {
    execFile(bin, ["status", "--json"], { windowsHide: true, timeout: TS_STATUS_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return resolve(null);
      try {
        resolve(JSON.parse(String(stdout)));
      } catch {
        resolve(null);
      }
    });
  });
}

/** `tailscale status --json` of this machine's own Tailscale, or null when there is none. */
async function tailscaleStatus({ platform = process.platform, exists = fs.existsSync } = {}) {
  for (const bin of tailscaleCandidates(platform)) {
    if (bin !== "tailscale" && !exists(bin)) continue;
    const st = await runStatus(bin);
    if (st) return st;
  }
  return null;
}

/** Phone nodes in a status: online peers of THIS user named rb-phone* or running Android. */
function tailnetPhones(status) {
  if (!status || status.BackendState !== "Running" || !status.Peer || !status.Self) return [];
  const owner = status.Self.UserID;
  if (owner === undefined || owner === null || owner === 0) return [];
  const out = [];
  for (const p of Object.values(status.Peer)) {
    if (!p || p.Online === false) continue;
    // Someone else's device (shared in, or another user of a shared tailnet) is never a candidate.
    if (p.ShareeNode || p.UserID !== owner) continue;
    const name = String(p.HostName || "");
    const short = String(p.DNSName || "").split(".")[0];
    if (!PHONE_NODE.test(name) && !PHONE_NODE.test(short) && String(p.OS || "").toLowerCase() !== "android") continue;
    const ip4 = (p.TailscaleIPs || []).find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
    if (ip4) out.push({ host: ip4, port: PHONE_PORT, via: "system", label: short || name });
  }
  return out;
}

const lanPhones = (found) =>
  found.map((f) => ({ host: f.ip, port: Number(f.port) || PHONE_PORT, via: "lan", label: f.instance, txtFp: normFp(f.txt && f.txt.fp) }));

/** Confirms one candidate: { ...c, fp, name } or null. */
async function confirm(c, probe) {
  try {
    const { body, fp } = await probe({ host: c.host, port: c.port }, PROBE_MS);
    const got = normFp(fp);
    if (got.length !== 64) return null;
    // A LAN answer whose certificate is not the one the phone announced is not trusted.
    if (c.txtFp && c.txtFp !== got) return null;
    // Never the name the phone reports about itself (audit C3): a label from Tailscale or mDNS.
    return { ...c, fp: got, name: c.via === "system" ? `Tailscale node ${c.label || c.host}` : `the phone on this Wi-Fi at ${c.host}` };
  } catch {
    return null;
  }
}

/** One entry per phone (same fp), its Tailscale address preferred over the Wi-Fi one. */
function dedupe(list) {
  const byFp = new Map();
  for (const c of list) {
    const prev = byFp.get(c.fp);
    if (!prev || (prev.via === "lan" && c.via === "system")) byFp.set(c.fp, { ...c, lanHost: prev && prev.via === "lan" ? prev.host : c.via === "lan" ? c.host : "" });
    else if (c.via === "lan" && !prev.lanHost) byFp.set(c.fp, { ...prev, lanHost: c.host });
  }
  return [...byFp.values()];
}

const matchesName = (c, want) => {
  const w = String(want || "").trim().toLowerCase();
  return !w || String(c.label || "").toLowerCase().includes(w) || String(c.host || "").includes(w);
};

/**
 * The user's own reachable Ringback phones. Returns { phones: [{ host, port, via: "lan"|"system",
 * fp, name }], unverified: <Ringback phones seen on the Wi-Fi that are not provably the user's> }.
 * `deps`: browse() (mDNS), tailscale() (status JSON or null), probe(target, ms) (health on a
 * capture socket), knownFps() (Set of fingerprints known on this machine). `want`: a phone name
 * the user gave, to pick one of several of their own.
 */
async function findPhones({ want } = {}, deps) {
  const [mdns, ts] = await Promise.all([deps.browse().catch(() => []), deps.tailscale().catch(() => null)]);
  const candidates = [...tailnetPhones(ts), ...lanPhones(mdns || [])];
  const confirmed = (await Promise.all(candidates.map((c) => confirm(c, deps.probe)))).filter(Boolean);
  const known = (deps.knownFps && deps.knownFps()) || new Set();
  // After dedupe a phone also on the user's tailnet has via "system".
  const all = dedupe(confirmed);
  const owned = all.filter((c) => c.via === "system" || known.has(c.fp));
  return { phones: owned.filter((c) => matchesName(c, want)), unverified: all.length - owned.length };
}

module.exports = { findPhones, tailnetPhones, lanPhones, tailscaleStatus, tailscaleCandidates, dedupe, PHONE_NODE, PHONE_PORT };
