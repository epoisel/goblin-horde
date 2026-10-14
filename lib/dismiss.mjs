/**
 * Dismissed asks, and the one place every scene's asks are settled before they leave the server.
 *
 * The person can dismiss an alert they have dealt with elsewhere (answered in the agent's own app,
 * decided to ignore). A dismissal names the actor and the ask's key, so the same ask stays quiet across
 * polls and restarts while a new ask from the same agent (a different key) alerts again. Dismissals are
 * kept in `<state>/dismissed.json`, a week at most and 500 at most; a folder that cannot be written
 * keeps them for this run only.
 *
 * `settleView` applies them to whatever a route is about to send (the all-parties scene, a party, one
 * chat), for every source alike, and holds every actor to one rule: attention is "needs" exactly when it
 * has an ask that was not dismissed. It runs on each response, so the cached all-parties scene shows a
 * dismissal on the very next poll.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyClaude } from "./claude.mjs";
import { classifyCodex, classifyOrca } from "./feed.mjs";
import { askKey } from "./asks.mjs";

export const DISMISS_LIMITS = Object.freeze({ items: 500, keepMs: 7 * 24 * 60 * 60_000 });
// Codex chats, Claude and Orca goblins, and extension members: ids the scene hands out.
const ACTOR_ID = /^(?:[A-Za-z0-9_-]{8,100}|(?:claude-agent|orca-agent|ext-agent):[A-Za-z0-9_.:-]{1,300})$/;
const KEY = /^[a-f0-9]{8,64}$/;

export const isActorId = (value) => typeof value === "string" && ACTOR_ID.test(value);
export const isAskKey = (value) => typeof value === "string" && KEY.test(value);

export class DismissStore {
  constructor({ dir, clock = Date.now, limits = DISMISS_LIMITS } = {}) {
    this.dir = dir;
    this.file = join(dir, "dismissed.json");
    this.clock = clock;
    this.limits = limits;
    this.items = new Map(); // `${id}\n${key}` -> { id, key, at }
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      for (const item of Array.isArray(saved?.items) ? saved.items : []) {
        if (isActorId(item?.id) && isAskKey(item?.key) && Number.isFinite(item?.at)) this.items.set(`${item.id}\n${item.key}`, { id: item.id, key: item.key, at: item.at });
      }
    } catch { /* Nothing dismissed yet, or an unreadable file: start empty. */ }
    this.prune();
  }

  /** Dismiss one ask; returns { id, key, at }, or throws a 400 for an id or key that is not one of ours. */
  dismiss(id, key) {
    if (!isActorId(id) || !isAskKey(key)) throw Object.assign(new Error("Choose an alert to dismiss."), { statusCode: 400 });
    const item = { id, key, at: this.clock() };
    this.items.delete(`${id}\n${key}`);
    this.items.set(`${id}\n${key}`, item);
    this.prune();
    // A dismissal that cannot be saved (a locked or read-only folder) still holds for this run.
    try { this.save(); } catch { /* Kept in memory. */ }
    return item;
  }

  /** The dismissal of this exact ask, or null. */
  isDismissed(id, key) {
    const item = this.items.get(`${id}\n${key}`);
    return item && this.clock() - item.at <= this.limits.keepMs ? item : null;
  }

  prune() {
    const now = this.clock();
    for (const [name, item] of this.items) if (now - item.at > this.limits.keepMs) this.items.delete(name);
    // Oldest first: insertion order is dismissal order.
    while (this.items.size > this.limits.items) this.items.delete(this.items.keys().next().value);
  }

  save() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ items: [...this.items.values()] })}\n`, { mode: 0o600 });
      renameSync(temporary, this.file);
    } finally { rmSync(temporary, { force: true }); }
  }
}

const withoutQuestions = (turnStates) => (Array.isArray(turnStates) && turnStates.length
  ? [...turnStates.slice(0, -1), { ...turnStates.at(-1), questions: [] }] : turnStates);

/** The feed class an actor would have with no ask: failed, working, waiting (Orca), or quiet. */
export function attentionWithoutAsk(actor, { now = Date.now() } = {}) {
  const plain = { ...actor, needsInput: false, awaitingApproval: false, turnStates: withoutQuestions(actor.turnStates) };
  const attention = actor.source === "codex" ? classifyCodex(plain, { hasRequest: false, now })
    : actor.source === "orca" ? classifyOrca(plain, { now })
      : classifyClaude(plain, { now });
  return attention === "needs" ? "quiet" : attention;
}

/**
 * One actor with its ask settled: a dismissed ask becomes `ask: null` with `dismissedAsk: { key, at }`,
 * and the actor stops saying it needs the person (needsInput, a "waiting" status, and the last turn's
 * question go too, so older views agree). Attention, where the actor has one, is "needs" exactly when an
 * undismissed ask remains. An ask without a key gets one.
 */
export function settleActor(actor, { isDismissed = () => null, now = Date.now() } = {}) {
  if (!actor || typeof actor !== "object") return actor;
  let ask = actor.ask && typeof actor.ask === "object" ? actor.ask : null;
  if (ask && !isAskKey(ask.key)) ask = { ...ask, key: askKey(actor.id, ask) };
  const dismissed = ask ? isDismissed(actor.id, ask.key) : null;
  const hasAttention = "attention" in actor;
  if (dismissed) {
    const quiet = { ...actor, ask: null, dismissedAsk: { key: ask.key, at: dismissed.at }, needsInput: false, turnStates: withoutQuestions(actor.turnStates) };
    if (quiet.awaitingApproval) quiet.awaitingApproval = false;
    // Claude and extension members say "waiting" only while they wait on the person.
    if (quiet.status === "waiting" && actor.source !== "orca" && actor.source !== "codex") {
      const last = String(quiet.turnStates?.at(-1)?.status || "");
      quiet.status = last === "inProgress" ? "active" : last === "failed" ? "failed" : "completed";
    }
    if (hasAttention) quiet.attention = attentionWithoutAsk(actor, { now });
    return quiet;
  }
  if (ask) return { ...actor, ask, ...(hasAttention ? { attention: "needs" } : {}) };
  if (hasAttention && actor.attention === "needs") return { ...actor, attention: attentionWithoutAsk(actor, { now }) };
  return actor;
}

/** A scene, party, or chat response with every actor's ask settled (see settleActor). */
export function settleView(view, options = {}) {
  if (!view || typeof view !== "object") return view;
  const result = { ...view };
  if (Array.isArray(view.agents)) result.agents = view.agents.map((actor) => settleActor(actor, options));
  for (const key of ["root", "thread", "agent"]) if (view[key] && typeof view[key] === "object" && "ask" in view[key]) result[key] = settleActor(view[key], options);
  return result;
}
