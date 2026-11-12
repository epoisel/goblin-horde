/**
 * One writer for pets.json: the lock file pets.lock in the state folder.
 *
 * The process that may load and save the game creates pets.lock with its process id, its start time, and the
 * port its viewer answers on. Creating it is exclusive, so of two that try at once only one holds it.
 *
 * A holder shows it is alive with a heartbeat: every few seconds it touches the lock file, which changes the
 * file's modified time. Nobody reads that time as a time. Whoever wants the lock remembers the modified time it
 * last read and counts, on its own clock that no change of the date moves, how long the file has shown the same
 * one. A lock that showed an observer no new heartbeat for 20 seconds is stale and is taken over, whatever its
 * process id says, because Windows hands a freed process id to the next program and a stopped process still has
 * its id. A date on the file that is an hour ahead or an hour behind changes nothing. So one look never frees a
 * lock whose process id is alive: whoever wants it watches it, for as long as it takes to see a heartbeat or 20
 * seconds without one. A touch never changes who holds the lock, so a holder that wakes late cannot take it back
 * by beating.
 *
 * Two things free a lock at once, because they are definite: its process is gone, or the viewer on the port it
 * names is not that process.
 */
import { readFileSync, rmSync } from "node:fs";
import { mkdir, open, readFile, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { answerJson, askLocal } from "./local-viewer.mjs";
import { isAlive } from "./processes.mjs";

/** @typedef {{ pid: number, startedAt: number, port?: number }} Holder */

export const LOCK_FILE = "pets.lock";
/** The `code` of the error a reward engine throws when another process holds the lock. */
export const LOCKED = "PETS_LOCKED";
export const HELD_MESSAGE = "Another Goblin Horde on this computer already runs the game.";

const WRITE_MS = 5000;
const BEAT_MS = 5000;
const STALE_MS = 20_000;
const LOOK_MS = 500;
// Windows answers these, not EEXIST, for a file another process is deleting at this moment.
const BUSY = new Set(["EPERM", "EACCES", "EBUSY"]);
const processStart = Math.round(Date.now() - process.uptime() * 1000);
const whole = (value) => Number.isInteger(value) && value > 0;
// This process's own clock, in milliseconds. It only ever goes forward, whatever the computer's date is set to.
const ownClock = () => performance.now();

function parseHolder(text) {
  try {
    const { pid, startedAt, port } = JSON.parse(text);
    return whole(pid) && Number.isFinite(startedAt) ? { pid, startedAt, ...(whole(port) ? { port } : {}) } : null;
  } catch { return null; }
}

/**
 * Whether the viewer a lock names still runs. Only a definite no counts as no: nothing listens on the lock's
 * port, or what answers there is not that process. A viewer that does not finish its answer in time is not a
 * definite no, and neither is a holder that named no port. Their heartbeat decides.
 * @param {Holder} holder
 */
export async function viewerHolds({ pid, port }, { timeoutMs = 1500 } = {}) {
  if (!port) return true;
  const answer = await askLocal(port, "/api/health", { timeoutMs });
  return answer.status ? answerJson(answer)?.pid === pid : !answer.refused;
}

/** A file's heartbeat: its modified time, kept as the text it is, to be compared and never to be read as a time. "" for no file. */
const beatOf = async (path) => { try { return String((await stat(path, { bigint: true })).mtimeNs); } catch { return ""; } };

/**
 * What one observer has seen of the files it watches. `look` notes what the file at `path` shows now, its text
 * and its heartbeat, and answers how long, on `monotonic`, it has shown exactly that, and whether its heartbeat
 * was ever seen to change while its text stayed the same. A file seen for the first time has shown what it
 * shows for no time at all.
 * @param {() => number} monotonic
 */
function createWatch(monotonic) {
  const seen = new Map();
  return {
    async look(path, text) {
      const beat = await beatOf(path);
      const last = seen.get(path);
      if (last?.text === text && last.beat === beat) return { unchangedMs: monotonic() - last.since, beating: last.beating };
      const beating = last?.text === text;
      seen.set(path, { text, beat, since: monotonic(), beating });
      return { unchangedMs: 0, beating };
    },
  };
}

/**
 * What an observer makes of a lock with a readable holder. It is `held` unless that holder is definitely gone or
 * has shown this observer no heartbeat for `staleMs`. `beating` says a heartbeat was seen, so the holder is alive.
 */
async function sight(path, text, holder, { alive, confirm, staleMs, watch }) {
  if (!alive(holder.pid) || !(await confirm(holder))) return { held: false, beating: false };
  const { unchangedMs, beating } = await watch.look(path, text);
  return { held: unchangedMs < staleMs, beating };
}

/**
 * The process that holds the lock in `dir`, or null when nobody does: no lock, a holder that is gone, or one
 * whose viewer is not on its port. One look cannot say that a heartbeat has stopped, so a holder whose process id
 * is alive is answered as the holder. With `wait`, the lock is watched instead: until a heartbeat is seen, which
 * answers the holder at once, or until none came for `staleMs`, which answers null.
 * @returns {Promise<Holder | null>}
 */
export async function lockHolder(dir, { alive = isAlive, confirm = viewerHolds, staleMs = STALE_MS, wait = false, lookMs = LOOK_MS,
  monotonic = ownClock, pause = sleep } = {}) {
  const path = join(dir, LOCK_FILE);
  const watch = createWatch(monotonic);
  const until = monotonic() + (wait ? staleMs + lookMs : 0);
  for (;;) {
    const text = await readFile(path, "utf8").catch(() => "");
    const holder = parseHolder(text);
    if (!holder) return null;
    const { held, beating } = await sight(path, text, holder, { alive, confirm, staleMs, watch });
    if (!held) return null;
    if (beating || monotonic() >= until) return holder;
    await pause(lookMs);
  }
}

/**
 * Remove the stale lock whose text is `text`. Several processes can find the same stale lock, and one that
 * removed it late would remove the new lock made meanwhile. So only the process that creates the takeover
 * marker removes anything, and only a lock that still has the text it found and is still stale.
 */
async function removeStale(path, text, stillStale, { watch, writeMs }) {
  const marker = `${path}.takeover`;
  let handle;
  try { handle = await open(marker, "wx"); } catch (error) {
    if (error.code !== "EEXIST" && !BUSY.has(error.code)) throw error;
    // A takeover lasts milliseconds, so a marker this observer has seen sit there for seconds is from a process that died in the middle of one.
    if ((await watch.look(marker, "")).unchangedMs < writeMs) await sleep(20);
    else await rm(marker, { force: true }).catch(() => {});
    return;
  }
  try {
    if ((await readFile(path, "utf8").catch(() => null)) === text && await stillStale()) await rm(path, { force: true });
  } finally {
    await handle.close();
    await rm(marker, { force: true });
  }
}

/** One try for the lock: `{ ok: true }`, or who holds it and whether that holder was seen to beat. */
async function take(path, holder, options) {
  const mine = JSON.stringify(holder);
  for (let tries = 0; tries < 6; tries += 1) {
    try {
      const handle = await open(path, "wx");
      try { await handle.writeFile(mine); } finally { await handle.close(); }
      return { ok: true };
    } catch (error) {
      if (BUSY.has(error.code)) { await sleep(20); continue; }
      if (error.code !== "EEXIST") throw error;
    }
    const text = await readFile(path, "utf8").catch(() => null);
    if (text === null) continue;
    if (text === mine) return { ok: true };
    const current = parseHolder(text);
    const look = async () => {
      // A lock with no readable holder is one being written right now, unless this observer has seen it sit there for seconds.
      if (!current) return { held: (await options.watch.look(path, text)).unchangedMs < options.writeMs, beating: false };
      // A lock an earlier process left under this process's own id is nobody's.
      return current.pid === holder.pid ? { held: false, beating: false } : sight(path, text, current, options);
    };
    const seen = await look();
    if (seen.held) return { ok: false, holder: current, beating: seen.beating };
    await removeStale(path, text, async () => !(await look()).held, options);
  }
  return { ok: false, holder: null, beating: false };
}

/**
 * This process's lock over pets.json in `dir`. `port` is the port its viewer answers on, when it is a viewer.
 * `acquire` takes the lock or names its holder, and starts the heartbeat that keeps it. Since one look cannot say
 * whether a holder still runs, `acquire` watches a holder until it knows: it answers the holder as soon as it has
 * seen the holder's heartbeat, which a running one shows within seconds, and it takes the lock once the holder
 * has shown none for `staleMs`. `acquire({ wait: false })` looks once and answers the holder when it cannot tell.
 * It remembers what it saw, so asking again later is another way to come to know that a holder stopped. `wait`
 * here sets which of the two `acquire` does when it is not told. `held` says whether this process still holds the
 * lock, and `release` stops the heartbeat and gives the lock up at once, so it can run while the process exits.
 * `setTimer` and `clearTimer` schedule the heartbeat, as setInterval does. `monotonic` is the clock a holder is
 * watched on, and `pause` waits between two looks.
 * @param {{ dir: string, port?: number, pid?: number, startedAt?: number, alive?: (pid: number) => boolean, confirm?: (holder: Holder) => Promise<boolean>,
 *   beatMs?: number, staleMs?: number, writeMs?: number, lookMs?: number, wait?: boolean, setTimer?: typeof setInterval, clearTimer?: typeof clearInterval,
 *   monotonic?: () => number, pause?: (ms: number) => Promise<unknown> }} options
 * @returns {{ acquire(options?: { wait?: boolean }): Promise<{ ok: true } | { ok: false, holder: Holder | null }>, held(): Promise<boolean>, release(): void }}
 */
export function createPetsLock({ dir, port, pid = process.pid, startedAt = processStart, alive = isAlive, confirm = viewerHolds,
  beatMs = BEAT_MS, staleMs = STALE_MS, writeMs = WRITE_MS, lookMs = LOOK_MS, wait: patient = true, setTimer = setInterval, clearTimer = clearInterval,
  monotonic = ownClock, pause = sleep }) {
  const path = join(dir, LOCK_FILE);
  const holder = { pid, startedAt, ...(whole(port) ? { port } : {}) };
  const mine = JSON.stringify(holder);
  const observer = { alive, confirm, staleMs, writeMs, watch: createWatch(monotonic) };
  let timer = null;
  const held = async () => (await readFile(path, "utf8").catch(() => "")) === mine;
  function stopBeating() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  // A beat only touches the file. When the lock is another holder's by now, there is nothing of this one's to keep.
  async function beat() {
    if (!(await held())) return stopBeating();
    // Released while this beat was reading the file: a lock that was given up is not touched again.
    if (timer === null) return;
    // The date it writes comes from this process's own clock, which only goes forward, so every beat changes the file's modified time.
    const at = new Date(performance.timeOrigin + performance.now());
    await utimes(path, at, at).catch(() => {});
  }
  return {
    async acquire({ wait = patient } = {}) {
      await mkdir(dir, { recursive: true });
      const until = monotonic() + (wait ? Math.max(staleMs, writeMs) + lookMs : 0);
      for (;;) {
        const result = await take(path, holder, observer);
        if (result.ok || result.beating || monotonic() >= until) {
          if (result.ok && timer === null) {
            timer = setTimer(() => beat().catch(() => {}), beatMs);
            timer?.unref?.();
          }
          return result.ok ? { ok: true } : { ok: false, holder: result.holder };
        }
        await pause(lookMs);
      }
    },
    held,
    release() {
      stopBeating();
      try { if (readFileSync(path, "utf8") === mine) rmSync(path, { force: true }); } catch { /* Not ours, or gone already. */ }
    },
  };
}
