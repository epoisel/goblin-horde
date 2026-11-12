#!/usr/bin/env node
/**
 * The pet game in a sandbox, for trying it out and for screenshots: the real viewer (server.mjs) on a free
 * port, over a temp folder that holds its state folder and a fixture T3 database.
 *
 *   node scripts/dev/pets-rig.mjs [--horde N] [--bosses N] [--coins N] [--grip N]
 *
 * The viewer's home and app-data folders point into the temp folder and GOBLIN_T3_DB names the fixture, so
 * nothing reads or writes the real ~/.t3 or the real Goblin Horde state. The rig prints what a
 * Python widget needs to join it, then reads the commands in COMMANDS from stdin. The viewer is the saved
 * game's only writer, so the rig writes pets.json only while no viewer runs: a seed is saved before the first
 * start, and `give` and `horde` stop the viewer, save, and start it again on the same port.
 *
 * Needs Node.js 22.13 or newer, for node:sqlite.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createPetsStore } from "../../lib/pets-store.mjs";
import { localDayKey } from "../../lib/reward-engine.mjs";
import { createState, loadConfig } from "../../lib/rewards.mjs";
import { initialWatermark } from "../../lib/t3-source.mjs";
import { createT3Fixture, hasSqlite, usage as tokenUsage } from "../../test/helpers/t3-fixture.mjs";

/**
 * @typedef {{ horde?: number | string, bosses?: number | string, coins?: number | string, grip?: number | string }} Seed
 *   The horde's size, the bosses cleared, the coins held, and the grip upgrade's level. A field left out keeps its saved value.
 */

const SOURCE = fileURLToPath(new URL("../..", import.meta.url));
const NO_SQLITE = `The pets rig needs Node.js 22.13 or newer for its built-in SQLite (this is ${process.versions.node}).`;
// A medium turn is the fixture's own default: 50,000 fresh input tokens, and a 25th of that in output.
const MEDIUM_TURN = 50_000;
const OUTPUT_PER_INPUT = 1 / 25;
const OPEN_MS = 15_000;

function whole(name, value, min = 0, max = Infinity) {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be a whole number from ${min}${max === Infinity ? " up" : ` to ${max}`}.`);
  }
  return number;
}

// Coins put in count as earned, as the coins the game pays do.
const withCoins = (state, coins) => ({
  ...state,
  wallet: { ...state.wallet, coins, lifetimeCoins: state.wallet.lifetimeCoins + Math.max(0, coins - state.wallet.coins) },
});

// Each seed field: its range, and the saved game with the number put in.
const SEED = {
  horde: { min: 1, max: () => Infinity, put: (state, size) => ({ ...state, horde: { ...state.horde, size } }) },
  bosses: { min: 0, max: (config) => config.bosses.count, put: (state, cleared) => ({ ...state, bosses: { cleared } }) },
  coins: { min: 0, max: () => Infinity, put: withCoins },
  grip: { min: 0, max: (config) => config.upgrades.grip.max, put: (state, grip) => ({ ...state, upgrades: { ...state.upgrades, grip } }) },
};

/** The change `seed` makes to a saved game's state. Throws a plain Error for a number out of range. */
function seedChange(config, seed) {
  const puts = Object.entries(SEED).filter(([name]) => seed[name] != null)
    .map(([name, { min, max, put }]) => [put, whole(name, seed[name], min, max(config))]);
  return (state) => puts.reduce((next, [put, value]) => put(next, value), state);
}

async function freePort() {
  const probe = createServer();
  await new Promise((done) => probe.listen(0, "127.0.0.1", done));
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}

function tail(file, lines = 3) {
  try { return readFileSync(file, "utf8").trim().split(/\r?\n/).slice(-lines).join("\n"); } catch { return ""; }
}

/**
 * Start the rig, seeded when `seed` names any number. Calls on the handle must not overlap.
 * @param {Seed} [seed]
 * @returns {Promise<{ dir: string, port: number, stateDir: string, env: { GOBLIN_HORDE_STATE_DIR: string },
 *   turn(tokens?: number | string): void, seed(seed: Seed): Promise<void>, give(coins: number | string): Promise<void>,
 *   pets(): Promise<object>, stop(): Promise<void> }>}
 *   `dir` is the temp folder and `stateDir` the state folder inside it. `env` is what a Python widget's
 *   environment needs, beside `--port`, to keep its own files in the rig's folder. `turn` finishes one turn in
 *   the fixture. `seed` and `give` restart the viewer on the same port. `pets` is the viewer's GET /api/pets
 *   answer. `stop` ends the viewer and deletes `dir`, and is safe to call again.
 */
export async function startRig(seed = {}) {
  if (!hasSqlite) throw new Error(NO_SQLITE);
  const config = loadConfig(join(SOURCE, "game_config.json"));
  const firstChange = seedChange(config, seed);
  const seeded = Object.keys(SEED).some((name) => seed[name] != null);
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const dir = mkdtempSync(join(tmpdir(), "goblin-pets-rig-"));
  const stateDir = join(dir, "state");
  const home = join(dir, "home");
  const logFile = join(dir, "viewer.log");
  for (const folder of [stateDir, home]) mkdirSync(folder);
  // A widget pointed at a state folder with no settings would copy the real Activity Lens settings into it.
  writeFileSync(join(stateDir, "goblins.json"), "{}");
  const fixture = createT3Fixture({ dir: join(dir, "t3") });
  const store = createPetsStore({ dir: stateDir });
  // Every folder the viewer could look in, its home folder included, inside the temp folder.
  const viewerEnv = {
    ...process.env, PORT: String(port), GOBLIN_HORDE_STATE_DIR: stateDir, GOBLIN_T3_DB: fixture.path,
    HOME: home, USERPROFILE: home, LOCALAPPDATA: join(dir, "local"), APPDATA: join(dir, "roaming"),
  };
  let viewer = null;
  let turns = 0;
  let stopping = null;

  async function pets() {
    const response = await fetch(`${url}/api/pets`).catch(() => null);
    if (!response) throw new Error("The rig's viewer is not answering.");
    return response.json();
  }

  async function openViewer() {
    // A stop that lands while a restart is under way must not be followed by a new viewer.
    if (stopping) throw new Error("The rig has stopped.");
    const log = openSync(logFile, "a");
    viewer = spawn(process.execPath, [join(SOURCE, "server.mjs")], { env: viewerEnv, stdio: ["ignore", log, log], windowsHide: true });
    closeSync(log);
    const deadline = Date.now() + OPEN_MS;
    let said = "";
    while (Date.now() < deadline && viewer.exitCode === null) {
      const answer = await pets().catch(() => null);
      if (answer?.ready) return;
      said = answer?.message ?? said;
      await sleep(50);
    }
    throw new Error(["The rig's viewer did not open the game.", said || tail(logFile)].filter(Boolean).join("\n"));
  }

  async function closeViewer() {
    if (!viewer || viewer.exitCode !== null || viewer.signalCode !== null) return;
    const exited = new Promise((done) => viewer.once("exit", done));
    viewer.kill();
    await exited;
  }

  async function rewrite(change) {
    await closeViewer();
    try {
      const now = Date.now();
      const saved = (await store.load()).record
        ?? { schema: 1, state: createState(config, localDayKey(now)), sources: { t3: initialWatermark(now) }, lastSeenAt: now };
      // Saved as seen just now, so the viewer pays no idle coins for the time before this.
      await store.save({ ...saved, state: change(saved.state), lastSeenAt: now });
    } finally {
      await openViewer();
    }
  }

  const stop = () => (stopping ??= (async () => {
    await closeViewer();
    try { fixture.close(); } catch { /* The folder is deleted just below, and a failure there is reported. */ }
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      throw new Error(`The rig stopped, but ${dir} could not be deleted (${error.code ?? error.message}). Close any widget started on it, then delete the folder.`);
    }
  })());

  try {
    await (seeded ? rewrite(firstChange) : openViewer());
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }

  return {
    dir,
    port,
    stateDir,
    env: { GOBLIN_HORDE_STATE_DIR: stateDir },
    turn(tokens = MEDIUM_TURN) {
      const input = whole("tokens", tokens);
      turns += 1;
      fixture.addTurn({ id: `rig-${turns}`, completedAt: Date.now(), tokens: tokenUsage(input, Math.round(input * OUTPUT_PER_INPUT)) });
    },
    seed: async (next) => rewrite(seedChange(config, next)),
    async give(coins) {
      const added = whole("coins", coins, 1);
      await rewrite((state) => withCoins(state, state.wallet.coins + added));
    },
    pets,
    stop,
  };
}

/** The game's numbers on one line, from a GET /api/pets answer. */
function summary(answer) {
  if (!answer.ready) return answer.message || answer.error || "The game is not open.";
  const { state: { wallet, horde, bosses }, power, nextBoss } = answer.game;
  return [
    `coins ${wallet.coins}`, `scrap ${wallet.scrap}`, `horde ${horde.size}`, `level ${horde.level}`, `xp ${horde.xp}`, `gear ${horde.gear}`,
    `bosses ${bosses.cleared}`, `power ${Number(power.toFixed(2))}`,
    nextBoss ? `next boss ${nextBoss.index} needs ${nextBoss.requiredPower}` : "no boss left",
    `events ${answer.seq}`, `source ${answer.source.ok ? "ok" : answer.source.reason}`,
  ].join("  ");
}

// The stdin commands: how each is typed, what it does, and its action over the words after its name.
const COMMANDS = {
  turn: {
    usage: "turn [tokens]",
    about: `Finish one turn of that many fresh input tokens (${MEDIUM_TURN}, a medium turn, unless told).`,
    run(rig, [tokens = MEDIUM_TURN]) {
      rig.turn(tokens);
      return `A turn of ${tokens} tokens finished.`;
    },
  },
  turns: {
    usage: "turns N [gapMs]",
    about: "Finish N medium turns, gapMs apart (0 unless told; 1100 pays each one on its own).",
    async run(rig, [count, gapMs = 0]) {
      const [total, gap] = [whole("N", count, 1), whole("gapMs", gapMs)];
      for (let done = 0; done < total; done += 1) {
        if (done) await sleep(gap);
        rig.turn();
      }
      return `${total} turns finished.`;
    },
  },
  give: {
    usage: "give coins N",
    about: "Add N coins to the saved game. Restarts the viewer.",
    async run(rig, [what, coins = ""]) {
      if (what !== "coins") throw new Error("Only coins can be given: give coins N.");
      await rig.give(coins);
      return summary(await rig.pets());
    },
  },
  horde: {
    usage: "horde N [bosses]",
    about: "Set the horde's size and, when given, the bosses cleared. Restarts the viewer.",
    async run(rig, [size = "", bosses]) {
      await rig.seed({ horde: size, bosses });
      return summary(await rig.pets());
    },
  },
  status: { usage: "status", about: "Print the game's numbers from GET /api/pets.", run: async (rig) => summary(await rig.pets()) },
  wait: {
    usage: "wait [ms]",
    about: "Do nothing for that long (1500 unless told), so a script can let a turn pay.",
    async run(rig, [ms = 1500]) { await sleep(whole("ms", ms)); },
  },
  help: { usage: "help", about: "Print this list.", run: () => commandList() },
  quit: { usage: "quit", about: "Stop the viewer and delete the temp folder. The end of stdin does the same." },
};
const commandList = () => Object.values(COMMANDS).map(({ usage, about }) => `  ${usage.padEnd(18)}${about}`).join("\n");
const USAGE = "Usage: node scripts/dev/pets-rig.mjs [--horde N] [--bosses N] [--coins N] [--grip N]";

function welcome(rig, answer) {
  const { GOBLIN_HORDE_STATE_DIR: stateDir } = rig.env;
  const widget = `$env:GOBLIN_HORDE_STATE_DIR = '${stateDir}'; python desktop_widget.py --port ${rig.port}`;
  return [
    "The pets rig is up: the real viewer over a temp folder and a fixture T3 database.",
    `  Port:        ${rig.port}`,
    `  State dir:   ${rig.stateDir}`,
    `  Widget env:  GOBLIN_HORDE_STATE_DIR=${stateDir}`,
    `  Widget run:  ${widget}`,
    `  Viewer log:  ${join(rig.dir, "viewer.log")}`,
    `  ${summary(answer)}`,
    "Type help for the commands. quit, or the end of stdin, stops the viewer and deletes the temp folder.",
  ].join("\n");
}

async function main(argv) {
  const options = { horde: { type: "string" }, bosses: { type: "string" }, coins: { type: "string" }, grip: { type: "string" }, help: { type: "boolean", short: "h" } };
  let values;
  try { ({ values } = parseArgs({ args: argv, options })); } catch (error) { throw new Error(`${error.message}\n${USAGE}`); }
  if (values.help) {
    console.log(`${USAGE}\n\nCommands on stdin:\n${commandList()}`);
    return;
  }
  const rig = await startRig(values);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => rig.stop().catch((error) => console.error(error.message)).finally(() => process.exit(0)));
  }
  try {
    console.log(welcome(rig, await rig.pets()));
    for await (const line of createInterface({ input: process.stdin })) {
      const [name, ...words] = line.trim().split(/\s+/);
      if (name === "quit") break;
      if (!name) continue;
      try {
        if (!Object.hasOwn(COMMANDS, name)) throw new Error(`Unknown command "${name}". Type help for the list.`);
        const said = await COMMANDS[name].run(rig, words);
        if (said) console.log(said);
      } catch (error) {
        console.error(error.message);
      }
    }
  } finally {
    await rig.stop();
  }
  console.log("The rig stopped and its temp folder is deleted.");
}

const fold = (path) => (process.platform === "win32" ? path.toLowerCase() : path);
if (fold(resolve(process.argv[1] || "")) === fold(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
