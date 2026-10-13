import test from "node:test";
import assert from "node:assert/strict";
import { APPROVAL_QUIET_MS, looksLikeApprovalWait } from "../lib/rollout.mjs";
import { markAwaitingApproval, transformThread } from "../lib/transform.mjs";

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
