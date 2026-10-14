/**
 * Small pure helpers shared by the agent detail readers (Claude transcripts, Codex turns, Orca).
 *
 * The detail view shows this computer's person what each agent actually did: commands, paths,
 * output tails, plans, and what it said. Everything that leaves a reader goes through
 * `redactSecrets` and is clipped to the limits below, so one huge command output or a pasted key
 * never reaches the window whole.
 */
import { redactSecrets } from "./claude.mjs";

export const DETAIL_LIMITS = Object.freeze({
  mission: 2000,
  said: 4000,
  trail: 60,
  output: 2000,
  detail: 2000,
  nowDetail: 400,
  title: 120,
  files: 100,
  paths: 20,
  screenLines: 40,
  screenLineChars: 400,
});

/**
 * Text clipped to `max` characters (an ellipsis marks the cut), secrets removed first. Only twice
 * the room is filtered, so a megabyte pasted into a prompt costs no more than a short one, and a
 * credential straddling the cut is still recognised whole.
 */
export function clean(value, max) {
  const raw = String(value ?? "").trimStart();
  const text = redactSecrets(raw.length > max * 2 ? raw.slice(0, max * 2) : raw).trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The end of a long text (command output), secrets removed: the newest lines matter most. */
export function cleanTail(value, max = DETAIL_LIMITS.output) {
  const raw = String(value ?? "");
  // Twice the room is filtered so a credential straddling the cut is still recognised whole.
  const text = redactSecrets(raw.length > max * 2 ? raw.slice(-max * 2) : raw).replace(/\s+$/, "");
  return text.length > max ? `…${text.slice(-(max - 1))}` : text;
}

/** One line for a title: the first non-empty line, clipped. */
export function oneLine(value, max = DETAIL_LIMITS.title) {
  const line = String(value ?? "").split(/\r?\n/).map((part) => part.trim()).find(Boolean) || "";
  return clean(line, max);
}

/** Lines in a text, as a diff counts them: "" is 0, a trailing newline does not add one. */
export function lineCount(text) {
  const value = String(text ?? "");
  if (!value) return 0;
  return value.replace(/\r?\n$/, "").split(/\r?\n/).length;
}

/** Added and removed lines in a unified diff (file headers are not changes). */
export function diffStats(diff) {
  let added = 0;
  let removed = 0;
  for (const line of String(diff ?? "").split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

const fold = (path) => String(path || "").replace(/\\/g, "/").replace(/\/+$/, "");

/** A path relative to `cwd` when it lies inside it (case-insensitive, either slash), else as given. */
export function relativePath(path, cwd) {
  const full = String(path || "");
  const base = fold(cwd);
  if (!full || !base) return full;
  const folded = fold(full);
  if (folded.toLowerCase() === base.toLowerCase()) return ".";
  if (folded.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return full.slice(base.length + 1);
  return full;
}

/** A file's base name, for titles. */
export function baseName(path) {
  return String(path || "").split(/[\\/]/).filter(Boolean).at(-1) || String(path || "");
}

const SHELL_WRAPPER = /^(?:"[^"]*?(?:powershell|pwsh|bash|zsh|sh|cmd)(?:\.exe)?"|\S*?(?:powershell|pwsh|bash|zsh|sh|cmd)(?:\.exe)?)\s+(?:-NoLogo\s+|-NoProfile\s+|-NonInteractive\s+|-ExecutionPolicy\s+\S+\s+)*(?:-Command|-lc|-c|\/c)\s+([\s\S]+)$/i;

/** The command a person would recognise: a `powershell -Command '…'` or `bash -lc "…"` wrapper removed. */
export function unwrapCommand(command) {
  const text = String(command ?? "").trim();
  const match = SHELL_WRAPPER.exec(text);
  if (!match) return text;
  const inner = match[1].trim();
  const quoted = /^(['"])([\s\S]*)\1$/.exec(inner);
  return quoted ? quoted[2] : inner;
}

/** Milliseconds from an ISO time, a number of seconds or milliseconds, or 0. */
export function toMs(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

const READ_KINDS = new Set(["read", "search"]);

/**
 * Collapse runs of neighbouring reads and searches into one row ("Read 4 files"), so a burst of
 * lookups does not push the commands and edits out of the trail. `rows` is newest first.
 */
export function groupLookups(rows) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length === 1) out.push(run[0]);
    else if (run.length > 1) {
      const reads = run.filter((row) => row.kind === "read");
      const searches = run.filter((row) => row.kind === "search");
      const title = reads.length && searches.length
        ? `Read ${reads.length} ${reads.length === 1 ? "file" : "files"} and searched ${searches.length} ${searches.length === 1 ? "time" : "times"}`
        : reads.length ? `Read ${reads.length} files` : `Searched ${searches.length} times`;
      const status = run.some((row) => row.status === "running") ? "running" : run.some((row) => row.status === "failed") ? "failed" : "ok";
      const paths = [...new Set(run.map((row) => row.path || row.detail).filter(Boolean))].slice(0, DETAIL_LIMITS.paths);
      // Newest first, like the trail: the group sits where its newest member was.
      out.push({ id: run[0].id, at: run[0].at, kind: reads.length ? "read" : "search", title, status, paths,
        ...(run.at(-1).at && run[0].at ? { durationMs: Math.max(0, run[0].at - run.at(-1).at) } : {}) });
    }
    run = [];
  };
  for (const row of rows) {
    if (READ_KINDS.has(row.kind)) { run.push(row); continue; }
    flush();
    out.push(row);
  }
  flush();
  // `path` is only a grouping aid; detail already carries it for single rows.
  return out.map(({ path, ...row }) => row);
}

/** Sum edits per path into the files list, newest change first. */
export function summarizeFiles(changes, cwd) {
  const byPath = new Map();
  for (const change of changes) {
    if (!change?.path) continue;
    const path = relativePath(change.path, cwd);
    const entry = byPath.get(path) || { path, added: 0, removed: 0, at: 0 };
    entry.added += Number(change.added) || 0;
    entry.removed += Number(change.removed) || 0;
    entry.at = Math.max(entry.at, Number(change.at) || 0);
    byPath.set(path, entry);
  }
  return [...byPath.values()].sort((a, b) => b.at - a.at).slice(0, DETAIL_LIMITS.files)
    .map((entry) => ({ ...entry, path: clean(entry.path, 400) }));
}

/** Plan step status from the words agents use (todos, Codex plans, Orca tasks). */
export function stepStatus(status) {
  const value = String(status || "").toLowerCase();
  if (value === "completed" || value === "done" || value === "complete") return "done";
  if (value === "in_progress" || value === "inprogress" || value === "active" || value === "dispatched" || value === "running") return "active";
  return "pending";
}
