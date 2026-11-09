"use strict";
// Join protocol rbj2: a join with no code (FOLLOWUPS item 51, "51 APP CONTRACT"). The machine
// and the phone agree a key with ephemeral ECDH P-256; the phone's tap on Allow decides. Public
// keys travel as base64url (no padding) of the DER SubjectPublicKeyInfo. Every MAC is
// HMAC-SHA256, lowercase hex, its message parts joined with "\n".
//   Z = ECDH shared secret (32 bytes)
//   K = HMAC(Z, "rbj2/key\n" + client_nonce + "\n" + server_nonce)            (32 raw bytes)
//   server_mac = HMAC(K, "rbj2/server\n" + client_nonce + "\n" + server_nonce + "\n" + join_id
//                + "\n" + fp + "\n" + hostname + "\n" + os + "\n" + arch + "\n" + mode)
//   match_code = uint32_be(HMAC(K, "rbj2/match")[0..4]) mod 1000000, 6 digits
//   poll_auth  = HMAC(K, "rbj2/poll\n" + join_id)

const crypto = require("crypto");

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;

const b64u = (buf) => Buffer.from(buf).toString("base64url");

/** A fresh ephemeral key pair: { privateKey (KeyObject), pub (base64url SPKI DER) }. */
function newKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { privateKey, pub: b64u(publicKey.export({ type: "spki", format: "der" })) };
}

/** A key pair from a fixed JWK private key (test vectors only). */
function keysFromJwk(jwk) {
  const privateKey = crypto.createPrivateKey({ key: jwk, format: "jwk" });
  const pub = b64u(crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" }));
  return { privateKey, pub };
}

/** The other side's public key, or null when it is not a P-256 SPKI. */
function parsePub(pub) {
  if (typeof pub !== "string" || !/^[A-Za-z0-9_-]{40,200}$/.test(pub)) return null;
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(pub, "base64url"), format: "der", type: "spki" });
    const details = key.asymmetricKeyDetails || {};
    if (key.asymmetricKeyType !== "ec" || details.namedCurve !== "prime256v1") return null;
    return key;
  } catch {
    return null;
  }
}

const hmac = (key, parts) => crypto.createHmac("sha256", key).update(parts.join("\n"), "utf8").digest();

/** K from our private key and their public key; null when their key is not usable. */
function sessionKey(privateKey, theirPub, clientNonce, serverNonce) {
  const publicKey = parsePub(theirPub);
  if (!publicKey) return null;
  const z = crypto.diffieHellman({ privateKey, publicKey });
  return hmac(z, ["rbj2/key", clientNonce, serverNonce]);
}

function serverMac(k, clientNonce, serverNonce, joinId, fp, m) {
  return hmac(k, ["rbj2/server", clientNonce, serverNonce, joinId, fp, m.hostname, m.os, m.arch, m.mode]).toString("hex");
}

function matchCode(k) {
  return String(hmac(k, ["rbj2/match"]).readUInt32BE(0) % 1000000).padStart(6, "0");
}

function pollAuth(k, joinId) {
  return hmac(k, ["rbj2/poll", joinId]).toString("hex");
}

/** Proof for the phone that the user read its code here: hex HMAC(K, "rbj2/confirm" LF join_id LF code). */
function confirmProof(k, joinId, code) {
  return hmac(k, ["rbj2/confirm", joinId, String(code)]).toString("hex");
}

/**
 * 51 rbj2 phone_code: the phone's proof that the code the user read (R, random on the phone, never
 * sent to this computer) is its own: hex HMAC(K, "rbj2/phone" LF join_id LF R). A fake phone never
 * saw R on the owner's screen, so it cannot make this.
 */
function phoneProof(k, joinId, code) {
  return hmac(k, ["rbj2/phone", joinId, String(code)]).toString("hex");
}

/** Constant-time compare of two lowercase hex strings. */
function sameHex(a, b) {
  const x = String(a || "").toLowerCase();
  const y = String(b || "").toLowerCase();
  if (!HEX64.test(x) || !HEX64.test(y)) return false;
  return crypto.timingSafeEqual(Buffer.from(x, "hex"), Buffer.from(y, "hex"));
}

function verifyServerMac(k, clientNonce, serverNonce, joinId, fp, m, got) {
  const want = Buffer.from(serverMac(k, clientNonce, serverNonce, joinId, fp, m), "hex");
  const g = String(got || "").toLowerCase();
  if (!HEX64.test(g)) return false;
  return crypto.timingSafeEqual(want, Buffer.from(g, "hex"));
}

const newNonce = () => crypto.randomBytes(16).toString("hex");

module.exports = { HEX32, HEX64, newKeys, keysFromJwk, parsePub, sessionKey, serverMac, matchCode, pollAuth, confirmProof, phoneProof, sameHex, verifyServerMac, newNonce };
