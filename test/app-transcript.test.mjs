import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEntry, normalizeTool } from "../public/app/adapter.js";
import { STORE_LIMIT, TranscriptStore, effectiveTimes, formatBytes, formatDuration, insertionIndex, interleave, previewText, promptLabel,
  textSize, toolSummary } from "../public/app/transcript.js";

const entry = (id, fields = {}) => normalizeEntry({ id, kind: "message", text: `text ${id}`, at: 1_700_000_000_000 + Number(String(id).replace(/\D/g, "") || 0) * 1000, ...fields });
const page = (entries, extra = {}) => ({ entries, cursor: { first: entries[0]?.id || "", last: entries.at(-1)?.id || "" }, hasOlder: false, live: true, ...extra });
const ids = (store) => store.entries.map((item) => item.id);

test("a store takes the newest page, appends new entries, and patches changed ones in place", () => {
  const store = new TranscriptStore("agent-1");
  const seen = [];
  store.subscribe((change) => seen.push(change));
  const first = store.apply(page([entry("e1"), entry("e2")], { hasOlder: true, cursor: { first: "c-first", last: "c-last" } }), "initial");
  assert.deepEqual(first.added.map((item) => item.id), ["e1", "e2"]);
  assert.equal(first.reset, false);
  assert.deepEqual([store.first, store.last, store.hasOlder, store.loaded], ["c-first", "c-last", true, true]);

  const running = normalizeEntry({ id: "t1", kind: "tool", tool: { name: "shell", kind: "command", input: "npm test", status: "running" } });
  store.apply(page([running], { cursor: { last: "c2" } }), "after");
  const done = normalizeEntry({ id: "t1", kind: "tool", tool: { name: "shell", kind: "command", input: "npm test", status: "completed", exitCode: 0, output: "ok", durationMs: 900 } });
  const change = store.apply({ entries: [done, entry("e3")], cursor: { last: "c3" } }, "after");
  assert.deepEqual(change.changed.map((item) => item.id), ["t1"]);
  assert.deepEqual(change.added.map((item) => item.id), ["e3"]);
  assert.deepEqual(ids(store), ["e1", "e2", "t1", "e3"]);
  assert.equal(store.byId.get("t1").tool.status, "ok");
  assert.equal(store.last, "c3");
  // The same entry again, unchanged, is no news.
  const quiet = store.apply({ entries: [done], cursor: { last: "c4" } }, "after");
  assert.deepEqual([quiet.added.length, quiet.changed.length], [0, 0]);
  assert.equal(seen.length, 4);
});

test("older pages are prepended without duplicates; cursors fall back to entry ids", () => {
  const store = new TranscriptStore("agent-2");
  store.apply({ entries: [entry("e5"), entry("e6")], hasOlder: true }, "initial");
  assert.deepEqual([store.first, store.last], ["e5", "e6"]);
  const change = store.apply({ entries: [entry("e3"), entry("e4"), entry("e5")], hasOlder: false, cursor: { first: "older" } }, "before");
  assert.deepEqual(change.prepended.map((item) => item.id), ["e3", "e4"]);
  assert.deepEqual(ids(store), ["e3", "e4", "e5", "e6"]);
  assert.deepEqual([store.first, store.hasOlder], ["older", false]);
  // A fresh initial page replaces everything and says so.
  const reset = store.apply({ entries: [entry("e9")] }, "initial");
  assert.equal(reset.reset, true);
  assert.deepEqual(ids(store), ["e9"]);
});

test("a store keeps a bounded number of entries and marks the rest as older", () => {
  const store = new TranscriptStore("agent-3");
  store.apply({ entries: [entry("a0")] }, "initial");
  const many = Array.from({ length: STORE_LIMIT + 10 }, (_, index) => entry(`b${index + 1}`));
  const change = store.apply({ entries: many }, "after");
  assert.equal(store.entries.length, STORE_LIMIT);
  assert.equal(change.dropped, 11);
  assert.equal(store.hasOlder, true);
  assert.equal(store.first, store.entries[0].id);
});

test("a failed read keeps what was shown and reports the error", () => {
  const store = new TranscriptStore("agent-4");
  let last = null;
  store.subscribe((change) => { last = change; });
  store.apply({ entries: [entry("e1")] }, "initial");
  store.fail("The transcript moved.");
  assert.equal(store.error, "The transcript moved.");
  assert.equal(last.error, "The transcript moved.");
  assert.equal(store.entries.length, 1);
  store.apply({ entries: [] }, "after");
  assert.equal(store.error, "", "the next good read clears it");
});

test("the timeline interleaves agents by time, carrying times to entries without one", () => {
  assert.deepEqual(effectiveTimes([{ at: null }, { at: 5 }, { at: null }, { at: 9 }]), [5, 5, 5, 9]);
  const lists = [
    { agentId: "lead", entries: [{ id: "l1", at: 10 }, { id: "l2", at: 40 }, { id: "l3", at: null }] },
    { agentId: "worker", entries: [{ id: "w1", at: 20 }, { id: "w2", at: 40 }] },
  ];
  assert.deepEqual(interleave(lists).map((item) => `${item.agentId}:${item.entry.id}`), ["lead:l1", "worker:w1", "lead:l2", "lead:l3", "worker:w2"]);
  assert.equal(insertionIndex([1, 3, 3, 5], 3), 3);
  assert.equal(insertionIndex([], 7), 0);
  assert.equal(insertionIndex([1, 2], 9), 2);
});

test("tool rows read like the native apps: verb by status, target by kind", () => {
  const tool = (fields) => normalizeTool(fields);
  assert.deepEqual(pick(toolSummary(tool({ name: "shell", kind: "command", input: "npm test -- --runInBand", status: "running" }))), { verb: "Running", target: "npm test -- --runInBand", mono: true, exit: "", duration: "" });
  assert.deepEqual(pick(toolSummary(tool({ name: "shell", kind: "command", input: "npm test", status: "completed", exitCode: 1, durationMs: 212_480 }))),
    { verb: "Ran", target: "npm test", mono: true, exit: "exit 1", duration: "3m 32s" });
  const edit = toolSummary(tool({ name: "Edit", input: { file_path: "src/pay.ts" }, diff: "@@ -1,2 +1,3 @@\n-a\n+b\n+c\n d", status: "ok" }));
  assert.deepEqual([edit.verb, edit.target, edit.added, edit.removed, edit.icon], ["Edited", "src/pay.ts", 2, 1, "✎"]);
  const counted = toolSummary(tool({ name: "apply_patch", kind: "edit", files: [{ path: "a.ts", added: 3, removed: 1 }, { path: "b.ts", added: 2, removed: 0 }], status: "ok" }));
  assert.deepEqual([counted.target, counted.added, counted.removed], ["a.ts and 1 more", 5, 1]);
  assert.equal(toolSummary(tool({ name: "Grep", input: { pattern: "chargeCart\\(" }, status: "ok" })).target, "chargeCart\\(");
  assert.equal(toolSummary(tool({ name: "mcp__github__get_issue", input: { number: 4 }, status: "ok" })).target, "github · get_issue");
  assert.deepEqual(pick(toolSummary(tool({ name: "shell", kind: "command", input: "rm -rf build", status: "declined" }))).verb, "Not run:");
  // A title that already says what happened is shown as it is.
  const titled = toolSummary(tool({ name: "shell", kind: "command", title: "Ran the test suite", input: "npm test", status: "ok" }));
  assert.deepEqual([titled.verb, titled.target], ["", "Ran the test suite"]);
  assert.equal(toolSummary(tool({ name: "shell", kind: "command", input: "cd app\nnpm ci", status: "ok" })).more, true);
});

const pick = ({ verb, target, mono, exit, duration }) => ({ verb, target, mono, exit, duration });

test("prompt labels say who sent them", () => {
  const coordinator = { id: "c", name: "Checkout lead", role: "coordinator" };
  const plain = { id: "p", name: "Coordinator", role: "coordinator" };
  const lead = { id: "l", name: "Plan the rewrite", role: "lead" };
  const byId = new Map([[coordinator.id, coordinator], [plain.id, plain], [lead.id, lead]]);
  assert.equal(promptLabel({ from: "you" }), "You");
  assert.equal(promptLabel({ from: "coordinator" }, { agent: { parentId: "c" }, agentsById: byId }), "From the coordinator · Checkout lead");
  assert.equal(promptLabel({ from: "coordinator" }, { agent: { parentId: "p" }, agentsById: byId }), "From the coordinator");
  assert.equal(promptLabel({ from: "coordinator" }), "From the coordinator");
  assert.equal(promptLabel({ from: "parent" }, { agent: { parentId: "l" }, agentsById: byId }), "From Plan the rewrite");
  assert.equal(promptLabel({ from: "parent" }), "From the parent chat");
});

test("sizes, durations, and long-output previews", () => {
  assert.equal(formatDuration(0), "", "no measured time says nothing");
  assert.deepEqual([formatDuration(null), formatDuration(820), formatDuration(4200), formatDuration(72_000), formatDuration(7_500_000)], ["", "820 ms", "4.2 s", "1m 12s", "2h 5m"]);
  assert.deepEqual([formatBytes(512), formatBytes(14 * 1024), formatBytes(1.25 * 1024 * 1024)], ["512 B", "14 KB", "1.3 MB"]);
  assert.deepEqual(textSize("a\nb\n"), { lines: 2, bytes: 4 });
  const long = Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n");
  const preview = previewText(long, { lines: 200 });
  assert.equal(preview.shown.split("\n").length - 1, 200);
  assert.equal(preview.hiddenLines, 300);
  assert.deepEqual(previewText("short"), { shown: "short", hiddenLines: 0, hiddenBytes: 0 });
  const wide = previewText("x".repeat(100_000), { bytes: 1000 });
  assert.equal(wide.shown.length, 1000);
  assert.equal(wide.hiddenBytes, 99_000);
});
