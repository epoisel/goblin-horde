/**
 * Tasks: every agent with activity in the window, grouped with the agents it works with.
 *
 * The person checks on tasks, not on separate chats: a Codex chat that drives an Orca coordinator, the
 * coordinator, its workers, and their subagents are one task, shown side by side. Grouping is worked
 * out from what each source records, strongest evidence first, so it holds even when Orca's command
 * line cannot be reached:
 *   1. structure: a Claude Code subagent belongs to its session, a spawned Codex chat to its parent;
 *   2. the person's own choice (join a party to a chat, or keep it separate; see LinkStore);
 *   3. a Codex chat drives an Orca terminal (LinkStore's automatic links) and the Claude Code session
 *      whose hook recorded that terminal (ORCA_TERMINAL_HANDLE) is driven by it;
 *   4. a session's own `orca orchestration dispatch|worker-start|send …` and `orca terminal send`
 *      commands name the terminals of its workers (an `ask` names whom it waits on);
 *   5. Orca's parent pane, while Orca answers;
 *   6. a session working in the same Orca worktree (ORCA_WORKTREE_ID) as a coordinator, while that
 *      coordinator works;
 *   7. the party links the scene already works out (Orca worktrees joined to a chat);
 *   8. what was learned before (TaskMemory), kept for a week in the state folder.
 * Nothing is dropped silently: every agent active in the window is in exactly one task.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyCodex, classifyOrca } from "./feed.mjs";
import { codexAsk } from "./transform.mjs";
import { orcaIdentity } from "./claude.mjs";
import { baseName } from "./detail-text.mjs";

export const TASK_LIMITS = Object.freeze({
  windowHours: 24,
  maxHours: 7 * 24,
  memoryEntries: 2000,
  memoryKeepMs: 7 * 24 * 60 * 60_000,
  driveSlackMs: 30 * 60_000, // A chat's drive of a terminal counts for a session started up to this long after it.
  worktreeSlackMs: 60 * 60_000, // A session joins a coordinator's worktree while their work overlaps within this.
  liveMs: 2 * 60_000, // A transcript written this recently is an agent at work.
  staleSubagentMs: 60 * 60_000, // A subagent quiet this long is marked `stale`: its task keeps it, folded.
});

/** "24h", "4h", "7d" (or a number of hours) as hours, within 1 hour to 7 days; 24 for anything else. */
export function parseWindow(value) {
  const match = /^(\d{1,3})\s*([hd]?)$/i.exec(String(value ?? "").trim());
  if (!match) return TASK_LIMITS.windowHours;
  const hours = Number(match[1]) * (match[2].toLowerCase() === "d" ? 24 : 1);
  return Math.min(TASK_LIMITS.maxHours, Math.max(1, hours || TASK_LIMITS.windowHours));
}

const HANDLE = /^term_[A-Za-z0-9_-]{1,80}$/;
const AGENT_ID = /^(?:[A-Za-z0-9_-]{8,100}|claude-agent:[A-Za-z0-9_-]{1,128}(?::[A-Za-z0-9_-]{1,128})?|orca-agent:[A-Za-z0-9_:.-]{1,200})$/;
const KINDS = new Set(["drives", "spawned", "asked", "dispatched"]);

// ---------------------------------------------------------------------------------------------
// What the Claude Code hook log says about Orca

/** Each session's newest Orca identity in hook records: Map(session -> { terminal?, pane?, worktree?, workspace?, at }). Pure. */
export function claudeIdentities(records) {
  const found = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (!record?.orca || record.agent) continue;
    const orca = orcaIdentity(record.orca);
    const previous = found.get(record.session);
    if (orca && (!previous || record.at >= previous.at)) found.set(record.session, { ...orca, at: record.at });
  }
  return found;
}

// Verbs whose caller directs the terminal it names; an `ask` names whom the caller waits on.
const DISPATCH_VERBS = new Set(["orchestration dispatch", "orchestration worker-start", "orchestration coordinator-start"]);
const DRIVE_VERBS = new Set(["terminal send", "orchestration send", "orchestration reply"]);
const ASK_VERBS = new Set(["orchestration ask"]);

/**
 * The Orca terminals each Claude Code agent's own commands address, as the hook recorded them from each
 * shell command (`orcaTo`, read before its credential filter): Map(agent id -> [{ terminal, kind, verb,
 * at }]) where kind is "dispatched", "drives", or "asked". `--from` names the caller itself and is left
 * out. Pure.
 */
export function claudeAddressing(records) {
  const found = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (record?.event !== "PreToolUse" || !Array.isArray(record.orcaTo)) continue;
    const id = record.agent ? `claude-agent:${record.session}:${record.agent}` : `claude-agent:${record.session}`;
    for (const { terminal, verb, flag } of record.orcaTo) {
      if (flag === "from") continue;
      const kind = DISPATCH_VERBS.has(verb) ? "dispatched" : DRIVE_VERBS.has(verb) ? "drives" : ASK_VERBS.has(verb) ? "asked" : "";
      if (!kind) continue;
      const list = found.get(id) || [];
      const same = list.find((item) => item.terminal === terminal && item.kind === kind);
      if (same) same.at = Math.max(same.at, record.at);
      else list.push({ terminal, kind, verb, at: record.at });
      found.set(id, list);
    }
  }
  return found;
}

/**
 * Each session's own Orca terminal, as its own Orca commands name it: the `--from` of the newest command
 * the hook recorded (Orca tells every worker to name itself so). Map(session -> handle). Pure.
 */
export function claudeOwnHandles(records) {
  const found = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (record?.event !== "PreToolUse" || record.agent || !Array.isArray(record.orcaTo)) continue;
    const from = record.orcaTo.find((item) => item.flag === "from" && HANDLE.test(String(item.terminal)));
    if (from) found.set(record.session, from.terminal);
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// What Codex chats' Orca commands proved, kept per chat

const CHAT_ID = /^[A-Za-z0-9_-]{8,100}$/;
const ITEM_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const RUN = /^run_[A-Za-z0-9]{6,40}$/;
const TASK = /^task_[A-Za-z0-9]{6,40}$/;
const MARK = /^[0-9a-f]{16}$/;
const UUID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVIDENCE_LIMITS = { runs: 300, tasks: 1500, terminals: 500, flagged: 500, sent: 100, screens: 200 };

/** A chat's evidence: runs, tasks, terminals it created or gave work to, terminals it addressed, marks, screens. */
export function emptyEvidence() {
  return { runs: new Map(), tasks: new Map(), terminals: new Map(), flagged: new Map(), sent: new Map(), screens: new Map(), at: 0 };
}

const capped = (map, most) => { while (map.size > most) map.delete(map.keys().next().value); };

/**
 * Fold what one or more commands proved (commandEvidence's shape, plus `flagged` handles; or the saved
 * shape) into a chat's evidence. Every id is checked again. Returns whether anything was new. Pure but
 * for `evidence`.
 */
export function mergeEvidence(evidence, found, at = 0) {
  let changed = false;
  const stamp = (value) => Number(value?.at) || at || 0;
  for (const run of Array.isArray(found?.runs) ? found.runs : []) {
    if (!RUN.test(String(run?.id))) continue;
    const previous = evidence.runs.get(run.id);
    const coordinator = HANDLE.test(String(run.coordinator)) ? run.coordinator : previous?.coordinator || "";
    if (!previous || (coordinator && !previous.coordinator)) { evidence.runs.set(run.id, { coordinator, at: stamp(run) }); changed = true; }
  }
  for (const task of Array.isArray(found?.tasks) ? found.tasks : []) {
    if (!TASK.test(String(task?.id))) continue;
    const previous = evidence.tasks.get(task.id);
    const next = { run: RUN.test(String(task.run)) ? task.run : previous?.run || "", terminal: HANDLE.test(String(task.terminal)) ? task.terminal : previous?.terminal || "", at: stamp(task) || previous?.at || 0 };
    if (!previous || next.run !== previous.run || next.terminal !== previous.terminal) { evidence.tasks.set(task.id, next); changed = true; }
  }
  for (const [field, list] of [["terminals", found?.terminals], ["flagged", found?.flagged]]) {
    for (const item of Array.isArray(list) ? list : []) {
      const handle = typeof item === "string" ? item : item?.handle;
      if (!HANDLE.test(String(handle))) continue;
      const when = typeof item === "string" ? at : stamp(item);
      if ((evidence[field].get(handle) ?? -1) < when) { if (!evidence[field].has(handle)) changed = true; evidence[field].set(handle, when); }
    }
  }
  for (const [field, list, key, valid, most] of [["sent", found?.sent, "mark", MARK, 20], ["screens", found?.screens, "ids", UUID_ID, 8]]) {
    for (const item of Array.isArray(list) ? list : []) {
      if (!HANDLE.test(String(item?.terminal))) continue;
      const values = (Array.isArray(item[key]) ? item[key] : [item[key]]).filter((value) => valid.test(String(value)));
      if (!values.length) continue;
      const kept = evidence[field].get(item.terminal) || [];
      const fresh = values.filter((value) => !kept.includes(value));
      if (!fresh.length) continue;
      evidence[field].set(item.terminal, [...kept, ...fresh].slice(-most));
      changed = true;
    }
  }
  evidence.at = Math.max(evidence.at || 0, Number(found?.at) || at || 0);
  for (const [field, most] of Object.entries(EVIDENCE_LIMITS)) capped(evidence[field], most);
  return changed;
}

/** A chat's evidence as saved in task-links.json (mergeEvidence reads it back). */
function serializeEvidence(evidence) {
  return {
    runs: [...evidence.runs].map(([id, run]) => ({ id, ...(run.coordinator ? { coordinator: run.coordinator } : {}), at: run.at })),
    tasks: [...evidence.tasks].map(([id, task]) => ({ id, ...(task.run ? { run: task.run } : {}), ...(task.terminal ? { terminal: task.terminal } : {}), at: task.at })),
    terminals: [...evidence.terminals].map(([handle, at]) => ({ handle, at })),
    flagged: [...evidence.flagged].map(([handle, at]) => ({ handle, at })),
    sent: [...evidence.sent].map(([terminal, mark]) => ({ terminal, mark })),
    screens: [...evidence.screens].map(([terminal, ids]) => ({ terminal, ids })),
    at: evidence.at, seenAt: evidence.seenAt,
  };
}

// ---------------------------------------------------------------------------------------------
// Memory of what was learned

/**
 * Memberships learned from evidence that does not last (a hook log that rolls over, an Orca that closes,
 * a terminal a chat no longer drives): each session's Orca identity and each agent's parent, saved in the
 * state folder (task-links.json), at most `memoryEntries` of each, each forgotten a week after it was last
 * seen. Used only where nothing stronger says otherwise.
 */
export class TaskMemory {
  constructor({ dir, clock = Date.now, limits = TASK_LIMITS } = {}) {
    Object.assign(this, { dir, clock, limits });
    this.file = dir ? join(dir, "task-links.json") : "";
    this.identities = new Map(); // session -> { terminal?, pane?, worktree?, workspace?, at, seenAt }
    this.parents = new Map(); // child agent id -> { parent, kind, at, seenAt }
    this.chats = new Map(); // Codex chat id -> chat evidence (see noteEvidence), with seenAt
    this.scans = new Map(); // Codex chat id -> { newest, oldestAt, complete, since, at, seenAt }: how far its items were read
    this.runs = new Map(); // Orca run id -> { coordinator?, objective?, at, seenAt }
    this.workers = new Map(); // Orca task id -> { run?, handle?, dispatch?, seenAt }
    this.dirty = false;
    if (!this.file) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      for (const [session, value] of Object.entries(saved?.identities || {})) {
        const orca = orcaIdentity(value);
        if (/^[A-Za-z0-9_-]{1,128}$/.test(session) && orca && Number.isFinite(value?.seenAt)) this.identities.set(session, { ...orca, at: Number(value.at) || 0, seenAt: value.seenAt });
      }
      for (const [child, value] of Object.entries(saved?.parents || {})) {
        if (AGENT_ID.test(child) && AGENT_ID.test(String(value?.parent)) && KINDS.has(value?.kind) && Number.isFinite(value?.seenAt) && child !== value.parent)
          this.parents.set(child, { parent: value.parent, kind: value.kind, at: Number(value.at) || 0, seenAt: value.seenAt });
      }
      for (const [chat, value] of Object.entries(saved?.chats || {})) {
        if (!CHAT_ID.test(chat) || !Number.isFinite(value?.seenAt)) continue;
        const evidence = emptyEvidence();
        mergeEvidence(evidence, value);
        this.chats.set(chat, { ...evidence, seenAt: value.seenAt });
      }
      for (const [chat, value] of Object.entries(saved?.scans || {})) {
        if (CHAT_ID.test(chat) && Number.isFinite(value?.seenAt)) this.scans.set(chat, { newest: ITEM_ID.test(String(value.newest)) ? value.newest : "",
          oldestAt: Number(value.oldestAt) || 0, complete: value.complete === true, since: Number(value.since) || 0, at: Number(value.at) || 0, seenAt: value.seenAt });
      }
      for (const [run, value] of Object.entries(saved?.runs || {})) {
        if (RUN.test(run) && Number.isFinite(value?.seenAt)) this.runs.set(run, { ...(HANDLE.test(String(value.coordinator)) ? { coordinator: value.coordinator } : {}),
          ...(typeof value.objective === "string" ? { objective: value.objective.slice(0, 200) } : {}), at: Number(value.at) || 0, seenAt: value.seenAt });
      }
      for (const [task, value] of Object.entries(saved?.workers || {})) {
        if (TASK.test(task) && Number.isFinite(value?.seenAt)) this.workers.set(task, { ...(RUN.test(String(value.run)) ? { run: value.run } : {}),
          ...(HANDLE.test(String(value.handle)) ? { handle: value.handle } : {}), seenAt: value.seenAt });
      }
    } catch { /* Nothing learned yet, or an unreadable file: start empty. */ }
    this.prune();
  }

  /**
   * Remember what a Codex chat's Orca commands proved (see commandEvidence in lib/orca-commands.mjs):
   * the runs it created or used, the tasks it started, the terminals it created, gave work to, or
   * addressed, what their screens showed, and marks of what it typed into them.
   */
  noteEvidence(chat, found, at = 0) {
    if (!CHAT_ID.test(String(chat)) || !found) return;
    const evidence = this.chats.get(chat) || { ...emptyEvidence(), seenAt: 0 };
    if (mergeEvidence(evidence, found, Number(at) || 0) || this.clock() - evidence.seenAt > 60 * 60_000) {
      evidence.seenAt = this.clock();
      this.chats.set(chat, evidence);
      this.dirty = true;
    }
  }

  /** Remember how far a chat's items were read. */
  noteScan(chat, state) {
    if (!CHAT_ID.test(String(chat))) return;
    this.scans.set(chat, { newest: ITEM_ID.test(String(state.newest)) ? state.newest : "", oldestAt: Number(state.oldestAt) || 0, complete: state.complete === true,
      since: Number(state.since) || 0, at: Number(state.at) || 0, seenAt: this.clock() });
    this.dirty = true;
  }

  /** Remember Orca's own runs and workers, so a task keeps its shape after Orca closes. */
  noteOrca({ runs = [], workers = [] } = {}) {
    const now = this.clock();
    for (const run of runs) {
      if (!RUN.test(String(run?.id))) continue;
      const previous = this.runs.get(run.id);
      if (previous && previous.coordinator === run.coordinator && now - previous.seenAt < 60 * 60_000) continue;
      this.runs.set(run.id, { ...(HANDLE.test(String(run.coordinator)) ? { coordinator: run.coordinator } : {}), ...(run.objective ? { objective: String(run.objective).slice(0, 200) } : {}),
        at: Number(run.at) || 0, seenAt: now });
      this.dirty = true;
    }
    for (const worker of workers) {
      if (!TASK.test(String(worker?.task))) continue;
      const previous = this.workers.get(worker.task);
      if (previous && previous.handle === worker.handle && now - previous.seenAt < 60 * 60_000) continue;
      this.workers.set(worker.task, { ...(RUN.test(String(worker.run)) ? { run: worker.run } : {}), ...(HANDLE.test(String(worker.handle)) ? { handle: worker.handle } : {}), seenAt: now });
      this.dirty = true;
    }
  }

  /** Remember where a session runs. */
  noteIdentity(session, orca) {
    const clean = orcaIdentity(orca);
    if (!clean || !/^[A-Za-z0-9_-]{1,128}$/.test(String(session))) return;
    const previous = this.identities.get(session);
    const at = Number(orca.at) || 0;
    if (previous && previous.at > at) return;
    const same = previous && ["terminal", "pane", "worktree", "workspace"].every((field) => previous[field] === clean[field]);
    if (same && this.clock() - previous.seenAt < 60 * 60_000) return;
    this.identities.set(session, { ...clean, at, seenAt: this.clock() });
    this.dirty = true;
  }

  /** Remember whom an agent works for. */
  noteParent(child, parent, kind, at = 0) {
    if (!AGENT_ID.test(String(child)) || !AGENT_ID.test(String(parent)) || child === parent || !KINDS.has(kind)) return;
    const previous = this.parents.get(child);
    if (previous && previous.parent === parent && previous.kind === kind && this.clock() - previous.seenAt < 60 * 60_000) return;
    this.parents.set(child, { parent, kind, at: Number(at) || 0, seenAt: this.clock() });
    this.dirty = true;
  }

  prune() {
    const now = this.clock();
    const limits = [[this.identities, this.limits.memoryEntries], [this.parents, this.limits.memoryEntries], [this.chats, 300], [this.scans, 300],
      [this.runs, this.limits.memoryEntries], [this.workers, this.limits.memoryEntries * 3]];
    for (const [map, most] of limits) {
      for (const [key, value] of map) if (now - value.seenAt > this.limits.memoryKeepMs) { map.delete(key); this.dirty = true; }
      if (map.size > most) {
        const oldest = [...map].sort((a, b) => a[1].seenAt - b[1].seenAt).slice(0, map.size - most);
        for (const [key] of oldest) map.delete(key);
        this.dirty = true;
      }
    }
  }

  /** Write what changed; a folder that cannot be written keeps it in memory for this run. */
  save() {
    if (!this.dirty || !this.file) return false;
    this.prune();
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const chats = Object.fromEntries([...this.chats].map(([chat, evidence]) => [chat, serializeEvidence(evidence)]));
      writeFileSync(temporary, `${JSON.stringify({ v: 1, identities: Object.fromEntries(this.identities), parents: Object.fromEntries(this.parents), chats,
        scans: Object.fromEntries(this.scans), runs: Object.fromEntries(this.runs), workers: Object.fromEntries(this.workers) })}\n`, { mode: 0o600 });
      renameSync(temporary, this.file);
      this.dirty = false;
      return true;
    } catch { return false; } finally { try { rmSync(temporary, { force: true }); } catch { /* Gone already. */ } }
  }
}

// ---------------------------------------------------------------------------------------------
// Building tasks

const ROLE_ORDER = { coordinator: 0, worker: 1, solo: 1, lead: 0, subagent: 2 };

/** A Codex chat known only from thread/list: its listed status, and any request it waits on. */
function listedChat(summary, { requests = [], now }) {
  const status = String(summary.status || "notLoaded");
  const actor = { id: summary.id, source: "codex", name: summary.name || "Untitled chat", nickname: summary.agentNickname || summary.name || "",
    role: summary.agentRole || "Codex chat", model: summary.model || null, cwd: summary.cwd || "", status, updatedAt: Number(summary.updatedAt) || 0,
    turns: 0, turnStates: [], now: null, progress: null, ...(summary.parentThreadId ? { parentThreadId: summary.parentThreadId, subagent: true } : {}) };
  const lower = status.toLowerCase();
  actor.ask = codexAsk(actor, { requests, now });
  actor.attention = actor.ask ? "needs" : lower === "systemerror" ? classifyCodex({ ...actor, status: "systemError" }, { now }) : lower === "active" ? "working" : "quiet";
  actor.needsInput = Boolean(actor.ask);
  return actor;
}

/** A Claude Code session or subagent known only from its transcript (no hook records in view). */
function transcriptActor(item, { now, limits }) {
  const id = item.agent ? `claude-agent:${item.session}:${item.agent}` : `claude-agent:${item.session}`;
  const live = now - Number(item.updatedAt) <= limits.liveMs;
  const type = String(item.agentType || "helper");
  const name = item.agent
    ? (item.description ? `${type[0].toUpperCase()}${type.slice(1)}: ${item.description}` : `${type[0].toUpperCase()}${type.slice(1)} subagent`)
    : item.name || `Claude · ${baseName(item.cwd) || "session"}`;
  return {
    id, source: "claude", name: String(name).slice(0, 120), nickname: item.agent ? `${type} subagent` : "Claude Code", model: item.model || null,
    role: item.agent ? `Claude subagent · ${type}` : "Claude Code", cwd: item.cwd || "", status: live ? "active" : "idle", attention: live ? "working" : "quiet",
    updatedAt: Number(item.updatedAt) || 0, turns: 0, turnStates: [], ask: null, now: live ? { kind: "think", title: "Working", startedAt: Number(item.updatedAt) || 0 } : null,
    progress: null, needsInput: false, ...(item.agent ? { childOf: `claude-agent:${item.session}`, agentType: type } : {}), parentThreadId: `claude:${item.session}`,
  };
}

/**
 * Orca's run ids, task ids, and terminal handles, from Codex chats' evidence (TaskMemory chats), Orca's own
 * run and worker lists (`evidence.runs`, `evidence.workers`), and the chats' flag-driven links (`auto`),
 * indexed for buildTasks. `chatFor({ task, run, coordinator, handle })` names the chat that leads that
 * work, strongest proof first: it started the task, created the run, used the run, addresses the
 * coordinator's terminal, or created or addresses the worker's own terminal. Among chats with the same
 * proof (a forked chat copies its parent's history), the newest evidence wins. Only chats in `nodes`.
 */
export function orchestrationIndex(evidence, auto = new Map(), nodes = new Map()) {
  const lists = { task: new Map(), created: new Map(), used: new Map(), coordinator: new Map(), flagged: new Map(), terminal: new Map() };
  const add = (kind, key, chat, at) => {
    if (!key || !nodes.has(chat)) return;
    const list = lists[kind].get(key) || [];
    list.push({ chat, at: Number(at) || 0 });
    lists[kind].set(key, list);
  };
  const taskRun = new Map();
  const runCoordinator = new Map();
  const objective = new Map();
  const taskByHandle = new Map();
  for (const [chat, found] of evidence?.chats instanceof Map ? evidence.chats : []) {
    for (const [task, value] of found.tasks || []) {
      add("task", task, chat, value.at);
      if (value.run && !taskRun.has(task)) taskRun.set(task, value.run);
      if (value.terminal) taskByHandle.set(value.terminal, task);
    }
    for (const [run, value] of found.runs || []) {
      if (value.coordinator) { add("created", run, chat, value.at); add("coordinator", value.coordinator, chat, value.at); runCoordinator.set(run, value.coordinator); }
      else add("used", run, chat, value.at);
    }
    for (const [handle, at] of found.terminals || []) add("terminal", handle, chat, at);
    for (const [handle, at] of found.flagged || []) add("flagged", handle, chat, at);
  }
  for (const [handle, link] of auto) add("flagged", handle, link.chat, link.at);
  for (const [run, value] of evidence?.runs instanceof Map ? evidence.runs : []) {
    if (value.coordinator && !runCoordinator.has(run)) runCoordinator.set(run, value.coordinator);
    if (value.objective) objective.set(run, value.objective);
  }
  for (const [task, value] of evidence?.workers instanceof Map ? evidence.workers : []) {
    if (value.run && !taskRun.has(task)) taskRun.set(task, value.run);
    if (value.handle && !taskByHandle.has(value.handle)) taskByHandle.set(value.handle, task);
  }
  const coordinatorRun = new Map([...runCoordinator].map(([run, handle]) => [handle, run]));
  const newest = (list) => (list?.length ? [...list].sort((a, b) => b.at - a.at || (nodes.get(b.chat)?.updatedAt || 0) - (nodes.get(a.chat)?.updatedAt || 0))[0].chat : "");
  const chatFor = ({ task = "", run = "", coordinator = "", handle = "" } = {}) => newest(lists.task.get(task)) || newest(lists.created.get(run))
    || newest(lists.coordinator.get(coordinator)) || newest(lists.used.get(run)) || newest(lists.flagged.get(coordinator))
    || newest(lists.terminal.get(handle)) || newest(lists.flagged.get(handle));
  return { taskRun, runCoordinator, coordinatorRun, objective, taskByHandle, chatFor };
}

/** An Orca run whose coordinator is no agent here and whose chat is not known: it holds its workers together. */
function runActor(id, { objective = "", cwd = "" } = {}) {
  return { id, source: "orca", name: objective || "Orca run", nickname: "Orca run", role: "Orca run", model: null, cwd, status: "unknown", attention: "quiet",
    updatedAt: 0, turns: 0, turnStates: [], ask: null, now: null, progress: null, needsInput: false };
}

/** The agent as the task list sends it: the scene actor's fields, without its step list (the transcript has them). */
function listedAgent(actor) {
  const { activities, ...rest } = actor || {};
  return rest;
}

/**
 * needs | working | failed | idle | done for a task, from its agents. Quiet tasks are "done" when every
 * agent finished cleanly, and "idle" when one stopped part-way (interrupted, gone quiet mid-turn) or its
 * state is known only from a transcript. Pure.
 */
export function taskStatus(agents) {
  const list = Array.isArray(agents) ? agents : [];
  if (list.some((agent) => agent.attention === "needs")) return "needs";
  if (list.some((agent) => agent.attention === "working")) return "working";
  if (list.some((agent) => agent.attention === "failed")) return "failed";
  const stopped = (agent) => {
    const status = String(agent.status || "").toLowerCase();
    // Codex calls a loaded chat with nothing running "idle"; Claude Code's idle is a turn left open.
    return agent.seenBy === "transcript" || ["stopped", "stale", "interrupted", "waiting"].includes(status) || (agent.source !== "codex" && status === "idle");
  };
  return list.some(stopped) ? "idle" : "done";
}

const samePath = (a, b) => Boolean(a) && Boolean(b) && String(a).replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase() === String(b).replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
const ORCA_ASK = /\borca(?:\.exe)?\s+orchestration\s+ask\b/i;

/**
 * Every task with activity since `since`. Pure: the server gathers the sources (see TaskService).
 *
 * input:
 *   now, since                         ms
 *   codex: { chats, spawned, actors: Map(id -> scene actor), requests(id) }
 *       chats and spawned are thread/list summaries (spawned carry parentThreadId); `actors` are chats
 *       read recently, with their asks and steps.
 *   claude: { parties, transcripts, identities, addressing }
 *       parties: ClaudeReader.taskFeed(); transcripts: [{ session, agent, updatedAt, startedAt, cwd, name,
 *       model, agentType, description, parentAgent }] from the projects folder; identities and addressing
 *       from claudeIdentities / claudeAddressing.
 *   orca: { agents, pairs: Map(pane id -> session actor id) }   (empty when Orca does not answer)
 *   links: { auto: Map(terminal -> { chat, verb, at }), manual: Map(party -> chat or "") }
 *   joined: Map(member id -> chat) from the scene's own party links (joinParties membership)
 *   memory: { identities: Map, parents: Map } (TaskMemory)
 *   settle(actor): the dismissals applied to an actor
 * Returns { tasks, aliases (agent id -> the id it is shown as), learned: { parents: [{ child, parent, kind, at }],
 * identities: Map }, counts }.
 */
export function buildTasks(input) {
  const now = Number(input.now) || Date.now();
  const since = Number(input.since) || now - TASK_LIMITS.windowHours * 3_600_000;
  const limits = { ...TASK_LIMITS, ...(input.limits || {}) };
  const settle = typeof input.settle === "function" ? input.settle : (actor) => actor;
  const codex = input.codex || {};
  const claude = input.claude || {};
  const orca = input.orca || {};
  const links = input.links || {};
  const manual = links.manual instanceof Map ? links.manual : new Map();
  const auto = links.auto instanceof Map ? links.auto : new Map();
  const memory = input.memory || {};
  const requests = typeof codex.requests === "function" ? codex.requests : () => [];
  const nodes = new Map(); // id -> { id, actor, party, session?, orca?, startedAt, updatedAt, seenBy }
  const aliases = new Map();
  const put = (id, fields) => {
    const node = nodes.get(id);
    if (node) {
      node.updatedAt = Math.max(node.updatedAt, Number(fields.updatedAt) || 0);
      if (!node.startedAt || (fields.startedAt && fields.startedAt < node.startedAt)) node.startedAt = fields.startedAt || node.startedAt;
      return node;
    }
    const created = { id, startedAt: 0, ...fields, updatedAt: Number(fields.updatedAt) || 0 };
    nodes.set(id, created);
    return created;
  };

  // Codex chats, and the chats they spawned.
  const codexActors = codex.actors instanceof Map ? codex.actors : new Map();
  for (const summary of [...(codex.chats || []), ...(codex.spawned || [])]) {
    if (!summary?.id || nodes.has(summary.id)) continue;
    const read = codexActors.get(summary.id);
    const actor = read
      ? { ...read, source: "codex", ask: codexAsk(read, { requests: requests(summary.id), now }), ...(summary.parentThreadId ? { parentThreadId: summary.parentThreadId } : {}) }
      : listedChat(summary, { requests: requests(summary.id), now });
    if (read) {
      actor.attention = actor.ask ? "needs" : read.attention || classifyCodex(read, { now });
      actor.needsInput = Boolean(actor.ask);
    }
    if (!actor.name || actor.name === "Untitled chat") actor.name = summary.name || actor.name;
    put(summary.id, { actor: settle(actor), party: summary.id, updatedAt: Math.max(Number(summary.updatedAt) || 0, Number(read?.updatedAt) || 0),
      startedAt: Number(summary.createdAt) || 0, seenBy: read ? "codex" : "codex-list", spawnedBy: summary.parentThreadId || "" });
  }

  // Claude Code sessions and subagents from the hook log.
  for (const party of claude.parties || []) {
    for (const actor of party.agents || []) {
      put(actor.id, { actor: settle(actor), party: party.id, session: party.session, updatedAt: actor.updatedAt, startedAt: actor.childOf ? 0 : Number(party.startedAt) || 0, seenBy: "hooks",
        spawnedBy: actor.childOf || "" });
    }
  }
  // And those only their transcripts show (the hook log rolled over, or hooks are not connected).
  for (const item of claude.transcripts || []) {
    const id = item.agent ? `claude-agent:${item.session}:${item.agent}` : `claude-agent:${item.session}`;
    const node = nodes.get(id);
    if (node) {
      node.updatedAt = Math.max(node.updatedAt, Number(item.updatedAt) || 0);
      // The transcript's first record is when the session really began; the hook log may have rolled past it.
      if (item.startedAt && (!node.startedAt || item.startedAt < node.startedAt)) node.startedAt = item.startedAt;
      continue;
    }
    const actor = transcriptActor(item, { now, limits });
    const spawnedBy = item.agent ? (item.parentAgent ? `claude-agent:${item.session}:${item.parentAgent}` : `claude-agent:${item.session}`) : "";
    put(id, { actor, party: `claude:${item.session}`, session: item.session, updatedAt: item.updatedAt, startedAt: Number(item.startedAt) || 0, seenBy: "transcript", spawnedBy });
  }
  // A subagent whose parent's own records are gone still stands under its session.
  for (const node of [...nodes.values()]) {
    if (!node.spawnedBy || nodes.has(node.spawnedBy) || !node.spawnedBy.startsWith("claude-agent:") || !node.session) continue;
    node.spawnedBy = `claude-agent:${node.session}`;
    if (nodes.has(node.spawnedBy)) continue;
    put(node.spawnedBy, { actor: transcriptActor({ session: node.session, updatedAt: node.updatedAt, cwd: node.actor.cwd }, { now, limits }), party: `claude:${node.session}`,
      session: node.session, updatedAt: node.updatedAt, startedAt: 0, seenBy: "transcript" });
  }

  // An Orca worker goes by its dispatch brief's task line, else by Orca's title for its terminal; a name
  // the person gave the session always stands.
  const facts = new Map(); // session node id -> { task, coordinator } from its dispatch brief
  const own = new Map(); // node id -> its own Orca terminal handle
  const orcaTitles = new Map((orca.terminals || []).filter((item) => HANDLE.test(String(item?.handle))).map((item) => [item.handle, String(item.title || "")]));
  for (const item of claude.transcripts || []) {
    if (item.agent) continue;
    const node = nodes.get(`claude-agent:${item.session}`);
    if (!node) continue;
    if (item.orca?.own && HANDLE.test(item.orca.own)) own.set(node.id, item.orca.own);
    if (item.orca?.task || item.orca?.coordinator) facts.set(node.id, { task: TASK.test(String(item.orca.task)) ? item.orca.task : "", coordinator: HANDLE.test(String(item.orca.coordinator)) ? item.orca.coordinator : "" });
    if (item.brief && !item.custom) node.actor = { ...node.actor, name: String(item.brief).slice(0, 120) };
  }
  // Its own --from in the Orca commands the hook recorded: the terminal it runs in, said by itself.
  for (const [session, handle] of claude.handles instanceof Map ? claude.handles : []) {
    const id = `claude-agent:${session}`;
    if (nodes.has(id) && !own.has(id) && HANDLE.test(handle)) own.set(id, handle);
  }
  // A terminal's screen a Codex chat read that showed exactly one session's id: that session runs there.
  for (const evidence of input.evidence?.chats instanceof Map ? input.evidence.chats.values() : []) {
    for (const [handle, ids] of evidence.screens || []) {
      const shown = ids.map((id) => `claude-agent:${id}`).filter((id) => nodes.has(id));
      if (shown.length === 1 && !own.has(shown[0])) own.set(shown[0], handle);
    }
  }
  // Where each Claude Code session runs in Orca: the above, its hook's terminal ids, else what was learned before.
  const identities = new Map();
  for (const [session, value] of memory.identities instanceof Map ? memory.identities : []) identities.set(session, value);
  for (const [session, value] of claude.identities instanceof Map ? claude.identities : []) {
    const previous = identities.get(session);
    if (!previous || (value.at || 0) >= (previous.at || 0)) identities.set(session, value);
  }
  for (const [id, handle] of own) {
    const session = id.slice("claude-agent:".length);
    const previous = identities.get(session);
    if (previous?.terminal !== handle) identities.set(session, { ...(previous || {}), terminal: handle, at: Math.max(Number(previous?.at) || 0, nodes.get(id).updatedAt) });
  }
  const sessionByTerminal = new Map();
  const sessionByPane = new Map();
  for (const [session, value] of identities) {
    const id = `claude-agent:${session}`;
    if (!nodes.has(id)) continue;
    const node = nodes.get(id);
    node.orca = value;
    if (value.terminal && !own.has(id)) own.set(id, value.terminal);
    // A terminal used by two sessions belongs to the one that ran in it last.
    const take = (map, key) => { if (!key) return; const other = map.get(key); if (!other || (nodes.get(other)?.updatedAt || 0) <= node.updatedAt) map.set(key, id); };
    take(sessionByTerminal, value.terminal);
    take(sessionByPane, value.pane);
    if (!facts.has(id) && !node.actor.custom && value.terminal && orcaTitles.get(value.terminal) && /^Claude · /.test(String(node.actor.name))) {
      node.actor = { ...node.actor, name: orcaTitles.get(value.terminal).slice(0, 120) };
    }
  }
  const sessionByTask = new Map([...facts].filter(([, value]) => value.task).map(([id, value]) => [value.task, id]));

  // Orca's own agents: one that is a Claude Code session already shown is that session.
  const orcaPairs = orca.pairs instanceof Map ? orca.pairs : new Map();
  const byPane = new Map();
  for (const agent of orca.agents || []) {
    if (!agent?.id) continue;
    // The same agent: the hook's pane or terminal ids, its brief's task or own terminal, or proven words.
    const twin = (agent.pane && sessionByPane.get(agent.pane)) || (agent.terminal && sessionByTerminal.get(agent.terminal))
      || (agent.orcaBrief?.task && sessionByTask.get(agent.orcaBrief.task)) || (agent.orcaBrief?.own && sessionByTerminal.get(agent.orcaBrief.own)) || orcaPairs.get(agent.id);
    if (twin && nodes.has(twin)) {
      aliases.set(agent.id, twin);
      byPane.set(agent.pane, twin);
      const node = nodes.get(twin);
      node.orcaAgent = agent;
      if (agent.terminal && !sessionByTerminal.has(agent.terminal)) sessionByTerminal.set(agent.terminal, twin);
      if (agent.terminal && !own.has(twin)) own.set(twin, agent.terminal);
      continue;
    }
    const actor = { ...agent, attention: agent.attention || classifyOrca(agent, { now }) };
    put(agent.id, { actor: settle(actor), party: String(agent.parentThreadId || agent.id), updatedAt: agent.updatedAt, startedAt: 0, seenBy: "orca", orcaAgent: agent });
    byPane.set(agent.pane, agent.id);
    const handle = agent.terminal || agent.orcaBrief?.own || "";
    if (HANDLE.test(handle)) own.set(agent.id, handle);
    if (agent.orcaBrief?.task || agent.orcaBrief?.coordinator) facts.set(agent.id, { task: TASK.test(String(agent.orcaBrief.task)) ? agent.orcaBrief.task : "",
      coordinator: HANDLE.test(String(agent.orcaBrief.coordinator)) ? agent.orcaBrief.coordinator : "" });
  }
  const nodeByTerminal = (terminal) => {
    if (!terminal || !HANDLE.test(terminal)) return "";
    const session = sessionByTerminal.get(terminal);
    if (session) return session;
    return [...own].find(([id, handle]) => handle === terminal && nodes.has(id))?.[0] || "";
  };

  // Parents, strongest evidence first; an edge that would make a loop is left out.
  const parent = new Map(); // child -> { parent, kind, at, strength, source }
  const separate = new Set();
  const ancestorOf = (candidate, child) => {
    for (let at = candidate, steps = 0; at && steps < 64; steps++) {
      if (at === child) return true;
      at = parent.get(at)?.parent;
    }
    return false;
  };
  const link = (child, to, kind, { at = 0, strength = 0, source = "", run = "" } = {}) => {
    if (!child || !to || child === to || !nodes.has(child) || !nodes.has(to) || parent.has(child) || ancestorOf(to, child)) return false;
    if (separate.has(child) && strength < 100) return false;
    parent.set(child, { parent: to, kind, at: Number(at) || 0, strength, source, ...(run ? { run } : {}) });
    return true;
  };
  // 1. Structure.
  for (const node of nodes.values()) if (node.spawnedBy) link(node.id, node.spawnedBy, "spawned", { strength: 100, source: "structure" });
  // 2. The person's own choices, by party.
  for (const node of nodes.values()) {
    if (parent.has(node.id)) continue;
    const choice = manual.get(node.party);
    if (choice === "") separate.add(node.id);
    else if (choice && choice !== node.party) {
      if (!nodes.has(choice)) put(choice, { actor: listedChat({ id: choice, name: "Codex chat", status: "notLoaded" }, { now }), party: choice, updatedAt: 0, seenBy: "codex-list" });
      link(node.id, choice, "drives", { strength: 90, source: "manual" });
    }
  }
  // 2b. Orca runs, by their ids, with no Orca needed: a worker's brief names its task and its coordinator's
  //     terminal; the Codex chat that started that task (worker-start), created that run (run-create), or
  //     drives that coordinator terminal leads it; a session running in a run's coordinator terminal is the
  //     coordinator, between the chat and the workers. Orca's own run and worker lists fill the gaps.
  const orchestration = orchestrationIndex(input.evidence, auto, nodes);
  const workerOf = new Map(); // node id -> { task, run, coordinator }
  for (const node of nodes.values()) {
    if (node.spawnedBy) continue;
    const brief = facts.get(node.id) || {};
    const handle = own.get(node.id) || "";
    const task = brief.task || orchestration.taskByHandle.get(handle) || "";
    const run = orchestration.taskRun.get(task) || "";
    const coordinator = brief.coordinator || orchestration.runCoordinator.get(run) || "";
    if (task || coordinator) workerOf.set(node.id, { task, run, coordinator });
  }
  // Coordinators first, so their workers can stand under them.
  for (const [id, handle] of own) {
    const run = orchestration.coordinatorRun.get(handle);
    if (!run || !nodes.has(id) || workerOf.get(id)?.coordinator === handle) continue;
    const chat = orchestration.chatFor({ run, coordinator: handle });
    if (chat) link(id, chat, "drives", { strength: 86, source: "orca-run", run });
  }
  for (const [id, worker] of workerOf) {
    const coordinatorNode = worker.coordinator ? nodeByTerminal(worker.coordinator) : "";
    if (coordinatorNode && coordinatorNode !== id && link(id, coordinatorNode, "dispatched", { strength: 85, source: "orca-run", run: worker.run })) continue;
    const chat = orchestration.chatFor({ ...worker, handle: own.get(id) || "" });
    if (chat) { link(id, chat, "dispatched", { strength: 84, source: "orca-run", run: worker.run }); continue; }
    // No chat known: the run's workers still stand together, under the run.
    if (!worker.run && !worker.coordinator) continue;
    const placeholder = worker.run ? `orca-agent:run:${worker.run}` : `orca-agent:coordinator:${worker.coordinator}`;
    const node = nodes.get(id);
    put(placeholder, { actor: runActor(placeholder, { objective: orchestration.objective.get(worker.run), cwd: node.actor.cwd }), party: placeholder,
      updatedAt: node.updatedAt, startedAt: node.startedAt, seenBy: "orca-run" });
    link(id, placeholder, "dispatched", { strength: 84, source: "orca-run", run: worker.run });
  }
  // 3. A Codex chat drives a terminal: the session in that terminal (or Orca's agent there) is driven by it.
  for (const [terminal, driven] of auto) {
    const child = nodeByTerminal(terminal);
    const node = nodes.get(child);
    if (!node || !nodes.has(driven.chat)) continue;
    // A drive from long before the session started was another session in the same terminal.
    if (node.startedAt && Number(driven.at) && Number(driven.at) < node.startedAt - limits.driveSlackMs) continue;
    link(child, driven.chat, "drives", { at: driven.at, strength: 80, source: "drives" });
  }
  // 4. A session's own Orca commands: whom it dispatches or drives, and whom it asks.
  const addressing = claude.addressing instanceof Map ? claude.addressing : new Map();
  const asked = [];
  const ordered = [...addressing].flatMap(([from, list]) => list.map((item) => ({ from, ...item }))).sort((a, b) => (a.kind === "asked") - (b.kind === "asked") || a.at - b.at);
  for (const item of ordered) {
    const from = aliases.get(item.from) || item.from;
    const target = nodeByTerminal(item.terminal);
    if (!target || target === from || !nodes.has(from)) continue;
    if (item.kind === "asked") { asked.push({ from, to: target, kind: "asked", at: item.at }); link(from, target, "asked", { at: item.at, strength: 60, source: "commands" }); }
    else link(target, from, item.kind, { at: item.at, strength: 70, source: "commands" });
  }
  // 5. Orca's parent panes.
  for (const agent of orca.agents || []) {
    if (!agent?.parentPane) continue;
    const child = aliases.get(agent.id) || agent.id;
    const up = byPane.get(agent.parentPane);
    if (up) link(child, up, "dispatched", { at: agent.updatedAt, strength: 65, source: "orca" });
  }
  // 6. A session in a coordinator's Orca worktree, while the coordinator works, is one of its workers.
  //    A coordinator is driven by a chat or dispatches workers, now or as remembered.
  const coordinators = new Set();
  const remembered = memory.parents instanceof Map ? [...memory.parents].map(([child, edge]) => [child, { ...edge, source: "memory" }]) : [];
  for (const [child, edge] of [...parent, ...remembered]) {
    if (!nodes.has(child) || !nodes.has(edge.parent)) continue;
    if (edge.kind === "drives" && edge.source !== "manual" && nodes.get(edge.parent).actor.source === "codex") coordinators.add(child);
    if (edge.kind === "dispatched" && edge.source !== "worktree") coordinators.add(edge.parent);
  }
  for (const node of nodes.values()) {
    if (parent.has(node.id) || !node.orca?.worktree || coordinators.has(node.id)) continue;
    const coordinator = [...coordinators].map((id) => nodes.get(id)).filter((other) => other?.orca?.worktree === node.orca.worktree && other.id !== node.id)
      .filter((other) => (!other.startedAt || !node.updatedAt || node.updatedAt >= other.startedAt - limits.worktreeSlackMs)
        && (!node.startedAt || node.startedAt <= other.updatedAt + limits.worktreeSlackMs))
      .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))[0];
    if (coordinator) link(node.id, coordinator.id, "dispatched", { at: node.startedAt, strength: 40, source: "worktree" });
  }
  // 7. The scene's own party links (Orca worktrees a chat drives, proven Claude panes).
  for (const [member, chat] of input.joined instanceof Map ? input.joined : []) {
    const child = aliases.get(member) || member;
    if (nodes.has(child) && nodes.has(chat)) link(child, chat, "drives", { strength: 35, source: "party" });
  }
  // 8. What was learned before.
  for (const [child, remembered] of memory.parents instanceof Map ? memory.parents : []) {
    if (nodes.has(child) && nodes.has(remembered.parent)) link(child, remembered.parent, remembered.kind, { at: remembered.at, strength: 30, source: "memory" });
  }

  // Who waits on whom: a call to `orca orchestration ask` still running, or Orca's own record of it.
  for (const node of nodes.values()) {
    const up = parent.get(node.id)?.parent;
    const step = node.actor.now;
    const asking = step && !step.done && ORCA_ASK.test(String(step.detail || ""));
    const waiting = node.actor.waitingOn || (asking ? { at: step.startedAt } : null);
    if (!waiting || !up) continue;
    const same = asked.find((item) => item.from === node.id && item.to === up);
    if (same) same.waiting = true;
    else asked.push({ from: node.id, to: up, kind: "asked", at: Number(waiting.at) || 0, waiting: true });
  }

  // Trees: one task per root.
  const children = new Map();
  for (const [child, edge] of parent) children.set(edge.parent, [...(children.get(edge.parent) || []), child]);
  const roleOf = (id) => {
    const edge = parent.get(id);
    const below = (children.get(id) || []).filter((child) => parent.get(child)?.kind !== "spawned");
    if (edge?.kind === "spawned") return "subagent";
    if (!edge) return below.length ? (nodes.get(id).actor.source === "codex" ? "lead" : "coordinator") : (children.get(id)?.length ? "lead" : "solo");
    return below.length ? "coordinator" : "worker";
  };
  const tasks = [];
  const placed = new Set();
  for (const node of nodes.values()) {
    if (parent.has(node.id)) continue;
    const order = [];
    const walk = (id, depth) => {
      if (placed.has(id) || depth > 32) return;
      placed.add(id);
      order.push({ id, depth });
      const kids = (children.get(id) || []).map((child) => ({ child, role: roleOf(child), node: nodes.get(child) }))
        .sort((a, b) => (ROLE_ORDER[a.role] ?? 3) - (ROLE_ORDER[b.role] ?? 3) || (a.node.startedAt || a.node.updatedAt) - (b.node.startedAt || b.node.updatedAt));
      for (const { child } of kids) walk(child, depth + 1);
    };
    walk(node.id, 0);
    const members = order.map(({ id }) => nodes.get(id));
    const updatedAt = Math.max(0, ...members.map((member) => member.updatedAt));
    if (updatedAt < since) continue;
    const agents = order.map(({ id, depth }) => {
      const member = nodes.get(id);
      const edge = parent.get(id);
      const actor = listedAgent(member.actor);
      const terminal = own.get(id) || member.orca?.terminal || member.orcaAgent?.terminal;
      const worker = workerOf.get(id);
      const role = roleOf(id);
      const updated = Math.max(Number(actor.updatedAt) || 0, member.updatedAt);
      const orcaIds = { ...(terminal ? { terminal } : {}), ...(member.orca?.pane || member.orcaAgent?.pane ? { pane: member.orca?.pane || member.orcaAgent.pane } : {}),
        ...(member.orca?.worktree ? { worktree: member.orca.worktree } : {}), ...(worker?.task ? { task: worker.task } : {}), ...(worker?.run || edge?.run ? { run: worker?.run || edge.run } : {}),
        ...(worker?.coordinator ? { coordinator: worker.coordinator } : {}) };
      return {
        ...actor, id, role, depth, ...(edge ? { parentId: edge.parent } : {}), project: baseName(actor.cwd) || "",
        updatedAt: updated, ...(member.startedAt ? { startedAt: member.startedAt } : {}), seenBy: member.seenBy,
        ...(Object.keys(orcaIds).length ? { orca: orcaIds } : {}),
        // A subagent that finished over an hour ago: kept in its task, but the view may fold it away.
        ...(role === "subagent" && actor.attention !== "working" && actor.attention !== "needs" && updated < now - limits.staleSubagentMs ? { stale: true } : {}),
      };
    });
    const memberIds = new Set(order.map(({ id }) => id));
    // Membership links point from the one in charge to the one it runs; an "asked" link from the asker.
    const taskLinks = order.filter(({ id }) => parent.has(id)).map(({ id }) => {
      const edge = parent.get(id);
      const [from, to] = edge.kind === "asked" ? [id, edge.parent] : [edge.parent, id];
      return { from, to, kind: edge.kind, ...(edge.at ? { at: edge.at } : {}), ...(edge.source === "manual" ? { manual: true } : {}), ...(edge.run ? { run: edge.run } : {}) };
    });
    for (const item of asked) {
      if (!memberIds.has(item.from) || !memberIds.has(item.to)) continue;
      const same = taskLinks.find((other) => other.kind === "asked" && other.from === item.from && other.to === item.to);
      // `waiting`: it is waiting for that answer now.
      if (same) { if (item.waiting) same.waiting = true; continue; }
      taskLinks.push({ from: item.from, to: item.to, kind: "asked", ...(item.at ? { at: item.at } : {}), ...(item.waiting ? { waiting: true } : {}) });
    }
    const root = agents[0];
    const startedAt = Math.min(...members.map((member) => member.startedAt).filter(Boolean));
    tasks.push({
      id: root.id, title: root.name || "Untitled", project: root.project, updatedAt,
      ...(Number.isFinite(startedAt) ? { startedAt } : {}),
      status: taskStatus(agents), needs: agents.filter((agent) => agent.attention === "needs").length, working: agents.filter((agent) => agent.attention === "working").length,
      agents, links: taskLinks,
    });
  }
  tasks.sort((a, b) => b.updatedAt - a.updatedAt);
  // Evidence that may not last is remembered; the worktree rule is worked out again from remembered identities.
  const learned = [...parent].filter(([, edge]) => ["drives", "commands", "orca", "party", "orca-run"].includes(edge.source) && !edge.parent.startsWith("orca-agent:run:")
    && !edge.parent.startsWith("orca-agent:coordinator:"))
    .map(([child, edge]) => ({ child, parent: edge.parent, kind: edge.kind, at: edge.at }));
  const inWindow = [...nodes.values()].filter((node) => node.updatedAt >= since).length;
  return { tasks, aliases, learned: { parents: learned, identities }, counts: { agents: inWindow, tasks: tasks.length, nodes: nodes.size } };
}
