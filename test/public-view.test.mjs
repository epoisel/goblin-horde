import test from "node:test";
import assert from "node:assert/strict";
import { publicView } from "../lib/public-view.mjs";
import { makeAsk } from "../lib/asks.mjs";

// Synthetic credential shapes, joined at runtime so the source holds no credential-shaped literal.
const STRIPE = ["sk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("_");
const PASSWORD = ["Hunter2", "Secret!"].join("");
const NOW = 1_800_000_000_000;

const goblin = (id) => ({
  id, source: "claude", name: "Claude · billing-api · 1a2b", status: "waiting", updatedAt: NOW, attention: "needs",
  activities: [{ id: "a1", kind: "command", title: "Ran a local command", description: "Ran a command.", detail: "", status: "inProgress" }],
  ask: makeAsk(id, { kind: "question", text: `Use the key ${STRIPE} for staging?`, command: `deploy --api-key ${STRIPE}`, tool: "AskUserQuestion", at: NOW,
    questions: [{ text: "Which region?", options: ["eu-west", `token: ${STRIPE}`] }, { text: "Ship today?", options: ["Yes", "No"] }] }),
  now: { kind: "command", title: "Running deploy --password", detail: `deploy --password ${PASSWORD}`, startedAt: NOW - 5000 },
  progress: { done: 2, total: 5, current: `Rotate password: ${PASSWORD}` },
  waitingOn: { who: "coordinator", text: `Asked the coordinator about ${STRIPE}`, at: NOW - 1000 },
  dismissedAsk: { key: "0123456789abcdef", at: NOW - 100 },
});

test("this computer sees the question, command, options, step, and plan, with credentials removed", () => {
  const view = publicView({ agents: [goblin("claude-agent:s1")], root: goblin("claude-agent:s2"), thread: goblin("chat-desk-0001") });
  for (const actor of [view.agents[0], view.root, view.thread]) {
    assert.equal(actor.ask.text, "Use the key [secret removed] for staging?");
    assert.equal(actor.ask.command, "deploy --api-key [secret removed]");
    assert.deepEqual(actor.ask.options, ["eu-west", "token: [secret removed]"]);
    assert.deepEqual(actor.ask.questions[1], { text: "Ship today?", options: ["Yes", "No"] });
    assert.equal(actor.now.detail, "deploy --password [secret removed]");
    assert.equal(actor.progress.current, "Rotate password: [secret removed]");
    assert.equal(actor.waitingOn.text, "Asked the coordinator about [secret removed]");
    assert.match(actor.ask.key, /^[a-f0-9]{16}$/, "keys are ids, never filtered");
  }
  assert.equal(view.agents[0].ask.key, goblin("claude-agent:s1").ask.key);
  assert.ok(!JSON.stringify(view).includes(STRIPE));
  assert.ok(!JSON.stringify(view).includes(PASSWORD));
});

test("a phone gets the kinds, counts, and times only", () => {
  const source = goblin("claude-agent:s1");
  const view = publicView({ agents: [source], root: goblin("claude-agent:s2"), thread: goblin("chat-phone-0001"), agent: goblin("claude-agent:s3") }, { phone: true });
  for (const actor of [view.agents[0], view.root, view.thread, view.agent]) {
    assert.deepEqual(Object.keys(actor.ask).sort(), ["answerHere", "at", "key", "kind", "optionCount", "questionCount", "tool"]);
    assert.equal(actor.ask.kind, "question");
    assert.equal(actor.ask.questionCount, 2);
    assert.equal(actor.ask.optionCount, 2);
    assert.equal(actor.ask.at, NOW);
    assert.deepEqual(actor.now, { kind: "command", startedAt: NOW - 5000, title: "Running a command" });
    assert.deepEqual(actor.progress, { done: 2, total: 5 });
    assert.deepEqual(actor.waitingOn, { who: "coordinator", at: NOW - 1000 });
    assert.deepEqual(actor.dismissedAsk, { key: "0123456789abcdef", at: NOW - 100 });
    // What phones already had stays: the actor's own name and activity titles.
    assert.equal(actor.activities[0].title, "Ran a local command");
  }
  const text = JSON.stringify(view);
  for (const fragment of ["Which region", "eu-west", "deploy", "Rotate", "staging", "coordinator about"]) assert.ok(!text.includes(fragment), fragment);
  // The server's own copy is untouched.
  assert.equal(source.ask.questions.length, 2);
  // Nothing to strip is fine.
  assert.deepEqual(publicView({ agents: [{ id: "chat-0001", ask: null, now: null, progress: null }] }, { phone: true }).agents[0],
    { id: "chat-0001", ask: null, now: null, progress: null });
});
