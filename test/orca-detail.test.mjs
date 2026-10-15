/**
 * Orca's "waiting": a real prompt on screen needs the person; an agent asking its coordinator is
 * at work; an agent idle at its prompt is quiet. Everything runs on a fake Orca CLI; nothing here
 * calls the real Orca or sends or switches anything.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  OrcaReader, detectTerminalPrompt, orcaAskInCommand, orcaInteractiveAsk, orcaNow, pendingCoordinatorQuestion, taskProgress,
} from "../lib/orca.mjs";
import { classifyOrca } from "../lib/feed.mjs";
import { identityMark } from "../lib/links.mjs";

const CLAUDE_PERMISSION = [
  "● I'll run the tests now.",
  "",
  "╭──────────────────────────────────────────────────────────────╮",
  "│ Bash command                                                 │",
  "│                                                              │",
  "│   npm test                                                   │",
  "│   Run the project tests                                      │",
  "│                                                              │",
  "│ Do you want to proceed?                                      │",
  "│ ❯ 1. Yes                                                     │",
  "│   2. Yes, and don't ask again for npm test commands          │",
  "│   3. No, and tell Claude what to do differently (esc)        │",
  "╰──────────────────────────────────────────────────────────────╯",
];

const CLAUDE_QUESTION = [
  "● Two options here.",
  "",
  " ☐ Database ",
  "",
  "Which database should we use?",
  "",
  "❯ 1. Postgres",
  "     Relational and mature",
  "  2. SQLite",
  "     Embedded, one file",
  "  3. Type something.",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
];

const CODEX_APPROVAL = [
  "• Running the tests before the change.",
  "",
  "  Would you like to run the following command?",
  "",
  "  Reason: check the exporter",
  "",
  "  $ npm test",
  "",
  "› 1. Yes, proceed (y)",
  "  2. Yes, and don't ask again for this command (a)",
  "  3. No, and tell Codex what to do differently (esc)",
  "",
  "  Press enter to confirm or esc to cancel",
];

const IDLE_AFTER_ANSWER = [
  "● Done. Summary:",
  "  1. Fixed the header row",
  "  2. Added a test",
  "  3. Updated the docs",
  "  Do you want me to open a pull request?",
  "",
  "╭──────────────────────────────────────────╮",
  "│ >                                        │",
  "╰──────────────────────────────────────────╯",
  "  ? for shortcuts",
];

test("real prompts are recognised on screen: Claude permission and question menus, Codex approvals, y/n", () => {
  assert.deepEqual(detectTerminalPrompt(CLAUDE_PERMISSION), {
    kind: "permission", text: "Do you want to proceed?", command: "npm test\nRun the project tests", tool: "Bash",
    options: ["Yes", "Yes, and don't ask again for npm test commands", "No, and tell Claude what to do differently"],
  });
  assert.deepEqual(detectTerminalPrompt(CLAUDE_QUESTION), { kind: "question", text: "Which database should we use?", options: ["Postgres", "SQLite", "Type something."] });
  assert.deepEqual(detectTerminalPrompt(CODEX_APPROVAL), {
    kind: "permission", text: "Would you like to run the following command?", command: "npm test",
    options: ["Yes, proceed", "Yes, and don't ask again for this command", "No, and tell Codex what to do differently"],
  });
  assert.deepEqual(detectTerminalPrompt(["Copying files", "Overwrite settings.json? (y/n)"]), { kind: "permission", text: "Overwrite settings.json?", options: ["Yes", "No"] });
});

test("an agent idle at its prompt is not a prompt, whatever its last answer said", () => {
  assert.equal(detectTerminalPrompt(IDLE_AFTER_ANSWER), null);
  assert.equal(detectTerminalPrompt([...CLAUDE_PERMISSION, ...Array.from({ length: 12 }, (_, index) => `output line ${index}`)]), null, "an old menu scrolled up is history");
  assert.equal(detectTerminalPrompt(["Would you like to continue with the migration?"]), null);
  assert.equal(detectTerminalPrompt([]), null);
  assert.equal(detectTerminalPrompt(null), null);
});

test("structured questions, coordinator asks, and running steps are read from Orca's own fields", () => {
  const ask = orcaInteractiveAsk(JSON.stringify({ questions: [
    { question: "Which region?", header: "Region", options: [{ label: "eu-west" }, { label: "us-east" }], multiSelect: false },
    { question: "Keep backups?", options: [{ label: "Yes" }, { label: "No" }] }] }));
  assert.deepEqual(ask, { kind: "question", text: "Which region?", tool: "AskUserQuestion",
    questions: [{ text: "Which region?", options: ["eu-west", "us-east"] }, { text: "Keep backups?", options: ["Yes", "No"] }], options: ["eu-west", "us-east"] });
  assert.equal(orcaInteractiveAsk("{not json"), null);
  assert.equal(orcaInteractiveAsk(JSON.stringify({ questions: [] })), null);
  assert.deepEqual(orcaAskInCommand("Bash", "orca orchestration ask --question \"Which schema?\" --json"), { who: "coordinator", text: "Which schema?" });
  assert.equal(orcaAskInCommand("Bash", "orca terminal read --json"), null);
  assert.equal(orcaAskInCommand("Read", "orca orchestration ask"), null);
  assert.deepEqual(orcaNow({ state: "working", toolName: "Bash", toolInput: "npm test", updatedAt: 5 }), { kind: "command", title: "Running npm test", detail: "npm test", startedAt: 5 });
  assert.deepEqual(orcaNow({ state: "working", updatedAt: 5 }), { kind: "think", title: "Thinking", startedAt: 5 });
  assert.equal(orcaNow({ state: "waiting", toolName: "Bash" }), null);
  assert.deepEqual(taskProgress([{ status: "completed" }, { status: "dispatched", task_title: "Fix header" }, { status: "pending" }]), { done: 1, total: 3, current: "Fix header" });
  assert.equal(taskProgress([]), null);
});

test("an unanswered question to the coordinator is found in the inbox; an answered one is not", () => {
  const messages = [
    { id: "r1", type: "status", from_handle: "run:run-1", to_handle: "term_a", thread_id: "q1", body: "Use v2", created_at: "2026-05-01T10:02:00Z" },
    { id: "q1", type: "question", from_handle: "term_a", to_handle: "run:run-1", thread_id: "q1", body: "Which API?", payload: "{\"question\":\"Which API?\"}", created_at: "2026-05-01T10:01:00Z" },
    { id: "q2", type: "question", from_handle: "term_a", to_handle: "run:run-1", thread_id: "q2", body: "Old body", payload: "{\"question\":\"Delete the old table?\"}", created_at: "2026-05-01T10:03:00Z" },
    { id: "q3", type: "question", from_handle: "dispatch:d9", to_handle: "run:run-1", thread_id: "q3", body: "Retry the flaky test?", created_at: "2026-05-01T10:04:00Z" },
    { id: "q4", type: "question", from_handle: "term_other", to_handle: "run:run-1", thread_id: "q4", body: "Not mine", created_at: "2026-05-01T10:05:00Z" },
  ];
  assert.deepEqual(pendingCoordinatorQuestion(messages, { terminal: "term_a" }), { who: "coordinator", text: "Delete the old table?", at: Date.parse("2026-05-01T10:03:00Z") });
  assert.equal(pendingCoordinatorQuestion(messages, { terminal: "term_b", dispatchIds: new Set(["d9"]) }).text, "Retry the flaky test?");
  assert.equal(pendingCoordinatorQuestion(messages.slice(0, 2), { terminal: "term_a" }), null);
  assert.equal(pendingCoordinatorQuestion([], { terminal: "term_a" }), null);
});

const NOW = 1_800_000_000_000;
const ok = (result) => ({ stdout: JSON.stringify({ ok: true, result }) });

/** A fake Orca CLI: agents and screens are plain data; every call is recorded. */
function fakeOrca({ agents, screens = {}, inbox = [], runs = [], tasks = {}, fail = () => false } = {}) {
  const calls = [];
  const state = { agents, screens, inbox, runs, tasks, sent: [], switched: [], refuse: false };
  const run = async (_command, args) => {
    const key = args.join(" ");
    calls.push(key);
    if (fail(key)) return { stdout: JSON.stringify({ ok: false, error: { code: "runtime_unavailable", message: "Could not connect" } }) };
    if (key === "worktree ps --json") return ok({ worktrees: [{ worktreeId: "repo::C:/work/billing-api", path: "C:/work/billing-api", repo: "billing-api", agents: state.agents }] });
    if (key === "terminal list --json") return ok({ terminals: state.agents.map((agent) => { const [tabId, leafId] = agent.paneKey.split(":"); return { tabId, leafId, handle: agent.handle, title: agent.title || "", orphaned: false }; }) });
    const read = /^terminal read --terminal=(\S+) --screen --json$/.exec(key);
    if (read) {
      if (state.screens[read[1]] === "hang") return new Promise(() => {});
      return ok({ terminal: { handle: read[1], status: "running", source: "screen", tail: state.screens[read[1]] || [] } });
    }
    if (key === "orchestration inbox --limit=200 --json") return ok({ messages: state.inbox, count: state.inbox.length });
    if (key === "orchestration run-list --limit=10 --json") return ok({ runs: state.runs, nextCursor: null });
    const list = /^orchestration task-list --run=(\S+) --json$/.exec(key);
    if (list) return ok({ runId: list[1], tasks: state.tasks[list[1]] || [], count: 0 });
    const send = /^terminal send --terminal=(\S+) --text=([\s\S]*) --enter --json$/.exec(key);
    if (send) {
      state.sent.push({ terminal: send[1], text: send[2] });
      return ok({ send: state.refuse ? { accepted: false, refusedReason: "terminal exited", handle: send[1] } : { accepted: true, handle: send[1], bytesWritten: 3 } });
    }
    const focus = /^terminal switch --terminal=(\S+) --json$/.exec(key);
    if (focus) { state.switched.push(focus[1]); return ok({ terminal: { handle: focus[1] } }); }
    throw Object.assign(new Error(`unexpected call: ${key}`), { code: 2 });
  };
  return { run, calls, state };
}

const agent = (pane, handle, fields) => ({ paneKey: pane, handle, agentType: "claude", updatedAt: NOW - 1000, ...fields });

function party() {
  return fakeOrca({
    agents: [
      agent("tab:a", "term_a", { state: "waiting", displayName: "Exporter" }),
      agent("tab:b", "term_b", { state: "waiting", displayName: "Importer" }),
      agent("tab:c", "term_c", { state: "waiting", displayName: "Docs", lastAssistantMessage: "All done." }),
      agent("tab:d", "term_d", { state: "working", toolName: "Bash", toolInput: "npm test", displayName: "Tester" }),
      agent("tab:e", "term_e", { state: "waiting", displayName: "Planner", toolName: "AskUserQuestion",
        interactivePrompt: JSON.stringify({ questions: [{ question: "Which region?", options: [{ label: "eu-west" }, { label: "us-east" }] }] }) }),
      agent("tab:f", "term_f", { state: "working", displayName: "Coordinator" }),
    ],
    screens: { term_a: CLAUDE_PERMISSION, term_b: IDLE_AFTER_ANSWER, term_c: IDLE_AFTER_ANSWER },
    inbox: [{ id: "q1", type: "question", from_handle: "term_b", to_handle: "run:run-1", thread_id: "q1", body: "Which importer format?", created_at: new Date(NOW - 2000).toISOString() }],
    runs: [{ id: "run-1", objective: "Ship CSV export", coordinator_handle: "term_f", created_at: new Date(NOW - 60_000).toISOString(), updated_at: new Date(NOW - 5000).toISOString() }],
    tasks: { "run-1": [
      { id: "task-1", status: "completed", task_title: "Read the exporter", spec: "Read lib/export.mjs", created_at: new Date(NOW - 50_000).toISOString() },
      { id: "task-2", status: "dispatched", task_title: "Fix the header row", spec: "Fix the CSV header row in lib/export.mjs and add a test.", assignee_handle: "term_a", dispatch_id: "d1", created_at: new Date(NOW - 40_000).toISOString() },
      { id: "task-3", status: "pending", task_title: "Update the docs", spec: "Document the export", created_at: new Date(NOW - 30_000).toISOString() }] },
  });
}

const byName = (snapshot) => Object.fromEntries(snapshot.workspaces[0].agents.map((item) => [item.nickname, item]));

test("only a real prompt makes a waiting Orca agent need the person", async () => {
  const fake = party();
  const reader = new OrcaReader({ run: fake.run, ttlMs: 0, clock: () => NOW });
  const agents = byName(await reader.snapshot());
  const { Exporter, Importer, Docs, Tester, Planner, Coordinator } = agents;
  assert.equal(Exporter.status, "waiting");
  assert.equal(Exporter.needsInput, true);
  assert.equal(Exporter.ask.kind, "permission");
  assert.equal(Exporter.ask.command, "npm test\nRun the project tests");
  assert.equal(Exporter.ask.answerHere, "orca-send");
  assert.equal(Exporter.ask.at, NOW - 1000);
  assert.match(Exporter.ask.key, /^[0-9a-f]{16}$/);
  assert.equal(classifyOrca(Exporter, { now: NOW }), "needs");
  assert.equal(Importer.ask, null);
  assert.deepEqual(Importer.waitingOn, { who: "coordinator", text: "Which importer format?", at: NOW - 2000 });
  assert.equal(Importer.status, "working");
  assert.equal(Importer.role, "claude · asked the coordinator");
  assert.equal(classifyOrca(Importer, { now: NOW }), "working");
  assert.equal(Docs.ask, null);
  assert.equal(Docs.waitingOn, null);
  assert.equal(Docs.status, "idle");
  assert.equal(Docs.needsInput, false);
  assert.equal(classifyOrca(Docs, { now: NOW }), "quiet");
  assert.deepEqual(Tester.now, { kind: "command", title: "Running npm test", detail: "npm test", startedAt: NOW - 1000 });
  assert.equal(Planner.ask.kind, "question");
  assert.deepEqual(Planner.ask.options, ["eu-west", "us-east"]);
  assert.ok(!fake.calls.includes("terminal read --terminal=term_e --screen --json"), "a structured question needs no screen read");
  assert.deepEqual(Coordinator.progress, { done: 1, total: 3, current: "Fix the header row" });
});

test("screens are read once per state change, a few at a time, and never hold the scene", async () => {
  let now = NOW;
  const many = fakeOrca({ agents: Array.from({ length: 5 }, (_, index) => agent(`tab:${index}`, `term_${index}`, { state: "waiting", displayName: `Worker ${index}` })),
    screens: Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`term_${index}`, IDLE_AFTER_ANSWER])) });
  const reader = new OrcaReader({ run: many.run, ttlMs: 0, clock: () => now, inboxTtlMs: 60_000 });
  const reads = () => many.calls.filter((call) => call.startsWith("terminal read")).length;
  await reader.snapshot();
  assert.equal(reads(), 3, "at most three screen reads per load");
  await reader.snapshot();
  assert.equal(reads(), 5, "the rest are read on the next load");
  await reader.snapshot();
  assert.equal(reads(), 5, "an unchanged waiting agent is not read again");
  assert.equal(many.calls.filter((call) => call.startsWith("orchestration inbox")).length, 1, "the inbox is read at most every few seconds");
  many.state.agents[0] = { ...many.state.agents[0], updatedAt: NOW + 5000 };
  now += 1000;
  await reader.snapshot();
  assert.equal(reads(), 6, "a state change is looked at again");

  const stuck = fakeOrca({ agents: [agent("tab:s", "term_s", { state: "waiting", displayName: "Stuck" })], screens: { term_s: "hang" } });
  const slow = new OrcaReader({ run: stuck.run, ttlMs: 0, clock: () => NOW, inspectTimeoutMs: 30 });
  const started = Date.now();
  const snapshot = await slow.snapshot();
  assert.ok(Date.now() - started < 2000);
  assert.equal(snapshot.workspaces[0].agents[0].ask, null, "no prompt is claimed for a screen that could not be read in time");
  assert.equal(snapshot.workspaces[0].agents[0].status, "idle");
  await slow.snapshot();
  assert.equal(stuck.calls.filter((call) => call.startsWith("terminal read")).length, 1, "a read still running is not started again");
});

test("a prompt answered in the terminal stops asking although Orca still says waiting", async () => {
  let now = NOW;
  const fake = fakeOrca({ agents: [agent("tab:a", "term_a", { state: "waiting", displayName: "Exporter", toolName: "Bash", toolInput: "npm test" }),
    agent("tab:c", "term_c", { state: "waiting", displayName: "Docs" })],
  screens: { term_a: CLAUDE_PERMISSION, term_c: IDLE_AFTER_ANSWER } });
  const reader = new OrcaReader({ run: fake.run, ttlMs: 0, clock: () => now, inboxTtlMs: 60_000, tasksTtlMs: 60 * 60_000 });
  const reads = (terminal) => fake.calls.filter((call) => call === `terminal read --terminal=${terminal} --screen --json`).length;
  assert.equal(byName(await reader.snapshot()).Exporter.ask.kind, "permission");
  // Approved: the menu is gone, the tool runs, and Orca keeps "waiting" (same updatedAt) until its next event.
  fake.state.screens.term_a = ["● I'll run the tests now.", "", "  ⎿  Running…"];
  now += 2000;
  assert.equal(byName(await reader.snapshot()).Exporter.ask.kind, "permission", "not reread within a few seconds");
  now += 4000;
  const answered = byName(await reader.snapshot()).Exporter;
  assert.equal(answered.ask, null);
  assert.equal(answered.needsInput, false);
  assert.equal(classifyOrca(answered, { now }), "working");
  assert.equal(answered.now.title, "Running npm test", "the approved step is what it is doing");
  assert.equal(reads("term_a"), 2);
  // Nothing on screen is not reread, and an idle agent never is.
  now += 60_000;
  await reader.snapshot();
  assert.equal(reads("term_a"), 2);
  assert.equal(reads("term_c"), 1);
  assert.equal(byName(await reader.snapshot()).Docs.status, "idle");
});

test("Orca's approval record is a permission ask until the screen shows the menu is gone", async () => {
  assert.deepEqual(orcaInteractiveAsk(JSON.stringify({ approval: { tool: "Bash", summary: "npm run deploy -- --env staging" } })),
    { kind: "permission", text: "Allow Bash to run this command?", command: "npm run deploy -- --env staging", tool: "Bash" });
  assert.equal(orcaInteractiveAsk(JSON.stringify({ approval: { tool: "Read", summary: "C:\\work\\billing-api\\notes.md" } })).text, "Allow Read to open notes.md?");
  assert.equal(orcaInteractiveAsk(JSON.stringify({ approval: { summary: "x" } })), null);
  let now = NOW;
  const approval = JSON.stringify({ approval: { tool: "Bash", summary: "npm test" } });
  const fake = fakeOrca({ agents: [agent("tab:a", "term_a", { state: "waiting", displayName: "Exporter", interactivePrompt: approval, toolName: "Bash", toolInput: "npm test" })],
    screens: { term_a: ["● Starting."] } });
  const reader = new OrcaReader({ run: fake.run, ttlMs: 0, clock: () => now, inboxTtlMs: 60_000, tasksTtlMs: 60 * 60_000 });
  // Read a moment after the request: the dialog may not be drawn yet, so the record stands.
  const early = byName(await reader.snapshot()).Exporter;
  assert.equal(early.ask.kind, "permission");
  assert.equal(early.ask.text, "Allow Bash to run this command?");
  assert.equal(early.ask.command, "npm test");
  fake.state.screens.term_a = CLAUDE_PERMISSION;
  now += 6000;
  const shown = byName(await reader.snapshot()).Exporter;
  assert.equal(shown.ask.key, early.ask.key, "the screen adds options, not a new ask");
  assert.deepEqual(shown.ask.options, ["Yes", "Yes, and don't ask again for npm test commands", "No, and tell Claude what to do differently"]);
  fake.state.screens.term_a = ["  ⎿  Running…"];
  now += 6000;
  assert.equal(byName(await reader.snapshot()).Exporter.ask, null);
});

test("text typed into a terminal is one plain line, and a token wrapped across screen rows is still removed", async () => {
  const fake = party();
  const reader = new OrcaReader({ run: fake.run, ttlMs: 0, clock: () => NOW });
  await reader.send("term_a", "first\u0007 \u001b[31mred\u001b[0m\u0085next\u2028line\u2029end\tok");
  const [{ text }] = fake.state.sent;
  assert.doesNotMatch(text, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
  assert.match(text, /^first\s+\[31mred \[0m next line end ok$/);
  const token = ["ghp", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab"].join("_");
  fake.state.screens.term_a = ["$ git push", `Pushing with the saved key ${token.slice(0, 14)}`, `${token.slice(14)} and done`, "ok"];
  const screen = await reader.screen("term_a");
  assert.ok(screen.lines.every((line) => !line.includes("ABCDEFGHIJ") && !line.includes("KLMNOPQRST")), screen.lines.join("\n"));
  assert.ok(screen.lines.join("").includes("[secret removed]"));
  assert.equal(screen.lines[0], "$ git push");
  assert.equal(screen.lines.at(-1), "ok");
});

test("a pane's newest prompt and reply are kept only as marks, to prove which Claude Code session it is", async () => {
  const prompt = "Ship the CSV export for billing-api and add a test for the header row.";
  const fake = fakeOrca({ agents: [agent("tab:a", "term_a", { state: "working", displayName: "Exporter", prompt, lastAssistantMessage: "ok" })] });
  const reader = new OrcaReader({ run: fake.run, ttlMs: 0, clock: () => NOW });
  const [pane] = (await reader.snapshot()).workspaces[0].agents;
  assert.deepEqual(reader.marksFor(pane.id), [identityMark(prompt)], "a reply too short to tell agents apart is no mark");
  assert.equal("prompt" in pane, false, "the prompt itself stays off the actor");
  assert.deepEqual(reader.marksFor("orca-agent:tab:gone"), []);
});

test("Orca refusing the orchestration calls leaves agents quiet, not alarming", async () => {
  const fake = fakeOrca({ agents: [agent("tab:a", "term_a", { state: "waiting", displayName: "Exporter" })], fail: (key) => !key.startsWith("worktree") && !key.startsWith("terminal list") });
  const reader = new OrcaReader({ run: fake.run, ttlMs: 0, clock: () => NOW });
  const [only] = (await reader.snapshot()).workspaces[0].agents;
  assert.equal(only.ask, null);
  assert.equal(only.waitingOn, null);
  assert.equal(classifyOrca(only, { now: NOW }), "quiet");
});

test("an Orca agent's detail has its screen, its task from the coordinator, and its steps", async () => {
  const fake = party();
  fake.state.screens.term_a = [...Array.from({ length: 60 }, (_, index) => `line ${index}`), "password=hunter2secret", "", ""];
  const reader = new OrcaReader({ run: fake.run, ttlMs: 0, clock: () => NOW });
  await reader.snapshot();
  const detail = await reader.detail("orca-agent:tab:a");
  assert.equal(detail.screen.lines.length, 40);
  assert.equal(detail.screen.lines.at(-1), "password=[secret removed]");
  assert.deepEqual(detail.mission, { text: "Fix the header row\n\nFix the CSV header row in lib/export.mjs and add a test.", from: "coordinator", at: NOW - 40_000 });
  const coordinator = await reader.detail("orca-agent:tab:f");
  assert.equal(coordinator.plan.source, "orca-tasks");
  assert.deepEqual(coordinator.plan.steps.map((step) => step.status), ["done", "active", "pending"]);
  const tester = await reader.detail("orca-agent:tab:d");
  assert.equal(tester.trail[0].kind, "command");
  assert.equal(tester.trail[0].title, "npm test");
  assert.equal(tester.now.kind, "command");
  const docs = await reader.detail("orca-agent:tab:c");
  assert.equal(docs.said.text, "All done.");
  assert.equal(await reader.detail("orca-agent:tab:zzz"), null);
  assert.equal(await reader.detail("not-an-id"), null);
});

test("open switches to the agent's terminal; message types one line and presses Enter", async () => {
  const fake = party();
  const reader = new OrcaReader({ run: fake.run, ttlMs: 0, clock: () => NOW });
  await reader.switchTo("term_a");
  assert.deepEqual(fake.state.switched, ["term_a"]);
  await reader.send("term_a", "--help\nthen continue");
  assert.deepEqual(fake.state.sent, [{ terminal: "term_a", text: "--help then continue" }]);
  assert.ok(fake.calls.includes("terminal send --terminal=term_a --text=--help then continue --enter --json"), "the text travels as --text=… so it is never read as a flag");
  fake.state.refuse = true;
  await assert.rejects(reader.send("term_a", "hello"), (error) => error.statusCode === 409 && /terminal exited/.test(error.message));
  await assert.rejects(reader.send("term_a", "  "), (error) => error.statusCode === 400);
  await assert.rejects(reader.switchTo("--json"), (error) => error.statusCode === 409);
  await assert.rejects(reader.send("C:\\x", "hi"), (error) => error.statusCode === 409);
  const notRunning = new OrcaReader({ run: async () => ({ stdout: JSON.stringify({ ok: false, error: { code: "runtime_unavailable" } }) }) });
  await assert.rejects(notRunning.switchTo("term_a"), /Orca is not running/);
});
