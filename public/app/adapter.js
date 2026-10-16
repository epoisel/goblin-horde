/**
 * The one place the task view meets the server: endpoint addresses, request bodies, and the
 * normalising of `/api/tasks` and `/api/transcript` answers into the exact shapes the rest of the app
 * reads (SPEC2). Everything is tolerant: a missing field gets a sensible default, alternative names
 * the sources already use (`detail` for `say`, `items` for `entries`, seconds for milliseconds,
 * snake_case, Codex item types, Claude record types) are accepted, and nothing here throws on odd
 * input. Integrating with the real server should only ever touch this file.
 *
 * Pure (no DOM), so node tests import it directly; `createClient` takes `fetch` from its caller.
 */
import { eventAction } from "../party.js";

// ---- Endpoints: the only addresses the app calls. ----

/** The window as the server reads it: "4h", "24h", "7d". */
export const windowParam = (hours) => (hours > 24 && hours % 24 === 0 ? `${hours / 24}d` : `${hours}h`);

export const ENDPOINTS = Object.freeze({
  tasks: (hours) => `/api/tasks?window=${encodeURIComponent(windowParam(hours))}`,
  transcript: (id, { after = "", before = "", limit = 0, screen = false } = {}) => {
    const query = new URLSearchParams({ id });
    if (after) query.set("after", after);
    if (before) query.set("before", before);
    if (limit) query.set("limit", String(limit));
    if (screen) query.set("screen", "1");
    return `/api/transcript?${query}`;
  },
  requests: (threadId) => `/api/requests?id=${encodeURIComponent(threadId)}`,
  respond: "/api/respond",
  message: "/api/message",
  dismiss: "/api/dismiss",
  open: "/api/open",
  join: "/api/join",
  appOpen: "/api/app/open",
});

// ---- Small value helpers. ----

const text = (value) => (typeof value === "string" ? value : value == null ? "" : typeof value === "number" || typeof value === "boolean" ? String(value) : "");
const lower = (value) => text(value).toLowerCase();
const list = (value) => (Array.isArray(value) ? value : []);
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : null);
const first = (...values) => values.find((value) => value !== undefined && value !== null && value !== "");
const number = (value) => {
  const result = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof result === "number" && Number.isFinite(result) ? result : null;
};

/** A time in milliseconds from milliseconds, seconds, or an ISO string; null when there is none. */
export function toMs(value) {
  if (value == null || value === "") return null;
  if (typeof value === "string" && !/^\d+(\.\d+)?$/.test(value.trim())) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const stamp = number(value);
  if (stamp == null || stamp <= 0) return null;
  return stamp < 1e12 ? Math.round(stamp * 1000) : stamp;
}

/** FNV-1a, for ids of entries that arrive without one. */
export function hashText(value) {
  let hash = 2166136261;
  const source = String(value);
  for (let index = 0; index < source.length; index++) hash = Math.imul(hash ^ source.charCodeAt(index), 16777619) >>> 0;
  return hash.toString(36);
}

/** Terminal colour and cursor codes removed: test runners colour their output, the page shows text. */
export function stripAnsi(value) {
  // eslint-disable-next-line no-control-regex
  return String(value ?? "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b[()][A-Za-z0-9]/g, "");
}

/** Any value as display text: strings as they are, lists joined by lines, objects as pretty JSON. */
export function asText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value.join("\n");
  if (Array.isArray(value) && value.every((item) => object(item) && typeof item.text === "string")) return value.map((item) => item.text).join("\n");
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

// ---- Sources. ----

const SOURCE_STATES = {
  ok: "ok", ready: "ok", connected: "ok", installed: "ok",
  partial: "partial", starting: "partial", restarting: "partial", "not-connected": "partial", disabled: "partial", broken: "partial", stale: "partial",
  unavailable: "unavailable", unreadable: "unavailable", error: "unavailable", down: "unavailable", failed: "unavailable",
  "not-installed": "not-installed", missing: "not-installed", none: "not-installed", absent: "not-installed",
};
export const SOURCE_NAMES = { codex: "Codex", claude: "Claude Code", orca: "Orca", extensions: "Extensions", extension: "Extensions" };
const SOURCE_SAY = { ok: "Reading it.", partial: "Partly available.", unavailable: "Can't be read right now.", "not-installed": "Not installed on this computer." };

/** One source's health as { key, name, state: ok | partial | unavailable | not-installed, say }. */
export function normalizeSource(key, value) {
  const raw = object(value) || { state: text(value) };
  const state = SOURCE_STATES[lower(raw.state || raw.status)] || (raw.ok === true ? "ok" : raw.ok === false ? "unavailable" : "partial");
  const say = text(first(raw.say, raw.detail, raw.message, raw.note)) || SOURCE_SAY[state];
  return { key, name: SOURCE_NAMES[key] || text(raw.name) || key, state, say };
}

// A source only partly read (Codex still listing its chats after a start) says so only when that
// lasts: a few seconds of it is normal, and a warning that comes and goes is noise.
export const PARTIAL_GRACE_MS = 10_000;

/**
 * The state a source's chip shows: "partial" only once it has lasted PARTIAL_GRACE_MS, "ok" before.
 * `since` (Map: source key → first seen partial) is the caller's memory between polls.
 */
export function shownSourceState(source, since, now = Date.now()) {
  if (source.state !== "partial") { since.delete(source.key); return source.state; }
  if (!since.has(source.key)) since.set(source.key, now);
  return now - since.get(source.key) > PARTIAL_GRACE_MS ? "partial" : "ok";
}

// ---- Agents and tasks. ----

const ROLES = new Set(["lead", "coordinator", "worker", "subagent", "solo"]);
const ROLE_ALIASES = { orchestrator: "coordinator", leader: "lead", driver: "lead", parent: "lead", helper: "worker", child: "subagent", sub: "subagent", "sub-agent": "subagent", agent: "worker" };
const SOURCES = new Set(["codex", "claude", "orca", "extension"]);

/** codex | claude | orca | extension, from the field or the id's prefix. */
export function sourceOf(raw = {}) {
  const named = lower(raw.source);
  if (SOURCES.has(named)) return named;
  const id = text(raw.id);
  if (id.startsWith("orca")) return "orca";
  if (id.startsWith("claude")) return "claude";
  if (id.startsWith("ext")) return "extension";
  return named === "claude-code" ? "claude" : "codex";
}

function normalizeModel(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const id = value.trim();
    const family = /claude|opus|sonnet|haiku|fable/i.test(id) ? "claude" : /gpt|^o\d|codex/i.test(id) ? "openai" : "other";
    return id ? { id, label: id, family } : null;
  }
  const raw = object(value);
  if (!raw) return null;
  const label = text(first(raw.label, raw.name, raw.id));
  if (!label) return null;
  return { id: text(raw.id) || label, label, family: ["claude", "openai"].includes(raw.family) ? raw.family : normalizeModel(label).family, ...(raw.effort ? { effort: text(raw.effort) } : {}) };
}

function normalizeAsk(value) {
  const raw = object(value);
  if (!raw) return null;
  const words = text(first(raw.text, raw.question, raw.message, raw.title));
  if (!words) return null;
  return {
    kind: text(raw.kind) || "question",
    text: words,
    command: text(raw.command),
    tool: text(raw.tool),
    options: list(raw.options).map((option) => text(typeof option === "string" ? option : first(option?.label, option?.text))).filter(Boolean),
    questions: list(raw.questions).map((question) => ({ id: text(question?.id), text: text(first(question?.text, question?.question)),
      options: list(question?.options).map((option) => text(typeof option === "string" ? option : first(option?.label, option?.text))).filter(Boolean) }))
      .filter((question) => question.text),
    at: toMs(raw.at) || 0,
    answerHere: text(raw.answerHere) || null,
    requestId: raw.requestId != null ? text(raw.requestId) : "",
    key: text(raw.key),
  };
}

function normalizeNow(value) {
  const raw = object(value);
  if (!raw) return typeof value === "string" && value ? { kind: "tool", title: value, detail: "", startedAt: 0, done: false } : null;
  const title = text(first(raw.title, raw.text));
  if (!title) return null;
  return { kind: text(raw.kind) || "tool", title, detail: text(raw.detail), startedAt: toMs(raw.startedAt) || 0, done: Boolean(raw.done) };
}

function normalizeProgress(value) {
  const raw = object(value);
  if (!raw) return null;
  const total = number(raw.total);
  if (!total) return null;
  return { done: Math.max(0, Math.min(total, number(raw.done) || 0)), total, current: text(raw.current) };
}

/**
 * An agent's tone for colour and grouping: needs (asks you), failed, waiting (on another agent),
 * working, done, or idle.
 */
export function agentTone(agent = {}) {
  const status = lower(agent.status).replace(/[\s_-]+/g, "");
  const attention = lower(agent.attention);
  const quiet = attention === "quiet";
  if ((agent.ask && !agent.askDismissed) || agent.needsInput || status === "waiting" || status === "needs" || status === "needsyou") return "needs";
  if (!quiet && (status === "failed" || status === "error" || attention === "failed")) return "failed";
  if (agent.waitingOn) return "waiting";
  if (["working", "running", "inprogress", "active", "busy", "thinking"].includes(status) || attention === "working") return "working";
  if (["done", "completed", "complete", "finished", "succeeded"].includes(status)) return "done";
  return "idle";
}

/** The goblin's action for an agent: the same six actions as the desktop widget. */
export function agentAction(agent = {}) {
  const tone = agentTone(agent);
  if (tone === "needs") return "waiting";
  if (tone === "failed") return "trouble";
  if (tone === "waiting") return "think";
  if (tone !== "working") return "idle";
  const now = agent.now;
  if (!now || now.done) return "think";
  if (["read", "search", "web"].includes(now.kind)) return "search";
  if (["edit", "write"].includes(now.kind)) return "build";
  if (now.kind === "command") return eventAction({ kind: "command", title: now.title, detail: now.detail });
  return "think";
}

/** One agent of a task, every field present (see the top of app.js for the shape). */
export function normalizeAgent(raw, index = 0) {
  const value = object(raw) || {};
  const id = text(first(value.id, value.agentId, value.threadId)) || `agent-${index}`;
  const roleWord = lower(value.role).split(/[\s·]+/)[0];
  const role = ROLES.has(roleWord) ? roleWord : ROLE_ALIASES[roleWord] || "";
  const agent = {
    id,
    source: sourceOf({ ...value, id }),
    name: text(first(value.name, value.nickname, value.title, value.label)) || "Unnamed agent",
    model: normalizeModel(value.model),
    role,
    parentId: text(first(value.parentId, value.parent, value.parentAgentId)) || null,
    depth: Math.max(0, number(value.depth) ?? 0),
    status: text(value.status) || "idle",
    attention: text(value.attention),
    ask: normalizeAsk(value.ask),
    waitingOn: object(value.waitingOn) ? { ...value.waitingOn, text: text(first(value.waitingOn.text, value.waitingOn.question)), on: text(first(value.waitingOn.on, value.waitingOn.agentId, value.waitingOn.to)) } : null,
    now: normalizeNow(value.now),
    progress: normalizeProgress(value.progress),
    updatedAt: toMs(value.updatedAt) || 0,
    startedAt: toMs(first(value.startedAt, value.createdAt)) || 0,
    cwd: text(value.cwd),
    project: text(value.project) || projectOf(value.cwd),
    terminal: text(first(value.terminal, value.orca?.terminal)),
    seenBy: text(value.seenBy),
    needsInput: Boolean(value.needsInput),
    stale: value.stale === true, // The server's word: a subagent that finished over an hour ago.
  };
  agent.tone = agentTone(agent);
  return agent;
}

const TASK_STATUSES = new Set(["needs", "working", "failed", "idle", "done"]);

/** Roles when the server sent none: the first agent leads; children of a lead coordinate or work. */
function fillRoles(agents) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  for (const agent of agents) {
    if (agent.parentId && !byId.has(agent.parentId)) agent.parentId = null;
  }
  const depthOf = (agent, seen = new Set()) => {
    if (!agent.parentId || seen.has(agent.id)) return 0;
    seen.add(agent.id);
    return 1 + depthOf(byId.get(agent.parentId), seen);
  };
  // A Claude Code subagent ("claude-agent:session:agent") or a chat Codex spawned helps its parent.
  const helps = (agent, parent) => (agent.source === "claude" && agent.id.split(":").length > 2) || (agent.source === "codex" && parent?.source === "codex");
  const parents = new Set(agents.map((agent) => agent.parentId).filter(Boolean));
  // Coordinators hand work to other agents; an agent whose only children are its subagents is not one.
  const coordinators = new Set(agents.filter((agent) => agent.parentId && !helps(agent, byId.get(agent.parentId))).map((agent) => agent.parentId));
  const roots = agents.filter((agent) => !agent.parentId);
  // The top agent leads: the root with helpers, else the first root.
  const lead = roots.find((agent) => parents.has(agent.id)) || roots[0];
  for (const agent of agents) {
    if (!agent.depth) agent.depth = depthOf(agent);
    if (agent.role) continue;
    const parent = byId.get(agent.parentId);
    if (agents.length === 1) agent.role = "solo";
    else if (!parent) agent.role = agent === lead ? "lead" : "worker";
    else if (helps(agent, parent)) agent.role = "subagent";
    else if (coordinators.has(agent.id)) agent.role = "coordinator";
    else agent.role = "worker";
  }
  return agents;
}

const ROLE_ORDER = { lead: 0, solo: 0, coordinator: 1, worker: 2, subagent: 3 };

/** Agents in tree order: lead, coordinator, workers, then subagents, each after its parent's group. */
export function orderAgents(agents) {
  const byParent = new Map();
  for (const agent of agents) {
    const key = agent.parentId || "";
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(agent);
  }
  const rank = (agent) => ROLE_ORDER[agent.role] ?? 2;
  const result = [];
  const seen = new Set();
  const walk = (parent) => {
    const children = [...(byParent.get(parent) || [])].sort((a, b) => rank(a) - rank(b));
    const later = [];
    for (const child of children) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      result.push(child);
      later.push(child);
    }
    // Children of coordinators and workers follow their whole level, so workers sit side by side.
    for (const child of later) walk(child.id);
  };
  walk("");
  for (const agent of agents) if (!seen.has(agent.id)) result.push(agent);
  return result;
}

// A finished subagent this long ago is history: its column waits at the end, folded.
export const STALE_MS = 60 * 60_000;
// An agent that did something this recently still counts as active, so a session idling between
// turns does not jump to the back and forth on every poll.
const ACTIVE_MS = 2 * 60_000;

/**
 * An agent whose part ended a while ago: the server says so (`stale`: a worker, coordinator, or subagent
 * quiet for an hour), or, for a subagent, it is done or idle and quiet for an hour.
 */
export function isStale(agent, now = Date.now()) {
  if (agent.stale) return true;
  if (agent.role !== "subagent") return false;
  return (agent.tone === "done" || agent.tone === "idle") && Boolean(agent.updatedAt) && now - agent.updatedAt > STALE_MS;
}

/** A subagent whose work is over: its column starts folded to the goblin rail (the person can open it). */
export function isFinishedSubagent(agent, now = Date.now()) {
  return agent.role === "subagent" && (isStale(agent, now) || agent.tone === "done" || agent.tone === "idle");
}

/** Whether a column starts folded unless the person chose otherwise: a finished subagent, or any agent gone stale. */
export function foldsByDefault(agent, now = Date.now()) {
  return isFinishedSubagent(agent, now) || isStale(agent, now);
}

/**
 * Columns in the order the person reads a task: lead, coordinator, workers, then subagents; within
 * workers and within subagents the ones at work first; finished subagents of long ago last. Ties keep
 * the tree order (so a parent's helpers stay together). Pure.
 */
export function columnOrder(agents, now = Date.now()) {
  const busy = (agent) => (["working", "waiting", "needs"].includes(agent.tone) || (agent.updatedAt && now - agent.updatedAt < ACTIVE_MS && agent.tone !== "done") ? 0
    : agent.tone === "failed" ? 1 : 2);
  return agents.map((agent, index) => ({ agent, index, key: [isStale(agent, now) ? 1 : 0, ROLE_ORDER[agent.role] ?? 2, agent.role === "lead" || agent.role === "solo" ? 0 : busy(agent)] }))
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2] || a.index - b.index)
    .map((item) => item.agent);
}

/** A task's status from its agents when the server sent none. */
export function taskTone(agents) {
  const tones = agents.map((agent) => agent.tone);
  if (tones.includes("needs")) return "needs";
  if (tones.includes("failed")) return "failed";
  if (tones.includes("working") || tones.includes("waiting")) return "working";
  if (tones.length && tones.every((tone) => tone === "done")) return "done";
  return "idle";
}

const LINK_KINDS = new Set(["drives", "spawned", "asked", "dispatched"]);

/** One task, every field present. */
export function normalizeTask(raw, index = 0, { now = Date.now() } = {}) {
  const value = object(raw) || {};
  const given = list(first(value.agents, value.members)).map(normalizeAgent);
  const ids = new Set(given.map((agent) => agent.id));
  const links = list(value.links).map((link) => ({ from: text(link?.from), to: text(link?.to), kind: LINK_KINDS.has(link?.kind) ? link.kind : "spawned", at: toMs(link?.at),
    waiting: link?.waiting === true, manual: link?.manual === true }))
    .filter((link) => ids.has(link.from) && ids.has(link.to) && link.from !== link.to);
  // An "asked" link marked waiting says who an agent is waiting on right now.
  for (const link of links) {
    if (link.kind !== "asked" || !link.waiting) continue;
    const asker = given.find((agent) => agent.id === link.from);
    if (!asker) continue;
    asker.waitingOn = { ...(asker.waitingOn || { at: link.at || 0 }), on: asker.waitingOn?.on || link.to, text: asker.waitingOn?.text || "" };
    asker.tone = agentTone(asker);
  }
  // Parents named only by links (an Orca coordinator's workers) are filled in for the layout,
  // unless that would make an agent its own ancestor.
  const byId = new Map(given.map((agent) => [agent.id, agent]));
  const ancestorOf = (id, of) => {
    for (let at = byId.get(of), steps = 0; at && steps < 64; at = byId.get(at.parentId), steps++) if (at.id === id) return true;
    return false;
  };
  for (const link of links) {
    const child = byId.get(link.to);
    if (child && !child.parentId && link.kind !== "asked" && !ancestorOf(child.id, link.from)) child.parentId = link.from;
  }
  const agents = columnOrder(orderAgents(fillRoles(given)), now);
  for (const agent of agents) agent.stale = isStale(agent, now);
  const lead = agents[0];
  const status = lower(value.status);
  const task = {
    id: text(value.id) || lead?.id || `task-${index}`,
    title: text(first(value.title, value.name)) || lead?.name || "Untitled task",
    project: text(value.project) || lead?.project || "",
    updatedAt: toMs(value.updatedAt) || Math.max(0, ...agents.map((agent) => agent.updatedAt)),
    startedAt: toMs(value.startedAt) || Math.min(...agents.map((agent) => agent.startedAt || Infinity).concat([Infinity])),
    status: TASK_STATUSES.has(status) ? status : taskTone(agents),
    needs: number(value.needs) ?? agents.filter((agent) => agent.tone === "needs").length,
    working: number(value.working) ?? agents.filter((agent) => agent.tone === "working" || agent.tone === "waiting").length,
    agents,
    links,
  };
  if (!Number.isFinite(task.startedAt)) task.startedAt = 0;
  return task;
}

/**
 * The name a column shows: a subagent's "General-purpose: Fix rounding" shows its task (its role chip
 * already says it is a subagent); everything else as named.
 */
export function shortName(agent) {
  const name = text(agent?.name) || "Unnamed agent";
  const typed = /^[\w .-]{2,40}: (\S.*)$/.exec(name);
  return agent?.role === "subagent" && typed ? typed[1] : name;
}

/**
 * Labels that fit their room and can be told apart, the way the goblin strip does it
 * (horde_model.tell_apart): `fits[i](text)` cuts text to label i's room from its end ("Fix roun…"),
 * `fitEnds[i](text)` from its start ("…in totals"). Labels that would read the same are told apart by
 * the words after the ones their names share ("…receipts"), else by how their names end; names that are
 * the same through and through get a number. Never returns an empty label. Pure.
 */
export function tellApart(names, fits, fitEnds) {
  const shown = names.map((name, index) => fits[index](name) || name.slice(0, 1) || "?");
  const groups = new Map();
  shown.forEach((label, index) => groups.set(label, [...(groups.get(label) || []), index]));
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const words = new Map(members.map((index) => [index, names[index].split(/\s+/).filter(Boolean)]));
    let shared = 0;
    while (members.every((index) => words.get(index).length > shared + 1) && new Set(members.map((index) => words.get(index)[shared])).size === 1) shared++;
    // How each name ends, as much as fits ("…Fix rounding in totals"); else the words after the shared ones.
    const choices = [
      (index) => fitEnds[index](names[index]),
      (index) => (shared ? fits[index](`…${words.get(index).slice(shared).join(" ")}`) : ""),
    ];
    let told = false;
    for (const choose of choices) {
      const options = members.map(choose);
      if (options.every(Boolean) && new Set(options).size === options.length) {
        members.forEach((index, at) => { shown[index] = options[at]; });
        told = true;
        break;
      }
    }
    // Still the same (the same name twice): number them in the order they are shown, number first so it survives the cut.
    if (!told) members.forEach((index, at) => { shown[index] = fits[index](`${at + 1} · ${names[index]}`); });
  }
  return shown;
}

/** Cut text to `max` characters from its end ("Fix roun…") or from its start at a word ("…in totals"). */
export const cutText = (value, max) => (value.length <= max ? value : `${value.slice(0, Math.max(1, max - 1)).trimEnd()}…`);
export const cutTextEnd = (value, max) => (value.length <= max ? value : `…${wordStart(value, value.length - Math.max(1, max - 1))}`);

/** The text from `at`, moved on to the next word when `at` falls inside one (a lone long word stays cut). */
export function wordStart(value, at) {
  const rest = value.slice(at);
  if (at === 0 || /\s/.test(value[at - 1]) || /^\s/.test(rest)) return rest.trimStart();
  const space = rest.search(/\s/);
  return space > 0 && space < rest.length - 1 ? rest.slice(space).trimStart() : rest;
}

/** The last folder of a path ("C:\\code\\lantern" → "lantern"); a workspace's name under "workspaces". */
export function projectOf(cwd) {
  const parts = text(cwd).replace(/\\/g, "/").split("/").filter(Boolean);
  const at = parts.indexOf("workspaces");
  if (at >= 0 && at + 1 < parts.length) return parts[at + 1];
  return parts.at(-1) || "";
}

/**
 * `/api/tasks` as { tasks, sources: [Source], window: { hours, since }, checkedAt, truncated, aliases }.
 * `aliases` maps an id the strip may still name (an Orca agent shown as its Claude Code session) to
 * the id the task list shows.
 */
export function normalizeTasks(json, { now = Date.now() } = {}) {
  const value = Array.isArray(json) ? { tasks: json } : object(json) || {};
  // Ages are judged on the server's clock when it sends one (the answer's own checkedAt).
  const clock = toMs(value.checkedAt) || now;
  const tasks = list(first(value.tasks, value.items, value.parties)).map((task, index) => normalizeTask(task, index, { now: clock }));
  const sources = Object.entries(object(value.sources) || {}).map(([key, source]) => normalizeSource(key, source));
  const aliases = {};
  for (const [from, to] of Object.entries(object(value.aliases) || {})) if (typeof to === "string" && to) aliases[from] = to;
  return {
    tasks: tasks.sort((a, b) => b.updatedAt - a.updatedAt),
    sources,
    window: { hours: number(object(value.window)?.hours) ?? (number(value.window) || 24), since: toMs(object(value.window)?.since) || 0 },
    checkedAt: toMs(value.checkedAt) || now,
    truncated: number(value.truncated) || 0,
    aliases,
    // The goblin strip asked this open window to show a task (once per `seq`).
    focus: object(value.focus) && number(value.focus.seq) ? { seq: number(value.focus.seq), taskId: text(value.focus.taskId), agentId: text(value.focus.agentId) } : null,
  };
}

// ---- Transcript entries. ----

const ENTRY_KINDS = {
  prompt: "prompt", user: "prompt", usermessage: "prompt", user_message: "prompt", input: "prompt",
  message: "message", assistant: "message", agentmessage: "message", agent_message: "message", text: "message", reply: "message",
  reasoning: "reasoning", thinking: "reasoning", reasoningsummary: "reasoning",
  tool: "tool", tool_use: "tool", tooluse: "tool", toolcall: "tool", tool_call: "tool", commandexecution: "tool", filechange: "tool",
  mcptoolcall: "tool", websearch: "tool", command: "tool",
  plan: "plan", todo: "plan", todos: "plan", todowrite: "plan", planupdate: "plan",
  subagent: "subagent", spawn: "subagent", collab: "subagent", collabagenttoolcall: "subagent", agentspawn: "subagent",
  ask: "ask", question: "ask", approval: "ask", permission: "ask",
  system: "system", note: "system", slash: "system",
  compaction: "compaction", compact: "compaction", summary: "compaction", contextcompaction: "compaction",
  error: "error", failure: "error",
};
const TOOL_KINDS = new Set(["command", "edit", "write", "read", "search", "web", "mcp", "agent", "other"]);
const FROM = { you: "you", user: "you", person: "you", human: "you", coordinator: "coordinator", orchestrator: "coordinator",
  parent: "parent", lead: "parent", agent: "agent", system: "system" };

/** The kind of a tool from its name, for sources that only say what was called. */
export function toolKindOf(name, fallback = "other") {
  const value = lower(name);
  if (!value) return fallback;
  if (value.startsWith("mcp__") || value.startsWith("mcp:") || value === "mcptoolcall") return "mcp";
  if (/^(bash|shell|powershell|exec_command|commandexecution|local_shell|run|terminal|cmd)/.test(value)) return "command";
  if (/^(edit|multiedit|str_replace|apply_patch|filechange|notebookedit|patch)/.test(value)) return "edit";
  if (/^(write|create_file|create)/.test(value)) return "write";
  if (/^(read|view|cat|open_file|notebookread)/.test(value)) return "read";
  if (/^(grep|glob|search|find|rg|ls|list)/.test(value)) return "search";
  if (/^(webfetch|websearch|web|fetch|browse)/.test(value)) return "web";
  if (/^(agent|task|spawn|collab|subagent)/.test(value)) return "agent";
  return fallback;
}

const TOOL_STATUS = { running: "running", inprogress: "running", in_progress: "running", pending: "running", started: "running",
  ok: "ok", completed: "ok", complete: "ok", success: "ok", succeeded: "ok", done: "ok",
  failed: "failed", failure: "failed", error: "failed", errored: "failed", interrupted: "failed", cancelled: "failed", canceled: "failed",
  denied: "denied", declined: "denied", rejected: "denied" };

/** A tool call in the spec's shape, with every field present. */
export function normalizeTool(raw, entry = {}) {
  const value = object(raw) || {};
  // A field from the tool object, else from the entry itself (Codex items carry them at the top).
  const pick = (...keys) => first(...keys.map((key) => value[key]), ...keys.map((key) => entry[key]));
  const name = text(first(value.name, value.tool, entry.name, entry.type)) || "Tool";
  const declared = lower(value.kind);
  const kind = TOOL_KINDS.has(declared) ? declared : toolKindOf(name, toolKindOf(entry.type));
  const input = asText(pick("input", "arguments", "args", "command"));
  const exitCode = number(pick("exitCode", "exit_code"));
  const output = pick("output", "result", "aggregatedOutput", "aggregated_output");
  let status = TOOL_STATUS[lower(pick("status")).replace(/\s+/g, "")] || (output != null ? "ok" : "running");
  if (status === "ok" && exitCode != null && exitCode !== 0) status = "failed";
  const seconds = number(value.duration);
  const durationMs = number(pick("durationMs", "duration_ms")) ?? (seconds != null ? seconds * 1000 : null);
  const truncated = object(pick("outputTruncated", "truncated"));
  const changes = list(pick("files", "changes"));
  // A Codex file change carries one diff per file; they read as one multi-file diff.
  const perFile = changes.filter((file) => typeof file?.diff === "string" && file.diff)
    .map((file) => (/^(diff --git|--- )/m.test(file.diff) ? file.diff : `--- a/${text(file.path)}\n+++ b/${text(file.path)}\n${file.diff}`)).join("\n");
  return {
    name,
    kind,
    title: text(first(value.title, kind === "agent" ? value.description : "", entry.title)),
    input,
    status,
    exitCode,
    durationMs,
    output: stripAnsi(asText(output)),
    outputTruncated: truncated ? { shownBytes: number(first(truncated.shownBytes, truncated.shown)) || 0, totalBytes: number(first(truncated.totalBytes, truncated.total)) || 0 } : null,
    diff: asText(pick("diff", "patch", "unifiedDiff")) || perFile,
    files: changes.map((file) => (typeof file === "string" ? { path: file, added: null, removed: null }
      : { path: text(first(file?.path, file?.file, file?.name)), added: number(first(file?.added, file?.additions)), removed: number(first(file?.removed, file?.deletions)) }))
      .filter((file) => file.path),
    agentId: text(pick("agentId", "agent_id")) || null,
    cwd: text(pick("cwd")),
    // Why the agent ran it ("Run the test suite"), as Claude Code records for its shell calls.
    description: kind === "agent" ? "" : text(value.description),
    background: value.background === true,
    interrupted: value.interrupted === true,
    inputTruncated: Boolean(value.inputTruncated),
    diffTruncated: Boolean(value.diffTruncated),
  };
}

const PLAN_STATUS = { done: "done", completed: "done", complete: "done", active: "active", in_progress: "active", inprogress: "active", running: "active",
  pending: "pending", todo: "pending", not_started: "pending" };

/**
 * A plan: { steps, explanation, change }. `change` ("added" | "updated") marks a single task added or
 * updated (Claude Code's TaskCreate/TaskUpdate); a plan written as prose (Codex plan items, Claude
 * Code's ExitPlanMode) has no steps and its words in the entry's text.
 */
function normalizePlan(raw) {
  const steps = list(object(raw)?.steps ?? raw).map((step) => (typeof step === "string" ? { text: step, status: "pending" }
    : { text: text(first(step?.text, step?.step, step?.content, step?.title)), status: PLAN_STATUS[lower(step?.status).replace(/[\s-]+/g, "_")] || "pending" }))
    .filter((step) => step.text);
  return { steps, explanation: text(object(raw)?.explanation), change: ["added", "updated"].includes(object(raw)?.change) ? raw.change : "" };
}

/** One transcript entry in the spec's shape, every field present. `index` only names an id-less entry. */
export function normalizeEntry(raw) {
  const value = object(raw) || { text: asText(raw) };
  const kindWord = lower(first(value.kind, value.type)).replace(/[\s-]+/g, "_");
  let kind = ENTRY_KINDS[kindWord] || ENTRY_KINDS[kindWord.replace(/_/g, "")] || (value.tool ? "tool" : value.plan ? "plan" : "system");
  const toolLike = kind === "tool" || (kind === "subagent" && (value.tool || value.agentId));
  const tool = toolLike ? normalizeTool(value.tool, value) : null;
  if (tool && kind === "tool" && tool.kind === "agent" && tool.agentId) kind = "subagent";
  const at = toMs(first(value.at, value.time, value.timestamp, value.createdAt));
  const words = asText(first(value.text, value.message, value.content, value.summary));
  const entry = {
    id: text(value.id),
    at,
    turn: first(value.turn, value.turnId) != null ? text(first(value.turn, value.turnId)) : "",
    kind,
    text: words,
    from: FROM[lower(value.from)] || (kind === "prompt" ? "you" : ""),
    // Who sent a prompt that came from another agent, when the source knows.
    fromId: text(first(value.fromId, value.from_id)),
    fromName: text(first(value.fromName, value.from_name)),
    tool,
    plan: kind === "plan" ? normalizePlan(first(value.plan, value.steps, value.todos)) : null,
    ask: kind === "ask" ? normalizeAsk(first(value.ask, value)) : null,
    agentId: text(first(value.agentId, tool?.agentId)) || null,
    updated: value.updated === true, // Sent again because it changed (a call that finished).
    queued: value.queued === true, // A prompt typed while the agent was busy.
    phase: text(value.phase), // Codex: "commentary" while working, "final_answer" at the end.
    screen: value.screen === true, // An Orca terminal's screen, as a system entry.
  };
  if (!entry.id) entry.id = `x-${kind}-${at || 0}-${hashText(`${words}|${tool ? `${tool.name}|${tool.input}` : ""}`)}`;
  return entry;
}

/**
 * `/api/transcript` as { agent, entries, cursor: { first, last }, hasOlder, live, reset, source,
 * checkedAt, error }. Cursors are the server's own, passed back as they came ("" included: a Codex chat
 * says "" when nothing is older); only a server that sends none gets entry ids instead. `reset`: the
 * page replaces everything shown.
 */
export function normalizeTranscript(json, { now = Date.now() } = {}) {
  const value = object(json) || {};
  const entries = list(first(value.entries, value.items, value.records)).map(normalizeEntry);
  // Duplicate ids inside one page keep the newest version, in the place of the first.
  const newest = new Map();
  for (const entry of entries) newest.set(entry.id, entry);
  const unique = [];
  for (const entry of entries) if (newest.has(entry.id)) { unique.push(newest.get(entry.id)); newest.delete(entry.id); }
  const cursor = object(value.cursor);
  const given = (key) => (cursor && typeof cursor[key] === "string" ? cursor[key] : undefined);
  return {
    agent: object(value.agent) ? normalizeAgent(value.agent) : null,
    entries: unique,
    cursor: {
      first: given("first") ?? text(first(value.firstCursor, value.prevCursor, unique.find((entry) => !entry.updated)?.id)),
      last: given("last") ?? text(first(typeof value.cursor === "string" ? value.cursor : "", value.lastCursor, value.nextCursor, unique.at(-1)?.id)),
    },
    hasOlder: Boolean(first(value.hasOlder, value.hasMore, value.older)),
    live: Boolean(value.live),
    reset: value.reset === true,
    source: text(value.source),
    checkedAt: toMs(value.checkedAt) || now,
    error: text(value.error),
  };
}

// ---- The client: real server or the demo, same methods. ----

async function readJson(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(text(body.error) || `The viewer answered ${response.status}.`), { status: response.status, body });
  return body;
}

/**
 * The calls the app makes. `demo` is the demo module (public/app/demo-data.js) or null for the real
 * server; `fetcher` is window.fetch.
 */
export function createClient({ demo = null, fetcher = globalThis.fetch?.bind(globalThis) } = {}) {
  const get = async (path) => readJson(await fetcher(path, { cache: "no-store" }));
  const post = async (path, body) => readJson(await fetcher(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  if (demo) {
    return {
      demo: true,
      tasks: async (hours) => normalizeTasks(await demo.tasks(hours)),
      transcript: async (id, options) => normalizeTranscript(await demo.transcript(id, options)),
      requests: async (threadId) => demo.requests(threadId),
      respond: async (threadId, requestId, answer) => demo.respond(threadId, requestId, answer),
      message: async (id, words) => demo.message(id, words),
      dismiss: async (id, key) => demo.dismiss(id, key),
      open: async (id) => demo.open(id),
      join: async (party, chat) => demo.join(party, chat),
    };
  }
  return {
    demo: false,
    tasks: async (hours) => normalizeTasks(await get(ENDPOINTS.tasks(hours))),
    transcript: async (id, options) => normalizeTranscript(await get(ENDPOINTS.transcript(id, options))),
    requests: async (threadId) => list((await get(ENDPOINTS.requests(threadId))).requests),
    // An approval sends { decision: "accept" | "decline" }; a question sends { answers: { [questionId]: text } }.
    respond: async (threadId, requestId, answer) => post(ENDPOINTS.respond, { threadId, requestId, ...answer }),
    message: async (id, words) => post(ENDPOINTS.message, { id, text: words }),
    dismiss: async (id, key) => post(ENDPOINTS.dismiss, { id, key }),
    open: async (id) => post(ENDPOINTS.open, { id }),
    join: async (party, chat) => post(ENDPOINTS.join, { party, chat }),
  };
}
