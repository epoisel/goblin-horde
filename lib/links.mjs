/**
 * Party links: a Codex chat that drives Orca agents (often a Claude Opus coordinator and its workers)
 * becomes one party with them, instead of three unrelated rows.
 *
 * The automatic link is "this chat drives that Orca terminal": a command the chat ran addresses the
 * terminal with an orchestration verb (worker-start, run-create, task-create, send, ask, reply, check,
 * dispatch, ...) or sends input to it (terminal send / wait). Reading or showing a terminal does not
 * count. Only command lines are read, never their output or any message text. Workers a coordinator
 * starts follow it through Orca's parent pane, and a Claude Code session working in a joined
 * worktree is the same agent as the Orca pane there, so it joins (and the duplicate goblin goes).
 * People can join a party to a chat by hand, or keep one separate; both choices are remembered.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HANDLE = "term_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const COMMAND = /\borca(?:\.exe)?\s+(orchestration|terminal)\s+([a-z][a-z-]*)([^|;&\n]*)/gi;
const ADDRESSED = new RegExp(String.raw`--(terminal|from|to)[ =]+["']?(${HANDLE})`, "g");
// Terminal subcommands that only look at a terminal; a chat looks at many it does not drive.
const OBSERVING = new Set(["read", "show", "list", "switch", "close"]);
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

/** The Orca terminals a chat's own commands drive, newest time first: [{ terminal, verb, at }]. */
export function drivenTerminals(turns) {
  const found = new Map();
  for (const turn of Array.isArray(turns) ? turns : []) {
    const at = ms(turn?.startedAt) || ms(turn?.completedAt);
    for (const item of turn?.items || []) {
      if (typeof item?.command !== "string" || !item.command.includes("orca")) continue;
      for (const match of item.command.matchAll(COMMAND)) {
        const [, kind, verb, rest] = match;
        if (kind.toLowerCase() === "terminal" && OBSERVING.has(verb.toLowerCase())) continue;
        for (const flag of rest.matchAll(ADDRESSED)) {
          const terminal = flag[2];
          const previous = found.get(terminal);
          if (!previous || at >= previous.at) found.set(terminal, { terminal, verb: `${kind} ${verb}`.toLowerCase(), at });
        }
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

/**
 * Rewrite party membership so linked agents join their chat. Pure.
 *
 * agents: every member (Codex, Claude, extension, Orca); Orca members carry `pane`, `parentPane`,
 * `terminal`, and `mainWorktree`. Returns { agents, joined: Map(original party -> chat) } where a
 * joined member's parentThreadId is the chat, it carries `joined: { from, reason, verb }`, and an
 * Orca pane that is the same agent as a joined Claude session is left out. Also returned, for
 * `joinSubset`: `membership` (member id -> { chat, joined }) and `twins` (left-out pane -> session).
 */
export function joinParties(agents, { auto = new Map(), manual = new Map() } = {}) {
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
  const claudeParties = new Map();
  for (const agent of agents) {
    if (agent.source !== "claude" || agent.childOf) continue;
    const chat = [...worktrees].find(([path]) => samePath(path, agent.cwd))?.[1];
    if (chat) claudeParties.set(agent.parentThreadId, chat);
  }
  // 3. Manual choices override everything for their party: join to a chat, or keep separate ("").
  const partyOf = (agent) => String(agent.parentThreadId || agent.id || "");
  const joined = new Map();
  const out = [];
  const hiddenPanes = new Map(); // pane id -> the Claude session that is the same agent
  const membership = new Map();
  // An Orca pane and the joined Claude session in its worktree are one agent: keep the Claude goblin.
  for (const [path] of worktrees) {
    const panes = orca.filter((agent) => target.has(agent.id) && samePath(agent.cwd, path) && /claude/i.test(String(agent.role || agent.model?.family || "")));
    const sessions = agents.filter((agent) => agent.source === "claude" && !agent.childOf && samePath(agent.cwd, path));
    if (panes.length === 1 && sessions.length === 1) hiddenPanes.set(panes[0].id, sessions[0].id);
  }
  for (const agent of agents) {
    const party = partyOf(agent);
    const choice = manual.get(party);
    let link = null;
    if (choice === "") link = null;
    else if (choice) link = { chat: choice, reason: "manual", verb: "" };
    else if (target.has(agent.id)) link = target.get(agent.id);
    else if (agent.source === "claude" && claudeParties.has(party)) link = { chat: claudeParties.get(party), reason: "worktree", verb: "" };
    if (!link || link.chat === party || agent.id === link.chat) { out.push(agent); continue; }
    const member = { chat: link.chat, joined: { from: party, reason: link.reason, verb: link.verb } };
    membership.set(agent.id, member);
    if (choice !== "" && hiddenPanes.has(agent.id) && !manual.has(party)) continue;
    joined.set(party, link.chat);
    out.push({ ...agent, parentThreadId: link.chat, joined: member.joined });
  }
  const twins = new Map([...hiddenPanes].filter(([pane]) => !out.some((agent) => agent.id === pane)));
  return { agents: out, joined, membership, twins };
}

/**
 * Join the members a scene shows (`shown`, often a cut of the feed) using every member known
 * (`everyone`), so a worker whose coordinator pane was cut, or a helper chat whose parent was, keeps
 * its party from one poll to the next. Members keep the scene's own fields (such as `attention`); a
 * pane is left out as a Claude session's twin only while that session is shown.
 */
export function joinSubset(shown, everyone, links) {
  const all = new Map(everyone.map((agent) => [agent.id, agent]));
  for (const agent of shown) all.set(agent.id, agent);
  const { membership, twins } = joinParties([...all.values()], links);
  const ids = new Set(shown.map((agent) => agent.id));
  const agents = [];
  const joined = new Map();
  for (const agent of shown) {
    if (twins.has(agent.id) && ids.has(twins.get(agent.id))) continue;
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
