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
 * Only record types, call ids, timestamps, and the approval policy are read; no content.
 */
import { statSync } from "node:fs";
import { readFileTail } from "./claude.mjs";
import { markAwaitingApproval } from "./transform.mjs";

export const APPROVAL_QUIET_MS = 45_000;
export const APPROVAL_MAX_QUIET_MS = 6 * 60 * 60_000;
// The newest part of the session file is read first; a long turn's policy may sit further back.
const TAIL_STEPS = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024];
const CALLS = new Set(["custom_tool_call", "function_call", "local_shell_call"]);
const OUTPUTS = new Set(["custom_tool_call_output", "function_call_output", "local_shell_call_output"]);
// Bookkeeping Codex writes right after a call; it says nothing about progress.
const BOOKKEEPING = new Set(["token_usage_record", "token_count"]);

/** The approval policy in force, the newest open tool call, and the newest write time in a tail. */
function scanRollout(text) {
  let policy = "";
  let openCall = "";
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
    if (CALLS.has(type)) openCall = String(record.payload?.call_id || "call");
    else if (OUTPUTS.has(type) || type === "item_completed" || type === "task_complete" || type === "turn_aborted") openCall = "";
  }
  return { policy, openCall, lastAt };
}

const quietCall = ({ openCall, lastAt }, now, quietMs, maxQuietMs) =>
  Boolean(openCall) && lastAt > 0 && now - lastAt >= quietMs && now - lastAt <= maxQuietMs;

export function looksLikeApprovalWait(text, { now = Date.now(), quietMs = APPROVAL_QUIET_MS, maxQuietMs = APPROVAL_MAX_QUIET_MS } = {}) {
  const scan = scanRollout(text);
  return quietCall(scan, now, quietMs, maxQuietMs) && scan.policy !== "never" && scan.policy !== "";
}

/**
 * The same check on a session file on disk; false when it cannot be read. Only a quiet open call
 * whose policy is not in the newest part of the file costs a longer read, up to 4 MB.
 */
export function rolloutAwaitsApproval(file, { now = Date.now(), quietMs = APPROVAL_QUIET_MS, maxQuietMs = APPROVAL_MAX_QUIET_MS,
  readTail = readFileTail, sizeOf = (path) => statSync(path).size } = {}) {
  if (typeof file !== "string" || !/\.jsonl$/i.test(file)) return false;
  const path = file.replace(/^\\\\\?\\/, "");
  try {
    let previous = -1;
    for (const [step, bytes] of TAIL_STEPS.entries()) {
      const text = readTail(path, bytes);
      if (text.length === previous) break; // The whole file is already in view.
      previous = text.length;
      const scan = scanRollout(text);
      // The open call and its quiet are in the newest part; only the policy may need a longer look.
      if (!quietCall(scan, now, quietMs, maxQuietMs)) return false;
      if (scan.policy) {
        rememberPolicy(path, scan.policy, sizeOf(path));
        return scan.policy !== "never";
      }
      // A chat rechecked every few seconds would otherwise read megabytes each time to find the same policy.
      // Session files only grow; one that shrank was replaced, and its remembered policy no longer applies.
      const known = step === 0 ? knownPolicies.get(path) : null;
      if (known && sizeOf(path) >= known.size) return known.policy !== "never";
    }
    return false;
  } catch {
    return false;
  }
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
 * an approval. The turn's timestamp freezes while it waits, so this does not depend on how recently
 * the chat changed; `rolloutAwaitsApproval` bounds how long the guess lasts.
 */
export function withApprovalGuess(actor, file, { now = Date.now(), awaits = rolloutAwaitsApproval } = {}) {
  const last = actor?.turnStates?.at(-1);
  if (!last?.open || !(actor.runningElsewhere || last.status === "interrupted")) return actor;
  return awaits(file, { now }) ? markAwaitingApproval(actor) : actor;
}
