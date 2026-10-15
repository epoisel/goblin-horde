/**
 * One agent's whole conversation for the task view, as the native apps show it and more: every prompt
 * and who sent it, every message as written, readable reasoning, every tool call with its full input and
 * full output, diffs for edits, plans, questions, and subagent spawns. GET /api/transcript reads it for
 * the one agent the person opened, on this computer only (see lib/task-service.mjs).
 *
 * Pages, newest first: a page is at most `limit` entries (200 by default) and about 4 MB of text, so a
 * 30 MB Claude Code transcript is never loaded whole for one request. `before=` pages older entries;
 * `after=` returns what is new, plus any entry that changed since it was sent (a tool call that was
 * still running when the last page went out comes again, by the same id, with its result). Cursors are
 * opaque strings: a byte offset for a Claude Code transcript, Codex's own item cursors for a chat.
 *
 * Every text field goes through redactSecrets once, here; tool output up to 256 KB is shown whole, and
 * past that its head and tail with `outputTruncated: { shownBytes, totalBytes }`.
 */
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import { redactSecrets } from "./claude.mjs";
import { isInside, isLocalPath } from "./paths.mjs";
import { baseName, lineCount, oneLine, relativePath, stepStatus, toMs, unwrapCommand } from "./detail-text.mjs";
import { changeStats } from "./codex-detail.mjs";

export const TRANSCRIPT_LIMITS = Object.freeze({
  pageEntries: 200, // Entries in a page unless the caller asks for fewer or more.
  maxEntries: 500,
  textBytes: 256 * 1024, // A tool's output, input, or diff is shown whole up to this; then head and tail.
  pageBytes: 4 * 1024 * 1024, // A page stops growing past about this much text (it always holds one entry).
  chunkBytes: 1024 * 1024, // A transcript is read backwards this much at a time.
  scanBytes: 64 * 1024 * 1024, // One page never reads more of a transcript than this.
  lookaheadBytes: 8 * 1024 * 1024, // How far past an older page its tool results are looked for.
  lookbackBytes: 8 * 1024 * 1024, // How far back a running call is looked for when its result arrives.
  newBytes: 16 * 1024 * 1024, // An `after` poll reads at most this much new text; past it the page starts over.
  runningIds: 30, // Running calls a cursor remembers, so their results come back as soon as they land.
  cachedPages: 48,
});

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CHAT_ID = /^[A-Za-z0-9_-]{8,100}$/;
const pathApi = (path) => (/^[A-Za-z]:[\\/]|^\\\\/.test(path) ? win32 : posix);

// ---------------------------------------------------------------------------------------------
// Cursors and text

/** An opaque cursor: base64url JSON with a version. */
export function encodeCursor(value) {
  return Buffer.from(JSON.stringify({ v: 1, ...value })).toString("base64url");
}

/** A cursor this module made, or null for anything else (bad base64, another shape, a wrong version). */
export function decodeCursor(text) {
  if (typeof text !== "string" || !text || text.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const value = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
    return value && typeof value === "object" && value.v === 1 ? value : null;
  } catch { return null; }
}

/**
 * A long text as the transcript shows it: credentials removed, whole up to `max` bytes, past that its
 * first and last halves with a line saying how much was left out. { text, truncated? } where truncated
 * is { shownBytes, totalBytes }. Pure.
 */
export function shownText(value, max = TRANSCRIPT_LIMITS.textBytes) {
  const raw = String(value ?? "");
  const totalBytes = Buffer.byteLength(raw);
  if (totalBytes <= max) return { text: redactSecrets(raw) };
  const half = Math.floor(max / 2);
  // Characters approximate bytes here; the counts reported are exact.
  const head = raw.slice(0, half);
  const tail = raw.slice(-half);
  const shownBytes = Buffer.byteLength(head) + Buffer.byteLength(tail);
  const text = `${redactSecrets(head)}\n… ${(totalBytes - shownBytes).toLocaleString("en-US")} bytes not shown …\n${redactSecrets(tail)}`;
  return { text, truncated: { shownBytes, totalBytes } };
}

/** Pretty JSON of a tool's arguments (a string stays as written). */
export function prettyJson(value) {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value ?? {}, null, 2); } catch { return String(value); }
}

/** Short text for titles and plan steps: one line, credentials removed, clipped. */
const short = (value, max = 160) => oneLine(value, max);
const plainText = (value) => redactSecrets(String(value ?? ""));

/** Sets `field` (and `fieldTruncated`) on `target` from a long text, when there is any. */
function putLong(target, field, value) {
  const text = String(value ?? "");
  if (!text) return target;
  const shown = shownText(text);
  target[field] = shown.text;
  if (shown.truncated) target[`${field}Truncated`] = shown.truncated;
  return target;
}

/** About how many bytes an entry holds, for the page budget. */
const entryBytes = (entry) => (entry.text?.length || 0) + (entry.tool ? (entry.tool.input?.length || 0) + (entry.tool.output?.length || 0) + (entry.tool.diff?.length || 0) : 0) + 200;

// ---------------------------------------------------------------------------------------------
// Diffs

const textLines = (text) => {
  const value = String(text ?? "");
  if (!value) return [];
  return value.replace(/\r?\n$/, "").split(/\r?\n/);
};

/** A unified diff from Claude Code's own patch hunks ({ oldStart, oldLines, newStart, newLines, lines }). Pure. */
export function hunksToDiff(path, hunks, { created = false } = {}) {
  const out = [created ? "--- /dev/null" : `--- a/${path}`, `+++ b/${path}`];
  for (const hunk of Array.isArray(hunks) ? hunks : []) {
    out.push(`@@ -${Number(hunk?.oldStart) || 0},${Number(hunk?.oldLines) || 0} +${Number(hunk?.newStart) || 0},${Number(hunk?.newLines) || 0} @@`);
    for (const line of Array.isArray(hunk?.lines) ? hunk.lines : []) out.push(String(line));
  }
  return out.join("\n");
}

/**
 * A unified diff from the text an edit replaced and its replacement, when Claude Code has not written its
 * own patch yet (the edit is waiting or failed). Lines count from the edited text, not the file. Pure.
 */
export function replacementDiff(path, oldText, newText) {
  const before = textLines(oldText);
  const after = textLines(newText);
  return [`--- a/${path}`, `+++ b/${path}`, `@@ -1,${before.length} +1,${after.length} @@`,
    ...before.map((line) => `-${line}`), ...after.map((line) => `+${line}`)].join("\n");
}

/** A new file as a diff against nothing. Pure. */
export function newFileDiff(path, content) {
  const lines = textLines(content);
  return ["--- /dev/null", `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join("\n");
}

/** Added and removed lines in hunks. */
function hunkStats(hunks) {
  let added = 0;
  let removed = 0;
  for (const hunk of Array.isArray(hunks) ? hunks : []) {
    for (const line of Array.isArray(hunk?.lines) ? hunk.lines : []) {
      if (String(line).startsWith("+")) added++;
      else if (String(line).startsWith("-")) removed++;
    }
  }
  return { added, removed };
}

// ---------------------------------------------------------------------------------------------
// Claude Code records

const SHELL_TOOLS = new Set(["Bash", "PowerShell", "BashOutput", "KillShell", "KillBash", "Monitor"]);
const PLAN_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate"]);
// Wrappers Claude Code puts in "user" records the person did not type.
const WRAPPER = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|task-notification|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook|tool-use-error|teammate-message)\b/i;
// Orca's dispatch brief, as a worker receives it (see Orca's orca-dispatch-status-prompt).
const ORCA_DISPATCH = /^\s*(?:Please carry out this task from my Orca coordinator|(?:<pasted_content[^>]{0,64}>\s*)?You are working inside Orca, a multi-agent IDE\.)/;

/** What kind of tool a Claude Code tool name is. */
export function claudeToolKind(name) {
  const tool = String(name || "");
  if (SHELL_TOOLS.has(tool)) return "command";
  if (tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit") return "edit";
  if (tool === "Write") return "write";
  if (tool === "Read" || tool === "NotebookRead" || tool === "LS") return "read";
  if (tool === "Grep" || tool === "Glob" || tool === "ToolSearch") return "search";
  if (tool === "WebFetch" || tool === "WebSearch") return "web";
  if (tool.startsWith("mcp__")) return "mcp";
  if (tool === "Agent" || tool === "Task" || tool === "SendMessage" || tool === "TaskStop" || tool === "ListAgents") return "agent";
  return "other";
}

function blocksOf(record) {
  const content = record?.message?.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

/** A tool result's content as text: text parts as written, an image as a placeholder line. */
export function claudeResultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : prettyJson(content);
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part?.type === "text") return part.text || "";
    if (part?.type === "image") return "[image]";
    if (part?.type === "tool_reference") return `[tool: ${part.tool_name || part.name || "?"}]`;
    return prettyJson(part);
  }).filter(Boolean).join("\n");
}

/** The words of a "user" record's text blocks, images as placeholders. */
function userWords(record) {
  return blocksOf(record).map((block) => (block?.type === "text" ? block.text || "" : block?.type === "image" ? "[image]" : ""))
    .filter(Boolean).join("\n").trim();
}

const tagText = (text, tag) => new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(text)?.[1]?.trim() || "";

/**
 * A "user" record's text that the person did not type, as a system line: a slash command they ran, its
 * output, a shell command typed with "!", a background task's notification. "" for wrappers that only
 * carry context for the model (system reminders, caveats).
 */
function wrapperNote(text) {
  const name = tagText(text, "command-name");
  if (name) return `Ran ${[name, tagText(text, "command-args")].filter(Boolean).join(" ")}`;
  const stdout = tagText(text, "local-command-stdout") || tagText(text, "local-command-stderr");
  if (stdout) return stdout;
  const shell = tagText(text, "bash-input");
  if (shell) return `You ran: ${shell}`;
  const output = tagText(text, "bash-stdout") || tagText(text, "bash-stderr");
  if (output) return output;
  const notice = tagText(text, "task-notification");
  if (notice) return notice.replace(/<\/?[a-z-]+>/gi, "").replace(/\n{3,}/g, "\n\n").trim();
  const hook = tagText(text, "user-prompt-submit-hook");
  if (hook) return `Hook: ${hook}`;
  return "";
}

/** Who sent a Claude Code prompt: the person, the parent agent, the Orca coordinator, or another agent. */
function promptFrom(record, text, { subagent }) {
  if (subagent) return "parent";
  if (record?.origin?.kind === "peer" || /^\s*<teammate-message\b/i.test(text)) return "agent";
  if (ORCA_DISPATCH.test(text)) return "coordinator";
  return "you";
}

/** Whether a tool call's refusal came from the person or a permission rule, not from the tool failing. */
function deniedResult(record, text) {
  if (record?.toolDenialKind) return true;
  return /^(?:The user doesn't want to proceed with this tool use|Permission to use [^\n]{1,80} has been denied|.{0,40}permission (?:was )?denied)/i.test(String(text || "").slice(0, 300));
}

/** A tool's result, from the "user" record that carries it. */
function claudeResult(record, block) {
  const text = claudeResultText(block.content);
  return { at: toMs(record.timestamp) || null, isError: block.is_error === true, text, extra: record.toolUseResult, denied: block.is_error === true && deniedResult(record, text) };
}

/** Plan steps from a TodoWrite list. */
function todoSteps(todos) {
  return (Array.isArray(todos) ? todos : []).filter((item) => item && typeof item === "object").slice(0, 100)
    .map((item) => ({ text: short(item.status === "in_progress" && item.activeForm ? item.activeForm : item.content ?? item.activeForm ?? "", 300), status: stepStatus(item.status) }))
    .filter((step) => step.text);
}

/**
 * One Claude Code tool call as a transcript entry: its full input, full output (or `readOutput` for an
 * output Claude Code saved to its own file), status, exit code, duration, diff, and changed files.
 * `result` is null while it runs. Pure but for `readOutput`.
 */
export function claudeToolEntry(use, result, { session = "", cwd = "", later = false, readOutput = null, turn } = {}) {
  const name = String(use.name || "tool");
  const input = use.input && typeof use.input === "object" ? use.input : {};
  const extra = result?.extra && typeof result.extra === "object" ? result.extra : {};
  const kind = claudeToolKind(name);
  const status = !result ? (later ? "failed" : "running") : result.denied ? "denied" : result.isError ? "failed" : "ok";
  const tool = { name, kind, title: `Used ${short(name, 60)}`, status };
  const path = String(input.file_path ?? input.notebook_path ?? input.path ?? "");
  const shown = relativePath(path, cwd);
  if (SHELL_TOOLS.has(name)) {
    const command = String(input.command ?? input.bash_id ?? input.shell_id ?? "");
    tool.title = short(unwrapCommand(command), 160) || `Used ${name}`;
    putLong(tool, "input", command || prettyJson(input));
    if (typeof input.description === "string" && input.description.trim()) tool.description = short(input.description, 300);
    if (input.run_in_background === true) tool.background = true;
  } else {
    putLong(tool, "input", prettyJson(input));
  }
  if (name === "Edit" || name === "MultiEdit" || name === "NotebookEdit" || name === "Write") {
    const hunks = Array.isArray(extra.structuredPatch) ? extra.structuredPatch : null;
    const created = name === "Write" && (extra.type === "create" || (!hunks?.length && !extra.originalFile && result && !result.isError));
    let diff = "";
    let stats = { added: 0, removed: 0 };
    if (hunks?.length) { diff = hunksToDiff(shown || path, hunks); stats = hunkStats(hunks); }
    else if (name === "Write") { diff = newFileDiff(shown || path, input.content); stats = { added: lineCount(input.content), removed: 0 }; }
    else if (name === "MultiEdit") {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      diff = edits.map((edit) => replacementDiff(shown || path, edit?.old_string, edit?.new_string)).join("\n");
      stats = edits.reduce((sum, edit) => ({ added: sum.added + lineCount(edit?.new_string), removed: sum.removed + lineCount(edit?.old_string) }), { added: 0, removed: 0 });
    } else if (name === "NotebookEdit") { diff = replacementDiff(shown || path, "", input.new_source); stats = { added: lineCount(input.new_source), removed: 0 }; }
    else { diff = replacementDiff(shown || path, input.old_string, input.new_string); stats = { added: lineCount(input.new_string), removed: lineCount(input.old_string) }; }
    tool.title = `${created ? "Created" : name === "Write" ? "Wrote" : "Edited"} ${baseName(path) || "a file"}`;
    putLong(tool, "diff", diff);
    if (path) tool.files = [{ path: plainText(shown || path), ...stats }];
  } else if (kind === "read") tool.title = `${name === "LS" ? "Listed" : "Read"} ${baseName(path) || "a file"}`;
  else if (name === "Grep") tool.title = `Searched for "${short(input.pattern, 80)}"${path ? ` in ${short(shown, 60)}` : ""}`;
  else if (name === "Glob") tool.title = `Looked for ${short(input.pattern, 80)}`;
  else if (name === "ToolSearch") tool.title = `Looked for tools: ${short(input.query, 80)}`;
  else if (name === "WebFetch") { let host = ""; try { host = new URL(String(input.url)).host; } catch { host = String(input.url || ""); } tool.title = `Opened ${short(host, 80) || "a page"}`; }
  else if (name === "WebSearch") tool.title = `Searched the web for "${short(input.query, 80)}"`;
  else if (kind === "mcp") {
    const [, server = "an app", call = ""] = name.split("__");
    tool.title = `${server.replace(/[_-]+/g, " ")}${call ? ` · ${call.replace(/[_-]+/g, " ")}` : ""}`;
  } else if (name === "Agent" || name === "Task") {
    tool.title = `Started ${short(input.subagent_type || "helper", 40)} subagent: ${short(input.description, 100)}`;
    const agentId = typeof extra.agentId === "string" && SAFE_ID.test(extra.agentId) ? extra.agentId : "";
    if (agentId && session) tool.agentId = `claude-agent:${session}:${agentId}`;
    if (input.run_in_background === true || extra.isAsync === true) tool.background = true;
  } else if (name === "SendMessage") tool.title = `Messaged ${short(input.to ?? input.recipient ?? "an agent", 60)}`;
  else if (name === "Skill") tool.title = `Used skill ${short(input.skill ?? input.command ?? "", 60)}`.trim();
  else if (name === "AskUserQuestion") tool.title = `Asked you: ${short(input.questions?.[0]?.question || "a question", 120)}`;
  else if (name === "ExitPlanMode") tool.title = "Proposed a plan";
  else if (name === "TodoWrite") tool.title = "Updated the plan";
  else if (name === "TaskCreate") tool.title = `Added a task: ${short(input.subject ?? input.title ?? input.description, 100)}`;
  else if (name === "TaskUpdate") tool.title = `Updated task ${short(input.taskId ?? input.id ?? "", 20)}${input.status ? `: ${input.status}` : ""}`;
  if (result) {
    if (result.at && use.at) tool.durationMs = Math.max(0, result.at - use.at);
    let output = result.text;
    if (name === "AskUserQuestion" && extra.answers && typeof extra.answers === "object") {
      output = Object.entries(extra.answers).map(([question, answer]) => `${question} → ${answer}`).join("\n") || output;
    }
    // A long output Claude Code kept in its own file instead of the transcript: read it, whole or head and tail.
    let saved = null;
    if (typeof extra.persistedOutputPath === "string" && readOutput) {
      try { saved = readOutput(extra.persistedOutputPath, TRANSCRIPT_LIMITS.textBytes); } catch { saved = null; }
    }
    if (saved?.text) {
      tool.output = saved.text; // Already filtered.
      if (saved.truncated) tool.outputTruncated = saved.truncated;
    } else putLong(tool, "output", output);
    if (SHELL_TOOLS.has(name) && name !== "Monitor") {
      const code = /^Exit code (-?\d+)/m.exec(String(result.text || "").slice(0, 2000));
      if (code) tool.exitCode = Number(code[1]);
      else if (!result.isError) tool.exitCode = 0;
      if (extra.interrupted === true) tool.interrupted = true;
    }
  } else if (later) tool.output = "(No result was recorded.)";
  const entry = { id: use.id, at: use.at || null, ...(turn ? { turn } : {}), kind: "tool", tool };
  if (name === "Agent" || name === "Task") {
    entry.kind = "subagent";
    entry.text = plainText(input.description || input.prompt || "");
  } else if (name === "TodoWrite") {
    entry.kind = "plan";
    entry.plan = { steps: todoSteps(input.todos) };
  } else if (name === "TaskCreate" || name === "TaskUpdate") {
    entry.kind = "plan";
    entry.plan = { steps: [{ text: short(input.subject ?? input.title ?? input.description ?? `Task ${input.taskId ?? ""}`, 300), status: stepStatus(input.status) }], change: name === "TaskCreate" ? "added" : "updated" };
  } else if (name === "ExitPlanMode") {
    entry.kind = "plan";
    entry.text = plainText(input.plan || "");
    entry.plan = { steps: [] };
  } else if (name === "AskUserQuestion") {
    entry.kind = "ask";
    const questions = (Array.isArray(input.questions) ? input.questions : []).slice(0, 8).map((question) => ({
      text: plainText(question?.question || question?.header || ""),
      options: (Array.isArray(question?.options) ? question.options : []).map((option) => plainText(typeof option === "string" ? option : option?.label ?? "")).filter(Boolean),
    })).filter((question) => question.text);
    entry.ask = { kind: "question", text: questions[0]?.text || "Claude Code asked you a question.", questions, answered: Boolean(result) };
  }
  return entry;
}

/** A quick look at a raw line, so the bulky records nothing is shown from (hook output, prompt snapshots, tool lists) are never parsed. */
function skippable(head) {
  if (/^\{"type":"(?:file-history-snapshot|file-history-delta|atis-latch|mode|permission-mode|cost-state|bridge-session|relocated|pr-link|queue-operation)"/.test(head)) return true;
  const attachment = /"attachment":\{"type":"([a-z_]+)"/.exec(head);
  return Boolean(attachment) && attachment[1] !== "queued_command";
}

/** Parse one raw line (a Buffer) into a record, or null. */
function parseLine(buffer) {
  if (!buffer.length) return null;
  const head = buffer.subarray(0, 400).toString("latin1");
  if (skippable(head)) return null;
  try {
    const record = JSON.parse(buffer.toString("utf8"));
    return record && typeof record === "object" && !Array.isArray(record) ? record : null;
  } catch { return null; }
}

/**
 * Transcript entries from Claude Code records in file order ([{ record, offset }]). `results` (tool use
 * id -> result, from these records and any read past them) completes each call; `later` says records
 * exist after these (a call with no result before them did not finish). Main transcripts leave out
 * side-chain records (older Claude Code kept subagents inline). Each entry carries `offset`, the byte
 * offset of the record it came from, for cursors. Pure but for `readOutput`.
 */
export function claudeEntries(records, { session = "", subagent = false, cwd = "", results = new Map(), later = false, readOutput = null } = {}) {
  const entries = [];
  let turn;
  let lastBoundary = -1; // index in `records` of the newest prompt
  const list = Array.isArray(records) ? records : [];
  list.forEach(({ record }, index) => {
    if (record?.type === "user" && !record.isMeta && !record.isCompactSummary && !blocksOf(record).some((block) => block?.type === "tool_result")) {
      const words = userWords(record);
      if (words && !WRAPPER.test(words) && !/^\s*(?:\[Request interrupted by user|Caveat: The messages below)/.test(words)) lastBoundary = index;
    }
  });
  list.forEach(({ record, offset }, index) => {
    if (!record || typeof record !== "object") return;
    if (!subagent && record.isSidechain === true) return;
    const at = toMs(record.timestamp) || null;
    const id = typeof record.uuid === "string" && record.uuid ? record.uuid : `@${offset}`;
    const push = (entry) => entries.push({ ...entry, ...(turn && !entry.turn ? { turn } : {}), offset });
    if (record.type === "user") {
      if (record.isCompactSummary) { push({ id, at, kind: "compaction", text: plainText(userWords(record)) }); return; }
      const blocks = blocksOf(record);
      if (blocks.some((block) => block?.type === "tool_result")) return; // Results complete their calls.
      const words = userWords(record);
      if (!words) return;
      if (record.isMeta && record.origin?.kind !== "peer") return;
      if (/^\s*\[Request interrupted by user/.test(words)) { push({ id, at, kind: "system", text: "Interrupted by you." }); return; }
      if (/^\s*Caveat: The messages below/.test(words)) return;
      if (record.origin?.kind === "task-notification") { push({ id, at, kind: "system", text: plainText(wrapperNote(words) || words) }); return; }
      if (WRAPPER.test(words) && !/^\s*<teammate-message\b/i.test(words)) {
        const note = wrapperNote(words);
        if (note) push({ id, at, kind: "system", text: plainText(note) });
        return;
      }
      turn = id;
      push({ id, at, turn: id, kind: "prompt", from: promptFrom(record, words, { subagent }), text: plainText(words) });
      return;
    }
    if (record.type === "attachment") {
      const attachment = record.attachment;
      if (attachment?.type !== "queued_command" || typeof attachment.prompt !== "string" || !attachment.prompt.trim()) return;
      if (attachment.commandMode === "task-notification" || attachment.origin?.kind === "task-notification") {
        push({ id, at, kind: "system", text: plainText(wrapperNote(attachment.prompt) || attachment.prompt) });
        return;
      }
      turn = id;
      push({ id, at, turn: id, kind: "prompt", from: attachment.origin?.kind === "peer" ? "agent" : subagent ? "parent" : "you", text: plainText(attachment.prompt), queued: true });
      return;
    }
    if (record.type === "system") {
      if (record.subtype === "compact_boundary") {
        const meta = record.compactMetadata && typeof record.compactMetadata === "object" ? record.compactMetadata : {};
        push({ id, at, kind: "compaction", text: `Conversation compacted${meta.trigger ? ` (${short(meta.trigger, 20)})` : ""}${Number(meta.preTokens) ? `, ${Number(meta.preTokens).toLocaleString("en-US")} tokens before` : ""}.` });
      } else if (record.subtype === "api_error") {
        const error = record.error && typeof record.error === "object" ? record.error.message || record.error.error?.message || prettyJson(record.error) : record.error;
        push({ id, at, kind: "error", text: plainText(`Claude's service answered with an error${record.retryAttempt ? ` (try ${record.retryAttempt} of ${record.maxRetries || "?"})` : ""}: ${short(error, 600)}`) });
      } else if (record.subtype === "away_summary" || record.subtype === "informational" || record.subtype === "local_command") {
        const text = typeof record.content === "string" ? record.content : "";
        if (text.trim()) push({ id, at, kind: "system", text: plainText(wrapperNote(text) || text) });
      }
      return;
    }
    if (record.type !== "assistant") return;
    if (record.isApiErrorMessage) { push({ id, at, kind: "error", text: plainText(claudeResultText(record.message?.content)) }); return; }
    blocksOf(record).forEach((block, blockIndex) => {
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        push({ id: `${id}:${blockIndex}`, at, kind: "message", text: plainText(block.text) });
      } else if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
        push({ id: `${id}:${blockIndex}`, at, kind: "reasoning", text: plainText(block.thinking) });
      } else if (block?.type === "tool_use" && typeof block.id === "string") {
        const use = { id: block.id, name: block.name, input: block.input, at };
        push(claudeToolEntry(use, results.get(block.id) || null, { session, cwd, later: later || index < lastBoundary, readOutput, turn }));
      }
    });
  });
  return entries;
}

/** Every tool result in these records, by tool use id. */
function collectResults(records, into = new Map()) {
  for (const { record } of records) {
    if (record?.type !== "user") continue;
    for (const block of blocksOf(record)) {
      if (block?.type === "tool_result" && typeof block.tool_use_id === "string") into.set(block.tool_use_id, claudeResult(record, block));
    }
  }
  return into;
}

// ---------------------------------------------------------------------------------------------
// Reading a transcript by byte offsets

const defaultFs = {
  stat: (path) => { const info = statSync(path); return { size: info.size, mtimeMs: info.mtimeMs }; },
  /** Bytes [start, end) of a file. */
  read: (path, start, end) => {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const to = Math.min(end, size);
      const length = Math.max(0, to - start);
      const buffer = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const count = readSync(fd, buffer, read, length - read, start + read);
        if (!count) break;
        read += count;
      }
      return buffer.subarray(0, read);
    } finally { closeSync(fd); }
  },
};

/**
 * Complete lines of `buffer` (which starts at file offset `base`), with their offsets. A first line that
 * may be cut (`cutStart`) is returned apart as `head` with the rest; a last line with no newline is left
 * out (`end` is where the complete lines stop).
 */
function splitLines(buffer, base, { cutStart = false } = {}) {
  const lines = [];
  let start = 0;
  let head = null;
  let index = buffer.indexOf(0x0a);
  if (cutStart) {
    if (index < 0) return { lines, head: buffer, end: base };
    head = buffer.subarray(0, index);
    start = index + 1;
    index = buffer.indexOf(0x0a, start);
  }
  while (index >= 0) {
    lines.push({ offset: base + start, buffer: buffer.subarray(start, index) });
    start = index + 1;
    index = buffer.indexOf(0x0a, start);
  }
  return { lines, head, end: base + start };
}

/** Records from raw lines, oldest first, unparsable and bulky ones left out. */
function recordsOf(lines) {
  const records = [];
  for (const line of lines) {
    const record = parseLine(line.buffer.at(-1) === 0x0d ? line.buffer.subarray(0, -1) : line.buffer);
    if (record) records.push({ record, offset: line.offset });
  }
  return records;
}

/** Roughly how many entries records make, so a backwards read knows when it has a page. */
function entryCount(records) {
  let count = 0;
  for (const { record } of records) {
    if (record?.type === "assistant") count += Math.max(1, blocksOf(record).length);
    else if (record?.type === "user" && !blocksOf(record).some((block) => block?.type === "tool_result")) count++;
    else if (record?.type === "system" || record?.type === "attachment") count++;
  }
  return count;
}

const fileTag = (file) => createHash("sha256").update(String(file).toLowerCase()).digest("hex").slice(0, 12);

/**
 * Pages of one Claude Code transcript, found through the confined locator in lib/claude-detail.mjs (a
 * file under the Claude config folder's projects only). `fs` and `limits` are injectable for tests.
 */
export class ClaudeTranscripts {
  constructor({ locator, fs = defaultFs, limits = TRANSCRIPT_LIMITS, platform = process.platform } = {}) {
    Object.assign(this, { locator, fs: { ...defaultFs, ...fs }, limits, platform });
    this.pages = new Map(); // cache key -> page
    this.reads = 0; // bytes read, for tests and diagnostics
  }

  read(file, start, end) {
    const buffer = this.fs.read(file, start, end);
    this.reads += buffer.length;
    return buffer;
  }

  /**
   * A tool's output Claude Code saved to its own file (<session>/tool-results/…): read only when its real
   * location is under the Claude config folder's projects, whole up to `max` bytes, else head and tail.
   */
  readOutput(path, max) {
    if (!isLocalPath(path, this.platform) || !this.locator) return null;
    let root;
    let real;
    try { root = this.locator.projectsRoot(); real = this.locator.fs.realpath(path); } catch { return null; }
    if (!isLocalPath(real, this.platform) || real === root || !isInside(real, root, this.platform)) return null;
    let size;
    try { size = this.fs.stat(real).size; } catch { return null; }
    if (size <= max) return shownText(this.read(real, 0, size).toString("utf8"), max);
    const half = Math.floor(max / 2);
    const head = this.read(real, 0, half).toString("utf8");
    const tail = this.read(real, size - half, size).toString("utf8");
    return { text: `${redactSecrets(head)}\n… ${(size - 2 * half).toLocaleString("en-US")} bytes not shown …\n${redactSecrets(tail)}`, truncated: { shownBytes: 2 * half, totalBytes: size } };
  }

  remember(key, page) {
    this.pages.delete(key);
    this.pages.set(key, page);
    while (this.pages.size > this.limits.cachedPages) this.pages.delete(this.pages.keys().next().value);
    return page;
  }

  /** Where this session's (or subagent's) transcript is, or "". */
  locate({ session, agent = "", cwd = "", recorded = {} }) {
    if (!SAFE_ID.test(String(session || "")) || (agent && !SAFE_ID.test(agent))) return "";
    try { return this.locator?.locate({ session, agent, cwd, recorded }) || ""; } catch { return ""; }
  }

  /**
   * One page: { entries, cursor: { first, last }, hasOlder, reset?, file } or null when the transcript
   * cannot be found. `after` / `before` are cursors from an earlier page; a cursor that no longer fits
   * the file (another file, or one that shrank) gives the newest page with `reset: true`.
   */
  page({ session, agent = "", cwd = "", recorded = {}, after = "", before = "", limit = this.limits.pageEntries }) {
    const file = this.locate({ session, agent, cwd, recorded });
    if (!file) return null;
    let info;
    try { info = this.fs.stat(file); } catch { return null; }
    const tag = fileTag(file);
    const ctx = { session, subagent: Boolean(agent), cwd, readOutput: (path, max) => this.readOutput(path, max) };
    const want = Math.max(1, Math.min(this.limits.maxEntries, Number(limit) || this.limits.pageEntries));
    const decoded = decodeCursor(after || before);
    const fits = decoded && decoded.f === tag && decoded.k === (after ? "a" : "b") && Number.isSafeInteger(decoded.o) && decoded.o >= 0 && decoded.o <= info.size;
    if ((after || before) && !fits) return { ...this.newest(file, info, tag, want, ctx), reset: true, file };
    if (after) return { ...this.newer(file, info, tag, decoded, want, ctx), file };
    if (before) return { ...this.older(file, info, tag, decoded.o, want, ctx), file };
    return { ...this.newest(file, info, tag, want, ctx), file };
  }

  /** Read backwards from `end` until about `want` entries are in view; records oldest first. */
  backwards(file, end, want) {
    let position = end;
    let carry = null; // the cut first line of the newer chunk
    let records = [];
    let scanned = 0;
    while (position > 0 && scanned < this.limits.scanBytes) {
      const start = Math.max(0, position - this.limits.chunkBytes);
      let buffer = this.read(file, start, position);
      scanned += buffer.length;
      if (carry) buffer = Buffer.concat([buffer, carry]);
      const { lines, head } = splitLines(Buffer.concat([buffer, Buffer.from("\n")]), start, { cutStart: start > 0 });
      carry = head;
      records = [...recordsOf(lines.filter((line) => line.offset < end)), ...records];
      position = start;
      if (entryCount(records) > want + 8) break;
    }
    return { records, start: records[0]?.offset ?? position };
  }

  /** Results for calls in `records` that have none yet, looked for after `from` (bounded). */
  lookahead(file, from, size, records, results) {
    const open = new Set();
    for (const { record } of records) for (const block of blocksOf(record)) if (block?.type === "tool_use" && !results.has(block.id)) open.add(block.id);
    let position = from;
    let carry = Buffer.alloc(0);
    while (open.size && position < size && position - from < this.limits.lookaheadBytes) {
      const end = Math.min(size, position + this.limits.chunkBytes);
      const buffer = Buffer.concat([carry, this.read(file, position, end)]);
      const base = position - carry.length;
      const { lines, end: complete } = splitLines(buffer, base);
      carry = buffer.subarray(complete - base);
      for (const line of lines) {
        if (!line.buffer.includes('"tool_use_id"')) continue;
        const ids = [...open].filter((id) => line.buffer.includes(id));
        if (!ids.length) continue;
        const parsed = recordsOf([line]);
        collectResults(parsed, results);
        for (const id of ids) if (results.has(id)) open.delete(id);
      }
      position = end;
    }
  }

  /** Entries of `records` trimmed to the newest `want` (whole records) and the page byte budget. */
  trim(entries, want) {
    let budget = this.limits.pageBytes;
    let keep = 0;
    for (let index = entries.length - 1; index >= 0 && keep < want; index--) {
      budget -= entryBytes(entries[index]);
      if (budget < 0 && keep > 0) break;
      keep++;
    }
    let first = entries.length - keep;
    // Whole records: an entry that shares its record with a kept one stays too.
    while (first > 0 && entries[first - 1].offset === entries[first]?.offset) first--;
    return entries.slice(first);
  }

  pageOf(entries, { tag, oldestOffset, end, hasOlderBefore }) {
    const running = entries.filter((entry) => entry.tool?.status === "running").map((entry) => entry.id).slice(-this.limits.runningIds);
    const first = entries.length ? entries[0].offset : oldestOffset;
    return {
      entries: entries.map(({ offset, ...entry }) => entry),
      cursor: { first: encodeCursor({ k: "b", f: tag, o: first }), last: encodeCursor({ k: "a", f: tag, o: end, r: running }) },
      hasOlder: hasOlderBefore(first),
    };
  }

  newest(file, info, tag, want, ctx) {
    const key = `${file}|${info.size}|${info.mtimeMs}|newest|${want}`;
    const saved = this.pages.get(key);
    if (saved) return saved;
    const tail = this.read(file, Math.max(0, info.size - 1), info.size);
    // Only complete lines: a record still being written waits for the next poll.
    let end = info.size;
    if (tail.length && tail[0] !== 0x0a) {
      const chunk = this.read(file, Math.max(0, info.size - this.limits.chunkBytes), info.size);
      const last = chunk.lastIndexOf(0x0a);
      end = last < 0 ? Math.max(0, info.size - chunk.length) : info.size - chunk.length + last + 1;
    }
    const { records } = this.backwards(file, end, want);
    const results = collectResults(records);
    const entries = this.trim(claudeEntries(records, { ...ctx, results }), want);
    return this.remember(key, this.pageOf(entries, { tag, oldestOffset: 0, end, hasOlderBefore: (first) => first > 0 }));
  }

  older(file, info, tag, offset, want, ctx) {
    const key = `${file}|before|${offset}|${want}`;
    const saved = this.pages.get(key);
    if (saved && saved.size <= info.size) return saved.page;
    const { records } = this.backwards(file, offset, want);
    const results = collectResults(records);
    this.lookahead(file, offset, info.size, records, results);
    const entries = this.trim(claudeEntries(records, { ...ctx, results, later: true }), want);
    const page = this.pageOf(entries, { tag, oldestOffset: 0, end: offset, hasOlderBefore: (first) => first > 0 });
    // An older page whose calls all finished never changes again.
    if (!page.entries.some((entry) => entry.tool?.status === "running")) this.remember(key, { size: info.size, page });
    return page;
  }

  /** What was written after the cursor, and the calls it left running, now with their results. */
  newer(file, info, tag, cursor, want, ctx) {
    const running = Array.isArray(cursor.r) ? cursor.r.filter((id) => typeof id === "string" && id.length <= 200).slice(0, this.limits.runningIds) : [];
    const from = cursor.o;
    if (info.size - from > this.limits.newBytes) return { ...this.newest(file, info, tag, want, ctx), reset: true };
    let records = [];
    let end = from;
    if (info.size > from) {
      const buffer = this.read(file, from, info.size);
      const split = splitLines(buffer, from);
      records = recordsOf(split.lines);
      end = split.end;
    }
    const results = collectResults(records);
    const entries = claudeEntries(records, { ...ctx, results });
    // Calls the last page showed running: send them again once their result is in.
    const finished = running.filter((id) => results.has(id));
    if (finished.length) {
      const uses = this.findUses(file, from, finished);
      const again = claudeEntries(uses, { ...ctx, results }).filter((entry) => finished.includes(entry.id));
      entries.unshift(...again.map((entry) => ({ ...entry, updated: true })));
    }
    const stillRunning = running.filter((id) => !results.has(id));
    const page = this.pageOf(entries, { tag, oldestOffset: from, end, hasOlderBefore: () => from > 0 });
    const newRunning = page.entries.filter((entry) => entry.tool?.status === "running").map((entry) => entry.id);
    page.cursor.last = encodeCursor({ k: "a", f: tag, o: end, r: [...new Set([...stillRunning, ...newRunning])].slice(-this.limits.runningIds) });
    page.cursor.first = encodeCursor({ k: "b", f: tag, o: page.entries.length ? entries.find((entry) => !entry.updated)?.offset ?? from : from });
    page.hasOlder = from > 0;
    return page;
  }

  /** The records holding these tool calls, looked for backwards from `before` (bounded). */
  findUses(file, before, ids) {
    const found = [];
    const open = new Set(ids);
    let position = before;
    let carry = null;
    while (open.size && position > 0 && before - position < this.limits.lookbackBytes) {
      const start = Math.max(0, position - this.limits.chunkBytes);
      let buffer = this.read(file, start, position);
      if (carry) buffer = Buffer.concat([buffer, carry]);
      const { lines, head } = splitLines(Buffer.concat([buffer, Buffer.from("\n")]), start, { cutStart: start > 0 });
      carry = head;
      for (const line of lines) {
        if (line.offset >= before || !line.buffer.includes('"tool_use"')) continue;
        const ids = [...open].filter((id) => line.buffer.includes(id));
        if (!ids.length) continue;
        found.push(...recordsOf([line]));
        for (const id of ids) open.delete(id);
      }
      position = start;
    }
    return found.sort((a, b) => a.offset - b.offset);
  }
}

// ---------------------------------------------------------------------------------------------
// Codex chats

function codexInputText(content) {
  return (Array.isArray(content) ? content : []).map((part) => {
    if (part?.type === "text") return part.text || "";
    if (part?.type === "image") return "[image]";
    if (part?.type === "localImage") return `[image: ${baseName(part.path) || "file"}]`;
    if (part?.type === "skill") return `[skill: ${part.name || ""}]`;
    if (part?.type === "mention") return `@${part.name || ""}`;
    if (part?.type === "audio" || part?.type === "localAudio") return "[audio]";
    return "";
  }).filter(Boolean).join("\n").trim();
}

function mcpOutput(item) {
  if (item.error?.message) return String(item.error.message);
  const content = Array.isArray(item.result?.content) ? item.result.content : [];
  const text = content.map((part) => (typeof part === "string" ? part : part?.type === "text" ? part.text || "" : part?.type === "image" ? "[image]" : prettyJson(part))).filter(Boolean).join("\n");
  if (text) return text;
  return item.result?.structuredContent != null ? prettyJson(item.result.structuredContent) : "";
}

const CODEX_STATUS = { inprogress: "running", in_progress: "running", completed: "ok", failed: "failed", declined: "denied", error: "failed" };
const codexStatus = (status) => CODEX_STATUS[String(status || "").toLowerCase()] || "ok";

/** One Codex file change as a unified diff with its own file header: updates as Codex wrote them, adds and deletes as whole files. */
export function codexChangeDiff(change) {
  const path = String(change?.path || "");
  const kind = String(change?.kind?.type ?? change?.kind ?? "update");
  const moved = typeof change?.kind?.move_path === "string" && change.kind.move_path ? change.kind.move_path : "";
  const body = String(change?.diff ?? "");
  const looksLikeDiff = /^@@|\n@@/.test(body);
  if (kind === "add") return looksLikeDiff ? `--- /dev/null\n+++ b/${path}\n${body}` : newFileDiff(path, body);
  if (kind === "delete") {
    if (looksLikeDiff) return `--- a/${path}\n+++ /dev/null\n${body}`;
    const lines = textLines(body);
    return [`--- a/${path}`, "+++ /dev/null", `@@ -1,${lines.length} +0,0 @@`, ...lines.map((line) => `-${line}`)].join("\n");
  }
  return `--- a/${path}\n+++ b/${moved || path}\n${body}`;
}

/**
 * Transcript entries for Codex items ([{ turnId, item, startedAtMs, completedAtMs }], oldest first, as
 * thread/items/list gives them). `subagent`: the chat was started by another, so its prompts come from
 * that parent. `turns` (turn id -> { status, error, completedAt }) adds a turn's failure or interruption
 * after its last item. Pure.
 */
export function codexEntries(list, { subagent = false, cwd = "", turns = new Map() } = {}) {
  const entries = [];
  const items = Array.isArray(list) ? list : [];
  items.forEach((wrapped, index) => {
    const item = wrapped?.item;
    if (!item || typeof item !== "object") return;
    const turn = String(wrapped.turnId || "") || undefined;
    const at = Number(wrapped.startedAtMs) || Number(wrapped.completedAtMs) || null;
    const id = String(item.id || `${turn}:${index}`);
    const base = { id, at, ...(turn ? { turn } : {}) };
    const tool = (fields) => entries.push({ ...base, kind: "tool", tool: fields });
    const status = codexStatus(item.status);
    const duration = Number.isFinite(item.durationMs) ? { durationMs: item.durationMs }
      : wrapped.completedAtMs && wrapped.startedAtMs ? { durationMs: Math.max(0, wrapped.completedAtMs - wrapped.startedAtMs) } : {};
    switch (item.type) {
      case "userMessage": {
        const text = codexInputText(item.content);
        if (text) entries.push({ ...base, kind: "prompt", from: subagent ? "parent" : "you", text: plainText(text) });
        break;
      }
      case "hookPrompt": {
        const text = (Array.isArray(item.fragments) ? item.fragments : []).map((part) => part?.text || "").filter(Boolean).join("\n");
        if (text.trim()) entries.push({ ...base, kind: "system", text: plainText(text) });
        break;
      }
      case "agentMessage": {
        const text = typeof item.text === "string" ? item.text : (Array.isArray(item.content) ? item.content.map((part) => part?.text || "").join("\n") : "");
        if (!text.trim()) break;
        const entry = { ...base, kind: "message", text: plainText(text), ...(item.phase ? { phase: String(item.phase) } : {}) };
        const questions = (Array.isArray(item.questions) ? item.questions : []).map((question) => ({ text: plainText(question?.title || ""),
          options: (Array.isArray(question?.options) ? question.options : []).map((option) => plainText(option)) })).filter((question) => question.text);
        if (questions.length) entry.ask = { kind: "question", text: questions[0].text, questions };
        entries.push(entry);
        break;
      }
      case "reasoning": {
        const summary = (Array.isArray(item.summary) ? item.summary : []).map(String).filter((part) => part.trim());
        const content = (Array.isArray(item.content) ? item.content : []).map(String).filter((part) => part.trim());
        const text = (summary.length ? summary : content).join("\n\n");
        if (text.trim()) entries.push({ ...base, kind: "reasoning", text: plainText(text) });
        break;
      }
      case "plan":
        if (String(item.text || "").trim()) entries.push({ ...base, kind: "plan", text: plainText(item.text), plan: { steps: [] } });
        break;
      case "commandExecution": {
        const command = String(item.command ?? "");
        const fields = { name: "shell", kind: "command", title: short(unwrapCommand(command), 160) || "Ran a command", status, ...duration };
        putLong(fields, "input", command);
        if (item.cwd) fields.cwd = plainText(relativePath(String(item.cwd), cwd) || item.cwd);
        if (Number.isFinite(item.exitCode)) {
          fields.exitCode = item.exitCode;
          if (item.exitCode !== 0 && fields.status === "ok") fields.status = "failed";
        }
        putLong(fields, "output", item.aggregatedOutput || "");
        tool(fields);
        break;
      }
      case "fileChange": {
        const changes = Array.isArray(item.changes) ? item.changes
          : item.changes && typeof item.changes === "object" ? Object.entries(item.changes).map(([path, change]) => ({ path, ...change })) : [];
        const kinds = changes.map((change) => String(change?.kind?.type ?? change?.kind ?? "update"));
        const verb = kinds.length && kinds.every((kind) => kind === "add") ? "Created" : kinds.length && kinds.every((kind) => kind === "delete") ? "Deleted" : "Edited";
        const paths = changes.map((change) => relativePath(String(change?.path || ""), cwd)).filter(Boolean);
        const fields = { name: "apply_patch", kind: verb === "Created" ? "write" : "edit", title: changes.length === 1 ? `${verb} ${baseName(paths[0])}` : `${verb} ${changes.length} files`, status, ...duration };
        putLong(fields, "input", paths.join("\n"));
        putLong(fields, "diff", changes.map((change) => codexChangeDiff({ ...change, path: relativePath(String(change?.path || ""), cwd) })).join("\n"));
        fields.files = changes.map((change) => ({ path: plainText(relativePath(String(change?.path || ""), cwd)), ...changeStats(change) }));
        tool(fields);
        break;
      }
      case "mcpToolCall": {
        const fields = { name: `${item.server || "mcp"}.${item.tool || "tool"}`, kind: "mcp", title: `${String(item.server || "an app").replace(/[_-]+/g, " ")} · ${String(item.tool || "tool").replace(/[_]+/g, " ")}`,
          status: item.error ? "failed" : status, ...duration };
        putLong(fields, "input", prettyJson(item.arguments));
        putLong(fields, "output", mcpOutput(item));
        tool(fields);
        break;
      }
      case "dynamicToolCall": {
        const fields = { name: String(item.tool || "tool"), kind: "other", title: `Used ${short(item.tool || "a tool", 60)}`, status: item.success === false ? "failed" : status, ...duration };
        putLong(fields, "input", prettyJson(item.arguments));
        putLong(fields, "output", (Array.isArray(item.contentItems) ? item.contentItems : []).map((part) => part?.text || (part?.imageUrl ? "[image]" : "")).filter(Boolean).join("\n"));
        tool(fields);
        break;
      }
      case "functionCallOutput":
        tool(putLong({ name: String(item.name || "tool"), kind: "other", title: `Result of ${short(item.name || "a tool", 60)}`, status: "ok" }, "output", prettyJson(item.output)));
        break;
      case "collabAgentToolCall": {
        const receivers = (Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []).filter((value) => CHAT_ID.test(String(value)));
        const states = item.agentsStates && typeof item.agentsStates === "object"
          ? Object.entries(item.agentsStates).map(([agent, state]) => `${agent}: ${state?.status || "?"}${state?.message ? ` · ${state.message}` : ""}`).join("\n") : "";
        const toolName = String(item.tool || "");
        const title = toolName === "spawnAgent" ? "Started a subagent" : toolName === "wait" ? "Waited for subagents" : /send|message|followup/i.test(toolName) ? "Messaged a subagent"
          : toolName === "closeAgent" ? "Closed a subagent" : toolName === "interruptAgent" ? "Interrupted a subagent" : toolName === "resumeAgent" ? "Resumed a subagent"
            : toolName === "listAgents" ? "Listed its subagents" : `Used ${short(toolName || "a subagent tool", 60)}`;
        const fields = { name: toolName || "agent", kind: "agent", title, status, ...(receivers[0] ? { agentId: receivers[0] } : {}) };
        putLong(fields, "input", item.prompt || prettyJson({ receivers }));
        putLong(fields, "output", states);
        if (toolName === "spawnAgent") entries.push({ ...base, kind: "subagent", text: plainText(item.prompt || ""), tool: fields });
        else tool(fields);
        break;
      }
      case "subAgentActivity": {
        const words = { started: "started", interacted: "was messaged", interrupted: "was interrupted", completed: "finished" }[item.kind] || String(item.kind || "changed");
        entries.push({ ...base, kind: "system", text: plainText(`Subagent ${item.agentPath || ""} ${words}.`.replace(/\s+/g, " ")),
          ...(CHAT_ID.test(String(item.agentThreadId)) ? { agentId: item.agentThreadId } : {}) });
        break;
      }
      case "webSearch": {
        const action = item.action && typeof item.action === "object" ? item.action : {};
        const query = String(item.query || action.query || (Array.isArray(action.queries) ? action.queries.join(" · ") : "") || "");
        const title = action.type === "openPage" ? `Opened ${short(action.url, 100)}` : action.type === "findInPage" ? `Searched a page for "${short(action.pattern, 60)}"`
          : query ? `Searched the web for "${short(query, 100)}"` : "Searched the web";
        const fields = { name: "web_search", kind: "web", title, status: "ok" };
        putLong(fields, "input", query || prettyJson(action));
        if (Array.isArray(item.results) && item.results.length) putLong(fields, "output", prettyJson(item.results));
        tool(fields);
        break;
      }
      case "imageView":
        tool(putLong({ name: "view_image", kind: "read", title: `Viewed ${baseName(item.path) || "an image"}`, status: "ok" }, "input", relativePath(String(item.path || ""), cwd)));
        break;
      case "imageGeneration":
        entries.push({ ...base, kind: "system", text: "Generated an image." });
        break;
      case "enteredReviewMode":
      case "exitedReviewMode":
        entries.push({ ...base, kind: "system", text: plainText(`${item.type === "enteredReviewMode" ? "Started a review" : "Finished a review"}${item.review ? `: ${item.review}` : "."}`) });
        break;
      case "contextCompaction":
        entries.push({ ...base, kind: "compaction", text: "Conversation compacted." });
        break;
      case "sleep":
        tool({ name: "sleep", kind: "other", title: "Waited", status: "ok", ...duration });
        break;
      default:
        break;
    }
    // A turn that failed or was stopped says so after its last item.
    const next = items[index + 1];
    const meta = turn ? turns.get(turn) : null;
    if (meta && meta.completedAt && (!next || String(next.turnId || "") !== turn) && (meta.status === "failed" || meta.status === "interrupted")) {
      const text = meta.status === "failed" ? `The turn failed${meta.error?.message ? `: ${meta.error.message}` : "."}${meta.error?.additionalDetails ? `\n${meta.error.additionalDetails}` : ""}` : "Stopped before it finished.";
      entries.push({ id: `${turn}:end`, at: toMs(meta.completedAt) || null, turn, kind: meta.status === "failed" ? "error" : "system", text: plainText(text) });
    }
  });
  return entries;
}

/** Plan updates (from the chat's session file) placed among entries by time; the rest keep their order. */
export function withPlanUpdates(entries, updates) {
  if (!updates?.length) return entries;
  const out = [...entries];
  for (const update of [...updates].sort((a, b) => a.at - b.at)) {
    if (out.some((entry) => entry.id === update.id)) continue;
    let index = out.findIndex((entry) => entry.at && entry.at > update.at);
    if (index < 0) index = out.length;
    const before = out[index - 1];
    out.splice(index, 0, { id: update.id, at: update.at, ...(before?.turn ? { turn: before.turn } : {}), kind: "plan", plan: { steps: update.steps } });
  }
  return out;
}

/**
 * Pages of one Codex chat through the app-server's thread/items/list (each item with its own times),
 * newest first. `request(method, params)` is the CodexReader's; `plans(path)` gives the update_plan calls
 * in the chat's session file ([{ id, at, steps }]); `meta(threadId)` its { path, cwd }.
 */
export class CodexTranscripts {
  constructor({ request, plans = () => [], limits = TRANSCRIPT_LIMITS } = {}) {
    Object.assign(this, { request, plans, limits });
  }

  /** Turn statuses for the turns these items belong to (newest 20 turns, without their items). */
  async turnMeta(threadId) {
    try {
      const result = await this.request("thread/turns/list", { threadId, limit: 20, sortDirection: "desc", itemsView: "notLoaded" });
      return new Map((result?.data || []).map((turn) => [String(turn.id), turn]));
    } catch { return new Map(); }
  }

  async items(threadId, params) {
    const result = await this.request("thread/items/list", { threadId, ...params });
    return { data: Array.isArray(result?.data) ? result.data : [], nextCursor: result?.nextCursor || null, backwardsCursor: result?.backwardsCursor || null };
  }

  /** One page: { entries, cursor, hasOlder, reset? }. */
  async page(threadId, { after = "", before = "", limit = this.limits.pageEntries, subagent = false, cwd = "", path = "" } = {}) {
    if (!CHAT_ID.test(String(threadId))) return null;
    const want = Math.max(1, Math.min(this.limits.maxEntries, Number(limit) || this.limits.pageEntries));
    const decoded = decodeCursor(after || before);
    const ctx = { subagent, cwd };
    let updates = [];
    try { updates = (await this.plans(path)) || []; } catch { updates = []; }
    if (before && decoded?.k === "cb" && typeof decoded.c === "string") {
      try {
        const page = await this.items(threadId, { limit: want, sortDirection: "desc", cursor: decoded.c });
        return this.shape(threadId, [...page.data].reverse(), page.nextCursor, { ...ctx, turns: await this.turnMeta(threadId), updates, olderThan: decoded.at || 0 });
      } catch { /* An old cursor Codex no longer takes: start again from the newest page. */ }
      return { ...(await this.newest(threadId, want, ctx, updates)), reset: true };
    }
    // A chat that had no items yet: everything it has now is new.
    if (after && decoded?.k === "ca" && decoded.id === "") return this.newest(threadId, want, ctx, updates);
    if (after && decoded?.k === "ca" && typeof decoded.id === "string") return this.newer(threadId, decoded, want, ctx, updates);
    if (after || before) return { ...(await this.newest(threadId, want, ctx, updates)), reset: true };
    return this.newest(threadId, want, ctx, updates);
  }

  async newest(threadId, want, ctx, updates) {
    const page = await this.items(threadId, { limit: want, sortDirection: "desc" });
    return this.shape(threadId, [...page.data].reverse(), page.nextCursor, { ...ctx, turns: await this.turnMeta(threadId), updates });
  }

  shape(threadId, items, olderCursor, { subagent, cwd, turns, updates, olderThan = 0, newerThan = 0 }) {
    let entries = codexEntries(items, { subagent, cwd, turns });
    const oldestAt = Number(items[0]?.startedAtMs) || Number(items[0]?.completedAtMs) || 0;
    const newestAt = Math.max(0, ...items.map((item) => Number(item.completedAtMs) || Number(item.startedAtMs) || 0));
    const inRange = updates.filter((update) => update.at && (!olderCursor || update.at >= oldestAt) && (!olderThan || update.at < olderThan) && (!newerThan || update.at > newerThan));
    entries = withPlanUpdates(entries, inRange);
    const newest = items.at(-1);
    const running = items.filter((item) => codexStatus(item.item?.status) === "running").map((item) => String(item.item.id)).slice(-this.limits.runningIds);
    return {
      entries,
      cursor: {
        first: olderCursor ? encodeCursor({ k: "cb", c: olderCursor, at: oldestAt }) : "",
        last: encodeCursor({ k: "ca", id: newest ? String(newest.item?.id || "") : "", at: Math.max(newestAt, newerThan), r: running }),
      },
      hasOlder: Boolean(olderCursor),
    };
  }

  /** Items newer than the cursor's, and the ones it saw running, read newest first until the cursor's item. */
  async newer(threadId, cursor, want, ctx, updates) {
    const running = new Set((Array.isArray(cursor.r) ? cursor.r : []).filter((id) => typeof id === "string").slice(0, this.limits.runningIds));
    const fresh = [];
    const again = [];
    let next = null;
    let found = !cursor.id;
    for (let page = 0; page < 5 && !found; page++) {
      const result = await this.items(threadId, { limit: Math.max(want, 50), sortDirection: "desc", ...(next ? { cursor: next } : {}) });
      for (const item of result.data) {
        const id = String(item.item?.id || "");
        if (id === cursor.id) {
          found = true;
          // The cursor's own item may have changed (a running command finished).
          if (running.has(id)) again.push(item);
          continue;
        }
        if (!found) fresh.push(item);
        else if (running.has(id)) again.push(item);
      }
      // Calls seen running sit just before the cursor's item: they are in this page or not looked for.
      if (!result.nextCursor) break;
      next = result.nextCursor;
    }
    if (!found) return { ...(await this.newest(threadId, want, ctx, updates)), reset: true };
    const items = [...again.reverse(), ...fresh.reverse()];
    const shaped = this.shape(threadId, items, null, { ...ctx, turns: await this.turnMeta(threadId), updates, newerThan: Number(cursor.at) || 0 });
    const againIds = new Set(again.map((item) => String(item.item?.id || "")));
    shaped.entries = shaped.entries.map((entry) => (againIds.has(entry.id) ? { ...entry, updated: true } : entry));
    const stillRunning = [...running].filter((id) => !again.some((item) => String(item.item?.id) === id && codexStatus(item.item?.status) !== "running"));
    const newest = fresh[0];
    const last = decodeCursor(shaped.cursor.last);
    shaped.cursor = {
      first: shaped.cursor.first,
      last: encodeCursor({ k: "ca", id: newest ? String(newest.item?.id || "") : cursor.id, at: Math.max(Number(cursor.at) || 0, last?.at || 0),
        r: [...new Set([...stillRunning, ...(last?.r || [])])].slice(-this.limits.runningIds) }),
    };
    shaped.hasOlder = true;
    return shaped;
  }
}

// ---------------------------------------------------------------------------------------------
// Orca agents with no session of their own on this computer

/**
 * What Orca reported about an agent whose own transcript is not on this computer (a Codex CLI in an Orca
 * pane, or a Claude Code session without the hook): its recent messages and tool calls, oldest first,
 * and its terminal screen when asked. Pure.
 */
export function orcaEntries(events, { screen = null } = {}) {
  const entries = (Array.isArray(events) ? events : []).filter((event) => event && event.title !== "Status").map((event) => {
    const at = Number(event.turnStartedAt) || null;
    if (event.kind === "tool") {
      const name = String(event.title || "").replace(/^Used /, "");
      const fields = { name, kind: /^(Bash|PowerShell)$/i.test(name) ? "command" : claudeToolKind(name), title: short(event.detail || name, 160) || `Used ${name}`,
        status: event.status === "inProgress" ? "running" : event.status === "failed" ? "failed" : "ok" };
      putLong(fields, "input", event.detail || "");
      return { id: String(event.id), at, kind: "tool", tool: fields };
    }
    return { id: String(event.id), at, kind: "message", text: plainText(event.description || "") };
  });
  if (screen?.lines?.length) entries.push({ id: `screen:${screen.at || 0}`, at: screen.at || null, kind: "system", text: plainText(screen.lines.join("\n")), screen: true });
  return entries;
}

export { pathApi as transcriptPathApi };
