/**
 * Unified diffs as coloured lines with line numbers, the way the Codex and Claude apps show edits.
 *
 * `parseDiff` reads what the sources produce: git diffs with several files, bare `@@` hunks (a Codex
 * file change), `---`/`+++` headers without `diff --git`, "\ No newline at end of file", and plain
 * +/- lines with no hunk header at all (then lines carry no numbers). Paired removed and added lines
 * get the changed part marked, so a one-word edit in a long line is easy to spot.
 *
 * Pure except `renderDiff`, which builds DOM nodes (createElement and textContent only: diff text is
 * agent text and never goes through innerHTML).
 */

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const GIT = /^diff --git (?:"?a\/)?(.+?)"? (?:"?b\/)?(.+?)"?$/;
// Bigger diffs are cut here (with a note), so one huge generated file cannot freeze the window.
export const DIFF_LINE_LIMIT = 20_000;

const pathOf = (header) => {
  const value = header.replace(/\t.*$/, "").trim();
  if (value === "/dev/null") return "";
  return value.replace(/^"?(?:a|b)\//, "").replace(/"$/, "");
};

/**
 * A diff as { files: [{ path, oldPath, newPath, status, binary, added, removed, hunks: [{ header,
 * section, oldStart, newStart, lines: [{ type: "add" | "del" | "ctx" | "meta", text, old, new, mark? }] }] }],
 * truncated }. Never throws.
 */
export function parseDiff(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const files = [];
  let file = null;
  let hunk = null;
  let oldLeft = 0;
  let newLeft = 0;
  let count = 0;
  let truncated = 0;
  const newFile = (fields = {}) => {
    file = { path: "", oldPath: "", newPath: "", status: "modified", binary: false, added: 0, removed: 0, hunks: [], ...fields };
    files.push(file);
    hunk = null;
    return file;
  };
  const bare = () => {
    if (!file) newFile();
    hunk = { header: "", section: "", oldStart: 0, newStart: 0, lines: [], counted: false, nextOld: 0, nextNew: 0 };
    file.hunks.push(hunk);
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (count >= DIFF_LINE_LIMIT) { truncated = lines.length - index; break; }
    // Inside a numbered hunk every line is content until its counts run out; elsewhere, look for headers.
    const counting = hunk && hunk.counted && (oldLeft > 0 || newLeft > 0);
    if (!counting) {
      const git = line.startsWith("diff --git ") && GIT.exec(line);
      if (git) { newFile({ oldPath: git[1], newPath: git[2], path: git[2] }); continue; }
      if (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
        const oldPath = pathOf(line.slice(4));
        const newPath = pathOf(lines[index + 1].slice(4));
        // A git header already opened this file; a bare ---/+++ pair opens a new one.
        if (!file || file.hunks.length || (file.oldPath && file.oldPath !== oldPath && file.newPath !== newPath)) newFile();
        Object.assign(file, { oldPath, newPath, path: newPath || oldPath });
        if (!oldPath && newPath) file.status = "added";
        if (oldPath && !newPath) file.status = "deleted";
        index++;
        hunk = null;
        continue;
      }
      const header = HUNK.exec(line);
      if (header) {
        if (!file) newFile();
        hunk = { header: line, section: header[5].trim(), oldStart: Number(header[1]), newStart: Number(header[3]), lines: [], counted: true };
        oldLeft = header[2] === undefined ? 1 : Number(header[2]);
        newLeft = header[4] === undefined ? 1 : Number(header[4]);
        hunk.nextOld = hunk.oldStart;
        hunk.nextNew = hunk.newStart;
        file.hunks.push(hunk);
        continue;
      }
      if (file && !file.hunks.length) {
        if (line.startsWith("new file mode")) { file.status = "added"; continue; }
        if (line.startsWith("deleted file mode")) { file.status = "deleted"; continue; }
        if (line.startsWith("rename from ")) { file.status = "renamed"; file.oldPath = line.slice(12); continue; }
        if (line.startsWith("rename to ")) { file.status = "renamed"; file.newPath = line.slice(10); file.path = file.newPath; continue; }
        if (/^Binary files .* differ$/.test(line) || line === "GIT binary patch") { file.binary = true; continue; }
        if (/^(index |similarity index|dissimilarity index|old mode|new mode|copy from|copy to)/.test(line)) continue;
      }
      const unnumbered = hunk && !hunk.counted;
      if (unnumbered && /^[ +\-]/.test(line)) {
        // More lines of a hunk with no header.
      } else if (/^[+\-]/.test(line)) {
        bare(); // Lines with no hunk header: shown without numbers.
      } else {
        if (!line.trim()) continue;
        // "\ No newline at end of file", or words before or between files ("Only in …"): kept as a note.
        if (!hunk) bare();
        hunk.lines.push({ type: "meta", text: line, old: 0, new: 0 });
        count++;
        continue;
      }
    }
    const sign = line[0];
    const text = line.slice(1);
    const numbered = hunk.counted;
    if (sign === "+") {
      hunk.lines.push({ type: "add", text, old: 0, new: numbered ? hunk.nextNew++ : 0 });
      file.added++;
      newLeft--;
    } else if (sign === "-") {
      hunk.lines.push({ type: "del", text, old: numbered ? hunk.nextOld++ : 0, new: 0 });
      file.removed++;
      oldLeft--;
    } else if (sign === "\\") {
      hunk.lines.push({ type: "meta", text: line, old: 0, new: 0 });
    } else {
      // A context line; some tools drop the leading space of an empty one.
      hunk.lines.push({ type: "ctx", text: sign === " " ? text : line, old: numbered ? hunk.nextOld++ : 0, new: numbered ? hunk.nextNew++ : 0 });
      oldLeft--;
      newLeft--;
    }
    count++;
  }
  for (const each of files) for (const part of each.hunks) { markChanges(part.lines); delete part.nextOld; delete part.nextNew; }
  return { files: files.filter((each) => each.hunks.length || each.binary || each.path), truncated };
}

/**
 * Mark the changed middle of each removed line and the added line paired with it (same position in
 * a run of removals followed by a run of additions): `mark: [start, end]` on both. Lines that share
 * little are left unmarked; colouring all of a line says nothing.
 */
export function markChanges(lines) {
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].type !== "del") continue;
    let delEnd = index;
    while (delEnd < lines.length && lines[delEnd].type === "del") delEnd++;
    let addEnd = delEnd;
    while (addEnd < lines.length && lines[addEnd].type === "add") addEnd++;
    const pairs = Math.min(delEnd - index, addEnd - delEnd);
    for (let k = 0; k < pairs; k++) {
      const removed = lines[index + k];
      const added = lines[delEnd + k];
      const change = inlineChange(removed.text, added.text);
      if (change) { removed.mark = change.removed; added.mark = change.added; }
    }
    index = addEnd - 1;
  }
  return lines;
}

/** The differing middle of two lines as { removed: [s, e], added: [s, e] }, or null when not worth marking. */
export function inlineChange(before, after) {
  const a = String(before);
  const b = String(after);
  if (a === b) return null;
  let prefix = 0;
  const max = Math.min(a.length, b.length);
  while (prefix < max && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const shared = prefix + suffix;
  // Mostly-rewritten lines are not marked.
  if (shared < 3 || shared < Math.min(a.length, b.length) * 0.3) return null;
  return { removed: [prefix, a.length - suffix], added: [prefix, b.length - suffix] };
}

/** Lines added and removed over all files. */
export function diffStats(parsed) {
  const files = parsed?.files || [];
  return { added: files.reduce((sum, file) => sum + file.added, 0), removed: files.reduce((sum, file) => sum + file.removed, 0), files: files.length };
}

function element(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * A diff as a `div.diff`: one block per file (path, +/− counts, copy) and its lines in a grid with
 * old and new line numbers. Options: `doc`, `path` (for a diff with no file header), `limit` (lines
 * shown before "Show all"), `copyButton(text, label)`.
 */
export function renderDiff(text, options = {}) {
  const doc = options.doc || globalThis.document;
  const parsed = typeof text === "string" ? parseDiff(text) : text;
  const limit = options.limit || 400;
  const root = element(doc, "div", "diff");
  if (!parsed.files.length) {
    root.append(element(doc, "div", "diff-empty", "No changes in this diff."));
    return root;
  }
  let budget = limit;
  const rest = [];
  for (const file of parsed.files) {
    const box = element(doc, "div", "diff-file");
    const head = element(doc, "div", "diff-file-head");
    const path = file.path || options.path || "";
    head.append(element(doc, "span", "diff-path", path || "Changes"));
    if (file.status !== "modified") head.append(element(doc, "span", `diff-status ${file.status}`, file.status === "added" ? "new" : file.status));
    const stat = element(doc, "span", "diff-stat");
    stat.append(element(doc, "span", "plus", `+${file.added}`), element(doc, "span", "minus", `−${file.removed}`));
    head.append(stat);
    box.append(head);
    if (file.binary) box.append(element(doc, "div", "diff-empty", "Binary file: not shown."));
    const body = element(doc, "div", "diff-body");
    const widest = Math.max(1, ...file.hunks.flatMap((hunk) => hunk.lines.map((line) => Math.max(line.old, line.new)))).toString().length;
    body.style.setProperty("--ln", `${Math.max(2, widest)}ch`);
    const numbered = file.hunks.some((hunk) => hunk.counted);
    if (!numbered) body.classList.add("no-numbers");
    for (const hunk of file.hunks) {
      if (hunk.header) {
        const row = element(doc, "div", "diff-hunk");
        row.append(element(doc, "span", "diff-hunk-range", hunk.header.replace(/^(@@ [^@]* @@).*$/, "$1")));
        if (hunk.section) row.append(element(doc, "span", "diff-hunk-section", hunk.section));
        body.append(row);
      }
      for (const line of hunk.lines) {
        if (budget > 0) { body.append(renderLine(doc, line)); budget--; }
        else rest.push([body, line]);
      }
    }
    box.append(body);
    root.append(box);
  }
  const hidden = rest.length + (parsed.truncated || 0);
  if (rest.length) {
    const more = element(doc, "button", "diff-more", `Show ${rest.length} more ${rest.length === 1 ? "line" : "lines"}`);
    more.type = "button";
    more.addEventListener("click", () => {
      for (const [body, line] of rest) body.append(renderLine(doc, line));
      more.remove();
    });
    root.append(more);
  }
  if (parsed.truncated) root.append(element(doc, "div", "diff-note", `${parsed.truncated} more lines are not shown here.`));
  root.dataset.hidden = String(hidden);
  return root;
}

function renderLine(doc, line) {
  const row = element(doc, "div", `dl-row ${line.type}`);
  row.append(element(doc, "span", "ln old", line.old ? String(line.old) : ""));
  row.append(element(doc, "span", "ln new", line.new ? String(line.new) : ""));
  row.append(element(doc, "span", "sign", line.type === "add" ? "+" : line.type === "del" ? "−" : ""));
  const code = element(doc, "span", "code");
  if (line.mark) {
    const [start, end] = line.mark;
    code.append(doc.createTextNode(line.text.slice(0, start)));
    code.append(element(doc, "span", "chg", line.text.slice(start, end)));
    code.append(doc.createTextNode(line.text.slice(end)));
  } else code.textContent = line.text || (line.type === "meta" ? "" : " ");
  row.append(code);
  return row;
}
