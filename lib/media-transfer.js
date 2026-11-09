"use strict";
// Sends one media file over a live-view stream socket (FOLLOWUPS item 58 APP CONTRACT):
//   {type:"media", req_id, ok:true, kind, mime, bytes, chunks}
//   then `chunks` x {type:"media_chunk", req_id, seq (0-based), data (base64)}
//   or {type:"media", req_id, ok:false, error}
// Each chunk message stays well under the 256 KB message cap of the stream; sending waits while
// the socket is backed up, and stops at once when the stream ends.

const { checkMedia, loadMedia } = require("./view-media.js");

const CHUNK_RAW = 180 * 1024;
const HIGH_WATER = 1024 * 1024;
const REQ_ID = /^[A-Za-z0-9_-]{1,32}$/;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `io`: { send(obj), queued() -> bytes waiting, ended() -> bool }. `opts`: checkMedia options
 * (allowed, cwd, home) plus ffmpeg / spawn / readFile for loadMedia. Resolves when done.
 */
async function sendMedia(io, msg, opts = {}) {
  const reqId = String((msg && msg.req_id) || "");
  if (!REQ_ID.test(reqId)) return;
  const fail = (error) => io.send({ type: "media", req_id: reqId, ok: false, error });
  const checked = checkMedia(msg.path, opts);
  if (checked.error) return fail(checked.error);
  let loaded;
  try {
    loaded = await loadMedia(checked, opts);
  } catch (err) {
    return fail("Could not read the file");
  }
  if (io.ended()) return undefined;
  const buf = loaded.buf;
  const chunks = Math.max(1, Math.ceil(buf.length / CHUNK_RAW));
  io.send({ type: "media", req_id: reqId, ok: true, kind: checked.kind, mime: loaded.mime, bytes: buf.length, chunks });
  for (let seq = 0; seq < chunks; seq += 1) {
    while (!io.ended() && io.queued() > HIGH_WATER) await pause(opts.drainMs || 20);
    if (io.ended()) return undefined;
    io.send({ type: "media_chunk", req_id: reqId, seq, data: buf.subarray(seq * CHUNK_RAW, (seq + 1) * CHUNK_RAW).toString("base64") });
  }
  return undefined;
}

module.exports = { sendMedia, CHUNK_RAW, REQ_ID };
