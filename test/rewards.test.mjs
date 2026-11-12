import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { buy, createState, fight, idlePayout, loadConfig, rollDay, turnPayout, validateConfig } from "../lib/rewards.mjs";

// The starting balance, fixed here so retuning game_config.json never changes what these rules mean.
const CONFIG = validateConfig({
  schema: 1,
  income: { floorCoins: 2, k: 1.6, outputWeight: 5, subagentCoins: 4, xpPerCoin: 0.5 },
  idle: { coinsPerMinPer100: 0.1, maxHours: 4, catchUpDays: 7 },
  horde: { startSize: 3, startCoins: 0, recruitBaseCost: 10, recruitGrowth: 1.015, powerPerLevel: 0.1, powerPerGear: 0.15 },
  levels: { xpBase: 20, xpGrowth: 1.35, coinBase: 15, coinGrowth: 1.4 },
  gear: { maxTier: 10, scrapBase: 20, scrapGrowth: 1.6 },
  upgrades: {
    hoard: { baseCost: 40, growth: 1.5, bonus: 0.08, max: 20 },
    training: { baseCost: 30, growth: 1.5, bonus: 0.1, max: 20 },
    grip: { baseCost: 50, growth: 1.6, max: 3 },
  },
  bosses: {
    count: 30, powerBase: 6, powerExponent: 2, variance: 0.2,
    firstClear: { coinsBase: 25, coinsGrowth: 1.28, scrapBase: 4, scrapGrowth: 1.2, xpBase: 20, xpGrowth: 1.3 },
    rerunDecay: [0.25, 0.1, 0.03],
  },
});
const DAY = "2026-11-10";
const player = (patch = {}, config = CONFIG) => {
  const state = createState(config, DAY);
  return Object.fromEntries(Object.entries(state).map(([key, value]) => [key, typeof value === "object" ? { ...value, ...patch[key] } : value]));
};
const work = (fresh, output = 0, cached = 0) => ({ outcome: "completed", inputTokens: fresh + cached, cachedInputTokens: cached, outputTokens: output });
const deepFreeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

test("a completed turn pays at least the floor of 2, and a finished subagent pays a flat 4", () => {
  const tiny = turnPayout(CONFIG, player(), work(100));
  assert.equal(tiny.coins, 2);
  assert.equal(tiny.xp, 1);
  assert.deepEqual(tiny.state.wallet, { coins: 2, scrap: 0, lifetimeCoins: 2 });
  assert.equal(tiny.state.horde.xp, 1);
  assert.equal(turnPayout(CONFIG, player(), { outcome: "completed" }).coins, 2, "a turn with no usage pays the floor");
  assert.equal(turnPayout(CONFIG, player(), { outcome: "subagent" }).coins, 4);
});

test("100 times the work pays about 10 times the coins, and output counts 5 times fresh input", () => {
  const small = turnPayout(CONFIG, player(), work(32_000)).coins;
  const big = turnPayout(CONFIG, player(), work(3_200_000)).coins;
  assert.equal(small, 9);
  assert.ok(big >= 9 * small && big <= 11 * small, `${big} coins for 100x the work of ${small}`);
  assert.equal(turnPayout(CONFIG, player(), work(0, 20_000)).coins, turnPayout(CONFIG, player(), work(100_000)).coins);
});

test("cache reads never change the payout", () => {
  const fresh = turnPayout(CONFIG, player(), work(20_000, 2_000));
  const reread = turnPayout(CONFIG, player(), work(20_000, 2_000, 5_000_000));
  assert.ok(fresh.coins > CONFIG.income.floorCoins);
  assert.deepEqual(reread, fresh);
});

test("failed, cancelled, and interrupted turns pay nothing and change nothing", () => {
  const state = player();
  for (const outcome of ["failed", "cancelled", "interrupted"]) {
    const result = turnPayout(CONFIG, state, { ...work(3_200_000, 50_000), outcome });
    assert.deepEqual({ coins: result.coins, xp: result.xp }, { coins: 0, xp: 0 }, outcome);
    assert.deepEqual(result.state, state, outcome);
  }
});

test("a day of many large turns pays every one in full, with no daily limit", () => {
  const big = work(3_200_000); // 90.5 coins.
  let state = player();
  const paid = [];
  for (let turn = 0; turn < 400; turn++) {
    const payout = turnPayout(CONFIG, state, big);
    state = payout.state;
    paid.push(payout.coins);
  }
  assert.deepEqual([...new Set(paid)], [91], "the 400th turn of the day pays what the first did");
  assert.deepEqual(state.wallet, { coins: 400 * 91, scrap: 0, lifetimeCoins: 400 * 91 });
  assert.equal(state.today.key, DAY);
});

test("hoard multiplies work coins and training multiplies work XP", () => {
  const big = work(3_200_000);
  const plain = turnPayout(CONFIG, player(), big);
  assert.deepEqual([plain.coins, plain.xp], [91, 46]);
  assert.equal(turnPayout(CONFIG, player({ upgrades: { hoard: 5 } }), big).coins, 127, "90.5 coins times 1.4");
  const trained = turnPayout(CONFIG, player({ upgrades: { training: 5 } }), big);
  assert.deepEqual([trained.coins, trained.xp], [91, 68], "91 coins at 0.5 XP each, times 1.5");
});

test("idle pays its trickle for at most the banked hours", () => {
  const horde = player({ horde: { size: 100 } });
  assert.equal(idlePayout(CONFIG, horde, 60).coins, 6);
  assert.equal(idlePayout(CONFIG, horde, 600).coins, 24);
  assert.equal(idlePayout(CONFIG, horde, 3 * 24 * 60).coins, 24);
  assert.equal(idlePayout(CONFIG, horde, -5).coins, 0);
  assert.deepEqual(idlePayout(CONFIG, horde, 60).state.wallet, { coins: 6, scrap: 0, lifetimeCoins: 6 });
});

test("a level needs both its XP and its coins, spends them, and keeps the XP remainder", () => {
  const short = player({ horde: { xp: 19 }, wallet: { coins: 100 } });
  assert.deepEqual(buy(CONFIG, short, "level"), { state: short, ok: false, reason: "xp" });
  const poor = player({ horde: { xp: 50 }, wallet: { coins: 14 } });
  assert.deepEqual(buy(CONFIG, poor, "level"), { state: poor, ok: false, reason: "coins" });
  const { state, ok } = buy(CONFIG, player({ horde: { xp: 50 }, wallet: { coins: 15 } }), "level");
  assert.ok(ok);
  assert.deepEqual([state.horde.level, state.horde.xp, state.wallet.coins], [2, 30, 0]);
  const again = buy(CONFIG, { ...state, wallet: { ...state.wallet, coins: 21 } }, "level").state;
  assert.deepEqual([again.horde.level, again.horde.xp, again.wallet.coins], [3, 3, 0], "the 30 XP kept covers level 2's 27");
});

test("a purchase never takes a wallet below zero", () => {
  let state = player({ wallet: { coins: 25, scrap: 19 } });
  const bought = [];
  for (let result = buy(CONFIG, state, "recruit"); result.ok; result = buy(CONFIG, state, "recruit")) {
    state = result.state;
    bought.push(state.wallet.coins);
  }
  assert.deepEqual(bought, [15, 5]);
  assert.deepEqual(buy(CONFIG, state, "recruit"), { state, ok: false, reason: "coins" });
  assert.deepEqual(buy(CONFIG, state, "hoard"), { state, ok: false, reason: "coins" });
  assert.deepEqual(buy(CONFIG, state, "gear"), { state, ok: false, reason: "scrap" });
  assert.equal(state.horde.size, 5);
  const geared = player({ horde: { gear: 10 }, wallet: { scrap: 1e9 } });
  assert.deepEqual(buy(CONFIG, geared, "gear"), { state: geared, ok: false, reason: "maxed" });
  assert.deepEqual(buy(CONFIG, state, "dragon"), { state, ok: false, reason: "unknown" });
});

// Fight boss 0 `times` times in a row at even luck: the state after, and what each fight paid.
function fightBossZero(config, start, times) {
  let state = start;
  const rewards = [];
  for (let n = 0; n < times; n++) {
    const bout = fight(config, state, 0, 0.5);
    assert.ok(bout.won);
    assert.equal(bout.first, n === 0);
    state = bout.state;
    rewards.push(bout.rewards);
  }
  return { state, rewards };
}

test("a first clear pays in full, that boss's reruns today pay 25%, 10%, then 3% of it for good, and a new day starts over", () => {
  const flat = { ...CONFIG, bosses: { ...CONFIG.bosses, firstClear: { coinsBase: 1000, coinsGrowth: 1, scrapBase: 1000, scrapGrowth: 1, xpBase: 1000, xpGrowth: 1 } } };
  const { state, rewards } = fightBossZero(flat, player({ horde: { size: 100 } }, flat), 7);
  assert.deepEqual(rewards, [
    { coins: 1000, scrap: 1000, xp: 1000 },
    { coins: 250, scrap: 250, xp: 250 },
    { coins: 100, scrap: 100, xp: 100 },
    { coins: 30, scrap: 30, xp: 30 },
    { coins: 30, scrap: 30, xp: 30 },
    { coins: 30, scrap: 30, xp: 30 },
    { coins: 30, scrap: 30, xp: 30 },
  ]);
  assert.equal(state.bosses.cleared, 1);
  assert.deepEqual(state.wallet, { coins: 1470, scrap: 1470, lifetimeCoins: 1470 });
  const tomorrow = fight(flat, rollDay(state, "2026-11-11"), 0, 0.5);
  assert.deepEqual([tomorrow.first, tomorrow.rewards], [false, { coins: 250, scrap: 250, xp: 250 }], "a rerun pays the same share of coins, scrap, and XP");
});

test("a won fight always pays at least 1 coin, 1 scrap, and 1 XP, so a rerun of the first boss is never worth nothing", () => {
  // 10% and 3% of a first clear of 4 round to nothing, so only the minimum pays those reruns.
  const small = { ...CONFIG, bosses: { ...CONFIG.bosses, firstClear: { coinsBase: 4, coinsGrowth: 1, scrapBase: 4, scrapGrowth: 1, xpBase: 4, xpGrowth: 1 } } };
  const { rewards } = fightBossZero(small, player({ horde: { size: 100 } }, small), 8);
  assert.deepEqual(rewards[0], { coins: 4, scrap: 4, xp: 4 });
  rewards.slice(1).forEach((paid, rerun) => assert.deepEqual(paid, { coins: 1, scrap: 1, xp: 1 }, `rerun ${rerun + 1}`));

  const shipped = loadConfig(fileURLToPath(new URL("../game_config.json", import.meta.url)));
  for (let boss = 0; boss < shipped.bosses.count; boss++) {
    let state = { ...player({ horde: { size: 1_000_000 } }, shipped), bosses: { cleared: boss + 1 } };
    for (let rerun = 1; rerun <= 5; rerun++) {
      const bout = fight(shipped, state, boss, 0.5);
      state = bout.state;
      assert.ok(bout.won && Math.min(bout.rewards.coins, bout.rewards.scrap, bout.rewards.xp) >= 1, `boss ${boss} rerun ${rerun} pays ${JSON.stringify(bout.rewards)}`);
    }
  }
});

test("a lost fight pays nothing and changes nothing, and luck, level, and gear decide the margin", () => {
  const state = player({ horde: { size: 6 } }); // Power 6 against boss 0's 6.
  const lost = fight(CONFIG, state, 0, 0.49);
  assert.deepEqual([lost.won, lost.rewards], [false, { coins: 0, scrap: 0, xp: 0 }]);
  assert.ok(lost.ratio < 1 && lost.ratio > 0.99);
  assert.equal(lost.state, state);
  assert.ok(fight(CONFIG, state, 0, 0.5).won);
  const cleared = { ...state, bosses: { cleared: 1 } };
  const lostRerun = fight(CONFIG, cleared, 0, 0.49);
  assert.deepEqual([lostRerun.won, lostRerun.first, lostRerun.rewards], [false, false, { coins: 0, scrap: 0, xp: 0 }], "a lost rerun gets no minimum");
  assert.equal(lostRerun.state, cleared);
  assert.deepEqual(fight(CONFIG, cleared, 0, 0.5).rewards, { coins: 6, scrap: 1, xp: 5 }, "the next win is still the day's 25% rerun");
  const ahead = { ...state, horde: { ...state.horde, size: 20 }, bosses: { cleared: 1 } }; // Boss 1 needs 24.
  assert.equal(fight(CONFIG, ahead, 1, 0.5).won, false);
  assert.ok(fight(CONFIG, { ...ahead, horde: { ...ahead.horde, gear: 2 } }, 1, 0.5).won, "gear 2 makes 26");
  assert.ok(fight(CONFIG, { ...ahead, horde: { ...ahead.horde, level: 4 } }, 1, 0.5).won, "level 4 makes 26");
});

test("a fight past the next uncleared boss is refused however strong the horde is", () => {
  const state = player({ horde: { size: 10_000 } });
  for (const [boss, reason] of [[1, "locked"], [30, "unknown"], [-1, "unknown"]]) {
    const result = fight(CONFIG, state, boss, 0.9);
    assert.deepEqual([result.won, result.reason, result.state], [false, reason, state], `boss ${boss}`);
  }
});

test("rollDay resets only today's counters", () => {
  const state = player({ wallet: { coins: 70, scrap: 9, lifetimeCoins: 900 }, horde: { size: 40, level: 3, xp: 12, gear: 2 }, upgrades: { hoard: 2 }, bosses: { cleared: 4 }, today: { reruns: { 2: 3 } } });
  assert.equal(rollDay(state, DAY), state);
  const next = rollDay(state, "2026-11-11");
  assert.deepEqual(next.today, { key: "2026-11-11", reruns: {} });
  assert.deepEqual({ ...next, today: state.today }, state);
});

test("no reducer changes the state or config it was given", () => {
  const config = deepFreeze(structuredClone(CONFIG));
  const state = deepFreeze(player({ wallet: { coins: 5000, scrap: 5000 }, horde: { size: 60, xp: 5000 }, bosses: { cleared: 2 }, today: { reruns: { 0: 1 } } }, config));
  const before = structuredClone(state);
  rollDay(state, "2026-11-11");
  turnPayout(config, state, work(50_000, 3_000));
  turnPayout(config, state, { outcome: "subagent" });
  idlePayout(config, state, 120);
  for (const kind of ["recruit", "level", "gear", "hoard", "training", "grip"]) assert.ok(buy(config, state, kind).ok, kind);
  for (const boss of [0, 1, 2]) assert.ok(fight(config, state, boss, 0.5).won, `boss ${boss}`);
  assert.deepEqual(state, before);
});

test("validateConfig names the missing or invalid key, and the shipped game_config.json is valid", () => {
  const broken = (edit) => {
    const config = structuredClone(CONFIG);
    edit(config);
    return () => validateConfig(config);
  };
  assert.throws(broken((config) => { delete config.income.k; }), /income\.k is missing/);
  assert.throws(broken((config) => { config.bosses.rerunDecay = []; }), /bosses\.rerunDecay must be/);
  assert.throws(broken((config) => { config.upgrades.hoard.max = 1.5; }), /upgrades\.hoard\.max must be/);
  assert.throws(broken((config) => { delete config.upgrades.hoard.bonus; }), /upgrades\.hoard\.bonus is missing/);
  assert.throws(broken((config) => { delete config.upgrades.grip; }), /upgrades\.grip\.baseCost is missing/);
  assert.throws(broken((config) => { config.horde.recruitBaseCost = "10"; }), /horde\.recruitBaseCost must be/);
  assert.throws(broken((config) => { config.schema = 2; }), /schema must be 1/);
  assert.equal(loadConfig(fileURLToPath(new URL("../game_config.json", import.meta.url))).schema, 1);
});

test("grip is bought with coins up to its max, and changes no payout and no power", () => {
  const rich = player({ wallet: { coins: 1000 }, horde: { size: 40 } });
  assert.equal(rich.upgrades.grip, 0, "a new player's hand carries one goblin");
  const levels = [];
  let state = rich;
  for (let bought = buy(CONFIG, state, "grip"); bought.ok; bought = buy(CONFIG, state, "grip")) {
    levels.push(state.wallet.coins - bought.state.wallet.coins);
    state = bought.state;
  }
  assert.deepEqual(levels, [50, 80, 128], "50 coins, then 1.6 times as much each level");
  assert.equal(state.upgrades.grip, 3);
  assert.deepEqual(buy(CONFIG, state, "grip"), { state, ok: false, reason: "maxed" });
  assert.deepEqual(buy(CONFIG, player({ wallet: { coins: 49 } }), "grip").reason, "coins");
  const big = work(3_200_000);
  assert.deepEqual([turnPayout(CONFIG, state, big).coins, turnPayout(CONFIG, state, big).xp], [turnPayout(CONFIG, rich, big).coins, turnPayout(CONFIG, rich, big).xp]);
  assert.equal(fight(CONFIG, state, 0, 0.5).ratio, fight(CONFIG, rich, 0, 0.5).ratio);
  assert.ok(fight(CONFIG, rich, 0, 0.5).ratio > 1);
});

test("the vault upgrade is gone: buying it is refused, even for a player an older version sold vault levels to", () => {
  const rich = player({ wallet: { coins: 1e9, scrap: 1e9 }, horde: { xp: 1e9 } });
  assert.deepEqual(buy(CONFIG, rich, "vault"), { state: rich, ok: false, reason: "unknown" });
  const old = { ...rich, upgrades: { ...rich.upgrades, vault: 2 } };
  assert.deepEqual(buy(CONFIG, old, "vault"), { state: old, ok: false, reason: "unknown" });
});

test("a config that still carries the removed cap, vault, and rerun coin fraction is valid and plays by the new rules", () => {
  const old = validateConfig({
    ...CONFIG,
    income: { ...CONFIG.income, dailyCapCoins: 20, overCapRate: 0 },
    upgrades: { ...CONFIG.upgrades, vault: { baseCost: 60, growth: 1.6, bonus: 250, max: 10 } },
    bosses: { ...CONFIG.bosses, rerunCoinFraction: 0.02 },
  });
  const big = work(3_200_000);
  const second = turnPayout(old, turnPayout(old, player(), big).state, big);
  assert.deepEqual([second.coins, second.state.wallet.coins], [91, 182], "its cap of 20 coins a day is not applied");
  const start = player({ horde: { size: 100 } });
  assert.deepEqual(fightBossZero(old, start, 4).rewards, fightBossZero(CONFIG, start, 4).rewards);
  assert.equal(buy(old, player({ wallet: { coins: 1e9 } }), "vault").reason, "unknown");
});

test("a new player starts with the configured starter coins, which are a gift and not lifetime earnings", () => {
  const config = { ...CONFIG, horde: { ...CONFIG.horde, startCoins: 25 } };
  const state = createState(config, DAY);
  assert.deepEqual(state.wallet, { coins: 25, scrap: 0, lifetimeCoins: 0 });
});
