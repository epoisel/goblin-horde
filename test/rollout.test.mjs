import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPROVAL_QUIET_MS, looksLikeApprovalWait, rolloutAwaitsApproval, withApprovalGuess } from "../lib/rollout.mjs";
import { markAwaitingApproval, markRunningElsewhere, transformThread } from "../lib/transform.mjs";
import { classifyCodex, planCodexReads } from "../lib/feed.mjs";

const NOW = Date.parse("2026-10-13T10:40:00Z");
const at = (secondsAgo) => new Date(NOW - secondsAgo * 1000).toISOString();
const line = (secondsAgo, type, payload = {}) => JSON.stringify({ timestamp: at(secondsAgo), type, payload });
const context = (policy, secondsAgo = 120) => line(secondsAgo, "turn_context", { approval_policy: policy });
const call = (secondsAgo, id = "c1") => line(secondsAgo, "response_item", { type: "custom_tool_call", call_id: id, name: "exec" });
const output = (secondsAgo, id = "c1") => line(secondsAgo, "response_item", { type: "custom_tool_call_output", call_id: id });
const finished = (secondsAgo) => line(secondsAgo, "event_msg", { type: "item_completed" });
const usage = (secondsAgo) => line(secondsAgo, "token_usage_record");

test("a quiet unanswered tool call under a policy that asks looks like an approval wait", () => {
  const text = [context("untrusted"), call(90), usage(90)].join("\n");
  assert.equal(looksLikeApprovalWait(text, { now: NOW }), true);
  assert.equal(looksLikeApprovalWait([context({ granular: { rules: true } }), call(90)].join("\n"), { now: NOW }), true);
});

test("no guess while the chat is still writing, once the call has an answer, or when the policy never asks", () => {
  const quiet = (APPROVAL_QUIET_MS / 1000) - 5;
  assert.equal(looksLikeApprovalWait([context("on-request"), call(quiet)].join("\n"), { now: NOW }), false, "too soon");
  assert.equal(looksLikeApprovalWait([context("on-request"), call(90), output(80)].join("\n"), { now: NOW }), false, "answered");
  assert.equal(looksLikeApprovalWait([context("on-request"), call(90), finished(85)].join("\n"), { now: NOW }), false, "a step ran");
  assert.equal(looksLikeApprovalWait([context("never"), call(90)].join("\n"), { now: NOW }), false, "never asks");
  assert.equal(looksLikeApprovalWait(call(90), { now: NOW }), false, "policy unknown in this part of the file");
});

test("a newer call reopens the wait, and a cut first line is skipped", () => {
  const text = ['"payload":{"type":"custom_tool_call"', context("untrusted"), call(200, "a"), output(190, "a"), call(100, "b")].join("\n");
  assert.equal(looksLikeApprovalWait(text, { now: NOW }), true);
});

test("a chat that looks held on an approval needs the person and says why", () => {
  const actor = markAwaitingApproval(transformThread({ id: "t", turns: [] }));
  assert.equal(actor.needsInput, true);
  assert.equal(actor.awaitingApproval, true);
  assert.equal(actor.latest.title, "Waiting for approval?");
  assert.match(actor.latest.description, /long-running command can look the same/);
});

test("a long turn's approval wait is still found 30 minutes on, with its policy far back in the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "goblin-rollout-"));
  try {
    const file = join(dir, "rollout-2026-10-13.jsonl");
    // The policy, then ~320 KB of finished steps, then a call that has waited half an hour.
    const steps = [];
    for (let index = 0; steps.join("\n").length < 320 * 1024; index++) {
      steps.push(call(3600, `s${index}`), line(3600, "response_item", { type: "custom_tool_call_output", call_id: `s${index}`, output: "x".repeat(400) }));
    }
    const rollout = (policy) => `${[context(policy, 4000), ...steps, call(30 * 60, "held")].join("\n")}\n`;
    writeFileSync(file, rollout("on-request"));
    assert.equal(rolloutAwaitsApproval(file, { now: NOW }), true);
    // The chat's own timestamp froze when the call was made: past the 10-minute running window.
    const thread = { id: "chat-held01", updatedAt: (NOW - 30 * 60_000) / 1000, path: file,
      turns: [{ id: "t1", status: "interrupted", completedAt: null, items: [] }] };
    const actor = withApprovalGuess(markRunningElsewhere(transformThread(thread), { now: NOW }), file, { now: NOW });
    assert.equal(actor.awaitingApproval, true);
    assert.equal(classifyCodex(actor, { hasRequest: actor.awaitingApproval, now: NOW }), "needs");
    // It stays a chat that is read (and so rechecked) although it changed more than 15 minutes ago.
    const record = { id: actor.id, updatedAt: actor.updatedAt, checkedAt: NOW - 10_000, attention: "needs", thread: actor };
    const plan = planCodexReads([{ id: actor.id, updatedAt: actor.updatedAt, source: "codex" }], { now: NOW, cache: new Map([[actor.id, record]]) });
    assert.deepEqual(plan.reads.map((item) => item.id), [actor.id]);
    // A policy that never asks, found just as far back, is still not a wait.
    writeFileSync(file, rollout("never"));
    assert.equal(rolloutAwaitsApproval(file, { now: NOW }), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("only an open turn is checked, and a call left open for many hours is not a wait", () => {
  let asked = 0;
  const awaits = () => { asked++; return true; };
  const closed = transformThread({ id: "c", turns: [{ id: "t", status: "completed", completedAt: 1, items: [] }] });
  assert.equal(withApprovalGuess(closed, "x.jsonl", { awaits }).awaitingApproval, undefined);
  const live = transformThread({ id: "c", turns: [{ id: "t", status: "inProgress", completedAt: null, items: [] }] });
  assert.equal(withApprovalGuess(live, "x.jsonl", { awaits }).awaitingApproval, undefined, "this app-server sees its own requests");
  assert.equal(asked, 0);
  assert.equal(looksLikeApprovalWait([context("on-request", 8 * 3600), call(7 * 3600)].join("\n"), { now: NOW }), false);
});

test("a far-back approval policy is found once, then remembered instead of reread every check", async () => {
  const { rolloutAwaitsApproval } = await import("../lib/rollout.mjs");
  const reads = [];
  const near = [call(90), usage(90)].join("\n");
  const whole = [context("on-request"), "x".repeat(10), call(90), usage(90)].join("\n");
  const readTail = (_path, bytes) => { reads.push(bytes); return bytes > 256 * 1024 ? whole : near; };
  let size = 5_000_000;
  const sizeOf = () => size;
  assert.equal(rolloutAwaitsApproval("C:/s/far-policy.jsonl", { now: NOW, readTail, sizeOf }), true);
  const first = reads.length;
  assert.ok(first > 1, "the first check looks further back");
  reads.length = 0;
  size += 1000; // The session file grew.
  assert.equal(rolloutAwaitsApproval("C:/s/far-policy.jsonl", { now: NOW, readTail, sizeOf }), true);
  assert.deepEqual(reads, [256 * 1024], "later checks read only the newest part");
  // A file that shrank was replaced: look again.
  size = 10;
  reads.length = 0;
  rolloutAwaitsApproval("C:/s/far-policy.jsonl", { now: NOW, readTail, sizeOf });
  assert.ok(reads.length > 1);
});
