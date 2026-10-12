import test from "node:test";
import assert from "node:assert/strict";
import { markRunningElsewhere, RUNNING_ELSEWHERE_MS, transformThread, toMilliseconds } from "../lib/transform.mjs";

test("normalizes Codex timestamps for ordering beside Orca actors", () => {
  assert.equal(toMilliseconds(1791545642), 1791545642000);
  assert.equal(toMilliseconds(1791545642000), 1791545642000);
  const transformed = transformThread({ id: "t", updatedAt: 1791545642, turns: [{ id: "turn", startedAt: 1791545642, items: [] }] });
  assert.equal(transformed.updatedAt, 1791545642000);
  assert.equal(transformed.source, "codex");
  assert.ok(transformed.updatedAt > 1791535139292);
});

test("turns Codex activity into a concise timeline and omits private reasoning", () => {
  const result = transformThread({
    id: "thread-123",
    name: "Fix the dashboard",
    cwd: "C:\\work\\dashboard",
    status: { type: "active" },
    turns: [{
      id: "turn-1",
      startedAt: 1000,
      status: "completed",
      items: [
        { type: "userMessage", id: "user-1", content: [{ text: "Please fix it" }] },
        { type: "reasoning", id: "reason-1", text: "internal" },
        { type: "agentMessage", id: "message-1", phase: "commentary", text: "I’m checking the page." },
        { type: "commandExecution", id: "command-1", status: "completed", command: "Get-Content README.md", commandActions: [{ type: "read", path: "C:\\work\\README.md", command: "Get-Content README.md" }], aggregatedOutput: "hello", exitCode: 0 },
        { type: "webSearch", id: "search-1", query: "official docs", results: [{}] },
      ],
    }],
  });
  assert.equal(result.activities.length, 3);
  assert.deepEqual(result.activities.map((activity) => activity.title), ["Update", "Read README.md", "Searched the web"]);
  assert.equal(result.activities[1].description, "Opened README.md to inspect its contents.");
  assert.deepEqual(result.counts, { updates: 1, commands: 1, research: 1, tools: 0 });
  assert.equal(result.latest.description, "official docs");
});

test("keeps unusual activity visible with a generic label", () => {
  const result = transformThread({ id: "t", turns: [{ id: "a", items: [{ type: "imageGeneration", id: "i" }] }] });
  assert.equal(result.activities[0].title, "image Generation");
});

test("reads file paths and web actions from the app-server shapes", () => {
  const result = transformThread({ id: "t", turns: [{ id: "a", items: [
    { type: "fileChange", id: "files", changes: [{ path: "C:\\work\\app.js" }, { path: "C:\\work\\styles.css" }] },
    { type: "webSearch", id: "web", action: { type: "search", queries: ["Codex docs", "Codex events"] } },
  ] }] });
  assert.equal(result.activities[0].title, "Changed 2 files");
  assert.equal(result.activities[0].description, "app.js · styles.css");
  assert.equal(result.activities[1].description, "Codex docs · Codex events");
});

test("uses a useful command summary when action metadata has no target", () => {
  const result = transformThread({ id: "t", turns: [{ id: "a", items: [
    { type: "commandExecution", id: "test", command: "npm test", commandActions: [{ type: "unknown" }] },
  ] }] });
  assert.equal(result.activities[0].description, "Checked the project with its test suite.");
});

test("keeps turn outcomes and explicit user questions for alerts", () => {
  const result = transformThread({ id: "t", turns: [
    { id: "done", status: "completed", error: null, items: [{ type: "agentMessage", id: "a", phase: "final_answer", text: "Choose one.", questions: [{ title: "Which layout?" }] }] },
    { id: "failed", status: "failed", error: { message: "Connection lost" }, items: [] },
  ] });
  assert.deepEqual(result.turnStates, [
    { id: "done", status: "completed", questions: ["Which layout?"], error: "", open: true },
    { id: "failed", status: "failed", questions: [], error: "Connection lost", open: true },
  ]);
});

test("recognizes a final answer that asks the user to choose", () => {
  const result = transformThread({ id: "t", turns: [{ id: "choice", status: "completed", items: [
    { type: "agentMessage", id: "ask", phase: "final_answer", text: "Which layout should I use?\n- Compact\n- Spacious" },
  ] }] });
  assert.deepEqual(result.turnStates[0].questions, ["Which layout should I use?"]);
});

test("a turn still running in another Codex process counts as working while its chat is active", () => {
  const NOW = 1_800_000_000_000;
  const chat = (turn, updatedAt) => transformThread({ id: "t", updatedAt: updatedAt / 1000, turns: [turn] });
  const open = { id: "open", status: "interrupted", startedAt: (NOW - 60_000) / 1000, completedAt: null, items: [] };
  const running = markRunningElsewhere(chat(open, NOW - 5000), { now: NOW });
  assert.equal(running.turnStates.at(-1).status, "inProgress");
  assert.equal(running.runningElsewhere, true);
  // Quiet for longer than the window: an abandoned turn, left as it is.
  const stale = markRunningElsewhere(chat(open, NOW - RUNNING_ELSEWHERE_MS - 1000), { now: NOW });
  assert.equal(stale.turnStates.at(-1).status, "interrupted");
  // A turn someone actually stopped has a completion time.
  const stopped = markRunningElsewhere(chat({ ...open, completedAt: (NOW - 2000) / 1000 }, NOW - 2000), { now: NOW });
  assert.equal(stopped.turnStates.at(-1).status, "interrupted");
});

test("a chat's activity time is when its newest turn started, when that is later than its update time", () => {
  const result = transformThread({ id: "t", updatedAt: 1_700_000_000, recencyAt: 1_700_000_900, turns: [] });
  assert.equal(result.updatedAt, 1_700_000_900_000);
});
