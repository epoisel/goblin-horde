import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { carryNowStart, codexAsk, isCodexSubagent, markRunningElsewhere, requestAsk, transformThread, withCodexNow } from "../lib/transform.mjs";
import { callSummary, inspectRollout, withApprovalGuess } from "../lib/rollout.mjs";
import { classifyCodex, composeAllScene, FEED_LIMITS } from "../lib/feed.mjs";

// Synthetic chats only.
const NOW = Date.parse("2026-10-13T10:40:00Z");
const finalTurn = (text, extra = {}) => ({ id: "turn-9", status: "completed", startedAt: (NOW - 120_000) / 1000, completedAt: (NOW - 60_000) / 1000,
  items: [{ type: "agentMessage", id: "m1", phase: "final_answer", text }], ...extra });
const chat = (turns, extra = {}) => transformThread({ id: "chat-csv-export", name: "Ship CSV export", updatedAt: (NOW - 60_000) / 1000, turns, ...extra });
const compose = (thread, { requests = [], now = NOW } = {}) => composeAllScene({
  codex: { ok: true, threads: [{ id: thread.id, updatedAt: thread.updatedAt }], listComplete: true,
    checked: { records: [{ thread, attention: classifyCodex(thread, { hasRequest: requests.length > 0 || Boolean(thread.awaitingApproval), now }) }], pending: 0, failed: 0, candidates: 1, capped: false } },
  claude: { ok: true, snapshot: { sessions: [], warning: "" } },
  orca: { ok: true, snapshot: { workspaces: [], warning: "", missing: true } },
  listRequests: (id) => requests.filter((request) => request.params.threadId === id),
  now,
}).agents[0];

test("a finished answer that ends in a question asks for a reply, with a sentence of context", () => {
  const actor = chat([finalTurn("I exported 120 rows to out.csv.\n\nThe totals match the ledger. Should I also add the archived invoices?")]);
  assert.equal(actor.ask.kind, "reply");
  assert.equal(actor.ask.text, "The totals match the ledger. Should I also add the archived invoices?");
  assert.equal(actor.ask.answerHere, "reply");
  assert.equal(actor.ask.at, NOW - 60_000);
  const shown = compose(actor);
  assert.equal(shown.attention, "needs");
  assert.deepEqual(shown.ask, actor.ask);
  // After the question's window it no longer asks, exactly when its needs-you class ends.
  const later = compose(actor, { now: NOW + FEED_LIMITS.askWindowMs + 1000 });
  assert.equal(later.ask, null);
  assert.equal(later.attention, "quiet");
  // A plain answer asks nothing; a chat that cannot take a reply here is answered in Codex.
  assert.equal(chat([finalTurn("Done. All tests pass.")]).ask, null);
  assert.equal(codexAsk({ ...actor, replyAvailable: false }, { now: NOW }).answerHere, null);
});

test("a Codex answer asks only when it ends in a question: headings and bullets mid-answer do not", () => {
  const explained = chat([finalTurn("## Why did the export fail?\n- The header row was missing.\n- The fixture was stale.\n\nBoth are fixed and the tests pass.")]);
  assert.deepEqual(explained.turnStates.at(-1).questions, []);
  assert.equal(explained.ask, null);
  assert.equal(classifyCodex(explained, { now: NOW }), "quiet");
  assert.equal(compose(explained).attention, "quiet");
  // A question in the middle of the answer, followed by more prose, is not the answer's question either.
  assert.deepEqual(chat([finalTurn("Should the CSV include archived rows? I left them out for now.\n\nDone.")]).turnStates.at(-1).questions, []);
  // A closing question followed by numbered options is a real question.
  const choice = chat([finalTurn("I found two ways to fix the export.\n\nWhich do you want?\n1. Rewrite the writer\n2. Patch the header row")]);
  assert.deepEqual(choice.turnStates.at(-1).questions, ["I found two ways to fix the export. Which do you want?"]);
  assert.equal(choice.ask.text, "I found two ways to fix the export. Which do you want?");
  assert.equal(compose(choice).attention, "needs");
  // Commentary along the way never asks.
  const commentary = chat([{ ...finalTurn("Done."), items: [{ type: "agentMessage", id: "c1", phase: "commentary", text: "Should I check the importer too?" },
    { type: "agentMessage", id: "m1", phase: "final_answer", text: "Done." }] }]);
  assert.deepEqual(commentary.turnStates.at(-1).questions, []);
});

test("an MCP elicitation or another request names what it asks, in the request's own words", () => {
  const actor = chat([{ id: "t1", status: "inProgress", completedAt: null, items: [] }]);
  const elicited = requestAsk(actor, { id: 12, method: "mcpServer/elicitation/request", receivedAt: NOW,
    params: { threadId: actor.id, serverName: "tracker", message: "Which project should the issue go in?", requestedSchema: { type: "object" } } });
  assert.equal(elicited.kind, "question");
  assert.equal(elicited.text, "Which project should the issue go in?");
  assert.equal(elicited.tool, "tracker");
  assert.equal(elicited.answerHere, null);
  const other = requestAsk(actor, { id: 13, method: "item/somethingNew/request", receivedAt: NOW, params: { threadId: actor.id, reason: "Needs a second look." } });
  assert.equal(other.text, "Needs a second look.");
  assert.equal(requestAsk(actor, { id: 14, method: "item/somethingNew/request", receivedAt: NOW, params: { threadId: actor.id } }).text, "Codex is waiting for your answer.");
});

test("a Codex subagent thread never asks the person, but its pending approvals still do", () => {
  const question = finalTurn("Found the writer in src/csv.js. Want me to refactor it?");
  for (const marker of [{ parentThreadId: "chat-parent-01" }, { agentNickname: "Scout", agentRole: "explorer" }, { source: { subAgent: { thread_spawn: {} } } }, { source: "subAgentThreadSpawn" }]) {
    const raw = { id: "chat-sub-0001", turns: [question], updatedAt: (NOW - 60_000) / 1000, ...marker };
    assert.equal(isCodexSubagent(raw), true, JSON.stringify(marker));
    const actor = transformThread(raw);
    assert.equal(actor.subagent, true);
    assert.equal(actor.ask, null);
    assert.deepEqual(actor.turnStates.at(-1).questions, []);
    assert.equal(classifyCodex(actor, { now: NOW }), "quiet");
    assert.equal(compose(actor).attention, "quiet");
    // A forged reply ask on a subagent is not believed either.
    assert.equal(codexAsk({ ...actor, ask: { kind: "reply", text: "x", key: "abcdef0123456789" } }, { now: NOW }), null);
  }
  const sub = transformThread({ id: "chat-sub-0002", parentThreadId: "chat-parent-01", turns: [{ id: "t", status: "inProgress", completedAt: null, items: [] }] });
  const request = { id: 41, method: "item/commandExecution/requestApproval", receivedAt: NOW - 5000,
    params: { threadId: "chat-sub-0002", itemId: "cmd-1", command: "npm publish", reason: "Publishes the package." } };
  const shown = compose(sub, { requests: [request] });
  assert.equal(shown.attention, "needs");
  assert.equal(shown.ask.kind, "approval");
  assert.equal(isCodexSubagent({ id: "chat-main-0001", source: "vscode" }), false);
});

test("pending app-server requests become asks answerable here", () => {
  const actor = chat([{ id: "t1", status: "inProgress", completedAt: null, items: [
    { type: "fileChange", id: "fc-1", status: "inProgress", changes: [{ path: "/work/billing-api/src/csv.js" }, { path: "/work/billing-api/README.md" }] },
  ] }]);
  const command = requestAsk(actor, { id: 7, method: "item/commandExecution/requestApproval", receivedAt: NOW,
    params: { threadId: actor.id, command: ["npm", "run", "deploy"], reason: "Deploys to staging." } });
  assert.deepEqual({ ...command, key: "k" }, { kind: "approval", text: "Allow Codex to run this command? Deploys to staging.", command: "npm run deploy",
    tool: "command", at: NOW, answerHere: "respond", requestId: "7", key: "k" });
  const files = requestAsk(actor, { id: 8, method: "item/fileChange/requestApproval", receivedAt: NOW, params: { threadId: actor.id, itemId: "fc-1" } });
  assert.equal(files.text, "Allow Codex to change these files?");
  assert.equal(files.command, "csv.js · README.md");
  const asked = requestAsk(actor, { id: "q-9", method: "item/tool/requestUserInput", receivedAt: NOW, params: { threadId: actor.id, questions: [
    { id: "fmt", header: "Format", question: "Which format should the export use?", options: [{ label: "CSV", description: "x" }, { label: "JSON" }] },
    { id: "arc", header: "Archive", question: "Include archived rows?", options: [{ label: "Yes" }, { label: "No" }] },
  ] } });
  assert.equal(asked.kind, "question");
  assert.equal(asked.text, "Which format should the export use?");
  assert.deepEqual(asked.options, ["CSV", "JSON"]);
  assert.equal(asked.questions.length, 2);
  assert.equal(asked.answerHere, "respond");
  assert.equal(asked.requestId, "q-9");
  // A request this viewer cannot answer still asks, answered in Codex.
  const other = requestAsk(actor, { id: 10, method: "mcpServer/elicitation/request", receivedAt: NOW, params: { threadId: actor.id } });
  assert.equal(other.answerHere, null);
  // A request outranks an answer's question; the key holds while the request stays pending.
  const both = chat([finalTurn("Ship it?")]);
  const request = { id: 7, method: "item/commandExecution/requestApproval", receivedAt: NOW, params: { threadId: both.id, command: "x" } };
  assert.equal(codexAsk(both, { requests: [request], now: NOW }).kind, "approval");
  assert.equal(codexAsk(both, { requests: [request], now: NOW }).key, codexAsk(both, { requests: [request], now: NOW + 9000 }).key);
});

const at = (secondsAgo) => new Date(NOW - secondsAgo * 1000).toISOString();
const line = (secondsAgo, type, payload = {}) => JSON.stringify({ timestamp: at(secondsAgo), type, payload });

test("the approval guess names the waiting command or patch, and the open turn shows its plan", () => {
  const dir = mkdtempSync(join(tmpdir(), "goblin-codex-asks-"));
  try {
    const file = join(dir, "rollout-2026-10-13.jsonl");
    const plan = line(200, "response_item", { type: "function_call", name: "update_plan", call_id: "p1",
      arguments: JSON.stringify({ plan: [{ step: "Read the exporter", status: "completed" }, { step: "Write the CSV writer", status: "in_progress" }, { step: "Run tests", status: "pending" }] }) });
    const write = (call) => writeFileSync(file, `${[line(300, "turn_context", { approval_policy: "on-request" }), plan,
      line(190, "response_item", { type: "function_call_output", call_id: "p1" }), call].join("\n")}\n`);
    write(line(90, "response_item", { type: "function_call", name: "exec_command", call_id: "c1",
      arguments: JSON.stringify({ cmd: "npm run deploy -- --env staging", workdir: "/work/billing-api", sandbox_permissions: "require_escalated" }) }));
    const seen = inspectRollout(file, { now: NOW });
    assert.equal(seen.awaits, true);
    assert.deepEqual(seen.call, { tool: "exec_command", command: "npm run deploy -- --env staging", at: NOW - 90_000 });
    assert.deepEqual(seen.progress, { done: 1, total: 3, current: "Write the CSV writer" });
    const thread = { id: "chat-held-001", updatedAt: (NOW - 30 * 60_000) / 1000, path: file, turns: [{ id: "t1", status: "interrupted", completedAt: null, items: [] }] };
    const actor = withApprovalGuess(markRunningElsewhere(transformThread(thread), { now: NOW }), file, { now: NOW });
    assert.equal(actor.ask.kind, "approval");
    assert.equal(actor.ask.text, "Codex may be waiting for your approval.");
    assert.equal(actor.ask.command, "npm run deploy -- --env staging");
    assert.equal(actor.ask.answerHere, null);
    assert.equal(actor.ask.at, NOW - 90_000);
    assert.deepEqual(actor.progress, { done: 1, total: 3, current: "Write the CSV writer" });
    assert.equal(compose(actor).ask.kind, "approval");

    write(line(90, "response_item", { type: "custom_tool_call", name: "apply_patch", call_id: "c2",
      input: "*** Begin Patch\n*** Update File: src/csv.js\n@@\n-a\n+b\n*** Add File: test/csv.test.js\n+x\n*** End Patch" }));
    assert.equal(inspectRollout(file, { now: NOW }).call.command, "Change src/csv.js, test/csv.test.js");
    write(line(90, "response_item", { type: "custom_tool_call", name: "exec", call_id: "c3",
      input: "const r = await tools.exec_command({ cmd: \"git push origin main\", workdir: \"/work\" });\ntext(r);" }));
    assert.equal(inspectRollout(file, { now: NOW }).call.command, "git push origin main");
    // A call that already has its answer is not waiting: no call, no guess, but the plan still shows.
    write([line(90, "response_item", { type: "function_call", name: "exec_command", call_id: "c4", arguments: "{\"cmd\":\"ls\"}" }),
      line(80, "response_item", { type: "function_call_output", call_id: "c4" })].join("\n"));
    const answered = inspectRollout(file, { now: NOW });
    assert.equal(answered.awaits, false);
    assert.equal(answered.call, null);
    assert.equal(answered.progress.total, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // Code-mode calls name their command several ways.
  const exec = (input) => callSummary({ type: "custom_tool_call", name: "exec", input }).command;
  assert.equal(exec("const r = await tools.exec_command({\n  \"workdir\": \"/work\",\n  \"cmd\": \"npm run lint -- --fix\"\n});"), "npm run lint -- --fix");
  assert.equal(exec("const cmd = 'git status --short';\nconst r = await tools.exec_command({ cmd, workdir: '/work' });"), "git status --short");
  assert.equal(exec("const command = `make build`;\nawait tools.exec_command({ cmd: command });"), "make build");
  assert.equal(exec("const out = await tools.mcp__tracker__get_issue({ id: 'X-1' });\ntext(out);"), "Use mcp__tracker__get_issue");
  assert.deepEqual(callSummary({ type: "local_shell_call", action: { command: ["bash", "-lc", "make test"] } }), { tool: "shell", command: "bash -lc make test" });
  assert.deepEqual(callSummary({ type: "function_call", name: "_search_messages", namespace: "mail", arguments: "{}" }), { tool: "_search_messages", command: "Use mail · _search_messages" });
});

test("now names the step running in an open turn, else Thinking, and nothing once the turn is over", () => {
  const open = (items) => withCodexNow(chat([{ id: "t1", status: "inProgress", startedAt: (NOW - 300_000) / 1000, completedAt: null, items }]));
  const running = open([{ type: "commandExecution", id: "c1", status: "inProgress", command: "npm test\nnpm run lint" }]);
  assert.deepEqual(running.now, { kind: "command", title: "Running npm test", detail: "npm test\nnpm run lint", startedAt: NOW - 60_000 });
  assert.equal(open([{ type: "fileChange", id: "f1", status: "inProgress", changes: [{ path: "/w/src/csv.js" }] }]).now.title, "Editing csv.js");
  assert.equal(open([{ type: "webSearch", id: "w1", status: "inProgress", query: "rfc 4180" }]).now.kind, "web");
  assert.equal(open([{ type: "mcpToolCall", id: "m1", status: "inProgress", server: "tracker", tool: "create_issue", arguments: {} }]).now.title, "Using create issue");
  // Nothing running: the newest finished step, in the past tense, first seen at the chat's last update.
  const finished = open([{ type: "commandExecution", id: "c2", status: "completed", command: "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'gh pr view 214'" }]);
  assert.deepEqual(finished.now, { kind: "command", title: "Ran gh pr view 214", detail: "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'gh pr view 214'",
    startedAt: NOW - 60_000, done: true });
  assert.equal(open([{ type: "commandExecution", id: "c5", status: "completed", command: "npm test", exitCode: 1 }]).now.title, "Ran npm test · exit 1");
  assert.equal(open([{ type: "fileChange", id: "f2", status: "completed", changes: [{ path: "/w/src/csv.ts" }] }]).now.title, "Edited csv.ts");
  assert.equal(open([{ type: "agentMessage", id: "a1", phase: "commentary", text: "Checking the PR.\nThen merging." }]).now.title, "Said: Checking the PR.");
  // Thinking only before the turn's first step.
  assert.equal(open([]).now.title, "Thinking");
  assert.equal(withCodexNow(chat([finalTurn("Done.")])).now, null);
  // A finished step keeps the time it was first seen too; a running step and a finished one are never the same.
  assert.equal(carryNowStart({ ...finished, now: { ...finished.now, startedAt: NOW - 90_000 } }, finished).now.startedAt, NOW - 90_000);
  assert.equal(carryNowStart({ ...finished, now: { ...finished.now, done: false } }, finished).now.startedAt, NOW - 60_000);
  // A step seen on an earlier read keeps its first time.
  const earlier = { ...running, now: { ...running.now, startedAt: NOW - 99_000 } };
  assert.equal(carryNowStart(earlier, running).now.startedAt, NOW - 99_000);
  const other = open([{ type: "commandExecution", id: "c3", status: "inProgress", command: "npm run build" }]);
  assert.equal(carryNowStart(earlier, other).now.startedAt, NOW - 60_000);
});

// A chat running in the Codex app: its session file's own records say what it is doing.
const event = (secondsAgo, payload) => line(secondsAgo, "event_msg", payload);
const item = (secondsAgo, value) => event(secondsAgo, { type: "item_completed", turn_id: "t1", item: value,
  started_at_ms: NOW - secondsAgo * 1000 - 500, completed_at_ms: NOW - secondsAgo * 1000 });
const turnStart = (secondsAgo) => [event(secondsAgo, { type: "task_started", turn_id: "t1" }), line(secondsAgo, "turn_context", { approval_policy: "never" }),
  line(secondsAgo, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Ship it" }] })];
const exec = (secondsAgo, id, code) => line(secondsAgo, "response_item", { type: "custom_tool_call", name: "exec", call_id: id, input: code });
const execOutput = (secondsAgo, id) => line(secondsAgo, "response_item", { type: "custom_tool_call_output", call_id: id, output: "PRIVATE-OUTPUT" });
const reasoning = (secondsAgo) => line(secondsAgo, "response_item", { type: "reasoning", summary: [], encrypted_content: "PRIVATE" });

test("a chat running elsewhere says what it is doing from its session file, with the records' own times", () => {
  const dir = mkdtempSync(join(tmpdir(), "goblin-codex-now-"));
  try {
    const file = join(dir, "rollout-2026-10-13-now.jsonl");
    const nowOf = (...lines) => { writeFileSync(file, `${lines.join("\n")}\n`); return inspectRollout(file, { now: NOW }).now; };
    // An earlier turn's open call never leaks into this one.
    const earlier = [exec(3000, "old", "await tools.exec_command({ cmd: \"npm run build\" });"), ...turnStart(600)];
    // The newest call still waiting for its output is what runs, since that record's time.
    const running = [...earlier, reasoning(300), exec(290, "c1", "const r = await tools.exec_command({ cmd: \"npm test -- --grep csv\" });")];
    assert.deepEqual(nowOf(...running), { kind: "command", title: "Running npm test -- --grep csv", detail: "npm test -- --grep csv", startedAt: NOW - 290_000 });
    // Its command finished: the newest finished step, as of its own time, in the past tense.
    const ran = [...running, item(200, { type: "CommandExecution", id: "exec-1", command: ["pwsh.exe", "-Command", "gh pr view 214"],
      parsed_cmd: [{ type: "unknown", cmd: "gh pr view 214" }], status: "completed", exit_code: 0, aggregated_output: "PRIVATE-OUTPUT" }), execOutput(199, "c1"),
      line(199, "token_usage_record"), event(199, { type: "token_count" })];
    assert.deepEqual(nowOf(...ran), { kind: "command", title: "Ran gh pr view 214", detail: "pwsh.exe -Command gh pr view 214", startedAt: NOW - 200_000, done: true });
    // Reasoning after it: Thinking, since the newest record (how long it has been quiet), never since the turn began.
    assert.deepEqual(nowOf(...ran, reasoning(60)), { kind: "think", title: "Thinking", startedAt: NOW - 60_000 });
    // What it said along the way, first line only.
    const said = item(30, { type: "AgentMessage", id: "msg_1", phase: "commentary", content: [{ type: "Text", text: "The PR is green.\nMerging it next." }] });
    assert.equal(nowOf(...ran, reasoning(60), said).title, "Said: The PR is green.");
    // Edits: an open patch names its files; a finished change names them in the past tense.
    const patch = line(20, "response_item", { type: "custom_tool_call", name: "apply_patch", call_id: "p1",
      input: "*** Begin Patch\n*** Update File: src/invoices/csv.ts\n@@\n-a\n+b\n*** End Patch" });
    assert.deepEqual(nowOf(...ran, patch), { kind: "edit", title: "Editing csv.ts", detail: "src/invoices/csv.ts", startedAt: NOW - 20_000 });
    const edited = item(10, { type: "FileChange", id: "exec-2", changes: { "C:/work/billing-api/src/invoices/csv.ts": { type: "update", unified_diff: "PRIVATE" } }, status: "completed" });
    assert.equal(nowOf(...ran, patch, edited, execOutput(9, "p1")).title, "Edited csv.ts");
    // A failed command says so; a plan update and a tool call read in plain words.
    const failed = item(5, { type: "CommandExecution", id: "exec-3", command: ["npm", "test"], parsed_cmd: [], status: "failed", exit_code: 1 });
    assert.equal(nowOf(...ran, failed).title, "Ran npm test · exit 1");
    const plan = line(4, "response_item", { type: "function_call", name: "update_plan", call_id: "u1", arguments: JSON.stringify({ plan: [{ step: "Ship", status: "in_progress" }] }) });
    assert.equal(nowOf(...ran, plan).title, "Updating the plan");
    assert.equal(nowOf(...ran, plan, line(3, "response_item", { type: "function_call_output", call_id: "u1" })).title, "Updated the plan");
    const mcp = item(2, { type: "McpToolCall", id: "call_9", server: "tracker", tool: "create_issue", status: "completed" });
    assert.equal(nowOf(...ran, mcp).title, "Used tracker · create_issue");
    // Nothing yet in this turn but the person's message: Thinking since then.
    assert.deepEqual(nowOf(...turnStart(45)), { kind: "think", title: "Thinking", startedAt: NOW - 45_000 });
    // Nothing kept is output, reasoning, or a diff.
    assert.doesNotMatch(JSON.stringify([nowOf(...ran), nowOf(...ran, patch, edited)]), /PRIVATE/);

    // The actor keeps the file's line (withCodexNow keeps it, carryNowStart carries nothing over it).
    writeFileSync(file, `${ran.join("\n")}\n`);
    const thread = { id: "chat-elsewhere-01", updatedAt: (NOW - 20_000) / 1000, path: file, turns: [{ id: "t1", status: "interrupted", completedAt: null, items: [] }] };
    const actor = withCodexNow(withApprovalGuess(markRunningElsewhere(transformThread(thread), { now: NOW }), file, { now: NOW }));
    assert.equal(actor.runningElsewhere, true);
    assert.deepEqual(actor.now, { kind: "command", title: "Ran gh pr view 214", detail: "pwsh.exe -Command gh pr view 214", startedAt: NOW - 200_000, done: true });
    const before = { ...actor, now: { ...actor.now, startedAt: NOW - 999_000 } };
    assert.equal(carryNowStart(before, actor).now.startedAt, NOW - 200_000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a session file that has not changed since it was scanned is not read again", () => {
  let reads = 0;
  let info = { size: 4000, mtimeMs: Date.now() - 60_000 };
  const text = [...turnStart(120), exec(100, "c1", "await tools.exec_command({ cmd: \"npm test\" });")].join("\n");
  const options = { now: NOW, readTail: () => { reads++; return text; }, stat: () => info };
  const path = "C:/codex/sessions/rollout-cached.jsonl";
  assert.equal(inspectRollout(path, options).now.title, "Running npm test");
  assert.equal(inspectRollout(path, options).now.title, "Running npm test");
  assert.equal(reads, 1, "same size and time: the earlier scan is reused");
  info = { size: 4100, mtimeMs: Date.now() - 30_000 };
  inspectRollout(path, options);
  assert.equal(reads, 2, "the file grew: it is read again");
  // A file written within the last moment may change again without its time moving: never reused.
  info = { size: 4200, mtimeMs: Date.now() };
  inspectRollout(path, options);
  inspectRollout(path, options);
  assert.equal(reads, 4);
});

test("a now line is filtered before it is cut, so a cut never leaves part of a credential", () => {
  // A long random token with no keyword is known by its length; cut to the first line's 60 characters, it is not.
  const TOKEN = ["a1B2", "c3D4"].join("").repeat(6);
  const command = `git clone https://git.example.test/shop.git ${TOKEN}`;
  const said = `Cloned it with ${TOKEN} as the deploy token.`;
  const leaked = (now) => JSON.stringify(now).includes(TOKEN.slice(0, 12));
  const open = (items) => withCodexNow(chat([{ id: "t1", status: "inProgress", startedAt: (NOW - 300_000) / 1000, completedAt: null, items }]));
  assert.equal(leaked(open([{ type: "commandExecution", id: "c1", status: "completed", command }]).now), false);
  assert.equal(leaked(open([{ type: "commandExecution", id: "c2", status: "inProgress", command }]).now), false);
  assert.equal(leaked(open([{ type: "agentMessage", id: "a1", phase: "commentary", text: said }]).now), false);
  // The same from a chat's session file: a call still running, a finished command, and what it said.
  const running = [...turnStart(120), line(100, "response_item", { type: "function_call", name: "shell_command", call_id: "s1", arguments: JSON.stringify({ command }) })];
  const finished = [...turnStart(120), event(90, { type: "item_completed", turn_id: "t1", item: { type: "CommandExecution", id: "x1", command } })];
  const spoke = [...turnStart(120), line(80, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: said }] })];
  for (const lines of [running, finished, spoke]) {
    const seen = inspectRollout("C:/codex/sessions/rollout-cut.jsonl", { now: NOW, readTail: () => lines.join("\n"), stat: () => { throw new Error("no stat"); } });
    assert.ok(seen.now, "it says what the chat is doing");
    assert.equal(leaked(seen.now), false, JSON.stringify(seen.now));
  }
});
