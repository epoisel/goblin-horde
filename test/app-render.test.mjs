import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMarkdown } from "../public/app/markdown.js";
import { renderDiff } from "../public/app/diff.js";
import { normalizeEntry } from "../public/app/adapter.js";
import { renderEntry, updateEntry } from "../public/app/transcript.js";

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
