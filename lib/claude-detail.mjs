/**
 * What a Claude Code session or subagent is doing, read from its own transcript on this computer.
 *
 * Claude Code collapses tool calls and hides subagents; its transcript does not. The detail view
 * reads the newest part of the session's JSONL transcript (never the whole file: they reach 15 MB
 * and more) only for the agent the person selected, and turns it into the mission (the prompt that
 * started the current turn), the plan (todos or tasks), what is running now, what it said, a trail
 * of steps with commands, paths, output tails and line counts, and the files it changed.
 * Everything is clipped and passed through redactSecrets. Nothing here is written anywhere or sent
 * to a phone; the server answers detail requests from this computer only.
 *
 * Transcripts live at <config>/projects/<encoded cwd>/<session>.jsonl, and a subagent's at
 * <config>/projects/<encoded cwd>/<session>/subagents/agent-<agentId>.jsonl. The hook may record
 * the exact paths; otherwise they are found by name.
 */
import { closeSync, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, posix, win32 } from "node:path";
import { readFileTail } from "./claude.mjs";
import { claudeConfigDir, isInside, isLocalPath } from "./paths.mjs";
import {
  DETAIL_LIMITS, baseName, clean, cleanTail, diffStats, groupLookups, lineCount, oneLine, relativePath, stepStatus, summarizeFiles,
  toMs, unwrapCommand,
} from "./detail-text.mjs";

export const CLAUDE_DETAIL_LIMITS = Object.freeze({
  firstBytes: 1024 * 1024, // The newest megabyte holds most turns whole.
  maxBytes: 8 * 1024 * 1024, // A long turn's start is looked for this far back, no further.
  headBytes: 256 * 1024, // A subagent's own prompt, and the session's start time, sit at the head.
  projectDirs: 2000, // Project folders scanned when a transcript has to be found by name.
  cachedFiles: 64,
  missingMs: 30_000, // A transcript that could not be found is looked for again after this.
});

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
// Text Claude Code puts in "user" records that the person did not type.
const INJECTED = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|task-notification|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook|tool-use-error|teammate-message)\b/i;
const NOT_PROMPT = /^\s*(\[Request interrupted by user|Caveat: The messages below were generated)/;
const COMMAND_TOOLS = new Set(["Bash", "PowerShell", "BashOutput", "Monitor"]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

function blocksOf(record) {
  const content = record?.message?.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

/** The words a person typed to start a turn, or "" for tool results, injected wrappers and notes. */
export function promptText(record) {
  if (record?.type !== "user" || record.isMeta || record.isCompactSummary || record.isVisibleInTranscriptOnly) return "";
  const blocks = blocksOf(record);
  if (blocks.some((block) => block?.type === "tool_result")) return "";
  const text = blocks.filter((block) => block?.type === "text" && typeof block.text === "string" && !INJECTED.test(block.text))
    .map((block) => block.text).join("\n").trim();
  if (!text || NOT_PROMPT.test(text)) return "";
  return text;
}

function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (block?.type === "text" ? block.text || "" : block?.type === "image" ? "[image]" : "")).filter(Boolean).join("\n");
}

function json(value, max) {
  try { return clean(JSON.stringify(value ?? {}, null, 1), max); } catch { return ""; }
}

function hostOf(url) {
  try { return new URL(String(url)).host || String(url); } catch { return String(url || "a page"); }
}

/** Added and removed lines for an edit, from Claude Code's own patch when it kept one. */
function editStats(name, input, extra) {
  const hunks = Array.isArray(extra?.structuredPatch) ? extra.structuredPatch : null;
  if (hunks && hunks.length) {
    let added = 0;
    let removed = 0;
    for (const hunk of hunks) {
      const stats = diffStats((Array.isArray(hunk?.lines) ? hunk.lines : []).join("\n"));
      added += stats.added;
      removed += stats.removed;
    }
    return { added, removed };
  }
  if (name === "Write") return { added: lineCount(input.content), removed: 0 };
  if (name === "MultiEdit") {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    return edits.reduce((sum, edit) => ({ added: sum.added + lineCount(edit?.new_string), removed: sum.removed + lineCount(edit?.old_string) }), { added: 0, removed: 0 });
  }
  if (name === "NotebookEdit") return { added: lineCount(input.new_source), removed: 0 };
  return { added: lineCount(input.new_string), removed: lineCount(input.old_string) };
}

function serverName(name) {
  const [, server = "a connected app", tool = ""] = String(name).split("__");
  return `${server.replace(/[_-]+/g, " ")}${tool ? ` · ${tool.replace(/[_-]+/g, " ")}` : ""}`;
}

/** One trail row for a tool call and its result. Pure. */
export function claudeToolRow(use, result, { cwd = "", session = "", running = false } = {}) {
  const name = String(use.name || "tool");
  const input = use.input && typeof use.input === "object" ? use.input : {};
  const extra = result?.extra && typeof result.extra === "object" ? result.extra : {};
  const status = result ? (result.isError ? "failed" : "ok") : running ? "running" : "ok";
  const row = { id: use.id, at: use.at, kind: "tool", title: `Used ${name}`, status };
  if (result?.at && use.at) row.durationMs = Math.max(0, result.at - use.at);
  const path = String(input.file_path ?? input.notebook_path ?? input.path ?? "");
  const shown = relativePath(path, cwd);
  if (COMMAND_TOOLS.has(name)) {
    const command = String(input.command ?? input.bash_id ?? "");
    Object.assign(row, { kind: "command", title: oneLine(unwrapCommand(command)) || `Used ${name}`, detail: clean(command, DETAIL_LIMITS.detail) });
    if (result) {
      row.output = cleanTail(result.text);
      const code = /^Exit code (-?\d+)/m.exec(String(result.text || ""));
      if (code) row.exitCode = Number(code[1]);
      else if (!result.isError) row.exitCode = 0;
    }
  } else if (EDIT_TOOLS.has(name)) {
    const { added, removed } = editStats(name, input, extra);
    const created = name === "Write" && extra.type === "create";
    Object.assign(row, { kind: name === "Write" ? "write" : "edit", title: `${created ? "Created" : name === "Write" ? "Wrote" : "Edited"} ${baseName(path) || "a file"}`,
      detail: clean(shown, DETAIL_LIMITS.detail), added, removed });
    if (result?.isError) row.output = cleanTail(result.text);
  } else if (name === "Read" || name === "NotebookRead" || name === "LS") {
    Object.assign(row, { kind: "read", title: `${name === "LS" ? "Listed" : "Read"} ${baseName(path) || "a file"}`, detail: clean(shown, DETAIL_LIMITS.detail), path: clean(shown, 400) });
  } else if (name === "Grep" || name === "Glob") {
    const pattern = String(input.pattern ?? "");
    Object.assign(row, { kind: "search", title: name === "Grep" ? `Searched for "${oneLine(pattern, 80)}"` : `Looked for ${oneLine(pattern, 80)}`,
      detail: clean(`${pattern}${path ? ` in ${shown}` : ""}`, DETAIL_LIMITS.detail), path: clean(pattern, 400) });
    if (result) row.output = cleanTail(result.text);
  } else if (name === "WebFetch") {
    Object.assign(row, { kind: "web", title: `Opened ${oneLine(hostOf(input.url), 80)}`, detail: clean(input.url, DETAIL_LIMITS.detail) });
    if (result) row.output = cleanTail(result.text);
  } else if (name === "WebSearch") {
    Object.assign(row, { kind: "web", title: `Searched the web for "${oneLine(input.query, 80)}"`, detail: clean(input.query, DETAIL_LIMITS.detail) });
  } else if (name === "Agent" || name === "Task") {
    const type = oneLine(input.subagent_type || "helper", 40);
    Object.assign(row, { kind: "agent", title: `Started subagent ${type}`,
      detail: clean([input.description, input.prompt].filter(Boolean).join("\n\n"), DETAIL_LIMITS.detail) });
    const agentId = typeof extra.agentId === "string" && SAFE_ID.test(extra.agentId) ? extra.agentId : "";
    if (agentId && session) row.agentId = `claude-agent:${session}:${agentId}`;
    if (result) row.output = cleanTail(result.text);
    // A background subagent's call returns at once; it is still working, so the row says so only while open.
  } else if (name === "AskUserQuestion") {
    const questions = Array.isArray(input.questions) ? input.questions : [];
    Object.assign(row, { kind: "ask", title: `Asked you: ${oneLine(questions[0]?.question || "a question", 100)}`,
      detail: clean(questions.map((question) => [question?.question, ...(Array.isArray(question?.options) ? question.options.map((option) => `  - ${option?.label ?? option}`) : [])]
        .filter(Boolean).join("\n")).join("\n\n"), DETAIL_LIMITS.detail) });
    const answers = extra.answers && typeof extra.answers === "object" ? Object.entries(extra.answers).map(([question, answer]) => `${question} → ${answer}`).join("\n") : "";
    if (answers || result) row.output = cleanTail(answers || result.text);
  } else if (name === "TodoWrite" || name === "TaskCreate" || name === "TaskUpdate") {
    Object.assign(row, { kind: "tool", title: name === "TaskCreate" ? `Added a task: ${oneLine(input.subject ?? input.title ?? input.description, 90)}` : "Updated the plan" });
  } else if (name === "Skill") {
    Object.assign(row, { kind: "tool", title: `Used skill ${oneLine(input.skill ?? input.command ?? "", 60)}`.trim() });
  } else if (name === "ExitPlanMode") {
    Object.assign(row, { kind: "tool", title: "Proposed a plan", detail: clean(input.plan, DETAIL_LIMITS.detail) });
  } else if (name.startsWith("mcp__")) {
    Object.assign(row, { kind: "tool", title: `Used ${oneLine(serverName(name), 80)}`, detail: json(input, 1000) });
    if (result) row.output = cleanTail(result.text);
  } else {
    Object.assign(row, { kind: "tool", title: `Used ${oneLine(name, 60)}`, detail: json(input, 1000) });
    if (result?.isError) row.output = cleanTail(result.text);
  }
  if (!row.detail) delete row.detail;
  return row;
}

/** What a running tool call is doing, for the "Now" line. */
export function claudeNow(use, { cwd = "" } = {}) {
  const row = claudeToolRow(use, null, { cwd, running: true });
  const input = use.input && typeof use.input === "object" ? use.input : {};
  const path = baseName(input.file_path ?? input.notebook_path ?? input.path ?? "");
  const titles = {
    command: `Running ${row.title}`, edit: `Editing ${path || "a file"}`, write: `Writing ${path || "a file"}`, read: `Reading ${path || "a file"}`,
    search: row.title.replace(/^Searched/, "Searching").replace(/^Looked/, "Looking"), web: use.name === "WebSearch" ? "Searching the web" : row.title.replace(/^Opened/, "Opening"),
    agent: row.title.replace(/^Started/, "Running"), ask: "Asking you", tool: row.title.replace(/^Used/, "Using"),
  };
  return { kind: row.kind === "message" ? "tool" : row.kind, title: oneLine(titles[row.kind] || row.title), ...(row.detail ? { detail: clean(row.detail, DETAIL_LIMITS.nowDetail) } : {}), startedAt: use.at };
}

function planFrom(todos, tasks) {
  if (todos && (!tasks || todos.order >= tasks.order)) {
    const steps = todos.items.filter((item) => item && typeof item === "object").slice(0, 50).map((item) => ({
      text: clean(item.status === "in_progress" && item.activeForm ? item.activeForm : item.content ?? item.activeForm ?? "", 300), status: stepStatus(item.status) }));
    return steps.length ? { steps, at: todos.at, source: "todos" } : null;
  }
  if (tasks && tasks.items.size) {
    const steps = [...tasks.items.values()].slice(0, 50).map((item) => ({ text: clean(item.subject, 300), status: stepStatus(item.status) }));
    return { steps, at: tasks.at, source: "tasks" };
  }
  return null;
}

/**
 * Read a transcript tail (records in file order). Pure: returns the detail parts plus whether the
 * current turn's starting prompt was in view (`turnStartFound`) and where it starts (`startChars`,
 * characters from the start of `text`), so the reader can look further back or less far next time.
 * `subagent` transcripts are all side-chain records; a main transcript's side-chain records (older
 * Claude Code versions kept subagents inline) belong to subagents and are skipped.
 */
export function parseClaudeTranscript(text, { subagent = false, session = "", cwd = "" } = {}) {
  const records = [];
  let offset = 0;
  for (const line of String(text).split("\n")) {
    const at = offset;
    offset += line.length + 1;
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; } // A tail's first line may be cut.
    if (!record || typeof record !== "object") continue;
    if (!subagent && record.isSidechain === true) continue;
    records.push({ record, chars: at });
  }
  const uses = new Map();
  const results = new Map();
  const events = []; // { kind: "text" | "tool" | "error", order, at, ... } in file order
  let prompt = null;
  let lastPrompt = "";
  let branch = "";
  let seenCwd = "";
  let lastAt = 0;
  let endedAfter = -1; // order of the newest turn end marker
  let lastAssistant = -1;
  let todos = null;
  const taskUses = [];
  let order = 0;
  for (const { record, chars } of records) {
    const at = toMs(record.timestamp);
    if (at) lastAt = Math.max(lastAt, at);
    if (typeof record.gitBranch === "string" && record.gitBranch && record.gitBranch !== "HEAD") branch = record.gitBranch;
    if (typeof record.cwd === "string" && record.cwd) seenCwd = record.cwd;
    if (record.type === "last-prompt" && typeof record.lastPrompt === "string") { lastPrompt = record.lastPrompt; continue; }
    if (record.type === "system") {
      if (record.subtype === "turn_duration" || record.subtype === "stop_hook_summary") endedAfter = order++;
      continue;
    }
    if (record.type === "user") {
      const words = promptText(record);
      if (words) { prompt = { text: words, at, order: order++, chars }; continue; }
      for (const block of blocksOf(record)) {
        if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        results.set(block.tool_use_id, { at, isError: block.is_error === true, text: resultText(block.content), extra: record.toolUseResult });
      }
      continue;
    }
    if (record.type !== "assistant") continue;
    lastAssistant = order;
    if (record.isApiErrorMessage) {
      events.push({ kind: "error", order: order++, at, text: resultText(record.message?.content), id: String(record.uuid || `error-${order}`) });
      continue;
    }
    for (const block of blocksOf(record)) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        events.push({ kind: "text", order: order++, at, text: block.text, id: `${record.uuid || "text"}:${order}` });
      } else if (block?.type === "tool_use" && typeof block.id === "string") {
        const use = { id: block.id, name: String(block.name || ""), input: block.input, at, order: order++ };
        uses.set(use.id, use);
        events.push({ kind: "tool", order: use.order, at, use });
        if (use.name === "TodoWrite" && Array.isArray(block.input?.todos)) todos = { items: block.input.todos, at, order: use.order };
        if (use.name === "TaskCreate" || use.name === "TaskUpdate") taskUses.push(use);
      }
    }
  }
  const turnStart = prompt ? prompt.order : -1;
  const turnOpen = !(endedAfter > Math.max(lastAssistant, turnStart));
  const inTurn = (event) => event.order > turnStart;
  // Tasks: created by TaskCreate (the result names the id), changed by TaskUpdate.
  let tasks = null;
  for (const use of taskUses) {
    const input = use.input && typeof use.input === "object" ? use.input : {};
    tasks ||= { items: new Map(), at: 0, order: 0 };
    if (use.name === "TaskCreate") {
      const result = results.get(use.id);
      const extra = result?.extra && typeof result.extra === "object" ? result.extra : {};
      const id = String(extra.task?.id ?? extra.taskId ?? extra.id ?? (/#?(\d+)/.exec(result?.text || "") || [])[1] ?? use.id);
      tasks.items.set(id, { subject: input.subject ?? input.title ?? input.content ?? input.description ?? "", status: input.status || "pending" });
    } else {
      const item = tasks.items.get(String(input.taskId ?? input.id ?? ""));
      if (!item) continue;
      if (input.status === "deleted") tasks.items.delete(String(input.taskId ?? input.id));
      else Object.assign(item, { ...(input.status ? { status: input.status } : {}), ...(input.subject ? { subject: input.subject } : {}) });
    }
    tasks.at = use.at;
    tasks.order = use.order;
  }
  const where = cwd || seenCwd;
  // Trail: every step in view, newest first; lookups in a row become one row.
  const rows = [];
  let group = [];
  const flushText = () => {
    if (!group.length) return;
    const joined = group.map((event) => event.text.trim()).join("\n\n");
    rows.push({ id: group[0].id, at: group[0].at, kind: "message", title: oneLine(joined), detail: clean(joined, DETAIL_LIMITS.detail), status: "ok", order: group[0].order });
    group = [];
  };
  for (const event of events) {
    if (event.kind === "text") { group.push(event); continue; }
    flushText();
    if (event.kind === "error") {
      rows.push({ id: event.id, at: event.at, kind: "error", title: "Claude hit an error", detail: clean(event.text, DETAIL_LIMITS.detail), status: "failed", order: event.order });
      continue;
    }
    const running = turnOpen && inTurn(event) && !results.has(event.use.id);
    rows.push({ ...claudeToolRow(event.use, results.get(event.use.id), { cwd: where, session, running }), order: event.order });
  }
  flushText();
  const trail = groupLookups(rows.sort((a, b) => b.order - a.order).map(({ order: _order, ...row }) => row)).slice(0, DETAIL_LIMITS.trail);
  // Said: the newest run of prose (text blocks with no tool call between them), this turn's if it has any.
  const textRuns = [];
  for (const event of events) {
    if (event.kind !== "text") { if (textRuns.at(-1)?.length) textRuns.push([]); continue; }
    if (!textRuns.length) textRuns.push([]);
    textRuns.at(-1).push(event);
  }
  const runs = textRuns.filter((run) => run.length);
  const newest = [...runs].reverse().find((run) => run.some(inTurn)) || runs.at(-1) || null;
  const said = newest ? { text: clean(newest.map((event) => event.text.trim()).join("\n\n"), DETAIL_LIMITS.said), at: newest.at(-1).at } : null;
  // Now: the newest call in this turn still waiting for its result.
  const open = turnOpen ? [...uses.values()].filter((use) => use.order > turnStart && !results.has(use.id)).at(-1) : null;
  const now = open ? claudeNow(open, { cwd: where }) : null;
  const edits = [...uses.values()].filter((use) => EDIT_TOOLS.has(use.name)).map((use) => {
    const input = use.input && typeof use.input === "object" ? use.input : {};
    const result = results.get(use.id);
    if (result?.isError) return null;
    return { path: String(input.file_path ?? input.notebook_path ?? ""), ...editStats(use.name, input, result?.extra), at: use.at, order: use.order };
  }).filter(Boolean);
  const turnEdits = edits.filter((edit) => edit.order > turnStart);
  const mission = prompt ? { text: clean(prompt.text, DETAIL_LIMITS.mission), from: subagent ? "parent" : "you", at: prompt.at }
    : lastPrompt.trim() ? { text: clean(lastPrompt, DETAIL_LIMITS.mission), from: subagent ? "parent" : "you", at: 0 } : null;
  return {
    mission, plan: planFrom(todos, tasks), now, said, trail,
    files: summarizeFiles(turnEdits.length ? turnEdits : edits, where),
    branch, cwd: seenCwd, lastAt, turnOpen, turnStartFound: Boolean(prompt), startChars: prompt ? prompt.chars : -1,
  };
}

/** The first prompt in a transcript's head: the task a subagent was given, and when it started. */
export function transcriptHead(text) {
  let startedAt = 0;
  let prompt = null;
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (!startedAt && toMs(record?.timestamp)) startedAt = toMs(record.timestamp);
    const words = promptText(record);
    if (words) { prompt = { text: words, at: toMs(record.timestamp) }; break; }
  }
  return { startedAt, prompt };
}

function readHead(file, bytes) {
  const fd = openSync(file, "r");
  try {
    const length = Math.min(bytes, fstatSync(fd).size);
    const buffer = Buffer.alloc(length);
    const read = length ? readSync(fd, buffer, 0, length, 0) : 0;
    const text = buffer.subarray(0, read).toString("utf8");
    // A head cut mid-line ends with a partial record; drop it.
    return read < fstatSync(fd).size ? text.slice(0, Math.max(0, text.lastIndexOf("\n"))) : text;
  } finally { closeSync(fd); }
}

const defaultFs = {
  stat: (path) => { const info = statSync(path); return { size: info.size, mtimeMs: info.mtimeMs, file: info.isFile() }; },
  // Links, junctions, "..", and Windows short names all resolved, as the disk names the file.
  realpath: (path) => realpathSync.native(path),
  readTail: readFileTail,
  readHead,
  readdir: (path) => readdirSync(path),
};

/** Claude Code's folder name for a project: every character but letters and digits becomes "-". */
export const encodeProjectDir = (cwd) => String(cwd || "").replace(/[^A-Za-z0-9]/g, "-");

const pathApi = (path) => (/^[A-Za-z]:[\\/]|^\\\\/.test(path) ? win32 : posix);
const absolute = (path) => typeof path === "string" && path.length < 1024 && !/[\u0000-\u001f]/.test(path) && (win32.isAbsolute(path) || posix.isAbsolute(path) || isAbsolute(path));

/**
 * The transcript paths a hook recorded for this session (newest record first). Only a path that
 * names this session's own file (or this subagent's) is kept; anything else is ignored. The name
 * alone proves little (any program on this computer can write the hook log), so the reader also
 * requires the file to be under the Claude config folder's projects before it reads it.
 */
export function recordedTranscript(records, session, agent = "") {
  const out = { main: "", agent: "" };
  const list = Array.isArray(records) ? records : [];
  for (let index = list.length - 1; index >= 0 && (!out.main || (agent && !out.agent)); index--) {
    const record = list[index];
    if (record?.session !== session) continue;
    if (!out.main && absolute(record.transcript) && pathApi(record.transcript).basename(record.transcript) === `${session}.jsonl`) out.main = record.transcript;
    if (agent && !out.agent && record.agent === agent && absolute(record.agentTranscript)
      && pathApi(record.agentTranscript).basename(record.agentTranscript) === `agent-${agent}.jsonl`) out.agent = record.agentTranscript;
  }
  return out;
}

export class ClaudeDetailReader {
  constructor({ configDir = claudeConfigDir(), fs = defaultFs, limits = CLAUDE_DETAIL_LIMITS, clock = Date.now, platform = process.platform } = {}) {
    Object.assign(this, { configDir, fs: { ...defaultFs, ...fs }, limits, clock, platform });
    this.mains = new Map(); // session -> transcript path
    this.missing = new Map(); // session -> when it was last looked for in vain
    this.cache = new Map(); // file -> { size, mtimeMs, bytes, detail }
    this.heads = new Map(); // file -> transcriptHead()
  }

  /**
   * Whether a transcript may be read at all: a .jsonl file on a local disk (never a network share or
   * device path, which is not even looked at) whose real location, with links, junctions, and ".."
   * followed, is inside <config>/projects (letter case ignored on Windows). A recorded path that
   * points anywhere else, by name or through a link, is never opened.
   */
  allowed(path) {
    if (!isLocalPath(path, this.platform) || !/\.jsonl$/i.test(path)) return false;
    let root;
    let real;
    try {
      root = this.fs.realpath(join(this.configDir, "projects"));
      real = this.fs.realpath(path);
    } catch { return false; }
    return isLocalPath(real, this.platform) && /\.jsonl$/i.test(real) && real !== root && isInside(real, root, this.platform);
  }

  /** A transcript that may be read and is there to read. */
  exists(path) {
    if (!this.allowed(path)) return false;
    try { return this.fs.stat(path).file !== false; } catch { return false; }
  }

  /** The session's main transcript: the recorded path, the project folder its cwd names, or a scan. */
  findMain(session, { cwd = "", recorded = "" } = {}) {
    if (recorded && this.exists(recorded)) return recorded;
    const known = this.mains.get(session);
    if (known && this.exists(known)) return known;
    const projects = join(this.configDir, "projects");
    const guess = cwd ? join(projects, encodeProjectDir(cwd), `${session}.jsonl`) : "";
    if (guess && this.exists(guess)) { this.mains.set(session, guess); return guess; }
    if (this.clock() - (this.missing.get(session) || 0) < this.limits.missingMs) return "";
    let dirs = [];
    try { dirs = this.fs.readdir(projects).slice(0, this.limits.projectDirs); } catch { dirs = []; }
    for (const dir of dirs) {
      const file = join(projects, String(dir), `${session}.jsonl`);
      if (this.exists(file)) {
        this.mains.set(session, file);
        if (this.mains.size > 500) this.mains.delete(this.mains.keys().next().value);
        return file;
      }
    }
    this.missing.set(session, this.clock());
    if (this.missing.size > 500) this.missing.delete(this.missing.keys().next().value);
    return "";
  }

  /** Where this session's (or subagent's) transcript is, or "" when it cannot be found. */
  locate({ session, agent = "", cwd = "", recorded = {} }) {
    if (!SAFE_ID.test(String(session || "")) || (agent && !SAFE_ID.test(agent))) return "";
    if (agent && recorded.agent && this.exists(recorded.agent)) return recorded.agent;
    const main = this.findMain(session, { cwd, recorded: recorded.main });
    if (!agent) return main;
    const folder = main ? dirname(main) : cwd ? join(this.configDir, "projects", encodeProjectDir(cwd)) : "";
    const file = folder ? join(folder, session, "subagents", `agent-${agent}.jsonl`) : "";
    return file && this.exists(file) ? file : "";
  }

  /**
   * The detail parts for one session or subagent, or null when its transcript cannot be read.
   * Unchanged files (same size and modification time) are answered from memory, so a two-second
   * poll of a quiet agent costs one stat.
   */
  read({ session, agent = "", cwd = "", recorded = {} }) {
    const file = this.locate({ session, agent, cwd, recorded });
    if (!file) return null;
    let info;
    try { info = this.fs.stat(file); } catch { return null; }
    const saved = this.cache.get(file);
    if (saved && saved.size === info.size && saved.mtimeMs === info.mtimeMs) return saved.detail;
    const { firstBytes, maxBytes } = this.limits;
    // Read from where the current turn started last time (plus what was added), never less than a megabyte.
    let bytes = saved ? Math.min(maxBytes, Math.max(firstBytes, saved.bytes + Math.max(0, info.size - saved.size))) : firstBytes;
    let parsed;
    let text = "";
    for (;;) {
      try { text = this.fs.readTail(file, bytes); } catch { return null; }
      parsed = parseClaudeTranscript(text, { subagent: Boolean(agent), session, cwd });
      if (parsed.turnStartFound || bytes >= info.size || bytes >= maxBytes || saved?.farStart) break;
      bytes = Math.min(maxBytes, bytes * 2);
    }
    const farStart = !parsed.turnStartFound && info.size > bytes;
    const nextBytes = parsed.turnStartFound ? Buffer.byteLength(text.slice(parsed.startChars)) + 64 * 1024 : firstBytes;
    let head = this.heads.get(file);
    if (!head) {
      try { head = transcriptHead(this.fs.readHead(file, this.limits.headBytes)); } catch { head = { startedAt: 0, prompt: null }; }
      this.heads.set(file, head);
      if (this.heads.size > this.limits.cachedFiles) this.heads.delete(this.heads.keys().next().value);
    }
    let mission = parsed.mission;
    // A subagent's task is the prompt its parent gave it: the first record of its own transcript.
    if (agent && head.prompt) mission = { text: clean(head.prompt.text, DETAIL_LIMITS.mission), from: "parent", at: head.prompt.at };
    // A turn that began further back than the bounded read keeps the prompt found before.
    else if (!parsed.turnStartFound && saved?.detail?.mission?.at) mission = saved.detail.mission;
    const { turnStartFound, startChars, ...rest } = parsed;
    const detail = { ...rest, mission, startedAt: head.startedAt || 0, file };
    this.cache.set(file, { size: info.size, mtimeMs: info.mtimeMs, bytes: nextBytes, farStart, detail });
    if (this.cache.size > this.limits.cachedFiles) this.cache.delete(this.cache.keys().next().value);
    return detail;
  }
}
