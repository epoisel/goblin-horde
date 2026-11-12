/**
 * The T3 Code source: finished turns and subagents, read from T3's own database without ever writing it.
 *
 * T3 keeps its state in ~/.t3/userdata/statev2.sqlite, a WAL database it writes while this reads. The query
 * selects only statuses, timestamps, ids and token counts. SQLite's json_extract pulls the counts out of
 * payload_json inside the query, so no payload text reaches JavaScript. T3's composite ids can carry agent
 * labels, so an id leaves this module only as a short hash. T3's schema is internal and unversioned, so
 * openT3 checks every table and column the query reads and fails closed.
 *
 * The raw event log is compacted away, so a watermark replaces a cursor: the newest finish time read, plus
 * the ids already paid inside a slack window before it, for rows that land with a slightly older time.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * @typedef {{ id: string, kind: "turn" | "subagent", at: number, outcome: string, inputTokens?: number, cachedInputTokens?: number, outputTokens?: number }} WorkEvent
 *   `at` is the finish time in epoch milliseconds. A turn's `outcome` is its T3 status; a completed subagent's is "subagent".
 * @typedef {{ at: number, seen: string[] }} Watermark
 * @typedef {{ ok: false, reason: "missing" | "locked" | "schema", message: string }} SourceFailure
 */

export const SLACK_MS = 10 * 60_000;
const LIMIT = 500;

const TURNS = "orchestration_v2_projection_provider_turns";
const SUBAGENTS = "orchestration_v2_projection_subagents";
const REQUIRED = { [TURNS]: ["provider_turn_id", "status", "completed_at", "payload_json"], [SUBAGENTS]: ["subagent_id", "status", "completed_at"] };

// Only complete usage counts, and only numbers leave SQLite; anything else pays the floor.
const count = (field) => `CASE WHEN typeof(json_extract(usage, '$.${field}')) IN ('integer', 'real') THEN json_extract(usage, '$.${field}') END AS ${field}`;
const FINISHED = `
  WITH finished AS (
    SELECT 'turn' AS kind, provider_turn_id AS key, status AS outcome, completed_at,
      CASE WHEN json_valid(payload_json) THEN payload_json END AS payload
    FROM ${TURNS} WHERE completed_at IS NOT NULL
    UNION ALL
    SELECT 'subagent', subagent_id, CASE status WHEN 'completed' THEN 'subagent' ELSE status END, completed_at, NULL
    FROM ${SUBAGENTS} WHERE completed_at IS NOT NULL
  ), timed AS (
    SELECT kind, key, outcome, CAST(round((julianday(completed_at) - 2440587.5) * 86400000) AS INTEGER) AS at,
      CASE WHEN json_extract(payload, '$.turnTokenUsage.usageStatus') = 'complete' THEN json_extract(payload, '$.turnTokenUsage') END AS usage
    FROM finished
  )
  SELECT kind, key, outcome, at, ${["inputTokens", "cachedInputTokens", "outputTokens"].map(count).join(", ")}
  FROM timed WHERE at > ? ORDER BY at, kind, key LIMIT ?`;

const MESSAGES = {
  missing: "T3 Code's database was not found, so open T3 Code once on this computer and Goblin Horde will start counting its work.",
  locked: "T3 Code's database is busy right now, so Goblin Horde will try again on the next check.",
  schema: "T3 Code's database is not in a shape Goblin Horde can read, so counting stopped until Goblin Horde is updated for this T3 Code version.",
};
const NO_SQLITE = "This Node.js has no built-in SQLite, so install Node.js 22.13 or newer to earn coins from T3 Code.";
const BY_SQLITE_CODE = { 5: "locked", 6: "locked", 14: "missing" };

const failure = (reason, message = MESSAGES[reason]) => ({ ok: false, reason, message });
const readFailure = (error) => failure(BY_SQLITE_CODE[error?.errcode & 0xff] ?? "schema");

function closeQuietly(db) {
  try { db?.close(); } catch {}
}

/** T3's database under `home`. */
export const defaultT3Path = (home = homedir()) => join(home, ".t3", "userdata", "statev2.sqlite");

function missingColumn(db) {
  const columns = db.prepare("SELECT name FROM pragma_table_info(?)");
  for (const [table, needed] of Object.entries(REQUIRED)) {
    const present = new Set(columns.all(table).map((row) => row.name));
    if (!present.size) return table;
    const absent = needed.find((column) => !present.has(column));
    if (absent) return `${table}.${absent}`;
  }
  return null;
}

/**
 * Open T3's database read-only and check its schema. Never throws for an expected failure.
 * @returns {Promise<{ ok: true, db: import("node:sqlite").DatabaseSync } | SourceFailure>}
 */
export async function openT3(path = defaultT3Path()) {
  let sqlite;
  try { sqlite = await import("node:sqlite"); } catch { return failure("missing", NO_SQLITE); }
  if (!existsSync(path)) return failure("missing");
  let db;
  try {
    db = new sqlite.DatabaseSync(path, { readOnly: true });
    const gap = missingColumn(db);
    if (!gap) return { ok: true, db };
    closeQuietly(db);
    return failure("schema", `This T3 Code version has no ${gap} in its database, so counting stopped until Goblin Horde is updated to match it.`);
  } catch (error) {
    closeQuietly(db);
    return readFailure(error);
  }
}

const hashId = (kind, key) => createHash("sha256").update(`${kind}:${key}`).digest("base64url").slice(0, 16);

function toEvent({ kind, key, outcome, at, ...tokens }) {
  const counts = Object.entries(tokens).filter(([, value]) => Number.isFinite(value));
  return { id: hashId(kind, key), kind, at, outcome, ...Object.fromEntries(counts) };
}

/**
 * Turns and subagents that finished after `since - slackMs`, oldest first, at most `limit`. Rows with no
 * completed_at are still running and are skipped. Token counts appear only for complete usage.
 * @returns {WorkEvent[]}
 */
export function readFinished(db, since, { slackMs = SLACK_MS, limit = LIMIT } = {}) {
  return db.prepare(FINISHED).all(since - slackMs, limit).map(toEvent);
}

/** A new player's watermark: only work that finishes from `now` on pays. @returns {Watermark} */
export const initialWatermark = (now) => ({ at: now, seen: [] });

/** The events not already paid. */
export function unseen(watermark, events) {
  const seen = new Set(watermark.seen);
  return events.filter((event) => !seen.has(event.id));
}

/**
 * The watermark after a read. `events` is the whole read since `watermark.at - slackMs`, seen events included,
 * so an id it lacks has left the window. `at` moves to the newest finish but never past `now`, so a row stamped
 * ahead of this clock cannot stall reading, and `seen` keeps only the ids inside the new window.
 * @returns {Watermark}
 */
export function advance(watermark, events, { now, slackMs = SLACK_MS }) {
  const newest = events.reduce((latest, event) => Math.max(latest, event.at), -Infinity);
  const at = Math.max(watermark.at, Math.min(now, newest));
  return { at, seen: [...new Set(events.filter((event) => event.at > at - slackMs).map((event) => event.id))] };
}

// A full read that ends at or before `since` holds only rows already inside the window: its limit could hide a
// seen row and would never move the watermark, so it reads again with room for the whole window.
function readWindow(db, since, options) {
  for (let limit = options.limit; ; limit *= 2) {
    const events = readFinished(db, since, { ...options, limit });
    if (events.length < limit || events.at(-1).at > since) return events;
  }
}

/**
 * A reward source over T3's database. It opens the database on the first read and again after any failure,
 * and each read returns the unpaid events with the watermark that follows them. Never throws.
 */
export function t3Source(path = defaultT3Path(), { now = Date.now, slackMs = SLACK_MS, limit = LIMIT } = {}) {
  let db = null;
  const close = () => {
    closeQuietly(db);
    db = null;
  };
  return {
    async read(watermark) {
      if (!db) {
        const opened = await openT3(path);
        if (!opened.ok) return opened;
        db = opened.db;
      }
      try {
        const events = readWindow(db, watermark.at, { slackMs, limit });
        return { ok: true, events: unseen(watermark, events), watermark: advance(watermark, events, { now: now(), slackMs }) };
      } catch (error) {
        close();
        return readFailure(error);
      }
    },
    close,
  };
}
