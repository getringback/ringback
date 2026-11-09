"use strict";
// Remote guests setup (FOLLOWUPS 51 SETUP CONTRACT, audit G3 / G6 / G7): the policy changes
// Ringback needs in their Tailscale policy file, MERGED into what is there, never replacing it.
// Pure functions, no network: lib/guests-setup.js does the API calls.
//
// Added, and nothing of theirs removed:
//  - tagOwners tag:rb-guest and tag:rb-phone (owners autogroup:admin) when missing;
//  - the two guest grants: tag:rb-guest -> tag:rb-phone tcp:47870,47871 and the reverse;
//  - a tests block proving a guest reaches only the phone's two Ringback ports.
// Only when the file is still Tailscale's default allow-all ("*" -> "*:*") is that one rule
// narrowed to autogroup:member -> * (members keep reaching everything; tagged guest nodes do not),
// because the phone's own check refuses any rule a guest node could match. A restrictive policy is
// never widened.

const GUEST = "tag:rb-guest";
const PHONE = "tag:rb-phone";
const PORTS = ["tcp:47870", "tcp:47871"];
const OWNERS = ["autogroup:admin"];

const clone = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));

const guestGrants = () => [
  { src: [GUEST], dst: [PHONE], ip: [...PORTS] },
  { src: [PHONE], dst: [GUEST], ip: [...PORTS] },
];

const guestTest = () => ({ src: GUEST, accept: [`${PHONE}:47870`, `${PHONE}:47871`], deny: [`${PHONE}:22`, `${PHONE}:443`] });

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Tailscale's untouched default: one acl rule accepting "*" to "*:*" and nothing that narrows it. */
function isDefaultAllowAll(policy) {
  const acls = Array.isArray(policy && policy.acls) ? policy.acls : [];
  if (acls.length !== 1 || (policy.grants && policy.grants.length)) return false;
  const r = acls[0] || {};
  const srcAll = Array.isArray(r.src) && r.src.length === 1 && r.src[0] === "*";
  const dstAll = Array.isArray(r.dst) && r.dst.length === 1 && r.dst[0] === "*:*";
  return r.action === "accept" && srcAll && dstAll && Object.keys(r).every((k) => ["action", "src", "dst", "proto"].includes(k)) && !r.proto;
}

/**
 * The merged policy and a list of plain-words changes. Throws when the input is not a policy
 * object (so nothing is ever written from a parse that went wrong).
 */
function mergePolicy(current) {
  if (!current || typeof current !== "object" || Array.isArray(current)) throw new Error("The current policy file could not be read as JSON.");
  const next = clone(current);
  const changes = [];
  next.tagOwners = { ...(next.tagOwners || {}) };
  for (const tag of [GUEST, PHONE]) {
    if (!Array.isArray(next.tagOwners[tag])) {
      next.tagOwners[tag] = [...OWNERS];
      changes.push(`adds the tag ${tag} (owned by admins)`);
    }
  }
  if (isDefaultAllowAll(current)) {
    next.acls = [];
    next.grants = [{ src: ["autogroup:member"], dst: ["*"], ip: ["*"] }];
    changes.push("narrows the default allow-everything rule to your own devices and users (autogroup:member to everything): guest devices get nothing from it");
  }
  next.grants = Array.isArray(next.grants) ? [...next.grants] : [];
  for (const g of guestGrants()) {
    if (!next.grants.some((x) => sameJson(x, g))) {
      next.grants.push(g);
      changes.push(`lets ${g.src[0]} reach ${g.dst[0]} on ports 47870 and 47871 only`);
    }
  }
  next.tests = Array.isArray(next.tests) ? [...next.tests] : [];
  if (!next.tests.some((t) => sameJson(t, guestTest()))) {
    next.tests.push(guestTest());
    changes.push("adds a test Tailscale runs on every save: a guest reaches only those two phone ports");
  }
  return { policy: next, changes };
}

/** Every rule of `before` is still in `after` (the merge never drops their rules). */
function keepsEverything(before, after) {
  for (const key of ["acls", "grants", "ssh", "tests", "postures", "nodeAttrs", "autoApprovers"]) {
    const was = Array.isArray(before && before[key]) ? before[key] : [];
    const now = Array.isArray(after && after[key]) ? after[key] : [];
    // The one allowed exception: the default allow-all acl narrowed to members.
    if (key === "acls" && isDefaultAllowAll(before)) continue;
    if (!was.every((r) => now.some((x) => sameJson(x, r)))) return false;
  }
  for (const key of ["groups", "hosts", "tagOwners"]) {
    const was = (before && before[key]) || {};
    const now = (after && after[key]) || {};
    if (!Object.keys(was).every((k) => sameJson(was[k], now[k]))) return false;
  }
  return true;
}

/** A line diff of the two policies as pretty JSON ("+ " added, "- " removed), for the typed yes. */
function policyDiff(before, after) {
  const a = JSON.stringify(before, null, 2).split("\n");
  const b = JSON.stringify(after, null, 2).split("\n");
  // Longest common subsequence on lines: small files, plain O(n*m).
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) out.push(`+ ${b[j++]}`);
    else out.push(`- ${a[i++]}`);
  }
  return out.join("\n");
}

// The scopes the phone may hold (audit G3): never more than these.
const PHONE_SCOPES_ALLOWED = Object.freeze(["auth_keys", "devices:core", "devices:core:read", "policy_file:read"]);

/** The phone's requested scopes, kept only when every one is in the allowed set; else null. */
function phoneScopes(requested) {
  const list = Array.isArray(requested) && requested.length ? requested.map(String) : ["auth_keys", "devices:core", "policy_file:read"];
  return list.every((s) => PHONE_SCOPES_ALLOWED.includes(s)) ? [...new Set(list)] : null;
}

module.exports = { GUEST, PHONE, PORTS, guestGrants, guestTest, isDefaultAllowAll, mergePolicy, keepsEverything, policyDiff, phoneScopes, PHONE_SCOPES_ALLOWED };
