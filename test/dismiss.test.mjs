import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DISMISS_LIMITS, DismissStore, settleActor, settleView } from "../lib/dismiss.mjs";
import { appendClaudeRecord, buildClaudeSessions, normalizeHookEvent } from "../lib/claude.mjs";
import { makeAsk } from "../lib/asks.mjs";

const NOW = 1_800_000_000_000;
const tempDir = () => mkdtempSync(join(tmpdir(), "goblin-dismiss-"));
const SESSION = "d15m1550-0000-4000-8000-000000000001";

let counter = 0;
function claudeRecords(inputs, base = NOW) {
  return inputs.map(([event, extra, offset]) => normalizeHookEvent({ hook_event_name: event, session_id: SESSION, cwd: "/work/billing-api", ...extra },
    { now: base + offset, id: (0x9000 + ++counter).toString(16).padStart(12, "0") }));
}
const asking = (base = NOW) => claudeRecords([
  ["UserPromptSubmit", {}, 0],
  ["PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_D1", tool_input: { command: "make deploy" } }, 1],
  ["PermissionRequest", { tool_name: "Bash", tool_use_id: "toolu_D1", tool_input: { command: "make deploy" } }, 2],
], base);

test("a dismissal is kept per ask, saved atomically, and read back after a restart", () => {
  const dir = tempDir();
  try {
    let clock = NOW;
    const store = new DismissStore({ dir, clock: () => clock });
    const item = store.dismiss("claude-agent:abc", "0123456789abcdef");
    assert.deepEqual(item, { id: "claude-agent:abc", key: "0123456789abcdef", at: NOW });
    assert.ok(store.isDismissed("claude-agent:abc", "0123456789abcdef"));
    assert.equal(store.isDismissed("claude-agent:abc", "fedcba9876543210"), null, "a new ask from the same agent is not dismissed");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "dismissed.json"), "utf8")), { items: [item] });
    assert.ok(!existsSync(join(dir, `dismissed.json.${process.pid}.tmp`)));
    const again = new DismissStore({ dir, clock: () => clock });
    assert.ok(again.isDismissed("claude-agent:abc", "0123456789abcdef"));
    // A week later it is forgotten, and pruned from the file on the next change.
    clock = NOW + DISMISS_LIMITS.keepMs + 1;
    assert.equal(again.isDismissed("claude-agent:abc", "0123456789abcdef"), null);
    again.dismiss("orca-agent:1:2", "aaaaaaaaaaaaaaaa");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "dismissed.json"), "utf8")).items.map((entry) => entry.id), ["orca-agent:1:2"]);
    // Bad ids and keys are refused; junk in the file is skipped.
    assert.throws(() => again.dismiss("../../etc", "0123456789abcdef"), (error) => error.statusCode === 400);
    assert.throws(() => again.dismiss("claude-agent:abc", "not-a-key"), (error) => error.statusCode === 400);
    writeFileSync(join(dir, "dismissed.json"), JSON.stringify({ items: [{ id: "<script>", key: "zz", at: 1 }, { id: "chat-0001", key: "abcdefabcdefabcd", at: clock }] }));
    assert.deepEqual([...new DismissStore({ dir, clock: () => clock }).items.values()].map((entry) => entry.id), ["chat-0001"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("dismissals are capped, oldest first, and a folder that cannot be written keeps them for this run", () => {
  const dir = tempDir();
  try {
    let clock = NOW;
    const store = new DismissStore({ dir, clock: () => clock++ });
    for (let index = 0; index < DISMISS_LIMITS.items + 20; index++) store.dismiss(`chat-${String(index).padStart(6, "0")}`, "0123456789abcdef");
    assert.equal(store.items.size, DISMISS_LIMITS.items);
    assert.equal(store.isDismissed("chat-000000", "0123456789abcdef"), null);
    assert.ok(store.isDismissed(`chat-${String(DISMISS_LIMITS.items + 19).padStart(6, "0")}`, "0123456789abcdef"));
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "");
    const stuck = new DismissStore({ dir: join(blocked, "inner"), clock: () => NOW });
    assert.doesNotThrow(() => stuck.dismiss("chat-000001", "0123456789abcdef"));
    assert.ok(stuck.isDismissed("chat-000001", "0123456789abcdef"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a dismissed ask leaves the actor quiet or working, and a new ask alerts again", () => {
  const [session] = buildClaudeSessions(asking(), { now: NOW + 5000 });
  const actor = session.agents[0];
  assert.equal(actor.attention, "needs");
  const dismissed = new Map([[`${actor.id}\n${actor.ask.key}`, { at: NOW + 6000 }]]);
  const isDismissed = (id, key) => dismissed.get(`${id}\n${key}`) || null;
  const quiet = settleActor(actor, { isDismissed, now: NOW + 7000 });
  assert.equal(quiet.ask, null);
  assert.deepEqual(quiet.dismissedAsk, { key: actor.ask.key, at: NOW + 6000 });
  assert.equal(quiet.attention, "working", "the turn is still going");
  assert.equal(quiet.needsInput, false);
  assert.equal(quiet.status, "active");
  assert.equal(actor.ask.kind, "permission", "the source's own actor is not changed");
  // A later, different ask from the same goblin alerts again.
  const more = claudeRecords([
    ["PostToolUse", { tool_name: "Bash", tool_use_id: "toolu_D1", tool_input: { command: "make deploy" } }, 3],
    ["PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_D2", tool_input: { command: "make release" } }, 4],
    ["PermissionRequest", { tool_name: "Bash", tool_use_id: "toolu_D2", tool_input: { command: "make release" } }, 5],
  ]);
  const next = buildClaudeSessions([...asking(), ...more], { now: NOW + 9000 })[0].agents[0];
  const alerted = settleActor(next, { isDismissed, now: NOW + 9000 });
  assert.equal(alerted.attention, "needs");
  assert.equal(alerted.ask.command, "make release");

  // A finished reply's question, once dismissed, is history.
  const reply = { id: "chat-0001", source: "codex", status: "notLoaded", updatedAt: NOW, attention: "needs", needsInput: true,
    turnStates: [{ id: "t", status: "completed", questions: ["Ship it?"] }], ask: makeAsk("chat-0001", { kind: "reply", text: "Ship it?", at: NOW, answerHere: "reply" }) };
  const settledReply = settleActor(reply, { isDismissed: () => ({ at: NOW + 1 }), now: NOW + 2 });
  assert.equal(settledReply.attention, "quiet");
  assert.deepEqual(settledReply.turnStates.at(-1).questions, []);
});

test("every source is held to one rule: needs-you exactly when an undismissed ask remains", () => {
  const orcaAsk = makeAsk("orca-agent:1:2", { kind: "question", text: "Which branch?", at: NOW });
  const scene = {
    root: { id: "all", source: "all" },
    agents: [
      { id: "orca-agent:1:2", source: "orca", status: "working", updatedAt: NOW, attention: "working", ask: orcaAsk },
      { id: "ext-agent:relay:p:a", source: "extension", status: "waiting", updatedAt: NOW, attention: "needs", needsInput: true,
        turnStates: [{ id: "t", status: "inProgress", questions: ["Approve the plan?"] }], ask: makeAsk("ext-agent:relay:p:a", { kind: "question", text: "Approve the plan?", at: NOW }) },
      // Needs-you with nothing to show is not needs-you.
      { id: "chat-0002", source: "codex", status: "active", updatedAt: NOW, attention: "needs", turnStates: [{ id: "t", status: "inProgress", questions: [] }], ask: null },
      // An ask without a key gets one.
      { id: "claude-agent:s", source: "claude", status: "active", updatedAt: NOW, attention: "working", turnStates: [], ask: { kind: "permission", text: "Allow Bash to run this command?", at: NOW } },
    ],
  };
  const extensionKey = scene.agents[1].ask.key;
  const view = settleView(scene, { isDismissed: (id, key) => (id === "ext-agent:relay:p:a" && key === extensionKey ? { at: NOW } : null), now: NOW });
  const byId = Object.fromEntries(view.agents.map((agent) => [agent.id, agent]));
  assert.equal(byId["orca-agent:1:2"].attention, "needs");
  assert.equal(byId["ext-agent:relay:p:a"].ask, null);
  assert.equal(byId["ext-agent:relay:p:a"].attention, "working");
  assert.equal(byId["ext-agent:relay:p:a"].status, "active");
  assert.equal(byId["chat-0002"].attention, "working");
  assert.match(byId["claude-agent:s"].ask.key, /^[a-f0-9]{16}$/);
  assert.equal(byId["claude-agent:s"].attention, "needs");
  assert.equal(view.root, scene.root, "a root that asks nothing is left as it is");
  // A single chat's response is settled too.
  const thread = settleView({ thread: { id: "chat-0003", source: "codex", ask: makeAsk("chat-0003", { kind: "reply", text: "Ok?", at: NOW }) } }, { isDismissed: () => ({ at: NOW }) });
  assert.equal(thread.thread.ask, null);
});

async function freePort() {
  const probe = createServer(() => {});
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test("POST /api/dismiss quiets the alert on the next poll, survives a restart, and only this computer's page may send it", { timeout: 60_000 }, async () => {
  const root = tempDir();
  const state = join(root, "state");
  mkdirSync(join(state, "claude"), { recursive: true });
  const base = Date.now() - 5000;
  for (const record of asking(base)) appendClaudeRecord(record, { dir: join(state, "claude") });
  const port = await freePort();
  // No Codex, no Orca, every folder temporary, and a Wi-Fi address this computer does not have.
  const env = { ...process.env, PORT: String(port), GOBLIN_HORDE_STATE_DIR: state, LOCALAPPDATA: join(root, "local"), CLAUDE_CONFIG_DIR: join(root, "claude"),
    CODEX_HOME: join(root, "codex"), CODEX_CLI_PATH: join(root, "no-codex.exe"), ORCA_CLI_COMMAND: join(root, "no-orca"), LAN_IP: "10.255.255.254" };
  const server = join(fileURLToPath(new URL("..", import.meta.url)), "server.mjs");
  const url = `http://127.0.0.1:${port}`;
  const start = async () => {
    const child = spawn(process.execPath, [server], { env, stdio: "ignore", windowsHide: true });
    for (let tries = 0; ; tries++) {
      try { if ((await fetch(`${url}/api/health`)).ok) return child; } catch { /* Not up yet. */ }
      if (tries > 100) throw new Error("The viewer did not start.");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const stop = async (child) => {
    if (child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  };
  const goblin = async () => (await (await fetch(`${url}/api/scene?id=all`)).json()).agents.find((agent) => agent.id === `claude-agent:${SESSION}`);
  let child = await start();
  try {
    const before = await goblin();
    assert.equal(before.attention, "needs");
    assert.equal(before.ask.text, "Allow Bash to run this command?");
    assert.equal(before.ask.command, "make deploy");
    const post = (body, headers = { "Content-Type": "application/json", Origin: url }) => fetch(`${url}/api/dismiss`, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal((await post({ id: before.id, key: before.ask.key }, { "Content-Type": "application/json" })).status, 403, "another page cannot dismiss");
    assert.equal((await post({ id: before.id, key: "nope" })).status, 400);
    const answer = await post({ id: before.id, key: before.ask.key });
    assert.equal(answer.status, 200);
    const body = await answer.json();
    assert.equal(body.ask, null);
    assert.equal(body.dismissedAsk.key, before.ask.key);
    assert.equal(body.attention, "working");
    const after = await goblin();
    assert.equal(after.ask, null);
    assert.equal(after.attention, "working");
    assert.equal(after.dismissedAsk.key, before.ask.key);
    assert.ok(existsSync(join(state, "dismissed.json")));
    await stop(child);
    child = await start();
    assert.equal((await goblin()).ask, null, "the dismissal outlives a restart");
    // A new request from the same goblin alerts again.
    const more = claudeRecords([
      ["PostToolUse", { tool_name: "Bash", tool_use_id: "toolu_D1", tool_input: { command: "make deploy" } }, 3],
      ["PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_D3", tool_input: { command: "make clean" } }, 4],
      ["PermissionRequest", { tool_name: "Bash", tool_use_id: "toolu_D3", tool_input: { command: "make clean" } }, 5],
    ], base);
    for (const record of more) appendClaudeRecord(record, { dir: join(state, "claude") });
    let again = null;
    for (let tries = 0; tries < 40 && !again?.ask; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      again = await goblin();
    }
    assert.equal(again.attention, "needs");
    assert.equal(again.ask.command, "make clean");
  } finally {
    await stop(child);
    rmSync(root, { recursive: true, force: true });
  }
});
