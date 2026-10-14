/**
 * One agent in full, and the controls to reach it: `GET /api/agent?id=`, `POST /api/open`,
 * `POST /api/message`. All three answer this computer only; a paired phone keeps its summaries.
 *
 * The detail is read from each agent's own records, only for the agent the person selected:
 * a Claude Code transcript (lib/claude-detail.mjs), a Codex chat's newest turns and session file
 * (lib/codex-detail.mjs), an Orca agent's screen, inbox and tasks (lib/orca.mjs). Each read is
 * bounded and remembered by file size and time, so the window's two-second poll of a quiet agent
 * costs a stat or two.
 *
 * Open brings the agent up in its own app: a Codex chat by its codex:// link, an Orca agent (or a
 * Claude Code session running in an Orca pane) by switching to its terminal, and a Claude Code
 * session the Claude desktop app runs by the app's own claude://code/continue link. That link
 * accepts only the app's own session ids ("local_…"), never a Claude Code session id, so the app's
 * session index is read (ids only) to find which of its sessions this one is. Links are opened
 * without a shell, after their ids are checked. Message types into an Orca terminal, or sends a
 * Codex reply the way /api/reply does.
 */
import { spawn as spawnProcess } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { open as openAsync, stat as statAsync } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";
import { isLocalPath } from "./paths.mjs";
import { classifyCodex } from "./feed.mjs";
import { recordedTranscript } from "./claude-detail.mjs";
import { codexDetail, spawnPromptFor } from "./codex-detail.mjs";
import { ORCA_AGENT_ID } from "./orca.mjs";
import { localOnlyRefusal } from "./phone.mjs";
import { publicView } from "./public-view.mjs";
import { baseName } from "./detail-text.mjs";

export const AGENT_ID = Object.freeze({
  codex: /^[A-Za-z0-9_-]{8,100}$/,
  claude: /^claude-agent:([A-Za-z0-9_-]{1,128})(?::([A-Za-z0-9_-]{1,128}))?$/,
  orca: ORCA_AGENT_ID,
  extension: /^ext-agent:[a-z0-9][a-z0-9-]{0,31}:[A-Za-z0-9_.-]{1,64}:[A-Za-z0-9_.-]{1,64}$/,
});

/** Which source an actor id belongs to, or "" for anything that is not a valid id. */
export function agentKind(id) {
  const value = String(id ?? "");
  if (value.length > 400) return "";
  if (AGENT_ID.claude.test(value)) return "claude";
  if (AGENT_ID.orca.test(value)) return "orca";
  if (AGENT_ID.extension.test(value)) return "extension";
  if (AGENT_ID.codex.test(value)) return "codex";
  return "";
}

const LINKS = [/^codex:\/\/threads\/[A-Za-z0-9_-]{8,100}$/, /^claude:\/\/code\/continue\?session=local_[A-Za-z0-9-]{1,64}$/];

/** Open one of the two app links this server makes, without a shell. False when it could not start. */
export function launchUrl(url, { platform = process.platform, spawn = spawnProcess } = {}) {
  if (!LINKS.some((pattern) => pattern.test(String(url)))) return false;
  const [command, args] = platform === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
    : platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on?.("error", () => {});
    child.unref?.();
    return true;
  } catch { return false; }
}

/** Where the Claude desktop app keeps its Claude Code sessions' index files. */
export function claudeDesktopSessionsDir({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "Claude", "claude-code-sessions");
  if (platform === "darwin") return join(home, "Library", "Application Support", "Claude", "claude-code-sessions");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "Claude", "claude-code-sessions");
}

const DESKTOP_SESSION = /^local_[A-Za-z0-9-]{1,64}$/;
const CLI_SESSION = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Which Claude desktop app session runs a given Claude Code session. Only three fields of each
 * `local_*.json` index file are kept: the app's session id, the Claude Code session id it wraps,
 * and whether it is archived. Rescanned at most every 30 seconds; unchanged files are not reread.
 */
export class ClaudeDesktopIndex {
  constructor({ dir = claudeDesktopSessionsDir(), clock = Date.now, ttlMs = 30_000, maxFiles = 500, maxBytes = 512 * 1024,
    fs = { readdir: (path) => readdirSync(path, { withFileTypes: true }), stat: (path) => statSync(path), read: (path) => readFileSync(path, "utf8") } } = {}) {
    Object.assign(this, { dir, clock, ttlMs, maxFiles, maxBytes, fs });
    this.at = null; // when the index was last scanned
    this.files = new Map(); // path -> { mtimeMs, size, entry }
    this.byCli = new Map();
  }

  refresh() {
    if (this.at !== null && this.clock() - this.at < this.ttlMs) return;
    this.at = this.clock();
    const found = [];
    const walk = (dir, depth) => {
      if (depth > 3 || found.length >= this.maxFiles) return;
      let entries = [];
      try { entries = this.fs.readdir(dir); } catch { return; }
      for (const entry of entries) {
        if (found.length >= this.maxFiles) return;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path, depth + 1);
        else if (/^local_[A-Za-z0-9-]{1,64}\.json$/.test(entry.name)) found.push(path);
      }
    };
    walk(this.dir, 0);
    const byCli = new Map();
    const files = new Map();
    for (const path of found) {
      let info;
      try { info = this.fs.stat(path); } catch { continue; }
      let saved = this.files.get(path);
      if (!saved || saved.mtimeMs !== info.mtimeMs || saved.size !== info.size) {
        let entry = null;
        if (info.size <= this.maxBytes) {
          try {
            const data = JSON.parse(this.fs.read(path));
            if (DESKTOP_SESSION.test(String(data?.sessionId)) && CLI_SESSION.test(String(data?.cliSessionId)))
              entry = { sessionId: data.sessionId, cliSessionId: data.cliSessionId, archived: data.isArchived === true, at: Number(data.lastActivityAt) || 0 };
          } catch { entry = null; }
        }
        saved = { mtimeMs: info.mtimeMs, size: info.size, entry };
      }
      files.set(path, saved);
      const entry = saved.entry;
      if (!entry || entry.archived) continue;
      const previous = byCli.get(entry.cliSessionId);
      if (!previous || entry.at > previous.at) byCli.set(entry.cliSessionId, entry);
    }
    this.files = files;
    this.byCli = byCli;
  }

  /** The claude:// link that opens this Claude Code session in the desktop app, or "". */
  linkFor(cliSessionId) {
    if (!CLI_SESSION.test(String(cliSessionId || ""))) return "";
    try { this.refresh(); } catch { return ""; }
    const entry = this.byCli.get(cliSessionId);
    return entry ? `claude://code/continue?session=${entry.sessionId}` : "";
  }
}

const fold = (path) => String(path || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/**
 * The Orca pane a Claude Code session runs in: the only Claude pane with a terminal in the
 * session's folder, when the session is also the only Claude Code session there. Pure.
 */
export function orcaTwin(actor, orcaAgents, claudeMains) {
  if (!actor?.cwd) return null;
  const where = fold(actor.cwd);
  const panes = (orcaAgents || []).filter((agent) => agent?.terminal && fold(agent.cwd) === where
    && /^claude\b/i.test(String(agent.role || "")) && agent.status !== "unavailable");
  const sessions = (claudeMains || []).filter((agent) => fold(agent?.cwd) === where);
  return panes.length === 1 && sessions.length <= 1 ? panes[0] : null;
}

/** The first few kilobytes of a small regular file, read without holding up the server. */
async function readSmallFile(path, maxBytes = 4096) {
  const info = await statAsync(path);
  if (!info.isFile()) throw new Error("Not a file.");
  const handle = await openAsync(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(maxBytes, info.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
}

const absolutePath = (path) => win32.isAbsolute(path) || posix.isAbsolute(path);

/**
 * The branch checked out in a folder, from its .git (a worktree's .git file points to its gitdir).
 * The folder comes from an agent's own records, so only an ordinary local folder is read, never a
 * network share or a device path (a share's read can freeze for many seconds and offers this
 * account's Windows sign-in to that server), and the read is asynchronous and a few kilobytes at most.
 */
export async function gitBranch(cwd, { read = readSmallFile } = {}) {
  if (!isLocalPath(cwd)) return "";
  try {
    let gitDir = join(cwd, ".git");
    let head;
    try { head = await read(join(gitDir, "HEAD")); } catch {
      const pointer = /^gitdir:\s*(.+)$/m.exec(await read(gitDir));
      if (!pointer) return "";
      const target = pointer[1].trim();
      gitDir = absolutePath(target) ? target : resolve(cwd, target);
      if (!isLocalPath(gitDir)) return "";
      head = await read(join(gitDir, "HEAD"));
    }
    const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(String(head));
    return ref ? ref[1].trim().slice(0, 200) : "";
  } catch { return ""; }
}

// A branch read is trusted this long; a folder with no branch (or one that could not be read) is
// not tried again for longer. A read still running after BRANCH_WAIT_MS is not waited for.
const BRANCH_MS = 10_000;
const NO_BRANCH_MS = 60_000;
const BRANCH_WAIT_MS = 300;

const error = (statusCode, message, extra = {}) => Object.assign(new Error(message), { statusCode, extra });
const working = (actor) => actor?.attention === "working" || ["active", "working", "running"].includes(String(actor?.status || "").toLowerCase());
const asking = (actor) => actor?.attention === "needs";

export class AgentDetailService {
  /**
   * scene(): the all-parties scene; codex: { listThreads, latestTurns, readThread, canView, sendReply,
   * listRequests }; claude: { snapshot, records }; orca: an OrcaReader; extensions: { snapshot };
   * claudeDetail: a ClaudeDetailReader; codexPlans: a CodexPlanReader; desktop: a ClaudeDesktopIndex;
   * launch(url): opens an app link. Every reader is injected so tests run on fakes.
   */
  constructor({ scene, codex, claude, orca, extensions, claudeDetail, codexPlans, desktop, launch = launchUrl, clock = Date.now,
    stat = (path) => statSync(path), branch = gitBranch, branchWaitMs = BRANCH_WAIT_MS } = {}) {
    Object.assign(this, { scene, codex, claude, orca, extensions, claudeDetail, codexPlans, desktop, launch, clock, stat, branch, branchWaitMs });
    this.codexCache = new Map(); // chat id -> { key, thread, at }
    this.branches = new Map(); // cwd -> { at, branch, pending }
  }

  async sceneAgents() {
    try { return (await this.scene?.())?.agents || []; } catch { return []; }
  }

  async orcaAgents() {
    try { return (await this.orca?.snapshot())?.workspaces?.flatMap((workspace) => workspace.agents) || []; } catch { return []; }
  }

  claudeAgents() {
    try { return this.claude?.snapshot()?.sessions?.flatMap((session) => session.agents) || []; } catch { return []; }
  }

  /** The actor as the scene shows it; one the scene cut is looked up in its own source. */
  async findActor(id, kind) {
    const everyone = await this.sceneAgents();
    const shown = everyone.find((agent) => agent.id === id);
    if (shown) return { actor: shown, everyone };
    let actor = null;
    if (kind === "codex") {
      if (!(await this.codex.canView(id))) throw error(404, "That chat is not available in this viewer.");
      actor = await this.codex.readThread(id);
      if (actor) actor = { ...actor, attention: classifyCodex(actor, { hasRequest: this.codex.listRequests(id).length > 0 || Boolean(actor.awaitingApproval), now: this.clock() }) };
    } else if (kind === "claude") actor = this.claudeAgents().find((agent) => agent.id === id) || null;
    else if (kind === "orca") actor = (await this.orcaAgents()).find((agent) => agent.id === id) || null;
    else if (kind === "extension") {
      try { actor = this.extensions.snapshot().sessions.flatMap((party) => party.agents).find((agent) => agent.id === id) || null; } catch { actor = null; }
    }
    return actor ? { actor, everyone } : null;
  }

  /**
   * A folder's branch, remembered with its failures: a folder with no repository costs one read a
   * minute, and one folder never has two reads at once. Only a local folder is read at all, and a
   * slow read is not waited for past branchWaitMs; the next poll has its answer.
   */
  async cachedBranch(cwd) {
    if (!isLocalPath(cwd)) return "";
    let saved = this.branches.get(cwd);
    const fresh = saved && (saved.pending || this.clock() - saved.at < (saved.branch ? BRANCH_MS : NO_BRANCH_MS));
    if (!fresh) {
      const entry = { at: this.clock(), branch: saved?.branch || "", pending: null };
      entry.pending = Promise.resolve().then(() => this.branch(cwd)).catch(() => "").then((branch) => {
        Object.assign(entry, { at: this.clock(), branch: typeof branch === "string" ? branch : "", pending: null });
        return entry.branch;
      });
      this.branches.delete(cwd);
      this.branches.set(cwd, entry);
      if (this.branches.size > 100) this.branches.delete(this.branches.keys().next().value);
      saved = entry;
    }
    if (!saved.pending) return saved.branch;
    let timer;
    const late = new Promise((done) => { timer = setTimeout(() => done(saved.branch), this.branchWaitMs); timer.unref?.(); });
    try { return await Promise.race([saved.pending, late]); } finally { clearTimeout(timer); }
  }

  /** A chat's raw newest turns, reread only when its time or its session file changed. */
  async codexTurns(id, updatedAt) {
    const saved = this.codexCache.get(id);
    const keyFor = (path) => {
      let key = String(updatedAt || 0);
      if (path) { try { const info = this.stat(String(path).replace(/^\\\\\?\\/, "")); key += `|${info.size}|${info.mtimeMs}`; } catch { /* No file to compare. */ } }
      return key;
    };
    if (saved && saved.key === keyFor(saved.thread?.path) && this.clock() - saved.at < 60_000) return saved.thread;
    const thread = await this.codex.latestTurns(id, 3);
    this.codexCache.set(id, { key: keyFor(thread?.path), thread, at: this.clock() });
    if (this.codexCache.size > 32) this.codexCache.delete(this.codexCache.keys().next().value);
    return thread;
  }

  async partyOf(actor, kind, everyone) {
    const id = String(actor.parentThreadId || actor.id);
    let name = everyone.find((agent) => agent.id === id)?.name || "";
    let coordinatorId = "";
    if (kind === "codex" && actor.parentThreadId && !actor.joined) coordinatorId = actor.parentThreadId;
    if ((kind === "claude" || kind === "extension") && actor.childOf) coordinatorId = actor.childOf;
    if (kind === "orca" && actor.parentPane) coordinatorId = `orca-agent:${actor.parentPane}`;
    if (!name && AGENT_ID.codex.test(id)) {
      try { name = (await this.codex.listThreads()).find((thread) => thread.id === id)?.name || ""; } catch { name = ""; }
    }
    if (!name && kind === "claude") name = this.claudeAgents().find((agent) => agent.parentThreadId === id && !agent.childOf)?.name || "";
    if (!name && kind === "orca") {
      try { name = (await this.orca.snapshot()).workspaces.find((workspace) => workspace.id === id)?.name || ""; } catch { name = ""; }
    }
    if (!name && kind === "extension") name = actor.workflowName || "";
    return { id, name: name || actor.name || "", ...(coordinatorId ? { coordinatorId } : {}) };
  }

  /** How the person can reach this agent, and what Open and Message would do. */
  async controlsFor(actor, kind) {
    const dismiss = Boolean(actor.ask);
    const orcaOpen = { kind: "orca-terminal", label: "Open in Orca" };
    const orcaSend = { kind: "orca-send", label: "Message", hint: "Types into its terminal and presses Enter" };
    if (kind === "codex") {
      return { open: { kind: "codex-link", label: "Open in Codex" },
        message: actor.parentThreadId ? null : { kind: "codex-reply", label: "Message", hint: "Sends a new message to this chat" }, dismiss };
    }
    if (kind === "orca") return { open: actor.terminal ? orcaOpen : null, message: actor.terminal ? orcaSend : null, dismiss };
    if (kind === "claude") {
      const [, session, agent] = AGENT_ID.claude.exec(actor.id) || [];
      const twin = await this.twinFor(actor);
      if (twin) return { open: orcaOpen, message: agent ? null : orcaSend, dismiss };
      const link = this.desktop?.linkFor(session) || "";
      return { open: link ? { kind: "claude-link", label: "Open in Claude" } : null, message: null, dismiss };
    }
    return { open: null, message: null, dismiss };
  }

  async twinFor(actor) {
    const [, session] = AGENT_ID.claude.exec(actor.id) || [];
    const claudeAgents = this.claudeAgents();
    const main = claudeAgents.find((agent) => agent.id === `claude-agent:${session}`) || actor;
    return orcaTwin(main, await this.orcaAgents(), claudeAgents.filter((agent) => agent.source === "claude" && !agent.childOf));
  }

  /** The detail response for one actor id (SPEC section B). Throws with statusCode on bad ids. */
  async detail(id) {
    const kind = agentKind(id);
    if (!kind) throw error(400, "Choose a valid agent.");
    const found = await this.findActor(id, kind);
    if (!found) throw error(404, "That agent is not in view any more.");
    const { actor, everyone } = found;
    let parts = { mission: null, plan: null, now: null, said: null, trail: [], files: [], screen: null };
    let branch = "";
    let startedAt = 0;
    if (kind === "claude") {
      const [, session, agent = ""] = AGENT_ID.claude.exec(id);
      let records = [];
      try { records = this.claude.records?.() || []; } catch { records = []; }
      const recorded = recordedTranscript(records, session, agent);
      const read = this.claudeDetail?.read({ session, agent, cwd: actor.cwd, recorded }) || null;
      if (read) {
        const busy = working(actor) || asking(actor);
        const now = read.now && busy ? read.now : working(actor) ? { kind: "think", title: "Thinking", startedAt: read.lastAt || Number(actor.updatedAt) || 0 } : null;
        parts = { ...parts, mission: read.mission, plan: read.plan, now, said: read.said, trail: read.trail, files: read.files };
        branch = read.branch;
        startedAt = read.startedAt;
      }
    } else if (kind === "codex") {
      let summary = null;
      try { summary = (await this.codex.listThreads()).find((thread) => thread.id === id) || null; } catch { summary = null; }
      const thread = await this.codexTurns(id, summary?.updatedAt ?? actor.updatedAt);
      const last = actor.turnStates?.at(-1);
      const active = working(actor) || String(last?.status || "").toLowerCase() === "inprogress" || Boolean(actor.runningElsewhere);
      const subagent = Boolean(actor.parentThreadId) && !actor.joined;
      let parentMission = null;
      if (subagent && AGENT_ID.codex.test(actor.parentThreadId) && !(thread?.turns || []).some((turn) => (turn.items || []).some((item) => item?.type === "userMessage"))) {
        try { parentMission = spawnPromptFor(await this.codexTurns(actor.parentThreadId, 0), id); } catch { parentMission = null; }
      }
      const plan = this.codexPlans?.read(thread?.path) || null;
      parts = { ...parts, ...codexDetail(thread, { cwd: actor.cwd || thread?.cwd, active, subagent, parentMission, plan }) };
      startedAt = Number(thread?.createdAt) ? (Number(thread.createdAt) < 1e12 ? Number(thread.createdAt) * 1000 : Number(thread.createdAt)) : 0;
    } else if (kind === "orca") {
      const read = await this.orca.detail(id);
      if (read) parts = { ...parts, mission: read.mission, plan: read.plan, now: read.now, said: read.said, trail: read.trail, files: read.files, screen: read.screen };
    }
    if (!parts.now && actor.now && (working(actor) || asking(actor))) parts.now = actor.now;
    // An extension feed's folder is whatever any program wrote into the feed: never read it.
    if (!branch && kind !== "extension") branch = await this.cachedBranch(actor.cwd);
    const agent = {
      ...actor,
      project: baseName(actor.cwd) || "",
      ...(branch ? { branch } : {}),
      party: await this.partyOf(actor, kind, everyone),
      ...(startedAt ? { startedAt } : {}),
      controls: await this.controlsFor(actor, kind),
    };
    return { agent, ...parts, checkedAt: this.clock() };
  }

  /** Bring the agent up in its own app (SPEC section C). */
  async open(id) {
    const kind = agentKind(id);
    if (!kind) throw error(400, "Choose a valid agent.");
    if (kind === "codex") {
      if (!(await this.codex.canView(id))) throw error(404, "That chat is not available in this viewer.");
      if (!this.launch(`codex://threads/${id}`)) throw error(500, "Codex could not be opened on this computer.");
      return { opened: true, kind: "codex-link" };
    }
    const found = await this.findActor(id, kind);
    if (!found) throw error(404, "That agent is not in view any more.");
    if (kind === "orca") {
      if (!found.actor.terminal) throw error(409, "This Orca agent has no terminal to open.");
      await this.orca.switchTo(found.actor.terminal);
      return { opened: true, kind: "orca-terminal" };
    }
    if (kind === "claude") {
      const twin = await this.twinFor(found.actor);
      if (twin) {
        await this.orca.switchTo(twin.terminal);
        return { opened: true, kind: "orca-terminal" };
      }
      const [, session] = AGENT_ID.claude.exec(id);
      const link = this.desktop?.linkFor(session) || "";
      if (link && this.launch(link)) return { opened: true, kind: "claude-link" };
      throw error(409, "Goblin Horde cannot bring this Claude Code session up: it runs in a terminal outside Orca and the Claude app. Switch to that terminal.");
    }
    throw error(409, "Open this agent in the tool that runs it.");
  }

  /** Send the person's words to the agent (SPEC section C). */
  async message(id, text) {
    const kind = agentKind(id);
    if (!kind) throw error(400, "Choose a valid agent.");
    const words = typeof text === "string" ? text.trim() : "";
    if (!words || words.length > 4000) throw error(400, "Write a message of up to 4,000 characters.");
    if (kind === "codex") {
      if (!(await this.codex.canView(id))) throw error(404, "That chat is not available in this viewer.");
      const found = await this.findActor(id, kind);
      if (found?.actor?.parentThreadId && !found.actor.joined) throw error(409, "This is a helper chat that reports to another chat. Message the chat that started it.");
      try { return { sent: true, threadId: id, ...(await this.codex.sendReply(id, words)) }; } catch (failure) {
        if (/already has an active writer/i.test(failure.message))
          throw error(409, "This chat is open in the Codex app. Open it there to send this message.", { requiresOpen: true });
        throw failure;
      }
    }
    const found = await this.findActor(id, kind);
    if (!found) throw error(404, "That agent is not in view any more.");
    if (kind === "orca") {
      if (!found.actor.terminal) throw error(409, "This Orca agent has no terminal to type into.");
      await this.orca.send(found.actor.terminal, words);
      return { sent: true, kind: "orca-send" };
    }
    if (kind === "claude") {
      const [, , agent] = AGENT_ID.claude.exec(id);
      const twin = agent ? null : await this.twinFor(found.actor);
      if (twin) {
        await this.orca.send(twin.terminal, words);
        return { sent: true, kind: "orca-send" };
      }
      throw error(409, agent ? "Subagents take their instructions from the session that started them." : "Message this Claude Code session in Claude Code itself.");
    }
    throw error(409, "Extension agents are watch-only. Message them in the tool that runs them.");
  }
}

/**
 * The three routes as one handler for server.mjs: returns true when it answered the request.
 * `/api/agent` is GET from this computer only (403 for a paired phone); `/api/open` and
 * `/api/message` are POSTs with the same local, Origin, and JSON checks as the other local routes.
 */
export function agentRoutes(service) {
  return async function handleAgentRoute(request, response, { url, local, origin, json, readBody, fail = (res, status, message) => json(res, status, { error: message }) }) {
    const path = url.pathname;
    if (path === "/api/agent") {
      if (request.method !== "GET") return false;
      if (!local) { json(response, 403, { error: "Agent details are shown on this computer only." }); return true; }
      try { json(response, 200, publicView(await service.detail(url.searchParams.get("id") || ""), { phone: false })); }
      catch (failure) { fail(response, failure.statusCode || 500, failure.statusCode ? failure.message : "Unable to read this agent."); }
      return true;
    }
    if ((path === "/api/open" || path === "/api/message") && request.method === "POST") {
      const refusal = localOnlyRefusal({ local, origin, headers: request.headers });
      if (refusal) { json(response, refusal.status, { error: refusal.error }); return true; }
      try {
        const data = await readBody(request);
        const id = String(data?.id || "");
        const result = path === "/api/open" ? await service.open(id) : await service.message(id, data?.text);
        json(response, 200, result);
      } catch (failure) {
        if (failure.extra && Object.keys(failure.extra).length) json(response, failure.statusCode || 500, { error: failure.message, ...failure.extra });
        else fail(response, failure.statusCode || 500, failure.message || "That did not work.");
      }
      return true;
    }
    return false;
  };
}
