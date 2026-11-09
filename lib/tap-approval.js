"use strict";
// Permission prompts and AskUserQuestion questions answered from the phone (PERMISSION TAP
// CONTRACT, FOLLOWUPS). They see and pick the SAME options the session shows:
//  - permission: Allow once, each "allow always" / mode option Claude Code itself suggested for this
//    request (permission_suggestions, echoed back as updatedPermissions: documented hooks.md
//    "PermissionRequest decision control"), Deny, Deny with a note;
//  - question: the question, every option label and description, single or multi select, plus
//    Other with typed or spoken text; answered with PreToolUse permissionDecision "allow" +
//    updatedInput {questions, answers} (documented hooks.md "Allow with updatedInput").
// A spoken pick on a call is read back and applies only after a spoken yes; risky permissions still
// need a tap (the phone enforces both). No answer in time, an old phone, or they are at the keyboard
// right now: the normal terminal prompt, exactly as without Ringback.

const { redact } = require("./redact.js");

const WAIT_MS = 9 * 60 * 1000; // under the 600 s hook timeout in hooks.json
const POLL_S = 50;
const MAX_DETAIL = 2000;
// They typed a prompt this recently: they are at the keyboard, the terminal dialog is quicker for them
// (while a hook waits, Claude Code shows no dialog at all).
const AT_KEYBOARD_MS = 5 * 60 * 1000;
// Modes the phone may switch a session to (audit C2: never above the local setting from the phone).
const PHONE_MODES = new Set(["default", "manual", "plan", "acceptEdits"]);

const RISKS = [
  ["delete", /\b(rm|rmdir|del|erase|Remove-Item|rd|unlink|shred|truncate|DROP\s+TABLE|DELETE\s+FROM)\b|git\s+(clean|reset\s+--hard)|--force\b/i],
  ["push", /\bgit\s+push\b|\b(npm|pnpm|yarn)\s+publish\b|\bgh\s+(release|pr\s+merge)\b|\bdeploy\b|\bvercel\b.*--prod/i],
  ["spend", /\b(stripe|charge|payment|invoice|purchase|buy|checkout|top[_-]?up)\b/i],
  ["send", /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b.*(-X\s*(POST|PUT|DELETE)|--data|-d\s|-F\s|-Method\s+(Post|Put|Delete))|\b(sendmail|send_message|send_email|smtp|mail\s+-s|telegram|slack|whatsapp|tweet|post_to)\b/i],
];

/** The exact thing it will run or touch: the command, path, url or the whole input. */
function detailOf(input) {
  const ti = (input && input.tool_input) || {};
  const raw = ti.command || ti.file_path || ti.notebook_path || ti.url || ti.path || JSON.stringify(ti);
  return redact(String(raw)).slice(0, MAX_DETAIL);
}

/** One plain line: "<Tool>: <its own description, else the start of what it runs>". */
function summaryOf(input) {
  const tool = String((input && input.tool_name) || "a tool");
  const ti = (input && input.tool_input) || {};
  const what = String(ti.description || ti.command || ti.file_path || ti.url || "").replace(/\s+/g, " ").trim();
  return redact(what ? `${tool}: ${what}` : tool).slice(0, 160);
}

/** The risk flags of a request: delete, push, spend, send (any that match). */
function risksOf(input) {
  const ti = (input && input.tool_input) || {};
  const text = `${(input && input.tool_name) || ""} ${ti.command || ""} ${ti.url || ""} ${ti.description || ""}`;
  return RISKS.filter(([, re]) => re.test(text)).map(([k]) => k);
}

const WHERE = { session: "this session", localSettings: "this project, just me", projectSettings: "this project", userSettings: "all my projects" };

/** A plain label for one of Claude Code's suggestions, or null when the phone may not offer it. */
function suggestionLabel(s, cfg = {}) {
  if (!s || typeof s !== "object") return null;
  const where = WHERE[s.destination] || "this session";
  if (s.type === "addRules" && s.behavior === "allow" && Array.isArray(s.rules) && s.rules.length) {
    const rules = s.rules.map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : String(r.toolName || "this tool"))).join(", ");
    return redact(`Allow always: ${rules} (${where})`).slice(0, 200);
  }
  if (s.type === "setMode" && (PHONE_MODES.has(s.mode) || cfg.allow_phone_bypass === true)) return `Allow and switch to ${s.mode} mode (${where})`;
  if (s.type === "addDirectories" && Array.isArray(s.directories) && s.directories.length) return redact(`Allow and add ${s.directories.join(", ")} (${where})`).slice(0, 200);
  return null;
}

/** The options for a permission prompt: [{id, label, note?}] plus the update each "always" applies. */
function permissionOptions(input, cfg = {}) {
  const options = [{ id: "allow_once", label: "Allow once" }];
  const updates = {};
  (Array.isArray(input && input.permission_suggestions) ? input.permission_suggestions : []).forEach((s, i) => {
    const label = suggestionLabel(s, cfg);
    if (!label) return;
    const id = `suggestion_${i}`;
    options.push({ id, label });
    updates[id] = s;
  });
  options.push({ id: "deny", label: "Deny" }, { id: "deny_note", label: "Deny with a note", note: true });
  return { options, updates };
}

/** The AskUserQuestion questions as the phone shows them (1 to 4, each with its options). */
function questionsOf(input) {
  const qs = (input && input.tool_input && Array.isArray(input.tool_input.questions) ? input.tool_input.questions : []).slice(0, 4);
  return qs
    .filter((q) => q && typeof q.question === "string" && q.question.trim())
    .map((q) => ({
      question: redact(q.question).slice(0, 500),
      header: redact(String(q.header || "")).slice(0, 40),
      multi_select: q.multiSelect === true,
      options: (Array.isArray(q.options) ? q.options : []).slice(0, 8).map((o) => ({ label: redact(String((o && o.label) || "")).slice(0, 120), description: redact(String((o && o.description) || "")).slice(0, 300) })),
      other: true,
    }));
}

/**
 * The answers map Claude Code wants ({question text: label, or labels joined with ", ", or their own
 * text}) from the phone's {question text: string | string[]}; null unless every question is answered.
 */
function answersFrom(input, got) {
  const qs = (input && input.tool_input && Array.isArray(input.tool_input.questions) ? input.tool_input.questions : []).slice(0, 4);
  if (!got || typeof got !== "object" || !qs.length) return null;
  const out = {};
  for (const q of qs) {
    const v = got[q.question];
    const parts = (Array.isArray(v) ? v : [v]).map((x) => String(x == null ? "" : x).replace(/\s+/g, " ").trim().slice(0, 500)).filter(Boolean);
    if (!parts.length) return null;
    out[q.question] = q.multiSelect === true ? parts.join(", ") : parts[0];
  }
  return out;
}

/** Whether they typed a prompt to this session in the last few minutes (lib/turns.js). */
function atKeyboard(sessionId, now = Date.now()) {
  try {
    const t = require("./turns.js").read ? require("./turns.js").read(sessionId) : null;
    return Boolean(t && t.started_at && now - t.started_at < AT_KEYBOARD_MS && !t.called);
  } catch {
    return false;
  }
}

/** POSTs the request and waits for their answer; resolves the phone's final status object or null. */
async function waitForPhone(cfg, body, deps) {
  const now = deps.now || Date.now;
  let made;
  try {
    made = await deps.api.requestApproval(cfg, body);
  } catch (err) {
    if (deps.log) deps.log(`tap approval: ${err.status === 404 ? "this phone has no approvals yet" : err.message}`);
    return null;
  }
  const aid = made && made.approval_id;
  if (!aid) return null;
  const end = now() + (deps.waitMs || WAIT_MS);
  while (now() < end) {
    let s;
    try {
      s = await deps.api.approvalStatus(cfg, aid, Math.min(POLL_S, Math.max(1, Math.ceil((end - now()) / 1000))));
    } catch (err) {
      if (err.status === 404) return null;
      await (deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))))(2000);
      continue;
    }
    if (s && ["allowed", "denied", "answered"].includes(s.status)) return s;
    if (s && (s.status === "expired" || s.status === "cancelled")) return null;
  }
  try {
    await deps.api.cancelApproval(cfg, aid);
  } catch {
    // It expires on the phone by itself.
  }
  return null;
}

const baseBody = (cfg, input, deps) => ({
  session_id: input.session_id,
  session_name: deps.sessionName || "",
  ring: cfg.ring_on_permission === true,
  ask_by_voice: cfg.voice_approvals === true || cfg.voice_picks !== false,
});

/**
 * A permission prompt. Resolves { behavior: "allow", updatedPermissions? } | { behavior: "deny",
 * message } | null (the terminal prompt decides).
 */
async function askByTap(cfg, input, deps) {
  if (!deps.ignoreKeyboard && (deps.atKeyboard || atKeyboard)(input.session_id, (deps.now || Date.now)())) return null;
  const { options, updates } = permissionOptions(input, cfg);
  const risks = risksOf(input);
  const body = { ...baseBody(cfg, input, deps), kind: "permission", tool: String(input.tool_name || ""), summary: summaryOf(input), detail: detailOf(input), risks, options, tap_required: risks.length > 0 };
  const s = await waitForPhone(cfg, body, deps);
  if (!s) return null;
  if (s.status === "denied") {
    const note = String(s.note || "").replace(/\s+/g, " ").trim().slice(0, 500);
    return { behavior: "deny", message: note ? `The user denied this on their phone: ${redact(note)}` : "The user denied this on their phone." };
  }
  if (s.status !== "allowed") return null;
  const choice = String(s.choice || "allow_once");
  if (choice === "allow_once") return { behavior: "allow" };
  // Only an option this request offered; anything else is treated as no answer.
  return updates[choice] ? { behavior: "allow", updatedPermissions: [updates[choice]] } : null;
}

/** An AskUserQuestion: resolves the answers map, or null (the terminal dialog then asks them). */
async function askQuestion(cfg, input, deps) {
  if (!deps.ignoreKeyboard && (deps.atKeyboard || atKeyboard)(input.session_id, (deps.now || Date.now)())) return null;
  const questions = questionsOf(input);
  if (!questions.length) return null;
  const body = { ...baseBody(cfg, input, deps), kind: "question", summary: redact(questions[0].question).slice(0, 160), questions };
  const s = await waitForPhone(cfg, body, deps);
  if (!s || s.status !== "answered") return null;
  return answersFrom(input, s.answers);
}

module.exports = { askByTap, askQuestion, permissionOptions, suggestionLabel, questionsOf, answersFrom, atKeyboard, summaryOf, detailOf, risksOf, WAIT_MS, AT_KEYBOARD_MS };
