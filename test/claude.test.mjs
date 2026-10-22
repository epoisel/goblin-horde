import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendClaudeRecord, buildClaudeFeed, buildClaudeSessions, claudeActivityDir, ClaudeReader, CLAUDE_LIMITS, cleanRecord,
  goblinStateDir, normalizeHookEvent, parseClaudeLines, promptTitle, readFileTail, redactSecrets,
} from "../lib/claude.mjs";
import { validateExtensionRecord } from "../lib/extension.mjs";
import { composeAllScene } from "../lib/feed.mjs";

const NOW = 1_800_000_000_000;
const SESSION = "a1b2c3d4-0000-4000-8000-000000000001";
const OTHER = "a1b2c3d4-0000-4000-8000-000000000002";
const hookScript = fileURLToPath(new URL("../claude-hook.mjs", import.meta.url));
const tempDir = () => mkdtempSync(join(tmpdir(), "goblin-claude-test-"));

let counter = 0;
const hook = (event, extra = {}, at = NOW) => ({ hook_event_name: event, session_id: SESSION, cwd: "/work/goblin-horde", transcript_path: "/home/someone/.claude/projects/x/transcript.jsonl", ...extra, _at: at });
// Normalize synthetic hooks in order, with distinct ids and times, as the hook would over a session.
function records(...inputs) {
  return inputs.map((input) => {
    const { _at, ...payload } = input;
    counter++;
    return normalizeHookEvent(payload, { now: _at ?? NOW + counter, id: counter.toString(16).padStart(12, "0") });
  }).filter(Boolean);
}

test("hook records keep what each call works on, filtered, and never output, errors, or notification titles", () => {
  const PASSWORD = ["Hunter2", "Secret!"].join("");
  const [prompt, pre, post, failed, notice, crash] = records(
    hook("UserPromptSubmit", { prompt: `Ship the CSV export for billing-api. The password is ${PASSWORD} for staging.` }),
    hook("PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_01", tool_input: { command: "curl -H 'Authorization: Bearer abcdefSECRETTOKEN123456' https://api.example.test/v1", description: "call the endpoint" } }),
    hook("PostToolUse", { tool_name: "Bash", tool_use_id: "toolu_01", tool_input: { command: "cat ~/.ssh/config" }, tool_output: "Host private-box\n  HostName 10.0.0.5", tool_response: { stdout: "PRIVATE-OUTPUT" } }),
    hook("PostToolUseFailure", { tool_name: "Read", tool_use_id: "toolu_02", tool_input: { file_path: "C:\\work\\billing-api\\notes.md" }, error: "EACCES PRIVATE-ERROR" }),
    hook("Notification", { notification_type: "permission_prompt", message: "Claude needs permission to run rm -rf PRIVATE-DIR", title: "Permission" }),
    hook("StopFailure", { error_type: "server_error", error_message: "upstream PRIVATE-ERROR-DETAIL" }),
  );
  // The prompt excerpt and the command are kept for this computer, with the credentials removed.
  assert.match(prompt.prompt, /^Ship the CSV export for billing-api\. The password is \[secret removed\]/);
  assert.equal(prompt.transcript, "/home/someone/.claude/projects/x/transcript.jsonl");
  assert.match(pre.detail, /^curl -H 'Authorization: Bearer \[secret removed\]' https:\/\/api\.example\.test\/v1$/);
  assert.equal(pre.transcript, undefined, "only the session's own events say where its transcript is");
  // A result, a failure, and a crash carry no text of their own; a needs-you notice keeps what it tells the person, filtered.
  assert.equal(post.detail, undefined);
  assert.equal(failed.target, "notes.md");
  assert.equal(notice.message, "Claude needs permission to run rm -rf PRIVATE-DIR");
  const stored = JSON.stringify([prompt, pre, post, failed, { ...notice, message: "" }, crash]);
  for (const fragment of [PASSWORD, "SECRETTOKEN", "ssh", "10.0.0.5", "PRIVATE-OUTPUT", "PRIVATE-ERROR", "PRIVATE-DIR", "Permission\"", "call the endpoint"]) {
    assert.ok(!stored.includes(fragment), `stored records leaked ${fragment}`);
  }
  // Read keeps the full path as its detail and the base name as its target.
  const read = records(hook("PreToolUse", { tool_name: "Read", tool_use_id: "toolu_03", tool_input: { file_path: "/work/billing-api/src/app.js" } }))[0];
  assert.equal(read.target, "app.js");
  assert.equal(read.detail, "/work/billing-api/src/app.js");
  // A file name that suggests a credential is not named in titles.
  assert.equal(records(hook("PreToolUse", { tool_name: "Read", tool_input: { file_path: "/work/.env.local" } }))[0].target, "a private file");
  // Non-file tools never carry a target, even when their input has a path.
  assert.equal(records(hook("PreToolUse", { tool_name: "Bash", tool_input: { file_path: "/work/app.js", command: "x" } }))[0].target, undefined);
});

// Synthetic, obviously fake credential shapes (alphabet runs, not real keys), joined at runtime
// so the source holds no credential-shaped literal for secret scanners to flag.
const FAKE_ANTHROPIC_PREFIX = ["sk", "ant", "api03"].join("-");
const FAKE_ANTHROPIC_KEY = [FAKE_ANTHROPIC_PREFIX, "ABCDEFGHIJKLMNOPQRSTUVWX"].join("-");
const FAKE_GITHUB_TOKEN = ["ghp", "abcdefghijklmnopqrstuvwxyz0123"].join("_");
const FAKE_SK_LIVE_KEY = ["sk", "live", "ABCDEFGHIJKLMNOPQRST"].join("-");
const FAKE_AWS_KEY_ID = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");

test("the final reply is a bounded, redacted excerpt and a closing question is noticed", () => {
  const long = `${"Done with the refactor. ".repeat(80)}\nKey: ${FAKE_ANTHROPIC_KEY} and ${FAKE_GITHUB_TOKEN}\nShould I also update the docs?`;
  const [record] = records(hook("Stop", { last_assistant_message: long, stop_hook_active: false }));
  assert.ok(record.message.length <= CLAUDE_LIMITS.excerptChars);
  // The question keeps the sentence before it for context, filtered like the rest.
  assert.match(record.question, /\[secret removed\] Should I also update the docs\?$/);
  const redacted = redactSecrets(`token=abc123 Bearer abcdefghijklmnopqrstu ${FAKE_SK_LIVE_KEY} ${FAKE_AWS_KEY_ID}`);
  assert.ok(!["abc123", "abcdefghijklmnopqrstu", "ABCDEFGHIJKLMNOPQRST", FAKE_AWS_KEY_ID].some((part) => redacted.includes(part)), redacted);
  assert.ok(!JSON.stringify(record).includes(FAKE_ANTHROPIC_PREFIX));
});

test("quoted and JSON credential keys are removed while the public text around them stays", () => {
  // Synthetic values only; each must disappear wherever it appears.
  const cases = [
    ['{"password":"FAKE_PASSWORD_FOR_TEST"}', "FAKE_PASSWORD_FOR_TEST"],
    ['{"user": "alice", "db_password" : "FAKE PASS WITH SPACES", "port": 5432}', "FAKE PASS"],
    ["{'api_key': 'FAKE_KEY_VALUE_1'}", "FAKE_KEY_VALUE_1"],
    ['{\\"client_secret\\":\\"FAKE_SECRET_2\\"}', "FAKE_SECRET_2"],
    ['accessToken="FAKE_TOKEN_3"', "FAKE_TOKEN_3"],
    ["AWS_SECRET_ACCESS_KEY=FAKEAWSSECRET4", "FAKEAWSSECRET4"],
    ["x-api-key: FAKEHEADER5", "FAKEHEADER5"],
    ['{"refresh_token" => "FAKE_REFRESH_6"}', "FAKE_REFRESH_6"],
    ['password: "unterminated FAKE_TAIL_7', "FAKE_TAIL_7"],
    ["mysql --password FAKE_FLAG_8 -h db", "FAKE_FLAG_8"],
    ["https://alice:FAKE_URL_9@git.example.com/repo.git", "FAKE_URL_9"],
    ["password=ab}FAKE_BRACE_10", "FAKE_BRACE_10"],
    ['"Authorization": "Bearer FAKEBEARERVALUE11"', "FAKEBEARERVALUE11"],
  ];
  for (const [text, secret] of cases) {
    const redacted = redactSecrets(text);
    assert.ok(!redacted.includes(secret), `${text} -> ${redacted}`);
    assert.match(redacted, /\[secret removed\]/, text);
  }
  // The rest of a JSON object stays readable.
  assert.equal(redactSecrets('{"user": "alice", "password": "FAKE_PW", "port": 5432}'), '{"user": "alice", "password": "[secret removed]", "port": 5432}');
  assert.equal(redactSecrets('{"password":"FAKE_PASSWORD_FOR_TEST"}'), '{"password":"[secret removed]"}');
  // Ordinary words about credentials, and counters named like them, are not touched.
  for (const plain of ["Fixed the password reset flow; tokens now expire after 30 minutes.", "Set max_tokens: 4096 and token_count = 12.",
    "Read passwords.md and secret-scanning.yml, then updated the tokenizer.", "All 42 tests pass."]) {
    assert.equal(redactSecrets(plain), plain);
  }
  // The hook path: a final reply and its closing question.
  const [stop] = records(hook("Stop", { last_assistant_message: 'Saved config {"password":"FAKE_PASSWORD_FOR_TEST"}.\nUse "api_key": "FAKE_KEY_IN_QUESTION" next time?' }));
  assert.ok(!JSON.stringify(stop).includes("FAKE_PASSWORD_FOR_TEST"), stop.message);
  assert.ok(!JSON.stringify(stop).includes("FAKE_KEY_IN_QUESTION"), stop.question);
  assert.match(stop.message, /Saved config/);
  // A record read back from disk is filtered again.
  const [base] = records(hook("SessionStart", { source: "startup" }));
  const stored = cleanRecord({ ...base, event: "Stop", message: '{"password":"FAKE_FROM_DISK"}' });
  assert.ok(!stored.message.includes("FAKE_FROM_DISK"));
  // The extension feed reuses the same filter for its public text.
  const ext = validateExtensionRecord({ v: 1, feed: "relay", at: NOW - 1000, party: "p", agent: "a", event: "message",
    agentName: "token: FAKE_LABEL", text: 'Deployed with {"password":"FAKE_PASSWORD_FOR_TEST"} to staging.' }, { now: NOW }).record;
  assert.ok(!JSON.stringify(ext).includes("FAKE_PASSWORD_FOR_TEST"));
  assert.ok(!JSON.stringify(ext).includes("FAKE_LABEL"));
  assert.match(ext.text, /Deployed with .* to staging\./);
});

test("a long run of word characters is filtered in linear time", () => {
  const started = Date.now();
  redactSecrets(`${"a_".repeat(20_000)}password=FAKE`);
  redactSecrets(`--${"x-".repeat(20_000)}`);
  assert.ok(Date.now() - started < 2000, "redaction must not be quadratic on hostile text");
});

test("unknown events, unsafe ids, and quiet notifications are not recorded", () => {
  assert.equal(normalizeHookEvent({ hook_event_name: "PreCompact", session_id: SESSION }), null);
  assert.equal(normalizeHookEvent({ hook_event_name: "Stop", session_id: "../../etc/passwd" }), null);
  assert.equal(normalizeHookEvent({ hook_event_name: "Notification", session_id: SESSION, notification_type: "auth_success" }), null);
  // Back at the prompt is kept (only its type: never the notification's message or title).
  const idle = normalizeHookEvent({ hook_event_name: "Notification", session_id: SESSION, notification_type: "idle_prompt",
    message: "Claude is waiting for your input PRIVATE", title: "PRIVATE" });
  assert.equal(idle.notice, "idle_prompt");
  assert.ok(!JSON.stringify(idle).includes("PRIVATE"));
  assert.equal(cleanRecord({ ...idle, notice: "made_up" }).notice, undefined);
  assert.equal(normalizeHookEvent("not an object"), null);
  assert.equal(normalizeHookEvent(null), null);
  assert.equal(cleanRecord({ v: 2, id: "abcdef12", at: 1, event: "Stop", session: SESSION }), null);
});

test("state folders follow each platform's convention", () => {
  assert.equal(goblinStateDir({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, home: "C:\\Users\\a" }), "C:\\Users\\a\\AppData\\Local\\GoblinHorde");
  assert.equal(goblinStateDir({ platform: "darwin", env: {}, home: "/Users/a" }), "/Users/a/Library/Application Support/GoblinHorde");
  assert.equal(goblinStateDir({ platform: "linux", env: { XDG_STATE_HOME: "/xdg/state" }, home: "/home/a" }), "/xdg/state/goblin-horde");
  assert.equal(goblinStateDir({ platform: "linux", env: { XDG_STATE_HOME: "relative/ignored" }, home: "/home/a" }), "/home/a/.local/state/goblin-horde");
  assert.equal(goblinStateDir({ platform: "linux", env: {}, home: "/home/a" }), "/home/a/.local/state/goblin-horde");
  assert.equal(claudeActivityDir({ platform: "linux", env: {}, home: "/home/a" }), "/home/a/.local/state/goblin-horde/claude");
});

test("the hook entrypoint appends one record, prints nothing, and exits 0 even when it cannot record", () => {
  const dir = tempDir();
  try {
    const env = { ...process.env, GOBLIN_HORDE_STATE_DIR: dir };
    const payload = JSON.stringify({ hook_event_name: "PreToolUse", session_id: SESSION, cwd: "/work/x", tool_name: "Read", tool_use_id: "toolu_9", tool_input: { file_path: "/work/x/readme.md" } });
    const run = spawnSync(process.execPath, [hookScript], { input: payload, env, encoding: "utf8", timeout: 15000 });
    assert.equal(run.status, 0);
    assert.equal(run.stdout, "");
    const lines = readFileSync(join(dir, "claude", "activity.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).target, "readme.md");
    for (const input of ["{not json", "", JSON.stringify({ hook_event_name: "Stop" })]) {
      const bad = spawnSync(process.execPath, [hookScript], { input, env, encoding: "utf8", timeout: 15000 });
      assert.equal(bad.status, 0);
      assert.equal(bad.stdout, "");
    }
    assert.equal(readFileSync(join(dir, "claude", "activity.jsonl"), "utf8").trim().split("\n").length, 1);
    // A state folder that cannot be created (a file is in the way) still exits 0 quietly.
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "");
    const stuck = spawnSync(process.execPath, [hookScript], { input: payload, env: { ...env, GOBLIN_HORDE_STATE_DIR: join(blocked, "inner") }, encoding: "utf8", timeout: 15000 });
    assert.equal(stuck.status, 0);
    assert.equal(stuck.stdout, "");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the log rolls over at its size limit and the reader still sees both files", () => {
  const dir = tempDir();
  try {
    const all = records(...Array.from({ length: 30 }, (_, index) => hook("PreToolUse", { tool_name: "Grep", tool_use_id: `toolu_r${index}` }, NOW + index)));
    for (const record of all) appendClaudeRecord(record, { dir, rotateBytes: 2000 });
    assert.ok(existsSync(join(dir, "activity.1.jsonl")));
    assert.ok(readFileSync(join(dir, "activity.jsonl"), "utf8").length < 2000 + 400);
    const reader = new ClaudeReader({ dir, ttlMs: 0, clock: () => NOW + 60_000, limits: { ...CLAUDE_LIMITS, rotateBytes: 2000 } });
    const [session] = reader.snapshot().sessions;
    assert.ok(session.agents[0].activities.length > 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("malformed, oversized, foreign, and repeated lines are skipped", () => {
  const [good] = records(hook("SessionStart", { source: "startup" }));
  const text = [
    JSON.stringify(good), JSON.stringify(good), "{broken", "null", "[]", JSON.stringify({ ...good, id: "zz" }),
    JSON.stringify({ ...good, id: "abcdefabcdef", event: "Exfiltrate" }), "x".repeat(CLAUDE_LIMITS.lineChars + 1),
    JSON.stringify({ ...good, id: "abcdefabcdee", prompt: "PRIVATE", message: undefined }),
  ].join("\n");
  const { records: parsed, skipped } = parseClaudeLines(text);
  assert.equal(parsed.length, 2);
  assert.equal(skipped, 6);
  assert.ok(!JSON.stringify(parsed).includes("PRIVATE"));
});

test("a session becomes one party with a stable main goblin and distinct subagent children", () => {
  const list = records(
    hook("SessionStart", { source: "startup" }, NOW),
    hook("UserPromptSubmit", { prompt: "x" }, NOW + 1),
    hook("PreToolUse", { tool_name: "Read", tool_use_id: "t1", tool_input: { file_path: "/work/goblin-horde/server.mjs" } }, NOW + 2),
    hook("PostToolUse", { tool_name: "Read", tool_use_id: "t1", tool_input: { file_path: "/work/goblin-horde/server.mjs" } }, NOW + 3),
    hook("PreToolUse", { tool_name: "Task", tool_use_id: "t2", tool_input: {} }, NOW + 4),
    hook("SubagentStart", { agent_id: "agent-explore-1", agent_type: "Explore" }, NOW + 5),
    hook("PreToolUse", { agent_id: "agent-explore-1", agent_type: "Explore", tool_name: "Grep", tool_use_id: "t3", tool_input: { pattern: "PRIVATE-PATTERN" } }, NOW + 6),
    hook("SubagentStart", { agent_id: "agent-review-2", agent_type: "code-reviewer" }, NOW + 7),
    hook("SubagentStop", { agent_id: "agent-explore-1", agent_type: "Explore", last_assistant_message: "Found the feed code." }, NOW + 8),
    hook("PreToolUse", { tool_name: "Read", tool_use_id: "t4", tool_input: { file_path: "/work/goblin-horde/lib/feed.mjs" } }, NOW + 9),
  );
  const [session] = buildClaudeSessions(list, { now: NOW + 10_000 });
  assert.equal(session.id, `claude:${SESSION}`);
  const byId = Object.fromEntries(session.agents.map((agent) => [agent.id, agent]));
  const main = byId[`claude-agent:${SESSION}`];
  const explore = byId[`claude-agent:${SESSION}:agent-explore-1`];
  const review = byId[`claude-agent:${SESSION}:agent-review-2`];
  assert.ok(main && explore && review);
  for (const agent of session.agents) {
    assert.equal(agent.source, "claude");
    assert.equal(agent.parentThreadId, session.id);
    assert.equal(agent.replyAvailable, false);
  }
  assert.equal(explore.childOf, main.id);
  assert.equal(explore.nickname, "Explore subagent");
  assert.match(review.role, /Claude subagent · code-reviewer/);
  // Reading a file is an investigation step the goblins act out with the magnifier.
  assert.equal(main.activities.find((item) => item.title === "Read server.mjs").kind, "tool");
  assert.equal(main.latest.title, "Read feed.mjs");
  assert.equal(main.latest.status, "inProgress");
  assert.equal(main.status, "active");
  assert.equal(main.attention, "working");
  // The child's steps stay with the child, not the session's goblin.
  assert.ok(!main.activities.some((item) => item.title === "Searched local files"));
  assert.equal(explore.turnStates.at(-1).status, "completed");
  assert.equal(explore.latest.title, "Answer");
  assert.equal(explore.latest.description, "Found the feed code.");
  assert.equal(explore.attention, "quiet");
  assert.equal(review.attention, "working");
  assert.ok(!JSON.stringify(session).includes("PRIVATE-PATTERN"));
  // Ids do not depend on how much history is left: rebuilding from a later slice keeps them.
  const later = buildClaudeSessions(list.slice(6), { now: NOW + 10_000 })[0];
  assert.ok(later.agents.some((agent) => agent.id === explore.id));
});

test("a session is named for the first thing it was asked to do; its subagents for their tasks", () => {
  const list = records(
    hook("SessionStart", { source: "startup" }, NOW),
    hook("UserPromptSubmit", { prompt: "## Add a CSV export for invoices, with tests.\nUse the streaming writer." }, NOW + 1),
    hook("PreToolUse", { tool_name: "Task", tool_use_id: "t1", tool_input: { description: "Find invoice fixtures", subagent_type: "Explore", prompt: "Find them." } }, NOW + 2),
    hook("PreToolUse", { tool_name: "Task", tool_use_id: "t2", tool_input: { description: "Review the CSV writer", subagent_type: "code-reviewer", prompt: "Review." } }, NOW + 3),
    hook("SubagentStart", { agent_id: "agent-review", agent_type: "code-reviewer" }, NOW + 4),
    hook("SubagentStart", { agent_id: "agent-explore", agent_type: "Explore" }, NOW + 5),
    hook("SubagentStart", { agent_id: "agent-extra", agent_type: "Explore" }, NOW + 6),
  );
  const [session] = buildClaudeSessions(list, { now: NOW + 10_000 });
  const byId = Object.fromEntries(session.agents.map((agent) => [agent.id, agent]));
  const main = byId[`claude-agent:${SESSION}`];
  assert.equal(main.name, "Add a CSV export for invoices, with tests");
  assert.equal(session.name, main.name, "the party and its session share the name");
  assert.equal(main.cwd, "/work/goblin-horde", "the folder is still there to show beside it");
  assert.equal(byId[`claude-agent:${SESSION}:agent-explore`].nickname, "Explore: Find invoice fixtures");
  assert.equal(byId[`claude-agent:${SESSION}:agent-review`].name, "Code-reviewer: Review the CSV writer", "matched by type, not order");
  assert.equal(byId[`claude-agent:${SESSION}:agent-extra`].nickname, "Explore subagent", "no task left: the plain name");
  // The session keeps the name of its first real prompt: no follow-up, nudge, or slash command renames it.
  const more = [...list, ...records(hook("UserPromptSubmit", { prompt: "yes, please continue" }, NOW + 7), hook("UserPromptSubmit", { prompt: "/compact" }, NOW + 8))];
  assert.equal(buildClaudeSessions(more, { now: NOW + 10_000 })[0].name, "Add a CSV export for invoices, with tests");
  const followUps = ["No, only delete dist/old", "Option 2", "looks good, commit it", "What about the second one?", "Now make the export button stream rows"];
  const later = [...more, ...records(...followUps.map((prompt, index) => hook("UserPromptSubmit", { prompt }, NOW + 9 + index)))];
  assert.equal(buildClaudeSessions(later, { now: NOW + 10_000 })[0].name, "Add a CSV export for invoices, with tests");
  // A session whose first prompts were only nudges is named for the first one that says what it is for.
  const nudged = records(hook("UserPromptSubmit", { prompt: "continue" }, NOW), hook("UserPromptSubmit", { prompt: "Option 2" }, NOW + 1),
    hook("UserPromptSubmit", { prompt: "Fix the CSV export headers" }, NOW + 2), hook("UserPromptSubmit", { prompt: "Then add a test" }, NOW + 3));
  assert.equal(buildClaudeSessions(nudged, { now: NOW + 10_000 })[0].name, "Fix the CSV export headers");
  // Without a prompt worth a name, the folder and a short id still tell sessions apart.
  assert.match(buildClaudeSessions(records(hook("SessionStart", {}, NOW)), { now: NOW + 1000 })[0].name, /^Claude · goblin-horde · [0-9a-f]{4}$/);
});

test("prompt titles are one plain line, cut at a word, with nudges and commands left out", () => {
  assert.equal(promptTitle("Fix the flaky login test."), "Fix the flaky login test");
  assert.equal(promptTitle("> **Why** is `npm test` slow?\nmore"), "Why is npm test slow?");
  assert.equal(promptTitle("Reconcile every ledger for the third quarter and write the full report with every discrepancy"),
    "Reconcile every ledger for the third quarter and write the…");
  assert.ok(promptTitle("x".repeat(200)).length <= 60);
  for (const nudge of ["yes", "Continue.", "go ahead!", "ok", "/clear", "<command-name>/model</command-name>", "  ", "42", "[secret removed]"])
    assert.equal(promptTitle(nudge), "", nudge);
  // Replies to the agent's own question name nothing either.
  for (const reply of ["No, only delete dist/old", "Option 2", "option B", "looks good, commit it", "What about the second one?", "How about the other layout?",
    "Yes, but keep the old flag", "LGTM, ship it", "Actually, use tabs", "the second one", "2"])
    assert.equal(promptTitle(reply), "", reply);
  assert.equal(promptTitle("Why is the nightly build slow?"), "Why is the nightly build slow?", "a real question is still a name");
});

test("hooks map cleanly to needs-you, failure, finish, and end states", () => {
  const base = [hook("UserPromptSubmit", {}, NOW), hook("PreToolUse", { tool_name: "Bash", tool_use_id: "b1", tool_input: { command: "x" } }, NOW + 1)];
  const asking = buildClaudeSessions(records(...base, hook("Notification", { notification_type: "permission_prompt", message: "m" }, NOW + 2)), { now: NOW + 5000 })[0].agents[0];
  assert.equal(asking.needsInput, true);
  assert.equal(asking.attention, "needs");
  assert.equal(asking.status, "waiting");

  const approved = buildClaudeSessions(records(...base, hook("PermissionRequest", { tool_name: "Bash", tool_use_id: "b1" }, NOW + 2),
    hook("PostToolUse", { tool_name: "Bash", tool_use_id: "b1" }, NOW + 3)), { now: NOW + 5000 })[0].agents[0];
  assert.equal(approved.needsInput, false);
  assert.equal(approved.attention, "working");
  assert.equal(approved.activities.filter((item) => item.kind === "command").length, 1);
  assert.equal(approved.latest.status, "completed");

  const toolFailed = buildClaudeSessions(records(...base, hook("PostToolUseFailure", { tool_name: "Bash", tool_use_id: "b1", error: "boom" }, NOW + 3)), { now: NOW + 5000 })[0].agents[0];
  assert.equal(toolFailed.latest.status, "failed");
  assert.equal(toolFailed.attention, "working");

  const crashed = buildClaudeSessions(records(...base, hook("StopFailure", { error_type: "rate_limit", error_message: "PRIVATE" }, NOW + 3)), { now: NOW + 5000 })[0].agents[0];
  assert.equal(crashed.attention, "failed");
  assert.equal(crashed.status, "failed");
  assert.equal(crashed.turnStates.at(-1).error, "Claude Code hit a rate limit.");
  assert.equal(crashed.activities.find((item) => item.kind === "command").status, "failed");

  const finished = buildClaudeSessions(records(...base, hook("Stop", { last_assistant_message: "All tests pass." }, NOW + 3)), { now: NOW + 5000 })[0].agents[0];
  assert.equal(finished.status, "completed");
  assert.equal(finished.attention, "quiet");
  assert.equal(finished.turnStates.at(-1).status, "completed");
  // A step whose PostToolUse never arrived is not left running after the turn ends.
  assert.ok(finished.activities.every((item) => item.status !== "inProgress"));

  const asked = buildClaudeSessions(records(...base, hook("Stop", { last_assistant_message: "Ready. Want me to push?" }, NOW + 3)), { now: NOW + 5000 })[0].agents[0];
  assert.deepEqual(asked.turnStates.at(-1).questions, ["Ready. Want me to push?"]);
  assert.equal(asked.attention, "needs");
  const oldAsk = buildClaudeSessions(records(...base, hook("Stop", { last_assistant_message: "Want me to push?" }, NOW + 3)), { now: NOW + CLAUDE_LIMITS.askMs + 10_000 })[0].agents[0];
  assert.equal(oldAsk.attention, "quiet");

  const ended = buildClaudeSessions(records(...base, hook("SessionEnd", { reason: "prompt_input_exit" }, NOW + 3)), { now: NOW + 5000 })[0].agents[0];
  assert.equal(ended.status, "ended");
  assert.equal(ended.turnStates.at(-1).status, "interrupted");

  // An open shell command heard nothing from for longer than the shell tool can run: idle.
  const silent = buildClaudeSessions(records(...base), { now: NOW + CLAUDE_LIMITS.staleMs + 10_000 })[0].agents[0];
  assert.equal(silent.status, "idle");
  assert.equal(silent.attention, "quiet");
  // Any other open call (a subagent at work) is stale only after two hours.
  const agentCall = [hook("UserPromptSubmit", {}, NOW), hook("PreToolUse", { tool_name: "Agent", tool_use_id: "g1", tool_input: { description: "Audit" } }, NOW + 1)];
  const lost = buildClaudeSessions(records(...agentCall), { now: NOW + CLAUDE_LIMITS.staleMs + 10_000 })[0].agents[0];
  assert.equal(lost.status, "stale");
  assert.equal(lost.attention, "quiet");
});

test("a permission request stays open until its own tool resolves, not when another tool finishes", () => {
  const asked = records(
    hook("UserPromptSubmit", {}, NOW),
    hook("PreToolUse", { tool_name: "Bash", tool_use_id: "toolA", tool_input: { command: "x" } }, NOW + 1),
    hook("PreToolUse", { tool_name: "Read", tool_use_id: "toolB", tool_input: { file_path: "/w/b.js" } }, NOW + 2),
    hook("PermissionRequest", { tool_name: "Bash", tool_use_id: "toolA" }, NOW + 3),
    hook("PreToolUse", { tool_name: "Grep", tool_use_id: "toolC" }, NOW + 4),
    hook("Notification", { notification_type: "permission_prompt" }, NOW + 5),
    hook("PostToolUse", { tool_name: "Read", tool_use_id: "toolB" }, NOW + 6),
  );
  const main = (list) => buildClaudeSessions(list, { now: NOW + 60_000 })[0].agents[0];
  assert.equal(main(asked).needsInput, true, "tool B finishing does not answer tool A's request");
  assert.equal(main(asked).attention, "needs");
  assert.equal(main(asked).status, "waiting");
  // A parallel tool that started before the notice and finishes later does not answer it either.
  const later = [...asked, ...records(hook("PostToolUseFailure", { tool_name: "Grep", tool_use_id: "toolC" }, NOW + 7))];
  assert.equal(main(later).needsInput, true);
  // Its own tool finishing does.
  const answered = main([...later, ...records(hook("PostToolUse", { tool_name: "Bash", tool_use_id: "toolA" }, NOW + 8))]);
  assert.equal(answered.needsInput, false);
  assert.equal(answered.attention, "working");
  // A denied request never gets a PostToolUse; the end of the turn resolves it.
  const denied = main([...later, ...records(hook("Stop", { last_assistant_message: "Skipped that command." }, NOW + 8))]);
  assert.equal(denied.needsInput, false);
  assert.equal(denied.attention, "quiet");
  // So does the session ending.
  assert.equal(main([...later, ...records(hook("SessionEnd", { reason: "other" }, NOW + 8))]).needsInput, false);

  // A subagent's request is its own: the session's goblin finishing a tool does not clear it.
  const [session] = buildClaudeSessions(records(
    hook("UserPromptSubmit", {}, NOW),
    hook("SubagentStart", { agent_id: "agent-k", agent_type: "Explore" }, NOW + 1),
    hook("PreToolUse", { agent_id: "agent-k", tool_name: "WebFetch", tool_use_id: "toolK" }, NOW + 2),
    hook("PermissionRequest", { agent_id: "agent-k", tool_name: "WebFetch", tool_use_id: "toolK" }, NOW + 3),
    hook("PreToolUse", { tool_name: "Read", tool_use_id: "toolM", tool_input: { file_path: "/w/m.js" } }, NOW + 4),
    hook("PostToolUse", { tool_name: "Read", tool_use_id: "toolM" }, NOW + 5),
  ), { now: NOW + 5000 });
  const child = session.agents.find((agent) => agent.childOf);
  assert.equal(child.needsInput, true);
  assert.equal(child.attention, "needs");
});

test("caps keep sessions and subagents that need you, failed, or are working, and count what they leave out", () => {
  const limits = { ...CLAUDE_LIMITS, sessions: 3, children: 2 };
  const as = (session, input) => ({ ...input, session_id: session });
  const list = records(
    // The oldest session is the one waiting on a permission.
    as("cap-urgent", hook("UserPromptSubmit", {}, NOW)),
    as("cap-urgent", hook("PreToolUse", { tool_name: "Bash", tool_use_id: "u1" }, NOW + 1)),
    as("cap-urgent", hook("PermissionRequest", { tool_name: "Bash", tool_use_id: "u1" }, NOW + 2)),
    // A party with one failed and one working subagent, older than three quiet ones.
    as("cap-party", hook("UserPromptSubmit", {}, NOW + 10)),
    as("cap-party", hook("SubagentStart", { agent_id: "kid-busy", agent_type: "Explore" }, NOW + 11)),
    as("cap-party", hook("SubagentStart", { agent_id: "kid-fail", agent_type: "Plan" }, NOW + 12)),
    as("cap-party", hook("StopFailure", { agent_id: "kid-fail", error_type: "server_error" }, NOW + 13)),
    ...[1, 2, 3].flatMap((n) => [
      as("cap-party", hook("SubagentStart", { agent_id: `kid-quiet-${n}` }, NOW + 20 + n)),
      as("cap-party", hook("SubagentStop", { agent_id: `kid-quiet-${n}`, last_assistant_message: "Done." }, NOW + 30 + n)),
    ]),
    as("cap-party", hook("Stop", { last_assistant_message: "Handed off." }, NOW + 40)),
    // Five quiet sessions, all newer than both.
    ...[1, 2, 3, 4, 5].flatMap((n) => [
      as(`cap-quiet-${n}`, hook("UserPromptSubmit", {}, NOW + 100 + n)),
      as(`cap-quiet-${n}`, hook("Stop", { last_assistant_message: "Done." }, NOW + 110 + n)),
    ]),
  );
  const { sessions, truncated } = buildClaudeFeed(list, { now: NOW + 10_000, limits });
  assert.deepEqual(sessions.map((session) => session.session), ["cap-quiet-5", "cap-party", "cap-urgent"]);
  const urgent = sessions.find((session) => session.session === "cap-urgent");
  assert.equal(urgent.agents[0].attention, "needs");
  const party = sessions.find((session) => session.session === "cap-party");
  assert.deepEqual(party.agents.map((agent) => agent.attention).sort(), ["failed", "quiet", "working"], "main goblin plus the two urgent subagents");
  assert.deepEqual(party.hidden, { agents: 3, active: 0, urgent: 0 });
  assert.deepEqual(truncated, { parties: 4, agents: 7, active: 0, urgent: 0 });

  // When even the urgent ones do not fit, the cut is counted and the all-parties scene says so.
  const flood = records(...[1, 2].flatMap((n) => [
    as(`flood-${n}`, hook("UserPromptSubmit", {}, NOW + n)),
    as(`flood-${n}`, hook("PreToolUse", { tool_name: "Bash", tool_use_id: `f${n}` }, NOW + 10 + n)),
  ]));
  const cut = buildClaudeFeed(flood, { now: NOW + 10_000, limits: { ...limits, sessions: 1 } });
  assert.equal(cut.sessions.length, 1);
  assert.deepEqual(cut.truncated, { parties: 1, agents: 1, active: 1, urgent: 0 });
  const scene = composeAllScene({
    codex: { ok: true, threads: [], listComplete: true, checked: { records: [], pending: 0, failed: 0, candidates: 0, capped: false } },
    claude: { ok: true, snapshot: { sessions: cut.sessions, truncated: cut.truncated, warning: "" } },
    orca: { ok: true, snapshot: { workspaces: [], warning: "", missing: true } },
    now: NOW + 10_000,
  });
  assert.equal(scene.coverage.complete, false);
  assert.deepEqual(scene.coverage.claudeTruncated, { sessions: 1, agents: 1, active: 1, urgent: 0 });
  assert.equal(scene.coverage.activeTotal, 2);
  assert.equal(scene.coverage.activeShown, 1);
  assert.match(scene.warning, /1 more active members were left out/);
});

test("a focused Claude party reports subagents its cap left out", () => {
  const dir = tempDir();
  try {
    const list = records(
      hook("UserPromptSubmit", {}, NOW),
      ...[1, 2, 3].map((n) => hook("SubagentStart", { agent_id: `busy-${n}`, agent_type: "Explore" }, NOW + n)),
    );
    for (const record of list) appendClaudeRecord(record, { dir });
    const reader = new ClaudeReader({ dir, ttlMs: 0, clock: () => NOW + 10_000, limits: { ...CLAUDE_LIMITS, children: 1 } });
    const scene = reader.scene(`claude:${SESSION}`);
    assert.equal(scene.agents.length, 2);
    assert.deepEqual(scene.coverage, { agentsShown: 2, agentsHidden: 2, activeHidden: 2, urgentHidden: 0, complete: false });
    assert.match(scene.warning, /2 subagents still active were left out/);
    assert.deepEqual(reader.snapshot().truncated, { parties: 0, agents: 2, active: 2, urgent: 0 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the Claude log is read from its newest bytes without loading the whole file", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "tail.jsonl");
    writeFileSync(file, `${"first line that will be cut\n"}${"x".repeat(100)}\nkeep-1\nkeep-2\n`);
    assert.equal(readFileTail(file, 1_000_000), readFileSync(file, "utf8"), "a small file is read whole");
    assert.equal(readFileTail(file, 20), "keep-1\nkeep-2\n", "a partial first line is dropped");
    writeFileSync(file, "y".repeat(5000));
    assert.equal(readFileTail(file, 1000), "", "a tail with no line break is one partial line");
    // Multi-byte text is cut only at a line break, never inside a character.
    writeFileSync(file, `${"é".repeat(300)}\nfin ✓\n`);
    assert.equal(readFileTail(file, 12), "fin ✓\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("several sessions stay separate parties and the reader lists and opens each", () => {
  const dir = tempDir();
  try {
    const first = records(hook("UserPromptSubmit", {}, NOW), hook("PreToolUse", { tool_name: "Edit", tool_use_id: "e1", tool_input: { file_path: "/work/goblin-horde/app.js" } }, NOW + 1));
    const second = records({ ...hook("UserPromptSubmit", {}, NOW + 2), session_id: OTHER, cwd: "/work/other" }, { ...hook("Stop", { last_assistant_message: "Done." }, NOW + 3), session_id: OTHER, cwd: "/work/other" });
    for (const record of [...first, ...second]) appendClaudeRecord(record, { dir });
    appendFileSync(join(dir, "activity.jsonl"), "{half a line");
    const reader = new ClaudeReader({ dir, ttlMs: 0, clock: () => NOW + 10_000 });
    const catalog = reader.listSessions();
    assert.deepEqual(catalog.map((item) => item.id).sort(), [`claude:${OTHER}`, `claude:${SESSION}`].sort());
    assert.ok(catalog.every((item) => item.source === "claude" && /^Claude · /.test(item.name)));
    const scene = reader.scene(`claude:${SESSION}`);
    assert.equal(scene.root.source, "claude");
    assert.equal(scene.replyAvailable, false);
    assert.deepEqual(scene.requests, []);
    assert.equal(scene.agents[0].latest.title, "Changed app.js");
    assert.equal(scene.agents[0].latest.kind, "file");
    assert.equal(reader.scene("claude:../escape"), null);
    assert.equal(reader.scene(`claude:missing-session`), null);
    assert.equal(reader.snapshot().warning, "");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a missing Claude log is an empty, healthy feed", () => {
  const reader = new ClaudeReader({ dir: join(tmpdir(), "goblin-claude-test-does-not-exist"), ttlMs: 0 });
  assert.deepEqual(reader.snapshot().sessions, []);
  assert.equal(reader.snapshot().warning, "");
});

test("the all-party feed carries Claude, Codex, and Orca members, and absent Orca is not a warning", () => {
  const claudeSessions = buildClaudeSessions(records(
    hook("UserPromptSubmit", {}, NOW - 1000),
    hook("PreToolUse", { tool_name: "Read", tool_use_id: "r1", tool_input: { file_path: "/w/a.js" } }, NOW - 900),
    hook("SubagentStart", { agent_id: "agent-1", agent_type: "Plan" }, NOW - 800),
    hook("Notification", { agent_id: "agent-1", notification_type: "permission_prompt" }, NOW - 700),
  ), { now: NOW });
  const codexThread = { id: "codex-thread-1", name: "Codex chat", status: "active", updatedAt: NOW - 500, turnStates: [{ id: "t", status: "inProgress", questions: [] }], activities: [], counts: {} };
  const codex = { ok: true, threads: [{ id: "codex-thread-1", updatedAt: NOW - 500 }], listComplete: true,
    checked: { records: [{ thread: codexThread, attention: "working" }], pending: 0, failed: 0, candidates: 1, capped: false } };
  const scene = composeAllScene({
    codex, now: NOW,
    claude: { ok: true, snapshot: { sessions: claudeSessions, warning: "" } },
    orca: { ok: true, snapshot: { workspaces: [], warning: "", missing: true } },
  });
  assert.equal(scene.warning, "");
  assert.equal(scene.coverage.complete, true);
  assert.equal(scene.coverage.orcaInstalled, false);
  assert.equal(scene.coverage.orcaAvailable, true);
  const bySource = (source) => scene.agents.filter((agent) => agent.source === source);
  assert.equal(bySource("codex").length, 1);
  assert.equal(bySource("claude").length, 2);
  const child = bySource("claude").find((agent) => agent.childOf);
  assert.equal(child.attention, "needs");
  assert.equal(child.needsInput, true);
  assert.equal(scene.totals.recentClaude, 2);
  assert.equal(scene.totals.claudeSessions, 1);
  assert.equal(scene.coverage.activeTotal, 3);
  // Claude needs-you is never turned into a Codex request the phone could answer.
  assert.deepEqual(scene.requests, []);

  // An Orca that is installed but failing still says so; a broken Claude log does too.
  const partial = composeAllScene({ codex, now: NOW,
    claude: { ok: true, snapshot: { sessions: [], warning: "Claude Code activity could not be read." } },
    orca: { ok: true, snapshot: { workspaces: [], warning: "Orca feed is unavailable: timeout" } } });
  assert.equal(partial.coverage.complete, false);
  assert.match(partial.warning, /Orca feed is unavailable/);
  assert.match(partial.warning, /Claude Code activity could not be read/);
  assert.equal(partial.coverage.claudeAvailable, false);
});

test("a StopFailure names its reason from the documented error field, and an old one stops calling for attention", () => {
  const start = NOW - 3 * 60 * 60_000;
  const failed = records(
    hook("UserPromptSubmit", {}, start),
    hook("StopFailure", { error: "overloaded", error_details: "529 Overloaded", last_assistant_message: "API Error: Overloaded" }, start + 1000),
  );
  assert.equal(failed[1].errorType, "overloaded");
  assert.equal(JSON.stringify(failed[1]).includes("529"), false, "details are not kept");
  const fresh = buildClaudeSessions(failed, { now: start + 5 * 60_000 })[0].agents[0];
  assert.equal(fresh.attention, "failed");
  assert.equal(fresh.latest.description, "Claude was overloaded.");
  const later = buildClaudeSessions(failed, { now: start + CLAUDE_LIMITS.failedMs + 60_000 })[0].agents[0];
  assert.equal(later.attention, "quiet");
  assert.equal(later.status, "failed", "the stream still says it stopped with an error");
  // Older Claude Code versions sent error_type.
  assert.equal(records(hook("StopFailure", { error_type: "rate_limit" }))[0].errorType, "rate_limit");
});

test("an interrupted turn or a denied permission is over once Claude Code is back at its prompt", () => {
  const base = [hook("UserPromptSubmit", {}, NOW), hook("PreToolUse", { tool_name: "Bash", tool_use_id: "b1", tool_input: { command: "x" } }, NOW + 1)];
  const idle = (at) => hook("Notification", { notification_type: "idle_prompt" }, at);
  const main = (list, now = NOW + 120_000) => buildClaudeSessions(records(...list), { now })[0].agents[0];
  // Esc: no Stop, no PostToolUse. Without the idle notice it looks busy for two hours.
  assert.equal(main(base).attention, "working");
  const interrupted = main([...base, idle(NOW + 61_000)]);
  assert.equal(interrupted.attention, "quiet");
  assert.equal(interrupted.turnStates.at(-1).status, "interrupted");
  assert.ok(interrupted.activities.every((item) => item.status !== "inProgress"));
  assert.notEqual(interrupted.status, "failed");
  // A denied permission never gets its PostToolUse; without the idle notice it needs you for six hours.
  const denied = [...base, hook("PermissionRequest", { tool_name: "Bash", tool_use_id: "b1" }, NOW + 2),
    hook("Notification", { notification_type: "permission_prompt" }, NOW + 6000)];
  assert.equal(main(denied).attention, "needs");
  const settled = main([...denied, idle(NOW + 62_000)]);
  assert.equal(settled.attention, "quiet");
  assert.equal(settled.needsInput, false);
  // A finished reply that asks a question still asks it after the prompt goes idle.
  assert.equal(main([...base, hook("Stop", { last_assistant_message: "Want me to push?" }, NOW + 3), idle(NOW + 63_000)]).attention, "needs");
  // A new prompt after the idle notice works as before.
  assert.equal(main([...base, idle(NOW + 61_000), hook("UserPromptSubmit", {}, NOW + 70_000)]).attention, "working");
});


test("back at the prompt, a subagent's interrupted turn is over too", () => {
  const start = NOW - 10 * 60_000;
  const sessions = buildClaudeSessions(records(
    hook("UserPromptSubmit", {}, start),
    hook("SubagentStart", { agent_id: "sub1", agent_type: "Explore" }, start + 1000),
    hook("PreToolUse", { agent_id: "sub1", agent_type: "Explore", tool_name: "Grep", tool_use_id: "toolu_s1" }, start + 2000),
    hook("Notification", { notification_type: "idle_prompt" }, start + 70_000),
  ), { now: start + 80_000 });
  const child = sessions[0].agents.find((agent) => agent.childOf);
  assert.equal(child.attention, "quiet");
  assert.notEqual(child.status, "active");
});
