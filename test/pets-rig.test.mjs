import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { goblinStateDir } from "../lib/paths.mjs";
import { startRig } from "../scripts/dev/pets-rig.mjs";
import { hasSqlite } from "./helpers/t3-fixture.mjs";

const needsSqlite = { skip: !hasSqlite && "this Node.js has no node:sqlite", timeout: 60_000 };
const RIG = fileURLToPath(new URL("../scripts/dev/pets-rig.mjs", import.meta.url));

// The places a rig must leave alone: the home folder, T3's folder, and Goblin Horde's real state folder.
const REAL = [homedir(), join(homedir(), ".t3"), process.env.LOCALAPPDATA, goblinStateDir({ env: { ...process.env, GOBLIN_HORDE_STATE_DIR: "" } })].filter(Boolean);
// Names only, since other programs rewrite their files there all the time, and without the half-written
// .tmp files that come and go between two listings.
const names = (dir) => (existsSync(dir) ? readdirSync(dir).filter((name) => !name.endsWith(".tmp")).sort() : null);
const realListing = () => Object.fromEntries(REAL.map((dir) => [dir, names(dir)]));

const pets = async (port) => (await fetch(`http://127.0.0.1:${port}/api/pets?after=0`)).json();
const numbers = ({ game: { state } }) => ({ horde: state.horde.size, bosses: state.bosses.cleared, coins: state.wallet.coins });

/** The viewer's answer once its coins pass `coins`, or its last answer when `ms` run out first. */
async function paidAbove(port, coins, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const answer = await pets(port);
    if (answer.game.state.wallet.coins > coins || Date.now() >= deadline) return answer;
    await sleep(50);
  }
}

test("a seeded rig answers as the real viewer, pays a turn within 3 seconds, and leaves nothing behind", needsSqlite, async () => {
  const before = realListing();
  const rig = await startRig({ horde: 200, bosses: 5, coins: 3000 });
  try {
    assert.ok(rig.stateDir.startsWith(tmpdir()), "the state folder is a temp folder");
    assert.deepEqual(rig.env, { GOBLIN_HORDE_STATE_DIR: rig.stateDir });
    const opened = await pets(rig.port);
    assert.equal(opened.ready, true);
    assert.deepEqual(numbers(opened), { horde: 200, bosses: 5, coins: 3000 });
    assert.equal(opened.game.nextBoss.index, 5);
    assert.deepEqual(opened.source, { ok: true });

    rig.turn();
    const paid = await paidAbove(rig.port, 3000, 3000);
    assert.ok(paid.game.state.wallet.coins > 3000, "the coins rose within 3 seconds of the turn");
    assert.deepEqual(paid.events.filter((event) => event.type === "work").map((event) => event.turns), [1]);
  } finally {
    await rig.stop();
  }
  assert.equal(existsSync(rig.dir), false, "stop() deletes the temp folder");
  await assert.rejects(pets(rig.port), "stop() ends the viewer");
  await rig.stop();
  assert.deepEqual(realListing(), before, "nothing appeared in the real home, T3, or Goblin Horde folders");
});

test("give and seed change the saved game and bring the viewer back on the same port, paying no turn twice", needsSqlite, async () => {
  const rig = await startRig();
  try {
    const opened = await pets(rig.port);
    assert.deepEqual(opened.events.map((event) => [event.type, event.welcome]), [["launch", true]], "with no seed the viewer starts a new player");
    rig.turn();
    const paid = numbers(await paidAbove(rig.port, opened.game.state.wallet.coins, 10_000));
    assert.ok(paid.coins > opened.game.state.wallet.coins);

    await rig.give(500);
    assert.deepEqual(numbers(await pets(rig.port)), { ...paid, coins: paid.coins + 500 });
    await rig.seed({ horde: 12, bosses: 2 });
    assert.deepEqual(numbers(await pets(rig.port)), { horde: 12, bosses: 2, coins: paid.coins + 500 });

    rig.turn();
    assert.ok(numbers(await paidAbove(rig.port, paid.coins + 500, 10_000)).coins > paid.coins + 500, "a turn still pays after the restarts");
  } finally {
    await rig.stop();
  }
});

test("a seed outside the game's range is refused by name before anything starts", needsSqlite, async () => {
  await assert.rejects(startRig({ bosses: 999 }), /bosses/);
  await assert.rejects(startRig({ horde: "many" }), /horde/);
});

test("the command line seeds from its flags, answers stdin commands, and deletes its folder on quit", needsSqlite, async () => {
  const child = spawn(process.execPath, [RIG, "--horde", "7", "--coins", "90"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const said = { stdout: "", stderr: "" };
  for (const stream of Object.keys(said)) child[stream].on("data", (chunk) => { said[stream] += chunk; });
  child.stdin.end("status\nnonsense\ngive gold 5\nquit\n");
  const code = await new Promise((resolve) => child.once("close", resolve));
  assert.equal(code, 0, said.stderr);
  const [, port] = /Port:\s+(\d+)/.exec(said.stdout);
  const [, stateDir] = /GOBLIN_HORDE_STATE_DIR=(.+)/.exec(said.stdout);
  assert.equal(said.stdout.match(/coins 90\b.*\bhorde 7\b/g)?.length, 2, "the seeded numbers at the start and again for status");
  assert.match(said.stderr, /Unknown command "nonsense"/);
  assert.match(said.stderr, /Only coins can be given/);
  assert.equal(existsSync(stateDir.trim()), false, "quit deletes the temp folder");
  await assert.rejects(pets(port), "quit ends the viewer");
});
