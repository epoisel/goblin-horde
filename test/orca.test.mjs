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
