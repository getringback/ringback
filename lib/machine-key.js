"use strict";
// This computer's identity for the phone (app 26ffd87, "Remove and block"): a P-256 key made once
// and kept in ~/.ringback/machine-key.pem (user-only), whose public half (base64url SPKI DER) goes
// with every join request as machine.machine_key. The phone can then block a computer by identity
// under any hostname. The private key never leaves this file; nothing signs with it yet.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { configDir } = require("./config.js");

const keyFile = () => path.join(configDir(), "machine-key.pem");

const toB64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Windows: only this user may read the file (mode 0600 means nothing there). Best effort. */
function restrictOnWindows(file, deps = {}) {
  if ((deps.platform || process.platform) !== "win32") return;
  const user = deps.user || os.userInfo().username;
  (deps.spawnSync || spawnSync)("icacls", [file, "/inheritance:r", "/grant:r", `${user}:F`], { windowsHide: true, stdio: "ignore" });
}

function readKey(file) {
  try {
    return crypto.createPrivateKey(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The private key: the one already saved, else a new one written atomically (and only once). */
function loadOrCreate(deps = {}) {
  const file = keyFile();
  const have = readKey(file);
  if (have && have.asymmetricKeyDetails && have.asymmetricKeyDetails.namedCurve === "prime256v1") return have;
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  restrictOnWindows(tmp, deps);
  try {
    // Exclusive: two joins at once keep whichever key landed first.
    fs.linkSync(tmp, file);
  } catch {
    // Another process made it first (or the old file was unreadable: replace that one).
    if (!readKey(file)) fs.renameSync(tmp, file);
  }
  fs.rmSync(tmp, { force: true });
  return readKey(file) || privateKey;
}

/** machine.machine_key: base64url (no padding) of the public key's SPKI DER. */
function machineKey(deps = {}) {
  const pub = crypto.createPublicKey(loadOrCreate(deps));
  return toB64url(pub.export({ type: "spki", format: "der" }));
}

module.exports = { machineKey, loadOrCreate, keyFile, restrictOnWindows };
