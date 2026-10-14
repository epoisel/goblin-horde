import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../lib/claude.mjs";
import { transformThread } from "../lib/transform.mjs";
import { publicView } from "../lib/public-view.mjs";

// Hostile text the credential filter must get through in linear time: every agent message, command,
// and tool argument passes it on every scene, so one quadratic pattern turns a long escaped-JSON line
// into seconds per poll. Each input is about 200 KB.
const SIZE = 200_000;
const fill = (piece) => piece.repeat(Math.ceil(SIZE / piece.length)).slice(0, SIZE);
const escapedJson = JSON.stringify(JSON.stringify({ name: "csv-export", rows: [1, 2, 3], nested: { quote: 'a "b" c', path: "C:\\work\\x" } }));

export const HOSTILE = {
  "escaped quotes": fill('\\"'),
  "escaped JSON": fill(escapedJson),
  "quote then backslash": fill('"\\'),
  "double quotes": fill('"'),
  "single quotes": fill("'"),
  "backtick quotes": fill('`"'),
  "equals signs": fill("="),
  "colons": fill(":"),
  "key, equals, escaped quote": fill('password=\\"'),
  "key, colon, open quote": fill('"secret_key": "a\\'),
  "variable, escaped quote": fill('$pw="\\"'),
  "flag, escaped quote": fill('--password "\\"'),
  "credential call, escaped quote": fill('NetworkCredential("a", "\\"'),
  "secure string, escaped quote": fill('ConvertTo-SecureString "\\"'),
  "piped secure string": `${fill('"a\\"')}| ConvertTo-SecureString`,
  "authorization and spaces": `Authorization:${" ".repeat(SIZE)}`,
  "authorization repeated": fill("Authorization: Bearer "),
  "private key header": `-----BEGIN ${"A".repeat(SIZE)}`,
  "sql flags": fill("sqlcmd -P "),
  "dashes": fill("-"),
  "dashed letters": fill("a-"),
  "spaced words": fill("a "),
  "word runs": fill("a_"),
  "spaces after a key": `password:${" ".repeat(SIZE)};`,
  "spaces after a credential call": `NetworkCredential${" ".repeat(SIZE)}`,
  "spaces in a connection string": `;Password=${" ".repeat(SIZE)}`,
  "export and spaces": fill("export "),
  "upper-case names and spaces": fill("A "),
  "curl user": `curl -u ${"a".repeat(SIZE)}`,
};

/** The fastest of three runs, in ms: one slow run on a busy computer is not the filter's doing. */
function fastest(text) {
  let best = Infinity;
  for (let run = 0; run < 3; run++) {
    const started = performance.now();
    redactSecrets(text);
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

test("the credential filter takes linear time on hostile text: 200 KB in under 50 ms each", () => {
  const slow = Object.entries(HOSTILE).map(([name, text]) => [name, Math.round(fastest(text))]).filter(([, ms]) => ms >= 50);
  assert.deepEqual(slow, []);
});

test("a long Codex message or command is clipped before it is filtered, so a scene never filters it whole", () => {
  const SECRET = ["Hunter2", "Secret!"].join("");
  const message = `Deployed. The password is ${SECRET}. ${fill('\\"')}`;
  const command = `deploy --password ${SECRET} --manifest ${fill('{\\"a\\":1}')}`;
  const actor = transformThread({ id: "chat-long-0001", name: "Ship CSV export", updatedAt: 1_800_000_000, turns: [{
    id: "t1", status: "completed", completedAt: 1_800_000_001, items: [
      { id: "m1", type: "agentMessage", phase: "final_answer", text: message },
      { id: "c1", type: "commandExecution", command, aggregatedOutput: "ok", exitCode: 0 },
    ] }] });
  const said = actor.activities.find((item) => item.id === "m1");
  const ran = actor.activities.find((item) => item.id === "c1");
  assert.ok(said.description.length <= 4000, `${said.description.length} characters`);
  assert.ok(said.description.endsWith("…"));
  assert.ok(ran.detail.length <= 2000, `${ran.detail.length} characters`);
  for (const text of [said.description, ran.detail]) assert.ok(!text.includes(SECRET));
  const started = performance.now();
  for (let index = 0; index < 5; index++) publicView({ agents: [actor] });
  assert.ok(performance.now() - started < 250, `five scenes took ${Math.round(performance.now() - started)} ms`);
});
