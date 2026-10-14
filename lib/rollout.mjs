/**
 * Whether a Codex chat running in another process (the Codex app or CLI) looks to be waiting for an
 * approval.
 *
 * Codex never saves the approval request itself, and the step it would approve is not listed until it
 * runs. What the chat's own session file does show is the model's tool call with no result after it.
 * A long-running command looks the same, so this is a guess, made only when all of these hold:
 *   - the turn's approval policy can ask at all (policy "never" never waits on anyone),
 *   - the newest tool call has no output and no step finished after it, and is one that can ask under
 *     that policy (a command asking to leave the sandbox, or any command or patch under "untrusted";
 *     never a wait, a plan, or a command that only waits on an Orca terminal; see callCanAsk),
 *   - nothing at all has been written for `quietMs`, and not for longer than `maxQuietMs` (an ask
 *     stays urgent as long as a question does; an app that closed mid-turn is not waiting forever).
 * Besides record types, call ids, timestamps, and the approval policy, the same tail gives what the
 * waiting call would do (its command, or the files a patch changes) and the newest plan the chat set
 * (update_plan), so the person can see them on this computer. Nothing else in the file is kept, and the
 * file is only read for a chat whose turn is still open.
 *
 * The same read says what such a chat is doing, which the Codex app shows and this reader otherwise
 * cannot see (a chat running in another process lists no step as in progress): the newest call still
 * waiting for its output ("Running npm test", since that record's own time), else the newest step that
 * finished ("Ran npm test", "Edited csv.ts", "Said: …", as of its time), else "Thinking" since the
 * newest record. Only commands, file names, tool names, and the first line of what it said are taken.
 */
import { statSync } from "node:fs";
import { readFileTail, redactSecrets } from "./claude.mjs";
import { markAwaitingApproval } from "./transform.mjs";
import { firstLine, makeNow, planProgress } from "./asks.mjs";
import { unwrapCommand } from "./detail-text.mjs";

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

// Code-mode calls are read only this far: a command is near the start, and an unclosed object must
// not make the lookups below slow.
const CODE_CHARS = 32 * 1024;

/**
 * What a code-mode `exec` call would run: the command of a `tools.exec_command({ cmd: ... })`, the files of
 * a `tools.apply_patch(...)`, else the tools it calls.
 */
function codeModeSummary(input) {
  const code = String(input ?? "").slice(0, CODE_CHARS);
  const unescape = (text) => text.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\(["'`\\])/g, "$1");
  const STRING = String.raw`(["'\x60])((?:\\.|(?!\1)[^\\])*)\1`;
  // { cmd: "..." } or { "cmd": "..." }, the key anywhere in the object (bounded, so many unclosed objects stay linear).
  const literal = new RegExp(String.raw`\bexec_command\s*\(\s*\{[^}]{0,2000}?["']?\bcmd["']?\s*:\s*${STRING}`, "s").exec(code);
  if (literal) return unescape(literal[2]);
  // { cmd } or { cmd: name }, with the string set earlier: const name = "...".
  const named = /\bexec_command\s*\(\s*\{[^}]{0,2000}?(?:["']?\bcmd["']?\s*:\s*([A-Za-z_$][\w$]*)|\bcmd\s*(?=[,}]))/s.exec(code);
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

// Calls that never wait on the person: plans, waits on subagents or a running command, image views,
// subagent and MCP-resource bookkeeping.
const NEVER_ASKS = new Set(["update_plan", "wait", "wait_agent", "write_stdin", "view_image", "spawn_agent", "send_input",
  "close_agent", "resume_agent", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);
const SHELL_CALLS = new Set(["exec_command", "shell", "shell_command", "container.exec"]);
// A command that only waits on something else: an Orca terminal, or a coordinator's answer.
const WAIT_COMMAND = /\borca(?:\.exe)?\s+(?:terminal\s+wait|orchestration\s+(?:wait|ask))\b|\borca(?:\.exe)?\s+orchestration\s+check\b[^|;&\n]*--wait\b/i;
const ESCALATION = /\bsandbox_permissions["']?\s*:\s*["']require_escalated["']|\bwith_escalated_permissions["']?\s*:\s*true\b/;

/**
 * Whether an open call can be waiting on an approval at all under `policy`. A command asks to leave the
 * sandbox (sandbox_permissions "require_escalated", or the older with_escalated_permissions) under any
 * policy but "never"; under "untrusted" any command or patch may ask. Waits, plans, MCP tools, and
 * commands that only wait on an Orca terminal or a coordinator never do. Pure.
 */
export function callCanAsk(payload, policy) {
  if (!policy || policy === "never") return false;
  const name = String(payload?.name || "");
  if (NEVER_ASKS.has(name)) return false;
  const args = parseArguments(payload?.arguments) || {};
  const code = name === "exec" && typeof payload?.input === "string" ? payload.input.slice(0, CODE_CHARS) : "";
  const shell = payload?.type === "local_shell_call" || SHELL_CALLS.has(name) || /\btools\.exec_command\s*\(/.test(code);
  const patch = name === "apply_patch" || /\btools\.apply_patch\s*\(/.test(code);
  if (shell) {
    if (WAIT_COMMAND.test(callSummary(payload).command)) return false;
    const escalated = args.sandbox_permissions === "require_escalated" || args.with_escalated_permissions === true || ESCALATION.test(code);
    return escalated || policy === "untrusted";
  }
  return patch && policy === "untrusted";
}

/** Plan progress from an update_plan call's arguments: { plan: [{ step, status }] }. */
function planFrom(argumentsValue) {
  const plan = parseArguments(argumentsValue)?.plan;
  return Array.isArray(plan) ? planProgress(plan.map((item) => ({ text: item?.step, status: item?.status })), (step) => step.text) : null;
}

const baseName = (path) => String(path || "").split(/[\\/]/).filter(Boolean).at(-1) || String(path || "");
const fileNames = (paths) => (paths.length <= 3 ? paths.map(baseName).join(", ") : `${paths.length} files`);

/**
 * One tool call as a step: its kind, how it reads while it runs ("Running npm test") and once it has
 * finished ("Ran npm test"), and what it works on. Pure.
 */
export function callStep(payload) {
  const name = String(payload?.name || "");
  const { command } = callSummary(payload);
  const step = (kind, running, done, detail = "") => ({ kind, running, done, detail });
  if (name === "update_plan") return step("tool", "Updating the plan", "Updated the plan");
  if (name === "wait" || name === "wait_agent") return step("agent", "Waiting", "Waited");
  if (name === "spawn_agent") return step("agent", "Starting a subagent", "Started a subagent");
  if (name === "send_input") return step("agent", "Messaging a subagent", "Messaged a subagent");
  if (name === "close_agent") return step("agent", "Closing a subagent", "Closed a subagent");
  if (name === "resume_agent") return step("agent", "Resuming a subagent", "Resumed a subagent");
  if (name === "write_stdin") return step("command", "Waiting on a running command", "Checked a running command");
  if (name === "view_image") {
    const path = String(parseArguments(payload?.arguments)?.path || "");
    return step("read", `Viewing ${baseName(path) || "an image"}`, `Viewed ${baseName(path) || "an image"}`, path);
  }
  if ((name === "apply_patch" || name === "exec") && /^Change /.test(command)) {
    const paths = command.slice("Change ".length).split(", ").filter(Boolean);
    return step("edit", `Editing ${fileNames(paths)}`, `Edited ${fileNames(paths)}`, paths.join("\n"));
  }
  const shell = payload?.type === "local_shell_call" || SHELL_CALLS.has(name) || (name === "exec" && command && !/^Use /.test(command));
  if (shell) {
    const shown = firstLine(unwrapCommand(command)) || "a command";
    return step("command", `Running ${shown}`, `Ran ${shown}`, command);
  }
  if (name === "exec") {
    const tools = command.replace(/^Use /, "");
    return tools ? step("tool", `Using ${tools}`, `Used ${tools}`) : step("tool", "Running code", "Ran code");
  }
  const label = command.replace(/^Use /, "").replace(/^mcp__/, "") || name || "a tool";
  return step("tool", `Using ${label}`, `Used ${label}`);
}

const messageText = (content) => (Array.isArray(content) ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).filter(Boolean).join("\n") : "");
const said = (text) => (text.trim() ? { kind: "message", title: `Said: ${firstLine(text, 60)}`, detail: text } : null);

/**
 * A finished step from an `item_completed` record (Codex writes one, with its own times, for each
 * command, file change, tool call, search, and message): { kind, title, detail }, or null for reasoning,
 * the person's message, and anything this version does not know. Pure.
 */
export function itemStep(item) {
  const failed = String(item?.status || "").toLowerCase() === "failed" ? " · failed" : "";
  switch (item?.type) {
    case "CommandExecution": {
      const command = Array.isArray(item.command) ? item.command.map(String).join(" ") : String(item.command ?? "");
      const parsed = Array.isArray(item.parsed_cmd) ? item.parsed_cmd.filter((part) => part && typeof part === "object") : [];
      const exit = Number.isFinite(item.exit_code) && item.exit_code !== 0 ? ` · exit ${item.exit_code}` : failed;
      if (parsed.length && parsed.every((part) => part.type === "read")) {
        const name = baseName(parsed[0].name || parsed[0].path || "");
        return { kind: "read", title: `${parsed.length === 1 ? `Read ${name || "a file"}` : `Read ${parsed.length} files`}${exit}`, detail: command };
      }
      const inner = parsed.length === 1 && typeof parsed[0].cmd === "string" && parsed[0].cmd ? parsed[0].cmd : unwrapCommand(command);
      return { kind: "command", title: `Ran ${firstLine(inner) || "a command"}${exit}`, detail: command };
    }
    case "FileChange": {
      const changes = item.changes && typeof item.changes === "object" ? item.changes : {};
      const list = Array.isArray(changes) ? changes : Object.entries(changes).map(([path, change]) => ({ path, ...(change && typeof change === "object" ? change : {}) }));
      const paths = list.map((change) => String(change?.path || "")).filter(Boolean);
      const kinds = list.map((change) => String(change?.type ?? change?.kind?.type ?? change?.kind ?? "update"));
      const verb = kinds.length && kinds.every((kind) => kind === "add") ? "Created" : kinds.length && kinds.every((kind) => kind === "delete") ? "Deleted" : "Edited";
      return { kind: verb === "Created" ? "write" : "edit", title: `${verb} ${paths.length ? fileNames(paths) : "files"}${failed}`, detail: paths.join("\n") };
    }
    case "McpToolCall": return { kind: "tool", title: `Used ${[item.server, item.tool].filter(Boolean).join(" · ") || "a tool"}${failed}`, detail: "" };
    case "Extension": {
      const query = typeof item.query === "string" ? item.query : "";
      return /search/i.test(String(item.kind || "")) ? { kind: "web", title: query ? `Searched the web for ${firstLine(query, 50)}` : "Searched the web", detail: query }
        : { kind: "tool", title: `Used ${String(item.kind || "a tool")}`, detail: "" };
    }
    case "WebSearch": return { kind: "web", title: "Searched the web", detail: typeof item.query === "string" ? item.query : "" };
    case "AgentMessage": return said(messageText(item.content));
    case "ContextCompaction": return { kind: "tool", title: "Compacted the conversation", detail: "" };
    default: return null;
  }
}

/**
 * The approval policy in force, the newest open tool call (its id, record, and time), the newest plan,
 * and the newest write time in a tail; and, for `now`, the open turn's calls still without output, its
 * newest finished step, and whether only reasoning was written after that step.
 */
function scanRollout(text) {
  let policy = "";
  let openCall = "";
  let call = null;
  let plan = null;
  let lastAt = 0;
  // The open turn's visible steps (see stepNow). Reset when a turn starts.
  let calls = new Map(); // call_id -> { payload, at }: calls still waiting for their output
  let step = null; // { kind, title, detail, at, inner } the newest finished step
  let thinking = false; // reasoning written after that step
  let recordAt = 0; // the newest record that is not bookkeeping
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; } // The first line of a tail may be cut.
    const parsedAt = Date.parse(record.timestamp);
    const at = Number.isFinite(parsedAt) ? parsedAt : 0;
    if (at) lastAt = Math.max(lastAt, at);
    const type = String(record.payload?.type || record.type || "");
    if (record.type === "turn_context") {
      const value = record.payload?.approval_policy;
      policy = typeof value === "string" ? value : value ? "granular" : "";
      recordAt = Math.max(recordAt, at);
      continue;
    }
    if (BOOKKEEPING.has(record.type) || BOOKKEEPING.has(type)) continue;
    recordAt = Math.max(recordAt, at);
    if (type === "task_started") { calls = new Map(); step = null; thinking = false; }
    if (CALLS.has(type)) {
      openCall = String(record.payload?.call_id || "call");
      call = { payload: record.payload, at };
      calls.set(openCall, call);
      thinking = false;
      if (record.payload?.name === "update_plan") plan = planFrom(record.payload.arguments) || plan;
    } else if (OUTPUTS.has(type) || type === "item_completed" || type === "task_complete" || type === "turn_aborted") {
      openCall = "";
      call = null;
    }
    if (OUTPUTS.has(type)) {
      const id = String(record.payload?.call_id || "call");
      const done = calls.get(id);
      calls.delete(id);
      // A code-mode call reports each command it ran as it finishes; the newest of those says more than the call.
      if (done && !(step?.inner && step.at >= done.at)) {
        const finished = callStep(done.payload);
        step = { kind: finished.kind, title: finished.done, detail: finished.detail, at };
      }
      if (done) thinking = false;
    } else if (type === "item_completed") {
      const item = record.payload?.item;
      if (item?.type === "Reasoning") thinking = true;
      const finished = itemStep(item);
      if (finished) { step = { ...finished, at, inner: true }; thinking = false; }
    } else if (type === "reasoning") {
      thinking = true;
    } else if (type === "message" && record.payload?.role === "assistant") {
      const words = said(messageText(record.payload.content));
      if (words) { step = { ...words, at }; thinking = false; }
    } else if (type === "web_search_call") {
      step = { kind: "web", title: "Searched the web", detail: "", at };
      thinking = false;
    } else if (type === "task_complete" || type === "turn_aborted") {
      calls = new Map();
    }
  }
  return { policy, openCall, call, plan, lastAt, calls, step, thinking, recordAt };
}

/**
 * What the chat is doing, from a scan: the newest call still waiting for its output ("Running …", from
 * the call's own time), else the newest finished step (`done`, from its time), else "Thinking" since
 * the newest record (reasoning, or a turn with no step yet). Text is credential-filtered. Pure.
 */
function stepNow(scan) {
  const clean = (value, max) => redactSecrets(String(value ?? "").slice(0, max * 2));
  const open = [...scan.calls.values()].at(-1);
  if (open) {
    const step = callStep(open.payload);
    return makeNow({ kind: step.kind, title: clean(step.running, 120), detail: clean(step.detail, 400), startedAt: open.at });
  }
  if (scan.step && !scan.thinking) {
    return makeNow({ kind: scan.step.kind, title: clean(scan.step.title, 120), detail: clean(scan.step.detail, 400), startedAt: scan.step.at, done: true });
  }
  return scan.recordAt ? makeNow({ kind: "think", title: "Thinking", startedAt: scan.recordAt }) : null;
}

/** The open call as an ask names it: { command, tool, at }, or null. */
const openCallOf = (scan) => (scan.openCall && scan.call ? { ...callSummary(scan.call.payload), at: scan.call.at } : null);

const quietCall = ({ openCall, lastAt }, now, quietMs, maxQuietMs) =>
  Boolean(openCall) && lastAt > 0 && now - lastAt >= quietMs && now - lastAt <= maxQuietMs;

export function looksLikeApprovalWait(text, { now = Date.now(), quietMs = APPROVAL_QUIET_MS, maxQuietMs = APPROVAL_MAX_QUIET_MS } = {}) {
  const scan = scanRollout(text);
  return quietCall(scan, now, quietMs, maxQuietMs) && callCanAsk(scan.call?.payload, scan.policy);
}

// The newest part of each session file as last scanned, by size and modification time, so a chat
// rechecked every few seconds that wrote nothing since is not read again.
const scans = new Map();
const SCAN_LIMIT = 200;
// A file changed this recently may change again without its time moving; its scan is not reused.
const SETTLED_MS = 2000;
const statFile = (path) => { const info = statSync(path); return { size: info.size, mtimeMs: info.mtimeMs }; };

/**
 * Look at a session file on disk: { awaits, call, progress, now }. `awaits` is the approval guess (false
 * when the file cannot be read), `call` the open call ({ command, tool, at }) while there is one,
 * `progress` the newest plan in view, and `now` what the chat is doing (see stepNow). Only a quiet open
 * call whose policy is not in the newest part of the file costs a longer read, up to 4 MB; a file whose
 * size and time have not changed since it was last scanned is not read at all.
 */
export function inspectRollout(file, { now = Date.now(), quietMs = APPROVAL_QUIET_MS, maxQuietMs = APPROVAL_MAX_QUIET_MS,
  readTail = readFileTail, sizeOf = (path) => statSync(path).size, stat = statFile } = {}) {
  const none = { awaits: false, call: null, progress: null, now: null };
  if (typeof file !== "string" || !/\.jsonl$/i.test(file)) return none;
  const path = file.replace(/^\\\\\?\\/, "");
  let seen = none;
  let info = null;
  try { info = stat(path); } catch { info = null; }
  try {
    let previous = -1;
    for (const [step, bytes] of TAIL_STEPS.entries()) {
      const saved = step === 0 && info ? scans.get(path) : null;
      let scan;
      let length;
      if (saved && saved.size === info.size && saved.mtimeMs === info.mtimeMs) ({ scan, length } = saved);
      else {
        const text = readTail(path, bytes);
        scan = scanRollout(text);
        length = text.length;
        if (step === 0 && info && Date.now() - info.mtimeMs > SETTLED_MS) rememberScan(path, { size: info.size, mtimeMs: info.mtimeMs, scan, length });
      }
      if (length === previous) break; // The whole file is already in view.
      previous = length;
      seen = { awaits: false, call: openCallOf(scan), progress: scan.plan || seen.progress, now: stepNow(scan) };
      // The open call and its quiet are in the newest part; only the policy may need a longer look.
      // A call no policy lets ask (a wait, a plan, a sandboxed command short of "untrusted") needs none.
      if (!quietCall(scan, now, quietMs, maxQuietMs) || !callCanAsk(scan.call?.payload, "untrusted")) return seen;
      const payload = scan.call.payload;
      if (scan.policy) {
        rememberPolicy(path, scan.policy, sizeOf(path));
        return { ...seen, awaits: callCanAsk(payload, scan.policy) };
      }
      // A chat rechecked every few seconds would otherwise read megabytes each time to find the same policy.
      // Session files only grow; one that shrank was replaced, and its remembered policy no longer applies.
      // Anything written since the policy was found is inside the newest read (which held no newer turn_context),
      // so the remembered policy still applies; a file that shrank or grew past that is looked at again.
      const known = step === 0 ? knownPolicies.get(path) : null;
      const size = known ? sizeOf(path) : 0;
      if (known && size >= known.size && size - known.size <= bytes) {
        rememberPolicy(path, known.policy, size);
        return { ...seen, awaits: callCanAsk(payload, known.policy) };
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

function rememberScan(path, entry) {
  scans.delete(path);
  scans.set(path, entry);
  if (scans.size > SCAN_LIMIT) scans.delete(scans.keys().next().value);
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
 * same read gives the open turn's plan progress and what the chat is doing (`now`, which withCodexNow
 * keeps for a chat running elsewhere). `awaits` (a yes/no check) stands in for tests.
 */
export function withApprovalGuess(actor, file, { now = Date.now(), awaits = null, inspect = inspectRollout } = {}) {
  const last = actor?.turnStates?.at(-1);
  if (!last?.open || !(actor.runningElsewhere || last.status === "interrupted")) return actor;
  if (awaits) return awaits(file, { now }) ? markAwaitingApproval(actor) : actor;
  const seen = inspect(file, { now });
  const planned = { ...actor, ...(seen.progress ? { progress: seen.progress } : {}), ...(seen.now ? { now: seen.now } : {}) };
  return seen.awaits ? markAwaitingApproval(planned, seen.call) : planned;
}
