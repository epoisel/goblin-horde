import test from "node:test";
import assert from "node:assert/strict";
import {
  ActionPulse, foldActive, goblinAction, launchpadBoard, memberStatus, partySignal, replyMode, searchSources, splitStream, streamOrder,
} from "../public/party.js";
import { demoAll, demoCatalog, demoParty, demoLength } from "../public/demo.js";

const NOW = 1_800_000_000_000;
const step = (kind, title, extra = {}) => ({ id: `${kind}-${title}`, kind, title, description: "", status: "completed", exitCode: null, ...extra });
const working = (id, extra = {}) => ({ id, status: "running", updatedAt: NOW - 1000, attention: "working",
  turnStates: [{ id: "t", status: "inProgress", questions: [] }], activities: [step("command", "Read a file")], ...extra });

test("parties that need you or failed rise above working ones; working rows keep their order", () => {
  const actors = [
    working("calm-a"), working("calm-b"),
    working("broken", { status: "failed", attention: "failed", activities: [step("command", "Lint check", { status: "failed", exitCode: 1 })] }),
    working("asks", { attention: "needs", needsInput: true }),
  ];
  const { active } = launchpadBoard(actors, [], ["calm-b", "calm-a", "broken", "asks"], NOW);
  assert.deepEqual(active.map((card) => card.id), ["asks", "broken", "calm-b", "calm-a"]);
  assert.equal(partySignal(active[1]).label, "FAILED · LINT CHECK");
  assert.equal(partySignal(active[0]).tone, "needs");
});

test("members group under their parent party and count by state", () => {
  const actors = [working("lead"), working("helper-1", { parentThreadId: "lead" }), working("helper-2", { parentThreadId: "lead", attention: "needs", needsInput: true,
    turnStates: [{ id: "t", status: "completed", questions: ["Gold or green?"] }] })];
  const { active } = launchpadBoard(actors, [{ id: "lead", name: "Lantern Shop", updatedAt: NOW }], [], NOW);
  assert.equal(active.length, 1);
  assert.equal(active[0].name, "Lantern Shop");
  assert.equal(active[0].members.length, 3);
  assert.equal(partySignal(active[0]).label, "NEEDS YOU · 1 QUESTION");
});

test("recently used lists quiet catalog parties from the past week, newest first", () => {
  const catalog = [{ id: "old", name: "Old", updatedAt: NOW - 30 * 86_400_000 }, { id: "yesterday", name: "Quest Log", updatedAt: NOW - 86_400_000 },
    { id: "busy", name: "Busy", updatedAt: NOW }, { id: "today", name: "Pixel Forge", updatedAt: NOW - 3_600_000 }];
  const board = launchpadBoard([working("busy")], catalog, [], NOW);
  assert.deepEqual(board.recent.map((card) => card.id), ["today", "yesterday"]);
  assert.equal(board.older, 1);
});

test("folding never hides a party that needs you or failed", () => {
  const cards = [...Array(8)].map((_, index) => ({ id: `w${index}`, rank: 4 })).concat([{ id: "n", rank: 1 }, { id: "f", rank: 2 }]);
  const { shown, folded } = foldActive(cards, 3);
  assert.ok(shown.some((card) => card.id === "n") && shown.some((card) => card.id === "f"));
  assert.equal(shown.length, 3);
  assert.equal(folded, 7);
});

test("only Codex chats take replies; Claude Code, Orca, and extension feeds are watch-only", () => {
  assert.equal(replyMode({ source: "codex" }, "019a-thread"), "reply");
  assert.equal(replyMode({}, "claude:abc"), "claude");
  assert.equal(replyMode({}, "claude-agent:abc"), "claude");
  assert.equal(replyMode({ source: "orca" }, "orca:ws"), "orca");
  assert.equal(replyMode({}, "ext:feed/party"), "extension");
});

test("goblins act out visible work only: magnifier, hammer, thought, bell, cross, rest", () => {
  assert.equal(goblinAction(working("a", { activities: [step("research", "Searched the web")] }), NOW), "search");
  assert.equal(goblinAction(working("a", { activities: [step("file", "Changed app.js")] }), NOW), "build");
  assert.equal(goblinAction(working("a", { activities: [step("update", "Update")] }), NOW), "think");
  assert.equal(goblinAction(working("a", { needsInput: true }), NOW), "waiting");
  assert.equal(goblinAction(working("a", { activities: [step("command", "Run tests", { exitCode: 2 })] }), NOW), "trouble");
  assert.equal(goblinAction({ id: "a", status: "completed", turnStates: [{ status: "completed", questions: [] }], activities: [] }, NOW), "idle");
  // A finished read long ago settles into thinking instead of waving the magnifier forever.
  assert.equal(goblinAction(working("a", { updatedAt: NOW - 120_000 }), NOW), "think");
});

test("a new step is acted out briefly, but the first look only records", () => {
  const pulse = new ActionPulse(1000);
  const actor = { id: "g", status: "completed", turnStates: [{ status: "completed", questions: [] }], activities: [step("file", "Changed a.js")] };
  assert.equal(pulse.action(actor, NOW), "idle");
  const next = { ...actor, activities: [...actor.activities, step("research", "Opened a source")] };
  assert.equal(pulse.action(next, NOW + 10), "search");
  assert.equal(pulse.action(next, NOW + 2000), "idle");
});

test("dialogue holds what the agent said; the field log holds what it did", () => {
  const { dialogue, log } = splitStream([step("update", "Update", { description: "Working on it." }), step("update", "Status", { description: "Finished the task." }),
    step("command", "Ran tests"), step("update", "Update", { description: "   " })]);
  assert.deepEqual(dialogue.map((item) => item.description), ["Working on it."]);
  assert.deepEqual(log.map((item) => item.title), ["Ran tests"]);
});

test("streams that need you jump ahead; equal ranks keep their place", () => {
  const actors = [working("a"), working("b"), working("c", { needsInput: true })];
  assert.deepEqual(streamOrder(actors, ["b", "a", "c"]).map((actor) => actor.id), ["c", "b", "a"]);
  assert.equal(memberStatus(actors[2]).word, "WAITING ON YOU");
});

test("a failure or question the feed calls quiet is history in the browser too", () => {
  const failed = { id: "c", status: "notLoaded", attention: "quiet", turnStates: [{ status: "failed", questions: [] }],
    activities: [step("command", "Ran project tests", { status: "failed", exitCode: 1 })] };
  assert.notEqual(memberStatus(failed).word, "FAILED");
  assert.equal(goblinAction(failed, NOW), "idle");
  assert.equal(memberStatus({ ...failed, attention: "failed" }).word, "FAILED");
  const asked = { id: "q", status: "completed", attention: "quiet", turnStates: [{ status: "completed", questions: ["Ship it?"] }], activities: [] };
  assert.equal(memberStatus(asked).word, "DONE");
  assert.equal(memberStatus({ ...asked, attention: "needs" }).word, "ASKED YOU");
  assert.equal(memberStatus({ ...asked, needsInput: true }).word, "WAITING ON YOU");
});

test("search matches every word, title matches first, and skips the all-parties entry", () => {
  const catalog = [{ id: "all", name: "All" }, { id: "1", name: "Docs pass", cwd: "/demo/lantern-shop" }, { id: "2", name: "Lantern shop sign", cwd: "/demo/x" }];
  assert.deepEqual(searchSources(catalog, "lantern").map((item) => item.id), ["2", "1"]);
  assert.deepEqual(searchSources(catalog, "lantern sign").map((item) => item.id), ["2"]);
  assert.deepEqual(searchSources(catalog, ""), []);
});

test("the demo shows every launchpad state with source-correct reply rules", () => {
  const scene = demoAll(demoLength);
  const board = launchpadBoard(scene.agents, demoCatalog(), [], Date.now());
  const tones = board.active.map((card) => partySignal(card).tone);
  assert.equal(tones[0], "needs");
  assert.equal(tones[1], "failed");
  assert.ok(tones.slice(2).every((tone) => tone === "working"));
  assert.ok(board.recent.length >= 2);
  for (const card of board.active) {
    const party = demoParty(card.id, demoLength);
    assert.ok(party.root, card.id);
    assert.equal(replyMode(party.root, card.id) === "reply", card.source === "codex", card.id);
  }
});
