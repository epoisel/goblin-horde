import test from "node:test";
import assert from "node:assert/strict";
import { readDescendants } from "../lib/descendants.mjs";

test("reads every descendant page and keeps later members in the party", async () => {
  const calls = [];
  const result = await readDescendants("root", async (_method, params) => {
    calls.push(params.cursor || "first");
    return params.cursor
      ? { data: [{ id: "member-13" }, { id: "member-14" }] }
      : { data: Array.from({ length: 12 }, (_, index) => ({ id: `member-${index + 1}` })), nextCursor: "next" };
  }, async (id) => ({ id }));
  assert.deepEqual(calls, ["first", "next"]);
  assert.equal(result.agents.length, 14);
  assert.equal(result.agents.at(-1).id, "member-14");
  assert.equal(result.warning, "");
});

test("reports a partial party when a later page or member read fails", async () => {
  const result = await readDescendants("root", async (_method, params) => {
    if (params.cursor) throw new Error("list failed");
    return { data: [{ id: "one" }, { id: "two" }], nextCursor: "next" };
  }, async (id) => {
    if (id === "two") throw new Error("read failed");
    return { id };
  });
  assert.deepEqual(result.agents.map((agent) => agent.id), ["one"]);
  assert.match(result.warning, /could not be listed/);
  assert.match(result.warning, /could not be read/);
});
