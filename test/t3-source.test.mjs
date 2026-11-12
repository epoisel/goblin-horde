import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advance, defaultT3Path, initialWatermark, openT3, readFinished, t3Source, unseen } from "../lib/t3-source.mjs";
import { createT3Fixture, hasSqlite, TRAP, usage } from "./helpers/t3-fixture.mjs";

const needsSqlite = { skip: !hasSqlite && "this Node.js has no node:sqlite" };
const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 10, 12);
const sentence = /^[A-Z].+\.$/;

async function opened(t, fixture) {
  const result = await openT3(fixture.path);
  assert.ok(result.ok, result.message);
  t.after(() => {
    result.db.close();
    fixture.close();
  });
  return result.db;
}

test("T3's database lives in the user's .t3 folder", () => {
  assert.equal(defaultT3Path(join("home", "goblin")), join("home", "goblin", ".t3", "userdata", "statev2.sqlite"));
});

test("readFinished returns finished turns and subagents oldest first, skips running rows and rows before the slack, and stops at the limit", needsSqlite, async (t) => {
  const fixture = createT3Fixture();
  fixture.addTurn({ id: "late", completedAt: T0 + 3 * MIN });
  fixture.addSubagent({ id: "helper", completedAt: T0 + 2 * MIN });
  fixture.addTurn({ id: "early", completedAt: T0 + MIN, status: "failed" });
  fixture.addTurn({ id: "inside-slack", completedAt: T0 - 9 * MIN, status: "interrupted" });
  fixture.addTurn({ id: "before-slack", completedAt: T0 - 11 * MIN });
  fixture.addTurn({ id: "running", completedAt: null, status: "running" });
  fixture.addSubagent({ id: "still-going", completedAt: null, status: "running" });
  fixture.addSubagent({ id: "dropped", completedAt: T0 + 4 * MIN, status: "cancelled" });
  const db = await opened(t, fixture);

  const events = readFinished(db, T0, { slackMs: 10 * MIN });
  assert.deepEqual(events.map(({ kind, at, outcome }) => ({ kind, at, outcome })), [
    { kind: "turn", at: T0 - 9 * MIN, outcome: "interrupted" },
    { kind: "turn", at: T0 + MIN, outcome: "failed" },
    { kind: "subagent", at: T0 + 2 * MIN, outcome: "subagent" },
    { kind: "turn", at: T0 + 3 * MIN, outcome: "completed" },
    { kind: "subagent", at: T0 + 4 * MIN, outcome: "cancelled" },
  ]);
  assert.equal(new Set(events.map((event) => event.id)).size, events.length, "every event has its own id");
  assert.deepEqual(readFinished(db, T0, { slackMs: 10 * MIN }), events, "the same rows read the same way twice");
  assert.deepEqual(readFinished(db, T0, { slackMs: 10 * MIN, limit: 2 }), events.slice(0, 2));
});

test("rows that finish at the same moment keep one fixed order", needsSqlite, async (t) => {
  const fixture = createT3Fixture();
  for (const id of ["c", "a", "b"]) fixture.addTurn({ id, completedAt: T0 + MIN });
  fixture.addSubagent({ id: "a", completedAt: T0 + MIN });
  const db = await opened(t, fixture);
  const ids = readFinished(db, T0).map((event) => event.id);
  assert.equal(new Set(ids).size, 4, "a turn and a subagent with the same T3 id stay apart");
  assert.deepEqual(readFinished(db, T0, { limit: 2 }).map((event) => event.id), ids.slice(0, 2));
});

test("token counts come only from complete usage, and only as numbers", needsSqlite, async (t) => {
  const fixture = createT3Fixture();
  fixture.addTurn({ id: "complete", completedAt: T0 + MIN, tokens: usage(60_000, 2_000, 10_000) });
  fixture.addTurn({ id: "partial", completedAt: T0 + 2 * MIN, tokens: usage(60_000, 2_000, 10_000, "partial") });
  fixture.addTurn({ id: "unavailable", completedAt: T0 + 3 * MIN, tokens: { usageStatus: "unavailable" } });
  fixture.addTurn({ id: "none", completedAt: T0 + 4 * MIN, tokens: null });
  fixture.addTurn({ id: "text", completedAt: T0 + 5 * MIN, tokens: { ...usage(60_000, 2_000), outputTokens: TRAP.secret } });
  const db = await opened(t, fixture);
  const tokens = readFinished(db, T0).map(({ inputTokens, cachedInputTokens, outputTokens }) => ({ inputTokens, cachedInputTokens, outputTokens }));
  const none = { inputTokens: undefined, cachedInputTokens: undefined, outputTokens: undefined };
  assert.deepEqual(tokens, [
    { inputTokens: 60_000, cachedInputTokens: 10_000, outputTokens: 2_000 },
    none,
    none,
    none,
    { inputTokens: 60_000, cachedInputTokens: 0, outputTokens: undefined },
  ]);
});

test("no payload text, title, or id label leaves the reader", needsSqlite, async (t) => {
  const fixture = createT3Fixture();
  fixture.addTurn({ id: "work", completedAt: T0 + MIN });
  fixture.addSubagent({ id: "helper", completedAt: T0 + 2 * MIN });
  const db = await opened(t, fixture);
  const text = JSON.stringify(readFinished(db, T0));
  for (const trap of Object.values(TRAP)) assert.ok(!text.includes(trap), `"${trap}" stayed in T3`);
  assert.ok(!text.includes("provider-turn") && !text.includes("subagent:"), "raw T3 ids stay in T3");
});

test("openT3 reports a missing database and a changed schema in a plain sentence instead of throwing", needsSqlite, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "goblin-t3-missing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const missing = await openT3(join(dir, "statev2.sqlite"));
  assert.deepEqual({ ok: missing.ok, reason: missing.reason }, { ok: false, reason: "missing" });
  assert.match(missing.message, sentence);

  const drifted = createT3Fixture({ omit: ["orchestration_v2_projection_subagents.completed_at"] });
  t.after(() => drifted.close());
  const schema = await openT3(drifted.path);
  assert.deepEqual({ ok: schema.ok, reason: schema.reason }, { ok: false, reason: "schema" });
  assert.match(schema.message, sentence);
  assert.match(schema.message, /orchestration_v2_projection_subagents\.completed_at/);
});

test("a source opens T3's database once it appears, and every read returns only unpaid events", needsSqlite, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "goblin-t3-later-"));
  const source = t3Source(join(dir, "statev2.sqlite"), { now: () => T0 + 10 * MIN });
  let fixture = null;
  t.after(() => {
    source.close();
    fixture?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const before = await source.read(initialWatermark(T0));
  assert.equal(before.reason, "missing");

  fixture = createT3Fixture({ dir });
  fixture.addTurn({ id: "first", completedAt: T0 + MIN });
  const first = await source.read(initialWatermark(T0));
  assert.ok(first.ok);
  assert.equal(first.events.length, 1);
  assert.deepEqual(first.watermark, { at: T0 + MIN, seen: [first.events[0].id] });

  fixture.addTurn({ id: "second", completedAt: T0 + 2 * MIN });
  const second = await source.read(first.watermark);
  assert.deepEqual(second.events.map((event) => event.at), [T0 + 2 * MIN]);
  assert.deepEqual((await source.read(second.watermark)).events, []);
});

test("a source does not stall or repeat when more rows than its limit finish inside one slack window", needsSqlite, async (t) => {
  const fixture = createT3Fixture();
  for (let index = 0; index < 7; index += 1) fixture.addTurn({ id: `burst-${index}`, completedAt: T0 + MIN });
  const source = t3Source(fixture.path, { now: () => T0 + 10 * MIN, limit: 3 });
  t.after(() => {
    source.close();
    fixture.close();
  });
  let watermark = initialWatermark(T0);
  const paid = [];
  for (let read = 0; read < 5; read += 1) {
    const result = await source.read(watermark);
    paid.push(...result.events.map((event) => event.id));
    watermark = result.watermark;
  }
  assert.equal(paid.length, 7);
  assert.equal(new Set(paid).size, 7);
});

test("unseen drops events already paid, and advance keeps the seen set to the slack window", () => {
  const slackMs = 10 * MIN;
  const event = (id, at) => ({ id, kind: "turn", at, outcome: "completed" });
  let watermark = initialWatermark(T0);
  const rows = [];
  let largest = 0;
  for (let minute = 1; minute <= 600; minute += 1) {
    rows.push(event(`turn-${minute}`, T0 + minute * MIN));
    const read = rows.filter((row) => row.at > watermark.at - slackMs);
    assert.deepEqual(unseen(watermark, read).map((row) => row.id), [`turn-${minute}`], `minute ${minute} pays once`);
    watermark = advance(watermark, read, { now: T0 + minute * MIN, slackMs });
    largest = Math.max(largest, watermark.seen.length);
  }
  assert.equal(watermark.at, T0 + 600 * MIN);
  assert.ok(largest <= 10, `seen grew to ${largest} ids`);
});

test("advance never moves the watermark past now or backwards", () => {
  const watermark = { at: T0, seen: [] };
  const ahead = advance(watermark, [{ id: "future", at: T0 + 60 * MIN }], { now: T0 + MIN });
  assert.deepEqual(ahead, { at: T0 + MIN, seen: ["future"] }, "a row stamped ahead of the clock is kept as seen");
  assert.deepEqual(advance(watermark, [{ id: "older", at: T0 - MIN }], { now: T0 + MIN }), { at: T0, seen: ["older"] });
  assert.deepEqual(advance(watermark, [], { now: T0 + MIN }), watermark);
});
