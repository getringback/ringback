"use strict";
// A small DNS-SD browser (RFC 6762 / 6763) for the phone's `_ringback._tcp` service on the same
// Wi-Fi (FOLLOWUPS item 51). Plain UDP from Node: no dependency, no OS tool, same on Windows,
// macOS and Linux. Two sockets ask: one on an ephemeral port (legacy unicast answers, which every
// responder must send back to that port) and one bound to 5353 with SO_REUSEADDR in the mDNS
// group (multicast answers). Either may fail to open; the other still works.

const dgram = require("dgram");
const os = require("os");

const GROUP = "224.0.0.251";
const PORT = 5353;
const SERVICE = "_ringback._tcp.local";
const T = { A: 1, PTR: 12, TXT: 16, SRV: 33 };
const BROWSE_MS = 2000;
const RESEND_AT = [0, 600, 1300];

function encodeName(name) {
  const parts = String(name).split(".").filter(Boolean);
  const bufs = parts.map((p) => {
    const b = Buffer.from(p, "utf8");
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  return Buffer.concat([...bufs, Buffer.from([0])]);
}

/** One PTR question for `name`. */
function query(name = SERVICE, id = 0) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(T.PTR, 0);
  tail.writeUInt16BE(1, 2);
  return Buffer.concat([header, encodeName(name), tail]);
}

/** A (possibly compressed) name at `off`: { name, next }. Throws on a malformed packet. */
function readName(buf, off) {
  const labels = [];
  let next = -1;
  let pos = off;
  for (let hops = 0; hops < 64; hops += 1) {
    if (pos >= buf.length) throw new Error("name past end");
    const len = buf[pos];
    if (len === 0) {
      if (next < 0) next = pos + 1;
      return { name: labels.join("."), next };
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new Error("pointer past end");
      if (next < 0) next = pos + 2;
      pos = ((len & 0x3f) << 8) | buf[pos + 1];
      continue;
    }
    if (pos + 1 + len > buf.length) throw new Error("label past end");
    labels.push(buf.toString("utf8", pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  throw new Error("name loop");
}

function readTxt(buf, start, end) {
  const out = {};
  let pos = start;
  while (pos < end) {
    const len = buf[pos];
    const s = buf.toString("utf8", pos + 1, Math.min(end, pos + 1 + len));
    pos += 1 + len;
    const eq = s.indexOf("=");
    if (eq > 0) out[s.slice(0, eq).toLowerCase()] = s.slice(eq + 1);
    else if (s) out[s.toLowerCase()] = "";
  }
  return out;
}

function readRecord(buf, off) {
  const { name, next } = readName(buf, off);
  if (next + 10 > buf.length) throw new Error("record past end");
  const type = buf.readUInt16BE(next);
  const len = buf.readUInt16BE(next + 8);
  const start = next + 10;
  const end = start + len;
  if (end > buf.length) throw new Error("rdata past end");
  const rec = { name: name.toLowerCase(), rawName: name, type };
  if (type === T.PTR) rec.target = readName(buf, start).name;
  else if (type === T.SRV && len >= 7) Object.assign(rec, { port: buf.readUInt16BE(start + 4), target: readName(buf, start + 6).name.toLowerCase() });
  else if (type === T.TXT) rec.txt = readTxt(buf, start, end);
  else if (type === T.A && len === 4) rec.ip = [...buf.subarray(start, end)].join(".");
  return { rec, next: end };
}

/** Every resource record of a DNS message (questions skipped); [] for a malformed one. */
function parse(buf) {
  try {
    if (buf.length < 12) return [];
    const qd = buf.readUInt16BE(4);
    const total = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
    let off = 12;
    for (let i = 0; i < qd; i += 1) off = readName(buf, off).next + 4;
    const out = [];
    for (let i = 0; i < total; i += 1) {
      const { rec, next } = readRecord(buf, off);
      out.push(rec);
      off = next;
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Phones from collected records: [{ instance, ip, port, txt }]. `from` maps an instance to the
 * address the answer came from (used when no A record came along).
 */
function collect(records, from = {}) {
  const instances = new Map();
  const srv = new Map();
  const txt = new Map();
  const a = new Map();
  for (const r of records) {
    if (r.type === T.PTR && r.name === SERVICE && r.target) instances.set(r.target.toLowerCase(), r.target);
    if (r.type === T.SRV) srv.set(r.name, r);
    if (r.type === T.TXT) txt.set(r.name, r.txt);
    if (r.type === T.A) a.set(r.name, r.ip);
  }
  const out = [];
  for (const [key, raw] of instances) {
    const s = srv.get(key);
    const ip = (s && a.get(s.target)) || from[key];
    if (!ip) continue;
    const label = raw.endsWith(`.${SERVICE}`) ? raw.slice(0, -SERVICE.length - 1) : raw;
    out.push({ instance: label, ip, port: (s && s.port) || 47870, txt: txt.get(key) || {} });
  }
  return out;
}

const ipv4s = () =>
  Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);

function openSocket(bindPort, joinGroup) {
  return new Promise((resolve) => {
    const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
    s.once("error", () => {
      try {
        s.close();
      } catch {
        // Not open.
      }
      resolve(null);
    });
    s.bind(bindPort, () => {
      if (joinGroup) {
        for (const ip of ipv4s()) {
          try {
            s.addMembership(GROUP, ip);
          } catch {
            // That interface has no multicast.
          }
        }
      }
      s.removeAllListeners("error");
      s.on("error", () => {});
      resolve(s);
    });
  });
}

/**
 * Sends `packet` out of every IPv4 interface, one after the other: a send is queued, so the
 * multicast interface may only change once the previous send has left.
 */
async function sendAll(s, packet) {
  const ifaces = ipv4s();
  for (const ip of ifaces.length ? ifaces : [null]) {
    await new Promise((resolve) => {
      try {
        if (ip) s.setMulticastInterface(ip);
        s.send(packet, PORT, GROUP, () => resolve());
      } catch {
        // Interface gone, or the socket closed.
        resolve();
      }
    });
  }
}

/** Browses `_ringback._tcp` on every IPv4 interface for `ms`; resolves with the phones found. */
async function browse({ ms = BROWSE_MS } = {}) {
  const sockets = (await Promise.all([openSocket(0, false), openSocket(PORT, true)])).filter(Boolean);
  if (!sockets.length) return [];
  const records = [];
  const from = {};
  for (const s of sockets) {
    s.on("message", (msg, rinfo) => {
      const recs = parse(msg);
      for (const r of recs) if (r.type === T.PTR && r.name === SERVICE && r.target) from[r.target.toLowerCase()] = rinfo.address;
      records.push(...recs);
    });
  }
  const packet = query(SERVICE, 0);
  const timers = RESEND_AT.map((at) => setTimeout(() => sockets.forEach((s) => sendAll(s, packet).catch(() => {})), at));
  await new Promise((r) => setTimeout(r, ms));
  timers.forEach(clearTimeout);
  for (const s of sockets) {
    try {
      s.close();
    } catch {
      // Already closed.
    }
  }
  return collect(records, from);
}

module.exports = { SERVICE, T, query, parse, collect, browse, encodeName, readName };
