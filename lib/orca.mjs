import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { describeModel } from "./models.mjs";
import { redactSecrets } from "./claude.mjs";
import { DETAIL_LIMITS, baseName, clean, oneLine, stepStatus, toMs } from "./detail-text.mjs";

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
    changes.push({ id: eventId(id, "message", stamp, agent.lastAssistantMessage), kind: "update", title: "Update", description: CLIP(agent.lastAssistantMessage, 1200), status: "completed", turnId: id, turnStartedAt: stamp, order: 0 });
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

/** A structured question Orca captured from the agent's own hook (AskUserQuestion), or null. Pure. */
export function orcaInteractiveAsk(interactivePrompt) {
  if (typeof interactivePrompt !== "string" || !interactivePrompt) return null;
  let parsed;
  try { parsed = JSON.parse(interactivePrompt); } catch { return null; }
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

const delay = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); });

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

export class OrcaReader {
  constructor({ command = process.env.ORCA_CLI_COMMAND || "orca", ttlMs = 3000, run = runFile, clock = Date.now,
    inspectLimit = 3, inspectTimeoutMs = 3000, inboxTtlMs = 5000, tasksTtlMs = 15_000, screenTtlMs = 1500 } = {}) {
    this.command = command;
    this.ttlMs = ttlMs;
    this.run = run;
    this.clock = clock;
    Object.assign(this, { inspectLimit, inspectTimeoutMs, inboxTtlMs, tasksTtlMs, screenTtlMs });
    this.cached = null;
    this.cachedAt = 0;
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

  /** Run one Orca CLI call with a timeout; the JSON result or a thrown error. */
  async call(args, { timeout = this.inspectTimeoutMs, maxBuffer = 4 * 1024 * 1024 } = {}) {
    const output = await this.run(this.command, args, { windowsHide: true, timeout, maxBuffer }).catch((error) => {
      // A CLI that ran and said why still answers in JSON on stdout.
      if (error?.stdout) return { stdout: error.stdout };
      throw error;
    });
    return envelope(output.stdout);
  }

  async snapshot() {
    if (this.cached && this.clock() - this.cachedAt < this.ttlMs) return this.cached;
    if (this.pending) return this.pending;
    this.pending = this.load().finally(() => { this.pending = null; });
    return this.pending;
  }

  async load() {
    let worktrees = [];
    let terminals = [];
    try {
      const [worktreeOutput, terminalOutput] = await Promise.all([
        this.run(this.command, ["worktree", "ps", "--json"], { windowsHide: true, timeout: 12000, maxBuffer: 8 * 1024 * 1024 }),
        this.run(this.command, ["terminal", "list", "--json"], { windowsHide: true, timeout: 12000, maxBuffer: 8 * 1024 * 1024 }),
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
      if (!this.cached && error?.code === "ENOENT") return { workspaces: [], warning: "", missing: true };
      // Plain words for the tooltip, never the command line: a CLI that ran and failed (exit code,
      // timeout, or Orca saying its app is not running) means the Orca app is closed; anything else is
      // an answer it could not read.
      const reason = error?.notRunning || typeof error?.code === "number" || error?.killed || /timed? ?out/i.test(String(error?.message))
        ? "Orca is not running" : "Orca could not be read";
      if (this.cached) {
        // A minute after Orca stopped answering, what was working is no longer known to be.
        const saved = this.clock() - this.cachedAt > ORCA_FALLBACK_MS ? unavailableSnapshot(this.cached) : this.cached;
        return { ...saved, warning: `Orca feed is temporarily unavailable: ${reason}.` };
      }
      return { workspaces: [], warning: `Orca feed is unavailable: ${reason}.` };
    }
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
        return {
          id, source: "orca", name: nickname, nickname, role: `${agent.agentType} · ${agent.state || "unknown"}`,
          model: orcaModel(agent),
          parentThreadId: workspaceId(worktree.worktreeId), cwd: worktree.path, status: agent.state || "unknown",
          pane: agent.paneKey, parentPane: agent.parentPaneKey || "", terminal,
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
    this.cached = { workspaces: transformed, warning: "" };
    this.cachedAt = this.clock();
    return this.cached;
  }

  /**
   * Tell a real prompt from an idle or coordinator-blocked "waiting" agent, and add what each agent
   * is doing now and how far a coordinator's tasks have got. Bounded: a few screen reads per load
   * (only for waiting agents whose state changed), one inbox read, and the task list every 15 s,
   * all with short timeouts and never longer than `inspectTimeoutMs` together. What is still
   * running when that time is up is used on the next load. Orca not running is simply no news.
   */
  async enrich(agents) {
    const now = this.clock();
    const jobs = [];
    const keyOf = (agent) => `${agent.terminal}|${agent.updatedAt}`;
    const waiting = agents.filter((agent) => String(agent.status).toLowerCase() === "waiting" && agent.terminal);
    const unread = waiting.filter((agent) => !orcaInteractiveAsk(this.raw.get(agent.id)?.interactivePrompt) && this.screens.get(agent.terminal)?.key !== keyOf(agent)
      && !this.inspecting.has(agent.terminal))
      .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt)).slice(0, this.inspectLimit);
    for (const agent of unread) jobs.push(this.inspectScreen(agent.terminal, keyOf(agent)));
    if (waiting.length && now - this.inbox.at > this.inboxTtlMs) jobs.push(this.refreshInbox());
    if (agents.length && now - this.tasks.at > this.tasksTtlMs) jobs.push(this.refreshTasks());
    if (jobs.length) await Promise.race([Promise.allSettled(jobs), delay(this.inspectTimeoutMs)]);
    const runs = this.tasks.runs;
    for (const agent of agents) {
      const raw = this.raw.get(agent.id) || {};
      const fields = { ask: null, waitingOn: null, now: orcaNow(raw), progress: null };
      const commandAsk = orcaAskInCommand(raw.toolName, raw.toolInput);
      if (String(agent.status).toLowerCase() === "waiting") {
        const screen = this.screens.get(agent.terminal);
        const found = orcaInteractiveAsk(raw.interactivePrompt) || (screen?.key === keyOf(agent) ? screen.prompt : null);
        if (found) {
          const ask = { ...found, at: Number(agent.updatedAt) || 0, answerHere: agent.terminal ? "orca-send" : null };
          fields.ask = { ...ask, key: askKey(agent.id, ask) };
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
      // real prompt; an agent asking its coordinator is at work, and one at its prompt is idle.
      if (String(raw.state || agent.status).toLowerCase() === "waiting") {
        const [kind] = String(agent.role || "agent").split(" · ");
        agent.status = fields.ask ? "waiting" : fields.waitingOn ? "working" : "idle";
        agent.role = `${kind} · ${fields.ask ? "waiting on you" : fields.waitingOn ? "asked the coordinator" : "idle"}`;
      }
    }
  }

  async inspectScreen(terminal, key) {
    // One read per terminal at a time: a slow one still running is not started again.
    this.inspecting.add(terminal);
    try {
      const result = await this.call(["terminal", "read", `--terminal=${terminal}`, "--screen", "--json"]);
      const lines = Array.isArray(result.terminal?.tail) ? result.terminal.tail : [];
      this.screens.set(terminal, { key, prompt: detectTerminalPrompt(lines), at: this.clock() });
    } catch {
      // Unreadable now: no prompt is claimed, and this state is not read again until it changes.
      this.screens.set(terminal, { key, prompt: null, at: this.clock() });
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
      const screen = { lines: tail.slice(-DETAIL_LIMITS.screenLines).map((line) => {
        const text = redactSecrets(line);
        return text.length > DETAIL_LIMITS.screenLineChars ? `${text.slice(0, DETAIL_LIMITS.screenLineChars - 1)}…` : text;
      }), at: this.clock() };
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

  /** Bring an agent's terminal to the front in Orca. */
  async switchTo(terminal) {
    if (!ORCA_HANDLE.test(String(terminal || ""))) throw Object.assign(new Error("This agent has no Orca terminal to open."), { statusCode: 409 });
    await this.call(["terminal", "switch", `--terminal=${terminal}`, "--json"], { timeout: 8000 });
    return { opened: true };
  }

  /** Type one line into an agent's terminal and press Enter. */
  async send(terminal, text) {
    if (!ORCA_HANDLE.test(String(terminal || ""))) throw Object.assign(new Error("This agent has no Orca terminal to type into."), { statusCode: 409 });
    // One line: a newline in the middle would submit half the message.
    const line = String(text ?? "").replace(/\r\n|\r|\n/g, " ").trim();
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
