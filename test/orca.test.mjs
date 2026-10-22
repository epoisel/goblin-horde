import test from "node:test";
import assert from "node:assert/strict";
import { OrcaReader, orcaAgentActivity, workspaceId } from "../lib/orca.mjs";
import { classifyOrca } from "../lib/feed.mjs";

test("Orca activity keeps public messages and tool actions as separate bubbles", () => {
  const agent = { paneKey: "tab:pane", state: "working", updatedAt: 1234567890000, lastAssistantMessage: "Checking the build.", toolName: "Bash", toolInput: "npm test" };
  const first = orcaAgentActivity(agent);
  assert.deepEqual(first.map((event) => event.kind), ["update", "tool"]);
  assert.equal(first[0].description, "Checking the build.");
  assert.equal(orcaAgentActivity(agent, agent).length, 0);
  assert.equal(orcaAgentActivity({ ...agent, state: "done" }, agent).at(-1).description, "Finished the task.");
});

test("Orca workspaces include each agent and retain new events across snapshots", async () => {
  let message = "Starting the review.";
  const run = async (_command, args) => ({ stdout: JSON.stringify(args[0] === "worktree"
    ? { ok: true, result: { worktrees: [{ worktreeId: "repo::C:/work", path: "C:/work", repo: "Project", agents: [{ paneKey: "tab:pane", agentType: "claude", state: "working", updatedAt: 1000, lastAssistantMessage: message }] }] } }
    : { ok: true, result: { terminals: [{ tabId: "tab", leafId: "pane", title: "✳ Review agent", orphaned: false }] } }) });
  const reader = new OrcaReader({ run, ttlMs: 0 });
  const id = workspaceId("repo::C:/work");
  let scene = await reader.scene(id);
  assert.equal(scene.agents[0].nickname, "Review agent");
  assert.equal(scene.agents[0].activities.length, 1);
  message = "Review finished.";
  scene = await reader.scene(id);
  assert.deepEqual(scene.agents[0].activities.map((event) => event.description), ["Starting the review.", "Review finished."]);
  assert.equal((await reader.listWorkspaces())[0].id, id);
});

test("Orca that is not installed is an empty feed without a warning; a failing Orca still warns", async () => {
  const missing = new OrcaReader({ ttlMs: 0, run: async () => { throw Object.assign(new Error("spawn orca ENOENT"), { code: "ENOENT" }); } });
  const snapshot = await missing.snapshot();
  assert.deepEqual(snapshot.workspaces, []);
  assert.equal(snapshot.warning, "");
  assert.equal(snapshot.missing, true);
  const broken = new OrcaReader({ ttlMs: 0, run: async () => { throw new Error("timed out"); } });
  assert.match((await broken.snapshot()).warning, /Orca feed is unavailable/);
});

test("a closed Orca is asked again only after a growing wait, and the last answer is there without asking", async () => {
  let now = 1_800_000_000_000;
  let open = false;
  let calls = 0;
  const run = async (_command, args) => {
    calls++;
    return { stdout: JSON.stringify(!open ? { ok: false, error: { code: "runtime_unavailable" } }
      : args[0] === "worktree" ? { ok: true, result: { worktrees: [{ worktreeId: "repo::C:/work", path: "C:/work", agents: [] }] } }
        : { ok: true, result: { terminals: [] } }) };
  };
  const reader = new OrcaReader({ run, ttlMs: 3000, clock: () => now });
  assert.equal(reader.lastSnapshot(), null, "nothing read yet");
  assert.match((await reader.snapshot()).warning, /Orca is not running/);
  const first = calls;
  await reader.snapshot();
  now += 2000;
  await reader.snapshot();
  assert.equal(calls, first, "a failed read is kept for the TTL");
  now += 1500;
  await reader.snapshot();
  assert.equal(calls, first * 2, "then tried again");
  now += 3500;
  await reader.snapshot();
  assert.equal(calls, first * 2, "the wait doubles while Orca stays closed");
  now += 3000;
  await reader.snapshot();
  assert.equal(calls, first * 3);
  assert.match(reader.lastSnapshot().warning, /Orca is not running/);
  // Never more than a minute between tries, and the first good answer ends the waiting.
  for (let index = 0; index < 8; index++) { now += 60_000; await reader.snapshot(); }
  assert.equal(calls, first * 11);
  open = true;
  now += 60_000;
  assert.equal((await reader.snapshot()).warning, "");
  assert.equal(reader.lastSnapshot().warning, "");
  const missing = new OrcaReader({ ttlMs: 3000, clock: () => now, run: async () => { calls++; throw Object.assign(new Error("spawn orca ENOENT"), { code: "ENOENT" }); } });
  assert.equal((await missing.snapshot()).missing, true);
  const once = calls;
  assert.equal((await missing.snapshot()).missing, true);
  assert.equal(calls, once, "a missing Orca is not looked for on every poll");
});

test("agents last seen working are not called working long after the Orca app was closed", async () => {
  let now = 1_800_000_000_000;
  let open = true;
  const run = async (_command, args) => ({ stdout: JSON.stringify(!open ? { ok: false, error: { code: "runtime_unavailable" } }
    : args[0] === "worktree"
      ? { ok: true, result: { worktrees: [{ worktreeId: "repo::C:/work", path: "C:/work", agents: [{ paneKey: "tab:pane", agentType: "claude", state: "working", updatedAt: now }] }] } }
      : { ok: true, result: { terminals: [] } }) });
  const reader = new OrcaReader({ run, ttlMs: 0, clock: () => now });
  const agentNow = async () => (await reader.snapshot()).workspaces[0].agents[0];
  assert.equal(classifyOrca(await agentNow(), { now }), "working");
  open = false;
  now += 10_000;
  // A moment's hiccup keeps the last snapshot as it was.
  const brief = await reader.snapshot();
  assert.match(brief.warning, /temporarily unavailable/);
  assert.equal(classifyOrca(brief.workspaces[0].agents[0], { now }), "working");
  now += 6 * 60 * 60_000;
  const later = await agentNow();
  assert.equal(classifyOrca(later, { now }), "quiet");
  assert.equal(later.status, "unavailable");
  assert.equal(later.role, "claude · unavailable");
  // Orca back again: live states return.
  open = true;
  assert.equal(classifyOrca(await agentNow(), { now }), "working");
});
