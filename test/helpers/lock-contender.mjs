/**
 * One real process that wants the saved game's lock, for the test of several at once.
 *
 *   node lock-contender.mjs <state folder> <stale ms>
 *
 * It prints "ready", waits for a line on standard input, then tries for the lock in the folder, watching a
 * holder for as long as it takes to call it gone. It prints { pid, ok } and, when it took the lock, holds it
 * with a heartbeat until standard input ends, as a running game would. Run with no folder, as the test runner
 * runs every file in this folder, it does nothing.
 */
import { createPetsLock } from "../../lib/pets-lock.mjs";

const [dir, staleMs] = process.argv.slice(2);
if (dir) {
  const lock = createPetsLock({ dir, staleMs: Number(staleMs), lookMs: 25, beatMs: 100 });
  process.stdin.once("data", async () => {
    const { ok } = await lock.acquire();
    process.stdout.write(`${JSON.stringify({ pid: process.pid, ok })}\n`);
  });
  process.stdin.on("end", () => {
    lock.release();
    process.exit(0);
  });
  process.stdout.write("ready\n");
}
