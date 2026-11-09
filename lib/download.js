"use strict";
// Fetch ringback-net per net-manifest.json (spec 03 section 5.4, threat 10): download the .gz,
// check its sha256, gunzip, check the binary's sha256, chmod 755, atomic rename to
// ~/.ringback/bin/ringback-net-<version>[.exe]. Any mismatch: the temp file is removed and nothing
// is installed or run.
//
// Manifest: { version, base_url?, targets: { "<os>-<arch>": { file, size, sha256_gz, sha256, url? } } }
// (os linux|darwin|windows, arch amd64|arm64). Aliases accepted: name for file, gz_sha256 for
// sha256_gz, bin_sha256 / binary_sha256 for sha256. Env RINGBACK_NET_BASE_URL overrides base_url.

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const zlib = require("zlib");

const OS = { linux: "linux", darwin: "darwin", win32: "windows" };
const ARCH = { x64: "amd64", arm64: "arm64" };
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const HEX64 = /^[0-9a-f]{64}$/;

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function targetKey(platform = process.platform, arch = process.arch) {
  if (!OS[platform] || !ARCH[arch]) {
    throw new Error(`The built-in Tailscale is not available for ${platform}/${arch}. Install Tailscale on this machine and run the join again.`);
  }
  return `${OS[platform]}-${ARCH[arch]}`;
}

function binPath(dir, version, platform = process.platform) {
  return path.join(dir, `ringback-net-${version}${platform === "win32" ? ".exe" : ""}`);
}

function readManifest(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** The manifest entry for this machine, normalized, or a plain error. */
function entryFor(manifest, key) {
  if (!manifest || typeof manifest.version !== "string" || !manifest.targets || typeof manifest.targets !== "object") {
    throw new Error("The ringback-net manifest in this package is broken.");
  }
  const raw = manifest.targets[key];
  if (!raw) throw new Error(`The built-in Tailscale is not available for ${key} yet. Install Tailscale on this machine and run the join again.`);
  const e = {
    file: raw.file || raw.name,
    url: raw.url || "",
    size: Number(raw.size) || 0,
    sha256Gz: String(raw.sha256_gz || raw.gz_sha256 || "").toLowerCase(),
    sha256: String(raw.sha256 || raw.bin_sha256 || raw.binary_sha256 || "").toLowerCase(),
  };
  if (!e.file || !HEX64.test(e.sha256Gz) || !HEX64.test(e.sha256)) throw new Error("The ringback-net manifest in this package is broken.");
  return e;
}

function downloadUrl(manifest, entry, env) {
  if (entry.url) return entry.url;
  const base = (env && env.RINGBACK_NET_BASE_URL) || manifest.base_url || "";
  if (!base) throw new Error("This package has no download address for ringback-net yet.");
  return new URL(entry.file, base.endsWith("/") ? base : `${base}/`).toString();
}

/** GET a URL into memory, following redirects, bounded in size. No overall timeout (slow links). */
function fetchBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : u.protocol === "http:" ? http : null;
    if (!lib) return reject(new Error(`Refusing to download from ${u.protocol} addresses.`));
    const req = lib.get(u, { headers: { "User-Agent": "ringback-join" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) return reject(new Error("Too many redirects downloading ringback-net."));
        return resolve(fetchBuffer(new URL(res.headers.location, u).toString(), redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Downloading ringback-net failed (HTTP ${res.statusCode}).`));
      }
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > MAX_BYTES) req.destroy(new Error("ringback-net download is too large."));
        else chunks.push(c);
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}

function verifiedInPlace(file, want) {
  try {
    return sha256(fs.readFileSync(file)) === want;
  } catch {
    return false;
  }
}

/**
 * Path of a verified ringback-net for this machine, downloading it when missing or not matching.
 * deps: manifest, dir (~/.ringback/bin), platform, arch, env, fetch(url) -> Buffer.
 */
async function ensureNet({ manifest, dir, platform = process.platform, arch = process.arch, env = process.env, fetch = fetchBuffer }) {
  const entry = entryFor(manifest, targetKey(platform, arch));
  const final = binPath(dir, manifest.version, platform);
  if (verifiedInPlace(final, entry.sha256)) return final;
  const url = downloadUrl(manifest, entry, env);
  const gz = await fetch(url);
  if (sha256(gz) !== entry.sha256Gz) throw new Error("The ringback-net download did not match its checksum. Nothing was installed.");
  const bin = zlib.gunzipSync(gz);
  if (sha256(bin) !== entry.sha256) throw new Error("The unpacked ringback-net did not match its checksum. Nothing was installed.");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${final}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, bin, { mode: 0o755 });
    fs.chmodSync(tmp, 0o755);
    if (!verifiedInPlace(tmp, entry.sha256)) throw new Error("The written ringback-net did not match its checksum. Nothing was installed.");
    fs.renameSync(tmp, final);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return final;
}

module.exports = { targetKey, binPath, readManifest, entryFor, ensureNet, fetchBuffer, sha256 };
