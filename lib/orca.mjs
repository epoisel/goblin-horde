import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { win32 } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { describeModel } from "./models.mjs";
import { permissionText, redactSecrets } from "./claude.mjs";
import { DETAIL_LIMITS, baseName, clean, oneLine, stepStatus, toMs } from "./detail-text.mjs";
import { identityMark } from "./links.mjs";
import { clipText } from "./asks.mjs";
import { briefFacts } from "./orca-commands.mjs";

// Tools whose approval summary is a file path; the ask names the file.
const FILE_ASK_TOOLS = new Set(["Read", "NotebookRead", "Edit", "MultiEdit", "Write", "NotebookEdit"]);

// Orca names the agent kind; when it does not also name the model, the kind still picks the tribe.
const AGENT_KINDS = { claude: { id: "claude", label: "Claude", family: "claude" }, codex: { id: "codex", label: "Codex", family: "openai" } };
export function orcaModel(agent) {
  return describeModel(agent?.model) || AGENT_KINDS[String(agent?.agentType || "").toLowerCase()] || null;
}

const runFile = promisify(execFile);
const CLIP = (value, length = 800) => String(value || "").trim().slice(0, length);
const eventId = (id, kind, stamp, value) => `${id}:${kind}:${stamp}:${createHash("sha256").update(String(value || "")).digest("hex").slice(0, 12)}`;
const workspaceId = (id) => `orca:${Buffer.from(id).toString("base64url")}`;
const decodeWorkspaceId = (id) => {
  if (!/^orca:[A-Za-z0-9_-]+$/.test(id)) return "";
  try { return Buffer.from(id.slice(5), "base64url").toString("utf8"); } catch { return ""; }
};
// A terminal handle as Orca issues it; nothing that could be read as a flag or a path.
export const ORCA_HANDLE = /^term_[A-Za-z0-9_-]{1,80}$/;
export const ORCA_AGENT_ID = /^orca-agent:[A-Za-z0-9_:.-]{1,200}$/;

export function orcaAgentActivity(agent, previous = null) {
  const changes = [];
  const stamp = Number(agent.updatedAt) || Date.now();
  const id = String(agent.paneKey);
  if (agent.lastAssistantMessage && agent.lastAssistantMessage !== previous?.lastAssistantMessage) {
    // Cut with an ellipsis, so a phone knows the last line was cut (and leaves it out: see withoutCutLine).
    changes.push({ id: eventId(id, "message", stamp, agent.lastAssistantMessage), kind: "update", title: "Update", description: clipText(agent.lastAssistantMessage, 1200), status: "completed", turnId: id, turnStartedAt: stamp, order: 0 });
  }
  if (agent.toolName && (agent.toolName !== previous?.toolName || agent.toolInput !== previous?.toolInput || agent.state !== previous?.state)) {
    const name = CLIP(agent.toolName, 60);
    changes.push({ id: eventId(id, "tool", stamp, `${name}:${agent.toolInput}`), kind: "tool", title: `Used ${name}`, description: name === "Bash" || name === "PowerShell" ? "Ran a local command." : `Used ${name}.`, detail: CLIP(agent.toolInput, 1800), status: agent.state === "working" ? "inProgress" : "completed", turnId: id, turnStartedAt: stamp, order: 1 });
  }
  if (previous && agent.state !== previous.state) {
    const labels = { done: "Finished the task.", waiting: "Waiting for the next step.", working: "Working on the task." };
    changes.push({ id: eventId(id, "state", stamp, agent.state), kind: "update", title: "Status", description: labels[agent.state] || `Status: ${agent.state}.`, status: "completed", turnId: id, turnStartedAt: stamp, order: 2 });
  }
  return changes;
}

function emptyCounts() { return { updates: 0, commands: 0, research: 0, tools: 0 }; }

// A saved snapshot stands in briefly when Orca cannot be read; after this its agents are not live news.
export const ORCA_FALLBACK_MS = 60_000;

/** The last snapshot, with every agent marked unavailable: Orca is closed, so nothing is known to run. */
function unavailableSnapshot(snapshot) {
  return {
    ...snapshot,
    workspaces: snapshot.workspaces.map((workspace) => ({
      ...workspace,
      agents: workspace.agents.map((agent) => ({ ...agent, status: "unavailable", ask: null, waitingOn: null, now: null,
        role: `${String(agent.role || "").split(" · ")[0] || "agent"} · unavailable` })),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// What "waiting" means. Orca says "waiting" for an agent idle at its prompt after finishing, for a
// worker blocked on `orca orchestration ask` to its coordinator, and for a real prompt for the
// person (a permission or question menu on screen). Only the last needs the person; the screen
// and the orchestration inbox tell them apart.

const BOX = /[│┃║╭╮╰╯─━═╔╗╚╝┌┐└┘├┤┬┴┼▌▐█╌┄]/g;
const OPTION = /^(?:([❯›>▶➤→»])\s*)?(\d{1,2})[.)]\s+(.+?)\s*$/;
const MENU_HINT = /esc to cancel|enter to (?:select|confirm)|↑\/↓|to navigate|press enter|\(esc\)|tab to amend/i;
const PERMISSION_WORDS = /do you want to|would you like to|\ballow\b|approve|permission|proceed|run the following|make (?:this|the following) edit/i;
const PERMISSION_OPTIONS = /don't ask again|yes, and|always allow|no, and tell|yes, proceed|allow all/i;
const HEADER = /^(Bash|PowerShell) command$|^(Edit|Create|Write|Read|Update|Delete) file$|^Fetch$|^Web (?:fetch|search)$|^Tool use$|^MCP\b|^Network request/i;
const HEADER_TOOL = [[/^Bash/i, "Bash"], [/^PowerShell/i, "PowerShell"], [/^Edit|^Update/i, "Edit"], [/^Create|^Write/i, "Write"], [/^Read/i, "Read"],
  [/^Fetch|^Web fetch/i, "WebFetch"], [/^Web search/i, "WebSearch"]];
const KEY_HINT = /\s*\((?:esc|y|n|a|p|shift\+tab|ctrl\+[a-z]|tab|enter)\)\s*$/i;

/**
 * A prompt waiting for the person on a rendered terminal screen, or null. Recognises numbered
 * menus with a selection cursor or a key hint (Claude Code's "Do you want to proceed?" and
 * question menus, Codex's approval menu) and y/n prompts at the bottom of the screen. Prose that
 * merely ends in a question, or a numbered list in an answer, is not a prompt. Pure.
 * Returns { kind: "permission" | "question", text, command?, tool?, options? }.
 */
export function detectTerminalPrompt(lines) {
  const rows = (Array.isArray(lines) ? lines : []).slice(-80).map((line) => String(line ?? "").replace(BOX, " ").replace(/\s+$/, ""));
  const filled = rows.map((text, index) => ({ text: text.trim(), index })).filter((row) => row.text);
  const bottom = filled.slice(-30);
  // Every option line near the bottom, then the lowest run numbered 1, 2, 3 … with small gaps.
  const options = bottom.map((row) => ({ ...row, match: OPTION.exec(row.text) })).filter((row) => row.match);
  let menu = [];
  for (let start = options.length - 1; start >= 0; start--) {
    if (Number(options[start].match[2]) !== 1) continue;
    const run = [options[start]];
    for (let next = start + 1; next < options.length; next++) {
      const previous = run.at(-1);
      if (Number(options[next].match[2]) !== Number(previous.match[2]) + 1) break;
      if (options[next].index - previous.index > 4) break;
      run.push(options[next]);
    }
    if (run.length >= 2) { menu = run; break; }
  }
  if (menu.length) {
    const lastIndex = menu.at(-1).index;
    const below = filled.filter((row) => row.index > lastIndex);
    const hinted = menu.some((row) => row.match[1]) || below.slice(0, 4).some((row) => MENU_HINT.test(row.text)) || menu.some((row) => /\((?:esc|y|a)\)\s*$/i.test(row.text));
    // A real prompt sits at the bottom: little but key hints may follow it.
    if (hinted && below.length <= 4) {
      const firstIndex = menu[0].index;
      const above = rows.slice(Math.max(0, firstIndex - 16), firstIndex);
      const labels = menu.map((row) => row.match[3].replace(KEY_HINT, "").trim()).filter(Boolean);
      // The question: the nearest line ending in "?" above the menu, else the paragraph just above it.
      let questionAt = -1;
      for (let index = above.length - 1; index >= 0; index--) if (/\?\s*$/.test(above[index].trim())) { questionAt = index; break; }
      const paragraph = [];
      if (questionAt < 0) {
        for (let index = above.length - 1; index >= 0 && paragraph.length < 6; index--) {
          if (!above[index].trim()) { if (paragraph.length) break; continue; }
          paragraph.unshift(above[index].trim());
        }
      }
      const text = questionAt >= 0 ? above[questionAt].trim() : paragraph.join("\n");
      const headerAt = above.findIndex((line) => HEADER.test(line.trim()));
      let command = "";
      const dollar = above.slice(Math.max(0, questionAt)).map((line) => line.trim()).find((line) => /^\$ \S/.test(line));
      if (dollar) command = dollar.slice(2);
      else if (headerAt >= 0) {
        const block = [];
        for (let index = headerAt + 1; index < (questionAt >= 0 ? questionAt : above.length); index++) {
          const line = above[index].trim();
          if (!line) { if (block.length) break; continue; }
          block.push(line);
        }
        command = block.join("\n");
      }
      const header = headerAt >= 0 ? above[headerAt].trim() : "";
      const tool = HEADER_TOOL.find(([pattern]) => pattern.test(header))?.[1] || "";
      const permission = Boolean(header) || PERMISSION_WORDS.test(text) || labels.some((label) => PERMISSION_OPTIONS.test(label));
      return {
        kind: permission ? "permission" : "question",
        text: clean(text || (permission ? "Allow this step?" : "Choose an option."), 600),
        ...(command ? { command: clean(command, 400) } : {}),
        ...(tool ? { tool } : {}),
        options: labels.slice(0, 6).map((label) => clean(label, 120)),
      };
    }
  }
  // y/n prompts: only at the very bottom of the screen.
  const last = filled.slice(-3);
  const yesNo = last.find((row) => /\((?:y\/n|y\/N|Y\/n|yes\/no)\)|\[(?:y\/n|y\/N|Y\/n)\]/.test(row.text))
    || (last.some((row) => /\byes\s*\(y\)/i.test(row.text) && /\bno\s*\(n\)/i.test(row.text)) ? last.at(-1) : null);
  if (yesNo) {
    const question = [...filled.slice(-6)].reverse().find((row) => /\?/.test(row.text)) || yesNo;
    return { kind: "permission", text: clean(question.text.replace(/\s*(?:\((?:y\/n|y\/N|Y\/n|yes\/no)\)|\[(?:y\/n|y\/N|Y\/n)\])\s*:?\s*$/, ""), 600), options: ["Yes", "No"] };
  }
  return null;
}

/**
 * A terminal screen's rows with credentials removed. The filter runs on the joined text, with a row
 * that fills the screen's width (a long line the terminal wrapped) joined to the next without a break,
 * so a token split across rows is still recognised whole; the text is then split back into rows. Pure.
 */
export function redactScreen(rows) {
  const lines = (Array.isArray(rows) ? rows : []).map((row) => String(row ?? ""));
  const width = Math.max(0, ...lines.map((row) => row.length));
  const wraps = (row) => width >= 20 && row.length === width && !/\s$/.test(row);
  const groups = [];
  let open = null;
  for (const row of lines) {
    if (open) open.push(row);
    else groups.push(open = [row]);
    if (!wraps(row)) open = null;
  }
  const cleaned = redactSecrets(groups.map((group) => group.join("")).join("\n")).split("\n");
  // A removed multi-line block (a private key) changes the line count: keep its lines as they came out.
  if (cleaned.length !== groups.length) return cleaned;
  return cleaned.flatMap((text, index) => {
    if (groups[index].length === 1) return [text];
    const rows = [];
    for (let at = 0; at < text.length; at += width) rows.push(text.slice(at, at + width));
    return rows.length ? rows : [""];
  });
}

/**
 * What Orca captured from the agent's own hook, or null. Pure. AskUserQuestion's `{ questions }` is a
 * question; a PermissionRequest's `{ approval: { tool, summary } }` (the summary is the command, path,
 * url, or pattern, up to 200 characters) is a permission ask in the words Claude Code requests use.
 */
export function orcaInteractiveAsk(interactivePrompt) {
  if (typeof interactivePrompt !== "string" || !interactivePrompt) return null;
  let parsed;
  try { parsed = JSON.parse(interactivePrompt); } catch { return null; }
  const approval = parsed?.approval;
  if (approval && typeof approval === "object" && typeof approval.tool === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(approval.tool)) {
    const tool = approval.tool;
    const summary = typeof approval.summary === "string" ? approval.summary : "";
    const target = FILE_ASK_TOOLS.has(tool) ? baseName(summary) : "";
    return { kind: "permission", text: clean(permissionText({ tool, target, detail: summary }), 600), ...(summary ? { command: clean(summary, 400) } : {}), tool };
  }
  const questions = (Array.isArray(parsed?.questions) ? parsed.questions : []).slice(0, 4).map((question) => ({
    text: clean(question?.question ?? question?.text ?? "", 600),
    options: (Array.isArray(question?.options) ? question.options : []).slice(0, 6).map((option) => clean(typeof option === "string" ? option : option?.label ?? "", 120)).filter(Boolean),
  })).filter((question) => question.text);
  if (!questions.length) return null;
  return { kind: "question", text: questions[0].text, tool: "AskUserQuestion", questions, ...(questions[0].options.length ? { options: questions[0].options } : {}) };
}

const ASK_COMMAND = /\borca(?:\.exe)?\s+orchestration\s+ask\b/i;
/** A worker whose running command is `orca orchestration ask`: it waits on its coordinator. Pure. */
export function orcaAskInCommand(toolName, toolInput) {
  if (!/^(Bash|PowerShell|shell|exec_command|local_shell)$/i.test(String(toolName || "")) || !ASK_COMMAND.test(String(toolInput || ""))) return null;
  const match = /--question[ =]+(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(String(toolInput));
  const text = match ? match[1] ?? match[2] ?? match[3] : "";
  return { who: "coordinator", ...(text ? { text: clean(text, 600) } : {}) };
}

/**
 * The newest question this agent asked its coordinator that has no reply yet, from Orca's
 * orchestration inbox rows, or null. An ask is a "question" message from the agent's terminal
 * (or its dispatch); a reply is any later message in the same thread. Pure.
 */
export function pendingCoordinatorQuestion(messages, { terminal = "", pane = "", dispatchIds = new Set() } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const replied = new Set(list.filter((message) => message?.thread_id && message.thread_id !== message.id).map((message) => message.thread_id));
  const mine = list.filter((message) => (message?.type === "question" || message?.type === "decision_gate") && !replied.has(message.id)
    && ((terminal && message.from_handle === terminal) || (pane && message.sender_pane_key === pane)
      || (String(message.from_handle || "").startsWith("dispatch:") && dispatchIds.has(String(message.from_handle).slice(9)))));
  const newest = mine.sort((a, b) => toMs(b.created_at) - toMs(a.created_at))[0];
  if (!newest) return null;
  let question = "";
  try { question = String(JSON.parse(newest.payload || "{}")?.question || ""); } catch { question = ""; }
  return { who: "coordinator", text: clean(question || newest.body || newest.subject || "", 600), at: toMs(newest.created_at) };
}

const NOW_KIND = [[/^(Bash|PowerShell|shell|exec_command|local_shell)$/i, "command"], [/^(Edit|MultiEdit|NotebookEdit|apply_patch)$/i, "edit"], [/^Write$/i, "write"],
  [/^(Read|NotebookRead|LS)$/i, "read"], [/^(Grep|Glob)$/i, "search"], [/^(WebFetch|WebSearch|web_search)$/i, "web"], [/^(Agent|Task)$/i, "agent"],
  [/^(AskUserQuestion|request_user_input)$/i, "ask"]];

/** What a working Orca agent is doing, from the tool its hook last reported. Pure. */
export function orcaNow({ state, toolName, toolInput, updatedAt } = {}) {
  if (String(state || "").toLowerCase() !== "working") return null;
  const startedAt = Number(updatedAt) || 0;
  if (!toolName) return { kind: "think", title: "Thinking", startedAt };
  const kind = NOW_KIND.find(([pattern]) => pattern.test(String(toolName)))?.[1] || "tool";
  const input = String(toolInput || "");
  const titles = { command: `Running ${oneLine(input, 100) || "a command"}`, edit: `Editing ${baseName(input) || "a file"}`, write: `Writing ${baseName(input) || "a file"}`,
    read: `Reading ${baseName(input) || "a file"}`, search: `Searching for ${oneLine(input, 80) || "files"}`, web: `Opening ${oneLine(input, 80) || "a page"}`,
    agent: "Running a subagent", ask: "Asking you", tool: `Using ${oneLine(toolName, 60)}` };
  return { kind, title: oneLine(titles[kind]), ...(input ? { detail: clean(input, DETAIL_LIMITS.nowDetail) } : {}), startedAt };
}

/** A coordinator's progress from its run's tasks: { done, total, current? }, or null. Pure. */
export function taskProgress(tasks) {
  const list = (Array.isArray(tasks) ? tasks : []).filter((task) => task && typeof task === "object");
  if (!list.length) return null;
  const current = list.find((task) => task.status === "dispatched");
  return { done: list.filter((task) => task.status === "completed").length, total: list.length,
    ...(current ? { current: oneLine(current.task_title || current.display_name || current.spec, 120) } : {}) };
}

const taskTitle = (task) => oneLine(task?.task_title || task?.display_name || task?.spec, 300);

/** A stable signature for an ask, so a dismissed one stays dismissed and a new one alerts again. */
export function askKey(id, ask) {
  return createHash("sha256").update(`${id}\n${ask.kind}\n${ask.text}\n${ask.at}`).digest("hex").slice(0, 16);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A screen read this long after Orca's state changed has had time to draw a permission dialog.
const SETTLE_MS = 2000;

/** The `result` of an Orca CLI JSON answer, or an error in plain words. */
function envelope(stdout) {
  let parsed;
  try { parsed = JSON.parse(String(stdout || "")); } catch { throw new Error("Orca gave an answer that could not be read."); }
  if (!parsed?.ok) {
    const code = String(parsed?.error?.code || "");
    throw Object.assign(new Error(code === "runtime_unavailable" ? "Orca is not running." : clean(parsed?.error?.message || "Orca refused the request.", 300)), { code });
  }
  return parsed.result || {};
}

/**
 * Where the running Orca keeps its runtime file, when that is not where the Orca CLI looks by default.
 * Started from a packaged Windows app (the Codex app is one), Orca's writes to %APPDATA% land in that
 * package's private copy (%LOCALAPPDATA%\Packages\<package>\LocalCache\Roaming), so the default
 * %APPDATA%\orca\orca-runtime.json goes stale and every CLI call from outside that app says Orca is not
 * running. The folder whose runtime file names a live process wins (the newest start when several do);
 * null keeps the CLI's own default. An ORCA_USER_DATA_PATH the person set is always kept.
 */
export function orcaUserDataPath({ env = process.env, platform = process.platform, fs = { existsSync, readdirSync, readFileSync },
  alive = processAlive } = {}) {
  if (env.ORCA_USER_DATA_PATH) return null;
  if (platform !== "win32" || !env.APPDATA || !env.LOCALAPPDATA) return null;
  const standard = win32.join(env.APPDATA, "orca");
  const candidates = [standard];
  const packages = win32.join(env.LOCALAPPDATA, "Packages");
  let names = [];
  try { names = fs.readdirSync(packages); } catch { /* No packaged apps. */ }
  for (const name of names) {
    if (!/^[\w.-]{1,120}$/.test(name)) continue;
    const dir = win32.join(packages, name, "LocalCache", "Roaming", "orca");
    if (fs.existsSync(win32.join(dir, "orca-runtime.json"))) candidates.push(dir);
  }
  if (candidates.length === 1) return null;
  let best = null;
  for (const dir of candidates) {
    let runtime;
    try { runtime = JSON.parse(fs.readFileSync(win32.join(dir, "orca-runtime.json"), "utf8")); } catch { continue; }
    const pid = Number(runtime?.pid);
    if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) continue;
    const started = Number(runtime.startedAt) || 0;
    if (!best || started > best.started) best = { dir, started };
  }
  return best && best.dir !== standard ? best.dir : null;
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

export class OrcaReader {
  constructor({ command = process.env.ORCA_CLI_COMMAND || "orca", ttlMs = 3000, run = runFile, clock = Date.now,
    inspectLimit = 3, inspectTimeoutMs = 3000, inboxTtlMs = 5000, tasksTtlMs = 15_000, screenTtlMs = 1500, recheckMs = 5000,
    maxBackoffMs = 60_000, userData = orcaUserDataPath } = {}) {
    this.command = command;
    this.userData = userData;
    this.userDataAt = -Infinity;
    this.ttlMs = ttlMs;
    this.run = run;
    this.clock = clock;
    Object.assign(this, { inspectLimit, inspectTimeoutMs, inboxTtlMs, tasksTtlMs, screenTtlMs, recheckMs, maxBackoffMs });
    this.cached = null;
    this.cachedAt = 0;
    this.failed = null; // { result, until }: the last failed read, answered again until `until`
    this.failures = 0; // failed reads in a row
    this.pending = null;
    this.previous = new Map();
    this.events = new Map();
    this.raw = new Map(); // agent id -> the hook fields kept off the public actor (prompt, tool input, …)
    this.screens = new Map(); // terminal -> { key, prompt, at } for waiting agents
    this.inspecting = new Set(); // terminals whose screen read is still running
    this.liveScreens = new Map(); // terminal -> { at, lines } for the detail view
    this.inbox = { at: 0, messages: [], pending: null };
    this.tasks = { at: 0, runs: [], pending: null };
  }

  /**
   * Options for one CLI call: when the running Orca keeps its runtime file in a packaged app's private
   * AppData (see orcaUserDataPath), the CLI is told where, so it reaches the Orca that is really running.
   */
  cliOptions(options) {
    const now = this.clock();
    if (now - this.userDataAt > 30_000) {
      this.userDataAt = now;
      try { this.userDataPath = this.userData?.() || null; } catch { this.userDataPath = null; }
    }
    return this.userDataPath ? { ...options, env: { ...process.env, ORCA_USER_DATA_PATH: this.userDataPath } } : options;
  }

  /** Run one Orca CLI call with a timeout; the JSON result or a thrown error. */
  async call(args, { timeout = this.inspectTimeoutMs, maxBuffer = 4 * 1024 * 1024 } = {}) {
    const output = await this.run(this.command, args, this.cliOptions({ windowsHide: true, timeout, maxBuffer })).catch((error) => {
      // A CLI that ran and said why still answers in JSON on stdout.
      if (error?.stdout) return { stdout: error.stdout };
      throw error;
    });
    return envelope(output.stdout);
  }

  /**
   * Every workspace and agent, read at most once per TTL. A failed read (Orca closed, not installed, or
   * not answering) is answered again for the TTL, doubling with each failure in a row up to
   * `maxBackoffMs`, so a closed Orca costs no CLI call on most polls.
   */
  async snapshot() {
    const now = this.clock();
    if (this.cached && !this.failed && now - this.cachedAt < this.ttlMs) return this.cached;
    if (this.failed && now < this.failed.until) return this.failed.result;
    if (this.pending) return this.pending;
    this.pending = this.load().finally(() => { this.pending = null; });
    return this.pending;
  }

  /** The newest snapshot already in hand, without asking Orca: for callers that must never wait. Null before the first read. */
  lastSnapshot() {
    return this.failed?.result || this.cached || null;
  }

  /** Remember a failed read and when to try again. */
  fail(result) {
    this.failures++;
    this.failed = { result, until: this.clock() + Math.min(this.maxBackoffMs, this.ttlMs * 2 ** Math.min(this.failures - 1, 20)) };
    return result;
  }

  async load() {
    let worktrees = [];
    let terminals = [];
    try {
      const [worktreeOutput, terminalOutput] = await Promise.all([
        this.run(this.command, ["worktree", "ps", "--json"], this.cliOptions({ windowsHide: true, timeout: 12000, maxBuffer: 8 * 1024 * 1024 })),
        this.run(this.command, ["terminal", "list", "--json"], this.cliOptions({ windowsHide: true, timeout: 12000, maxBuffer: 8 * 1024 * 1024 })),
      ]);
      const worktreeEnvelope = JSON.parse(worktreeOutput.stdout);
      const terminalEnvelope = JSON.parse(terminalOutput.stdout);
      if (!worktreeEnvelope.ok || !terminalEnvelope.ok) {
        const code = String(worktreeEnvelope.error?.code || terminalEnvelope.error?.code || "");
        throw Object.assign(new Error("Orca inventory unavailable"), { notRunning: code === "runtime_unavailable" });
      }
      worktrees = worktreeEnvelope.result?.worktrees || [];
      terminals = terminalEnvelope.result?.terminals || [];
    } catch (error) {
      // Orca is optional: when its command is not installed there is nothing missing from the feed.
      if (!this.cached && error?.code === "ENOENT") return this.fail({ workspaces: [], warning: "", missing: true, failure: "missing" });
      // Plain words for the tooltip, never the command line: a CLI that ran and failed (exit code,
      // timeout, or Orca saying its app is not running) means the Orca app is closed; anything else is
      // an answer it could not read. `failure` keeps which, so the task view can tell an Orca that is
      // closed from one whose command line cannot reach it (see orcaSource).
      const failure = error?.notRunning ? "not-running" : error?.killed || /timed? ?out/i.test(String(error?.message)) ? "timeout"
        : typeof error?.code === "number" ? "not-running" : error?.code === "ENOENT" ? "missing" : "unreadable";
      const reason = failure === "unreadable" || failure === "missing" ? "Orca could not be read" : "Orca is not running";
      if (this.cached) {
        // A minute after Orca stopped answering, what was working is no longer known to be.
        const saved = this.clock() - this.cachedAt > ORCA_FALLBACK_MS ? unavailableSnapshot(this.cached) : this.cached;
        return this.fail({ ...saved, warning: `Orca feed is temporarily unavailable: ${reason}.`, failure });
      }
      return this.fail({ workspaces: [], warning: `Orca feed is unavailable: ${reason}.`, failure });
    }
    this.failures = 0;
    this.failed = null;
    const terminalNames = new Map(terminals.filter((item) => !item.orphaned).map((item) => [`${item.tabId}:${item.leafId}`, item.title]));
    // A pane's terminal handle is how a Codex chat that drives it names it (see lib/links.mjs).
    const terminalHandles = new Map(terminals.filter((item) => !item.orphaned && item.handle).map((item) => [`${item.tabId}:${item.leafId}`, String(item.handle)]));
    const seen = new Set();
    const transformed = worktrees.filter((worktree) => !worktree.isArchived).map((worktree) => {
      const agents = (worktree.agents || []).filter((agent) => agent.paneKey && agent.agentType).map((agent) => {
        const id = `orca-agent:${agent.paneKey}`;
        seen.add(id);
        const old = this.previous.get(id);
        const newEvents = orcaAgentActivity(agent, old);
        const events = [...(this.events.get(id) || []), ...newEvents].slice(-50);
        this.events.set(id, events);
        this.previous.set(id, { state: agent.state, lastAssistantMessage: agent.lastAssistantMessage, toolName: agent.toolName, toolInput: agent.toolInput });
        const terminalName = terminalNames.get(agent.paneKey);
        const title = agent.displayName || agent.taskTitle || (terminalName && !/^terminal\s*\d+$/i.test(terminalName) ? terminalName.replace(/^✳\s*/, "") : "");
        const nickname = CLIP(title || `${agent.agentType[0].toUpperCase()}${agent.agentType.slice(1)} agent`, 70);
        const latest = events.at(-1) || null;
        const terminal = terminalHandles.get(agent.paneKey) || "";
        this.raw.set(id, { state: agent.state, toolName: agent.toolName, toolInput: agent.toolInput, interactivePrompt: agent.interactivePrompt,
          prompt: agent.prompt, lastAssistantMessage: agent.lastAssistantMessage, updatedAt: agent.updatedAt || worktree.lastOutputAt || 0, terminal });
        // A worker's dispatch brief names its task and terminals: the task view matches it to its session by these ids.
        const brief = briefFacts(agent.prompt);
        return {
          id, source: "orca", name: nickname, nickname, role: `${agent.agentType} · ${agent.state || "unknown"}`,
          model: orcaModel(agent),
          parentThreadId: workspaceId(worktree.worktreeId), cwd: worktree.path, status: agent.state || "unknown",
          pane: agent.paneKey, parentPane: agent.parentPaneKey || "", terminal,
          ...(brief?.task || brief?.own ? { orcaBrief: { task: brief.task, own: brief.own, coordinator: brief.coordinator } } : {}),
          mainWorktree: Boolean(worktree.isMainWorktree),
          updatedAt: agent.updatedAt || worktree.lastOutputAt || 0, turns: 1,
          turnStates: [], activities: events, latest,
          counts: { ...emptyCounts(), updates: events.filter((event) => event.kind === "update").length, tools: events.filter((event) => event.kind === "tool").length },
        };
      }).sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
      return {
        id: workspaceId(worktree.worktreeId), source: "orca", name: worktree.displayName || worktree.repo || "Orca workspace",
        cwd: worktree.path, status: worktree.workspaceStatus || "unknown", updatedAt: worktree.lastOutputAt || worktree.lastActivityAt || 0,
        agents,
      };
    }).sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
    for (const key of this.events.keys()) if (!seen.has(key)) { this.events.delete(key); this.previous.delete(key); this.raw.delete(key); }
    await this.enrich(transformed.flatMap((workspace) => workspace.agents));
    // Every open terminal's handle and title: a worker whose terminal is not an agent pane is still named by Orca.
    const titles = terminals.filter((item) => !item.orphaned && ORCA_HANDLE.test(String(item.handle || "")))
      .map((item) => ({ handle: String(item.handle), title: CLIP(String(item.title || "").replace(/^✳\s*/, ""), 120) }));
    this.cached = { workspaces: transformed, warning: "", terminals: titles };
    this.cachedAt = this.clock();
    return this.cached;
  }

  /**
   * Orca's own record of its orchestration runs and their workers, for grouping a task even after the
   * workers' terminals closed: { runs: [{ id, coordinator, objective, at }], workers: [{ task, run, handle,
   * dispatch, state, at }] }. Read at most every 30 s, only while Orca answers, through `call` (so it
   * reaches an Orca whose runtime file lives in a packaged app's AppData); null before the first answer.
   */
  async orchestration() {
    const now = this.clock();
    if (this.orch && now - this.orch.at < 30_000) return this.orch.value;
    if (this.orchPending) return this.orchPending;
    if (!this.cached || this.failed) return this.orch?.value || null;
    this.orchPending = (async () => {
      const listed = await this.call(["orchestration", "run-list", "--limit=100", "--json"], { timeout: 8000, maxBuffer: 16 * 1024 * 1024 });
      const runs = (Array.isArray(listed.runs) ? listed.runs : []).filter((run) => /^run_[A-Za-z0-9]{6,40}$/.test(String(run?.id)))
        .map((run) => ({ id: String(run.id), ...(ORCA_HANDLE.test(String(run.coordinator_handle)) ? { coordinator: String(run.coordinator_handle) } : {}),
          objective: clean(run.objective || "", 200), at: toMs(run.updated_at || run.created_at) }));
      const workers = [];
      let cursor = "";
      for (let page = 0; page < 5; page++) {
        const answer = await this.call(["orchestration", "worker-list", "--limit=100", ...(cursor ? [`--cursor=${cursor}`] : []), "--json"],
          { timeout: 8000, maxBuffer: 16 * 1024 * 1024 });
        for (const worker of Array.isArray(answer.workers) ? answer.workers : []) {
          if (!/^task_[A-Za-z0-9]{6,40}$/.test(String(worker?.taskId))) continue;
          workers.push({ task: String(worker.taskId), ...(/^run_[A-Za-z0-9]{6,40}$/.test(String(worker.runId)) ? { run: String(worker.runId) } : {}),
            ...(ORCA_HANDLE.test(String(worker.agentTerminalHandle)) ? { handle: String(worker.agentTerminalHandle) } : {}),
            ...(typeof worker.dispatchId === "string" && /^[A-Za-z0-9_-]{6,60}$/.test(worker.dispatchId) ? { dispatch: worker.dispatchId } : {}),
            state: String(worker.workerState || worker.dispatchStatus || "").slice(0, 30) });
        }
        const next = String(answer.page?.nextCursor || "");
        if (!answer.page?.hasMore || !/^[A-Za-z0-9_=:.+/-]{1,400}$/.test(next)) break;
        cursor = next;
      }
      return { runs, workers };
    })().then((value) => { this.orch = { at: this.clock(), value }; return value; },
      () => { this.orch = { at: this.clock(), value: this.orch?.value || null }; return this.orch.value; })
      .finally(() => { this.orchPending = null; });
    return this.orchPending;
  }

  /**
   * The prompt a waiting agent shows the person, or null. Orca's own record of a question stands until
   * Orca's state changes (answering it ends the tool call at once). A permission is different: Orca
   * keeps "waiting" after it is approved, until the tool's next event, so the screen decides. Its menu
   * on screen is the ask (Orca's approval record, when there is one, names it); a screen read taken
   * at least `SETTLE_MS` after Orca's state changed that shows no menu means it was answered.
   * `screen` is the newest read for this state, or null.
   */
  promptFor(agent, screen, recorded) {
    if (recorded?.kind === "question") return recorded;
    if (screen?.prompt) return recorded ? { ...screen.prompt, ...recorded, command: recorded.command || screen.prompt.command } : screen.prompt;
    if (recorded && !(screen && screen.at - (Number(agent.updatedAt) || 0) >= SETTLE_MS)) return recorded;
    return null;
  }

  /**
   * Tell a real prompt from an idle or coordinator-blocked "waiting" agent, and add what each agent
   * is doing now and how far a coordinator's tasks have got. Bounded: a few screen reads per load
   * (waiting agents whose state changed first, then, every `recheckMs`, those still showing a prompt,
   * since one answered in the terminal leaves Orca saying "waiting"), one inbox read, and the task
   * list every 15 s, all with short timeouts and never longer than `inspectTimeoutMs` together. What
   * is still running when that time is up is used on the next load. Orca not running is no news.
   */
  async enrich(agents) {
    const now = this.clock();
    const jobs = [];
    const keyOf = (agent) => `${agent.terminal}|${agent.updatedAt}`;
    const recordedAsk = (agent) => orcaInteractiveAsk(this.raw.get(agent.id)?.interactivePrompt);
    const screenOf = (agent) => { const screen = this.screens.get(agent.terminal); return screen?.key === keyOf(agent) ? screen : null; };
    const waiting = agents.filter((agent) => String(agent.status).toLowerCase() === "waiting" && agent.terminal);
    const firstLooks = [];
    const rechecks = [];
    for (const agent of waiting) {
      const recorded = recordedAsk(agent);
      if (recorded?.kind === "question" || this.inspecting.has(agent.terminal)) continue;
      const screen = screenOf(agent);
      if (!screen) firstLooks.push(agent);
      else if (this.promptFor(agent, screen, recorded) && now - screen.at >= this.recheckMs) rechecks.push({ agent, at: screen.at });
    }
    const due = [...firstLooks.sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt)),
      ...rechecks.sort((a, b) => a.at - b.at).map((item) => item.agent)].slice(0, this.inspectLimit);
    for (const agent of due) jobs.push(this.inspectScreen(agent.terminal, keyOf(agent)));
    if (waiting.length && now - this.inbox.at > this.inboxTtlMs) jobs.push(this.refreshInbox());
    if (agents.length && now - this.tasks.at > this.tasksTtlMs) jobs.push(this.refreshTasks());
    if (jobs.length) await Promise.race([Promise.allSettled(jobs), delay(this.inspectTimeoutMs)]);
    const runs = this.tasks.runs;
    for (const agent of agents) {
      const raw = this.raw.get(agent.id) || {};
      const fields = { ask: null, waitingOn: null, now: orcaNow(raw), progress: null };
      const commandAsk = orcaAskInCommand(raw.toolName, raw.toolInput);
      let answered = false;
      if (String(agent.status).toLowerCase() === "waiting") {
        const screen = agent.terminal ? screenOf(agent) : null;
        const recorded = recordedAsk(agent);
        const found = this.promptFor(agent, screen, recorded);
        if (found) {
          const ask = { ...found, at: Number(agent.updatedAt) || 0, answerHere: agent.terminal ? "orca-send" : null };
          fields.ask = { ...ask, key: askKey(agent.id, ask) };
        } else if (screen?.asked || recorded) {
          // A prompt seen for this state is gone from the screen: it was answered, and the step it
          // asked about is running until Orca's next event.
          answered = true;
          fields.now = orcaNow({ ...raw, state: "working" });
        } else {
          const dispatchIds = new Set(runs.flatMap((run) => run.tasks).filter((task) => task.assignee_handle === agent.terminal && task.dispatch_id).map((task) => String(task.dispatch_id)));
          const question = pendingCoordinatorQuestion(this.inbox.messages, { terminal: agent.terminal, pane: agent.pane, dispatchIds });
          if (question || commandAsk) fields.waitingOn = { ...(commandAsk || {}), ...(question || {}), at: question?.at || Number(agent.updatedAt) || 0 };
        }
      } else if (commandAsk) fields.waitingOn = { ...commandAsk, at: Number(agent.updatedAt) || 0 };
      const led = runs.find((run) => run.run.coordinator_handle && run.run.coordinator_handle === agent.terminal);
      if (led) fields.progress = taskProgress(led.tasks);
      Object.assign(agent, fields, { needsInput: Boolean(fields.ask) });
      // Every viewer reads status "waiting" as "waiting on you", so Orca's word is kept only for a
      // real prompt; an agent asking its coordinator or running an answered step is at work, and one
      // at its prompt is idle.
      if (String(raw.state || agent.status).toLowerCase() === "waiting") {
        const [kind] = String(agent.role || "agent").split(" · ");
        agent.status = fields.ask ? "waiting" : fields.waitingOn || answered ? "working" : "idle";
        agent.role = `${kind} · ${fields.ask ? "waiting on you" : fields.waitingOn ? "asked the coordinator" : answered ? "working" : "idle"}`;
      }
    }
  }

  async inspectScreen(terminal, key) {
    // One read per terminal at a time: a slow one still running is not started again.
    this.inspecting.add(terminal);
    const previous = this.screens.get(terminal);
    const same = previous?.key === key;
    try {
      const result = await this.call(["terminal", "read", `--terminal=${terminal}`, "--screen", "--json"]);
      const lines = Array.isArray(result.terminal?.tail) ? result.terminal.tail : [];
      const prompt = detectTerminalPrompt(lines);
      // `asked`: a prompt was on screen at some read of this state.
      this.screens.set(terminal, { key, prompt, at: this.clock(), asked: Boolean(prompt) || Boolean(same && previous.asked) });
    } catch {
      // Unreadable now: a first look claims no prompt; a recheck keeps what the last read saw. Either
      // way the next try waits for the next state change or recheck.
      this.screens.set(terminal, same ? { ...previous, at: this.clock() } : { key, prompt: null, at: this.clock(), asked: false });
    } finally { this.inspecting.delete(terminal); }
    if (this.screens.size > 200) this.screens.delete(this.screens.keys().next().value);
  }

  refreshInbox() {
    if (this.inbox.pending) return this.inbox.pending;
    this.inbox.pending = this.call(["orchestration", "inbox", "--limit=200", "--json"])
      .then((result) => { this.inbox.messages = Array.isArray(result.messages) ? result.messages : []; }, () => { /* Keep the last answer. */ })
      .finally(() => { this.inbox.at = this.clock(); this.inbox.pending = null; });
    return this.inbox.pending;
  }

  refreshTasks() {
    if (this.tasks.pending) return this.tasks.pending;
    this.tasks.pending = (async () => {
      const listed = await this.call(["orchestration", "run-list", "--limit=10", "--json"]);
      const day = this.clock() - 24 * 60 * 60_000;
      const recent = (Array.isArray(listed.runs) ? listed.runs : []).filter((run) => run?.id && run.coordinator_handle && toMs(run.updated_at || run.created_at) >= day)
        .sort((a, b) => toMs(b.updated_at || b.created_at) - toMs(a.updated_at || a.created_at)).slice(0, 3);
      const runs = [];
      for (const run of recent) {
        try {
          const result = await this.call(["orchestration", "task-list", `--run=${run.id}`, "--json"]);
          runs.push({ run, tasks: Array.isArray(result.tasks) ? result.tasks.slice(0, 200) : [] });
        } catch { /* A run Orca will not list is left out. */ }
      }
      this.tasks.runs = runs;
    })().catch(() => { /* Orca not running or too old: keep the last answer. */ })
      .finally(() => { this.tasks.at = this.clock(); this.tasks.pending = null; });
    return this.tasks.pending;
  }

  /** The rendered screen of one terminal for the detail view (≤ 40 lines), read at most every 1.5 s. */
  async screen(terminal) {
    if (!ORCA_HANDLE.test(String(terminal || ""))) return null;
    const saved = this.liveScreens.get(terminal);
    if (saved && this.clock() - saved.at < this.screenTtlMs) return saved;
    try {
      const result = await this.call(["terminal", "read", `--terminal=${terminal}`, "--screen", "--json"]);
      const tail = (Array.isArray(result.terminal?.tail) ? result.terminal.tail : []).map((line) => String(line ?? "").replace(/\s+$/, ""));
      while (tail.length && !tail.at(-1)) tail.pop();
      const screen = { lines: redactScreen(tail.slice(-DETAIL_LIMITS.screenLines - 1)).slice(-DETAIL_LIMITS.screenLines).map((text) =>
        (text.length > DETAIL_LIMITS.screenLineChars ? `${text.slice(0, DETAIL_LIMITS.screenLineChars - 1)}…` : text)), at: this.clock() };
      this.liveScreens.set(terminal, screen);
      if (this.liveScreens.size > 50) this.liveScreens.delete(this.liveScreens.keys().next().value);
      return screen;
    } catch { return saved || null; }
  }

  /** One Orca agent's detail parts: screen, mission, plan, now, said, trail. Null when unknown. */
  async detail(id) {
    if (!ORCA_AGENT_ID.test(String(id))) return null;
    const snapshot = await this.snapshot();
    const agent = snapshot.workspaces.flatMap((workspace) => workspace.agents).find((item) => item.id === id);
    if (!agent) return null;
    const raw = this.raw.get(id) || {};
    const tasks = this.tasks.runs.flatMap((run) => run.tasks.map((task) => ({ ...task, run: run.run })));
    const assigned = tasks.filter((task) => agent.terminal && task.assignee_handle === agent.terminal)
      .sort((a, b) => Number(b.status === "dispatched") - Number(a.status === "dispatched") || toMs(b.created_at) - toMs(a.created_at))[0];
    const led = this.tasks.runs.find((run) => agent.terminal && run.run.coordinator_handle === agent.terminal);
    const mission = assigned ? { text: clean([assigned.task_title, assigned.spec].filter(Boolean).join("\n\n"), DETAIL_LIMITS.mission), from: "coordinator", at: toMs(assigned.created_at) }
      : raw.prompt ? { text: clean(raw.prompt, DETAIL_LIMITS.mission), from: agent.parentPane ? "coordinator" : "you", at: 0 } : null;
    const plan = led?.tasks.length ? { steps: led.tasks.slice(0, 50).map((task) => ({ text: taskTitle(task), status: task.status === "failed" ? "pending" : stepStatus(task.status) })),
      at: Math.max(0, ...led.tasks.map((task) => toMs(task.completed_at || task.created_at))), source: "orca-tasks" } : null;
    const trail = [...(this.events.get(id) || [])].reverse().filter((event) => event.title !== "Status").slice(0, DETAIL_LIMITS.trail).map((event) => {
      const at = Number(event.turnStartedAt) || 0;
      const status = event.status === "inProgress" ? "running" : event.status === "failed" ? "failed" : "ok";
      if (event.kind === "tool") {
        const name = String(event.title || "").replace(/^Used /, "");
        const command = /^(Bash|PowerShell)$/i.test(name);
        return { id: event.id, at, kind: command ? "command" : "tool", title: command ? oneLine(event.detail) || "Ran a command" : `Used ${oneLine(name, 60)}`,
          ...(event.detail ? { detail: clean(event.detail, DETAIL_LIMITS.detail) } : {}), status };
      }
      return { id: event.id, at, kind: "message", title: oneLine(event.description), detail: clean(event.description, DETAIL_LIMITS.detail), status };
    });
    const said = raw.lastAssistantMessage ? { text: clean(raw.lastAssistantMessage, DETAIL_LIMITS.said), at: Number(raw.updatedAt) || 0 } : null;
    const screen = agent.terminal ? await this.screen(agent.terminal) : null;
    return { agent, mission, plan, now: agent.now ?? orcaNow(raw), said, trail, files: [], screen };
  }

  /**
   * Marks of a pane's newest prompt and reply as Orca reported them (see identityMark), so the server
   * can prove which Claude Code session the pane is. The words themselves stay off the actor.
   */
  marksFor(id) {
    const raw = this.raw.get(id);
    return raw ? [identityMark(raw.prompt), identityMark(raw.lastAssistantMessage)].filter(Boolean) : [];
  }

  /** Bring an agent's terminal to the front in Orca. */
  async switchTo(terminal) {
    if (!ORCA_HANDLE.test(String(terminal || ""))) throw Object.assign(new Error("This agent has no Orca terminal to open."), { statusCode: 409 });
    await this.call(["terminal", "switch", `--terminal=${terminal}`, "--json"], { timeout: 8000 });
    return { opened: true };
  }

  /** Type one line into an agent's terminal and press Enter. */
  async send(terminal, text) {
    if (!ORCA_HANDLE.test(String(terminal || ""))) throw Object.assign(new Error("This agent has no Orca terminal to type into."), { statusCode: 409 });
    // One plain line: a newline (or a Unicode line or paragraph separator) in the middle would submit
    // half the message, and control characters (escape sequences, bells, C1 codes) are keystrokes.
    const line = String(text ?? "").replace(/\r\n/g, " ").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").trim();
    if (!line) throw Object.assign(new Error("Write a message first."), { statusCode: 400 });
    const result = await this.call(["terminal", "send", `--terminal=${terminal}`, `--text=${line}`, "--enter", "--json"], { timeout: 15_000 });
    if (result.send && result.send.accepted === false)
      throw Object.assign(new Error(clean(result.send.refusedReason ? `Orca did not send it: ${result.send.refusedReason}` : "Orca did not send it.", 300)), { statusCode: 409 });
    return { sent: true };
  }

  async listWorkspaces() {
    const snapshot = await this.snapshot();
    return snapshot.workspaces.map(({ id, name, cwd, updatedAt, agents }) => ({ id, name: `Orca · ${name}`, cwd, updatedAt, source: "orca", agentCount: agents.length }));
  }

  async scene(id) {
    const snapshot = await this.snapshot();
    const decoded = decodeWorkspaceId(id);
    const workspace = snapshot.workspaces.find((item) => item.id === id && decodeWorkspaceId(item.id) === decoded);
    if (!workspace) return null;
    return {
      root: { id, source: "orca", name: `Orca · ${workspace.name}`, cwd: workspace.cwd, status: workspace.status, updatedAt: workspace.updatedAt, turns: 0, turnStates: [], activities: [], latest: null, counts: emptyCounts() },
      agents: workspace.agents,
      requests: [], warning: snapshot.warning,
    };
  }
}

export { workspaceId };

/**
 * Whether the Orca app is running on this computer, by its process name alone (Orca.exe, Orca.app, orca),
 * for telling an Orca that is closed from one whose command line cannot reach it. Resolves true, false,
 * or null when the process list cannot be read. No shell; a fixed command per platform.
 */
export async function orcaProcessRunning({ platform = process.platform, run = runFile } = {}) {
  try {
    if (platform === "win32") {
      const { stdout } = await run("tasklist.exe", ["/FI", "IMAGENAME eq Orca.exe", "/FO", "CSV", "/NH"], { windowsHide: true, timeout: 8000 });
      return /"orca\.exe"/i.test(String(stdout));
    }
    // pgrep exits 1 when nothing matches: that is an answer, not a failure.
    await run("pgrep", ["-x", platform === "darwin" ? "Orca" : "orca"], { timeout: 8000 });
    return true;
  } catch (error) {
    return error?.code === 1 ? false : null;
  }
}

/**
 * Orca's state for the task view's source chips, in plain words with what to do: { state, say, reason? }.
 * `snapshot` is the newest OrcaReader answer; `running` whether Orca's process is up (true, false, or null
 * when unknown). An Orca that runs while its command line fails (a stale runtime file after an update)
 * is told apart from one that is closed: only the first needs a restart. Pure.
 */
export function orcaSource(snapshot, running = null) {
  if (!snapshot) return { state: "partial", reason: "checking", say: "Checking Orca…" };
  if (!snapshot.warning && !snapshot.missing) return { state: "ok", say: "Reading Orca's terminals and workers." };
  if (snapshot.missing && running !== true) return { state: "not-installed", reason: "not-installed", say: "Orca is not installed. It is optional." };
  if (running === true) {
    return { state: "unavailable", reason: "unreachable", say: snapshot.missing
      ? "Orca is running, but its command line was not found. Reinstall or restart Orca. Until then its workers are grouped from their Claude Code records."
      : "Orca is running, but its command line can't reach it — restart Orca. Until then its workers are grouped from their Claude Code records." };
  }
  if (running === false) return { state: "unavailable", reason: "not-running", say: "Orca is not running. Agents it ran still show from their own records." };
  return { state: "unavailable", reason: snapshot.failure || "unreadable", say: "Orca could not be reached. Agents it ran still show from their own records." };
}
