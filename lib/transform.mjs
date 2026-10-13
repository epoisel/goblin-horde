import { describeModel } from "./models.mjs";

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

/** A chat that looks to be waiting for an approval in the Codex app: it needs the person, and says so. */
export function markAwaitingApproval(actor) {
  const note = { id: `${actor.id}:approval`, kind: "update", title: "Waiting for approval?", status: "completed", detail: "",
    description: "This chat looks to be waiting for you to approve a step in the Codex app. A long-running command can look the same." };
  return { ...actor, awaitingApproval: true, needsInput: true, activities: [...actor.activities, note], latest: note };
}

export function transformThread(thread) {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const activities = turns.flatMap((turn) => (turn.items || []).map((item, index) => transformItem(item, turn, index)).filter(Boolean));
  const latest = activities.at(-1) || null;
  const turnStates = turns.map((turn) => {
    const questions = (turn.items || []).filter((item) => item.type === "agentMessage")
      .flatMap((item) => Array.isArray(item.questions)
        ? item.questions.map((question) => question.title).filter(Boolean)
        : item.phase === "final_answer" ? replyQuestions(item) : []);
    // `open`: the turn has no completion time yet. Another Codex process may still be running it.
    return { id: turn.id, status: turn.status, questions, error: turn.error?.message || "", open: turn.completedAt == null };
  });
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
    updatedAt: Math.max(toMilliseconds(thread.updatedAt) || 0, toMilliseconds(thread.recencyAt) || 0) || null,
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
  };
}
