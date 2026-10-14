/**
 * What a Codex chat is doing, in full: the detail view's mission, plan, running step, last words,
 * trail and changed files for one chat, built from the same paged turn read the feed already uses
 * (never the whole history) plus the newest `update_plan` call in the chat's own session file.
 *
 * Codex hides finished work behind "Worked for 5m"; the items are all there. Commands keep their
 * exit code, duration and an output tail, file changes their paths and line counts from the diff,
 * tool calls their arguments. Everything is clipped and passed through redactSecrets.
 */
import { statSync } from "node:fs";
import { readFileTail } from "./claude.mjs";
import {
  DETAIL_LIMITS, baseName, clean, cleanTail, diffStats, groupLookups, lineCount, oneLine, relativePath, stepStatus, summarizeFiles,
  toMs, unwrapCommand,
} from "./detail-text.mjs";

const CHAT_ID = /^[A-Za-z0-9_-]{8,100}$/;

function inputText(item) {
  const content = Array.isArray(item?.content) ? item.content : [];
  return content.map((part) => (part?.type === "text" ? part.text || "" : part?.type === "image" || part?.type === "localImage" ? "[image]" : ""))
    .filter(Boolean).join("\n").trim();
}

function messageText(item) {
  if (typeof item?.text === "string") return item.text;
  return Array.isArray(item?.content) ? item.content.map((part) => part?.text || "").join("\n") : "";
}

function statusOf(item, turnRunning) {
  const status = String(item?.status || "").toLowerCase();
  if (status === "inprogress" || status === "in_progress") return turnRunning ? "running" : "ok";
  if (status === "failed" || status === "declined" || status === "error") return "failed";
  if (item?.success === false) return "failed";
  return "ok";
}

/** Lines added and removed by one Codex file change: a unified diff for updates, the content for adds and deletes. */
export function changeStats(change) {
  const kind = String(change?.kind?.type ?? change?.kind ?? "update");
  const diff = String(change?.diff ?? "");
  if (kind === "add") return /^@@|\n[-+]/.test(diff) ? diffStats(diff) : { added: lineCount(diff), removed: 0 };
  if (kind === "delete") return { added: 0, removed: lineCount(diff) };
  return diffStats(diff);
}

function json(value, max) {
  try { return clean(typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 1), max); } catch { return ""; }
}

function hostOf(url) {
  try { return new URL(String(url)).host || String(url); } catch { return String(url || "a page"); }
}

function resultText(result) {
  const content = Array.isArray(result?.content) ? result.content : Array.isArray(result) ? result : [];
  return content.map((part) => (typeof part === "string" ? part : part?.text || "")).filter(Boolean).join("\n");
}

/**
 * One trail row for a Codex item, or null for items that are not steps (the person's own message,
 * reasoning). Pure. `at` is the turn's start: Codex items carry no time of their own.
 */
export function codexItemRow(item, { at = 0, cwd = "", turnRunning = false } = {}) {
  if (!item || typeof item !== "object") return null;
  const id = String(item.id || "");
  const status = statusOf(item, turnRunning);
  const base = { id, at, status };
  switch (item.type) {
    case "commandExecution": {
      const command = String(item.command ?? "");
      const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
      const row = { ...base, kind: "command", title: oneLine(unwrapCommand(command)) || "Ran a command", detail: clean(command, DETAIL_LIMITS.detail) };
      // A command that only reads or searches (Codex says so) groups with the other lookups.
      if (actions.length && actions.every((action) => action?.type === "read" || action?.type === "listFiles")) {
        const path = String(actions[0]?.path || actions[0]?.name || "");
        Object.assign(row, { kind: "read", title: actions.length === 1 ? `${actions[0].type === "listFiles" ? "Listed" : "Read"} ${baseName(path) || "a file"}` : `Read ${actions.length} files`,
          path: clean(relativePath(path, cwd) || command, 400) });
      } else if (actions.length && actions.every((action) => action?.type === "search")) {
        const query = String(actions[0]?.query || "");
        Object.assign(row, { kind: "search", title: query ? `Searched for "${oneLine(query, 80)}"` : "Searched files", path: clean(query || command, 400) });
      }
      if (item.aggregatedOutput) row.output = cleanTail(item.aggregatedOutput);
      if (Number.isFinite(item.exitCode)) {
        row.exitCode = item.exitCode;
        if (item.exitCode !== 0 && row.status === "ok") row.status = "failed";
      }
      if (Number.isFinite(item.durationMs)) row.durationMs = item.durationMs;
      return row;
    }
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes
        : item.changes && typeof item.changes === "object" ? Object.entries(item.changes).map(([path, change]) => ({ path, ...change })) : [];
      let added = 0;
      let removed = 0;
      for (const change of changes) { const stats = changeStats(change); added += stats.added; removed += stats.removed; }
      const kinds = changes.map((change) => String(change?.kind?.type ?? change?.kind ?? "update"));
      const verb = kinds.every((kind) => kind === "add") ? "Created" : kinds.every((kind) => kind === "delete") ? "Deleted" : "Edited";
      const paths = changes.map((change) => relativePath(String(change?.path || ""), cwd)).filter(Boolean);
      return { ...base, kind: verb === "Created" ? "write" : "edit", title: changes.length === 1 ? `${verb} ${baseName(paths[0])}` : `${verb} ${changes.length} files`,
        detail: clean(paths.join("\n"), DETAIL_LIMITS.detail), paths: paths.slice(0, DETAIL_LIMITS.paths).map((path) => clean(path, 400)), added, removed };
    }
    case "mcpToolCall": {
      const row = { ...base, kind: "tool", title: `Used ${oneLine(`${item.server || "a connected app"} · ${item.tool || "tool"}`.replace(/[_]+/g, " "), 80)}`,
        detail: json(item.arguments, 1000) };
      const output = item.error?.message || resultText(item.result);
      if (output) row.output = cleanTail(output);
      if (item.error && row.status === "ok") row.status = "failed";
      if (Number.isFinite(item.durationMs)) row.durationMs = item.durationMs;
      return row;
    }
    case "dynamicToolCall": {
      const row = { ...base, kind: "tool", title: `Used ${oneLine(item.tool || "a tool", 60)}`, detail: json(item.arguments, 1000) };
      const output = resultText(item.contentItems);
      if (output) row.output = cleanTail(output);
      if (Number.isFinite(item.durationMs)) row.durationMs = item.durationMs;
      return row;
    }
    case "webSearch": {
      const action = item.action && typeof item.action === "object" ? item.action : {};
      const query = String(item.query || action.query || (Array.isArray(action.queries) ? action.queries.join(" · ") : "") || "");
      if (action.type === "openPage") return { ...base, kind: "web", title: `Opened ${oneLine(hostOf(action.url), 80)}`, detail: clean(action.url, DETAIL_LIMITS.detail) };
      if (action.type === "findInPage") return { ...base, kind: "web", title: `Searched a page for "${oneLine(action.pattern, 60)}"`, detail: clean(`${action.pattern || ""} ${action.url || ""}`, DETAIL_LIMITS.detail) };
      return { ...base, kind: "web", title: query ? `Searched the web for "${oneLine(query, 80)}"` : "Searched the web", ...(query ? { detail: clean(query, DETAIL_LIMITS.detail) } : {}) };
    }
    case "agentMessage": {
      const text = messageText(item).trim();
      return text ? { ...base, kind: "message", title: oneLine(text), detail: clean(text, DETAIL_LIMITS.detail), status: "ok" } : null;
    }
    case "collabAgentToolCall": {
      const tool = String(item.tool || "");
      const title = /spawn/i.test(tool) ? "Started a subagent" : /wait/i.test(tool) ? "Waited for subagents" : /send|message|input/i.test(tool) ? "Messaged a subagent"
        : /close/i.test(tool) ? "Closed a subagent" : `Used ${oneLine(tool || "a subagent tool", 60)}`;
      const receiver = (Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []).find((value) => CHAT_ID.test(String(value)));
      return { ...base, kind: "agent", title, ...(item.prompt ? { detail: clean(item.prompt, DETAIL_LIMITS.detail) } : {}), ...(receiver ? { agentId: receiver } : {}) };
    }
    case "plan": return { ...base, kind: "tool", title: "Wrote a plan", detail: clean(item.text, DETAIL_LIMITS.detail) };
    case "imageView": return { ...base, kind: "read", title: `Viewed ${baseName(item.path) || "an image"}`, path: clean(relativePath(String(item.path || ""), cwd), 400) };
    case "contextCompaction": return { ...base, kind: "tool", title: "Compacted the conversation" };
    case "enteredReviewMode": return { ...base, kind: "tool", title: "Started a review" };
    case "exitedReviewMode": return { ...base, kind: "tool", title: "Finished a review" };
    case "sleep": return { ...base, kind: "tool", title: "Waited", ...(Number.isFinite(item.durationMs) ? { durationMs: item.durationMs } : {}) };
    default: return null;
  }
}

const NOW_TITLES = { command: (row) => `Running ${row.title}`, read: (row) => row.title.replace(/^Read/, "Reading").replace(/^Listed/, "Listing"),
  search: (row) => row.title.replace(/^Searched/, "Searching"), edit: (row) => row.title.replace(/^Edited/, "Editing").replace(/^Deleted/, "Deleting"),
  write: (row) => row.title.replace(/^Created/, "Creating"), web: (row) => row.title.replace(/^Searched/, "Searching").replace(/^Opened/, "Opening"),
  agent: (row) => row.title.replace(/^Started/, "Starting").replace(/^Waited/, "Waiting").replace(/^Messaged/, "Messaging"), tool: (row) => row.title.replace(/^Used/, "Using") };

/**
 * The detail parts for one chat from its raw newest turns (oldest first, as the paged reader
 * returns them). Pure. `active`: the chat is working now (its newest turn is open here or in the
 * Codex app). `subagent`: the chat was started by another chat, so its instructions came from there.
 */
export function codexDetail(thread, { cwd = thread?.cwd || "", active = false, subagent = false, parentMission = null, plan = null } = {}) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const rows = [];
  const changes = [];
  let mission = null;
  let said = null;
  let saidAnyTurn = null;
  let now = null;
  turns.forEach((turn, turnIndex) => {
    const at = toMs(turn?.startedAt) || 0;
    const last = turnIndex === turns.length - 1;
    const turnRunning = last && (active || String(turn?.status || "").toLowerCase() === "inprogress");
    (Array.isArray(turn?.items) ? turn.items : []).forEach((item, itemIndex) => {
      const order = turnIndex * 100_000 + itemIndex;
      if (item?.type === "userMessage") {
        const text = inputText(item);
        if (text) mission = { text: clean(text, DETAIL_LIMITS.mission), from: subagent ? "parent" : "you", at };
        return;
      }
      if (item?.type === "agentMessage") {
        const text = messageText(item).trim();
        if (text) {
          saidAnyTurn = { text: clean(text, DETAIL_LIMITS.said), at: toMs(turn?.completedAt) || at };
          if (last) said = saidAnyTurn;
        }
      }
      if (item?.type === "fileChange" && statusOf(item, false) !== "failed") {
        const list = Array.isArray(item.changes) ? item.changes : [];
        for (const change of list) changes.push({ path: String(change?.path || ""), ...changeStats(change), at, last });
      }
      const row = codexItemRow(item, { at, cwd, turnRunning });
      if (!row) return;
      rows.push({ ...row, order });
      if (turnRunning && row.status === "running" && row.kind !== "message") {
        now = { kind: row.kind, title: oneLine((NOW_TITLES[row.kind] || ((value) => value.title))(row)),
          ...(row.detail ? { detail: clean(row.detail, DETAIL_LIMITS.nowDetail) } : {}), startedAt: at };
      }
    });
  });
  const lastTurn = turns.at(-1);
  if (active && !now && lastTurn) now = { kind: "think", title: "Thinking", startedAt: toMs(lastTurn.startedAt) || 0 };
  if (!active) now = null;
  if (!mission && parentMission?.text) mission = { text: clean(parentMission.text, DETAIL_LIMITS.mission), from: "parent", at: parentMission.at || 0 };
  const trail = groupLookups(rows.sort((a, b) => b.order - a.order).map(({ order, ...row }) => row)).slice(0, DETAIL_LIMITS.trail);
  const current = changes.filter((change) => change.last);
  return { mission, plan, now, said: said || saidAnyTurn, trail, files: summarizeFiles(current.length ? current : changes, cwd) };
}

/** The spawn prompt a parent chat gave one of its subagents, from the parent's newest turns. */
export function spawnPromptFor(parentThread, childId) {
  let found = null;
  for (const turn of Array.isArray(parentThread?.turns) ? parentThread.turns : []) {
    for (const item of Array.isArray(turn?.items) ? turn.items : []) {
      if (item?.type !== "collabAgentToolCall" || !item.prompt) continue;
      if ((Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []).includes(childId)) found = { text: String(item.prompt), at: toMs(turn.startedAt) };
    }
  }
  return found;
}

/** The newest `update_plan` call in a session file's text, as plan steps; null when there is none. */
export function parseRolloutPlan(text) {
  let plan = null;
  for (const line of String(text).split("\n")) {
    if (!line.includes("update_plan")) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const payload = record?.payload;
    if (payload?.type !== "function_call" || payload.name !== "update_plan") continue;
    let args;
    try { args = typeof payload.arguments === "string" ? JSON.parse(payload.arguments) : payload.arguments; } catch { continue; }
    const steps = (Array.isArray(args?.plan) ? args.plan : []).filter((step) => step && typeof step === "object").slice(0, 50)
      .map((step) => ({ text: clean(step.step ?? step.text ?? "", 300), status: stepStatus(step.status) })).filter((step) => step.text);
    if (steps.length) plan = { steps, at: toMs(record.timestamp), source: "plan" };
  }
  return plan;
}

/**
 * The newest plan in each chat's session file, read from its end and remembered by size and
 * modification time. A plan further back than the first look is searched for once (up to 4 MB);
 * after that only what the file gained is read.
 */
export class CodexPlanReader {
  constructor({ readTail = readFileTail, stat = (path) => statSync(path), steps = [512 * 1024, 4 * 1024 * 1024], limit = 64 } = {}) {
    Object.assign(this, { readTail, stat, steps, limit });
    this.cache = new Map();
  }

  read(file) {
    if (typeof file !== "string" || !/\.jsonl$/i.test(file)) return null;
    const path = file.replace(/^\\\\\?\\/, "");
    let info;
    try { info = this.stat(path); } catch { return null; }
    const saved = this.cache.get(path);
    if (saved && saved.size === info.size && saved.mtimeMs === info.mtimeMs) return saved.plan;
    let plan = null;
    try {
      if (saved && info.size >= saved.size) {
        plan = parseRolloutPlan(this.readTail(path, Math.max(this.steps[0], info.size - saved.size + 64 * 1024))) || saved.plan;
      } else {
        for (const bytes of this.steps) {
          plan = parseRolloutPlan(this.readTail(path, bytes));
          if (plan || bytes >= info.size) break;
        }
      }
    } catch { return saved?.plan || null; }
    this.cache.set(path, { size: info.size, mtimeMs: info.mtimeMs, plan });
    if (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value);
    return plan;
  }
}
