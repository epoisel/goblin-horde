import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinkStore, drivenTerminals, joinParties, joinReason } from "../lib/links.mjs";

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
const links = (auto, manual = new Map()) => ({ auto: new Map(Object.entries(auto)), manual });

test("a chat's Opus coordinator, its workers, and its Claude session join the chat's party as one", () => {
  const { agents, joined } = joinParties([chat, coordinator, worker, opus, opusHelper, elsewhere],
    links({ [T1]: { chat: chat.id, verb: "orchestration worker-start" } }));
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
