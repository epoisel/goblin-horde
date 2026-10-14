import { describeModel } from "./models.mjs";
import { closingQuestion, firstLine, makeAsk, makeNow } from "./asks.mjs";

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

function replyQuestions(item) {
  const lines = messageText(item).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.flatMap((line, index) => {
    if (!line.endsWith("?")) return [];
    const next = lines[index + 1] || "";
    return index === lines.length - 1 || /^[-*]\s/.test(next) ? [clip(line, 180)] : [];
  });
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
    return { ...base, kind: "update", title: item.phase === "final_answer" ? "Answer" : "Update", description: text, detail: "", status: "completed" };
  }

  if (item.type === "commandExecution") {
    return {
      ...base,
      kind: "command",
      title: commandLabel(item),
      description: commandDescription(item),
      detail: String(item.command ?? ""),
      output: clip(item.aggregatedOutput, 5000),
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
      detail: clip(JSON.stringify(item.arguments || item.input || {}, null, 2), 5000),
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
    const questions = subagent ? [] : (turn.items || []).filter((item) => item.type === "agentMessage")
      .flatMap((item) => Array.isArray(item.questions)
        ? item.questions.map((question) => question.title).filter(Boolean)
        : item.phase === "final_answer" ? replyQuestions(item) : []);
    // `open`: the turn has no completion time yet. Another Codex process may still be running it.
    return { id: turn.id, status: turn.status, questions, error: turn.error?.message || "", open: turn.completedAt == null };
  });
  const updatedAt = Math.max(toMilliseconds(thread.updatedAt) || 0, toMilliseconds(thread.recencyAt) || 0) || null;
  // A finished answer that ends in a question: the question itself, with a sentence of context, answered by a reply.
  const lastTurn = turns.at(-1);
  const asked = turnStates.at(-1)?.questions || [];
  const ask = asked.length ? makeAsk(thread.id, { kind: "reply", text: closingQuestion(finalAnswer(lastTurn)) || asked.at(-1),
    at: toMilliseconds(lastTurn?.completedAt) || updatedAt || 0, answerHere: "reply" }) : null;
  return {
    id: thread.id,
    source: "codex",
    name: thread.name || thread.preview || "Untitled chat",
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

/**
 * What the chat is doing right now: the newest step still running in its open turn ("Running npm
 * test", "Editing app.js", "Searching the web", "Using create issue"), else "Thinking" while the turn is
 * open, else nothing. Codex items carry no start time, so a step counts from the chat's last update;
 * `carryNowStart` keeps the first time a step was seen across polls.
 */
export function withCodexNow(actor) {
  const last = actor?.turnStates?.at(-1);
  if (!actor || String(last?.status || "").toLowerCase() !== "inprogress") return actor ? { ...actor, now: null } : actor;
  const steps = (actor.activities || []).filter((item) => item.turnId === last.id);
  const running = [...steps].reverse().find((item) => item.status === "inProgress" && item.kind !== "update");
  const startedAt = Number(actor.updatedAt) || Number(steps.at(-1)?.turnStartedAt) || 0;
  let now;
  if (running?.kind === "command") now = makeNow({ kind: "command", title: `Running ${firstLine(running.detail) || "a command"}`, detail: running.detail, startedAt });
  else if (running?.kind === "file") now = makeNow({ kind: "edit", title: String(running.title).replace(/^Changed\b/, "Editing"), detail: running.description, startedAt });
  else if (running?.kind === "research") now = makeNow({ kind: "web", title: "Searching the web", detail: running.description, startedAt });
  else if (running) now = makeNow({ kind: "tool", title: `Using ${running.title}`, detail: running.detail, startedAt });
  else now = makeNow({ kind: "think", title: "Thinking", startedAt: Number(steps.at(-1)?.turnStartedAt) || startedAt });
  return { ...actor, now };
}

/** Keep when a still-running step was first seen, so its timer does not restart on every read. */
export function carryNowStart(previous, next) {
  if (!previous?.now || !next?.now) return next;
  const [a, b] = [previous.now, next.now];
  if (a.kind !== b.kind || a.title !== b.title || (a.detail || "") !== (b.detail || "")) return next;
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
  return makeAsk(actor.id, { kind: "approval", text: "Codex is waiting for your answer.", at, answerHere: null, requestId: request?.id });
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
