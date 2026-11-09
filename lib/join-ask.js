"use strict";
// "Add this computer to my phone" (FOLLOWUPS item 51): the step 3 join with nothing typed. The
// machine finds the phone (same Wi-Fi by mDNS, its own Tailscale, else Ringback's built-in
// Tailscale), asks it with POST /v1/join/request (rbj2, "51 APP CONTRACT"), the phone shows
// "<machine> wants to join" and the user taps Allow. Then the same config, service and health check
// as the code join (lib/join.js). Every effect goes through `deps`, so tests use a fake phone.
// Result: { status, say } where `say` is one plain sentence the agent can say as it is.

const fs = require("fs");
const os = require("os");
const path = require("path");
const guard = require("./guard.js");
const ak = require("./askcrypto.js");
const join = require("./join.js");
const { configDir, loadConfig, isConfigured } = require("./config.js");
const { normFp } = require("./client.js");

const PHONE_NODE = "rb-phone";
const PHONE_PORT = 47870;
// The built-in Tailscale: how long a started sign-in may wait for the human (not an AI call).
const SIGN_IN_WAIT_MS = 15 * 60 * 1000;
const FORWARD_TRIES = 15;
const FORWARD_EVERY_MS = 2000;

const SAY = {
  notFound:
    "I could not find a phone of yours, so I stopped: open Ringback on your phone, and have this computer and the phone on the same Tailscale account, then ask me again (if this computer has no Tailscale, you can tell me to use Ringback's built-in Tailscale and sign in with your own account).",
  unverified:
    "I see a Ringback phone on this Wi-Fi, but nothing proves it is yours, so I stopped: put this computer and your phone on the same Tailscale account (or tell me to use Ringback's built-in Tailscale and sign in with your own account), then ask me again.",
  oldPhone:
    "Your phone's Ringback app cannot take a join request yet, so update the app on your own phone and ask me again.",
  denied: "You tapped Deny on the phone, so this computer was not added.",
  expired: "The request on your phone ran out of time, so nothing was added; ask me again to retry.",
  notProven: "Your phone's answer did not check out, so I saved nothing; ask me again to retry.",
  signInGaveUp: "The Tailscale sign-in was not finished, so I stopped; ask me again when you are ready.",
  asksOff: "Your phone is set not to accept join requests; turn on \"Machines can ask to join\" in Ringback's Settings, Machines, then ask me again.",
  deniedRecently: "You said no to this computer a few minutes ago, so the phone will not ask again yet; try again in ten minutes.",
  busy: "Your phone is already asking about another machine; answer that first, then ask me again.",
  // 51/52 APP SIDE (audit H1): the phone takes a request only within 5 minutes after Add, Add a computer.
  asksClosed: "On your phone tap Add, then Add a computer, then ask me again.",
  mismatch: "Those digits are not the code this computer expects, so I stopped and saved nothing; tap Deny on your phone if it asks. If your phone showed no code at all, the phone I reached is not yours.",
  noCode: "No code from your phone came back, so I stopped and saved nothing; tap Deny on your phone if it asks.",
  builtinNamed: "With Ringback's built-in Tailscale I can only reach your phone's own Ringback node, so I did not use a phone name; ask me again without one.",
};

const OS_NAME = { win32: "Windows", darwin: "macOS", linux: "Linux" };

class AskStop extends Error {
  constructor(status, say) {
    super(say);
    this.status = status;
  }
}
const stop = (status, say) => {
  throw new AskStop(status, say);
};

function askRefusal(status, body) {
  const b = body || {};
  // An app without the route sends it to the bearer check: 401 unauthorized (or 404/405).
  if (status === 404 || status === 405 || (status === 401 && b.status === "unauthorized")) return ["old_phone", SAY.oldPhone];
  if (status === 403 && b.reason === "asks_off") return ["refused", SAY.asksOff];
  if (status === 403 && b.reason === "asks_closed") return ["refused", SAY.asksClosed];
  if (status === 429 && b.status === "denied_recently") return ["denied", SAY.deniedRecently];
  if (status === 429) return ["busy", b.detail ? `${String(b.detail).replace(/\.$/, "")}; ask me again in a minute.` : SAY.busy];
  return ["refused", join.refusedLine(status, b)];
}

// Written when the phone said yes but the helper service did not install; the next call retries.
const pendingFile = () => path.join(configDir(), "state", "helper-install-pending");

function markPending(error) {
  fs.mkdirSync(path.dirname(pendingFile()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(pendingFile(), `${JSON.stringify({ error, at: Date.now() })}
`, { mode: 0o600 });
}

const withNotes = (say, notes) => (notes.length ? `${say} ${notes.join(" ")}` : say);

function serviceFailedSay(name, error, notes) {
  return withNotes(`${name} is on your phone, but its helper service did not install (${error}), so ask me to add this computer again to retry that part.`, notes);
}

/** Install the helper again after a join whose install failed. */
async function retryInstall(name, d) {
  const s = await d.installService();
  if (s && s.ok) {
    fs.rmSync(pendingFile(), { force: true });
    return { status: "joined", name, say: withNotes(`Done: ${name} was already on your phone and its helper is installed now, so agents on this computer can call you.`, d.installNotes) };
  }
  const error = String((s && s.error) || "unknown error");
  return { status: "service_failed", name, say: serviceFailedSay(name, error, d.installNotes) };
}

/** Already paired? Then nothing is touched (unless a helper install is still owed). */
async function alreadyJoined(d) {
  const cfg = d.loadConfig();
  if (!isConfigured(cfg)) return null;
  const name = (cfg.machine && cfg.machine.name) || d.hostname;
  if (fs.existsSync(pendingFile())) return retryInstall(name, d);
  return { status: "already_joined", say: `This computer is already on your phone as ${name}, so there is nothing to do.` };
}

/** The phone to ask: one found, or a stop when there are several. */
function pickPhone(found, want) {
  if (found.length <= 1) return found[0] || null;
  const names = found.map((f) => f.name);
  const list = names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return stop("choose_phone", `I found ${found.length} Ringback phones of yours, ${list}${want ? ` (none matched "${want}" alone)` : ""}: which one is yours?`);
}

/** Ringback's built-in Tailscale, only when the user asked for it and no phone was found. */
async function viaBuiltin(d, ctx) {
  d.report({ status: "starting_tailscale", say: "Starting Ringback's built-in Tailscale on this computer." });
  let bin;
  try {
    bin = await d.ensureNet();
  } catch (err) {
    stop("not_found", `${SAY.notFound} (The built-in Tailscale could not be fetched: ${err.message}.)`);
  }
  const home = configDir();
  const args = ["up", "--phone", `${PHONE_NODE}:${PHONE_PORT}`, "--dir", path.join(home, "tsnet"), "--state", path.join(home, "state", "net.json")];
  const startedAt = d.now();
  ctx.net = d.spawnNet(bin, args);
  let shownUrl = "";
  for (;;) {
    if (ctx.net.exited !== null && ctx.net.exited !== undefined) stop("failed", `The built-in Tailscale stopped before it was ready (exit ${ctx.net.exited}), so nothing was added.`);
    const st = d.readNetState();
    const ours = st && (st.pid ? st.pid === ctx.net.pid : Number(st.updated_at) >= startedAt);
    if (ours && st.state === "running" && Number(st.forward_port) > 0) return { netState: st, target: { host: "127.0.0.1", port: Number(st.forward_port) } };
    if (ours && st.state === "needs_login" && st.login_url && st.login_url !== shownUrl) {
      shownUrl = st.login_url;
      d.report({
        status: "sign_in",
        url: shownUrl,
        say: `Open this link and sign in with your OWN Tailscale account, the one your phone uses (never an account someone gave you), then I will ask your phone: ${shownUrl}`,
      });
    }
    if (d.now() - startedAt > SIGN_IN_WAIT_MS) stop("timeout", SAY.signInGaveUp);
    await d.sleep(join.NET_POLL_MS);
  }
}

/** The phone through the built-in node's forward: confirmed with its health route. */
async function phoneThroughForward(target, d, want) {
  let got = null;
  for (let i = 0; i < FORWARD_TRIES && !got; i += 1) {
    try {
      got = await d.api.healthProbe(target);
    } catch {
      await d.sleep(FORWARD_EVERY_MS);
    }
  }
  if (!got) return stop("not_found", SAY.notFound);
  // The phone's own name is never trusted (audit C3); a requested name cannot be checked here.
  if (String(want || "").trim()) return stop("not_found", SAY.builtinNamed);
  return { ...target, via: "embedded", fp: normFp(got.fp), name: "your phone's Ringback node" };
}

/** POST /v1/join/request; returns the proven pending join with its key. */
async function ask(phone, mode, g, d) {
  const keys = ak.newKeys();
  const nonce = ak.newNonce();
  const machine = join.machineBody(d, mode);
  const body = {
    v: 2,
    client_nonce: nonce,
    client_pub: keys.pub,
    machine,
    // 51 rbj2 phone_code: the phone shows its own random code and proves it after Allow.
    phone_code: true,
    guard: { vast: Boolean(g.vast), container: Boolean(g.container), never_join: Boolean(g.never_join), signals: [...(g.signals || [])] },
  };
  const target = { host: phone.host, port: phone.port };
  let r;
  try {
    r = await d.api.joinAsk(target, body);
  } catch (err) {
    return stop("unreachable", `I found your phone but lost it while asking (${err.code || err.message}); ask me again.`);
  }
  if (r.status !== 202) {
    const [status, say] = askRefusal(r.status, r.body);
    return stop(status, say);
  }
  const p = r.body || {};
  const fp = normFp(r.fp);
  const k = ak.HEX32.test(String(p.server_nonce)) ? ak.sessionKey(keys.privateKey, p.server_pub, nonce, p.server_nonce) : null;
  const proven =
    k &&
    fp.length === 64 &&
    normFp(p.fp) === fp &&
    (!phone.fp || phone.fp === fp) &&
    typeof p.join_id === "string" &&
    /^[A-Za-z0-9_-]{22}$/.test(p.join_id) &&
    ak.verifyServerMac(k, nonce, p.server_nonce, p.join_id, fp, machine, p.server_mac);
  if (!proven) return stop("refused", SAY.notProven);
  // A phone that took phone_code sends no match_code: its code R is random and only on its screen.
  const phoneCode = p.match_code === undefined || p.match_code === null;
  return { joinId: p.join_id, fp, k, match: ak.matchCode(k), phoneCode, expiresAt: Number(p.expires_at) || 0, target };
}

const SAY_FOR_EXIT = new Map([
  [join.LINES.denied, ["denied", SAY.denied]],
  [join.LINES.expired, ["expired", SAY.expired]],
  [join.LINES.gone, ["expired", SAY.expired]],
  [join.LINES.notProven, ["refused", SAY.notProven]],
]);

async function steps(opts, d, ctx) {
  // Guard first, before any network or disk write (and before the config is even read).
  const g = d.guard();
  const refused = guard.refusal(g);
  if (refused) return { status: "refused", say: refused };
  const already = await alreadyJoined(d);
  if (already) return already;
  await join.checkMachine({ noPlugin: true }, d);
  d.report({ status: "finding", say: "Looking for your phone." });
  // Only the user's own phones (find-phone.js); the tool takes no address, code or link.
  const found = await d.findPhones({ want: opts.phone });
  let phone = pickPhone(found.phones, opts.phone);
  let netState = null;
  if (!phone) {
    if (opts.builtin !== true) return found.unverified > 0 ? { status: "not_yours", say: SAY.unverified } : { status: "not_found", say: SAY.notFound };
    const b = await viaBuiltin(d, ctx);
    netState = b.netState;
    phone = await phoneThroughForward(b.target, d, opts.phone);
  }
  const mode = phone.via === "lan" ? "lan" : phone.via === "embedded" ? "embedded" : "system";
  const pending = await ask(phone, mode, g, d);
  const host = d.hostname;
  const who = `${host}, ${OS_NAME[d.platform] || d.platform}, user ${d.user || "unknown"}`;
  // Audit C3: the user reads back the code their OWN phone shows. The code is never put in a
  // tool result, so neither the agent nor injected content can supply it; a fake phone cannot
  // make the user's real phone show it.
  d.report({
    status: "waiting_for_code",
    // Audit H1 (number matching, app 51/52): the right number on the phone is the first two digits.
    tap: pending.match.slice(0, 2),
    say: `Your phone should now ask to let this computer join (${who}). On your phone, tap ${pending.match.slice(0, 2)}. Then read me the 6-digit code your phone shows. If your phone shows nothing, tell me and I stop.`,
  });
  const typed = String((await d.waitCode()) || "").replace(/\D/g, "");
  if (!typed) return { status: "no_code", say: SAY.noCode };
  // Older phones: the code is derived from K, so it is checked here first.
  if (typed.length !== 6 || (!pending.phoneCode && typed !== pending.match)) return { status: "mismatch", say: SAY.mismatch };
  d.report({
    status: "waiting_for_allow",
    // phone_code: only the phone can check the digits; its proof is checked once it answers.
    say: `${pending.phoneCode ? "Thanks, I passed the code to your phone." : "The code matches."} If your phone still asks, tap ${pending.match.slice(0, 2)} (or Allow) for "${host}", only if that is this computer and you asked for it.`,
  });
  const proven = { ...pending, confirm: ak.confirmProof(pending.k, pending.joinId, typed) };
  const approved = await join.pollDecision(ak.pollAuth(pending.k, pending.joinId), pending.target, proven, d);
  if (!/^rbk_/.test(String(approved.agent_token || "")) || normFp(approved.phone && approved.phone.fp) !== pending.fp) {
    return { status: "refused", say: SAY.notProven };
  }
  // phone_code: only the user's own phone, which showed R, can prove it (audit C3).
  if (pending.phoneCode && !ak.sameHex(approved.phone_proof, ak.phoneProof(pending.k, pending.joinId, typed))) {
    return { status: "refused", say: SAY.notProven };
  }
  const hosts = mode === "embedded" ? [PHONE_NODE] : [phone.host, ...(phone.lanHost ? [phone.lanHost] : [])];
  const pseudoCode = { hosts, port: Number(approved.phone && approved.phone.port) || PHONE_PORT };
  const choice = { mode, target: mode === "embedded" ? null : pending.target };
  const cfg = join.buildConfig(pseudoCode, mode, choice, netState, approved, pending.fp);
  join.writeJoinedConfig(cfg);
  // Owed until the helper is installed: a crash or throw below is retried on the next call.
  markPending("the setup did not finish");
  d.out(`Joined as ${cfg.machine.name || host}.`);
  d.report({ status: "installing", say: "Your phone said yes; finishing the setup on this computer." });
  let done;
  try {
    done = (await join.finishInstall(cfg, mode, netState, { noPlugin: true }, d, ctx)) || { serviceOk: true, healthOk: true };
  } catch (err) {
    done = { serviceOk: false, serviceError: String((err && err.message) || err), healthOk: false };
  }
  const name = cfg.machine.name || host;
  if (!done.serviceOk) {
    markPending(done.serviceError);
    return { status: "service_failed", name, say: serviceFailedSay(name, done.serviceError, d.installNotes) };
  }
  fs.rmSync(pendingFile(), { force: true });
  const say = done.healthOk
    ? `Done: ${name} is on your phone now, and agents on this computer can call you.`
    : `Done: ${name} is on your phone now; its first check did not reach the phone yet, and the helper keeps trying in the background.`;
  return { status: "joined", name, say: withNotes(say, d.installNotes) };
}

/** Runs the ask-to-join. Never throws; returns { status, say, ... }. */
async function runAsk(opts = {}, deps = {}) {
  const d = { ...realDeps(), ...deps };
  const ctx = { net: null, stopped: false };
  // The MCP server can exit mid-join (the session closed): never leave a sign-in node behind.
  const onExit = () => join.stopNet(ctx);
  process.once("exit", onExit);
  try {
    return await steps(opts, d, ctx);
  } catch (err) {
    if (err instanceof AskStop) return { status: err.status, say: err.message };
    if (err instanceof join.JoinExit) {
      const mapped = SAY_FOR_EXIT.get(err.message);
      if (mapped) return { status: mapped[0], say: mapped[1] };
      return { status: err.exitCode === 2 ? "machine_problem" : err.exitCode === 3 ? "unreachable" : "refused", say: err.message };
    }
    return { status: "failed", say: `Adding this computer failed: ${err && err.message ? err.message : err}.` };
  } finally {
    process.removeListener("exit", onExit);
    join.stopNet(ctx);
  }
}

function realDeps() {
  const base = join.realDeps({});
  const fp = require("./find-phone.js");
  const mdns = require("./mdns.js");
  const { api } = require("./client.js");
  const pluginRoot = path.join(__dirname, "..");
  // Installer hints (Linux linger) go into the tool's sentence, never onto MCP stdout.
  const installNotes = [];
  return {
    ...base,
    out: () => {},
    report: () => {},
    waitCode: async () => "",
    now: () => Date.now(),
    hostname: os.hostname(),
    loadConfig,
    findPhones: (o) =>
      fp.findPhones(o, { browse: () => mdns.browse(), tailscale: () => fp.tailscaleStatus(), probe: api.healthProbe, knownFps: () => require("./known-phones.js").knownFps() }),
    installNotes,
    installService: join.pluginInstallService(pluginRoot, { print: (l) => installNotes.push(String(l)) }),
  };
}

module.exports = { runAsk, askRefusal, SAY, PHONE_NODE };
