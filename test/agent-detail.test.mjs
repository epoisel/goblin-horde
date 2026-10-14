/**
 * GET /api/agent, POST /api/open and POST /api/message on fakes: no Codex, Orca, Claude app or
 * browser is ever started, switched, or sent anything. Launches go to a recording fake.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDetailService, ClaudeDesktopIndex, agentKind, agentRoutes, gitBranch, launchUrl, orcaTwin } from "../lib/agent-detail.mjs";

const CWD = "C:\\work\\billing-api";
const CHAT = "019a-chat-0001";
const HELPER = "019a-helper-0002";

function world({ twin = false, desktop = false, proof = twin, orcaHangs = false } = {}) {
  const log = { turns: [], launched: [], switched: [], sent: [], replies: [], orcaSnapshots: 0 };
  let now = 50_000;
  let fileStat = () => ({ size: 10, mtimeMs: 20 });
  const codexActor = { id: CHAT, source: "codex", name: "Ship CSV export", cwd: CWD, status: "notLoaded", attention: "working", updatedAt: 1000,
    turnStates: [{ id: "t2", status: "inProgress" }], activities: [] };
  const helperActor = { id: HELPER, source: "codex", name: "Check importer", cwd: CWD, parentThreadId: CHAT, attention: "quiet", turnStates: [], activities: [] };
  const claudeMain = { id: "claude-agent:sess-1", source: "claude", name: "Claude · billing-api · 1a2b", cwd: CWD, parentThreadId: "claude:sess-1", status: "active", attention: "working", activities: [] };
  const claudeChild = { id: "claude-agent:sess-1:a1b2c3", source: "claude", name: "Explore subagent", cwd: CWD, parentThreadId: "claude:sess-1", childOf: "claude-agent:sess-1", status: "completed", attention: "quiet", activities: [] };
  const claudeDesktop = { id: "claude-agent:sess-desktop", source: "claude", name: "Claude · notes · 9f9f", cwd: "C:\\work\\notes", parentThreadId: "claude:sess-desktop", status: "completed", attention: "quiet", activities: [] };
  const orcaActor = { id: "orca-agent:tab:a", source: "orca", name: "Exporter", cwd: "C:/work/other", parentThreadId: "orca:d29yaw", role: "codex · working", status: "working", terminal: "term_a", parentPane: "tab:f", activities: [] };
  const pane = { id: "orca-agent:tab:p", source: "orca", name: "Claude pane", cwd: CWD, role: "claude · working", status: "working", terminal: "term_p", activities: [] };
  const extActor = { id: "ext-agent:relay:night-run:scout", source: "extension", name: "Scout", cwd: CWD, parentThreadId: "ext:relay:night-run", workflowName: "Night run", activities: [] };
  const scene = { agents: [codexActor, helperActor, claudeMain, claudeChild, claudeDesktop, orcaActor, extActor] };
  const threads = [{ id: CHAT, name: "Ship CSV export", updatedAt: 1000 }, { id: HELPER, name: "Check importer", updatedAt: 900 }];
  let writer = false;
  const codex = {
    listThreads: async () => threads,
    latestTurns: async (id, limit) => {
      log.turns.push([id, limit]);
      return { id, cwd: CWD, path: "C:\\codex\\rollout-1.jsonl", createdAt: 1_780_000_000, turns: [{ id: "t2", status: "inProgress", startedAt: 1_780_000_100, items: [
        { type: "userMessage", content: [{ type: "text", text: "Fix the header row" }] },
        { type: "commandExecution", id: "c1", command: "npm test", status: "completed", exitCode: 0, durationMs: 10, aggregatedOutput: "ok password=hunter2secret" },
        { type: "commandExecution", id: "c2", command: "npm run lint", status: "inProgress" }] }] };
    },
    readThread: async (id) => ({ ...codexActor, id, attention: undefined, turnStates: [{ id: "t", status: "completed", questions: [] }] }),
    canView: async (id) => threads.some((thread) => thread.id === id),
    sendReply: async (id, text) => {
      if (writer) throw new Error("thread already has an active writer");
      log.replies.push([id, text]);
      return { turnId: "turn-9", status: "inProgress" };
    },
    listRequests: () => [],
  };
  // What each side recorded: the pane's newest prompt matches the session's only when `proof` says so.
  const marks = { [claudeMain.id]: ["mark-ship-csv"], [pane.id]: [proof ? "mark-ship-csv" : "mark-another-agent"] };
  const workspaces = () => ({ workspaces: [{ id: "orca:d29yaw", name: "billing-api", agents: [orcaActor, ...(twin ? [pane] : [])] }] });
  const service = new AgentDetailService({
    scene: async () => scene,
    codex,
    claude: { snapshot: () => ({ sessions: [{ agents: [claudeMain, claudeChild] }, { agents: [claudeDesktop] }] }), records: () => [], marks: (id) => marks[id] || [] },
    orca: {
      snapshot: async () => { log.orcaSnapshots++; return orcaHangs ? new Promise(() => {}) : workspaces(); },
      lastSnapshot: () => workspaces(),
      marksFor: (id) => marks[id] || [],
      detail: async (id) => ({ agent: orcaActor, mission: { text: "Fix the header", from: "coordinator", at: 1 }, plan: null, now: { kind: "think", title: "Thinking", startedAt: 1 },
        said: { text: "On it.", at: 1 }, trail: [], files: [], screen: { lines: ["$ npm test"], at: 2 }, id }),
      switchTo: async (terminal) => { log.switched.push(terminal); return { opened: true }; },
      send: async (terminal, text) => { log.sent.push([terminal, text]); return { sent: true }; },
    },
    extensions: { snapshot: () => ({ sessions: [{ agents: [extActor] }] }) },
    claudeDetail: { read: ({ session, agent }) => ({
      mission: { text: agent ? "Find callers" : "Ship the CSV export", from: agent ? "parent" : "you", at: 5 }, plan: { steps: [{ text: "Fix", status: "active" }], at: 5, source: "todos" },
      now: { kind: "command", title: "Running npm test", detail: "npm test", startedAt: 6 }, said: { text: "Working on it.", at: 6 },
      trail: [{ id: "b1", at: 6, kind: "command", title: "npm test", detail: "npm test --token=abc123def456ghi789", status: "running" }],
      files: [{ path: "lib\\export.mjs", added: 4, removed: 2, at: 6 }], branch: session === "sess-1" ? "ship-csv" : "", startedAt: 3, lastAt: 6 }) },
    codexPlans: { read: (file) => (file ? { steps: [{ text: "Fix the header", status: "active" }], at: 9, source: "plan" } : null) },
    desktop: { linkFor: (session) => (desktop && session === "sess-desktop" ? "claude://code/continue?session=local_0a1b2c3d" : "") },
    launch: (url) => { log.launched.push(url); return true; },
    stat: () => fileStat(),
    branch: () => "main",
    clock: () => now,
  });
  return { service, log, setWriter: (value) => { writer = value; }, threads, scene,
    advance: (ms) => { now += ms; }, setStat: (next) => { fileStat = next; } };
}

test("actor ids are checked before anything is read", () => {
  assert.equal(agentKind(CHAT), "codex");
  assert.equal(agentKind("claude-agent:sess-1"), "claude");
  assert.equal(agentKind("claude-agent:sess-1:a1b2c3"), "claude");
  assert.equal(agentKind("orca-agent:tab:pane"), "orca");
  assert.equal(agentKind("ext-agent:relay:night-run:scout"), "extension");
  for (const bad of ["", "short", "../../etc/passwd", "claude-agent:", "claude-agent:a/b", "orca-agent:a b", "ext-agent:Relay:x:y", "x".repeat(500), "a b c d e f g h"])
    assert.equal(agentKind(bad), "", bad);
});

test("a Claude Code session's detail comes from its transcript, with its party and no app to open", async () => {
  const { service } = world();
  const detail = await service.detail("claude-agent:sess-1");
  assert.equal(detail.mission.text, "Ship the CSV export");
  assert.equal(detail.now.title, "Running npm test");
  assert.equal(detail.agent.project, "billing-api");
  assert.equal(detail.agent.branch, "ship-csv");
  assert.equal(detail.agent.startedAt, 3);
  assert.deepEqual(detail.agent.party, { id: "claude:sess-1", name: "Claude · billing-api · 1a2b" });
  assert.deepEqual(detail.agent.controls, { open: null, message: null, dismiss: false });
  assert.equal(detail.checkedAt, 50_000);
  const child = await service.detail("claude-agent:sess-1:a1b2c3");
  assert.deepEqual(child.agent.party.coordinatorId, "claude-agent:sess-1");
  assert.equal(child.mission.from, "parent");
  assert.equal(child.now, null, "a finished subagent has nothing running");
  await assert.rejects(service.open("claude-agent:sess-1"), (error) => error.statusCode === 409);
  await assert.rejects(service.message("claude-agent:sess-1", "hi"), (error) => error.statusCode === 409);
});

test("a Claude Code session in an Orca pane opens and takes messages through that terminal", async () => {
  const { service, log } = world({ twin: true });
  const detail = await service.detail("claude-agent:sess-1");
  assert.deepEqual(detail.agent.controls.open, { kind: "orca-terminal", label: "Open in Orca" });
  assert.equal(detail.agent.controls.message.kind, "orca-send");
  assert.equal(detail.agent.controls.message.hint, "Types into the Orca terminal \"Claude pane\" and presses Enter");
  assert.deepEqual(await service.open("claude-agent:sess-1"), { opened: true, kind: "orca-terminal" });
  assert.deepEqual(await service.message("claude-agent:sess-1", "  Use v2 of the API  "), { sent: true, kind: "orca-send" });
  assert.deepEqual(log.switched, ["term_p"]);
  assert.deepEqual(log.sent, [["term_p", "Use v2 of the API"]]);
  const child = await service.detail("claude-agent:sess-1:a1b2c3");
  assert.equal(child.agent.controls.message, null, "a subagent is never messaged directly");
  await assert.rejects(service.message("claude-agent:sess-1:a1b2c3", "hi"), (error) => error.statusCode === 409);
});

test("an unrelated Claude pane in the same folder is never typed into or opened for a session", async () => {
  // Session sess-1 runs in a plain terminal; another agent's Orca Claude pane works in the same folder.
  const { service, log } = world({ twin: true, proof: false });
  const detail = await service.detail("claude-agent:sess-1");
  assert.deepEqual(detail.agent.controls, { open: null, message: null, dismiss: false });
  await assert.rejects(service.message("claude-agent:sess-1", "Use v2 of the API"), (error) => error.statusCode === 409);
  await assert.rejects(service.open("claude-agent:sess-1"), (error) => error.statusCode === 409);
  assert.deepEqual(log.sent, []);
  assert.deepEqual(log.switched, []);
});

test("a Claude Code session's detail never waits on Orca: the last Orca answer in hand is enough", async () => {
  const { service, log } = world({ twin: true, orcaHangs: true });
  const timeout = new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("waited on Orca")), 2000); timer.unref?.(); });
  const detail = await Promise.race([service.detail("claude-agent:sess-1"), timeout]);
  assert.equal(detail.agent.controls.message.kind, "orca-send");
  assert.deepEqual(await Promise.race([service.message("claude-agent:sess-1", "continue"), timeout]), { sent: true, kind: "orca-send" });
  assert.equal(log.orcaSnapshots, 0);
});

test("a session the Claude app runs opens with the app's own link, nothing else", async () => {
  const { service, log } = world({ desktop: true });
  const detail = await service.detail("claude-agent:sess-desktop");
  assert.deepEqual(detail.agent.controls.open, { kind: "claude-link", label: "Open in Claude" });
  assert.deepEqual(await service.open("claude-agent:sess-desktop"), { opened: true, kind: "claude-link" });
  assert.deepEqual(log.launched, ["claude://code/continue?session=local_0a1b2c3d"]);
});

test("a Codex chat's detail is built from its newest turns, which are reread only when the chat changes", async () => {
  const { service, log, threads, advance } = world();
  const detail = await service.detail(CHAT);
  assert.deepEqual(detail.mission, { text: "Fix the header row", from: "you", at: 1_780_000_100_000 });
  assert.equal(detail.plan.source, "plan");
  assert.equal(detail.now.title, "Running npm run lint");
  assert.equal(detail.trail[1].output, "ok password=[secret removed]");
  assert.deepEqual(detail.agent.controls, { open: { kind: "codex-link", label: "Open in Codex" },
    message: { kind: "codex-reply", label: "Message", hint: "Sends a new message to this chat" }, dismiss: false });
  assert.equal(detail.agent.branch, "main");
  assert.equal(detail.agent.startedAt, 1_780_000_000_000);
  await service.detail(CHAT);
  assert.equal(log.turns.length, 1, "an unchanged chat is not read again");
  threads[0].updatedAt = 2000;
  advance(5000);
  await service.detail(CHAT);
  assert.equal(log.turns.length, 2);
  const helper = await service.detail(HELPER);
  assert.equal(helper.agent.controls.message, null);
  assert.equal(helper.agent.party.coordinatorId, CHAT);
});

test("a working Codex chat is reread at most every five seconds, and only its detail is kept, briefly", async () => {
  const { service, log, advance, setStat } = world();
  let size = 10;
  setStat(() => ({ size: size++, mtimeMs: size })); // The session file grows on every look, as it does while the chat works.
  for (let poll = 0; poll < 6; poll++) { await service.detail(CHAT); advance(2000); }
  assert.equal(log.turns.filter(([id]) => id === CHAT).length, 2, "twelve seconds of two-second polls read the chat twice");
  for (const entry of service.codexCache.values()) assert.equal("thread" in entry, false, "the raw turns are not kept");
  advance(61_000);
  await service.detail(HELPER);
  assert.equal(service.codexCache.has(CHAT), false, "a chat nobody looked at for a minute is forgotten");
});

test("a Codex step's timer counts from when the step was first seen, not from when the turn started", async () => {
  const { service, scene } = world();
  scene.agents[0].now = { kind: "command", title: "Running npm run lint", detail: "npm run lint", startedAt: 1_780_000_150_000 };
  assert.equal((await service.detail(CHAT)).now.startedAt, 1_780_000_150_000);
  // The scene names it with its shell wrapper; the detail without: still the same step.
  scene.agents[0].now = { kind: "command", title: "Running powershell -Command 'npm run lint'", detail: "powershell -Command 'npm run lint'", startedAt: 1_780_000_160_000 };
  assert.equal((await service.detail(CHAT)).now.startedAt, 1_780_000_160_000);
  // Another step: the scene's time is not this one's.
  scene.agents[0].now = { kind: "command", title: "Running npm test", detail: "npm test", startedAt: 1_780_000_170_000 };
  assert.equal((await service.detail(CHAT)).now.startedAt, 1_780_000_100_000);
});

test("Codex open launches its link; message replies, or says to open the app when the chat is open there", async () => {
  const { service, log, setWriter } = world();
  assert.deepEqual(await service.open(CHAT), { opened: true, kind: "codex-link" });
  assert.deepEqual(log.launched, [`codex://threads/${CHAT}`]);
  await assert.rejects(service.open("019a-unknown-0009"), (error) => error.statusCode === 404);
  assert.deepEqual(await service.message(CHAT, "Ship it"), { sent: true, threadId: CHAT, turnId: "turn-9", status: "inProgress" });
  setWriter(true);
  await assert.rejects(service.message(CHAT, "Ship it"), (error) => error.statusCode === 409 && error.extra.requiresOpen === true);
  await assert.rejects(service.message(CHAT, "x".repeat(4001)), (error) => error.statusCode === 400);
  await assert.rejects(service.message(CHAT, ""), (error) => error.statusCode === 400);
  await assert.rejects(service.message(HELPER, "hi"), (error) => error.statusCode === 409);
});

test("Orca and extension agents: the terminal, or nothing to open", async () => {
  const { service, log } = world();
  const orca = await service.detail("orca-agent:tab:a");
  assert.deepEqual(orca.screen, { lines: ["$ npm test"], at: 2 });
  assert.equal(orca.mission.from, "coordinator");
  assert.deepEqual(orca.agent.party, { id: "orca:d29yaw", name: "billing-api", coordinatorId: "orca-agent:tab:f" });
  assert.deepEqual(orca.agent.controls, { open: { kind: "orca-terminal", label: "Open in Orca" },
    message: { kind: "orca-send", label: "Message", hint: "Types into its terminal and presses Enter" }, dismiss: false });
  await service.open("orca-agent:tab:a");
  await service.message("orca-agent:tab:a", "continue");
  assert.deepEqual(log.switched, ["term_a"]);
  assert.deepEqual(log.sent, [["term_a", "continue"]]);
  const ext = await service.detail("ext-agent:relay:night-run:scout");
  assert.deepEqual(ext.agent.controls, { open: null, message: null, dismiss: false });
  assert.deepEqual([ext.mission, ext.trail, ext.screen], [null, [], null]);
  assert.equal(ext.agent.party.name, "Night run");
  await assert.rejects(service.open("ext-agent:relay:night-run:scout"), (error) => error.statusCode === 409);
  await assert.rejects(service.message("ext-agent:relay:night-run:scout", "hi"), (error) => error.statusCode === 409);
  await assert.rejects(service.detail("orca-agent:tab:gone"), (error) => error.statusCode === 404);
  await assert.rejects(service.detail("bad id"), (error) => error.statusCode === 400);
});

test("an actor with an ask offers Dismiss", async () => {
  const { service } = world();
  const scene = await service.scene();
  scene.agents[0].ask = { kind: "question", text: "Ship it?", at: 1, answerHere: "reply", key: "k" };
  assert.equal((await service.detail(CHAT)).agent.controls.dismiss, true);
});

/** The routes on a real local HTTP server with fake readers; `x-remote: 1` plays a paired phone. */
async function serve(service) {
  const route = agentRoutes(service);
  const json = (response, status, data) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(data)); };
  const readBody = async (request) => { let text = ""; for await (const chunk of request) text += chunk; return JSON.parse(text || "{}"); };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const handled = await route(request, response, { url, local: request.headers["x-remote"] !== "1", origin: `http://${request.headers.host}`, json, readBody });
    if (!handled) json(response, 404, { error: "not ours" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = "GET", body, headers = {} } = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  return { base, call, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("the routes answer this computer only, with the same Origin and JSON checks as the other local routes", async () => {
  const { service, log, setWriter } = world();
  const http = await serve(service);
  try {
    const post = { "Content-Type": "application/json", Origin: http.base };
    const detail = await http.call(`/api/agent?id=${encodeURIComponent("claude-agent:sess-1")}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.agent.id, "claude-agent:sess-1");
    assert.equal(detail.body.trail[0].detail, "npm test --token=[secret removed]", "the response passes the secret filter");
    assert.equal((await http.call(`/api/agent?id=${CHAT}`, { headers: { "x-remote": "1" } })).status, 403);
    assert.equal((await http.call("/api/agent?id=..%2F..")).status, 400);
    assert.equal((await http.call("/api/agent?id=orca-agent:tab:gone")).status, 404);
    assert.equal((await http.call("/api/open", { method: "POST", body: { id: CHAT }, headers: { "Content-Type": "application/json" } })).status, 403);
    assert.equal((await http.call("/api/open", { method: "POST", body: { id: CHAT }, headers: { "Content-Type": "text/plain", Origin: http.base } })).status, 403);
    assert.equal((await http.call("/api/open", { method: "POST", body: { id: CHAT }, headers: { ...post, "x-remote": "1" } })).status, 403);
    assert.deepEqual(log.launched, [], "nothing is opened for a refused request");
    assert.deepEqual(await http.call("/api/open", { method: "POST", body: { id: CHAT }, headers: post }), { status: 200, body: { opened: true, kind: "codex-link" } });
    assert.equal((await http.call("/api/message", { method: "POST", body: { id: CHAT, text: "Ship it" }, headers: post })).body.sent, true);
    setWriter(true);
    const busy = await http.call("/api/message", { method: "POST", body: { id: CHAT, text: "Ship it" }, headers: post });
    assert.equal(busy.status, 409);
    assert.equal(busy.body.requiresOpen, true);
    assert.equal((await http.call("/api/message", { method: "POST", body: { id: "nope nope", text: "x" }, headers: post })).status, 400);
    assert.equal((await http.call("/api/agent", { method: "POST", body: {}, headers: post })).status, 404, "a POST to /api/agent is not this route's");
  } finally { await http.close(); }
});

test("app links are opened without a shell, and only the two kinds this server makes", () => {
  const spawned = [];
  const spawn = (command, args, options) => { spawned.push({ command, args, options }); return { on() {}, unref() {} }; };
  assert.equal(launchUrl(`codex://threads/${CHAT}`, { platform: "win32", spawn }), true);
  assert.deepEqual(spawned[0].command, "rundll32.exe");
  assert.deepEqual(spawned[0].args, ["url.dll,FileProtocolHandler", `codex://threads/${CHAT}`]);
  assert.equal(spawned[0].options.shell, undefined);
  assert.equal(launchUrl("claude://code/continue?session=local_0a1b2c3d", { platform: "darwin", spawn }), true);
  assert.deepEqual([spawned[1].command, spawned[1].args], ["open", ["claude://code/continue?session=local_0a1b2c3d"]]);
  for (const bad of ["https://example.com", "codex://threads/../x", `codex://threads/${CHAT}&calc`, "claude://code/continue?session=3f2a-cli-id", "file:///C:/Windows"])
    assert.equal(launchUrl(bad, { platform: "win32", spawn }), false, bad);
  assert.equal(spawned.length, 2);
  assert.equal(launchUrl(`codex://threads/${CHAT}`, { platform: "linux", spawn: () => { throw new Error("no xdg-open"); } }), false);
});

test("the Claude app's session index maps a Claude Code session to the app's own id", () => {
  const root = mkdtempSync(join(tmpdir(), "goblin-desktop-"));
  try {
    const folder = join(root, "account-1", "org-1");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "local_0a1b2c3d.json"), JSON.stringify({ sessionId: "local_0a1b2c3d", cliSessionId: "sess-desktop", cwd: "C:\\work\\notes", isArchived: false, lastActivityAt: 2 }));
    writeFileSync(join(folder, "local_99999999.json"), JSON.stringify({ sessionId: "local_99999999", cliSessionId: "sess-old", isArchived: true }));
    writeFileSync(join(folder, "local_bad.json"), JSON.stringify({ sessionId: "local_bad;calc", cliSessionId: "sess-bad" }));
    writeFileSync(join(folder, "local_broken.json"), "{not json");
    let now = 0;
    const index = new ClaudeDesktopIndex({ dir: root, clock: () => now });
    assert.equal(index.linkFor("sess-desktop"), "claude://code/continue?session=local_0a1b2c3d");
    assert.equal(index.linkFor("sess-old"), "", "archived sessions are not offered");
    assert.equal(index.linkFor("sess-bad"), "");
    assert.equal(index.linkFor("unknown"), "");
    assert.equal(index.linkFor("../x"), "");
    writeFileSync(join(folder, "local_11111111.json"), JSON.stringify({ sessionId: "local_11111111", cliSessionId: "sess-new" }));
    assert.equal(index.linkFor("sess-new"), "", "the index is rescanned at most every 30 seconds");
    now = 31_000;
    assert.equal(index.linkFor("sess-new"), "claude://code/continue?session=local_11111111");
    assert.equal(new ClaudeDesktopIndex({ dir: join(root, "missing") }).linkFor("sess-desktop"), "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a session's Orca pane and its git branch are found without guessing", () => {
  const session = { id: "claude-agent:s1", source: "claude", cwd: "C:\\work\\billing-api" };
  const pane = { id: "orca-agent:p", source: "orca", pane: "p", terminal: "term_p", cwd: "c:/work/billing-api/", role: "claude · working", status: "working" };
  const proof = { paneMarks: (agent) => (agent.id === pane.id ? ["m1"] : []), sessionMarks: (agent) => (agent.id === session.id ? ["m1"] : []) };
  assert.equal(orcaTwin(session, [pane], [session], proof), pane);
  assert.equal(orcaTwin(session, [pane], [session]), null, "one pane in the session's folder is no proof");
  assert.equal(orcaTwin(session, [{ ...pane, role: "codex · working" }], [session], proof), null);
  assert.equal(orcaTwin(session, [{ ...pane, terminal: "" }], [session], proof), null);
  assert.equal(orcaTwin(session, [{ ...pane, status: "unavailable" }], [session], proof), null);
  assert.equal(orcaTwin({ cwd: "" }, [pane], [], proof), null);
  const files = { [join("C:\\repo", ".git", "HEAD")]: "ref: refs/heads/ship-csv\n", [join("C:\\wt", ".git")]: "gitdir: C:\\repo\\.git\\worktrees\\wt\n",
    [join("C:\\repo\\.git\\worktrees\\wt", "HEAD")]: "ref: refs/heads/fix-header\n", [join("C:\\detached", ".git", "HEAD")]: "0123456789abcdef\n" };
  const read = (path) => { if (path in files) return files[path]; throw new Error("ENOENT"); };
  assert.equal(gitBranch("C:\\repo", { read }), "ship-csv");
  assert.equal(gitBranch("C:\\wt", { read }), "fix-header");
  assert.equal(gitBranch("C:\\detached", { read }), "");
  assert.equal(gitBranch("C:\\nowhere", { read }), "");
  assert.equal(gitBranch("", { read }), "");
});
