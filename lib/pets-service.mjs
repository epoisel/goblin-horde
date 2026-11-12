/**
 * The pet game's lifecycle around the reward engine: open the saved game, pay finished work on a timer, and
 * keep the last few things worth a pop-up.
 *
 * The engine keeps no timers and its start() fails when the save cannot be read, so this owns both. A failed
 * start is tried again every 30 seconds, as is one refused because another Goblin Horde on this computer holds
 * the saved game, or because the saved game is there and cannot be read. No game is made in its place: the
 * service says so until the owner has moved the file away. Once the game is open finished work is paid every `tickMs`. The
 * launch summary and each check that pays become numbered events in a bounded list, so the widget asks only
 * for what is newer than the last number it showed. An event holds counts, never an id or text.
 */

import { randomBytes } from "node:crypto";
import { HELD_MESSAGE, LOCKED } from "./pets-lock.mjs";
import { UNREADABLE, UNREADABLE_MESSAGE } from "./pets-store.mjs";

/**
 * @typedef {{ ok: true } | { ok: false, reason: string, message: string }} SourceStatus
 * @typedef {{ seq: number, at: number, type: "work", coins: number, xp: number, turns: number, subagents: number }} WorkEvent
 * @typedef {{ seq: number, at: number, type: "launch", welcome: boolean, away: { minutes: number, coins: number } | null,
 *   caughtUp: { turns: number, coins: number } }} LaunchEvent
 * @typedef {{ ready: true, boot: string, seq: number, source: SourceStatus } | { ready: false, reason: string, message: string }} PetsStatus
 *   `boot` names this run of the service, so a client can tell when event numbers began again at 1. `seq` is the
 *   newest event's number, 0 when there is none. `reason` is a short code for why there is no game, which another
 *   computer can say in its own words, and `message` is this computer's sentence for it.
 */

const RETRY_MS = 30_000;

const OPENING = { reason: "opening", message: "Goblin Horde is opening your saved game." };
// What a caller is told while there is no game to show, by phase.
const WAITING = {
  off: { reason: "off", message: "The game is off because game_config.json could not be read, so install Goblin Horde again to bring it back." },
  idle: OPENING,
  opening: OPENING,
  retrying: { reason: "retrying", message: "Goblin Horde could not open your saved game, so it will try again in 30 seconds." },
  locked: { reason: "locked", message: HELD_MESSAGE },
  unreadable: { reason: "unreadable", message: UNREADABLE_MESSAGE },
  stopped: { reason: "stopped", message: "The game stopped because Goblin Horde is closing." },
};
// The phase a start that was refused leads to, by the error's code. Any other failure is "retrying".
const REFUSED = { [LOCKED]: "locked", [UNREADABLE]: "unreadable" };
const CHECK_FAILED = { ok: false, reason: "error", message: "Goblin Horde could not check for finished work, so it will try again on the next check." };

const firstLine = (error) => String(error?.message || error).split(/\r?\n/)[0];

/**
 * The game service over `engine` (a reward engine), or over null when the game could not be set up. It then
 * stays off and only says why. `setTimer` and `clearTimer` schedule a repeating call, as setInterval does.
 * @param {{ engine: ReturnType<typeof import("./reward-engine.mjs").createRewardEngine> | null, tickMs?: number, ringSize?: number,
 *   now?: () => number, setTimer?: typeof setInterval, clearTimer?: typeof clearInterval, log?: (line: string) => void }} options
 */
export function createPetsService({ engine, tickMs = 1000, ringSize = 50, now = Date.now, setTimer = setInterval, clearTimer = clearInterval, log = console.error }) {
  /** @type {"off" | "idle" | "opening" | "retrying" | "locked" | "unreadable" | "ready" | "stopped"} */
  let phase = engine ? "idle" : "off";
  let timer = null;
  let running = false;
  const boot = randomBytes(4).toString("hex");
  let seq = 0;
  /** @type {SourceStatus | null} */
  let source = null;
  let reported = "";
  /** @type {(WorkEvent | LaunchEvent)[]} */
  const events = [];

  function record(type, fields) {
    seq += 1;
    events.push({ seq, at: now(), type, ...fields });
    if (events.length > ringSize) events.shift();
  }

  // A problem that repeats on every try is logged once, until the step works again. `failed` is told the error.
  async function attempt(work, problem, failed = () => {}) {
    try {
      const value = await work();
      reported = "";
      return value;
    } catch (error) {
      const line = `${problem}: ${firstLine(error)}`;
      if (line !== reported) log(line);
      reported = line;
      failed(error);
      return null;
    }
  }

  // A phase and its timer change together, and never after stop().
  function enter(next, ms) {
    if (phase === "stopped") return;
    phase = next;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(step, ms);
    timer?.unref?.();
  }

  async function check() {
    const result = (await attempt(() => engine.tick(), "The pet game could not check for finished work")) ?? CHECK_FAILED;
    if (!result.ok) {
      source = { ok: false, reason: result.reason, message: result.message };
      return;
    }
    source = { ok: true };
    const { coins, xp, turns, subagents } = result;
    if (coins > 0 || xp > 0 || turns > 0 || subagents > 0) record("work", { coins, xp, turns, subagents });
  }

  async function open() {
    let waiting = "retrying";
    const launch = await attempt(() => engine.start(), "The pet game could not open its saved game and will try again in 30 seconds",
      (error) => { waiting = REFUSED[error?.code] ?? "retrying"; });
    if (!launch) {
      if (phase !== waiting) enter(waiting, RETRY_MS);
      return;
    }
    // Stopped while the game was opening: the engine is closing, so there is nothing more to ask of it.
    if (phase === "stopped") return;
    const { welcome, away, caughtUp } = launch;
    if (welcome || away || caughtUp.coins > 0) record("launch", { welcome, away, caughtUp });
    // The first check runs before the game is ready, so a ready game always knows its source's state.
    await check();
    enter("ready", tickMs);
  }

  // A timer that fires while the last step still runs is skipped, so steps never overlap.
  async function step() {
    if (running) return;
    running = true;
    try { await (phase === "ready" ? check() : open()); } finally { running = false; }
  }

  return {
    /** Open the saved game and start paying finished work. The promise settles after the first try and never rejects. */
    async begin() {
      if (phase !== "idle") return;
      phase = "opening";
      await step();
    },

    /**
     * Stop the timer and give up the saved game. A step already running finishes, and nothing runs after it. The
     * promise settles once the engine has closed, which is after its last save, so wait for it before exiting.
     */
    async stop() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      phase = "stopped";
      await engine?.close?.();
    },

    /** @returns {PetsStatus} */
    status: () => (phase === "ready" ? { ready: true, boot, seq, source } : { ready: false, ...WAITING[phase] }),

    /** The engine's snapshot. Only for a ready service. */
    game: () => engine.snapshot(),

    /** The events numbered above `after`, oldest first. @returns {(WorkEvent | LaunchEvent)[]} */
    eventsAfter: (after) => events.filter((event) => event.seq > after),

    /** A purchase and a fight go straight to the engine. Only for a ready service. */
    buy: (kind) => engine.buy(kind),
    fight: (boss) => engine.fight(boss),
  };
}
