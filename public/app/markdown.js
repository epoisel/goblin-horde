/**
 * A small, safe Markdown reader for what agents write: paragraphs, headings, bold, italic, strike,
 * inline code, fenced code blocks (lightly highlighted), lists (nested, numbered, task lists), block
 * quotes, tables, rules, and links.
 *
 * Agent text is untrusted, so nothing here ever goes through innerHTML: `parseMarkdown` turns text
 * into plain objects, and `renderMarkdown` builds DOM nodes from them with createElement and text
 * nodes only. Links are never followed: they show as text, with the address and a copy button, so a
 * message can never navigate this window or reach another site. Raw HTML in a message stays text.
 *
 * Pure except `renderMarkdown`, which takes the document to build in (node tests pass a fake one).
 */

// Bigger messages are shown as plain text: parsing stays fast and bounded whatever an agent writes.
export const MARKDOWN_LIMIT = 200_000;
const MAX_DEPTH = 8; // Nesting of quotes, lists, and emphasis.
const SCAN = 4000; // How far an opening delimiter looks for its closer.

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[^\n]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*)|$)/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const TABLE_RULE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const TASK = /^\[([ xX])\][ \t]+/;
const PUNCT = /[!-/:-@[-`{-~]/;
const SPACE = /\s/;
const WORD = /[\p{L}\p{N}]/u;

const blank = (line) => !line || /^[ \t]*$/.test(line);
const indentOf = (line) => /^ */.exec(line)[0].length;
const expandTabs = (line) => (line.includes("\t") ? line.replace(/^[ \t]+/, (lead) => lead.replace(/\t/g, "    ")) : line);

/** True when `line` starts a block that ends a paragraph (a list only when it could not be text). */
function interrupts(line, next) {
  if (FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line)) return true;
  const item = ITEM.exec(line);
  if (item && item[4] !== undefined && item[4].trim()) return !/^\d/.test(item[2]) || /^1[.)]$/.test(item[2]);
  return isTableStart(line, next);
}

function isTableStart(line, next) {
  if (!line || !next || !line.includes("|") || !TABLE_RULE.test(next) || !next.includes("-")) return false;
  const head = splitRow(line);
  return head.length > 0 && head.length === splitRow(next).length;
}

/** The cells of a table row: outer pipes dropped, `\|` and pipes inside `code` kept. */
export function splitRow(line) {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells = [];
  let cell = "";
  let ticks = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && text[i + 1] === "|") { cell += "|"; i++; continue; }
    if (ch === "`") {
      let run = 1;
      while (text[i + run] === "`") run++;
      ticks = ticks === run ? 0 : ticks || run;
      cell += text.slice(i, i + run);
      i += run - 1;
      continue;
    }
    if (ch === "|" && !ticks) { cells.push(cell.trim()); cell = ""; continue; }
    cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

/** Markdown text as a list of block objects. Never throws; anything it does not know is a paragraph. */
export function parseMarkdown(text) {
  const source = String(text ?? "");
  if (source.length > MARKDOWN_LIMIT) return [{ type: "code", lang: "", text: source, plain: true }];
  const lines = source.replace(/\r\n?/g, "\n").split("\n").map(expandTabs);
  return parseBlocks(lines, 0);
}

function parseBlocks(lines, depth) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) { i++; continue; }
    const fence = FENCE.exec(line);
    if (fence) {
      const [, marks, info] = fence;
      const pad = indentOf(line);
      const body = [];
      i++;
      while (i < lines.length) {
        const close = new RegExp(`^ {0,3}${marks[0] === "`" ? "`" : "~"}{${marks.length},}[ \\t]*$`).exec(lines[i]);
        if (close) { i++; break; }
        body.push(pad ? lines[i].replace(new RegExp(`^ {0,${pad}}`), "") : lines[i]);
        i++;
      }
      blocks.push({ type: "code", lang: info.toLowerCase(), text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, children: parseInline(heading[2] || "", depth) });
      i++;
      continue;
    }
    if (RULE.test(line)) { blocks.push({ type: "hr" }); i++; continue; }
    if (QUOTE.test(line) && depth < MAX_DEPTH) {
      const inner = [];
      while (i < lines.length && !blank(lines[i])) {
        const quoted = QUOTE.exec(lines[i]);
        // A line without ">" right after quoted text continues it (a "lazy" line), unless it starts a block.
        if (quoted) inner.push(quoted[1]);
        else if (inner.length && !blank(inner.at(-1)) && !interrupts(lines[i], lines[i + 1])) inner.push(lines[i]);
        else break;
        i++;
      }
      blocks.push({ type: "quote", blocks: parseBlocks(inner, depth + 1) });
      continue;
    }
    const item = ITEM.exec(line);
    if (item && depth < MAX_DEPTH) {
      const list = parseList(lines, i, depth);
      blocks.push(list.block);
      i = list.next;
      continue;
    }
    if (isTableStart(line, lines[i + 1])) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((cell) => (cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : ""));
      const rows = [];
      i += 2;
      while (i < lines.length && !blank(lines[i]) && lines[i].includes("|") && !FENCE.test(lines[i])) {
        const cells = splitRow(lines[i]);
        rows.push(head.map((_, index) => parseInline(cells[index] ?? "", depth)));
        i++;
      }
      blocks.push({ type: "table", align, head: head.map((cell) => parseInline(cell, depth)), rows });
      continue;
    }
    // A paragraph, perhaps turned into a heading by a following === or --- line.
    const para = [line.trim()];
    i++;
    let level = 0;
    while (i < lines.length && !blank(lines[i])) {
      const setext = SETEXT.exec(lines[i]);
      if (setext) { level = setext[1][0] === "=" ? 1 : 2; i++; break; }
      if (interrupts(lines[i], lines[i + 1])) break;
      para.push(lines[i].replace(/^[ \t]+/, ""));
      i++;
    }
    const content = para.join("\n").replace(/[ \t]+$/, "");
    blocks.push(level ? { type: "heading", level, children: parseInline(content, depth) } : { type: "paragraph", children: parseInline(content, depth) });
  }
  return blocks;
}

function parseList(lines, start, depth) {
  const first = ITEM.exec(lines[start]);
  const ordered = /^\d/.test(first[2]);
  const marker = ordered ? first[2].slice(-1) : first[2];
  const base = first[1].length;
  const items = [];
  let i = start;
  let loose = false;
  while (i < lines.length) {
    const match = ITEM.exec(lines[i]);
    if (!match || match[1].length > base + 3 || /^\d/.test(match[2]) !== ordered || (ordered ? match[2].slice(-1) : match[2]) !== marker) break;
    const gap = match[3] ? Math.min(match[3].length, 4) : 1;
    const content = match[1].length + match[2].length + (match[3] && match[3].length > 4 ? 1 : gap);
    const body = [match[4] ?? ""];
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (blank(line)) {
        let next = i + 1;
        while (next < lines.length && blank(lines[next])) next++;
        if (next < lines.length && indentOf(lines[next]) >= content) {
          for (; i < next; i++) body.push("");
          loose = true;
          continue;
        }
        break;
      }
      if (indentOf(line) >= content) { body.push(line.slice(content)); i++; continue; }
      // A lazy line continues the item's paragraph; a new item or block ends it.
      if (!blank(body.at(-1)) && !ITEM.test(line) && !interrupts(line, lines[i + 1])) { body.push(line.trim()); i++; continue; }
      break;
    }
    let checked = null;
    const task = TASK.exec(body[0]);
    if (task) { checked = task[1] !== " "; body[0] = body[0].slice(task[0].length); }
    items.push({ checked, blocks: parseBlocks(body, depth + 1) });
    // Blank lines between two items of the same list keep the list going.
    let next = i;
    while (next < lines.length && blank(lines[next])) next++;
    if (next > i && next < lines.length) {
      const again = ITEM.exec(lines[next]);
      if (again && again[1].length <= base + 3 && /^\d/.test(again[2]) === ordered) { loose = true; i = next; }
    }
  }
  return { block: { type: "list", ordered, start: ordered ? Number.parseInt(first[2], 10) : 1, loose, items }, next: i };
}

// How many characters emphasis may scan for closers in one paragraph; past it, marks stay text.
// Keeps a paragraph of thousands of unmatched "*" fast (each would otherwise scan far ahead).
const SCAN_BUDGET = 1_500_000;
let budget = SCAN_BUDGET;

/** Inline Markdown as a list of nodes: text, code, strong, em, del, link, image, br. */
export function parseInline(text, depth = 0) {
  budget = SCAN_BUDGET;
  return inlineNodes(text, depth);
}

function inlineNodes(text, depth) {
  const src = String(text ?? "");
  const out = [];
  let buffer = "";
  const flush = () => { if (buffer) { out.push({ type: "text", text: buffer }); buffer = ""; } };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      const next = src[i + 1];
      if (next === "\n") { flush(); out.push({ type: "br" }); i += 2; continue; }
      if (next && PUNCT.test(next)) { buffer += next; i += 2; continue; }
      buffer += ch;
      i++;
      continue;
    }
    if (ch === "\n") {
      // Agents write line by line: a single newline is a line break, as in chat apps.
      buffer = buffer.replace(/[ \t]+$/, "");
      flush();
      out.push({ type: "br" });
      i++;
      while (src[i] === " " || src[i] === "\t") i++;
      continue;
    }
    if (ch === "`") {
      let run = 1;
      while (src[i + run] === "`") run++;
      const close = closingTicks(src, i + run, run);
      if (close >= 0) {
        flush();
        let code = src.slice(i + run, close).replace(/\n/g, " ");
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
        out.push({ type: "code", text: code });
        i = close + run;
        continue;
      }
      buffer += src.slice(i, i + run);
      i += run;
      continue;
    }
    if ((ch === "[" || (ch === "!" && src[i + 1] === "[")) && depth < MAX_DEPTH) {
      const link = linkAt(src, ch === "!" ? i + 1 : i);
      if (link) {
        flush();
        if (ch === "!") out.push({ type: "image", alt: link.label, href: link.href });
        else out.push({ type: "link", href: link.href, children: inlineNodes(link.label, depth + 1) });
        i = link.end;
        continue;
      }
    }
    if (ch === "<") {
      const angle = /<((?:https?|mailto|file):[^\s<>]{1,2000})>/iy;
      angle.lastIndex = i;
      const found = angle.exec(src);
      if (found) { flush(); out.push({ type: "link", href: found[1], children: [{ type: "text", text: found[1] }] }); i = angle.lastIndex; continue; }
    }
    if ((ch === "h" || ch === "H" || ch === "w" || ch === "W") && (i === 0 || !WORD.test(src[i - 1]))) {
      const bare = /(?:https?:\/\/|www\.)[^\s<>]{1,2000}/iy;
      bare.lastIndex = i;
      const found = bare.exec(src);
      if (found) {
        const url = trimUrl(found[0]);
        if (url.length > 8) {
          flush();
          out.push({ type: "link", href: url, children: [{ type: "text", text: url }] });
          i += url.length;
          continue;
        }
      }
    }
    if ((ch === "*" || ch === "_" || ch === "~") && depth < MAX_DEPTH) {
      const emphasis = emphasisAt(src, i, depth);
      if (emphasis) { flush(); out.push(emphasis.node); i = emphasis.end; continue; }
      let run = 1;
      while (src[i + run] === ch) run++;
      buffer += src.slice(i, i + run);
      i += run;
      continue;
    }
    buffer += ch;
    i++;
  }
  flush();
  return out;
}

function closingTicks(src, from, run) {
  let at = from;
  while ((at = src.indexOf("`", at)) !== -1) {
    let end = at;
    while (src[end] === "`") end++;
    if (end - at === run) return at;
    at = end;
  }
  return -1;
}

/** `[label](address "title")` starting at `start`, or null. */
function linkAt(src, start) {
  let depth = 0;
  let close = -1;
  for (let j = start; j < src.length && j - start < 1000; j++) {
    const ch = src[j];
    if (ch === "\\") { j++; continue; }
    if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) { close = j; break; }
  }
  if (close < 0 || src[close + 1] !== "(") return null;
  let k = close + 2;
  while (src[k] === " ") k++;
  let href = "";
  if (src[k] === "<") {
    const end = src.indexOf(">", k);
    if (end < 0) return null;
    href = src.slice(k + 1, end);
    k = end + 1;
  } else {
    let parens = 0;
    const from = k;
    for (; k < src.length && k - from < 2000; k++) {
      const ch = src[k];
      if (SPACE.test(ch)) break;
      if (ch === "(") parens++;
      else if (ch === ")") { if (!parens) break; parens--; }
    }
    href = src.slice(from, k);
  }
  while (src[k] === " ") k++;
  if (src[k] === "\"" || src[k] === "'") {
    const end = src.indexOf(src[k], k + 1);
    if (end < 0) return null;
    k = end + 1;
    while (src[k] === " ") k++;
  }
  if (src[k] !== ")") return null;
  return { label: src.slice(start + 1, close), href: href.replace(/\\([!-/:-@[-`{-~])/g, "$1"), end: k + 1 };
}

/** A bare address without the punctuation that ends its sentence. */
function trimUrl(url) {
  let text = url;
  for (;;) {
    const last = text.at(-1);
    if (/[.,:;!?'"*_]/.test(last)) { text = text.slice(0, -1); continue; }
    if (last === ")" && (text.match(/\(/g) || []).length < (text.match(/\)/g) || []).length) { text = text.slice(0, -1); continue; }
    if (last === "]" && !text.includes("[")) { text = text.slice(0, -1); continue; }
    return text;
  }
}

function emphasisAt(src, start, depth) {
  const ch = src[start];
  let run = 1;
  while (src[start + run] === ch) run++;
  const after = src[start + run];
  if (!after || SPACE.test(after) || budget <= 0) return null;
  if (ch === "~") {
    if (run !== 2) return null;
    for (let j = start + 2; j < src.length && j - start < SCAN && budget-- > 0; j++) {
      if (src[j] === "~" && src[j + 1] === "~" && src[j + 2] !== "~" && !SPACE.test(src[j - 1]) && j > start + 2)
        return { node: { type: "del", children: inlineNodes(src.slice(start + 2, j), depth + 1) }, end: j + 2 };
    }
    return null;
  }
  if (ch === "_" && start > 0 && WORD.test(src[start - 1])) return null;
  const size = Math.min(run, 3);
  const from = start + run;
  const opened = []; // Runs of the same mark opened inside, still waiting for their closers.
  for (let j = from; j < src.length && j - start < SCAN && budget-- > 0; j++) {
    if (src[j] === "\\") { j++; continue; }
    if (src[j] === "`") {
      let ticks = 1;
      while (src[j + ticks] === "`") ticks++;
      const close = closingTicks(src, j + ticks, ticks);
      if (close > 0) { j = close + ticks - 1; continue; }
    }
    if (src[j] !== ch) continue;
    let closeRun = 1;
    while (src[j + closeRun] === ch) closeRun++;
    const before = src[j - 1];
    const next = src[j + closeRun];
    const closes = j > from && before && !SPACE.test(before) && !(ch === "_" && next && WORD.test(next));
    const opens = next && !SPACE.test(next) && !(ch === "_" && before && WORD.test(before));
    if (closes) {
      // Emphasis opened inside ("*a **b** c*") is closed first; what is left may close this one.
      let left = closeRun;
      while (opened.length && left > 0) {
        const top = opened.pop();
        if (left >= top) left -= top;
        else { opened.push(top - left); left = 0; }
      }
      if (!opened.length && left >= size) {
        if (run > 3) return null; // Four or more marks in a row stay as text.
        const at = j + closeRun - left; // This emphasis's closing marks start here.
        const content = src.slice(from, at);
        if (!content.trim()) return null;
        const children = inlineNodes(content, depth + 1);
        const node = size === 3
          ? { type: "strong", children: [{ type: "em", children }] }
          : { type: size === 2 ? "strong" : "em", children };
        return { node, end: at + size };
      }
      if (opens && left > 0) opened.push(left);
    } else if (opens) opened.push(closeRun);
    j += closeRun - 1;
  }
  return null;
}

/** Everything a block or inline list says, as plain text (for copying and searching). */
export function plainText(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  return list.map((node) => {
    if (node.type === "text" || node.type === "code") return node.text;
    if (node.type === "br") return "\n";
    if (node.type === "image") return node.alt;
    if (node.children) return plainText(node.children);
    return "";
  }).join("");
}

// ---- A light code highlighter: comments, strings, numbers, and keywords, as text spans. ----

const KEYWORDS = {
  js: "async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while with yield",
  py: "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield",
  sh: "case do done echo elif else esac exit export fi for function if in local return set shift then unset until while",
  ps1: "begin break catch class continue data do dynamicparam else elseif end exit filter finally for foreach function if in param process return switch throw trap try until using while $true $false $null",
  go: "break case chan const continue default defer else fallthrough false for func go goto if import interface map nil package range return select struct switch true type var",
  rust: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while",
  c: "auto bool break case char class const continue default delete do double else enum extern false float for goto if inline int long namespace new nullptr private protected public return short signed sizeof static struct switch template this throw true try typedef union unsigned using virtual void volatile while",
  java: "abstract boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long new null package private protected public return short static super switch this throw throws true false try void volatile while var val fun",
  sql: "add all alter and as asc between by case create delete desc distinct drop else end exists from group having in index inner insert into is join left like limit not null on or order outer primary right select set table then union update values view when where with",
  css: "important media supports keyframes from to root",
  json: "true false null",
  yaml: "true false null yes no on off",
};
KEYWORDS.ts = `${KEYWORDS.js} abstract as declare enum implements interface keyof namespace private protected public readonly type`;
const ALIASES = { javascript: "js", mjs: "js", cjs: "js", jsx: "js", node: "js", typescript: "ts", tsx: "ts", python: "py", py3: "py",
  bash: "sh", shell: "sh", zsh: "sh", console: "sh", shellsession: "sh", powershell: "ps1", pwsh: "ps1", ps: "ps1", golang: "go", rs: "rust",
  cpp: "c", "c++": "c", h: "c", hpp: "c", cs: "c", csharp: "c", kotlin: "java", kt: "java", swift: "java", scss: "css", less: "css",
  yml: "yaml", jsonc: "json", json5: "json", toml: "yaml", ini: "yaml" };
const HASH_COMMENT = new Set(["py", "sh", "ps1", "yaml"]);
const SLASH_COMMENT = new Set(["js", "ts", "go", "rust", "c", "java", "css"]);
const patterns = new Map();

function patternFor(lang) {
  if (patterns.has(lang)) return patterns.get(lang);
  const parts = [];
  if (SLASH_COMMENT.has(lang)) parts.push(String.raw`(?<com>\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))`);
  else if (HASH_COMMENT.has(lang)) parts.push(String.raw`(?<com>#[^\n]*)`);
  else if (lang === "sql") parts.push(String.raw`(?<com>--[^\n]*)`);
  if (lang === "py") parts.push(String.raw`(?<str>"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)`);
  else if (lang === "js" || lang === "ts") parts.push(String.raw`(?<str>"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|\x60(?:\\.|[^\x60\\])*\x60?)`);
  else parts.push(String.raw`(?<str>"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)`);
  parts.push(String.raw`(?<num>\b(?:0x[\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b)`);
  parts.push(String.raw`(?<word>[$A-Za-z_][\w$-]*)`);
  const pattern = new RegExp(parts.join("|"), "g");
  patterns.set(lang, pattern);
  return pattern;
}

/** Code as [{ type: "" | "com" | "str" | "num" | "kw", text }]; unknown languages come back as one plain piece. */
export function highlightCode(code, lang = "") {
  const text = String(code ?? "");
  const key = ALIASES[String(lang).toLowerCase()] || String(lang).toLowerCase();
  if (!KEYWORDS[key] || text.length > 60_000) return [{ type: "", text }];
  const words = new Set(KEYWORDS[key].split(" "));
  const pattern = patternFor(key);
  pattern.lastIndex = 0;
  const pieces = [];
  let last = 0;
  const push = (type, value) => {
    if (!value) return;
    const previous = pieces.at(-1);
    if (previous && previous.type === type) previous.text += value;
    else pieces.push({ type, text: value });
  };
  for (const match of text.matchAll(pattern)) {
    push("", text.slice(last, match.index));
    const groups = match.groups;
    if (groups.com) push("com", groups.com);
    else if (groups.str) push("str", groups.str);
    else if (groups.num) push("num", groups.num);
    else push(words.has(groups.word) || (key === "sql" && words.has(groups.word.toLowerCase())) ? "kw" : "", groups.word);
    last = match.index + match[0].length;
  }
  push("", text.slice(last));
  return pieces;
}

// ---- DOM rendering: createElement and text nodes only. ----

/** A shortened address for display: the full one is in the tooltip and on the copy button. */
export function shortUrl(href, max = 64) {
  const text = String(href ?? "");
  if (text.length <= max) return text;
  const keep = max - 1;
  return `${text.slice(0, Math.ceil(keep * 0.65))}…${text.slice(text.length - Math.floor(keep * 0.35))}`;
}

function defaultCopyButton(doc, text, label = "Copy") {
  const button = doc.createElement("button");
  button.type = "button";
  button.className = "copy";
  button.textContent = label;
  button.dataset.copy = text;
  return button;
}

/**
 * Markdown as a `div.md` element. Options: `doc` (the document to build in), `copyButton(text, label)`
 * returning a button that copies `text` (the app's own, with feedback), and `codeLines` (code blocks
 * longer than this many lines start folded behind a "Show all" button).
 */
export function renderMarkdown(text, options = {}) {
  const doc = options.doc || globalThis.document;
  const context = { doc, copy: options.copyButton || ((value, label) => defaultCopyButton(doc, value, label)), codeLines: options.codeLines || 60 };
  const root = doc.createElement("div");
  root.className = "md";
  for (const block of parseMarkdown(text)) root.append(renderBlock(block, context));
  return root;
}

function element(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function renderBlock(block, context) {
  const { doc } = context;
  switch (block.type) {
    case "heading": {
      const node = element(doc, "div", `md-h md-h${block.level}`);
      node.setAttribute("role", "heading");
      node.setAttribute("aria-level", String(Math.min(6, block.level + 2)));
      appendInline(node, block.children, context);
      return node;
    }
    case "paragraph": {
      const node = element(doc, "p", "md-p");
      appendInline(node, block.children, context);
      return node;
    }
    case "code": return renderCode(block, context);
    case "hr": return element(doc, "hr", "md-hr");
    case "quote": {
      const node = element(doc, "blockquote", "md-quote");
      for (const child of block.blocks) node.append(renderBlock(child, context));
      return node;
    }
    case "list": {
      const node = element(doc, block.ordered ? "ol" : "ul", `md-list${block.loose ? " loose" : ""}`);
      if (block.ordered && block.start !== 1) node.setAttribute("start", String(block.start));
      for (const item of block.items) {
        const li = element(doc, "li", item.checked === null ? "" : `md-task${item.checked ? " done" : ""}`);
        if (item.checked !== null) {
          const box = element(doc, "span", "md-check", item.checked ? "✓" : "");
          box.setAttribute("aria-label", item.checked ? "Done" : "Not done");
          box.setAttribute("role", "img");
          li.append(box);
        }
        for (const child of item.blocks) li.append(renderBlock(child, context));
        node.append(li);
      }
      return node;
    }
    case "table": {
      const wrap = element(doc, "div", "md-table-wrap");
      const table = element(doc, "table", "md-table");
      const head = element(doc, "thead");
      const headRow = element(doc, "tr");
      block.head.forEach((cell, index) => {
        const th = element(doc, "th");
        if (block.align[index]) th.className = `align-${block.align[index]}`;
        appendInline(th, cell, context);
        headRow.append(th);
      });
      head.append(headRow);
      const body = element(doc, "tbody");
      for (const row of block.rows) {
        const tr = element(doc, "tr");
        row.forEach((cell, index) => {
          const td = element(doc, "td");
          if (block.align[index]) td.className = `align-${block.align[index]}`;
          appendInline(td, cell, context);
          tr.append(td);
        });
        body.append(tr);
      }
      table.append(head, body);
      wrap.append(table);
      return wrap;
    }
    default: return element(doc, "p", "md-p", "");
  }
}

/** A fenced code block: language, copy, highlighted lines, and a fold for long ones. */
export function renderCode(block, context) {
  const { doc } = context;
  const wrap = element(doc, "div", "md-code");
  const bar = element(doc, "div", "md-code-bar");
  const lines = block.text.split("\n");
  bar.append(element(doc, "span", "md-code-lang", block.plain ? "text (too long to format)" : block.lang || "text"));
  bar.append(element(doc, "span", "md-code-size", `${lines.length} ${lines.length === 1 ? "line" : "lines"}`));
  bar.append(context.copy(block.text, "Copy"));
  const pre = element(doc, "pre", "md-pre");
  const code = element(doc, "code");
  const fill = (text) => {
    code.replaceChildren();
    if (/^(diff|patch)$/.test(block.lang)) {
      for (const line of text.split("\n")) {
        const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : "";
        code.append(element(doc, "span", kind ? `dl ${kind}` : "dl", `${line}\n`));
      }
      return;
    }
    for (const piece of highlightCode(text, block.lang)) {
      if (piece.type) code.append(element(doc, "span", `tk-${piece.type}`, piece.text));
      else code.append(doc.createTextNode(piece.text));
    }
  };
  const folded = lines.length > context.codeLines + 10;
  fill(folded ? lines.slice(0, context.codeLines).join("\n") : block.text);
  pre.append(code);
  wrap.append(bar, pre);
  if (folded) {
    const more = element(doc, "button", "md-more", `Show all ${lines.length} lines`);
    more.type = "button";
    more.addEventListener("click", () => { fill(block.text); more.remove(); });
    wrap.append(more);
  }
  return wrap;
}

function appendInline(parent, nodes, context) {
  const { doc } = context;
  for (const node of nodes) {
    switch (node.type) {
      case "text": parent.append(doc.createTextNode(node.text)); break;
      case "br": parent.append(element(doc, "br")); break;
      case "code": parent.append(element(doc, "code", "md-ic", node.text)); break;
      case "strong": case "em": case "del": {
        const child = element(doc, node.type === "strong" ? "strong" : node.type === "em" ? "em" : "del");
        appendInline(child, node.children, context);
        parent.append(child);
        break;
      }
      case "link": parent.append(renderLink(node.href, node.children, context)); break;
      case "image": parent.append(renderLink(node.href, [{ type: "text", text: node.alt ? `Image: ${node.alt}` : "Image" }], context)); break;
      default: break;
    }
  }
}

/** A link shown as text: its words, the address it names, and a copy button. Never followed. */
function renderLink(href, children, context) {
  const { doc } = context;
  const wrap = element(doc, "span", "md-link");
  const label = element(doc, "span", "md-link-text");
  appendInline(label, children, context);
  wrap.append(label);
  wrap.title = href;
  if (plainText(children).trim() !== String(href).trim()) wrap.append(element(doc, "span", "md-link-url", shortUrl(href)));
  wrap.append(context.copy(href, "Copy link"));
  return wrap;
}
