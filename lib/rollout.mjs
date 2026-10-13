/**
 * Whether a Codex chat running in another process (the Codex app or CLI) looks to be waiting for an
 * approval.
 *
 * Codex never saves the approval request itself, and the step it would approve is not listed until it
 * runs. What the chat's own session file does show is the model's tool call with no result after it.
 * A long-running command looks the same, so this is a guess, made only when all of these hold:
 *   - the turn's approval policy can ask at all (policy "never" never waits on anyone),
 *   - the newest tool call has no output and no step finished after it,
 *   - nothing at all has been written for `quietMs`.
 * Only record types, call ids, timestamps, and the approval policy are read; no content.
 */
import { readFileTail } from "./claude.mjs";

export const APPROVAL_QUIET_MS = 45_000;
const CALLS = new Set(["custom_tool_call", "function_call", "local_shell_call"]);
const OUTPUTS = new Set(["custom_tool_call_output", "function_call_output", "local_shell_call_output"]);
// Bookkeeping Codex writes right after a call; it says nothing about progress.
const BOOKKEEPING = new Set(["token_usage_record", "token_count"]);

export function looksLikeApprovalWait(text, { now = Date.now(), quietMs = APPROVAL_QUIET_MS } = {}) {
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
  return Boolean(openCall) && policy !== "never" && policy !== "" && lastAt > 0 && now - lastAt >= quietMs;
}

/** The same check on a session file on disk; false when it cannot be read. */
export function rolloutAwaitsApproval(file, { now = Date.now(), quietMs = APPROVAL_QUIET_MS, readTail = readFileTail } = {}) {
  if (typeof file !== "string" || !/\.jsonl$/i.test(file)) return false;
  try {
    return looksLikeApprovalWait(readTail(file.replace(/^\\\\\?\\/, ""), 256 * 1024), { now, quietMs });
  } catch {
    return false;
  }
}
