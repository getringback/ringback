#!/usr/bin/env node
"use strict";
// Pair this computer with a phone: node pair.js "ringback://agent?v=1&name=..&port=..&hosts=..&token=..&fp=.."
// Verifies the phone answers with the pinned certificate before saving anything.

const { loadConfig, saveConfig } = require("./lib/config.js");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { api, normFp } = require("./lib/client.js");

// Lets sessions see photos the user shows on a call without a permission prompt (spec 05 section 6.3).
const VIEW_IMAGE_RULE = "mcp__plugin_ringback_ringback__view_image";
const userSettingsFile = () => path.join(os.homedir(), ".claude", "settings.json");

/** Adds [VIEW_IMAGE_RULE] to permissions.allow in [file]; false when it was already there. */
function addViewImageAllow(file = userSettingsFile()) {
  let settings = {};
  if (fs.existsSync(file)) settings = JSON.parse(fs.readFileSync(file, "utf8") || "{}");
  const permissions = settings.permissions || {};
  const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
  if (allow.includes(VIEW_IMAGE_RULE)) return false;
  const next = { ...settings, permissions: { ...permissions, allow: [...allow, VIEW_IMAGE_RULE] } };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return true;
}

function hasViewImageAllow(file = userSettingsFile()) {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    return Boolean(s.permissions && Array.isArray(s.permissions.allow) && s.permissions.allow.includes(VIEW_IMAGE_RULE));
  } catch {
    return false;
  }
}

function parsePairString(raw) {
  const text = String(raw || "").trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("That is not a Ringback pair code. In the app open Connect a computer and copy the code.");
  }
  if (url.protocol !== "ringback:" || url.hostname !== "agent") throw new Error("Expected a code starting with ringback://agent");
  const q = url.searchParams;
  const hosts = (q.get("hosts") || "").split(",").map((h) => h.trim()).filter(Boolean);
  const port = Number(q.get("port"));
  const fp = normFp(q.get("fp"));
  const token = q.get("token") || "";
  if (!hosts.length || !Number.isInteger(port) || port <= 0 || fp.length !== 64 || !token) {
    throw new Error("The pair code is incomplete (needs hosts, port, token and a sha256 fingerprint).");
  }
  return { phone: { name: q.get("name") || "Phone", port, hosts, fp }, agent_token: token };
}

async function pair(raw, deps = { api, save: saveConfig, load: loadConfig }) {
  const parsed = parsePairString(raw);
  const current = deps.load();
  const next = { ...current, ...parsed };
  const health = await deps.api.health({ ...next, url_override: "" });
  if (!health || !health.ok) throw new Error("The phone answered but is not healthy yet. Open Ringback on the phone and try again.");
  deps.save(next);
  return { name: parsed.phone.name, models_ready: Boolean(health.models_ready) };
}

if (require.main === module && process.argv[2] === "--allow-view-image") {
  const added = addViewImageAllow();
  process.stdout.write(added ? `Added ${VIEW_IMAGE_RULE} to permissions.allow in ${userSettingsFile()}.\n` : "The view_image allow rule is already there.\n");
} else if (require.main === module) {
  pair(process.argv.slice(2).join(" "))
    .then((r) => {
      process.stdout.write(`Paired with ${r.name}.${r.models_ready ? "" : " Voice models are still downloading on the phone."}\n`);
      if (!hasViewImageAllow()) {
        process.stdout.write(
          `Offer: so Claude can see photos you show on a call without a prompt each time, add ${VIEW_IMAGE_RULE} to permissions.allow in ${userSettingsFile()} (pair.js --allow-view-image).\n`,
        );
      }
    })
    .catch((err) => {
      process.stderr.write(`Pairing failed: ${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { pair, parsePairString, addViewImageAllow, hasViewImageAllow, VIEW_IMAGE_RULE };
