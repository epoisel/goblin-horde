import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPartyId, WATCH_LIMIT, WatchList } from "../lib/watch.mjs";

const folder = () => mkdtempSync(join(tmpdir(), "goblin-watch-"));

test("watching is saved, newest first, and survives a restart", () => {
  const dir = folder();
  try {
    const list = new WatchList({ dir });
    list.set("0199c0de-0000-7000-8000-000000000001", true);
    list.set("claude:c1a0de00-0000-4000-8000-000000000002", true);
    list.set("0199c0de-0000-7000-8000-000000000001", true);
    assert.deepEqual(new WatchList({ dir }).ids, ["0199c0de-0000-7000-8000-000000000001", "claude:c1a0de00-0000-4000-8000-000000000002"]);
    list.set("0199c0de-0000-7000-8000-000000000001", false);
    assert.deepEqual(new WatchList({ dir }).ids, ["claude:c1a0de00-0000-4000-8000-000000000002"]);
    assert.deepEqual(readdirSync(dir), ["watched.json"], "no temporary file is left behind");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("only party ids are accepted, and the list is capped", () => {
  assert.equal(isPartyId("all"), false);
  assert.equal(isPartyId("../../etc/passwd"), false);
  assert.equal(isPartyId("orca:d29ya3RyZWU"), true);
  assert.equal(isPartyId("ext:relay/build-42"), true);
  const dir = folder();
  try {
    const list = new WatchList({ dir });
    assert.throws(() => list.set("all", true), { statusCode: 400 });
    for (let index = 0; index < WATCH_LIMIT; index++) list.set(`chat-${String(index).padStart(6, "0")}`, true);
    assert.throws(() => list.set("one-too-many", true), { statusCode: 409 });
    // Re-watching one already on the list is still fine at the cap.
    list.set("chat-000003", true);
    assert.equal(list.ids[0], "chat-000003");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an unreadable or tampered file starts empty or keeps only valid ids", () => {
  const dir = folder();
  try {
    writeFileSync(join(dir, "watched.json"), "{ not json");
    assert.deepEqual(new WatchList({ dir }).ids, []);
    writeFileSync(join(dir, "watched.json"), JSON.stringify({ ids: ["chat-000001", "../x", 5, "chat-000001"] }));
    assert.deepEqual(new WatchList({ dir }).ids, ["chat-000001"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
