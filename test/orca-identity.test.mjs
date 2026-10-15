import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeRecordIndex, cleanRecord, normalizeHookEvent, orcaIdentity } from "../lib/claude.mjs";

const NOW = 1_800_000_000_000;
const SESSION = "0rca1d00-0000-4000-8000-000000000001";
const HANDLE = "term_0a1b2c3d-1111-4222-8333-444455556666";
const PANE = "tab-7:9f8e7d6c-1111-4222-8333-444455556666";
const ORCA_ENV = { ORCA_TERMINAL_HANDLE: HANDLE, ORCA_PANE_KEY: PANE, ORCA_WORKTREE_ID: "repo-1::C:/work/billing-api-wt", ORCA_WORKSPACE_ID: "worktree:repo-1::C:/work/billing-api-wt" };
let counter = 0;
const record = (event, extra = {}, env = ORCA_ENV) => normalizeHookEvent({ hook_event_name: event, session_id: SESSION, cwd: "/work/billing-api", ...extra },
  { now: NOW + counter, id: (0x7000 + ++counter).toString(16).padStart(12, "0"), env });

test("SessionStart and UserPromptSubmit records keep the Orca terminal, pane, worktree, and workspace the session runs in", () => {
  for (const event of ["SessionStart", "UserPromptSubmit"]) {
    const saved = record(event, event === "UserPromptSubmit" ? { prompt: "Ship the invoice export" } : { source: "startup" });
    assert.deepEqual(saved.orca, { terminal: HANDLE, pane: PANE, worktree: "repo-1::C:/work/billing-api-wt", workspace: "worktree:repo-1::C:/work/billing-api-wt" }, event);
    // Read back from disk, the same record keeps it.
    assert.deepEqual(cleanRecord(JSON.parse(JSON.stringify(saved))).orca, saved.orca);
  }
  // Tool calls and the rest carry no identity: it does not change within one Claude Code process.
  assert.equal(record("PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_1", tool_input: { command: "npm test" } }).orca, undefined);
  assert.equal(record("Stop", { last_assistant_message: "Done." }).orca, undefined);
  // Outside Orca there is nothing to record.
  assert.equal(record("SessionStart", { source: "startup" }, {}).orca, undefined);
  assert.equal(record("SessionStart", { source: "startup" }, null).orca, undefined);
});

test("Orca ids are shape-checked and kept to 120 characters, long ones with a hash so equal ids stay equal", () => {
  assert.equal(orcaIdentity({ ORCA_TERMINAL_HANDLE: "--terminal=evil" }, { fromEnv: true }), null, "never a flag");
  assert.equal(orcaIdentity({ ORCA_TERMINAL_HANDLE: "term_../../x" }, { fromEnv: true }), null, "never a path");
  assert.equal(orcaIdentity({ ORCA_PANE_KEY: "no-colon" }, { fromEnv: true }), null);
  assert.equal(orcaIdentity({ ORCA_WORKTREE_ID: "line\nbreak" }, { fromEnv: true }), null, "one line only");
  assert.deepEqual(orcaIdentity({ ORCA_TERMINAL_HANDLE: ` ${HANDLE} ` }, { fromEnv: true }), { terminal: HANDLE });
  const long = `repo-9::C:/work/${"deep/".repeat(60)}wt`;
  const a = orcaIdentity({ ORCA_WORKTREE_ID: long }, { fromEnv: true }).worktree;
  const b = orcaIdentity({ ORCA_WORKTREE_ID: `${long}2` }, { fromEnv: true }).worktree;
  assert.ok(a.length <= 120 && b.length <= 120);
  assert.notEqual(a, b, "two long ids that differ only at the end stay different");
  assert.equal(orcaIdentity({ ORCA_WORKTREE_ID: long }, { fromEnv: true }).worktree, a, "and the same id clips the same way");
  assert.equal(orcaIdentity({ ORCA_TERMINAL_HANDLE: `term_${"a".repeat(200)}` }, { fromEnv: true }), null, "a handle is never clipped into another one");
  // A record from disk with a bad identity keeps everything else.
  const bad = cleanRecord({ v: 1, id: "abcdef0123456789", at: NOW, event: "SessionStart", session: SESSION, orca: { terminal: "rm -rf /", pane: 5 } });
  assert.equal(bad.orca, undefined);
  assert.equal(bad.session, SESSION);
});

test("a shell command's Orca targets are recorded before the credential filter blanks their handles", () => {
  const worker = "term_0b1b2c3d-1111-4222-8333-444455556666";
  const saved = record("PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_d1", tool_input: { command: `orca orchestration dispatch --task t-1 --to ${worker} --from ${HANDLE}` } });
  assert.doesNotMatch(saved.detail, /term_0b1b/, "the command as kept has the handle blanked");
  assert.deepEqual(saved.orcaTo, [{ terminal: worker, verb: "orchestration dispatch", flag: "to" }, { terminal: HANDLE, verb: "orchestration dispatch", flag: "from" }]);
  assert.deepEqual(cleanRecord(JSON.parse(JSON.stringify(saved))).orcaTo, saved.orcaTo);
  // Only real handles and verbs survive a record read back from disk; only shell calls carry them.
  const forged = cleanRecord({ ...saved, orcaTo: [{ terminal: "term_x; rm -rf /", verb: "orchestration dispatch", flag: "to" }, { terminal: worker, verb: "evil verb!", flag: "to" }] });
  assert.equal(forged.orcaTo, undefined);
  assert.equal(record("PreToolUse", { tool_name: "Read", tool_use_id: "toolu_r", tool_input: { file_path: `/x/orca orchestration dispatch --to ${worker}` } }).orcaTo, undefined);
  assert.equal(record("PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_e", tool_input: { command: "npm test" } }).orcaTo, undefined);
});

test("the record index keeps each session's newest identity past the shared record window", () => {
  const index = new ClaudeRecordIndex();
  const first = record("SessionStart", { source: "startup" });
  const moved = record("UserPromptSubmit", { prompt: "Carry on in the new pane" }, { ...ORCA_ENV, ORCA_TERMINAL_HANDLE: "term_ffffffff-1111-4222-8333-444455556666" });
  index.add(first);
  index.add(moved);
  const kept = index.records().filter((item) => item.orca);
  assert.equal(kept.at(-1).orca.terminal, "term_ffffffff-1111-4222-8333-444455556666");
});

test("the hook receiver records the identity from the terminal it runs in", () => {
  const dir = mkdtempSync(join(tmpdir(), "goblin-orca-hook-"));
  try {
    const hook = join(fileURLToPath(new URL("..", import.meta.url)), "claude-hook.mjs");
    const input = JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, cwd: "/work/billing-api", prompt: "Dispatch the export workers" });
    const run = spawnSync(process.execPath, [hook, "--state-dir", dir], { input, env: { ...process.env, ...ORCA_ENV }, encoding: "utf8", timeout: 20_000 });
    assert.equal(run.status, 0);
    assert.equal(run.stdout, "", "the hook prints nothing");
    const [line] = readFileSync(join(dir, "claude", "activity.jsonl"), "utf8").trim().split("\n");
    assert.equal(JSON.parse(line).orca.terminal, HANDLE);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
