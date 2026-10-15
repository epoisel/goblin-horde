import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeFeed, CLAUDE_LIMITS, normalizeHookEvent } from "../lib/claude.mjs";
import { TASK_LIMITS, TaskMemory, buildTasks, claudeAddressing, claudeIdentities, parseWindow, taskStatus } from "../lib/tasks.mjs";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const term = (n) => `term_${String(n).padStart(8, "0")}-1111-4222-8333-444455556666`;
const CHAT = "chat-lead-0001";
const env = (n, worktree = "repo-1::C:/work/export-wt") => ({ ORCA_TERMINAL_HANDLE: term(n), ORCA_PANE_KEY: `tab-${n}:00000000-1111-4222-8333-44445555${String(n).padStart(4, "0")}`, ORCA_WORKTREE_ID: worktree });

let counter = 0;
/** Hook records for one session: [event, extra, minutes after NOW - 3h, env]. */
function hooks(session, steps) {
  return steps.map(([event, extra = {}, minute = 0, orcaEnv = null]) => normalizeHookEvent({ hook_event_name: event, session_id: session, cwd: "/work/export", ...extra },
    { now: NOW - 3 * HOUR + minute * MIN, id: (0x100000 + ++counter).toString(16).padStart(12, "0"), env: orcaEnv }));
}
const bash = (command, id) => ({ tool_name: "Bash", tool_use_id: id, tool_input: { command } });

/** A Codex lead driving an Orca coordinator with three workers, Orca's command line unreachable. */
function orchestra() {
  const records = [
    ...hooks("coord-1", [["SessionStart", { source: "startup" }, 0, env(1)], ["UserPromptSubmit", { prompt: "Coordinate the invoice export workers" }, 1, env(1)],
      ["PreToolUse", bash(`orca orchestration dispatch --task task-1 --to ${term(2)} --from ${term(1)}`, "toolu_c1"), 5],
      ["PostToolUse", bash(`orca orchestration dispatch --task task-1 --to ${term(2)} --from ${term(1)}`, "toolu_c1"), 6],
      ["PreToolUse", bash(`orca terminal send --terminal ${term(3)} --text "start the tests" --enter`, "toolu_c2"), 7],
      ["PostToolUse", bash(`orca terminal send --terminal ${term(3)} --text "start the tests" --enter`, "toolu_c2"), 8]]),
    // Worker 1: dispatched, now asking its coordinator, with a subagent of its own.
    ...hooks("work-1", [["SessionStart", { source: "startup" }, 4, env(2)], ["UserPromptSubmit", { prompt: "Please carry out this task from my Orca coordinator by following the brief I pasted below." }, 6, env(2)],
      ["PreToolUse", { tool_name: "Agent", tool_use_id: "toolu_w1a", tool_input: { description: "Find the CSV writer", subagent_type: "Explore" } }, 10],
      ["SubagentStart", { agent_id: "sub-1", agent_type: "Explore" }, 11], ["SubagentStop", { agent_id: "sub-1", agent_type: "Explore" }, 20],
      ["PostToolUse", { tool_name: "Agent", tool_use_id: "toolu_w1a", tool_input: { description: "Find the CSV writer", subagent_type: "Explore" } }, 21],
      ["PreToolUse", bash(`orca orchestration ask --question "Which date format?" --to ${term(1)}`, "toolu_w1b"), 170]]),
    // Worker 2: driven by terminal send, running tests.
    ...hooks("work-2", [["SessionStart", { source: "startup" }, 6, env(3)], ["UserPromptSubmit", { prompt: "start the tests" }, 8, env(3)],
      ["PreToolUse", bash("npm test", "toolu_w2"), 175]]),
    // Worker 3: no command names it; it works in the coordinator's worktree and finished.
    ...hooks("work-3", [["SessionStart", { source: "startup" }, 9, env(4)], ["UserPromptSubmit", { prompt: "Write the export changelog" }, 10, env(4)],
      ["Stop", { last_assistant_message: "Changelog written." }, 40]]),
    // Someone else, in another worktree, never named: a task of its own.
    ...hooks("solo-1", [["UserPromptSubmit", { prompt: "Tidy the README badges" }, 100, env(9, "repo-2::C:/work/docs")], ["Stop", { last_assistant_message: "Done." }, 110]]),
  ];
  const { sessions } = buildClaudeFeed(records, { now: NOW, limits: { ...CLAUDE_LIMITS, sessions: 1e9, children: 1e9 } });
  return { records, parties: sessions };
}

function input(overrides = {}) {
  const { records, parties } = orchestra();
  return {
    now: NOW, since: NOW - 24 * HOUR,
    codex: { chats: [{ id: CHAT, name: "Ship the invoice export", updatedAt: NOW - 20 * MIN, createdAt: NOW - 4 * HOUR, cwd: "/work/export", status: "notLoaded", source: "codex" }], spawned: [], actors: new Map() },
    claude: { parties, transcripts: [], identities: claudeIdentities(records), addressing: claudeAddressing(records) },
    orca: { agents: [] },
    links: { auto: new Map([[term(1), { chat: CHAT, verb: "terminal send", at: NOW - 3 * HOUR + 2 * MIN }]]), manual: new Map() },
    ...overrides,
  };
}

const byId = (task) => Object.fromEntries(task.agents.map((agent) => [agent.id, agent]));

test("with Orca unreachable, the hook's terminal ids put the lead, its coordinator, the workers, and their subagents in one task", () => {
  const { tasks } = buildTasks(input());
  const task = tasks.find((item) => item.id === CHAT);
  assert.ok(task, "the Codex chat leads the task");
  const agents = byId(task);
  assert.deepEqual(task.agents.map((agent) => [agent.id, agent.role, agent.depth]), [
    [CHAT, "lead", 0],
    ["claude-agent:coord-1", "coordinator", 1],
    ["claude-agent:work-1", "worker", 2],
    ["claude-agent:work-1:sub-1", "subagent", 3],
    ["claude-agent:work-2", "worker", 2],
    ["claude-agent:work-3", "worker", 2],
  ]);
  assert.equal(agents["claude-agent:coord-1"].parentId, CHAT);
  assert.equal(agents["claude-agent:work-3"].parentId, "claude-agent:coord-1", "the worktree it shares with the coordinator makes it a worker");
  assert.equal(agents["claude-agent:coord-1"].orca.terminal, term(1));
  const link = (from, to) => task.links.find((item) => item.from === from && item.to === to);
  assert.equal(link(CHAT, "claude-agent:coord-1").kind, "drives");
  assert.equal(link("claude-agent:coord-1", "claude-agent:work-1").kind, "dispatched");
  assert.equal(link("claude-agent:coord-1", "claude-agent:work-2").kind, "drives");
  assert.equal(link("claude-agent:work-1", "claude-agent:work-1:sub-1").kind, "spawned");
  // Who waits on whom: worker 1's running `orca orchestration ask` names its coordinator.
  const ask = task.links.find((item) => item.kind === "asked");
  assert.deepEqual([ask.from, ask.to, ask.waiting], ["claude-agent:work-1", "claude-agent:coord-1", true]);
  assert.equal(task.status, "working");
  assert.equal(task.working, 2);
  assert.equal(task.title, "Ship the invoice export");
  assert.equal(task.project, "export");
  assert.equal(task.startedAt, NOW - 4 * HOUR, "the task began when its lead chat did");
  assert.equal(task.updatedAt, Math.max(...task.agents.map((agent) => agent.updatedAt)));
  // The bystander in another worktree stands alone.
  const solo = tasks.find((item) => item.id === "claude-agent:solo-1");
  assert.deepEqual(solo.agents.map((agent) => agent.role), ["solo"]);
});

test("every agent active in the window is in exactly one task, and nothing older is", () => {
  const base = input();
  // Fifty more chats, half old, a few spawned under them, and transcript-only sessions.
  const chats = [...base.codex.chats];
  const spawned = [];
  for (let index = 0; index < 50; index++) chats.push({ id: `chat-many-${String(index).padStart(4, "0")}`, name: `Chat ${index}`, updatedAt: NOW - index * HOUR, status: "notLoaded" });
  for (let index = 0; index < 6; index++) spawned.push({ id: `chat-kid-${index}-000`, name: `Helper ${index}`, updatedAt: NOW - (index * 10) * HOUR, parentThreadId: `chat-many-${String(index * 9).padStart(4, "0")}` });
  spawned.push({ id: "chat-kid-of-old", name: "Late helper", updatedAt: NOW - HOUR, parentThreadId: "chat-many-0036" });
  const transcripts = [
    { session: "only-transcript", agent: "", updatedAt: NOW - 5 * MIN, startedAt: NOW - HOUR, cwd: "/work/site", name: "Fix the footer" },
    { session: "only-transcript", agent: "nested", parentAgent: "missing-parent", updatedAt: NOW - 6 * MIN, agentType: "Plan" },
    { session: "gone-session", agent: "orphan", updatedAt: NOW - 7 * MIN, agentType: "Explore" },
    { session: "old-transcript", agent: "", updatedAt: NOW - 40 * HOUR },
  ];
  const { tasks, counts } = buildTasks({ ...base, codex: { ...base.codex, chats, spawned }, claude: { ...base.claude, transcripts } });
  const shown = tasks.flatMap((task) => task.agents.map((agent) => agent.id));
  assert.equal(new Set(shown).size, shown.length, "no agent appears twice");
  const since = NOW - 24 * HOUR;
  const active = [...chats, ...spawned].filter((chat) => chat.updatedAt >= since).map((chat) => chat.id);
  for (const id of [...active, "claude-agent:only-transcript", "claude-agent:only-transcript:nested", "claude-agent:gone-session:orphan", "claude-agent:work-3"]) assert.ok(shown.includes(id), `${id} is listed`);
  assert.ok(!shown.includes("chat-many-0030"), "a chat last updated 30 hours ago is not");
  assert.ok(!shown.includes("claude-agent:old-transcript"));
  assert.ok(shown.includes("chat-many-0036"), "an old chat leads the task of a helper it spawned that is active");
  assert.equal(tasks.find((task) => task.id === "chat-many-0036").agents[1].role, "subagent");
  // A subagent whose parent's records are gone stands under its session.
  const orphan = tasks.flatMap((task) => task.agents).find((agent) => agent.id === "claude-agent:gone-session:orphan");
  assert.equal(orphan.parentId, "claude-agent:gone-session");
  assert.equal(tasks.flatMap((task) => task.agents).find((agent) => agent.id === "claude-agent:only-transcript:nested").parentId, "claude-agent:only-transcript");
  assert.ok(counts.agents >= active.length);
  // A 4-hour window keeps only what moved in the last four hours.
  const recent = buildTasks({ ...base, since: NOW - 4 * HOUR, codex: { ...base.codex, chats, spawned } }).tasks;
  assert.ok(recent.every((task) => task.updatedAt >= NOW - 4 * HOUR));
  assert.ok(!recent.some((task) => task.id === "chat-many-0010"));
});

test("the person's own choices win: a party kept separate stands alone, one joined by hand follows the chat", () => {
  const separate = buildTasks(input({ links: { ...input().links, manual: new Map([["claude:coord-1", ""]]) } })).tasks;
  const coordinator = separate.find((task) => task.id === "claude-agent:coord-1");
  assert.ok(coordinator, "kept separate, the coordinator leads its own task");
  assert.equal(coordinator.agents[0].role, "coordinator");
  assert.ok(coordinator.agents.some((agent) => agent.id === "claude-agent:work-1"), "its workers stay with it");
  assert.equal(separate.find((task) => task.id === CHAT).agents.length, 1);
  const joined = buildTasks(input({ links: { auto: new Map(), manual: new Map([["claude:solo-1", CHAT]]) } })).tasks;
  const lead = joined.find((task) => task.id === CHAT);
  assert.ok(lead.agents.some((agent) => agent.id === "claude-agent:solo-1"));
  assert.ok(lead.links.find((item) => item.to === "claude-agent:solo-1").manual);
});

test("a drive from long before a session started is another session's, in a reused terminal", () => {
  const base = input();
  const stale = buildTasks({ ...base, links: { ...base.links, auto: new Map([[term(1), { chat: CHAT, verb: "terminal send", at: NOW - 10 * HOUR }]]) } }).tasks;
  assert.ok(stale.find((task) => task.id === "claude-agent:coord-1"), "not joined to the chat");
});

test("what was learned is remembered: grouping survives the hook log rolling over, Orca closing, and a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "goblin-tasks-"));
  try {
    let clock = NOW;
    const memory = new TaskMemory({ dir, clock: () => clock });
    const first = buildTasks({ ...input(), memory });
    for (const item of first.learned.parents) memory.noteParent(item.child, item.parent, item.kind, item.at);
    for (const [session, orca] of first.learned.identities) memory.noteIdentity(session, orca);
    assert.ok(memory.save());
    const saved = JSON.parse(readFileSync(join(dir, "task-links.json"), "utf8"));
    assert.equal(saved.parents["claude-agent:coord-1"].parent, CHAT);
    assert.equal(saved.identities["work-3"].terminal, term(4));
    // After a restart: the drive link is gone and the records that named terminals rolled out.
    const restarted = new TaskMemory({ dir, clock: () => clock });
    const base = input();
    const parties = base.claude.parties;
    const later = buildTasks({ ...base, claude: { parties, transcripts: [], identities: new Map(), addressing: new Map() }, links: { auto: new Map(), manual: new Map() },
      memory: { identities: restarted.identities, parents: restarted.parents } });
    const task = later.tasks.find((item) => item.id === CHAT);
    assert.deepEqual(task.agents.map((agent) => agent.id).sort(), ["chat-lead-0001", "claude-agent:coord-1", "claude-agent:work-1", "claude-agent:work-1:sub-1",
      "claude-agent:work-2", "claude-agent:work-3"].sort());
    // A week later, what was not seen again is forgotten.
    clock = NOW + TASK_LIMITS.memoryKeepMs + 1;
    const forgotten = new TaskMemory({ dir, clock: () => clock });
    assert.equal(forgotten.parents.size, 0);
    assert.equal(forgotten.identities.size, 0);
    // Junk in the file is skipped.
    writeFileSync(join(dir, "task-links.json"), JSON.stringify({ parents: { "../x": { parent: CHAT, kind: "drives", seenAt: NOW }, "claude-agent:a": { parent: "claude-agent:a", kind: "drives", seenAt: NOW } } }));
    assert.equal(new TaskMemory({ dir, clock: () => NOW }).parents.size, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("when Orca answers, a pane that is a hooked session is that session, and Orca's parent panes place the rest", () => {
  const base = input({ links: { auto: new Map(), manual: new Map() } });
  const pane = (n) => `tab-${n}:00000000-1111-4222-8333-44445555${String(n).padStart(4, "0")}`;
  const orcaAgents = [
    { id: `orca-agent:${pane(1)}`, source: "orca", name: "Coordinator", status: "working", pane: pane(1), parentPane: "", terminal: term(1), updatedAt: NOW - MIN, cwd: "/work/export" },
    { id: "orca-agent:tab-20:aaaa", source: "orca", name: "Codex worker", status: "working", pane: "tab-20:aaaa", parentPane: pane(1), terminal: term(20), updatedAt: NOW - MIN, cwd: "/work/export" },
  ];
  const { tasks, aliases } = buildTasks({ ...base, orca: { agents: orcaAgents } });
  assert.equal(aliases.get(`orca-agent:${pane(1)}`), "claude-agent:coord-1", "one goblin, not two");
  const task = tasks.find((item) => item.id === "claude-agent:coord-1");
  assert.equal(task.agents[0].role, "coordinator");
  const codexWorker = task.agents.find((agent) => agent.id === "orca-agent:tab-20:aaaa");
  assert.equal(codexWorker.parentId, "claude-agent:coord-1");
  assert.equal(codexWorker.role, "worker");
  assert.ok(!tasks.flatMap((item) => item.agents).some((agent) => agent.id === `orca-agent:${pane(1)}`));
});

test("asks and states roll up: a chat waiting on an approval makes its task need you", () => {
  const base = input();
  const request = { id: 7, method: "item/commandExecution/requestApproval", params: { threadId: CHAT, command: "rm -rf dist" }, receivedAt: NOW - MIN };
  const { tasks } = buildTasks({ ...base, codex: { ...base.codex, requests: (id) => (id === CHAT ? [request] : []) } });
  const task = tasks.find((item) => item.id === CHAT);
  assert.equal(task.status, "needs");
  assert.equal(task.needs, 1);
  assert.equal(task.agents[0].ask.kind, "approval");
  assert.equal(task.agents[0].ask.answerHere, "respond");
  assert.equal(taskStatus([{ attention: "quiet", status: "completed", source: "claude" }]), "done");
  assert.equal(taskStatus([{ attention: "quiet", status: "stopped", source: "claude" }]), "idle");
  assert.equal(taskStatus([{ attention: "quiet", status: "idle", source: "codex" }]), "done", "Codex's idle is a chat at rest");
  assert.equal(taskStatus([{ attention: "quiet", status: "active", seenBy: "transcript" }]), "idle", "a state known only from a transcript is not called done");
  assert.equal(taskStatus([{ attention: "failed" }, { attention: "quiet" }]), "failed");
});

test("the window parameter reads hours or days, within an hour and a week", () => {
  assert.equal(parseWindow("24h"), 24);
  assert.equal(parseWindow("4h"), 4);
  assert.equal(parseWindow("7d"), 168);
  assert.equal(parseWindow("30d"), 168);
  assert.equal(parseWindow("0h"), 24);
  assert.equal(parseWindow("abc"), 24);
  assert.equal(parseWindow(""), 24);
  assert.equal(parseWindow("12"), 12);
});

test("orchestration commands are read only for the terminals they direct", () => {
  const records = hooks("cmd-1", [
    ["PreToolUse", bash(`orca orchestration worker-start --spec "x" --terminal ${term(5)} --from ${term(6)}`, "t1"), 1],
    ["PreToolUse", bash(`orca terminal read --terminal ${term(7)} --screen`, "t2"), 2],
    ["PreToolUse", bash(`orca orchestration check --terminal ${term(8)}`, "t3"), 3],
    ["PreToolUse", bash(`echo orca terminal send --terminal ${term(9)} | grep x`, "t4"), 4],
  ]);
  const found = claudeAddressing(records).get("claude-agent:cmd-1");
  assert.deepEqual(found.map((item) => [item.terminal, item.kind]), [[term(5), "dispatched"], [term(9), "drives"]],
    "reading a screen or checking an inbox directs nobody, and --from names the caller itself");
});
