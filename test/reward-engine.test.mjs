import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { UNREADABLE, createPetsStore } from "../lib/pets-store.mjs";
import { createRewardEngine, localDayKey } from "../lib/reward-engine.mjs";
import { loadConfig, validateConfig } from "../lib/rewards.mjs";
import { advance, SLACK_MS, t3Source, unseen } from "../lib/t3-source.mjs";
import { createT3Fixture, hasSqlite, TRAP, usage } from "./helpers/t3-fixture.mjs";

const needsSqlite = { skip: !hasSqlite && "this Node.js has no node:sqlite" };
const SHIPPED = loadConfig(fileURLToPath(new URL("../game_config.json", import.meta.url)));
// Income, idle and the starting horde are fixed here so retuning game_config.json never changes what these tests mean.
const CONFIG = validateConfig({
  ...SHIPPED,
  income: { floorCoins: 2, k: 1.6, outputWeight: 5, subagentCoins: 4, xpPerCoin: 0.5 },
  idle: { coinsPerMinPer100: 0.1, maxHours: 4, catchUpDays: 7 },
  horde: { ...SHIPPED.horde, startSize: 100, startCoins: 25 },
});
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 10, 9);
// 50,000 fresh input and 2,000 output: 1.6 * sqrt((50,000 + 5 * 2,000) / 1000) = 12.4, so 12 coins and 6 XP.
const TURN_COINS = 12;

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
function clock(start = T0) {
  let time = start;
  return { now: () => time, set: (at) => { time = at; } };
}
function stateDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "goblin-engine-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const engineFor = ({ dir, source, time, config = CONFIG, random = () => 0.5, store = createPetsStore({ dir }) }) =>
  createRewardEngine({ config, store, source, now: time.now, random, dayKey: utcDay });
const turn = (id, at, outcome = "completed") => ({ id, kind: "turn", at, outcome, inputTokens: 50_000, cachedInputTokens: 0, outputTokens: 2_000 });
const coins = (engine) => engine.snapshot().state.wallet.coins;

/** A source over rows held in memory, read the way the T3 source reads its database. */
function memorySource(time, { delayMs = 0 } = {}) {
  const rows = [];
  return {
    add: (...events) => rows.push(...events),
    async read(watermark) {
      await sleep(delayMs);
      const read = rows.filter((row) => row.at > watermark.at - SLACK_MS).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
      return { ok: true, events: unseen(watermark, read), watermark: advance(watermark, read, { now: time.now() }) };
    },
  };
}

/** An engine over a fixture database; `restart()` builds a new engine and source on the same save. */
function overFixture(t, fixtureOptions) {
  const fixture = createT3Fixture(fixtureOptions);
  const dir = stateDir(t);
  const time = clock();
  const sources = [];
  const open = () => {
    const source = t3Source(fixture.path, { now: time.now });
    sources.push(source);
    return engineFor({ dir, source, time });
  };
  t.after(() => {
    sources.forEach((source) => source.close());
    fixture.close();
  });
  return { fixture, dir, time, open };
}

test("a completed turn pays on the next tick and shows in the batch, and failed, cancelled and interrupted turns pay 0", needsSqlite, async (t) => {
  const { fixture, time, open } = overFixture(t);
  const engine = open();
  await engine.start();
  const start = coins(engine);

  for (const status of ["failed", "cancelled", "interrupted"]) fixture.addTurn({ id: status, completedAt: T0 + MIN, status, tokens: usage(3_000_000, 50_000) });
  time.set(T0 + 2 * MIN);
  assert.deepEqual(await engine.tick(), { ok: true, coins: 0, xp: 0, turns: 0, subagents: 0 });
  assert.equal(coins(engine), start);

  fixture.addTurn({ id: "done", completedAt: T0 + 3 * MIN });
  fixture.addSubagent({ id: "helper", completedAt: T0 + 3 * MIN });
  time.set(T0 + 4 * MIN);
  assert.deepEqual(await engine.tick(), { ok: true, coins: TURN_COINS + 4, xp: 6 + 2, turns: 1, subagents: 1 });
  assert.equal(coins(engine), start + TURN_COINS + 4);
  assert.equal(engine.snapshot().state.horde.xp, 8);
});

test("a turn with no usable token data pays the floor, and cache reads never count", needsSqlite, async (t) => {
  const { fixture, time, open } = overFixture(t);
  const engine = open();
  await engine.start();

  fixture.addTurn({ id: "partial", completedAt: T0 + MIN, tokens: usage(3_000_000, 50_000, 0, "partial") });
  fixture.addTurn({ id: "none", completedAt: T0 + MIN, tokens: null });
  time.set(T0 + 2 * MIN);
  assert.equal((await engine.tick()).coins, 2 * CONFIG.income.floorCoins);

  fixture.addTurn({ id: "fresh", completedAt: T0 + 3 * MIN, tokens: usage(50_000, 2_000) });
  time.set(T0 + 4 * MIN);
  assert.equal((await engine.tick()).coins, TURN_COINS);
  fixture.addTurn({ id: "reread", completedAt: T0 + 5 * MIN, tokens: usage(5_050_000, 2_000, 5_000_000) });
  time.set(T0 + 6 * MIN);
  assert.equal((await engine.tick()).coins, TURN_COINS, "5 million cache reads add nothing");
});

test("the same rows never pay twice, across restarts and for a row that lands late inside the slack", needsSqlite, async (t) => {
  const { fixture, time, open } = overFixture(t);
  let engine = open();
  await engine.start();
  const start = coins(engine);

  fixture.addTurn({ id: "first", completedAt: T0 + 5 * MIN });
  time.set(T0 + 6 * MIN);
  assert.equal((await engine.tick()).turns, 1);
  assert.equal((await engine.tick()).turns, 0);

  engine = open();
  assert.deepEqual((await engine.start()).caughtUp, { turns: 0, coins: 0 });
  assert.equal((await engine.tick()).turns, 0);

  fixture.addTurn({ id: "late", completedAt: T0 + 2 * MIN });
  time.set(T0 + 7 * MIN);
  assert.deepEqual(await engine.tick(), { ok: true, coins: TURN_COINS, xp: 6, turns: 1, subagents: 0 });
  assert.equal((await engine.tick()).turns, 0);
  engine = open();
  await engine.start();
  assert.equal((await engine.tick()).turns, 0);
  assert.equal(coins(engine), start + 2 * TURN_COINS);
});

test("a first launch pays nothing for work that finished before it, even minutes before, and pays work that finishes after", async (t) => {
  const time = clock();
  const source = memorySource(time);
  source.add(turn("last-week", T0 - 2 * DAY), turn("an-hour-ago", T0 - HOUR), turn("five-minutes-ago", T0 - 5 * MIN));
  const engine = engineFor({ dir: stateDir(t), source, time });
  assert.deepEqual(await engine.start(), { welcome: true, away: null, caughtUp: { turns: 0, coins: 0 } });
  time.set(T0 + MIN);
  assert.deepEqual(await engine.tick(), { ok: true, coins: 0, xp: 0, turns: 0, subagents: 0 });
  assert.equal(coins(engine), CONFIG.horde.startCoins);
  source.add(turn("after-launch", T0 + 2 * MIN));
  time.set(T0 + 3 * MIN);
  const batch = await engine.tick();
  assert.deepEqual([batch.turns, batch.coins], [1, TURN_COINS]);
});

test("a new game never pays work that finished before it began, however late that work shows up, and it remembers that across restarts", async (t) => {
  const dir = stateDir(t);
  const time = clock();
  const source = memorySource(time);
  let engine = engineFor({ dir, source, time });
  await engine.start();
  assert.equal(JSON.parse(readFileSync(join(dir, "pets.json"), "utf8")).notBefore, T0, "the moment the game began is saved with it");

  // T3 writes these rows only now, with finish times from before the game began: inside the ten minutes a read looks back.
  source.add(turn("a-minute-before", T0 - MIN), turn("nine-minutes-before", T0 - 9 * MIN), turn("at-the-start", T0));
  time.set(T0 + 30_000);
  assert.deepEqual(await engine.tick(), { ok: true, coins: 0, xp: 0, turns: 0, subagents: 0 });
  source.add(turn("a-second-after", T0 + 1000));
  time.set(T0 + MIN);
  assert.deepEqual([(await engine.tick()).turns, coins(engine)], [1, CONFIG.horde.startCoins + TURN_COINS], "work that finished after the game began pays");

  engine = engineFor({ dir, source, time });
  await engine.start();
  source.add(turn("another-late-one", T0 - 2 * MIN));
  time.set(T0 + 2 * MIN);
  assert.equal((await engine.tick()).turns, 0, "after a restart the game still knows when it began");
  assert.equal(coins(engine), CONFIG.horde.startCoins + TURN_COINS);
  assert.equal(JSON.parse(readFileSync(join(dir, "pets.json"), "utf8")).notBefore, T0);
});

test("a saved game's cutoff holds whatever its watermark says, and a game saved without one pays as before", async (t) => {
  const state = { schema: 1, wallet: { coins: 100, scrap: 0, lifetimeCoins: 100 }, horde: { size: 100, level: 1, xp: 0, gear: 0 }, upgrades: { hoard: 0, training: 0 },
    bosses: { cleared: 0 }, today: { key: utcDay(T0), reruns: {} } };
  const rows = () => [turn("six-minutes-before", T0 - 6 * MIN), turn("two-minutes-before", T0 - 2 * MIN), turn("at-the-cutoff", T0), turn("just-after", T0 + 1)];
  for (const [what, extra, paid] of [["with a cutoff", { notBefore: T0 }, 1], ["without one", {}, 4]]) {
    const dir = stateDir(t);
    const time = clock(T0 + MIN);
    const source = memorySource(time);
    source.add(...rows());
    // The watermark is older than the cutoff, as after a clock change or a save put together by hand.
    writeFileSync(join(dir, "pets.json"), JSON.stringify({ schema: 1, state, sources: { t3: { at: T0 - 8 * MIN, seen: [] } }, lastSeenAt: T0 + MIN, ...extra }));
    const engine = engineFor({ dir, source, time });
    assert.deepEqual((await engine.start()).caughtUp, { turns: paid, coins: paid * TURN_COINS }, what);
    assert.equal(coins(engine), 100 + paid * TURN_COINS, what);
    assert.equal((await engine.tick()).turns, 0, `${what}: and nothing pays twice`);
  }
});

test("reopening after 3 hours replays the missed work and pays the idle trickle once", async (t) => {
  const dir = stateDir(t);
  const time = clock();
  const source = memorySource(time);
  const first = engineFor({ dir, source, time });
  await first.start();
  source.add(turn("before-close", T0 + 30_000));
  time.set(T0 + MIN);
  assert.equal((await first.tick()).turns, 1);
  const closed = coins(first);

  source.add(turn("away-1", T0 + HOUR), turn("away-2", T0 + 2 * HOUR));
  time.set(T0 + MIN + 3 * HOUR);
  const reopened = engineFor({ dir, source, time });
  // 180 minutes at 0.1 coin a minute per 100 goblins, for 100 goblins.
  assert.deepEqual(await reopened.start(), { welcome: false, away: { minutes: 180, coins: 18 }, caughtUp: { turns: 2, coins: 2 * TURN_COINS } });
  assert.equal(coins(reopened), closed + 2 * TURN_COINS + 18);

  const again = engineFor({ dir, source, time });
  assert.deepEqual(await again.start(), { welcome: false, away: null, caughtUp: { turns: 0, coins: 0 } });
  assert.equal(coins(again), closed + 2 * TURN_COINS + 18);
});

test("a break longer than catchUpDays replays only the last catchUpDays days", async (t) => {
  const dir = stateDir(t);
  const time = clock();
  const source = memorySource(time);
  await engineFor({ dir, source, time }).start();
  source.add(turn("day-1", T0 + DAY), turn("day-2", T0 + 2 * DAY), turn("day-9", T0 + 9 * DAY));
  time.set(T0 + 10 * DAY);
  const back = await engineFor({ dir, source, time }).start();
  assert.deepEqual(back.caughtUp, { turns: 1, coins: TURN_COINS });
  assert.deepEqual(back.away, { minutes: 10 * 24 * 60, coins: 24 }, "idle banks at most maxHours");
});

test("every turn of a busy day pays in full, live and in a catch-up, however many finish", async (t) => {
  const dir = stateDir(t);
  const time = clock();
  const source = memorySource(time);
  const live = engineFor({ dir, source, time });
  await live.start();
  const BUSY = 300;
  // The first turn finishes a second after the game began: one that finished at that very moment or before is never paid.
  const busyDay = (day) => Array.from({ length: BUSY }, (_, index) => turn(`day-${day}-${index}`, T0 + day * DAY + (index + 1) * 1000));
  source.add(...busyDay(0));
  time.set(T0 + HOUR);
  assert.deepEqual(await live.tick(), { ok: true, coins: BUSY * TURN_COINS, xp: BUSY * 6, turns: BUSY, subagents: 0 });
  assert.equal(coins(live), CONFIG.horde.startCoins + BUSY * TURN_COINS);

  for (const day of [1, 2]) source.add(...busyDay(day));
  time.set(T0 + 3 * DAY);
  const back = engineFor({ dir, source, time });
  assert.deepEqual((await back.start()).caughtUp, { turns: 2 * BUSY, coins: 2 * BUSY * TURN_COINS });
  assert.deepEqual(back.snapshot().state.today, { key: utcDay(T0 + 3 * DAY), reruns: {} });
});

test("work from yesterday that lands after midnight counts toward today instead of resetting it", async (t) => {
  const time = clock();
  const source = memorySource(time);
  const engine = engineFor({ dir: stateDir(t), source, time });
  await engine.start();
  const midnight = Date.UTC(2026, 10, 11);
  source.add(turn("after-midnight", midnight + 4 * MIN));
  time.set(midnight + 5 * MIN);
  await engine.tick();
  assert.ok((await engine.fight(0)).first);
  assert.ok((await engine.fight(0)).won, "a rerun, which today counts");
  source.add(turn("before-midnight", midnight - 2 * MIN));
  time.set(midnight + 6 * MIN);
  assert.equal((await engine.tick()).coins, TURN_COINS);
  assert.deepEqual(engine.snapshot().state.today, { key: "2026-11-11", reruns: { 0: 1 } });
});

test("level-ups and purchases persist across a restart", async (t) => {
  const dir = stateDir(t);
  const time = clock();
  const source = memorySource(time);
  const config = validateConfig({ ...CONFIG, horde: { ...CONFIG.horde, startCoins: 500 } });
  const engine = engineFor({ dir, source, time, config });
  await engine.start();

  for (const kind of ["recruit", "hoard"]) {
    const { quotes, state } = engine.snapshot();
    assert.ok((await engine.buy(kind)).ok, kind);
    assert.equal(coins(engine), state.wallet.coins - quotes[kind].coins, `${kind} costs what it was quoted`);
  }
  const battle = await engine.fight(0);
  assert.ok(battle.won && battle.first);
  assert.ok((await engine.buy("level")).ok);
  const bought = engine.snapshot();
  assert.deepEqual({ size: bought.state.horde.size, level: bought.state.horde.level, hoard: bought.state.upgrades.hoard, cleared: bought.state.bosses.cleared },
    { size: 101, level: 2, hoard: 1, cleared: 1 });

  const restarted = engineFor({ dir, source, time, config });
  await restarted.start();
  assert.deepEqual(restarted.snapshot(), { ...bought, source: { ok: true } });
});

test("snapshot quotes every purchase, the horde's power and the next boss", async (t) => {
  const time = clock();
  const engine = engineFor({ dir: stateDir(t), source: memorySource(time), time });
  await engine.start();
  const snapshot = engine.snapshot();
  assert.deepEqual(Object.keys(snapshot.quotes).sort(), ["gear", "grip", "hoard", "level", "recruit", "training"]);
  assert.deepEqual(snapshot.quotes.grip, { coins: CONFIG.upgrades.grip.baseCost });
  assert.deepEqual(snapshot.quotes.level, { xp: CONFIG.levels.xpBase, coins: CONFIG.levels.coinBase });
  assert.deepEqual(snapshot.quotes.gear, { scrap: CONFIG.gear.scrapBase });
  assert.equal(snapshot.power, 100);
  assert.deepEqual(snapshot.nextBoss, { index: 0, requiredPower: CONFIG.bosses.powerBase });
  assert.equal(snapshot.source, null, "no read has happened yet");
  assert.deepEqual(await engine.buy("vault"), { state: snapshot.state, ok: false, reason: "unknown" }, "the vault is no longer sold");
});

test("a game saved before the daily cap and the vault were removed opens with the rest intact, and those fields are not saved again", async (t) => {
  const dir = stateDir(t);
  const time = clock();
  const source = memorySource(time);
  const kept = { schema: 1, wallet: { coins: 640, scrap: 12, lifetimeCoins: 5000 }, horde: { size: 120, level: 4, xp: 33, gear: 2 }, bosses: { cleared: 5 } };
  // 5,000 coins earned today was far past that save's cap of 1,500, where work paid a fifth.
  const old = { ...kept, upgrades: { hoard: 3, training: 1, vault: 2 }, today: { key: utcDay(T0), coinsEarned: 5000, reruns: { 4: 1 } } };
  writeFileSync(join(dir, "pets.json"), JSON.stringify({ schema: 1, state: old, sources: { t3: { at: T0 - MIN, seen: [] } }, lastSeenAt: T0 - MIN }));
  source.add(turn("after-the-update", T0 - 30_000));

  const engine = engineFor({ dir, source, time });
  // 12.4 coins times hoard 3's 1.24, and 0.5 XP a coin times training 1's 1.1.
  assert.deepEqual(await engine.start(), { welcome: false, away: null, caughtUp: { turns: 1, coins: 15 } });
  const { state, quotes } = engine.snapshot();
  assert.deepEqual(state, {
    ...kept, wallet: { coins: 655, scrap: 12, lifetimeCoins: 5015 }, horde: { ...kept.horde, xp: 41 },
    upgrades: { hoard: 3, training: 1, grip: 0 }, today: { key: utcDay(T0), reruns: { 4: 1 } },
  });
  assert.ok(!("vault" in quotes));
  for (const name of ["pets.json", "pets.json.bak"]) {
    const text = readFileSync(join(dir, name), "utf8");
    assert.ok(!text.includes("vault") && !text.includes("coinsEarned"), name);
  }
  assert.deepEqual((await createPetsStore({ dir }).load()).record.state, state);
});

const savedState = (overrides = {}) => ({ schema: 1, wallet: { coins: 4321, scrap: 100, lifetimeCoins: 9000 }, horde: { size: 17, level: 3, xp: 100, gear: 1 }, upgrades: { hoard: 2, training: 1, grip: 1 },
  bosses: { cleared: 4 }, today: { key: utcDay(T0), reruns: {} }, ...overrides });
const savedGame = (state) => JSON.stringify({ schema: 1, state, sources: { t3: { at: T0 - MIN, seen: [] } }, lastSeenAt: T0 - MIN, notBefore: T0 - DAY });
const unreadableCopies = (dir) => readdirSync(dir).filter((name) => name.startsWith("pets.json.unreadable"));

test("a game saved when there were 40 bosses opens when there are 36: the horde of 17 is kept, and the bosses cleared are held to 36", async (t) => {
  // The review's case. Before the fix the save was refused and a new game with 3 goblins took its place.
  const dir = stateDir(t);
  const time = clock();
  assert.equal(CONFIG.bosses.count, 36);
  writeFileSync(join(dir, "pets.json"), savedGame(savedState({ bosses: { cleared: 37 }, today: { key: utcDay(T0), reruns: { 2: 1, 38: 2 } } })));
  const engine = engineFor({ dir, source: memorySource(time), time, store: createPetsStore({ dir, config: CONFIG }) });
  assert.deepEqual(await engine.start(), { welcome: false, away: null, caughtUp: { turns: 0, coins: 0 } }, "it is the same game, not a new one");
  const { state, nextBoss } = engine.snapshot();
  assert.deepEqual(state, savedState({ bosses: { cleared: 36 }, today: { key: utcDay(T0), reruns: { 2: 1 } } }));
  assert.equal(nextBoss, null, "every boss the game has now is cleared");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "pets.json"), "utf8")).state, state, "and that is what is saved");
  assert.deepEqual(unreadableCopies(dir), [], "nothing was set aside as unreadable");
  const rerun = await engine.fight(35);
  assert.deepEqual([rerun.first, rerun.reason], [false, null], "the last boss the game has is a rerun");
  assert.equal((await engine.fight(36)).reason, "unknown", "and there is no boss past it");
});

test("a saved game that cannot be read is never replaced by a new game: the engine does not start, and writes nothing", async (t) => {
  const refused = (error) => error.code === UNREADABLE && error.message === "The saved game could not be read. A copy was kept next to it. Nothing was replaced.";
  const bad = ["{\"schema\":1,\"state\":", "", savedGame(savedState({ horde: { size: 0, level: 3, xp: 100, gear: 1 } })), savedGame(savedState({ wallet: { coins: "many", scrap: 0, lifetimeCoins: 0 } }))];
  for (const text of bad) {
    const dir = stateDir(t);
    const time = clock();
    writeFileSync(join(dir, "pets.json"), text);
    const store = createPetsStore({ dir, config: CONFIG });
    const engine = engineFor({ dir, source: memorySource(time), time, store });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(engine.start(), refused, `try ${attempt + 1} with ${text.slice(0, 20)}`);
      time.set(T0 + (attempt + 1) * 30_000);
    }
    assert.equal(readFileSync(join(dir, "pets.json"), "utf8"), text, "the file that could not be read is as it was");
    const copies = unreadableCopies(dir);
    assert.equal(copies.length, 1, "one copy was kept, however often the game was tried");
    assert.equal(readFileSync(join(dir, copies[0]), "utf8"), text);
    assert.deepEqual(readdirSync(dir).sort(), ["pets.json", copies[0]].sort(), "no backup, no new game, no temp file");
    assert.throws(() => engine.snapshot(), /start\(\)/, "there is no game to show");
    await assert.rejects(engine.buy("recruit"), /start\(\)/);

    // The owner moves the files away themselves, and only then does a new game begin.
    rmSync(join(dir, "pets.json"));
    assert.equal((await engine.start()).welcome, true);
    assert.equal(engine.snapshot().state.horde.size, CONFIG.horde.startSize);
    assert.equal(readFileSync(join(dir, copies[0]), "utf8"), text, "and the copy is still there");
  }
});

test("a saved game that cannot be read opens from its backup when that loads, and the unreadable file is kept before it is saved over", async (t) => {
  const dir = stateDir(t);
  const time = clock();
  const torn = savedGame(savedState()).slice(0, 80);
  writeFileSync(join(dir, "pets.json"), torn);
  writeFileSync(join(dir, "pets.json.bak"), savedGame(savedState({ wallet: { coins: 4000, scrap: 100, lifetimeCoins: 8700 } })));
  const engine = engineFor({ dir, source: memorySource(time), time, store: createPetsStore({ dir, config: CONFIG }) });
  assert.equal((await engine.start()).welcome, false);
  assert.deepEqual([engine.snapshot().state.wallet.coins, engine.snapshot().state.horde.size], [4000, 17], "the game is the backup's");
  const copies = unreadableCopies(dir);
  assert.equal(copies.length, 1);
  assert.equal(readFileSync(join(dir, copies[0]), "utf8"), torn, "what was in pets.json is kept, whole");
  assert.equal(JSON.parse(readFileSync(join(dir, "pets.json"), "utf8")).state.wallet.coins, 4000);
});

test("a source failure is reported, changes nothing, and never throws", async (t) => {
  const dir = stateDir(t);
  const time = clock();
  const busy = { ok: false, reason: "locked", message: "T3 Code's database is busy right now." };
  const failing = { read: async () => ({ ...busy }) };
  const engine = engineFor({ dir, source: failing, time });
  await engine.start();
  const before = engine.snapshot().state;
  time.set(T0 + 2 * HOUR);
  assert.deepEqual(await engine.tick(), busy);
  assert.equal(engine.snapshot().state, before);
  assert.deepEqual(engine.snapshot().source, busy);

  const back = await engineFor({ dir, source: failing, time }).start();
  assert.deepEqual(back.caughtUp, { turns: 0, coins: 0 }, "a failed catch-up still opens the game");
  assert.equal(back.away.minutes, 120);
});

test("a save that fails during a tick is reported, and the same work pays exactly once when saving works again", async (t) => {
  const dir = stateDir(t);
  const time = clock();
  const source = memorySource(time);
  const real = createPetsStore({ dir });
  let refuse = false;
  const store = { load: real.load, save: (record) => (refuse ? Promise.reject(new Error("Goblin Horde could not save pets.json (EPERM), so the last saved game is kept.")) : real.save(record)) };
  const engine = engineFor({ dir, source, time, store });
  await engine.start();
  source.add(turn("work", T0 + 30_000));
  time.set(T0 + MIN);

  refuse = true;
  assert.deepEqual(await engine.tick(), { ok: false, reason: "save", message: "Goblin Horde could not save pets.json (EPERM), so the last saved game is kept." });
  assert.equal(coins(engine), CONFIG.horde.startCoins);
  refuse = false;
  assert.equal((await engine.tick()).coins, TURN_COINS);
  assert.equal((await engine.tick()).coins, 0);
});

test("a tick and a purchase issued together run in order and both land", async (t) => {
  const dir = stateDir(t);
  const time = clock();
  const source = memorySource(time, { delayMs: 20 });
  const config = validateConfig({ ...CONFIG, horde: { ...CONFIG.horde, startCoins: 30 } });
  const engine = engineFor({ dir, source, time, config });
  await engine.start();
  source.add(turn("work", T0 + 30_000));
  time.set(T0 + MIN);
  const recruit = engine.snapshot().quotes.recruit.coins;
  assert.ok(30 < recruit && recruit <= 30 + TURN_COINS, "the recruit is affordable only with the tick's coins");

  const [batch, bought] = await Promise.all([engine.tick(), engine.buy("recruit")]);
  assert.equal(batch.coins, TURN_COINS);
  assert.ok(bought.ok);
  const { state } = engine.snapshot();
  assert.equal(state.wallet.coins, 30 + TURN_COINS - recruit);
  assert.equal(state.horde.size, config.horde.startSize + 1);
  assert.deepEqual((await createPetsStore({ dir }).load()).record.state, state, "the save matches the game");
});

test("nothing from T3's rows but counts reaches the save, the backup, a batch or a snapshot", needsSqlite, async (t) => {
  const { fixture, dir, time, open } = overFixture(t);
  const engine = open();
  await engine.start();
  fixture.addTurn({ id: "work", completedAt: T0 + MIN });
  fixture.addTurn({ id: "broken", completedAt: T0 + MIN, status: "failed" });
  fixture.addSubagent({ id: "helper", completedAt: T0 + MIN });
  time.set(T0 + 2 * MIN);
  const batch = await engine.tick();
  assert.equal(batch.turns + batch.subagents, 2);

  assert.deepEqual(readdirSync(dir).sort(), ["pets.json", "pets.json.bak"]);
  const outputs = { "pets.json": readFileSync(join(dir, "pets.json"), "utf8"), "pets.json.bak": readFileSync(join(dir, "pets.json.bak"), "utf8"), batch: JSON.stringify(batch), snapshot: JSON.stringify(engine.snapshot()) };
  for (const [name, text] of Object.entries(outputs)) {
    for (const trap of Object.values(TRAP)) assert.ok(!text.includes(trap), `"${trap}" reached ${name}`);
  }

  const saved = JSON.parse(outputs["pets.json"]);
  assert.deepEqual(Object.keys(saved).sort(), ["lastSeenAt", "notBefore", "schema", "sources", "state"]);
  assert.equal(saved.notBefore, T0, "the one new field is a number: the moment the game began");
  assert.deepEqual(Object.keys(saved.state).sort(), ["bosses", "horde", "schema", "today", "upgrades", "wallet"]);
  assert.deepEqual(Object.keys(saved.sources), ["t3"]);
  assert.deepEqual(Object.keys(saved.sources.t3).sort(), ["at", "seen"]);
  assert.equal(saved.sources.t3.seen.length, 3);
  assert.ok(saved.sources.t3.seen.every((id) => /^[\w-]{16}$/.test(id)), "seen holds only short hashes");
});

test("a T3 schema change is reported by tick without throwing", needsSqlite, async (t) => {
  const { open } = overFixture(t, { omit: ["orchestration_v2_projection_provider_turns.payload_json"] });
  const engine = open();
  await engine.start();
  const result = await engine.tick();
  assert.deepEqual({ ok: result.ok, reason: result.reason }, { ok: false, reason: "schema" });
  assert.match(result.message, /^[A-Z].*orchestration_v2_projection_provider_turns\.payload_json.*\.$/);
  assert.deepEqual(engine.snapshot().source, result);
});

test("day keys are local calendar dates", () => {
  assert.equal(localDayKey(new Date(2026, 0, 2, 23, 59).getTime()), "2026-01-02");
  assert.equal(localDayKey(new Date(2026, 11, 31, 0, 1).getTime()), "2026-12-31");
});
