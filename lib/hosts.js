"use strict";
// Which of the phone's addresses to try first (FOLLOWUPS item 8). The phone is reachable on its
// Wi-Fi IP while it shares a network with this machine, and on its Tailscale address anywhere.
// A long-poll to a Wi-Fi IP dies silently when the phone moves to mobile data, so:
//  - a host that just failed goes last, and after a failure Tailscale hosts go first;
//  - a private Wi-Fi IP that is not on any subnet of this machine goes after Tailscale;
//  - otherwise the last host that worked goes first.
// Pure functions plus two tiny state files (last_host, failed_hosts) in ~/.ringback/state.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { configDir } = require("./config.js");

// A failure is remembered this long; after that the host is ordered normally again.
const FAILED_FOR_MS = 10 * 60 * 1000;

const isIPv4 = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(String(h));

/** The address part of a hosts entry: "h:port", "[v6]:port", "[v6]", bare v6 or bare host. */
function hostPart(entry) {
  const e = String(entry || "").trim();
  const br = /^\[([^\]]+)\](?::\d+)?$/.exec(e);
  if (br) return br[1];
  if ((e.match(/:/g) || []).length > 1) return e;
  return e.replace(/:\d+$/, "");
}

/** The machine's own loopback: the embedded Tailscale forward (127.0.0.1:47880). */
const isLoopback = (h) => h === "127.0.0.1" || h === "::1" || h === "localhost";

function ipToInt(ip) {
  return String(ip)
    .split(".")
    .reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0);
}

/**
 * Tailscale: CGNAT 100.64.0.0/10, MagicDNS names (*.ts.net) or its IPv6 prefix fd7a:115c:a1e0::/48.
 * The local forward of the built-in Tailscale (127.0.0.1:<port>) counts as Tailscale too.
 */
function isTailscale(entry) {
  const h = hostPart(entry).toLowerCase();
  if (isLoopback(h)) return true;
  if (h.endsWith(".ts.net")) return true;
  if (h.startsWith("fd7a:115c:a1e0:")) return true;
  if (!isIPv4(h)) return false;
  return (ipToInt(h) & 0xffc00000) >>> 0 === ipToInt("100.64.0.0");
}

/** 10/8, 172.16/12, 192.168/16: a LAN (Wi-Fi) address. */
function isPrivateLan(entry) {
  const host = hostPart(entry);
  if (!isIPv4(host)) return false;
  const n = ipToInt(host);
  return (
    (n & 0xff000000) >>> 0 === ipToInt("10.0.0.0") ||
    (n & 0xfff00000) >>> 0 === ipToInt("172.16.0.0") ||
    (n & 0xffff0000) >>> 0 === ipToInt("192.168.0.0")
  );
}

/** This machine's IPv4 subnets as [{ address, netmask }] (non-internal interfaces only). */
function localSubnets(ifaces = os.networkInterfaces()) {
  const out = [];
  for (const list of Object.values(ifaces || {})) {
    for (const a of list || []) {
      const v4 = a && (a.family === "IPv4" || a.family === 4);
      if (v4 && !a.internal && a.address && a.netmask) out.push({ address: a.address, netmask: a.netmask });
    }
  }
  return out;
}

function onSubnet(entry, subnets) {
  const h = ipToInt(hostPart(entry));
  return subnets.some((s) => {
    const mask = ipToInt(s.netmask);
    return (h & mask) >>> 0 === (ipToInt(s.address) & mask) >>> 0;
  });
}

/** A Wi-Fi IP of the phone that cannot be on this machine's network right now. */
function offSubnet(host, subnets) {
  return isPrivateLan(host) && !isTailscale(host) && subnets.length > 0 && !onSubnet(host, subnets);
}

/**
 * The order to try `hosts` in. `last` is the last host that worked, `failed` maps host -> time of
 * its last failure, `subnets` are this machine's IPv4 subnets, `now` the clock.
 */
function orderHosts(hosts, { last = "", failed = {}, subnets = [], now = Date.now() } = {}) {
  const list = [...new Set((hosts || []).map(String))];
  const recentlyFailed = (h) => Number(failed[h]) > 0 && now - Number(failed[h]) < FAILED_FOR_MS;
  const anyFailure = list.some(recentlyFailed);
  const rank = (h) => {
    if (recentlyFailed(h)) return 3;
    if (offSubnet(h, subnets)) return 2;
    // After a failure Tailscale is the safest bet; otherwise the last good host leads.
    if (anyFailure) return isTailscale(h) ? (h === last ? 0 : 0.5) : 1;
    return h === last ? 0 : 1;
  };
  return list
    .map((h, i) => ({ h, i, r: rank(h) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.h);
}

const stateFile = (name) => path.join(configDir(), "state", name);

function readText(name) {
  try {
    return fs.readFileSync(stateFile(name), "utf8").trim();
  } catch {
    return "";
  }
}

function writeText(name, text) {
  try {
    fs.mkdirSync(path.dirname(stateFile(name)), { recursive: true });
    fs.writeFileSync(stateFile(name), text);
  } catch {
    // Remembering is an optimisation only.
  }
}

function readFailed() {
  try {
    const v = JSON.parse(readText("failed_hosts") || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function markFailed(host, now = Date.now()) {
  writeText("failed_hosts", JSON.stringify({ ...readFailed(), [host]: now }));
}

/** A host answered: it is the last good one and no longer counts as failed. */
function markGood(host) {
  writeText("last_host", host);
  const failed = readFailed();
  if (failed[host]) {
    const { [host]: _gone, ...rest } = failed;
    writeText("failed_hosts", JSON.stringify(rest));
  }
}

/** `hosts` in the order to try right now, from the remembered state and this machine's subnets. */
function preferredHosts(hosts, now = Date.now()) {
  return orderHosts(hosts, { last: readText("last_host"), failed: readFailed(), subnets: localSubnets(), now });
}

module.exports = {
  FAILED_FOR_MS,
  hostPart,
  isTailscale,
  isPrivateLan,
  localSubnets,
  offSubnet,
  orderHosts,
  preferredHosts,
  markFailed,
  markGood,
};
