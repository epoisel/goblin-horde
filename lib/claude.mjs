/**
 * Direct Claude Code activity, recorded by a hook and read back as goblin parties.
 *
 * The hook keeps only public activity: which tool ran and its category, a file's base name when
 * the tool clearly works on one file, statuses, subagent lifecycle, and a short excerpt of the
 * final reply. It never keeps prompt text, tool input or output, error text, transcripts, or
 * reasoning. Records are rebuilt into Codex-shaped actors so the widget and viewer need no
 * Claude-specific animation code.
 */
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, statSync, truncateSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { cleanModelId, describeModel } from "./models.mjs";

export const CLAUDE_LIMITS = Object.freeze({
  rotateBytes: 1_000_000, // The live log rolls over to one older file at this size.
  lineChars: 4096, // A stored line longer than this is not one of ours.
  records: 6000, // Newest records rebuilt per read.
  sessions: 100, // Claude sessions kept as parties: needing you, failed, working, then newest.
  children: 24, // Subagents kept per session, in the same order; what is cut is counted.
  activities: 40, // Public steps kept per goblin.
  turns: 3, // Turn states kept per goblin, as for Codex.
  excerptChars: 600, // Final reply excerpt.
  catalogMs: 7 * 24 * 60 * 60_000, // Sessions older than this leave the source list.
  staleMs: 2 * 60 * 60_000, // A turn with no hook for this long is no longer called working.
  askMs: 6 * 60 * 60_000, // A permission or question prompt stays urgent this long.
  failedMs: 30 * 60_000, // A failure stays urgent this long after the session's last activity; then the person has moved on.
});

const EVENTS = new Set(["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "PermissionRequest", "Notification", "SubagentStart", "SubagentStop", "Stop", "StopFailure"]);
const NEEDS_NOTICES = new Set(["permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"]);
const CLEAR_NOTICES = new Set(["elicitation_complete", "elicitation_response"]);
// Claude Code is back at its prompt, waiting for the next message. Stop does not run when the person
// interrupts a turn (Esc) or denies a permission, so this is the only sign that such a turn is over.
const IDLE_NOTICE = "idle_prompt";
const START_SOURCES = new Set(["startup", "resume", "clear", "compact", "fork"]);
const END_REASONS = new Set(["clear", "resume", "logout", "prompt_input_exit", "other"]);
const ERROR_TYPES = new Set(["rate_limit", "overloaded", "authentication_failed", "oauth_org_not_allowed", "account_on_hold",
  "billing_error", "invalid_request", "model_not_found", "server_error", "max_output_tokens", "cloud_credential_error", "unknown"]);
const ERROR_TEXT = {
  rate_limit: "Claude Code hit a rate limit.", overloaded: "Claude was overloaded.", server_error: "Claude hit a server error.",
  authentication_failed: "Claude Code needs to sign in again.", max_output_tokens: "The reply ran out of room.",
  billing_error: "Claude Code reported a billing problem.", account_on_hold: "The Claude account is on hold.",
  invalid_request: "Claude rejected the request.", model_not_found: "Claude Code could not find the chosen model.",
  oauth_org_not_allowed: "This Claude organization is not allowed here.", cloud_credential_error: "Claude Code's cloud credentials failed.",
};
const FILE_TOOLS = { Read: "read", NotebookRead: "read", Edit: "edit", MultiEdit: "edit", Write: "edit", NotebookEdit: "edit" };
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
// File names that suggest secrets are shown without their name.
const PRIVATE_NAME = /^\.env(\.|$)|^\.netrc$|^\.npmrc$|^\.pypirc$|^id_(rsa|dsa|ecdsa|ed25519)|\.(pem|key|p12|pfx|keystore|jks)$|secret|credential|password|token/i;

const clip = (value, max) => {
  const text = String(value ?? "").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const safeId = (value) => (typeof value === "string" && SAFE_ID.test(value) ? value : "");
const safeLabel = (value, max = 40) => (typeof value === "string" ? clip(value.replace(/[^A-Za-z0-9 _.:-]/g, ""), max) : "");
const shortHash = (value) => createHash("sha256").update(String(value)).digest("hex").slice(0, 4);

/** Where Goblin Horde keeps its own state on this computer. */
export function goblinStateDir({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  const path = platform === "win32" ? win32 : posix;
  if (env.GOBLIN_HORDE_STATE_DIR && path.isAbsolute(env.GOBLIN_HORDE_STATE_DIR)) return env.GOBLIN_HORDE_STATE_DIR;
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "GoblinHorde");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "GoblinHorde");
  const xdg = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(home, ".local", "state");
  return path.join(xdg, "goblin-horde");
}

export function claudeActivityDir(options) {
  const platform = options?.platform || process.platform;
  return (platform === "win32" ? win32 : posix).join(goblinStateDir(options), "claude");
}

// A key that names a credential, alone or at the end of a longer name: password, db_password,
// clientSecret, x-api-key, accessToken, AWS_SECRET_ACCESS_KEY. "max_tokens" or "token_count" are not.
// Azure's AccountKey, SharedAccessKey, and SharedAccessSignature are named too: their values hold
// "/" and "+", which the long-run catch-all at the end does not cover.
const CREDENTIAL_WORD = String.raw`(?:password|passwd|passphrase|pwd|secrets?|token|api[_-]?key|apikey|access[_-]?key|account[_-]?key|private[_-]?key|auth[_-]?key|access[_-]?signature|credentials?|authorization|cookie)`;
// The key may be bare or quoted (also JSON-escaped inside a string), followed by ":", "=", or "=>".
// The value may be quoted (escaped or not, even unterminated) or bare; a bare value runs to the
// next whitespace or quote, so the rest of a quoted JSON object stays readable. Key prefixes are
// bounded so a long run of word characters cannot make the scan quadratic.
const CREDENTIAL_PAIR = new RegExp(String.raw`(?<![A-Za-z0-9])([A-Za-z0-9_.-]{0,40}?${CREDENTIAL_WORD})((?:\\?["'])?\s*(?:=>|[:=])\s*)`
  + String.raw`(\\"(?:(?!\\")[^\r\n])*?(?:\\"|(?=[\r\n])|$)|"(?:[^"\\\r\n]|\\.)*(?:"|(?=[\r\n])|$)|'(?:[^'\\\r\n]|\\.)*(?:'|(?=[\r\n])|$)`
  + String.raw`|(?:[^\s"'\\]|\\(?!"))+)`, "gi");
const ALREADY_REMOVED = /\[(secret|private key)\b/;
// Command-line style: --password hunter2, --api-key abc.
const CREDENTIAL_FLAG = new RegExp(String.raw`(?<![A-Za-z0-9-])(--?[A-Za-z0-9_-]{0,40}?${CREDENTIAL_WORD})(\s+)(?!-)((?:[^\s"'\\]|\\(?!"))+)`, "gi");
// A short password flag means a password only after the tools that use it so: sqlcmd/bcp/osql
// "-P secret" and mysql "-psecret" (attached; "mysql -p db" prompts instead). Elsewhere -p and -P
// are ports and flags (ssh -p 22, docker -p 8080:80, rsync -P) and stay. Likewise curl's -u
// user:password. The command and the flag must sit on one line, within 400 characters.
const ARG = String.raw`("[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+)`;
const SQL_PASSWORD_FLAG = new RegExp(String.raw`(\b(?:sqlcmd|SQLCMD|Sqlcmd|osql|OSQL|bcp|BCP|isql)(?:\.exe)?\b[^\r\n;|&]{0,400}?\s-P)(?![A-Za-z])(\s*)(?!-)${ARG}`, "g");
const MYSQL_PASSWORD_FLAG = new RegExp(String.raw`(\b(?:mysql|mysqldump|mysqladmin|mysqlimport|mysqlsh|mariadb|mariadb-dump)(?:\.exe)?\b[^\r\n;|&]{0,400}?\s-p)(?=[^\s-])${ARG}`, "g");
const CURL_USER = new RegExp(String.raw`(\bcurl(?:\.exe)?\b[^\r\n;|&]{0,400}?\s(?:-u\s*|--user[\s=]+)["']?[^\s:"']*:)([^\s"']+)`, "gi");
// Prose: "the password is Hunter2Secret!". Only a value that does not read as a word is removed
// ("the password is incorrect" stays), and quoted values always are.
const SPOKEN_SECRET = new RegExp(String.raw`(\b(?:password|passphrase|passcode|pwd|secret|token|api key)\s+(?:is|was|=)\s+(?:now\s+|set to\s+)?)`
  + String.raw`("[^"\r\n]{1,200}"|'[^'\r\n]{1,200}'|\x60[^\x60\r\n]{1,200}\x60|[^\s"'\x60]{4,200})`, "gi");
// Well-known token shapes: Stripe live/test keys and webhook secrets, GitLab tokens.
const KNOWN_TOKEN = /\b(?:(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{20,}|gl(?:pat|dt|rt|ptt|ft|cbt|soat|imt)-[A-Za-z0-9_-]{20,})/g;
// A SAS token's signature in a URL query (?sv=...&sig=...), whatever else surrounds it.
const SAS_SIGNATURE = /((?<![A-Za-z0-9_.-])sig=)([^&\s"'#]+)/gi;

/** Remove things that look like credentials from public text, keeping the words around them. */
export function redactSecrets(text) {
  return String(text ?? "")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[private key removed]")
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "[secret removed]")
    .replace(KNOWN_TOKEN, "[secret removed]")
    .replace(SAS_SIGNATURE, "$1[secret removed]")
    .replace(SQL_PASSWORD_FLAG, "$1$2[secret removed]")
    .replace(MYSQL_PASSWORD_FLAG, "$1[secret removed]")
    .replace(CURL_USER, "$1[secret removed]")
    .replace(SPOKEN_SECRET, (whole, lead, value) => {
      const bare = value.replace(/[.,;:)]+$/, "");
      if (/^["'\x60]/.test(value)) return `${lead}${value[0]}[secret removed]${value[0]}`;
      // An ordinary word, or a number too short to be a secret, is left alone.
      if (/^[A-Za-z]+$/.test(bare) || ALREADY_REMOVED.test(value) || bare.length < 4) return whole;
      return `${lead}[secret removed]${value.slice(bare.length)}`;
    })
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/g, "[secret removed]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[secret removed]")
    .replace(/\b([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s/:@"']+:[^\s/@"']+@/gi, "$1[secret removed]@")
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [secret removed]")
    .replace(CREDENTIAL_PAIR, (whole, key, separator, value) => {
      // "Authorization: Bearer [secret removed]" was already handled above.
      if (ALREADY_REMOVED.test(value) || /^(bearer|basic)$/i.test(value)) return whole;
      const quote = /^\\"/.test(value) ? "\\\"" : /^["']/.test(value) ? value[0] : "";
      return `${key}${separator}${quote}[secret removed]${quote}`;
    })
    .replace(CREDENTIAL_FLAG, (whole, flag, space, value) => (ALREADY_REMOVED.test(value) ? whole : `${flag}${space}[secret removed]`))
    .replace(/\b(?=[A-Za-z0-9+_-]{0,256}\d)(?=[A-Za-z0-9+_-]{0,256}[A-Za-z])[A-Za-z0-9+_-]{40,}={0,2}/g,
      (token) => (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(token) ? token : "[secret removed]"));
}

function fileTarget(tool, input) {
  if (!FILE_TOOLS[tool] || !input || typeof input !== "object") return "";
  const raw = input.file_path ?? input.notebook_path ?? input.path;
  if (typeof raw !== "string" || !raw.trim()) return "";
  const base = raw.split(/[\\/]/).filter(Boolean).at(-1) || "";
  if (!base || /[\u0000-\u001f]/.test(base)) return "";
  if (PRIVATE_NAME.test(base)) return "a private file";
  return clip(base, 80);
}

/** The reply's closing line when it is a question, filtered before it is clipped. */
function questionIn(text) {
  const tail = String(text).trimEnd();
  const last = tail.slice(tail.lastIndexOf("\n") + 1).trim();
  return last.endsWith("?") ? clip(redactSecrets(last.slice(0, 400)), 180) : "";
}

/**
 * Validate one record, from the hook or from disk, keeping only known public fields.
 * Returns null for anything that is not a well-formed Goblin Horde Claude record.
 */
export function cleanRecord(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.v !== 1) return null;
  if (typeof raw.id !== "string" || !/^[a-f0-9]{8,32}$/.test(raw.id)) return null;
  if (typeof raw.at !== "number" || !Number.isFinite(raw.at) || raw.at <= 0) return null;
  if (!EVENTS.has(raw.event) || !safeId(raw.session)) return null;
  const record = { v: 1, id: raw.id, at: raw.at, event: raw.event, session: raw.session };
  if (safeId(raw.agent)) record.agent = raw.agent;
  if (safeLabel(raw.agentType)) record.agentType = safeLabel(raw.agentType);
  if (typeof raw.cwd === "string" && raw.cwd.trim() && !/[\u0000-\u001f]/.test(raw.cwd)) record.cwd = clip(raw.cwd, 300);
  if (typeof raw.tool === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(raw.tool)) record.tool = raw.tool;
  if (safeId(raw.toolUse)) record.toolUse = raw.toolUse;
  if (typeof raw.target === "string" && raw.target && !/[\\/\u0000-\u001f]/.test(raw.target)) record.target = clip(raw.target, 80);
  if (NEEDS_NOTICES.has(raw.notice) || CLEAR_NOTICES.has(raw.notice) || raw.notice === IDLE_NOTICE) record.notice = raw.notice;
  if (START_SOURCES.has(raw.start)) record.start = raw.start;
  if (END_REASONS.has(raw.reason)) record.reason = raw.reason;
  if (ERROR_TYPES.has(raw.errorType)) record.errorType = raw.errorType;
  if (typeof raw.message === "string" && raw.message.trim()) record.message = clip(redactSecrets(raw.message), CLAUDE_LIMITS.excerptChars);
  if (typeof raw.question === "string" && raw.question.trim()) record.question = clip(redactSecrets(raw.question), 180);
  if (cleanModelId(raw.model)) record.model = cleanModelId(raw.model);
  return record;
}

/** Turn one hook payload into a bounded public record, or null when nothing should be kept. */
export function normalizeHookEvent(input, { now = Date.now(), id = randomBytes(8).toString("hex") } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const event = input.hook_event_name;
  if (!EVENTS.has(event) || !safeId(input.session_id)) return null;
  const raw = { v: 1, id, at: now, event, session: input.session_id, agent: input.agent_id, agentType: input.agent_type, cwd: input.cwd };
  // SessionStart names the model; newer Claude Code versions send it as { id, display_name }.
  const model = typeof input.model === "string" ? input.model : input.model?.id;
  if (cleanModelId(model)) raw.model = model;
  if (["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest"].includes(event)) {
    raw.tool = input.tool_name;
    raw.toolUse = input.tool_use_id;
    const target = fileTarget(input.tool_name, input.tool_input);
    if (target) raw.target = target;
  }
  if (event === "Notification") {
    if (!NEEDS_NOTICES.has(input.notification_type) && !CLEAR_NOTICES.has(input.notification_type)
      && input.notification_type !== IDLE_NOTICE) return null;
    raw.notice = input.notification_type;
  }
  if (event === "SessionStart") raw.start = input.source;
  if (event === "SessionEnd") raw.reason = input.reason;
  if (event === "StopFailure") {
    const reason = typeof input.error === "string" ? input.error : input.error_type;
    raw.errorType = ERROR_TYPES.has(reason) ? reason : "unknown";
  }
  if ((event === "Stop" || event === "SubagentStop") && typeof input.last_assistant_message === "string") {
    // Only the opening excerpt and the closing line are kept, so only those are filtered; twice the
    // excerpt length keeps a credential that straddles the cut whole until it is removed.
    const full = input.last_assistant_message;
    raw.message = redactSecrets(full.slice(0, CLAUDE_LIMITS.excerptChars * 2));
    raw.question = questionIn(full);
  }
  return cleanRecord(raw);
}

// Events after which the transcript's newest assistant turn names the model in use.
const MODEL_EVENTS = new Set(["PreToolUse", "PostToolUse", "Stop", "SubagentStop", "StopFailure"]);
// Lines that may carry the assistant's model; each is then parsed and checked properly.
const MODEL_HINT = '"model":"';

/**
 * The model the session (or subagent) last answered with, read from the newest end of its
 * transcript. Only the model id is taken; nothing else in the transcript is kept or parsed.
 * A subagent's own transcript sits beside the session's: <session>/subagents/agent-<id>.jsonl.
 */
export function transcriptModel(input, { maxBytes = 64 * 1024, readTail = readFileTail } = {}) {
  if (!input || !MODEL_EVENTS.has(input.hook_event_name)) return "";
  const main = typeof input.transcript_path === "string" ? input.transcript_path : "";
  const agent = safeId(input.agent_id);
  let file = main;
  if (agent) {
    file = typeof input.agent_transcript_path === "string" && input.agent_transcript_path ? input.agent_transcript_path : "";
    if (!file && main) {
      const path = /\\/.test(main) && !main.includes("/") ? win32 : posix;
      file = path.join(path.dirname(main), path.basename(main, ".jsonl"), "subagents", `agent-${agent}.jsonl`);
    }
  }
  if (!file || !/\.jsonl$/i.test(file)) return "";
  let text = "";
  try { text = readTail(file, maxBytes); } catch { return ""; }
  let found = "";
  for (const line of text.split("\n")) {
    if (!line.includes(MODEL_HINT)) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    // Tool calls and their results can carry a "model" of their own (an Agent's input, a tool's output).
    const model = record?.type === "assistant" ? record.message?.model : "";
    if (cleanModelId(model)) found = model;
  }
  return found;
}

/** Append one record to the app-owned log, rolling it over when it grows too large. */
export function appendClaudeRecord(record, { dir = claudeActivityDir(), rotateBytes = CLAUDE_LIMITS.rotateBytes } = {}) {
  const clean = cleanRecord(record);
  if (!clean) return false;
  const line = `${JSON.stringify(clean)}\n`;
  if (line.length > CLAUDE_LIMITS.lineChars) return false;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "activity.jsonl");
  try {
    const size = statSync(file).size;
    if (size >= rotateBytes) {
      try { renameSync(file, join(dir, "activity.1.jsonl")); }
      // A reader may hold the file for a moment; past four times the limit, start over rather than grow.
      catch { if (size >= rotateBytes * 4) truncateSync(file, 0); }
    }
  } catch { /* No log yet. */ }
  appendFileSync(file, line, { mode: 0o600 });
  return true;
}

const emptyCounts = () => ({ updates: 0, commands: 0, research: 0, tools: 0 });

/** A public activity bubble for one tool step, in the same words the Codex feed uses. */
export function toolActivity(tool, target = "") {
  const name = String(tool || "tool");
  if (FILE_TOOLS[name] === "read") return { kind: "tool", title: target ? `Read ${target}` : "Read a local file", description: "Opened a local file to inspect its contents." };
  if (FILE_TOOLS[name] === "edit") return { kind: "file", title: target ? `Changed ${target}` : "Changed a file", description: target || "a file" };
  if (name === "Grep") return { kind: "tool", title: "Searched local files", description: "Looked for matching text in the project." };
  if (name === "Glob" || name === "LS") return { kind: "tool", title: "Looked for matching files", description: "Listed files in the project." };
  if (name === "Bash" || name === "PowerShell" || name === "BashOutput" || name === "KillShell") return { kind: "command", title: "Ran a local command", description: "Ran a command in the local workspace." };
  if (name === "WebSearch") return { kind: "research", title: "Searched the web", description: "Looked up information online." };
  if (name === "WebFetch") return { kind: "research", title: "Opened a source", description: "Read a web page." };
  if (name === "Task" || name === "Agent") return { kind: "tool", title: "Started a helper agent", description: "Handed part of the work to a subagent." };
  if (name === "TodoWrite") return { kind: "tool", title: "Updated the task list", description: "Updated its working plan." };
  if (name.startsWith("mcp__")) {
    const server = name.split("__")[1] || "connected app";
    return { kind: "tool", title: `Used ${clip(server.replace(/[_-]+/g, " "), 40)}`, description: "Used a connected tool." };
  }
  return { kind: "tool", title: `Used ${clip(name, 40)}`, description: `Used ${clip(name, 40)}.` };
}

function projectName(cwd) {
  return String(cwd || "").split(/[\\/]/).filter(Boolean).at(-1) || "";
}

/** Party and goblin ids are fixed by the session and subagent ids, so they survive restarts and log roll-over. */
export const claudePartyId = (session) => `claude:${session}`;
export const claudeMainId = (session) => `claude-agent:${session}`;
export const claudeChildId = (session, agent) => `claude-agent:${session}:${agent}`;

function newActor(session, agent, record) {
  return {
    session, agent, cwd: record.cwd || "", agentType: record.agentType || "", startedAt: record.at, updatedAt: record.at,
    turns: [], openTurn: null, activities: [], tools: new Map(), openTools: new Set(), asks: new Map(), ended: false, order: 0,
  };
}

/**
 * Open questions to the person. A permission request is keyed by its tool_use_id and waits on that
 * tool alone; a prompt notice (which carries no id) waits on every tool that was running when it
 * arrived. An ask clears when what it waits on finishes, or when the turn or session resolves.
 * Another tool finishing never answers it.
 */
function addAsk(actor, record) {
  const keyed = record.event === "PermissionRequest" && record.toolUse;
  const waitingOn = keyed ? new Set([record.toolUse]) : new Set(actor.openTools);
  actor.asks.set(keyed ? `tool:${record.toolUse}` : `ask:${record.id}`, { at: record.at, waitingOn, notice: record.event === "Notification" });
}

function settleAsks(actor, record) {
  for (const [key, ask] of actor.asks) {
    if (record.event === "Notification") { if (ask.notice) actor.asks.delete(key); continue; }
    // An ask with nothing running when it arrived is answered by the next sign of progress.
    if (!ask.waitingOn.size) { actor.asks.delete(key); continue; }
    if ((record.event === "PostToolUse" || record.event === "PostToolUseFailure") && record.toolUse) {
      ask.waitingOn.delete(record.toolUse);
      if (!ask.waitingOn.size) actor.asks.delete(key);
    }
  }
}

function resolveAsks(actor) {
  actor.asks.clear();
  actor.openTools.clear();
}

const needsAt = (actor) => Math.max(0, ...[...actor.asks.values()].map((ask) => ask.at));

function openTurn(actor, record) {
  if (actor.openTurn) return actor.openTurn;
  const turn = { id: `turn-${record.id}`, status: "inProgress", startedAt: record.at, questions: [], error: "" };
  actor.turns.push(turn);
  actor.openTurn = turn;
  return turn;
}

function closeTurn(actor, status) {
  // The end of a turn (or of the session) answers whatever it was waiting on.
  resolveAsks(actor);
  const turn = actor.openTurn;
  if (!turn) return null;
  turn.status = status;
  actor.openTurn = null;
  // Steps still open when the turn ends are done; a lost PostToolUse must not leave a goblin swinging forever.
  for (const activity of actor.activities) if (activity.turnId === turn.id && activity.status === "inProgress") activity.status = status === "failed" ? "failed" : "completed";
  return turn;
}

function addActivity(actor, turn, record, fields) {
  const activity = { id: `claude-${record.id}`, turnId: turn.id, turnStartedAt: turn.startedAt, order: actor.order++, detail: "", status: "completed", ...fields };
  actor.activities.push(activity);
  return activity;
}

function applyRecord(actor, record) {
  actor.updatedAt = Math.max(actor.updatedAt, record.at);
  if (record.cwd) actor.cwd = record.cwd;
  if (record.agentType && !actor.agentType) actor.agentType = record.agentType;
  if (record.model) actor.model = record.model;
  const needs = record.event === "PermissionRequest" || (record.event === "Notification" && NEEDS_NOTICES.has(record.notice));
  if (needs) { addAsk(actor, record); return; }
  settleAsks(actor, record);
  switch (record.event) {
    case "SessionStart":
      resolveAsks(actor);
      actor.ended = false;
      break;
    case "UserPromptSubmit":
      closeTurn(actor, "completed");
      actor.ended = false;
      openTurn(actor, record);
      break;
    case "SubagentStart":
      openTurn(actor, record);
      break;
    case "PreToolUse": {
      const turn = openTurn(actor, record);
      const key = record.toolUse || record.id;
      const activity = addActivity(actor, turn, record, { ...toolActivity(record.tool, record.target), status: "inProgress" });
      actor.tools.set(key, activity);
      if (record.toolUse) actor.openTools.add(record.toolUse);
      break;
    }
    case "PostToolUse":
    case "PostToolUseFailure": {
      const status = record.event === "PostToolUse" ? "completed" : "failed";
      if (record.toolUse) actor.openTools.delete(record.toolUse);
      const existing = record.toolUse ? actor.tools.get(record.toolUse) : null;
      if (existing) { existing.status = status; break; }
      const turn = openTurn(actor, record);
      addActivity(actor, turn, record, { ...toolActivity(record.tool, record.target), status });
      break;
    }
    case "Stop":
    case "SubagentStop": {
      const turn = actor.openTurn || openTurn(actor, record);
      if (record.message) addActivity(actor, turn, record, { kind: "update", title: "Answer", description: record.message });
      if (record.question) turn.questions = [record.question];
      closeTurn(actor, "completed");
      break;
    }
    case "StopFailure": {
      const turn = actor.openTurn || openTurn(actor, record);
      const description = ERROR_TEXT[record.errorType] || "Claude Code stopped with an error.";
      turn.error = description;
      addActivity(actor, turn, record, { kind: "update", title: "Stopped", description, status: "failed" });
      closeTurn(actor, "failed");
      break;
    }
    case "SessionEnd":
      closeTurn(actor, "interrupted");
      actor.ended = true;
      break;
    case "Notification":
      // Back at the prompt: a turn still open was interrupted or denied, not failed, and nothing it
      // asked is still waiting. A finished reply's closing question is kept; it was already closed.
      if (record.notice === IDLE_NOTICE) closeTurn(actor, "interrupted");
      break;
    default:
      break;
  }
}

/** needs | failed | working | quiet, the same feed classes Codex and Orca members use. */
export function classifyClaude(actor, { now = Date.now(), askMs = CLAUDE_LIMITS.askMs, failedMs = CLAUDE_LIMITS.failedMs } = {}) {
  if (actor?.needsInput) return "needs";
  const last = actor?.turnStates?.at(-1);
  // A finished reply that ends in a question waits on the person, as a Codex one does.
  if (last?.questions?.length && Number(actor.updatedAt) >= now - askMs) return "needs";
  // An old failure with nothing after it is history, not something to do: the person moved on.
  if (String(last?.status || "") === "failed") return Number(actor.updatedAt) >= now - failedMs ? "failed" : "quiet";
  if (String(last?.status || "") === "inProgress") return "working";
  return "quiet";
}

function toActor(state, { now, limits, sessionName }) {
  const isChild = Boolean(state.agent);
  const turns = state.turns.map((turn) => ({ ...turn }));
  const last = turns.at(-1);
  const stale = last?.status === "inProgress" && now - state.updatedAt > limits.staleMs;
  if (stale) last.status = "stale";
  const activities = state.activities.slice(-limits.activities).map((activity) => (stale && activity.status === "inProgress" ? { ...activity, status: "completed" } : { ...activity }));
  const askedAt = needsAt(state);
  const needsInput = Boolean(askedAt) && now - askedAt <= limits.askMs;
  const status = needsInput ? "waiting" : stale ? "stale" : last?.status === "inProgress" ? "active"
    : last?.status === "failed" ? "failed" : state.ended ? "ended" : last ? "completed" : "idle";
  const typeLabel = state.agentType || (isChild ? "helper" : "");
  const nickname = isChild ? clip(`${typeLabel[0].toUpperCase()}${typeLabel.slice(1)} subagent`, 70) : "Claude Code";
  const actor = {
    id: isChild ? claudeChildId(state.session, state.agent) : claudeMainId(state.session),
    source: "claude", name: isChild ? nickname : sessionName, nickname,
    role: isChild ? `Claude subagent · ${typeLabel}` : `Claude Code${state.agentType ? ` · ${state.agentType}` : ""}`,
    parentThreadId: claudePartyId(state.session),
    ...(isChild ? { childOf: claudeMainId(state.session), agentType: state.agentType } : {}),
    cwd: state.cwd, model: describeModel(state.model, { provider: "anthropic" }), status, updatedAt: state.updatedAt, turns: state.turns.length,
    turnStates: turns.slice(-limits.turns).map(({ id, status: turnStatus, questions, error }) => ({ id, status: turnStatus, questions, error })),
    activities, latest: activities.at(-1) || null,
    counts: {
      ...emptyCounts(),
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

// Which members a cap keeps first: someone waiting on the person, then failures, then work in progress.
const ATTENTION_RANK = { needs: 0, failed: 1, waiting: 2, working: 3, quiet: 4 };
const rankOf = (actor) => ATTENTION_RANK[actor?.attention] ?? ATTENTION_RANK.quiet;
export const partyRank = (actors) => Math.min(ATTENTION_RANK.quiet, ...actors.map(rankOf));

/** Keep at most `limit` items, most urgent first and then newest; the kept ones stay newest first. */
export function keepMostUrgent(items, limit, rank = rankOf) {
  if (items.length <= limit) return { kept: [...items].sort((a, b) => b.updatedAt - a.updatedAt), hidden: [] };
  const ordered = [...items].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
  return { kept: ordered.slice(0, limit).sort((a, b) => b.updatedAt - a.updatedAt), hidden: ordered.slice(limit) };
}

/** How many actors a cut left out, and how many of those were active or urgent. */
export function countActors(actors) {
  return {
    agents: actors.length,
    active: actors.filter((actor) => rankOf(actor) < ATTENTION_RANK.quiet).length,
    urgent: actors.filter((actor) => rankOf(actor) <= ATTENTION_RANK.failed).length,
  };
}

/** Totals left out across parties: whole parties that were cut, plus members cut from kept ones. */
export function truncatedCounts(kept, hidden) {
  const total = { parties: hidden.length, agents: 0, active: 0, urgent: 0 };
  const add = (counts) => { total.agents += counts.agents; total.active += counts.active; total.urgent += counts.urgent; };
  for (const party of hidden) { add(countActors(party.agents)); add(party.hidden); }
  for (const party of kept) add(party.hidden);
  return total;
}

/**
 * Rebuild sessions from records already in time order. Pure, so tests can drive it directly.
 * Returns { sessions, truncated }: truncated counts what the session and subagent caps left out.
 */
export function buildClaudeFeed(records, { now = Date.now(), limits = CLAUDE_LIMITS } = {}) {
  const sessions = new Map();
  for (const record of records) {
    let session = sessions.get(record.session);
    if (!session) {
      session = { id: record.session, cwd: record.cwd || "", startedAt: record.at, updatedAt: record.at, main: null, children: new Map() };
      sessions.set(record.session, session);
    }
    session.updatedAt = Math.max(session.updatedAt, record.at);
    if (record.cwd) session.cwd = record.cwd;
    // Subagent lifecycle and steps belong to the child; everything else to the session's own goblin.
    const childEvent = record.agent && record.event !== "SessionStart" && record.event !== "SessionEnd" && record.event !== "UserPromptSubmit";
    if (childEvent) {
      let child = session.children.get(record.agent);
      if (!child) { child = newActor(record.session, record.agent, record); session.children.set(record.agent, child); }
      applyRecord(child, record);
    } else {
      session.main ||= newActor(record.session, "", record);
      applyRecord(session.main, record);
      if (record.event === "SessionEnd" || record.notice === IDLE_NOTICE) for (const child of session.children.values()) closeTurn(child, "interrupted");
    }
  }
  // Every actor is classified before any cut, so the caps drop quiet history, never someone waiting.
  const built = [...sessions.values()].filter((session) => !limits.catalogMs || now - session.updatedAt <= limits.catalogMs).map((session) => {
    const project = projectName(session.cwd);
    const name = `Claude · ${project || "session"} · ${shortHash(session.id)}`;
    const main = session.main ? toActor(session.main, { now, limits, sessionName: name }) : null;
    const children = [...session.children.values()].map((child) => toActor(child, { now, limits, sessionName: name }));
    // The session's own goblin always stays; subagents fill the remaining places by urgency, then recency.
    const { kept, hidden } = keepMostUrgent(children, Math.max(0, limits.children));
    return {
      id: claudePartyId(session.id), session: session.id, name, cwd: session.cwd, updatedAt: session.updatedAt,
      agents: [...(main ? [main] : []), ...kept], hidden: countActors(hidden), rank: partyRank([...(main ? [main] : []), ...children]),
    };
  });
  const { kept, hidden } = keepMostUrgent(built, limits.sessions, (session) => session.rank);
  return { sessions: kept.map(({ rank, ...session }) => session), truncated: truncatedCounts(kept, hidden) };
}

/** Rebuild sessions from records already in time order. Pure, so tests can drive it directly. */
export function buildClaudeSessions(records, options) {
  return buildClaudeFeed(records, options).sessions;
}

/** Parse stored lines: malformed, oversized, foreign, and repeated records are skipped. */
export function parseClaudeLines(text, { limits = CLAUDE_LIMITS, seen = new Set() } = {}) {
  const records = [];
  let skipped = 0;
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    if (line.length > limits.lineChars) { skipped++; continue; }
    let record;
    try { record = cleanRecord(JSON.parse(line)); } catch { record = null; }
    if (!record) { skipped++; continue; }
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    records.push(record);
  }
  return { records, skipped };
}

export class ClaudeReader {
  constructor({ dir = claudeActivityDir(), ttlMs = 1000, limits = CLAUDE_LIMITS, clock = Date.now } = {}) {
    this.dir = dir;
    this.ttlMs = ttlMs;
    this.limits = limits;
    this.clock = clock;
    this.cached = null;
    this.cachedAt = 0;
    this.fingerprint = "";
    this.records = [];
  }

  readFiles() {
    const texts = [];
    let fingerprint = "";
    let warning = "";
    for (const name of ["activity.1.jsonl", "activity.jsonl"]) {
      const file = join(this.dir, name);
      try {
        const info = statSync(file);
        fingerprint += `${name}:${info.size}:${info.mtimeMs};`;
        // Bounded reads: anything past twice the roll-over size is read from its newest end.
        texts.push(readFileTail(file, this.limits.rotateBytes * 2));
      } catch (error) {
        if (error.code !== "ENOENT") warning = "Claude Code activity could not be read.";
      }
    }
    return { texts, fingerprint, warning };
  }

  snapshot() {
    const now = this.clock();
    if (this.cached && now - this.cachedAt < this.ttlMs) return this.cached;
    const { texts, fingerprint, warning } = this.readFiles();
    if (fingerprint !== this.fingerprint) {
      const seen = new Set();
      const parsed = texts.flatMap((text) => parseClaudeLines(text, { limits: this.limits, seen }).records);
      // Hooks for parallel tools can land a moment out of order; a stable sort keeps ties in file order.
      this.records = parsed.sort((a, b) => a.at - b.at).slice(-this.limits.records);
      this.fingerprint = fingerprint;
    }
    const { sessions, truncated } = buildClaudeFeed(this.records, { now, limits: this.limits });
    this.cached = { sessions, truncated, warning, recordCount: this.records.length };
    this.cachedAt = now;
    return this.cached;
  }

  listSessions() {
    return this.snapshot().sessions.map(({ id, name, cwd, updatedAt, agents }) => ({ id, name, cwd, updatedAt, source: "claude", agentCount: agents.length,
      model: agents[0]?.model || null }));
  }

  scene(id) {
    if (!/^claude:[A-Za-z0-9_-]{1,128}$/.test(String(id))) return null;
    const snapshot = this.snapshot();
    const session = snapshot.sessions.find((item) => item.id === id);
    if (!session) return null;
    return {
      root: { id, source: "claude", name: session.name, cwd: session.cwd, status: session.agents[0]?.status || "unknown", updatedAt: session.updatedAt,
        turns: 0, turnStates: [], activities: [], latest: null, counts: emptyCounts() },
      agents: session.agents, requests: [], replyAvailable: false, ...partyCoverage(session, snapshot.warning, "subagent"),
    };
  }
}

/** A focused party's own coverage: how many members it shows and how many the cap left out. */
export function partyCoverage(party, sourceWarning = "", noun = "member") {
  const hidden = party.hidden || { agents: 0, active: 0, urgent: 0 };
  const plural = (count) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  const gap = hidden.active ? `${plural(hidden.active)} still active ${hidden.active === 1 ? "was" : "were"} left out of this party view.` : "";
  return {
    warning: [sourceWarning, gap].filter(Boolean).join(" "),
    coverage: { agentsShown: party.agents.length, agentsHidden: hidden.agents, activeHidden: hidden.active, urgentHidden: hidden.urgent,
      complete: !sourceWarning && !hidden.active },
  };
}

/**
 * The newest `maxBytes` of a file without reading the rest. When the read starts mid-file, the
 * partial first line is dropped; a tail with no line break at all is one partial line, so nothing
 * is returned. Cutting at a newline byte never splits a UTF-8 character.
 */
export function readFileTail(file, maxBytes) {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const count = readSync(fd, buffer, read, length - read, start + read);
      if (!count) break;
      read += count;
    }
    let bytes = buffer.subarray(0, read);
    if (start > 0) {
      const newline = bytes.indexOf(0x0a);
      bytes = newline < 0 ? bytes.subarray(0, 0) : bytes.subarray(newline + 1);
    }
    return bytes.toString("utf8");
  } finally { closeSync(fd); }
}
