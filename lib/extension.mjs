/**
 * Extension feeds: a small NDJSON format other orchestrators can write so their agents appear as
 * goblin parties. See EXTENSIONS.md for the format.
 *
 * Each feed is one file, `<state>/feeds/<feed>.ndjson`, with one JSON record per line. Only the
 * documented fields are kept, every text is clipped and passed through the same secret filter as
 * the Claude feed, and command steps never carry their command text or output: the schema has no
 * place for them and records that try are rejected.
 */
import { appendFileSync, mkdirSync, readdirSync, renameSync, statSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { cleanModelId, describeModel } from "./models.mjs";
import {
  classifyClaude, countActors, goblinStateDir, keepMostUrgent, partyCoverage, partyRank, readFileTail, redactSecrets, truncatedCounts,
} from "./claude.mjs";

export const EXTENSION_LIMITS = Object.freeze({
  rotateBytes: 1_000_000, // A feed file rolls over to one older file at this size.
  readBytes: 2_000_000, // Newest bytes read from each file.
  lineChars: 4096,
  feeds: 32, // Feed files read per scan.
  records: 6000, // Newest records rebuilt per feed.
  parties: 50, // Parties kept per feed: needing you, failed, working, then newest.
  agents: 24, // Agents kept per party (the lead always), in the same order; what is cut is counted.
  activities: 40,
  turns: 3,
  textChars: 600,
  catalogMs: 7 * 24 * 60 * 60_000,
  staleMs: 2 * 60 * 60_000,
  askMs: 6 * 60 * 60_000,
});

export const FEED_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ID = /^[A-Za-z0-9_.-]{1,64}$/;
export const EXTENSION_EVENTS = Object.freeze(["start", "step", "message", "needs", "failed", "done", "ended"]);
export const STEP_KINDS = Object.freeze(["read", "edit", "search", "command", "test", "research", "tool", "plan"]);
const STEP_STATUS = new Set(["started", "completed", "failed"]);
const ALLOWED = new Set(["v", "feed", "at", "party", "partyName", "agent", "agentName", "role", "lead", "event", "step", "stepId",
  "status", "target", "label", "text", "cwd", "model"]);
// Fields that would carry raw prompts, shell commands, or tool output are refused outright, so an integration learns early.
const FORBIDDEN = new Set(["command", "cmd", "args", "output", "stdout", "stderr", "prompt", "input", "transcript", "diff", "patch", "env", "token", "secret"]);
const PRIVATE_NAME = /^\.env(\.|$)|^\.netrc$|^\.npmrc$|^\.pypirc$|^id_(rsa|dsa|ecdsa|ed25519)|\.(pem|key|p12|pfx|keystore|jks)$|secret|credential|password|token/i;

const clip = (value, max) => {
  const text = String(value ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
// Names are short public labels: credential-looking text is removed before the character filter.
const label = (value, max) => (typeof value === "string" ? clip(redactSecrets(value).replace(/\[secret removed\]/g, "(removed)").replace(/[^\p{L}\p{N} _.,:·'()&+#/-]/gu, ""), max) : "");
const shortHash = (value) => createHash("sha256").update(String(value)).digest("hex").slice(0, 4);

export const extensionFeedDir = (stateDir = goblinStateDir()) => join(stateDir, "feeds");
export const extensionPartyId = (feed, party) => `ext:${feed}:${party}`;
export const extensionAgentId = (feed, party, agent) => `ext-agent:${feed}:${party}:${agent}`;
export const EXTENSION_PARTY = /^ext:[a-z0-9][a-z0-9-]{0,31}:[A-Za-z0-9_.-]{1,64}$/;

function toMillis(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string" && value.length <= 40) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

/**
 * Validate one record. Returns { record, errors, dropped }: record is null when the line must be
 * skipped; dropped lists unknown fields that were ignored.
 */
export function validateExtensionRecord(raw, { feed = "", now = Date.now() } = {}) {
  const errors = [];
  const dropped = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { record: null, errors: ["A record must be a JSON object."], dropped };
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN.has(key)) errors.push(`"${key}" is not accepted: feeds carry public progress only, never commands, output, prompts, or secrets.`);
    else if (!ALLOWED.has(key)) dropped.push(key);
  }
  if (raw.v !== 1) errors.push("\"v\" must be 1.");
  const feedName = raw.feed ?? feed;
  if (typeof feedName !== "string" || !FEED_NAME.test(feedName)) errors.push("\"feed\" must be 1-32 lowercase letters, digits, or dashes.");
  else if (feed && feedName !== feed) errors.push(`"feed" is "${feedName}" but this file belongs to "${feed}".`);
  const at = toMillis(raw.at);
  if (!at) errors.push("\"at\" must be a time in milliseconds, seconds, or ISO 8601.");
  else if (at > now + 5 * 60_000) errors.push("\"at\" is in the future.");
  if (typeof raw.party !== "string" || !ID.test(raw.party)) errors.push("\"party\" must be an id of 1-64 letters, digits, dots, dashes, or underscores.");
  if (typeof raw.agent !== "string" || !ID.test(raw.agent)) errors.push("\"agent\" must be an id of 1-64 letters, digits, dots, dashes, or underscores.");
  if (!EXTENSION_EVENTS.includes(raw.event)) errors.push(`"event" must be one of ${EXTENSION_EVENTS.join(", ")}.`);
  if (raw.event === "step" && !STEP_KINDS.includes(raw.step)) errors.push(`A step needs "step": one of ${STEP_KINDS.join(", ")}.`);
  if (raw.status !== undefined && !STEP_STATUS.has(raw.status)) errors.push("\"status\" must be started, completed, or failed.");
  if (raw.stepId !== undefined && (typeof raw.stepId !== "string" || !ID.test(raw.stepId))) errors.push("\"stepId\" must be a short id.");
  if (raw.lead !== undefined && typeof raw.lead !== "boolean") errors.push("\"lead\" must be true or false.");
  if (raw.target !== undefined && (typeof raw.target !== "string" || /[\\/]/.test(raw.target))) errors.push("\"target\" must be a file's base name, with no folders.");
  if (raw.cwd !== undefined && (typeof raw.cwd !== "string" || raw.cwd.length > 300)) errors.push("\"cwd\" must be a folder path of up to 300 characters.");
  if (raw.text !== undefined && typeof raw.text !== "string") errors.push("\"text\" must be a string.");
  if (errors.length) return { record: null, errors, dropped };

  const record = { v: 1, feed: feedName, at, party: raw.party, agent: raw.agent, event: raw.event };
  const partyName = label(raw.partyName, 80);
  const agentName = label(raw.agentName, 60);
  const role = label(raw.role, 60);
  if (partyName) record.partyName = partyName;
  if (agentName) record.agentName = agentName;
  if (role) record.role = role;
  if (cleanModelId(raw.model)) record.model = cleanModelId(raw.model);
  if (raw.lead === true) record.lead = true;
  if (typeof raw.cwd === "string" && raw.cwd.trim() && !/[\u0000-\u001f]/.test(raw.cwd)) record.cwd = clip(raw.cwd, 300);
  if (raw.event === "step") {
    record.step = raw.step;
    record.status = raw.status || "completed";
    if (raw.stepId) record.stepId = raw.stepId;
    if (raw.step === "read" || raw.step === "edit") {
      const base = clip(raw.target, 80);
      if (base) record.target = PRIVATE_NAME.test(base) ? "a private file" : base;
    }
    if (raw.step === "tool") {
      const name = label(raw.label, 40);
      if (name) record.label = name;
    }
  }
  // Commands and checks never show text: the title says what kind of thing happened, nothing more.
  const textAllowed = ["message", "needs", "failed", "done"].includes(raw.event) || (raw.event === "step" && ["plan", "research", "search"].includes(raw.step));
  if (textAllowed && typeof raw.text === "string" && raw.text.trim()) record.text = clip(redactSecrets(raw.text.slice(0, EXTENSION_LIMITS.textChars * 2)), EXTENSION_LIMITS.textChars);
  return { record, errors, dropped };
}

/** Parse NDJSON text for one feed: malformed, oversized, and invalid lines are counted and skipped. */
export function parseExtensionLines(text, { feed = "", now = Date.now(), limits = EXTENSION_LIMITS } = {}) {
  const records = [];
  let skipped = 0;
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    if (line.length > limits.lineChars) { skipped++; continue; }
    let raw;
    try { raw = JSON.parse(line); } catch { skipped++; continue; }
    const { record } = validateExtensionRecord(raw, { feed, now });
    if (record) records.push(record);
    else skipped++;
  }
  return { records, skipped };
}

/** Append a validated record to its feed's file, rolling the file over when it grows too large. */
export function appendExtensionRecord(raw, { dir = extensionFeedDir(), now = Date.now(), rotateBytes = EXTENSION_LIMITS.rotateBytes } = {}) {
  const { record, errors, dropped } = validateExtensionRecord(raw, { now });
  if (!record) return { ok: false, errors, dropped };
  const line = `${JSON.stringify(record)}\n`;
  if (line.length > EXTENSION_LIMITS.lineChars) return { ok: false, errors: ["The record is too long."], dropped };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${record.feed}.ndjson`);
  try {
    const size = statSync(file).size;
    if (size >= rotateBytes) {
      try { renameSync(file, join(dir, `${record.feed}.1.ndjson`)); }
      catch { if (size >= rotateBytes * 4) truncateSync(file, 0); }
    }
  } catch { /* No file yet. */ }
  appendFileSync(file, line, { mode: 0o600 });
  return { ok: true, record, errors: [], dropped };
}

const STEP_TEXT = {
  read: (target) => ({ kind: "tool", title: target ? `Read ${target}` : "Read a local file", description: "Opened a local file to inspect its contents." }),
  edit: (target) => ({ kind: "file", title: target ? `Changed ${target}` : "Changed a file", description: target || "a file" }),
  search: () => ({ kind: "tool", title: "Searched local files", description: "Looked for matching text in the project." }),
  command: () => ({ kind: "command", title: "Ran a local command", description: "Ran a command in the local workspace." }),
  test: () => ({ kind: "command", title: "Ran checks", description: "Ran the project's checks." }),
  research: () => ({ kind: "research", title: "Researched", description: "Looked up information." }),
  plan: () => ({ kind: "update", title: "Planned", description: "Updated its working plan." }),
  tool: (_target, name) => ({ kind: "tool", title: name ? `Used ${name}` : "Used a tool", description: name ? `Used ${name}.` : "Used a tool." }),
};

/** A public activity for one step, in the words the Codex and Claude feeds use. */
export function stepActivity(record) {
  const base = STEP_TEXT[record.step](record.target, record.label);
  if (record.text && ["plan", "research", "search"].includes(record.step)) return { ...base, description: record.text };
  return base;
}

function newAgent(record) {
  return { feed: record.feed, party: record.party, agent: record.agent, name: "", role: "", cwd: "", lead: false,
    startedAt: record.at, updatedAt: record.at, turns: [], openTurn: null, activities: [], steps: new Map(), needsAt: 0, question: "", ended: false, order: 0 };
}

function openTurn(agent, record) {
  if (agent.openTurn) return agent.openTurn;
  const turn = { id: `turn-${agent.turns.length + 1}-${record.at}`, status: "inProgress", startedAt: record.at, questions: [], error: "" };
  agent.turns.push(turn);
  agent.openTurn = turn;
  agent.ended = false;
  return turn;
}

function closeTurn(agent, status) {
  const turn = agent.openTurn;
  if (!turn) return null;
  turn.status = status;
  agent.openTurn = null;
  for (const activity of agent.activities) if (activity.turnId === turn.id && activity.status === "inProgress") activity.status = status === "failed" ? "failed" : "completed";
  return turn;
}

function addActivity(agent, turn, record, fields) {
  const activity = { id: `ext-${shortHash(`${record.feed}:${record.party}:${record.agent}`)}-${agent.order}`, turnId: turn.id, turnStartedAt: turn.startedAt,
    order: agent.order++, detail: "", status: "completed", ...fields };
  agent.activities.push(activity);
  if (agent.activities.length > EXTENSION_LIMITS.activities * 4) agent.activities.splice(0, agent.activities.length - EXTENSION_LIMITS.activities * 2);
  return activity;
}

function applyRecord(agent, record) {
  agent.updatedAt = Math.max(agent.updatedAt, record.at);
  if (record.agentName) agent.name = record.agentName;
  if (record.role) agent.role = record.role;
  if (record.model) agent.model = record.model;
  if (record.cwd) agent.cwd = record.cwd;
  if (record.lead) agent.lead = true;
  if (record.event !== "needs") { agent.needsAt = 0; agent.question = ""; }
  switch (record.event) {
    case "start":
      openTurn(agent, record);
      break;
    case "step": {
      const turn = openTurn(agent, record);
      const existing = record.stepId ? agent.steps.get(record.stepId) : null;
      const status = record.status === "started" ? "inProgress" : record.status;
      if (existing && record.status !== "started") { existing.status = status; break; }
      const activity = addActivity(agent, turn, record, { ...stepActivity(record), status });
      if (record.stepId) agent.steps.set(record.stepId, activity);
      break;
    }
    case "message": {
      const turn = openTurn(agent, record);
      if (record.text) addActivity(agent, turn, record, { kind: "update", title: "Update", description: record.text });
      break;
    }
    case "needs": {
      const turn = openTurn(agent, record);
      agent.needsAt = record.at;
      agent.question = record.text || "";
      if (record.text) addActivity(agent, turn, record, { kind: "update", title: "Needs you", description: record.text });
      break;
    }
    case "failed": {
      const turn = openTurn(agent, record);
      turn.error = record.text || "The agent reported a failure.";
      addActivity(agent, turn, record, { kind: "update", title: "Stopped", description: turn.error, status: "failed" });
      closeTurn(agent, "failed");
      break;
    }
    case "done": {
      const turn = openTurn(agent, record);
      if (record.text) addActivity(agent, turn, record, { kind: "update", title: "Answer", description: record.text });
      closeTurn(agent, "completed");
      break;
    }
    case "ended":
      closeTurn(agent, "interrupted");
      agent.ended = true;
      break;
    default:
      break;
  }
}

function toActor(agent, party, { now, limits, leadId }) {
  const id = extensionAgentId(agent.feed, agent.party, agent.agent);
  const isLead = id === leadId;
  const turns = agent.turns.map((turn) => ({ ...turn }));
  const last = turns.at(-1);
  const stale = last?.status === "inProgress" && now - agent.updatedAt > limits.staleMs;
  if (stale) last.status = "stale";
  if (last && agent.question && agent.needsAt) last.questions = [agent.question];
  const activities = agent.activities.slice(-limits.activities).map((activity) => (stale && activity.status === "inProgress" ? { ...activity, status: "completed" } : { ...activity }));
  const needsInput = Boolean(agent.needsAt) && now - agent.needsAt <= limits.askMs;
  const status = needsInput ? "waiting" : stale ? "stale" : last?.status === "inProgress" ? "active"
    : last?.status === "failed" ? "failed" : agent.ended ? "ended" : last ? "completed" : "idle";
  const name = agent.name || agent.agent;
  const actor = {
    id, source: "extension", feed: agent.feed, name: isLead ? party.name : name, nickname: name,
    role: agent.role || `${agent.feed} agent`, parentThreadId: party.id, workflowName: party.name,
    ...(isLead ? {} : { childOf: leadId }),
    cwd: agent.cwd || party.cwd, model: describeModel(agent.model), status, updatedAt: agent.updatedAt, turns: agent.turns.length,
    turnStates: turns.slice(-limits.turns).map(({ id: turnId, status: turnStatus, questions, error }) => ({ id: turnId, status: turnStatus, questions, error })),
    activities, latest: activities.at(-1) || null,
    counts: {
      updates: activities.filter((item) => item.kind === "update").length,
      commands: activities.filter((item) => item.kind === "command").length,
      research: activities.filter((item) => item.kind === "research").length,
      tools: activities.filter((item) => item.kind === "tool" || item.kind === "file").length,
    },
    needsInput, replyAvailable: false,
  };
  actor.attention = classifyClaude(actor, { now, askMs: limits.askMs });
  return actor;
}

/** Rebuild parties from one feed's records in time order. Pure. */
export function buildExtensionParties(records, options) {
  return buildExtensionFeed(records, options).parties;
}

/**
 * Parties plus what the caps left out. Every agent is classified before any cut, so the caps drop
 * quiet history first and never a member that needs the person while quieter ones are kept.
 */
export function buildExtensionFeed(records, { now = Date.now(), limits = EXTENSION_LIMITS } = {}) {
  const parties = new Map();
  for (const record of records) {
    const key = `${record.feed}:${record.party}`;
    let party = parties.get(key);
    if (!party) {
      party = { feed: record.feed, party: record.party, name: "", cwd: "", updatedAt: record.at, agents: new Map(), firstAgent: record.agent };
      parties.set(key, party);
    }
    party.updatedAt = Math.max(party.updatedAt, record.at);
    if (record.partyName) party.name = record.partyName;
    if (record.cwd && !party.cwd) party.cwd = record.cwd;
    let agent = party.agents.get(record.agent);
    if (!agent) { agent = newAgent(record); party.agents.set(record.agent, agent); }
    applyRecord(agent, record);
  }
  const built = [...parties.values()].filter((party) => !limits.catalogMs || now - party.updatedAt <= limits.catalogMs).map((party) => {
    const id = extensionPartyId(party.feed, party.party);
    const project = String(party.cwd || "").split(/[\\/]/).filter(Boolean).at(-1) || "";
    const name = party.name || `${party.feed} · ${project || party.party}`;
    const agents = [...party.agents.values()];
    // The lead is the agent marked lead, else the agent named like the party, else the first one seen.
    const lead = agents.find((agent) => agent.lead) || party.agents.get(party.party) || party.agents.get(party.firstAgent);
    const leadId = extensionAgentId(party.feed, party.party, lead.agent);
    const meta = { id, name, cwd: party.cwd };
    const leadActor = toActor(lead, meta, { now, limits, leadId });
    const others = agents.filter((agent) => agent !== lead).map((agent) => toActor(agent, meta, { now, limits, leadId }));
    // The lead always stays; the other places go to the most urgent members, then the newest.
    const { kept, hidden } = keepMostUrgent(others, Math.max(0, limits.agents - 1));
    return {
      id, feed: party.feed, name, cwd: party.cwd, updatedAt: party.updatedAt,
      agents: [leadActor, ...kept], hidden: countActors(hidden), rank: partyRank([leadActor, ...others]),
    };
  });
  const { kept, hidden } = keepMostUrgent(built, limits.parties, (party) => party.rank);
  return { parties: kept.map(({ rank, ...party }) => party), truncated: truncatedCounts(kept, hidden) };
}

/** Lists feed files, newest first, without reading them. */
export function listFeedFiles(dir, limits = EXTENSION_LIMITS) {
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const feeds = new Map();
  for (const name of names) {
    const match = /^([a-z0-9][a-z0-9-]{0,31})(\.1)?\.ndjson$/.exec(name);
    if (!match) continue;
    let info;
    try { info = statSync(join(dir, name)); } catch { continue; }
    if (!info.isFile()) continue;
    const entry = feeds.get(match[1]) || { feed: match[1], files: [], mtimeMs: 0, bytes: 0 };
    entry.files.push({ name, older: Boolean(match[2]), size: info.size, mtimeMs: info.mtimeMs });
    entry.mtimeMs = Math.max(entry.mtimeMs, info.mtimeMs);
    entry.bytes += info.size;
    feeds.set(match[1], entry);
  }
  return [...feeds.values()].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limits.feeds)
    .map((entry) => ({ ...entry, files: entry.files.sort((a, b) => Number(b.older) - Number(a.older)) }));
}

export class ExtensionReader {
  constructor({ dir = extensionFeedDir(), ttlMs = 1000, limits = EXTENSION_LIMITS, clock = Date.now } = {}) {
    this.dir = dir;
    this.ttlMs = ttlMs;
    this.limits = limits;
    this.clock = clock;
    this.cached = null;
    this.cachedAt = 0;
    this.byFeed = new Map();
  }

  readFeed(entry, now) {
    const fingerprint = entry.files.map((file) => `${file.name}:${file.size}:${file.mtimeMs}`).join(";");
    const saved = this.byFeed.get(entry.feed);
    if (saved?.fingerprint === fingerprint) return saved;
    const records = [];
    let skipped = 0;
    let unreadable = false;
    for (const file of entry.files) {
      try {
        // Feeds are written by other programs, so only the newest bytes are ever read into memory.
        const text = readFileTail(join(this.dir, file.name), this.limits.readBytes);
        const parsed = parseExtensionLines(text, { feed: entry.feed, now, limits: this.limits });
        records.push(...parsed.records);
        skipped += parsed.skipped;
      } catch { unreadable = true; }
    }
    const sorted = records.sort((a, b) => a.at - b.at).slice(-this.limits.records);
    const result = { fingerprint, records: sorted, skipped, unreadable, lastAt: sorted.at(-1)?.at || 0 };
    this.byFeed.set(entry.feed, result);
    return result;
  }

  snapshot() {
    const now = this.clock();
    if (this.cached && now - this.cachedAt < this.ttlMs) return this.cached;
    // Feeds past the cap are the least recently written; they are counted, not silently lost.
    const allEntries = listFeedFiles(this.dir, { ...this.limits, feeds: Number.MAX_SAFE_INTEGER });
    const entries = allEntries.slice(0, this.limits.feeds);
    const feeds = [];
    const sessions = [];
    const truncated = { feeds: allEntries.length - entries.length, parties: 0, agents: 0, active: 0, urgent: 0 };
    for (const entry of entries) {
      const read = this.readFeed(entry, now);
      const { parties, truncated: cut } = buildExtensionFeed(read.records, { now, limits: this.limits });
      sessions.push(...parties);
      for (const key of ["parties", "agents", "active", "urgent"]) truncated[key] += cut[key];
      feeds.push({ feed: entry.feed, records: read.records.length, skipped: read.skipped, lastAt: read.lastAt, parties: parties.length,
        partiesHidden: cut.parties, agentsHidden: cut.agents, unreadable: read.unreadable });
    }
    for (const feed of this.byFeed.keys()) if (!entries.some((entry) => entry.feed === feed)) this.byFeed.delete(feed);
    const warning = feeds.some((feed) => feed.unreadable) ? "An extension feed could not be read." : "";
    this.cached = { sessions, feeds, truncated, warning };
    this.cachedAt = now;
    return this.cached;
  }

  listSessions() {
    return this.snapshot().sessions.map(({ id, name, cwd, updatedAt, agents, feed }) => ({ id, name, cwd, updatedAt, source: "extension", feed, agentCount: agents.length,
      model: agents.find((agent) => agent.model)?.model || null }));
  }

  scene(id) {
    if (!EXTENSION_PARTY.test(String(id))) return null;
    const snapshot = this.snapshot();
    const party = snapshot.sessions.find((item) => item.id === id);
    if (!party) return null;
    return {
      root: { id, source: "extension", name: party.name, cwd: party.cwd, status: party.agents[0]?.status || "unknown", updatedAt: party.updatedAt,
        turns: 0, turnStates: [], activities: [], latest: null, counts: { updates: 0, commands: 0, research: 0, tools: 0 } },
      agents: party.agents, requests: [], replyAvailable: false, ...partyCoverage(party, snapshot.warning, "member"),
    };
  }
}
