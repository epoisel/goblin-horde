/**
 * What an agent is asking the person, and what it is doing right now, in one shape for every source.
 *
 * Each source (Claude Code hooks, Codex chats, Orca, extension feeds) builds its own `ask`, `now`, and
 * `progress` from what it saw; these helpers keep the shape, the limits, and the stable key the same
 * everywhere, so the widget can show the question itself and a dismissal can name exactly the ask it
 * dismissed. Text here is already the source's own redacted text; publicView filters it again on the
 * way out and leaves it out entirely for a phone. No dependencies, so every source can use it.
 */
import { createHash } from "node:crypto";

export const ASK_LIMITS = Object.freeze({
  text: 600, // The question itself, or "Allow PowerShell to run this command?".
  command: 400, // The exact command, path, or url being approved.
  options: 6, // Option labels per question.
  option: 80,
  questions: 4, // AskUserQuestion asks up to four at once.
  question: 300,
  title: 60, // A roster line: "Running npm test".
});

export const ASK_KINDS = Object.freeze(["permission", "question", "approval", "reply"]);
// "message": the newest thing an agent said, as a finished step ("Said: …").
export const NOW_KINDS = Object.freeze(["command", "edit", "write", "read", "search", "web", "agent", "tool", "think", "ask", "message"]);
const ANSWER_HERE = new Set(["respond", "reply", "orca-send"]);

/** Trimmed text of at most `max` characters, with an ellipsis when it was cut. */
export function clipText(value, max) {
  const text = String(value ?? "").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The first non-empty line of a command or pattern, for a one-line title. */
export function firstLine(value, max = ASK_LIMITS.title) {
  const line = String(value ?? "").split(/\r?\n/).map((part) => part.trim()).find(Boolean) || "";
  return clipText(line, max);
}

/** A url's host ("example.com"), or the clipped text when it is not a url. */
export function hostOf(value) {
  try { return new URL(String(value)).host || clipText(value, ASK_LIMITS.title); } catch { return clipText(value, ASK_LIMITS.title); }
}

/**
 * A stable signature for one ask: the same agent asking the same thing at the same moment always gets
 * the same key, so a dismissal survives restarts and polls, and a new ask (new text or time) alerts again.
 */
export function askKey(id, { kind = "", text = "", at = 0 } = {}) {
  return createHash("sha256").update(`${id}\n${kind}\n${text}\n${Number(at) || 0}`).digest("hex").slice(0, 16);
}

const labels = (options) => (Array.isArray(options) ? options : [])
  .map((option) => clipText(typeof option === "string" ? option : option?.label ?? option?.text, ASK_LIMITS.option))
  .filter(Boolean).slice(0, ASK_LIMITS.options);

/**
 * One ask in the shared contract, clipped to its limits and keyed. Returns null without a known kind or
 * any text. `fields`: kind, text, at, and optionally command, tool, options, questions
 * ([{ text, options }]), answerHere ("respond" | "reply" | "orca-send"; anything else means null),
 * and requestId.
 */
export function makeAsk(id, fields = {}) {
  const kind = ASK_KINDS.includes(fields.kind) ? fields.kind : "";
  const questions = (Array.isArray(fields.questions) ? fields.questions : []).slice(0, ASK_LIMITS.questions)
    .map((question) => ({ text: clipText(question?.text, ASK_LIMITS.question), options: labels(question?.options) }))
    .filter((question) => question.text)
    .map((question) => (question.options.length ? question : { text: question.text }));
  const text = clipText(fields.text || questions[0]?.text, ASK_LIMITS.text);
  if (!kind || !text) return null;
  const at = Number(fields.at) || 0;
  const ask = { kind, text };
  const command = clipText(fields.command, ASK_LIMITS.command);
  if (command) ask.command = command;
  if (typeof fields.tool === "string" && fields.tool) ask.tool = clipText(fields.tool, 80);
  const options = labels(fields.options ?? questions[0]?.options);
  if (options.length) ask.options = options;
  if (questions.length) ask.questions = questions;
  ask.at = at;
  ask.answerHere = ANSWER_HERE.has(fields.answerHere) ? fields.answerHere : null;
  if (fields.requestId != null && fields.requestId !== "") ask.requestId = String(fields.requestId);
  ask.key = askKey(id, { kind, text, at });
  return ask;
}

/**
 * A `now` line in the shared contract, or null. `done`: the line names the newest step that already
 * finished ("Ran npm test"), and `startedAt` is when it finished, because nothing visible is running:
 * the roster reads it as a past step ("Ran npm test · 2m ago") instead of a running timer. A "think"
 * line's `startedAt` is the agent's newest sign of activity, so its time is how long it has been
 * quiet, never how long the turn has run.
 */
export function makeNow({ kind, title, detail = "", startedAt = 0, done = false } = {}) {
  if (!NOW_KINDS.includes(kind) || !title) return null;
  const now = { kind, title: clipText(title, 120) };
  const exact = clipText(detail, ASK_LIMITS.command);
  if (exact) now.detail = exact;
  now.startedAt = Number(startedAt) || 0;
  if (done) now.done = true;
  return now;
}

/** Plan progress from a list of { status } steps: { done, total, current? }, or null for an empty plan. */
export function planProgress(steps, textOf = (step) => step?.text) {
  const list = (Array.isArray(steps) ? steps : []).filter(Boolean);
  if (!list.length) return null;
  const status = (step) => String(step?.status ?? step?.s ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  const active = list.find((step) => status(step) === "in_progress");
  const progress = { done: list.filter((step) => status(step) === "completed").length, total: list.length };
  const current = active ? clipText(textOf(active), 200) : "";
  if (current) progress.current = current;
  return progress;
}

// A list item or numbered option under a question: "- Compact", "2. Spacious".
const OPTION_LINE = /^(?:[-*•+]|\d{1,2}[.)])\s+\S/;
// Lines that are not prose: headings, tables, code fences, quotes of code.
const NOT_PROSE = /^(?:#{1,6}\s|\||```|~~~|>)/;
const SENTENCE_END = /(?<=[.!?…])["')\]]*\s+(?=["'(\[]?[A-Z0-9])/;

const plain = (line) => line.replace(/\*\*|__/g, "").replace(/^>\s*/, "").trim();
const sentencesOf = (line) => line.split(SENTENCE_END).map((part) => part.trim()).filter(Boolean);

/**
 * The question a reply ends with, as the person would want it on an alert: the closing question
 * sentence(s), plus the one sentence before them when they are short (so "Want me to push?" reads
 * "All 42 tests pass. Want me to push?"). A question followed only by a list of options still counts.
 * Returns "" when the reply does not end in a question. Callers redact first.
 */
export function closingQuestion(text, max = ASK_LIMITS.text) {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trim());
  while (lines.length && !lines.at(-1)) lines.pop();
  let index = lines.length - 1;
  let options = 0;
  while (index >= 0 && OPTION_LINE.test(lines[index])) { index--; options++; }
  if (index < 0) return "";
  const line = plain(lines[index]);
  // A list that does not answer a question is not one; neither is a reply whose last word is not a question.
  if (!line.endsWith("?") && !(options && /[?:]$/.test(line) && line.includes("?"))) return "";
  const sentences = sentencesOf(line);
  const asks = (sentence) => /\?["')\]]*$/.test(sentence);
  // "Which one do you want? Options:" asks the first sentence; the label after it is left out.
  let end = sentences.length - 1;
  while (end > 0 && !asks(sentences[end])) end--;
  let first = end;
  while (first > 0 && asks(sentences[first - 1])) first--;
  const question = sentences.slice(first, end + 1).join(" ");
  let context = first > 0 ? sentences[first - 1] : "";
  if (!context && question.length <= 120) {
    // The sentence before, from the paragraph above, when it is prose and not the end of a list or code.
    let previous = index - 1;
    while (previous >= 0 && !lines[previous]) previous--;
    const above = previous >= 0 ? lines[previous] : "";
    if (above && !OPTION_LINE.test(above) && !NOT_PROSE.test(above) && !/[:{[(,]$/.test(above)) context = sentencesOf(plain(above)).at(-1) || "";
  }
  const joined = context && context.length + question.length + 1 <= max ? `${context} ${question}` : question;
  return clipText(joined, max);
}
