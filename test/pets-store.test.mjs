import test from "node:test";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { UNREADABLE, createPetsStore, parseRecord } from "../lib/pets-store.mjs";
import { createState, loadConfig, validateConfig } from "../lib/rewards.mjs";

const CONFIG = loadConfig(fileURLToPath(new URL("../game_config.json", import.meta.url)));
const T0 = Date.UTC(2026, 10, 10, 12);

const record = (coins = 25) => {
  const state = createState(CONFIG, "2026-11-10");
  return { schema: 1, state: { ...state, wallet: { ...state.wallet, coins } }, sources: { t3: { at: T0, seen: ["aB3_x-9"] } }, lastSeenAt: T0 };
};
function stateDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "goblin-pets-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const busy = (code) => Object.assign(new Error(`${code}: file held open`), { code });
/** node:fs/promises whose rename fails with EPERM `failures` times, then works. */
function flakyRename(failures) {
  const calls = { rename: 0 };
  return {
    calls,
    fs: {
      ...fsPromises,
      async rename(...args) {
        calls.rename += 1;
        if (calls.rename <= failures) throw busy("EPERM");
        return fsPromises.rename(...args);
      },
    },
  };
}

test("a folder with no save loads as a new player", async (t) => {
  assert.deepEqual(await createPetsStore({ dir: stateDir(t) }).load(), { record: null, recovered: null });
  assert.deepEqual(await createPetsStore({ dir: join(stateDir(t), "not-made-yet") }).load(), { record: null, recovered: null });
});

test("a saved game loads back, and the file holds only the save format's fields", async (t) => {
  const dir = stateDir(t);
  const store = createPetsStore({ dir });
  const game = record(80);
  await store.save({ ...game, note: "free text", state: { ...game.state, title: "free text", horde: { ...game.state.horde, name: "Grub" } } });
  assert.deepEqual(await store.load(), { record: game, recovered: null });
  const saved = JSON.parse(readFileSync(join(dir, "pets.json"), "utf8"));
  assert.deepEqual(saved, game);
  assert.ok(!readFileSync(join(dir, "pets.json"), "utf8").includes("free text"));
});

test("a save killed partway loads the last good copy from the backup and clears the leftover temp file", async (t) => {
  const dir = stateDir(t);
  const store = createPetsStore({ dir });
  await store.save(record(10));
  await store.save(record(20));
  writeFileSync(join(dir, "pets.json.4242-deadbeef.tmp"), '{"schema":1,"state":');
  const main = readFileSync(join(dir, "pets.json"), "utf8");
  writeFileSync(join(dir, "pets.json"), main.slice(0, main.length / 2));

  assert.deepEqual(await store.load(), { record: record(10), recovered: "backup" });
  assert.deepEqual(readdirSync(dir).sort(), ["pets.json", "pets.json.bak"]);
});

/** The copies a store kept of saved games it could not read, by name. */
const keptCopies = (dir) => readdirSync(dir).filter((name) => /^pets\.json\.unreadable\.\d+-[0-9a-f]+$/.test(name)).sort();
const cannotBeRead = (error) => error.code === UNREADABLE && error.message === "The saved game could not be read. A copy was kept next to it. Nothing was replaced.";

test("a damaged or wrongly shaped save falls back to the backup, and is never taken for a new player", async (t) => {
  const dir = stateDir(t);
  const store = createPetsStore({ dir });
  writeFileSync(join(dir, "pets.json.bak"), JSON.stringify(record(30)));
  const damaged = ["not json at all", JSON.stringify(record(-5)), JSON.stringify({ ...record(30), state: { ...record(30).state, today: { key: "Tuesday", reruns: {} } } })];
  for (const text of damaged) {
    writeFileSync(join(dir, "pets.json"), text);
    assert.deepEqual(await store.load(), { record: record(30), recovered: "backup" }, text.slice(0, 30));
  }
  assert.deepEqual(readdirSync(dir).sort(), ["pets.json", "pets.json.bak"], "a load that found the backup writes nothing");

  // With no backup that loads, a saved game that cannot be read is not a missing one: the store says so and leaves it be.
  for (const backup of [null, "{", JSON.stringify(record(-1))]) {
    const alone = stateDir(t);
    if (backup !== null) writeFileSync(join(alone, "pets.json.bak"), backup);
    for (const text of damaged) {
      writeFileSync(join(alone, "pets.json"), text);
      await assert.rejects(createPetsStore({ dir: alone }).load(), cannotBeRead, text.slice(0, 30));
      assert.equal(readFileSync(join(alone, "pets.json"), "utf8"), text, "the file is where it was, whole");
    }
    if (backup !== null) assert.equal(readFileSync(join(alone, "pets.json.bak"), "utf8"), backup, "and so is its backup");
    assert.deepEqual(keptCopies(alone).map((name) => readFileSync(join(alone, name), "utf8")).sort(), [...damaged].sort(), "each one was kept as a copy of its own");
  }
  // A backup that is all there is, and cannot be read, is a saved game too.
  const onlyBackup = stateDir(t);
  writeFileSync(join(onlyBackup, "pets.json.bak"), "half a sav");
  await assert.rejects(createPetsStore({ dir: onlyBackup }).load(), cannotBeRead);
  assert.deepEqual(readdirSync(onlyBackup).filter((name) => !keptCopies(onlyBackup).includes(name)), ["pets.json.bak"], "no pets.json was made");
  assert.deepEqual(keptCopies(onlyBackup).map((name) => readFileSync(join(onlyBackup, name), "utf8")), ["half a sav"]);
});

test("a saved game that cannot be read is kept once however often it is looked at, and two of them are two copies", async (t) => {
  const dir = stateDir(t);
  let time = 1_762_880_400_000;
  const store = createPetsStore({ dir, now: () => time });
  writeFileSync(join(dir, "pets.json"), "bad file one");
  for (let look = 0; look < 5; look += 1) {
    await assert.rejects(store.load(), cannotBeRead);
    time += 30_000;
  }
  assert.equal(keptCopies(dir).length, 1, "looking again, as the viewer does every 30 seconds, keeps no second copy of the same bytes");
  assert.match(keptCopies(dir)[0], /^pets\.json\.unreadable\.1762880400000-[0-9a-f]{8}$/, "its name holds the millisecond and a few random letters");

  writeFileSync(join(dir, "pets.json"), "bad file two");
  await assert.rejects(store.load(), cannotBeRead);
  assert.deepEqual(keptCopies(dir).map((name) => readFileSync(join(dir, name), "utf8")).sort(), ["bad file one", "bad file two"], "the second bad file has a copy of its own, and the first copy is as it was");

  // The review's case: the one copy an older version kept under the plain name, and a second file that cannot be read.
  const older = stateDir(t);
  writeFileSync(join(older, "pets.json.unreadable"), "the first game that could not be read");
  writeFileSync(join(older, "pets.json"), "bad file two");
  await createPetsStore({ dir: older }).save(record(25));
  assert.equal(readFileSync(join(older, "pets.json.unreadable"), "utf8"), "the first game that could not be read", "an earlier copy is never written over");
  assert.deepEqual(keptCopies(older).map((name) => readFileSync(join(older, name), "utf8")), ["bad file two"]);
  assert.deepEqual((await createPetsStore({ dir: older }).load()).record, record(25));
});

test("a copy is made only under a name no file has: when the name is taken, nothing is replaced and the save is refused", async (t) => {
  const dir = stateDir(t);
  // The clock and the random letters are fixed, so the second copy would get the first one's name.
  const store = createPetsStore({ dir, now: () => 1_762_880_400_000, token: () => "abcd1234" });
  writeFileSync(join(dir, "pets.json"), "bad file one");
  await assert.rejects(store.load(), cannotBeRead);
  assert.deepEqual(keptCopies(dir), ["pets.json.unreadable.1762880400000-abcd1234"]);

  writeFileSync(join(dir, "pets.json"), "bad file two");
  const noCopy = /^Error: Goblin Horde could not keep a copy of the saved game it could not read \(EEXIST\), so it left everything as it was\.$/;
  await assert.rejects(store.load(), noCopy, "a load that cannot keep its copy does not say that it did");
  await assert.rejects(store.save(record(25)), noCopy, "and a save does not replace a file it could not keep");
  assert.equal(readFileSync(join(dir, "pets.json"), "utf8"), "bad file two", "the file that could not be read is still there");
  assert.equal(readFileSync(join(dir, "pets.json.unreadable.1762880400000-abcd1234"), "utf8"), "bad file one", "and the earlier copy still holds the first one");
  assert.deepEqual(readdirSync(dir).sort(), ["pets.json", "pets.json.unreadable.1762880400000-abcd1234"]);
});

test("a save made when the game had more bosses still loads when it has fewer, with its count held to the bosses there are", async (t) => {
  // The review's case: 40 bosses when the game was saved with 37 cleared, and 36 bosses now.
  const before = validateConfig({ ...CONFIG, bosses: { ...CONFIG.bosses, count: 40 } });
  const old = changed((save) => {
    save.state.bosses.cleared = 37;
    save.state.horde.size = 17;
    save.state.today.reruns = { 3: 2, 35: 1, 36: 4, 39: 1 };
  }, 4321);
  assert.deepEqual(parseRecord(JSON.stringify(old), before), old, "for the game it was made with, it is a saved game as it stands");
  const held = changed((save) => {
    save.state.bosses.cleared = 36;
    save.state.horde.size = 17;
    save.state.today.reruns = { 3: 2, 35: 1 };
  }, 4321);
  assert.deepEqual(parseRecord(JSON.stringify(old), CONFIG), held, "36 bosses cleared, and no rerun of a boss the game no longer has");

  const dir = stateDir(t);
  const store = createPetsStore({ dir, config: CONFIG });
  writeFileSync(join(dir, "pets.json"), JSON.stringify(old));
  assert.deepEqual(await store.load(), { record: held, recovered: null });
  assert.deepEqual(readdirSync(dir), ["pets.json"], "it was read as a saved game, so nothing was set aside");
  await store.save({ ...held, lastSeenAt: T0 + 1 });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "pets.json.bak"), "utf8")), held, "the backup is the game as it was read");
  for (const cleared of [36, 37, 40, 99_999]) {
    assert.equal(parseRecord(JSON.stringify(changed((save) => { save.state.bosses.cleared = cleared; })), CONFIG).state.bosses.cleared, 36, `${cleared} cleared`);
  }
  assert.equal(parseRecord(JSON.stringify(changed((save) => { save.state.bosses.cleared = 35; })), CONFIG).state.bosses.cleared, 35, "a count within the game is left alone");
});

test("a save with fields a later version dropped still loads, and neither the save nor the backup holds them again", async (t) => {
  const dir = stateDir(t);
  const store = createPetsStore({ dir });
  const game = record(70);
  const old = { ...game, state: { ...game.state, upgrades: { ...game.state.upgrades, vault: 2 }, today: { ...game.state.today, coinsEarned: 640 } } };
  writeFileSync(join(dir, "pets.json"), JSON.stringify(old));
  assert.deepEqual(await store.load(), { record: game, recovered: null });

  await store.save(record(71));
  for (const name of ["pets.json", "pets.json.bak"]) {
    const text = readFileSync(join(dir, name), "utf8");
    assert.ok(!text.includes("vault") && !text.includes("coinsEarned"), name);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "pets.json.bak"), "utf8")), game, "the backup is the old game without them");
});

test("a rename that fails twice with EPERM is retried and the save lands", async (t) => {
  const dir = stateDir(t);
  const flaky = flakyRename(2);
  await createPetsStore({ dir, fs: flaky.fs, delayMs: 1 }).save(record(40));
  assert.ok(flaky.calls.rename >= 3);
  assert.deepEqual((await createPetsStore({ dir }).load()).record, record(40));
});

test("a save that cannot land rejects in plain words and leaves the previous file intact", async (t) => {
  const dir = stateDir(t);
  await createPetsStore({ dir }).save(record(50));
  const before = readFileSync(join(dir, "pets.json"), "utf8");
  const stuck = createPetsStore({ dir, fs: flakyRename(Infinity).fs, retries: 2, delayMs: 1 });
  await assert.rejects(stuck.save(record(60)), /^Error: Goblin Horde could not save pets\.json(\.bak)? \(EPERM\), so the last saved game is kept\.$/);
  assert.equal(readFileSync(join(dir, "pets.json"), "utf8"), before);
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
});

/** A copy of `record(coins)` with `change` applied to it. */
function changed(change, coins = 25) {
  const copy = structuredClone(record(coins));
  change(copy);
  return copy;
}

test("a count that is a fraction, below its least, or beyond any game is not a saved game, on load and on save", async (t) => {
  const bosses = CONFIG.bosses.count;
  const impossible = [
    // The review's four.
    ["half a boss cleared", (save) => { save.state.bosses.cleared = 0.5; }],
    ["half a rerun", (save) => { save.state.today.reruns = { 0: 0.5 }; }],
    ["a horde at level 0", (save) => { save.state.horde.level = 0; }],
    ["a horde of 1e308", (save) => { save.state.horde.size = 1e308; }],
    ["no goblins", (save) => { save.state.horde.size = 0; }],
    ["a goblin and a half", (save) => { save.state.horde.size = 1.5; }],
    ["more than a million goblins", (save) => { save.state.horde.size = 1_000_001; }],
    ["level 2.5", (save) => { save.state.horde.level = 2.5; }],
    ["level 1,001", (save) => { save.state.horde.level = 1001; }],
    ["gear below nothing", (save) => { save.state.horde.gear = -1; }],
    ["half a gear tier", (save) => { save.state.horde.gear = 0.5; }],
    ["gear tier 1,001", (save) => { save.state.horde.gear = 1001; }],
    ["half an upgrade", (save) => { save.state.upgrades.hoard = 0.5; }],
    ["an upgrade below nothing", (save) => { save.state.upgrades.training = -1; }],
    ["upgrade level 1,001", (save) => { save.state.upgrades.training = 1001; }],
    ["half a grip", (save) => { save.state.upgrades.grip = 0.5; }],
    ["a grip of no number", (save) => { save.state.upgrades.grip = null; }],
    ["fewer than no bosses cleared", (save) => { save.state.bosses.cleared = -1; }],
    ["more bosses cleared than any game has", (save) => { save.state.bosses.cleared = 100_001; }],
    ["1e308 bosses cleared", (save) => { save.state.bosses.cleared = 1e308; }],
    ["a rerun of a boss no game has", (save) => { save.state.today.reruns = { 100_000: 1 }; }],
    ["half a rerun of a boss this game does not have", (save) => { save.state.today.reruns = { [bosses]: 0.5 }; }],
    ["a rerun of boss 007", (save) => { save.state.today.reruns = { "007": 1 }; }],
    ["a rerun of boss -1", (save) => { save.state.today.reruns = { "-1": 1 }; }],
    ["a rerun of boss 1.5", (save) => { save.state.today.reruns = { 1.5: 1 }; }],
    ["a rerun of a boss with a name", (save) => { save.state.today.reruns = { ogre: 1 }; }],
    ["fewer than no reruns", (save) => { save.state.today.reruns = { 0: -1 }; }],
    ["1e308 reruns", (save) => { save.state.today.reruns = { 0: 1e308 }; }],
    ["reruns in words", (save) => { save.state.today.reruns = { 0: "2" }; }],
    ["reruns as a list", (save) => { save.state.today.reruns = [1]; }],
    ["more coins than 1e12", (save) => { save.state.wallet.coins = 1e12 + 1; }],
    ["1e308 lifetime coins", (save) => { save.state.wallet.lifetimeCoins = 1e308; }],
    ["scrap below nothing", (save) => { save.state.wallet.scrap = -1; }],
    ["more XP than 1e12", (save) => { save.state.horde.xp = 2e12; }],
    ["the 13th month", (save) => { save.state.today.key = "2026-13-01"; }],
    ["the 30th of February", (save) => { save.state.today.key = "2026-02-30"; }],
    ["day 0", (save) => { save.state.today.key = "2026-11-00"; }],
    ["a day with a time", (save) => { save.state.today.key = "2026-11-10T09:00"; }],
    ["a cutoff below zero", (save) => { save.notBefore = -1; }],
    ["a cutoff in words", (save) => { save.notBefore = "yesterday"; }],
  ];
  const dir = stateDir(t);
  const store = createPetsStore({ dir, config: CONFIG });
  const loaded = stateDir(t);
  for (const [what, change] of impossible) {
    const save = changed(change);
    assert.equal(parseRecord(JSON.stringify(save), CONFIG), null, what);
    await assert.rejects(store.save(save), /refused to save/, what);
    // On disk it is a saved game that cannot be read: never a new player, and never replaced.
    writeFileSync(join(loaded, "pets.json"), JSON.stringify(save));
    await assert.rejects(createPetsStore({ dir: loaded, config: CONFIG }).load(), cannotBeRead, what);
    assert.equal(readFileSync(join(loaded, "pets.json"), "utf8"), JSON.stringify(save), what);
  }
  assert.deepEqual(readdirSync(dir), [], "no refused save wrote anything");
  assert.equal(keptCopies(loaded).length, impossible.length, "and each one that was on disk was kept");
  // Numbers JSON cannot hold, written as text a parser turns into Infinity.
  for (const text of [JSON.stringify(record()).replace("\"coins\":25", "\"coins\":1e400"), JSON.stringify(record()).replace("\"size\":3", "\"size\":1e400")])
    assert.equal(parseRecord(text, CONFIG), null);
});

test("a save whose horde power, prices, or next boss would not be numbers is not a saved game", () => {
  // Each count here is within its own limit, but the price it leads to is past what a number can hold.
  const overflowing = changed((save) => { save.state.horde.size = 900_000; });
  assert.equal(parseRecord(JSON.stringify(overflowing), CONFIG), null, "a horde whose next recruit would cost Infinity");
  assert.equal(parseRecord(JSON.stringify(changed((save) => { save.state.horde.size = 5_000; })), CONFIG).state.horde.size, 5_000, "a big horde with a price that is a number loads");
  const steep = validateConfig({ ...CONFIG, levels: { ...CONFIG.levels, coinGrowth: 10 } });
  assert.equal(parseRecord(JSON.stringify(changed((save) => { save.state.horde.level = 400; })), steep), null, "a level whose next one would cost Infinity");
  assert.equal(parseRecord(JSON.stringify(changed((save) => { save.state.horde.level = 400; })), CONFIG).state.horde.level, 400);
});

test("a game saved before grip was sold opens with a grip of 0, and saves it from then on", async (t) => {
  const dir = stateDir(t);
  const { grip: _level, ...upgrades } = record().state.upgrades;
  const older = { ...record(), state: { ...record().state, upgrades: { ...upgrades, hoard: 3 } } };
  writeFileSync(join(dir, "pets.json"), JSON.stringify(older));
  const store = createPetsStore({ dir, config: CONFIG });
  const { record: loaded } = await store.load();
  assert.deepEqual(loaded, { ...older, state: { ...older.state, upgrades: { hoard: 3, training: 0, grip: 0 } } });
  await store.save(loaded);
  assert.equal(JSON.parse(readFileSync(join(dir, "pets.json"), "utf8")).state.upgrades.grip, 0);
});

test("saved games of every shape a real game makes still load, to the number", async (t) => {
  const day = createState(CONFIG, "2026-11-01");
  const games = {
    "a new game": record().state,
    "the laptop's game": { ...day, wallet: { coins: 4321, scrap: 9, lifetimeCoins: 9000 }, horde: { ...day.horde, size: 17, level: 3 }, bosses: { cleared: 4 } },
    "the walk-through's game": { ...day, wallet: { coins: 500, scrap: 12, lifetimeCoins: 2400 }, horde: { ...day.horde, size: 6, level: 2 }, bosses: { cleared: 1 } },
    "a small game with XP": { schema: 1, wallet: { coins: 64, scrap: 0, lifetimeCoins: 39 }, horde: { size: 3, level: 1, xp: 1, gear: 0 }, upgrades: { hoard: 0, training: 0, grip: 2 },
      bosses: { cleared: 0 }, today: { key: "2026-11-10", reruns: {} } },
    "a finished game": { schema: 1, wallet: { coins: 987_654_321, scrap: 54_321, lifetimeCoins: 9_876_543_210 }, horde: { size: 400, level: 60, xp: 123_456, gear: CONFIG.gear.maxTier },
      upgrades: { hoard: CONFIG.upgrades.hoard.max, training: CONFIG.upgrades.training.max, grip: CONFIG.upgrades.grip.max }, bosses: { cleared: CONFIG.bosses.count },
      today: { key: "2028-02-29", reruns: { 0: 3, 7: 1, [CONFIG.bosses.count - 1]: 12 } } },
    "a game with part coins": { ...day, wallet: { coins: 12.5, scrap: 0.25, lifetimeCoins: 100.75 } },
  };
  for (const [what, state] of Object.entries(games)) {
    for (const extra of [{}, { notBefore: T0 }, { notBefore: 0 }]) {
      const dir = stateDir(t);
      const store = createPetsStore({ dir, config: CONFIG });
      const game = { schema: 1, state, sources: { t3: { at: T0, seen: ["aB3_x-9", "laptop-turn-1"] } }, lastSeenAt: T0 - 86_400_000, ...extra };
      assert.deepEqual(parseRecord(JSON.stringify(game), CONFIG), game, what);
      await store.save(game);
      assert.deepEqual(await store.load(), { record: game, recovered: null }, what);
      assert.deepEqual(JSON.parse(readFileSync(join(dir, "pets.json"), "utf8")), game, `${what}: the file holds the same numbers`);
    }
  }
  // A save an older version wrote, with free text and fields this version does not keep, loads as its numbers.
  const old = { ...record(70), note: "free text", state: { ...record(70).state, title: "free text", upgrades: { ...record(70).state.upgrades, vault: 2 } } };
  assert.deepEqual(parseRecord(JSON.stringify(old), CONFIG), record(70));
  assert.deepEqual(parseRecord(JSON.stringify(record(70))), record(70), "and a reader with no game config still reads a game");
});

test("a pets.json this version cannot read is kept beside the new one before a save replaces it, to the byte", async (t) => {
  const dir = stateDir(t);
  const store = createPetsStore({ dir, config: CONFIG });
  // It loads from its backup, so a game goes on, and the next save is about to replace the file that could not be read.
  const unreadable = Buffer.concat([Buffer.from(JSON.stringify(changed((save) => { save.state.horde.size = 0; }, 9999))), Buffer.from([0xff, 0xfe, 0x00, 0xc3])]);
  writeFileSync(join(dir, "pets.json"), unreadable);
  writeFileSync(join(dir, "pets.json.bak"), JSON.stringify(record(20)));
  assert.deepEqual(await store.load(), { record: record(20), recovered: "backup" });
  await store.save(record(25));
  const [copy, ...more] = keptCopies(dir);
  assert.deepEqual(more, [], "one copy");
  assert.deepEqual(readdirSync(dir).sort(), ["pets.json", "pets.json.bak", copy].sort());
  assert.ok(readFileSync(join(dir, copy)).equals(unreadable), "the game that could not be read is still on the disk, whole, bytes that are not text included");
  await store.save(record(30));
  assert.ok(readFileSync(join(dir, copy)).equals(unreadable), "and a later save of a good game leaves it there");
  assert.deepEqual(readdirSync(dir).sort(), ["pets.json", "pets.json.bak", copy].sort());
  assert.deepEqual((await store.load()).record, record(30));
});

test("a game that does not match the save format is refused and nothing is written", async (t) => {
  const dir = stateDir(t);
  const store = createPetsStore({ dir });
  await assert.rejects(store.save({ ...record(), sources: { t3: { at: T0, seen: ["a prompt with spaces"] } } }), /refused to save/);
  await assert.rejects(store.save({ ...record(), lastSeenAt: Number.NaN }), /refused to save/);
  assert.ok(!existsSync(join(dir, "pets.json")));
});
