/**
 * The Claude Code detail reader: mission, plan, now, said, trail and files from a synthetic
 * transcript, and bounded, cached reads of transcript files in a temporary config folder.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeDetailReader, encodeProjectDir, parseClaudeTranscript, promptText, recordedTranscript, transcriptHead } from "../lib/claude-detail.mjs";
import { readFileTail } from "../lib/claude.mjs";

const T0 = Date.parse("2026-05-01T10:00:00.000Z");
const CWD = "C:\\work\\billing-api";
const ts = (seconds) => new Date(T0 + seconds * 1000).toISOString();
const line = (record) => JSON.stringify(record);
const user = (s, content, extra = {}) => line({ type: "user", timestamp: ts(s), uuid: `u${s}`, cwd: CWD, gitBranch: "ship-csv", message: { role: "user", content }, ...extra });
const assistant = (s, blocks, extra = {}) => line({ type: "assistant", timestamp: ts(s), uuid: `a${s}`, cwd: CWD, gitBranch: "ship-csv", message: { role: "assistant", content: blocks }, ...extra });
const tool = (id, name, input) => ({ type: "tool_use", id, name, input });
const result = (s, id, content, { isError = false, extra } = {}) => line({ type: "user", timestamp: ts(s), uuid: `r${s}`,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] }, ...(extra ? { toolUseResult: extra } : {}) });
const system = (s, subtype) => line({ type: "system", subtype, timestamp: ts(s) });

function workingTranscript() {
  return [
    user(0, "Earlier question"),
    assistant(1, [{ type: "text", text: "Earlier answer." }]),
    system(2, "turn_duration"),
    user(9, "<command-name>/model</command-name>"),
    user(10, [{ type: "text", text: "Ship the CSV export for billing-api" }, { type: "text", text: "<system-reminder>internal note</system-reminder>" }]),
    user(11, "Base directory for this skill: /skills/csv", { isMeta: true }),
    assistant(12, [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "I'll look around first." },
      tool("r1", "Read", { file_path: `${CWD}\\lib\\export.mjs` }), tool("g1", "Grep", { pattern: "csv", path: CWD })]),
    result(13, "r1", "file contents"),
    result(13, "g1", "lib/export.mjs:4: csv"),
    assistant(14, [tool("todo1", "TodoWrite", { todos: [
      { content: "Read the exporter", status: "completed", activeForm: "Reading the exporter" },
      { content: "Fix the header row", status: "in_progress", activeForm: "Fixing the header row" },
      { content: "Run the tests", status: "pending", activeForm: "Running the tests" }] })]),
    result(14, "todo1", "Todos updated"),
    assistant(15, [tool("b1", "Bash", { command: "npm test", description: "Run tests" })]),
    result(17, "b1", "Exit code 1\nFAIL export.test.mjs\napi_key=sk-live-abcdefghijklmnopqrstuvwx", { isError: true }),
    assistant(18, [tool("e1", "Edit", { file_path: `${CWD}\\lib\\export.mjs`, old_string: "a\nb", new_string: "a\nb\nc\nd" })]),
    result(19, "e1", "The file was updated."),
    assistant(20, [tool("w1", "Write", { file_path: `${CWD}\\docs\\csv.md`, content: "x\ny\nz\n" })]),
    result(20.5, "w1", "File created.", { extra: { type: "create", filePath: `${CWD}\\docs\\csv.md` } }),
    assistant(21, [tool("t1", "Agent", { subagent_type: "Explore", description: "Find callers", prompt: "Find every caller of exportCsv" })]),
    result(30, "t1", [{ type: "text", text: "Found 3 callers" }], { extra: { agentId: "a1b2c3", status: "completed" } }),
    assistant(31, [{ type: "text", text: "Tests fail on the header row." }, { type: "text", text: "Fixing it next." }]),
    assistant(32, [tool("b2", "Bash", { command: "npm test -- export" })]),
    user(33, "Sidechain prompt", { isSidechain: true }),
  ].join("\n");
}

test("the mission is the newest prompt the person typed, never tool results or injected text", () => {
  assert.equal(promptText({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } }), "");
  assert.equal(promptText({ type: "user", isMeta: true, message: { content: "Skill body" } }), "");
  assert.equal(promptText({ type: "user", message: { content: "<local-command-stdout>done</local-command-stdout>" } }), "");
  assert.equal(promptText({ type: "user", message: { content: "[Request interrupted by user]" } }), "");
  assert.equal(promptText({ type: "user", message: { content: [{ type: "text", text: "Fix it" }, { type: "text", text: "<system-reminder>x</system-reminder>" }] } }), "Fix it");
  const detail = parseClaudeTranscript(workingTranscript(), { session: "sess-1", cwd: CWD });
  assert.deepEqual(detail.mission, { text: "Ship the CSV export for billing-api", from: "you", at: T0 + 10_000 });
  assert.equal(detail.turnStartFound, true);
  assert.equal(detail.branch, "ship-csv");
});

test("plan, now, and what it said come from the current turn", () => {
  const detail = parseClaudeTranscript(workingTranscript(), { session: "sess-1", cwd: CWD });
  assert.equal(detail.plan.source, "todos");
  assert.deepEqual(detail.plan.steps, [
    { text: "Read the exporter", status: "done" }, { text: "Fixing the header row", status: "active" }, { text: "Run the tests", status: "pending" }]);
  assert.deepEqual(detail.now, { kind: "command", title: "Running npm test -- export", detail: "npm test -- export", startedAt: T0 + 32_000 });
  assert.deepEqual(detail.said, { text: "Tests fail on the header row.\n\nFixing it next.", at: T0 + 31_000 });
  assert.equal(detail.turnOpen, true);
});

test("the trail shows commands with exit codes and output, edits with line counts, and links to subagents", () => {
  const { trail, files } = parseClaudeTranscript(workingTranscript(), { session: "sess-1", cwd: CWD });
  assert.equal(trail[0].id, "b2");
  assert.equal(trail[0].status, "running");
  const failed = trail.find((row) => row.id === "b1");
  assert.equal(failed.kind, "command");
  assert.equal(failed.title, "npm test");
  assert.equal(failed.status, "failed");
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.durationMs, 2000);
  assert.match(failed.output, /FAIL export\.test\.mjs/);
  assert.doesNotMatch(failed.output, /sk-live-abcdefghijklmnopqrstuvwx/, "secrets are removed from output");
  const edit = trail.find((row) => row.id === "e1");
  assert.deepEqual([edit.kind, edit.title, edit.added, edit.removed, edit.detail], ["edit", "Edited export.mjs", 4, 2, "lib\\export.mjs"]);
  const write = trail.find((row) => row.id === "w1");
  assert.deepEqual([write.kind, write.title, write.added], ["write", "Created csv.md", 3]);
  const agent = trail.find((row) => row.id === "t1");
  assert.deepEqual([agent.kind, agent.title, agent.agentId, agent.status, agent.output], ["agent", "Started subagent Explore", "claude-agent:sess-1:a1b2c3", "ok", "Found 3 callers"]);
  assert.equal(agent.durationMs, 9000);
  // The read and the search right after it are one row; the older turn's answer is still there.
  const lookups = trail.find((row) => row.id === "r1" || row.id === "g1");
  assert.equal(lookups.title, "Read 1 file and searched 1 time");
  assert.deepEqual(lookups.paths, ["csv", "lib\\export.mjs"]);
  assert.ok(trail.some((row) => row.kind === "message" && row.title === "Earlier answer."));
  assert.ok(!trail.some((row) => /Sidechain/.test(row.title)), "side-chain records belong to subagents");
  assert.deepEqual(files.map((file) => [file.path, file.added, file.removed]), [["docs\\csv.md", 3, 0], ["lib\\export.mjs", 4, 2]]);
});

test("a finished turn has nothing running, and Claude Code's own patch counts lines when it kept one", () => {
  const text = [
    user(0, "Tidy the README"),
    assistant(1, [tool("e1", "Edit", { file_path: `${CWD}\\README.md`, old_string: "x", new_string: "y" })]),
    result(2, "e1", "ok", { extra: { structuredPatch: [{ lines: [" keep", "-old one", "-old two", "+new"] }] } }),
    assistant(3, [{ type: "text", text: "Done." }]),
    system(4, "turn_duration"),
  ].join("\n");
  const detail = parseClaudeTranscript(text, { session: "s", cwd: CWD });
  assert.equal(detail.now, null);
  assert.equal(detail.turnOpen, false);
  assert.deepEqual(detail.files, [{ path: "README.md", added: 1, removed: 2, at: T0 + 1000 }]);
  assert.deepEqual(detail.said, { text: "Done.", at: T0 + 3000 });
});

test("TaskCreate and TaskUpdate become the plan when they are newer than any todo list", () => {
  const text = [
    user(0, "Plan the release"),
    assistant(1, [tool("c1", "TaskCreate", { subject: "Write tests" })]),
    result(1, "c1", "Task created", { extra: { task: { id: "1", subject: "Write tests" } } }),
    assistant(2, [tool("c2", "TaskCreate", { subject: "Ship it" })]),
    result(2, "c2", "Task #2 created successfully"),
    assistant(3, [tool("u1", "TaskUpdate", { taskId: "1", status: "completed" }), tool("u2", "TaskUpdate", { taskId: "2", status: "in_progress" })]),
  ].join("\n");
  const { plan } = parseClaudeTranscript(text, { session: "s" });
  assert.equal(plan.source, "tasks");
  assert.deepEqual(plan.steps, [{ text: "Write tests", status: "done" }, { text: "Ship it", status: "active" }]);
});

test("a subagent transcript's first prompt is its task from the parent", () => {
  const head = transcriptHead([user(0, "Find every caller of exportCsv", { isSidechain: true }), assistant(1, [{ type: "text", text: "Looking." }])].join("\n"));
  assert.deepEqual(head, { startedAt: T0, prompt: { text: "Find every caller of exportCsv", at: T0 } });
  const detail = parseClaudeTranscript([user(0, "Find callers", { isSidechain: true }), assistant(1, [{ type: "text", text: "Found them." }], { isSidechain: true })].join("\n"), { subagent: true });
  assert.equal(detail.mission.from, "parent");
  assert.equal(detail.said.text, "Found them.");
});

test("recorded transcript paths are trusted only when they name this session's own file", () => {
  const records = [
    { session: "s1", transcript: "C:\\cfg\\projects\\x\\s1.jsonl" },
    { session: "s1", agent: "a1", agentTranscript: "C:\\cfg\\projects\\x\\s1\\subagents\\agent-a1.jsonl" },
    { session: "s1", transcript: "C:\\Windows\\win.ini" },
    { session: "s2", transcript: "/home/me/.claude/projects/y/s2.jsonl" },
  ];
  assert.deepEqual(recordedTranscript(records, "s1", "a1"), { main: "C:\\cfg\\projects\\x\\s1.jsonl", agent: "C:\\cfg\\projects\\x\\s1\\subagents\\agent-a1.jsonl" });
  assert.deepEqual(recordedTranscript([{ session: "s3", transcript: "relative/s3.jsonl" }, { session: "s3", transcript: "/x/other.jsonl" }], "s3"), { main: "", agent: "" });
  assert.equal(recordedTranscript(records, "s2").main, "/home/me/.claude/projects/y/s2.jsonl");
});

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "goblin-claude-detail-"));
  const configDir = join(root, "claude");
  return { root, configDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A file system that counts tail reads, so tests can see how much was read. */
function countingFs() {
  const calls = [];
  const fs = new ClaudeDetailReader().fs;
  return { calls, fs: { ...fs, readTail: (file, bytes) => { calls.push(bytes); return readFileTail(file, bytes); } } };
}

test("transcripts are found by their project folder, by a scan, or not at all, and subagents beside them", () => {
  const box = sandbox();
  try {
    const folder = join(box.configDir, "projects", encodeProjectDir(CWD));
    mkdirSync(join(folder, "sess-1", "subagents"), { recursive: true });
    writeFileSync(join(folder, "sess-1.jsonl"), `${user(0, "Hello")}\n`);
    writeFileSync(join(folder, "sess-1", "subagents", "agent-a1.jsonl"), `${user(0, "Sub task", { isSidechain: true })}\n`);
    const other = join(box.configDir, "projects", "elsewhere");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "sess-2.jsonl"), `${user(0, "Moved")}\n`);
    const reader = new ClaudeDetailReader({ configDir: box.configDir });
    assert.equal(reader.locate({ session: "sess-1", cwd: CWD }), join(folder, "sess-1.jsonl"));
    assert.equal(reader.locate({ session: "sess-2", cwd: CWD }), join(other, "sess-2.jsonl"));
    assert.equal(reader.locate({ session: "sess-1", agent: "a1" }), join(folder, "sess-1", "subagents", "agent-a1.jsonl"));
    assert.equal(reader.locate({ session: "missing" }), "");
    assert.equal(reader.locate({ session: "../escape" }), "");
    assert.equal(reader.read({ session: "sess-1", agent: "a1" }).mission.from, "parent");
    assert.equal(reader.read({ session: "sess-1", cwd: CWD }).mission.text, "Hello");
  } finally { box.cleanup(); }
});

test("a long turn's start is looked for further back, and an unchanged file is answered from memory", () => {
  const box = sandbox();
  try {
    const folder = join(box.configDir, "projects", encodeProjectDir(CWD));
    mkdirSync(folder, { recursive: true });
    const file = join(folder, "long.jsonl");
    const filler = Array.from({ length: 150 }, (_, index) => [assistant(20 + index, [tool(`b${index}`, "Bash", { command: `step ${index}` })]),
      result(20 + index, `b${index}`, "o".repeat(10_000))].join("\n"));
    writeFileSync(file, [user(0, "Old prompt"), system(1, "turn_duration"), user(10, "Migrate the invoices table"), ...filler, assistant(500, [{ type: "text", text: "Halfway." }])].join("\n") + "\n");
    const { calls, fs } = countingFs();
    const reader = new ClaudeDetailReader({ configDir: box.configDir, fs });
    const first = reader.read({ session: "long", cwd: CWD });
    assert.equal(first.mission.text, "Migrate the invoices table");
    assert.deepEqual(calls, [1024 * 1024, 2 * 1024 * 1024], "1 MB first, then 2 MB when the start was not in view");
    assert.equal(first.trail.length, 60);
    assert.equal(reader.read({ session: "long", cwd: CWD }), first);
    assert.equal(calls.length, 2, "an unchanged transcript is not read again");
    appendFileSync(file, `${assistant(501, [{ type: "text", text: "Nearly there." }])}\n`);
    const second = reader.read({ session: "long", cwd: CWD });
    assert.equal(second.said.text, "Halfway.\n\nNearly there.");
    assert.equal(second.mission.text, "Migrate the invoices table");
    assert.equal(calls.length, 3, "the next read starts where the turn did: one read");
    assert.ok(calls[2] >= 1.5 * 1024 * 1024 && calls[2] < 2 * 1024 * 1024);
  } finally { box.cleanup(); }
});

test("a turn that began beyond the bounded read keeps the last prompt Claude Code noted", () => {
  const box = sandbox();
  try {
    const folder = join(box.configDir, "projects", encodeProjectDir(CWD));
    mkdirSync(folder, { recursive: true });
    const file = join(folder, "far.jsonl");
    const filler = Array.from({ length: 40 }, (_, index) => result(20 + index, `x${index}`, "z".repeat(1000)));
    writeFileSync(file, [user(10, "Rebuild the search index"), ...filler, line({ type: "last-prompt", lastPrompt: "Rebuild the search index", sessionId: "far" })].join("\n") + "\n");
    const { calls, fs } = countingFs();
    const reader = new ClaudeDetailReader({ configDir: box.configDir, fs, limits: { firstBytes: 4096, maxBytes: 16_384, headBytes: 4096, projectDirs: 10, cachedFiles: 8, missingMs: 1000 } });
    const detail = reader.read({ session: "far", cwd: CWD });
    assert.deepEqual(detail.mission, { text: "Rebuild the search index", from: "you", at: 0 });
    assert.deepEqual(calls, [4096, 8192, 16_384]);
    appendFileSync(file, `${assistant(90, [{ type: "text", text: "Still indexing." }])}\n`);
    const later = reader.read({ session: "far", cwd: CWD });
    assert.equal(calls.length, 4, "past the limit once, only the newest part is read after that");
    assert.ok(calls[3] < 8192);
    assert.equal(later.mission.text, "Rebuild the search index");
    assert.equal(later.said.text, "Still indexing.");
  } finally { box.cleanup(); }
});

/**
 * A file system that records every call as "method path", so a test can see what was never touched:
 * realpath only asks where a path leads; stat, readTail and readHead open the file itself.
 */
function watchingFs() {
  const touched = [];
  const fs = new ClaudeDetailReader().fs;
  const watch = (name) => (path, ...rest) => { touched.push(`${name} ${path}`); return fs[name](path, ...rest); };
  const opened = (fragment) => touched.filter((call) => call.includes(fragment) && !call.startsWith("realpath ") && !call.startsWith("readdir "));
  return { touched, opened, fs: { stat: watch("stat"), realpath: watch("realpath"), readTail: watch("readTail"), readHead: watch("readHead"), readdir: watch("readdir") } };
}

test("a forged transcript path in the hook log is never read, whatever its name", () => {
  const box = sandbox();
  try {
    const folder = join(box.configDir, "projects", encodeProjectDir(CWD));
    mkdirSync(join(folder, "sess-1", "subagents"), { recursive: true });
    writeFileSync(join(folder, "sess-1.jsonl"), `${user(0, "Hello")}\n`);
    const outside = join(box.root, "elsewhere");
    mkdirSync(join(outside, "sess-1", "subagents"), { recursive: true });
    for (const name of ["sess-9.jsonl", "sess-1.jsonl", join("sess-1", "subagents", "agent-a9.jsonl")]) writeFileSync(join(outside, name), `${user(0, "PRIVATE-ELSEWHERE")}\n`);
    const forged = [
      { session: "sess-9", transcript: join(outside, "sess-9.jsonl") },
      { session: "sess-9", transcript: join(folder, "..", "..", "..", "elsewhere", "sess-9.jsonl") },
      { session: "sess-1", agent: "a9", agentTranscript: join(outside, "sess-1", "subagents", "agent-a9.jsonl") },
    ];
    const { touched, opened, fs } = watchingFs();
    const reader = new ClaudeDetailReader({ configDir: box.configDir, fs });
    assert.equal(recordedTranscript(forged.slice(0, 1), "sess-9").main, join(outside, "sess-9.jsonl"), "the name alone passes");
    assert.equal(reader.read({ session: "sess-9", recorded: recordedTranscript(forged.slice(0, 1), "sess-9") }), null);
    assert.equal(reader.read({ session: "sess-9", recorded: recordedTranscript(forged.slice(1, 2), "sess-9") }), null);
    // The subagent's forged path is refused; its real place beside the session has no file, so nothing is read.
    assert.equal(reader.read({ session: "sess-1", agent: "a9", cwd: CWD, recorded: recordedTranscript(forged, "sess-1", "a9") }), null);
    assert.ok(touched.some((call) => call.startsWith("realpath ") && call.includes("elsewhere")), "where each forged path leads was checked");
    assert.deepEqual(opened("elsewhere"), [], "and none of them was opened");
    // The session's own transcript is still read as usual.
    assert.equal(reader.read({ session: "sess-1", cwd: CWD, recorded: { main: join(folder, "sess-1.jsonl") } }).mission.text, "Hello");
    assert.ok(opened("sess-1.jsonl").length > 0);
  } finally { box.cleanup(); }
});

test("a network or device path in the hook log is not even looked at", () => {
  const box = sandbox();
  try {
    mkdirSync(join(box.configDir, "projects"), { recursive: true });
    const { touched, fs } = watchingFs();
    const reader = new ClaudeDetailReader({ configDir: box.configDir, fs, platform: "win32" });
    for (const main of ["\\\\files.example.test\\share\\projects\\x\\sess-5.jsonl", "//files.example.test/share/projects/x/sess-5.jsonl",
      "\\\\?\\UNC\\files.example.test\\share\\sess-5.jsonl", "\\\\.\\pipe\\sess-5.jsonl", "C:\\work\\CON\\sess-5.jsonl"]) {
      assert.equal(reader.read({ session: "sess-5", recorded: { main } }), null, main);
      assert.equal(reader.read({ session: "sess-5", agent: "a5", recorded: { agent: main } }), null, main);
    }
    assert.deepEqual(touched.filter((path) => /files\.example|pipe|CON/.test(path)), []);
  } finally { box.cleanup(); }
});

test("a link inside the projects folder that leads outside it is not followed", (t) => {
  const box = sandbox();
  try {
    const projects = join(box.configDir, "projects");
    mkdirSync(projects, { recursive: true });
    const outside = join(box.root, "elsewhere");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "sess-7.jsonl"), `${user(0, "PRIVATE-ELSEWHERE")}\n`);
    try { symlinkSync(outside, join(projects, "linked"), process.platform === "win32" ? "junction" : "dir"); }
    catch { t.skip("this computer cannot make a folder link"); return; }
    const { fs, opened } = watchingFs();
    const reader = new ClaudeDetailReader({ configDir: box.configDir, fs });
    assert.equal(reader.read({ session: "sess-7", recorded: { main: join(projects, "linked", "sess-7.jsonl") } }), null);
    assert.equal(reader.read({ session: "sess-7" }), null, "nor found through it by the scan");
    assert.deepEqual(opened("sess-7"), []);
    assert.equal(reader.cache.size, 0);
  } finally { box.cleanup(); }
});

test("the projects folder is matched without regard to letter case on Windows", () => {
  const real = { "C:\\Users\\dev\\.claude\\projects": "C:\\Users\\dev\\.claude\\projects", "c:\\users\\DEV\\.Claude\\Projects\\x\\sess-3.jsonl": "C:\\Users\\dev\\.claude\\projects\\x\\sess-3.jsonl",
    "C:\\Users\\dev\\.claude\\projects-old\\sess-3.jsonl": "C:\\Users\\dev\\.claude\\projects-old\\sess-3.jsonl" };
  const fs = { realpath: (path) => { if (path in real) return real[path]; throw new Error("ENOENT"); } };
  const reader = new ClaudeDetailReader({ configDir: "C:\\Users\\dev\\.claude", fs, platform: "win32" });
  assert.equal(reader.allowed("c:\\users\\DEV\\.Claude\\Projects\\x\\sess-3.jsonl"), true);
  assert.equal(reader.allowed("C:\\Users\\dev\\.claude\\projects-old\\sess-3.jsonl"), false, "a neighbouring folder is not inside");
  assert.equal(reader.allowed("C:\\Users\\dev\\.claude\\projects"), false);
});

test("project folders are named the way Claude Code names them", () => {
  assert.equal(encodeProjectDir("C:\\work\\billing-api"), "C--work-billing-api");
  assert.equal(encodeProjectDir("/home/dev/ship_csv"), "-home-dev-ship-csv");
});
