import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMarkdown } from "../public/app/markdown.js";
import { renderDiff } from "../public/app/diff.js";
import { normalizeEntry, normalizeTranscript } from "../public/app/adapter.js";
import { TranscriptStore, renderEntry, toolSummary, updateEntry } from "../public/app/transcript.js";
import { claudeEntries, codexEntries, orcaEntries } from "../lib/transcript.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Just enough of a DOM to run the renderers in node. Assigning innerHTML, outerHTML, or href throws:
 * agent text must only ever reach the page as text nodes.
 */
class FakeNode {
  constructor(tag, text = null) {
    this.tagName = tag ? tag.toUpperCase() : "#text";
    this.children = [];
    this.parent = null;
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.style = { setProperty: (key, value) => { this.style[key] = value; } };
    this.ownText = text;
    this.className = "";
    this.hidden = false;
    const self = this;
    this.classList = {
      add: (...names) => { self.className = [...new Set([...self.className.split(" ").filter(Boolean), ...names])].join(" "); },
      remove: (...names) => { self.className = self.className.split(" ").filter((name) => name && !names.includes(name)).join(" "); },
      toggle: (name, force) => { const on = force ?? !self.classList.contains(name); if (on) self.classList.add(name); else self.classList.remove(name); return on; },
      contains: (name) => self.className.split(" ").includes(name),
    };
  }
  set innerHTML(_) { throw new Error("innerHTML is not allowed"); }
  set outerHTML(_) { throw new Error("outerHTML is not allowed"); }
  set href(_) { throw new Error("links must not navigate"); }
  insertAdjacentHTML() { throw new Error("insertAdjacentHTML is not allowed"); }
  get textContent() { return this.tagName === "#text" ? this.ownText : this.children.map((child) => child.textContent).join(""); }
  set textContent(value) { this.children = []; if (this.tagName === "#text") this.ownText = String(value); else if (value !== "") this.append(new FakeNode(null, String(value))); }
  append(...nodes) {
    for (const node of nodes) {
      const child = typeof node === "string" ? new FakeNode(null, node) : node;
      if (child.tagName === "#fragment") { for (const inner of [...child.children]) this.append(inner); continue; }
      child.parent?.children.splice(child.parent.children.indexOf(child), 1);
      child.parent = this;
      this.children.push(child);
    }
  }
  prepend(...nodes) { const old = this.children; this.children = []; this.append(...nodes); for (const node of old) this.children.push(node); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  replaceWith(node) { const at = this.parent.children.indexOf(this); this.parent.children[at] = node; node.parent = this.parent; this.parent = null; }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  setAttribute(key, value) { if (/^(href|src|srcdoc|on)/i.test(key)) throw new Error(`attribute ${key} is not allowed`); this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
  click() { for (const listener of this.listeners.get("click") || []) listener({ stopPropagation() {}, preventDefault() {} }); }
  *walk() { yield this; for (const child of this.children) yield* child.walk(); }
  find(predicate) { for (const node of this.walk()) if (predicate(node)) return node; return null; }
  findAll(predicate) { return [...this.walk()].filter(predicate); }
  byClass(name) { return this.find((node) => node.classList?.contains(name)); }
}

const doc = {
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (text) => new FakeNode(null, text),
  createDocumentFragment: () => new FakeNode("#fragment"),
};
const copyButton = (text, label) => { const node = doc.createElement("button"); node.textContent = label; node.dataset.copy = text; return node; };
const ctx = (fields = {}) => ({ doc, agent: { id: "a1", parentId: "c1" }, agentsById: new Map([["c1", { id: "c1", name: "Coordinator", role: "coordinator" }], ["sub-1", { id: "sub-1", name: "Explore", role: "subagent" }]]), copyButton, ...fields });

test("Markdown with hostile text renders as text nodes only: no script, no link that navigates", () => {
  const node = renderMarkdown("Hi <img src=x onerror=alert(1)> **bold** [click](javascript:alert(1)) <script>alert(2)</script>\n\n```html\n<b>raw</b>\n```", { doc, copyButton });
  const tags = new Set(node.findAll(() => true).map((item) => item.tagName));
  for (const banned of ["SCRIPT", "IMG", "A", "IFRAME"]) assert.ok(!tags.has(banned), banned);
  assert.match(node.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(node.textContent, /<script>alert\(2\)<\/script>/);
  const link = node.byClass("md-link");
  assert.equal(link.title, "javascript:alert(1)");
  assert.equal(link.find((item) => item.dataset?.copy).dataset.copy, "javascript:alert(1)", "the address is offered to copy, never followed");
  assert.equal(node.byClass("md-code").find((item) => item.tagName === "CODE").textContent, "<b>raw</b>");
});

test("Markdown renders tables, lists, tasks, quotes, and folds long code", () => {
  const long = Array.from({ length: 120 }, (_, index) => `line ${index}`).join("\n");
  const node = renderMarkdown(`| a | b |\n|---|--:|\n| 1 | 2 |\n\n- [x] done\n- todo\n\n> quoted\n\n\`\`\`js\n${long}\n\`\`\``, { doc, copyButton });
  assert.ok(node.find((item) => item.tagName === "TABLE"));
  assert.equal(node.find((item) => item.tagName === "TD" && item.textContent === "2").className, "align-right");
  assert.ok(node.byClass("md-task"));
  assert.ok(node.find((item) => item.tagName === "BLOCKQUOTE"));
  const code = node.byClass("md-code");
  assert.equal(code.find((item) => item.tagName === "CODE").textContent.split("\n").length, 60);
  code.byClass("md-more").click();
  assert.equal(code.find((item) => item.tagName === "CODE").textContent, long);
});

test("diffs render line numbers, signs, and marked changes as text", () => {
  const node = renderDiff("--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-let total = price * qty;\n+let total = price * quantity;\n <script>keep()</script>", { doc, copyButton });
  const rows = node.findAll((item) => item.classList?.contains("dl-row"));
  assert.deepEqual(rows.map((row) => row.className), ["dl-row del", "dl-row add", "dl-row ctx"]);
  assert.deepEqual(rows.map((row) => row.children.slice(0, 3).map((cell) => cell.textContent)), [["1", "", "−"], ["", "1", "+"], ["2", "2", ""]]);
  assert.equal(rows[1].byClass("chg").textContent, "uanti", "only the changed middle: q[uanti]ty");
  assert.equal(rows[2].byClass("code").textContent, "<script>keep()</script>");
  assert.equal(node.byClass("diff-path").textContent, "x.ts");
  // Long diffs show their start and offer the rest.
  const many = renderDiff(`@@ -0,0 +1,500 @@\n${Array.from({ length: 500 }, (_, index) => `+l${index}`).join("\n")}`, { doc, copyButton, limit: 100 });
  assert.equal(many.findAll((item) => item.classList?.contains("dl-row")).length, 100);
  many.byClass("diff-more").click();
  assert.equal(many.findAll((item) => item.classList?.contains("dl-row")).length, 500);
});

test("every entry kind renders; tool rows build their body only when opened", () => {
  const kinds = [
    { id: "p", kind: "prompt", from: "coordinator", text: "Do the thing" },
    { id: "m", kind: "message", text: "Done **well**" },
    { id: "r", kind: "reasoning", text: "**Thinking** about it" },
    { id: "pl", kind: "plan", plan: { steps: [{ text: "One", status: "completed" }, { text: "Two", status: "in_progress" }] } },
    { id: "s", kind: "subagent", agentId: "sub-1", tool: { name: "Task", input: { description: "Find readers" }, status: "running", agentId: "sub-1" } },
    { id: "a", kind: "ask", ask: { kind: "approval", text: "Run it?", command: "rm -rf build", options: ["Yes", "No"] } },
    { id: "y", kind: "system", text: "/compact" },
    { id: "c", kind: "compaction", text: "Summary so far" },
    { id: "e", kind: "error", text: "Turn failed" },
  ].map(normalizeEntry);
  for (const entry of kinds) {
    const node = renderEntry(entry, ctx());
    assert.equal(node.dataset.id, entry.id);
    assert.ok(node.textContent.length > 0, entry.kind);
  }
  assert.match(renderEntry(kinds[0], ctx()).textContent, /^From the coordinatorCopy prompt/, "a coordinator called Coordinator is not named twice");
  const opened = [];
  const sub = renderEntry(kinds[4], ctx({ openAgent: (id) => opened.push(id) }));
  sub.byClass("sub-open").click();
  assert.deepEqual(opened, ["sub-1"]);

  const big = "x".repeat(300 * 1024);
  const tool = normalizeEntry({ id: "t", kind: "tool", tool: { name: "shell", kind: "command", input: "npm test", status: "completed", exitCode: 1, output: `${"line\n".repeat(400)}${big}`, durationMs: 4000 } });
  const toggles = [];
  const node = renderEntry(tool, ctx({ onToggle: (id, open) => toggles.push([id, open]) }));
  assert.equal(node.byClass("tool-body"), null, "nothing heavy is built before opening");
  assert.equal(node.byClass("tool-exit").textContent, "exit 1");
  node.byClass("tool-head").click();
  assert.deepEqual(toggles, [["t", true]]);
  const output = node.findAll((item) => item.classList?.contains("io")).at(-1);
  assert.equal(output.find((item) => item.tagName === "PRE").textContent.split("\n").length, 201, "the first 200 lines");
  assert.ok(output.find((item) => item.dataset?.copy === tool.tool.output), "copy takes the whole output");
  output.byClass("io-more").click();
  assert.equal(output.find((item) => item.tagName === "PRE").textContent, tool.tool.output);
});

test("a changed entry is redrawn in place and stays open", () => {
  const running = normalizeEntry({ id: "t", kind: "tool", tool: { name: "shell", kind: "command", input: "npm test", status: "running" } });
  const parent = doc.createElement("div");
  const node = renderEntry(running, ctx());
  parent.append(node);
  node.byClass("tool-head").click();
  const done = normalizeEntry({ id: "t", kind: "tool", tool: { name: "shell", kind: "command", input: "npm test", status: "completed", exitCode: 0, output: "all good" } });
  const fresh = updateEntry(node, done, ctx());
  assert.equal(parent.children[0], fresh);
  assert.ok(fresh.classList.contains("open"));
  assert.match(fresh.textContent, /all good/);
});

test("the app's code never writes HTML strings, follows links, or evaluates text", () => {
  for (const file of ["app.js", "adapter.js", "transcript.js", "markdown.js", "diff.js", "demo-data.js"]) {
    const source = readFileSync(join(root, "public", "app", file), "utf8");
    for (const banned of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function\(/, /\.href\s*=/, /setAttribute\(\s*["']href/, /window\.open\(/, /location\.(assign|replace)\(/])
      assert.doesNotMatch(source, banned, `${file} must not use ${banned}`);
  }
  const page = readFileSync(join(root, "public", "app", "index.html"), "utf8");
  assert.doesNotMatch(page, /<script(?![^>]*\bsrc=)/, "no inline script (the page CSP forbids it)");
  assert.doesNotMatch(page, /\sstyle=|<style/, "no inline style");
  assert.doesNotMatch(page, /https?:\/\//, "nothing from the network");
});

// ---- Contract: the server's own entries (lib/transcript.mjs) read and render as intended. ----

const BASE = 1_800_000_000_000;
let serial = 0;
const stamp = () => new Date(BASE + ++serial * 1000).toISOString();
const uid = () => `u-${String(++serial).padStart(6, "0")}`;
const user = (content, extra = {}) => ({ type: "user", uuid: uid(), timestamp: stamp(), message: { role: "user", content }, origin: { kind: "human" }, ...extra });
const assistant = (content, extra = {}) => ({ type: "assistant", uuid: uid(), timestamp: stamp(), message: { role: "assistant", model: "claude-opus-4-1", content }, ...extra });
const call = (id, name, input) => assistant([{ type: "tool_use", id, name, input }]);
const answer = (id, content, extra = {}, isError = false) => user([{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }], extra);

function serverClaudeEntries() {
  const list = [
    user("Please carry out this task from my Orca coordinator by following the brief I pasted below.\n<pasted_content>You are working inside Orca, a multi-agent IDE."),
    assistant([{ type: "thinking", thinking: "The writer lives in src/csv.ts." }]),
    assistant([{ type: "text", text: "I'll **start** with the writer.\n\n| a | b |\n|---|---|\n| 1 | 2 |" }]),
    call("toolu_bash", "Bash", { command: "npm test -- csv", description: "Run the CSV tests", run_in_background: true }),
    answer("toolu_bash", "Exit code 1\n2 failing", {}, true),
    call("toolu_edit", "Edit", { file_path: "/work/app/src/csv.ts", old_string: "a,b", new_string: "a;b" }),
    answer("toolu_edit", "Updated", { toolUseResult: { structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 2, lines: ["-a,b", "+a;b", "+c;d"] }] } }),
    call("toolu_agent", "Agent", { description: "Find fixtures", prompt: "Look for invoice fixtures", subagent_type: "Explore" }),
    answer("toolu_agent", "Found 3", { toolUseResult: { agentId: "a1b2c3" } }),
    call("toolu_todo", "TodoWrite", { todos: [{ content: "Write tests", status: "completed" }, { content: "Ship", status: "in_progress", activeForm: "Shipping" }] }),
    answer("toolu_todo", "ok"),
    call("toolu_task", "TaskCreate", { subject: "Check the totals", status: "pending" }),
    answer("toolu_task", "ok"),
    call("toolu_plan", "ExitPlanMode", { plan: "## Plan\n\n1. Read\n2. Write" }),
    answer("toolu_plan", "ok"),
    call("toolu_ask", "AskUserQuestion", { questions: [{ question: "Which separator?", options: [{ label: "Comma" }, { label: "Semicolon" }] }] }),
    answer("toolu_ask", "answered", { toolUseResult: { answers: { "Which separator?": "Semicolon" } } }),
    call("toolu_denied", "Bash", { command: "rm -rf dist" }),
    answer("toolu_denied", "The user doesn't want to proceed with this tool use.", { toolDenialKind: "user-rejected" }, true),
    user("[Request interrupted by user]"),
    { type: "attachment", uuid: uid(), timestamp: stamp(), attachment: { type: "queued_command", prompt: "also check the totals", commandMode: "prompt", origin: { kind: "human" } } },
    call("toolu_open", "Bash", { command: "npm run build" }),
  ];
  const results = new Map();
  for (const item of list) for (const block of Array.isArray(item.message?.content) ? item.message.content : []) {
    if (block.type === "tool_result") results.set(block.tool_use_id, { at: Date.parse(item.timestamp), isError: block.is_error === true, text: block.content, extra: item.toolUseResult, denied: Boolean(item.toolDenialKind) });
  }
  return claudeEntries(list.map((record, index) => ({ record, offset: index * 100 })), { session: "7a5c0000-0000-4000-8000-000000000001", cwd: "/work/app", results });
}

test("the server's Claude Code entries read and render as the native app shows them", () => {
  const page = normalizeTranscript({ entries: serverClaudeEntries(), cursor: { first: "", last: "c-1" }, hasOlder: false, live: true, source: "claude" });
  assert.equal(page.cursor.first, "", "an empty cursor stays empty: nothing older");
  const byId = new Map(page.entries.map((entry) => [entry.id, entry]));
  const prompt = page.entries[0];
  assert.deepEqual([prompt.kind, prompt.from], ["prompt", "coordinator"]);
  const bash = byId.get("toolu_bash");
  assert.deepEqual([bash.tool.kind, bash.tool.status, bash.tool.exitCode, bash.tool.description, bash.tool.background], ["command", "failed", 1, "Run the CSV tests", true]);
  const bashRow = toolSummary(bash.tool);
  assert.deepEqual([bashRow.verb, bashRow.target, bashRow.exit, bashRow.badges], ["Ran", "npm test -- csv", "exit 1", ["background"]]);
  const edit = toolSummary(byId.get("toolu_edit").tool);
  assert.deepEqual([edit.verb, edit.target, edit.added, edit.removed], ["Edited", "src/csv.ts", 2, 1], "the verb from the server's title, the whole path");
  const agent = byId.get("toolu_agent");
  assert.deepEqual([agent.kind, agent.agentId], ["subagent", "claude-agent:7a5c0000-0000-4000-8000-000000000001:a1b2c3"]);
  assert.deepEqual(byId.get("toolu_todo").plan.steps, [{ text: "Write tests", status: "done" }, { text: "Shipping", status: "active" }]);
  assert.equal(byId.get("toolu_task").plan.change, "added");
  assert.deepEqual([byId.get("toolu_plan").plan.steps.length, byId.get("toolu_plan").text], [0, "## Plan\n\n1. Read\n2. Write"]);
  assert.equal(byId.get("toolu_denied").tool.status, "denied");
  assert.equal(byId.get("toolu_open").tool.status, "running");
  assert.ok(page.entries.some((entry) => entry.queued && entry.kind === "prompt"));

  const subagent = { id: "claude-agent:7a5c0000-0000-4000-8000-000000000001:a1b2c3", name: "Find fixtures", role: "subagent" };
  const rendered = page.entries.map((entry) => renderEntry(entry, ctx({ agentsById: new Map([[subagent.id, subagent]]) })));
  const text = (id) => rendered[page.entries.findIndex((entry) => entry.id === id)].textContent;
  assert.match(rendered[0].textContent, /^From the coordinator/);
  assert.match(text("toolu_bash"), /background/);
  assert.match(text("toolu_agent"), /Started Explore subagent: Find fixtures.*Open Find fixtures/);
  assert.doesNotMatch(text("toolu_agent"), /Subagent:/, "a title that says what it is gets no extra label");
  assert.match(text("toolu_task"), /Task added.*Check the totals/);
  assert.match(text("toolu_plan"), /Plan.*Read.*Write/);
  assert.match(rendered.find((node) => node.dataset.kind === "prompt" && /queued/.test(node.textContent)).textContent, /You.*queued/);
  // Open the edit: its diff is there, numbered from the server's hunk.
  const editNode = rendered[page.entries.findIndex((entry) => entry.id === "toolu_edit")];
  editNode.byClass("tool-head").click();
  assert.deepEqual(editNode.findAll((item) => item.classList?.contains("dl-row")).map((row) => row.children[1].textContent), ["", "3", "4"]);
  // The shell call says why it ran.
  const bashNode = rendered[page.entries.findIndex((entry) => entry.id === "toolu_bash")];
  bashNode.byClass("tool-head").click();
  assert.equal(bashNode.byClass("tool-why").textContent, "Run the CSV tests");
});

test("the server's Codex and Orca entries read and render too", () => {
  const item = (value, second) => ({ turnId: "turn-1", item: value, startedAtMs: BASE + second * 1000, completedAtMs: BASE + second * 1000 + 500 });
  const list = [
    item({ type: "userMessage", id: "m1", content: [{ type: "text", text: "Fix the export" }] }, 1),
    item({ type: "reasoning", id: "r1", summary: ["**Plan** the fix"], content: [] }, 2),
    item({ type: "commandExecution", id: "c1", command: "pwsh -Command 'npm test'", cwd: "/work/app/web", status: "completed", aggregatedOutput: "1 failing", exitCode: 1, durationMs: 4200 }, 3),
    item({ type: "fileChange", id: "f1", status: "completed", changes: [{ path: "/work/app/src/a.ts", kind: { type: "update", move_path: null }, diff: "@@ -1,1 +1,1 @@\n-x\n+y" }] }, 4),
    item({ type: "collabAgentToolCall", id: "s1", tool: "spawnAgent", status: "completed", senderThreadId: "chat-main-01", receiverThreadIds: ["chat-kid-001"], prompt: "Check the totals", agentsStates: {} }, 5),
    item({ type: "plan", id: "p1", text: "1. Read\n2. Fix" }, 6),
    item({ type: "agentMessage", id: "a1", text: "Done, but **tests fail**.", phase: "final_answer" }, 7),
  ];
  const turns = new Map([["turn-1", { id: "turn-1", status: "failed", error: { message: "Usage limit reached" }, completedAt: (BASE + 9000) / 1000 }]]);
  const page = normalizeTranscript({ entries: codexEntries(list, { cwd: "/work/app", turns }), cursor: { first: "", last: "cx" }, source: "codex" });
  assert.deepEqual(page.entries.map((entry) => entry.kind), ["prompt", "reasoning", "tool", "tool", "subagent", "plan", "message", "error"]);
  const command = toolSummary(page.entries[2].tool);
  assert.deepEqual([command.verb, command.target, command.exit], ["Ran", "npm test", "exit 1"], "the unwrapped command");
  assert.deepEqual([page.entries[4].agentId, page.entries[6].phase], ["chat-kid-001", "final_answer"]);
  for (const entry of page.entries) assert.ok(renderEntry(entry, ctx()).textContent.length > 0, entry.kind);
  assert.match(renderEntry(page.entries[5], ctx()).textContent, /Plan.*Read.*Fix/);

  const orca = normalizeTranscript({ entries: orcaEntries([{ id: "e1", at: BASE, description: "Started the build" }], { screen: { at: BASE, lines: ["$ npm run build", "done"] } }), cursor: { first: "", last: "o" } });
  const screen = orca.entries.find((entry) => entry.screen);
  assert.ok(screen);
  const node = renderEntry(screen, ctx());
  assert.ok(node.classList.contains("e-screen"));
  assert.match(node.textContent, /Terminal screen.*\$ npm run build\ndone/s);
});

test("after-pages: changed calls patch in place, unknown ones are skipped, a reset replaces", () => {
  const store = new TranscriptStore("a");
  store.apply(normalizeTranscript({ entries: [{ id: "t1", kind: "tool", tool: { name: "Bash", kind: "command", input: "make", status: "running" } }], cursor: { first: "", last: "c1" } }), "initial");
  assert.equal(store.first, "");
  const change = store.apply(normalizeTranscript({ entries: [
    { id: "old", kind: "tool", updated: true, tool: { name: "Bash", kind: "command", input: "ls", status: "ok" } },
    { id: "t1", kind: "tool", updated: true, tool: { name: "Bash", kind: "command", input: "make", status: "ok", exitCode: 0, output: "built" } },
    { id: "m2", kind: "message", text: "Built." },
  ], cursor: { last: "c2" } }), "after");
  assert.deepEqual([change.changed.map((entry) => entry.id), change.added.map((entry) => entry.id)], [["t1"], ["m2"]]);
  assert.deepEqual(store.entries.map((entry) => entry.id), ["t1", "m2"]);
  assert.equal(store.last, "c2");
  const reset = store.apply(normalizeTranscript({ entries: [{ id: "n1", kind: "message", text: "fresh" }], cursor: { first: "f", last: "c9" }, reset: true }), "after");
  assert.equal(reset.reset, true);
  assert.deepEqual([store.entries.map((entry) => entry.id), store.first, store.last], [["n1"], "f", "c9"]);
});
