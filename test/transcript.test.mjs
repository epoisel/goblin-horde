import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeDetailReader, encodeProjectDir } from "../lib/claude-detail.mjs";
import { parseRolloutPlans } from "../lib/codex-detail.mjs";
import {
  ClaudeTranscripts, CodexTranscripts, TRANSCRIPT_LIMITS, claudeEntries, codexChangeDiff, codexEntries, decodeCursor, encodeCursor, hunksToDiff, orcaEntries,
  shownText, withPlanUpdates,
} from "../lib/transcript.mjs";

const NOW = 1_800_000_000_000;
const SESSION = "7a5c0000-0000-4000-8000-000000000001";
const at = (second) => new Date(NOW + second * 1000).toISOString();
let uuid = 0;
const id = () => `u-${String(++uuid).padStart(6, "0")}`;
const user = (content, extra = {}) => ({ type: "user", uuid: id(), timestamp: at(uuid), message: { role: "user", content }, origin: { kind: "human" }, ...extra });
const assistant = (content, extra = {}) => ({ type: "assistant", uuid: id(), timestamp: at(uuid), message: { role: "assistant", model: "claude-opus-4-1", content }, ...extra });
const use = (toolId, name, input) => assistant([{ type: "tool_use", id: toolId, name, input }]);
const result = (toolId, content, extra = {}, isError = false) => user([{ type: "tool_result", tool_use_id: toolId, content, ...(isError ? { is_error: true } : {}) }], extra);
const records = (list) => list.map((record, index) => ({ record, offset: index * 100 }));

test("every kind of Claude Code record maps to what the native app shows, and more", () => {
  const list = [
    user("Export the invoices as CSV"),
    assistant([{ type: "thinking", thinking: "", signature: "sig" }]),
    assistant([{ type: "thinking", thinking: "The writer lives in src/csv.ts." }]),
    assistant([{ type: "text", text: "I'll **start** with the writer.\n\n| a | b |\n|---|---|" }]),
    use("toolu_bash", "Bash", { command: "npm test -- csv", description: "Run the CSV tests" }),
    result("toolu_bash", "Exit code 1\n2 failing\npassword=hunter22", { toolUseResult: { stdout: "", stderr: "", interrupted: false } }, true),
    use("toolu_edit", "Edit", { file_path: "/work/app/src/csv.ts", old_string: "a,b", new_string: "a;b" }),
    result("toolu_edit", "Updated", { toolUseResult: { filePath: "/work/app/src/csv.ts", structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 2, lines: ["-a,b", "+a;b", "+c;d"] }] } }),
    use("toolu_write", "Write", { file_path: "/work/app/NOTES.md", content: "one\ntwo\n" }),
    result("toolu_write", "Created", { toolUseResult: { type: "create" } }),
    use("toolu_read", "Read", { file_path: "/work/app/shot.png" }),
    result("toolu_read", [{ type: "image", source: {} }]),
    use("toolu_agent", "Agent", { description: "Find fixtures", prompt: "Look for invoice fixtures", subagent_type: "Explore" }),
    result("toolu_agent", "Found 3", { toolUseResult: { agentId: "a1b2c3", status: "completed" } }),
    use("toolu_todo", "TodoWrite", { todos: [{ content: "Write tests", status: "completed", activeForm: "Writing tests" }, { content: "Ship", status: "in_progress", activeForm: "Shipping" }] }),
    result("toolu_todo", "ok"),
    use("toolu_ask", "AskUserQuestion", { questions: [{ question: "Which separator?", options: [{ label: "Comma" }, { label: "Semicolon" }] }] }),
    result("toolu_ask", "answered", { toolUseResult: { answers: { "Which separator?": "Semicolon" } } }),
    use("toolu_denied", "Bash", { command: "rm -rf dist" }),
    result("toolu_denied", "The user doesn't want to proceed with this tool use.", { toolDenialKind: "user-rejected" }, true),
    user("<command-name>/model</command-name>\n<command-args>opus</command-args>"),
    user("<system-reminder>internal</system-reminder>"),
    user("meta words", { isMeta: true }),
    user("[Request interrupted by user]"),
    { type: "system", subtype: "compact_boundary", uuid: id(), timestamp: at(uuid), compactMetadata: { trigger: "auto", preTokens: 150000 } },
    user("This session is being continued from a previous conversation...", { isCompactSummary: true }),
    { type: "attachment", uuid: id(), timestamp: at(uuid), attachment: { type: "queued_command", prompt: "also check the totals", commandMode: "prompt", origin: { kind: "human" } } },
    { type: "attachment", uuid: id(), timestamp: at(uuid), attachment: { type: "hook_success", content: "x" } },
    user("Please carry out this task from my Orca coordinator by following the brief I pasted below.\n<pasted_content>You are working inside Orca, a multi-agent IDE."),
    assistant([{ type: "text", text: "inline subagent text" }], { isSidechain: true }),
    assistant([{ type: "text", text: "API Error: overloaded" }], { isApiErrorMessage: true }),
    use("toolu_open", "Bash", { command: "npm run build" }),
  ];
  const results = new Map();
  for (const item of list) for (const block of Array.isArray(item.message?.content) ? item.message.content : []) {
    if (block.type === "tool_result") results.set(block.tool_use_id, { at: Date.parse(item.timestamp), isError: block.is_error === true, text: typeof block.content === "string" ? block.content : "[image]", extra: item.toolUseResult, denied: Boolean(item.toolDenialKind) });
  }
  const entries = claudeEntries(records(list), { session: SESSION, cwd: "/work/app", results });
  const kinds = entries.map((entry) => entry.kind);
  assert.deepEqual(kinds, ["prompt", "reasoning", "message", "tool", "tool", "tool", "tool", "subagent", "plan", "ask", "tool", "system", "system", "compaction", "compaction",
    "prompt", "prompt", "error", "tool"]);
  const byTool = Object.fromEntries(entries.filter((entry) => entry.tool).map((entry) => [entry.id, entry]));
  assert.equal(entries[0].from, "you");
  assert.equal(entries[1].text, "The writer lives in src/csv.ts.", "only thinking with readable words");
  assert.match(entries[2].text, /\*\*start\*\*/, "messages keep their markdown as written");
  const bashEntry = byTool.toolu_bash.tool;
  assert.deepEqual([bashEntry.kind, bashEntry.status, bashEntry.exitCode, bashEntry.input, bashEntry.description], ["command", "failed", 1, "npm test -- csv", "Run the CSV tests"]);
  assert.match(bashEntry.output, /2 failing/);
  assert.doesNotMatch(bashEntry.output, /hunter22/, "output passes the credential filter");
  assert.ok(bashEntry.durationMs >= 0);
  const edit = byTool.toolu_edit.tool;
  assert.equal(edit.diff, "--- a/src/csv.ts\n+++ b/src/csv.ts\n@@ -3,1 +3,2 @@\n-a,b\n+a;b\n+c;d");
  assert.deepEqual(edit.files, [{ path: "src/csv.ts", added: 2, removed: 1 }]);
  assert.equal(byTool.toolu_write.tool.title, "Created NOTES.md");
  assert.equal(byTool.toolu_write.tool.diff, "--- /dev/null\n+++ b/NOTES.md\n@@ -0,0 +1,2 @@\n+one\n+two");
  assert.equal(byTool.toolu_read.tool.output, "[image]");
  assert.equal(byTool.toolu_agent.tool.agentId, `claude-agent:${SESSION}:a1b2c3`);
  assert.equal(byTool.toolu_agent.text, "Find fixtures");
  assert.deepEqual(byTool.toolu_todo.plan.steps, [{ text: "Write tests", status: "done" }, { text: "Shipping", status: "active" }]);
  assert.deepEqual(byTool.toolu_ask.ask.questions, [{ text: "Which separator?", options: ["Comma", "Semicolon"] }]);
  assert.equal(byTool.toolu_ask.tool.output, "Which separator? → Semicolon");
  assert.equal(byTool.toolu_denied.tool.status, "denied");
  assert.equal(entries[11].text, "Ran /model opus");
  assert.equal(entries[12].text, "Interrupted by you.");
  assert.match(entries[13].text, /compacted \(auto\), 150,000 tokens/);
  assert.equal(entries[15].queued, true);
  assert.equal(entries[16].from, "coordinator", "Orca's dispatch brief comes from the coordinator");
  assert.equal(byTool.toolu_open.tool.status, "running", "the newest call without a result is still running");
  assert.ok(entries.every((entry) => entry.id && "at" in entry), "every entry has a stable id and a time");
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
  // A subagent's own transcript: its prompt came from the parent.
  assert.equal(claudeEntries(records([user("Find the fixtures")]), { subagent: true })[0].from, "parent");
  // A call left without a result before a newer prompt did not finish.
  const lost = claudeEntries(records([use("toolu_lost", "Bash", { command: "sleep 9" }), user("never mind")]), {});
  assert.equal(lost[0].tool.status, "failed");
  assert.equal(lost[0].tool.output, "(No result was recorded.)");
});

test("long text is shown whole up to 256 KB, then its head and tail with the sizes", () => {
  const big = `${"a".repeat(200_000)}MIDDLE${"z".repeat(200_000)}`;
  const shown = shownText(big);
  assert.equal(shown.truncated.totalBytes, big.length);
  assert.equal(shown.truncated.shownBytes, TRANSCRIPT_LIMITS.textBytes);
  assert.ok(shown.text.startsWith("aaa") && shown.text.endsWith("zzz"));
  assert.match(shown.text, /bytes not shown/);
  assert.doesNotMatch(shown.text, /MIDDLE/);
  assert.equal(shownText("short").truncated, undefined);
  const entry = claudeEntries(records([use("toolu_big", "Bash", { command: "cat big.log" }), result("toolu_big", big)]), { results: new Map([["toolu_big", { text: big, at: NOW }]]) })[0];
  assert.deepEqual(entry.tool.outputTruncated, shown.truncated);
});

/** A Claude config folder with one transcript; returns helpers to write and page it. */
function transcriptFolder(limits = TRANSCRIPT_LIMITS) {
  const root = mkdtempSync(join(tmpdir(), "goblin-transcript-"));
  const config = join(root, "claude");
  const project = join(config, "projects", encodeProjectDir("/work/app"));
  mkdirSync(project, { recursive: true });
  const file = join(project, `${SESSION}.jsonl`);
  writeFileSync(file, "");
  const locator = new ClaudeDetailReader({ configDir: config });
  const reader = new ClaudeTranscripts({ locator, limits });
  return {
    root, file, reader, project,
    append: (...items) => appendFileSync(file, items.map((item) => (typeof item === "string" ? item : `${JSON.stringify(item)}\n`)).join("")),
    page: (options = {}) => reader.page({ session: SESSION, cwd: "/work/app", ...options }),
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("a long transcript pages backwards to its start with no entry lost or repeated, in small chunks and across multi-byte text", () => {
  const folder = transcriptFolder({ ...TRANSCRIPT_LIMITS, chunkBytes: 4096 });
  try {
    const all = [];
    for (let index = 0; index < 300; index++) {
      all.push(user(`Step ${index}: café ☕ ${"é".repeat(index % 50)}`), use(`toolu_${index}`, "Bash", { command: `echo ${index}` }), result(`toolu_${index}`, `out ${index} ✓`));
      if (index % 7 === 0) all.push(assistant([{ type: "text", text: `Note ${index} — ünïcode` }]));
    }
    folder.append(...all);
    let page = folder.page({ limit: 40 });
    const seen = [...page.entries];
    let pages = 1;
    while (page.hasOlder) {
      page = folder.page({ before: page.cursor.first, limit: 40 });
      seen.unshift(...page.entries);
      if (++pages > 100) throw new Error("did not reach the start");
    }
    const ids = seen.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length, "no entry twice");
    const expected = all.filter((item) => item.type === "assistant" || !Array.isArray(item.message.content)).length;
    assert.equal(ids.length, expected, "every entry once");
    assert.equal(seen[0].text, "Step 0: café ☕");
    assert.equal(seen.at(-2).text, `Step 299: café ☕ ${"é".repeat(299 % 50)}`);
    assert.ok(seen.filter((entry) => entry.tool).every((entry) => entry.tool.status === "ok" && /^out \d+ ✓$/.test(entry.tool.output)), "every call has its own result, even across pages");
    // An unchanged file is answered from memory.
    const before = folder.reader.reads;
    folder.page({ limit: 40 });
    assert.equal(folder.reader.reads, before);
  } finally { folder.done(); }
});

test("after= returns only what is new, a running call again once its result lands, and nothing of a half-written line", () => {
  const folder = transcriptFolder();
  try {
    folder.append(user("Build it"), use("toolu_a", "Bash", { command: "npm run build" }));
    const first = folder.page();
    assert.deepEqual(first.entries.map((entry) => entry.kind), ["prompt", "tool"]);
    assert.equal(first.entries[1].tool.status, "running");
    assert.deepEqual(decodeCursor(first.cursor.last).r, ["toolu_a"]);
    // Nothing new: nothing sent.
    const quiet = folder.page({ after: first.cursor.last });
    assert.deepEqual(quiet.entries, []);
    // A line still being written waits.
    const pending = result("toolu_a", "built");
    const line = JSON.stringify(pending);
    folder.append(line.slice(0, 30));
    const partial = folder.page({ after: quiet.cursor.last });
    assert.deepEqual(partial.entries, []);
    folder.append(`${line.slice(30)}\n`, assistant([{ type: "text", text: "Built." }]));
    const next = folder.page({ after: partial.cursor.last });
    assert.deepEqual(next.entries.map((entry) => [entry.id, entry.kind, entry.updated || false]), [["toolu_a", "tool", true], [next.entries[1].id, "message", false]]);
    assert.equal(next.entries[0].tool.status, "ok");
    assert.equal(next.entries[0].tool.output, "built");
    assert.deepEqual(decodeCursor(next.cursor.last).r, []);
    // A replaced transcript (shorter than the cursor) starts over.
    writeFileSync(folder.file, `${JSON.stringify(user("Fresh start"))}\n`);
    const reset = folder.page({ after: next.cursor.last });
    assert.equal(reset.reset, true);
    assert.equal(reset.entries[0].text, "Fresh start");
    // Someone else's cursor, or junk, starts over too.
    assert.equal(folder.page({ after: encodeCursor({ k: "a", f: "other", o: 0 }) }).reset, true);
    assert.equal(folder.page({ before: "!!" }).reset, true);
  } finally { folder.done(); }
});

test("an output Claude Code saved to its own file is read whole, but only from under the projects folder", () => {
  const folder = transcriptFolder();
  try {
    const saved = join(folder.project, SESSION, "tool-results");
    mkdirSync(saved, { recursive: true });
    writeFileSync(join(saved, "out.txt"), "line 1\nline 2\nthe whole output\n");
    const outside = join(folder.root, "outside.txt");
    writeFileSync(outside, "never read");
    folder.append(use("toolu_p", "Bash", { command: "big" }), result("toolu_p", "<persisted-output>\nPreview…", { toolUseResult: { persistedOutputPath: join(saved, "out.txt") } }),
      use("toolu_q", "Bash", { command: "big2" }), result("toolu_q", "<persisted-output>\nPreview…", { toolUseResult: { persistedOutputPath: outside } }));
    const page = folder.page();
    assert.match(page.entries[0].tool.output, /the whole output/);
    assert.match(page.entries[1].tool.output, /Preview/, "a file outside the projects folder is never read");
  } finally { folder.done(); }
});

const item = (turnId, value, second) => ({ turnId, item: value, startedAtMs: NOW + second * 1000, completedAtMs: NOW + second * 1000 + 500 });

test("every kind of Codex item maps to an entry, with its full output, diff, and the turn's own failure", () => {
  const list = [
    item("turn-1", { type: "userMessage", id: "m1", content: [{ type: "text", text: "Fix the export" }, { type: "localImage", path: "C:/shots/a.png" }] }, 1),
    item("turn-1", { type: "reasoning", id: "r0", summary: [], content: [] }, 2),
    item("turn-1", { type: "reasoning", id: "r1", summary: ["**Plan** the fix"], content: [] }, 3),
    item("turn-1", { type: "commandExecution", id: "c1", command: "pwsh -Command 'npm test'", cwd: "/work/app/web", status: "completed", aggregatedOutput: "1 failing", exitCode: 1, durationMs: 4200 }, 4),
    item("turn-1", { type: "fileChange", id: "f1", status: "completed", changes: [
      { path: "/work/app/src/a.ts", kind: { type: "update", move_path: null }, diff: "@@ -1,1 +1,1 @@\n-x\n+y" },
      { path: "/work/app/NEW.md", kind: { type: "add" }, diff: "hello\nworld\n" },
      { path: "/work/app/old.txt", kind: { type: "delete" }, diff: "bye\n" }] }, 5),
    item("turn-1", { type: "mcpToolCall", id: "p1", server: "tracker", tool: "create_issue", status: "failed", arguments: { title: "x" }, result: null, error: { message: "denied" }, durationMs: 10 }, 6),
    item("turn-1", { type: "webSearch", id: "w1", query: "csv rfc", action: { type: "search", query: "csv rfc" } }, 7),
    item("turn-1", { type: "collabAgentToolCall", id: "s1", tool: "spawnAgent", status: "completed", senderThreadId: "chat-main-01", receiverThreadIds: ["chat-kid-001"], prompt: "Check the totals", agentsStates: {} }, 8),
    item("turn-1", { type: "contextCompaction", id: "k1" }, 9),
    item("turn-1", { type: "agentMessage", id: "a1", text: "Done, but **tests fail**.", phase: "final_answer" }, 10),
  ];
  const turns = new Map([["turn-1", { id: "turn-1", status: "failed", error: { message: "Usage limit reached" }, completedAt: (NOW + 11_000) / 1000 }]]);
  const entries = codexEntries(list, { cwd: "/work/app", turns });
  assert.deepEqual(entries.map((entry) => entry.kind), ["prompt", "reasoning", "tool", "tool", "tool", "tool", "subagent", "compaction", "message", "error"]);
  assert.equal(entries[0].text, "Fix the export\n[image: a.png]");
  assert.equal(entries[0].from, "you");
  assert.equal(entries[1].text, "**Plan** the fix");
  const command = entries[2].tool;
  assert.deepEqual([command.title, command.status, command.exitCode, command.durationMs, command.output, command.cwd], ["npm test", "failed", 1, 4200, "1 failing", "web"]);
  assert.equal(entries[3].tool.diff, "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-x\n+y\n--- /dev/null\n+++ b/NEW.md\n@@ -0,0 +1,2 @@\n+hello\n+world\n--- a/old.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-bye");
  assert.deepEqual(entries[3].tool.files, [{ path: "src/a.ts", added: 1, removed: 1 }, { path: "NEW.md", added: 2, removed: 0 }, { path: "old.txt", added: 0, removed: 1 }]);
  assert.deepEqual([entries[4].tool.kind, entries[4].tool.status, entries[4].tool.output], ["mcp", "failed", "denied"]);
  assert.equal(entries[4].tool.input, "{\n  \"title\": \"x\"\n}");
  assert.equal(entries[6].tool.agentId, "chat-kid-001");
  assert.equal(entries[6].text, "Check the totals");
  assert.equal(entries[9].text, "The turn failed: Usage limit reached");
  assert.ok(entries.every((entry) => entry.turn === "turn-1"));
  // A spawned chat's prompts come from its parent.
  assert.equal(codexEntries([list[0]], { subagent: true })[0].from, "parent");
  assert.equal(codexChangeDiff({ path: "a", kind: { type: "update", move_path: "b" }, diff: "@@ -1 +1 @@\n-a\n+b" }).split("\n")[1], "+++ b/b", "a moved file names where it went");
  assert.equal(hunksToDiff("x", []), "--- a/x\n+++ b/x");
});

test("Codex pages newest first through thread/items/list: older pages to the start, newer ones with a finished command sent again, and plans by time", async () => {
  const items = [];
  for (let index = 0; index < 120; index++) {
    items.push(item(`turn-${Math.floor(index / 30)}`, index % 30 === 0 ? { type: "userMessage", id: `i${index}`, content: [{ type: "text", text: `Prompt ${index}` }] }
      : { type: "agentMessage", id: `i${index}`, text: `Update ${index}`, phase: "commentary" }, index));
  }
  const calls = [];
  const request = async (method, params) => {
    calls.push(method);
    if (method === "thread/turns/list") return { data: [] };
    const end = params.cursor ? Number(String(params.cursor).slice(4)) : items.length;
    const start = Math.max(0, end - params.limit);
    return { data: items.slice(start, end).reverse(), nextCursor: start > 0 ? `pos:${start}` : null, backwardsCursor: null };
  };
  const plans = [{ id: "plan:call-1", at: NOW + 115_500, steps: [{ text: "Write the fix", status: "active" }] }];
  const reader = new CodexTranscripts({ request, plans: () => plans });
  const first = await reader.page("chat-main-01", { limit: 25 });
  assert.equal(first.entries.at(-1).text, "Update 119");
  assert.ok(first.entries.some((entry) => entry.kind === "plan" && entry.plan.steps[0].text === "Write the fix"), "the plan update sits among the entries by its time");
  const planAt = first.entries.findIndex((entry) => entry.kind === "plan");
  assert.equal(first.entries[planAt - 1].text, "Update 115");
  let page = first;
  const seen = [...first.entries.filter((entry) => entry.kind !== "plan")];
  while (page.hasOlder) {
    page = await reader.page("chat-main-01", { before: page.cursor.first, limit: 25 });
    seen.unshift(...page.entries.filter((entry) => entry.kind !== "plan"));
  }
  assert.deepEqual(seen.map((entry) => entry.id), items.map((value) => value.item.id));
  // A running command, then new items and the command finished.
  items.push(item("turn-4", { type: "commandExecution", id: "run-1", command: "npm test", status: "inProgress", aggregatedOutput: "" }, 130));
  const running = await reader.page("chat-main-01", { after: first.cursor.last });
  assert.deepEqual(running.entries.map((entry) => [entry.id, entry.tool?.status]), [["run-1", "running"]]);
  items[items.length - 1] = item("turn-4", { type: "commandExecution", id: "run-1", command: "npm test", status: "completed", aggregatedOutput: "ok", exitCode: 0 }, 130);
  items.push(item("turn-4", { type: "agentMessage", id: "after-1", text: "Tests pass." }, 131));
  const later = await reader.page("chat-main-01", { after: running.cursor.last });
  assert.deepEqual(later.entries.map((entry) => [entry.id, entry.tool?.status, entry.updated || false]), [["run-1", "ok", true], ["after-1", undefined, false]]);
  const none = await reader.page("chat-main-01", { after: later.cursor.last });
  assert.deepEqual(none.entries, []);
  // A cursor Codex no longer knows starts over.
  assert.equal((await reader.page("chat-main-01", { after: encodeCursor({ k: "ca", id: "gone" }) })).reset, true);
  assert.ok(calls.includes("thread/items/list"));
});

test("plan updates come from every update_plan call in a session file, and Orca-only agents show what Orca reported", () => {
  const line = (second, steps, callId) => JSON.stringify({ timestamp: at(second), type: "response_item", payload: { type: "function_call", name: "update_plan", call_id: callId,
    arguments: JSON.stringify({ plan: steps }) } });
  const plans = parseRolloutPlans([line(1, [{ step: "Read", status: "completed" }], "c1"), line(2, [{ step: "Write", status: "in_progress" }], "c2")].join("\n"));
  assert.deepEqual(plans.map((plan) => [plan.id, plan.steps[0].status]), [["plan:c1", "done"], ["plan:c2", "active"]]);
  const merged = withPlanUpdates([{ id: "a", at: NOW, kind: "message" }, { id: "b", at: NOW + 3000, kind: "message" }], [{ id: "plan:x", at: NOW + 1000, steps: [] }]);
  assert.deepEqual(merged.map((entry) => entry.id), ["a", "plan:x", "b"]);
  const entries = orcaEntries([{ id: "e1", kind: "tool", title: "Used Bash", detail: "npm test", status: "inProgress", turnStartedAt: NOW },
    { id: "e2", kind: "update", title: "Status", description: "Working." }, { id: "e3", kind: "update", title: "Update", description: "Half done." }],
  { screen: { at: NOW, lines: ["$ npm test", "token=abcdef0123456789abcdef0123456789abcdef01"] } });
  assert.deepEqual(entries.map((entry) => entry.kind), ["tool", "message", "system"]);
  assert.equal(entries[0].tool.status, "running");
  assert.doesNotMatch(entries[2].text, /abcdef0123/, "the screen passes the credential filter");
});
