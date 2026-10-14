/**
 * The Codex detail builder: mission, said, now, trail and files from synthetic paged turns, and
 * the newest update_plan from a synthetic session file.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexPlanReader, changeStats, codexDetail, codexItemRow, parseRolloutPlan, parseRolloutTimes, spawnPromptFor } from "../lib/codex-detail.mjs";
import { readFileTail } from "../lib/claude.mjs";
import { parseClaudeTranscript } from "../lib/claude-detail.mjs";
import { diffStats, groupLookups, relativePath, unwrapCommand } from "../lib/detail-text.mjs";

const CWD = "C:\\work\\billing-api";
const START = 1_780_000_000; // seconds, as Codex sends them

function chat({ running = false } = {}) {
  return {
    id: "019a-chat-0001", cwd: CWD, path: "C:\\codex\\sessions\\rollout-1.jsonl",
    turns: [
      { id: "t1", status: "completed", startedAt: START, completedAt: START + 60, items: [
        { type: "userMessage", id: "u1", content: [{ type: "text", text: "Add a CSV export" }] },
        { type: "agentMessage", id: "m1", text: "Added it.", phase: "final_answer" },
      ] },
      { id: "t2", status: running ? "inProgress" : "completed", startedAt: START + 100, ...(running ? {} : { completedAt: START + 200 }), items: [
        { type: "userMessage", id: "u2", content: [{ type: "text", text: "Now fix the header row" }, { type: "image", url: "data:x" }] },
        { type: "reasoning", id: "r1", summary: [] },
        { type: "commandExecution", id: "c1", command: "\"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -Command 'npm test'",
          status: "completed", exitCode: 1, durationMs: 2300, aggregatedOutput: "FAIL header\ntoken=ghp_abcdefghijklmnopqrstuvwxyz0123456789", commandActions: [{ type: "unknown", command: "npm test" }] },
        { type: "commandExecution", id: "c2", command: "Get-Content lib/export.mjs", status: "completed", exitCode: 0, durationMs: 40,
          aggregatedOutput: "export function csv() {}", commandActions: [{ type: "read", path: `${CWD}\\lib\\export.mjs`, name: "export.mjs" }] },
        { type: "commandExecution", id: "c3", command: "rg header", status: "completed", exitCode: 0, durationMs: 30, commandActions: [{ type: "search", query: "header" }] },
        { type: "fileChange", id: "f1", status: "completed", changes: [
          { path: `${CWD}\\lib\\export.mjs`, kind: { type: "update", move_path: null }, diff: "@@ -1,2 +1,3 @@\n-old\n+new\n+newer\n keep" },
          { path: `${CWD}\\docs\\csv.md`, kind: { type: "add" }, diff: "line one\nline two\n" }] },
        { type: "mcpToolCall", id: "p1", server: "linear", tool: "create_issue", arguments: { title: "Header row" }, status: "completed", result: { content: [{ type: "text", text: "Created ABC-1" }] }, durationMs: 900 },
        { type: "webSearch", id: "w1", query: "csv header rfc4180", action: { type: "search", query: "csv header rfc4180" } },
        { type: "collabAgentToolCall", id: "s1", tool: "spawnAgent", status: "completed", senderThreadId: "019a-chat-0001", receiverThreadIds: ["019a-helper-0002"], prompt: "Check the importer", agentsStates: {} },
        { type: "agentMessage", id: "m2", text: "Fixed the header; tests pass now.", phase: "final_answer" },
        ...(running ? [{ type: "commandExecution", id: "c4", command: "npm run lint", status: "inProgress", commandActions: [] }] : []),
      ] },
    ],
  };
}

test("shared helpers unwrap shells, count diff lines, and make paths relative", () => {
  assert.equal(unwrapCommand("\"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -Command 'npm test'"), "npm test");
  assert.equal(unwrapCommand("/bin/bash -lc \"git status\""), "git status");
  assert.equal(unwrapCommand("npm test"), "npm test");
  assert.deepEqual(diffStats("--- a/x\n+++ b/x\n@@\n-a\n+b\n+c\n d"), { added: 2, removed: 1 });
  assert.deepEqual(changeStats({ kind: { type: "add" }, diff: "a\nb\n" }), { added: 2, removed: 0 });
  assert.deepEqual(changeStats({ kind: { type: "delete" }, diff: "a\nb\nc" }), { added: 0, removed: 3 });
  assert.equal(relativePath("C:/work/billing-api/lib/x.mjs", "c:\\work\\billing-api\\"), "lib/x.mjs");
  assert.equal(relativePath("D:\\other\\x.mjs", CWD), "D:\\other\\x.mjs");
  const grouped = groupLookups([{ id: "a", at: 3, kind: "read", path: "a.mjs", status: "ok" }, { id: "b", at: 2, kind: "read", path: "b.mjs", status: "ok" },
    { id: "c", at: 1, kind: "command", title: "npm test", status: "ok" }]);
  assert.deepEqual(grouped[0], { id: "a", at: 3, kind: "read", title: "Read 2 files", status: "ok", paths: ["a.mjs", "b.mjs"], durationMs: 1 });
  assert.equal(grouped[1].id, "c");
});

test("diff lines that start with -- or ++ inside a hunk are changes, not file headers", () => {
  // An SQL comment removed and a C increment added: "--- old note" and "+++count;" are body lines.
  assert.deepEqual(diffStats("--- a/q.sql\n+++ b/q.sql\n@@ -1,3 +1,3 @@\n--- old note\n+-- new note\n select 1;\n-x\n++++count;"), { added: 2, removed: 2 });
  assert.deepEqual(diffStats("@@\n--- dropped comment\n+++kept;"), { added: 1, removed: 1 });
  // Each file's own header is still skipped in a multi-file diff, with or without hunk counts.
  const two = "diff --git a/a.sql b/a.sql\n--- a/a.sql\n+++ b/a.sql\n@@ -1 +1 @@\n--- one\n+-- two\ndiff --git a/b.js b/b.js\n--- a/b.js\n+++ b/b.js\n@@\n-x\n+y";
  assert.deepEqual(diffStats(two), { added: 2, removed: 2 });
  const counted = "--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-a\n+b\n c\n--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-d\n+e";
  assert.deepEqual(diffStats(counted), { added: 2, removed: 2 });
  // Claude Code's own patch keeps hunk lines without their header: all of them are body lines.
  const transcript = [
    { type: "user", timestamp: "2026-05-01T10:00:00.000Z", message: { role: "user", content: "Tidy the query" } },
    { type: "assistant", timestamp: "2026-05-01T10:00:01.000Z", message: { role: "assistant", content: [
      { type: "tool_use", id: "e1", name: "Edit", input: { file_path: `${CWD}\\q.sql`, old_string: "x", new_string: "y" } }] } },
    { type: "user", timestamp: "2026-05-01T10:00:02.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "e1", content: "ok" }] },
      toolUseResult: { structuredPatch: [{ lines: [" select 1;", "--- old note", "+-- new note", "++++count;"] }] } },
  ].map((record) => JSON.stringify(record)).join("\n");
  const { files } = parseClaudeTranscript(transcript, { session: "s", cwd: CWD });
  assert.deepEqual(files.map((file) => [file.added, file.removed]), [[2, 1]]);
});

test("a finished chat: mission is this turn's message, said its final answer, nothing running", () => {
  const detail = codexDetail(chat(), { active: false });
  assert.deepEqual(detail.mission, { text: "Now fix the header row\n[image]", from: "you", at: (START + 100) * 1000 });
  assert.equal(detail.said.text, "Fixed the header; tests pass now.");
  assert.equal(detail.now, null);
  const titles = detail.trail.map((row) => row.title);
  assert.equal(titles[0], "Fixed the header; tests pass now.");
  const failed = detail.trail.find((row) => row.id === "c1");
  assert.deepEqual([failed.kind, failed.title, failed.status, failed.exitCode, failed.durationMs], ["command", "npm test", "failed", 1, 2300]);
  assert.match(failed.output, /FAIL header/);
  assert.doesNotMatch(failed.output, /ghp_abcdefghijklmnopqrstuvwxyz0123456789/);
  const lookups = detail.trail.find((row) => row.id === "c3");
  assert.equal(lookups.title, "Read 1 file and searched 1 time", "the read and the search next to it are one row");
  const change = detail.trail.find((row) => row.id === "f1");
  assert.deepEqual([change.kind, change.title, change.added, change.removed, change.paths], ["edit", "Edited 2 files", 4, 1, ["lib\\export.mjs", "docs\\csv.md"]]);
  const mcp = detail.trail.find((row) => row.id === "p1");
  assert.deepEqual([mcp.title, mcp.output, mcp.durationMs], ["Used linear · create issue", "Created ABC-1", 900]);
  assert.equal(detail.trail.find((row) => row.id === "w1").title, "Searched the web for \"csv header rfc4180\"");
  const spawn = detail.trail.find((row) => row.id === "s1");
  assert.deepEqual([spawn.kind, spawn.title, spawn.agentId, spawn.detail], ["agent", "Started a subagent", "019a-helper-0002", "Check the importer"]);
  assert.deepEqual(detail.files.map((file) => [file.path, file.added, file.removed]), [["lib\\export.mjs", 2, 1], ["docs\\csv.md", 2, 0]]);
});

test("a working chat shows the running step as now, else its newest finished step; Thinking only before any step", () => {
  // Items carry no time: a running step without one in the session file has no start, never the turn's.
  const detail = codexDetail(chat({ running: true }), { active: true });
  assert.deepEqual(detail.now, { kind: "command", title: "Running npm run lint", detail: "npm run lint", startedAt: 0 });
  assert.equal(detail.trail[0].status, "running");
  assert.equal(detail.trail[0].at, null);
  const timed = codexDetail(chat({ running: true }), { active: true, times: new Map([["c4", { startedAt: (START + 150) * 1000, completedAt: 0 }]]) });
  assert.equal(timed.now.startedAt, (START + 150) * 1000);
  // An open turn with nothing running names what it did last, in the past tense, as done.
  const quiet = { turns: [{ id: "t", status: "inProgress", startedAt: START, items: [
    { type: "userMessage", id: "u", content: [{ type: "text", text: "Go" }] },
    { type: "commandExecution", id: "x1", command: "gh pr view 214", status: "completed", exitCode: 0, commandActions: [] }] }] };
  assert.deepEqual(codexDetail(quiet, { active: true, times: new Map([["x1", { startedAt: (START + 5) * 1000, completedAt: (START + 7) * 1000 }]]) }).now,
    { kind: "command", title: "Ran gh pr view 214", detail: "gh pr view 214", startedAt: (START + 5) * 1000, done: true });
  quiet.turns[0].items.push({ type: "agentMessage", id: "m9", phase: "commentary", text: "The PR is green.\nMerging next." });
  assert.equal(codexDetail(quiet, { active: true }).now.title, "Said: The PR is green.");
  const thinking = codexDetail({ turns: [{ id: "t", status: "inProgress", startedAt: START, items: [{ type: "userMessage", content: [{ type: "text", text: "Go" }] }] }] }, { active: true });
  assert.deepEqual(thinking.now, { kind: "think", title: "Thinking", startedAt: START * 1000 });
});

test("trail rows take their times from the session file by item or call id; the rest have none", () => {
  const at = (seconds) => (START + seconds) * 1000;
  const iso = (seconds) => new Date(at(seconds)).toISOString();
  const text = [
    JSON.stringify({ timestamp: iso(110), type: "event_msg", payload: { type: "item_completed", turn_id: "t2", item: { type: "CommandExecution", id: "c1", command: ["npm", "test"] },
      started_at_ms: at(105), completed_at_ms: at(110) } }),
    JSON.stringify({ timestamp: iso(120), type: "response_item", payload: { type: "function_call", name: "mcp", call_id: "p1", arguments: "{}" } }),
    JSON.stringify({ timestamp: iso(121), type: "response_item", payload: { type: "function_call_output", call_id: "p1", output: "x" } }),
    JSON.stringify({ timestamp: iso(130), type: "response_item", payload: { type: "message", id: "m2", role: "assistant", content: [{ type: "output_text", text: "Fixed" }] } }),
    '{"timestamp":"cut mid-line', "",
  ].join("\n");
  const times = parseRolloutTimes(text);
  assert.deepEqual(times.get("c1"), { startedAt: at(105), completedAt: at(110) });
  assert.deepEqual(times.get("p1"), { startedAt: at(120), completedAt: at(121) });
  const detail = codexDetail(chat(), { active: false, times });
  const row = (id) => detail.trail.find((item) => item.id === id);
  assert.equal(row("c1").at, at(105));
  assert.equal(row("p1").at, at(120));
  assert.equal(row("w1").at, null, "a step with no time in the file shows none, not the turn's start");
  assert.equal(row("f1").at, null);
  assert.equal(detail.said.at, at(130));
  // A final answer with no time of its own is as old as its turn's end; anything else said has no time.
  assert.equal(codexDetail(chat(), { active: false }).said.at, (START + 200) * 1000);
  const commentary = codexDetail({ turns: [{ id: "t", status: "inProgress", startedAt: START, items: [{ type: "agentMessage", id: "m", phase: "commentary", text: "Looking" }] }] }, { active: true });
  assert.equal(commentary.said.at, null);
});

test("a helper chat's instructions come from the chat that started it", () => {
  const parent = chat();
  assert.deepEqual(spawnPromptFor(parent, "019a-helper-0002"), { text: "Check the importer", at: (START + 100) * 1000 });
  const helper = codexDetail({ turns: [{ id: "h1", status: "completed", startedAt: START, items: [{ type: "agentMessage", text: "Importer is fine." }] }] },
    { subagent: true, parentMission: spawnPromptFor(parent, "019a-helper-0002") });
  assert.deepEqual(helper.mission, { text: "Check the importer", from: "parent", at: (START + 100) * 1000 });
  const own = codexDetail({ turns: [{ id: "h1", startedAt: START, items: [{ type: "userMessage", content: [{ type: "text", text: "Check X" }] }] }] }, { subagent: true });
  assert.equal(own.mission.from, "parent");
  assert.equal(codexItemRow({ type: "userMessage" }), null);
});

const planLine = (at, plan) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: "response_item",
  payload: { type: "function_call", name: "update_plan", call_id: `call-${at}`, arguments: JSON.stringify({ explanation: "x", plan }) } });

test("the newest update_plan in a session file is the plan", () => {
  const text = [
    planLine(1000, [{ step: "Read the exporter", status: "in_progress" }]),
    JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{}" } }),
    planLine(2000, [{ step: "Read the exporter", status: "completed" }, { step: "Fix the header", status: "in_progress" }, { step: "Ship", status: "pending" }]),
  ].join("\n");
  assert.deepEqual(parseRolloutPlan(text), { steps: [{ text: "Read the exporter", status: "done" }, { text: "Fix the header", status: "active" }, { text: "Ship", status: "pending" }], at: 2000, source: "plan" });
  assert.equal(parseRolloutPlan("{\"type\":\"response_item\",\"payload\":{\"type\":\"message\"}}"), null);
});

test("plans are read from the end of the session file and remembered until it changes", () => {
  const root = mkdtempSync(join(tmpdir(), "goblin-codex-plan-"));
  try {
    const file = join(root, "rollout-1.jsonl");
    writeFileSync(file, `${planLine(1000, [{ step: "One", status: "in_progress" }])}\n${"x".repeat(5000)}\n`);
    const calls = [];
    const reader = new CodexPlanReader({ readTail: (path, bytes) => { calls.push(bytes); return readFileTail(path, bytes); }, steps: [1024, 64 * 1024] });
    assert.equal(reader.read(file).steps[0].text, "One");
    assert.deepEqual(calls, [1024, 64 * 1024], "a plan further back costs one longer look");
    reader.read(file);
    assert.equal(calls.length, 2, "unchanged files are not read again");
    appendFileSync(file, `${planLine(2000, [{ step: "One", status: "completed" }, { step: "Two", status: "pending" }])}\n`);
    assert.deepEqual(reader.read(`\\\\?\\${file}`)?.steps.map((step) => step.status), ["done", "pending"]);
    assert.equal(reader.read(join(root, "missing.jsonl")), null);
    assert.equal(reader.read("C:\\not-a-session.txt"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the plan reader remembers step times with its plan, from the same reads", () => {
  const root = mkdtempSync(join(tmpdir(), "goblin-codex-times-"));
  try {
    const file = join(root, "rollout-2.jsonl");
    const event = (id, seconds) => JSON.stringify({ timestamp: new Date((START + seconds) * 1000).toISOString(), type: "event_msg",
      payload: { type: "item_completed", item: { type: "CommandExecution", id }, started_at_ms: (START + seconds - 1) * 1000, completed_at_ms: (START + seconds) * 1000 } });
    writeFileSync(file, `${planLine(1000, [{ step: "One", status: "in_progress" }])}\n${event("exec-1", 10)}\n`);
    let reads = 0;
    const reader = new CodexPlanReader({ readTail: (path, bytes) => { reads++; return readFileTail(path, bytes); } });
    assert.equal(reader.times(file).get("exec-1").startedAt, (START + 9) * 1000);
    assert.equal(reader.read(file).steps[0].text, "One");
    assert.equal(reads, 1, "the plan and the times come from one read");
    appendFileSync(file, `${event("exec-2", 20)}\n`);
    const times = reader.times(file);
    assert.deepEqual([...times.keys()].filter((id) => id.startsWith("exec")), ["exec-1", "exec-2"], "what the file gained is added to what was known");
    assert.equal(reader.times(join(root, "missing.jsonl")).size, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a step keeps the start time first read when only its result is in what the file gained", () => {
  let text = "";
  let size = 0;
  const stamp = (seconds) => new Date((START + seconds) * 1000).toISOString();
  const call = JSON.stringify({ timestamp: stamp(10), type: "response_item", payload: { type: "function_call", name: "shell_command", call_id: "call-7", arguments: "{}" } });
  const output = JSON.stringify({ timestamp: stamp(95), type: "response_item", payload: { type: "function_call_output", call_id: "call-7", output: "PRIVATE" } });
  // A tail of the new bytes only: the call itself is no longer in view, its output is.
  const reader = new CodexPlanReader({ readTail: () => text, stat: () => ({ size, mtimeMs: size }), steps: [1024] });
  text = `${call}\n`;
  size = 100;
  assert.deepEqual(reader.times("C:/codex/sessions/rollout-7.jsonl").get("call-7"), { startedAt: (START + 10) * 1000, completedAt: 0 });
  text = `${output}\n`;
  size = 200;
  assert.deepEqual(reader.times("C:/codex/sessions/rollout-7.jsonl").get("call-7"), { startedAt: (START + 10) * 1000, completedAt: (START + 95) * 1000 });
});
