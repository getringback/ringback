"use strict";
// Minimal RFC 6455 WebSocket client over the phone's pinned TLS socket (spec 04 section 5.3).
// Node's global WebSocket cannot reuse a socket whose certificate was pinned before any byte
// was sent, so this is hand-written. Client frames are masked; the phone only sends control
// and small text messages (max 64 KB). The helper pings every 2 s and answers pings at once
// (NanoWSD counts pongs and data frames as liveness, and its socket read timeout is 5 s).

const crypto = require("crypto");
const { EventEmitter } = require("events");
const { RingbackError, pinnedSocket, plainSocket, connectMs, parseHost, hostHeader } = require("./client.js");
const hostOrder = require("./hosts.js");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_INBOUND = 64 * 1024;
const MAX_HEADER = 16 * 1024;
const PING_MS = 2000;
// No byte from the phone for this long: the socket is dead (a phone network bound, not an AI one).
const DEAD_MS = 20000;

const OP = { cont: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 };

function encodeFrame(opcode, payload, mask = crypto.randomBytes(4)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const len = data.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, 0x80 | len]);
  else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i += 1) body[i] = data[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

const acceptFor = (key) => crypto.createHash("sha1").update(key + GUID).digest("base64");

class WsClient extends EventEmitter {
  constructor(socket, leftover = Buffer.alloc(0), { pingMs = PING_MS, deadMs = DEAD_MS } = {}) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.parts = null;
    this.partOp = 0;
    this.closed = false;
    this.lastIn = Date.now();
    socket.setTimeout(0);
    socket.setNoDelay(true);
    socket.on("data", (c) => this.onData(c));
    socket.on("close", () => this.finish(1006, "socket closed"));
    socket.on("error", (err) => this.emit("socketError", err));
    this.pinger = setInterval(() => {
      if (Date.now() - this.lastIn > deadMs) {
        this.socket.destroy();
        return;
      }
      this.ping();
    }, pingMs);
    if (this.pinger.unref) this.pinger.unref();
    if (leftover.length) this.onData(leftover);
  }

  get writableLength() {
    return this.socket.writableLength || 0;
  }

  write(op, payload) {
    if (this.closed || this.socket.destroyed || this.socket.writableEnded) return false;
    this.socket.write(encodeFrame(op, payload));
    return true;
  }

  sendText(text) {
    return this.write(OP.text, typeof text === "string" ? text : JSON.stringify(text));
  }

  sendBinary(buf) {
    return this.write(OP.binary, buf);
  }

  ping(data = Buffer.alloc(0)) {
    return this.write(OP.ping, data);
  }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    const r = Buffer.from(String(reason).slice(0, 100));
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    this.write(OP.close, p);
    this.socket.end();
    const t = setTimeout(() => this.socket.destroy(), 1000);
    if (t.unref) t.unref();
    this.finish(code, reason);
  }

  finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pinger);
    this.emit("close", code, reason);
  }

  onData(chunk) {
    this.lastIn = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const f = this.readFrame();
      if (!f) return;
      if (this.closed) return;
      this.onFrame(f);
    }
  }

  readFrame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = Boolean(b[0] & 0x80);
    const op = b[0] & 15;
    const masked = Boolean(b[1] & 0x80);
    let len = b[1] & 127;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(MAX_INBOUND)) {
        this.close(1009, "message too big");
        return null;
      }
      len = Number(big);
      off = 10;
    }
    if (len > MAX_INBOUND) {
      this.close(1009, "message too big");
      return null;
    }
    const need = off + (masked ? 4 : 0) + len;
    if (b.length < need) return null;
    const data = Buffer.from(b.subarray(off + (masked ? 4 : 0), need));
    if (masked) {
      const key = b.subarray(off, off + 4);
      for (let i = 0; i < data.length; i += 1) data[i] ^= key[i & 3];
    }
    this.buf = b.subarray(need);
    return { fin, op, data };
  }

  onFrame({ fin, op, data }) {
    if (op === OP.ping) return this.write(OP.pong, data);
    if (op === OP.pong) return this.emit("pong", data);
    if (op === OP.close) {
      const code = data.length >= 2 ? data.readUInt16BE(0) : 1005;
      if (!this.socket.destroyed) this.socket.end(encodeFrame(OP.close, data.subarray(0, 2)));
      return this.finish(code, data.subarray(2).toString("utf8"));
    }
    if (op === OP.text || op === OP.binary) {
      if (fin) return this.deliver(op, data);
      this.parts = [data];
      this.partOp = op;
      return undefined;
    }
    if (op === OP.cont && this.parts) {
      this.parts.push(data);
      const total = this.parts.reduce((n, p) => n + p.length, 0);
      if (total > MAX_INBOUND) return this.close(1009, "message too big");
      if (fin) {
        const all = Buffer.concat(this.parts);
        this.parts = null;
        return this.deliver(this.partOp, all);
      }
    }
    return undefined;
  }

  deliver(op, data) {
    if (op === OP.text) this.emit("text", data.toString("utf8"));
    else this.emit("binary", data);
  }
}

function readHead(socket) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (c) => {
      buf = Buffer.concat([buf, c]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buf.length > MAX_HEADER) done(new Error("response header too large"));
        return;
      }
      done(null, { head: buf.subarray(0, end).toString("latin1"), rest: buf.subarray(end + 4) });
    };
    const onEnd = () => done(Object.assign(new Error("connection closed during the upgrade"), { lost: true }));
    const onErr = (e) => done(Object.assign(e, { lost: true }));
    function done(err, v) {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("close", onEnd);
      socket.off("error", onErr);
      if (err) reject(err);
      else resolve(v);
    }
    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("close", onEnd);
    socket.on("error", onErr);
  });
}

function readRest(socket, first, length) {
  return new Promise((resolve) => {
    let buf = first;
    const finish = () => resolve(buf.toString("utf8"));
    if (buf.length >= length) return finish();
    socket.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
      if (buf.length >= length || buf.length > MAX_HEADER) finish();
    });
    socket.on("end", finish);
    socket.on("close", finish);
    const t = setTimeout(finish, 3000);
    if (t.unref) t.unref();
    return undefined;
  });
}

/** Upgrade an open socket. Resolves a WsClient; a refusal rejects with RingbackError(status). */
async function handshake(socket, { host, route, token, protocol = "ringback.v1", wsOpts }) {
  const key = crypto.randomBytes(16).toString("base64");
  socket.write(
    `GET ${route} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: ${protocol}\r\n` +
      `Authorization: Bearer ${token}\r\n\r\n`,
  );
  const { head, rest } = await readHead(socket);
  const [statusLine, ...lines] = head.split("\r\n");
  const status = Number((/^HTTP\/1\.[01] (\d{3})/.exec(statusLine) || [])[1]);
  const headers = {};
  for (const l of lines) {
    const i = l.indexOf(":");
    if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  if (status !== 101) {
    const text = await readRest(socket, rest, Number(headers["content-length"]) || MAX_HEADER);
    socket.destroy();
    let body = {};
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
    throw new RingbackError(`Phone refused the stream: ${body.detail || body.status || `HTTP ${status || "?"}`}`, status || 0, body);
  }
  // Only the accept key is checked: NanoWSD may omit or alter the subprotocol header.
  if (headers["sec-websocket-accept"] !== acceptFor(key)) {
    socket.destroy();
    throw new RingbackError("Phone sent a bad WebSocket accept key", 0, null);
  }
  return new WsClient(socket, rest, wsOpts);
}

/** Open wss://<phone>/<route>, pinned, trying the phone's hosts in order like client.request. */
async function connect(cfg, route, opts = {}) {
  const token = cfg.agent_token;
  if (cfg.url_override) {
    const u = new URL(cfg.url_override);
    const socket = await plainSocket(u.hostname, Number(u.port || 80), connectMs(cfg));
    return handshake(socket, { host: u.host, route, token, ...opts });
  }
  const { hosts, port, fp } = cfg.phone;
  const errors = [];
  for (const h of hostOrder.preferredHosts(hosts)) {
    let socket;
    let target;
    try {
      // A host entry may carry its own port (step 3: the embedded node's 127.0.0.1:47880 forward).
      target = parseHost(h, port);
      socket = await pinnedSocket(target.host, target.port, fp, connectMs(cfg));
    } catch (err) {
      if (err instanceof RingbackError) throw err;
      hostOrder.markFailed(h);
      errors.push(`${h}: ${err.code || err.message}`);
      continue;
    }
    try {
      const ws = await handshake(socket, { host: hostHeader(target), route, token, ...opts });
      hostOrder.markGood(h);
      return ws;
    } catch (err) {
      if (!err.lost) throw err;
      hostOrder.markFailed(h);
      errors.push(`${h}: connection lost`);
    }
  }
  throw new RingbackError(`Cannot reach the phone for a stream (${errors.join("; ")})`, 0, null);
}

module.exports = { connect, handshake, WsClient, encodeFrame, acceptFor, OP, MAX_INBOUND };
