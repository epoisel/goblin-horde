import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { transformThread } from "./lib/transform.mjs";
import { describeModel } from "./lib/models.mjs";
import { readDescendants } from "./lib/descendants.mjs";
import { classifyCodex, composeAllScene, noteReadFailure, planCodexReads, pruneCache } from "./lib/feed.mjs";
import { WatchList } from "./lib/watch.mjs";
import { OrcaReader } from "./lib/orca.mjs";
import { ClaudeReader, goblinStateDir } from "./lib/claude.mjs";
import { ExtensionReader, EXTENSION_PARTY, extensionFeedDir } from "./lib/extension.mjs";
import { claudeHookReport, claudeSettingsPath } from "./lib/claude-hooks.mjs";
import { claudeConfigDir } from "./lib/paths.mjs";
import { codexCommand } from "./lib/codex-bin.mjs";
import { Pairing, sessionCookie } from "./lib/pairing.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const publicDir = resolve(here, "public");
const port = Number(process.env.PORT || 43917);
const host = "127.0.0.1";
const version = JSON.parse(readFileSync(join(here, "package.json"), "utf8")).version || "0.0.0";
// The manager passes a random instance id so `goblin stop` can tell this copy from any other server on the port.
const instance = /^[a-f0-9]{16,64}$/.test(process.env.GOBLIN_HORDE_INSTANCE || "") ? process.env.GOBLIN_HORDE_INSTANCE : "";
const stateDir = goblinStateDir();
const codeDir = stateDir;
const codeFile = join(codeDir, "pairing-code.txt");
function loadPairingCode() {
  try {
    const saved = readFileSync(codeFile, "utf8").trim();
    if (/^[A-HJ-NP-Z2-9]{8}$/.test(saved)) return saved;
  } catch { /* Create a code below. */ }
  try {
    if (!process.env.LOCALAPPDATA) throw new Error("No Activity Lens folder outside Windows.");
    const legacy = readFileSync(join(process.env.LOCALAPPDATA, "ActivityLens", "pairing-code.txt"), "utf8").trim();
    if (/^[A-HJ-NP-Z2-9]{8}$/.test(legacy)) {
      mkdirSync(codeDir, { recursive: true });
      writeFileSync(codeFile, `${legacy}\n`, { mode: 0o600 });
      return legacy;
    }
  } catch { /* No old code to carry over. */ }
  const code = Array.from(randomBytes(8), (byte) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[byte % 32]).join("");
  mkdirSync(codeDir, { recursive: true });
  writeFileSync(codeFile, `${code}\n`, { mode: 0o600 });
  return code;
}
const pairingCode = loadPairingCode();
const pairing = new Pairing({ code: pairingCode });

function isPrivateIPv4(ip) {
  const parts = String(ip).split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168));
}

function findLanIp() {
  const entries = Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses || []).filter((address) => address.family === "IPv4" && !address.internal && isPrivateIPv4(address.address))
      .map((address) => ({ name, ip: address.address })));
  return entries.find(({ name }) => /wi-?fi|wlan/i.test(name))?.ip
    || entries.find(({ name }) => /ethernet/i.test(name) && !/virtual|vpn|vEthernet/i.test(name))?.ip
    || "";
}

const lanIp = process.env.LAN_IP || findLanIp();
if (lanIp && !isPrivateIPv4(lanIp)) throw new Error("LAN_IP must be a private IPv4 address");
const defaultThreadId = process.env.CODEX_VIEWER_THREAD_ID || "all";
const asMilliseconds = (value) => Number(value) < 1e12 ? Number(value || 0) * 1000 : Number(value || 0);

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
    this.problem = "";
    this.process = null;
    try {
      const codex = codexCommand(["app-server", "--listen", "stdio://"]);
      this.process = spawn(codex.command, codex.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, ...codex.options,
        ...(Object.keys(codex.env).length ? { env: { ...process.env, ...codex.env } } : {}) });
    } catch {
      // Node refuses some programs synchronously (a .cmd it cannot quote); treat that like a missing CLI.
      this.problem = "Codex could not be started.";
    }
    if (this.process) {
      this.lines = createInterface({ input: this.process.stdout });
      this.lines.on("line", (line) => this.onLine(line));
      this.process.stderr.on("data", () => {});
      this.process.stdin.on("error", () => {});
      this.process.on("error", (error) => {
        this.problem = error.code === "ENOENT" ? "The Codex CLI was not found." : "Codex could not be started.";
        this.failAll(error);
      });
      this.process.on("exit", (code) => {
        this.problem ||= `Codex app-server stopped (${code}).`;
        this.failAll(new Error(`Codex app-server exited (${code})`));
      });
    }
    this.ready = this.request("initialize", {
      clientInfo: { name: "goblin_horde", title: "Goblin Horde", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    }).then(() => this.notify("initialized"));
    // Codex is optional: callers still await `ready` and see the failure, but nothing else is left holding it.
    this.ready.catch(() => {});
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
    this.process.stdin.write(`${JSON.stringify({ method, ...(params ? { params } : {}) })}\n`);
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

  async readThread(threadId) {
    await this.ready;
    const result = await this.request("thread/read", { threadId, includeTurns: true });
    return transformThread(result.thread);
  }

  /** Check the chats in use or watched; reuse saved checks for the rest. */
  async checkThreadsForOverview(threads, watched = new Set()) {
    const now = Date.now();
    const mustIds = new Set([...this.serverRequests.values()].map((item) => String(item.params.threadId || "")).filter(Boolean));
    const plan = planCodexReads(threads, { now, cache: this.threadReads, attempts: this.threadAttempts, mustIds, watched,
      failures: this.threadFailures });
    const fresh = [];
    let failed = 0;
    for (let offset = 0; offset < plan.reads.length; offset += 8) {
      const batch = plan.reads.slice(offset, offset + 8);
      const settled = await Promise.allSettled(batch.map((summary) => this.readThread(summary.id)));
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
        const hasRequest = this.listRequests(actor.id).length > 0;
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
        // Status is only what this app-server knows; chats running in another Codex process usually read as notLoaded.
        threads.push(...(result.data || []).map(({ id, name, preview, updatedAt, cwd, status, model, modelProvider, reasoningEffort }) => ({
          id, name: String(name || preview || "Untitled chat").slice(0, 120), updatedAt: asMilliseconds(updatedAt), cwd, source: "codex",
          model: describeModel(model, { provider: modelProvider, effort: reasoningEffort }),
          ...(status?.type ? { status: status.type } : {}),
          ...(Array.isArray(status?.activeFlags) && status.activeFlags.length ? { activeFlags: status.activeFlags.map(String) } : {}),
        })));
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
      const saved = await this.request("thread/read", { threadId, includeTurns: true });
      if (saved.thread?.turns?.at(-1)?.status === "inProgress")
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
      const saved = await this.request("thread/read", { threadId: sourceThreadId, includeTurns: true });
      if (saved.thread?.turns?.at(-1)?.status === "inProgress")
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

  close() { this.process?.kill(); }
}

const reader = new CodexReader();
const orca = new OrcaReader();
const claude = new ClaudeReader();
const extensions = new ExtensionReader({ dir: extensionFeedDir(stateDir) });
const watchList = new WatchList({ dir: stateDir });
const CLAUDE_ID = /^claude:[A-Za-z0-9_-]{1,128}$/;

async function listAllSources() {
  const [codexResult, orcaResult, claudeResult, extensionResult] = await Promise.allSettled([reader.listThreads(), orca.listWorkspaces(),
    Promise.resolve().then(() => claude.listSessions()), Promise.resolve().then(() => extensions.listSessions())]);
  const codex = codexResult.status === "fulfilled" ? codexResult.value : [];
  const workspaces = orcaResult.status === "fulfilled" ? orcaResult.value : [];
  const sessions = claudeResult.status === "fulfilled" ? claudeResult.value : [];
  const parties = extensionResult.status === "fulfilled" ? extensionResult.value : [];
  return [...codex, ...sessions, ...parties, ...workspaces].sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
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
    sources: {
      codex: { state: reader.problem ? "unavailable" : "ok", detail: reader.problem || "Reading local Codex chats." },
      claude: {
        state: hooks.state === "installed" && !hooks.broken && !hooks.disabled ? "ok" : hooks.state === "unreadable" ? "unreadable" : hooks.disabled ? "disabled"
          : hooks.state === "missing" ? "not-connected" : hooks.broken ? "broken" : "partial",
        detail: hooks.error || (hooks.disabled ? "Claude Code hooks are turned off in its settings." : hooks.state === "missing"
          ? "Claude Code hooks are not installed. Run: node goblin.mjs hooks install" : hooks.broken
            ? "The Claude Code hook points to a missing Node or receiver. Run: node goblin.mjs hooks install"
            : hooks.state === "partial" ? `Some Claude Code hooks are missing: ${hooks.missing.join(", ")}.` : "Recording public Claude Code activity."),
        sessions: claudeSnapshot.sessions.length, lastEventAt: lastClaude || 0,
      },
      orca: orcaResult.status === "fulfilled"
        ? { state: orcaResult.value.missing ? "not-installed" : orcaResult.value.warning ? "unavailable" : "ok",
          detail: orcaResult.value.missing ? "Optional. Orca is not installed." : orcaResult.value.warning || "Reading Orca workspaces." }
        : { state: "unavailable", detail: "Orca could not be read." },
      extensions: { state: extensionSnapshot.feeds.length ? "ok" : "none", detail: extensionSnapshot.feeds.length
        ? `${extensionSnapshot.feeds.length} extension ${extensionSnapshot.feeds.length === 1 ? "feed" : "feeds"}.` : "No extension feeds yet. See EXTENSIONS.md.",
        feeds: extensionSnapshot.feeds },
    },
  };
}

async function allScene() {
  const [codexResult, orcaResult, claudeResult, extensionResult] = await Promise.allSettled([reader.listThreads(), orca.snapshot(),
    Promise.resolve().then(() => claude.snapshot()), Promise.resolve().then(() => extensions.snapshot())]);
  const codex = { ok: codexResult.status === "fulfilled", threads: codexResult.value || [], listComplete: reader.threadListComplete, checkFailed: false };
  if (codex.ok) {
    try { codex.checked = await reader.checkThreadsForOverview(codex.threads, new Set(watchList.ids)); }
    catch { codex.checkFailed = true; }
  }
  const scene = composeAllScene({
    codex,
    orca: { ok: orcaResult.status === "fulfilled", snapshot: orcaResult.value },
    claude: { ok: claudeResult.status === "fulfilled", snapshot: claudeResult.value },
    extension: { ok: extensionResult.status === "fulfilled", snapshot: extensionResult.value },
    listRequests: (id) => reader.listRequests(id),
    now: Date.now(),
  });
  // Watched parties are always read and kept on the launchpad, whatever their age.
  return { ...scene, watched: [...watchList.ids] };
}
let allScenePending = null;
let allSceneCached = null;
let allSceneCachedAt = 0;
// A scene this old is still served at once while a fresh one is built; older ones wait for the rebuild.
const ALL_SCENE_STALE_MS = 60_000;
function recentScene() {
  const age = Date.now() - allSceneCachedAt;
  if (allSceneCached && age < 1500) return Promise.resolve(allSceneCached);
  if (!allScenePending) {
    allScenePending = allScene().then((scene) => {
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
      return json(response, 409, { error: "This chat is open in Codex. You can send this message in a linked mobile branch.", requiresBranch: true });
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
  const allowedHosts = new Set([host, "localhost", lanIp].filter(Boolean));
  if (!allowedHosts.has(hostHeader.split(":")[0])) return json(response, 403, { error: "Local network access only" });
  const url = new URL(request.url || "/", `http://${hostHeader}`);
  const origin = `http://${hostHeader}`;
  if (url.pathname === "/api/pair" && request.method === "POST" && !isLocal(request)) {
    try { return await handlePair(request, response, origin); }
    catch { return fail(response, 500, "Unable to pair this phone."); }
  }
  if (url.pathname === "/api/watch" && request.method === "POST") {
    if (!isLocal(request) && !hasSession(request)) return json(response, 401, { error: "Pair this phone with the viewer first." });
    if (request.headers.origin !== origin || !String(request.headers["content-type"] || "").startsWith("application/json"))
      return json(response, 403, { error: "Open the viewer before changing what is watched." });
    try {
      const data = await readBody(request);
      if (typeof data.watched !== "boolean") throw Object.assign(new Error("Say whether to watch it."), { statusCode: 400 });
      const ids = watchList.set(String(data.id || ""), data.watched);
      allSceneCachedAt = 0; // The next poll reads the newly watched chat or drops the unwatched one.
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
    if (url.pathname === "/api/mobile") return json(response, 200, {
      available: Boolean(lanIp),
      address: lanIp ? `http://${lanIp}:${port}` : "",
      ...(isLocal(request) ? { code: pairingCode } : {}),
    });
    if (url.pathname === "/api/config") return json(response, 200, { defaultThreadId, pollMs: 2000 });
    // Local only: the manager uses this to recognise its own server before stopping anything.
    if (url.pathname === "/api/health") {
      if (!isLocal(request)) return json(response, 404, { error: "Not found" });
      return json(response, 200, { product: "GoblinHorde", version, pid: process.pid, installDir: here.replace(/[\\/]+$/, ""), instance });
    }
    if (url.pathname === "/api/capabilities") return json(response, 200, await capabilities());
    if (url.pathname === "/api/requests") return json(response, 200, { requests: reader.listRequests(url.searchParams.get("id") || defaultThreadId) });
    if (url.pathname === "/api/threads") return json(response, 200, { threads: await listAllSources(), watched: [...watchList.ids] });
    if (url.pathname === "/api/scene") {
      const threadId = url.searchParams.get("id") || defaultThreadId;
      if (threadId === "all") return json(response, 200, await recentScene());
      if (threadId.startsWith("orca:")) {
        const scene = await orca.scene(threadId);
        return scene ? json(response, 200, { ...scene, checkedAt: Date.now() }) : json(response, 404, { error: "That Orca workspace is unavailable." });
      }
      if (threadId.startsWith("claude:")) {
        const scene = CLAUDE_ID.test(threadId) ? claude.scene(threadId) : null;
        return scene ? json(response, 200, { ...scene, checkedAt: Date.now() }) : json(response, 404, { error: "That Claude Code session is unavailable." });
      }
      if (threadId.startsWith("ext:")) {
        const scene = EXTENSION_PARTY.test(threadId) ? extensions.scene(threadId) : null;
        return scene ? json(response, 200, { ...scene, checkedAt: Date.now() }) : json(response, 404, { error: "That extension party is unavailable." });
      }
      if (!/^[a-zA-Z0-9_-]{8,100}$/.test(threadId)) return json(response, 400, { error: "Choose a valid thread" });
      if (!(await canViewThread(threadId))) return json(response, 403, { error: "That chat is not available in this viewer." });
      return json(response, 200, { ...(await reader.readScene(threadId)), requests: reader.listRequests(threadId), checkedAt: Date.now() });
    }
    if (url.pathname === "/api/thread") {
      const threadId = url.searchParams.get("id") || defaultThreadId;
      if (!/^[a-zA-Z0-9_-]{8,100}$/.test(threadId)) return json(response, 400, { error: "Choose a valid thread" });
      if (!(await canViewThread(threadId))) return json(response, 403, { error: "That chat is not available in this viewer." });
      return json(response, 200, { thread: await reader.readThread(threadId), checkedAt: Date.now() });
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
let lanServer;
if (lanIp) {
  lanServer = createServer(safeHandler);
  lanServer.on("error", (error) => console.error(`Could not start Wi-Fi listener: ${error.message}`));
  lanServer.listen(port, lanIp, () => console.log(`Phone address: http://${lanIp}:${port}`));
}
// Browsers hold keep-alive connections open, so exit right after stopping Codex instead of waiting for them.
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { reader.close(); localServer.close(); lanServer?.close(); process.exit(0); });
