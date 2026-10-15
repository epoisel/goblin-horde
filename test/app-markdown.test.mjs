import test from "node:test";
import assert from "node:assert/strict";
import { MARKDOWN_LIMIT, highlightCode, parseInline, parseMarkdown, plainText, shortUrl, splitRow } from "../public/app/markdown.js";

const inline = (text) => parseInline(text);
const types = (nodes) => nodes.map((node) => node.type);

test("emphasis follows the delimiter rules agents rely on", () => {
  assert.deepEqual(inline("**bold**"), [{ type: "strong", children: [{ type: "text", text: "bold" }] }]);
  assert.deepEqual(inline("*a **b** c*"), [{ type: "em", children: [{ type: "text", text: "a " }, { type: "strong", children: [{ type: "text", text: "b" }] }, { type: "text", text: " c" }] }]);
  assert.deepEqual(inline("**bold *it***")[0].children.map((node) => node.type), ["text", "em"]);
  assert.deepEqual(inline("***both***"), [{ type: "strong", children: [{ type: "em", children: [{ type: "text", text: "both" }] }] }]);
  assert.deepEqual(types(inline("**a** and **b**")), ["strong", "text", "strong"]);
  assert.deepEqual(inline("_snake_case_"), [{ type: "em", children: [{ type: "text", text: "snake_case" }] }]);
  assert.deepEqual(inline("snake_case_name"), [{ type: "text", text: "snake_case_name" }], "intraword underscores are text");
  assert.deepEqual(inline("2 * 3 * 4"), [{ type: "text", text: "2 * 3 * 4" }], "spaced stars are arithmetic");
  assert.deepEqual(inline("**unclosed"), [{ type: "text", text: "**unclosed" }]);
  assert.deepEqual(inline("****x****"), [{ type: "text", text: "****x****" }]);
  assert.deepEqual(inline("~~gone~~"), [{ type: "del", children: [{ type: "text", text: "gone" }] }]);
});

test("code spans keep their text exactly and win over emphasis", () => {
  assert.deepEqual(inline("`a *b* c`"), [{ type: "code", text: "a *b* c" }]);
  assert.deepEqual(inline("``has ` tick``"), [{ type: "code", text: "has ` tick" }]);
  assert.deepEqual(inline("`` `x` ``"), [{ type: "code", text: "`x`" }]);
  assert.deepEqual(inline("a `unclosed"), [{ type: "text", text: "a `unclosed" }]);
  assert.deepEqual(types(inline("*see `x*` here*")), ["em"], "an asterisk inside code does not close emphasis");
});

test("links keep label and address; bare addresses drop trailing punctuation", () => {
  const [link] = inline("[docs](https://example.com/a_(b) \"Title\")");
  assert.equal(link.type, "link");
  assert.equal(link.href, "https://example.com/a_(b)");
  assert.equal(plainText(link.children), "docs");
  const bare = inline("see https://example.com/x/y. Then (https://example.com/z).");
  assert.deepEqual(bare.filter((node) => node.type === "link").map((node) => node.href), ["https://example.com/x/y", "https://example.com/z"]);
  assert.equal(inline("<https://example.com/q?a=1>")[0].href, "https://example.com/q?a=1");
  assert.deepEqual(inline("![chart](img/plot.png)"), [{ type: "image", alt: "chart", href: "img/plot.png" }]);
  assert.deepEqual(inline("[not a link] (x)"), [{ type: "text", text: "[not a link] (x)" }]);
  assert.equal(inline("javascript:alert(1)")[0].type, "text", "only http(s)/www addresses become bare links");
});

test("escapes, raw HTML, and line breaks stay text", () => {
  assert.deepEqual(inline("\\*not em\\*"), [{ type: "text", text: "*not em*" }]);
  assert.deepEqual(inline("<script>alert(1)</script>"), [{ type: "text", text: "<script>alert(1)</script>" }]);
  assert.deepEqual(types(inline("one\ntwo")), ["text", "br", "text"]);
  assert.deepEqual(inline("trailing  \nnext")[0], { type: "text", text: "trailing" });
});

test("blocks: headings, paragraphs, rules, quotes, fences", () => {
  const blocks = parseMarkdown("# Title #\n\nPara one\nline two\n\nSetext\n===\n\n---\n\n> quoted\n> - item\n\n```js\nconst a = 1;\n```\n~~~\nraw ``` inside\n~~~");
  assert.deepEqual(types(blocks), ["heading", "paragraph", "heading", "hr", "quote", "code", "code"]);
  assert.equal(blocks[0].level, 1);
  assert.equal(plainText(blocks[0].children), "Title");
  assert.equal(blocks[2].level, 1);
  assert.deepEqual(types(blocks[4].blocks), ["paragraph", "list"]);
  assert.deepEqual({ lang: blocks[5].lang, text: blocks[5].text }, { lang: "js", text: "const a = 1;" });
  assert.equal(blocks[6].text, "raw ``` inside");
  // An unclosed fence runs to the end; an indented fence keeps its content's own indentation.
  assert.deepEqual(parseMarkdown("```\nline\n  more")[0], { type: "code", lang: "", text: "line\n  more" });
  assert.equal(parseMarkdown("  ```\n    four\n  ```")[0].text, "  four");
});

test("lists: nesting, numbering, tasks, looseness, lazy lines", () => {
  const [list] = parseMarkdown("- a\n- b\n  - nested\n  - two\n- [x] done\n- [ ] todo");
  assert.equal(list.type, "list");
  assert.equal(list.ordered, false);
  assert.equal(list.items.length, 4);
  assert.deepEqual(types(list.items[1].blocks), ["paragraph", "list"]);
  assert.equal(list.items[1].blocks[1].items.length, 2);
  assert.deepEqual(list.items.map((item) => item.checked), [null, null, true, false]);
  const [numbered] = parseMarkdown("3. three\n4. four");
  assert.deepEqual([numbered.ordered, numbered.start, numbered.items.length], [true, 3, 2]);
  const [loose] = parseMarkdown("1. one\n\n2. two");
  assert.equal(loose.loose, true);
  assert.equal(loose.items.length, 2);
  const [lazy] = parseMarkdown("- first line\ncontinues here\n- second");
  assert.equal(plainText(lazy.items[0].blocks[0].children), "first line\ncontinues here");
  // A numbered line inside a paragraph is text unless it starts at 1.
  assert.deepEqual(types(parseMarkdown("In 2024\n2. was not a list")), ["paragraph"]);
  // Code inside a list item.
  const [withCode] = parseMarkdown("1. Run:\n   ```bash\n   npm test\n   ```");
  assert.deepEqual(types(withCode.items[0].blocks), ["paragraph", "code"]);
  assert.equal(withCode.items[0].blocks[1].text, "npm test");
});

test("tables: alignment, escaped pipes, pipes in code, ragged rows", () => {
  const [table] = parseMarkdown("| a | b | c |\n|:--|--:|:-:|\n| `x|y` | 2 | \\| |\n| only one |");
  assert.equal(table.type, "table");
  assert.deepEqual(table.align, ["left", "right", "center"]);
  assert.deepEqual(table.rows[0].map(plainText), ["x|y", "2", "|"]);
  assert.deepEqual(table.rows[1].map(plainText), ["only one", "", ""]);
  assert.deepEqual(splitRow("| a | b |"), ["a", "b"]);
  // A line with pipes but no rule under it is a paragraph.
  assert.deepEqual(types(parseMarkdown("a | b\nnot a rule")), ["paragraph"]);
});

test("huge or hostile input stays bounded", () => {
  const huge = "x".repeat(MARKDOWN_LIMIT + 1);
  assert.deepEqual(parseMarkdown(huge), [{ type: "code", lang: "", text: huge, plain: true }]);
  const hostile = `${"*a ".repeat(20_000)}${"[".repeat(20_000)}${"`".repeat(5000)}${"> ".repeat(500)}x`;
  const started = performance.now();
  const blocks = parseMarkdown(hostile);
  assert.ok(blocks.length >= 1);
  assert.ok(performance.now() - started < 4000, "pathological input parses quickly");
  let depth = 0;
  for (let block = parseMarkdown("> ".repeat(50) + "deep")[0]; block?.type === "quote"; block = block.blocks[0]) depth++;
  assert.ok(depth <= 9, "quote nesting is capped");
});

test("the highlighter splits code into typed pieces without losing a character", () => {
  const code = "const x = 'a'; // note\nif (x) return 42;";
  const pieces = highlightCode(code, "javascript");
  assert.equal(pieces.map((piece) => piece.text).join(""), code);
  assert.deepEqual(pieces.filter((piece) => piece.type).map((piece) => `${piece.type}:${piece.text}`), ["kw:const", "str:'a'", "com:// note", "kw:if", "kw:return", "num:42"]);
  assert.deepEqual(highlightCode("SELECT a FROM t", "sql").filter((piece) => piece.type === "kw").map((piece) => piece.text), ["SELECT", "FROM"]);
  assert.deepEqual(highlightCode("anything", "brainfudge"), [{ type: "", text: "anything" }]);
  assert.equal(highlightCode("# note\necho \"hi\"", "bash")[0].type, "com");
});

test("long addresses shorten in the middle for display", () => {
  assert.equal(shortUrl("https://example.com/a"), "https://example.com/a");
  const long = `https://example.com/${"x".repeat(200)}/end`;
  const short = shortUrl(long);
  assert.ok(short.length <= 64 && short.startsWith("https://example.com/") && short.endsWith("/end") && short.includes("…"));
});
