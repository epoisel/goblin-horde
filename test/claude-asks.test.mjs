import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendClaudeRecord, buildClaudeSessions, ClaudeReader, CLAUDE_LIMITS, cleanRecord, normalizeHookEvent } from "../lib/claude.mjs";
import { closingQuestion } from "../lib/asks.mjs";
import { claudePanePairs, identityMark } from "../lib/links.mjs";

// Synthetic sessions only: invented projects, paths, and commands.
const NOW = 1_800_000_000_000;
const SESSION = "c0ffee00-0000-4000-8000-00000000a5c1";
const MAIN = `claude-agent:${SESSION}`;
const TRANSCRIPT = "/home/dev/.claude/projects/-work-billing-api/c0ffee00-0000-4000-8000-00000000a5c1.jsonl";
const hookScript = fileURLToPath(new URL("../claude-hook.mjs", import.meta.url));

let counter = 0;
const hook = (event, extra = {}, at = NOW) => ({ hook_event_name: event, session_id: SESSION, cwd: "/work/billing-api", transcript_path: TRANSCRIPT, ...extra, _at: at });
function records(...inputs) {
  return inputs.map((input) => {
    const { _at, ...payload } = input;
    counter++;
    return normalizeHookEvent(payload, { now: _at ?? NOW + counter, id: (0x5000 + counter).toString(16).padStart(12, "0") });
  }).filter(Boolean);
}
const party = (list, now = NOW + 5000) => buildClaudeSessions(list, { now })[0];
const main = (list, now) => party(list, now).agents.find((agent) => agent.id === MAIN);
const pre = (tool, input, extra = {}) => ({ tool_name: tool, tool_input: input, ...extra });

test("each tool call records what it works on, filtered and clipped", () => {
  const cases = [
    [pre("Bash", { command: "npm test -- --grep csv" }), "npm test -- --grep csv"],
    [pre("PowerShell", { command: "Get-ChildItem C:\\work\\billing-api" }), "Get-ChildItem C:\\work\\billing-api"],
    [pre("Read", { file_path: "/work/billing-api/src/export.js" }), "/work/billing-api/src/export.js"],
    [pre("Edit", { file_path: "/work/billing-api/src/export.js", old_string: "a", new_string: "b" }), "/work/billing-api/src/export.js"],
    [pre("Write", { file_path: "/work/billing-api/README.md", content: "PRIVATE-CONTENT" }), "/work/billing-api/README.md"],
    [pre("MultiEdit", { file_path: "/work/billing-api/a.js", edits: [] }), "/work/billing-api/a.js"],
    [pre("NotebookEdit", { notebook_path: "/work/billing-api/n.ipynb", new_source: "PRIVATE-CELL" }), "/work/billing-api/n.ipynb"],
    [pre("Grep", { pattern: "exportCsv\\(", path: "/work/billing-api/src" }), "exportCsv\\(\nin /work/billing-api/src"],
    [pre("Glob", { pattern: "**/*.csv" }), "**/*.csv"],
    [pre("WebFetch", { url: "https://docs.example.test/csv", prompt: "PRIVATE-PROMPT" }), "https://docs.example.test/csv"],
    [pre("WebSearch", { query: "rfc 4180 quoting" }), "rfc 4180 quoting"],
    [pre("Agent", { description: "Find the CSV writer", subagent_type: "Explore", prompt: "PRIVATE-BRIEF" }), "Find the CSV writer"],
    [pre("Skill", { skill: "release-notes" }), "release-notes"],
    [pre("mcp__tracker__create_issue", { title: "x" }), "tracker · create_issue"],
  ];
  for (const [input, detail] of cases) {
    const [record] = records(hook("PreToolUse", { tool_use_id: `toolu_${counter}`, ...input }));
    assert.equal(record.detail, detail, input.tool_name);
    assert.ok(!JSON.stringify(record).includes("PRIVATE"), `${input.tool_name} kept input it should not`);
    assert.match(record.sig, /^[a-f0-9]{12}$/);
  }
  const [agent] = records(hook("PreToolUse", pre("Task", { description: "Review", subagent_type: "code-reviewer" })));
  assert.equal(agent.agentKind, "code-reviewer");
  // A permission request records its call id when the payload has one, and the same detail.
  const [asked] = records(hook("PermissionRequest", pre("Bash", { command: "rm -rf build" }, { tool_use_id: "toolu_perm1" })));
  assert.equal(asked.toolUse, "toolu_perm1");
  assert.equal(asked.detail, "rm -rf build");
  // Credentials in a command are removed; a huge command is cut before it is filtered.
  const FAKE = ["sk", "live", "ABCDEFGHIJKLMNOPQRSTUVWX"].join("_");
  const [secret] = records(hook("PreToolUse", pre("Bash", { command: `deploy --api-key ${FAKE} && ${"x".repeat(5_000_000)}` })));
  assert.ok(!secret.detail.includes(FAKE));
  assert.match(secret.detail, /^deploy --api-key \[secret removed\]/);
  assert.ok(secret.detail.length <= CLAUDE_LIMITS.detailChars);
});

test("questions, todo lists, tasks, prompts, and transcript paths are kept within their limits", () => {
  const questions = Array.from({ length: 6 }, (_, index) => ({ question: `${"Which export format? ".repeat(30)}${index}`, header: "Format", multiSelect: false,
    options: Array.from({ length: 9 }, (_, option) => ({ label: `${"Option ".repeat(20)}${option}`, description: "PRIVATE-DESCRIPTION" })) }));
  const [ask] = records(hook("PreToolUse", pre("AskUserQuestion", { questions }, { tool_use_id: "toolu_q" })));
  assert.equal(ask.asks.length, 4);
  for (const item of ask.asks) {
    assert.ok(item.q.length <= 300);
    assert.equal(item.options.length, 6);
    assert.ok(item.options.every((label) => label.length <= 80));
  }
  assert.ok(!JSON.stringify(ask).includes("PRIVATE-DESCRIPTION"));

  const todos = Array.from({ length: 40 }, (_, index) => ({ content: `Step ${index} ${"y".repeat(300)}`, activeForm: `Doing step ${index}`,
    status: index < 3 ? "completed" : index === 3 ? "in_progress" : "pending" }));
  const [plan] = records(hook("PreToolUse", pre("TodoWrite", { todos })));
  assert.equal(plan.todos.length, CLAUDE_LIMITS.todos);
  assert.ok(plan.todos.every((item) => item.t.length <= CLAUDE_LIMITS.todoChars));
  assert.deepEqual(plan.todos[3], { t: "Doing step 3", s: "in_progress" }, "the active item reads as Claude Code shows it");
  assert.equal(plan.todos[0].s, "completed");
  assert.ok(JSON.stringify(plan).length < CLAUDE_LIMITS.lineChars);

  const [created] = records(hook("PreToolUse", pre("TaskCreate", { subject: "Write the CSV writer", description: "PRIVATE-TASK-BODY" })));
  assert.deepEqual(created.task, { subject: "Write the CSV writer" });
  const [made] = records(hook("PostToolUse", pre("TaskCreate", { subject: "x" }, { tool_response: { task: { id: "7", subject: "x" } } })));
  assert.deepEqual(made.task, { id: "7" });
  const [madeText] = records(hook("PostToolUse", pre("TaskCreate", { subject: "x" }, { tool_response: "Task #8 created successfully" })));
  assert.deepEqual(madeText.task, { id: "8" });
  const [updated] = records(hook("PreToolUse", pre("TaskUpdate", { taskId: "7", status: "completed", description: "PRIVATE" })));
  assert.deepEqual(updated.task, { id: "7", status: "completed" });

  const FAKE = ["ghp", "abcdefghijklmnopqrstuvwxyz0123"].join("_");
  const [prompt] = records(hook("UserPromptSubmit", { prompt: `Use ${FAKE} to push. ${"Then tidy up. ".repeat(200)}` }));
  assert.ok(prompt.prompt.length <= CLAUDE_LIMITS.promptChars);
  assert.match(prompt.prompt, /^Use \[secret removed\] to push\./);
  assert.equal(prompt.transcript, TRANSCRIPT);
  const [start] = records(hook("SubagentStart", { agent_id: "sub1", agent_type: "Explore", agent_transcript_path: "/home/dev/.claude/projects/x/s/subagents/agent-sub1.jsonl" }));
  assert.equal(start.agentTranscript, "/home/dev/.claude/projects/x/s/subagents/agent-sub1.jsonl");
  // Paths that are not absolute transcripts are not kept.
  assert.equal(records(hook("SessionStart", { source: "startup", transcript_path: "relative/x.jsonl" }))[0].transcript, undefined);
  assert.equal(records(hook("SessionStart", { source: "startup", transcript_path: "/etc/passwd" }))[0].transcript, undefined);
});

test("a subagent's final message is never a question for the person", () => {
  const [stop] = records(hook("SubagentStop", { agent_id: "sub1", agent_type: "general-purpose", last_assistant_message: "Here is what you asked for. Should I continue?" }));
  assert.equal(stop.question, undefined);
  assert.match(stop.message, /Should I continue\?/, "the message excerpt is kept");
  // An older record on disk that carries one is not believed either.
  assert.equal(cleanRecord({ ...stop, question: "Should I continue?" }).question, undefined);
  const list = records(
    hook("UserPromptSubmit", {}, NOW),
    hook("SubagentStart", { agent_id: "sub1", agent_type: "general-purpose" }, NOW + 1),
    hook("SubagentStop", { agent_id: "sub1", agent_type: "general-purpose", last_assistant_message: "Can you share the file?" }, NOW + 2),
  );
  const child = party(list).agents.find((agent) => agent.childOf);
  assert.equal(child.ask, null);
  assert.notEqual(child.attention, "needs");
  assert.deepEqual(child.turnStates.at(-1).questions, []);
  // Even a legacy question on a subagent's record never reaches its actor.
  const legacy = { ...list[2], id: "abcdef000001", question: "Can you share the file?" };
  assert.equal(party([...list.slice(0, 2), legacy]).agents.find((agent) => agent.childOf).ask, null);
});

test("parallel calls: a later call finishing does not answer an earlier call's permission request", () => {
  // The live case: Read A asks, Read B runs and finishes, then the permission notice arrives.
  const base = [
    hook("UserPromptSubmit", {}, NOW),
    hook("PreToolUse", pre("Read", { file_path: "/work/billing-api/shots/full-half.png" }, { tool_use_id: "toolu_A" }), NOW + 1),
    hook("PermissionRequest", pre("Read", { file_path: "/work/billing-api/shots/full-half.png" }), NOW + 2),
    hook("PreToolUse", pre("Read", { file_path: "/work/billing-api/src/b.js" }, { tool_use_id: "toolu_B" }), NOW + 3),
    hook("PostToolUse", pre("Read", { file_path: "/work/billing-api/src/b.js" }, { tool_use_id: "toolu_B" }), NOW + 4),
    hook("Notification", { notification_type: "permission_prompt" }, NOW + 5),
  ];
  const list = records(...base);
  const asking = main(list);
  assert.equal(asking.attention, "needs");
  assert.equal(asking.ask.kind, "permission");
  assert.equal(asking.ask.text, "Allow Read to open full-half.png?");
  assert.equal(asking.ask.command, "/work/billing-api/shots/full-half.png");
  assert.equal(asking.ask.tool, "Read");
  assert.equal(asking.ask.answerHere, null);
  assert.equal(asking.ask.at, NOW + 2);
  assert.match(asking.ask.key, /^[a-f0-9]{16}$/);
  // A's own result answers it.
  const answered = main([...list, ...records(hook("PostToolUse", pre("Read", { file_path: "/work/billing-api/shots/full-half.png" }, { tool_use_id: "toolu_A" }), NOW + 6))]);
  assert.equal(answered.ask, null);
  assert.equal(answered.attention, "working");

  // With the call id on the request, and with the request stamped a moment before its own call.
  const keyed = records(
    hook("UserPromptSubmit", {}, NOW),
    hook("PermissionRequest", pre("PowerShell", { command: "Remove-Item build -Recurse" }, { tool_use_id: "toolu_P" }), NOW + 1),
    hook("PreToolUse", pre("PowerShell", { command: "Remove-Item build -Recurse" }, { tool_use_id: "toolu_P" }), NOW + 2),
    hook("PreToolUse", pre("PowerShell", { command: "npm test" }, { tool_use_id: "toolu_Q" }), NOW + 3),
    hook("PostToolUse", pre("PowerShell", { command: "npm test" }, { tool_use_id: "toolu_Q" }), NOW + 4),
  );
  assert.equal(main(keyed).ask.text, "Allow PowerShell to run this command?");
  assert.equal(main(keyed).ask.command, "Remove-Item build -Recurse");
  const early = records(
    hook("UserPromptSubmit", {}, NOW),
    hook("PermissionRequest", pre("Bash", { command: "make release" }), NOW + 1),
    hook("PreToolUse", pre("Bash", { command: "make release" }, { tool_use_id: "toolu_E" }), NOW + 2),
    hook("PreToolUse", pre("Bash", { command: "ls" }, { tool_use_id: "toolu_F" }), NOW + 3),
    hook("PostToolUse", pre("Bash", { command: "ls" }, { tool_use_id: "toolu_F" }), NOW + 4),
  );
  assert.equal(main(early).ask.command, "make release");
  const done = main([...early, ...records(hook("PostToolUse", pre("Bash", { command: "make release" }, { tool_use_id: "toolu_E" }), NOW + 5))]);
  assert.equal(done.ask, null);
  // The end of the turn, the session, a new prompt, or the prompt going idle answers it too.
  for (const end of [hook("Stop", { last_assistant_message: "Skipped it." }, NOW + 9), hook("StopFailure", { error: "server_error" }, NOW + 9),
    hook("SessionEnd", { reason: "other" }, NOW + 9), hook("UserPromptSubmit", {}, NOW + 9), hook("Notification", { notification_type: "idle_prompt" }, NOW + 9)]) {
    assert.equal(main([...list, ...records(end)]).ask, null, end.hook_event_name);
  }
});

test("an approved permission stops asking: a request alone asks briefly, Claude Code's notice confirms it", () => {
  const SECOND = 1000;
  const deploy = pre("Bash", { command: "npm run deploy -- --env staging" }, { tool_use_id: "toolu_D" });
  const asked = records(
    hook("UserPromptSubmit", {}, NOW),
    hook("PreToolUse", deploy, NOW + 1),
    hook("PermissionRequest", deploy, NOW + 2),
  );
  // Just asked: needs you, as the dialog is on screen.
  assert.equal(main(asked, NOW + 5 * SECOND).attention, "needs");
  // Approved at once: no notice ever comes, and the five-minute deploy is work, not a question.
  const running = main(asked, NOW + 15 * SECOND);
  assert.equal(running.ask, null);
  assert.equal(running.attention, "working");
  assert.equal(running.now.title, "Running npm run deploy -- --env staging");
  // Still open after six seconds: Claude Code says so, and the ask stays until the call resolves.
  const confirmed = [...asked, ...records(hook("Notification", { notification_type: "permission_prompt" }, NOW + 6 * SECOND))];
  const waiting = main(confirmed, NOW + 10 * 60 * SECOND);
  assert.equal(waiting.attention, "needs");
  assert.equal(waiting.ask.text, "Allow Bash to run this command?");
  assert.equal(waiting.ask.key, main(asked, NOW + 5 * SECOND).ask.key, "confirming an ask does not make it a new one");
  assert.equal(main([...confirmed, ...records(hook("PostToolUse", deploy, NOW + 9 * 60 * SECOND))], NOW + 10 * 60 * SECOND).ask, null);
  // agent_needs_input confirms it too.
  assert.equal(main([...asked, ...records(hook("Notification", { notification_type: "agent_needs_input" }, NOW + 7 * SECOND))], NOW + 60 * SECOND).attention, "needs");
});

test("parallel calls: the notice confirms the request that is still open, not one answered earlier", () => {
  const SECOND = 1000;
  const fileA = pre("Read", { file_path: "/work/billing-api/shots/full-half.png" }, { tool_use_id: "toolu_RA" });
  const fileB = pre("Read", { file_path: "/work/billing-api/src/b.js" }, { tool_use_id: "toolu_RB" });
  // The live case: PreToolUse A, PermissionRequest A, PreToolUse B, PostToolUse B, then the notice.
  const live = records(
    hook("UserPromptSubmit", {}, NOW),
    hook("PreToolUse", fileA, NOW + 1),
    hook("PermissionRequest", { ...fileA, tool_use_id: undefined }, NOW + 2),
    hook("PreToolUse", fileB, NOW + 3),
    hook("PostToolUse", fileB, NOW + 4),
    hook("Notification", { notification_type: "permission_prompt" }, NOW + 6 * SECOND),
  );
  const actor = main(live, NOW + 2 * 60 * SECOND);
  assert.equal(actor.attention, "needs");
  assert.equal(actor.ask.text, "Allow Read to open full-half.png?");
  // A request answered at once, then a second one left open: only the second is confirmed.
  const build = pre("Bash", { command: "make build" }, { tool_use_id: "toolu_M1" });
  const push = pre("Bash", { command: "git push origin main" }, { tool_use_id: "toolu_M2" });
  const two = records(
    hook("UserPromptSubmit", {}, NOW),
    hook("PreToolUse", build, NOW + 1),
    hook("PermissionRequest", build, NOW + 2),
    hook("PostToolUse", build, NOW + 20 * SECOND),
    hook("PreToolUse", push, NOW + 30 * SECOND),
    hook("PermissionRequest", push, NOW + 30 * SECOND + 1),
    hook("Notification", { notification_type: "permission_prompt" }, NOW + 36 * SECOND),
  );
  assert.equal(main(two, NOW + 5 * 60 * SECOND).ask.command, "git push origin main");
});

test("a confirmed prompt is over once the agent moves on: denied, it gets no result of its own", () => {
  const SECOND = 1000;
  const remove = pre("Bash", { command: "rm -rf build" }, { tool_use_id: "toolu_X1" });
  const asked = records(
    hook("UserPromptSubmit", {}, NOW),
    hook("PreToolUse", remove, NOW + 1),
    hook("PermissionRequest", remove, NOW + 2),
    hook("Notification", { notification_type: "permission_prompt" }, NOW + 6 * SECOND),
  );
  const later = NOW + 5 * 60 * SECOND;
  assert.equal(main(asked, later).attention, "needs");
  // Denied: no PostToolUse ever comes. The next call, a new prompt, or the end of the turn answers it.
  const next = records(hook("PreToolUse", pre("Bash", { command: "ls build" }, { tool_use_id: "toolu_X2" }), NOW + 40 * SECOND));
  assert.equal(main([...asked, ...next], later).ask, null);
  assert.equal(main([...asked, ...records(hook("UserPromptSubmit", {}, NOW + 40 * SECOND))], later).ask, null);
  assert.equal(main([...asked, ...records(hook("Stop", { last_assistant_message: "Left the build folder alone." }, NOW + 40 * SECOND))], later).ask, null);
  // A newer permission request is the new prompt; the old one is done.
  const newer = pre("Bash", { command: "rm -rf dist" }, { tool_use_id: "toolu_X3" });
  const replaced = main([...asked, ...records(hook("PreToolUse", newer, NOW + 40 * SECOND), hook("PermissionRequest", newer, NOW + 40 * SECOND + 1))], NOW + 45 * SECOND);
  assert.equal(replaced.ask.command, "rm -rf dist");
  // A call that started before the notice (a parallel one) does not answer it, nor does the call's own late hook.
  const parallel = records(
    hook("UserPromptSubmit", {}, NOW),
    hook("PreToolUse", remove, NOW + 1),
    hook("PermissionRequest", remove, NOW + 2),
    hook("PreToolUse", pre("Read", { file_path: "/work/billing-api/a.js" }, { tool_use_id: "toolu_X4" }), NOW + 3),
    hook("Notification", { notification_type: "permission_prompt" }, NOW + 6 * SECOND),
    hook("PostToolUse", pre("Read", { file_path: "/work/billing-api/a.js" }, { tool_use_id: "toolu_X4" }), NOW + 7 * SECOND),
  );
  assert.equal(main(parallel, later).attention, "needs");
  // Unconfirmed and denied: it stops asking on its own, and a new prompt or the end of the turn clears it at once.
  const quick = records(hook("UserPromptSubmit", {}, NOW), hook("PreToolUse", remove, NOW + 1), hook("PermissionRequest", remove, NOW + 2));
  assert.equal(main(quick, NOW + 30 * SECOND).ask, null);
  assert.equal(main([...quick, ...records(hook("Stop", { last_assistant_message: "Skipped." }, NOW + 3 * SECOND))], NOW + 4 * SECOND).ask, null);
});

test("a question stays a question until answered, with or without a notice", () => {
  const questions = [{ question: "Which export format?", options: [{ label: "CSV" }, { label: "JSON" }] }];
  const asked = records(
    hook("UserPromptSubmit", {}, NOW),
    hook("PreToolUse", pre("AskUserQuestion", { questions }, { tool_use_id: "toolu_AQ" }), NOW + 1),
    hook("PermissionRequest", pre("AskUserQuestion", { questions }), NOW + 2),
  );
  assert.equal(main(asked, NOW + 30 * 60_000).ask.kind, "question");
  assert.equal(main(asked, NOW + 30 * 60_000).attention, "needs");
});

test("a subagent's permission request is its own, and the session's notice does not add a second ask", () => {
  const list = records(
    hook("UserPromptSubmit", {}, NOW),
    hook("SubagentStart", { agent_id: "sub7", agent_type: "Explore" }, NOW + 1),
    hook("PreToolUse", pre("WebFetch", { url: "https://docs.example.test/a" }, { agent_id: "sub7", tool_use_id: "toolu_W" }), NOW + 2),
    hook("PermissionRequest", pre("WebFetch", { url: "https://docs.example.test/a" }, { agent_id: "sub7" }), NOW + 3),
    hook("Notification", { notification_type: "permission_prompt" }, NOW + 4),
  );
  const { agents } = party(list);
  const child = agents.find((agent) => agent.childOf);
  assert.equal(child.ask.text, "Allow WebFetch to open docs.example.test?");
  assert.equal(child.attention, "needs");
  const session = agents.find((agent) => agent.id === MAIN);
  assert.equal(session.ask, null);
  assert.notEqual(session.attention, "needs");
  // The session's notice confirms the subagent's request, so it still asks a minute later.
  const later = party(list, NOW + 60_000).agents;
  assert.equal(later.find((agent) => agent.childOf).attention, "needs");
  assert.equal(later.find((agent) => agent.id === MAIN).ask, null);
});

test("AskUserQuestion is a question with its options, answered in Claude Code", () => {
  const questions = [
    { question: "Which export format should the report use?", header: "Format", multiSelect: false, options: [{ label: "CSV", description: "d" }, { label: "JSON", description: "d" }] },
    { question: "Include archived invoices?", header: "Archive", multiSelect: false, options: [{ label: "Yes" }, { label: "No" }] },
  ];
  const asked = records(
    hook("UserPromptSubmit", {}, NOW),
    hook("PreToolUse", pre("AskUserQuestion", { questions }, { tool_use_id: "toolu_ask" }), NOW + 1),
    hook("PermissionRequest", pre("AskUserQuestion", { questions }), NOW + 2),
    hook("Notification", { notification_type: "elicitation_dialog" }, NOW + 3),
  );
  const actor = main(asked);
  assert.equal(actor.ask.kind, "question");
  assert.equal(actor.ask.text, "Which export format should the report use?");
  assert.deepEqual(actor.ask.options, ["CSV", "JSON"]);
  assert.deepEqual(actor.ask.questions, [
    { text: "Which export format should the report use?", options: ["CSV", "JSON"] },
    { text: "Include archived invoices?", options: ["Yes", "No"] },
  ]);
  assert.equal(actor.ask.tool, "AskUserQuestion");
  assert.equal(actor.ask.answerHere, null);
  assert.equal(actor.ask.at, NOW + 1, "one ask, from the call itself");
  assert.deepEqual(actor.now, { kind: "ask", title: "Asking you a question", detail: "Which export format should the report use?", startedAt: NOW + 1 });
  const answered = main([...asked, ...records(hook("PostToolUse", pre("AskUserQuestion", { questions }, { tool_use_id: "toolu_ask" }), NOW + 4))]);
  assert.equal(answered.ask, null);
});

test("a notice with no captured request still names the open call, and a reply's closing question asks too", () => {
  const notice = main(records(
    hook("UserPromptSubmit", {}, NOW),
    hook("PreToolUse", pre("Bash", { command: "git push origin main" }, { tool_use_id: "toolu_N" }), NOW + 1),
    hook("Notification", { notification_type: "permission_prompt" }, NOW + 2),
  ));
  assert.equal(notice.ask.kind, "permission");
  assert.equal(notice.ask.text, "Claude Code is waiting for your answer.");
  assert.equal(notice.ask.command, "git push origin main");
  assert.equal(notice.ask.tool, "Bash");

  const replied = records(
    hook("UserPromptSubmit", {}, NOW),
    hook("Stop", { last_assistant_message: "Exported 120 invoices.\n\nAll 42 tests pass. Want me to open a pull request?" }, NOW + 1),
  );
  const actor = main(replied);
  assert.equal(actor.ask.kind, "reply");
  assert.equal(actor.ask.text, "All 42 tests pass. Want me to open a pull request?");
  assert.equal(actor.ask.answerHere, null);
  assert.equal(actor.attention, "needs");
  assert.equal(actor.now, null, "a finished turn is doing nothing");
  // A new prompt moves on from it, and the session ending clears it.
  assert.equal(main([...replied, ...records(hook("UserPromptSubmit", {}, NOW + 2))]).ask, null);
  const ended = main([...replied, ...records(hook("SessionEnd", { reason: "prompt_input_exit" }, NOW + 2))]);
  assert.equal(ended.ask, null);
  assert.equal(ended.attention, "quiet");
});

test("a notice keeps Claude Code's own words, filtered and clipped, and they are the ask when nothing else is", () => {
  const FAKE = ["ghp", "abcdefghijklmnopqrstuvwxyz0123"].join("_");
  const [notice] = records(hook("Notification", { notification_type: "permission_prompt", title: "Needs you",
    message: `Claude needs your permission to use Bash with ${FAKE} ${"and more ".repeat(80)}` }));
  assert.match(notice.message, /^Claude needs your permission to use Bash with \[secret removed\]/);
  assert.ok(notice.message.length <= 300);
  assert.ok(!JSON.stringify(notice).includes("Needs you"), "the title is not kept");
  // Quiet notices keep no text.
  assert.equal(records(hook("Notification", { notification_type: "idle_prompt", message: "Claude is waiting for your input" }))[0].message, undefined);
  // An old hook install captured no request: the notice's own words say what is asked.
  const asked = main(records(
    hook("UserPromptSubmit", {}, NOW),
    hook("PreToolUse", pre("WebFetch", { url: "https://docs.example.test/csv" }, { tool_use_id: "toolu_W9" }), NOW + 1),
    hook("Notification", { notification_type: "permission_prompt", message: "Claude needs your permission to use WebFetch" }, NOW + 6000),
  ), NOW + 60_000);
  assert.equal(asked.ask.text, "Claude needs your permission to use WebFetch");
  assert.equal(asked.ask.command, "https://docs.example.test/csv");
  const elicited = main(records(hook("UserPromptSubmit", {}, NOW),
    hook("Notification", { notification_type: "elicitation_dialog", message: "billing-api needs the invoice period" }, NOW + 1)), NOW + 60_000);
  assert.equal(elicited.ask.text, "billing-api needs the invoice period");
});

test("an old closing question does not come back when the session is resumed or busy elsewhere", () => {
  const HOUR = 60 * 60_000;
  const replied = records(
    hook("UserPromptSubmit", {}, NOW),
    hook("Stop", { last_assistant_message: "Exported 120 invoices. Want me to open a pull request?" }, NOW + 1000),
  );
  assert.equal(main(replied, NOW + 60_000).ask.kind, "reply");
  // Resumed the next day (or a minute later): the question was from the old conversation.
  for (const at of [NOW + 26 * HOUR, NOW + 2 * 60_000]) {
    const resumed = main([...replied, ...records(hook("SessionStart", { source: "resume" }, at))], at + 5000);
    assert.equal(resumed.ask, null, `resumed at +${at - NOW} ms`);
    assert.notEqual(resumed.attention, "needs");
  }
  // A subagent still at work keeps the session fresh, but the question itself is over six hours old.
  const busy = records(hook("PreToolUse", pre("Grep", { pattern: "invoice" }, { agent_id: "sub4", tool_use_id: "toolu_G4" }), NOW + 6.4 * HOUR));
  const later = main([...replied, ...busy], NOW + 6.5 * HOUR);
  assert.equal(later.ask, null);
  assert.notEqual(later.attention, "needs");
});

test("an ask stops alerting after askMs of session quiet, and the key is stable for the same ask", () => {
  const list = records(
    hook("UserPromptSubmit", {}, NOW),
    hook("PreToolUse", pre("Bash", { command: "make deploy" }, { tool_use_id: "toolu_X" }), NOW + 1),
    hook("PermissionRequest", pre("Bash", { command: "make deploy" }, { tool_use_id: "toolu_X" }), NOW + 2),
    hook("Notification", { notification_type: "permission_prompt" }, NOW + 3),
  );
  const soon = main(list, NOW + 60_000);
  const later = main(list, NOW + 120_000);
  assert.equal(soon.ask.key, later.ask.key, "the same ask keeps its key from poll to poll");
  const old = main(list, NOW + 2 + CLAUDE_LIMITS.askMs + 1000);
  assert.equal(old.ask, null);
  assert.notEqual(old.attention, "needs");
  // Activity elsewhere in the session keeps it current.
  const busy = records(hook("SubagentStart", { agent_id: "sub9", agent_type: "Explore" }, NOW + CLAUDE_LIMITS.askMs));
  assert.ok(main([...list, ...busy], NOW + CLAUDE_LIMITS.askMs + 5000).ask);
  // A second request on another call is a new ask with a new key.
  const again = main([...list, ...records(hook("PostToolUse", pre("Bash", { command: "make deploy" }, { tool_use_id: "toolu_X" }), NOW + 3),
    hook("PreToolUse", pre("Bash", { command: "make deploy" }, { tool_use_id: "toolu_Y" }), NOW + 4),
    hook("PermissionRequest", pre("Bash", { command: "make deploy" }, { tool_use_id: "toolu_Y" }), NOW + 5))]);
  assert.notEqual(again.ask.key, soon.ask.key);
});

test("now names the newest open call, Thinking between calls, and nothing once the turn is over", () => {
  const start = [hook("UserPromptSubmit", {}, NOW)];
  const nowFor = (input) => main(records(...start, hook("PreToolUse", { tool_use_id: `toolu_now${counter}`, ...input }, NOW + 10))).now;
  assert.deepEqual(nowFor(pre("Bash", { command: "npm test\nnpm run lint" })), { kind: "command", title: "Running npm test", detail: "npm test\nnpm run lint", startedAt: NOW + 10 });
  assert.equal(nowFor(pre("Bash", { command: `node ${"a".repeat(100)}` })).title.length, "Running ".length + 60);
  assert.equal(nowFor(pre("Edit", { file_path: "/work/billing-api/server.mjs" })).title, "Editing server.mjs");
  assert.equal(nowFor(pre("Write", { file_path: "/work/billing-api/out.csv" })).kind, "write");
  assert.equal(nowFor(pre("Read", { file_path: "/work/billing-api/README.md" })).title, "Reading README.md");
  assert.equal(nowFor(pre("Grep", { pattern: "exportCsv" })).title, "Searching exportCsv");
  assert.equal(nowFor(pre("WebFetch", { url: "https://docs.example.test/page" })).title, "Fetching docs.example.test");
  assert.equal(nowFor(pre("Agent", { description: "Find the CSV writer", subagent_type: "Explore" })).title, "Subagent Find the CSV writer");
  assert.equal(nowFor(pre("Agent", { description: "Find the CSV writer", subagent_type: "Explore" })).kind, "agent");
  assert.equal(nowFor(pre("mcp__tracker__create_issue", {})).title, "Using tracker · create_issue");
  const between = main(records(...start, hook("PreToolUse", pre("Bash", { command: "ls" }, { tool_use_id: "toolu_L" }), NOW + 1),
    hook("PostToolUse", pre("Bash", { command: "ls" }, { tool_use_id: "toolu_L" }), NOW + 2)));
  assert.deepEqual(between.now, { kind: "think", title: "Thinking", startedAt: NOW + 2 });
  assert.equal(main(records(...start, hook("Stop", { last_assistant_message: "Done." }, NOW + 3))).now, null);
});

test("progress follows the newest todo list or task list", () => {
  const todos = [
    { content: "Read the exporter", activeForm: "Reading the exporter", status: "completed" },
    { content: "Write the CSV writer", activeForm: "Writing the CSV writer", status: "in_progress" },
    { content: "Run the tests", activeForm: "Running the tests", status: "pending" },
  ];
  const list = records(hook("UserPromptSubmit", {}, NOW), hook("PreToolUse", pre("TodoWrite", { todos }, { tool_use_id: "toolu_T" }), NOW + 1));
  assert.deepEqual(main(list).progress, { done: 1, total: 3, current: "Writing the CSV writer" });
  const tasks = records(
    hook("PreToolUse", pre("TaskCreate", { subject: "Parse invoices" }, { tool_use_id: "toolu_c1" }), NOW + 2),
    hook("PostToolUse", pre("TaskCreate", { subject: "Parse invoices" }, { tool_use_id: "toolu_c1", tool_response: { task: { id: "1" } } }), NOW + 3),
    hook("PreToolUse", pre("TaskCreate", { subject: "Write rows" }, { tool_use_id: "toolu_c2" }), NOW + 4),
    hook("PostToolUse", pre("TaskCreate", { subject: "Write rows" }, { tool_use_id: "toolu_c2", tool_response: "Task #2 created successfully: Write rows" }), NOW + 5),
    hook("PreToolUse", pre("TaskUpdate", { taskId: "1", status: "completed" }, { tool_use_id: "toolu_u1" }), NOW + 6),
    hook("PreToolUse", pre("TaskUpdate", { taskId: "2", status: "in_progress" }, { tool_use_id: "toolu_u2" }), NOW + 7),
  );
  assert.deepEqual(main([...list, ...tasks]).progress, { done: 1, total: 2, current: "Write rows" });
  assert.equal(main(records(hook("UserPromptSubmit", {}, NOW))).progress, null);
});

test("closing questions keep the question and one sentence of context", () => {
  assert.equal(closingQuestion("Ready. Want me to push?"), "Ready. Want me to push?");
  assert.equal(closingQuestion("I changed three files. Then I ran the tests. All pass. Should I commit?"), "All pass. Should I commit?");
  assert.equal(closingQuestion("Which layout should I use?\n- Compact\n- Spacious"), "Which layout should I use?");
  assert.equal(closingQuestion("Here are two options.\n\nWhich do you prefer? Options:\n1. CSV\n2. JSON"), "Here are two options. Which do you prefer?");
  assert.equal(closingQuestion("```js\nconst x = 1;\n```\nShip it?"), "Ship it?", "code is not context");
  assert.equal(closingQuestion("All done.\n- one\n- two"), "");
  assert.equal(closingQuestion("Is this right? I think so."), "");
  assert.ok(closingQuestion(`${"Long sentence here. ".repeat(100)}Ok?`, 600).length <= 600);
});

test("the hook entrypoint keeps a huge payload's record within one log line", () => {
  const dir = mkdtempSync(join(tmpdir(), "goblin-claude-asks-"));
  try {
    // Lone surrogates take six characters each once written as JSON, so thirty clipped items still overflow a line.
    const todos = Array.from({ length: 30 }, (_, index) => ({ content: `${"\ud800".repeat(250)} ${index}`, activeForm: "x", status: "pending" }));
    const payload = JSON.stringify({ hook_event_name: "PreToolUse", session_id: SESSION, cwd: "/work/billing-api", tool_name: "TodoWrite",
      tool_use_id: "toolu_big", tool_input: { todos, padding: "z".repeat(2_000_000) } });
    const run = spawnSync(process.execPath, [hookScript], { input: payload, env: { ...process.env, GOBLIN_HORDE_STATE_DIR: dir }, encoding: "utf8", timeout: 20_000 });
    assert.equal(run.status, 0);
    const lines = readFileSync(join(dir, "claude", "activity.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.ok(lines[0].length <= CLAUDE_LIMITS.lineChars);
    const kept = JSON.parse(lines[0]).todos.length;
    assert.ok(kept >= 1 && kept < 30, `a list too long for one line is shortened, not dropped (${kept})`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a session's recent prompts and replies prove which Orca pane it runs in", () => {
  const dir = mkdtempSync(join(tmpdir(), "goblin-claude-asks-"));
  try {
    const FAKE = ["ghp", "abcdefghijklmnopqrstuvwxyz0123"].join("_");
    const prompt = `Ship the CSV export for billing-api; push with ${FAKE} when the tests pass.`;
    for (const record of records(
      hook("UserPromptSubmit", { prompt: "An earlier prompt about the importer module." }, NOW),
      hook("Stop", { last_assistant_message: "The importer now reads quoted fields correctly." }, NOW + 1),
      hook("UserPromptSubmit", { prompt }, NOW + 2),
      hook("SubagentStop", { agent_id: "sub1", last_assistant_message: "A helper's report goes to its parent, not to any pane." }, NOW + 3),
    )) appendClaudeRecord(record, { dir });
    const reader = new ClaudeReader({ dir, ttlMs: 0, clock: () => NOW + 10_000 });
    const words = reader.recentWords(MAIN);
    assert.equal(words.length, 3);
    assert.ok(words.every((text) => !text.includes(FAKE)), "the words are the filtered records");
    assert.ok(!words.some((text) => /helper's report/.test(text)));
    assert.deepEqual(reader.recentWords(`${MAIN}:sub1`), [], "a subagent is never a pane");
    assert.deepEqual(reader.recentWords("claude-agent:unknown"), []);
    // The pane Orca reports with the same prompt, unfiltered, is this session; a pane with other words is not.
    const session = reader.snapshot().sessions[0].agents.find((agent) => agent.id === MAIN);
    const pane = { id: "orca-agent:p1", source: "orca", role: "claude · working", pane: "p1", cwd: "/work/billing-api" };
    const proof = (paneWords) => ({ paneMarks: () => paneWords.map(identityMark), sessionMarks: (agent) => reader.recentWords(agent.id).map(identityMark) });
    assert.deepEqual([...claudePanePairs([pane, session], proof([prompt]))], [[pane.id, MAIN]]);
    assert.equal(claudePanePairs([pane, session], proof(["Refactor the invoice mailer and its templates."])).size, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the reader says where each actor's transcript is, and rereads only new lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "goblin-claude-asks-"));
  try {
    const list = records(
      hook("SessionStart", { source: "startup" }, NOW),
      hook("SubagentStart", { agent_id: "sub2", agent_type: "Explore", agent_transcript_path: "/home/dev/t/agent-sub2.jsonl" }, NOW + 1),
      hook("SubagentStart", { agent_id: "sub3", agent_type: "Plan" }, NOW + 2),
    );
    for (const record of list) appendClaudeRecord(record, { dir });
    let clock = NOW + 10_000;
    const reader = new ClaudeReader({ dir, ttlMs: 0, clock: () => clock });
    assert.deepEqual(reader.transcriptFor(MAIN), { file: TRANSCRIPT, session: SESSION, agent: "", cwd: "/work/billing-api" });
    assert.equal(reader.transcriptFor(`${MAIN}:sub2`).file, "/home/dev/t/agent-sub2.jsonl");
    assert.equal(reader.transcriptFor(`${MAIN}:sub3`).file,
      "/home/dev/.claude/projects/-work-billing-api/c0ffee00-0000-4000-8000-00000000a5c1/subagents/agent-sub3.jsonl");
    assert.equal(reader.transcriptFor("claude-agent:../x"), null);
    assert.equal(reader.transcriptFor("claude-agent:unknown-session"), null);
    const first = reader.records[0];
    for (const record of records(hook("UserPromptSubmit", {}, NOW + 20))) appendClaudeRecord(record, { dir });
    clock += 1;
    reader.snapshot();
    assert.equal(reader.records.length, 4);
    assert.equal(reader.records[0], first, "a record already filtered is reused, not filtered again");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
