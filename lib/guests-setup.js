"use strict";
// "Set up Ringback remote guests" (FOLLOWUPS 51 SETUP CONTRACT; audit G3, G6, G7): the one-time
// setup so people far away can join their calls, done from a joined computer so the user never edits
// policy JSON. It runs ONLY in their own terminal (bin/guests-setup.js): the OAuth secret is typed at
// a hidden prompt there, never into chat, never echoed, never logged, and the policy change needs
// their typed "yes" after they saw the diff. An agent cannot run it (no terminal) and cannot answer it.
//
// Steps:
//  1. GET /v1/guests/setup on the paired phone (machine token): already ready, or what it needs.
//  2. They make ONE Tailscale OAuth client (the only console step): Policy File Write and OAuth Keys
//     Write, no tags. They paste its id and secret at the prompt.
//  3. The policy file is read as JSON with its ETag, merged (lib/guests-policy.js: nothing of theirs is
//     dropped), validated by Tailscale, shown as a diff; on "yes" it is set with If-Match.
//  4. With the tags now defined, short-lived clients are made through the same API: one with
//     devices:core for tag:rb-phone tags the phone's node (found by the phone's DNS name), then is
//     deleted; one with exactly the scopes the phone asks for (never more than auth_keys,
//     devices:core, policy_file:read) and tag:rb-guest is handed to the phone over the paired
//     channel, POST /v1/guests/setup. The phone checks it itself (scopes, its own node, Verify).
//  5. GET again: "Done" only when the phone says ready. They are told to delete the setup client.

const policyLib = require("./guests-policy.js");

const CONSOLE_URL = "https://login.tailscale.com/admin/settings/oauth";
const PHONE_CLIENT = "Ringback guests";
const TAGGER_CLIENT = "Ringback setup tag phone";

const SAY = {
  intro: [
    "One-time setup so people far away can join your Ringback calls.",
    `1. Open ${CONSOLE_URL} and click "Generate OAuth client".`,
    "2. Tick exactly these two, nothing else: Policy File: Write, and OAuth Keys: Write. Leave tags empty.",
    "3. Click Generate, then paste the client ID and the client secret below.",
    "   The secret is hidden while you type and is never saved, logged or sent anywhere but Tailscale.",
  ].join("\n"),
  notJoined: "This computer is not on your phone yet. Add it first (tell a session: add this computer to my phone).",
  already: "Remote guests are already set up on your phone. Nothing to do.",
  noYes: "Nothing changed: you did not type yes.",
  done: "Done: people far away can join your calls now.",
  deleteSetup: `Last step: delete the setup client you just made (${CONSOLE_URL}, the one with Policy File and OAuth Keys). Ringback does not need it any more.`,
};

/** Asks Tailscale which scopes this client really has; refuses one that can do far more (G3). */
async function checkSetupClient(ts) {
  const scopes = await ts.scopes();
  const need = ["policy_file", "oauth_keys"];
  const missing = need.filter((s) => !scopes.includes(s) && !scopes.includes("all"));
  if (missing.length) return `That client is missing ${missing.join(" and ")}. Make a new one with Policy File: Write and OAuth Keys: Write.`;
  if (scopes.includes("all")) return "That client can do everything in your Tailscale account. Make a new one with only Policy File: Write and OAuth Keys: Write.";
  return "";
}

const validateError = (r) => (r && (r.message || (Array.isArray(r.data) && r.data.length)) ? String(r.message || JSON.stringify(r.data)).slice(0, 300) : "");

/** The phone's node in the device list, by the DNS name the phone gave (exact, case-insensitive). */
function findPhoneNode(devices, dnsName) {
  const want = String(dnsName || "").replace(/\.$/, "").toLowerCase();
  if (!want) return null;
  const hits = (devices || []).filter((d) => String(d.name || "").replace(/\.$/, "").toLowerCase() === want);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Runs the setup. deps: phone {get(), save(body)}; tailscale(clientId, clientSecret) -> api;
 * ask(question) -> line; askSecret(question) -> line (hidden); out(text). Resolves
 * { status, say } with status done | already | refused | cancelled | failed.
 */
async function runSetup(deps) {
  const { phone, out } = deps;
  let state;
  try {
    state = await phone.get();
  } catch (err) {
    if (err && err.status === 404) return { status: "refused", say: "Your phone's Ringback app is too old for remote guests: update it, then run this again." };
    return { status: "failed", say: `Could not reach your phone: ${err.message}` };
  }
  if (state && state.ready) return { status: "already", say: SAY.already };
  const scopes = policyLib.phoneScopes(state && state.scopes);
  if (!scopes) return { status: "refused", say: "Your phone asked for more Tailscale rights than Ringback ever needs, so I stopped. Update the app and try again." };
  out(SAY.intro);
  const clientId = String((await deps.ask("Client ID: ")) || "").trim();
  const secret = String((await deps.askSecret("Client secret (hidden): ")) || "").trim();
  if (!clientId || !secret) return { status: "cancelled", say: "Nothing changed: no client ID or secret was given." };
  const ts = deps.tailscale(clientId, secret);
  const wrong = await checkSetupClient(ts);
  if (wrong) return { status: "refused", say: wrong };
  const applied = await applyPolicy(ts, deps);
  if (applied.status !== "ok") return applied;
  const tagged = await tagPhone(ts, state.phone_dns_name, out);
  const handed = await handOver(ts, phone, scopes);
  if (handed.status !== "ok") return handed;
  let after = null;
  try {
    after = await phone.get();
  } catch {
    after = null;
  }
  const tail = [tagged, SAY.deleteSetup].filter(Boolean).join("\n");
  if (after && after.ready) return { status: "done", say: `${SAY.done}\n${tail}` };
  const why = after && after.network_ready === false ? "the phone app still needs its update with guest connections" : (after && after.reason) || "the phone has not confirmed yet";
  return { status: "saved", say: `Saved on your phone, but it is not ready yet: ${why}.\n${tail}` };
}

/** Read, merge, validate, show, typed yes, set with If-Match. */
async function applyPolicy(ts, { ask, out }) {
  const { policy, etag } = await ts.getPolicy();
  let merged;
  try {
    merged = policyLib.mergePolicy(policy);
  } catch (err) {
    return { status: "failed", say: `${err.message} Nothing changed.` };
  }
  if (!policyLib.keepsEverything(policy, merged.policy)) return { status: "failed", say: "The change would drop one of your own rules, so I stopped. Nothing changed." };
  if (!merged.changes.length) return { status: "ok" };
  const bad = validateError(await ts.validatePolicy(merged.policy));
  if (bad) return { status: "failed", say: `Tailscale refused the change (${bad}). Nothing changed.` };
  out(["This changes your Tailscale policy file. It:", ...merged.changes.map((c) => `  - ${c}`), "", "The exact change (+ added, - removed):", policyLib.policyDiff(policy, merged.policy), "", "Comments in the policy file are not kept (every rule is)."].join("\n"));
  const yes = String((await ask("Type yes to apply it: ")) || "").trim().toLowerCase();
  if (yes !== "yes") return { status: "cancelled", say: SAY.noYes };
  try {
    await ts.setPolicy(merged.policy, etag);
  } catch (err) {
    if (err.status === 412) return { status: "failed", say: "Someone changed the policy file meanwhile, so I stopped. Run this again." };
    return { status: "failed", say: `${err.message}. Nothing changed.` };
  }
  return { status: "ok" };
}

/** Tags the phone's node tag:rb-phone with a short-lived devices:core client. Returns a note or "". */
async function tagPhone(ts, dnsName, out) {
  const manual = `Tag your phone by hand once: open https://login.tailscale.com/admin/machines, open ${dnsName || "your phone"}, Edit ACL tags, add ${policyLib.PHONE}.`;
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
async function handOver(ts, phone, scopes) {
  let client;
  try {
    client = await ts.createClient(PHONE_CLIENT, scopes, [policyLib.GUEST]);
  } catch (err) {
    return { status: "failed", say: `Could not make the phone's own Tailscale key (${err.message}). The policy change is in place; run this again.` };
  }
  if (!client || !client.id || !client.key) return { status: "failed", say: "Tailscale did not return the phone's key. Run this again." };
  try {
    const res = await phone.save({ client_id: client.id, client_secret: client.key });
    if (res && res.status === "refused") throw Object.assign(new Error(res.detail || "refused"), { status: 400, body: res });
  } catch (err) {
    await ts.deleteKey(client.id).catch(() => {});
    const detail = (err.body && err.body.detail) || err.message;
    return { status: "refused", say: `Your phone did not take the key: ${detail}` };
  }
  return { status: "ok" };
}

module.exports = { runSetup, applyPolicy, tagPhone, handOver, findPhoneNode, checkSetupClient, SAY, CONSOLE_URL };
