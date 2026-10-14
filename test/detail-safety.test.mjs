import test from "node:test";
import assert from "node:assert/strict";
import { clean } from "../lib/detail-text.mjs";

test("a megabyte pasted into a prompt is clipped before it is filtered", () => {
  const secret = "Win" + "ter2026!x";
  const pasted = `   Deploy with password=${secret} now. ${"lorem ipsum ".repeat(90_000)}`;
  const started = Date.now();
  const text = clean(pasted, 2000);
  assert.ok(Date.now() - started < 100, `took ${Date.now() - started} ms`);
  assert.equal(text.length, 2000);
  assert.ok(text.startsWith("Deploy with password=[secret removed] now."));
  assert.ok(text.endsWith("…"));
  assert.equal(text.includes(secret), false);
  // Short text is unchanged by the cut.
  assert.equal(clean(`  token=${secret}  `, 2000), "token=[secret removed]");
  // A credential straddling the clip point is still recognised whole before the cut.
  const straddle = clean(`${"x ".repeat(45)}password=${secret}${" y".repeat(100)}`, 100);
  assert.equal(straddle.includes("Win"), false, straddle);
});
