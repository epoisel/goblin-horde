#!/usr/bin/env node
/**
 * Play the Goblin Horde economy forward with simulated players and score it against written feel targets.
 *
 *   node scripts/sim/horde-sim.mjs [--persona typical|light|heavy|fleet|farmer|owner|all] [--days 90] [--seed 1]
 *     [--from-t3 [path]] [--check] [--set path=value ...] [--json]
 *
 * Every payout, purchase, and fight goes through lib/rewards.mjs, the reducers the app ships, with
 * game_config.json as loaded. `--set income.k=1.4` overrides one value for this run only, so tuning needs no
 * file edits. `--check` scores the run against feel-targets.json and exits 1 when a target fails.
 * `--from-t3` replays the owner's real days from T3's database, opened read-only, reading only timestamps,
 * statuses, and token counts; nothing it reads is written anywhere.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bossRequiredPower, buy, createState, fight, hordePower, idlePayout, loadConfig, rollDay, turnPayout, upgradeCost, validateConfig } from "../../lib/rewards.mjs";

const CONFIG_FILE = fileURLToPath(new URL("../../game_config.json", import.meta.url));
const TARGETS_FILE = fileURLToPath(new URL("./feel-targets.json", import.meta.url));
const T3_DATABASE = join(homedir(), ".t3", "userdata", "statev2.sqlite");
const DAY_MS = 24 * 60 * 60_000;
const CHECKPOINTS = [1, 3, 7, 14, 30, 60, 90];

// Turn sizes in W-units (fresh input plus outputWeight times output), lognormal around a median turn.
const TURN = { medianW: 32_000, sigma: 2, minW: 500, maxW: 2_500_000, outputPerFresh: 10, subagentChance: 0.15 };
// Buy hoard or training when it pays back within paybackDays of recent work income, the only income they raise.
const BOT = { paybackDays: 30, windowDays: 7 };
// Turns per active day as [mean, sd]. Each spread is 24% of the mean, as typical's 6 on 25.
const PERSONAS = {
  typical: { activeOf7: 5, turns: [25, 6], battles: 3 },
  light: { activeOf7: 4, turns: [6, 1.44], battles: 1 },
  heavy: { activeOf7: 7, turns: [45, 10.8], battles: 6 },
  fleet: { activeOf7: 7, turns: [400, 96], battles: 6 },
  farmer: { activeOf7: 7, turns: [0, 0], battles: 100 },
};
const OWNER_BATTLES = PERSONAS.typical.battles;
const PERSONA_NAMES = [...Object.keys(PERSONAS), "owner", "all"];
const USAGE = `Usage: node scripts/sim/horde-sim.mjs [--persona ${PERSONA_NAMES.join("|")}] [--days 90] [--seed 1]
  [--from-t3 [path]] [--check] [--set path=value ...] [--json]`;

function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gaussian = (rng) => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function syntheticTurn(rng, outputWeight) {
  const w = Math.round(clamp(TURN.medianW * Math.exp(TURN.sigma * gaussian(rng)), TURN.minW, TURN.maxW));
  const outputTokens = Math.round(w * TURN.outputPerFresh / (1 + outputWeight * TURN.outputPerFresh));
  return { outcome: "completed", inputTokens: w - outputWeight * outputTokens, cachedInputTokens: 0, outputTokens };
}

const syntheticPlan = ({ activeOf7, turns: [mean, sd], battles }) => (day, rng, config) => {
  if ((day - 1) % 7 >= activeOf7) return { active: false, events: [], battles: 0 };
  const events = [];
  for (let n = Math.max(0, Math.round(mean + sd * gaussian(rng))); n > 0; n--) {
    events.push(syntheticTurn(rng, config.income.outputWeight));
    if (rng() < TURN.subagentChance) events.push({ outcome: "subagent" });
  }
  return { active: true, events, battles };
};

const replayPlan = (realDays) => (day) => {
  const events = realDays[(day - 1) % realDays.length];
  const active = events.some((event) => event.outcome === "completed");
  return { active, events, battles: active ? OWNER_BATTLES : 0 };
};

const T3_COLUMNS = {
  orchestration_v2_projection_provider_turns: ["status", "completed_at", "payload_json"],
  orchestration_v2_projection_subagents: ["status", "completed_at"],
};
const USAGE_FIELDS = ["inputTokens", "cachedInputTokens", "outputTokens"];

/** The owner's finished turns and subagents from T3, one list of turns per local calendar day, gaps kept. */
async function readT3Days(path) {
  if (!existsSync(path)) throw new Error(`There is no T3 database at ${path}.`);
  const { DatabaseSync } = await import("node:sqlite").catch(() => { throw new Error("Reading T3 needs Node 22.13 or newer, which has node:sqlite."); });
  const db = new DatabaseSync(path, { readOnly: true });
  let turns, subagents;
  try {
    for (const [table, columns] of Object.entries(T3_COLUMNS)) {
      const present = new Set(db.prepare("SELECT name FROM pragma_table_info(?)").all(table).map((column) => column.name));
      if (!present.size) throw new Error(`The T3 database has no ${table} table, so T3's schema may have changed.`);
      const missing = columns.filter((column) => !present.has(column));
      if (missing.length) throw new Error(`The T3 table ${table} has no ${missing.join(" or ")} column, so T3's schema may have changed.`);
    }
    // Only numbers leave SQLite. A usage field that is not a number reads as null, and that turn pays the floor.
    const usage = USAGE_FIELDS.map((field) => `CASE WHEN json_valid(payload_json) THEN CASE WHEN json_type(payload_json, '$.turnTokenUsage.${field}') IN ('integer', 'real') THEN json_extract(payload_json, '$.turnTokenUsage.${field}') END END AS ${field}`);
    turns = db.prepare(`SELECT completed_at, status, ${usage.join(", ")} FROM orchestration_v2_projection_provider_turns WHERE completed_at IS NOT NULL`).all();
    subagents = db.prepare("SELECT completed_at FROM orchestration_v2_projection_subagents WHERE status = 'completed' AND completed_at IS NOT NULL").all();
  } finally { db.close(); }
  const events = [
    ...turns.map((row) => ({ at: Date.parse(row.completed_at), turn: { outcome: row.status, inputTokens: row.inputTokens, cachedInputTokens: row.cachedInputTokens, outputTokens: row.outputTokens } })),
    ...subagents.map((row) => ({ at: Date.parse(row.completed_at), turn: { outcome: "subagent" } })),
  ].filter((event) => Number.isFinite(event.at)).sort((a, b) => a.at - b.at);
  if (!events.some((event) => event.turn.outcome === "completed")) throw new Error("The T3 database has no completed turns to replay.");
  const midnight = (at) => { const date = new Date(at); return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(); };
  // Rounding absorbs the 23- and 25-hour days at daylight-saving changes.
  const dayIndex = (at) => Math.round((midnight(at) - midnight(events[0].at)) / DAY_MS);
  const days = Array.from({ length: dayIndex(events.at(-1).at) + 1 }, () => []);
  for (const event of events) days[dayIndex(event.at)].push(event.turn);
  return days;
}

function choosePurchase(config, state, recent) {
  const income = recent.reduce((sum, day) => sum + day.workCoins, 0) / recent.length;
  for (const name of ["hoard", "training"]) {
    const cost = upgradeCost(config, state, name);
    if (cost == null || cost > BOT.paybackDays * income * config.upgrades[name].bonus) continue;
    const bought = buy(config, state, name);
    if (bought.ok) return bought.state;
  }
  let best = null;
  for (const kind of ["recruit", "level", "gear"]) {
    const bought = buy(config, state, kind);
    if (!bought.ok) continue;
    // Gear spends scrap, which nothing else buys, so its value is power per scrap.
    const spent = state.wallet.coins - bought.state.wallet.coins + state.wallet.scrap - bought.state.wallet.scrap;
    const value = (hordePower(config, bought.state) - hordePower(config, state)) / spent;
    if (!best || value > best.value) best = { value, state: bought.state };
  }
  return best?.state ?? null;
}

// The share of luck that wins: luck swings the horde's power by `bosses.variance` around its real value.
function winChance(config, state, boss) {
  const short = bossRequiredPower(config, boss) / hordePower(config, state) - 1;
  const { variance } = config.bosses;
  return variance ? clamp(0.5 - short / variance, 0, 1) : Number(short <= 0);
}

// The bot fights the boss it expects to pay the most: what a win pays today (read from the reducer at the
// luckiest swing) times the chance to win. A loss costs the rerun it could have won instead, so the next boss,
// which pays its first clear in full, is challenged once its chance beats a sure rerun.
function chooseBoss(config, state) {
  const last = Math.min(state.bosses.cleared, config.bosses.count - 1);
  let best = 0;
  let bestValue = -1;
  for (let boss = 0; boss <= last; boss++) {
    const { coins, scrap, xp } = fight(config, state, boss, 1).rewards;
    const value = winChance(config, state, boss) * (coins + scrap + xp);
    if (value >= bestValue) [best, bestValue] = [boss, value];
  }
  return best;
}

/** One persona's run: a record per day (its income, purchases, and end-of-day state) and its first-purchase turn. */
function simulate(config, plan, days, seed) {
  const rng = mulberry32(seed);
  const log = [];
  let state = createState(config, "day-1");
  let turns = 0;
  let activeDays = 0;
  let turnsToFirstPurchase = null;
  for (let day = 1; day <= days; day++) {
    state = rollDay(state, `day-${day}`);
    const record = { day, active: false, activeDay: null, coins: 0, workCoins: 0, battleCoins: 0, idleCoins: 0, purchases: 0, firstClears: 0 };
    const recent = [...log.slice(1 - BOT.windowDays), record];
    const shop = () => {
      for (let next = choosePurchase(config, state, recent); next; next = choosePurchase(config, state, recent)) {
        state = next;
        record.purchases++;
        turnsToFirstPurchase ??= turns;
      }
    };
    const idle = idlePayout(config, state, config.idle.maxHours * 60);
    state = idle.state;
    record.coins += idle.coins;
    record.idleCoins += idle.coins;
    shop();
    const today = plan(day, rng, config);
    record.active = today.active;
    if (today.active) record.activeDay = ++activeDays;
    for (const turn of today.events) {
      const paid = turnPayout(config, state, turn);
      state = paid.state;
      record.coins += paid.coins;
      record.workCoins += paid.coins;
      if (turn.outcome === "completed") turns++;
      shop();
    }
    for (let n = 0; n < today.battles; n++) {
      const bout = fight(config, state, chooseBoss(config, state), rng());
      state = bout.state;
      record.coins += bout.rewards.coins;
      record.battleCoins += bout.rewards.coins;
      if (bout.won && bout.first) record.firstClears++;
      shop();
    }
    log.push({ ...record, wallet: state.wallet, horde: state.horde, upgrades: state.upgrades, bosses: state.bosses });
  }
  return { log, turnsToFirstPurchase };
}

const total = (days, field) => days.reduce((sum, day) => sum + day[field], 0);
const share = (part, whole) => (part == null || !whole ? null : part / whole);
const dayAt = (log, day) => log[day - 1] ?? null;
const firstDay = (log, test) => log.find(test)?.day ?? null;
// A day's rate averages the week that ends on it, so a weekly rest day does not decide it.
const weekTo = (log, n, field) => (log.length >= n ? total(log.slice(n - 7, n), field) / 7 : null);
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function longestRun(items, test) {
  let longest = 0;
  let run = 0;
  for (const item of items) longest = Math.max(longest, (run = test(item) ? run + 1 : 0));
  return longest;
}
const hordeOn = (n) => ({ value: ({ log }) => dayAt(log, n)?.horde.size ?? null });
const bossesOn = (n) => ({ value: ({ log }) => dayAt(log, n)?.bosses.cleared ?? null });
const coinsPerDayOn = (n) => ({ value: ({ log }) => weekTo(log, n, "coins") });
const hordeVsTypical = (n) => ({ only: "farmer", value: ({ log }, config, typical) => share(dayAt(log, n)?.horde.size ?? null, dayAt(typical.log, n)?.horde.size) });

// `reach` marks first-time metrics, where null means "not within the run" and compares as later than any target.
// Any other null means the run was too short to measure it.
const METRICS = {
  turnsToFirstPurchase: { reach: true, value: (run) => run.turnsToFirstPurchase },
  firstBossClearActiveDay: { reach: true, value: ({ log }) => log.find((day) => day.bosses.cleared > 0)?.activeDay ?? null },
  medianPurchasesPerActiveDayFirst14: { value: ({ log }) => median(log.slice(0, 14).filter((day) => day.active).map((day) => day.purchases)) },
  maxStallActiveDaysFirst30: { value: ({ log }) => longestRun(log.slice(0, 30).filter((day) => day.active), (day) => !day.purchases && !day.firstClears) },
  hordeDay7: hordeOn(7),
  hordeDay30: hordeOn(30),
  hordeDay60: hordeOn(60),
  hordeDay90: hordeOn(90),
  daysToHorde200: { reach: true, value: ({ log }) => firstDay(log, (day) => day.horde.size >= 200) },
  bossesDay7: bossesOn(7),
  bossesDay30: bossesOn(30),
  bossesDay60: bossesOn(60),
  bossesDay90: bossesOn(90),
  daysToLadderComplete: { reach: true, value: ({ log }, config) => firstDay(log, (day) => day.bosses.cleared >= config.bosses.count) },
  battleCoinShare: { value: ({ log }) => share(total(log, "battleCoins"), total(log, "coins")) },
  coinsPerDayDay7: coinsPerDayOn(7),
  coinsPerDayDay30: coinsPerDayOn(30),
  coinsPerDayDay60: coinsPerDayOn(60),
  coinsPerDayDay90: coinsPerDayOn(90),
  hordeVsTypicalDay30: hordeVsTypical(30),
  hordeVsTypicalDay60: hordeVsTypical(60),
  hordeVsTypicalDay90: hordeVsTypical(90),
  coinsVsTypicalDay30: { only: "farmer", value: ({ log }, config, typical) => share(weekTo(log, 30, "coins"), weekTo(typical.log, 30, "workCoins")) },
};

function measure(name, run, config, typical) {
  return Object.fromEntries(Object.entries(METRICS).filter(([, metric]) => !metric.only || metric.only === name).map(([key, metric]) => [key, metric.value(run, config, typical)]));
}

function score(targets, results) {
  const rows = [];
  for (const [persona, goals] of Object.entries(targets)) {
    if (!results[persona]) continue;
    for (const [metric, { min, max }] of Object.entries(goals)) {
      if (!Object.hasOwn(METRICS, metric)) throw new Error(`feel-targets.json: ${persona}.${metric} is not a metric this simulator measures.`);
      const value = results[persona].metrics[metric] ?? null;
      const compared = value ?? (METRICS[metric].reach ? Infinity : NaN);
      rows.push({ persona, metric, value, min, max, pass: compared >= (min ?? -Infinity) && compared <= (max ?? Infinity) });
    }
  }
  return rows;
}

function override(config, sets) {
  const next = structuredClone(config);
  for (const [path, text] of sets) {
    const keys = path.split(".");
    const last = keys.pop();
    const parent = keys.reduce((node, key) => (node && typeof node === "object" && Object.hasOwn(node, key) ? node[key] : null), next);
    if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, last)) throw new Error(`--set ${path}: game_config.json has no such key.`);
    try { parent[last] = JSON.parse(text); } catch { parent[last] = text; }
  }
  return validateConfig(next);
}

function parseArgs(argv) {
  const options = { persona: "typical", days: 90, seed: 1, fromT3: null, check: false, json: false, sets: [], help: false };
  const whole = (flag, text, min) => {
    const number = Number(text);
    if (!Number.isInteger(number) || number < min) throw new Error(`${flag} must be a whole number of at least ${min}.`);
    return number;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${flag} needs a value.\n${USAGE}`);
      return argv[++i];
    };
    if (flag === "--persona") {
      options.persona = value();
      if (!PERSONA_NAMES.includes(options.persona)) throw new Error(`--persona must be one of ${PERSONA_NAMES.join(", ")}.`);
    } else if (flag === "--days") options.days = whole(flag, value(), 1);
    else if (flag === "--seed") options.seed = whole(flag, value(), 0);
    else if (flag === "--from-t3") options.fromT3 = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : T3_DATABASE;
    else if (flag === "--check") options.check = true;
    else if (flag === "--json") options.json = true;
    else if (flag === "--set") {
      const pair = value();
      const at = pair.indexOf("=");
      if (at < 1) throw new Error("--set needs path=value, like income.k=1.4.");
      options.sets.push([pair.slice(0, at), pair.slice(at + 1)]);
    } else if (flag === "--help" || flag === "-h") options.help = true;
    else throw new Error(`Unknown option ${flag}.\n${USAGE}`);
  }
  if (options.persona === "owner" && !options.fromT3) throw new Error("--persona owner replays your T3 history, so it needs --from-t3.");
  return options;
}

function show(value, metric, days) {
  if (value == null) return metric?.reach ? `never in ${days} days` : "n/a";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function table(headers, rows) {
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => String(row[i]).length)));
  const line = (row) => `  ${row.map((cell, i) => (i ? String(cell).padStart(widths[i]) : String(cell).padEnd(widths[i]))).join("  ")}`;
  return [headers, ...rows].map(line).join("\n");
}

function report({ options, about, results, checks }) {
  const sets = options.sets.map(([path, text]) => `${path}=${text}`).join(" ");
  const lines = [`Goblin Horde economy sim, seed ${options.seed}, ${options.days} days${sets ? `, with ${sets}` : ""}`];
  for (const [name, { metrics, days }] of Object.entries(results)) {
    const shown = [...CHECKPOINTS.filter((day) => day < days.length), days.length];
    const rows = shown.map((n) => {
      const day = days[n - 1];
      return [n, day.wallet.lifetimeCoins, day.horde.size, day.horde.level, day.horde.gear, day.bosses.cleared, total(days.slice(0, n), "purchases")];
    });
    lines.push("", `${name}: ${about[name]}`, table(["day", "coins earned", "horde", "level", "gear", "bosses", "purchases"], rows), "");
    lines.push(table(["metric", "value"], Object.entries(metrics).map(([key, value]) => [key, show(value, METRICS[key], options.days)])));
  }
  if (checks) {
    const range = ({ min, max }) => [min != null && `min ${min}`, max != null && `max ${max}`].filter(Boolean).join(", ");
    const rows = checks.map((row) => [row.pass ? "PASS" : "FAIL", `${row.persona}.${row.metric}`, show(row.value, METRICS[row.metric], options.days), range(row)]);
    lines.push("", "Feel targets", table(["", "metric", "value", "target"], rows), `  ${checks.filter((row) => row.pass).length} of ${checks.length} targets pass.`);
  }
  return lines.join("\n");
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const config = override(loadConfig(CONFIG_FILE), options.sets);
  const plans = Object.fromEntries(Object.entries(PERSONAS).map(([name, persona]) => [name, syntheticPlan(persona)]));
  const about = Object.fromEntries(Object.entries(PERSONAS).map(([name, { activeOf7, turns, battles }]) => [name, `active ${activeOf7} of 7 days, about ${turns[0]} turns and ${battles} battles a day`]));
  const names = options.persona === "all" ? [...Object.keys(PERSONAS), ...(options.fromT3 ? ["owner"] : [])] : [options.persona];
  if (names.includes("owner")) {
    const realDays = await readT3Days(options.fromT3);
    const completed = realDays.flat().filter((turn) => turn.outcome === "completed").length;
    plans.owner = replayPlan(realDays);
    about.owner = `${realDays.length} real days from T3 with ${completed} completed turns, looped, ${OWNER_BATTLES} battles a day`;
  }
  const runs = Object.fromEntries(names.map((name) => [name, simulate(config, plans[name], options.days, options.seed)]));
  const typical = runs.typical ?? (names.includes("farmer") ? simulate(config, plans.typical, options.days, options.seed) : null);
  const results = Object.fromEntries(names.map((name) => [name, { metrics: measure(name, runs[name], config, typical), days: runs[name].log }]));
  const checks = options.check ? score(JSON.parse(readFileSync(TARGETS_FILE, "utf8")), results) : null;
  if (options.json) {
    const check = checks ? { passed: checks.every((row) => row.pass), results: checks } : undefined;
    console.log(JSON.stringify({ seed: options.seed, days: options.days, overrides: Object.fromEntries(options.sets), personas: results, check }));
  } else console.log(report({ options, about, results, checks }));
  return checks?.some((row) => !row.pass) ? 1 : 0;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
  console.error(error.message);
  process.exitCode = 2;
});
