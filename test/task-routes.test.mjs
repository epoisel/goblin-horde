import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendClaudeRecord, normalizeHookEvent } from "../lib/claude.mjs";
import { encodeProjectDir } from "../lib/claude-detail.mjs";
import { TaskService, claudeSource, codexSource, taskRoutes } from "../lib/task-service.mjs";
import { orcaSource } from "../lib/orca.mjs";

const ORIGIN = "http://127.0.0.1:44905";

/** One route call against fakes: { status, body }. */
async function call(route, { method = "GET", path, local = true, headers = {}, body = null }) {
  const url = new URL(path, ORIGIN);
  let answer = null;
  const json = (_response, status, data) => { answer = { status, body: data }; };
  const request = { method, headers };
  const handled = await route(request, {}, { url, local, origin: ORIGIN, json, readBody: async () => body });
  return handled ? answer : null;
}

test("the task routes answer this computer only, and opening the app window takes the local-route checks", async () => {
  const opened = [];
  const service = {
    tasks: async ({ window }) => ({ tasks: [], window: { hours: window === "4h" ? 4 : 24 } }),
    transcript: async ({ id }) => ({ agent: { id }, entries: [] }),
    // An Orca pane that is a Claude Code session is placed by that session's id.
    place: async (agentId) => (agentId === "orca-agent:tab-1:leaf-1" ? { taskId: "chat-lead-0001", agentId: "claude-agent:work-1" } : null),
  };
  const route = taskRoutes(service, { open: async (target) => { opened.push(target); return { opened: true, browser: "edge", url: "http://127.0.0.1:1/app" }; } });
  assert.equal((await call(route, { path: "/api/tasks", local: false })).status, 403, "a paired phone never gets the task list");
  assert.equal((await call(route, { path: "/api/transcript?id=chat-0001-abc", local: false })).status, 403, "nor a transcript");
  assert.equal((await call(route, { path: "/api/tasks?window=4h" })).body.window.hours, 4);
  assert.equal((await call(route, { path: "/api/transcript?id=chat-0001-abc" })).body.agent.id, "chat-0001-abc");
  assert.equal(await call(route, { path: "/api/scene" }), null, "other routes pass through");
  const json = { "content-type": "application/json", origin: ORIGIN };
  assert.equal((await call(route, { method: "POST", path: "/api/app/open", local: false, headers: json, body: {} })).status, 403);
  assert.equal((await call(route, { method: "POST", path: "/api/app/open", headers: { "content-type": "application/json" }, body: {} })).status, 403, "another site's page cannot open it");
  assert.equal((await call(route, { method: "POST", path: "/api/app/open", headers: json, body: { agentId: "../../etc" } })).status, 400);
  const ok = await call(route, { method: "POST", path: "/api/app/open", headers: json, body: { agentId: "orca-agent:tab-1:leaf-1" } });
  assert.equal(ok.status, 200);
  assert.deepEqual(opened, [{ taskId: "chat-lead-0001", agentId: "claude-agent:work-1" }], "the goblin's own task is opened, on the id the task list shows");
  await call(route, { method: "POST", path: "/api/app/open", headers: json, body: { agentId: "chat-0009-unlisted" } });
  assert.deepEqual(opened.at(-1), { taskId: "", agentId: "chat-0009-unlisted" }, "a goblin in no task still opens the task view");
  const failing = taskRoutes(service, { open: async () => ({ opened: false }) });
  assert.equal((await call(failing, { method: "POST", path: "/api/app/open", headers: json, body: {} })).status, 500);
});

test("with a window already open, the strip's click switches that window's task instead of opening another", async () => {
  let now = 1_000_000;
  const opened = [];
  const service = {
    tasks: async () => ({ tasks: [], window: { hours: 24 } }),
    place: async (agentId) => (agentId === "claude-agent:work-1:sub-1" ? { taskId: "chat-lead-0001", agentId } : null),
  };
  const route = taskRoutes(service, { open: async (target) => { opened.push(target); return { opened: true }; }, clock: () => now });
  const json = { "content-type": "application/json", origin: ORIGIN };
  assert.equal((await call(route, { path: "/api/tasks" })).body.focus, undefined, "nothing asked yet");
  const reused = await call(route, { method: "POST", path: "/api/app/open", headers: json, body: { agentId: "claude-agent:work-1:sub-1", reuse: true } });
  assert.equal(reused.status, 200);
  assert.equal(reused.body.reused, true);
  assert.deepEqual(opened, [], "no new window");
  const asked = (await call(route, { path: "/api/tasks" })).body.focus;
  assert.deepEqual([asked.seq, asked.taskId, asked.agentId], [1, "chat-lead-0001", "claude-agent:work-1:sub-1"]);
  await call(route, { method: "POST", path: "/api/app/open", headers: json, body: { taskId: "chat-lead-0002", reuse: true } });
  assert.equal((await call(route, { path: "/api/tasks" })).body.focus.seq, 2, "each click is a new request");
  const second = (await call(route, { path: "/api/tasks" })).body.focus;
  assert.notEqual(second.id, asked.id);
  // A restarted viewer counts from 1 again, but its ids never repeat an earlier viewer's.
  const restarted = taskRoutes(service, { open: async () => ({ opened: true }), clock: () => now + 5 });
  await call(restarted, { method: "POST", path: "/api/app/open", headers: json, body: { taskId: "chat-lead-0002", reuse: true } });
  const fresh = (await call(restarted, { path: "/api/tasks" })).body.focus;
  assert.equal(fresh.seq, 1);
  assert.ok(fresh.id !== asked.id && fresh.id !== second.id, "a page that saw the old viewer still takes the new request");
  now += 61_000;
  assert.equal((await call(route, { path: "/api/tasks" })).body.focus, undefined, "an old request is not replayed a minute later");
  assert.equal((await call(route, { method: "POST", path: "/api/app/open", local: false, headers: json, body: { reuse: true } })).status, 403, "only this computer");
});

test("each source says plainly what is wrong and what to do", () => {
  assert.deepEqual(orcaSource({ workspaces: [], warning: "Orca feed is unavailable: Orca is not running.", failure: "not-running" }, true),
    { state: "unavailable", reason: "unreachable", say: "Orca is running, but its command line can't reach it — restart Orca. Until then its workers are grouped from their Claude Code records." });
  assert.equal(orcaSource({ workspaces: [], warning: "x", failure: "not-running" }, false).reason, "not-running");
  assert.equal(orcaSource({ workspaces: [], warning: "", missing: true }, false).state, "not-installed");
  assert.equal(orcaSource({ workspaces: [], warning: "", missing: true }, true).reason, "unreachable", "Orca runs but its command line is not on PATH");
  assert.equal(orcaSource({ workspaces: [], warning: "" }, null).state, "ok");
  assert.equal(codexSource({ state: "ok" }, { cutInWindow: true }).state, "partial");
  assert.equal(codexSource({ state: "not-installed" }).state, "not-installed");
  assert.equal(codexSource({ state: "unavailable", detail: "Codex stopped." }).say, "Codex stopped.");
  assert.equal(claudeSource({ state: "installed" }).state, "ok");
  assert.match(claudeSource({ state: "missing" }, { transcripts: 3 }).say, /transcripts only.*hooks install/);
  assert.equal(claudeSource({ state: "missing" }, { projects: false }).state, "not-installed");
});

test("the task list never waits long on a slow source, and a slow spawned-chat list is read in the background", async () => {
  let clock = 1_800_000_000_000;
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const service = new TaskService({ clock: () => clock, waitMs: 30,
    codex: { listThreads: () => new Promise(() => {}), lastThreads: () => [{ id: "chat-last-list-1", name: "From the last list", updatedAt: clock - 1000 }],
      listSpawned: () => slow, actors: () => new Map(), health: () => ({ state: "ok" }) },
    orca: { snapshot: () => new Promise(() => {}), lastSnapshot: () => ({ workspaces: [], warning: "Orca feed is unavailable: Orca is not running.", failure: "not-running" }) },
    orcaRunning: async () => true });
  const started = Date.now();
  const first = await service.tasks({ window: "24h" });
  assert.ok(Date.now() - started < 2000);
  assert.equal(first.sources.orca.reason, "unreachable");
  assert.equal(first.sources.codex.state, "partial", "a chat list still loading says so");
  assert.ok(first.tasks.some((task) => task.id === "chat-last-list-1"), "and the last list stands in");
  release([{ id: "chat-kid-0001", name: "Helper", updatedAt: clock - 1000, parentThreadId: "chat-gone-0001" }]);
  await slow;
  await new Promise((resolve) => setTimeout(resolve, 10));
  clock += 2000;
  const second = await service.tasks({ window: "24h" });
  assert.ok(second.tasks.some((task) => task.agents.some((agent) => agent.id === "chat-kid-0001")), "the helper shows once listed");
});

async function freePort() {
  const probe = createServer(() => {});
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const term = (n) => `term_${String(n).padStart(8, "0")}-1111-4222-8333-444455556666`;

test("an isolated viewer serves tasks, transcripts, and the app window from synthetic hook records and transcripts", { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "goblin-tasks-e2e-"));
  const state = join(root, "state");
  const config = join(root, "claude");
  const project = join(config, "projects", encodeProjectDir("/work/export"));
  mkdirSync(join(state, "claude"), { recursive: true });
  mkdirSync(project, { recursive: true });
  const base = Date.now() - 20 * 60_000;
  let counter = 0;
  const hook = (session, event, extra, minute, env = null) => appendClaudeRecord(normalizeHookEvent({ hook_event_name: event, session_id: session, cwd: "/work/export", ...extra },
    { now: base + minute * 60_000, id: (0xe2e000 + ++counter).toString(16).padStart(12, "0"), env }), { dir: join(state, "claude") });
  const orcaEnv = (n) => ({ ORCA_TERMINAL_HANDLE: term(n), ORCA_WORKTREE_ID: "repo-1::/work/export" });
  hook("coord-e2e", "SessionStart", { source: "startup" }, 0, orcaEnv(1));
  hook("coord-e2e", "UserPromptSubmit", { prompt: "Coordinate the export" }, 1, orcaEnv(1));
  hook("coord-e2e", "PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_d", tool_input: { command: `orca orchestration dispatch --task t1 --to ${term(2)}` } }, 2);
  hook("work-e2e", "UserPromptSubmit", { prompt: "Write the CSV writer" }, 3, orcaEnv(2));
  hook("work-e2e", "PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_w", tool_input: { command: "npm test" } }, 19);
  // The coordinator's transcript, and a session the hook never saw.
  const line = (record) => `${JSON.stringify(record)}\n`;
  const at = (minute) => new Date(base + minute * 60_000).toISOString();
  const coordinatorFile = join(project, "coord-e2e.jsonl");
  writeFileSync(coordinatorFile, [
    line({ type: "user", uuid: "c-1", timestamp: at(1), cwd: "/work/export", message: { role: "user", content: "Coordinate the export" } }),
    line({ type: "assistant", uuid: "c-2", timestamp: at(2), message: { role: "assistant", model: "claude-opus-4-1", content: [{ type: "tool_use", id: "toolu_d", name: "Bash", input: { command: "orca orchestration dispatch" } }] } }),
    line({ type: "user", uuid: "c-3", timestamp: at(2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_d", content: "dispatched" }] } }),
  ].join(""));
  writeFileSync(join(project, "lone-e2e.jsonl"), [
    line({ type: "user", uuid: "l-1", timestamp: at(5), cwd: "/work/export", message: { role: "user", content: "Tidy the changelog" } }),
    line({ type: "ai-title", aiTitle: "Tidy the changelog", sessionId: "lone-e2e" }),
  ].join(""));
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), GOBLIN_HORDE_STATE_DIR: state, LOCALAPPDATA: join(root, "local"), APPDATA: join(root, "roaming"), CLAUDE_CONFIG_DIR: config,
    CODEX_HOME: join(root, "codex"), CODEX_CLI_PATH: join(root, "no-codex.exe"), ORCA_CLI_COMMAND: join(root, "no-orca"), LAN_IP: "10.255.255.254",
    // A harmless program stands in for the browser: it is started with the app-window flags and exits.
    GOBLIN_HORDE_APP_BROWSER: process.execPath };
  const server = join(fileURLToPath(new URL("..", import.meta.url)), "server.mjs");
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [server], { env, stdio: "ignore", windowsHide: true });
  try {
    for (let tries = 0; ; tries++) {
      try { if ((await fetch(`${url}/api/health`)).ok) break; } catch { /* Not up yet. */ }
      if (tries > 100) throw new Error("The viewer did not start.");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const get = async (path) => (await fetch(`${url}${path}`)).json();
    let listed = await get("/api/tasks?window=24h");
    for (let tries = 0; tries < 30 && !listed.tasks.some((task) => task.id === "claude-agent:lone-e2e"); tries++) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      listed = await get("/api/tasks?window=24h");
    }
    const task = listed.tasks.find((item) => item.id === "claude-agent:coord-e2e");
    assert.ok(task, "the coordinator leads a task");
    assert.deepEqual(task.agents.map((agent) => [agent.id, agent.role, agent.parentId || ""]), [["claude-agent:coord-e2e", "coordinator", ""], ["claude-agent:work-e2e", "worker", "claude-agent:coord-e2e"]]);
    assert.deepEqual(task.links.map((item) => item.kind), ["dispatched"]);
    assert.equal(task.status, "working");
    const lone = listed.tasks.find((item) => item.id === "claude-agent:lone-e2e");
    assert.equal(lone.title, "Tidy the changelog", "a session only its transcript shows is listed, named from it");
    assert.equal(lone.agents[0].seenBy, "transcript");
    // No Orca command line here; whether Orca's app runs on the test computer decides which of the two it says.
    assert.ok(listed.sources.orca.state === "not-installed" || listed.sources.orca.reason === "unreachable", JSON.stringify(listed.sources.orca));
    assert.equal(listed.sources.claude.state, "partial", "the hooks are not in this Claude config's settings");
    assert.equal(listed.window.hours, 24);
    // The coordinator's transcript, then what is new.
    const page = await get(`/api/transcript?id=${encodeURIComponent("claude-agent:coord-e2e")}`);
    assert.deepEqual(page.entries.map((entry) => entry.kind), ["prompt", "tool"]);
    assert.equal(page.entries[1].tool.output, "dispatched");
    assert.equal(page.agent.role, "coordinator");
    assert.equal(page.live, true);
    appendFileSync(coordinatorFile, line({ type: "assistant", uuid: "c-4", timestamp: at(21), message: { role: "assistant", content: [{ type: "text", text: "Worker dispatched." }] } }));
    const newer = await get(`/api/transcript?id=${encodeURIComponent("claude-agent:coord-e2e")}&after=${page.cursor.last}`);
    assert.deepEqual(newer.entries.map((entry) => entry.text), ["Worker dispatched."]);
    const noCodex = await fetch(`${url}/api/transcript?id=chat-0001-nope`);
    assert.equal(noCodex.status, 503, "Codex is not on this test computer");
    assert.equal((await noCodex.json()).error, "Codex is not available right now.");
    assert.equal((await fetch(`${url}/api/transcript?id=..%2F..%2Fetc`)).status, 400);
    // The app window, opened on the worker's task, never from another site's page.
    const post = (body, headers = { "Content-Type": "application/json", Origin: url }) => fetch(`${url}/api/app/open`, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal((await post({ agentId: "claude-agent:work-e2e" }, { "Content-Type": "application/json" })).status, 403);
    const opened = await (await post({ agentId: "claude-agent:work-e2e" })).json();
    assert.equal(opened.opened, true);
    assert.equal(opened.url, `http://127.0.0.1:${port}/app#task=claude-agent%3Acoord-e2e&focus=claude-agent%3Awork-e2e`);
    // The page itself: /app moves to /app/ and only the task view's own files are served there.
    const redirect = await fetch(`${url}/app`, { redirect: "manual" });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), "/app/");
    const appRoot = join(fileURLToPath(new URL("..", import.meta.url)), "public", "app");
    const index = await fetch(`${url}/app/`);
    if (existsSync(join(appRoot, "index.html"))) {
      assert.equal(index.status, 200);
      assert.match(index.headers.get("content-security-policy"), /script-src 'self'/);
    } else assert.equal(index.status, 404);
    assert.equal((await fetch(`${url}/app/server.mjs`)).status, 404);
    // What was learned is saved for the next start.
    for (let tries = 0; tries < 20 && !existsSync(join(state, "task-links.json")); tries++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(existsSync(join(state, "task-links.json")));
  } finally {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
    rmSync(root, { recursive: true, force: true });
  }
});
