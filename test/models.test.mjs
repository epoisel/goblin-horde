import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanModelId, describeModel, modelFamily, modelLabel } from "../lib/models.mjs";
import { buildClaudeSessions, normalizeHookEvent, transcriptModel } from "../lib/claude.mjs";
import { buildExtensionParties, validateExtensionRecord } from "../lib/extension.mjs";
import { transformThread } from "../lib/transform.mjs";

const NOW = 1_800_000_000_000;

test("model ids become short badge labels", () => {
  const cases = {
    "claude-opus-5-5": "Opus 5.5",
    "claude-sonnet-4-5-20250929": "Sonnet 4.5",
    "claude-3-5-haiku-20241022": "Haiku 3.5",
    "claude-opus-4-1": "Opus 4.1",
    "claude-fable-5-1": "Fable 5.1",
    "us.anthropic.claude-sonnet-4-5-20250929-v1:0": "Sonnet 4.5",
    "claude-opus-5-5[1m]": "Opus 5.5 1M",
    "gpt-5.6-sol": "GPT-5.6 Sol",
    "gpt-5-codex": "GPT-5 Codex",
    "gpt-4o-mini": "GPT-4o mini",
    "o3": "o3",
    "o4-mini": "o4 mini",
    "llama-3.1-70b": "llama-3.1-70b",
  };
  for (const [id, label] of Object.entries(cases)) assert.equal(modelLabel(id), label, id);
});

test("families pick the goblin tribe from the id, then the provider", () => {
  assert.equal(modelFamily("claude-opus-5-5"), "claude");
  assert.equal(modelFamily("us.anthropic.claude-sonnet-4-5-20250929-v1:0"), "claude");
  assert.equal(modelFamily("gpt-5.6-sol"), "openai");
  assert.equal(modelFamily("o3"), "openai");
  assert.equal(modelFamily("my-house-model", "anthropic"), "claude");
  assert.equal(modelFamily("my-house-model", "openai"), "openai");
  assert.equal(modelFamily("llama-3.1-70b"), "other");
});

test("unsafe or missing ids describe no model; effort is kept only when known", () => {
  assert.equal(cleanModelId("<synthetic>"), "");
  assert.equal(cleanModelId("rm -rf /"), "");
  assert.equal(describeModel(""), null);
  assert.equal(describeModel(undefined), null);
  assert.deepEqual(describeModel("gpt-5.6-sol", { provider: "openai", effort: "xhigh" }),
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", family: "openai", effort: "xhigh" });
  assert.equal("effort" in describeModel("gpt-5.6-sol", { effort: "turbo" }), false);
});

test("Codex threads carry their model and reasoning effort", () => {
  const actor = transformThread({ id: "t", model: "gpt-5.6-sol", modelProvider: "openai", reasoningEffort: "high", turns: [] });
  assert.deepEqual(actor.model, { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", family: "openai", effort: "high" });
  assert.equal(transformThread({ id: "t", turns: [] }).model, null);
});

test("Claude sessions name the model from SessionStart and keep the newest one", () => {
  const session = "a1b2c3d4-0000-4000-8000-00000000000a";
  const hooks = [
    { hook_event_name: "SessionStart", session_id: session, source: "startup", model: "claude-sonnet-4-5" },
    { hook_event_name: "UserPromptSubmit", session_id: session },
    { hook_event_name: "PreToolUse", session_id: session, tool_name: "Read", tool_use_id: "t1", model: { id: "claude-opus-5-5", display_name: "Opus" } },
  ];
  const records = hooks.map((input, index) => normalizeHookEvent(input, { now: NOW + index, id: `${index}`.padStart(12, "0") }));
  assert.equal(records[0].model, "claude-sonnet-4-5");
  const [party] = buildClaudeSessions(records, { now: NOW + 10 });
  assert.equal(party.agents[0].model.label, "Opus 5.5");
  assert.equal(party.agents[0].model.family, "claude");
});

test("the hook reads only the model id from the newest end of a transcript, including a subagent's own", () => {
  const dir = mkdtempSync(join(tmpdir(), "goblin-models-"));
  try {
    const main = join(dir, "sess.jsonl");
    writeFileSync(main, [
      JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-4-5", content: [{ type: "text", text: "\"model\":\"gpt-fake\"" }] } }),
      JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5", content: [] } }),
      JSON.stringify({ type: "assistant", message: { model: "<synthetic>", content: [] } }),
    ].join("\n"));
    mkdirSync(join(dir, "sess", "subagents"), { recursive: true });
    writeFileSync(join(dir, "sess", "subagents", "agent-abc123.jsonl"), JSON.stringify({ type: "assistant", message: { model: "claude-haiku-4-5" } }));
    assert.equal(transcriptModel({ hook_event_name: "Stop", transcript_path: main }), "claude-opus-5-5");
    assert.equal(transcriptModel({ hook_event_name: "PreToolUse", transcript_path: main, agent_id: "abc123" }), "claude-haiku-4-5");
    assert.equal(transcriptModel({ hook_event_name: "Notification", transcript_path: main }), "", "only events after a reply look");
    assert.equal(transcriptModel({ hook_event_name: "Stop", transcript_path: join(dir, "missing.jsonl") }), "");
    assert.equal(transcriptModel({ hook_event_name: "Stop", transcript_path: join(dir, "notes.txt") }), "");
    // A "model" inside a tool call or its result is never mistaken for the assistant's own.
    const tools = join(dir, "tools.jsonl");
    writeFileSync(tools, [
      JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5", content: [{ type: "tool_use", input: { model: "haiku" } }] } }),
      JSON.stringify({ type: "user", toolUseResult: { model: "my-private-codename" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", input: { model: "sonnet" } }] } }),
    ].join("\n"));
    assert.equal(transcriptModel({ hook_event_name: "Stop", transcript_path: tools }), "claude-opus-5-5");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("extension feeds may name a model", () => {
  const { record } = validateExtensionRecord({ v: 1, feed: "relay", at: NOW - 1000, party: "p1", agent: "a1", event: "start", model: "gpt-5-codex" }, { now: NOW });
  assert.equal(record.model, "gpt-5-codex");
  const [party] = buildExtensionParties([record], { now: NOW });
  assert.equal(party.agents[0].model.label, "GPT-5 Codex");
  const bad = validateExtensionRecord({ v: 1, feed: "relay", at: NOW - 1000, party: "p1", agent: "a1", event: "start", model: "rm -rf /" }, { now: NOW });
  assert.equal("model" in bad.record, false);
});
