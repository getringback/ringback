"use strict";
// Stream loop of the Ringback helper (spec 04 sections 4 and 7.2): live terminals, machine
// screens, the Linux desk and single windows (FOLLOWUPS 22b). It runs next to the inbox loop.
//  - Captures ONLY what the paired phone asked for over the pinned long-poll. There is no local
//    listening port, so no local process can ask for a capture.
//  - Refuses everything on vast.ai (not even caps are sent), and on a restricted host unless a human set
//    streams.allow_dex_box. Desks only where stream-guard deskAllowed() says so.
//  - ffmpeg is spawned with shell:false, windowsHide, stdin ignored, from fixed argv builders,
//    and killed on pause, stream end and helper exit.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn: nodeSpawn } = require("child_process");
const { loadConfig, configDir } = require("../lib/config.js");
const { streamsApi } = require("../lib/streams-api.js");
const ws = require("../lib/ws.js");
const guard = require("../lib/stream-guard.js");
const capture = require("../lib/capture.js");
const { Fmp4Parser } = require("../lib/fmp4.js");
const transcript = require("../lib/transcript.js");
const { createCodexMapper } = require("../lib/codex-rollout.js");
const { inputState, sameState } = require("../lib/view-input.js");
const { sendMedia } = require("../lib/media-transfer.js");
const tmux = require("../lib/tmux.js");
const win = require("../lib/window.js");
const desk = require("../lib/desk.js");
const sessions = require("../lib/sessions.js");
const { redact } = require("../lib/redact.js");
const { buildCaps, ffmpegCommand, MACHINE } = require("../lib/stream-caps.js");

const STREAM_ID = /^[A-Za-z0-9_-]{22}$/;
const CAPS_EVERY_MS = 60 * 1000; // the phone holds caps in memory: an app restart must not leave View broken for long
const POLL_WAIT_S = 50;
const BACKPRESSURE_BYTES = 256 * 1024;
const SESSION_CHECK_MS = 2000;
// A View whose socket dropped tries to reattach this long (FOLLOWUPS 58).
const RECONNECT_FOR_MS = 2 * 60 * 1000;
const REC_MAX_MS = 30 * 60 * 1000;
const REC_MAX_BYTES = 1024 * 1024 * 1024;
const MAX_RAW = 256 * 1024;

// Every ffmpeg this process started; all are killed when the helper exits.
const CHILDREN = new Set();

function killAll() {
  for (const c of CHILDREN) {
    try {
      c.kill();
    } catch {
      // Already gone.
    }
  }
  CHILDREN.clear();
}

let exitHooked = false;
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", killAll);
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      killAll();
      process.exit(0);
    });
  }
}

/** Drop non-key frames while the socket is backed up, until the next keyframe (spec 2.2). */
class FrameGate {
  constructor(limit = BACKPRESSURE_BYTES) {
    this.limit = limit;
    this.waitKey = false;
  }

  admit(key, queued) {
    if (key) {
      this.waitKey = false;
      return true;
    }
    if (this.waitKey) return false;
    if (queued > this.limit) {
      this.waitKey = true;
      return false;
    }
    return true;
  }
}

function frameHeader(key, tsUs) {
  const h = Buffer.alloc(10);
  h[0] = 1;
  h[1] = key ? 1 : 0;
  h.writeBigUInt64BE(BigInt(Math.max(0, Math.round(tsUs))), 2);
  return h;
}

const safeName = (s) => String(s || "machine").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "machine";

function recordingTarget(machine, now = new Date(), dir = path.join(configDir(), "recordings")) {
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}_${p(now.getHours())}-${p(now.getMinutes())}`;
  const base = `${stamp}_${safeName(machine)}`;
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i < 1000; i += 1) {
    const name = i === 1 ? base : `${base}-${i}`;
    const out = path.join(dir, `${name}.mp4`);
    if (!fs.existsSync(out) && !fs.existsSync(`${out}.part`)) return { out, part: `${out}.part` };
  }
  throw new Error("too many recordings this minute");
}

class BaseStream {
  constructor(loop, req) {
    this.loop = loop;
    this.req = req;
    this.id = req.stream_id;
    this.ended = false;
    this.socket = null;
  }

  async open() {
    const o = this.loop.o;
    this.socket = await o.connect(o.cfg(), `/v1/streams/${encodeURIComponent(this.id)}/ws`);
    this.socket.on("text", (t) => {
      let msg;
      try {
        msg = JSON.parse(t);
      } catch {
        return;
      }
      if (msg && typeof msg.type === "string") this.onControl(msg);
    });
    const socket = this.socket;
    socket.on("close", (code, reason) => {
      if (this.socket !== socket || this.ended) return;
      this.loop.o.log(`stream ${this.id}: socket closed (${code || "?"} ${reason || ""})`);
      this.onSocketClose(code, reason);
    });
  }

  /** The phone side of the socket went away without a bye: streams end; the View reconnects. */
  onSocketClose() {
    this.end(null);
  }

  send(obj) {
    if (this.socket && !this.ended && !this.reconnecting) this.socket.sendText(JSON.stringify(obj));
  }

  bye(reason) {
    this.loop.o.log(`stream ${this.id}: bye ${reason}`);
    this.send({ type: "bye", reason });
    this.end(reason);
  }

  end(reason) {
    if (this.ended) return;
    this.ended = true;
    try {
      this.cleanup();
    } catch (err) {
      this.loop.o.log(`stream ${this.id} cleanup: ${err.message}`);
    }
    if (this.socket) this.socket.close(1000, reason || "");
    this.loop.active.delete(this.id);
  }

  cleanup() {}

  onControl(msg) {
    if (msg.type === "stop") this.end("stopped");
  }
}

// Clients whose session has no transcript the helper can read (FOLLOWUPS item 58).
const NO_VIEW = { agy: "Live view is not available for agy: it keeps no documented transcript." };

/** The session's own live view: its transcript, never a window capture (FOLLOWUPS item 58). */
class TerminalStream extends BaseStream {
  async start() {
    await this.open();
    const o = this.loop.o;
    const rec = sessions.readSession(this.req.session_id);
    if (!rec || rec.ended) return this.bye("session_gone");
    this.rec = rec;
    this.client = rec.client || "claude-code";
    this.file = NO_VIEW[this.client] ? null : transcript.safeTranscript(rec.transcript_path, { home: o.home, env: o.env, client: this.client });
    // A transcript outside the client's folder is refused (T10). A session with none yet, or a
    // client that keeps none, stays open with one line saying why, so the phone never reads it
    // as an ended session.
    if (!this.file && rec.transcript_path && !NO_VIEW[this.client]) return this.bye("session_gone");
    if (!this.file) this.send({ type: "lines", lines: [{ kind: "system", text: NO_VIEW[this.client] || "No transcript recorded for this session yet.", t: Date.now() }] });
    this.allowed = new Set();
    this.mediaQueue = Promise.resolve();
    this.sendInputState(rec);
    this.watch = setInterval(() => {
      const now = sessions.readSession(this.req.session_id);
      if (!now || now.ended) return this.bye("session_gone");
      this.rec = now;
      this.sendInputState(now);
      // The first hook that names the transcript starts the view.
      if (!this.file && !NO_VIEW[this.client] && now.transcript_path) {
        this.file = transcript.safeTranscript(now.transcript_path, { home: o.home, env: o.env, client: this.client });
        if (this.file) this.setView(this.req.view === "raw" ? "raw" : "activity");
      }
      return undefined;
    }, o.sessionCheckMs || SESSION_CHECK_MS);
    if (this.file) this.setView(this.req.view === "raw" ? "raw" : "activity");
    return undefined;
  }

  /**
   * FOLLOWUPS 58 (live 14:35: "the view said closed while my typed message still went through"):
   * a View whose socket drops without a bye (Wi-Fi blip, phone dozing, the 20 s dead-socket check)
   * reconnects to the same stream id for up to RECONNECT_FOR_MS, then sends its backlog and typing
   * state again. The phone keeps the stream id while the View is on screen; a 404 ends it.
   */
  onSocketClose() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    if (this.source) this.source.stop();
    this.source = null;
    this.reconnect().finally(() => {
      this.reconnecting = false;
    });
  }

  async reconnect() {
    const o = this.loop.o;
    const until = Date.now() + (o.reconnectForMs || RECONNECT_FOR_MS);
    let wait = o.reconnectFirstMs || 1000;
    while (!this.ended && Date.now() < until) {
      await new Promise((r) => setTimeout(r, wait));
      if (this.ended) return;
      try {
        await this.open();
        this.reconnecting = false;
        o.log(`stream ${this.id}: reconnected`);
        this.inputState = null;
        // The backlog comes again after this: the phone replaces what it shows.
        this.send({ type: "reset" });
        this.sendInputState(sessions.readSession(this.req.session_id) || this.rec);
        if (this.file) this.setView(this.req.view === "raw" ? "raw" : "activity");
        return;
      } catch (err) {
        if (err && err.status === 404) break;
        o.log(`stream ${this.id}: reconnect failed (${err.message})`);
      }
      wait = Math.min(wait * 2, 15000);
    }
    this.end(null);
  }

  rawAvailable() {
    return this.loop.o.platform !== "win32" && tmux.validPane(this.rec.tmux_pane);
  }

  setView(view) {
    if (this.source) this.source.stop();
    this.source = null;
    if (view === "raw" && this.rawAvailable()) {
      this.source = tmux.poll(this.rec.tmux_pane, (text) => this.send({ type: "raw", text: redact(text).slice(-MAX_RAW) }), { exec: this.loop.o.tmuxExec });
      return;
    }
    if (view === "raw") this.send({ type: "notice", text: "Raw view needs the session to run inside tmux" });
    this.source = transcript.tail(this.file, (lines) => {
      this.remember(lines);
      for (const b of transcript.batches(lines)) this.send({ type: "lines", lines: b });
    }, { pollMs: this.loop.o.tailPollMs, mapper: this.client === "codex" ? createCodexMapper() : transcript.createMapper() });
  }

  /** Whether typed text reaches the session now; sent at start and on every change. */
  sendInputState(rec) {
    const st = inputState(this.loop.o.cfg(), rec, this.loop.o.inputDeps);
    if (sameState(st, this.inputState)) return;
    this.inputState = st;
    this.send({ type: "input_state", ...st });
  }

  /** The paths this stream showed: the only files a media_get may ask for. */
  remember(lines) {
    for (const l of lines) for (const c of l.paths || []) if (c.media) this.allowed.add(c.path);
    if (this.allowed.size > 2000) this.allowed = new Set([...this.allowed].slice(-1000));
  }

  /** One media file at a time, in the order asked. */
  media(msg) {
    const o = this.loop.o;
    const io = { send: (m) => this.send(m), queued: () => (this.socket ? this.socket.writableLength : 0), ended: () => this.ended };
    const opts = { allowed: this.allowed, cwd: this.rec.cwd, home: o.home, ffmpeg: o.ffmpeg, spawn: o.spawn };
    this.mediaQueue = this.mediaQueue.then(() => sendMedia(io, msg, opts)).catch((err) => o.log(`stream ${this.id} media: ${err.message}`));
  }

  onControl(msg) {
    if (msg.type === "view" && (msg.view === "raw" || msg.view === "activity")) return this.file ? this.setView(msg.view) : undefined;
    if (msg.type === "media_get") return this.media(msg);
    return super.onControl(msg);
  }

  cleanup() {
    if (this.watch) clearInterval(this.watch);
    if (this.source) this.source.stop();
  }
}

class VideoStream extends BaseStream {
  constructor(loop, req) {
    super(loop, req);
    this.preset = capture.presetFor(req.preset);
    this.gate = new FrameGate(loop.o.backpressureBytes);
    this.child = null;
    this.paused = false;
    this.rec = null;
  }

  async start() {
    await this.open();
    const caps = this.loop.caps || {};
    if (!caps.ffmpeg || !caps.encoder) return this.bye("no_ffmpeg");
    const kind = this.req.kind;
    if (kind === "screen") {
      if (!caps.screen || !caps.screen.available) return this.bye("not_allowed");
      const display = this.req.display === undefined || this.req.display === null ? 0 : this.req.display;
      if (!caps.screen.displays.some((d) => d.index === display)) return this.bye("not_allowed");
      this.display = display;
    } else if (kind === "desk") {
      if (!guard.deskAllowed(this.loop.o.cfg(), this.loop.o.guardDeps) || !desk.status(this.loop.o.deskDeps).running) return this.bye("not_allowed");
    } else if (kind === "window") {
      if (!caps.window || !caps.window.available) return this.bye("window_not_found");
      if (!(await this.resolveWindow())) return undefined;
    } else return this.bye("not_allowed");
    // The phone pauses at once when nobody watches yet; a pause during the checks above wins.
    if (!this.paused) this.run();
    return undefined;
  }

  /** Finds the session's window again (it may have moved). false after a bye. */
  async resolveWindow() {
    const rec = sessions.readSession(this.req.session_id);
    if (!rec || rec.ended) {
      this.bye("session_gone");
      return false;
    }
    let w = null;
    try {
      w = rec.claude_pid ? await this.loop.o.findWindow(rec.claude_pid) : null;
    } catch (err) {
      this.loop.o.log(`stream ${this.id} window: ${err.message}`);
    }
    if (this.ended) return false;
    // A window shared by many sessions (Windows Terminal tabs, VS Code, Claude Desktop) would
    // show whichever one is focused, so it never counts as this session's window (item 58).
    if (!w || w.shared) {
      if (w) this.loop.o.log(`stream ${this.id} window: ${w.process || "host"} is shared, not this session's own`);
      this.bye("window_not_found");
      return false;
    }
    if (w.minimized) this.send({ type: "notice", text: "window minimized" });
    this.window = w;
    return true;
  }

  args() {
    const o = this.loop.o;
    const caps = this.loop.caps;
    if (this.req.kind === "desk") return capture.deskArgs({ display: desk.DISPLAY, preset: this.preset });
    if (this.req.kind === "window") {
      const rect = caps.window.method === "ddagrab-crop" ? win.cropRect(this.window) : null;
      if (rect) return capture.windowArgs({ method: "ddagrab-crop", rect, preset: this.preset });
      return capture.windowArgs({ method: "gdigrab-hwnd", hwnd: this.window.hwnd, preset: this.preset });
    }
    return capture.screenArgs({ platform: o.platform, method: caps.screen.method, display: this.display, preset: this.preset, x11: (o.env || process.env).DISPLAY });
  }

  run() {
    if (this.ended) return;
    const o = this.loop.o;
    const [cmd, ...pre] = o.ffmpeg;
    let child;
    try {
      child = o.spawn(cmd, [...pre, ...this.args()], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      o.log(`stream ${this.id}: ffmpeg did not start: ${err.message}`);
      return this.bye("ffmpeg_failed");
    }
    this.child = child;
    this.firstTs = null;
    CHILDREN.add(child);
    o.log(`stream ${this.id}: ffmpeg started for ${this.req.kind} (${this.preset.name})`);
    const parser = new Fmp4Parser((ev) => this.onMedia(ev));
    let errText = "";
    let noticed = false;
    child.stdout.on("data", (c) => {
      if (this.child !== child) return;
      try {
        parser.push(c);
      } catch (err) {
        o.log(`stream ${this.id}: bad ffmpeg output: ${err.message}`);
        this.stopChild();
        this.bye("ffmpeg_failed");
      }
    });
    child.stderr.on("data", (c) => {
      errText = (errText + c.toString("utf8")).slice(-2048);
      if (!noticed && /ACCESS_LOST|access denied|0x887a0026|desktop duplication/i.test(errText)) {
        noticed = true;
        this.send({ type: "notice", text: "screen locked" });
      }
    });
    child.on("error", () => {});
    child.on("close", (code) => {
      CHILDREN.delete(child);
      if (this.child !== child) return;
      this.child = null;
      if (this.ended) return;
      o.log(`stream ${this.id}: ffmpeg exited ${code}: ${errText.trim().split("\n").pop() || ""}`);
      this.bye("ffmpeg_failed");
    });
    return undefined;
  }

  stopChild() {
    const c = this.child;
    this.child = null;
    if (c) {
      try {
        c.kill();
      } catch {
        // Gone.
      }
      CHILDREN.delete(c);
    }
  }

  onMedia(ev) {
    if (ev.type === "init") {
      this.initRaw = ev.raw;
      this.send({
        type: "init",
        codec: "avc",
        width: ev.width,
        height: ev.height,
        fps: this.preset.fps,
        sps: (ev.sps[0] || Buffer.alloc(0)).toString("base64"),
        pps: (ev.pps[0] || Buffer.alloc(0)).toString("base64"),
      });
      return;
    }
    if (this.firstTs === null) this.firstTs = ev.tsUs;
    this.recordFrame(ev);
    if (!this.socket || this.ended) return;
    if (!this.gate.admit(ev.key, this.socket.writableLength)) return;
    this.socket.sendBinary(Buffer.concat([frameHeader(ev.key, ev.tsUs - this.firstTs), ev.au]));
  }

  // ---- machine recording: the fMP4 bytes from the next keyframe, remuxed once on stop ----

  recordFrame(ev) {
    const r = this.rec;
    if (!r) return;
    if (!r.fd) {
      if (!ev.key || !this.initRaw) return;
      try {
        r.fd = fs.openSync(r.part, "w");
        fs.writeSync(r.fd, this.initRaw);
        r.bytes = this.initRaw.length;
        r.startedAt = Date.now();
      } catch (err) {
        this.rec = null;
        this.send({ type: "save_failed", error: err.message });
        return;
      }
    }
    fs.writeSync(r.fd, ev.raw);
    r.bytes += ev.raw.length;
    if (r.bytes > REC_MAX_BYTES || Date.now() - r.startedAt > REC_MAX_MS) this.finishRecording();
  }

  startRecording() {
    if (this.rec) return;
    try {
      this.rec = { ...recordingTarget(this.loop.o.machine, new Date(), this.loop.o.recordingsDir), fd: null, bytes: 0 };
    } catch (err) {
      this.send({ type: "save_failed", error: err.message });
    }
  }

  finishRecording() {
    const r = this.rec;
    this.rec = null;
    if (!r) return Promise.resolve();
    if (!r.fd) {
      this.send({ type: "save_failed", error: "nothing was recorded" });
      return Promise.resolve();
    }
    fs.closeSync(r.fd);
    const o = this.loop.o;
    const [cmd, ...pre] = o.ffmpeg;
    return new Promise((resolve) => {
      const done = (ok, why) => {
        if (ok) {
          fs.rmSync(r.part, { force: true });
          const bytes = fs.statSync(r.out).size;
          o.log(`stream ${this.id}: saved ${r.out}`);
          this.sendLate({ type: "saved", path: r.out, bytes });
        } else {
          o.log(`stream ${this.id}: remux failed: ${why}`);
          this.sendLate({ type: "save_failed", error: why });
        }
        resolve();
      };
      let child;
      try {
        child = o.spawn(cmd, [...pre, ...capture.remuxArgs(r.part, r.out)], { shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      } catch (err) {
        done(false, err.message);
        return;
      }
      CHILDREN.add(child);
      let err = "";
      child.stderr.on("data", (c) => (err = (err + c).slice(-500)));
      child.on("error", (e) => (err = e.message));
      child.on("close", (code) => {
        CHILDREN.delete(child);
        done(code === 0 && fs.existsSync(r.out), err.trim() || `remux exit ${code}`);
      });
    });
  }

  /** A saved/save_failed message may come after the phone stopped the stream: send if still open. */
  sendLate(obj) {
    if (this.socket && !this.socket.closed) this.socket.sendText(JSON.stringify(obj));
  }

  async onControl(msg) {
    if (msg.type === "pause") {
      // While recording the stream keeps flowing (spec 2.5).
      if (this.rec) return;
      this.paused = true;
      this.stopChild();
      return;
    }
    if (msg.type === "resume") {
      if (!this.paused && this.child) return;
      this.paused = false;
      if (this.child) return;
      if (this.req.kind === "window" && !(await this.resolveWindow())) return;
      this.run();
      return;
    }
    if (msg.type === "preset") {
      if (this.rec) {
        this.send({ type: "notice", text: "Stop recording to change the quality" });
        return;
      }
      this.preset = capture.presetFor(msg.preset);
      if (this.child) {
        this.stopChild();
        this.run();
      }
      return;
    }
    if (msg.type === "record") {
      if (msg.action === "start") this.startRecording();
      else if (msg.action === "stop") await this.finishRecording();
      return;
    }
    super.onControl(msg);
  }

  end(reason) {
    if (this.ended) return;
    this.ended = true;
    this.stopChild();
    const finishing = this.finishRecording();
    this.loop.active.delete(this.id);
    // The socket closes after a machine recording is saved, so the phone can show its path.
    finishing.finally(() => {
      if (this.socket) this.socket.close(1000, reason || "");
    });
  }
}

class StreamsLoop {
  constructor(opts = {}) {
    this.o = {
      cfg: loadConfig,
      api: streamsApi,
      connect: ws.connect,
      spawn: nodeSpawn,
      buildCaps,
      findWindow: (pid) => win.findWindow(pid),
      log: () => {},
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      machine: MACHINE,
      platform: process.platform,
      env: process.env,
      home: os.homedir(),
      capsEveryMs: CAPS_EVERY_MS,
      pollWaitS: POLL_WAIT_S,
      ...opts,
    };
    if (!this.o.ffmpeg) this.o.ffmpeg = ffmpegCommand(this.o.cfg(), this.o.env);
    this.active = new Map();
    this.cursor = "";
    this.stopped = false;
    this.caps = null;
    this.failures = 0;
  }

  async sendCaps() {
    try {
      this.caps = await this.o.buildCaps(this.o.cfg(), { machine: this.o.machine, platform: this.o.platform, ffmpeg: this.o.ffmpeg, guardDeps: this.o.guardDeps });
      await this.o.api.putCaps(this.o.cfg(), this.caps);
    } catch (err) {
      this.o.log(`streams caps: ${err.message}`);
    }
  }

  async run() {
    if (guard.isVast(this.o.guardDeps)) {
      this.o.log("streams: vast.ai machine, streams refused");
      return;
    }
    hookExit();
    await this.sendCaps();
    this.capsTimer = setInterval(() => this.sendCaps(), this.o.capsEveryMs);
    if (this.capsTimer.unref) this.capsTimer.unref();
    while (!this.stopped) await this.pollOnce();
  }

  async pollOnce() {
    try {
      const res = await this.o.api.pollRequests(this.o.cfg(), this.o.machine, this.cursor, this.o.pollWaitS);
      if (this.stopped) return;
      if (res.cursor !== undefined) {
        if (this.cursor && Number(res.cursor) < Number(this.cursor)) this.o.log("streams: phone restarted; cursor reset");
        this.cursor = String(res.cursor);
      }
      this.failures = 0;
      for (const req of res.requests || []) this.accept(req);
    } catch (err) {
      this.failures += 1;
      this.o.log(`streams poll: ${err.message}`);
      // A phone app without stream routes answers 404: ask again rarely.
      const wait = err.status === 404 ? 5 * 60 * 1000 : Math.min(60000, 1000 * 2 ** Math.min(this.failures, 6));
      if (this.failures > 1 || err.status === 404) await this.o.sleep(wait);
    }
  }

  accept(req) {
    if (!req || !STREAM_ID.test(String(req.stream_id || "")) || this.active.has(req.stream_id)) return;
    const allowed = guard.streamsAllowed(this.o.cfg(), this.o.guardDeps);
    const Kind = req.kind === "terminal" ? TerminalStream : ["screen", "desk", "window"].includes(req.kind) ? VideoStream : null;
    if (!Kind) return;
    const s = new Kind(this, req);
    this.active.set(s.id, s);
    const go = allowed ? s.start() : s.open().then(() => s.bye("not_allowed"));
    Promise.resolve(go).catch((err) => {
      this.o.log(`stream ${s.id}: ${err.message}`);
      s.end("error");
    });
  }

  stop() {
    this.stopped = true;
    if (this.capsTimer) clearInterval(this.capsTimer);
    for (const s of [...this.active.values()]) {
      s.send({ type: "bye", reason: "shutdown" });
      s.end("shutdown");
    }
    killAll();
  }
}

/** Starts the loop in the background; never throws into the inbox loop. */
function startStreams(opts = {}) {
  const loop = new StreamsLoop(opts);
  loop.done = loop.run().catch((err) => loop.o.log(`streams loop crashed: ${err && err.stack ? err.stack : err}`));
  return loop;
}

module.exports = { StreamsLoop, startStreams, FrameGate, frameHeader, recordingTarget, safeName, killAll, CHILDREN };
