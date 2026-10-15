/**
 * The task view's routes: `GET /api/tasks`, `GET /api/transcript`, and `POST /api/app/open`, all for
 * this computer only (a paired phone keeps its summaries and is answered 403).
 *
 * TaskService gathers what each source already has, cheaply: Codex's chat list and the chats the scene
 * read recently, the Claude Code hook log and the projects folder's file list (with the first and last
 * 64 KB of each new or changed transcript), Orca's snapshot when it answers, the party links, and what
 * was learned before (TaskMemory). Building the list never reads a whole transcript; that happens only
 * for the one agent the person opens, a page at a time (lib/transcript.mjs).
 */
import { AGENT_ID, agentKind } from "./agent-detail.mjs";
import { recordedTranscript } from "./claude-detail.mjs";
import { claudePanePairs, identityMark, joinParties } from "./links.mjs";
import { orcaSource } from "./orca.mjs";
import { localOnlyRefusal } from "./phone.mjs";
import { publicView } from "./public-view.mjs";
import { TASK_LIMITS, buildTasks, claudeAddressing, claudeIdentities, parseWindow } from "./tasks.mjs";
import { TRANSCRIPT_LIMITS, decodeCursor, encodeCursor, orcaEntries } from "./transcript.mjs";

const error = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const settledOf = (promise, ms) => {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve({ late: true }), ms); timer.unref?.(); });
  return Promise.race([promise.then((value) => ({ value }), (failure) => ({ failure })), late]).finally(() => clearTimeout(timer));
};

/** Codex's state for the source chips, in plain words with what to do: { state, say }. Pure. */
export function codexSource(health, { listComplete = true, cutInWindow = false } = {}) {
  const state = health?.state || "unavailable";
  if (state === "ok") {
    return cutInWindow ? { state: "partial", say: "Codex lists more chats than Goblin Horde reads; the oldest in this window may be missing." }
      : { state: "ok", say: listComplete ? "Reading local Codex chats." : "Reading local Codex chats (the newest 2,000)." };
  }
  if (state === "not-installed") return { state: "not-installed", say: "Codex is not installed. It is optional." };
  if (state === "starting") return { state: "partial", say: "Starting Codex…" };
  return { state: "unavailable", say: health?.detail || "Codex could not be read. Use Reconnect Codex in the goblin menu." };
}

/** Claude Code's state for the source chips: whether its hook records activity, else transcripts only. Pure. */
export function claudeSource(hooks, { transcripts = 0, projects = true } = {}) {
  const connected = hooks?.state === "installed" && !hooks.broken && !hooks.disabled;
  if (connected) return { state: "ok", say: "Recording Claude Code activity on this computer." };
  if (!projects && hooks?.state === "missing") return { state: "not-installed", say: "Claude Code is not on this computer. It is optional." };
  const why = hooks?.disabled ? "Claude Code's hooks are turned off in its settings" : hooks?.broken ? "the Claude Code hook points to a missing file"
    : hooks?.state === "unreadable" ? "Claude Code's settings could not be read" : "Claude Code is not connected to Goblin Horde";
  const shown = transcripts ? "sessions show from their transcripts only and what they ask you is not known" : "what its sessions ask you is not known";
  return { state: "partial", say: `${why[0].toUpperCase()}${why.slice(1)}, so ${shown}. Connect it with: node goblin.mjs hooks install` };
}

export class TaskService {
  /**
   * Every source is injected, so tests run on fakes:
   *   codex: { listThreads(), listSpawned(since), actors() -> Map, requests(id), meta(id) -> { path, cwd, parentThreadId }, health() }
   *   claude: a ClaudeReader (taskFeed, detailRecords, recentWords); sessions: a ClaudeSessionIndex
   *   claudeTranscripts / codexTranscripts: lib/transcript.mjs readers
   *   orca: an OrcaReader; orcaRunning(): whether Orca's process is up
   *   links: the LinkStore; memory: a TaskMemory; settle(actor): dismissals
   *   scene(): the all-parties scene, which keeps the Codex chats in use read; hooks(): the hook report
   */
  constructor({ clock = Date.now, scene = null, codex, claude, sessions = null, claudeTranscripts = null, codexTranscripts = null, orca = null,
    orcaRunning = async () => null, links = { auto: new Map(), manual: new Map() }, memory = null, settle = (actor) => actor,
    hooks = () => ({ state: "installed" }), projectsExist = () => true, waitMs = 1500 } = {}) {
    Object.assign(this, { clock, scene, codex, claude, sessions, claudeTranscripts, codexTranscripts, orca, orcaRunning, links, memory, settle, hooks, projectsExist, waitMs });
    this.last = null; // { hours, at, response, aliases }
    this.pending = new Map(); // hours -> promise
    this.spawned = { at: -Infinity, since: 0, list: [], pending: null };
    this.orcaProcess = { at: -Infinity, running: null, pending: null };
    this.claudeMemo = { records: null, identities: new Map(), addressing: new Map() };
    this.savedAt = -Infinity;
  }

  /** Chats other chats spawned, listed at most every 30 s in the background (Codex lists them slowly). */
  async spawnedSince(since) {
    const now = this.clock();
    if (!this.codex?.listSpawned) return [];
    if ((now - this.spawned.at > 30_000 || since < this.spawned.since) && !this.spawned.pending) {
      this.spawned.pending = Promise.resolve().then(() => this.codex.listSpawned(since)).then((list) => {
        Object.assign(this.spawned, { at: this.clock(), since, list: Array.isArray(list) ? list : [] });
      }, () => { this.spawned.at = this.clock(); }).finally(() => { this.spawned.pending = null; });
    }
    if (this.spawned.pending && this.spawned.at === -Infinity) await settledOf(this.spawned.pending, this.waitMs);
    return this.spawned.list;
  }

  /** Orca's newest snapshot without waiting long for a slow command line. */
  async orcaSnapshot() {
    if (!this.orca) return null;
    const read = await settledOf(Promise.resolve().then(() => this.orca.snapshot()), this.waitMs);
    return read.value || this.orca.lastSnapshot?.() || null;
  }

  /** Whether Orca's process runs, asked only when its command line fails, at most every 30 s. */
  async orcaUp() {
    const now = this.clock();
    if (now - this.orcaProcess.at > 30_000 && !this.orcaProcess.pending) {
      this.orcaProcess.pending = Promise.resolve().then(() => this.orcaRunning()).then((running) => { this.orcaProcess.running = running; }, () => { this.orcaProcess.running = null; })
        .finally(() => { this.orcaProcess.at = this.clock(); this.orcaProcess.pending = null; });
    }
    if (this.orcaProcess.pending && this.orcaProcess.at === -Infinity) await settledOf(this.orcaProcess.pending, this.waitMs);
    return this.orcaProcess.running;
  }

  /** The hook log's Orca identities and orchestration commands, worked out again only when the log changed. */
  claudeEvidence() {
    let records = [];
    try { records = this.claude?.detailRecords?.() || []; } catch { records = []; }
    if (records !== this.claudeMemo.records && (records.length !== this.claudeMemo.count || records.at(-1)?.id !== this.claudeMemo.lastId)) {
      this.claudeMemo = { records, count: records.length, lastId: records.at(-1)?.id, identities: claudeIdentities(records), addressing: claudeAddressing(records) };
    }
    return this.claudeMemo;
  }

  /** GET /api/tasks: every task with activity in the window (see buildTasks), and each source's state. */
  async tasks({ window } = {}) {
    const hours = parseWindow(window);
    if (this.last?.hours === hours && this.clock() - this.last.at < 1000) return this.last.response;
    if (!this.pending.has(hours)) {
      this.pending.set(hours, this.build(hours).finally(() => this.pending.delete(hours)));
    }
    return this.pending.get(hours);
  }

  async build(hours) {
    const now = this.clock();
    const since = now - hours * 3_600_000;
    // The scene keeps the chats in use read (their asks, steps, and states); its last build is enough.
    if (this.scene) await settledOf(Promise.resolve().then(() => this.scene()), this.waitMs);
    const [threads, spawned, snapshot] = await Promise.all([
      // A slow chat list (a cold Codex takes seconds) is not waited for: the last one stands in meanwhile.
      settledOf(Promise.resolve().then(() => this.codex?.listThreads?.() || []), this.waitMs * 2),
      this.spawnedSince(since).catch(() => []),
      this.orcaSnapshot().catch(() => null),
    ]);
    let lastChats = null;
    try { lastChats = threads.late ? this.codex?.lastThreads?.() || null : null; } catch { lastChats = null; }
    const chats = Array.isArray(threads.value) ? threads.value : Array.isArray(lastChats) ? lastChats : [];
    let parties = [];
    try { parties = this.claude?.taskFeed?.() || []; } catch { parties = []; }
    let transcripts = [];
    try { transcripts = this.sessions?.list(since) || []; } catch { transcripts = []; }
    const evidence = this.claudeEvidence();
    const orcaOk = Boolean(snapshot && !snapshot.warning && !snapshot.missing);
    const orcaAgents = orcaOk ? snapshot.workspaces.flatMap((workspace) => workspace.agents) : [];
    let actors = new Map();
    try { actors = this.codex?.actors?.() || new Map(); } catch { actors = new Map(); }
    // The scene's party links over every member known, and the Orca panes proven to be Claude sessions.
    const claudeActors = parties.flatMap((party) => party.agents || []);
    const members = [...[...actors.values()].map((actor) => ({ ...actor, source: "codex" })), ...orcaAgents, ...claudeActors];
    const marks = { paneMarks: (pane) => { try { return this.orca?.marksFor?.(pane.id) || []; } catch { return []; } },
      sessionMarks: (agent) => { try { return (this.claude?.recentWords?.(agent.id) || []).map(identityMark).filter(Boolean); } catch { return []; } } };
    let pairs = new Map();
    let joined = new Map();
    try {
      pairs = orcaAgents.length ? claudePanePairs(members, marks) : new Map();
      const { membership } = joinParties(members, { auto: this.links.auto, manual: this.links.manual, pairs });
      joined = new Map([...membership].map(([id, member]) => [id, member.chat]));
    } catch { /* Without party links every agent stands on the other evidence. */ }
    const built = buildTasks({
      now, since,
      codex: { chats, spawned, actors, requests: (id) => { try { return this.codex?.requests?.(id) || []; } catch { return []; } } },
      claude: { parties, transcripts, identities: evidence.identities, addressing: evidence.addressing },
      orca: { agents: orcaAgents, pairs },
      links: { auto: this.links.auto, manual: this.links.manual },
      joined,
      memory: this.memory ? { identities: this.memory.identities, parents: this.memory.parents } : {},
      settle: (actor) => { try { return this.settle(actor); } catch { return actor; } },
    });
    this.learn(built.learned, evidence.identities);
    const running = orcaOk || !snapshot ? null : await this.orcaUp().catch(() => null);
    let health = { state: "unavailable" };
    try { health = this.codex?.health?.() || health; } catch { /* Shown as unavailable. */ }
    const listComplete = this.codex?.listComplete?.() !== false;
    const cutInWindow = !listComplete && Number(chats.at(-1)?.updatedAt) >= since;
    let hooks = { state: "missing" };
    try { hooks = this.hooks() || hooks; } catch { /* Unknown. */ }
    const response = {
      tasks: built.tasks,
      sources: {
        codex: threads.failure && health.state === "ok" ? { state: "unavailable", say: "The Codex chat list could not be read." }
          : threads.late && health.state === "ok" ? { state: "partial", say: lastChats ? "Codex is still listing its chats; this is the last list." : "Codex is still listing its chats." }
            : codexSource(health, { listComplete, cutInWindow }),
        claude: claudeSource(hooks, { transcripts: transcripts.length, projects: this.projectsExist() }),
        orca: orcaSource(snapshot, running),
      },
      window: { hours, since },
      checkedAt: now,
      aliases: Object.fromEntries(built.aliases),
      counts: built.counts,
    };
    this.last = { hours, at: this.clock(), response, aliases: built.aliases };
    return response;
  }

  /** Keep what this build learned (TaskMemory), written at most every 5 seconds. */
  learn(learned, identities) {
    if (!this.memory) return;
    for (const [session, orca] of identities || []) this.memory.noteIdentity(session, orca);
    for (const item of learned?.parents || []) this.memory.noteParent(item.child, item.parent, item.kind, item.at);
    if (this.clock() - this.savedAt >= 5000 && this.memory.dirty) {
      this.savedAt = this.clock();
      this.memory.save();
    }
  }

  /** The agent as the newest task list shows it (an Orca pane that is a Claude session by that session), or null. */
  async findAgent(id) {
    if (!this.last || this.clock() - this.last.at > 30_000) await this.tasks({ window: `${this.last?.hours || TASK_LIMITS.windowHours}h` });
    const real = this.last?.aliases?.get(id) || id;
    for (const task of this.last?.response.tasks || []) {
      const agent = task.agents.find((item) => item.id === real);
      if (agent) return { agent, task };
    }
    return null;
  }

  /**
   * Where an agent is in the task list, for opening the app window on it: { taskId, agentId } with the
   * id the list shows it by (an Orca pane that is a Claude Code session is that session), or null.
   */
  async place(agentId) {
    const found = await this.findAgent(String(agentId || ""));
    return found ? { taskId: found.task.id, agentId: found.agent.id } : null;
  }

  /** GET /api/transcript: one page of an agent's conversation (see lib/transcript.mjs). */
  async transcript({ id, after = "", before = "", limit, screen = false } = {}) {
    const kind = agentKind(id);
    if (!kind || kind === "extension") throw error(kind ? 404 : 400, kind ? "Extension agents have no transcript on this computer." : "Choose a valid agent.");
    if (after && before) throw error(400, "Ask for newer or older entries, not both.");
    const want = Math.max(1, Math.min(TRANSCRIPT_LIMITS.maxEntries, Number(limit) || TRANSCRIPT_LIMITS.pageEntries));
    const found = await this.findAgent(id);
    const realId = this.last?.aliases?.get(id) || id;
    const realKind = agentKind(realId);
    const agent = found?.agent || { id: realId, source: realKind, name: realId, role: "solo", depth: 0, attention: "quiet", status: "unknown", updatedAt: 0 };
    let page = null;
    let source = realKind;
    if (realKind === "claude") {
      const [, session, sub = ""] = AGENT_ID.claude.exec(realId);
      let records = [];
      try { records = this.claude?.detailRecords?.() || []; } catch { records = []; }
      page = this.claudeTranscripts?.page({ session, agent: sub, cwd: agent.cwd || "", recorded: recordedTranscript(records, session, sub), after, before, limit: want }) || null;
    } else if (realKind === "codex") {
      // Only a chat Codex lists, as /api/thread allows.
      if (!found) {
        let chats;
        try { chats = await this.codex?.listThreads?.(); } catch { throw error(503, "Codex is not available right now."); }
        if (!(chats || []).some((chat) => chat.id === realId) && !this.spawned.list.some((chat) => chat.id === realId)) throw error(404, "That chat is not available in this viewer.");
      }
      let meta = {};
      try { meta = (await this.codex?.meta?.(realId)) || {}; } catch { meta = {}; }
      try {
        page = await this.codexTranscripts?.page(realId, { after, before, limit: want, subagent: Boolean(meta.parentThreadId || agent.parentThreadId), cwd: meta.cwd || agent.cwd || "", path: meta.path || "" });
      } catch (failure) { throw error(502, `Codex could not read this chat: ${String(failure?.message || "no answer").slice(0, 200)}`); }
    } else if (realKind === "orca") {
      page = await this.orcaPage(realId, { after, screen });
    }
    if (!page) throw error(404, "This agent's transcript is not on this computer.");
    // The terminal screen, on request, for an agent Orca runs (only while Orca answers).
    if (screen && realKind !== "orca" && agent.orca?.terminal && this.orca?.screen) {
      const shown = await settledOf(Promise.resolve().then(() => this.orca.screen(agent.orca.terminal)), this.waitMs);
      if (shown.value?.lines?.length) page.entries = [...page.entries, ...orcaEntries([], { screen: shown.value })];
    }
    const now = this.clock();
    const live = agent.attention === "working" || agent.attention === "needs" || now - Number(agent.updatedAt || 0) < TASK_LIMITS.liveMs;
    return { agent: publicView({ agent }).agent, entries: page.entries, cursor: page.cursor, hasOlder: Boolean(page.hasOlder), live, checkedAt: now, source,
      ...(page.reset ? { reset: true } : {}) };
  }

  /** An Orca agent with no session of its own here: what Orca reported, newest last. */
  async orcaPage(id, { after = "", screen = false } = {}) {
    const snapshot = await this.orcaSnapshot();
    const agent = snapshot?.workspaces?.flatMap((workspace) => workspace.agents).find((item) => item.id === id);
    if (!agent) return null;
    const events = Array.isArray(agent.activities) ? agent.activities : [];
    const cursor = decodeCursor(after);
    const since = cursor?.k === "o" ? events.findIndex((event) => String(event.id) === cursor.id) : -1;
    const shown = since >= 0 ? events.slice(since + 1) : events;
    let lines = null;
    if (screen && agent.terminal && this.orca?.screen) lines = (await settledOf(Promise.resolve().then(() => this.orca.screen(agent.terminal)), this.waitMs)).value || null;
    const entries = orcaEntries(shown, { screen: lines });
    const newest = events.at(-1);
    return { entries, cursor: { first: "", last: encodeCursor({ k: "o", id: newest ? String(newest.id) : cursor?.id || "" }) }, hasOlder: false,
      ...(after && cursor?.k !== "o" ? { reset: true } : {}) };
  }
}

/**
 * The task view's routes as one handler for server.mjs; returns true when it answered. `GET /api/tasks`
 * and `GET /api/transcript` answer this computer only (403 for a paired phone); `POST /api/app/open`
 * takes the same local, Origin, and JSON checks as the other local routes. `open({ taskId, agentId })`
 * opens the app window (lib/app-window.mjs).
 */
export function taskRoutes(service, { open }) {
  return async function handleTaskRoute(request, response, { url, local, origin, json, readBody, fail = (res, status, message) => json(res, status, { error: message }) }) {
    const path = url.pathname;
    if ((path === "/api/tasks" || path === "/api/transcript") && request.method === "GET") {
      if (!local) { json(response, 403, { error: "Tasks are shown on this computer only." }); return true; }
      try {
        if (path === "/api/tasks") json(response, 200, publicView(await service.tasks({ window: url.searchParams.get("window") || "" }), { phone: false }));
        else {
          const params = url.searchParams;
          json(response, 200, await service.transcript({ id: params.get("id") || "", after: params.get("after") || "", before: params.get("before") || "",
            limit: params.get("limit") || "", screen: params.get("screen") === "1" }));
        }
      } catch (failure) { fail(response, failure.statusCode || 500, failure.statusCode ? failure.message : "Unable to read the tasks."); }
      return true;
    }
    if (path === "/api/app/open" && request.method === "POST") {
      const refusal = localOnlyRefusal({ local, origin, headers: request.headers });
      if (refusal) { json(response, refusal.status, { error: refusal.error }); return true; }
      try {
        const data = await readBody(request);
        let agentId = typeof data?.agentId === "string" ? data.agentId : "";
        let taskId = typeof data?.taskId === "string" ? data.taskId : "";
        if ((agentId && !agentKind(agentId)) || (taskId && !agentKind(taskId))) throw error(400, "Choose a valid task or agent.");
        // The goblin's own task, by the id the task list shows the goblin under.
        const placed = agentId ? await service.place(agentId) : null;
        if (placed) { agentId = placed.agentId; taskId ||= placed.taskId; }
        const opened = await open({ taskId, agentId });
        if (!opened?.opened) throw error(500, "The task view could not be opened on this computer.");
        json(response, 200, opened);
      } catch (failure) { fail(response, failure.statusCode || 500, failure.message || "The task view could not be opened."); }
      return true;
    }
    return false;
  };
}
