import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { briefFacts, commandEvidence, isDispatchBrief, withoutPastedWrappers, wordsMark } from "../lib/orca-commands.mjs";
import { TaskMemory, buildTasks, claudeOwnHandles, emptyEvidence, mergeEvidence, orchestrationIndex } from "../lib/tasks.mjs";
import { TaskService } from "../lib/task-service.mjs";
import { OrcaReader } from "../lib/orca.mjs";
import { normalizeHookEvent, promptTitle, sessionTitle } from "../lib/claude.mjs";
import { firstPrompt, transcriptStart } from "../lib/claude-detail.mjs";
import { claudeEntries } from "../lib/transcript.mjs";

// Synthetic ids in the shapes Orca uses (term_<uuid>, run_…, task_…).
const term = (n) => `term_${String(n).padStart(8, "0")}-aaaa-4bbb-8ccc-${String(n).padStart(12, "0")}`;
const RUN = "run_Ab12Cd34Ef56";
const RUN_OLD = "run_Zz98Yy76Xx54";
const task = (n) => `task_Qw${String(n).padStart(6, "0")}Er`;
const LEAD = "chat-lead-orca-0001";
const FORK = "chat-fork-orca-0002";
const NOW = 1_800_000_000_000;
const MIN = 60_000;

const json = (value) => `${JSON.stringify({ id: "local", ok: true, result: value }, null, 2)}\n`;
const runCreate = (run, coordinator) => ["orca orchestration run-create --worktree current --agent claude --model opus --objective \"Ship the invoice export\" --json",
  json({ run: { id: run, objective: "Ship the invoice export", coordinator_handle: coordinator, consumer_generation: 1, created_at: "2026-10-15T10:00:00Z" } })];
const workerStart = (run, taskId, handle) => [`orca orchestration worker-start --run ${run} --worktree new-child --agent claude --spec "Add the CSV writer" --json`,
  json({ dispatchId: "dsp_0123456789ab", runId: run, taskId, ...(handle ? { send: { handle } } : {}) })];

/**
 * A worker's dispatch brief as Orca types it, wrapped as Claude Code shows a paste. Its task's lines come in
 * the shapes real briefs use: who (Role), where (Target), what (Change, Task, Objective, …), how (Constraints).
 */
function brief({ taskId, own, coordinator, title = "Add the CSV writer to the invoice export (#42)", body }) {
  return ["Please carry out this task from my Orca coordinator by following the brief I pasted below.",
    "<pasted_content id=\"pc_0001\">You are working inside Orca, a multi-agent IDE.",
    `Your task ID is: ${taskId}`,
    `When you finish, run: orca orchestration send --from ${own} --type worker_done --subject "done"`,
    `If you need to ask, run: orca orchestration ask --from ${own} --question "..."`,
    `Your coordinator's terminal handle is: ${coordinator}`,
    "=== TASK ===",
    ...(body || ["Role: Engineer and implementation owner for the export", "Target: lib/export/csv.mjs", `Change: ${title}`,
      "Constraints: keep the existing tests green; no new dependencies."]),
    "</pasted_content>"].join("\n");
}
/** What a brief whose task holds these lines says the work is. */
const work = (lines) => {
  const { title, sentence } = briefFacts(brief({ taskId: task(1), own: term(2), coordinator: term(1), body: lines }));
  return { title, sentence };
};

test("Orca's command outputs prove which runs, tasks, and terminals a chat created; lists of everyone's prove nothing", () => {
  const [command, output] = runCreate(RUN, term(1));
  assert.deepEqual(commandEvidence(command, output).runs, [{ id: RUN, coordinator: term(1), objective: "Ship the invoice export" }]);
  const started = commandEvidence(...workerStart(RUN, task(1), term(2)));
  assert.deepEqual(started.tasks, [{ id: task(1), run: RUN, dispatch: "dsp_0123456789ab", terminal: term(2) }]);
  assert.deepEqual(started.terminals, [term(2)]);
  assert.ok(started.runs.some((run) => run.id === RUN), "the run the worker joined is one the chat uses");
  const dispatched = commandEvidence(`orca orchestration dispatch --task ${task(3)} --to ${term(3)} --json`,
    json({ dispatch: { id: "dsp_aaaaaaaaaaaa", task_id: task(3), run_id: RUN, assignee_handle: term(3), creator_handle: term(1) } }));
  assert.deepEqual(dispatched.tasks, [{ id: task(3), run: RUN, dispatch: "dsp_aaaaaaaaaaaa", terminal: term(3) }], "the worker's terminal, never the creator's");
  assert.deepEqual(commandEvidence("orca terminal create --worktree current --command claude --json", json({ terminal: { handle: term(4), paneKey: "tab-1:leaf-1" } })).terminals, [term(4)]);
  const screen = commandEvidence(`orca terminal read --terminal ${term(2)} --screen`, "Claude Code  session 0d1e2f3a-1111-4222-8333-444455556666\n> working");
  assert.deepEqual(screen.screens, [{ terminal: term(2), ids: ["0d1e2f3a-1111-4222-8333-444455556666"] }]);
  const sent = commandEvidence(`orca terminal send --terminal ${term(2)} --text "Please also update the changelog for the export" --enter`, "");
  assert.deepEqual(sent.sent, [{ terminal: term(2), mark: wordsMark("Please also update the changelog for the export") }]);
  // Everyone's runs and workers, and a failed or odd output, prove nothing.
  assert.deepEqual(commandEvidence("orca orchestration run-list --limit=50 --json", json({ runs: [{ id: RUN, coordinator_handle: term(1) }] })).runs, []);
  assert.deepEqual(commandEvidence("orca orchestration worker-list --json", json({ workers: [{ taskId: task(1), agentTerminalHandle: term(2) }] })).tasks, []);
  assert.deepEqual(commandEvidence(runCreate(RUN, term(1))[0], "error: runtime_unavailable").runs, []);
  assert.deepEqual(commandEvidence("echo hello", "{}").runs, []);
});

test("a dispatch brief names its task, the worker's own terminal, its coordinator's, and its task line", () => {
  const text = brief({ taskId: task(1), own: term(2), coordinator: term(1) });
  assert.ok(isDispatchBrief(text));
  assert.deepEqual(briefFacts(text), { task: task(1), own: term(2), coordinator: term(1), title: "Add the CSV writer to the invoice export (#42)", sentence: "" });
  assert.equal(briefFacts(text.replace("=== TASK ===\n", "=== TASK ===\nTask: Fix the totals\n")).title, "Fix the totals", "a Task: line wins over Change:");
  assert.equal(briefFacts("Fix the flaky login test"), null);
  assert.doesNotMatch(withoutPastedWrappers(text), /pasted_content/);
  assert.match(withoutPastedWrappers(text), /You are working inside Orca/);
  // Named for its task, never for its boilerplate first line, wherever the session's name comes from.
  assert.equal(promptTitle(text), "Add the CSV writer to the invoice export (#42)");
  assert.equal(promptTitle(text.slice(0, 200)), "", "a hook excerpt that ends before the task names nothing");
  assert.equal(sessionTitle({ hook: "" }, { custom: "", brief: "Add the CSV writer", titled: "Csv writer session", first: "Add the CSV writer" }), "Add the CSV writer");
  assert.equal(sessionTitle({ hook: "" }, { custom: "my name", brief: "Add the CSV writer", titled: "x" }), "my name", "a name the person gave stands");
  const head = [JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-10-15T10:00:00Z", cwd: "/work/export-wt", message: { role: "user", content: text } })].join("\n");
  assert.deepEqual(firstPrompt(head).facts, { task: task(1), own: term(2), coordinator: term(1), title: "Add the CSV writer to the invoice export (#42)", sentence: "" });
  assert.deepEqual(transcriptStart(head).orca, { task: task(1), own: term(2), coordinator: term(1) });
  assert.equal(transcriptStart(head).brief, true);
  // The transcript shows the brief without Claude Code's paste wrapper, from the coordinator.
  const [entry] = claudeEntries([{ record: JSON.parse(head), offset: 0 }], {});
  assert.equal(entry.from, "coordinator");
  assert.doesNotMatch(entry.text, /<\/?pasted_content/);
});

test("a brief is named by the line that says what the work is, never by who, where, or how", () => {
  // Who, where, and how come first in real briefs; the work line may stand anywhere after them.
  assert.equal(work(["Role: Engineer and design owner for the settings page", "Target: docs/product-specs/settings.md", "Context: the old page is gone.",
    "Rules: no new files.", "Constraints: none", "Objective: Write the settings page spec", "Observable acceptance: the spec lists every field."]).title,
  "Write the settings page spec");
  // The best label wins wherever it stands: Task, Title, Objective, Goal, Deliverable, Change.
  assert.equal(work(["Change: Rename the export module", "Deliverable: A pull request", "Task: Split the export into reader and writer"]).title,
    "Split the export into reader and writer");
  assert.equal(work(["Ownership: lib/export only", "Deliverable: A benchmark note", "Goal: Faster exports"]).title, "Faster exports");
  // Markdown, bullets, capitals, and a label on a line of its own.
  assert.equal(work(["**Role:** Reviewer", "**Task:** Review the `csv` writer"]).title, "Review the csv writer");
  assert.equal(work(["- Role: Reviewer", "- Deliverable: A review of the export"]).title, "A review of the export");
  assert.equal(work(["ROLE: Engineer", "TARGET: lib/export", "OBJECTIVE: Ship the nightly export"]).title, "Ship the nightly export");
  assert.equal(work(["Role: Engineer", "Task:", "Move the totals into the footer.", "Target: lib/export"]).title, "Move the totals into the footer.");
  // Its first sentence only, so the name stays short.
  assert.equal(work(["Task: Fix the totals. Then update the snapshot tests and the changelog."]).title, "Fix the totals.");
  // Who, where, and how only: no work line; the task's first sentence that is not a role statement or a
  // lead-in is the last resort, and a role statement only when nothing else is there.
  assert.deepEqual(work(["Role: Engineer and implementation owner", "Target: marigold-shop/export", "Constraints: no new dependencies",
    "You are the engineer for the export.", "Wire the CSV writer into the nightly export. Then run the tests."]),
  { title: "", sentence: "Wire the CSV writer into the nightly export." });
  assert.deepEqual(work(["Role: Engineer", "Please make these changes to the export:", "## Wire the CSV writer"]), { title: "", sentence: "Wire the CSV writer" });
  assert.deepEqual(work(["You are the engineer for the export."]), { title: "", sentence: "You are the engineer for the export." });
  // A session is never named for a who or where line.
  const text = brief({ taskId: task(1), own: term(2), coordinator: term(1), body: ["Role: Engineer and implementation owner", "Target: docs/product-specs/settings.md"] });
  assert.equal(promptTitle(text), "");
  const head = JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-10-15T10:00:00Z", cwd: "/work/export-wt", message: { role: "user", content: text } });
  assert.deepEqual([transcriptStart(head).first, transcriptStart(head).sentence], ["", undefined]);
  const plain = brief({ taskId: task(1), own: term(2), coordinator: term(1), body: ["Role: Engineer", "Wire the CSV writer into the nightly export."] });
  const start = transcriptStart(JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-10-15T10:00:00Z", message: { role: "user", content: plain } }));
  assert.deepEqual([start.first, start.sentence], ["", "Wire the CSV writer into the nightly export"]);
});

/** Synthetic sessions: worker transcripts with briefs, as ClaudeSessionIndex lists them. */
function worker(n, { taskId = task(n), coordinator = term(1), own = term(10 + n), updatedAt = NOW - n * MIN } = {}) {
  const facts = briefFacts(brief({ taskId, own, coordinator, title: `Worker task ${n}: export step ${n}` }));
  return { session: `work-${n}`, agent: "", updatedAt, startedAt: updatedAt - 30 * MIN, cwd: "/work/export-wt", name: facts.title, brief: facts.title,
    orca: { task: facts.task, own: facts.own, coordinator: facts.coordinator } };
}

function evidenceOf(byChat) {
  const chats = new Map();
  for (const [chat, commands] of Object.entries(byChat)) {
    const evidence = emptyEvidence();
    for (const [command, output, at] of commands) mergeEvidence(evidence, commandEvidence(command, output), at);
    chats.set(chat, evidence);
  }
  return chats;
}

const chatList = [{ id: LEAD, name: "Ship the invoice export", updatedAt: NOW - 2 * MIN, status: "notLoaded" },
  { id: FORK, name: "Ship the invoice export (fork)", updatedAt: NOW - 90 * MIN, status: "notLoaded" }];

test("with Orca's command line unreachable and no hook ids, the chat that started the work leads its workers", () => {
  const chats = evidenceOf({ [LEAD]: [[...runCreate(RUN, term(1)), NOW - 60 * MIN], [...workerStart(RUN, task(1)), NOW - 59 * MIN], [...workerStart(RUN, task(2)), NOW - 58 * MIN]] });
  const { tasks } = buildTasks({ now: NOW, since: NOW - 24 * 60 * MIN, codex: { chats: chatList },
    claude: { transcripts: [worker(1), worker(2), worker(3, { taskId: task(3) })] }, evidence: { chats } });
  const lead = tasks.find((item) => item.id === LEAD);
  // Workers in the order they started; a worker whose task the chat never listed still has the chat's coordinator terminal.
  assert.deepEqual(lead.agents.map((agent) => [agent.id, agent.role]), [[LEAD, "lead"], ["claude-agent:work-3", "worker"], ["claude-agent:work-2", "worker"],
    ["claude-agent:work-1", "worker"]]);
  assert.deepEqual(lead.links.map((item) => [item.to, item.kind, item.run || ""]), [["claude-agent:work-3", "dispatched", ""], ["claude-agent:work-2", "dispatched", RUN],
    ["claude-agent:work-1", "dispatched", RUN]]);
  const one = lead.agents.find((agent) => agent.id === "claude-agent:work-1");
  assert.equal(one.name, "Worker task 1: export step 1", "named for its brief's task line");
  assert.deepEqual(one.orca, { terminal: term(11), task: task(1), run: RUN, coordinator: term(1) });
});

test("an Orca worker goes by its brief's work line, else its run's objective, else Claude Code's title, else its brief's first sentence", () => {
  const RUN_B = "run_Mn34Op56Qr78", RUN_C = "run_St90Uv12Wx34", RUN_D = "run_Gh56Ij78Kl90";
  const session = (n, { brief = "", ai = "", sentence = "", custom = "", coordinator = term(1) } = {}) => ({ session: `work-${n}`, agent: "", updatedAt: NOW - n * MIN,
    startedAt: NOW - 40 * MIN, cwd: "/work/export-wt", name: custom || brief || ai || sentence, ...(custom ? { custom } : {}), ...(brief ? { brief } : {}),
    ...(ai ? { ai } : {}), ...(sentence ? { sentence } : {}), orca: { task: task(n), own: term(10 + n), coordinator } });
  // The lead's chat created RUN (its objective said in run-create's output) and started six of its workers.
  const chats = evidenceOf({ [LEAD]: [[...runCreate(RUN, term(1)), NOW - 60 * MIN],
    ...[1, 2, 3, 8, 9, 10].map((n) => [...workerStart(RUN, task(n)), NOW - (50 - n) * MIN])] });
  // Orca's lists, remembered: one run with a lone worker, one with no objective, one whose two workers share every name.
  const runs = new Map([[RUN_B, { coordinator: term(7), objective: "Fix the nightly build" }], [RUN_C, { coordinator: term(8) }],
    [RUN_D, { coordinator: term(9), objective: "Tidy the docs" }]]);
  const workers = new Map([[task(6), { run: RUN_B, handle: term(16) }], [task(7), { run: RUN_C, handle: term(17) }],
    [task(11), { run: RUN_D, handle: term(21) }], [task(12), { run: RUN_D, handle: term(22) }]]);
  const transcripts = [
    session(1, { brief: "Add the CSV writer", ai: "Csv writer", sentence: "Add the writer" }),
    // RUN's objective would name all four of these alike: each goes by its own title instead.
    session(2, { ai: "Csv writer tests", sentence: "Write the CSV tests" }),
    session(3, { ai: "Totals footer", sentence: "Move the totals" }),
    // Claude Code titled these two alike: their briefs' first sentences tell them apart.
    session(8, { ai: "Orca worker task", sentence: "Check the header row" }),
    session(9, { ai: "Orca worker task", sentence: "Check the footer row" }),
    session(10, { custom: "my export helper", brief: "Add the CSV reader" }),
    session(6, { ai: "Nightly build fix", sentence: "Fix it", coordinator: term(7) }),
    session(7, { sentence: "Rebuild the cache", coordinator: term(8) }),
    session(11, { ai: "Docs pass", coordinator: term(9) }),
    session(12, { ai: "Docs pass", coordinator: term(9) }),
  ];
  const { tasks } = buildTasks({ now: NOW, since: NOW - 24 * 60 * MIN, codex: { chats: chatList }, claude: { transcripts }, evidence: { chats, runs, workers } });
  const names = Object.fromEntries(tasks.flatMap((item) => item.agents).filter((agent) => agent.id.startsWith("claude-agent:work-"))
    .map((agent) => [agent.id.slice("claude-agent:work-".length), agent.name]));
  assert.deepEqual(names, {
    1: "Add the CSV writer", 2: "Csv writer tests", 3: "Totals footer", 8: "Check the header row", 9: "Check the footer row",
    10: "my export helper", 6: "Fix the nightly build", 7: "Rebuild the cache", 11: "Tidy the docs", 12: "Tidy the docs",
  });
});

test("workers and coordinators quiet for over an hour are stale like subagents; the agent a task stands under never is", () => {
  const chats = evidenceOf({ [LEAD]: [[...runCreate(RUN, term(1)), NOW - 5 * 60 * MIN], [...workerStart(RUN, task(1)), NOW - 4 * 60 * MIN],
    [...workerStart(RUN, task(2)), NOW - 4 * 60 * MIN], [...workerStart(RUN, task(3)), NOW - 4 * 60 * MIN]] });
  // The lead's chat itself has been quiet for four hours.
  const quietChats = [{ id: LEAD, name: "Ship the invoice export", updatedAt: NOW - 4 * 60 * MIN, status: "notLoaded" }];
  const coordinator = { session: "coord-1", agent: "", updatedAt: NOW - 2 * 60 * MIN, startedAt: NOW - 5 * 60 * MIN, cwd: "/work/export", name: "Coordinate the export" };
  const records = [normalizeHookEvent({ hook_event_name: "PreToolUse", session_id: "coord-1", tool_name: "Bash", tool_use_id: "toolu_1",
    tool_input: { command: `orca orchestration dispatch --task ${task(1)} --to ${term(11)} --from ${term(1)}` } }, { now: NOW - 4 * 60 * MIN, id: "c0c0c0c0c0c0" })];
  const solo = { session: "solo-1", agent: "", updatedAt: NOW - 6 * 60 * MIN, cwd: "/work/notes", name: "Tidy the notes" };
  // A run no chat here started, its coordinator not on this computer: the run stands in at the top.
  const runs = new Map([[RUN_OLD, { coordinator: term(7), objective: "Fix the nightly build" }]]);
  const workers = new Map([[task(6), { run: RUN_OLD, handle: term(16) }]]);
  const { tasks } = buildTasks({ now: NOW, since: NOW - 24 * 60 * MIN, codex: { chats: quietChats },
    claude: { transcripts: [coordinator, worker(1, { updatedAt: NOW - 2 * 60 * MIN }), worker(2, { updatedAt: NOW - 30 * MIN }), worker(3, { updatedAt: NOW - 20_000 }),
      worker(6, { taskId: task(6), coordinator: term(7), updatedAt: NOW - 3 * 60 * MIN }), solo], handles: claudeOwnHandles(records) }, evidence: { chats, runs, workers } });
  const stale = (taskId) => tasks.find((item) => item.id === taskId).agents.map((agent) => [agent.id, agent.role, agent.stale === true]);
  assert.deepEqual(stale(LEAD).sort(), [[LEAD, "lead", false], ["claude-agent:coord-1", "coordinator", true],
    ["claude-agent:work-1", "worker", true], ["claude-agent:work-2", "worker", false], ["claude-agent:work-3", "worker", false]].sort(),
  "quiet for two hours: stale; for half an hour, or at work: not; the lead, quiet for four hours: never");
  assert.deepEqual(stale(`orca-agent:run:${RUN_OLD}`).map(([, role, flag]) => [role, flag]), [["coordinator", false], ["worker", true]]);
  assert.deepEqual(stale("claude-agent:solo-1"), [["claude-agent:solo-1", "solo", false]]);
});

test("a session in the run's coordinator terminal is the coordinator, between the chat and its workers", () => {
  const chats = evidenceOf({ [LEAD]: [[...runCreate(RUN, term(1)), NOW - 60 * MIN], [...workerStart(RUN, task(1)), NOW - 59 * MIN]] });
  const coordinator = { session: "coord-1", agent: "", updatedAt: NOW - MIN, startedAt: NOW - 61 * MIN, cwd: "/work/export", name: "Coordinate the export" };
  // The coordinator says who it is with --from in its own Orca commands (the hook records them before filtering).
  const records = [normalizeHookEvent({ hook_event_name: "PreToolUse", session_id: "coord-1", tool_name: "Bash", tool_use_id: "toolu_1",
    tool_input: { command: `orca orchestration dispatch --task ${task(1)} --to ${term(11)} --from ${term(1)}` } }, { now: NOW - 59 * MIN, id: "c0c0c0c0c0c0" })];
  const { tasks } = buildTasks({ now: NOW, since: NOW - 24 * 60 * MIN, codex: { chats: chatList },
    claude: { transcripts: [coordinator, worker(1)], handles: claudeOwnHandles(records) }, evidence: { chats } });
  const lead = tasks.find((item) => item.id === LEAD);
  assert.deepEqual(lead.agents.map((agent) => [agent.id, agent.role, agent.parentId || ""]), [[LEAD, "lead", ""],
    ["claude-agent:coord-1", "coordinator", LEAD], ["claude-agent:work-1", "worker", "claude-agent:coord-1"]]);
});

test("Orca's own run and worker lists, remembered, fill what the chats' commands do not say; a run with no known chat holds its workers", () => {
  const chats = evidenceOf({ [LEAD]: [[...runCreate(RUN, term(1)), NOW - 60 * MIN]] });
  const runs = new Map([[RUN, { coordinator: term(1) }], [RUN_OLD, { coordinator: term(7), objective: "Fix the nightly build" }]]);
  const workers = new Map([[task(5), { run: RUN, handle: term(15) }], [task(6), { run: RUN_OLD, handle: term(16) }], [task(7), { run: RUN_OLD, handle: term(17) }]]);
  // Worker 5's brief names no coordinator: Orca's worker list puts its task in the chat's run.
  const five = { ...worker(5), orca: { task: task(5), own: term(15) } };
  const { tasks } = buildTasks({ now: NOW, since: NOW - 24 * 60 * MIN, codex: { chats: chatList },
    claude: { transcripts: [five, worker(6, { taskId: task(6), coordinator: term(7) }), worker(7, { taskId: task(7), coordinator: term(7) })] }, evidence: { chats, runs, workers } });
  assert.ok(tasks.find((item) => item.id === LEAD).agents.some((agent) => agent.id === "claude-agent:work-5"));
  const run = tasks.find((item) => item.id === `orca-agent:run:${RUN_OLD}`);
  assert.equal(run.title, "Fix the nightly build");
  assert.deepEqual(run.agents.map((agent) => agent.role), ["coordinator", "worker", "worker"]);
});

test("among chats with the same proof (a fork copies its parent's history), the newest evidence wins", () => {
  const chats = evidenceOf({ [LEAD]: [[...workerStart(RUN, task(1)), NOW - 59 * MIN]], [FORK]: [[...workerStart(RUN, task(1)), NOW - 30 * MIN]] });
  const nodes = new Map(chatList.map((chat) => [chat.id, { updatedAt: chat.updatedAt }]));
  assert.equal(orchestrationIndex({ chats }, new Map(), nodes).chatFor({ task: task(1) }), FORK);
  // A stronger kind of proof beats a newer weaker one: the task the lead started over a terminal the fork addressed.
  const flagged = evidenceOf({ [LEAD]: [[...workerStart(RUN, task(1)), NOW - 59 * MIN]], [FORK]: [[`orca terminal send --terminal ${term(11)} --text "status?"`, "", NOW - MIN]] });
  assert.equal(orchestrationIndex({ chats: flagged }, new Map(), nodes).chatFor({ task: task(1), handle: term(11) }), LEAD);
});

test("an Orca agent whose brief names a session's task is that session, and old finished subagents are marked stale", () => {
  const orcaAgent = { id: "orca-agent:tab-9:leaf-9", source: "orca", name: "Claude agent", status: "done", pane: "tab-9:leaf-9", parentPane: "", terminal: "",
    updatedAt: NOW - 5 * MIN, orcaBrief: { task: task(1), own: term(11), coordinator: term(1) } };
  const chats = evidenceOf({ [LEAD]: [[...workerStart(RUN, task(1)), NOW - 59 * MIN]] });
  const lead = { session: "lead-claude", agent: "", updatedAt: NOW - MIN, cwd: "/work/site", name: "Refactor the site" };
  const oldHelper = { session: "lead-claude", agent: "old-1", updatedAt: NOW - 3 * 60 * MIN, agentType: "Explore", description: "Find the fixtures" };
  const newHelper = { session: "lead-claude", agent: "new-1", updatedAt: NOW - 10 * MIN, agentType: "Explore", description: "Find the styles" };
  const { tasks, aliases } = buildTasks({ now: NOW, since: NOW - 24 * 60 * MIN, codex: { chats: chatList },
    claude: { transcripts: [worker(1), lead, oldHelper, newHelper] }, orca: { agents: [orcaAgent] }, evidence: { chats } });
  assert.equal(aliases.get(orcaAgent.id), "claude-agent:work-1");
  assert.ok(!tasks.some((item) => item.id === orcaAgent.id), "not a task of its own");
  const site = tasks.find((item) => item.id === "claude-agent:lead-claude");
  const helpers = Object.fromEntries(site.agents.filter((agent) => agent.role === "subagent").map((agent) => [agent.id, agent.stale || false]));
  assert.deepEqual(helpers, { "claude-agent:lead-claude:old-1": true, "claude-agent:lead-claude:new-1": false });
});

/** A fake Codex app-server for thread/items/list, newest first, paged by position. */
function fakeItems(byChat) {
  const calls = [];
  const request = async (method, params) => {
    calls.push(params.threadId);
    const items = byChat[params.threadId] || [];
    const end = params.cursor ? Number(params.cursor.slice(4)) : items.length;
    const start = Math.max(0, end - params.limit);
    return { data: items.slice(start, end).reverse(), nextCursor: start > 0 ? `pos:${start}` : null };
  };
  return { request, calls };
}
const commandItem = (id, [command, output], at) => ({ turnId: "t1", item: { type: "commandExecution", id, command, aggregatedOutput: output, status: "completed", exitCode: 0 },
  startedAtMs: at, completedAtMs: at + 500 });

test("Codex chats are read in the background once back to the window's start, then only for new items, and remembered across a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "goblin-orca-runs-"));
  try {
    const items = { [LEAD]: [] };
    for (let index = 0; index < 450; index++) items[LEAD].push({ turnId: "t0", item: { type: "agentMessage", id: `m${index}`, text: "working" }, startedAtMs: NOW - 120 * MIN + index });
    items[LEAD].push(commandItem("c1", runCreate(RUN, term(1)), NOW - 60 * MIN), commandItem("c2", workerStart(RUN, task(1)), NOW - 59 * MIN));
    const fake = fakeItems(items);
    let clock = NOW;
    const memory = new TaskMemory({ dir, clock: () => clock });
    const chats = [{ id: LEAD, name: "Ship the invoice export", updatedAt: NOW - 59 * MIN }];
    const service = new TaskService({ clock: () => clock, waitMs: 50, scanPages: 10, memory,
      codex: { listThreads: async () => chats, request: fake.request, health: () => ({ state: "ok" }) },
      sessions: { list: () => [worker(1)] } });
    await service.tasks({ window: "24h" });
    await service.scanning;
    assert.equal(fake.calls.length, 3, "450 items read in three pages, down to the chat's start");
    assert.equal(memory.scans.get(LEAD).complete, true);
    clock += 2000;
    service.last = null;
    const grouped = await service.tasks({ window: "24h" });
    assert.deepEqual(grouped.tasks.find((item) => item.id === LEAD).agents.map((agent) => agent.role), ["lead", "worker"]);
    // A new command: only the newest page is read, down to what was read before.
    items[LEAD].push(commandItem("c3", workerStart(RUN, task(2)), NOW + MIN));
    chats[0].updatedAt = NOW + MIN;
    clock += 2000;
    service.last = null;
    await service.tasks({ window: "24h" });
    await service.scanning;
    assert.equal(fake.calls.length, 4);
    assert.ok(memory.chats.get(LEAD).tasks.has(task(2)));
    memory.save();
    // After a restart nothing is read again for a chat already read through, and the grouping holds.
    const again = fakeItems(items);
    const restarted = new TaskService({ clock: () => clock, waitMs: 50, memory: new TaskMemory({ dir, clock: () => clock }),
      codex: { listThreads: async () => chats, request: again.request, health: () => ({ state: "ok" }) }, sessions: { list: () => [worker(1), worker(2)] } });
    const back = await restarted.tasks({ window: "24h" });
    await restarted.scanning;
    assert.equal(again.calls.length, 0);
    assert.deepEqual(back.tasks.find((item) => item.id === LEAD).agents.map((agent) => agent.id).sort(), [LEAD, "claude-agent:work-1", "claude-agent:work-2"].sort());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a worker's transcript names who sent each prompt: the brief and words its lead typed come from the lead", () => {
  const memory = new TaskMemory({});
  memory.noteEvidence(LEAD, commandEvidence(`orca terminal send --terminal ${term(11)} --text "Please also update the changelog for the export" --enter`, ""), NOW);
  const service = new TaskService({ memory });
  const agent = { id: "claude-agent:work-1", parentId: LEAD, orca: { terminal: term(11) } };
  const taskShape = { agents: [{ id: LEAD, name: "Ship the invoice export" }, agent, { id: "claude-agent:work-1:helper-1", name: "Explore: Find the fixtures" }] };
  const entries = service.senders([
    { id: "p1", kind: "prompt", from: "coordinator", text: "Add the CSV writer" },
    { id: "p2", kind: "prompt", from: "you", text: "Please also update the changelog for the export", queued: true },
    { id: "p3", kind: "prompt", from: "you", text: "what about the totals?" },
    { id: "p4", kind: "prompt", from: "agent", text: "found them", fromAgent: "helper-1" },
    { id: "m1", kind: "message", text: "ok" },
  ], agent, taskShape);
  assert.deepEqual(entries.map((entry) => [entry.from || "", entry.fromId || "", entry.fromName || ""]), [
    ["coordinator", LEAD, "Ship the invoice export"],
    ["coordinator", LEAD, "Ship the invoice export"],
    ["you", "", ""],
    ["agent", "claude-agent:work-1:helper-1", "Explore: Find the fixtures"],
    ["", "", ""],
  ]);
  assert.ok(!("fromAgent" in entries[3]));
});

test("Orca's run and worker lists are read through the reader's own call, with every id checked", async () => {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ args, env: options?.env?.ORCA_USER_DATA_PATH || "" });
    if (args[0] === "worktree") return { stdout: JSON.stringify({ ok: true, result: { worktrees: [] } }) };
    if (args[0] === "terminal") return { stdout: JSON.stringify({ ok: true, result: { terminals: [{ handle: term(1), title: "✳ Export coordinator", tabId: "t", leafId: "l" }] } }) };
    if (args[1] === "run-list") return { stdout: JSON.stringify({ ok: true, result: { runs: [{ id: RUN, coordinator_handle: term(1), objective: "Ship the export", updated_at: "2026-10-15T10:00:00Z" }, { id: "bad id" }] } }) };
    if (args[1] === "worker-list") {
      const second = args.some((arg) => arg.startsWith("--cursor="));
      return { stdout: JSON.stringify({ ok: true, result: { workers: second ? [{ taskId: task(2), runId: RUN, agentTerminalHandle: "nope" }]
        : [{ taskId: task(1), runId: RUN, agentTerminalHandle: term(11), dispatchId: "dsp_0123456789ab", workerState: "succeeded" }], page: { hasMore: !second, nextCursor: "abc123" } } }) };
    }
    return { stdout: JSON.stringify({ ok: true, result: {} }) };
  };
  const reader = new OrcaReader({ run, userData: () => "C:\\Packages\\Codex\\LocalCache\\Roaming\\orca" });
  const snapshot = await reader.snapshot();
  assert.deepEqual(snapshot.terminals, [{ handle: term(1), title: "Export coordinator" }]);
  const facts = await reader.orchestration();
  assert.deepEqual(facts.runs, [{ id: RUN, coordinator: term(1), objective: "Ship the export", at: Date.parse("2026-10-15T10:00:00Z") }]);
  assert.deepEqual(facts.workers, [{ task: task(1), run: RUN, handle: term(11), dispatch: "dsp_0123456789ab", state: "succeeded" }, { task: task(2), run: RUN, state: "" }]);
  assert.ok(calls.filter((call) => call.args[0] === "orchestration").every((call) => call.env), "pointed at the running Orca's own runtime file");
});
