/**
 * The saved game: pets.json in the state folder, replaced atomically, with the last good copy kept beside it.
 *
 * A save writes a uniquely named temp file, keeps the current pets.json as pets.json.bak when it is valid,
 * then renames the temp over pets.json. A load that finds pets.json missing or damaged uses the backup, and
 * clears temp files a killed save left behind. One shape decides both what a load accepts and which fields a
 * save writes, so nothing outside the schema, and no free text, reaches the disk.
 *
 * The shape holds every number to what a game can reach: a count is a whole number within its limits, an amount
 * of coins, scrap or XP is at least 0 and at most a million million, and a day is a real date. With the game's
 * config, a record is fitted to that game. A count that only that game's size limits, the bosses it has, is cut
 * down to it and never refused, since a game whose boss count shrank is still the same saved game. A record
 * whose horde power, prices or next boss would not be numbers is refused.
 *
 * A saved game that cannot be read is never taken for no saved game. A load says so, with the code UNREADABLE,
 * unless the backup loads, and only a folder with neither file is a new player's. Before a save replaces a
 * pets.json that could not be read, and when a load refuses one, the file's bytes are kept beside it as
 * pets.json.unreadable.<milliseconds>-<random letters>: a file of its own, private to this account, made only
 * where no file has that name, and made once for the same bytes however often they are looked at.
 */
import { randomBytes } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createPrivateFile } from "./private-file.mjs";
import { bossRequiredPower, gearCost, hordePower, levelCosts, recruitCost, upgradeCost } from "./rewards.mjs";

/**
 * @typedef {import("./rewards.mjs").GameConfig} GameConfig
 * @typedef {import("./rewards.mjs").GameState} GameState
 * @typedef {import("./t3-source.mjs").Watermark} Watermark
 * @typedef {{ schema: 1, state: GameState, sources: { t3: Watermark }, lastSeenAt: number, notBefore?: number }} PetsRecord
 *   `notBefore` is the moment this game began on this computer: a new game's first launch, or an adoption. Work
 *   that finished at or before it is never paid, whenever it turns up. A game saved before this field has none.
 */

/** The `code` of the error a load throws for a saved game that is there and cannot be read. */
export const UNREADABLE = "PETS_UNREADABLE";
export const UNREADABLE_MESSAGE = "The saved game could not be read. A copy was kept next to it. Nothing was replaced.";

const FILE = "pets.json";
const BACKUP = `${FILE}.bak`;
// The copies of saved games that could not be read: this name, which an older version used for its one copy, and this name with a dot and more after it.
const KEPT = `${FILE}.unreadable`;
const TEMP = /^pets\.json\..+\.tmp$/;
// Windows antivirus and indexers hold files open for a moment.
const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);
// The most of each thing any game holds. Far past what play reaches, and small enough that sums stay exact.
const MOST = { amount: 1e12, size: 1_000_000, level: 1000, tier: 1000, bosses: 100_000, reruns: 1_000_000 };

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const amount = (value) => finite(value) && value >= 0 && value <= MOST.amount;
const count = (least, most) => (value) => Number.isSafeInteger(value) && value >= least && value <= most;
const optional = (check) => Object.assign((value) => check(value), { optional: true });
function day(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  // A date that does not exist either fails to parse or reads back as another day.
  try { return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value; } catch { return false; }
}

/** The pets.json format, for a game of any size. `fit` holds a record to the bosses one game has. */
const RECORD = {
  schema: (value) => value === 1,
  state: {
    schema: (value) => value === 1,
    wallet: { coins: amount, scrap: amount, lifetimeCoins: amount },
    horde: { size: count(1, MOST.size), level: count(1, MOST.level), xp: amount, gear: count(0, MOST.tier) },
    upgrades: { hoard: count(0, MOST.tier), training: count(0, MOST.tier) },
    bosses: { cleared: count(0, MOST.bosses) },
    today: {
      key: day,
      reruns: (value) => isObject(value) && Object.entries(value).every(([boss, reruns]) => /^(0|[1-9]\d{0,5})$/.test(boss) && Number(boss) < MOST.bosses && count(0, MOST.reruns)(reruns)),
    },
  },
  sources: { t3: { at: finite, seen: (value) => Array.isArray(value) && value.every((id) => typeof id === "string" && /^[\w:.-]{1,64}$/.test(id)) } },
  lastSeenAt: finite,
  notBefore: optional((value) => finite(value) && value >= 0),
};

/** `value` cut down to `shape`'s fields, or undefined when any field fails its check. An optional field may be absent. */
function conform(shape, value) {
  if (typeof shape === "function") return shape(value) ? value : undefined;
  if (!isObject(value)) return undefined;
  const picked = {};
  for (const [key, field] of Object.entries(shape)) {
    if (field.optional && value[key] === undefined) continue;
    picked[key] = conform(field, value[key]);
    if (picked[key] === undefined) return undefined;
  }
  return picked;
}

/**
 * `record` as the game `config` describes holds it: no more bosses cleared than that game has, and no rerun of a
 * boss it does not have. A game saved when there were more bosses is cut down to this, never refused.
 * @param {PetsRecord} record @param {GameConfig} config
 */
function fit(record, config) {
  const bosses = config.bosses.count;
  const { state } = record;
  const reruns = Object.fromEntries(Object.entries(state.today.reruns).filter(([boss]) => Number(boss) < bosses));
  return { ...record, state: { ...state, bosses: { cleared: Math.min(state.bosses.cleared, bosses) }, today: { ...state.today, reruns } } };
}

/** Whether everything the game works out from `state` is a number: a count within its limit can still price the next one past any number. */
function derivesNumbers(config, state) {
  const next = state.bosses.cleared;
  return [
    hordePower(config, state), recruitCost(config, state), ...Object.values(levelCosts(config, state)), gearCost(config, state) ?? 0,
    upgradeCost(config, state, "hoard") ?? 0, upgradeCost(config, state, "training") ?? 0, next < config.bosses.count ? bossRequiredPower(config, next) : 0,
  ].every(Number.isFinite);
}

/** `value` as a saved game of the pets.json format, fitted to `config`'s game when there is one, or null. */
function asRecord(value, config) {
  const record = conform(RECORD, value);
  if (!record || !config) return record ?? null;
  const fitted = fit(record, config);
  return derivesNumbers(config, fitted.state) ? fitted : null;
}

/**
 * The saved game in `text`, cut down to the pets.json format, or null when it is not one. With `config`, the
 * game's config, it is fitted to that game, and must be one whose prices that config can work out.
 * @param {string} text @param {GameConfig} [config]
 * @returns {PetsRecord | null}
 */
export function parseRecord(text, config) {
  try { return asRecord(JSON.parse(text), config); } catch { return null; }
}

/**
 * The pets.json store in `dir`, for the game `config` describes. `fs` is node:fs/promises unless a test injects
 * failures. `load` answers the saved game, or a record of null for a folder with no saved game at all, and
 * throws an error with the code UNREADABLE for one that is there and cannot be read. `save` takes `before`, a
 * check the store runs right before it puts each file in place: when it throws, that file is not written.
 * `now` and `token` name a kept copy, and `keep` makes it.
 * @returns {{ load(): Promise<{ record: PetsRecord | null, recovered: "backup" | null }>,
 *   save(record: PetsRecord, options?: { before?: () => Promise<void> }): Promise<void> }}
 */
export function createPetsStore({ dir, config, fs = fsPromises, retries = 5, delayMs = 40, now = Date.now, token = () => randomBytes(4).toString("hex"), keep = createPrivateFile }) {
  async function retry(operation) {
    for (let attempt = 0; ; attempt += 1) {
      try { return await operation(); } catch (error) {
        if (attempt >= retries || !TRANSIENT.has(error.code)) throw error;
        await sleep(delayMs * (attempt + 1));
      }
    }
  }

  /** The bytes of `name`, or null when there is no such file. */
  async function read(name) {
    try { return await retry(() => fs.readFile(join(dir, name))); } catch (error) {
      if (error.code === "ENOENT") return null;
      throw new Error(`Goblin Horde could not read ${name} (${error.code ?? error.message}), so it left the saved game untouched.`);
    }
  }
  const parse = (bytes) => (bytes === null ? null : parseRecord(bytes.toString("utf8"), config));

  // `before` runs as late as it can, when the temp file is whole and about to take the file's place. What it
  // throws stops the save with nothing put in place, and reaches the caller as it is.
  async function replace(name, text, before) {
    const temp = join(dir, `${name}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
    const failed = async (error) => {
      await fs.rm(temp, { force: true }).catch(() => {});
      return new Error(`Goblin Horde could not save ${name} (${error.code ?? error.message}), so the last saved game is kept.`);
    };
    try {
      const handle = await fs.open(temp, "w");
      try {
        await handle.writeFile(text);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) { throw await failed(error); }
    try { await before(); } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => {});
      throw error;
    }
    try { await retry(() => fs.rename(temp, join(dir, name))); } catch (error) { throw await failed(error); }
  }

  async function removeStaleTemps() {
    const names = await fs.readdir(dir).catch(() => []);
    await Promise.all(names.filter((name) => TEMP.test(name)).map((name) => fs.rm(join(dir, name), { force: true }).catch(() => {})));
  }

  /**
   * Keep `bytes`, a saved game that could not be read, as a file of its own, unless a copy with these very bytes
   * is there already. The new copy is made only under a name no file has, so no earlier copy is written over.
   * Throws when the copy cannot be made, and then whoever asked must leave everything as it is.
   */
  async function preserve(bytes) {
    const names = await fs.readdir(dir).catch(() => []);
    for (const name of names.filter((name) => name === KEPT || name.startsWith(`${KEPT}.`))) {
      const copy = await fs.readFile(join(dir, name)).catch(() => null);
      if (copy?.equals(bytes)) return;
    }
    try { keep(join(dir, `${KEPT}.${now()}-${token()}`), bytes); } catch (error) {
      throw new Error(`Goblin Horde could not keep a copy of the saved game it could not read (${error.code ?? error.name}), so it left everything as it was.`);
    }
  }

  return {
    async load() {
      await removeStaleTemps();
      const mainBytes = await read(FILE);
      const main = parse(mainBytes);
      if (main) return { record: main, recovered: null };
      const backupBytes = await read(BACKUP);
      const backup = parse(backupBytes);
      if (backup) return { record: backup, recovered: "backup" };
      // Only a folder with no saved game and no backup of one is a new player's.
      if (mainBytes === null && backupBytes === null) return { record: null, recovered: null };
      await preserve(mainBytes ?? backupBytes);
      throw Object.assign(new Error(UNREADABLE_MESSAGE), { code: UNREADABLE });
    },

    async save(record, { before = async () => {} } = {}) {
      const next = asRecord(record, config);
      if (!next) throw new Error("Goblin Horde refused to save a game that does not match the pets.json format.");
      await fs.mkdir(dir, { recursive: true });
      const bytes = await read(FILE);
      // The backup is cut down to the format too, so a field an older version saved is not written again.
      const current = parse(bytes);
      if (current) await replace(BACKUP, JSON.stringify(current), before);
      // A pets.json this version cannot read is about to be replaced, so its bytes are kept beside it first.
      else if (bytes !== null) await preserve(bytes);
      await replace(FILE, JSON.stringify(next), before);
    },
  };
}
