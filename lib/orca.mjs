import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { describeModel } from "./models.mjs";

// Orca names the agent kind; when it does not also name the model, the kind still picks the tribe.
const AGENT_KINDS = { claude: { id: "claude", label: "Claude", family: "claude" }, codex: { id: "codex", label: "Codex", family: "openai" } };
export function orcaModel(agent) {
  return describeModel(agent?.model) || AGENT_KINDS[String(agent?.agentType || "").toLowerCase()] || null;
}

const runFile = promisify(execFile);
const CLIP = (value, length = 800) => String(value || "").trim().slice(0, length);
const eventId = (id, kind, stamp, value) => `${id}:${kind}:${stamp}:${createHash("sha256").update(String(value || "")).digest("hex").slice(0, 12)}`;
const workspaceId = (id) => `orca:${Buffer.from(id).toString("base64url")}`;
const decodeWorkspaceId = (id) => {
  if (!/^orca:[A-Za-z0-9_-]+$/.test(id)) return "";
  try { return Buffer.from(id.slice(5), "base64url").toString("utf8"); } catch { return ""; }
};

export function orcaAgentActivity(agent, previous = null) {
  const changes = [];
  const stamp = Number(agent.updatedAt) || Date.now();
  const id = String(agent.paneKey);
  if (agent.lastAssistantMessage && agent.lastAssistantMessage !== previous?.lastAssistantMessage) {
    changes.push({ id: eventId(id, "message", stamp, agent.lastAssistantMessage), kind: "update", title: "Update", description: CLIP(agent.lastAssistantMessage, 1200), status: "completed", turnId: id, turnStartedAt: stamp, order: 0 });
  }
  if (agent.toolName && (agent.toolName !== previous?.toolName || agent.toolInput !== previous?.toolInput || agent.state !== previous?.state)) {
    const name = CLIP(agent.toolName, 60);
    changes.push({ id: eventId(id, "tool", stamp, `${name}:${agent.toolInput}`), kind: "tool", title: `Used ${name}`, description: name === "Bash" || name === "PowerShell" ? "Ran a local command." : `Used ${name}.`, detail: CLIP(agent.toolInput, 1800), status: agent.state === "working" ? "inProgress" : "completed", turnId: id, turnStartedAt: stamp, order: 1 });
  }
  if (previous && agent.state !== previous.state) {
    const labels = { done: "Finished the task.", waiting: "Waiting for the next step.", working: "Working on the task." };
    changes.push({ id: eventId(id, "state", stamp, agent.state), kind: "update", title: "Status", description: labels[agent.state] || `Status: ${agent.state}.`, status: "completed", turnId: id, turnStartedAt: stamp, order: 2 });
  }
  return changes;
}

function emptyCounts() { return { updates: 0, commands: 0, research: 0, tools: 0 }; }

export class OrcaReader {
  constructor({ command = process.env.ORCA_CLI_COMMAND || "orca", ttlMs = 3000, run = runFile } = {}) {
    this.command = command;
    this.ttlMs = ttlMs;
    this.run = run;
    this.cached = null;
    this.cachedAt = 0;
    this.pending = null;
    this.previous = new Map();
    this.events = new Map();
  }

  async snapshot() {
    if (this.cached && Date.now() - this.cachedAt < this.ttlMs) return this.cached;
    if (this.pending) return this.pending;
    this.pending = this.load().finally(() => { this.pending = null; });
    return this.pending;
  }

  async load() {
    let worktrees = [];
    let terminals = [];
    try {
      const [worktreeOutput, terminalOutput] = await Promise.all([
        this.run(this.command, ["worktree", "ps", "--json"], { windowsHide: true, timeout: 12000, maxBuffer: 8 * 1024 * 1024 }),
        this.run(this.command, ["terminal", "list", "--json"], { windowsHide: true, timeout: 12000, maxBuffer: 8 * 1024 * 1024 }),
      ]);
      const worktreeEnvelope = JSON.parse(worktreeOutput.stdout);
      const terminalEnvelope = JSON.parse(terminalOutput.stdout);
      if (!worktreeEnvelope.ok || !terminalEnvelope.ok) throw new Error("Orca inventory unavailable");
      worktrees = worktreeEnvelope.result?.worktrees || [];
      terminals = terminalEnvelope.result?.terminals || [];
    } catch (error) {
      // Orca is optional: when its command is not installed there is nothing missing from the feed.
      if (!this.cached && error?.code === "ENOENT") return { workspaces: [], warning: "", missing: true };
      // Plain words for the tooltip, never the command line: a CLI that ran and failed (exit code,
      // timeout) almost always means the Orca app is closed; anything else is an answer it could not read.
      const reason = typeof error?.code === "number" || error?.killed || /timed? ?out/i.test(String(error?.message))
        ? "Orca is not running" : "Orca could not be read";
      if (this.cached) return { ...this.cached, warning: `Orca feed is temporarily unavailable: ${reason}.` };
      return { workspaces: [], warning: `Orca feed is unavailable: ${reason}.` };
    }
    const terminalNames = new Map(terminals.filter((item) => !item.orphaned).map((item) => [`${item.tabId}:${item.leafId}`, item.title]));
    // A pane's terminal handle is how a Codex chat that drives it names it (see lib/links.mjs).
    const terminalHandles = new Map(terminals.filter((item) => !item.orphaned && item.handle).map((item) => [`${item.tabId}:${item.leafId}`, String(item.handle)]));
    const seen = new Set();
    const transformed = worktrees.filter((worktree) => !worktree.isArchived).map((worktree) => {
      const agents = (worktree.agents || []).filter((agent) => agent.paneKey && agent.agentType).map((agent) => {
        const id = `orca-agent:${agent.paneKey}`;
        seen.add(id);
        const old = this.previous.get(id);
        const newEvents = orcaAgentActivity(agent, old);
        const events = [...(this.events.get(id) || []), ...newEvents].slice(-50);
        this.events.set(id, events);
        this.previous.set(id, { state: agent.state, lastAssistantMessage: agent.lastAssistantMessage, toolName: agent.toolName, toolInput: agent.toolInput });
        const terminalName = terminalNames.get(agent.paneKey);
        const title = agent.displayName || agent.taskTitle || (terminalName && !/^terminal\s*\d+$/i.test(terminalName) ? terminalName.replace(/^✳\s*/, "") : "");
        const nickname = CLIP(title || `${agent.agentType[0].toUpperCase()}${agent.agentType.slice(1)} agent`, 70);
        const latest = events.at(-1) || null;
        return {
          id, source: "orca", name: nickname, nickname, role: `${agent.agentType} · ${agent.state || "unknown"}`,
          model: orcaModel(agent),
          parentThreadId: workspaceId(worktree.worktreeId), cwd: worktree.path, status: agent.state || "unknown",
          pane: agent.paneKey, parentPane: agent.parentPaneKey || "", terminal: terminalHandles.get(agent.paneKey) || "",
          mainWorktree: Boolean(worktree.isMainWorktree),
          updatedAt: agent.updatedAt || worktree.lastOutputAt || 0, turns: 1,
          turnStates: [], activities: events, latest,
          counts: { ...emptyCounts(), updates: events.filter((event) => event.kind === "update").length, tools: events.filter((event) => event.kind === "tool").length },
        };
      }).sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
      return {
        id: workspaceId(worktree.worktreeId), source: "orca", name: worktree.displayName || worktree.repo || "Orca workspace",
        cwd: worktree.path, status: worktree.workspaceStatus || "unknown", updatedAt: worktree.lastOutputAt || worktree.lastActivityAt || 0,
        agents,
      };
    }).sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
    for (const key of this.events.keys()) if (!seen.has(key)) { this.events.delete(key); this.previous.delete(key); }
    this.cached = { workspaces: transformed, warning: "" };
    this.cachedAt = Date.now();
    return this.cached;
  }

  async listWorkspaces() {
    const snapshot = await this.snapshot();
    return snapshot.workspaces.map(({ id, name, cwd, updatedAt, agents }) => ({ id, name: `Orca · ${name}`, cwd, updatedAt, source: "orca", agentCount: agents.length }));
  }

  async scene(id) {
    const snapshot = await this.snapshot();
    const decoded = decodeWorkspaceId(id);
    const workspace = snapshot.workspaces.find((item) => item.id === id && decodeWorkspaceId(item.id) === decoded);
    if (!workspace) return null;
    return {
      root: { id, source: "orca", name: `Orca · ${workspace.name}`, cwd: workspace.cwd, status: workspace.status, updatedAt: workspace.updatedAt, turns: 0, turnStates: [], activities: [], latest: null, counts: emptyCounts() },
      agents: workspace.agents,
      requests: [], warning: snapshot.warning,
    };
  }
}

export { workspaceId };
