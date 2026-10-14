import { describeModel } from "./models.mjs";
import { closingQuestion, makeAsk, makeNow } from "./asks.mjs";
import { DETAIL_LIMITS, clean, oneLine, unwrapCommand } from "./detail-text.mjs";

// What a scene keeps of a Codex chat's own words. Each is credential-filtered over twice its room and
// then clipped (see clean), so a huge answer or command line is never filtered whole on every poll.
export const SCENE_TEXT = Object.freeze({ name: 300, message: DETAIL_LIMITS.said, command: DETAIL_LIMITS.detail, output: 5000, arguments: 5000 });

const humanize = (value = "") => String(value)
  .replace(/([a-z])([A-Z])/g, "$1 $2")
  .replace(/[_/.-]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const clip = (value, max = 240) => {
  const text = String(value ?? "").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

export function toMilliseconds(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (Number.isFinite(number)) return number < 1e12 ? number * 1000 : number;
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : null;
}

function fileName(path) {
  return String(path ?? "").split(/[\\/]/).filter(Boolean).at(-1) || "file";
}

function commandLabel(item) {
  const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
  if (actions.length === 1) {
    const action = actions[0];
    const target = fileName(action.path || action.name);
    if (action.type === "read") return `Read ${target}`;
    if (action.type === "write" || action.type === "edit") return `Changed ${target}`;
    if (action.type === "search") return `Searched ${target}`;
  }
  if (actions.length > 1) return `Ran ${actions.length} local actions`;
  const command = String(item.command ?? "");
  if (/\b(?:npm|pnpm|yarn)\s+(?:test|run test)\b/i.test(command)) return "Ran project tests";
  if (/\b(?:git status|git diff)\b/i.test(command)) return "Checked Git changes";
  if (/\b(?:rg|ripgrep)\b/i.test(command)) return "Searched local files";
  if (/\b(?:Get-Content|cat|type)\b/i.test(command)) return "Read a local file";
  return "Ran a local command";
}

function commandDescription(item) {
  const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
  const informative = actions.filter((action) => action.path || action.name);
  if (informative.length) {
    return clip(informative.map((action) => {
      const target = fileName(action.path || action.name);
      if (action.type === "read") return `Opened ${target} to inspect its contents.`;
      if (action.type === "write" || action.type === "edit") return `Updated ${target}.`;
      if (action.type === "search") return `Looked for matches in ${target}.`;
      return `${humanize(action.type)} ${target}.`;
    }).join(" "), 300);
  }
  const command = String(item.command ?? "");
  if (/\b(?:npm|pnpm|yarn)\s+(?:test|run test)\b/i.test(command)) return "Checked the project with its test suite.";
  if (/\bnode\s+--check\b/i.test(command)) return "Checked the JavaScript files for syntax errors.";
  if (/\b(?:git status|git diff)\b/i.test(command)) return "Reviewed local Git changes.";
  if (/\b(?:rg|ripgrep)\b/i.test(command)) return "Looked for matching files or text.";
  if (/\b(?:Invoke-RestMethod|Invoke-WebRequest|curl)\b/i.test(command)) return "Checked the local service response.";
  if (/\bcodex app-server\b/i.test(command)) return "Checked the Codex activity connection.";
  if (/\bGet-ChildItem\b/i.test(command)) return "Listed local files and folders.";
  if (/\b(?:Get-Content|cat|type)\b/i.test(command)) return "Opened a local file for inspection.";
  return "Ran a command in the local workspace.";
}

function messageText(item) {
  if (typeof item.text === "string") return item.text;
  if (!Array.isArray(item.content)) return "";
  return item.content.map((part) => part.text || "").filter(Boolean).join("\n");
}

export function transformItem(item, turn, index) {
  if (!item || item.type === "reasoning" || item.type === "userMessage") return null;

  const base = {
    id: item.id || `${turn.id}-${index}`,
    turnId: turn.id,
    turnStartedAt: toMilliseconds(turn.startedAt),
    order: index,
    status: item.status || (turn.status === "inProgress" ? "inProgress" : "completed"),
  };

  if (item.type === "agentMessage") {
    if (item.phase !== "commentary" && item.phase !== "final_answer") return null;
    const text = messageText(item).trim()
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1 ($2)")
      .replace(/\*\*/g, "");
    if (!text) return null;
    return { ...base, kind: "update", title: item.phase === "final_answer" ? "Answer" : "Update", description: clean(text, SCENE_TEXT.message), detail: "", status: "completed" };
  }

  if (item.type === "commandExecution") {
    return {
      ...base,
      kind: "command",
      title: commandLabel(item),
      description: commandDescription(item),
      detail: clean(item.command, SCENE_TEXT.command),
      output: clean(item.aggregatedOutput, SCENE_TEXT.output),
      exitCode: item.exitCode ?? null,
      durationMs: item.durationMs ?? null,
    };
  }

  if (item.type === "webSearch") {
    const action = item.action && typeof item.action === "object" ? item.action : {};
    const query = typeof item.query === "string" ? item.query : "";
    const description = query || (Array.isArray(action.queries) ? action.queries.join(" · ") : "") || action.url || action.refId || "Looked up information online";
    return {
      ...base,
      kind: "research",
      title: action.type === "open" ? "Opened a source" : "Searched the web",
      description: clip(description, 300),
      detail: "",
      resultCount: Array.isArray(item.results) ? item.results.length : null,
    };
  }

  if (item.type === "fileChange") {
    const changes = Array.isArray(item.changes)
      ? item.changes.map((change) => change.path || change.name).filter(Boolean)
      : item.changes && typeof item.changes === "object" ? Object.keys(item.changes) : [];
    return { ...base, kind: "file", title: changes.length === 1 ? `Changed ${fileName(changes[0])}` : `Changed ${changes.length} files`, description: clip(changes.map(fileName).join(" · "), 300), detail: "" };
  }

  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    const name = item.tool || item.name || item.server || "tool";
    const browserCheck = item.server === "cua_repl";
    const previewOpen = item.server === "codex_app" && name === "open_in_codex";
    return {
      ...base,
      kind: "tool",
      title: browserCheck ? "Checked the interface" : previewOpen ? "Opened the preview" : humanize(name),
      description: browserCheck ? "Inspected the local page to check its layout and behavior." : previewOpen ? "Showed the local viewer in Codex." : clip(item.server ? `Used ${humanize(item.server)}.` : "Used an app or connected tool.", 300),
      detail: clean(JSON.stringify(item.arguments || item.input || {}, null, 2), SCENE_TEXT.arguments),
    };
  }

  return {
    ...base,
    kind: "tool",
    title: humanize(item.type) || "Activity",
    description: "Codex activity",
    detail: "",
  };
}

// A turn running in another Codex process (the app, the CLI) has not finished, so this reader sees it
// as "interrupted" with no completion time. While the chat stays active it is that turn, still working.
export const RUNNING_ELSEWHERE_MS = 10 * 60_000;

/** Call a still-open "interrupted" newest turn working while its chat was active in the last few minutes. */
export function markRunningElsewhere(actor, { now = Date.now(), windowMs = RUNNING_ELSEWHERE_MS } = {}) {
  const last = actor?.turnStates?.at(-1);
  if (!last || last.status !== "interrupted" || !last.open || !(now - Number(actor.updatedAt) <= windowMs)) return actor;
  return {
    ...actor,
    runningElsewhere: true,
    turnStates: [...actor.turnStates.slice(0, -1), { ...last, status: "inProgress" }],
  };
}

/**
 * A chat that looks to be waiting for an approval in the Codex app: it needs the person, and says so.
 * `call` ({ command, tool, at }) is the open call read from the chat's own session file, when known.
 * The approval itself happens in the Codex app, so the ask cannot be answered here.
 */
export function markAwaitingApproval(actor, call = null) {
  const note = { id: `${actor.id}:approval`, kind: "update", title: "Waiting for approval?", status: "completed", detail: "",
    description: "This chat looks to be waiting for you to approve a step in the Codex app. A long-running command can look the same." };
  const ask = makeAsk(actor.id, { kind: "approval", text: "Codex may be waiting for your approval.", command: call?.command, tool: call?.tool,
    at: Number(call?.at) || Number(actor.updatedAt) || 0 });
  return { ...actor, awaitingApproval: true, needsInput: true, ask, activities: [...actor.activities, note], latest: note };
}

/**
 * Whether a Codex thread is a subagent another thread spawned (it has a parent, a spawned agent's
 * nickname or role, or a sub-agent source). Its final answer goes to that parent, never to the person.
 */
export function isCodexSubagent(thread) {
  if (thread?.parentThreadId || thread?.agentNickname || thread?.agentRole) return true;
  const source = thread?.source;
  if (source && typeof source === "object") return Boolean(source.subAgent || source.subagent || source.sub_agent);
  return /^sub_?agent/i.test(String(source || ""));
}

/** The final answer of a turn, as text. */
function finalAnswer(turn) {
  const item = [...(turn?.items || [])].reverse().find((entry) => entry?.type === "agentMessage" && entry.phase === "final_answer");
  return item ? messageText(item) : "";
}

export function transformThread(thread) {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const activities = turns.flatMap((turn) => (turn.items || []).map((item, index) => transformItem(item, turn, index)).filter(Boolean));
  const latest = activities.at(-1) || null;
  // A subagent reports to the thread that spawned it; nothing it says is a question for the person.
  const subagent = isCodexSubagent(thread);
  const turnStates = turns.map((turn) => {
    // The same rule as Claude Code's: a turn asks only when its final answer ends in a question (a
    // heading or a list item mid-answer is not one). The question keeps a sentence of context.
    const question = subagent ? "" : closingQuestion(finalAnswer(turn));
    // `open`: the turn has no completion time yet. Another Codex process may still be running it.
    return { id: turn.id, status: turn.status, questions: question ? [question] : [], error: turn.error?.message || "", open: turn.completedAt == null };
  });
  const updatedAt = Math.max(toMilliseconds(thread.updatedAt) || 0, toMilliseconds(thread.recencyAt) || 0) || null;
  // A finished answer that ends in a question asks the person, answered by a reply.
  const lastTurn = turns.at(-1);
  const asked = turnStates.at(-1)?.questions || [];
  const ask = asked.length ? makeAsk(thread.id, { kind: "reply", text: asked[0],
    at: toMilliseconds(lastTurn?.completedAt) || updatedAt || 0, answerHere: "reply" }) : null;
  return {
    id: thread.id,
    source: "codex",
    name: clean(thread.name || thread.preview, SCENE_TEXT.name) || "Untitled chat",
    nickname: thread.agentNickname || "",
    role: thread.agentRole || "",
    parentThreadId: thread.parentThreadId || "",
    cwd: thread.cwd || "",
    model: describeModel(thread.model, { provider: thread.modelProvider, effort: thread.reasoningEffort }),
    status: thread.status?.type || "unknown",
    // recencyAt moves when a turn starts, even when updatedAt has not caught up yet.
    updatedAt,
    turns: turns.length,
    turnStates,
    activities,
    latest,
    counts: {
      updates: activities.filter((a) => a.kind === "update").length,
      commands: activities.filter((a) => a.kind === "command").length,
      research: activities.filter((a) => a.kind === "research").length,
      tools: activities.filter((a) => a.kind === "tool" || a.kind === "file").length,
    },
    ...(subagent ? { subagent: true } : {}),
    ask,
  };
}

/** A finished step of an open turn as a `now` line in the past tense: "Ran npm test", "Edited csv.js". */
function finishedNow(step, startedAt) {
  const exit = Number.isFinite(step.exitCode) && step.exitCode !== 0 ? ` · exit ${step.exitCode}` : step.status === "failed" ? " · failed" : "";
  const done = (kind, title, detail = "") => makeNow({ kind, title: `${title}${exit}`, detail, startedAt, done: true });
  if (step.kind === "command") return done("command", `Ran ${oneLine(unwrapCommand(step.detail), 60) || "a command"}`, step.detail);
  if (step.kind === "file") return done("edit", String(step.title).replace(/^Changed\b/, "Edited"), step.description);
  if (step.kind === "research") return done("web", step.title, step.description);
  if (step.kind === "update") return makeNow({ kind: "message", title: `Said: ${oneLine(step.description, 60)}`, detail: step.description, startedAt, done: true });
  return done("tool", `Used ${step.title}`, step.detail);
}

/**
 * What the chat is doing right now: the newest step still running in its open turn ("Running npm
 * test", "Editing app.js", "Searching the web", "Using create issue"), else the newest step that
 * finished ("Ran npm test", "Said: …", with `done`), else "Thinking" while the turn is open, else
 * nothing. Codex items carry no time of their own, so a step counts from the chat's last update when it
 * was first seen (`carryNowStart` keeps that time across polls), and Thinking from the turn's start.
 * A chat running in another Codex process lists no step as running; the `now` its session file gave
 * (withApprovalGuess, with the records' own times) is kept.
 */
export function withCodexNow(actor) {
  const last = actor?.turnStates?.at(-1);
  if (!actor || String(last?.status || "").toLowerCase() !== "inprogress") return actor ? { ...actor, now: null } : actor;
  if (actor.runningElsewhere && actor.now) return actor;
  const steps = (actor.activities || []).filter((item) => item.turnId === last.id);
  const running = [...steps].reverse().find((item) => item.status === "inProgress" && item.kind !== "update");
  const startedAt = Number(actor.updatedAt) || Number(steps.at(-1)?.turnStartedAt) || 0;
  let now;
  if (running?.kind === "command") now = makeNow({ kind: "command", title: `Running ${oneLine(running.detail, 60) || "a command"}`, detail: running.detail, startedAt });
  else if (running?.kind === "file") now = makeNow({ kind: "edit", title: String(running.title).replace(/^Changed\b/, "Editing"), detail: running.description, startedAt });
  else if (running?.kind === "research") now = makeNow({ kind: "web", title: "Searching the web", detail: running.description, startedAt });
  else if (running) now = makeNow({ kind: "tool", title: `Using ${running.title}`, detail: running.detail, startedAt });
  else if (steps.length) now = finishedNow(steps.at(-1), startedAt);
  else now = makeNow({ kind: "think", title: "Thinking", startedAt: Number(last.startedAt) || startedAt });
  return { ...actor, now };
}

/**
 * Keep when a step was first seen, so its timer does not restart on every read. A chat running in
 * another process takes its times from its session file's own records, so nothing is carried.
 */
export function carryNowStart(previous, next) {
  if (!previous?.now || !next?.now || next.runningElsewhere) return next;
  const [a, b] = [previous.now, next.now];
  if (a.kind !== b.kind || a.title !== b.title || (a.detail || "") !== (b.detail || "") || Boolean(a.done) !== Boolean(b.done)) return next;
  return { ...next, now: { ...b, startedAt: Number(a.startedAt) || b.startedAt } };
}

/**
 * An ask from a pending app-server request, answerable here through /api/respond: command and file
 * change approvals (kind "approval", with the command or files) and requestUserInput (kind "question",
 * with every question and its options). Other requests are named but answered in Codex.
 */
export function requestAsk(actor, request) {
  const params = request?.params || {};
  const at = Number(request?.receivedAt) || 0;
  const reason = typeof params.reason === "string" && params.reason.trim() ? ` ${params.reason.trim()}` : "";
  const base = { at, answerHere: "respond", requestId: request?.id };
  if (request?.method === "item/commandExecution/requestApproval") {
    const command = Array.isArray(params.command) ? params.command.join(" ") : String(params.command ?? "");
    return makeAsk(actor.id, { ...base, kind: "approval", text: `Allow Codex to run this command?${reason}`, command, tool: "command" });
  }
  if (request?.method === "item/fileChange/requestApproval") {
    const step = (actor.activities || []).find((item) => item.id === params.itemId);
    const files = step?.description || "";
    return makeAsk(actor.id, { ...base, kind: "approval", text: `Allow Codex to change ${files ? "these files" : "files"}?${reason}`, command: files, tool: "fileChange" });
  }
  if (request?.method === "item/tool/requestUserInput") {
    const questions = (Array.isArray(params.questions) ? params.questions : [])
      .map((question) => ({ text: question?.question || question?.header || "", options: question?.options }));
    return makeAsk(actor.id, { ...base, kind: "question", text: questions[0]?.text || "Codex is asking you a question.", questions });
  }
  // Anything else (an MCP server's elicitation, a request this version does not know) is answered in
  // Codex, in the request's own words when it has any.
  const said = [params.message, params.prompt, params.question, params.text, params.reason].find((value) => typeof value === "string" && value.trim());
  const server = typeof params.serverName === "string" ? params.serverName : typeof params.server === "string" ? params.server : "";
  return makeAsk(actor.id, { kind: /elicitation/i.test(String(request?.method || "")) ? "question" : "approval",
    text: said ? said.trim() : "Codex is waiting for your answer.", tool: server, at, answerHere: null, requestId: request?.id });
}

/**
 * The one ask a Codex chat shows, most pressing first: a pending app-server request, then an approval
 * the chat's session file suggests, then a finished answer's closing question (for `askWindowMs`, as
 * its needs-you class lasts). A subagent's answer goes to its parent and is never asked.
 */
export function codexAsk(actor, { requests = [], now = Date.now(), askWindowMs = 6 * 60 * 60_000 } = {}) {
  const pending = Array.isArray(requests) ? requests : [];
  if (pending.length) return requestAsk(actor, pending[0]);
  const ask = actor?.ask;
  if (ask?.kind === "approval" && actor.awaitingApproval) return ask;
  if (ask?.kind === "reply" && !actor.subagent && actor.turnStates?.at(-1)?.questions?.length && Number(actor.updatedAt) >= now - askWindowMs) {
    // A chat that says it cannot take a reply here is answered in Codex instead.
    return actor.replyAvailable === false ? { ...ask, answerHere: null } : ask;
  }
  return null;
}
