/**
 * The last filter before activity leaves the server, for the widget, the browser, and a phone.
 *
 * Sources hand over what they saw: a Codex command line and up to 5,000 characters of its output,
 * an MCP tool's arguments, an Orca agent's tool input, a pending request's parameters. Every text
 * field is run through redactSecrets here, whatever the source. This computer gets all of it,
 * filtered.
 *
 * A paired phone (any request not from this computer) gets summaries:
 * - names, models, statuses, times, counts, step titles and descriptions, and filtered Codex
 *   command lines; never command output or a tool's arguments or input;
 * - the agents' messages, except that every line asking the person a question (and the options
 *   listed under it) reads "(Asked you a question: see it on this computer.)", and an extension's
 *   "needs you" text is replaced whole;
 * - of `ask`, `now`, `progress`, and `waitingOn`, only kinds, counts, and times; each of
 *   `turnStates[].questions` reads "Asked you a question" (the count is kept);
 * - of a pending Codex request, its kind, ids, and time, and for an approval the filtered command
 *   or folder it would allow, so an approval is never blind; never its reason, and never the words
 *   or options of Codex's questions, which are answered on this computer.
 */
import { redactSecrets } from "./claude.mjs";

// Fields that carry words an agent or a tool wrote. Ids, paths, states, and times are left as they
// are: the filter's long-token rule would otherwise mangle a long workspace id.
const TEXT_KEYS = new Set(["name", "nickname", "title", "description", "detail", "output", "message", "question", "questions",
  "error", "text", "preview", "reason", "warning", "label", "header", "command", "options", "current"]);
// What a phone reads for `now`: the kind of step, never its command, pattern, or file.
const PHONE_NOW = { command: "Running a command", edit: "Editing a file", write: "Writing a file", read: "Reading a file",
  search: "Searching the files", web: "Using the web", agent: "Working with a subagent", tool: "Using a tool", think: "Thinking",
  ask: "Asking you a question" };

/** An ask, plan, current step, and wait as a phone may see them: kinds, counts, and times only. */
function phoneSummaries(actor) {
  const result = {};
  if (actor.ask && typeof actor.ask === "object") {
    const { text, command, questions, options, ...ask } = actor.ask;
    if (Array.isArray(questions)) ask.questionCount = questions.length;
    if (Array.isArray(options)) ask.optionCount = options.length;
    result.ask = ask;
  }
  if (actor.now && typeof actor.now === "object") {
    const { detail, title, ...now } = actor.now;
    result.now = { ...now, title: PHONE_NOW[now.kind] || "Working" };
  }
  if (actor.progress && typeof actor.progress === "object") {
    const { current, ...progress } = actor.progress;
    result.progress = progress;
  }
  if (actor.waitingOn && typeof actor.waitingOn === "object") {
    const { text, ...waitingOn } = actor.waitingOn;
    result.waitingOn = waitingOn;
  }
  return result;
}
// In a request's parameters everything is text except these.
const REQUEST_ID_KEYS = new Set(["threadId", "turnId", "itemId", "requestId", "id", "callId", "approvalId"]);
const APPROVALS = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]);

// What a phone reads in place of a question's words.
export const PHONE_QUESTION = "Asked you a question";
const PHONE_QUESTION_LINE = "(Asked you a question: see it on this computer.)";
// A list item or numbered option under a question: "- Compact", "2. Spacious".
const OPTION_LINE = /^\s*(?:[-*•+]|\d{1,2}[.)])\s+\S/;
// A line that asks: it ends in "?" (perhaps inside quotes or bold), or a question leads into its options ("Which one? Options:").
const ASKING_LINE = /\?["'”’)\]]*$|\?["'”’)\]]*\s+\S.*:$/;

/**
 * An agent's message with the questions it asks the person left out, for a phone: each line that
 * asks, and the options listed under it, becomes one "(Asked you a question: ...)" line. Everything
 * else the agent said stays. Every line that ends in a question goes, rhetorical or not: the sources
 * call a reply's last question line (or one over a list) an ask, and a phone should not get it.
 */
export function withoutQuestions(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const kept = [];
  let options = false;
  let removed = false;
  for (const line of lines) {
    if (options && OPTION_LINE.test(line)) continue;
    if (options && !line.trim()) { kept.push(line); continue; }
    options = false;
    if (ASKING_LINE.test(line.replace(/\*\*|__/g, "").trim())) {
      removed = true;
      options = true;
      if (kept.filter((item) => item.trim()).at(-1) !== PHONE_QUESTION_LINE) kept.push(PHONE_QUESTION_LINE);
      continue;
    }
    kept.push(line);
  }
  return removed ? kept.join("\n").replace(/\n{3,}/g, "\n\n").trim() : String(text ?? "");
}

function walk(value, redactHere, keep) {
  if (typeof value === "string") return redactHere ? redactSecrets(value) : value;
  if (Array.isArray(value)) return value.map((item) => walk(item, redactHere, keep));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) result[key] = walk(item, keep(key, redactHere), keep);
  return result;
}

/**
 * An activity a phone may see: no output, a tool's arguments or input left out, and in a message
 * the questions it asks the person; an extension's "needs you" step is its question, so it goes whole.
 */
function forPhone(activity) {
  if (!activity || typeof activity !== "object" || Array.isArray(activity)) return activity;
  const { output, ...rest } = activity;
  if (rest.kind === "tool" && rest.detail) rest.detail = "";
  if (rest.kind === "update" && typeof rest.description === "string") {
    rest.description = rest.title === "Needs you" ? `${PHONE_QUESTION}.` : withoutQuestions(rest.description);
  }
  return rest;
}

/** A turn as a phone sees it: each question it asked counts, but reads only "Asked you a question". */
function phoneTurn(turn) {
  if (!turn || typeof turn !== "object" || !Array.isArray(turn.questions)) return turn;
  return { ...turn, questions: turn.questions.map(() => PHONE_QUESTION) };
}

function stripActor(actor) {
  if (!actor || typeof actor !== "object") return actor;
  return { ...actor, ...(Array.isArray(actor.activities) ? { activities: actor.activities.map(forPhone) } : {}),
    ...(actor.latest ? { latest: forPhone(actor.latest) } : {}),
    ...(Array.isArray(actor.turnStates) ? { turnStates: actor.turnStates.map(phoneTurn) } : {}), ...phoneSummaries(actor) };
}

/** A scene, thread, or list as it may leave the server: filtered, and trimmed further for a phone. */
export function publicView(data, { phone = false } = {}) {
  let view = data;
  if (phone && view && typeof view === "object") {
    view = { ...view };
    if (view.root) view.root = stripActor(view.root);
    if (view.thread) view.thread = stripActor(view.thread);
    if (view.agent) view.agent = stripActor(view.agent);
    if (Array.isArray(view.agents)) view.agents = view.agents.map(stripActor);
    if (Array.isArray(view.activities) || "ask" in view || "now" in view || Array.isArray(view.turnStates)) view = stripActor(view);
  }
  if (view && typeof view === "object" && Array.isArray(view.requests)) view = { ...view, requests: publicRequests(view.requests, { phone }) };
  return walk(view, false, (key, inherited) => inherited || TEXT_KEYS.has(key));
}

/**
 * A pending Codex request as a phone may see it (`summaryOnly`): its kind, ids, and time; for an
 * approval, the command or folder it would allow (filtered below), never Codex's reason; for
 * questions, how many there are, never their words or options.
 */
function phoneRequest(request) {
  const params = request?.params && typeof request.params === "object" ? request.params : {};
  const kept = {};
  for (const key of REQUEST_ID_KEYS) if (key in params) kept[key] = params[key];
  if (APPROVALS.has(request?.method)) {
    if (params.command != null) kept.command = params.command;
    if (typeof params.grantRoot === "string") kept.grantRoot = params.grantRoot;
    const host = params.networkApprovalContext?.host;
    if (typeof host === "string") kept.networkApprovalContext = { host };
  }
  if (Array.isArray(params.questions)) kept.questionCount = params.questions.length;
  return { id: request?.id, method: request?.method, ...(request?.receivedAt ? { receivedAt: request.receivedAt } : {}), params: kept, summaryOnly: true };
}

/** Pending Codex requests (approvals, questions): every parameter but the ids is filtered; a phone gets summaries. */
export function publicRequests(requests, { phone = false } = {}) {
  return (Array.isArray(requests) ? requests : []).map((request) => {
    const shown = phone ? phoneRequest(request) : request;
    return { ...shown, params: walk(shown?.params || {}, true, (key, inherited) => inherited && !REQUEST_ID_KEYS.has(key)) };
  });
}
