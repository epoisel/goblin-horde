/**
 * What Orca commands and Orca's own texts say about who works for whom, read without Orca itself.
 *
 * - commandTerminals: which Orca terminals a command line directs (`orca orchestration dispatch --to
 *   term_…`, `orca terminal send --terminal term_…`). Shared by the Codex party links (lib/links.mjs) and
 *   the Claude Code hook (lib/claude.mjs), which records these before its credential filter blanks long
 *   ids such as terminal handles.
 * - commandEvidence: what one Orca command a Codex chat ran, with its JSON output, proves: the runs it
 *   created (and their coordinator terminals), the tasks and dispatches it started, the terminals it
 *   created or assigned work to, the Claude Code session ids a terminal's screen showed, and marks of
 *   the words it typed into a terminal (to know those words when a worker receives them).
 * - briefFacts: what Orca's dispatch brief tells a worker: its task id, its own terminal handle, its
 *   coordinator's handle, and the task's title.
 * No dependencies but node:crypto.
 */
import { createHash } from "node:crypto";

export const ORCA_HANDLE_TEXT = "term_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const COMMAND = /\borca(?:\.exe)?\s+(orchestration|terminal)\s+([a-z][a-z-]*)([^|;&\n]*)/gi;
const ADDRESSED = new RegExp(String.raw`--(terminal|from|to)[ =]+["'\x60]?(${ORCA_HANDLE_TEXT})`, "g");
// Terminal subcommands that only look at a terminal; a chat looks at many it does not drive.
const OBSERVING = new Set(["read", "show", "list", "switch", "close"]);
const HANDLE = new RegExp(`^${ORCA_HANDLE_TEXT}$`);
const ANY_HANDLE = new RegExp(ORCA_HANDLE_TEXT, "g");
const RUN_ID = /^run_[A-Za-z0-9]{6,40}$/;
const TASK_ID = /^task_[A-Za-z0-9]{6,40}$/;
const DISPATCH_ID = /^[A-Za-z0-9_-]{6,60}$/;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;

/**
 * The Orca terminals one command line addresses with a driving verb: [{ terminal, verb, flag }], where
 * `verb` is "orchestration dispatch", "terminal send", … and `flag` the flag that named the terminal
 * ("terminal", "to", or "from"). Commands that only look at a terminal are left out. Pure.
 */
export function commandTerminals(command) {
  if (typeof command !== "string" || !command.includes("orca")) return [];
  const found = [];
  for (const match of command.slice(0, 65_536).matchAll(COMMAND)) {
    const [, kind, verb, rest] = match;
    if (kind.toLowerCase() === "terminal" && OBSERVING.has(verb.toLowerCase())) continue;
    for (const flag of rest.matchAll(ADDRESSED)) found.push({ terminal: flag[2], verb: `${kind} ${verb}`.toLowerCase(), flag: flag[1].toLowerCase() });
  }
  return found;
}

/**
 * A comparable mark for words typed into a terminal or sent to a worker, so the prompt a worker received
 * can be matched to the command that sent it without keeping either text: spacing collapsed, the first
 * 160 characters, hashed. "" for text too short to tell senders apart. Pure.
 */
export function wordsMark(text) {
  const words = String(text ?? "").replace(/<\/?pasted_content[^>]*>/g, " ").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return words.length < 16 ? "" : createHash("sha256").update(words.slice(0, 160)).digest("hex").slice(0, 16);
}

/** One flag's value from a command line: --name value, --name=value, quoted or not. */
function flagValue(rest, name) {
  const match = new RegExp(String.raw`--${name}(?:=|\s+)(?:"((?:[^"\\]|\\.){0,8000})"|'([^']{0,8000})'|([^\s"']{1,400}))`).exec(rest);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "").replace(/\\"/g, "\"") : "";
}

/** The first JSON object in a command's output (Orca prints one with --json), or null. */
function outputJson(output) {
  const text = String(output ?? "");
  const start = text.indexOf("{");
  if (start < 0) return null;
  const end = text.lastIndexOf("}");
  try { return JSON.parse(text.slice(start, end + 1)); } catch { /* Trailing text or a cut output. */ }
  return null;
}

/** Values of these keys anywhere in an object, at most `depth` levels down. */
function valuesOf(object, keys, depth = 5, out = []) {
  if (!object || typeof object !== "object" || depth < 0) return out;
  for (const [key, value] of Object.entries(object)) {
    if (keys.has(key) && typeof value === "string") out.push(value);
    else if (value && typeof value === "object") valuesOf(value, keys, depth - 1, out);
  }
  return out;
}

const HANDLE_KEYS = new Set(["agentTerminalHandle", "terminalHandle", "assigneeHandle", "assignee_handle", "handle"]);

/**
 * What one Orca command a Codex chat ran proves, with the command's output: { runs: [{ id, coordinator? }],
 * tasks: [{ id, run?, dispatch?, terminal? }], terminals: [handle] (created by it, or given work by it),
 * screens: [{ terminal, ids }] (uuids a terminal's screen showed: Claude Code shows its session id),
 * sent: [{ terminal, mark }] }. Only a command's own results count (a run it created, a worker it started);
 * lists of everyone's runs and workers (run-list, worker-list) prove nothing about the chat. Pure.
 */
export function commandEvidence(command, output) {
  const found = { runs: [], tasks: [], terminals: [], screens: [], sent: [] };
  if (typeof command !== "string" || !command.includes("orca")) return found;
  for (const match of command.slice(0, 65_536).matchAll(COMMAND)) {
    const [, kind, rawVerb, rest] = match;
    const verb = `${kind} ${rawVerb}`.toLowerCase();
    const json = ["orchestration run-create", "orchestration worker-start", "orchestration task-create", "orchestration dispatch", "terminal create"].includes(verb)
      ? outputJson(output) : null;
    const result = json?.result && typeof json.result === "object" ? json.result : null;
    const runFlag = flagValue(rest, "run");
    const target = flagValue(rest, "terminal") || flagValue(rest, "to");
    if (verb === "orchestration run-create" && result) {
      const run = result.run && typeof result.run === "object" ? result.run : result;
      const id = String(run.id ?? run.runId ?? "");
      if (RUN_ID.test(id)) found.runs.push({ id, ...(HANDLE.test(String(run.coordinator_handle ?? run.coordinatorHandle)) ? { coordinator: String(run.coordinator_handle ?? run.coordinatorHandle) } : {}) });
    } else if ((verb === "orchestration worker-start" || verb === "orchestration task-create" || verb === "orchestration dispatch") && result) {
      const dispatch = result.dispatch && typeof result.dispatch === "object" ? result.dispatch : {};
      const task = result.task && typeof result.task === "object" ? result.task : {};
      const id = String(result.taskId ?? dispatch.task_id ?? dispatch.taskId ?? task.id ?? (verb === "orchestration task-create" ? result.id : "") ?? "");
      const run = String(result.runId ?? dispatch.run_id ?? dispatch.runId ?? task.run_id ?? runFlag ?? "");
      const dispatchId = String(result.dispatchId ?? dispatch.id ?? "");
      // The worker's own terminal: one Orca names in this result (never the caller's own, `creator_handle`).
      const terminal = valuesOf(result, HANDLE_KEYS).find((value) => HANDLE.test(value)) || "";
      if (TASK_ID.test(id)) {
        found.tasks.push({ id, ...(RUN_ID.test(run) ? { run } : {}), ...(DISPATCH_ID.test(dispatchId) ? { dispatch: dispatchId } : {}), ...(terminal ? { terminal } : {}) });
      }
      if (terminal) found.terminals.push(terminal);
      if (RUN_ID.test(run)) found.runs.push({ id: run });
    } else if (verb === "terminal create" && result) {
      const handle = String(result.terminal?.handle ?? result.handle ?? "");
      if (HANDLE.test(handle)) found.terminals.push(handle);
    } else if (verb === "terminal read" && HANDLE.test(target)) {
      const ids = [...new Set(String(output ?? "").slice(-200_000).match(UUID) || [])].slice(0, 8);
      if (ids.length) found.screens.push({ terminal: target, ids });
    }
    if (RUN_ID.test(runFlag) && verb !== "orchestration run-show" && verb !== "orchestration run-list") found.runs.push({ id: runFlag });
    // Words typed into a terminal, or sent to a worker: matched later to the prompt the worker received.
    if (HANDLE.test(target) && (verb === "terminal send" || verb === "orchestration send" || verb === "orchestration reply")) {
      const words = verb === "terminal send" ? flagValue(rest, "text") : flagValue(rest, "body") || flagValue(rest, "subject");
      const mark = wordsMark(words);
      if (mark) found.sent.push({ terminal: target, mark });
    }
  }
  return found;
}

const BRIEF = /(?:Please carry out this task from my Orca coordinator|You are working inside Orca, a multi-agent IDE\.)/;

/** Whether a prompt is Orca's dispatch brief to a worker. */
export function isDispatchBrief(text) {
  return BRIEF.test(String(text ?? "").slice(0, 4000));
}

/** A prompt without Claude Code's <pasted_content …> wrappers, their content kept. */
export function withoutPastedWrappers(text) {
  return String(text ?? "").replace(/<pasted_content\b[^>]{0,200}>/g, "").replace(/<\/pasted_content>/g, "");
}

/**
 * What Orca's dispatch brief tells a worker: { task, own, coordinator, title }, or null for any other
 * prompt. `own` is the handle the brief tells the worker to use with --from or --terminal; `coordinator`
 * the other handle it names ("…handle is: term_…"); `title` the brief's "Task:" or "Title:" line, else the
 * first line of its task. Pure.
 */
export function briefFacts(text) {
  const value = withoutPastedWrappers(String(text ?? "").slice(0, 64 * 1024));
  if (!isDispatchBrief(value)) return null;
  const task = /Your task ID is:\s*(task_[A-Za-z0-9]{6,40})/.exec(value)?.[1] || "";
  const handles = [...new Set(value.match(ANY_HANDLE) || [])];
  const own = new RegExp(String.raw`--(?:from|terminal)[ =]+["'\x60]?(${ORCA_HANDLE_TEXT})`).exec(value)?.[1] || (handles.length === 1 ? handles[0] : "");
  const coordinator = new RegExp(String.raw`handle is:?\s*["'\x60]?(${ORCA_HANDLE_TEXT})`, "i").exec(value)?.[1] || handles.find((handle) => handle !== own) || "";
  const marker = value.indexOf("=== TASK ===");
  const body = marker >= 0 ? value.slice(marker + 12) : "";
  const named = /^\s*(?:Task|Title)\s*:\s*(.+)$/im.exec(body)?.[1] || "";
  const firstLine = body.split(/\r?\n/).map((line) => line.trim().replace(/^#{1,6}\s+/, "")).find((line) => line && !/^={3,}/.test(line)) || "";
  const title = (named || firstLine).replace(/\s+/g, " ").trim();
  return { task, own, coordinator: coordinator === own ? "" : coordinator, title };
}
