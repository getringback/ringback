"use strict";
// "Set up Ringback remote guests" (FOLLOWUPS 51 SETUP CONTRACT; audit G3, G6, G7): the one-time
// setup so people far away can join their calls, done from a joined computer so the user never edits
// policy JSON. It runs ONLY in their own terminal (bin/guests-setup.js): the OAuth secret is typed at
// a hidden prompt there, never into chat, never echoed, never logged, and the policy change needs
// their typed "yes" after they saw the diff. An agent cannot run it (no terminal) and cannot answer it.
//
// Steps:
//  1. GET /v1/guests/setup on the paired phone (machine token): already ready, or what it needs. A
//     saved key the phone can no longer use (HTTP 401) is simply replaced: POST overwrites it.
//  2. They make ONE Tailscale OAuth "setup client" (the only console step): full access, or Policy
//     File Write and OAuth Keys Write. They paste its id and secret at the prompt.
//  3. The policy file is read as JSON with its ETag, merged (lib/guests-policy.js: nothing of theirs is
//     dropped), validated by Tailscale, shown as a diff; on "yes" it is set with If-Match.
//  4. With the tags now defined, short-lived clients are made through the same API: one with
//     devices:core for tag:rb-phone tags the phone's node, then is deleted; one with exactly the scopes
//     the phone asks for (never more than RemoteGuests.ALLOWED_SCOPES) and tag:rb-guest is handed to
//     the phone, POST /v1/guests/setup. Older phone keys this setup made are removed.
//  5. GET again. On ready they are told to revoke the setup client BY ITS ID and to keep the phone key
//     BY ITS ID, then (Enter) the plugin checks the phone key still gets a token and the setup client
//     no longer does. Tailscale documents that revoking a client does not revoke the clients it made
//     (https://tailscale.com/kb/1623/trust-credentials, "Revoke a trust credential"); the check proves
//     it on their own tailnet instead of trusting that.

const fs = require("fs");
const path = require("path");
const { configDir } = require("./config.js");
const policyLib = require("./guests-policy.js");

const CONSOLE_URL = "https://console.tailscale.com/admin/settings/trust-credentials";
const ACLS_URL = "https://login.tailscale.com/admin/acls";
const MACHINES_URL = "https://login.tailscale.com/admin/machines";
// Before 0.7.41 every phone's key had this one name, so which phone it belongs to cannot be told.
const LEGACY_PHONE_CLIENT = "Ringback guests";

/**
 * The phone key's description: which phone it is for and that it stays. Tailscale allows 50
 * characters of letters, digits, spaces and hyphens. One name per phone, so a re-run replaces only
 * that phone's older keys, never another phone's on the same tailnet.
 */
function phoneClientName(dnsName) {
  const host = String(dnsName || "").split(".")[0].replace(/[^A-Za-z0-9-]/g, "").slice(0, 25) || "phone";
  return `Ringback ${host} key - keep`;
}

/** A token refusal that proves the client is revoked (not a network or server hiccup). */
const isRejected = (err) => Boolean(err && (err.status === 400 || err.status === 401 || err.status === 403));
const TAGGER_CLIENT = "Ringback setup tag phone";
const REFUSED_FILE = "guests-policy-refused.json";

const SAY = {
  intro: [
    "One-time setup so people far away can join your Ringback calls.",
    `1. Open ${CONSOLE_URL} (Trust credentials), select Credential, then OAuth.`,
    "2. Easiest: choose Write next to All. This setup uses it once and you revoke it at the end.",
    "   Or, narrower: choose Write next to Policy File and Write next to OAuth Keys (OAuth Keys, not Auth Keys).",
    "   If Tailscale ticks more boxes by itself, leave them. You do not need any tags.",
    "3. Select Generate credential, then paste the client ID and the client secret below.",
    "   The secret is hidden while you type and is never saved, logged or sent anywhere but Tailscale.",
  ].join("\n"),
  replacing: "Your phone's saved Tailscale key no longer works, so this makes it a new one.",
  notJoined: "This computer is not on your phone yet. Add it first (tell a session: add this computer to my phone), then run this again.",
  already: "Remote guests are already set up on your phone. Nothing to do.",
  noYes: "Nothing changed: you did not type yes. Run this again when you want to apply it.",
  done: "Done: people far away can join your calls now.",
  checkAsk: "Revoke it now, then press Enter here and I will check your phone's key still works (or type skip): ",
  checkOk: "Checked: your phone's key still works and the setup client is gone. Setup is finished.",
};

// What the setup client must have, in the words the intro uses for the console's rows.
const SETUP_NEEDS = Object.freeze({ policy_file: "Write next to Policy File", oauth_keys: "Write next to OAuth Keys" });

/** The phone says its saved key is dead (Tailscale 401 or a key it cannot open): replace it. */
function keyIsDead(state) {
  return Boolean(state && state.credential_saved && !state.ready && /HTTP 401|did not accept this OAuth client|could not be opened/i.test(String(state.reason || "")));
}

/** Asks Tailscale which scopes this client really has; refuses one missing what the setup needs (G3). */
// A client with every right is accepted (owner decision 2026-11-15): it is used once here and the
// last step tells them to revoke it. Only the narrow phone client is ever stored, on the phone.
async function checkSetupClient(ts) {
  let scopes;
  try {
    scopes = await ts.scopes();
  } catch (err) {
    return `Tailscale did not accept that client ID and secret (${err.message}). Copy both again from the Credential created page, or make a new one, then run this again.`;
  }
  const missing = Object.keys(SETUP_NEEDS).filter((s) => !scopes.includes(s) && !scopes.includes("all"));
  if (missing.length) return `That client does not have ${missing.map((s) => SETUP_NEEDS[s]).join(" or ")}. Make a new one with Write next to All, or with Write next to Policy File and Write next to OAuth Keys (OAuth Keys, not Auth Keys, and Write, not Read), then run this again.`;
  return "";
}

// The message alone ("test(s) failed") says nothing; the data rows name the failing test and why.
const validateError = (r) => {
  if (!r || !(r.message || (Array.isArray(r.data) && r.data.length))) return "";
  const rows = Array.isArray(r.data) ? r.data.map((d) => `${d.user || d.src || "?"}: ${[].concat(d.errors || []).join("; ")}`).join(" | ") : "";
  return [r.message, rows].filter(Boolean).join(": ").slice(0, 1200);
};

/** The phone's node in the device list, by the DNS name the phone gave (exact, case-insensitive). */
function findPhoneNode(devices, dnsName) {
  const want = String(dnsName || "").replace(/\.$/, "").toLowerCase();
  if (!want) return null;
  const hits = (devices || []).filter((d) => String(d.name || "").replace(/\.$/, "").toLowerCase() === want);
  return hits.length === 1 ? hits[0] : null;
}

/** GET the phone's setup state: { state } or a finished result. */
async function readPhone(phone) {
  try {
    return { state: await phone.get() };
  } catch (err) {
    if (err && err.status === 404) return { result: { status: "refused", say: "Your phone's Ringback app is too old for remote guests: update it, then run this again." } };
    return { result: { status: "failed", say: `Could not reach your phone (${err.message}). Open Ringback on your phone, check this computer is still on it, then run this again.` } };
  }
}

/**
 * Runs the setup. deps: phone {get(), save(body)}; tailscale(clientId, clientSecret) -> api;
 * ask(question) -> line; askSecret(question) -> line (hidden); out(text); stateDir (optional, for
 * the refused-policy file; defaults to <config dir>/state). Resolves { status, say } with status
 * done | already | saved | refused | cancelled | failed.
 */
async function runSetup(deps) {
  const { phone, out } = deps;
  const read = await readPhone(phone);
  if (read.result) return read.result;
  const state = read.state;
  if (state && state.ready) return { status: "already", say: SAY.already };
  const scopes = policyLib.phoneScopes(state && state.scopes);
  if (!scopes) return { status: "refused", say: "Your phone asked for more Tailscale rights than Ringback ever needs, so I stopped. Update the Ringback app on your phone, then run this again." };
  if (keyIsDead(state)) out(SAY.replacing);
  out(SAY.intro);
  const clientId = String((await deps.ask("Client ID: ")) || "").trim();
  const secret = String((await deps.askSecret("Client secret (hidden): ")) || "").trim();
  if (!clientId || !secret) return { status: "cancelled", say: "Nothing changed: no client ID or secret was given. Run this again when you have both." };
  const ts = deps.tailscale(clientId, secret);
  const wrong = await checkSetupClient(ts);
  if (wrong) return { status: "refused", say: wrong };
  const applied = await applyPolicy(ts, deps);
  if (applied.status !== "ok") return applied;
  const tagged = await tagPhone(ts, state.phone_dns_name, out);
  const handed = await handOver(ts, phone, scopes, phoneClientName(state.phone_dns_name));
  if (handed.status !== "ok") return handed;
  const old = await removeOldPhoneKeys(ts, handed.client);
  if (old.removed) out(`Removed ${old.removed} older key${old.removed === 1 ? "" : "s"} of this phone from Tailscale (the phone no longer used ${old.removed === 1 ? "it" : "them"}).`);
  if (old.legacy.length) out(`Tailscale also lists an older Ringback key named "${LEGACY_PHONE_CLIENT}" (${old.legacy.join(", ")}). If this is your only phone with Ringback, revoke it on ${CONSOLE_URL}; if you have another, leave it.`);
  return finish({ ...deps, ts, clientId, secret, phoneKey: handed.client, tagged });
}

/** After the hand-over: ready means revoke the setup client and check; otherwise keep it for a re-run. */
async function finish({ phone, ask, out, tailscale, clientId, secret, phoneKey, tagged }) {
  let after = null;
  try {
    after = await phone.get();
  } catch {
    after = null;
  }
  const name = phoneKey.description;
  const keep = `Keep "${name}" (${phoneKey.id}): that is your phone's own key, limited to inviting guests.`;
  if (!(after && after.ready)) {
    const why = after && after.network_ready === false ? "the phone app still needs its update with guest connections" : (after && after.reason) || "the phone has not confirmed yet";
    const lines = [`Saved on your phone, but it is not ready yet: ${String(why).replace(/\.$/, "")}.`, tagged, keep, `Keep the setup client ${clientId} until your phone says ready: if it does not get there, open Ringback on your phone and run this again with the same setup client. Once it is ready, revoke ${clientId} on ${CONSOLE_URL}.`];
    return { status: "saved", say: lines.filter(Boolean).join("\n") };
  }
  out([SAY.done, tagged, `Last step, on ${CONSOLE_URL}:`, `  Revoke the setup client ${clientId} (the one you pasted here). Ringback does not need it any more.`, `  ${keep}`].filter(Boolean).join("\n"));
  const answer = String((await ask(SAY.checkAsk)) || "").trim().toLowerCase();
  const res = answer === "skip" ? { status: "done", say: `Setup is finished. Revoke the setup client ${clientId} when you can; keep "${name}".` } : await checkAfterRevoke({ tailscale, clientId, secret, phoneKey });
  // A phone that could not be tagged here still needs that one manual step: it stays in the last words.
  return tagged ? { ...res, say: [res.say, tagged].join("\n") } : res;
}

/** The phone key must still get a token; the setup client should not any more. Proven, not assumed. */
async function checkAfterRevoke({ tailscale, clientId, secret, phoneKey }) {
  // "alive", "revoked" (Tailscale refused the client) or "unknown" (network or server trouble).
  const probe = (api) => api.scopes().then(() => "alive", (err) => (isRejected(err) ? "revoked" : "unknown"));
  // Both are checked before anything is said: which one died decides the advice.
  const phone = await probe(tailscale(clientId, secret).withClient(phoneKey.id, phoneKey.key));
  const setup = await probe(tailscale(clientId, secret));
  const name = phoneKey.description;
  if (phone === "unknown" || setup === "unknown") return { status: "done", say: `Your phone has its key, but Tailscale could not be reached to check the revoke. Make sure the setup client ${clientId} shows as revoked on ${CONSOLE_URL}, and keep "${name}".` };
  const phoneAlive = phone === "alive";
  const setupAlive = setup === "alive";
  if (!phoneAlive && setupAlive) return { status: "failed", say: `You revoked your phone's key ("${name}"), not the setup client. Run this again, paste the same setup client ${clientId}, and this time revoke that one.` };
  if (!phoneAlive) return { status: "failed", say: `Your phone's key stopped working after the revoke. Run this setup again with a new setup client, and this time keep that setup client instead of revoking it.` };
  if (setupAlive) return { status: "done", say: `Your phone's key works. Tailscale still accepts the setup client ${clientId}: check you revoked that one on ${CONSOLE_URL} (it can take a minute), and keep "${name}".` };
  return { status: "done", say: SAY.checkOk };
}

/** Keeps both versions of a refused policy (rules, not secrets) so the cause can be read. */
function saveRefused(stateDir, record) {
  const dir = stateDir || path.join(configDir(), "state");
  const file = path.join(dir, REFUSED_FILE);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record, null, 2));
    return file;
  } catch {
    return "";
  }
}

/** Read, merge, validate, show, typed yes, set with If-Match. */
async function applyPolicy(ts, { ask, out, stateDir }) {
  let current;
  try {
    current = await ts.getPolicy();
  } catch (err) {
    return { status: "failed", say: `Could not read your Tailscale policy file (${err.message}). Nothing changed. Check the setup client has Write next to Policy File (or All), then run this again.` };
  }
  const { policy, etag } = current;
  let merged;
  try {
    merged = policyLib.mergePolicy(policy);
  } catch (err) {
    return { status: "failed", say: `${err.message} Nothing changed. Open ${ACLS_URL}, make sure the policy file saves there, then run this again.` };
  }
  if (!policyLib.keepsEverything(policy, merged.policy)) return { status: "failed", say: `The change would drop one of your own rules, so I stopped. Nothing changed. Add these by hand at ${ACLS_URL}, then run this again: the tags ${policyLib.GUEST} and ${policyLib.PHONE} under tagOwners (owner autogroup:admin), and these grants: ${JSON.stringify(policyLib.guestGrants())}.` };
  if (!merged.changes.length) return { status: "ok" };
  const bad = validateError(await ts.validatePolicy(merged.policy));
  if (bad) {
    const file = saveRefused(stateDir, { current: policy, merged: merged.policy, refused: bad });
    const where = file ? ` Both versions are saved in ${file}.` : "";
    return { status: "failed", say: `Tailscale refused the change (${bad}). Nothing changed.${where} Fix the rule Tailscale names in your policy file, then run this again.` };
  }
  out(["This changes your Tailscale policy file. It:", ...merged.changes.map((c) => `  - ${c}`), "", "The exact change (+ added, - removed):", policyLib.policyDiff(policy, merged.policy), "", "Comments in the policy file are not kept (every rule is)."].join("\n"));
  const yes = String((await ask("Type yes to apply it: ")) || "").trim().toLowerCase();
  if (yes !== "yes") return { status: "cancelled", say: SAY.noYes };
  try {
    await ts.setPolicy(merged.policy, etag);
  } catch (err) {
    if (err.status === 412) return { status: "failed", say: "Someone changed the policy file meanwhile, so I stopped. Nothing changed. Run this again." };
    return { status: "failed", say: `Tailscale did not save the change (${err.message}). Nothing changed. Run this again in a minute.` };
  }
  return { status: "ok" };
}

/** Tags the phone's node tag:rb-phone with a short-lived devices:core client. Returns a note or "". */
async function tagPhone(ts, dnsName, out) {
  const manual = `Tag your phone by hand once: open ${MACHINES_URL}, open ${dnsName || "your phone"}, Edit ACL tags, add ${policyLib.PHONE}.`;
  let tagger = null;
  try {
    tagger = await ts.createClient(TAGGER_CLIENT, ["devices:core"], [policyLib.PHONE]);
    const t = ts.withClient(tagger.id, tagger.key);
    const node = findPhoneNode(await t.devices(), dnsName);
    if (!node) return manual;
    if ((node.tags || []).includes(policyLib.PHONE)) return "";
    await t.setDeviceTags(node.id, [...new Set([...(node.tags || []), policyLib.PHONE])]);
    out(`Tagged your phone's Tailscale node ${policyLib.PHONE} (its Tailscale key no longer expires; that is how tagged devices work).`);
    return "";
  } catch {
    return manual;
  } finally {
    if (tagger && tagger.id) await ts.deleteKey(tagger.id).catch(() => {});
  }
}

/** Makes the phone's own narrow client and hands it to the phone, which checks it itself. */
async function handOver(ts, phone, scopes, name) {
  let client;
  try {
    client = await ts.createClient(name, scopes, [policyLib.GUEST]);
  } catch (err) {
    return { status: "failed", say: `Could not make the phone's own Tailscale key (${err.message}). The policy change is in place. Check the setup client has Write next to OAuth Keys (or All), then run this again.` };
  }
  if (!client || !client.id || !client.key) return { status: "failed", say: "Tailscale did not return the phone's key. Nothing was handed to your phone. Run this again." };
  try {
    const res = await phone.save({ client_id: client.id, client_secret: client.key });
    if (res && res.status === "refused") throw Object.assign(new Error(res.detail || "refused"), { status: 400, body: res });
  } catch (err) {
    await ts.deleteKey(client.id).catch(() => {});
    const detail = String((err.body && err.body.detail) || err.message).replace(/\.$/, "");
    return { status: "refused", say: `Your phone did not take the key: ${detail}. That key was removed from Tailscale again. Open Ringback on your phone, then run this again; if it says the same, update the app.` };
  }
  return { status: "ok", client: { ...client, description: client.description || name } };
}

/**
 * Removes the keys older runs made for THIS phone (same name, the phone just got a new one) and
 * lists the pre-0.7.41 ones, whose phone cannot be told, for the user to judge. { removed, legacy }.
 */
async function removeOldPhoneKeys(ts, keep) {
  const result = { removed: 0, legacy: [] };
  if (typeof ts.listKeys !== "function") return result;
  try {
    const clients = (await ts.listKeys()).filter((k) => k && k.keyType === "client" && k.id !== keep.id);
    result.legacy = clients.filter((k) => k.description === LEGACY_PHONE_CLIENT).map((k) => k.id);
    for (const k of clients.filter((c) => c.description === keep.description)) {
      await ts.deleteKey(k.id);
      result.removed += 1;
    }
  } catch {
    // Leftovers cannot reach anything the phone key could not; they are listed on the console page.
  }
  return result;
}

module.exports = { runSetup, applyPolicy, tagPhone, handOver, removeOldPhoneKeys, findPhoneNode, checkSetupClient, keyIsDead, SAY, CONSOLE_URL, phoneClientName, REFUSED_FILE };
