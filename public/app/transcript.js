/**
 * An agent's conversation: the model that keeps it (pages merged by id, changed entries patched,
 * older pages prepended) and the renderer that draws each entry the way the Codex and Claude apps do:
 * prompts as labelled bubbles, replies as formatted Markdown, reasoning folded away, every tool call as
 * a compact row that opens to its full input and output, diffs in colour, plans as checklists, and
 * subagent spawns as rows that open the subagent's column.
 *
 * The model half (TranscriptStore, interleave, toolSummary, …) is pure, for node tests. The render
 * half builds DOM nodes only through createElement and textContent; agent text never reaches innerHTML.
 */
import { renderMarkdown } from "./markdown.js";
import { renderDiff, parseDiff, diffStats } from "./diff.js";

// ---- Model ----

/** What makes an entry look different: a change here re-renders it in place. */
export function entrySignature(entry) {
  const tool = entry.tool;
  return [entry.kind, entry.text.length, entry.text.slice(-64), tool ? [tool.status, tool.exitCode, tool.durationMs, tool.output.length, tool.diff.length, tool.title, tool.input.length].join("|") : "",
    entry.plan ? entry.plan.steps.map((step) => step.status[0] + step.text.length).join(",") : "", entry.ask?.text || ""].join("§");
}

// Columns keep at most this many entries; the oldest go (and can be loaded again by scrolling up).
export const STORE_LIMIT = 4000;

/**
 * One agent's entries in order, merged from pages. `apply(page, mode)` takes a normalised transcript
 * page and returns what changed, so views add, prepend, or patch nodes instead of redrawing:
 * { added: [entry], prepended: [entry], changed: [entry], reset: boolean }.
 *   mode "initial": the newest page; replaces everything.
 *   mode "after":   new entries are appended; known ids that changed are patched.
 *   mode "before":  older entries are prepended (known ids are skipped).
 */
export class TranscriptStore {
  constructor(agentId) {
    this.agentId = agentId;
    this.entries = [];
    this.byId = new Map();
    this.signatures = new Map();
    this.first = "";
    this.last = "";
    this.hasOlder = false;
    this.loaded = false;
    this.live = false;
    this.error = "";
    this.failures = 0;
    this.failedAt = 0;
    this.listeners = new Set();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(change) {
    for (const listener of this.listeners) listener(change, this);
  }

  apply(page, mode = "after") {
    // The server may say a page replaces everything (`reset`), e.g. after a transcript was rewritten.
    if (page?.reset) mode = "initial";
    const change = { added: [], prepended: [], changed: [], reset: false, mode };
    const entries = page?.entries || [];
    const cursor = (key) => (typeof page?.cursor?.[key] === "string" ? page.cursor[key] : null);
    if (mode === "initial" || !this.loaded) {
      change.reset = this.loaded || this.entries.length > 0;
      this.entries = [];
      this.byId.clear();
      this.signatures.clear();
      for (const entry of entries) this.remember(entry, this.entries.length);
      change.added = [...this.entries];
      this.first = cursor("first") ?? this.entries[0]?.id ?? "";
      this.last = cursor("last") || this.entries.at(-1)?.id || "";
      this.hasOlder = Boolean(page?.hasOlder);
    } else if (mode === "before") {
      const fresh = entries.filter((entry) => !this.byId.has(entry.id) && !entry.updated);
      const unique = [...new Map(fresh.map((entry) => [entry.id, entry])).values()];
      this.entries = [...unique, ...this.entries];
      this.reindex();
      change.prepended = unique;
      this.first = cursor("first") ?? unique[0]?.id ?? this.first;
      this.hasOlder = Boolean(page?.hasOlder) && entries.length > 0;
    } else {
      for (const entry of entries) {
        const known = this.byId.get(entry.id);
        // A changed entry from before the oldest one shown: nothing to patch.
        if (!known && entry.updated) continue;
        if (known) {
          const signature = entrySignature(entry);
          if (signature !== this.signatures.get(entry.id)) {
            this.entries[this.entries.indexOf(known)] = entry;
            this.byId.set(entry.id, entry);
            this.signatures.set(entry.id, signature);
            change.changed.push(entry);
          }
        } else {
          this.remember(entry, this.entries.length);
          change.added.push(entry);
        }
      }
      if (page?.cursor?.last) this.last = page.cursor.last;
      else if (change.added.length) this.last = change.added.at(-1).id;
    }
    if (this.entries.length > STORE_LIMIT) {
      const dropped = this.entries.length - STORE_LIMIT;
      this.entries = this.entries.slice(dropped);
      this.reindex();
      this.first = this.entries[0]?.id || "";
      this.hasOlder = true;
      change.dropped = dropped;
    }
    this.loaded = true;
    this.live = page?.live ?? this.live;
    this.error = "";
    this.failures = 0;
    this.emit(change);
    return change;
  }

  remember(entry, at) {
    if (this.byId.has(entry.id)) {
      const index = this.entries.indexOf(this.byId.get(entry.id));
      this.entries[index] = entry;
    } else this.entries.splice(at, 0, entry);
    this.byId.set(entry.id, entry);
    this.signatures.set(entry.id, entrySignature(entry));
  }

  reindex() {
    this.byId = new Map(this.entries.map((entry) => [entry.id, entry]));
    for (const entry of this.entries) if (!this.signatures.has(entry.id)) this.signatures.set(entry.id, entrySignature(entry));
  }

  /** A read failed: keep what is shown, say why, and count failures so polling can back off. */
  fail(message, now = Date.now()) {
    this.failures = (this.failures || 0) + 1;
    this.failedAt = now;
    this.error = message || "This transcript could not be read.";
    this.emit({ added: [], prepended: [], changed: [], reset: false, error: this.error });
  }
}

/** Each entry's time for ordering: its own, else the last known time before it in the same list. */
export function effectiveTimes(entries) {
  let last = 0;
  const times = entries.map((entry) => {
    if (entry.at) last = entry.at;
    return entry.at || last;
  });
  // Entries before the first timed one take that first time.
  const firstTimed = times.find((time) => time > 0) || 0;
  return times.map((time) => time || firstTimed);
}

/**
 * Every agent's entries in one list by time, for the Timeline: [{ agentId, entry, at }]. Entries keep
 * their order within an agent; ties between agents follow the order the agents are given in.
 */
export function interleave(lists) {
  const items = [];
  lists.forEach(({ agentId, entries }, rank) => {
    const times = effectiveTimes(entries);
    entries.forEach((entry, index) => items.push({ agentId, entry, at: times[index], rank, index }));
  });
  return items.sort((a, b) => a.at - b.at || (a.agentId === b.agentId ? a.index - b.index : a.rank - b.rank));
}

/** Where an item with time `at` goes in a list sorted by time (after equal times). */
export function insertionIndex(times, at) {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (times[middle] <= at) low = middle + 1;
    else high = middle;
  }
  return low;
}

// ---- Words ----

/** "820 ms", "4.2 s", "1m 12s", "2h 5m". */
export function formatDuration(ms) {
  // No time, or none measured (a call and its result logged in the same instant), says nothing.
  if (ms == null || ms === "" || Number(ms) === 0) return "";
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(value / 60_000);
  if (minutes < 60) return `${minutes}m ${Math.floor((value % 60_000) / 1000)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** "512 B", "14 KB", "1.2 MB". */
export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

const byteLength = (text) => (typeof TextEncoder === "function" ? new TextEncoder().encode(text).length : text.length);

const VERBS = /^(Ran|Running|Run|Read|Reading|Edited|Editing|Edit|Wrote|Writing|Write|Searched|Searching|Search|Fetched|Fetching|Called|Calling|Started|Spawned|Used|Using|Created|Creating|Viewed|Listed|Opened|Updated|Applied|Asked|Delegated)\b/;
const RUNNING = { command: "Running", edit: "Editing", write: "Writing", read: "Reading", search: "Searching", web: "Fetching", mcp: "Calling", agent: "Starting", other: "Using" };
const DONE = { command: "Ran", edit: "Edited", write: "Wrote", read: "Read", search: "Searched", web: "Fetched", mcp: "Called", agent: "Started", other: "Used" };
export const TOOL_ICONS = { command: "›_", edit: "✎", write: "+", read: "≡", search: "⌕", web: "◎", mcp: "⧉", agent: "⇲", other: "•" };

function inputField(input, ...keys) {
  if (!input || input[0] !== "{") return "";
  try {
    const value = JSON.parse(input);
    for (const key of keys) if (typeof value?.[key] === "string" && value[key]) return value[key];
  } catch { /* Not JSON: no fields. */ }
  return "";
}

const baseName = (path) => String(path).replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || String(path);

// The last few diffs parsed: a row is summarised on every redraw, and a diff can be 256 KB.
const parsedDiffs = new Map();
function parsedDiff(text) {
  if (!text) return { files: [], truncated: 0 };
  if (parsedDiffs.has(text)) return parsedDiffs.get(text);
  const parsed = parseDiff(text);
  parsedDiffs.set(text, parsed);
  if (parsedDiffs.size > 32) parsedDiffs.delete(parsedDiffs.keys().next().value);
  return parsed;
}

/**
 * How a tool row reads: { icon, verb, target, mono, added, removed, files, status, exit, duration }.
 * The verb follows the status ("Running" / "Ran"); a title that already starts with a verb is kept whole.
 */
export function toolSummary(tool) {
  const kind = tool.kind || "other";
  const running = tool.status === "running";
  const input = tool.input || "";
  const fileTarget = () => {
    const paths = tool.files.map((file) => file.path);
    if (!paths.length) {
      const named = inputField(input, "file_path", "path", "notebook_path", "filename");
      if (named) paths.push(named);
      else for (const file of parsedDiff(tool.diff).files) if (file.path) paths.push(file.path);
    }
    if (!paths.length) return "";
    return paths.length === 1 ? paths[0] : `${baseName(paths[0])} and ${paths.length - 1} more`;
  };
  let target = "";
  let mono = false;
  if (kind === "command") { target = inputField(input, "command", "cmd") || input; mono = true; }
  else if (kind === "edit" || kind === "write" || kind === "read") { target = fileTarget(); mono = Boolean(target); }
  else if (kind === "search") { target = inputField(input, "pattern", "query", "glob") || input; mono = true; }
  else if (kind === "web") target = inputField(input, "url", "query") || input;
  else if (kind === "mcp") target = tool.name.replace(/^mcp__/, "").replace(/__/g, " · ");
  else if (kind === "agent") target = inputField(input, "description", "subagent_type") || tool.title;
  else target = tool.name;
  target = String(target).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  const multiline = kind === "command" && /\n\s*\S/.test(inputField(input, "command") || input);
  let verb = running ? RUNNING[kind] : DONE[kind];
  // "Used Bash" is only a fallback name; any other title is the source's own words.
  const title = tool.title && !/^Used [\w.:-]+$/.test(tool.title) ? tool.title : "";
  const sentence = (words) => VERBS.test(words) && words !== target;
  if (kind === "command" && title && !sentence(title)) target = title; // A command's title is the command (unwrapped).
  else if ((kind === "edit" || kind === "write") && target && (!title || /^(Created|Wrote|Edited)\b/.test(title))) {
    // "Edited payments.ts": keep the verb, show the whole path.
    if (!running && title) verb = /^(Created|Wrote|Edited)/.exec(title)[1];
  } else if (title && sentence(title)) { verb = ""; target = title; mono = false; }
  else if (title) { target = title; mono = kind === "command"; }
  if (tool.status === "denied") verb = kind === "command" ? "Not run:" : "Denied:";
  let added = null;
  let removed = null;
  const counted = tool.files.filter((file) => file.added != null || file.removed != null);
  if (counted.length) {
    added = counted.reduce((sum, file) => sum + (file.added || 0), 0);
    removed = counted.reduce((sum, file) => sum + (file.removed || 0), 0);
  } else if (tool.diff) ({ added, removed } = diffStats(parsedDiff(tool.diff)));
  return {
    icon: TOOL_ICONS[kind] || TOOL_ICONS.other,
    verb,
    target: target.length > 240 ? `${target.slice(0, 239)}…` : target,
    more: multiline,
    mono,
    added,
    removed,
    status: tool.status,
    exit: tool.exitCode != null && tool.exitCode !== 0 ? `exit ${tool.exitCode}` : "",
    duration: formatDuration(tool.durationMs),
    badges: [tool.background ? "background" : "", tool.interrupted ? "interrupted" : ""].filter(Boolean),
  };
}

/** Who sent a prompt, as its bubble's label. */
export function promptLabel(entry, { agent = null, agentsById = new Map() } = {}) {
  const parent = agent?.parentId ? agentsById.get(agent.parentId) : null;
  if (entry.from === "coordinator") {
    const named = parent && parent.role === "coordinator" && !/^(the )?coordinator$/i.test(parent.name.trim());
    return named ? `From the coordinator · ${parent.name}` : "From the coordinator";
  }
  if (entry.from === "parent") return parent ? `From ${parent.name}` : "From the parent chat";
  if (entry.from === "agent") return "From another agent";
  if (entry.from === "system") return "System";
  return "You";
}

/** "14:05" today, "Tue 14:05" this week, else "Mar 3 14:05". */
export function clockTime(ms, now = Date.now()) {
  if (!ms) return "";
  const date = new Date(ms);
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const age = now - ms;
  if (age < 20 * 3600_000 && new Date(now).getDate() === date.getDate()) return time;
  if (age < 6 * 86_400_000) return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

/** Line count and size of a text, for headers like "1,204 lines · 312 KB". */
export function textSize(value) {
  const lines = value ? value.split("\n").length - (value.endsWith("\n") ? 1 : 0) : 0;
  return { lines, bytes: byteLength(value || "") };
}

// ---- Rendering ----

// Expanded output shows this much first; "Show all" draws the rest.
export const OUTPUT_PREVIEW_LINES = 200;
export const OUTPUT_PREVIEW_BYTES = 48 * 1024;

function element(doc, tag, className, words) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (words != null) node.textContent = words;
  return node;
}

/**
 * The first part of a long text: at most `lines` lines and `bytes` characters. Returns
 * { shown, hiddenLines } so the caller can offer the rest.
 */
export function previewText(value, { lines = OUTPUT_PREVIEW_LINES, bytes = OUTPUT_PREVIEW_BYTES } = {}) {
  const source = String(value ?? "");
  let end = 0;
  let count = 0;
  while (count < lines && end < source.length) {
    const next = source.indexOf("\n", end);
    if (next === -1) { end = source.length; break; }
    end = next + 1;
    count++;
  }
  if (end > bytes) end = bytes;
  if (end >= source.length) return { shown: source, hiddenLines: 0, hiddenBytes: 0 };
  const rest = source.slice(end);
  return { shown: source.slice(0, end), hiddenLines: rest.split("\n").length - (rest.endsWith("\n") ? 1 : 0), hiddenBytes: source.length - end };
}

/**
 * A labelled monospace block: label, size, copy, and the text wrapped. Long text shows its start
 * and a "Show all" button; copy always copies all of it.
 */
export function renderBlock(ctx, label, value, { className = "", note = "", tone = "" } = {}) {
  const { doc } = ctx;
  const box = element(doc, "div", `io ${className}`.trim());
  const head = element(doc, "div", "io-head");
  head.append(element(doc, "span", "io-label", label));
  const size = textSize(value);
  head.append(element(doc, "span", "io-size", size.lines > 1 ? `${size.lines.toLocaleString()} lines · ${formatBytes(size.bytes)}` : formatBytes(size.bytes)));
  if (note) head.append(element(doc, "span", "io-note", note));
  head.append(ctx.copyButton(value, `Copy ${label.toLowerCase()}`));
  const pre = element(doc, "pre", `io-pre${tone ? ` ${tone}` : ""}`);
  const preview = previewText(value);
  pre.textContent = preview.shown;
  box.append(head, pre);
  if (preview.hiddenBytes) {
    const more = element(doc, "button", "io-more", `Show all · ${preview.hiddenLines.toLocaleString()} more lines (${formatBytes(preview.hiddenBytes)})`);
    more.type = "button";
    more.addEventListener("click", () => {
      pre.textContent = value;
      more.remove();
    });
    box.append(more);
  }
  return box;
}

function statusGlyph(doc, status) {
  const glyph = element(doc, "span", `tool-state ${status}`);
  glyph.setAttribute("role", "img");
  if (status === "running") { glyph.setAttribute("aria-label", "Running"); glyph.append(element(doc, "span", "spin")); }
  else if (status === "ok") { glyph.setAttribute("aria-label", "Done"); glyph.textContent = "✓"; }
  else if (status === "failed") { glyph.setAttribute("aria-label", "Failed"); glyph.textContent = "✕"; }
  else { glyph.setAttribute("aria-label", "Denied"); glyph.textContent = "⊘"; }
  return glyph;
}

function toolHead(ctx, tool, { label = "" } = {}) {
  const { doc } = ctx;
  const summary = toolSummary(tool);
  const head = element(doc, "button", "tool-head");
  head.type = "button";
  head.setAttribute("aria-expanded", "false");
  const icon = element(doc, "span", `tool-icon k-${tool.kind}`, summary.icon);
  icon.setAttribute("aria-hidden", "true");
  head.append(icon);
  const title = element(doc, "span", "tool-title");
  if (label) title.append(element(doc, "span", "tool-verb", label));
  else if (summary.verb) title.append(element(doc, "span", "tool-verb", summary.verb));
  if (summary.target) title.append(element(doc, "span", summary.mono ? "tool-target mono" : "tool-target", summary.target));
  if (summary.more) title.append(element(doc, "span", "tool-more", "…"));
  head.append(title);
  const meta = element(doc, "span", "tool-meta");
  for (const badge of summary.badges) meta.append(element(doc, "span", `tool-badge ${badge}`, badge));
  if (summary.added != null || summary.removed != null) {
    const stat = element(doc, "span", "tool-stat");
    stat.append(element(doc, "span", "plus", `+${summary.added || 0}`), element(doc, "span", "minus", `−${summary.removed || 0}`));
    meta.append(stat);
  }
  if (summary.exit) meta.append(element(doc, "span", "tool-exit", summary.exit));
  if (summary.duration) meta.append(element(doc, "span", "tool-dur", summary.duration));
  meta.append(statusGlyph(doc, tool.status));
  head.append(meta);
  const chevron = element(doc, "span", "chev", "›");
  chevron.setAttribute("aria-hidden", "true");
  head.append(chevron);
  head.title = [[summary.verb, summary.target].filter(Boolean).join(" "), tool.description].filter(Boolean).join("\n");
  return head;
}

function toolBody(ctx, tool) {
  const { doc } = ctx;
  const body = element(doc, "div", "tool-body");
  if (tool.description) body.append(element(doc, "p", "tool-why", tool.description));
  const facts = [];
  if (tool.cwd) facts.push(["in", tool.cwd]);
  if (tool.exitCode != null) facts.push(["exit code", String(tool.exitCode)]);
  if (tool.durationMs != null) facts.push(["took", formatDuration(tool.durationMs)]);
  if (tool.name && tool.kind !== "command") facts.push(["tool", tool.name]);
  if (facts.length) {
    const row = element(doc, "div", "tool-facts");
    for (const [key, value] of facts) {
      const fact = element(doc, "span", "fact");
      fact.append(element(doc, "span", "fact-key", key), element(doc, "span", "fact-value", value));
      row.append(fact);
    }
    body.append(row);
  }
  if (tool.diff) {
    body.append(renderDiff(parsedDiff(tool.diff), { doc, path: tool.files[0]?.path || "", copyButton: ctx.copyButton }));
    const copyRow = element(doc, "div", "io-actions");
    if (tool.diffTruncated) copyRow.append(element(doc, "span", "io-note", "This diff is long: its start and end are shown."));
    copyRow.append(ctx.copyButton(tool.diff, "Copy diff"));
    body.append(copyRow);
  }
  const showInput = tool.input && !(tool.diff && (tool.kind === "edit" || tool.kind === "write"));
  if (showInput) body.append(renderBlock(ctx, tool.kind === "command" ? "Command" : "Input", tool.input,
    { className: tool.kind === "command" ? "command" : "", note: tool.inputTruncated ? "start and end shown" : "" }));
  if (tool.output) {
    const truncated = tool.outputTruncated;
    const note = truncated ? `showing ${formatBytes(truncated.shownBytes)} of ${formatBytes(truncated.totalBytes)}` : "";
    body.append(renderBlock(ctx, tool.status === "failed" ? "Output (failed)" : "Output", tool.output, { note, tone: tool.status === "failed" ? "failed" : "" }));
  } else if (tool.status === "running") body.append(element(doc, "div", "io-empty", "Running… output appears when it finishes."));
  else if (!tool.diff) body.append(element(doc, "div", "io-empty", "No output."));
  if (tool.files.length > 1 || (tool.files.length && !tool.diff)) {
    const files = element(doc, "ul", "tool-files");
    for (const file of tool.files) {
      const item = element(doc, "li");
      item.append(element(doc, "span", "mono", file.path));
      if (file.added != null || file.removed != null) item.append(element(doc, "span", "plus", ` +${file.added || 0}`), element(doc, "span", "minus", ` −${file.removed || 0}`));
      files.append(item);
    }
    body.append(files);
  }
  return body;
}

/** A row that opens: head is a button; its body is built on first open (big outputs cost nothing until then). */
function foldable(ctx, node, head, build, open = false) {
  let body = null;
  const set = (value) => {
    head.setAttribute("aria-expanded", String(value));
    node.classList.toggle("open", value);
    if (value && !body) { body = build(); node.append(body); }
    if (body) body.hidden = !value;
  };
  head.addEventListener("click", () => {
    const value = head.getAttribute("aria-expanded") !== "true";
    set(value);
    ctx.onToggle?.(node.dataset.id, value);
  });
  set(open);
}

function timeTag(ctx, entry) {
  if (!entry.at) return null;
  const tag = element(ctx.doc, "time", "e-time", clockTime(entry.at, ctx.now?.() || Date.now()));
  tag.dateTime = new Date(entry.at).toISOString();
  tag.title = new Date(entry.at).toLocaleString();
  return tag;
}

function renderPrompt(ctx, entry, node) {
  const { doc } = ctx;
  node.classList.add(`from-${entry.from || "you"}`);
  const head = element(doc, "div", "e-head");
  head.append(element(doc, "span", "e-who", promptLabel(entry, ctx)));
  if (entry.queued) {
    const chip = element(doc, "span", "e-chip", "queued");
    chip.title = "Sent while the agent was busy; it read this after its current step.";
    head.append(chip);
  }
  const time = timeTag(ctx, entry);
  if (time) head.append(time);
  head.append(ctx.copyButton(entry.text, "Copy prompt"));
  const body = element(doc, "div", "e-bubble-body");
  body.append(renderMarkdown(entry.text, { doc, copyButton: ctx.copyButton }));
  node.append(head, body);
  // Long prompts (a coordinator's full brief) start folded.
  if (entry.text.length > 900 || entry.text.split("\n").length > 14) {
    node.classList.add("long");
    const more = element(doc, "button", "e-expand", "Show the whole prompt");
    more.type = "button";
    more.setAttribute("aria-expanded", "false");
    more.addEventListener("click", () => {
      const open = !node.classList.contains("unfolded");
      node.classList.toggle("unfolded", open);
      more.textContent = open ? "Show less" : "Show the whole prompt";
      more.setAttribute("aria-expanded", String(open));
      ctx.onToggle?.(entry.id, open);
    });
    node.append(more);
    if (ctx.isOpen?.(entry.id)) more.click();
  }
}

function renderMessage(ctx, entry, node) {
  const { doc } = ctx;
  if (entry.phase) node.dataset.phase = entry.phase;
  const tools = element(doc, "div", "e-tools");
  const time = timeTag(ctx, entry);
  if (time) tools.append(time);
  tools.append(ctx.copyButton(entry.text, "Copy message"));
  node.append(tools, renderMarkdown(entry.text, { doc, copyButton: ctx.copyButton }));
}

function renderReasoning(ctx, entry, node) {
  const { doc } = ctx;
  const head = element(doc, "button", "fold-head");
  head.type = "button";
  head.append(element(doc, "span", "chev", "›"), element(doc, "span", "fold-label", "Reasoning"));
  const firstLine = entry.text.replace(/[*_#`]/g, "").split("\n").map((line) => line.trim()).find(Boolean) || "";
  if (firstLine) head.append(element(doc, "span", "fold-peek", firstLine.length > 120 ? `${firstLine.slice(0, 119)}…` : firstLine));
  node.append(head);
  foldable(ctx, node, head, () => {
    const body = element(doc, "div", "fold-body");
    body.append(renderMarkdown(entry.text, { doc, copyButton: ctx.copyButton }));
    return body;
  }, ctx.isOpen?.(entry.id));
}

function renderTool(ctx, entry, node) {
  const tool = entry.tool;
  node.dataset.status = tool.status;
  node.dataset.kind = tool.kind;
  const head = toolHead(ctx, tool);
  node.append(head);
  foldable(ctx, node, head, () => toolBody(ctx, tool), ctx.isOpen?.(entry.id));
}

function renderSubagent(ctx, entry, node) {
  const { doc } = ctx;
  const tool = entry.tool || { name: "Agent", kind: "agent", title: "", input: "", status: "ok", exitCode: null, durationMs: null, output: "", diff: "", files: [], agentId: entry.agentId };
  // A spawn still running has no subagent id yet (it comes with the result): the task's own list may know it.
  const agentId = entry.agentId || tool.agentId || ctx.guessSubagent?.(entry) || null;
  const sub = agentId ? ctx.agentsById?.get(agentId) : null;
  const row = element(doc, "div", "sub-row");
  // "Started Explore subagent: …" already says what it is; a bare description gets a label.
  const said = VERBS.test(tool.title || "");
  const head = toolHead(ctx, { ...tool, kind: "agent", title: tool.title || entry.text.split("\n")[0] },
    { label: said ? "" : tool.status === "running" ? "Subagent working:" : "Subagent:" });
  row.append(head);
  const open = element(doc, "button", "sub-open", sub ? `Open ${sub.name} ›` : "Not in this task");
  open.type = "button";
  open.disabled = !sub;
  open.title = sub ? "Show this subagent's column" : "This subagent is not listed in the task";
  open.addEventListener("click", (event) => { event.stopPropagation(); ctx.openAgent?.(agentId); });
  row.append(open);
  node.append(row);
  foldable(ctx, node, head, () => toolBody(ctx, { ...tool, kind: "agent", input: tool.input || entry.text }), ctx.isOpen?.(entry.id));
}

function renderPlan(ctx, entry, node) {
  const { doc } = ctx;
  const steps = entry.plan?.steps || [];
  if (entry.plan?.change && steps.length <= 1) {
    // One task added or updated: a line, not a whole checklist.
    const step = steps[0] || { text: entry.text, status: "pending" };
    node.classList.add("plan-change");
    const mark = element(doc, "span", `plan-mark ${step.status}`, step.status === "done" ? "✓" : step.status === "active" ? "●" : "");
    mark.setAttribute("role", "img");
    mark.setAttribute("aria-label", step.status === "done" ? "Done" : step.status === "active" ? "In progress" : "To do");
    node.append(element(doc, "span", "plan-title", entry.plan.change === "added" ? "Task added" : "Task updated"), mark, element(doc, "span", "plan-text", step.text));
    const time = timeTag(ctx, entry);
    if (time) node.append(time);
    return;
  }
  if (!steps.length) {
    // A plan written as prose: Codex's plan, or a plan Claude Code proposed.
    const head = element(doc, "div", "plan-head");
    head.append(element(doc, "span", "plan-title", "Plan"));
    const time = timeTag(ctx, entry);
    if (time) head.append(time);
    head.append(ctx.copyButton(entry.text, "Copy plan"));
    node.append(head, renderMarkdown(entry.text || "No plan text was recorded.", { doc, copyButton: ctx.copyButton }));
    return;
  }
  const done = steps.filter((step) => step.status === "done").length;
  const head = element(doc, "div", "plan-head");
  head.append(element(doc, "span", "plan-title", "Plan"), element(doc, "span", "plan-count", `${done} of ${steps.length} done`));
  const time = timeTag(ctx, entry);
  if (time) head.append(time);
  const bar = element(doc, "div", "plan-bar");
  const fill = element(doc, "span", "plan-fill");
  fill.style.width = `${steps.length ? Math.round((done / steps.length) * 100) : 0}%`;
  bar.append(fill);
  const items = element(doc, "ol", "plan-steps");
  for (const step of steps) {
    const item = element(doc, "li", step.status);
    const mark = element(doc, "span", "plan-mark", step.status === "done" ? "✓" : step.status === "active" ? "●" : "");
    mark.setAttribute("aria-label", step.status === "done" ? "Done" : step.status === "active" ? "In progress" : "To do");
    mark.setAttribute("role", "img");
    item.append(mark, element(doc, "span", "plan-text", step.text));
    items.append(item);
  }
  node.append(head, bar);
  if (entry.plan?.explanation) node.append(element(doc, "p", "plan-note", entry.plan.explanation));
  node.append(items);
}

function renderAsk(ctx, entry, node) {
  const { doc } = ctx;
  const ask = entry.ask || { kind: "question", text: entry.text, options: [], questions: [], command: "" };
  const head = element(doc, "div", "e-head");
  head.append(element(doc, "span", "e-who", ask.kind === "permission" || ask.kind === "approval" ? "Asked for your approval" : "Asked you"));
  const time = timeTag(ctx, entry);
  if (time) head.append(time);
  node.append(head, element(doc, "p", "ask-text", ask.text));
  if (ask.command) node.append(element(doc, "pre", "ask-command", ask.command));
  const options = ask.options.length ? ask.options : ask.questions[0]?.options || [];
  if (options.length) {
    const row = element(doc, "div", "ask-options");
    for (const option of options) row.append(element(doc, "span", "option-chip", option));
    node.append(row);
  }
}

function renderNote(ctx, entry, node) {
  const { doc } = ctx;
  if (entry.kind === "compaction") {
    const head = element(doc, "button", "fold-head");
    head.type = "button";
    head.append(element(doc, "span", "chev", "›"), element(doc, "span", "fold-label", "Context compacted"));
    if (entry.text) head.append(element(doc, "span", "fold-peek", "summary of the conversation so far"));
    node.append(head);
    foldable(ctx, node, head, () => {
      const body = element(doc, "div", "fold-body");
      body.append(entry.text ? renderMarkdown(entry.text, { doc, copyButton: ctx.copyButton }) : element(doc, "p", "", "No summary was recorded."));
      return body;
    }, ctx.isOpen?.(entry.id));
    return;
  }
  if (entry.kind === "error") {
    node.append(element(doc, "span", "err-mark", "!"), element(doc, "span", "err-text", entry.text || "Something went wrong."));
    return;
  }
  if (entry.screen) {
    // An Orca terminal's screen, as it looks right now.
    node.classList.add("e-screen");
    const time = timeTag(ctx, entry);
    node.append(renderBlock(ctx, time ? `Terminal screen · ${time.textContent}` : "Terminal screen", entry.text || ""));
    return;
  }
  const words = element(doc, "span", "sys-text", entry.text || "");
  node.append(words);
  const time = timeTag(ctx, entry);
  if (time) node.append(time);
}

const KIND_CLASS = { prompt: "e-prompt", message: "e-msg", reasoning: "e-reason", tool: "e-tool", subagent: "e-sub", plan: "e-plan", ask: "e-ask", system: "e-sys", compaction: "e-compact", error: "e-err" };

/**
 * One entry as a DOM node (`div.e` with `data-id`). `ctx`: { doc, agent, agentsById, copyButton(text,
 * label), openAgent(id), isOpen(id), onToggle(id, open), now() }.
 */
export function renderEntry(entry, ctx) {
  const node = element(ctx.doc, "div", `e ${KIND_CLASS[entry.kind] || "e-sys"}`);
  node.dataset.id = entry.id;
  node.dataset.kind = entry.kind;
  fillEntry(node, entry, ctx);
  return node;
}

function fillEntry(node, entry, ctx) {
  switch (entry.kind) {
    case "prompt": renderPrompt(ctx, entry, node); break;
    case "message": renderMessage(ctx, entry, node); break;
    case "reasoning": renderReasoning(ctx, entry, node); break;
    case "tool": if (entry.tool) renderTool(ctx, entry, node); else renderNote(ctx, entry, node); break;
    case "subagent": renderSubagent(ctx, entry, node); break;
    case "plan": renderPlan(ctx, entry, node); break;
    case "ask": renderAsk(ctx, entry, node); break;
    default: renderNote(ctx, entry, node);
  }
}

/** Redraw an entry that changed, in place, keeping it open if it was open. */
export function updateEntry(node, entry, ctx) {
  const open = node.classList.contains("open") || node.classList.contains("unfolded");
  const fresh = renderEntry(entry, { ...ctx, isOpen: (id) => (id === entry.id ? open : ctx.isOpen?.(id)) });
  node.replaceWith(fresh);
  return fresh;
}
