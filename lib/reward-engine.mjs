/**
 * The reward engine: the single writer that turns finished AI work into game state and saves it.
 *
 * It reads finished work from a source, pays it with the reducers in rewards.mjs in finish order, and saves the
 * game and the source watermark as one record, so a payment and the mark that says it was paid land together
 * and a restart never pays twice. Every operation runs through one queue, so a tick and a purchase issued
 * together never interleave. The engine keeps no timers; the caller schedules tick().
 *
 * With a `lock` (lib/pets-lock.mjs) it is also the only writer among processes: start() takes the lock before it
 * loads the save, nothing is saved by an engine that no longer holds it, and close() gives the lock up only
 * after the last queued save has landed or failed.
 */
import {
  bossRequiredPower, buy as buyReducer, createState, fight as fightReducer, gearCost, hordePower, idlePayout,
  levelCosts, recruitCost, rollDay, turnPayout, upgradeCost,
} from "./rewards.mjs";
import { HELD_MESSAGE, LOCKED } from "./pets-lock.mjs";
import { initialWatermark } from "./t3-source.mjs";

/**
 * @typedef {import("./rewards.mjs").GameConfig} GameConfig
 * @typedef {import("./rewards.mjs").GameState} GameState
 * @typedef {import("./t3-source.mjs").WorkEvent} WorkEvent
 * @typedef {import("./t3-source.mjs").Watermark} Watermark
 * @typedef {import("./pets-store.mjs").PetsRecord} PetsRecord
 * @typedef {{ ok: false, reason: string, message: string }} Failure
 * @typedef {{ read(watermark: Watermark): Promise<{ ok: true, events: WorkEvent[], watermark: Watermark } | Failure> }} RewardSource
 * @typedef {{ ok: true, coins: number, xp: number, turns: number, subagents: number }} WorkBatch
 */

const DAY_MS = 86_400_000;
const pad = (value) => String(value).padStart(2, "0");

/** The local calendar date of `ms`, as YYYY-MM-DD. */
export function localDayKey(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Days only move forward: work that lands after its day was rolled past counts toward today.
const onDay = (state, key) => (key > state.today.key ? rollDay(state, key) : state);

const COUNTED = new Map([["completed", "turns"], ["subagent", "subagents"]]);

function payWork(config, state, events, dayKey) {
  return events.reduce((batch, event) => {
    const paid = turnPayout(config, onDay(batch.state, dayKey(event.at)), event);
    const counted = COUNTED.get(event.outcome);
    return { ...batch, state: paid.state, coins: batch.coins + paid.coins, xp: batch.xp + paid.xp, ...(counted && { [counted]: batch[counted] + 1 }) };
  }, { state, coins: 0, xp: 0, turns: 0, subagents: 0 });
}

const priced = (currency, amount) => (amount == null ? null : { [currency]: amount });
// The price buy() charges for each purchase, or null once it is maxed.
const QUOTES = {
  recruit: (config, state) => ({ coins: recruitCost(config, state) }),
  level: levelCosts,
  gear: (config, state) => priced("scrap", gearCost(config, state)),
  ...Object.fromEntries(["hoard", "training"].map((name) => [name, (config, state) => priced("coins", upgradeCost(config, state, name))])),
};

const sameWatermark = (a, b) => a.at === b.at && a.seen.length === b.seen.length && a.seen.every((id, index) => id === b.seen[index]);

/**
 * The engine over `store` (a pets store) and `source` (a RewardSource). Call start() once before anything else.
 * start() rejects with an error whose `code` is LOCKED while another process holds `lock`.
 * @param {{ config: GameConfig, store: ReturnType<typeof import("./pets-store.mjs").createPetsStore>, source: RewardSource,
 *   lock?: ReturnType<typeof import("./pets-lock.mjs").createPetsLock> | null, now?: () => number, random?: () => number,
 *   dayKey?: (ms: number) => string }} options
 */
export function createRewardEngine({ config, store, source, lock = null, now = Date.now, random = Math.random, dayKey = localDayKey }) {
  /** @type {PetsRecord | null} */
  let record = null;
  let sourceStatus = null;
  let queue = Promise.resolve();
  /** @type {Promise<void> | null} Set by close(): from then on the queue only drains. */
  let closing = null;

  const run = (operation) => {
    if (closing) return Promise.reject(new Error("Goblin Horde is closing, so the game takes no more changes."));
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const current = () => {
    if (!record) throw new Error("Call start() before using the reward engine.");
    return record;
  };
  async function mustHoldLock() {
    if (lock && !(await lock.held())) throw new Error("Goblin Horde stopped saving, because another Goblin Horde on this computer took over the saved game.");
  }
  // A record becomes current only once it is on disk, so a failed save loses nothing and pays nothing twice.
  // The lock is asked for before the save starts, and again by the store right before each file is put in place.
  async function persist(next) {
    await mustHoldLock();
    const saved = { ...next, lastSeenAt: now() };
    await store.save(saved, { before: mustHoldLock });
    record = saved;
  }

  // One read of new work. Work pays only when it finished after both floors: idle.catchUpDays ago, and the moment
  // this game began here (notBefore). That moment never moves, so a row T3 writes late cannot slip under the watermark.
  async function earn(from) {
    const floor = Math.max(now() - config.idle.catchUpDays * DAY_MS, from.notBefore ?? -Infinity);
    const { t3 } = from.sources;
    const read = await source.read(t3.at < floor ? { ...t3, at: floor } : t3);
    sourceStatus = read.ok ? { ok: true } : { ok: false, reason: read.reason, message: read.message };
    if (!read.ok) return sourceStatus;
    const batch = payWork(config, from.state, read.events.filter((event) => event.at > floor), dayKey);
    return { ok: true, batch, read: read.events.length, record: { ...from, state: batch.state, sources: { ...from.sources, t3: read.watermark } } };
  }

  async function apply(reduce) {
    const from = current();
    const result = reduce(onDay(from.state, dayKey(now())));
    if (result.state !== from.state) await persist({ ...from, state: result.state });
    return result;
  }

  return {
    /**
     * Load the save, or begin a new player who earns from now on. A returning player is paid the missed work
     * and then the idle trickle for the time since the last save. A new player begins only where the store finds
     * no saved game at all: for one that is there and cannot be read its load rejects, and so does this, with
     * nothing written.
     * @returns {Promise<{ welcome: boolean, away: { minutes: number, coins: number } | null, caughtUp: { turns: number, coins: number } }>}
     */
    start: () => run(async () => {
      if (lock && !(await lock.acquire()).ok) throw Object.assign(new Error(HELD_MESSAGE), { code: LOCKED });
      const at = now();
      const { record: saved } = await store.load();
      if (!saved) {
        // The game begins now, and the save says so: nothing that finished up to this moment is ever paid.
        await persist({ schema: 1, state: createState(config, dayKey(at)), sources: { t3: initialWatermark(at) }, lastSeenAt: at, notBefore: at });
        return { welcome: true, away: null, caughtUp: { turns: 0, coins: 0 } };
      }
      let next = saved;
      const caughtUp = { turns: 0, coins: 0 };
      for (let step = await earn(next); step.ok && step.read > 0; step = await earn(next)) {
        next = step.record;
        caughtUp.turns += step.batch.turns;
        caughtUp.coins += step.batch.coins;
      }
      const minutes = Math.max(0, (at - saved.lastSeenAt) / 60_000);
      const idle = idlePayout(config, onDay(next.state, dayKey(at)), minutes);
      await persist({ ...next, state: idle.state });
      return { welcome: false, away: idle.coins ? { minutes: Math.round(minutes), coins: idle.coins } : null, caughtUp };
    }),

    /**
     * Pay the work finished since the last read. A failed read or save changes nothing and is reported, not thrown.
     * @returns {Promise<WorkBatch | Failure>}
     */
    tick: () => run(async () => {
      const from = current();
      const step = await earn(from);
      if (!step.ok) return step;
      const next = { ...step.record, state: onDay(step.record.state, dayKey(now())) };
      if (next.state !== from.state || !sameWatermark(next.sources.t3, from.sources.t3)) {
        try { await persist(next); } catch (error) { return { ok: false, reason: "save", message: error.message }; }
      }
      const { coins, xp, turns, subagents } = step.batch;
      return { ok: true, coins, xp, turns, subagents };
    }),

    /** Buy one purchase of `kind` and save it. @returns {Promise<ReturnType<typeof buyReducer>>} */
    buy: (kind) => run(() => apply((state) => buyReducer(config, state, kind))),

    /** Fight boss `bossIndex` with luck from `random()` and save the result. @returns {Promise<ReturnType<typeof fightReducer>>} */
    fight: (bossIndex) => run(() => apply((state) => fightReducer(config, state, bossIndex, random()))),

    /** The current game with each purchase's price, horde power, the next boss and the last source status. */
    snapshot() {
      const { state } = current();
      const next = state.bosses.cleared;
      return {
        state,
        quotes: Object.fromEntries(Object.entries(QUOTES).map(([kind, quote]) => [kind, quote(config, state)])),
        power: hordePower(config, state),
        nextBoss: next < config.bosses.count ? { index: next, requiredPower: bossRequiredPower(config, next) } : null,
        source: sourceStatus,
      };
    },

    /**
     * Take no more work, let what is queued finish, a save in the middle of landing included, and only then give
     * up the lock. A lock given up sooner would let another engine save and this engine's pending save land over it.
     * @returns {Promise<void>}
     */
    close() {
      closing ??= queue.then(() => lock?.release());
      return closing;
    },
  };
}
