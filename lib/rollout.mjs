/**
 * Whether a Codex chat running in another process (the Codex app or CLI) looks to be waiting for an
 * approval.
 *
 * Codex never saves the approval request itself, and the step it would approve is not listed until it
 * runs. What the chat's own session file does show is the model's tool call with no result after it.
 * A long-running command looks the same, so this is a guess, made only when all of these hold:
 *   - the turn's approval policy can ask at all (policy "never" never waits on anyone),
 *   - the newest tool call has no output and no step finished after it,
 *   - nothing at all has been written for `quietMs`, and not for longer than `maxQuietMs` (an ask
 *     stays urgent as long as a question does; an app that closed mid-turn is not waiting forever).
 * Besides record types, call ids, timestamps, and the approval policy, the same tail gives what the
 * waiting call would do (its command, or the files a patch changes) and the newest plan the chat set
 * (update_plan), so the person can see them on this computer. Nothing else in the file is kept, and the
 * file is only read for a chat whose turn is still open.
 */
import { statSync } from "node:fs";
import { readFileTail } from "./claude.mjs";
import { markAwaitingApproval } from "./transform.mjs";
import { planProgress } from "./asks.mjs";

export const APPROVAL_QUIET_MS = 45_000;
export const APPROVAL_MAX_QUIET_MS = 6 * 60 * 60_000;
// The newest part of the session file is read first; a long turn's policy may sit further back.
const TAIL_STEPS = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024];
const CALLS = new Set(["custom_tool_call", "function_call", "local_shell_call"]);
const OUTPUTS = new Set(["custom_tool_call_output", "function_call_output", "local_shell_call_output"]);
// Bookkeeping Codex writes right after a call; it says nothing about progress.
const BOOKKEEPING = new Set(["token_usage_record", "token_count"]);

const parseArguments = (value) => {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(String(value ?? "")); } catch { return null; }
};
const joinCommand = (value) => (Array.isArray(value) ? value.map(String).join(" ") : typeof value === "string" ? value : "");

/** The files a patch adds, changes, or deletes: "Change src/app.js, README.md". */
function patchSummary(text) {
  const files = [...String(text ?? "").matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((match) => match[1].trim());
  return files.length ? `Change ${[...new Set(files)].join(", ")}` : "";
}

/**
 * What a code-mode `exec` call would run: the command of a `tools.exec_command({ cmd: ... })`, the files of
 * a `tools.apply_patch(...)`, else the tools it calls.
 */
function codeModeSummary(code) {
  const unescape = (text) => text.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\(["'`\\])/g, "$1");
  const STRING = String.raw`(["'\x60])((?:\\.|(?!\1)[^\\])*)\1`;
  // { cmd: "..." } or { "cmd": "..." }, the key anywhere in the object.
  const literal = new RegExp(String.raw`\bexec_command\s*\(\s*\{[^}]*?["']?\bcmd["']?\s*:\s*${STRING}`, "s").exec(code);
  if (literal) return unescape(literal[2]);
  // { cmd } or { cmd: name }, with the string set earlier: const name = "...".
  const named = /\bexec_command\s*\(\s*\{[^}]*?(?:["']?\bcmd["']?\s*:\s*([A-Za-z_$][\w$]*)|\bcmd\s*(?=[,}]))/s.exec(code);
  const variable = named ? named[1] || "cmd" : "";
  const value = variable ? new RegExp(String.raw`\b(?:const|let|var)\s+${variable.replace(/\$/g, "\\$")}\s*=\s*${STRING}`, "s").exec(code) : null;
  if (value) return unescape(value[2]);
  const patch = /\bapply_patch\s*\(/.test(code) ? patchSummary(code.replace(/\\n/g, "\n")) : "";
  if (patch) return patch;
  const tools = [...new Set([...code.matchAll(/\btools\.([A-Za-z0-9_]+)\s*\(/g)].map((match) => match[1]))];
  return tools.length ? `Use ${tools.slice(0, 4).join(", ")}` : "";
}

/** The tool and the command (or files) of one call record from a session file. */
export function callSummary(payload) {
  const name = String(payload?.name || "");
  const args = parseArguments(payload?.arguments);
  if (payload?.type === "local_shell_call") return { tool: "shell", command: joinCommand(payload.action?.command) };
  if (name === "exec_command") return { tool: name, command: String(args?.cmd ?? "") };
  if (name === "shell" || name === "shell_command" || name === "container.exec") return { tool: name, command: joinCommand(args?.command) };
  if (name === "apply_patch") return { tool: name, command: patchSummary(typeof payload.input === "string" ? payload.input : args?.input) };
  if (name === "exec" && typeof payload.input === "string") return { tool: name, command: codeModeSummary(payload.input) };
  const label = payload?.namespace ? `${payload.namespace} · ${name}` : name;
  return { tool: name || "tool", command: label ? `Use ${label}` : "" };
}

/** Plan progress from an update_plan call's arguments: { plan: [{ step, status }] }. */
function planFrom(argumentsValue) {
  const plan = parseArguments(argumentsValue)?.plan;
  return Array.isArray(plan) ? planProgress(plan.map((item) => ({ text: item?.step, status: item?.status })), (step) => step.text) : null;
}

/**
 * The approval policy in force, the newest open tool call (its id, record, and time), the newest plan,
 * and the newest write time in a tail.
 */
function scanRollout(text) {
  let policy = "";
  let openCall = "";
  let call = null;
  let plan = null;
  let lastAt = 0;
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; } // The first line of a tail may be cut.
    const at = Date.parse(record.timestamp);
    if (Number.isFinite(at)) lastAt = Math.max(lastAt, at);
    const type = String(record.payload?.type || record.type || "");
    if (record.type === "turn_context") {
      const value = record.payload?.approval_policy;
      policy = typeof value === "string" ? value : value ? "granular" : "";
      continue;
    }
    if (BOOKKEEPING.has(record.type) || BOOKKEEPING.has(type)) continue;
    if (CALLS.has(type)) {
      openCall = String(record.payload?.call_id || "call");
      call = { payload: record.payload, at: Number.isFinite(at) ? at : 0 };
      if (record.payload?.name === "update_plan") plan = planFrom(record.payload.arguments) || plan;
    } else if (OUTPUTS.has(type) || type === "item_completed" || type === "task_complete" || type === "turn_aborted") {
      openCall = "";
      call = null;
    }
  }
  return { policy, openCall, call, plan, lastAt };
}

/** The open call as an ask names it: { command, tool, at }, or null. */
const openCallOf = (scan) => (scan.openCall && scan.call ? { ...callSummary(scan.call.payload), at: scan.call.at } : null);

const quietCall = ({ openCall, lastAt }, now, quietMs, maxQuietMs) =>
  Boolean(openCall) && lastAt > 0 && now - lastAt >= quietMs && now - lastAt <= maxQuietMs;

export function looksLikeApprovalWait(text, { now = Date.now(), quietMs = APPROVAL_QUIET_MS, maxQuietMs = APPROVAL_MAX_QUIET_MS } = {}) {
  const scan = scanRollout(text);
  return quietCall(scan, now, quietMs, maxQuietMs) && scan.policy !== "never" && scan.policy !== "";
}

/**
 * Look at a session file on disk: { awaits, call, progress }. `awaits` is the approval guess (false when
 * the file cannot be read), `call` the open call ({ command, tool, at }) while there is one, and
 * `progress` the newest plan in view. Only a quiet open call whose policy is not in the newest part of
 * the file costs a longer read, up to 4 MB.
 */
export function inspectRollout(file, { now = Date.now(), quietMs = APPROVAL_QUIET_MS, maxQuietMs = APPROVAL_MAX_QUIET_MS,
  readTail = readFileTail, sizeOf = (path) => statSync(path).size } = {}) {
  const none = { awaits: false, call: null, progress: null };
  if (typeof file !== "string" || !/\.jsonl$/i.test(file)) return none;
  const path = file.replace(/^\\\\\?\\/, "");
  let seen = none;
  try {
    let previous = -1;
    for (const [step, bytes] of TAIL_STEPS.entries()) {
      const text = readTail(path, bytes);
      if (text.length === previous) break; // The whole file is already in view.
      previous = text.length;
      const scan = scanRollout(text);
      seen = { awaits: false, call: openCallOf(scan), progress: scan.plan || seen.progress };
      // The open call and its quiet are in the newest part; only the policy may need a longer look.
      if (!quietCall(scan, now, quietMs, maxQuietMs)) return seen;
      if (scan.policy) {
        rememberPolicy(path, scan.policy, sizeOf(path));
        return { ...seen, awaits: scan.policy !== "never" };
      }
      // A chat rechecked every few seconds would otherwise read megabytes each time to find the same policy.
      // Session files only grow; one that shrank was replaced, and its remembered policy no longer applies.
      // Anything written since the policy was found is inside the newest read (which held no newer turn_context),
      // so the remembered policy still applies; a file that shrank or grew past that is looked at again.
      const known = step === 0 ? knownPolicies.get(path) : null;
      const size = known ? sizeOf(path) : 0;
      if (known && size >= known.size && size - known.size <= bytes) {
        rememberPolicy(path, known.policy, size);
        return { ...seen, awaits: known.policy !== "never" };
      }
    }
    return seen;
  } catch {
    return seen;
  }
}

/** The approval guess alone, for a session file on disk; false when it cannot be read. */
export function rolloutAwaitsApproval(file, options) {
  return inspectRollout(file, options).awaits;
}

// The approval policy last found in each session file, for files whose policy sits far back.
const knownPolicies = new Map();
const KNOWN_POLICY_LIMIT = 200;
function rememberPolicy(path, policy, size) {
  knownPolicies.delete(path);
  knownPolicies.set(path, { policy, size });
  if (knownPolicies.size > KNOWN_POLICY_LIMIT) knownPolicies.delete(knownPolicies.keys().next().value);
}

/**
 * Mark a chat whose newest turn is still open (another Codex process is running it) and looks held on
 * an approval, naming the call it waits on. The turn's timestamp freezes while it waits, so this does
 * not depend on how recently the chat changed; `inspectRollout` bounds how long the guess lasts. The
 * same read gives the open turn's plan progress. `awaits` (a yes/no check) stands in for tests.
 */
export function withApprovalGuess(actor, file, { now = Date.now(), awaits = null, inspect = inspectRollout } = {}) {
  const last = actor?.turnStates?.at(-1);
  if (!last?.open || !(actor.runningElsewhere || last.status === "interrupted")) return actor;
  if (awaits) return awaits(file, { now }) ? markAwaitingApproval(actor) : actor;
  const seen = inspect(file, { now });
  const planned = seen.progress ? { ...actor, progress: seen.progress } : actor;
  return seen.awaits ? markAwaitingApproval(planned, seen.call) : planned;
}
