import test from "node:test";
import assert from "node:assert/strict";
import { diagnosticReport } from "../lib/diagnostics.mjs";

const NOW = 1_800_000_000_000;

test("the diagnostic report carries states, counts, and timings, and nothing that names a person, chat, or path", () => {
  const secrets = ["C:\\Users\\someone\\private-project", "Quarterly payroll fix", "ABCD2345", "192.168.1.20", "acme-relay"];
  const { data, text } = diagnosticReport({
    version: "0.3.0", platform: "win32", node: "24.19.0", now: NOW,
    stats: { startedAt: NOW - 90 * 60_000, sceneBuilds: 40, sceneFailures: 1, lastSceneMs: 120, slowestSceneMs: 7000, codexReadFailures: 2 },
    capabilities: { sources: {
      codex: { state: "ok", detail: `Reading chats in ${secrets[0]}` },
      claude: { state: "not-connected", detail: `Settings at ${secrets[0]}`, sessions: 3, lastEventAt: NOW - 60_000 },
      orca: { state: "weird-new-state", detail: secrets[1] },
      extensions: { state: "ok", feeds: [{ feed: secrets[4] }] },
    } },
    scene: { checkedAt: NOW - 5000, warning: secrets[1], agents: [{ name: secrets[1], cwd: secrets[0] }],
      coverage: { codexListed: 650, codexChecked: 4, codexPending: 0 } },
    watched: 2, codexRestarts: 1, phone: { available: true, pairedSessions: 1, code: secrets[2], address: secrets[3] },
  });
  const everything = `${text}\n${JSON.stringify(data)}`;
  for (const secret of secrets) assert.equal(everything.includes(secret), false, secret);
  assert.match(text, /codex ok \(restarts 1\)/);
  assert.match(text, /claude not-connected \(3 sessions, last event 60s ago\)/);
  assert.match(text, /orca other/, "an unknown state is named generically, never echoed");
  assert.match(text, /slowest 7\.0 s/);
  assert.match(text, /650 listed, 4 read, 0 waiting, 2 read failures/);
  assert.match(text, /1 paired/);
  assert.equal(data.scene.partial, true);
});
