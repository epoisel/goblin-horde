/**
 * A temporary T3 database for tests, with the table and column shapes of T3's real statev2.sqlite. Every row
 * carries text that must never leave the reader: a secret-looking key, a prompt-like message, a project title,
 * and an agent label inside its id, the way T3's composite ids can carry one.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sqlite = await import("node:sqlite").catch(() => null);

/** Whether this Node.js has node:sqlite; tests that need it skip without it. */
export const hasSqlite = Boolean(sqlite);

export const TRAP = Object.freeze({
  secret: "sk-live-TRAPKEY7f3a9c2e81d04b65",
  prompt: "Please move the payroll export to the shared finance drive tonight",
  title: "Project Nightingale Payroll",
  label: "nightingale-payroll-review",
});

const COLUMNS = {
  orchestration_v2_projection_provider_turns: [
    "provider_turn_id TEXT PRIMARY KEY", "thread_id TEXT NOT NULL", "provider_thread_id TEXT NOT NULL", "node_id TEXT NOT NULL",
    "run_attempt_id TEXT", "ordinal INTEGER NOT NULL", "status TEXT NOT NULL", "started_at TEXT", "completed_at TEXT", "payload_json TEXT NOT NULL",
  ],
  orchestration_v2_projection_subagents: [
    "subagent_id TEXT PRIMARY KEY", "thread_id TEXT NOT NULL", "run_id TEXT", "parent_node_id TEXT NOT NULL", "provider TEXT NOT NULL",
    "provider_thread_id TEXT", "child_thread_id TEXT", "origin TEXT NOT NULL", "status TEXT NOT NULL", "started_at TEXT", "completed_at TEXT",
    "updated_at TEXT NOT NULL", "payload_json TEXT NOT NULL", "driver TEXT", "provider_instance_id TEXT", "completion_delivery_state TEXT",
  ],
};

/** Token usage as T3 records it on a turn. */
export const usage = (inputTokens, outputTokens, cachedInputTokens = 0, usageStatus = "complete") => ({ inputTokens, cachedInputTokens, outputTokens, usageStatus });

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const trapPayload = (extra) => JSON.stringify({
  ...extra,
  apiKey: TRAP.secret,
  project: { title: TRAP.title },
  messages: [{ role: "user", text: TRAP.prompt }],
});

/**
 * A WAL database in a new temp folder (or `dir`). `omit` drops columns, as "table.column", to model schema drift.
 * Times are epoch milliseconds; a turn's `usage` of null leaves turnTokenUsage out of its payload.
 */
export function createT3Fixture({ dir = mkdtempSync(join(tmpdir(), "goblin-t3-")), omit = [] } = {}) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "statev2.sqlite");
  const db = new sqlite.DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  for (const [table, columns] of Object.entries(COLUMNS)) {
    db.exec(`CREATE TABLE ${table} (${columns.filter((column) => !omit.includes(`${table}.${column.split(" ")[0]}`)).join(", ")})`);
  }
  const insert = (table, columns, values) => db.prepare(`INSERT INTO ${table} (${columns}) VALUES (${values.map(() => "?").join(", ")})`).run(...values);
  let ordinal = 0;
  return {
    dir,
    path,
    addTurn({ id, completedAt, status = "completed", tokens = usage(50_000, 2_000) }) {
      ordinal += 1;
      insert("orchestration_v2_projection_provider_turns",
        "provider_turn_id, thread_id, provider_thread_id, node_id, ordinal, status, started_at, completed_at, payload_json",
        [`provider-turn:${id}:${TRAP.label}`, "thread-1", TRAP.title, "node-1", ordinal, status, iso((completedAt ?? Date.now()) - 1_000),
          iso(completedAt), trapPayload(tokens ? { turnTokenUsage: tokens, prompt: TRAP.prompt } : { prompt: TRAP.prompt })]);
    },
    addSubagent({ id, completedAt, status = "completed" }) {
      insert("orchestration_v2_projection_subagents",
        "subagent_id, thread_id, parent_node_id, provider, origin, status, started_at, completed_at, updated_at, payload_json",
        [`subagent:${id}:${TRAP.label}`, "thread-1", "node-1", "codex", TRAP.prompt, status, iso((completedAt ?? Date.now()) - 1_000),
          iso(completedAt), iso(completedAt ?? Date.now()), trapPayload({ task: TRAP.prompt })]);
    },
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
