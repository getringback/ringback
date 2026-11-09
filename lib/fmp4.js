"use strict";
// Incremental ISO BMFF reader for ffmpeg's fragmented MP4 (one fragment per frame, spec 04
// section 2.2). Emits:
//   { type: "init", width, height, sps: [Buffer], pps: [Buffer], timescale, lengthSize, raw }
//   { type: "frame", tsUs, key, au, raw }   (au is Annex B, SPS+PPS prepended on keyframes)
// `raw` is the exact bytes of ftyp+moov (init) or moof+mdat (frame), for machine recording.

const MAX_BOX = 16 * 1024 * 1024;
const START = Buffer.from([0, 0, 0, 1]);

/** Child boxes of `buf` from `start` to `end`: [{type, start, end, body}]. */
function children(buf, start = 0, end = buf.length) {
  const out = [];
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    let head = 8;
    if (size === 1) {
      if (off + 16 > end) break;
      size = Number(buf.readBigUInt64BE(off + 8));
      head = 16;
    } else if (size === 0) size = end - off;
    if (size < head || off + size > end) break;
    out.push({ type, start: off, end: off + size, body: off + head });
    off += size;
  }
  return out;
}

const find = (buf, start, end, type) => children(buf, start, end).find((b) => b.type === type);

function path(buf, box, types) {
  let cur = box;
  for (const t of types) {
    if (!cur) return null;
    cur = find(buf, cur.body, cur.end, t);
  }
  return cur;
}

function parseAvcC(buf, b) {
  let o = b.body;
  const lengthSize = (buf[o + 4] & 3) + 1;
  const nSps = buf[o + 5] & 0x1f;
  o += 6;
  const sps = [];
  for (let i = 0; i < nSps; i += 1) {
    const n = buf.readUInt16BE(o);
    sps.push(Buffer.from(buf.subarray(o + 2, o + 2 + n)));
    o += 2 + n;
  }
  const nPps = buf[o];
  o += 1;
  const pps = [];
  for (let i = 0; i < nPps; i += 1) {
    const n = buf.readUInt16BE(o);
    pps.push(Buffer.from(buf.subarray(o + 2, o + 2 + n)));
    o += 2 + n;
  }
  return { sps, pps, lengthSize };
}

function parseMoov(buf, moov) {
  const trak = find(buf, moov.body, moov.end, "trak");
  const mdia = trak && find(buf, trak.body, trak.end, "mdia");
  const mdhd = mdia && find(buf, mdia.body, mdia.end, "mdhd");
  if (!mdhd) throw new Error("fmp4: moov without mdhd");
  const v = buf[mdhd.body];
  const timescale = v === 1 ? buf.readUInt32BE(mdhd.body + 4 + 16) : buf.readUInt32BE(mdhd.body + 4 + 8);
  const stsd = path(buf, mdia, ["minf", "stbl", "stsd"]);
  if (!stsd) throw new Error("fmp4: no stsd");
  // stsd: version/flags (4) + entry_count (4), then sample entries.
  const entry = children(buf, stsd.body + 8, stsd.end).find((b) => b.type === "avc1" || b.type === "avc3");
  if (!entry) throw new Error("fmp4: not H.264");
  const width = buf.readUInt16BE(entry.start + 32);
  const height = buf.readUInt16BE(entry.start + 34);
  // The avc1 sample entry has 78 bytes of fixed fields after its 8-byte box header.
  const avcC = find(buf, entry.start + 86, entry.end, "avcC");
  if (!avcC) throw new Error("fmp4: no avcC");
  return { width, height, timescale: timescale || 1, ...parseAvcC(buf, avcC) };
}

function parseTfdt(buf, moof) {
  const traf = find(buf, moof.body, moof.end, "traf");
  const tfdt = traf && find(buf, traf.body, traf.end, "tfdt");
  if (!tfdt) return 0n;
  return buf[tfdt.body] === 1 ? buf.readBigUInt64BE(tfdt.body + 4) : BigInt(buf.readUInt32BE(tfdt.body + 4));
}

/** AVCC (length-prefixed NAL units) to Annex B with 4-byte start codes. */
function avccToAnnexB(data, lengthSize = 4) {
  const parts = [];
  let o = 0;
  while (o + lengthSize <= data.length) {
    let n = 0;
    for (let i = 0; i < lengthSize; i += 1) n = n * 256 + data[o + i];
    o += lengthSize;
    if (n === 0 || o + n > data.length) break;
    parts.push(START, data.subarray(o, o + n));
    o += n;
  }
  return Buffer.concat(parts);
}

/** NAL unit types in an Annex B access unit (4-byte start codes as built above). */
function nalTypes(au) {
  const types = [];
  for (let i = 0; i + 4 < au.length; i += 1) {
    if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 0 && au[i + 3] === 1) types.push(au[i + 4] & 0x1f);
  }
  return types;
}

class Fmp4Parser {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.buf = Buffer.alloc(0);
    this.init = null;
    this.pendingInit = [];
    this.moof = null;
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    for (;;) {
      if (this.buf.length < 8) return;
      let size = this.buf.readUInt32BE(0);
      if (size === 1) {
        if (this.buf.length < 16) return;
        size = Number(this.buf.readBigUInt64BE(8));
      }
      if (size > MAX_BOX) throw new Error("fmp4: box too large");
      if (size < 8) throw new Error("fmp4: bad box size");
      if (this.buf.length < size) return;
      const boxBuf = this.buf.subarray(0, size);
      this.buf = this.buf.subarray(size);
      this.onBox(Buffer.from(boxBuf));
    }
  }

  onBox(b) {
    const type = b.toString("latin1", 4, 8);
    const box = children(b)[0];
    if (type === "ftyp") {
      this.pendingInit = [b];
    } else if (type === "moov") {
      this.init = parseMoov(b, box);
      const raw = Buffer.concat([...this.pendingInit, b]);
      this.pendingInit = [];
      this.onEvent({ type: "init", ...this.init, raw });
    } else if (type === "moof") {
      this.moof = b;
    } else if (type === "mdat" && this.moof && this.init) {
      const tfdt = parseTfdt(this.moof, children(this.moof)[0]);
      const tsUs = Number((tfdt * 1000000n) / BigInt(this.init.timescale));
      let au = avccToAnnexB(b.subarray(box.body), this.init.lengthSize);
      const types = nalTypes(au);
      const key = types.includes(5);
      if (key && !types.includes(7)) {
        const cfg = [...this.init.sps, ...this.init.pps].flatMap((n) => [START, n]);
        au = Buffer.concat([...cfg, au]);
      }
      const raw = Buffer.concat([this.moof, b]);
      this.moof = null;
      this.onEvent({ type: "frame", tsUs, key, au, raw });
    }
  }
}

module.exports = { Fmp4Parser, avccToAnnexB, nalTypes, children };
