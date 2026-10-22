import test from "node:test";
import assert from "node:assert/strict";
import { DIFF_LINE_LIMIT, diffStats, inlineChange, markChanges, parseDiff } from "../public/app/diff.js";

const rows = (hunk) => hunk.lines.map((line) => `${line.type}:${line.old}:${line.new}:${line.text}`);

const GIT = [
  "diff --git a/src/pay.ts b/src/pay.ts",
  "index 123..456 100644",
  "--- a/src/pay.ts",
  "+++ b/src/pay.ts",
  "@@ -10,4 +10,5 @@ export function pay()",
  " import x from \"y\";",
  "-const total = price * qty;",
  "+const total = price * quantity;",
  "+const tax = total * rate;",
  "",
  " return total;",
  "\\ No newline at end of file",
  "diff --git a/README.md b/README.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/README.md",
  "@@ -0,0 +1,2 @@",
  "+# Title",
  "+text",
  "diff --git a/old.txt b/old.txt",
  "deleted file mode 100644",
  "--- a/old.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-bye",
  "diff --git a/a.png b/a.png",
  "Binary files a/a.png and b/a.png differ",
  "diff --git a/x.js b/y.js",
  "similarity index 90%",
  "rename from x.js",
  "rename to y.js",
].join("\n");

test("a git diff with several files: paths, statuses, numbers, counts", () => {
  const { files, truncated } = parseDiff(GIT);
  assert.equal(truncated, 0);
  assert.deepEqual(files.map((file) => [file.path, file.status, file.added, file.removed, file.binary]),
    [["src/pay.ts", "modified", 2, 1, false], ["README.md", "added", 2, 0, false], ["old.txt", "deleted", 0, 1, false], ["a.png", "modified", 0, 0, true], ["y.js", "renamed", 0, 0, false]]);
  const [hunk] = files[0].hunks;
  assert.equal(hunk.section, "export function pay()");
  assert.deepEqual(rows(hunk), [
    "ctx:10:10:import x from \"y\";",
    "del:11:0:const total = price * qty;",
    "add:0:11:const total = price * quantity;",
    "add:0:12:const tax = total * rate;",
    "ctx:12:13:",
    "ctx:13:14:return total;",
    "meta:0:0:\\ No newline at end of file",
  ]);
  assert.deepEqual(diffStats({ files }), { added: 4, removed: 2, files: 5 });
});

test("bare hunks, single-line ranges, and headerless +/- lines", () => {
  const codex = parseDiff("@@ -3 +3 @@\n-a\n+b");
  assert.deepEqual(rows(codex.files[0].hunks[0]), ["del:3:0:a", "add:0:3:b"]);
  assert.equal(codex.files[0].path, "");
  const plain = parseDiff("-old line\n+new line\n context");
  assert.equal(plain.files[0].hunks[0].counted, false);
  assert.deepEqual(rows(plain.files[0].hunks[0]), ["del:0:0:old line", "add:0:0:new line", "ctx:0:0:context"]);
  const headers = parseDiff("--- a/one.txt\n+++ b/one.txt\n@@ -1,2 +1,2 @@\n-x\n+y\n z\n--- a/two.txt\n+++ b/two.txt\n@@ -1 +1 @@\n-p\n+q");
  assert.deepEqual(headers.files.map((file) => file.path), ["one.txt", "two.txt"]);
  assert.deepEqual(parseDiff("").files, []);
});

test("content that looks like a header stays content while a hunk is still counting", () => {
  const { files } = parseDiff("--- a/sql.sql\n+++ b/sql.sql\n@@ -1,2 +1,2 @@\n--- a comment line removed\n+++ a line added\n same");
  assert.equal(files.length, 1);
  assert.deepEqual(rows(files[0].hunks[0]), ["del:1:0:-- a comment line removed", "add:0:1:++ a line added", "ctx:2:2:same"]);
});

test("paired removed and added lines get their changed middle marked", () => {
  assert.deepEqual(inlineChange("const total = price * qty;", "const total = price * quantity;"), { removed: [23, 23], added: [23, 28] });
  assert.equal(inlineChange("abc", "xyz"), null, "a rewritten line is not marked");
  assert.equal(inlineChange("same", "same"), null);
  const lines = markChanges([{ type: "del", text: "let a = 1;" }, { type: "del", text: "let b = 2;" }, { type: "add", text: "let a = 10;" }, { type: "add", text: "let b = 20;" }, { type: "add", text: "extra" }]);
  assert.deepEqual(lines.map((line) => line.mark || null), [[9, 9], [9, 9], [9, 10], [9, 10], null]);
});

test("enormous diffs are cut with a count of what was left out", () => {
  const body = Array.from({ length: DIFF_LINE_LIMIT + 50 }, (_, index) => `+line ${index}`);
  const { files, truncated } = parseDiff(["@@ -0,0 +1,99999 @@", ...body].join("\n"));
  assert.equal(files[0].added, DIFF_LINE_LIMIT);
  assert.equal(truncated, 50);
});
