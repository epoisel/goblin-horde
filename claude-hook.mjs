#!/usr/bin/env node
/**
 * Claude Code hook receiver for Goblin Horde.
 *
 * Reads one hook payload from stdin and appends a short public record to Goblin Horde's own
 * state folder. It needs no network and no running viewer, prints nothing (some hook events add
 * stdout to Claude's context), and always exits 0 so Claude Code is never blocked or slowed.
 */
const MAX_INPUT = 32 * 1024 * 1024; // Tool output can be large; anything bigger is skipped, not parsed.
const WAIT_MS = 5000;

// The installer passes `--state-dir <absolute path>` so the hook writes where that installation reads,
// whatever environment Claude Code runs it in. `--goblin-horde-hook` only marks the entry for removal.
const stateFlag = process.argv.indexOf("--state-dir");
const stateDir = stateFlag > 0 ? String(process.argv[stateFlag + 1] || "") : "";

let finished = false;
const chunks = [];
let size = 0;

async function finish() {
  if (finished) return;
  finished = true;
  try {
    if (size > 0 && size <= MAX_INPUT) {
      const { appendClaudeRecord, claudeActivityDir, normalizeHookEvent, transcriptModel } = await import("./lib/claude.mjs");
      const { isAbsolute, join } = await import("node:path");
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const record = normalizeHookEvent(input);
      // Only the model id is read from the transcript, so the goblin can name its model.
      if (record && !record.model) {
        const model = transcriptModel(input);
        if (model) record.model = model;
      }
      const dir = stateDir && isAbsolute(stateDir) ? join(stateDir, "claude") : claudeActivityDir();
      if (record) appendClaudeRecord(record, { dir });
    }
  } catch { /* A hook that cannot record simply records nothing. */ }
  process.exit(0);
}

process.on("uncaughtException", () => process.exit(0));
process.on("unhandledRejection", () => process.exit(0));
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
process.stdin.on("data", (chunk) => {
  size += chunk.length;
  if (size <= MAX_INPUT) chunks.push(chunk);
  else chunks.length = 0;
});
process.stdin.on("end", finish);
process.stdin.on("error", finish);
setTimeout(finish, WAIT_MS);
