import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXTENSION_LIMITS, ExtensionReader, appendExtensionRecord, buildExtensionFeed, buildExtensionParties, extensionAgentId, extensionPartyId,
  parseExtensionLines, validateExtensionRecord,
} from "../lib/extension.mjs";
import { composeAllScene } from "../lib/feed.mjs";

const NOW = 1_800_000_000_000;
const base = (fields) => ({ v: 1, feed: "relay", at: NOW - 60_000, party: "build-42", agent: "planner", ...fields });

test("only documented public fields are kept; raw commands and output are refused", () => {
  assert.equal(validateExtensionRecord(base({ event: "start" }), { now: NOW }).record.event, "start");
  for (const field of ["command", "output", "stdout", "prompt", "transcript"]) {
    const { record, errors } = validateExtensionRecord(base({ event: "step", step: "command", [field]: "rm -rf build" }), { now: NOW });
    assert.equal(record, null, field);
    assert.match(errors.join(" "), new RegExp(`"${field}" is not accepted`));
  }
  const { record, dropped } = validateExtensionRecord(base({ event: "start", colour: "green" }), { now: NOW });
  assert.deepEqual(dropped, ["colour"]);
  assert.equal("colour" in record, false);
});

test("ids, events, times, and file targets are validated", () => {
  const bad = [
    base({ v: 2, event: "start" }), base({ party: "has space", event: "start" }), base({ agent: "", event: "start" }),
    base({ event: "explode" }), base({ event: "step", step: "teleport" }), base({ at: NOW + 3_600_000, event: "start" }),
    base({ event: "step", step: "edit", target: "src/app.js" }), base({ feed: "Bad Feed", event: "start" }),
  ];
  for (const raw of bad) assert.equal(validateExtensionRecord(raw, { now: NOW }).record, null, JSON.stringify(raw));
  assert.equal(validateExtensionRecord(base({ at: new Date(NOW - 1000).toISOString(), event: "start" }), { now: NOW }).record.at, NOW - 1000);
  assert.equal(validateExtensionRecord({ ...base({ event: "start" }), feed: "other" }, { feed: "relay", now: NOW }).record, null,
    "a record cannot claim another feed's file");
});

test("command steps never show text, and messages are clipped and redacted", () => {
  const step = validateExtensionRecord(base({ event: "step", step: "command", text: "curl -H 'Authorization: Bearer abc' x" }), { now: NOW }).record;
  assert.equal(step.text, undefined);
  const message = validateExtensionRecord(base({ event: "message", text: `Deployed with token=ghp_${"a".repeat(30)} ${"x".repeat(900)}` }), { now: NOW }).record;
  assert.doesNotMatch(message.text, /ghp_/);
  assert.ok(message.text.length <= 600);
  const secretFile = validateExtensionRecord(base({ event: "step", step: "read", target: ".env.local" }), { now: NOW }).record;
  assert.equal(secretFile.target, "a private file");
});

test("records become a stable party with a lead and child goblins", () => {
  const lines = [
    base({ event: "start", lead: true, agentName: "Planner", partyName: "Release 42", cwd: "/work/shop" }),
    base({ agent: "coder", event: "start", agentName: "Coder", at: NOW - 50_000 }),
    base({ agent: "coder", event: "step", step: "edit", target: "cart.js", stepId: "s1", status: "started", at: NOW - 40_000 }),
    base({ agent: "coder", event: "step", step: "command", stepId: "s2", at: NOW - 35_000 }),
    base({ agent: "coder", event: "step", step: "edit", stepId: "s1", status: "completed", at: NOW - 30_000 }),
    base({ agent: "tester", event: "start", at: NOW - 20_000 }),
    base({ agent: "tester", event: "failed", text: "Two checks failed.", at: NOW - 10_000 }),
    base({ event: "needs", text: "Ship to production?", at: NOW - 5_000 }),
  ].map((raw) => JSON.stringify(raw)).join("\n");
  const { records, skipped } = parseExtensionLines(`${lines}\nnot json\n{"v":1}\n`, { feed: "relay", now: NOW });
  assert.equal(skipped, 2);
  const [party] = buildExtensionParties(records, { now: NOW });
  assert.equal(party.id, extensionPartyId("relay", "build-42"));
  assert.equal(party.name, "Release 42");
  const [lead, ...children] = party.agents;
  assert.equal(lead.id, extensionAgentId("relay", "build-42", "planner"));
  assert.equal(lead.source, "extension");
  assert.equal(lead.attention, "needs");
  assert.equal(lead.needsInput, true);
  assert.equal(lead.parentThreadId, party.id);
  const coder = children.find((actor) => actor.nickname === "Coder");
  assert.equal(coder.childOf, lead.id);
  assert.equal(coder.attention, "working");
  assert.deepEqual(coder.activities.map((item) => [item.title, item.status]), [["Changed cart.js", "completed"], ["Ran a local command", "completed"]]);
  const tester = children.find((actor) => actor.nickname === "tester");
  assert.equal(tester.attention, "failed");
  assert.equal(tester.turnStates.at(-1).error, "Two checks failed.");
});

test("a needs event with no question does not alert: there is nothing to show the person", () => {
  const lines = [base({ event: "start", lead: true }), base({ event: "needs", at: NOW - 5_000 })];
  const [party] = buildExtensionParties(lines.map((raw) => validateExtensionRecord(raw, { now: NOW }).record), { now: NOW });
  const [lead] = party.agents;
  assert.equal(lead.ask, null);
  assert.equal(lead.needsInput, false);
  assert.notEqual(lead.attention, "needs");
  assert.notEqual(lead.status, "waiting");
});

test("a turn quiet for hours is stale, not working", () => {
  const records = [validateExtensionRecord(base({ event: "start", at: NOW - 3 * 3_600_000 }), { now: NOW }).record];
  const [party] = buildExtensionParties(records, { now: NOW });
  assert.equal(party.agents[0].status, "stale");
  assert.equal(party.agents[0].attention, "quiet");
});

test("appending writes only validated records to the feed's own file", () => {
  const dir = mkdtempSync(join(tmpdir(), "goblin-feeds-"));
  try {
    assert.equal(appendExtensionRecord(base({ event: "start", at: Date.now() - 1000 }), { dir }).ok, true);
    const refused = appendExtensionRecord(base({ event: "step", step: "command", output: "secret", at: Date.now() }), { dir });
    assert.equal(refused.ok, false);
    const text = readFileSync(join(dir, "relay.ndjson"), "utf8").trim().split("\n");
    assert.equal(text.length, 1);
    assert.doesNotMatch(text[0], /secret/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const valid = (fields) => validateExtensionRecord(base(fields), { now: NOW }).record;
const emptyCodex = { ok: true, threads: [], listComplete: true, checked: { records: [], pending: 0, failed: 0, candidates: 0, capped: false } };

test("party and agent caps keep members that need you, failed, or are working, and count the rest", () => {
  const limits = { ...EXTENSION_LIMITS, parties: 2, agents: 3 };
  const records = [
    // An older party whose lead needs the person.
    valid({ party: "urgent", agent: "lead", event: "needs", text: "Approve the migration?", at: NOW - 50_000 }),
    // A party with five members: one failed and one waiting are older than three quiet ones.
    valid({ party: "crowd", agent: "lead", lead: true, event: "start", at: NOW - 40_000 }),
    valid({ party: "crowd", agent: "asker", event: "needs", text: "Which branch?", at: NOW - 39_000 }),
    valid({ party: "crowd", agent: "broken", event: "failed", text: "Build failed.", at: NOW - 38_000 }),
    ...[1, 2, 3].flatMap((n) => [
      valid({ party: "crowd", agent: `quiet-${n}`, event: "start", at: NOW - 30_000 + n }),
      valid({ party: "crowd", agent: `quiet-${n}`, event: "done", at: NOW - 20_000 + n }),
    ]),
    // Three quiet parties, all newer.
    ...[1, 2, 3].flatMap((n) => [
      valid({ party: `calm-${n}`, agent: "solo", event: "start", at: NOW - 10_000 + n }),
      valid({ party: `calm-${n}`, agent: "solo", event: "done", at: NOW - 5_000 + n }),
    ]),
  ];
  const { parties, truncated } = buildExtensionFeed(records, { now: NOW, limits });
  assert.deepEqual(parties.map((party) => party.id).sort(), [extensionPartyId("relay", "crowd"), extensionPartyId("relay", "urgent")]);
  const crowd = parties.find((party) => party.id === extensionPartyId("relay", "crowd"));
  assert.equal(crowd.agents[0].id, extensionAgentId("relay", "crowd", "lead"), "the lead always stays first");
  assert.deepEqual(crowd.agents.slice(1).map((agent) => agent.attention).sort(), ["failed", "needs"]);
  assert.deepEqual(crowd.hidden, { agents: 3, active: 0, urgent: 0 });
  assert.deepEqual(truncated, { parties: 3, agents: 6, active: 0, urgent: 0 });
  assert.equal(buildExtensionParties(records, { now: NOW, limits }).length, 2);
});

test("a focused extension party and the all-parties scene report active members a cap left out", () => {
  const dir = mkdtempSync(join(tmpdir(), "goblin-feeds-"));
  try {
    const lines = [
      base({ agent: "lead", lead: true, event: "start", at: NOW - 9000 }),
      ...[1, 2, 3].map((n) => base({ agent: `worker-${n}`, event: "step", step: "edit", target: `f${n}.js`, status: "started", at: NOW - 5000 + n })),
    ];
    writeFileSync(join(dir, "relay.ndjson"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    // A second, older feed past the feed cap is not read, and the scene says so.
    writeFileSync(join(dir, "older.ndjson"), `${JSON.stringify({ ...base({ event: "start" }), feed: "older" })}\n`);
    const anHourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(join(dir, "older.ndjson"), anHourAgo, anHourAgo);
    const reader = new ExtensionReader({ dir, ttlMs: 0, clock: () => NOW, limits: { ...EXTENSION_LIMITS, agents: 2, feeds: 1 } });
    const scene = reader.scene("ext:relay:build-42");
    assert.equal(scene.agents.length, 2);
    assert.deepEqual(scene.coverage, { agentsShown: 2, agentsHidden: 2, activeHidden: 2, urgentHidden: 0, complete: false });
    assert.match(scene.warning, /2 members still active were left out/);
    const snapshot = reader.snapshot();
    assert.deepEqual(snapshot.truncated, { feeds: 1, parties: 0, agents: 2, active: 2, urgent: 0 });
    const all = composeAllScene({ codex: emptyCodex, claude: { ok: true, snapshot: { sessions: [], warning: "" } },
      orca: { ok: true, snapshot: { workspaces: [], warning: "", missing: true } }, extension: { ok: true, snapshot }, now: NOW });
    assert.equal(all.coverage.complete, false);
    assert.deepEqual(all.coverage.extensionTruncated, { feeds: 1, parties: 0, agents: 2, active: 2, urgent: 0 });
    assert.ok(all.coverage.activeTotal > all.coverage.activeShown);
    assert.match(all.warning, /more active members were left out/);
    assert.match(all.warning, /1 older extension feed was not read/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a feed larger than readBytes is read from its newest bytes, dropping the partial first line", () => {
  const dir = mkdtempSync(join(tmpdir(), "goblin-feeds-"));
  try {
    const limits = { ...EXTENSION_LIMITS, readBytes: 4096 };
    const old = Array.from({ length: 800 }, (_, n) => JSON.stringify(base({ party: "old-party", agent: `a${n}`, event: "start", at: NOW - 600_000 + n })));
    const recent = Array.from({ length: 5 }, (_, n) => JSON.stringify(base({ party: "new-party", agent: `b${n}`, event: "start", at: NOW - 1000 + n })));
    const text = `${[...old, ...recent].join("\n")}\n`;
    assert.ok(text.length > limits.readBytes * 10);
    writeFileSync(join(dir, "relay.ndjson"), text);
    const reader = new ExtensionReader({ dir, ttlMs: 0, clock: () => NOW, limits });
    const snapshot = reader.snapshot();
    const ids = snapshot.sessions.map((party) => party.id);
    assert.ok(ids.includes(extensionPartyId("relay", "new-party")));
    assert.equal(snapshot.feeds[0].skipped, 0, "the cut first line is dropped, not counted as malformed");
    assert.ok(snapshot.feeds[0].records < old.length, "older records beyond the byte limit were not read");
    // Every line here is at least 80 bytes, so a 4096-byte tail holds at most 51 of them.
    assert.ok(snapshot.feeds[0].records <= Math.floor(limits.readBytes / 80), "no more than readBytes worth of records");

    // One enormous line with no line break: nothing is read, and nothing is mistaken for a record.
    writeFileSync(join(dir, "relay.ndjson"), `${"z".repeat(limits.readBytes * 5)}`);
    const huge = new ExtensionReader({ dir, ttlMs: 0, clock: () => NOW, limits }).snapshot();
    assert.deepEqual(huge.sessions, []);
    assert.equal(huge.feeds[0].records, 0);
    assert.equal(huge.feeds[0].skipped, 0);
    assert.equal(huge.warning, "");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the reader joins drop-folder feeds into the all-parties scene and reports skipped lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "goblin-feeds-"));
  try {
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    writeFileSync(join(dir, "relay.ndjson"), [
      JSON.stringify(base({ event: "start", at: now - 5000 })),
      JSON.stringify(base({ event: "step", step: "research", text: "Compared two libraries.", at: now - 4000 })),
      "garbage",
    ].join("\n"));
    writeFileSync(join(dir, "notes.txt"), "ignored");
    const reader = new ExtensionReader({ dir, ttlMs: 0 });
    const snapshot = reader.snapshot();
    assert.deepEqual(snapshot.feeds.map(({ feed, parties, skipped }) => ({ feed, parties, skipped })), [{ feed: "relay", parties: 1, skipped: 1 }]);
    assert.equal(reader.listSessions()[0].source, "extension");
    assert.equal(reader.scene("ext:relay:build-42").agents.length, 1);
    assert.equal(reader.scene("ext:relay:../x"), null);
    const scene = composeAllScene({
      codex: { ok: true, threads: [], listComplete: true, checked: { records: [], pending: 0, failed: 0, candidates: 0, capped: false } },
      claude: { ok: true, snapshot: { sessions: [], warning: "" } },
      orca: { ok: true, snapshot: { workspaces: [], warning: "", missing: true } },
      extension: { ok: true, snapshot },
      now,
    });
    assert.equal(scene.agents.length, 1);
    assert.equal(scene.agents[0].attention, "working");
    assert.equal(scene.totals.recentExtension, 1);
    assert.equal(scene.coverage.extensionFeeds, 1);
    assert.equal(scene.coverage.complete, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
