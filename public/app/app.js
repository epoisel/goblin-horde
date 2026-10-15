/**
 * The task view: every task of the last day on the left, and the selected task's agents side by side,
 * each column reading like the agent's own app (or all of them interleaved in a Timeline).
 *
 * State lives here; the server's words are read through adapter.js only, and entries are drawn by
 * transcript.js. Live by polling: /api/tasks every 3 s and each visible column's transcript every 2 s
 * with `after=`, paused while the window is hidden. Columns are never redrawn whole: new entries are
 * appended, changed ones patched in place, older pages prepended, so scroll position and opened rows
 * stay put. Agent text only ever reaches the page through textContent (see markdown.js).
 *
 * Address: /app#task=<id>&focus=<agent>&view=timeline ; /app#demo loads the synthetic demo-data.js.
 */
import { createGoblin, loadArt, modelBadge, setGoblinAction, tribeFor } from "/goblins.js";
import { agentAction, agentTone, createClient } from "./adapter.js";
import { TranscriptStore, clockTime, effectiveTimes, insertionIndex, renderEntry, updateEntry } from "./transcript.js";

const TASK_POLL_MS = 3000;
const TRANSCRIPT_POLL_MS = 2000;
const PREFS_KEY = "goblin-horde.app.v1";
const WINDOWS = [4, 24, 168];
const SOURCE_WORDS = { codex: "Codex", claude: "Claude Code", orca: "Orca", extension: "Feed" };
const OPEN_WORDS = { codex: "Open in Codex", claude: "Open in Claude", orca: "Open in Orca", extension: "Open" };
const ROLE_WORDS = { lead: "Lead", coordinator: "Coordinator", worker: "Worker", subagent: "Subagent", solo: "" };
const TONE_WORDS = { needs: "Needs you", failed: "Failed", waiting: "Waiting", working: "Working", done: "Done", idle: "Idle" };
const NOW_ICONS = { command: "›_", edit: "✎", write: "+", read: "≡", search: "⌕", web: "◎", agent: "⇲", tool: "•", think: "…", ask: "?", message: "✉" };
const LINK_WORDS = { drives: "drives", spawned: "spawned", dispatched: "dispatched", asked: "asked" };

// ---- Small DOM and time helpers ----

function el(tag, className = "", text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(className, text, label = "") {
  const node = el("button", className, text);
  node.type = "button";
  if (label) { node.setAttribute("aria-label", label); node.title = label; }
  return node;
}

/** "now", "4m", "2h", "yesterday", "3d" — for ages in lists. */
function age(ms, now = Date.now()) {
  if (!ms) return "";
  const minutes = Math.floor(Math.max(0, now - ms) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 48 * 60) return "yesterday";
  return `${Math.floor(minutes / 1440)}d`;
}

/** "42s", "12m", "3h 5m": how long something has run. */
function span(ms, now = Date.now()) {
  if (!ms) return "";
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function loadPrefs() {
  try { return { widths: {}, collapsed: {}, sidebar: true, window: 24, ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") }; }
  catch { return { widths: {}, collapsed: {}, sidebar: true, window: 24 }; }
}

function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* Private window: preferences last for this visit only. */ }
}

let toastTimer = 0;
function toast(message, tone = "") {
  const node = document.getElementById("toast");
  node.textContent = message;
  node.dataset.tone = tone;
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 3600);
}

/** A copy button: copies `text` (all of it, however long) and says so. */
function copyButton(text, label = "Copy") {
  const node = button("copy", "", label);
  node.append(el("span", "copy-icon", "⧉"), el("span", "copy-word", "Copy"));
  node.addEventListener("click", async (event) => {
    event.stopPropagation();
    let done = false;
    try { await navigator.clipboard.writeText(text); done = true; } catch {
      const area = el("textarea", "copy-area");
      area.value = text;
      document.body.append(area);
      area.select();
      try { done = document.execCommand("copy"); } catch { done = false; }
      area.remove();
    }
    node.classList.add(done ? "copied" : "copy-failed");
    node.querySelector(".copy-word").textContent = done ? "Copied" : "Can't copy";
    setTimeout(() => { node.classList.remove("copied", "copy-failed"); node.querySelector(".copy-word").textContent = "Copy"; }, 1600);
  });
  return node;
}

function goblinFor(agent, size, { still = false } = {}) {
  const canvas = createGoblin(agent.id, agentAction(agent), { size, still, tribe: tribeFor(agent), label: `${agent.name}, ${TONE_WORDS[agent.tone].toLowerCase()}` });
  canvas.dataset.agent = agent.id;
  return canvas;
}

// ---- Address (hash) ----

function readHash() {
  const raw = location.hash.replace(/^#/, "");
  const demo = /^demo(?:&|$)/.test(raw);
  const params = new URLSearchParams(raw.replace(/^demo&?/, ""));
  return { demo: demo || params.has("demo"), task: params.get("task") || "", focus: params.get("focus") || "", view: params.get("view") === "timeline" ? "timeline" : "columns" };
}

function writeHash() {
  const parts = [];
  if (api.demo) parts.push("demo");
  if (state.taskId) parts.push(`task=${encodeURIComponent(state.taskId)}`);
  if (state.focusId) parts.push(`focus=${encodeURIComponent(state.focusId)}`);
  if (state.view === "timeline") parts.push("view=timeline");
  const next = `#${parts.join("&")}`;
  if (location.hash !== next) history.replaceState(null, "", next);
}

// ---- State ----

const prefs = loadPrefs();
const start = readHash();
const state = {
  tasks: [], sources: [], checkedAt: 0, truncated: 0, aliases: {}, loaded: false, error: "", lastGood: 0,
  windowHours: WINDOWS.includes(prefs.window) ? prefs.window : 24, query: "",
  taskId: start.task, focusId: start.focus, view: start.view,
};
let api = null;
const stores = new Map(); // agent id → TranscriptStore, kept across task switches.
const inflight = new Map(); // agent id → the transcript request in flight.
const openRows = new Map(); // entry id → opened by the person; kept across redraws and views.
const dismissedAsks = new Set(); // agent id + ask key dismissed here, until the next poll agrees.
let taskView = null;

function storeFor(id) {
  if (!stores.has(id)) stores.set(id, new TranscriptStore(id));
  return stores.get(id);
}

function selectedTask() {
  return state.tasks.find((task) => task.id === state.taskId) || null;
}

function agentsById() {
  return new Map((selectedTask()?.agents || []).map((agent) => [agent.id, agent]));
}

/** The entry context the transcript renderer needs: copy, open-a-subagent, remembered open rows. */
function entryContext(agent) {
  return {
    doc: document,
    agent,
    agentsById: agentsById(),
    copyButton,
    openAgent: (id) => taskView?.revealAgent(id),
    isOpen: (id) => openRows.get(id) === true,
    onToggle: (id, open) => { if (open) openRows.set(id, true); else openRows.delete(id); },
    guessSubagent: (entry) => guessSubagent(agent, entry),
  };
}

/**
 * The subagent a spawn row means when the row has no id yet (a spawn still running): the agent's
 * subagent named in the row, else its only subagent no other row names.
 */
function guessSubagent(agent, entry) {
  if (!agent?.id) return null;
  const kids = (selectedTask()?.agents || []).filter((item) => item.parentId === agent.id && item.role === "subagent");
  if (!kids.length) return null;
  const words = `${entry.tool?.title || ""} ${entry.text || ""}`.toLowerCase();
  const named = kids.find((kid) => kid.name && words.includes(kid.name.toLowerCase()));
  if (named) return named.id;
  const entries = storeFor(agent.id).entries;
  const claimed = new Set(entries.map((item) => item.agentId || item.tool?.agentId).filter(Boolean));
  const free = kids.filter((kid) => !claimed.has(kid.id));
  const unnamed = entries.filter((item) => item.kind === "subagent" && !(item.agentId || item.tool?.agentId));
  return free.length === 1 && unnamed.length <= 1 ? free[0].id : null;
}

// ---- Transcript loading ----

async function loadTranscript(id, mode = "auto") {
  if (inflight.has(id)) return inflight.get(id);
  const store = storeFor(id);
  const kind = mode === "older" ? "before" : store.loaded ? "after" : "initial";
  if (kind === "before" && (!store.hasOlder || !store.first)) return null;
  const options = kind === "initial" ? { limit: 200 } : kind === "after" ? { after: store.last } : { before: store.first, limit: 200 };
  const request = api.transcript(id, options).then((page) => {
    if (page.error && !page.entries.length) throw new Error(page.error);
    store.apply(page, kind);
  }).catch((error) => {
    store.fail(error.status === 404 ? "This agent is not in view any more." : error.message);
  }).finally(() => inflight.delete(id));
  inflight.set(id, request);
  return request;
}

function pollTranscripts() {
  if (document.hidden || !taskView) return;
  for (const id of taskView.visibleAgentIds()) {
    // A transcript that keeps failing is asked less often: 4 s, 8 s, … up to a minute.
    const store = storeFor(id);
    if (store.failures && Date.now() - store.failedAt < Math.min(60_000, 2000 * 2 ** store.failures)) continue;
    loadTranscript(id);
  }
}

// ---- Tasks ----

let refreshing = null;
let refreshAgain = false;
/**
 * One request at a time: a slow server is never asked again before it answers. `fresh` (after the
 * person did something) reads once more when the request in flight began before the change.
 */
function refreshTasks(fresh = false) {
  if (refreshing) {
    if (fresh === true) refreshAgain = true;
    return refreshing;
  }
  refreshing = readTasks().finally(() => {
    refreshing = null;
    if (refreshAgain) { refreshAgain = false; refreshTasks(); }
  });
  return refreshing;
}

async function readTasks() {
  if (document.hidden && state.loaded) return;
  try {
    const result = await api.tasks(state.windowHours);
    Object.assign(state, { tasks: result.tasks, sources: result.sources, checkedAt: result.checkedAt, truncated: result.truncated, aliases: result.aliases || {},
      loaded: true, error: "", lastGood: Date.now() });
    for (const task of state.tasks) for (const agent of task.agents) {
      // An ask dismissed here stays dismissed until the server's next answer catches up.
      if (agent.ask && dismissedAsks.has(`${agent.id}:${agent.ask.key}`)) { agent.ask = null; agent.askDismissed = true; agent.needsInput = false; agent.tone = agentTone(agent); }
    }
  } catch (error) {
    state.error = error.status === 404 ? "This copy of Goblin Horde has no task list yet. Update it, or open /app#demo to see the demo."
      : error instanceof TypeError ? "Goblin Horde is not running on this computer." : error.message || "The viewer did not answer.";
  }
  resolveSelection();
  if (!state.taskId && state.tasks.length) { state.taskId = sidebarOrder()[0]?.id || ""; writeHash(); }
  renderSidebar();
  renderMain();
}

/**
 * The address may name an agent rather than its task, or an id the server now shows under another
 * (an Orca agent that is a Claude Code session): find the task and the column it means.
 */
function resolveSelection() {
  const resolve = (id) => state.aliases[id] || id;
  if (state.taskId && !state.tasks.some((task) => task.id === state.taskId)) {
    const wanted = resolve(state.taskId);
    const home = state.tasks.find((task) => task.id === wanted || task.agents.some((agent) => agent.id === wanted));
    if (home) {
      if (!state.focusId && home.id !== wanted) state.focusId = wanted;
      state.taskId = home.id;
      writeHash();
    }
  }
  const task = selectedTask();
  if (task && state.focusId && !task.agents.some((agent) => agent.id === state.focusId)) {
    const wanted = resolve(state.focusId);
    if (task.agents.some((agent) => agent.id === wanted)) { state.focusId = wanted; writeHash(); }
  }
}

/** Tasks in the order the sidebar shows them, filtered by the search box. */
function sidebarOrder() {
  const groups = groupTasks(filteredTasks());
  return [...groups.needs, ...groups.working, ...groups.rest];
}

function filteredTasks() {
  const words = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return state.tasks;
  return state.tasks.filter((task) => {
    const haystack = [task.title, task.project, ...task.agents.flatMap((agent) => [agent.name, agent.ask?.text, agent.now?.title, agent.model?.label, SOURCE_WORDS[agent.source]])]
      .filter(Boolean).join(" ").toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

function groupTasks(tasks) {
  return {
    needs: tasks.filter((task) => task.status === "needs" || task.status === "failed"),
    working: tasks.filter((task) => task.status === "working"),
    rest: tasks.filter((task) => task.status === "idle" || task.status === "done"),
  };
}

/** The most important thing going on in a task, in one line, and its tone. */
function taskLine(task) {
  const byId = new Map(task.agents.map((agent) => [agent.id, agent]));
  const asking = task.agents.find((agent) => agent.tone === "needs");
  if (asking) return { tone: "needs", text: asking.ask ? `${task.agents.length > 1 ? `${asking.name}: ` : ""}${asking.ask.text}` : `${asking.name} is waiting for you` };
  const failed = task.agents.find((agent) => agent.tone === "failed");
  if (failed) return { tone: "failed", text: `${task.agents.length > 1 ? `${failed.name} failed` : "Failed"}${failed.now?.title ? `: ${failed.now.title}` : ""}` };
  const waiting = task.agents.find((agent) => agent.tone === "waiting");
  if (waiting) {
    const on = byId.get(waiting.waitingOn?.on) || byId.get(waiting.parentId);
    return { tone: "waiting", text: `${waiting.name} asked ${on ? (on.role === "coordinator" ? "the coordinator" : on.name) : "another agent"}${waiting.waitingOn?.text ? `: ${waiting.waitingOn.text}` : ""}` };
  }
  const working = [...task.agents].filter((agent) => agent.tone === "working").sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (working) return { tone: "working", text: working.now?.title ? `${task.agents.length > 1 ? `${working.name}: ` : ""}${working.now.title}` : `${working.name} is working` };
  const last = [...task.agents].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (task.status === "done") return { tone: "done", text: last?.now?.title ? `Done · ${last.now.title}` : "Done" };
  return { tone: "idle", text: last?.now?.title ? `Last: ${last.now.title}` : "Idle" };
}

function taskCounts(task) {
  const tally = (tone) => task.agents.filter((agent) => agent.tone === tone).length;
  const parts = [];
  if (tally("needs")) parts.push(`${tally("needs")} needs you`);
  if (tally("failed")) parts.push(`${tally("failed")} failed`);
  const busy = tally("working") + tally("waiting");
  if (busy) parts.push(`${busy} working`);
  if (tally("done")) parts.push(`${tally("done")} done`);
  return parts;
}

// ---- Sidebar ----

const cards = new Map(); // task id → { node, task }
const groupHeads = {};

function renderSources() {
  const host = document.getElementById("sources");
  host.replaceChildren();
  for (const source of state.sources) {
    const chip = el("div", `source s-${source.state}`);
    const head = el("div", "source-head");
    head.append(el("span", "source-dot"), el("span", "source-name", source.name),
      el("span", "source-state", source.state === "ok" ? "" : source.state === "not-installed" ? "not installed" : source.state === "partial" ? "partly" : "can't reach"));
    chip.append(head);
    chip.title = source.say;
    if (source.state !== "ok" && source.state !== "not-installed") chip.append(el("p", "source-say", source.say));
    host.append(chip);
  }
  host.hidden = !state.sources.length;
}

function cardFor(task) {
  let entry = cards.get(task.id);
  if (!entry) {
    const node = button("task-card", "");
    node.dataset.id = task.id;
    node.addEventListener("click", () => selectTask(task.id));
    const side = el("div", "tc-side");
    side.append(el("span", "tc-age"), el("span", "tc-counts"));
    node.append(el("div", "tc-crew"), side, el("div", "tc-title"), el("div", "tc-line"), el("div", "tc-sub"));
    entry = { node, task, goblins: new Map() };
    cards.set(task.id, entry);
  }
  entry.task = task;
  updateCard(entry);
  return entry.node;
}

function updateCard(entry) {
  const { node, task, goblins } = entry;
  const compact = task.status === "idle" || task.status === "done";
  node.classList.toggle("compact", compact);
  node.classList.toggle("solo", !compact && task.agents.length < 2);
  node.dataset.status = task.status;
  node.setAttribute("aria-current", task.id === state.taskId ? "true" : "false");
  node.querySelector(".tc-title").textContent = task.title;
  const ageNode = node.querySelector(".tc-age");
  ageNode.textContent = age(task.updatedAt);
  ageNode.title = task.updatedAt ? `Updated ${new Date(task.updatedAt).toLocaleString()}` : "";
  const sub = node.querySelector(".tc-sub");
  sub.textContent = [task.project, task.agents.length > 1 ? `${task.agents.length} agents` : SOURCE_WORDS[task.agents[0]?.source] || ""].filter(Boolean).join(" · ");
  const line = taskLine(task);
  const lineNode = node.querySelector(".tc-line");
  lineNode.textContent = compact && task.project ? `${task.project} · ${line.text}` : line.text;
  lineNode.dataset.tone = line.tone;
  node.querySelector(".tc-counts").replaceChildren(...(compact || task.agents.length < 2 ? [] : taskCounts(task).map((part) => el("span", "", part))));
  // Goblins: the crew in tree order; a big card shows up to six, a compact one only the lead.
  const crew = node.querySelector(".tc-crew");
  const shown = task.agents.slice(0, compact ? 1 : 6);
  const size = compact ? 1 : 2;
  const keep = new Set(shown.map((agent) => agent.id));
  for (const [id, canvas] of goblins) if (!keep.has(id) || Number(canvas.dataset.size) !== size) { canvas.remove(); goblins.delete(id); }
  shown.forEach((agent, index) => {
    let canvas = goblins.get(agent.id);
    if (!canvas) {
      canvas = goblinFor(agent, size);
      canvas.dataset.size = String(size);
      goblins.set(agent.id, canvas);
    }
    setGoblinAction(canvas, agentAction(agent), `${agent.name}, ${TONE_WORDS[agent.tone].toLowerCase()}`);
    canvas.dataset.tone = agent.tone;
    if (crew.children[index] !== canvas) crew.insertBefore(canvas, crew.children[index] || null);
  });
  let more = crew.querySelector(".tc-more");
  const extra = task.agents.length - shown.length;
  if (extra > 0 && !compact) {
    if (!more) { more = el("span", "tc-more"); crew.append(more); }
    more.textContent = `+${extra}`;
    crew.append(more);
  } else more?.remove();
  node.setAttribute("aria-label", `${task.title}. ${TONE_WORDS[task.status] || task.status}. ${line.text}`);
}

function renderSidebar() {
  renderSources();
  const list = document.getElementById("task-list");
  const groups = groupTasks(filteredTasks());
  const wanted = [];
  const names = [["needs", "Needs you"], ["working", "Working"], ["rest", "Idle / done"]];
  for (const [key, title] of names) {
    if (!groups[key].length) continue;
    groupHeads[key] ||= el("h2", `group-head g-${key}`);
    groupHeads[key].replaceChildren(el("span", "", title), el("span", "group-count", String(groups[key].length)));
    wanted.push(groupHeads[key]);
    for (const task of groups[key]) wanted.push(cardFor(task));
  }
  const live = new Set(state.tasks.map((task) => task.id));
  for (const id of cards.keys()) if (!live.has(id)) { cards.get(id).node.remove(); cards.delete(id); }
  // Place nodes in order without rebuilding (keeps focus and the goblins' animation).
  wanted.forEach((node, index) => { if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null); });
  while (list.children.length > wanted.length) list.lastChild.remove();
  let empty = list.querySelector(".side-empty");
  if (!wanted.length) {
    empty = el("div", "side-empty");
    if (!state.loaded && !state.error) empty.append(el("p", "", "Gathering the horde…"));
    else if (!state.loaded) empty.append(el("p", "", "No task list yet."), el("p", "muted", "Trying again every few seconds."));
    else if (state.query) empty.append(el("p", "", `No task matches “${state.query}”.`));
    else empty.append(el("p", "", `Nothing ran in the last ${windowWords()}.`), el("p", "muted", "Agents appear here as soon as Codex or Claude Code starts work."));
    list.append(empty);
  }
  list.setAttribute("aria-label", `Tasks in the last ${windowWords()}`);
  const foot = document.getElementById("side-foot");
  const parts = [state.loaded ? `${state.tasks.length} ${state.tasks.length === 1 ? "task" : "tasks"} · last ${windowWords()}` : `Last ${windowWords()}`];
  if (state.truncated) parts.push(`${state.truncated} more not shown`);
  foot.textContent = parts.join(" · ");
  if (state.checkedAt) foot.title = `Checked ${new Date(state.checkedAt).toLocaleTimeString()}`;
  for (const choice of document.querySelectorAll("[data-window]")) choice.setAttribute("aria-pressed", String(Number(choice.dataset.window) === state.windowHours));
}

function windowWords() {
  return state.windowHours === 168 ? "7 days" : `${state.windowHours} hours`;
}

function selectTask(id) {
  if (state.taskId === id && taskView) return;
  state.taskId = id;
  state.focusId = "";
  writeHash();
  for (const entry of cards.values()) entry.node.setAttribute("aria-current", String(entry.task.id === id));
  renderMain();
}

// ---- Main area ----

function renderMain() {
  const banner = document.getElementById("banner");
  if (state.error && state.loaded) {
    banner.hidden = false;
    banner.replaceChildren(el("strong", "", "Can't reach Goblin Horde on this computer."),
      el("span", "", ` Showing the list from ${new Date(state.lastGood).toLocaleTimeString()}; trying again every few seconds. (${state.error})`));
  } else banner.hidden = true;
  const host = document.getElementById("view");
  const task = selectedTask();
  // The window's title names the task, and how many tasks need the person (it shows in the taskbar).
  const needs = state.tasks.filter((item) => item.status === "needs").length;
  document.title = `${needs ? `(${needs}) ` : ""}${task ? `${task.title} · ` : ""}Goblin Horde`;
  if (!task) {
    taskView?.destroy();
    taskView = null;
    // Redrawn only when what it says changes, so its button keeps focus between polls.
    const key = JSON.stringify([state.loaded, state.error, state.taskId, state.tasks.length, state.windowHours]);
    if (host.dataset.empty !== key || !host.querySelector(".empty-main")) {
      host.dataset.empty = key;
      host.replaceChildren(emptyMain());
    }
    return;
  }
  delete host.dataset.empty;
  if (taskView && taskView.task.id !== task.id) { taskView.destroy(); taskView = null; }
  if (!taskView) {
    taskView = new TaskView(task);
    host.replaceChildren(taskView.node);
    taskView.mount();
  } else taskView.update(task);
}

function emptyMain() {
  const box = el("section", "empty-main");
  const goblin = createGoblin("welcome", state.error && !state.loaded ? "trouble" : "idle", { size: 4, tribe: "raider", label: "A resting goblin" });
  box.append(goblin);
  if (state.error && !state.loaded) {
    box.append(el("h1", "", "The task list can't be read"), el("p", "", state.error),
      el("p", "muted", "If Goblin Horde is stopped, start it with: node goblin.mjs start. This page tries again every few seconds."));
    const retry = button("btn gold", "Try again");
    retry.addEventListener("click", () => refreshTasks());
    box.append(retry);
  } else if (!state.loaded) {
    box.append(el("h1", "", "Gathering the horde…"));
  } else if (state.taskId) {
    box.append(el("h1", "", "That task isn't in this list"), el("p", "", `It had no activity in the last ${windowWords()}. Try the 7-day window, or pick another task.`));
  } else if (!state.tasks.length) {
    box.append(el("h1", "", "No tasks yet"), el("p", "", `Nothing ran in the last ${windowWords()}. Start a Codex chat or a Claude Code session and it appears here.`));
  } else {
    box.append(el("h1", "", "Pick a task"), el("p", "", "Its agents open side by side."));
  }
  return box;
}

/** Stages of the crew strip: agents by depth, with the link word between stages. */
function crewStages(task) {
  const stages = [];
  for (const agent of task.agents) {
    const depth = Math.min(agent.depth || 0, 4);
    (stages[depth] ||= []).push(agent);
  }
  return stages.filter(Boolean).map((agents, index, all) => {
    if (!index) return { agents, word: "" };
    const ids = new Set(agents.map((agent) => agent.id));
    const previous = new Set(all[index - 1].map((agent) => agent.id));
    const kinds = task.links.filter((link) => ids.has(link.to) && previous.has(link.from)).map((link) => link.kind);
    const word = kinds.sort((a, b) => kinds.filter((k) => k === b).length - kinds.filter((k) => k === a).length)[0];
    return { agents, word: LINK_WORDS[word] || (agents.every((agent) => agent.role === "subagent") ? "spawned" : "leads") };
  });
}

class TaskView {
  constructor(task) {
    this.task = task;
    this.columns = new Map();
    this.timeline = null;
    this.node = el("section", "task-view");
    this.head = el("header", "tv-head");
    this.body = el("div", "tv-body");
    this.columnsNode = el("div", "columns");
    this.columnsNode.setAttribute("aria-label", "Agents of this task");
    this.body.append(this.columnsNode);
    this.node.append(this.head, this.body);
    this.visible = new Set();
    this.observer = new IntersectionObserver((items) => {
      for (const item of items) {
        const id = item.target.dataset.id;
        if (item.isIntersecting) { this.visible.add(id); loadTranscript(id); } else this.visible.delete(id);
      }
    }, { root: this.columnsNode, rootMargin: "0px 200px" });
    this.buildHead();
  }

  mount() {
    this.update(this.task, true);
  }

  destroy() {
    this.observer.disconnect();
    for (const column of this.columns.values()) column.destroy();
    this.timeline?.destroy();
    this.node.remove();
  }

  buildHead() {
    const row = el("div", "tv-row");
    const titles = el("div", "tv-titles");
    this.title = el("h1", "tv-title");
    this.meta = el("div", "tv-meta");
    titles.append(this.title, this.meta);
    const actions = el("div", "tv-actions");
    this.viewSwitch = el("div", "seg");
    this.viewSwitch.setAttribute("role", "group");
    this.viewSwitch.setAttribute("aria-label", "Layout");
    for (const [view, word] of [["columns", "Columns"], ["timeline", "Timeline"]]) {
      const choice = button("seg-btn", word);
      choice.dataset.view = view;
      choice.addEventListener("click", () => this.setView(view));
      this.viewSwitch.append(choice);
    }
    this.showAll = button("btn ghost", "Show all agents");
    this.showAll.addEventListener("click", () => this.setFocus(""));
    // Fit: every column shares the window's width, to watch the whole crew at once.
    this.fitButton = button("btn ghost", "⇔ Fit all", "Fit every agent's column in the window");
    this.fitButton.addEventListener("click", () => {
      prefs.fit = !prefs.fit;
      savePrefs();
      this.applyLayout();
    });
    this.openButtons = el("div", "tv-open");
    this.joinButton = button("btn ghost tight", "+ Join");
    this.joinButton.append(el("span", "btn-long", " a chat"));
    this.joinButton.setAttribute("aria-haspopup", "dialog");
    this.joinButton.addEventListener("click", () => this.toggleJoin());
    actions.append(this.showAll, this.fitButton, this.viewSwitch, this.openButtons, this.joinButton);
    row.append(titles, actions);
    this.crew = el("div", "crew");
    this.crew.setAttribute("aria-label", "Who works with whom");
    this.crew.addEventListener("scroll", () => this.markCrewOverflow(), { passive: true });
    this.crew.addEventListener("wheel", (event) => {
      // A mouse wheel scrolls the crew sideways.
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX) && this.crew.scrollWidth > this.crew.clientWidth) { this.crew.scrollLeft += event.deltaY; event.preventDefault(); }
    }, { passive: false });
    this.head.append(row, this.crew);
  }

  update(task, first = false) {
    this.task = task;
    this.title.textContent = task.title;
    this.meta.replaceChildren();
    const status = el("span", `status-chip t-${task.status}`, TONE_WORDS[task.status] || task.status);
    this.meta.append(status);
    if (task.project) this.meta.append(el("span", "tv-project", task.project));
    const facts = [`${task.agents.length} ${task.agents.length === 1 ? "agent" : "agents"}`];
    if (task.agents.length > 1 && taskCounts(task).length) facts.push(taskCounts(task).join(" · "));
    if (task.startedAt) facts.push(`started ${clockTime(task.startedAt)}`);
    const updated = el("span", "tv-fact", facts.join(" · "));
    this.meta.append(updated);
    this.renderOpenButtons();
    this.renderCrew();
    // Columns: one per agent, in the task's order.
    const ids = new Set(task.agents.map((agent) => agent.id));
    for (const [id, column] of this.columns) if (!ids.has(id)) { this.observer.unobserve(column.node); column.destroy(); this.columns.delete(id); }
    task.agents.forEach((agent, index) => {
      let column = this.columns.get(agent.id);
      if (!column) {
        column = new ColumnView(agent, this);
        this.columns.set(agent.id, column);
        this.observer.observe(column.node);
      } else column.update(agent);
      if (this.columnsNode.children[index] !== column.node) this.columnsNode.insertBefore(column.node, this.columnsNode.children[index] || null);
    });
    if (state.focusId && !ids.has(state.focusId)) { state.focusId = ""; writeHash(); }
    this.applyLayout();
    this.timeline?.updateAgents(task);
    // Columns load as they scroll into view (see the observer); a focused one at once.
    if (first && state.focusId) loadTranscript(state.focusId);
  }

  renderOpenButtons() {
    const signature = this.task.agents.map((agent) => `${agent.id}:${agent.source}:${agent.role}`).join("|");
    if (signature === this.openSignature) return;
    this.openSignature = signature;
    this.openButtons.replaceChildren();
    const seen = new Set();
    for (const agent of this.task.agents) {
      if (seen.has(agent.source) || seen.size >= 2) continue;
      seen.add(agent.source);
      const open = button("btn tight", "");
      open.append(el("span", "btn-long", "Open in "), document.createTextNode(SOURCE_WORDS[agent.source] === "Claude Code" ? "Claude" : SOURCE_WORDS[agent.source] || "its app"), el("span", "btn-arrow", " ↗"));
      open.setAttribute("aria-label", `${OPEN_WORDS[agent.source] || "Open"}: ${agent.name}`);
      open.addEventListener("click", () => openAgent(agent));
      this.openButtons.append(open);
    }
    const lead = this.task.agents.find((agent) => agent.source === "codex" && (agent.role === "lead" || agent.role === "solo"));
    this.joinButton.disabled = !lead;
    this.joinButton.title = lead ? "Add another chat or session to this task" : "Joining works when a Codex chat leads the task.";
  }

  renderCrew() {
    // Redrawn only when something it shows changed, so its scroll position and keyboard focus stay.
    const signature = JSON.stringify([this.task.agents.map((agent) => [agent.id, agent.name, agent.role, agent.tone, agent.depth, agent.waitingOn?.on, agentAction(agent)]), this.task.links.map((link) => `${link.from}>${link.to}:${link.kind}`)]);
    if (signature === this.crewSignature) return;
    this.crewSignature = signature;
    const scroll = this.crew.scrollLeft;
    const focused = document.activeElement?.closest?.(".crew-chip")?.dataset.id;
    this.crew.replaceChildren();
    this.crew.hidden = this.task.agents.length < 2;
    requestAnimationFrame(() => {
      this.crew.scrollLeft = scroll;
      if (focused) this.crew.querySelector(`.crew-chip[data-id="${CSS.escape(focused)}"]`)?.focus();
    });
    const byId = new Map(this.task.agents.map((agent) => [agent.id, agent]));
    crewStages(this.task).forEach((stage, index) => {
      if (index) {
        const arrow = el("span", "crew-link");
        arrow.append(el("span", "crew-word", stage.word), el("span", "crew-arrow", "→"));
        this.crew.append(arrow);
      }
      const group = el("div", "crew-stage");
      for (const agent of stage.agents) {
        const chip = button(`crew-chip r-${agent.role} t-${agent.tone}`, "");
        chip.dataset.id = agent.id;
        chip.setAttribute("aria-pressed", String(state.focusId === agent.id));
        chip.title = `${agent.name}${ROLE_WORDS[agent.role] ? ` · ${ROLE_WORDS[agent.role]}` : ""} · ${TONE_WORDS[agent.tone]} — click to show its column`;
        const goblin = goblinFor(agent, 1);
        chip.append(goblin, el("span", "crew-name", agent.name));
        if (agent.tone !== "working" && agent.tone !== "idle") chip.append(el("span", `crew-tone t-${agent.tone}`, agent.tone === "waiting" ? "asked" : TONE_WORDS[agent.tone].toLowerCase()));
        const on = agent.waitingOn ? byId.get(agent.waitingOn.on) : null;
        if (on) chip.title += ` · waiting on ${on.name}`;
        chip.addEventListener("click", () => this.revealAgent(agent.id));
        group.append(chip);
      }
      this.crew.append(group);
    });
    this.markCrewOverflow();
  }

  /** A crew wider than the header fades at its right edge, so it reads as scrollable. */
  markCrewOverflow() {
    requestAnimationFrame(() => this.crew.classList.toggle("overflowing", this.crew.scrollWidth > this.crew.clientWidth + 2
      && this.crew.scrollLeft + this.crew.clientWidth < this.crew.scrollWidth - 2));
  }

  /** Bring an agent's column into view (and open it if collapsed); in focus mode, focus it. */
  revealAgent(id) {
    const column = this.columns.get(id);
    if (!column) return;
    if (this.view === "timeline") this.setView("columns");
    if (state.focusId && state.focusId !== id) this.setFocus(id);
    if (column.collapsed) column.setCollapsed(false);
    column.node.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", inline: "nearest", block: "nearest" });
    column.flash();
  }

  get view() { return state.view; }

  setView(view) {
    state.view = view;
    writeHash();
    this.applyLayout();
  }

  setFocus(id) {
    state.focusId = id;
    writeHash();
    this.applyLayout();
    if (id) loadTranscript(id);
  }

  applyLayout() {
    const timeline = state.view === "timeline";
    for (const choice of this.viewSwitch.children) choice.setAttribute("aria-pressed", String(choice.dataset.view === state.view));
    // Scroll positions are saved before a view hides and put back when it shows again.
    for (const [id, column] of this.columns) column.setShown(!timeline && (!state.focusId || id === state.focusId));
    this.timeline?.setShown(timeline);
    this.columnsNode.hidden = timeline;
    this.columnsNode.classList.toggle("focused", Boolean(state.focusId));
    for (const [id, column] of this.columns) {
      column.node.hidden = Boolean(state.focusId) && id !== state.focusId;
      column.setFocused(state.focusId === id);
    }
    this.showAll.hidden = !state.focusId || timeline;
    this.columnsNode.classList.toggle("fit", Boolean(prefs.fit));
    this.fitButton.hidden = timeline || Boolean(state.focusId) || this.task.agents.length < 3;
    this.fitButton.setAttribute("aria-pressed", String(Boolean(prefs.fit)));
    for (const chip of this.crew.querySelectorAll(".crew-chip")) chip.setAttribute("aria-pressed", String(chip.dataset.id === state.focusId));
    if (timeline && !this.timeline) {
      this.timeline = new TimelineView(this.task);
      this.body.append(this.timeline.node);
      this.timeline.mount();
    }
    if (this.timeline) this.timeline.node.hidden = !timeline;
    if (timeline) for (const agent of this.task.agents) loadTranscript(agent.id);
    requestAnimationFrame(() => {
      for (const column of this.columns.values()) column.restoreScroll();
      this.timeline?.restoreScroll();
    });
  }

  visibleAgentIds() {
    if (state.view === "timeline") return this.task.agents.map((agent) => agent.id);
    if (state.focusId) return [state.focusId];
    return [...this.columns.values()].filter((column) => !column.collapsed && this.visible.has(column.agent.id)).map((column) => column.agent.id);
  }

  toggleJoin() {
    if (this.joinPanel) { this.closeJoin(); return; }
    const lead = this.task.agents.find((agent) => agent.source === "codex" && (agent.role === "lead" || agent.role === "solo"));
    if (!lead) return;
    const panel = el("div", "join-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Join a chat to this task");
    panel.append(el("p", "join-help", `Choose a chat or session to show with this task. It joins ${lead.name}, and you can separate it again later.`));
    const listNode = el("div", "join-list");
    const others = state.tasks.filter((task) => task.id !== this.task.id);
    if (!others.length) listNode.append(el("p", "muted", "No other chats in this window."));
    for (const other of others) {
      const pick = button("join-pick", "");
      pick.append(el("span", "join-title", other.title), el("span", "join-sub", [other.project, `${other.agents.length} ${other.agents.length === 1 ? "agent" : "agents"}`, age(other.updatedAt)].filter(Boolean).join(" · ")));
      pick.addEventListener("click", async () => {
        try {
          await api.join(other.agents[0].id, lead.id);
          toast(`${other.title} now shows with this task.`);
          this.closeJoin();
          refreshTasks(true);
        } catch (error) { toast(error.message, "bad"); }
      });
      listNode.append(pick);
    }
    const close = button("btn ghost small", "Cancel");
    close.addEventListener("click", () => this.closeJoin());
    panel.append(listNode, close);
    panel.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.stopPropagation(); this.closeJoin(); this.joinButton.focus(); } });
    this.head.append(panel);
    this.joinPanel = panel;
    this.joinButton.setAttribute("aria-expanded", "true");
    panel.querySelector("button")?.focus();
  }

  closeJoin() {
    this.joinPanel?.remove();
    this.joinPanel = null;
    this.joinButton.setAttribute("aria-expanded", "false");
  }
}

async function openAgent(agent) {
  try {
    const result = await api.open(agent.id);
    toast(result?.demo ? `Demo: this would open ${agent.name} in ${SOURCE_WORDS[agent.source]}.` : `Opening ${agent.name}…`);
  } catch (error) { toast(error.message, "bad"); }
}

// ---- One agent's column ----

class ColumnView {
  constructor(agent, taskView) {
    this.agent = agent;
    this.taskView = taskView;
    this.nodes = new Map(); // entry id → node
    this.unseen = 0;
    this.atBottom = true;
    this.store = storeFor(agent.id);
    this.collapsed = Boolean(prefs.collapsed[agent.id]);
    this.build();
    this.update(agent);
    this.unsubscribe = this.store.subscribe((change) => this.onChange(change));
    if (this.store.loaded) this.renderAll();
    else this.showLoading();
  }

  build() {
    const node = el("article", "col");
    node.dataset.id = this.agent.id;
    this.node = node;
    // The slim rail a collapsed column shrinks to.
    this.rail = button("col-rail", "", `Expand ${this.agent.name}`);
    this.railGoblin = goblinFor(this.agent, 1);
    this.rail.append(el("span", "rail-dot"), this.railGoblin, el("span", "rail-name", this.agent.name));
    this.rail.addEventListener("click", () => this.setCollapsed(false));

    const head = el("header", "col-head");
    this.goblin = goblinFor(this.agent, 2);
    const ident = el("div", "col-ident");
    const nameRow = el("div", "col-name-row");
    this.nameNode = el("span", "col-name");
    this.roleNode = el("span", "role-chip");
    nameRow.append(this.nameNode);
    this.subNode = el("div", "col-sub");
    this.relation = el("div", "col-rel");
    ident.append(nameRow, this.subNode, this.relation);
    const tools = el("div", "col-tools");
    this.focusButton = button("icon-btn", "⤢", "Focus on this agent");
    this.focusButton.addEventListener("click", () => this.taskView.setFocus(state.focusId === this.agent.id ? "" : this.agent.id));
    this.messageButton = button("icon-btn", "✉", "Write to this agent");
    this.messageButton.addEventListener("click", () => this.toggleComposer());
    this.openButton = button("icon-btn", "↗", "Open in its app");
    this.openButton.addEventListener("click", () => openAgent(this.agent));
    this.collapseButton = button("icon-btn", "⇤", "Collapse this column");
    this.collapseButton.addEventListener("click", () => this.setCollapsed(true));
    tools.append(this.focusButton, this.messageButton, this.openButton, this.collapseButton);
    head.append(this.goblin, ident, tools);

    this.nowNode = el("div", "col-now");
    this.progressNode = el("div", "col-progress");
    this.liveNode = el("div", "col-live");
    this.liveNode.append(this.nowNode, this.progressNode);
    this.waitNode = el("div", "col-wait");
    this.askNode = el("div", "col-ask");
    this.scroller = el("div", "col-scroll");
    this.scroller.tabIndex = 0;
    this.scroller.setAttribute("aria-label", `${this.agent.name}: conversation`);
    this.olderNode = el("div", "col-older");
    this.list = el("div", "col-list");
    this.list.setAttribute("role", "log");
    this.list.setAttribute("aria-live", "off");
    this.statusNode = el("div", "col-state");
    this.scroller.append(this.olderNode, this.list, this.statusNode);
    this.pill = button("new-pill", "");
    this.pill.hidden = true;
    this.pill.addEventListener("click", () => this.scrollToBottom(true));
    this.composer = el("form", "composer");
    this.composer.hidden = true;
    const area = el("textarea", "composer-text");
    area.rows = 2;
    area.maxLength = 4000;
    area.setAttribute("aria-label", `Message to ${this.agent.name}`);
    area.placeholder = `Message ${this.agent.name}…`;
    const send = button("btn gold small", "Send");
    send.type = "submit";
    const note = el("span", "composer-note");
    const row = el("div", "composer-row");
    row.append(note, send);
    this.composer.append(area, row);
    this.composer.addEventListener("submit", (event) => { event.preventDefault(); this.send(area, send, note); });
    area.addEventListener("keydown", (event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) this.composer.requestSubmit(); });
    const body = el("div", "col-body");
    body.append(head, this.liveNode, this.waitNode, this.askNode, this.scroller, this.pill, this.composer);
    this.resizer = el("div", "col-resize");
    this.resizer.setAttribute("aria-hidden", "true");
    this.resizer.addEventListener("pointerdown", (event) => this.startResize(event));
    node.append(this.rail, body, this.resizer);
    this.scroller.addEventListener("scroll", () => this.onScroll(), { passive: true });
    this.keepBottomOnResize();
    if (prefs.widths[this.agent.id]) node.style.setProperty("--w", `${prefs.widths[this.agent.id]}px`);
    node.classList.toggle("sized", Boolean(prefs.widths[this.agent.id]));
    node.classList.toggle("collapsed", this.collapsed);
  }

  destroy() {
    this.unsubscribe?.();
    this.resizeObserver?.disconnect();
    this.node.remove();
  }

  flash() {
    this.node.classList.remove("flash");
    void this.node.offsetWidth;
    this.node.classList.add("flash");
  }

  setFocused(focused) {
    this.node.classList.toggle("is-focused", focused);
    this.focusButton.textContent = focused ? "⤡" : "⤢";
    this.focusButton.setAttribute("aria-label", focused ? "Show all agents" : "Focus on this agent");
    this.focusButton.title = this.focusButton.getAttribute("aria-label");
    if (focused && this.collapsed) this.setCollapsed(false);
  }

  setCollapsed(collapsed) {
    this.collapsed = collapsed;
    this.node.classList.toggle("collapsed", collapsed);
    if (collapsed) prefs.collapsed[this.agent.id] = true;
    else delete prefs.collapsed[this.agent.id];
    savePrefs();
    if (!collapsed) {
      loadTranscript(this.agent.id);
      requestAnimationFrame(() => { if (this.atBottom) this.scrollToBottom(); });
    }
  }

  startResize(event) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = this.node.getBoundingClientRect().width;
    this.resizer.setPointerCapture(event.pointerId);
    const move = (moveEvent) => {
      const width = Math.max(360, Math.min(1400, Math.round(startWidth + moveEvent.clientX - startX)));
      this.node.style.setProperty("--w", `${width}px`);
      this.node.classList.add("sized");
    };
    const end = () => {
      this.resizer.removeEventListener("pointermove", move);
      prefs.widths[this.agent.id] = Math.round(this.node.getBoundingClientRect().width);
      savePrefs();
    };
    this.resizer.addEventListener("pointermove", move);
    this.resizer.addEventListener("pointerup", end, { once: true });
    this.resizer.addEventListener("dblclick", () => { delete prefs.widths[this.agent.id]; savePrefs(); this.node.classList.remove("sized"); this.node.style.removeProperty("--w"); }, { once: true });
  }

  update(agent) {
    this.agent = agent;
    const task = this.taskView.task;
    const byId = new Map(task.agents.map((item) => [item.id, item]));
    this.node.dataset.role = agent.role;
    this.node.dataset.tone = agent.tone;
    this.node.setAttribute("aria-label", `${agent.name}, ${ROLE_WORDS[agent.role] || SOURCE_WORDS[agent.source]}, ${TONE_WORDS[agent.tone]}`);
    const action = agentAction(agent);
    setGoblinAction(this.goblin, action, `${agent.name}, ${TONE_WORDS[agent.tone].toLowerCase()}`);
    setGoblinAction(this.railGoblin, action, `${agent.name}, ${TONE_WORDS[agent.tone].toLowerCase()}`);
    this.rail.querySelector(".rail-name").textContent = agent.name;
    this.rail.dataset.tone = agent.tone;
    this.nameNode.textContent = agent.name;
    this.nameNode.title = agent.name;
    this.roleNode.textContent = ROLE_WORDS[agent.role] || "";
    this.roleNode.hidden = !ROLE_WORDS[agent.role];
    this.roleNode.dataset.role = agent.role;
    // Role · model · source · status · how long.
    this.subNode.replaceChildren();
    if (ROLE_WORDS[agent.role]) this.subNode.append(this.roleNode);
    const model = modelBadge(agent, { effort: true });
    if (model) this.subNode.append(el("span", `model f-${agent.model?.family || "other"}`, model));
    this.subNode.append(el("span", "src", SOURCE_WORDS[agent.source] || agent.source));
    const status = el("span", `status t-${agent.tone}`);
    status.append(el("span", "dot"), el("span", "", this.statusWords(agent, byId)));
    this.subNode.append(status);
    this.openButton.setAttribute("aria-label", OPEN_WORDS[agent.source] || "Open in its app");
    this.openButton.title = this.openButton.getAttribute("aria-label");
    this.renderRelation(agent, task, byId);
    // Spawn rows link to subagent columns: redraw them when this agent's subagents change.
    const kids = task.agents.filter((item) => item.parentId === agent.id).map((item) => `${item.id}:${item.name}`).join("|");
    if (this.kids !== undefined && kids !== this.kids) {
      const ctx = this.ctx();
      for (const entry of this.store.entries) if (entry.kind === "subagent" && this.nodes.has(entry.id)) this.nodes.set(entry.id, updateEntry(this.nodes.get(entry.id), entry, ctx));
    }
    this.kids = kids;
    this.renderNow(agent);
    this.renderProgress(agent);
    this.liveNode.hidden = this.nowNode.hidden && this.progressNode.hidden;
    this.renderWait(agent, byId);
    this.renderAsk(agent);
  }

  statusWords(agent, byId) {
    if (agent.tone === "needs") return `Needs you${agent.ask?.at ? ` · ${span(agent.ask.at)}` : ""}`;
    if (agent.tone === "waiting") {
      const on = byId.get(agent.waitingOn?.on) || byId.get(agent.parentId);
      return `Waiting on ${on ? (on.role === "coordinator" ? "the coordinator" : on.name) : "another agent"}`;
    }
    if (agent.tone === "working") return `Working${agent.now?.startedAt && !agent.now.done ? ` · ${span(agent.now.startedAt)}` : ""}`;
    return `${TONE_WORDS[agent.tone]}${agent.updatedAt ? ` · ${age(agent.updatedAt)}${age(agent.updatedAt) === "now" || age(agent.updatedAt) === "yesterday" ? "" : " ago"}` : ""}`;
  }

  renderRelation(agent, task, byId) {
    const parent = byId.get(agent.parentId);
    const children = task.agents.filter((item) => item.parentId === agent.id);
    const linkFrom = parent && task.links.find((link) => link.from === parent.id && link.to === agent.id);
    const signature = JSON.stringify([parent?.id, parent?.name, agent.role, linkFrom?.kind, linkFrom?.at && age(linkFrom.at), children.map((child) => [child.id, child.name, child.role])]);
    if (signature === this.relationSignature) return; // Keeps keyboard focus on its links.
    this.relationSignature = signature;
    this.relation.replaceChildren();
    const jump = (target, words) => {
      const link = button("rel-link", words);
      link.addEventListener("click", () => this.taskView.revealAgent(target.id));
      return link;
    };
    // One line: who this agent answers to; for the top agent, whom it leads (the crew strip shows the rest).
    const words = (value) => document.createTextNode(value);
    const plain = [];
    if (parent) {
      const verb = agent.role === "subagent" ? "Subagent of " : agent.role === "coordinator" ? "Driven by " : linkFrom?.kind === "dispatched" ? "Dispatched by " : "Worker of ";
      this.relation.append(words(verb), jump(parent, parent.name));
      plain.push(verb + parent.name);
      if (linkFrom?.at) this.relation.append(words(` · ${age(linkFrom.at)}${age(linkFrom.at) === "now" ? "" : " ago"}`));
    } else if (children.length) {
      const spawned = children.every((child) => child.role === "subagent");
      const verb = spawned ? "Spawned " : "Leads ";
      this.relation.append(words(verb));
      if (children.length <= 2 && children.reduce((sum, child) => sum + child.name.length, 0) <= 44) {
        children.forEach((child, index) => {
          if (index) this.relation.append(words(" and "));
          this.relation.append(jump(child, child.name));
        });
      } else this.relation.append(words(`${children.length} ${spawned ? (children.length === 1 ? "subagent" : "subagents") : children.length === 1 ? "agent" : "agents"}`));
      plain.push(verb + children.map((child) => child.name).join(", "));
    }
    if (children.length && parent) {
      const more = `${children.length} ${children.every((child) => child.role === "subagent") ? "subagents" : "workers"}`;
      this.relation.append(words(` · leads ${more}`));
      plain.push(`leads ${children.map((child) => child.name).join(", ")}`);
    }
    this.relation.title = plain.join(" · ");
    this.relation.hidden = !this.relation.childNodes.length;
  }

  renderNow(agent) {
    const now = agent.now;
    this.nowNode.replaceChildren();
    // A wait on another agent has its own card; an ask has its card too.
    this.nowNode.hidden = !now || Boolean(agent.waitingOn) || Boolean(agent.ask) || (agent.tone !== "working" && !now.done);
    if (this.nowNode.hidden) return;
    this.nowNode.classList.toggle("done", Boolean(now.done));
    const icon = el("span", "now-icon", NOW_ICONS[now.kind] || "•");
    icon.setAttribute("aria-hidden", "true");
    const words = el("span", "now-title", now.done ? `Last: ${now.title}` : now.title);
    this.nowNode.append(icon, words);
    if (now.detail && !now.title.toLowerCase().includes(now.detail.toLowerCase())) this.nowNode.append(el("span", "now-detail", now.detail));
    if (now.startedAt) this.nowNode.append(el("span", "now-time", now.done ? `${age(now.startedAt)} ago` : span(now.startedAt)));
    this.nowNode.title = [now.title, now.detail].filter(Boolean).join("\n");
  }

  renderProgress(agent) {
    const progress = agent.progress;
    this.progressNode.replaceChildren();
    this.progressNode.hidden = !progress;
    if (!progress) return;
    const bar = el("span", "pbar");
    const fill = el("span", "pfill");
    fill.style.width = `${Math.round((progress.done / progress.total) * 100)}%`;
    bar.append(fill);
    this.progressNode.append(el("span", "pcount", `Plan ${progress.done}/${progress.total}`), bar);
    if (progress.current) this.progressNode.append(el("span", "pcurrent", progress.current));
  }

  renderWait(agent, byId) {
    const wait = agent.waitingOn;
    const signature = wait ? JSON.stringify([wait.on, wait.text, wait.at && span(toMsSafe(wait.at)), byId.get(wait.on)?.name]) : "";
    if (signature === this.waitSignature) return;
    this.waitSignature = signature;
    this.waitNode.replaceChildren();
    this.waitNode.hidden = !wait;
    if (!wait) return;
    const on = byId.get(wait.on) || byId.get(agent.parentId);
    const head = el("div", "wait-head");
    head.append(el("span", "wait-icon", "⧗"), el("span", "", `Asked ${on ? (on.role === "coordinator" ? "the coordinator" : on.name) : "another agent"}`));
    if (wait.at) head.append(el("span", "wait-time", `${span(toMsSafe(wait.at))} ago`));
    this.waitNode.append(head);
    if (wait.text) this.waitNode.append(el("p", "wait-text", wait.text));
    if (on) {
      const jump = button("rel-link", `Show ${on.name} ›`);
      jump.addEventListener("click", () => this.taskView.revealAgent(on.id));
      this.waitNode.append(jump);
    }
  }

  renderAsk(agent) {
    const ask = agent.ask;
    const key = ask ? `${ask.key}|${ask.text}` : null;
    if (ask && key === this.askKey) return; // The same ask: keep a half-written reply.
    this.askKey = key;
    this.askNode.replaceChildren();
    this.askNode.hidden = !ask;
    if (!ask) return;
    const card = el("div", "ask-card");
    const approval = ask.kind === "approval" || ask.kind === "permission";
    const head = el("div", "ask-head");
    head.append(el("span", "ask-bell", "!"), el("span", "ask-kind", approval ? "Needs your approval" : ask.kind === "reply" ? "Waiting for your reply" : "Asks you"));
    if (ask.at) head.append(el("span", "ask-time", `${span(ask.at)} ago`));
    card.append(head, el("p", "ask-text", ask.text));
    if (ask.command) {
      const command = el("div", "ask-command");
      command.append(el("pre", "", ask.command), copyButton(ask.command, "Copy command"));
      card.append(command);
    }
    for (const question of ask.questions.length > 1 ? ask.questions : []) card.append(el("p", "ask-question", question.text));
    const options = ask.options.length ? ask.options : ask.questions[0]?.options || [];
    const actions = el("div", "ask-actions");
    const error = el("p", "ask-error");
    error.hidden = true;
    const fail = (message) => { error.textContent = message; error.hidden = false; };
    const busy = (value) => { for (const control of card.querySelectorAll("button, textarea")) control.disabled = value; };
    if (ask.answerHere === "respond" && ask.requestId && approval) {
      for (const [decision, word, style] of [["accept", "Approve once", "btn gold"], ["decline", "Decline", "btn"]]) {
        const choice = button(style, word);
        choice.addEventListener("click", async () => {
          busy(true);
          try {
            await api.respond(agent.id, ask.requestId, { decision });
            toast(decision === "accept" ? "Approved. Codex carries on." : "Declined. Codex was told no.");
            this.askKey = "";
            refreshTasks(true);
          } catch (cause) { fail(cause.message); busy(false); }
        });
        actions.append(choice);
      }
    } else if (ask.answerHere === "respond" && ask.requestId) {
      this.questionForm(card, agent, ask, fail, busy);
    } else if (options.length) {
      const chips = el("div", "ask-options");
      for (const option of options) chips.append(el("span", "option-chip", option));
      card.append(chips);
    }
    if (ask.answerHere === "reply" || ask.answerHere === "orca-send") {
      const area = el("textarea", "ask-reply");
      area.rows = 2;
      area.maxLength = 4000;
      area.placeholder = ask.answerHere === "orca-send" ? "Type the answer into its terminal…" : "Reply…";
      area.setAttribute("aria-label", "Your reply");
      const send = button("btn gold", "Send reply");
      send.addEventListener("click", async () => {
        const words = area.value.trim();
        if (!words) { area.focus(); return; }
        busy(true);
        try { await api.message(agent.id, words); area.value = ""; toast("Sent."); refreshTasks(true); } catch (cause) { fail(cause.message); }
        busy(false);
      });
      card.append(area);
      actions.append(send);
    }
    const open = button("btn ghost", OPEN_WORDS[agent.source] || "Open in its app");
    open.addEventListener("click", () => openAgent(agent));
    const dismiss = button("btn ghost", "Dismiss");
    dismiss.title = "Hide this alert until the agent asks something new";
    dismiss.addEventListener("click", async () => {
      busy(true);
      try {
        await api.dismiss(agent.id, ask.key);
        dismissedAsks.add(`${agent.id}:${ask.key}`);
        this.askKey = "";
        refreshTasks(true);
      } catch (cause) { fail(cause.message); busy(false); }
    });
    actions.append(open, dismiss);
    card.append(actions, error);
    this.askNode.append(card);
  }

  /** Codex's own questions: the request's question ids come from /api/requests. */
  async questionForm(card, agent, ask, fail, busy) {
    const form = el("form", "ask-form");
    card.append(form);
    let request = null;
    try { request = (await api.requests(agent.id)).find((item) => String(item.id) === String(ask.requestId)); } catch (cause) { fail(cause.message); return; }
    const questions = request?.params?.questions || [];
    if (!questions.length) { fail("This question can't be answered here. Open it in Codex."); return; }
    for (const question of questions) {
      const label = el("label", "ask-question", question.question || question.header || "Answer");
      const field = (question.options || []).length ? el("select") : el("input");
      field.dataset.questionId = question.id;
      if (field.tagName === "SELECT") for (const option of question.options) { const choice = el("option", "", option.label); choice.value = option.label; field.append(choice); }
      else { field.type = question.isSecret ? "password" : "text"; field.maxLength = 2000; field.required = true; }
      label.append(field);
      form.append(label);
    }
    const submit = button("btn gold", "Send answer");
    submit.type = "submit";
    form.append(submit);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const answers = {};
      for (const field of form.querySelectorAll("[data-question-id]")) answers[field.dataset.questionId] = field.value;
      busy(true);
      try { await api.respond(agent.id, ask.requestId, { answers }); this.askKey = ""; refreshTasks(true); } catch (cause) { fail(cause.message); busy(false); }
    });
  }

  toggleComposer() {
    this.composer.hidden = !this.composer.hidden;
    this.messageButton.setAttribute("aria-pressed", String(!this.composer.hidden));
    if (!this.composer.hidden) this.composer.querySelector("textarea").focus();
  }

  async send(area, send, note) {
    const words = area.value.trim();
    if (!words) return;
    send.disabled = true;
    note.textContent = "Sending…";
    note.dataset.tone = "";
    try {
      await api.message(this.agent.id, words);
      area.value = "";
      note.textContent = "Sent.";
      loadTranscript(this.agent.id);
    } catch (error) {
      note.textContent = error.message;
      note.dataset.tone = "bad";
    }
    send.disabled = false;
  }

  // ---- The transcript ----

  ctx() {
    return entryContext(this.agent);
  }

  showLoading() {
    this.statusNode.replaceChildren(el("div", "skeleton"), el("div", "skeleton short"), el("div", "skeleton"));
    this.statusNode.dataset.kind = "loading";
  }

  renderAll() {
    this.list.replaceChildren();
    this.nodes.clear();
    const ctx = this.ctx();
    const fragment = document.createDocumentFragment();
    for (const entry of this.store.entries) {
      const node = renderEntry(entry, ctx);
      this.nodes.set(entry.id, node);
      fragment.append(node);
    }
    this.list.append(fragment);
    this.renderState();
    requestAnimationFrame(() => this.scrollToBottom());
  }

  renderState() {
    this.statusNode.replaceChildren();
    this.statusNode.dataset.kind = "";
    const store = this.store;
    if (store.error) {
      this.statusNode.dataset.kind = "error";
      const card = el("div", "state-card bad");
      card.append(el("strong", "", store.entries.length ? "Couldn't refresh this conversation" : "Couldn't read this conversation"), el("p", "", store.error));
      const retry = button("btn small", "Try again");
      retry.addEventListener("click", () => { store.error = ""; this.renderState(); loadTranscript(this.agent.id); });
      card.append(retry);
      this.statusNode.append(card);
    } else if (store.loaded && !store.entries.length) {
      this.statusNode.dataset.kind = "empty";
      const card = el("div", "state-card");
      card.append(el("strong", "", "Nothing here yet"), el("p", "", this.agent.tone === "working" ? "The agent has started; its first steps appear here as they happen." : "No messages or steps were recorded for this agent."));
      this.statusNode.append(card);
    }
    this.olderNode.replaceChildren();
    if (store.loaded && store.entries.length) {
      if (store.hasOlder) {
        const older = button("older-btn", "Load earlier messages");
        older.addEventListener("click", () => this.loadOlder());
        this.olderNode.append(older);
      } else this.olderNode.append(el("span", "older-start", "Start of the conversation"));
    }
  }

  onChange(change) {
    if (change.error) { this.renderState(); return; }
    if (change.reset || (!this.nodes.size && change.added.length && !change.prepended.length)) {
      if (change.reset || !this.list.children.length) { this.renderAll(); return; }
    }
    const ctx = this.ctx();
    const wasAtBottom = this.atBottom;
    if (change.prepended.length) {
      const before = this.scroller.scrollHeight;
      const top = this.scroller.scrollTop;
      const fragment = document.createDocumentFragment();
      for (const entry of change.prepended) {
        const node = renderEntry(entry, ctx);
        this.nodes.set(entry.id, node);
        fragment.append(node);
      }
      this.list.prepend(fragment);
      this.scroller.scrollTop = top + (this.scroller.scrollHeight - before);
    }
    for (const entry of change.changed) {
      const node = this.nodes.get(entry.id);
      if (node) this.nodes.set(entry.id, updateEntry(node, entry, ctx));
    }
    if (change.added.length) {
      const fragment = document.createDocumentFragment();
      for (const entry of change.added) {
        const node = renderEntry(entry, ctx);
        this.nodes.set(entry.id, node);
        fragment.append(node);
      }
      this.list.append(fragment);
      if (!wasAtBottom) {
        this.unseen += change.added.length;
        this.pill.textContent = `${this.unseen} new ↓`;
        this.pill.hidden = false;
      }
    }
    if (change.dropped) for (const [id, node] of this.nodes) if (!this.store.byId.has(id)) { node.remove(); this.nodes.delete(id); }
    this.renderState();
    if (wasAtBottom && (change.added.length || change.changed.length)) this.scrollToBottom();
  }

  onScroll() {
    const { scrollTop, scrollHeight, clientHeight } = this.scroller;
    this.atBottom = scrollHeight - scrollTop - clientHeight < 48;
    if (this.atBottom && this.unseen) { this.unseen = 0; this.pill.hidden = true; }
    if (scrollTop < 160 && this.store.hasOlder && !this.loadingOlder && this.store.loaded) this.loadOlder();
  }

  async loadOlder() {
    if (this.loadingOlder) return;
    this.loadingOlder = true;
    this.olderNode.replaceChildren(el("span", "older-start", "Loading earlier messages…"));
    await loadTranscript(this.agent.id, "older");
    this.loadingOlder = false;
    this.renderState();
  }

  scrollToBottom(smooth = false) {
    this.scroller.scrollTo({ top: this.scroller.scrollHeight, behavior: smooth && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto" });
    this.atBottom = true;
    this.unseen = 0;
    this.pill.hidden = true;
  }

  /** Hidden elements lose their scroll position: remember it on the way out, restore it on the way back. */
  setShown(shown) {
    if (this.shown !== false && !shown) this.saved = { top: this.scroller.scrollTop, bottom: this.atBottom };
    if (this.shown === false && shown) this.restorePending = true;
    this.shown = shown;
  }

  restoreScroll() {
    if (this.restorePending && this.saved) {
      this.restorePending = false;
      if (this.saved.bottom) this.scrollToBottom();
      else this.scroller.scrollTop = this.saved.top;
    } else if (this.shown !== false && this.atBottom) this.scrollToBottom();
  }

  /** A view that was following the newest entry keeps following it when its size changes. */
  keepBottomOnResize() {
    this.resizeObserver = new ResizeObserver(() => { if (this.atBottom && this.scroller.clientHeight) this.scrollToBottom(); });
    this.resizeObserver.observe(this.scroller);
  }
}

const toMsSafe = (value) => (Number(value) < 1e12 ? Number(value) * 1000 : Number(value));

// ---- Timeline: every agent's entries interleaved by time ----

class TimelineView {
  constructor(task) {
    this.task = task;
    this.node = el("div", "timeline");
    this.scroller = el("div", "tl-scroll");
    this.scroller.tabIndex = 0;
    this.scroller.setAttribute("aria-label", "Timeline of every agent in this task");
    this.list = el("div", "tl-list");
    this.list.setAttribute("role", "log");
    this.olderNode = el("div", "col-older");
    this.scroller.append(this.olderNode, this.list);
    this.pill = button("new-pill", "");
    this.pill.hidden = true;
    this.pill.addEventListener("click", () => this.scrollToBottom(true));
    this.node.append(this.scroller, this.pill);
    this.keepBottomOnResize();
    this.items = []; // { key, at, agentId, node }
    this.byKey = new Map();
    this.unsubscribers = new Map();
    this.atBottom = true;
    this.unseen = 0;
    this.scroller.addEventListener("scroll", () => {
      const { scrollTop, scrollHeight, clientHeight } = this.scroller;
      this.atBottom = scrollHeight - scrollTop - clientHeight < 48;
      if (this.atBottom && this.unseen) { this.unseen = 0; this.pill.hidden = true; }
      if (scrollTop < 160) this.loadOlder();
    }, { passive: true });
  }

  mount() {
    this.updateAgents(this.task);
    requestAnimationFrame(() => this.scrollToBottom());
  }

  destroy() {
    for (const off of this.unsubscribers.values()) off();
    this.resizeObserver?.disconnect();
    this.node.remove();
  }

  agent(id) {
    return this.task.agents.find((agent) => agent.id === id);
  }

  updateAgents(task) {
    this.task = task;
    for (const agent of task.agents) {
      if (this.unsubscribers.has(agent.id)) continue;
      const store = storeFor(agent.id);
      this.unsubscribers.set(agent.id, store.subscribe((change) => this.onChange(agent.id, store, change)));
      if (store.loaded) this.insertMany(agent.id, store, store.entries);
    }
    this.insertLinks(task);
    this.renderOlder();
  }

  /** Who started, dispatched, or asked whom, at the moment it happened: the hand-offs between columns. */
  insertLinks(task) {
    const byId = new Map(task.agents.map((agent) => [agent.id, agent]));
    const verbs = { drives: "started driving", dispatched: "handed work to", spawned: "started subagent", asked: "asked" };
    for (const link of task.links) {
      if (!link.at) continue;
      const key = `link|${link.from}|${link.to}|${link.kind}|${link.at}`;
      if (this.byKey.has(key)) continue;
      const from = byId.get(link.from);
      const to = byId.get(link.to);
      if (!from || !to) continue;
      const node = el("div", "tl-item tl-link");
      node.dataset.role = from.role;
      const stamp = el("div", "tl-badge-plain");
      stamp.append(el("span", "tl-time", clockTime(link.at)));
      const row = el("div", `e e-link k-${link.kind}`);
      const name = (agent) => {
        const jump = button("rel-link", agent.name);
        jump.addEventListener("click", () => taskView?.revealAgent(agent.id));
        return jump;
      };
      row.append(el("span", "link-icon", link.kind === "asked" ? "?" : "→"), name(from), document.createTextNode(` ${verbs[link.kind] || "linked"} `), name(to));
      node.append(stamp, row);
      this.place({ key, at: link.at, agentId: `link:${link.from}`, node, entryId: key });
    }
  }

  /** Put a prepared item in time order. */
  place(item) {
    const position = insertionIndex(this.items.map((each) => each.at), item.at);
    this.items.splice(position, 0, item);
    this.byKey.set(item.key, item);
    this.list.insertBefore(item.node, this.items[position + 1]?.node || null);
    this.markRuns(position);
    return position === this.items.length - 1;
  }

  timeOf(store, entry) {
    if (entry.at) return entry.at;
    const index = store.entries.indexOf(entry);
    const times = effectiveTimes(store.entries.slice(0, index + 1));
    return times.at(-1) || 0;
  }

  insertMany(agentId, store, entries) {
    const times = effectiveTimes(store.entries);
    const index = new Map(store.entries.map((entry, position) => [entry.id, position]));
    let appended = 0;
    for (const entry of entries) {
      const at = times[index.get(entry.id)] ?? this.timeOf(store, entry);
      if (this.insert(agentId, entry, at)) appended++;
    }
    return appended;
  }

  /** Put one entry in time order; true when it went at the end. */
  insert(agentId, entry, at) {
    const key = `${agentId}|${entry.id}`;
    if (this.byKey.has(key)) return false;
    const agent = this.agent(agentId);
    const node = el("div", "tl-item");
    node.dataset.agent = agentId;
    node.dataset.role = agent?.role || "";
    const badge = button("tl-badge", "", `Show ${agent?.name || "this agent"}'s column`);
    badge.append(el("span", "tl-dot"), el("span", "tl-name", agent?.name || agentId));
    if (agent && ROLE_WORDS[agent.role]) badge.append(el("span", "tl-role", ROLE_WORDS[agent.role]));
    if (entry.at) badge.append(el("span", "tl-time", clockTime(entry.at)));
    badge.addEventListener("click", () => taskView?.revealAgent(agentId));
    const content = renderEntry(entry, entryContext(agent || { id: agentId }));
    node.append(badge, content);
    return this.place({ key, at, agentId, node, entryId: entry.id });
  }

  /** Consecutive entries of one agent share one badge. */
  markRuns(position) {
    for (const index of [position, position + 1]) {
      const item = this.items[index];
      if (!item) continue;
      item.node.classList.toggle("same", this.items[index - 1]?.agentId === item.agentId);
    }
  }

  onChange(agentId, store, change) {
    if (change.error) return;
    const wasAtBottom = this.atBottom;
    if (change.reset) {
      for (const item of [...this.items]) if (item.agentId === agentId) this.remove(item);
      this.insertMany(agentId, store, store.entries);
    } else {
      let appended = this.insertMany(agentId, store, [...change.prepended, ...change.added]);
      for (const entry of change.changed) {
        const item = this.byKey.get(`${agentId}|${entry.id}`);
        if (!item) continue;
        const content = item.node.querySelector(":scope > .e");
        if (content) updateEntry(content, entry, entryContext(this.agent(agentId) || { id: agentId }));
      }
      if (!wasAtBottom && appended) {
        this.unseen += appended;
        this.pill.textContent = `${this.unseen} new ↓`;
        this.pill.hidden = false;
      }
      appended = 0;
    }
    this.renderOlder();
    if (wasAtBottom) this.scrollToBottom();
  }

  remove(item) {
    item.node.remove();
    this.byKey.delete(item.key);
    this.items.splice(this.items.indexOf(item), 1);
  }

  renderOlder() {
    this.olderNode.replaceChildren();
    const older = this.task.agents.some((agent) => storeFor(agent.id).hasOlder);
    if (older) {
      const more = button("older-btn", "Load earlier messages");
      more.addEventListener("click", () => this.loadOlder());
      this.olderNode.append(more);
    } else if (this.items.length) this.olderNode.append(el("span", "older-start", "Start of every conversation in this task"));
    else this.olderNode.append(el("span", "older-start", "Loading every agent's conversation…"));
  }

  async loadOlder() {
    if (this.loading) return;
    const ids = this.task.agents.map((agent) => agent.id).filter((id) => storeFor(id).hasOlder);
    if (!ids.length) return;
    this.loading = true;
    const before = this.scroller.scrollHeight;
    const top = this.scroller.scrollTop;
    await Promise.all(ids.map((id) => loadTranscript(id, "older")));
    this.scroller.scrollTop = top + (this.scroller.scrollHeight - before);
    this.loading = false;
  }

  scrollToBottom(smooth = false) {
    this.scroller.scrollTo({ top: this.scroller.scrollHeight, behavior: smooth && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto" });
    this.atBottom = true;
    this.unseen = 0;
    this.pill.hidden = true;
  }

  setShown(shown) { ColumnView.prototype.setShown.call(this, shown); }

  restoreScroll() { ColumnView.prototype.restoreScroll.call(this); }

  keepBottomOnResize() { ColumnView.prototype.keepBottomOnResize.call(this); }
}

// ---- Wiring ----

function bindChrome() {
  const side = document.getElementById("side");
  const toggle = document.getElementById("side-toggle");
  const applySide = () => {
    side.classList.toggle("collapsed", !prefs.sidebar);
    document.body.classList.toggle("side-collapsed", !prefs.sidebar);
    toggle.setAttribute("aria-expanded", String(prefs.sidebar));
    toggle.setAttribute("aria-label", prefs.sidebar ? "Collapse the task list" : "Expand the task list");
    toggle.title = toggle.getAttribute("aria-label");
    toggle.textContent = prefs.sidebar ? "⟨" : "⟩";
  };
  toggle.addEventListener("click", () => { prefs.sidebar = !prefs.sidebar; savePrefs(); applySide(); });
  applySide();
  const search = document.getElementById("search");
  search.addEventListener("input", () => { state.query = search.value.trim(); renderSidebar(); });
  for (const choice of document.querySelectorAll("[data-window]")) {
    choice.addEventListener("click", () => {
      state.windowHours = Number(choice.dataset.window);
      prefs.window = state.windowHours;
      savePrefs();
      refreshTasks(true);
    });
  }
  // ↑/↓ move between tasks, Enter opens; "/" jumps to search.
  const list = document.getElementById("task-list");
  list.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const all = [...list.querySelectorAll(".task-card")];
    const index = all.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? all.length - 1 : Math.max(0, Math.min(all.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
    all[next]?.focus();
    event.preventDefault();
  });
  document.addEventListener("keydown", (event) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
    if (event.key === "/" && !typing) { event.preventDefault(); if (!prefs.sidebar) toggle.click(); search.focus(); }
    if (event.key === "Escape" && !typing && state.focusId) taskView?.setFocus("");
  });
  window.addEventListener("hashchange", () => {
    const next = readHash();
    if (next.task && next.task !== state.taskId) { state.taskId = next.task; state.focusId = next.focus; state.view = next.view; resolveSelection(); renderSidebar(); renderMain(); }
    else if (next.focus !== state.focusId || next.view !== state.view) { state.focusId = next.focus; state.view = next.view; taskView?.applyLayout(); }
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { refreshTasks(); pollTranscripts(); } });
  window.addEventListener("resize", () => taskView?.markCrewOverflow());
  if (api.demo) document.getElementById("demo-badge").hidden = false;
  const brand = document.getElementById("brand-goblin");
  brand.append(createGoblin("goblin-horde-brand", "idle", { size: 1, tribe: "raider", label: "Goblin Horde" }));
}

/** Time labels refresh on their own between polls. */
function tick() {
  for (const entry of cards.values()) {
    const ageNode = entry.node.querySelector(".tc-age");
    ageNode.textContent = age(entry.task.updatedAt);
  }
}

async function main() {
  const demoModule = start.demo ? await import("./demo-data.js") : null;
  api = createClient({ demo: demoModule ? demoModule.createDemo() : null });
  bindChrome();
  loadArt().catch(() => document.body.classList.add("no-art"));
  renderSidebar();
  renderMain();
  await refreshTasks();
  setInterval(refreshTasks, TASK_POLL_MS);
  setInterval(pollTranscripts, TRANSCRIPT_POLL_MS);
  setInterval(tick, 15_000);
}

main();
