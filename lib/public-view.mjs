/**
 * The last filter before activity leaves the server, for the widget, the browser, and a phone.
 *
 * Sources hand over what they saw: a Codex command line and up to 5,000 characters of its output,
 * an MCP tool's arguments, an Orca agent's tool input, a pending request's parameters. Every text
 * field is run through redactSecrets here, whatever the source. A paired phone (any request not
 * from this computer) gets less: no command output and no tool arguments, only the titles and
 * descriptions; command lines and request parameters stay, filtered, so an approval is never blind.
 */
import { redactSecrets } from "./claude.mjs";

// Fields that carry words an agent or a tool wrote. Ids, paths, states, and times are left as they
// are: the filter's long-token rule would otherwise mangle a long workspace id.
const TEXT_KEYS = new Set(["name", "nickname", "title", "description", "detail", "output", "message", "question", "questions",
  "error", "text", "preview", "reason", "warning", "label", "header", "command"]);
// In a request's parameters everything is text except these.
const REQUEST_ID_KEYS = new Set(["threadId", "turnId", "itemId", "requestId", "id", "callId", "approvalId"]);

function walk(value, redactHere, keep) {
  if (typeof value === "string") return redactHere ? redactSecrets(value) : value;
  if (Array.isArray(value)) return value.map((item) => walk(item, redactHere, keep));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) result[key] = walk(item, keep(key, redactHere), keep);
  return result;
}

/** An activity a phone may see: no output, and a tool's arguments or input left out. */
function forPhone(activity) {
  if (!activity || typeof activity !== "object" || Array.isArray(activity)) return activity;
  const { output, ...rest } = activity;
  return rest.kind === "tool" && rest.detail ? { ...rest, detail: "" } : rest;
}

function stripActor(actor) {
  if (!actor || typeof actor !== "object") return actor;
  return { ...actor, ...(Array.isArray(actor.activities) ? { activities: actor.activities.map(forPhone) } : {}),
    ...(actor.latest ? { latest: forPhone(actor.latest) } : {}) };
}

/** A scene, thread, or list as it may leave the server: filtered, and trimmed further for a phone. */
export function publicView(data, { phone = false } = {}) {
  let view = data;
  if (phone && view && typeof view === "object") {
    view = { ...view };
    if (view.root) view.root = stripActor(view.root);
    if (view.thread) view.thread = stripActor(view.thread);
    if (Array.isArray(view.agents)) view.agents = view.agents.map(stripActor);
    if (Array.isArray(view.activities)) view = stripActor(view);
  }
  if (view && typeof view === "object" && Array.isArray(view.requests)) view = { ...view, requests: publicRequests(view.requests) };
  return walk(view, false, (key, inherited) => inherited || TEXT_KEYS.has(key));
}

/** Pending Codex requests (approvals, questions): every parameter but the ids is filtered. */
export function publicRequests(requests) {
  return (Array.isArray(requests) ? requests : []).map((request) => ({
    ...request, params: walk(request?.params || {}, true, (key, inherited) => inherited && !REQUEST_ID_KEYS.has(key)),
  }));
}
