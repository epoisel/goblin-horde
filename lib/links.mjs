/**
 * Party links: a Codex chat that drives Orca agents (often a Claude Opus coordinator and its workers)
 * becomes one party with them, instead of three unrelated rows.
 *
 * The automatic link is "this chat drives that Orca terminal": a command the chat ran addresses the
 * terminal with an orchestration verb (worker-start, run-create, task-create, send, ask, reply, check,
 * dispatch, ...) or sends input to it (terminal send / wait). Reading or showing a terminal does not
 * count. Only command lines are read, never their output or any message text. Workers a coordinator
 * starts follow it through Orca's parent pane, and a Claude Code session working in a joined
 * worktree joins too. A Claude Code session proven to be the same agent as an Orca pane (the pane's
 * newest prompt or reply is one the session recorded; see claudePanePairs) is one goblin: the pane's
 * duplicate goes. Without proof both stay, but one prompt is never counted twice.
 * People can join a party to a chat by hand, or keep one separate; both choices are remembered.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "./claude.mjs";
import { classifyOrca } from "./feed.mjs";
import { ORCA_HANDLE_TEXT as HANDLE, commandTerminals } from "./orca-commands.mjs";

const PARTY_ID = /^(?:[A-Za-z0-9_-]{8,100}|claude:[A-Za-z0-9_-]{1,128}|orca:[A-Za-z0-9_-]{1,400}|ext:[A-Za-z0-9_.:/-]{1,200})$/;
const CHAT_ID = /^[A-Za-z0-9_-]{8,100}$/;
const LINK_LIMIT = 500;
const LINK_KEEP_MS = 7 * 24 * 60 * 60_000;

const ms = (value) => {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number < 1e12 ? number * 1000 : number;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export { commandTerminals };

/** The Orca terminals a chat's own commands drive, newest time first: [{ terminal, verb, at }]. */
export function drivenTerminals(turns) {
  const found = new Map();
  for (const turn of Array.isArray(turns) ? turns : []) {
    const at = ms(turn?.startedAt) || ms(turn?.completedAt);
    for (const item of turn?.items || []) {
      for (const { terminal, verb } of commandTerminals(item?.command)) {
        const previous = found.get(terminal);
        if (!previous || at >= previous.at) found.set(terminal, { terminal, verb, at });
      }
    }
  }
  return [...found.values()].sort((a, b) => b.at - a.at);
}

/** Automatic links (terminal -> the chat that drove it last) and manual choices (party -> chat, or kept separate). */
export class LinkStore {
  constructor({ dir }) {
    this.dir = dir;
    this.file = join(dir, "links.json");
    this.auto = new Map();
    this.manual = new Map();
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      for (const [terminal, link] of Object.entries(saved?.auto || {})) {
        if (new RegExp(`^${HANDLE}$`).test(terminal) && CHAT_ID.test(link?.chat) && Number.isFinite(link?.at))
          this.auto.set(terminal, { chat: link.chat, verb: String(link.verb || "").slice(0, 40), at: link.at, seenAt: Number(link.seenAt) || link.at });
      }
      for (const [party, chat] of Object.entries(saved?.manual || {})) {
        if (PARTY_ID.test(party) && (chat === "" || CHAT_ID.test(chat))) this.manual.set(party, chat);
      }
    } catch { /* Nothing linked yet, or an unreadable file: start empty. */ }
  }

  /** Record what a chat drives; the most recent driver of a terminal wins. Returns whether anything changed. */
  observe(chat, drives, { now = Date.now() } = {}) {
    if (!CHAT_ID.test(chat)) return false;
    let changed = false;
    for (const { terminal, verb, at } of drives) {
      const previous = this.auto.get(terminal);
      if (previous && previous.at > at) continue;
      if (previous && previous.chat === chat && previous.at === at) continue;
      this.auto.set(terminal, { chat, verb, at, seenAt: now });
      changed = true;
    }
    if (changed) this.prune(now);
    // A link that cannot be saved (a locked or read-only folder) still holds for this run; it is
    // never a reason to call the chat unreadable.
    if (changed) try { this.save(); } catch { /* Kept in memory; saved with the next change. */ }
    return changed;
  }

  /** Join a party to a chat by hand (chat id), keep it separate (""), or go back to automatic (null). */
  setManual(party, chat) {
    if (!PARTY_ID.test(party)) throw Object.assign(new Error("Choose a valid party."), { statusCode: 400 });
    if (chat !== null && chat !== "" && !CHAT_ID.test(chat)) throw Object.assign(new Error("Choose a valid Codex chat."), { statusCode: 400 });
    if (chat === null) this.manual.delete(party);
    else this.manual.set(party, chat);
    this.save();
  }

  prune(now = Date.now()) {
    for (const [terminal, link] of this.auto) if (now - link.seenAt > LINK_KEEP_MS) this.auto.delete(terminal);
    if (this.auto.size > LINK_LIMIT) {
      const oldest = [...this.auto].sort((a, b) => a[1].at - b[1].at).slice(0, this.auto.size - LINK_LIMIT);
      for (const [terminal] of oldest) this.auto.delete(terminal);
    }
  }

  save() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ auto: Object.fromEntries(this.auto), manual: Object.fromEntries(this.manual) })}\n`, { mode: 0o600 });
      renameSync(temporary, this.file);
    } finally { rmSync(temporary, { force: true }); }
  }
}

const samePath = (a, b) => Boolean(a) && Boolean(b)
  && String(a).replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase() === String(b).replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();

// Marks already worked out, by text: the same prompts are compared on every poll.
const marks = new Map();
const MARK_MIN_CHARS = 24; // Shorter words ("yes", "continue") are said to many agents.

/**
 * A comparable mark for a prompt or a final reply, so an Orca pane's newest words can be matched to a
 * Claude Code session's recorded ones without keeping either text: credentials removed (the hook
 * stores its prompts filtered), spacing collapsed, the first 160 characters, hashed. "" for text too
 * short to tell agents apart.
 */
export function identityMark(text) {
  const value = typeof text === "string" ? text.slice(0, 600) : "";
  if (!value) return "";
  if (marks.has(value)) return marks.get(value);
  const words = redactSecrets(value).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  const mark = words.length < MARK_MIN_CHARS ? "" : createHash("sha256").update(words.slice(0, 160)).digest("hex").slice(0, 16);
  marks.set(value, mark);
  if (marks.size > 1000) marks.delete(marks.keys().next().value);
  return mark;
}

const isClaudePane = (agent) => agent?.source === "orca" && /^claude\b/i.test(String(agent.role || ""));
const isClaudeSession = (agent) => agent?.source === "claude" && !agent.childOf;

/**
 * Which Orca panes are positively which Claude Code sessions: pane id -> session id. A shared folder is
 * not proof (another agent can work there too): the pane must run Claude in the session's folder, one
 * of its marks (`paneMarks(pane)`: its newest prompt and reply, as Orca reports them) must be one of
 * the session's (`sessionMarks(session)`: its recent recorded prompts and replies), and neither side
 * may match anyone else. Pure.
 */
export function claudePanePairs(agents, { paneMarks = () => [], sessionMarks = () => [] } = {}) {
  const panes = agents.filter(isClaudePane);
  if (!panes.length) return new Map();
  const sessions = agents.filter(isClaudeSession).map((session) => ({ session, marks: new Set((sessionMarks(session) || []).filter(Boolean)) }));
  const byPane = new Map();
  const bySession = new Map();
  for (const pane of panes) {
    const own = (paneMarks(pane) || []).filter(Boolean);
    if (!own.length) continue;
    for (const { session, marks: theirs } of sessions) {
      if (!samePath(pane.cwd, session.cwd) || !own.some((mark) => theirs.has(mark))) continue;
      byPane.set(pane.id, [...(byPane.get(pane.id) || []), session.id]);
      bySession.set(session.id, [...(bySession.get(session.id) || []), pane.id]);
    }
  }
  const pairs = new Map();
  for (const [pane, found] of byPane) if (found.length === 1 && bySession.get(found[0]).length === 1) pairs.set(pane, found[0]);
  return pairs;
}

/** A pane whose prompt is shown on the Claude goblin instead: no ask of its own, classified again. */
function withoutAsk(pane) {
  const quiet = { ...pane, ask: null, needsInput: false };
  return "attention" in pane ? { ...quiet, attention: classifyOrca(quiet) } : quiet;
}

/**
 * Rewrite party membership so linked agents join their chat. Pure.
 *
 * agents: every member (Codex, Claude, extension, Orca); Orca members carry `pane`, `parentPane`,
 * `terminal`, and `mainWorktree`. `pairs` (pane id -> Claude session id, from claudePanePairs) are
 * the panes proven to be a Claude session. Returns { agents, joined: Map(original party -> chat) }
 * where a joined member's parentThreadId is the chat, it carries `joined: { from, reason, verb }`, an
 * Orca pane proven to be a Claude session is left out (the session takes the pane's link when it has
 * none of its own), and a Claude pane that may be a session asking the same thing shows no ask of its
 * own. Also returned, for `joinSubset`: `membership` (member id -> { chat, joined }), `twins`
 * (left-out pane -> session), and `muted` (pane -> the session whose ask stands for it).
 */
export function joinParties(agents, { auto = new Map(), manual = new Map(), pairs = new Map() } = {}) {
  const orca = agents.filter((agent) => agent.source === "orca" && agent.pane);
  const byPane = new Map(orca.map((agent) => [agent.pane, agent]));
  // A Codex helper chat that drives Orca belongs to its parent chat's party.
  const partyOfChat = new Map(agents.filter((agent) => agent.source === "codex" && agent.parentThreadId)
    .map((agent) => [String(agent.id), String(agent.parentThreadId)]));
  const target = new Map(); // member id -> { chat, reason, verb }
  // 1. Orca panes a chat drives, then the workers they started (parent panes), however deep.
  for (const agent of orca) {
    const link = agent.terminal ? auto.get(agent.terminal) : null;
    if (link) target.set(agent.id, { chat: partyOfChat.get(link.chat) || link.chat, reason: "drives", verb: link.verb });
  }
  for (let changed = true, rounds = 0; changed && rounds < 8; rounds++) {
    changed = false;
    for (const agent of orca) {
      if (target.has(agent.id) || !agent.parentPane) continue;
      const parent = byPane.get(agent.parentPane);
      const joined = parent && target.get(parent.id);
      if (joined) { target.set(agent.id, { chat: joined.chat, reason: "worker", verb: joined.verb }); changed = true; }
    }
  }
  // 2. A worktree is one task: other panes and Claude Code sessions working in a joined worktree join too
  //    (never the main checkout, where much else runs).
  const worktrees = new Map();
  for (const agent of orca) {
    const joined = target.get(agent.id);
    if (joined && !agent.mainWorktree && agent.cwd) worktrees.set(String(agent.cwd), joined.chat);
  }
  for (const agent of orca) {
    if (target.has(agent.id) || agent.mainWorktree) continue;
    const chat = [...worktrees].find(([path]) => samePath(path, agent.cwd))?.[1];
    if (chat) target.set(agent.id, { chat, reason: "worktree", verb: "" });
  }
  const partyOf = (agent) => String(agent.parentThreadId || agent.id || "");
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  // An Orca pane proven to be a Claude Code session is one agent: keep the Claude goblin, which takes
  // the link a chat has to the pane (unless the person chose for the pane's party by hand).
  const hiddenPanes = new Map(); // pane id -> the Claude session that is the same agent
  const twinLinks = new Map(); // Claude session party -> the link of its pane
  for (const [pane, session] of pairs) {
    if (!byId.has(pane) || !byId.has(session) || manual.has(partyOf(byId.get(pane)))) continue;
    hiddenPanes.set(pane, session);
    if (target.has(pane)) twinLinks.set(partyOf(byId.get(session)), target.get(pane));
  }
  const claudeParties = new Map();
  for (const agent of agents) {
    if (agent.source !== "claude" || agent.childOf) continue;
    const chat = [...worktrees].find(([path]) => samePath(path, agent.cwd))?.[1];
    if (chat) claudeParties.set(agent.parentThreadId, chat);
  }
  // Not proven either way: a Claude pane and a Claude session in one folder may be one agent. Both
  // goblins stay, but a prompt the session already shows is not counted again on the pane.
  const paired = new Set(pairs.values());
  const asking = (agent) => Boolean(agent?.ask) || agent?.attention === "needs";
  const muted = new Map(); // pane id -> the session whose ask stands for it
  for (const pane of orca) {
    if (hiddenPanes.has(pane.id) || pairs.has(pane.id) || !asking(pane) || !isClaudePane(pane)) continue;
    const session = agents.find((agent) => isClaudeSession(agent) && !paired.has(agent.id) && samePath(agent.cwd, pane.cwd) && asking(agent));
    if (session) muted.set(pane.id, session.id);
  }
  // 3. Manual choices override everything for their party: join to a chat, or keep separate ("").
  const joined = new Map();
  const out = [];
  const membership = new Map();
  for (const agent of agents) {
    const party = partyOf(agent);
    const choice = manual.get(party);
    let link = null;
    if (choice === "") link = null;
    else if (choice) link = { chat: choice, reason: "manual", verb: "" };
    else if (target.has(agent.id)) link = target.get(agent.id);
    else if (agent.source === "claude" && claudeParties.has(party)) link = { chat: claudeParties.get(party), reason: "worktree", verb: "" };
    else if (agent.source === "claude" && twinLinks.has(party)) link = twinLinks.get(party);
    const linked = link && link.chat !== party && agent.id !== link.chat;
    const member = linked ? { chat: link.chat, joined: { from: party, reason: link.reason, verb: link.verb } } : null;
    if (member) membership.set(agent.id, member);
    if (hiddenPanes.has(agent.id)) continue;
    const shown = muted.has(agent.id) ? withoutAsk(agent) : agent;
    if (!member) { out.push(shown); continue; }
    joined.set(party, link.chat);
    out.push({ ...shown, parentThreadId: link.chat, joined: member.joined });
  }
  return { agents: out, joined, membership, twins: hiddenPanes, muted };
}

/**
 * Join the members a scene shows (`shown`, often a cut of the feed) using every member known
 * (`everyone`), so a worker whose coordinator pane was cut, or a helper chat whose parent was, keeps
 * its party from one poll to the next. Members keep the scene's own fields (such as `attention`); a
 * pane is left out as a Claude session's twin, or loses an ask that session shows, only while that
 * session is shown.
 */
export function joinSubset(shown, everyone, links) {
  const all = new Map(everyone.map((agent) => [agent.id, agent]));
  for (const agent of shown) all.set(agent.id, agent);
  const { membership, twins, muted } = joinParties([...all.values()], links);
  const ids = new Set(shown.map((agent) => agent.id));
  const agents = [];
  const joined = new Map();
  for (const shownAgent of shown) {
    if (twins.has(shownAgent.id) && ids.has(twins.get(shownAgent.id))) continue;
    const agent = muted.has(shownAgent.id) && ids.has(muted.get(shownAgent.id)) ? withoutAsk(shownAgent) : shownAgent;
    const member = membership.get(agent.id);
    if (!member) { agents.push(agent); continue; }
    joined.set(member.joined.from, member.chat);
    agents.push({ ...agent, parentThreadId: member.chat, joined: member.joined });
  }
  return { agents, joined };
}

/**
 * Run link discovery in the background: at most one at a time, never awaited by a scene. A run that
 * learns nothing waits before the next, doubling from `minMs` up to `maxMs`; a change in what is
 * unlinked (`key`, such as a new pane) or a run that learned something starts over at once.
 */
export class DiscoveryGate {
  constructor({ minMs = 30_000, maxMs = 10 * 60_000, clock = Date.now } = {}) {
    Object.assign(this, { minMs, maxMs, clock, running: null, wait: 0, nextAt: 0, key: "" });
  }

  /** Start `task` (resolving to how many links it learned) unless one runs or is waiting; returns the run, or null. */
  start(task, key = "") {
    if (key !== this.key) { this.key = key; this.wait = 0; this.nextAt = 0; }
    if (this.running || this.clock() < this.nextAt) return null;
    const done = (learned) => {
      this.wait = learned > 0 ? 0 : Math.min(this.maxMs, this.wait ? this.wait * 2 : this.minMs);
      this.nextAt = this.clock() + this.wait;
      this.running = null;
      return learned;
    };
    this.running = Promise.resolve().then(task).then((learned) => done(Number(learned) || 0), () => done(0));
    return this.running;
  }
}

/** A short line for tooltips: why a member is in this party. */
export function joinReason(joined) {
  if (!joined) return "";
  if (joined.reason === "manual") return "Joined to this chat by you.";
  if (joined.reason === "worker") return "A worker started by this chat's Orca coordinator.";
  if (joined.reason === "worktree") return "Works in the Orca worktree this chat drives.";
  return `This chat drives it${joined.verb ? ` (orca ${joined.verb})` : ""}.`;
}
