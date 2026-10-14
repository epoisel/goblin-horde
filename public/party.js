/**
 * Party grouping, priority, and goblin actions for the browser viewer. No DOM: the same rules as
 * the Windows widget (party_layout.py, goblin_motion.py) so both surfaces rank and animate alike.
 * Everything here reads public activity only; nothing reveals private reasoning.
 */

const SEARCH = /\b(search|research|investigat|inspect|explor|browse|look|find|read|review|check|test|query|open(?:ed)? a source|rg|grep|Get-Content)\w*\b/i;
const SEARCH_LEAD = /^(search|research|investigat|inspect|explor|browse|look|find|read|review|check|test|query|open(?:ed)? a source|rg|grep|Get-Content)\w*\b/i;
const BUILD = /\b(build|implement|creat|edit|writ|patch|chang|fix|refactor|add|modif|design|draw|render|install|assembl|apply_patch)\w*\b/i;
const ACTIVE = new Set(["inprogress", "working", "running", "active"]);
export const BEAT_MS = 360;
export const PULSE_MS = 8 * BEAT_MS;

export function stampMs(value) {
  const stamp = Number(value);
  if (!Number.isFinite(stamp) || stamp <= 0) return 0;
  return stamp < 1e12 ? stamp * 1000 : stamp;
}

const lower = (value) => String(value ?? "").toLowerCase();
const failedStep = (item) => item?.status === "failed" || (item?.exitCode != null && item.exitCode !== 0);
const isPing = (item) => item?.kind === "update" && item?.title === "Status";

/** The newest step a goblin can act out; status pings are not steps. */
export function latestPublicEvent(activities = []) {
  for (let index = activities.length - 1; index >= 0; index--) if (!isPing(activities[index])) return activities[index];
  return activities.at(-1) || {};
}

/** Magnifier to read or search, hammer to write, thought bubble for updates. */
export function eventAction(item = {}) {
  const kind = lower(item.kind);
  const title = String(item.title || "");
  if (kind === "update") return "think";
  if (kind === "file") return "build";
  if (kind === "research") return "search";
  if (SEARCH_LEAD.test(title)) return "search";
  if (BUILD.test(title)) return "build";
  const signal = `${title} ${item.description || ""} ${String(item.detail || "").slice(0, 500)}`;
  if (SEARCH.test(signal)) return "search";
  if (BUILD.test(signal)) return "build";
  return "think";
}

// The feed calls this member quiet: an old question or failure is history, not news.
const settled = (actor = {}) => lower(actor.attention) === "quiet";

export function needsYou(actor = {}) {
  const turns = actor.turnStates || [];
  return Boolean(actor.needsInput) || (!settled(actor) && (lower(actor.status) === "waiting" || Boolean(turns.at(-1)?.questions?.length)));
}

/** idle, search, build, think, waiting, or trouble: an illustration of observable work. */
export function goblinAction(actor = {}, now = Date.now()) {
  const state = lower(actor.status);
  const turns = actor.turnStates || [];
  const activities = actor.activities || [];
  if (needsYou(actor)) return "waiting";
  if (!settled(actor) && (state === "failed" || state === "error" || failedStep(activities.at(-1)))) return "trouble";
  const turnState = turns.length ? lower(turns.at(-1).status) : "";
  const active = turns.length ? ACTIVE.has(turnState) : ACTIVE.has(state) || ACTIVE.has(lower(activities.at(-1)?.status));
  if (!active && lower(actor.attention) !== "working") return "idle";
  const item = latestPublicEvent(activities);
  const action = eventAction(item);
  // A finished step does not keep swinging its prop through a long pause.
  if ((action === "search" || action === "build") && item.status !== "inProgress") {
    const updated = stampMs(actor.updatedAt);
    if (updated && now - updated > 45_000) return "think";
  }
  return action;
}

/** Act out each newly seen public step for two beats-cycles; first sight only records. */
export class ActionPulse {
  constructor(duration = PULSE_MS) { this.duration = duration; this.seen = new Map(); this.pulses = new Map(); }
  observe(actor, now = Date.now()) {
    const key = String(actor?.id || "");
    if (!key) return null;
    const item = latestPublicEvent(actor.activities || []);
    const mark = item && (item.id || `${item.turnId}:${item.order}:${item.title}`);
    if (mark && item.title) {
      const previous = this.seen.get(key);
      if (previous !== undefined && previous !== mark) this.pulses.set(key, [eventAction(item), now + this.duration]);
      this.seen.set(key, mark);
    }
    const pulse = this.pulses.get(key);
    if (pulse && now >= pulse[1]) { this.pulses.delete(key); return null; }
    if (this.seen.size > 512) this.seen.delete(this.seen.keys().next().value);
    return pulse ? pulse[0] : null;
  }
  action(actor, now = Date.now()) {
    const base = goblinAction(actor, now);
    const pulse = this.observe(actor, now);
    return pulse && base !== "waiting" && base !== "trouble" ? pulse : base;
  }
}

export const ACTION_WORDS = {
  search: "INVESTIGATING", build: "BUILDING", think: "THINKING", waiting: "NEEDS YOU", trouble: "FAILED", idle: "RESTING",
};

/** One readable status per member: word, tone (needs|failed|working|done|quiet), and rank. */
export function memberStatus(actor = {}) {
  const turns = actor.turnStates || [];
  const state = lower(actor.status) || lower(turns.at(-1)?.status);
  if (actor.needsInput || state === "waiting") return { word: "WAITING ON YOU", tone: "needs", rank: 1 };
  const quiet = settled(actor); // Never ASKED YOU or FAILED once the feed says that has aged out.
  if (!quiet && turns.at(-1)?.questions?.length) return { word: "ASKED YOU", tone: "needs", rank: 1 };
  if (!quiet && (state === "failed" || state === "error" || failedStep((actor.activities || []).at(-1)))) return { word: "FAILED", tone: "failed", rank: 2 };
  const action = goblinAction(actor);
  if (action === "search" || action === "build" || action === "think") return { word: ACTION_WORDS[action], tone: "working", rank: 4 };
  if (state === "completed" || state === "done") return { word: "DONE", tone: "done", rank: 5 };
  return { word: "RESTING", tone: "quiet", rank: 6 };
}

const FEED_RANKS = { needs: 1, waiting: 1, failed: 2, working: 4 };

/** Launchpad rank from the server's feed classification; local status only when it is missing. */
export function feedRank(actor = {}) {
  const local = memberStatus(actor).rank;
  const attention = lower(actor.attention);
  if (attention in FEED_RANKS) return FEED_RANKS[attention];
  if (attention === "quiet") return Math.max(local, 5);
  return local;
}

/** Members belong to their parent chat or workspace party. */
export function partyScope(actor = {}) {
  return String(actor.parentThreadId || actor.id || "");
}

export function sourceOf(origin = {}, id = "") {
  const source = String(origin.source || "");
  const key = String(id || origin.id || "");
  if (source === "orca" || key.startsWith("orca:")) return "orca";
  if (source === "claude" || key.startsWith("claude:") || key.startsWith("claude-agent:")) return "claude";
  if (source === "extension" || key.startsWith("ext:") || key.startsWith("ext-agent:")) return "extension";
  return "codex";
}

export const SOURCE_LABELS = { codex: "CODEX", claude: "CLAUDE", orca: "ORCA", extension: "FEED" };

/** Who can be answered from here: only Codex chats. Everything else is watch-only. */
export function replyMode(origin = {}, id = "") {
  const source = sourceOf(origin, id);
  return source === "codex" ? "reply" : source;
}

export function projectName(origin = {}) {
  const parts = String(origin.cwd || "").replace(/\\/g, "/").split("/").filter(Boolean);
  const at = parts.indexOf("workspaces");
  if (at >= 0 && at + 1 < parts.length) return parts[at + 1];
  return parts.at(-1) || "";
}

function partyCard(id, origin, members) {
  const base = origin || members[0] || { id };
  const ranks = members.map(feedRank);
  const updated = Math.max(stampMs(base.updatedAt), ...members.map((member) => stampMs(member.updatedAt)));
  const failedMember = members.find((member) => feedRank(member) === 2);
  const failedStepTitle = failedMember && [...(failedMember.activities || [])].reverse().find(failedStep)?.title;
  const questions = members.reduce((sum, member) => sum + (member.turnStates?.at(-1)?.questions?.length || 0), 0);
  return {
    id, name: String(base.name || base.nickname || id), project: projectName(base), source: sourceOf(base, id),
    members, rank: Math.min(9, ...ranks), updated,
    needs: ranks.filter((rank) => rank === 1).length,
    failed: ranks.filter((rank) => rank === 2).length,
    working: ranks.filter((rank) => rank === 4).length,
    questions, failedStep: failedStepTitle || "",
    agentCount: Math.max(members.length, Number(base.agentCount) || 0),
  };
}

/** The pill a party card wears: what is most urgent, in a few plain words. */
export function partySignal(card) {
  if (card.needs) {
    const detail = card.questions ? `${card.questions} QUESTION${card.questions === 1 ? "" : "S"}` : `${card.needs} WAITING`;
    return { tone: "needs", label: `NEEDS YOU · ${detail}` };
  }
  if (card.failed) return { tone: "failed", label: card.failedStep ? `FAILED · ${card.failedStep.toUpperCase()}` : `${card.failed} FAILED` };
  if (card.working) return { tone: "working", label: `${card.working} WORKING` };
  return { tone: "quiet", label: card.agentCount > 1 ? `${card.agentCount} GOBLINS` : "QUIET" };
}

/**
 * Split parties into working-now and recently-used rows; count the rest for search.
 * Working parties keep their previous order so rows do not jump on every poll; a party that
 * needs input or reports a failure rises to the top.
 */
export function launchpadBoard(actors = [], catalog = [], previousOrder = [], now = Date.now(), { recentLimit = 4, recentDays = 7 } = {}) {
  const sources = new Map(catalog.filter((source) => source?.id).map((source) => [String(source.id), source]));
  const grouped = new Map();
  for (const actor of actors) {
    const scope = partyScope(actor);
    if (!scope || scope === "all" || scope === "standby") continue;
    if (!grouped.has(scope)) grouped.set(scope, []);
    grouped.get(scope).push(actor);
  }
  const cards = [...grouped].map(([id, members]) => partyCard(id, sources.get(id), members));
  const order = new Map(previousOrder.map((id, index) => [id, index]));
  const urgent = (card) => card.rank <= 2 ? card.rank : 3;
  const active = cards.filter((card) => card.rank <= 4)
    .sort((a, b) => urgent(a) - urgent(b) || (order.get(a.id) ?? order.size) - (order.get(b.id) ?? order.size) || b.updated - a.updated);
  const shown = new Set(active.map((card) => card.id));
  const observed = new Map(cards.map((card) => [card.id, card]));
  const cutoff = now - recentDays * 86_400_000;
  const pool = [...(catalog.length ? catalog : cards.map((card) => ({ id: card.id, name: card.name, updatedAt: card.updated })))]
    .sort((a, b) => stampMs(b.updatedAt) - stampMs(a.updatedAt));
  const recent = [];
  for (const source of pool) {
    const id = String(source.id || "");
    if (!id || id === "all" || shown.has(id) || stampMs(source.updatedAt) < cutoff) continue;
    recent.push(partyCard(id, sources.get(id) || source, observed.get(id)?.members || []));
    shown.add(id);
    if (recent.length >= recentLimit) break;
  }
  const older = catalog.filter((source) => source.id && source.id !== "all" && !shown.has(String(source.id))).length;
  return { active, recent, older };
}

/** Rows to draw and how many working rows wait behind 'show more'; urgent rows never fold. */
export function foldActive(active, limit = 6) {
  const urgent = active.filter((card) => card.rank <= 2);
  const room = Math.max(0, limit - urgent.length);
  const keep = new Set([...urgent, ...active.filter((card) => card.rank > 2).slice(0, room)]);
  return { shown: active.filter((card) => keep.has(card)), folded: Math.max(0, active.length - keep.size) };
}

/** Streams in priority order; equal ranks keep their previous order so panels do not jump. */
export function streamOrder(actors = [], previousOrder = [], leadId = "") {
  const order = new Map(previousOrder.map((id, index) => [id, index]));
  const urgent = (actor) => Math.min(3, memberStatus(actor).rank);
  return [...actors].sort((a, b) => urgent(a) - urgent(b)
    || (order.get(a.id) ?? order.size) - (order.get(b.id) ?? order.size)
    || (b.id === leadId) - (a.id === leadId)
    || stampMs(b.updatedAt) - stampMs(a.updatedAt));
}

/** Dialogue is what the agent said; the field log is what it visibly did. */
export function splitStream(activities = []) {
  const dialogue = [];
  const log = [];
  for (const item of activities) {
    if (item.kind === "update") { if (!isPing(item) && String(item.description || "").trim()) dialogue.push(item); }
    else log.push(item);
  }
  return { dialogue, log };
}

export function fieldGlyph(item = {}) {
  if (item.status === "inProgress") return "running";
  if (failedStep(item)) return "failed";
  if (item.kind === "file") return "edit";
  if (item.kind === "research") return "search";
  if (item.kind === "command") return eventAction(item) === "search" ? "read" : "run";
  return "tool";
}

export function ageLabel(updated, now = Date.now()) {
  if (!updated) return "";
  const minutes = Math.max(0, Math.floor((now - updated) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 48 * 60) return minutes < 24 * 60 ? `${Math.floor(minutes / 60)}h ago` : "yesterday";
  if (minutes < 14 * 24 * 60) return `${Math.floor(minutes / 1440)} days ago`;
  return new Date(updated).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Every word must match title, project, path, or source; title matches come first. */
export function searchSources(catalog = [], query = "", limit = 40) {
  const terms = lower(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return catalog.map((source, index) => {
    const name = lower(source.name);
    const haystack = `${name} ${lower(projectName(source))} ${lower(source.cwd)} ${lower(source.source)}`;
    if (source.id === "all" || !terms.every((term) => haystack.includes(term))) return null;
    return { rank: terms.every((term) => name.includes(term)) ? 0 : 1, index, source };
  }).filter(Boolean).sort((a, b) => a.rank - b.rank || a.index - b.index).slice(0, limit).map((match) => match.source);
}

/** Stable outfit for a goblin across every surface (same FNV-1a hash as the widget). */
export function outfitIndex(id, count = 8) {
  let value = 2166136261;
  for (const byte of new TextEncoder().encode(String(id))) value = Math.imul(value ^ byte, 16777619) >>> 0;
  return value % count;
}
