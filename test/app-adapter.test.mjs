import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENDPOINTS, agentAction, agentTone, asText, createClient, normalizeEntry, normalizeSource, normalizeTasks, normalizeTranscript, orderAgents,
  stripAnsi, toMs, toolKindOf } from "../public/app/adapter.js";
import { createDemo } from "../public/app/demo-data.js";
import { scanFile } from "../scripts/package.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("times arrive in milliseconds, seconds, or ISO text", () => {
  assert.equal(toMs(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(toMs(1_700_000_000), 1_700_000_000_000);
  assert.equal(toMs("1700000000"), 1_700_000_000_000);
  assert.equal(toMs("2026-10-15T12:00:00Z"), Date.parse("2026-10-15T12:00:00Z"));
  assert.deepEqual([toMs(null), toMs(""), toMs("soon"), toMs(-4), toMs(0)], [null, null, null, null, null]);
});

test("source health maps every word the server uses to four states with plain words", () => {
  assert.deepEqual(normalizeSource("orca", { state: "unavailable", say: "Restart Orca." }), { key: "orca", name: "Orca", state: "unavailable", say: "Restart Orca." });
  assert.equal(normalizeSource("claude", { state: "not-connected", detail: "Run hooks install." }).say, "Run hooks install.");
  assert.equal(normalizeSource("claude", { state: "not-connected" }).state, "partial");
  assert.equal(normalizeSource("codex", { state: "ready" }).state, "ok");
  assert.equal(normalizeSource("orca", "missing").state, "not-installed");
  assert.equal(normalizeSource("codex", { state: "weird" }).state, "partial");
  assert.ok(normalizeSource("codex", {}).say);
});

test("a task list with missing fields still lays out lead, coordinator, workers, subagents", () => {
  const result = normalizeTasks({
    tasks: [{
      id: "t1",
      agents: [
        { id: "orca:w:term-b", name: "Worker B", status: "working", updatedAt: 1_700_000_100 },
        { id: "chat-0001-lead", name: "Lead chat", model: "gpt-5.6-sol", status: "inProgress" },
        { id: "orca:w:term-a", name: "Worker A", waitingOn: { on: "orca:w:term-c", text: "Which path?" } },
        { id: "orca:w:term-c", name: "Coordinator", model: { id: "claude-opus-5-5", label: "Opus 5.5", family: "claude" } },
        { id: "claude-agent:s1:sub1", name: "Explore", parentId: "orca:w:term-b" },
      ],
      links: [{ from: "chat-0001-lead", to: "orca:w:term-c", kind: "drives" }, { from: "orca:w:term-c", to: "orca:w:term-a", kind: "dispatched" },
        { from: "orca:w:term-c", to: "orca:w:term-b", kind: "dispatched" }, { from: "orca:w:term-a", to: "orca:w:term-c", kind: "asked" }, { from: "nobody", to: "orca:w:term-a" }],
    }],
    sources: { codex: { state: "ok" } },
  });
  const [task] = result.tasks;
  // The chat that drives comes first, its coordinator next, the workers side by side, then the subagent.
  assert.deepEqual(task.agents.map((agent) => `${agent.role}:${agent.name}:${agent.depth}`),
    ["lead:Lead chat:0", "coordinator:Coordinator:1", "worker:Worker B:2", "worker:Worker A:2", "subagent:Explore:3"]);
  assert.equal(task.links.length, 4, "links to unknown agents are dropped");
  assert.equal(task.title, "Lead chat");
  assert.equal(task.agents.find((agent) => agent.name === "Coordinator").parentId, "chat-0001-lead");
  assert.equal(task.agents.find((agent) => agent.name === "Worker A").tone, "waiting");
  assert.equal(task.agents.find((agent) => agent.name === "Lead chat").model.family, "openai");
  assert.equal(task.status, "working");
  assert.equal(result.window.hours, 24);
});

test("the server's task list: windows, aliases, and who is waiting on whom right now", () => {
  assert.deepEqual([4, 24, 168].map((hours) => ENDPOINTS.tasks(hours)), ["/api/tasks?window=4h", "/api/tasks?window=24h", "/api/tasks?window=7d"]);
  const result = normalizeTasks({
    tasks: [{ id: "chat-lead-01", title: "Lead", project: "kettle", status: "working", needs: 0, working: 2,
      agents: [
        { id: "chat-lead-01", name: "Lead", role: "lead", depth: 0, status: "working", project: "kettle", seenBy: "codex" },
        { id: "claude-agent:coord", name: "Coordinator", role: "coordinator", parentId: "chat-lead-01", depth: 1, status: "working", orca: { terminal: "term_c1" } },
        { id: "claude-agent:w1", name: "Worker", role: "worker", parentId: "claude-agent:coord", depth: 2, status: "working" },
      ],
      links: [{ from: "chat-lead-01", to: "claude-agent:coord", kind: "drives" }, { from: "claude-agent:coord", to: "claude-agent:w1", kind: "dispatched", at: 1_800_000_000 },
        { from: "claude-agent:w1", to: "claude-agent:coord", kind: "asked", at: 1_800_000_100, waiting: true }, { from: "chat-lead-01", to: "claude-agent:w1", kind: "drives", manual: true }] }],
    sources: { orca: { state: "unavailable", say: "Orca is running, but its command line can't reach it — restart Orca.", reason: "unreachable" } },
    window: { hours: 168, since: 1_799_000_000_000 }, aliases: { "orca-agent:ws:term_c1": "claude-agent:coord", bad: 5 }, counts: { agents: 3, tasks: 1, nodes: 3 },
  });
  const [task] = result.tasks;
  assert.deepEqual(result.aliases, { "orca-agent:ws:term_c1": "claude-agent:coord" });
  assert.deepEqual(result.window, { hours: 168, since: 1_799_000_000_000 });
  assert.equal(result.sources[0].say, "Orca is running, but its command line can't reach it — restart Orca.", "the server's words, verbatim");
  const worker = task.agents[2];
  assert.deepEqual([worker.tone, worker.waitingOn.on], ["waiting", "claude-agent:coord"], "a waiting 'asked' link is a wait on that agent");
  assert.deepEqual([task.agents[1].terminal, task.agents[0].seenBy, task.project], ["term_c1", "codex", "kettle"]);
  assert.equal(task.links.find((link) => link.manual).kind, "drives");
});

test("the server's own roles and order are kept when it sends them", () => {
  const agents = [
    { id: "a", name: "Lead", role: "lead", depth: 0 },
    { id: "b", name: "Coord", role: "coordinator", parentId: "a", depth: 1 },
    { id: "c", name: "W1", role: "worker", parentId: "b", depth: 2 },
    { id: "d", name: "W2", role: "worker", parentId: "b", depth: 2 },
    { id: "e", name: "Sub of W1", role: "subagent", parentId: "c", depth: 3 },
  ];
  const [task] = normalizeTasks([{ id: "t", title: "A task", project: "kettle", status: "needs", needs: 1, working: 2, agents: [agents[4], agents[2], agents[0], agents[3], agents[1]] }]).tasks;
  assert.deepEqual(task.agents.map((agent) => agent.id), ["a", "b", "c", "d", "e"]);
  assert.deepEqual([task.status, task.needs, task.working, task.title, task.project], ["needs", 1, 2, "A task", "kettle"]);
  assert.deepEqual(orderAgents([{ id: "x", role: "worker" }, { id: "y", role: "lead" }]).map((agent) => agent.id), ["y", "x"]);
});

test("tones and goblin actions read the shared actor fields", () => {
  assert.equal(agentTone({ ask: { text: "?" } }), "needs");
  assert.equal(agentTone({ status: "waiting" }), "needs");
  assert.equal(agentTone({ status: "failed" }), "failed");
  assert.equal(agentTone({ status: "failed", attention: "quiet" }), "idle", "an old failure is history");
  assert.equal(agentTone({ status: "working", waitingOn: { on: "x" } }), "waiting");
  assert.equal(agentTone({ status: "inProgress" }), "working");
  assert.equal(agentTone({ status: "completed" }), "done");
  assert.equal(agentAction({ ask: { text: "?" } }), "waiting");
  assert.equal(agentAction({ status: "error" }), "trouble");
  assert.equal(agentAction({ status: "working", now: { kind: "read", title: "Reading a.ts" } }), "search");
  assert.equal(agentAction({ status: "working", now: { kind: "edit", title: "Editing a.ts" } }), "build");
  assert.equal(agentAction({ status: "working", now: { kind: "command", title: "Running npm test" } }), "search");
  assert.equal(agentAction({ status: "working", now: { kind: "command", title: "Running npm run build" } }), "build");
  assert.equal(agentAction({ status: "idle" }), "idle");
});

test("entries from Codex items and Claude records normalise to the spec's kinds", () => {
  const command = normalizeEntry({ id: "1", type: "commandExecution", command: "npm test", exit_code: 1, aggregatedOutput: "\x1b[31mFAIL\x1b[0m one", status: "completed", durationMs: 900 });
  assert.equal(command.kind, "tool");
  assert.deepEqual([command.tool.kind, command.tool.input, command.tool.exitCode, command.tool.status, command.tool.output], ["command", "npm test", 1, "failed", "FAIL one"]);
  const edit = normalizeEntry({ id: "2", kind: "tool", tool: { name: "MultiEdit", input: { file_path: "a.ts", edits: [] }, status: "success", files: ["a.ts"] } });
  assert.deepEqual([edit.tool.kind, edit.tool.status, edit.tool.files[0].path], ["edit", "ok", "a.ts"]);
  assert.match(edit.tool.input, /"file_path": "a.ts"/);
  assert.equal(normalizeEntry({ id: "3", type: "agentMessage", text: "hi" }).kind, "message");
  assert.equal(normalizeEntry({ id: "4", type: "userMessage", text: "go", from: "orchestrator" }).from, "coordinator");
  assert.equal(normalizeEntry({ id: "5", kind: "thinking", text: "hmm" }).kind, "reasoning");
  const plan = normalizeEntry({ id: "6", kind: "todo", todos: [{ content: "One", status: "completed" }, { content: "Two", status: "in_progress" }, "Three"] });
  assert.deepEqual(plan.plan.steps, [{ text: "One", status: "done" }, { text: "Two", status: "active" }, { text: "Three", status: "pending" }]);
  const spawn = normalizeEntry({ id: "7", kind: "tool", tool: { name: "Task", input: { description: "Find readers" }, agentId: "claude-agent:s:a1", status: "ok" } });
  assert.deepEqual([spawn.kind, spawn.agentId], ["subagent", "claude-agent:s:a1"]);
  const cut = normalizeEntry({ id: "8", kind: "tool", tool: { name: "shell", input: "cat big.log", output: ["a", "b"], outputTruncated: { shownBytes: 10, totalBytes: 99 }, status: "ok" } });
  assert.deepEqual([cut.tool.output, cut.tool.outputTruncated], ["a\nb", { shownBytes: 10, totalBytes: 99 }]);
  const change = normalizeEntry({ id: "10", type: "fileChange", status: "completed", changes: [{ path: "src/a.ts", kind: "update", diff: "@@ -1 +1 @@\n-a\n+b" }, { path: "src/b.ts", diff: "@@ -0,0 +1 @@\n+new" }] });
  assert.deepEqual([change.tool.kind, change.tool.files.map((file) => file.path)], ["edit", ["src/a.ts", "src/b.ts"]]);
  assert.match(change.tool.diff, /^--- a\/src\/a\.ts\n\+\+\+ b\/src\/a\.ts\n@@ -1 \+1 @@/);
  assert.match(change.tool.diff, /\+\+\+ b\/src\/b\.ts\n@@ -0,0 \+1 @@\n\+new$/);
  assert.equal(normalizeEntry({ id: "9", kind: "mystery", text: "?" }).kind, "system");
  assert.equal(normalizeEntry({ kind: "error", text: "boom" }).kind, "error");
  // Entries without ids get stable ones, so a re-sent entry is recognised.
  assert.equal(normalizeEntry({ kind: "message", text: "same", at: 5 }).id, normalizeEntry({ kind: "message", text: "same", at: 5 }).id);
  assert.notEqual(normalizeEntry({ kind: "message", text: "same", at: 5 }).id, normalizeEntry({ kind: "message", text: "other", at: 5 }).id);
  assert.equal(toolKindOf("mcp__github__get_issue"), "mcp");
  assert.equal(toolKindOf("WebFetch"), "web");
  assert.equal(stripAnsi("\x1b]0;title\x07\x1b[1;32mok\x1b[0m"), "ok");
  assert.equal(asText({ a: 1 }), "{\n  \"a\": 1\n}");
});

test("transcript pages accept the server's small deviations", () => {
  const page = normalizeTranscript({ items: [{ id: "a", kind: "message", text: "x" }, { id: "a", kind: "message", text: "y" }], cursor: "c-9", hasMore: true });
  assert.deepEqual(page.entries.map((item) => item.text), ["y"]);
  assert.deepEqual(page.cursor, { first: "a", last: "c-9" });
  assert.equal(page.hasOlder, true);
  assert.deepEqual(normalizeTranscript(null).entries, []);
});

test("the client calls the spec's endpoints with the bodies the server reads", async () => {
  assert.equal(ENDPOINTS.tasks(24), "/api/tasks?window=24h");
  assert.equal(ENDPOINTS.transcript("claude-agent:s:a", { after: "c1" }), "/api/transcript?id=claude-agent%3As%3Aa&after=c1");
  assert.equal(ENDPOINTS.transcript("x", { before: "c0", limit: 200 }), "/api/transcript?id=x&before=c0&limit=200");
  const calls = [];
  const fetcher = async (path, options = {}) => {
    calls.push([path, options.method || "GET", options.body ? JSON.parse(options.body) : null]);
    if (path === "/api/open") return { ok: false, status: 409, json: async () => ({ error: "It runs in a terminal outside Orca." }) };
    return { ok: true, status: 200, json: async () => (path.startsWith("/api/tasks") ? { tasks: [] } : path.startsWith("/api/transcript") ? { entries: [] } : { ok: true }) };
  };
  const client = createClient({ fetcher });
  await client.tasks(4);
  await client.transcript("abc12345", { after: "t:1" });
  await client.respond("abc12345", "17", { decision: "accept" });
  await client.message("abc12345", "carry on");
  await client.dismiss("abc12345", "k1");
  await client.join("claude-agent:s", "abc12345");
  await assert.rejects(client.open("abc12345"), /terminal outside Orca/);
  assert.deepEqual(calls, [
    ["/api/tasks?window=4h", "GET", null],
    ["/api/transcript?id=abc12345&after=t%3A1", "GET", null],
    ["/api/respond", "POST", { threadId: "abc12345", requestId: "17", decision: "accept" }],
    ["/api/message", "POST", { id: "abc12345", text: "carry on" }],
    ["/api/dismiss", "POST", { id: "abc12345", key: "k1" }],
    ["/api/join", "POST", { party: "claude-agent:s", chat: "abc12345" }],
    ["/api/open", "POST", { id: "abc12345" }],
  ]);
});

test("the demo covers every case the task view must show, in the spec's shapes", async () => {
  let clock = Date.parse("2026-10-15T12:00:00Z");
  const demo = createDemo({ clock: () => clock, latency: false });
  const client = createClient({ demo });
  const { tasks, sources } = await client.tasks(24);
  const checkout = tasks.find((task) => task.id === "task-checkout");
  assert.deepEqual(checkout.agents.map((agent) => agent.role), ["lead", "coordinator", "worker", "worker", "worker"]);
  assert.deepEqual(checkout.agents.map((agent) => agent.tone), ["working", "working", "waiting", "working", "done"]);
  assert.deepEqual(tasks.find((task) => task.id === "task-lantern").agents.map((agent) => agent.role), ["lead", "subagent", "subagent"]);
  assert.equal(tasks.find((task) => task.id === "task-config").agents[0].ask.answerHere, "respond");
  assert.equal(sources.find((source) => source.key === "orca").state, "unavailable");
  assert.equal((await client.tasks(168)).tasks.length, tasks.length + 1, "the 7-day window shows one more task");

  for (const task of tasks) for (const agent of task.agents) {
    if (agent.id === demo.ids.theme) { await assert.rejects(client.transcript(agent.id, {}), /moved or been deleted/); continue; }
    const page = await client.transcript(agent.id, {});
    assert.equal(new Set(page.entries.map((item) => item.id)).size, page.entries.length, `${agent.name}: unique ids`);
  }
  const tests = await client.transcript(demo.ids.tests, {});
  const big = tests.entries.find((item) => item.tool?.output.length > 300 * 1024 - 1);
  assert.ok(big, "a 300 KB output");
  const lead = await client.transcript(demo.ids.lead, {});
  assert.equal(lead.hasOlder, true);
  const older = await client.transcript(demo.ids.lead, { before: lead.cursor.first });
  assert.ok(older.entries.length > 0 && !older.entries.some((item) => lead.entries.some((other) => other.id === item.id)));
  // Time passes: the worker's question is answered and its waiting command finishes.
  const pay = await client.transcript(demo.ids.pay, {});
  const waiting = pay.entries.find((item) => item.tool?.status === "running");
  assert.ok(waiting);
  clock += 60_000;
  const later = await client.transcript(demo.ids.pay, { after: pay.cursor.last });
  assert.ok(later.entries.some((item) => item.id === waiting.id && item.tool.status === "ok"), "a finished command is sent again, changed");
  assert.ok(later.entries.some((item) => item.kind === "prompt" && item.from === "coordinator"));
  const quiet = await client.transcript(demo.ids.pay, { after: later.cursor.last });
  assert.equal(quiet.entries.length, 0);
  // Answering the approval clears the ask.
  await client.respond(demo.ids.config, "17", { decision: "accept" });
  assert.equal((await client.tasks(24)).tasks.find((task) => task.id === "task-config").agents[0].ask, null);
});

test("the shipped app files have no personal paths, addresses, or credentials", () => {
  for (const file of ["index.html", "app.css", "app.js", "adapter.js", "transcript.js", "markdown.js", "diff.js", "demo-data.js"]) {
    const text = readFileSync(join(root, "public", "app", file), "utf8");
    assert.deepEqual(scanFile(`public/app/${file}`, text), [], file);
  }
});
