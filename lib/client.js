"use strict";
// HTTP client for the Ringback agent API served by the phone itself.
// TLS is pinned to the phone's self-signed certificate fingerprint: the handshake is
// finished and checked BEFORE any byte of the request (and the token) is sent.
// No request timeout: a call waits for the person to pick up and finish speaking. Connection
// setup has a short bound, and every request has a socket IDLE bound of its own wait plus 90 s
// (FOLLOWUPS item 8: a phone network timeout, not an AI call timeout): a long-poll whose Wi-Fi
// socket died silently when the phone moved to mobile data is destroyed and the next host
// (Tailscale first after a failure) is tried, instead of hanging forever.

const http = require("http");
const tls = require("tls");
const hostOrder = require("./hosts.js");

const CONNECT_MS = 4000;
// Silence allowed on a request socket beyond the request's own wait (FOLLOWUPS item 8).
const IDLE_GRACE_MS = 90 * 1000;
// Methods safe to send again on another host when the first socket died mid-request. A POST
// (say, place a call, hang up) is never resent: the phone may already have acted on it.
const RETRIABLE = new Set(["GET", "PUT", "DELETE"]);

class RingbackError extends Error {
  constructor(message, status, body, code) {
    super(message);
    this.status = status;
    this.body = body;
    if (code) this.code = code;
  }
}

// 401 statuses of a machine key (spec 03 section 6): the phone removed this machine, or the key
// is used from the wrong node / off Tailscale.
const KEY_ERRORS = {
  revoked: "This machine was removed from Ringback on the phone. To add it again, tell this session \"add this computer to my phone\".",
  wrong_machine: "This key belongs to another machine or may only be used over Tailscale.",
};

/**
 * One phone.hosts entry as { host, port }: "host:port", "[v6]:port", "[v6]", a bare IPv6 or a
 * bare host (port = `defaultPort`).
 */
function parseHost(entry, defaultPort) {
  const e = String(entry || "").trim();
  const br = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(e);
  if (br) return { host: br[1], port: br[2] ? Number(br[2]) : Number(defaultPort) };
  if ((e.match(/:/g) || []).length > 1) return { host: e, port: Number(defaultPort) };
  const m = /^(.*):(\d{1,5})$/.exec(e);
  return m ? { host: m[1], port: Number(m[2]) } : { host: e, port: Number(defaultPort) };
}

const hostHeader = ({ host, port }) => (host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`);

const normFp = (fp) => String(fp || "").replace(/[^0-9a-f]/gi, "").toLowerCase();

// Hooks pass a shorter bound (cfg.connect_ms) so an unreachable phone never stalls a session.
const connectMs = (cfg) => (cfg && Number(cfg.connect_ms) > 0 ? Number(cfg.connect_ms) : CONNECT_MS);

function pinnedSocket(host, port, fp, ms = CONNECT_MS) {
  return new Promise((resolve, reject) => {
    const servername = /^[\d.]+$/.test(host) || host.includes(":") ? undefined : host;
    const socket = tls.connect({ host, port, servername, rejectUnauthorized: false });
    const timer = setTimeout(() => socket.destroy(new Error("connect timeout")), ms);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      const got = normFp(socket.getPeerCertificate().fingerprint256);
      if (!got || got !== normFp(fp)) {
        socket.destroy();
        return reject(new RingbackError(`Refused ${host}: certificate does not match the paired phone`, 0, null));
      }
      resolve(socket);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function plainSocket(host, port, ms = CONNECT_MS) {
  return new Promise((resolve, reject) => {
    const net = require("net");
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => socket.destroy(new Error("connect timeout")), ms);
    socket.once("connect", () => (clearTimeout(timer), resolve(socket)));
    socket.once("error", (err) => (clearTimeout(timer), reject(err)));
  });
}

/** Idle bound for one request: its own wait (seconds), plus extra time, plus the grace. */
function idleMs(cfg, opts = {}) {
  const grace = cfg && Number(cfg.idle_grace_ms) > 0 ? Number(cfg.idle_grace_ms) : IDLE_GRACE_MS;
  return Math.max(0, Number(opts.waitS) || 0) * 1000 + Math.max(0, Number(opts.extraMs) || 0) + grace;
}

function unreachable(cfg, errors) {
  const name = (cfg.phone && cfg.phone.name) || "the phone";
  return new RingbackError(
    `Cannot reach ${name} (${errors.join("; ")}). Is the phone on the same Wi-Fi or Tailscale, with Ringback running?`,
    0,
    null,
  );
}

function parseBody(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function settle(res, resolve, reject) {
  const chunks = [];
  let ended = false;
  const lost = () => reject(Object.assign(new RingbackError("Lost the phone before its answer finished arriving", 0, null), { lost: true }));
  res.on("data", (c) => chunks.push(c));
  res.on("aborted", lost);
  res.on("error", lost);
  res.on("close", () => {
    if (!ended) lost();
  });
  res.on("end", () => {
    ended = true;
    const data = parseBody(Buffer.concat(chunks).toString("utf8"));
    if (res.statusCode >= 200 && res.statusCode < 300) return resolve(data);
    if (res.statusCode === 409) return resolve({ ...data, status: data.status || "busy" });
    if (res.statusCode === 503) return resolve({ ...data, status: data.status || "not_ready" });
    // Conference: wait_your_turn, too_many_queued, full (spec 01 section 5).
    if (res.statusCode === 429) return resolve({ ...data, status: data.status || "too_many" });
    if (res.statusCode === 401 && KEY_ERRORS[data.status]) {
      return reject(new RingbackError(KEY_ERRORS[data.status], 401, data, data.status));
    }
    const why = data.detail || data.error || data.raw || `HTTP ${res.statusCode}`;
    reject(new RingbackError(`Phone said: ${typeof why === "string" ? why : JSON.stringify(why)}`, res.statusCode, data));
  });
}

/** One request on an open socket; a socket silent for `idle` ms is destroyed (err.lost, err.idle). */
function send(cfg, socket, host, method, route, payload, idle, extraHeaders = null) {
  const auth = cfg.agent_token ? { Authorization: `Bearer ${cfg.agent_token}` } : {};
  const headers = { Host: host, ...auth, Accept: "application/json", Connection: "close", ...(extraHeaders || {}) };
  if (payload) Object.assign(headers, { "Content-Type": "application/json", "Content-Length": payload.length });
  return new Promise((resolve, reject) => {
    let idleOut = false;
    socket.setTimeout(idle, () => {
      idleOut = true;
      socket.destroy(new Error("idle timeout"));
    });
    const lostErr = (why) =>
      Object.assign(new RingbackError(`Lost the phone mid-request: ${why}`, 0, null), { lost: true, idle: idleOut });
    const req = http.request({ method, path: route, headers, createConnection: () => socket }, (res) =>
      settle(res, resolve, (err) => reject(err.lost ? Object.assign(err, { idle: idleOut }) : err)),
    );
    req.on("error", (err) => reject(lostErr(idleOut ? "no answer for too long" : err.message)));
    if (payload) req.write(payload);
    req.end();
  });
}

async function request(cfg, method, route, body, opts = {}) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const idle = idleMs(cfg, opts);
  if (cfg.url_override) {
    const u = new URL(cfg.url_override);
    const socket = await plainSocket(u.hostname, Number(u.port || 80), connectMs(cfg));
    return send(cfg, socket, u.host, method, route, payload, idle, opts.headers);
  }
  const { hosts, port, fp } = cfg.phone;
  const errors = [];
  for (const h of hostOrder.preferredHosts(hosts)) {
    const target = parseHost(h, port);
    let socket;
    try {
      socket = await pinnedSocket(target.host, target.port, fp, connectMs(cfg));
    } catch (err) {
      if (err instanceof RingbackError) throw err;
      hostOrder.markFailed(h);
      errors.push(`${h}: ${err.code || err.message}`);
      continue;
    }
    try {
      const out = await send(cfg, socket, hostHeader(target), method, route, payload, idle, opts.headers);
      hostOrder.markGood(h);
      return out;
    } catch (err) {
      if (!err.lost) {
        // The phone answered (with an error status): this host works.
        hostOrder.markGood(h);
        throw err;
      }
      // The socket died or went silent: the next request starts on another host.
      hostOrder.markFailed(h);
      if (!RETRIABLE.has(method)) throw err;
      errors.push(`${h}: ${err.idle ? "no answer for too long" : "connection lost"}`);
    }
  }
  throw unreachable(cfg, errors);
}

/**
 * TLS without a pin yet (join, spec 03 section 7.2): the handshake finishes, the peer
 * certificate's sha256 is recorded, and the caller decides (server_mac) whether to trust it.
 */
function captureSocket(host, port, ms = CONNECT_MS) {
  return new Promise((resolve, reject) => {
    const servername = /^[\d.]+$/.test(host) || host.includes(":") ? undefined : host;
    const socket = tls.connect({ host, port, servername, rejectUnauthorized: false });
    const timer = setTimeout(() => socket.destroy(new Error("connect timeout")), ms);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      resolve({ socket, fp: normFp(socket.getPeerCertificate().fingerprint256) });
    });
    socket.once("error", (err) => (clearTimeout(timer), reject(err)));
  });
}

// settle() resolves (not rejects) a 409, 429 or 503 with the body: give the join callers the
// real HTTP status back so a refusal is never read as an accepted 202.
const RESOLVED_STATUS = { busy: 409, too_many: 429, denied_recently: 429, not_ready: 503 };
const joinStatus = (out) => (out && out.status !== "pending" && RESOLVED_STATUS[out.status]) || 202;

/** POST /v1/join (no bearer) on a fingerprint-recording socket: { status, body, fp }. */
async function joinStart(target, body, ms = CONNECT_MS) {
  const { socket, fp } = await captureSocket(target.host, target.port, ms);
  const payload = Buffer.from(JSON.stringify(body));
  try {
    const out = await send({ agent_token: "" }, socket, hostHeader(target), "POST", "/v1/join", payload, idleMs(null));
    return { status: joinStatus(out), body: out, fp };
  } catch (err) {
    if (err instanceof RingbackError && err.status) return { status: err.status, body: err.body || {}, fp };
    throw err;
  }
}

/** POST /v1/join/request (rbj2, no code, FOLLOWUPS item 51) on a fingerprint-recording socket. */
async function joinAsk(target, body, ms = CONNECT_MS) {
  const { socket, fp } = await captureSocket(target.host, target.port, ms);
  const payload = Buffer.from(JSON.stringify(body));
  try {
    const out = await send({ agent_token: "" }, socket, hostHeader(target), "POST", "/v1/join/request", payload, idleMs(null));
    return { status: joinStatus(out), body: out, fp };
  } catch (err) {
    if (err instanceof RingbackError && err.status) return { status: err.status, body: err.body || {}, fp };
    throw err;
  }
}

/**
 * GET /v1/health (no auth) on a fingerprint-recording socket: is a Ringback phone listening at
 * `target`? { body, fp }, or throws when nothing (or something else) answers.
 */
async function healthProbe(target, ms = CONNECT_MS) {
  const { socket, fp } = await captureSocket(target.host, target.port, ms);
  const body = await send({ agent_token: "" }, socket, hostHeader(target), "GET", "/v1/health", null, ms);
  if (!body || body.ok !== true) throw new Error("not a Ringback phone");
  return { body, fp };
}

/** GET /v1/join/{id} over the normal pinned socket (the fp the 202 proved). */
function joinPoll(target, joinId, auth, waitS = 50, confirm = "") {
  const cfg = { agent_token: "", phone: { name: "the phone", port: target.port, hosts: [hostHeader(target)], fp: target.fp } };
  return request(cfg, "GET", `/v1/join/${encodeURIComponent(joinId)}?wait_s=${waitS}`, undefined, {
    waitS,
    // rbj2: proof that the user read the phone's code to this computer (51 APP CONTRACT 5).
    headers: { "X-Ringback-Join": auth, ...(confirm ? { "X-Ringback-Confirm": confirm } : {}) },
  });
}

const id = (v) => encodeURIComponent(v);
// A say first waits for the call to be answered (ring), then speaks: allow the ring and about
// 8 characters a second of speech on top of the listen wait, so a long say is never cut.
const RING_MS = 60 * 1000;
const HANGUP_WAIT_S = 15;
const PHOTO_WAIT_S = 300;
// Countdown, capture and encode on the phone after the tap.
const PHOTO_EXTRA_MS = 15 * 1000;
const sayIdle = (text, waitS) => ({ waitS, extraMs: RING_MS + Math.ceil(String(text || "").length / 8) * 1000 });
// participant_id only when given, so a 1:1 request body is exactly today's.
const withPid = (body, pid) => (pid ? { ...body, participant_id: pid } : body);
// The caller's own session id (FOLLOWUPS item 11), also only when known.
const withSid = (body, sid) => (sid ? { ...body, session_id: sid } : body);
// from: "owner" only when asked (spec 02 section 7.2), so other bodies stay as they were.
const withFrom = (body, from) => (from ? { ...body, from } : body);
const api = {
  health: (cfg) => request(cfg, "GET", "/v1/health"),
  placeCall: (cfg, caller, reason, message, sid) => request(cfg, "POST", "/v1/calls", withSid({ caller, reason, message }, sid)),
  say: (cfg, cid, text, listen = true, waitS = 120, pid, sid, from) =>
    request(cfg, "POST", `/v1/calls/${id(cid)}/say`, withFrom(withSid(withPid({ text, listen, wait_s: waitS }, pid), sid), from), sayIdle(text, listen ? waitS : 0)),
  listen: (cfg, cid, waitS = 120, pid, sid, from) =>
    request(cfg, "POST", `/v1/calls/${id(cid)}/listen`, withFrom(withSid(withPid({ wait_s: waitS }, pid), sid), from), { waitS, extraMs: RING_MS }),
  phoneControl: (cfg, cid, action, body) => request(cfg, "POST", `/v1/calls/${id(cid)}/phone/${action}`, body || {}),
  hangup: (cfg, cid, text, pid, sid) =>
    request(cfg, "POST", `/v1/calls/${id(cid)}/hangup`, withSid(withPid(text ? { text } : {}, pid), sid), sayIdle(text || "", HANGUP_WAIT_S)),
  participants: (cfg, cid) => request(cfg, "GET", `/v1/calls/${id(cid)}/participants`),
  invite: (cfg, cid, pid, session, note) =>
    request(cfg, "POST", `/v1/calls/${id(cid)}/participants`, { session, invited_by: pid, ...(note ? { note } : {}) }),
  leave: (cfg, cid, pid, goodbye) =>
    request(cfg, "DELETE", `/v1/calls/${id(cid)}/participants/${id(pid)}`, goodbye ? { goodbye } : {}),
  transcript: (cfg, cid, pid, since) =>
    request(cfg, "GET", `/v1/calls/${id(cid)}/transcript?participant_id=${id(pid)}${since ? `&since=${id(since)}` : ""}`),
  getCall: (cfg, cid) => request(cfg, "GET", `/v1/calls/${id(cid)}`),
  wallpaperPreview: (cfg) => request(cfg, "GET", "/v1/wallpaper/preview"),
  searchCalls: (cfg, q = {}) => {
    const params = ["query", "since", "until", "session", "limit"]
      .filter((k) => q[k] !== undefined && q[k] !== null && q[k] !== "")
      .map((k) => `${k}=${encodeURIComponent(String(q[k]))}`);
    return request(cfg, "GET", `/v1/calls?${params.join("&")}`);
  },
  // tag: the session this note is about; the phone withdraws it once that session no longer needs them.
  // Taps and replies on cards, for every computer of this phone (helper/card-taps.js long-polls it).
  events: (cfg, since = "", waitS = 0) => request(cfg, "GET", `/v1/events?since=${id(since)}&wait_s=${waitS}`, undefined, { waitS }),
  putCard: (cfg, cardId, body) => request(cfg, "PUT", `/v1/cards/${id(cardId)}`, body),
  notify: (cfg, title, body, tag) => request(cfg, "POST", "/v1/notify", { title, body, ...(tag ? { tag } : {}) }),
  // FOLLOWUPS 51 SETUP CONTRACT: remote guests setup state, and the phone's own Tailscale key.
  guestsSetup: (cfg) => request(cfg, "GET", "/v1/guests/setup"),
  saveGuestsSetup: (cfg, body) => request(cfg, "POST", "/v1/guests/setup", body),
  // PERMISSION TAP CONTRACT (FOLLOWUPS): a pending permission they allow or deny by a tap.
  requestApproval: (cfg, body) => request(cfg, "POST", "/v1/approvals", body),
  approvalStatus: (cfg, aid, waitS = 50) => request(cfg, "GET", `/v1/approvals/${id(aid)}?wait_s=${waitS}`, undefined, { waitS }),
  cancelApproval: (cfg, aid) => request(cfg, "DELETE", `/v1/approvals/${id(aid)}`),
  // Every live session the phone knows, on all the user's computers (tools/conference.js list_sessions).
  listSessions: (cfg) => request(cfg, "GET", "/v1/sessions"),
  putSession: (cfg, sid, body) => request(cfg, "PUT", `/v1/sessions/${id(sid)}`, body),
  // FOLLOWUPS item 45: one generated picture (or the error) for the phone's "Make a picture" sheet.
  avatarOption: (cfg, sid, body) => request(cfg, "POST", `/v1/sessions/${id(sid)}/avatar-options`, body),
  deleteSession: (cfg, sid) => request(cfg, "DELETE", `/v1/sessions/${id(sid)}`),
  sessionInbox: (cfg, sid, since, waitS = 0) =>
    request(cfg, "GET", `/v1/sessions/${id(sid)}/inbox?wait_s=${waitS}${since ? `&since=${id(since)}` : ""}`, undefined, { waitS }),
  // New sessions from the phone (FOLLOWUPS items 21, 21b).
  putMachine: (cfg, machine, body) => request(cfg, "PUT", `/v1/machines/${id(machine)}`, body),
  answerStart: (cfg, machine, startId, status, detail) =>
    request(cfg, "POST", `/v1/machines/${id(machine)}/starts/${id(startId)}`, { status, ...(detail ? { detail } : {}) }),
  startSession: (cfg, cid, body) => request(cfg, "POST", `/v1/calls/${id(cid)}/sessions`, body),
  // Camera and images (BUILD_PLAN A6). take_photo waits for the user's tap (a human wait, up to the
  // phone's wait_s: 60 s in a call, 300 s outside), so the socket idle bound covers the longest.
  takePhoto: (cfg, body) =>
    request(cfg, "POST", "/v1/photos", body, { waitS: body.wait_s !== undefined ? Number(body.wait_s) : PHOTO_WAIT_S, extraMs: PHOTO_EXTRA_MS }),
  getImage: (cfg, imageId, detail) => request(cfg, "GET", `/v1/images/${id(imageId)}${detail ? `?detail=${id(detail)}` : ""}`),
  deleteImage: (cfg, imageId) => request(cfg, "DELETE", `/v1/images/${id(imageId)}`),
  machineInbox: (cfg, machine, since, waitS = 50) =>
    request(cfg, "GET", `/v1/inbox?machine=${id(machine)}&wait_s=${waitS}${since ? `&since=${id(since)}` : ""}`, undefined, { waitS }),
  // Machines (spec 03 section 6, contract "Phone HTTP API added by step 3").
  machine: (cfg) => request(cfg, "GET", "/v1/machine"),
  reportMachine: (cfg, body) => request(cfg, "PUT", "/v1/machine", body),
  control: (cfg, since, waitS = 50) =>
    request(cfg, "GET", `/v1/machine/control?since=${id(since || "")}&wait_s=${waitS}`, undefined, { waitS }),
  joinStart,
  joinAsk,
  healthProbe,
  joinPoll,
  // Images (BUILD_PLAN A6, shared by camera 05 and phone screen 06).
  callImages: (cfg, cid, source, since, waitS = 30, limit = 4) =>
    request(cfg, "GET", `/v1/calls/${id(cid)}/images?source=${id(source)}&since=${id(since || 0)}&wait_s=${waitS}&limit=${limit}`, undefined, { waitS }),
  // Phone screen (spec 06 section 5.1). There is no start route: only the user's tap starts a share.
  screenState: (cfg, cid, waitS = 0, state) =>
    request(cfg, "GET", `/v1/calls/${id(cid)}/screen?wait_s=${waitS}${state !== undefined ? `&state=${id(state)}` : ""}`, undefined, { waitS }),
  screenRequest: (cfg, cid, reason) => request(cfg, "POST", `/v1/calls/${id(cid)}/screen/request`, { reason }),
  screenWatch: (cfg, cid, everyS) => request(cfg, "POST", `/v1/calls/${id(cid)}/screen/watch`, { every_s: everyS }),
  screenStop: (cfg, cid) => request(cfg, "POST", `/v1/calls/${id(cid)}/screen/stop`, {}),
  screenLatest: (cfg, cid, fresh = true, detail = "standard") =>
    request(cfg, "GET", `/v1/calls/${id(cid)}/screen/latest?fresh=${fresh ? 1 : 0}&detail=${id(detail)}`, undefined, { extraMs: 5000 }),
};

module.exports = { request, api, RingbackError, normFp, idleMs, IDLE_GRACE_MS, parseHost, hostHeader, KEY_ERRORS, captureSocket, pinnedSocket, plainSocket, connectMs };
