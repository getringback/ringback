"use strict";
// Join protocol rbj1 crypto and the join code string (spec 03 section 7.1, contract
// "Join code string"). K = UTF-8 of the normalized secret; HMAC-SHA256, lowercase hex; messages
// joined with "\n". MACs are compared with crypto.timingSafeEqual.

const crypto = require("crypto");

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SECRET_LEN = 12;
const DEFAULT_PORT = 47870;
const HEX64 = /^[0-9a-f]{64}$/;
const HOST = /^[A-Za-z0-9.-]{1,253}$/;

const BAD_CODE =
  "That is not a Ringback join code. In the app open Machines, tap Add a machine and copy the code.";
const OUTSIDE = "That code points outside your own network. Ringback codes never do, so nothing was joined.";

// Audit C2: a join code may only point at this user's own network. IPv4 literals: private LAN
// (10/8, 172.16/12, 192.168/16, 169.254/16) or Tailscale (100.64/10). Names: a single-label
// MagicDNS name or a *.ts.net name; lib/join.js checks at join time that a name resolves into
// 100.64/10 only. Any public name or address is refused before anything is sent.
const isIPv4 = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) && h.split(".").every((o) => Number(o) <= 255);
const octets = (h) => h.split(".").map(Number);
function isCgnat(h) {
  if (!isIPv4(h)) return false;
  const [a, b] = octets(h);
  return a === 100 && (b & 0xc0) === 64;
}
function isPrivateLan(h) {
  if (!isIPv4(h)) return false;
  const [a, b] = octets(h);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}
const isTailnetName = (h) => !isIPv4(h) && !/^\d+(\.\d+)*$/.test(h) && (/^[A-Za-z0-9-]{1,63}$/.test(h) || /^([A-Za-z0-9-]{1,63}\.)+ts\.net$/i.test(h));
/** May a join code (or a joined config) point at this host? */
const isOwnNetworkHost = (h) => isPrivateLan(h) || isCgnat(h) || isTailnetName(h);

/** Uppercase, drop "-" and whitespace, O->0, I->1, L->1. */
function normalizeSecret(input) {
  return String(input || "")
    .toUpperCase()
    .replace(/[-\s]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

const validSecret = (s) => s.length === SECRET_LEN && [...s].every((c) => ALPHABET.includes(c));

function formatSecret(secret) {
  const s = normalizeSecret(secret);
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

function hmacHex(secret, parts) {
  return crypto.createHmac("sha256", Buffer.from(normalizeSecret(secret), "utf8")).update(parts.join("\n"), "utf8").digest("hex");
}

function clientMac(secret, clientNonce, m) {
  return hmacHex(secret, ["rbj1/client", clientNonce, m.hostname, m.os, m.arch, m.mode]);
}

function serverMac(secret, clientNonce, serverNonce, joinId, fp) {
  return hmacHex(secret, ["rbj1/server", clientNonce, serverNonce, joinId, fp]);
}

function matchCode(secret, clientNonce, serverNonce) {
  const mac = Buffer.from(hmacHex(secret, ["rbj1/match", clientNonce, serverNonce]), "hex");
  return String(mac.readUInt32BE(0) % 1000000).padStart(6, "0");
}

function pollAuth(secret, joinId) {
  return hmacHex(secret, ["rbj1/poll", joinId]);
}

/** Constant-time compare of two lowercase hex strings of 64 chars. */
function hexEqual(a, b) {
  const x = String(a || "").toLowerCase();
  const y = String(b || "").toLowerCase();
  if (!HEX64.test(x) || !HEX64.test(y)) return false;
  return crypto.timingSafeEqual(Buffer.from(x, "hex"), Buffer.from(y, "hex"));
}

function verifyServerMac(secret, clientNonce, serverNonce, joinId, fp, got) {
  return hexEqual(serverMac(secret, clientNonce, serverNonce, joinId, fp), got);
}

const displayMatch = (code) => `${String(code).slice(0, 3)} ${String(code).slice(3, 6)}`;
const newNonce = () => crypto.randomBytes(16).toString("hex");

/**
 * `<SECRET4-4-4>@<host>[,<host>...][:<port>]`. Split on the LAST "@"; the port is a trailing
 * ":<digits>" on the host list. A pasted "npx ringback-join <code>" line works too.
 */
function parseCode(raw) {
  const text = String(raw || "").trim().split(/\s+/).pop() || "";
  const at = text.lastIndexOf("@");
  if (at <= 0) throw new Error(BAD_CODE);
  const secret = normalizeSecret(text.slice(0, at));
  let list = text.slice(at + 1);
  let port = DEFAULT_PORT;
  const m = /:(\d{1,5})$/.exec(list);
  if (m) {
    port = Number(m[1]);
    list = list.slice(0, -m[0].length);
  }
  const hosts = list.split(",").map((h) => h.trim()).filter(Boolean);
  const ok = validSecret(secret) && hosts.length > 0 && hosts.every((h) => HOST.test(h)) && port >= 1 && port <= 65535;
  if (!ok) throw new Error(BAD_CODE);
  if (!hosts.every(isOwnNetworkHost)) throw new Error(OUTSIDE);
  return { secret, hosts, port };
}

module.exports = {
  ALPHABET,
  DEFAULT_PORT,
  BAD_CODE,
  OUTSIDE,
  isIPv4,
  isCgnat,
  isPrivateLan,
  isTailnetName,
  isOwnNetworkHost,
  normalizeSecret,
  formatSecret,
  clientMac,
  serverMac,
  matchCode,
  pollAuth,
  hexEqual,
  verifyServerMac,
  displayMatch,
  newNonce,
  parseCode,
};
