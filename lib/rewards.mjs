/**
 * The Goblin Horde economy: one immutable GameState and the pure reducers that change it.
 *
 * AI work is the income. A finished turn pays coins and horde XP, coins recruit and level the horde
 * and buy upgrades, battle scrap buys gear, and horde power decides which bosses fall. One upgrade, grip,
 * changes no number here: its level is how many more goblins the player's hand carries in the widget. Every number
 * comes from game_config.json (schema 1). The app and scripts/sim/horde-sim.mjs share these reducers,
 * so the simulator proves the rules the player gets. No reducer mutates its input: each returns new
 * objects and leaves the state it was given intact.
 */
import { readFileSync } from "node:fs";

/**
 * @typedef {{ baseCost: number, growth: number, max: number }} UpgradeConfig
 * @typedef {{
 *   schema: 1,
 *   income: { floorCoins: number, k: number, outputWeight: number, subagentCoins: number, xpPerCoin: number },
 *   idle: { coinsPerMinPer100: number, maxHours: number, catchUpDays: number },
 *   horde: { startSize: number, startCoins: number, recruitBaseCost: number, recruitGrowth: number, powerPerLevel: number, powerPerGear: number },
 *   levels: { xpBase: number, xpGrowth: number, coinBase: number, coinGrowth: number },
 *   gear: { maxTier: number, scrapBase: number, scrapGrowth: number },
 *   upgrades: { hoard: UpgradeConfig & { bonus: number }, training: UpgradeConfig & { bonus: number }, grip: UpgradeConfig },
 *   bosses: {
 *     count: number, powerBase: number, powerExponent: number, variance: number, rerunDecay: number[],
 *     firstClear: { coinsBase: number, coinsGrowth: number, scrapBase: number, scrapGrowth: number, xpBase: number, xpGrowth: number },
 *   },
 * }} GameConfig
 * @typedef {{
 *   schema: 1,
 *   wallet: { coins: number, scrap: number, lifetimeCoins: number },
 *   horde: { size: number, level: number, xp: number, gear: number },
 *   upgrades: { hoard: number, training: number, grip: number },
 *   bosses: { cleared: number },
 *   today: { key: string, reruns: Record<number, number> },
 * }} GameState
 *   `bosses.cleared` is the next boss to first-clear. `today.reruns[i]` counts boss i's reruns today; a first
 *   clear is never a rerun.
 * @typedef {{ outcome: string, inputTokens?: number, cachedInputTokens?: number, outputTokens?: number }} Turn
 *   `outcome` is "completed" or "subagent" to pay; any other outcome (failed, cancelled, interrupted) pays 0.
 * @typedef {{ coins: number, scrap: number, xp: number }} Rewards
 * @typedef {"recruit" | "level" | "gear" | "hoard" | "training" | "grip"} PurchaseKind
 */

/** Every upgrade, in the order a shop lists them. */
export const UPGRADES = ["hoard", "training", "grip"];
// The upgrades whose level scales a payout by `bonus`.
const BONUS_UPGRADES = ["hoard", "training"];
/** Everything `buy` sells. @type {PurchaseKind[]} */
export const PURCHASES = ["recruit", "level", "gear", ...UPGRADES];
const NO_REWARDS = Object.freeze({ coins: 0, scrap: 0, xp: 0 });

const finite = (test, label) => ({ test: (value) => typeof value === "number" && Number.isFinite(value) && test(value), label });
const RULES = {
  amount: finite((value) => value >= 0, "a number of at least 0"),
  positive: finite((value) => value > 0, "a positive number"),
  // Costs and their growth stay at least 1 so every purchase spends something and a shopping loop ends.
  atLeastOne: finite((value) => value >= 1, "a number of at least 1"),
  fraction: finite((value) => value >= 0 && value <= 1, "a number from 0 to 1"),
  count: finite((value) => Number.isInteger(value) && value >= 1, "a whole number of at least 1"),
  tiers: finite((value) => Number.isInteger(value) && value >= 0, "a whole number of at least 0"),
  decay: { test: (value) => Array.isArray(value) && value.length > 0 && value.every((item) => RULES.fraction.test(item)), label: "a list of numbers from 0 to 1" },
};
const CONFIG_KEYS = Object.entries({
  "income.floorCoins": "amount", "income.k": "positive", "income.outputWeight": "amount", "income.subagentCoins": "amount", "income.xpPerCoin": "amount",
  "idle.coinsPerMinPer100": "amount", "idle.maxHours": "amount", "idle.catchUpDays": "tiers",
  "horde.startSize": "count", "horde.startCoins": "amount", "horde.recruitBaseCost": "atLeastOne", "horde.recruitGrowth": "atLeastOne", "horde.powerPerLevel": "amount", "horde.powerPerGear": "amount",
  "levels.xpBase": "positive", "levels.xpGrowth": "positive", "levels.coinBase": "atLeastOne", "levels.coinGrowth": "atLeastOne",
  "gear.maxTier": "tiers", "gear.scrapBase": "atLeastOne", "gear.scrapGrowth": "atLeastOne",
  ...Object.fromEntries(UPGRADES.flatMap((name) => [
    [`upgrades.${name}.baseCost`, "atLeastOne"], [`upgrades.${name}.growth`, "atLeastOne"], [`upgrades.${name}.max`, "tiers"],
  ])),
  ...Object.fromEntries(BONUS_UPGRADES.map((name) => [`upgrades.${name}.bonus`, "amount"])),
  "bosses.count": "count", "bosses.powerBase": "positive", "bosses.powerExponent": "positive", "bosses.variance": "fraction",
  "bosses.firstClear.coinsBase": "amount", "bosses.firstClear.coinsGrowth": "positive", "bosses.firstClear.scrapBase": "amount",
  "bosses.firstClear.scrapGrowth": "positive", "bosses.firstClear.xpBase": "amount", "bosses.firstClear.xpGrowth": "positive",
  "bosses.rerunDecay": "decay",
});

/** Return the config unchanged, or throw an Error naming the first missing or invalid key. */
export function validateConfig(config) {
  if (config?.schema !== 1) throw new Error("game_config.json: schema must be 1.");
  for (const [path, rule] of CONFIG_KEYS) {
    const value = path.split(".").reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), config);
    if (value === undefined) throw new Error(`game_config.json: ${path} is missing.`);
    if (!RULES[rule].test(value)) throw new Error(`game_config.json: ${path} must be ${RULES[rule].label}.`);
  }
  return config;
}

/** Read and validate a game_config.json file. */
export function loadConfig(path) {
  let config;
  try { config = JSON.parse(readFileSync(path, "utf8")); } catch (error) { throw new Error(`Could not read ${path}: ${error.message}`); }
  return validateConfig(config);
}

const newDay = (key) => ({ key, reruns: {} });

/** A new player's state on day `dayKey`. @returns {GameState} */
export function createState(config, dayKey) {
  return {
    schema: 1,
    wallet: { coins: config.horde.startCoins, scrap: 0, lifetimeCoins: 0 },
    horde: { size: config.horde.startSize, level: 1, xp: 0, gear: 0 },
    upgrades: Object.fromEntries(UPGRADES.map((name) => [name, 0])),
    bosses: { cleared: 0 },
    today: newDay(dayKey),
  };
}

/** Start a new day's counters when `dayKey` differs from today's; everything else carries over. */
export const rollDay = (state, dayKey) => (state.today.key === dayKey ? state : { ...state, today: newDay(dayKey) });

const upgradeBonus = (config, state, name) => config.upgrades[name].bonus * state.upgrades[name];

function gain(state, { coins, scrap, xp }) {
  const { wallet, horde } = state;
  return {
    ...state,
    wallet: { coins: wallet.coins + coins, scrap: wallet.scrap + scrap, lifetimeCoins: wallet.lifetimeCoins + coins },
    horde: { ...horde, xp: horde.xp + xp },
  };
}

// Cache reads are context re-read on every tool call, not work, so only fresh input and output count.
// A turn with partial or missing usage counts as no work and pays the floor.
function workUnits(income, { inputTokens, cachedInputTokens = 0, outputTokens }) {
  if (![inputTokens, cachedInputTokens, outputTokens].every(Number.isFinite)) return 0;
  return Math.max(0, inputTokens - cachedInputTokens) + income.outputWeight * Math.max(0, outputTokens);
}

const TURN_COINS = {
  completed: (income, turn) => Math.max(income.floorCoins, income.k * Math.sqrt(workUnits(income, turn) / 1000)),
  subagent: (income) => income.subagentCoins,
};

/**
 * Pay one finished turn: coins after the hoard bonus, and horde XP after training. There is no daily limit,
 * so every agent's turns pay in full all day.
 * @param {GameConfig} config @param {GameState} state @param {Turn} turn
 * @returns {{ state: GameState, coins: number, xp: number }}
 */
export function turnPayout(config, state, turn) {
  const base = Object.hasOwn(TURN_COINS, turn.outcome) ? TURN_COINS[turn.outcome](config.income, turn) : 0;
  const coins = Math.round(base * (1 + upgradeBonus(config, state, "hoard")));
  const xp = Math.round(config.income.xpPerCoin * coins * (1 + upgradeBonus(config, state, "training")));
  return { state: coins || xp ? gain(state, { coins, scrap: 0, xp }) : state, coins, xp };
}

/** The "while you were away" trickle, banked up to `idle.maxHours`. @returns {{ state: GameState, coins: number }} */
export function idlePayout(config, state, minutesAway) {
  const minutes = Number.isFinite(minutesAway) ? Math.min(Math.max(0, minutesAway), config.idle.maxHours * 60) : 0;
  const coins = Math.round(minutes * config.idle.coinsPerMinPer100 * state.horde.size / 100);
  return { state: coins ? gain(state, { coins, scrap: 0, xp: 0 }) : state, coins };
}

/** Coins for the next goblin. */
export const recruitCost = (config, state) => Math.round(config.horde.recruitBaseCost * config.horde.recruitGrowth ** (state.horde.size - config.horde.startSize));

/** XP and coins the next horde level needs. @returns {{ xp: number, coins: number }} */
export function levelCosts(config, state) {
  const { xpBase, xpGrowth, coinBase, coinGrowth } = config.levels;
  const step = state.horde.level - 1;
  return { xp: Math.round(xpBase * xpGrowth ** step), coins: Math.round(coinBase * coinGrowth ** step) };
}

/** Scrap for the next gear tier, or null at `gear.maxTier`. */
export const gearCost = (config, state) => (state.horde.gear >= config.gear.maxTier ? null : Math.round(config.gear.scrapBase * config.gear.scrapGrowth ** state.horde.gear));

/** Coins for the next level of upgrade `name`, or null at its max. */
export function upgradeCost(config, state, name) {
  const { baseCost, growth, max } = config.upgrades[name];
  const level = state.upgrades[name];
  return level >= max ? null : Math.round(baseCost * growth ** level);
}

export function hordePower(config, state) {
  const { size, level, gear } = state.horde;
  return size * (1 + config.horde.powerPerLevel * (level - 1)) * (1 + config.horde.powerPerGear * gear);
}

/** Boss `bossIndex` needs `powerBase * (bossIndex + 1) ** powerExponent`: a ladder that stretches out as the horde's growth slows. */
export const bossRequiredPower = (config, bossIndex) => config.bosses.powerBase * (bossIndex + 1) ** config.bosses.powerExponent;

const priced = (currency, amount) => (amount == null ? null : { [currency]: amount });
const CURRENCIES = {
  coins: { held: (state) => state.wallet.coins, spend: (state, amount) => ({ ...state, wallet: { ...state.wallet, coins: state.wallet.coins - amount } }) },
  scrap: { held: (state) => state.wallet.scrap, spend: (state, amount) => ({ ...state, wallet: { ...state.wallet, scrap: state.wallet.scrap - amount } }) },
  xp: { held: (state) => state.horde.xp, spend: (state, amount) => ({ ...state, horde: { ...state.horde, xp: state.horde.xp - amount } }) },
};
const growHorde = (field) => (state) => ({ ...state, horde: { ...state.horde, [field]: state.horde[field] + 1 } });
const SHOP = {
  recruit: { price: (config, state) => ({ coins: recruitCost(config, state) }), apply: growHorde("size") },
  level: { price: levelCosts, apply: growHorde("level") },
  gear: { price: (config, state) => priced("scrap", gearCost(config, state)), apply: growHorde("gear") },
  ...Object.fromEntries(UPGRADES.map((name) => [name, {
    price: (config, state) => priced("coins", upgradeCost(config, state, name)),
    apply: (state) => ({ ...state, upgrades: { ...state.upgrades, [name]: state.upgrades[name] + 1 } }),
  }])),
};

/**
 * Buy one recruit, horde level, gear tier, or upgrade level. A refusal returns the same state and a
 * `reason`: "unknown", "maxed", or the currency that is short ("coins", "scrap", "xp").
 * @param {GameConfig} config @param {GameState} state @param {PurchaseKind} kind
 * @returns {{ state: GameState, ok: boolean, reason: string | null }}
 */
export function buy(config, state, kind) {
  if (!Object.hasOwn(SHOP, kind)) return { state, ok: false, reason: "unknown" };
  const price = SHOP[kind].price(config, state);
  if (!price) return { state, ok: false, reason: "maxed" };
  const short = Object.keys(price).find((currency) => CURRENCIES[currency].held(state) < price[currency]);
  if (short) return { state, ok: false, reason: short };
  const paid = Object.entries(price).reduce((next, [currency, amount]) => CURRENCIES[currency].spend(next, amount), state);
  return { state: SHOP[kind].apply(paid), ok: true, reason: null };
}

function winRewards(config, state, bossIndex) {
  const { firstClear, rerunDecay } = config.bosses;
  const decay = bossIndex === state.bosses.cleared ? 1 : rerunDecay[Math.min(state.today.reruns[bossIndex] ?? 0, rerunDecay.length - 1)];
  // A win always pays at least 1 of each, so a rerun of an early boss never rounds down to nothing.
  const share = (base, growth) => Math.max(1, Math.round(base * growth ** bossIndex * decay));
  return {
    coins: share(firstClear.coinsBase, firstClear.coinsGrowth),
    scrap: share(firstClear.scrapBase, firstClear.scrapGrowth),
    xp: share(firstClear.xpBase, firstClear.xpGrowth),
  };
}

/**
 * The whole horde fights boss `bossIndex`, with `luck` in [0, 1) swinging its power by `bosses.variance`.
 * `ratio` is the swung power over the boss's need, so a win is `ratio >= 1`. Boss `cleared` is a first clear;
 * a lower boss is a rerun, which pays the `bosses.rerunDecay` fraction of that boss's first clear for its
 * count of reruns today, the last fraction from then on. A win pays at least 1 coin, 1 scrap and 1 XP. A loss
 * pays and changes nothing. A boss past `cleared` is refused with reason "locked", one past the ladder with
 * "unknown".
 * @returns {{ state: GameState, won: boolean, ratio: number, first: boolean, rewards: Rewards, reason: string | null }}
 */
export function fight(config, state, bossIndex, luck) {
  const { cleared } = state.bosses;
  if (!Number.isInteger(bossIndex) || bossIndex < 0 || bossIndex >= config.bosses.count) return { state, won: false, ratio: 0, first: false, rewards: NO_REWARDS, reason: "unknown" };
  if (bossIndex > cleared) return { state, won: false, ratio: 0, first: false, rewards: NO_REWARDS, reason: "locked" };
  const first = bossIndex === cleared;
  const ratio = hordePower(config, state) * (1 + config.bosses.variance * (luck - 0.5)) / bossRequiredPower(config, bossIndex);
  if (ratio < 1) return { state, won: false, ratio, first, rewards: NO_REWARDS, reason: null };
  const rewards = winRewards(config, state, bossIndex);
  const paid = gain(state, rewards);
  return {
    state: {
      ...paid,
      bosses: { cleared: first ? cleared + 1 : cleared },
      today: first ? paid.today : { ...paid.today, reruns: { ...paid.today.reruns, [bossIndex]: (paid.today.reruns[bossIndex] ?? 0) + 1 } },
    },
    won: true, ratio, first, rewards, reason: null,
  };
}
