import test from "node:test";
import assert from "node:assert/strict";
import { publicRequests, publicView, withoutQuestions } from "../lib/public-view.mjs";
import { makeAsk } from "../lib/asks.mjs";
import { mobileStatus, requestAnswer } from "../lib/phone.mjs";

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
  // A finished step reads in the past tense on a phone too, without its command or words.
  const done = publicView({ agents: [{ id: "chat-0002", now: { kind: "command", title: "Ran deploy --prod", detail: "deploy --prod", startedAt: NOW, done: true } },
    { id: "chat-0003", now: { kind: "message", title: "Said: Shipping to eu-west", startedAt: NOW, done: true } }] }, { phone: true }).agents;
  assert.deepEqual(done[0].now, { kind: "command", startedAt: NOW, done: true, title: "Ran a command" });
  assert.equal(done[1].now.title, "Wrote an update");
});

// ------------------------------------------------------------------ What each route gives a phone
// Words of the questions agents ask the person in the fixtures below: none may reach a phone.
const ASKED = ["Ship the CSV export to staging", "Which region", "eu-west", "us-east", "Keep the old header", "Merge it now",
  "Rotate the signing key", "Needs network access", "Which database", "Postgres", "Approve the release"];

const codexChat = {
  id: "chat-ship-0001", source: "codex", name: "Ship CSV export", status: "idle", updatedAt: NOW, attention: "needs", replyAvailable: true,
  turnStates: [{ id: "t1", status: "completed", questions: [] },
    { id: "t2", status: "completed", questions: ["Ship the CSV export to staging now?", "Which region should it use?"] }],
  activities: [
    { id: "c1", turnId: "t2", kind: "command", title: "npm test", description: "Checked the project with its test suite.", detail: "npm test", output: "42 passing", status: "completed" },
    { id: "m1", turnId: "t2", kind: "update", title: "Answer", status: "completed", detail: "",
      description: "The export works and all 42 tests pass.\nWhich region should it use?\n- eu-west\n- us-east\n\nShip the CSV export to staging now?" },
  ],
  ask: makeAsk("chat-ship-0001", { kind: "reply", text: "All 42 tests pass. Ship the CSV export to staging now?", at: NOW, answerHere: "reply" }),
};
codexChat.latest = codexChat.activities.at(-1);
const claudeSession = {
  id: "claude-agent:sess-ship", source: "claude", name: "Claude · billing-api · 1a2b", status: "completed", updatedAt: NOW, attention: "needs",
  turnStates: [{ id: "turn-1", status: "completed", questions: ["Keep the old header? Merge it now?"], error: "" }],
  activities: [{ id: "claude-1", turnId: "turn-1", kind: "update", title: "Answer", detail: "", status: "completed",
    description: "Renamed the column.\n**Keep the old header? Merge it now?**" }],
  ask: makeAsk("claude-agent:sess-ship", { kind: "reply", text: "Keep the old header? Merge it now?", at: NOW }),
};
claudeSession.latest = claudeSession.activities[0];
const feedAgent = {
  id: "ext-agent:relay:night-run:scout", source: "extension", name: "Scout", status: "waiting", updatedAt: NOW, attention: "needs",
  turnStates: [{ id: "turn-1", status: "inProgress", questions: ["Rotate the signing key tonight."], error: "" }],
  activities: [{ id: "e1", turnId: "turn-1", kind: "update", title: "Needs you", description: "Rotate the signing key tonight.", status: "completed" }],
  ask: makeAsk("ext-agent:relay:night-run:scout", { kind: "question", text: "Rotate the signing key tonight.", at: NOW }),
};
feedAgent.latest = feedAgent.activities[0];
const requests = [
  { id: 7, method: "item/commandExecution/requestApproval", receivedAt: NOW,
    params: { threadId: "chat-ship-0001", turnId: "t3", itemId: "c9", command: `deploy --token ${STRIPE}`, reason: "Needs network access to upload the export.",
      networkApprovalContext: { host: "files.example.test", protocol: "https" } } },
  { id: 8, method: "item/fileChange/requestApproval", receivedAt: NOW, params: { threadId: "chat-ship-0001", itemId: "f1", grantRoot: "C:\\work\\billing-api", reason: "Approve the release notes edit." } },
  { id: 9, method: "item/tool/requestUserInput", receivedAt: NOW, params: { threadId: "chat-ship-0001", turnId: "t3", itemId: "q1",
    questions: [{ id: "db", header: "Which database", question: "Which database should the export read?", isOther: true, options: [{ label: "Postgres" }, { label: "us-east replica" }] }] } },
];

/** The payloads server.mjs builds for each route, as a phone gets them. */
const phoneRoutes = () => ({
  sceneAll: publicView({ agents: [codexChat, claudeSession, feedAgent], requests: [], watched: ["chat-ship-0001"], servedAt: NOW }, { phone: true }),
  sceneParty: publicView({ root: codexChat, agents: [codexChat], requests, checkedAt: NOW }, { phone: true }),
  sceneClaude: publicView({ root: { id: "claude:sess-ship", source: "claude", name: "Claude · billing-api · 1a2b", turnStates: [], activities: [], latest: null },
    agents: [claudeSession], requests: [] }, { phone: true }),
  thread: publicView({ thread: codexChat, checkedAt: NOW }, { phone: true }),
  threads: publicView({ threads: [{ id: "chat-ship-0001", name: "Ship CSV export", updatedAt: NOW, source: "codex", status: "idle" }], unavailable: [], watched: [] }, { phone: true }),
  requests: { requests: publicRequests(requests, { phone: true }) },
  mobile: mobileStatus({ local: false, state: { enabled: true, listening: true, url: "http://192.168.1.20:43917", adapter: "Wi-Fi", problem: "" }, code: "ABCD2345" }),
});

test("no phone route carries the words of a question an agent asked", () => {
  for (const [route, body] of Object.entries(phoneRoutes())) {
    const text = JSON.stringify(body);
    for (const words of [...ASKED, STRIPE, "ABCD2345"]) assert.ok(!text.includes(words), `${route} leaked "${words}": ${text}`);
  }
});

test("a phone keeps the count of questions, the rest of each reply, and what its page needs to work", () => {
  const routes = phoneRoutes();
  const chat = routes.sceneAll.agents[0];
  assert.deepEqual(chat.turnStates[1].questions, ["Asked you a question", "Asked you a question"]);
  assert.deepEqual(chat.turnStates[0].questions, []);
  // Two questions in a row, and the options between them, read as one line.
  assert.equal(chat.activities[1].description, "The export works and all 42 tests pass.\n(Asked you a question: see it on this computer.)");
  assert.equal(chat.latest.description, chat.activities[1].description);
  assert.equal(chat.activities[0].detail, "npm test", "a Codex command line is still shown");
  assert.equal("output" in chat.activities[0], false);
  assert.deepEqual(Object.keys(chat.ask).sort(), ["answerHere", "at", "key", "kind"]);
  assert.equal(routes.sceneAll.agents[1].activities[0].description, "Renamed the column.\n(Asked you a question: see it on this computer.)");
  assert.equal(routes.sceneAll.agents[1].turnStates[0].questions.length, 1);
  assert.equal(routes.sceneAll.agents[2].activities[0].description, "Asked you a question.");
  assert.equal(routes.sceneClaude.agents[0].latest.description, routes.sceneAll.agents[1].activities[0].description);
  assert.equal(routes.thread.thread.turnStates[1].questions.length, 2);
  assert.equal(routes.sceneParty.root.activities[1].description, chat.activities[1].description);
  // Requests: kinds, ids, and times; an approval's command (filtered) or folder, never its reason; a question's count only.
  for (const shown of [routes.requests.requests, routes.sceneParty.requests]) {
    const [command, files, question] = shown;
    assert.deepEqual(command, { id: 7, method: "item/commandExecution/requestApproval", receivedAt: NOW, summaryOnly: true,
      params: { threadId: "chat-ship-0001", turnId: "t3", itemId: "c9", command: "deploy --token [secret removed]", networkApprovalContext: { host: "files.example.test" } } });
    assert.deepEqual(files.params, { threadId: "chat-ship-0001", itemId: "f1", grantRoot: "C:\\work\\billing-api" });
    assert.deepEqual(question.params, { threadId: "chat-ship-0001", turnId: "t3", itemId: "q1", questionCount: 1 });
    assert.equal(question.summaryOnly, true);
  }
  assert.deepEqual(routes.mobile, { local: false, enabled: true, available: true, address: "http://192.168.1.20:43917", adapter: "Wi-Fi", problem: "" });
  assert.equal(routes.threads.threads[0].name, "Ship CSV export");
  // The server's own copies are untouched.
  assert.equal(codexChat.turnStates[1].questions[0], "Ship the CSV export to staging now?");
  assert.equal(requests[2].params.questions[0].options.length, 2);
});

test("this computer still gets every question, reason, and option, filtered", () => {
  const local = publicView({ root: codexChat, agents: [codexChat, feedAgent], requests }, { phone: false });
  assert.equal(local.root.turnStates[1].questions[1], "Which region should it use?");
  assert.match(local.root.activities[1].description, /Which region should it use\?\n- eu-west/);
  assert.equal(local.agents[1].activities[0].description, "Rotate the signing key tonight.");
  assert.equal(local.requests[0].params.reason, "Needs network access to upload the export.");
  assert.equal(local.requests[0].params.command, "deploy --token [secret removed]");
  assert.equal(local.requests[2].params.questions[0].options[0].label, "Postgres");
  assert.equal("summaryOnly" in local.requests[0], false);
  assert.equal(mobileStatus({ local: true, state: { enabled: true, listening: true, url: "u", adapter: "a", problem: "" }, code: "ABCD2345" }).code, "ABCD2345");
});

test("a phone approves or declines, but Codex's questions are answered on this computer only", () => {
  const [approval, , question] = requests;
  assert.deepEqual(requestAnswer(approval, { decision: "accept" }, { local: false }), { result: { decision: "accept" } });
  assert.equal(requestAnswer(approval, { decision: "maybe" }, { local: false }).status, 400);
  assert.deepEqual(requestAnswer(question, { answers: { db: "Postgres" } }, { local: false }),
    { status: 409, error: "Answer Codex's questions on this computer. A phone is not sent them." });
  assert.deepEqual(requestAnswer(question, { answers: { db: " Postgres " } }, { local: true }), { result: { answers: { db: { answers: ["Postgres"] } } } });
  assert.equal(requestAnswer(question, { answers: {} }, { local: true }).status, 400);
  assert.equal(requestAnswer({ method: "item/other" }, {}, { local: true }).status, 400);
});

test("a reply's questions are cut line by line, and ordinary lines stay", () => {
  assert.equal(withoutQuestions("All done."), "All done.");
  assert.equal(withoutQuestions("Fixed it.\nWant me to push?"), "Fixed it.\n(Asked you a question: see it on this computer.)");
  assert.equal(withoutQuestions("Which layout? Options:\n1. Compact\n2. Spacious\nI lean compact."), "(Asked you a question: see it on this computer.)\nI lean compact.");
  assert.equal(withoutQuestions("He said \"is it ready?\"\nYes."), "(Asked you a question: see it on this computer.)\nYes.");
  assert.equal(withoutQuestions("See https://example.test/?q=1 for details."), "See https://example.test/?q=1 for details.");
  assert.equal(withoutQuestions(""), "");
});
