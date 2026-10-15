import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscoveryGate, LinkStore, claudePanePairs, drivenTerminals, identityMark, joinParties, joinReason, joinSubset } from "../lib/links.mjs";

const T1 = "term_c104bbcf-1111-4222-8333-444455556666";
const T2 = "term_78a8df17-aaaa-4bbb-8ccc-ddddeeeeffff";
const T3 = "term_98a03cdb-0000-4000-8000-000000000000";
const turn = (startedAt, ...commands) => ({ startedAt, items: commands.map((command) => ({ type: "commandExecution", command })) });

test("only commands that drive a terminal count, never reading or showing one", () => {
  const drives = drivenTerminals([
    turn(1_800_000_000, `orca orchestration worker-start --from ${T1} --prompt "Build the PO import"`),
    turn(1_800_000_100, `orca terminal read --terminal ${T3}`, `orca terminal show --terminal ${T3}`,
      `orca orchestration check --terminal ${T1} --json`, `orca terminal send --terminal ${T2} --text "y"`),
    { startedAt: 1_800_000_200, items: [{ type: "agentMessage", text: `I will run orca orchestration send --to ${T3}` }] },
  ]);
  assert.deepEqual(drives.map((item) => [item.terminal, item.verb]), [[T1, "orchestration check"], [T2, "terminal send"]]);
  assert.equal(drives[0].at, 1_800_000_100_000);
});

test("the most recent driver of a terminal wins, and links survive a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "goblin-links-"));
  try {
    const store = new LinkStore({ dir });
    store.observe("chat-aaaa1111", [{ terminal: T1, verb: "orchestration check", at: 100 }], { now: 1000 });
    store.observe("chat-bbbb2222", [{ terminal: T1, verb: "orchestration send", at: 200 }], { now: 1000 });
    assert.equal(store.observe("chat-aaaa1111", [{ terminal: T1, verb: "orchestration check", at: 150 }], { now: 1000 }), false);
    store.setManual("orca:d29ya3RyZWU", "");
    const again = new LinkStore({ dir });
    assert.equal(again.auto.get(T1).chat, "chat-bbbb2222");
    assert.equal(again.manual.get("orca:d29ya3RyZWU"), "");
    assert.throws(() => again.setManual("../x", "chat-aaaa1111"), { statusCode: 400 });
    assert.deepEqual(readdirSync(dir), ["links.json"]);
    writeFileSync(join(dir, "links.json"), "{ broken");
    assert.equal(new LinkStore({ dir }).auto.size, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const chat = { id: "chat-aaaa1111", source: "codex", name: "[Lantern Shop] SHOP-12" };
const helper = { id: "chat-helper01", source: "codex", parentThreadId: "chat-aaaa1111", name: "helper" };
const coordinator = { id: "orca-agent:p1", source: "orca", role: "claude · working", pane: "p1", parentPane: "", terminal: T1,
  parentThreadId: "orca:wt1", cwd: "C:\\work\\lantern-shop-SHOP-12-fix", mainWorktree: false };
const worker = { id: "orca-agent:p2", source: "orca", role: "claude · working", pane: "p2", parentPane: "p1", terminal: "",
  parentThreadId: "orca:wt2", cwd: "C:\\work\\lantern-shop-SHOP-12-worker", mainWorktree: false };
const opus = { id: "claude-agent:s1", source: "claude", parentThreadId: "claude:s1", cwd: "c:/work/lantern-shop-shop-12-fix/" };
const opusHelper = { id: "claude-agent:s1:a1", source: "claude", parentThreadId: "claude:s1", childOf: "claude-agent:s1", cwd: opus.cwd };
const elsewhere = { id: "claude-agent:s9", source: "claude", parentThreadId: "claude:s9", cwd: "C:\\other" };
const links = (auto, manual = new Map(), pairs = new Map()) => ({ auto: new Map(Object.entries(auto)), manual, pairs });
// The coordinator pane is proven to be the Opus session (see claudePanePairs).
const proven = new Map([[coordinator.id, opus.id]]);

test("a chat's Opus coordinator, its workers, and its Claude session join the chat's party as one", () => {
  const { agents, joined } = joinParties([chat, coordinator, worker, opus, opusHelper, elsewhere],
    links({ [T1]: { chat: chat.id, verb: "orchestration worker-start" } }, new Map(), proven));
  const party = agents.filter((agent) => (agent.parentThreadId || agent.id) === chat.id).map((agent) => agent.id);
  // The Orca pane and the Claude session in the same worktree are one agent: the Claude goblin stays.
  assert.deepEqual(party.sort(), ["chat-aaaa1111", "claude-agent:s1", "claude-agent:s1:a1", "orca-agent:p2"].sort());
  assert.equal(agents.some((agent) => agent.id === "orca-agent:p1"), false);
  assert.equal(agents.find((agent) => agent.id === "orca-agent:p2").joined.reason, "worker");
  assert.equal(agents.find((agent) => agent.id === "claude-agent:s1").joined.reason, "worktree");
  assert.equal(agents.find((agent) => agent.id === "claude-agent:s9").parentThreadId, "claude:s9");
  assert.deepEqual(Object.fromEntries(joined), { "orca:wt2": chat.id, "claude:s1": chat.id });
});

test("a helper chat's link joins the parent chat's party", () => {
  const { agents } = joinParties([chat, helper, coordinator], links({ [T1]: { chat: helper.id, verb: "orchestration send" } }));
  assert.equal(agents.find((agent) => agent.id === coordinator.id).parentThreadId, chat.id);
});

test("the main checkout joins by pane only, never every Claude session that runs there", () => {
  const main = { ...coordinator, cwd: "C:\\work\\MainRepo", mainWorktree: true };
  const there = { ...opus, cwd: "C:\\work\\MainRepo" };
  const { agents } = joinParties([chat, main, there], links({ [T1]: { chat: chat.id, verb: "orchestration check" } }));
  assert.equal(agents.find((agent) => agent.id === main.id).parentThreadId, chat.id);
  assert.equal(agents.find((agent) => agent.id === there.id).parentThreadId, "claude:s1");
});

test("manual choices win: keep a party separate, or join one with no automatic link", () => {
  const separate = joinParties([chat, coordinator], links({ [T1]: { chat: chat.id } }, new Map([["orca:wt1", ""]])));
  assert.equal(separate.agents.find((agent) => agent.id === coordinator.id).parentThreadId, "orca:wt1");
  const byHand = joinParties([chat, elsewhere], links({}, new Map([["claude:s9", chat.id]])));
  const moved = byHand.agents.find((agent) => agent.id === elsewhere.id);
  assert.equal(moved.parentThreadId, chat.id);
  assert.equal(joinReason(moved.joined), "Joined to this chat by you.");
  assert.match(joinReason({ reason: "drives", verb: "orchestration worker-start" }), /orca orchestration worker-start/);
});

test("another pane in a worktree the chat drives joins too, but not one in the main checkout", () => {
  const sibling = { ...coordinator, id: "orca-agent:p3", pane: "p3", terminal: T3 };
  const mainPane = { ...coordinator, id: "orca-agent:p4", pane: "p4", terminal: T2, cwd: "C:\work\MainRepo", mainWorktree: true };
  const mainSibling = { ...mainPane, id: "orca-agent:p5", pane: "p5", terminal: "" };
  const { agents } = joinParties([chat, coordinator, sibling, mainPane, mainSibling],
    links({ [T1]: { chat: chat.id, verb: "orchestration check" }, [T2]: { chat: chat.id, verb: "orchestration check" } }));
  assert.equal(agents.find((agent) => agent.id === sibling.id).joined.reason, "worktree");
  assert.equal(agents.find((agent) => agent.id === mainSibling.id).parentThreadId, "orca:wt1", "main checkout siblings stay");
});

test("a scene's membership is the same whether or not the coordinator made the cut", () => {
  const everyone = [chat, helper, coordinator, worker, opus, opusHelper, elsewhere];
  const linked = links({ [T1]: { chat: helper.id, verb: "orchestration worker-start" } }, new Map(), proven);
  const membership = (shown) => {
    const { agents, joined } = joinSubset(shown.map((agent) => ({ ...agent, attention: "working" })), everyone, linked);
    return { parties: Object.fromEntries(agents.map((agent) => [agent.id, agent.parentThreadId])), joined: Object.fromEntries(joined), agents };
  };
  const full = membership(everyone);
  // The worker is shown without its coordinator pane, and the helper chat without its parent.
  const cut = membership([worker, helper, elsewhere]);
  assert.equal(cut.parties[worker.id], chat.id);
  assert.equal(cut.parties[worker.id], full.parties[worker.id]);
  assert.equal(cut.joined["orca:wt2"], chat.id);
  assert.equal(cut.agents.find((agent) => agent.id === worker.id).attention, "working", "the scene's own fields stay");
  // Before: joining only what the scene showed lost the worker's chain.
  assert.equal(joinParties([worker, helper, elsewhere], linked).agents.find((agent) => agent.id === worker.id).parentThreadId, "orca:wt2");
  // The coordinator pane is the Claude session's twin: hidden while the session is shown, kept when it is not.
  assert.equal(full.parties[coordinator.id], undefined);
  assert.equal(membership([coordinator, worker]).parties[coordinator.id], chat.id);
});

test("one Claude Code prompt in an Orca pane is one goblin needing you, joined to a chat or not", () => {
  const ask = (text) => ({ kind: "permission", text, at: 5, answerHere: null, key: `k-${text}` });
  const pane = { id: "orca-agent:p7", source: "orca", role: "claude · waiting on you", pane: "p7", parentPane: "", terminal: T2, parentThreadId: "orca:wt7",
    cwd: "C:\\work\\billing-api", mainWorktree: true, status: "waiting", updatedAt: Date.now(), attention: "needs", needsInput: true, ask: ask("Do you want to proceed?") };
  const session = { id: "claude-agent:s7", source: "claude", parentThreadId: "claude:s7", cwd: "c:/work/billing-api/", attention: "needs", needsInput: true,
    ask: ask("Allow Bash to run this command?") };
  const needing = (agents) => agents.filter((agent) => agent.attention === "needs").map((agent) => agent.id);
  // Proven the same agent: one goblin, the Claude one, whether or not any chat drives the pane.
  const twinned = joinParties([pane, session], links({}, new Map(), new Map([[pane.id, session.id]])));
  assert.deepEqual(twinned.agents.map((agent) => agent.id), [session.id]);
  assert.deepEqual(needing(joinSubset([pane, session], [pane, session], links({}, new Map(), new Map([[pane.id, session.id]]))).agents), [session.id]);
  // Not proven: both goblins stay, but the one prompt is counted once, on the Claude goblin.
  for (const result of [joinParties([pane, session], links({})), joinSubset([pane, session], [pane, session], links({}))]) {
    assert.deepEqual(result.agents.map((agent) => agent.id).sort(), [session.id, pane.id].sort());
    assert.deepEqual(needing(result.agents), [session.id]);
    const kept = result.agents.find((agent) => agent.id === pane.id);
    assert.equal(kept.ask, null);
    assert.equal(kept.needsInput, false);
  }
  // The pane's own ask stays when the session asks nothing, when the session is not shown, or when the session is another pane's.
  assert.equal(joinParties([pane, { ...session, ask: null, attention: "working", needsInput: false }], links({})).agents.find((agent) => agent.id === pane.id).ask.text, "Do you want to proceed?");
  assert.equal(joinSubset([pane], [pane, session], links({})).agents[0].ask.text, "Do you want to proceed?");
  const other = { ...pane, id: "orca-agent:p8", pane: "p8", terminal: T3 };
  const paired = joinParties([pane, other, session], links({}, new Map(), new Map([[other.id, session.id]])));
  assert.equal(paired.agents.find((agent) => agent.id === pane.id).ask.text, "Do you want to proceed?");
  assert.equal(paired.agents.some((agent) => agent.id === other.id), false);
  // A proven twin that a chat drives brings its link to the Claude goblin, even in the main checkout.
  const driven = joinParties([chat, pane, session], links({ [T2]: { chat: chat.id, verb: "terminal send" } }, new Map(), new Map([[pane.id, session.id]])));
  assert.equal(driven.agents.find((agent) => agent.id === session.id).parentThreadId, chat.id);
  assert.equal(driven.agents.some((agent) => agent.id === pane.id), false);
});

test("a pane is a Claude Code session only on proof: the same recorded prompt or reply, and no one else's", () => {
  const prompt = "Ship the CSV export for billing-api and add a test for the header row.";
  const pane = { id: "orca-agent:p1", source: "orca", role: "claude · working", pane: "p1", cwd: "C:\\work\\billing-api" };
  const session = { id: "claude-agent:s1", source: "claude", cwd: "c:/work/billing-api" };
  const marks = new Map([[pane.id, [identityMark(prompt)]], [session.id, [identityMark("An older prompt that was long enough."), identityMark(prompt)]]]);
  const options = { paneMarks: (agent) => marks.get(agent.id) || [], sessionMarks: (agent) => marks.get(agent.id) || [] };
  assert.deepEqual([...claudePanePairs([pane, session], options)], [[pane.id, session.id]]);
  // A shared folder alone is no proof: an unrelated pane there is not this session.
  assert.equal(claudePanePairs([{ ...pane, id: "orca-agent:p2" }, session], options).size, 0);
  // Another folder, a Codex pane, a subagent, or a match with two sessions (or two panes) is no proof either.
  assert.equal(claudePanePairs([{ ...pane, cwd: "C:\\work\\other" }, session], options).size, 0);
  assert.equal(claudePanePairs([{ ...pane, role: "codex · working" }, session], options).size, 0);
  assert.equal(claudePanePairs([pane, { ...session, childOf: "claude-agent:s0" }], options).size, 0);
  const twin = { ...session, id: "claude-agent:s2" };
  marks.set(twin.id, [identityMark(prompt)]);
  assert.equal(claudePanePairs([pane, session, twin], options).size, 0);
  marks.set("orca-agent:p3", [identityMark(prompt)]);
  assert.equal(claudePanePairs([pane, { ...pane, id: "orca-agent:p3" }, session], options).size, 0);
  // Marks ignore spacing and credentials (the hook stores prompts filtered), and short words prove nothing.
  const FAKE = ["ghp", "abcdefghijklmnopqrstuvwxyz0123"].join("_");
  assert.equal(identityMark(`Push   it with ${FAKE}\nto the staging remote, please.`), identityMark("Push it with [secret removed] to the staging remote, please."));
  assert.equal(identityMark("yes"), "");
  assert.equal(identityMark(""), "");
});

test("a link that cannot be saved still holds, and never fails the chat's read", () => {
  const dir = mkdtempSync(join(tmpdir(), "goblin-links-"));
  try {
    const blocked = join(dir, "file");
    writeFileSync(blocked, "");
    const store = new LinkStore({ dir: join(blocked, "inner") });
    assert.equal(store.observe("chat-aaaa1111", [{ terminal: T1, verb: "orchestration check", at: 100 }], { now: 1000 }), true);
    assert.equal(store.auto.get(T1).chat, "chat-aaaa1111");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("link discovery runs one at a time in the background and backs off while it learns nothing", async () => {
  let now = 0;
  const gate = new DiscoveryGate({ minMs: 30_000, maxMs: 120_000, clock: () => now });
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const slow = gate.start(() => pending, "a");
  assert.ok(slow);
  assert.equal(gate.start(async () => 1, "a"), null, "never two at once");
  release(0);
  assert.equal(await slow, 0);
  now += 10_000;
  assert.equal(gate.start(async () => 0, "a"), null, "waits after learning nothing");
  now += 21_000;
  assert.equal(await gate.start(async () => 0, "a"), 0);
  now += 31_000;
  assert.equal(gate.start(async () => 0, "a"), null, "the wait doubles");
  now += 30_000;
  assert.equal(await gate.start(async () => { throw new Error("Codex is slow"); }, "a"), 0, "a failed run is a run that learned nothing");
  now += 120_001;
  assert.equal(await gate.start(async () => 2, "a"), 2);
  assert.ok(gate.start(async () => 0, "a"), "learning something starts over at once");
  await gate.running;
  // A new unlinked pane is looked for at once, whatever the wait.
  assert.ok(gate.start(async () => 0, "a,b"));
});
