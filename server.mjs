import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { markRunningElsewhere, transformThread } from "./lib/transform.mjs";
import { withApprovalGuess } from "./lib/rollout.mjs";
import { readDescendants } from "./lib/descendants.mjs";
import { classifyCodex, composeAllScene, listedThread, noteReadFailure, planCodexReads, pruneCache } from "./lib/feed.mjs";
import { WatchList } from "./lib/watch.mjs";
import { DiscoveryGate, LinkStore, drivenTerminals, joinParties, joinSubset } from "./lib/links.mjs";
import { OrcaReader } from "./lib/orca.mjs";
import { ClaudeReader, goblinStateDir } from "./lib/claude.mjs";
import { ExtensionReader, EXTENSION_PARTY, extensionFeedDir } from "./lib/extension.mjs";
import { claudeHookReport, claudeSettingsPath, installClaudeHooks } from "./lib/claude-hooks.mjs";
import { diagnosticReport } from "./lib/diagnostics.mjs";
import { removeShortcut, shortcutPaths, shortcutSpec, writeShortcut } from "./lib/shortcuts.mjs";
import { claudeConfigDir } from "./lib/paths.mjs";
import { CODEX_NOT_FOUND, codexCommand, codexSourceState } from "./lib/codex-bin.mjs";
import { Pairing, sessionCookie } from "./lib/pairing.mjs";
import { PhoneAccess, loadPairingCode, localOnlyRefusal } from "./lib/phone.mjs";
import { publicRequests, publicView } from "./lib/public-view.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const publicDir = resolve(here, "public");
const port = Number(process.env.PORT || 43917);
const host = "127.0.0.1";
const version = JSON.parse(readFileSync(join(here, "package.json"), "utf8")).version || "0.0.0";
// The manager passes a random instance id so `goblin stop` can tell this copy from any other server on the port.
const instance = /^[a-f0-9]{16,64}$/.test(process.env.GOBLIN_HORDE_INSTANCE || "") ? process.env.GOBLIN_HORDE_INSTANCE : "";
const stateDir = goblinStateDir();
// Phone access is off until the person turns it on (phone.json); see lib/phone.mjs.
const pairing = new Pairing({ code: loadPairingCode(stateDir) });
const phone = new PhoneAccess({ stateDir, port, pairing, handler: (request, response) => safeHandler(request, response) });
const defaultThreadId = process.env.CODEX_VIEWER_THREAD_ID || "all";

// Turns read per chat: the all-parties view needs only the latest work; an opened chat shows more.
const OVERVIEW_TURNS = 3;
const SCENE_TURNS = 8;

class CodexReader {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.resumedThreads = new Set();
    this.sending = new Set();
    this.serverRequests = new Map();
    this.threadReads = new Map();
    this.threadAttempts = new Map();
    this.threadFailures = new Map();
    this.threadSeen = new Set(); // Chats read at least once since start; see planCodexReads.
    this.process = null;
    this.generation = 0;
    this.restarts = 0; // Failed starts in a row; the wait before the next one doubles with each.
    this.restartTimer = null;
    this.closing = false;
    this.health = { state: "starting", since: Date.now(), lastError: "", restartedAt: 0, nextRetryAt: 0 };
    this.start();
  }

  /**
   * Start (or restart) the Codex app-server. A Codex that stops or cannot start is retried on its
   * own, after 5 seconds and then up to a minute apart, so a crash or an update to the Codex CLI does
   * not leave the viewer without Codex chats until it is restarted. `reconnect()` retries at once.
   */
  start() {
    const generation = ++this.generation;
    this.problem = "";
    this.serverRequests.clear(); // Approvals belonged to the old process; it can no longer answer them.
    this.resumedThreads.clear();
    this.process = null;
    const current = () => generation === this.generation;
    try {
      const codex = codexCommand(["app-server", "--listen", "stdio://"]);
      this.process = spawn(codex.command, codex.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, ...codex.options,
        ...(Object.keys(codex.env).length ? { env: { ...process.env, ...codex.env } } : {}) });
    } catch {
      // Node refuses some programs synchronously (a .cmd it cannot quote); treat that like a missing CLI.
      this.problem = "Codex could not be started.";
    }
    if (this.process) {
      const child = this.process;
      createInterface({ input: child.stdout }).on("line", (line) => { if (current()) this.onLine(line); });
      child.stderr.on("data", () => {});
      child.stdin.on("error", () => {});
      child.on("error", (error) => {
        if (!current()) return;
        this.problem = error.code === "ENOENT" ? CODEX_NOT_FOUND : "Codex could not be started.";
        this.failAll(error);
        this.scheduleRestart(this.problem);
      });
      child.on("exit", (code) => {
        if (!current()) return;
        // Windows reports a killed process as 4294967295; only a small exit code says anything.
        this.problem ||= code > 0 && code < 256 ? `Codex stopped (exit code ${code}).` : "Codex stopped.";
        this.failAll(new Error(`Codex app-server exited (${code})`));
        this.scheduleRestart(this.problem);
      });
    } else {
      this.scheduleRestart(this.problem);
    }
    this.pagedTurns = undefined; // A Codex updated since the last start may now page its history.
    if (this.process) this.health = { ...this.health, state: this.restarts ? "restarting" : "starting", since: Date.now() };
    this.ready = this.request("initialize", {
      clientInfo: { name: "goblin_horde", title: "Goblin Horde", version },
      capabilities: { experimentalApi: true },
    }).then(() => {
      this.notify("initialized");
      if (!current()) return;
      this.restarts = 0;
      this.health = { ...this.health, state: "ready", since: Date.now(), lastError: "", nextRetryAt: 0 };
    });
    // Codex is optional: callers still await `ready` and see the failure. A Codex that never answered
    // initialize (or refused it) is stopped and retried, as one that exited would be.
    this.ready.catch((error) => {
      if (!current() || !this.process) return;
      const child = this.process;
      this.generation++; // Its exit is now expected, not news.
      try { child.kill(); } catch { /* Already gone. */ }
      this.problem = `Codex did not start (${error.message}).`;
      this.failAll(error);
      this.scheduleRestart(this.problem);
    });
  }

  scheduleRestart(reason) {
    if (this.closing || this.restartTimer) return;
    const wait = Math.min(60_000, 5000 * 2 ** this.restarts);
    this.restarts++;
    this.health = { ...this.health, state: "unavailable", since: Date.now(), lastError: reason, nextRetryAt: Date.now() + wait };
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.health.restartedAt = Date.now();
      this.start();
    }, wait);
    this.restartTimer.unref?.();
  }

  /** Retry Codex now: the person pressed reconnect. */
  reconnect() {
    if (this.closing) return this.health;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.restarts = 0;
    const old = this.process;
    this.generation++; // The old process's exit is no longer this reader's news.
    try { old?.kill(); } catch { /* Already gone. */ }
    this.failAll(new Error("Reconnecting to Codex."));
    this.health.restartedAt = Date.now();
    this.start();
    return this.health;
  }

  onLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method && message.id != null) {
      this.serverRequests.set(String(message.id), { id: message.id, method: message.method, params: message.params || {} });
      return;
    }
    if (message.method === "serverRequest/resolved") {
      this.serverRequests.delete(String(message.params?.requestId));
      return;
    }
    if (message.id == null) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message || "Codex request failed"));
    else pending.resolve(message.result);
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  notify(method, params) {
    this.process?.stdin.write(`${JSON.stringify({ method, ...(params ? { params } : {}) })}\n`);
  }

  request(method, params = {}) {
    const id = this.nextId++;
    if (this.problem) return Promise.reject(new Error(this.problem));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  /**
   * A chat's details and only its newest turns. Long chats can hold hundreds of megabytes of history
   * (Codex marks them `historyMode: "paginated"`), so the full history is never loaded: a
   * metadata-only read plus one page of `thread/turns/list`, newest first. A Codex too old for
   * `thread/turns/list` falls back to the full read.
   */
  async latestTurns(threadId, limit) {
    if (this.pagedTurns !== false) {
      const [meta, page] = await Promise.allSettled([
        this.request("thread/read", { threadId, includeTurns: false }),
        this.request("thread/turns/list", { threadId, limit, itemsView: "full", sortDirection: "desc" }),
      ]);
      if (meta.status === "rejected") throw meta.reason;
      if (page.status === "fulfilled") {
        this.pagedTurns = true;
        return { ...meta.value.thread, turns: [...(page.value.data || [])].reverse() };
      }
      // Only a Codex that has never answered a page and does not know the method gets the old full read.
      if (this.pagedTurns || !/method|unknown variant|not supported|unsupported/i.test(page.reason.message)) throw page.reason;
      this.pagedTurns = false;
    }
    const result = await this.request("thread/read", { threadId, includeTurns: true });
    return { ...result.thread, turns: (result.thread?.turns || []).slice(-limit) };
  }

  async readThread(threadId, { turns = SCENE_TURNS } = {}) {
    await this.ready;
    const thread = await this.latestTurns(threadId, turns);
    links.observe(threadId, drivenTerminals(thread.turns));
    // A turn running in the Codex app may be held on an approval this reader never sees; its session
    // file can tell, however long ago the chat last changed (the timestamp freezes while it waits).
    return withApprovalGuess(markRunningElsewhere(transformThread(thread)), thread.path);
  }

  /**
   * Learn which chat drives an Orca pane nobody is known to drive yet. A chat is only read while in
   * use, so one that started Opus and is now quiet would never be noticed: scan recently updated
   * chats (their newest turns, command lines only), a few per run, each at most every 10 minutes.
   * Runs in the background (see `discovery`); returns how many links it learned.
   */
  async discoverLinks(threads, unlinked, { now = Date.now(), budget = 4 } = {}) {
    if (!unlinked) return 0;
    this.linkScans ||= new Map();
    const due = threads.filter((thread) => now - Number(thread.updatedAt) < 24 * 60 * 60_000
      && now - (this.linkScans.get(thread.id) || 0) > 10 * 60_000).slice(0, budget);
    let learned = 0;
    for (const thread of due) {
      this.linkScans.set(thread.id, now);
      try {
        const page = await this.latestTurns(thread.id, 6);
        if (links.observe(thread.id, drivenTerminals(page.turns))) learned++;
      } catch { /* A chat that cannot be read is tried again later. */ }
    }
    for (const id of this.linkScans.keys()) if (!threads.some((thread) => thread.id === id)) this.linkScans.delete(id);
    return learned;
  }

  /** Check the chats in use or watched; reuse saved checks for the rest. */
  async checkThreadsForOverview(threads, watched = new Set()) {
    const now = Date.now();
    const mustIds = new Set([...this.serverRequests.values()].map((item) => String(item.params.threadId || "")).filter(Boolean));
    const plan = planCodexReads(threads, { now, cache: this.threadReads, attempts: this.threadAttempts, mustIds, watched,
      failures: this.threadFailures, seen: this.threadSeen });
    const fresh = [];
    let failed = 0;
    for (let offset = 0; offset < plan.reads.length; offset += 8) {
      const batch = plan.reads.slice(offset, offset + 8);
      const settled = await Promise.allSettled(batch.map((summary) => this.readThread(summary.id, { turns: OVERVIEW_TURNS })));
      settled.forEach((entry, index) => {
        const summary = batch[index];
        if (entry.status === "rejected") {
          failed++;
          // A chat that cannot be read (a very long one can time out) waits before the next try.
          noteReadFailure(this.threadFailures, summary.id, { now });
          const saved = this.threadReads.get(summary.id);
          if (saved) fresh.push(saved);
          return;
        }
        const actor = entry.value;
        this.threadFailures.delete(summary.id);
        const hasRequest = this.listRequests(actor.id).length > 0 || Boolean(actor.awaitingApproval);
        const record = {
          id: actor.id, updatedAt: summary.updatedAt, checkedAt: now,
          attention: classifyCodex(actor, { hasRequest, now }),
          thread: { ...actor, activities: actor.activities.slice(-24), turnStates: actor.turnStates.slice(-3) },
        };
        this.threadReads.set(actor.id, record);
        fresh.push(record);
      });
    }
    const capped = pruneCache(this.threadReads, plan.ids);
    return { records: [...plan.reused, ...fresh], pending: plan.pending, failed, backingOff: plan.backingOff,
      candidates: plan.candidates, capped };
  }

  async listThreads() {
    await this.ready;
    if (this.threadList && Date.now() - this.threadListAt < 3000) return this.threadList;
    if (this.threadListPending) return this.threadListPending;
    this.threadListPending = (async () => {
      const threads = [];
      let cursor = null;
      let complete = false;
      for (let page = 0; page < 20; page++) {
        const result = await this.request("thread/list", {
          limit: 100,
          sortKey: "updated_at",
          sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
          ...(cursor ? { cursor } : {}),
        });
        threads.push(...(result.data || []).map(listedThread));
        if (!result.nextCursor || result.nextCursor === cursor) { complete = true; break; }
        cursor = result.nextCursor;
      }
      this.threadListComplete = complete;
      this.threadList = threads;
      this.threadListAt = Date.now();
      return threads;
    })().finally(() => { this.threadListPending = null; });
    return this.threadListPending;
  }

  async readScene(threadId) {
    await this.ready;
    const root = await this.readThread(threadId);
    return { root, ...(await readDescendants(threadId, (method, params) => this.request(method, params),
      (id) => this.readThread(id))) };
  }

  async sendReply(threadId, message) {
    if (this.sending.has(threadId)) throw Object.assign(new Error("A reply is already being sent to this chat."), { statusCode: 409 });
    this.sending.add(threadId);
    try {
      await this.ready;
      const saved = await this.latestTurns(threadId, 1);
      if (saved.turns?.at(-1)?.status === "inProgress")
        throw Object.assign(new Error("This chat is still working. Wait for the turn to finish before replying."), { statusCode: 409 });
      if (!this.resumedThreads.has(threadId)) {
        const resumed = await this.request("thread/resume", { threadId, excludeTurns: true });
        if (resumed.thread?.canAcceptDirectInput === false)
          throw Object.assign(new Error("This chat cannot accept a direct phone reply right now."), { statusCode: 409 });
        this.resumedThreads.add(threadId);
      }
      const result = await this.request("turn/start", { threadId, input: [{ type: "text", text: message }], turnTrigger: "user" });
      this.threadListAt = 0;
      return { turnId: result.turn?.id || "", status: result.turn?.status || "inProgress" };
    } finally { this.sending.delete(threadId); }
  }

  async forkAndReply(sourceThreadId, message) {
    if (this.sending.has(sourceThreadId)) throw Object.assign(new Error("A reply is already being sent to this chat."), { statusCode: 409 });
    this.sending.add(sourceThreadId);
    let forkId = "";
    try {
      await this.ready;
      const saved = await this.latestTurns(sourceThreadId, 1);
      if (saved.turns?.at(-1)?.status === "inProgress")
        throw Object.assign(new Error("Wait for this chat to finish before creating a mobile branch."), { statusCode: 409 });
      const forked = await this.request("thread/fork", { threadId: sourceThreadId });
      forkId = forked.thread?.id || "";
      if (!forkId) throw new Error("Codex did not return a mobile branch.");
      this.resumedThreads.add(forkId);
      const result = await this.request("turn/start", { threadId: forkId, input: [{ type: "text", text: message }], turnTrigger: "user" });
      this.threadListAt = 0;
      return { threadId: forkId, branchedFrom: sourceThreadId, turnId: result.turn?.id || "", status: result.turn?.status || "inProgress" };
    } catch (error) {
      if (forkId) {
        this.resumedThreads.delete(forkId);
        try { await this.request("thread/archive", { threadId: forkId }); } catch { /* Keep the original error. */ }
      }
      throw error;
    } finally { this.sending.delete(sourceThreadId); }
  }

  listRequests(threadId) {
    return [...this.serverRequests.values()].filter((item) => item.params.threadId === threadId);
  }

  getRequest(threadId, requestId) {
    const request = this.serverRequests.get(String(requestId));
    return request?.params.threadId === threadId ? request : null;
  }

  answerRequest(threadId, requestId, result) {
    const request = this.serverRequests.get(String(requestId));
    if (!request || request.params.threadId !== threadId) throw Object.assign(new Error("That request is no longer pending."), { statusCode: 404 });
    this.process.stdin.write(`${JSON.stringify({ id: request.id, result })}\n`);
    this.serverRequests.delete(String(requestId));
  }

  close() {
    this.closing = true;
    clearTimeout(this.restartTimer);
    this.process?.kill();
  }
}

const reader = new CodexReader();
const orca = new OrcaReader();
const claude = new ClaudeReader();
const extensions = new ExtensionReader({ dir: extensionFeedDir(stateDir) });
const watchList = new WatchList({ dir: stateDir });
// Which Codex chat drives which Orca terminals, and the person's own join or keep-separate choices.
const links = new LinkStore({ dir: stateDir });
// Looking for the chat behind an unlinked Orca pane can take several slow reads; no scene waits on it.
const discovery = new DiscoveryGate();

/** Every Orca and Claude Code member, joined to the chats that drive them. */
async function joinedMembers() {
  const [orcaResult] = await Promise.allSettled([orca.snapshot()]);
  const orcaAgents = orcaResult.status === "fulfilled" ? orcaResult.value.workspaces.flatMap((workspace) => workspace.agents) : [];
  let claudeAgents = [];
  try { claudeAgents = claude.snapshot().sessions.flatMap((session) => session.agents); } catch { /* Claude Code feed unavailable. */ }
  return joinParties([...orcaAgents, ...claudeAgents], links);
}
// An installed copy has its manager's marker beside it; a copy run from a download folder does not.
const installed = existsSync(join(here, "goblin-horde-install.json"));
const CLAUDE_ID = /^claude:[A-Za-z0-9_-]{1,128}$/;

async function listAllSources() {
  const [codexResult, orcaResult, claudeResult, extensionResult] = await Promise.allSettled([reader.listThreads(), orca.listWorkspaces(),
    Promise.resolve().then(() => claude.listSessions()), Promise.resolve().then(() => extensions.listSessions())]);
  const codex = codexResult.status === "fulfilled" ? codexResult.value : [];
  const workspaces = orcaResult.status === "fulfilled" ? orcaResult.value : [];
  const sessions = claudeResult.status === "fulfilled" ? claudeResult.value : [];
  const parties = extensionResult.status === "fulfilled" ? extensionResult.value : [];
  // Name what could not be listed, so a short list is never mistaken for the whole history.
  const unavailable = [["codex", codexResult], ["orca", orcaResult], ["claude", claudeResult], ["extension", extensionResult]]
    .filter(([, result]) => result.status === "rejected").map(([name]) => name);
  let joined = new Map();
  try { ({ joined } = await joinedMembers()); } catch { /* Without links every party stands alone. */ }
  const mark = (source) => (joined.has(source.id) ? { ...source, joinedTo: joined.get(source.id) } : source);
  return { threads: [...codex, ...sessions.map(mark), ...parties, ...workspaces.map(mark)].sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt)), unavailable };
}

/** Whether this installed copy can start at Windows sign-in, and whether it does. */
function autostartState() {
  const paths = installed ? shortcutPaths() : null;
  return paths ? { available: true, enabled: existsSync(paths.startup) } : { available: false, enabled: false };
}

/** Codex's connection, in the same shape as the other sources: retried on its own, or by reconnect. */
function codexSource() {
  return codexSourceState(reader.health, { restarts: reader.restarts });
}

/** Which feeds this viewer can see right now, for the viewer's Feeds panel and `goblin status`. */
async function capabilities() {
  const [orcaResult] = await Promise.allSettled([orca.snapshot()]);
  const claudeSnapshot = claude.snapshot();
  const extensionSnapshot = extensions.snapshot();
  const hooks = claudeHookReport(claudeSettingsPath(claudeConfigDir()));
  const lastClaude = Math.max(0, ...claudeSnapshot.sessions.map((session) => Number(session.updatedAt) || 0));
  return {
    product: "GoblinHorde", version, platform: process.platform,
    widget: process.platform === "win32"
      ? { native: true, note: "The transparent desktop goblins run on Windows when Python with Tkinter is installed." }
      : process.platform === "darwin"
        ? { native: true, note: "The transparent desktop goblins run on macOS with python.org or Homebrew Python (Tk 8.6 or newer); \"node goblin.mjs doctor\" shows whether this Mac has it." }
        : { native: false, note: "This computer uses the browser viewer. The transparent desktop goblins run on Windows and macOS." },
    autostart: autostartState(),
    // Phone access over Wi-Fi: off unless the person turned it on. Never the pairing code.
    phone: phone.state(),
    sources: {
      codex: codexSource(),
      claude: {
        state: hooks.state === "installed" && !hooks.broken && !hooks.disabled ? "ok" : hooks.state === "unreadable" ? "unreadable" : hooks.disabled ? "disabled"
          : hooks.state === "missing" ? "not-connected" : hooks.broken ? "broken" : "partial",
        detail: hooks.error || (hooks.disabled ? "Claude Code hooks are turned off in its settings." : hooks.state === "missing"
          ? "Claude Code hooks are not installed. Run: node goblin.mjs hooks install" : hooks.broken
            ? "The Claude Code hook points to a missing Node or receiver. Run: node goblin.mjs hooks install"
            : hooks.state === "partial" ? `Some Claude Code hooks are missing: ${hooks.missing.join(", ")}.` : "Recording public Claude Code activity."),
        sessions: claudeSnapshot.sessions.length, lastEventAt: lastClaude || 0, replies: false,
        // The widget offers to connect it in one click when this copy is installed (its hook needs a fixed path).
        canConnect: hooks.state !== "installed" && hooks.state !== "unreadable" && installed,
      },
      orca: orcaResult.status === "fulfilled"
        ? { state: orcaResult.value.missing ? "not-installed" : orcaResult.value.warning ? "unavailable" : "ok",
          detail: orcaResult.value.missing ? "Optional. Orca is not installed." : orcaResult.value.warning || "Reading Orca workspaces.", replies: false }
        : { state: "unavailable", detail: "Orca could not be read." },
      extensions: { state: extensionSnapshot.feeds.length ? "ok" : "none", replies: false, detail: extensionSnapshot.feeds.length
        ? `${extensionSnapshot.feeds.length} extension ${extensionSnapshot.feeds.length === 1 ? "feed" : "feeds"}.` : "No extension feeds yet. See EXTENSIONS.md.",
        feeds: extensionSnapshot.feeds },
    },
  };
}

// What the diagnostic report says about this run: counts and timings only, never names or content.
const stats = { startedAt: Date.now(), sceneBuilds: 0, sceneFailures: 0, lastSceneMs: 0, slowestSceneMs: 0, codexReadFailures: 0 };

async function allScene() {
  const [codexResult, orcaResult, claudeResult, extensionResult] = await Promise.allSettled([reader.listThreads(), orca.snapshot(),
    Promise.resolve().then(() => claude.snapshot()), Promise.resolve().then(() => extensions.snapshot())]);
  const codex = { ok: codexResult.status === "fulfilled", threads: codexResult.value || [], listComplete: reader.threadListComplete, checkFailed: false,
    missing: codexResult.status === "rejected" && reader.health.lastError === CODEX_NOT_FOUND };
  const orcaAgents = orcaResult.status === "fulfilled" ? orcaResult.value.workspaces.flatMap((workspace) => workspace.agents) : [];
  if (codex.ok) {
    try { codex.checked = await reader.checkThreadsForOverview(codex.threads, new Set(watchList.ids)); }
    catch { codex.checkFailed = true; }
    // Recently active Orca panes with no known driver: look for the chat that drives them, in the background.
    const unlinked = orcaAgents.filter((agent) => agent.terminal && !links.auto.has(agent.terminal)
      && Date.now() - Number(agent.updatedAt) < 24 * 60 * 60_000).map((agent) => agent.terminal).sort();
    if (unlinked.length) {
      discovery.start(() => reader.discoverLinks(codex.threads, unlinked.length), unlinked.join(","))
        // What it learned shows on the next poll; links are a bonus, never a failure.
        ?.then((learned) => { if (learned) allSceneDirty = true; }, () => {});
    }
  }
  const scene = composeAllScene({
    codex,
    orca: { ok: orcaResult.status === "fulfilled", snapshot: orcaResult.value },
    claude: { ok: claudeResult.status === "fulfilled", snapshot: claudeResult.value },
    extension: { ok: extensionResult.status === "fulfilled", snapshot: extensionResult.value },
    listRequests: (id) => reader.listRequests(id),
    now: Date.now(),
  });
  // Members a chat drives join its party; the person's own choices are sent so the widget can offer undo.
  // Links are worked out over every known member, so a worker whose coordinator was cut from this
  // scene still finds its party.
  const claudeAgents = claudeResult.status === "fulfilled" ? claudeResult.value.sessions.flatMap((session) => session.agents) : [];
  const codexMembers = (codex.checked?.records || []).map(({ thread }) => ({ ...thread, source: "codex" }));
  const { agents, joined } = joinSubset(scene.agents, [...codexMembers, ...orcaAgents, ...claudeAgents], links);
  // Watched parties are always read and kept on the launchpad, whatever their age.
  return { ...scene, agents, joinedParties: Object.fromEntries(joined), manualLinks: Object.fromEntries(links.manual),
    watched: [...watchList.ids] };
}
async function timedScene() {
  const started = Date.now();
  try {
    const scene = await allScene();
    stats.sceneBuilds++;
    stats.lastSceneMs = Date.now() - started;
    stats.slowestSceneMs = Math.max(stats.slowestSceneMs, stats.lastSceneMs);
    stats.codexReadFailures += Number(scene.coverage?.codexFailed || 0);
    return scene;
  } catch (error) {
    stats.sceneFailures++;
    throw error;
  }
}
let allScenePending = null;
let allSceneCached = null;
let allSceneCachedAt = 0;
let allSceneDirty = false; // Something changed: rebuild now, but keep serving the last scene meanwhile.
// A scene this old is still served at once while a fresh one is built; older ones wait for the rebuild.
const ALL_SCENE_STALE_MS = 60_000;
function recentScene() {
  const age = Date.now() - allSceneCachedAt;
  if (allSceneCached && age < 1500 && !allSceneDirty) return Promise.resolve(allSceneCached);
  if (!allScenePending) {
    allSceneDirty = false;
    allScenePending = timedScene().then((scene) => {
      allSceneCached = scene;
      allSceneCachedAt = Date.now();
      return scene;
    }).finally(() => { allScenePending = null; });
    // Nobody may await a background rebuild; its failure must not end the process.
    allScenePending.catch(() => {});
  }
  // One slow Codex read (a very long chat can take 15 seconds) must not hold every viewer and widget poll.
  if (allSceneCached && age < ALL_SCENE_STALE_MS) return Promise.resolve(allSceneCached);
  return allScenePending;
}
const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8" };
const commonHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" };

function json(response, status, data) {
  response.writeHead(status, { ...commonHeaders, "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

function isLocal(request) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress);
}

function hasSession(request) {
  return pairing.hasSession(sessionCookie(request.headers.cookie));
}

// The pages load only their own files: no inline script or style, nothing from other sites.
const pageCsp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; "
  + "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

async function serveFile(response, file, folder = publicDir) {
  const path = join(folder, file);
  const info = await stat(path);
  const type = mime[`.${file.split(".").at(-1)}`];
  response.writeHead(200, { ...commonHeaders, "Content-Type": type, "Content-Length": info.size,
    ...(file.endsWith(".html") ? { "Content-Security-Policy": pageCsp } : {}) });
  // Headers are already out, so a read error can only end the connection.
  createReadStream(path).on("error", () => response.destroy()).pipe(response);
}

async function handlePair(request, response, origin) {
  const ip = request.socket.remoteAddress || "unknown";
  // Counted before anything is read, so parallel guesses cannot all slip past the limit.
  if (!pairing.allow(ip)) return json(response, 429, { error: "Too many attempts. Wait ten minutes and try again." });
  if (request.headers.origin !== origin || !String(request.headers["content-type"] || "").startsWith("application/json"))
    return json(response, 403, { error: "Open the pairing page on your phone first." });
  let input = "";
  try {
    for await (const chunk of request) {
      input += chunk;
      if (input.length > 256) return json(response, 413, { error: "Invalid pairing request" });
    }
  } catch { return response.destroy(); } // The client hung up mid-body; there is no one to answer.
  let code = "";
  try { code = String(JSON.parse(input).code || ""); } catch { /* handled below */ }
  const sessionToken = pairing.pair(ip, code);
  if (!sessionToken) return json(response, 401, { error: "That pairing code did not match." });
  response.writeHead(200, { ...commonHeaders, "Content-Type": "application/json; charset=utf-8", "Set-Cookie": `goblin_horde_session=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400` });
  response.end(JSON.stringify({ paired: true }));
}

const BODY_LIMIT = 12_000;
const tooLarge = () => Object.assign(new Error("Request is too large."), { statusCode: 413 });

/**
 * A small JSON body. An oversized one is answered with 413: the rest is read and dropped rather than
 * breaking off mid-stream, which would destroy the socket before the answer could be sent.
 */
async function readBody(request) {
  if (Number(request.headers["content-length"]) > BODY_LIMIT) {
    request.resume();
    throw tooLarge();
  }
  const input = await new Promise((resolve, reject) => {
    let text = "";
    let overflow = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (overflow) return;
      text += chunk;
      if (text.length > BODY_LIMIT) { overflow = true; text = ""; }
    });
    request.on("end", () => (overflow ? reject(tooLarge()) : resolve(text)));
    request.on("error", reject);
  });
  try { return JSON.parse(input); } catch { throw Object.assign(new Error("Invalid request."), { statusCode: 400 }); }
}

async function handleReply(request, response) {
  const data = await readBody(request);
  const threadId = String(data.threadId || "");
  const message = String(data.message || "").trim();
  // Claude Code sessions are watched, not driven; never let a Claude party's reply reach Codex.
  if (threadId.startsWith("claude:") || threadId.startsWith("claude-agent:"))
    return json(response, 409, { error: "Replies to Claude Code sessions are not available here. Reply in Claude Code.", replyAvailable: false });
  if (threadId.startsWith("ext:") || threadId.startsWith("ext-agent:"))
    return json(response, 409, { error: "Extension feeds are watch-only. Reply in the tool that runs these agents.", replyAvailable: false });
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(threadId) || !message || message.length > 4000)
    return json(response, 400, { error: "Choose a chat and write a reply of up to 4,000 characters." });
  if (!(await canViewThread(threadId)))
    return json(response, 403, { error: "That chat is not available in this viewer." });
  if (data.createBranch === true) return json(response, 200, await reader.forkAndReply(threadId, message));
  try { return json(response, 200, { threadId, ...(await reader.sendReply(threadId, message)) }); }
  catch (error) {
    if (/already has an active writer/i.test(error.message))
      return json(response, 409, { error: "This chat is open in Codex. You can send this message in a mobile branch: a separate copy of the chat that does not merge back.", requiresBranch: true });
    throw error;
  }
}

async function canViewThread(threadId) {
  if (threadId === defaultThreadId) return true;
  const available = await reader.listThreads();
  return available.some((thread) => thread.id === threadId);
}

async function handleRequestAnswer(request, response) {
  const data = await readBody(request);
  const threadId = String(data.threadId || "");
  const requestId = String(data.requestId ?? "");
  const pending = reader.getRequest(threadId, requestId);
  if (!pending) return json(response, 404, { error: "That decision is no longer pending." });
  let result;
  if (pending.method === "item/tool/requestUserInput") {
    const questions = pending.params.questions || [];
    const answers = {};
    for (const question of questions) {
      const answer = String(data.answers?.[question.id] || "").trim();
      if (!answer || answer.length > 2000) return json(response, 400, { error: "Answer every question before submitting." });
      answers[question.id] = { answers: [answer] };
    }
    result = { answers };
  } else if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(pending.method)) {
    if (!["accept", "decline"].includes(data.decision)) return json(response, 400, { error: "Choose approve or decline." });
    result = { decision: data.decision };
  } else return json(response, 400, { error: "This request type is not supported on the phone yet." });
  reader.answerRequest(threadId, requestId, result);
  return json(response, 200, { answered: true });
}

const handler = async (request, response) => {
  const hostHeader = request.headers.host || "";
  const allowedHosts = new Set([host, "localhost", phone.host].filter(Boolean));
  if (!allowedHosts.has(hostHeader.split(":")[0])) return json(response, 403, { error: "Local network access only" });
  // Nothing but this computer is answered while phone access is off, even on a connection left open.
  if (!isLocal(request) && !phone.listening) return json(response, 403, { error: "Phone access is turned off on this computer." });
  const url = new URL(request.url || "/", `http://${hostHeader}`);
  const origin = `http://${hostHeader}`;
  if (url.pathname === "/api/pair" && request.method === "POST" && !isLocal(request)) {
    try { return await handlePair(request, response, origin); }
    catch { return fail(response, 500, "Unable to pair this phone."); }
  }
  if (["/api/reconnect", "/api/connect-claude", "/api/autostart", "/api/phone", "/api/phone/reset"].includes(url.pathname) && request.method === "POST") {
    // Only this computer may restart a source, change Claude Code's settings, or turn phone access on; never a paired phone.
    const refusal = localOnlyRefusal({ local: isLocal(request), origin, headers: request.headers });
    if (refusal) return json(response, refusal.status, { error: refusal.error });
    try {
      const data = await readBody(request);
      if (url.pathname === "/api/phone") {
        const state = await phone.setEnabled(data.enabled, { address: typeof data.address === "string" ? data.address : "" });
        return json(response, 200, { phone: state, ...(state.listening ? { code: pairing.code } : {}) });
      }
      if (url.pathname === "/api/phone/reset") return json(response, 200, { phone: phone.resetPairing(), code: pairing.code });
      if (url.pathname === "/api/autostart") {
        const paths = installed ? shortcutPaths() : null;
        if (!paths) return json(response, 409, { error: "Starting at sign-in needs an installed copy on Windows." });
        if (typeof data.enabled !== "boolean") return json(response, 400, { error: "Say whether to start at sign-in." });
        if (data.enabled) writeShortcut(paths.startup, shortcutSpec({ nodePath: process.execPath, installDir: here.replace(/[\\/]+$/, "") }));
        // TODO(B6): refuse to delete a Startup shortcut that runs another installation once lib/manager.mjs
        // exports its ownsShortcut(link, installDir) check; until then this removes whatever is there.
        else removeShortcut(paths.startup);
        return json(response, 200, { autostart: autostartState() });
      }
      if (url.pathname === "/api/reconnect") {
        reader.reconnect();
        allSceneDirty = true;
        return json(response, 200, { codex: codexSource() });
      }
      if (!installed) return json(response, 409, { error: "Install Goblin Horde first (node goblin.mjs install), then connect Claude Code." });
      const result = installClaudeHooks({ settingsPath: claudeSettingsPath(claudeConfigDir()), nodePath: process.execPath,
        hookPath: join(here, "claude-hook.mjs"), stateDir });
      return json(response, 200, { changed: result.changed, message: result.changed
        ? "Connected Claude Code. New sessions appear here; restart sessions that were already open. Undo with: node goblin.mjs hooks remove"
        : "Claude Code was already connected." });
    } catch (error) { return fail(response, error.statusCode || 500, error.message || "That did not work."); }
  }
  if (url.pathname === "/api/join" && request.method === "POST") {
    if (!isLocal(request) && !hasSession(request)) return json(response, 401, { error: "Pair this phone with the viewer first." });
    if (request.headers.origin !== origin || !String(request.headers["content-type"] || "").startsWith("application/json"))
      return json(response, 403, { error: "Open the viewer before changing a party." });
    try {
      const data = await readBody(request);
      // chat: a Codex chat id joins the party to it; "" keeps it separate; null goes back to automatic.
      if (!(data.chat === null || typeof data.chat === "string")) throw Object.assign(new Error("Say which chat to join."), { statusCode: 400 });
      links.setManual(String(data.party || ""), data.chat);
      allSceneDirty = true;
      return json(response, 200, { manualLinks: Object.fromEntries(links.manual) });
    } catch (error) { return fail(response, error.statusCode || 500, error.message || "Unable to change the party."); }
  }
  if (url.pathname === "/api/watch" && request.method === "POST") {
    if (!isLocal(request) && !hasSession(request)) return json(response, 401, { error: "Pair this phone with the viewer first." });
    if (request.headers.origin !== origin || !String(request.headers["content-type"] || "").startsWith("application/json"))
      return json(response, 403, { error: "Open the viewer before changing what is watched." });
    try {
      const data = await readBody(request);
      if (typeof data.watched !== "boolean") throw Object.assign(new Error("Say whether to watch it."), { statusCode: 400 });
      const ids = watchList.set(String(data.id || ""), data.watched);
      allSceneDirty = true; // The next poll starts reading the newly watched chat; nobody waits for it.
      return json(response, 200, { watched: ids });
    } catch (error) { return fail(response, error.statusCode || 500, error.message || "Unable to change what is watched."); }
  }
  if (["/api/reply", "/api/respond"].includes(url.pathname) && request.method === "POST") {
    if (!isLocal(request) && !hasSession(request)) return json(response, 401, { error: "Pair this phone with the viewer first." });
    if (request.headers.origin !== origin || !String(request.headers["content-type"] || "").startsWith("application/json"))
      return json(response, 403, { error: "Open the viewer before sending a reply." });
    try { return await (url.pathname === "/api/reply" ? handleReply(request, response) : handleRequestAnswer(request, response)); }
    catch (error) { return fail(response, error.statusCode || 500, error.message || "Unable to send reply."); }
  }
  if (request.method !== "GET") return json(response, 405, { error: "Read-only viewer" });

  try {
    // Awaited, so a missing file lands in the catch below instead of escaping the handler.
    if (url.pathname === "/pair.css" || url.pathname === "/pair.js") return await serveFile(response, url.pathname.slice(1));
    if (!isLocal(request) && !hasSession(request)) {
      if (url.pathname === "/") return await serveFile(response, "pair.html");
      return json(response, 401, { error: "Pair this phone with the viewer first." });
    }
    if (url.pathname === "/api/mobile") {
      const state = phone.state();
      return json(response, 200, {
        local: isLocal(request), enabled: state.enabled, available: state.listening, address: state.url, adapter: state.adapter, problem: state.problem,
        ...(isLocal(request) && state.listening ? { code: pairing.code } : {}),
      });
    }
    if (url.pathname === "/api/config") return json(response, 200, { defaultThreadId, pollMs: 2000 });
    // Local only: the manager uses this to recognise its own server before stopping anything.
    if (url.pathname === "/api/health") {
      if (!isLocal(request)) return json(response, 404, { error: "Not found" });
      return json(response, 200, { product: "GoblinHorde", version, pid: process.pid, installDir: here.replace(/[\\/]+$/, ""), instance });
    }
    if (url.pathname === "/api/capabilities") return json(response, 200, await capabilities());
    if (url.pathname === "/api/requests") return json(response, 200, { requests: publicRequests(reader.listRequests(url.searchParams.get("id") || defaultThreadId)) });
    if (url.pathname === "/api/threads") return json(response, 200, publicView({ ...(await listAllSources()), watched: [...watchList.ids] }, { phone: !isLocal(request) }));
    if (url.pathname === "/api/diagnostics") {
      if (!isLocal(request)) return json(response, 404, { error: "Not found" });
      const report = diagnosticReport({ version, platform: process.platform, node: process.versions.node, stats, now: Date.now(),
        capabilities: await capabilities(), scene: allSceneCached, watched: watchList.ids.length, codexRestarts: reader.restarts,
        phone: { available: phone.listening, pairedSessions: pairing.sessionCount?.() ?? null } });
      return json(response, 200, report);
    }
    // Activity leaves only through publicView: filtered for everyone, trimmed further for a phone.
    const shown = (data) => json(response, 200, publicView(data, { phone: !isLocal(request) }));
    if (url.pathname === "/api/scene") {
      const threadId = url.searchParams.get("id") || defaultThreadId;
      // The watch list is always the current one, even on a scene built before the last change.
      if (threadId === "all") return shown({ ...(await recentScene()), watched: [...watchList.ids], servedAt: Date.now() });
      if (threadId.startsWith("orca:")) {
        const scene = await orca.scene(threadId);
        return scene ? shown({ ...scene, checkedAt: Date.now() }) : json(response, 404, { error: "That Orca workspace is unavailable." });
      }
      if (threadId.startsWith("claude:")) {
        const scene = CLAUDE_ID.test(threadId) ? claude.scene(threadId) : null;
        return scene ? shown({ ...scene, checkedAt: Date.now() }) : json(response, 404, { error: "That Claude Code session is unavailable." });
      }
      if (threadId.startsWith("ext:")) {
        const scene = EXTENSION_PARTY.test(threadId) ? extensions.scene(threadId) : null;
        return scene ? shown({ ...scene, checkedAt: Date.now() }) : json(response, 404, { error: "That extension party is unavailable." });
      }
      if (!/^[a-zA-Z0-9_-]{8,100}$/.test(threadId)) return json(response, 400, { error: "Choose a valid thread" });
      if (!(await canViewThread(threadId))) return json(response, 403, { error: "That chat is not available in this viewer." });
      const scene = await reader.readScene(threadId);
      const { agents: everyone } = await joinedMembers();
      const joinedHere = everyone.filter((agent) => agent.joined && agent.parentThreadId === threadId);
      return shown({ ...scene, agents: [...(scene.agents || []), ...joinedHere], requests: reader.listRequests(threadId),
        checkedAt: Date.now() });
    }
    if (url.pathname === "/api/thread") {
      const threadId = url.searchParams.get("id") || defaultThreadId;
      if (!/^[a-zA-Z0-9_-]{8,100}$/.test(threadId)) return json(response, 400, { error: "Choose a valid thread" });
      if (!(await canViewThread(threadId))) return json(response, 403, { error: "That chat is not available in this viewer." });
      return shown({ thread: await reader.readThread(threadId), checkedAt: Date.now() });
    }

    // The pixel goblins share one sprite file with the desktop widget.
    if (url.pathname === "/goblin_art.json") return await serveFile(response, "goblin_art.json", here);
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (!/^(index\.html|app\.js|styles\.css|mobile\.css|interactive\.css|demo\.js|party\.js|goblins\.js)$/.test(file)) return json(response, 404, { error: "Not found" });
    return await serveFile(response, file);
  } catch (error) {
    fail(response, 500, error.message || "Unable to read Codex activity");
  }
};

/** An error answer, unless a reply is already under way; then the connection is simply ended. */
function fail(response, status, message) {
  if (response.headersSent) return response.destroy();
  return json(response, status, { error: message });
}

// Last line of defence: one bad request must never become an unhandled rejection that ends the server.
const safeHandler = (request, response) => handler(request, response).catch(() => fail(response, 500, "Unexpected error."));
const localServer = createServer(safeHandler);
localServer.on("error", (error) => {
  // Say plainly why the viewer cannot start; the manager reads this from the server log.
  console.error(error.code === "EADDRINUSE" ? `PORT_IN_USE: Port ${port} is already used by another program. Choose another port with --port.`
    : `Could not start the viewer: ${error.message}`);
  reader.close();
  process.exit(error.code === "EADDRINUSE" ? 3 : 1);
});
localServer.listen(port, host, () => console.log(`Goblin Horde: http://${host}:${port}`));
// The Wi-Fi listener only when the person turned phone access on.
phone.apply().then((state) => { if (state.problem) console.error(state.problem); }, (error) => console.error(`Phone access: ${error.message}`));
// Browsers hold keep-alive connections open, so exit right after stopping Codex instead of waiting for them.
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { reader.close(); localServer.close(); phone.close(); process.exit(0); });
