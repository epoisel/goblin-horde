/**
 * The lock over pets.json, in temporary state folders. Process ids here are invented and `alive` says which of
 * them run, except where a test asks the real viewerHolds about a real loopback server.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import * as fsPromises from "node:fs/promises";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { HELD_MESSAGE, LOCKED, LOCK_FILE, createPetsLock, lockHolder, viewerHolds } from "../lib/pets-lock.mjs";
import { createPetsService } from "../lib/pets-service.mjs";
import { createPetsStore } from "../lib/pets-store.mjs";
import { createRewardEngine } from "../lib/reward-engine.mjs";
import { loadConfig } from "../lib/rewards.mjs";

const CONFIG = loadConfig(fileURLToPath(new URL("../game_config.json", import.meta.url)));

function stateDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "goblin-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A clock a test moves by hand, as an observer's own clock is: no date on a file and no change of the computer's date moves it. */
function stopwatch() {
  let ms = 0;
  return { now: () => ms, pass(more) { ms += more; } };
}

/**
 * Locks for invented processes over one folder; `running` holds the process ids that are alive. Each lock is an
 * observer of its own, and all of them read the one stopwatch `watch`, as processes on one computer read one clock.
 * These locks look once each time they are asked, so that a test says how much time passes between two looks.
 */
function processes(dir, running = new Set(), watch = stopwatch()) {
  return {
    running,
    watch,
    lock(pid, options = {}) {
      running.add(pid);
      return createPetsLock({ dir, pid, startedAt: pid * 1000, alive: (id) => running.has(id), confirm: async () => true, wait: false, monotonic: watch.now, pause: async (ms) => watch.pass(ms),
        ...options });
    },
  };
}
const holder = (dir) => JSON.parse(readFileSync(join(dir, LOCK_FILE), "utf8"));

test("the first process takes the lock, a second is refused while the first runs, and release frees it", async (t) => {
  const dir = stateDir(t);
  const { lock } = processes(dir);
  const [first, second] = [lock(1001, { port: 43917 }), lock(1002)];

  assert.deepEqual(await first.acquire(), { ok: true });
  assert.deepEqual(holder(dir), { pid: 1001, startedAt: 1_001_000, port: 43917 });
  assert.deepEqual(await second.acquire(), { ok: false, holder: { pid: 1001, startedAt: 1_001_000, port: 43917 } });
  assert.deepEqual([await first.held(), await second.held()], [true, false]);
  assert.deepEqual(await first.acquire(), { ok: true }, "the holder may ask again");

  second.release();
  assert.equal(holder(dir).pid, 1001, "a process that does not hold the lock cannot release it");
  first.release();
  assert.equal(existsSync(join(dir, LOCK_FILE)), false);
  assert.equal(await first.held(), false);
  assert.deepEqual(await second.acquire(), { ok: true });
  assert.equal(holder(dir).pid, 1002);
});

test("a lock whose process is gone is taken over, and the old holder no longer holds it", async (t) => {
  const dir = stateDir(t);
  const { lock, running } = processes(dir);
  const [crashed, next] = [lock(1001), lock(1002)];
  await crashed.acquire();
  running.delete(1001);
  assert.deepEqual(await next.acquire(), { ok: true });
  assert.deepEqual([await crashed.held(), await next.held()], [false, true]);
  crashed.release();
  assert.equal(holder(dir).pid, 1002, "the old holder's release leaves the new lock alone");
  assert.deepEqual(readdirSync(dir), [LOCK_FILE], "nothing of the stale lock is left behind");
});

test("a lock from an earlier process with this process's own id is stale", async (t) => {
  const dir = stateDir(t);
  const { lock } = processes(dir);
  await lock(1001).acquire();
  const reused = createPetsLock({ dir, pid: 1001, startedAt: 9_999_000, alive: () => true, confirm: async () => true });
  assert.deepEqual(await reused.acquire(), { ok: true });
  assert.equal(holder(dir).startedAt, 9_999_000);
});

test("a live process id is not enough: the lock holds only while a viewer with that id answers on its port", async (t) => {
  const dir = stateDir(t);
  let answer = (response) => response.end(JSON.stringify({ product: "GoblinHorde", pid: 1001 }));
  const viewer = createServer((request, response) => answer(response));
  await new Promise((resolve) => viewer.listen(0, "127.0.0.1", resolve));
  t.after(() => { viewer.closeAllConnections(); viewer.close(); });
  const { port } = viewer.address();
  const quick = (held) => viewerHolds(held, { timeoutMs: 300 });
  const { lock } = processes(dir);
  await lock(1001, { port }).acquire();
  const contender = lock(1002, { confirm: quick });

  assert.equal((await contender.acquire()).ok, false, "the viewer answers with the lock's process id");
  answer = () => {};
  assert.equal((await contender.acquire()).ok, false, "a viewer too busy to answer still holds its lock");
  answer = (response) => response.end("<html>not a viewer</html>");
  assert.equal(await quick({ pid: 1001, port }), false, "another program on that port");
  answer = (response) => response.end(JSON.stringify({ product: "GoblinHorde", pid: 4242 }));
  assert.equal(await quick({ pid: 1001, port }), false, "another viewer on that port");
  assert.equal(await quick({ pid: 1001 }), true, "a holder that named no port is judged by its process alone");
  assert.deepEqual(await contender.acquire(), { ok: true }, "process 1001 is some other program now");

  viewer.closeAllConnections();
  await new Promise((resolve) => viewer.close(resolve));
  assert.equal(await quick({ pid: 1002, port }), false, "nothing listens on the port");
});

test("a lock that cannot be read is being written, until an observer has seen it sit unreadable for seconds", async (t) => {
  const dir = stateDir(t);
  const path = join(dir, LOCK_FILE);
  for (const text of ["", "{\"pid\":", "{\"pid\":\"1001\"}", "[]"]) {
    const { lock, watch } = processes(dir);
    writeFileSync(path, text);
    // Its date says a minute ago, or a minute from now. Neither says anything: this observer has only just seen it.
    for (const ago of [60_000, -60_000]) {
      dated(dir, ago);
      const contender = lock(1002);
      assert.deepEqual(await contender.acquire(), { ok: false, holder: null }, `${JSON.stringify(text)}, dated ${ago} ms ago`);
      watch.pass(4000);
      assert.deepEqual(await contender.acquire(), { ok: false, holder: null }, `${JSON.stringify(text)}, seen for 4 seconds`);
      watch.pass(1500);
      assert.deepEqual(await contender.acquire(), { ok: true }, `${JSON.stringify(text)}, seen unchanged for more than 5 seconds`);
      contender.release();
      writeFileSync(path, text);
    }
    rmSync(path);
  }
});

test("of many processes that find the same stale lock at once, exactly one takes it", async (t) => {
  for (let round = 0; round < 20; round += 1) {
    const dir = mkdtempSync(join(tmpdir(), "goblin-lock-race-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { lock, running } = processes(dir);
    await lock(999).acquire();
    running.delete(999);
    const contenders = [1001, 1002, 1003, 1004, 1005, 1006].map((pid) => lock(pid));
    const results = await Promise.all(contenders.map((contender) => contender.acquire()));
    const winners = contenders.filter((contender, index) => results[index].ok);
    assert.equal(winners.length, 1, `round ${round}: ${results.map((result) => result.ok).join(" ")}`);
    assert.deepEqual(await Promise.all(contenders.map((contender) => contender.held())), results.map((result) => result.ok));
  }
});

/** Give the lock in `dir` the date of `ms` ago (or, below zero, of that long from now). A date is not a heartbeat: only a change of it is. */
function dated(dir, ms) {
  const at = new Date(Date.now() - ms);
  utimesSync(join(dir, LOCK_FILE), at, at);
}

test("a lock whose process id another program now has is taken once it has shown an observer no heartbeat for 20 seconds", async (t) => {
  // pets-adopt crashed with the lock, which names no port, and Windows handed its process id to another program.
  const hung = createServer(() => {});
  await new Promise((resolve) => hung.listen(0, "127.0.0.1", resolve));
  t.after(() => { hung.closeAllConnections(); hung.close(); });
  for (const left of [{ pid: 1001, startedAt: 1 }, { pid: 1001, startedAt: 1, port: hung.address().port }]) {
    const dir = stateDir(t);
    writeFileSync(join(dir, LOCK_FILE), JSON.stringify(left));
    const watch = stopwatch();
    const observer = { alive: () => true, confirm: (held) => viewerHolds(held, { timeoutMs: 200 }), monotonic: watch.now, pause: async (ms) => watch.pass(ms) };
    assert.deepEqual(await lockHolder(dir, observer), left, "one look cannot call a lock free whose process id is alive");
    assert.equal(await lockHolder(dir, { ...observer, wait: true }), null, "whoever watches it for 20 seconds and sees no heartbeat knows nobody holds it");
    assert.ok(watch.now() >= 20_000 && watch.now() < 22_000, `it was watched for ${watch.now()} ms`);

    // Another observer starts its own count: what one process saw frees nothing for the next. This one looks once each time it is asked.
    const contender = createPetsLock({ dir, pid: 2002, startedAt: 2, ...observer, wait: false });
    assert.deepEqual(await contender.acquire(), { ok: false, holder: left }, "seen for the first time, a lock whose process id is alive holds");
    watch.pass(15_000);
    assert.equal((await contender.acquire()).ok, false, "15 seconds without a heartbeat is not yet stale");
    watch.pass(6_000);
    assert.deepEqual(await contender.acquire(), { ok: true }, "21 seconds without a heartbeat, and the lock is taken whatever its process id says");
    assert.equal(holder(dir).pid, 2002);
    contender.release();
  }
});

test("the date on a lock means nothing: an hour ahead does not keep it, and an hour behind does not free it", async (t) => {
  const HOUR = 3_600_000;
  const stopped = { setTimer: () => 1, clearTimer: () => {} };
  {
    // The review's case: the holder stopped beating, and the lock's date is an hour ahead.
    const dir = stateDir(t);
    const { lock, watch } = processes(dir);
    await lock(1001, stopped).acquire();
    dated(dir, -HOUR);
    const contender = lock(1002);
    assert.deepEqual(await contender.acquire(), { ok: false, holder: { pid: 1001, startedAt: 1_001_000 } });
    watch.pass(21_000);
    assert.ok(statSync(join(dir, LOCK_FILE)).mtimeMs - Date.now() > 50 * 60_000, "its date is still most of an hour ahead");
    assert.deepEqual(await contender.acquire(), { ok: true }, "21 seconds with no heartbeat free it, whatever its date says");
    assert.equal(holder(dir).pid, 1002);
    contender.release();
  }
  {
    // A holder that runs on a computer whose date was set back: its lock is dated an hour ago, and every heartbeat is dated earlier than the last.
    const dir = stateDir(t);
    const { lock, watch } = processes(dir);
    await lock(1001, stopped).acquire();
    dated(dir, HOUR);
    const contender = lock(1002);
    assert.deepEqual(await contender.acquire(), { ok: false, holder: { pid: 1001, startedAt: 1_001_000 } }, "an old date alone frees nothing");
    assert.deepEqual(await lockHolder(dir, { alive: () => true, confirm: async () => true }), { pid: 1001, startedAt: 1_001_000 });
    for (const hoursBack of [2, 3, 4]) {
      watch.pass(15_000);
      dated(dir, hoursBack * HOUR);
      assert.equal((await contender.acquire()).ok, false, `a heartbeat dated ${hoursBack} hours ago is still a heartbeat`);
    }
    watch.pass(19_000);
    assert.equal((await contender.acquire()).ok, false, "19 seconds after the last heartbeat it still holds");
    watch.pass(2_000);
    assert.deepEqual(await contender.acquire(), { ok: true }, "and 21 seconds after the last one it is free");
    contender.release();
  }
});

test("on the real clock, a lock asked for is watched: one that shows no heartbeat is taken, and one that beats is left", async (t) => {
  const always = { alive: () => true, confirm: async () => true };
  const silent = stateDir(t);
  await createPetsLock({ dir: silent, pid: 780_001, startedAt: 1, ...always, setTimer: () => 1, clearTimer: () => {} }).acquire();
  dated(silent, -3_600_000);
  // The review's probe: a holder that stopped, a date an hour ahead, and a contender that asks once, as any lock does unless it is told otherwise.
  const taker = createPetsLock({ dir: silent, pid: 780_002, startedAt: 2, ...always, staleMs: 600, lookMs: 40 });
  let started = performance.now();
  assert.deepEqual(await taker.acquire(), { ok: true }, "no clock is faked here: it watched for 600 ms of its own time");
  let took = performance.now() - started;
  assert.ok(took >= 550 && took < 5000, `the lock was taken after ${Math.round(took)} ms`);
  taker.release();

  const beating = stateDir(t);
  const live = createPetsLock({ dir: beating, pid: 780_003, startedAt: 3, ...always, beatMs: 60 });
  await live.acquire();
  t.after(() => live.release());
  dated(beating, 3_600_000);
  const refused = createPetsLock({ dir: beating, pid: 780_004, startedAt: 4, ...always, staleMs: 2500, lookMs: 40 });
  started = performance.now();
  assert.deepEqual(await refused.acquire(), { ok: false, holder: { pid: 780_003, startedAt: 3 } });
  took = performance.now() - started;
  assert.ok(took < 2000, `a heartbeat was seen and the wait ended after ${Math.round(took)} ms, long before the 2.5 seconds were up`);
  started = performance.now();
  assert.deepEqual(await refused.acquire({ wait: false }), { ok: false, holder: { pid: 780_003, startedAt: 3 } }, "told to look once, it answers at once");
  assert.ok(performance.now() - started < 40);
});

test("six real processes that find the same stale lock at once: exactly one takes it", { timeout: 120_000 }, async (t) => {
  const contender = fileURLToPath(new URL("./helpers/lock-contender.mjs", import.meta.url));
  // A lock whose process is gone, and one whose process id is alive (this test's own) and that shows no heartbeat.
  for (const [what, left] of [["its process is gone", { pid: 999_999_999, startedAt: 1 }], ["its process id is alive and it shows no heartbeat", { pid: process.pid, startedAt: 1 }]]) {
    const dir = stateDir(t);
    writeFileSync(join(dir, LOCK_FILE), JSON.stringify(left));
    const children = Array.from({ length: 6 }, () => spawn(process.execPath, [contender, dir, "700"], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true }));
    t.after(() => { for (const child of children) child.kill(); });
    /** The next whole line `child` prints. */
    const line = (child) => new Promise((resolve, reject) => {
      let out = "";
      const read = (chunk) => {
        out += chunk;
        if (!out.includes("\n")) return;
        child.stdout.off("data", read);
        resolve(out.trim());
      };
      child.stdout.on("data", read);
      child.once("exit", () => reject(new Error(`a contender ended without a word: ${out}`)));
    });
    // Each says it is ready before any is told to go, so all six look at the lock in the same moment.
    assert.deepEqual(await Promise.all(children.map(line)), Array(6).fill("ready"));
    const answers = children.map(line);
    for (const child of children) child.stdin.write("go\n");
    const results = (await Promise.all(answers)).map((answer) => JSON.parse(answer));
    const winners = results.filter((result) => result.ok);
    assert.equal(winners.length, 1, `${what}: ${results.map((result) => result.ok).join(" ")}`);
    assert.equal(holder(dir).pid, winners[0].pid, `${what}: the lock names the one that took it`);
    assert.ok(children.some((child) => child.pid === winners[0].pid), "and it is one of the six");
    const exits = children.map((child) => new Promise((resolve) => child.once("exit", resolve)));
    for (const child of children) child.stdin.end();
    await Promise.all(exits);
    assert.equal(existsSync(join(dir, LOCK_FILE)), false, `${what}: the winner gave the lock up when it ended`);
  }
});

test("a holder's heartbeat keeps its lock, and one that stops for 20 seconds loses it and cannot take it back", async (t) => {
  const dir = stateDir(t);
  const { lock, watch } = processes(dir);
  // The holder's timer is held here, so the test says when its heartbeat runs. Not running it is a stopped process.
  const beats = [];
  const stopped = [];
  const holderLock = lock(1001, { port: 43917, setTimer: (run, ms) => { beats.push({ run, ms }); return beats.length; }, clearTimer: (timer) => stopped.push(timer) });
  await holderLock.acquire();
  await holderLock.acquire();
  assert.deepEqual(beats.map((beat) => beat.ms), [5000], "one heartbeat timer, every 5 seconds");
  const contender = lock(1002);

  assert.equal((await contender.acquire()).ok, false);
  watch.pass(15_000);
  dated(dir, 60_000);
  await beats[0].run();
  assert.ok(Date.now() - statSync(join(dir, LOCK_FILE)).mtimeMs < 5000, "a heartbeat stamps the lock with about the time it is");
  watch.pass(15_000);
  assert.equal((await contender.acquire()).ok, false, "30 seconds after the first look, but a heartbeat came in between, so the count began again");

  watch.pass(21_000);
  assert.deepEqual(await contender.acquire(), { ok: true }, "the holder's process is alive and its viewer answers, but it has shown no heartbeat for 21 seconds");
  const taken = readFileSync(join(dir, LOCK_FILE), "utf8");
  await beats[0].run();
  assert.equal(readFileSync(join(dir, LOCK_FILE), "utf8"), taken, "the old holder's heartbeat, when it wakes, leaves the new lock as it is");
  assert.deepEqual([await holderLock.held(), await contender.held()], [false, true]);
  assert.deepEqual(stopped, [1], "and it stops its own heartbeat");
  assert.equal((await holderLock.acquire()).ok, false, "it does not take the lock back from a holder that is alive");
  holderLock.release();
  assert.equal(holder(dir).pid, 1002);
  contender.release();
});

test("a lock is touched every few seconds while it is held, and never after it is released", async (t) => {
  const dir = stateDir(t);
  const { lock } = processes(dir);
  const held = lock(1001, { beatMs: 20 });
  await held.acquire();
  dated(dir, 10_000);
  const touched = () => Date.now() - statSync(join(dir, LOCK_FILE)).mtimeMs < 5000;
  for (const end = Date.now() + 5000; !touched() && Date.now() < end;) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(touched(), "the heartbeat ran by itself");
  held.release();
  writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ pid: 1001, startedAt: 1_001_000 }));
  dated(dir, 10_000);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(Date.now() - statSync(join(dir, LOCK_FILE)).mtimeMs > 9000, "a released lock's timer is stopped, even with the same words back in the file");
});

test("of many processes that find the same lock with a stopped heartbeat at once, exactly one takes it", async (t) => {
  for (let round = 0; round < 20; round += 1) {
    const dir = mkdtempSync(join(tmpdir(), "goblin-lock-beat-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { lock, watch } = processes(dir);
    // Its process stays alive, as a stopped or busy one is, so only the heartbeat says the lock is free.
    await lock(999, { setTimer: () => 1, clearTimer: () => {} }).acquire();
    const contenders = [1001, 1002, 1003, 1004, 1005, 1006].map((pid) => lock(pid));
    assert.deepEqual((await Promise.all(contenders.map((contender) => contender.acquire()))).map((result) => result.ok), Array(6).fill(false), "seen for the first time, it holds");
    watch.pass(25_000);
    const results = await Promise.all(contenders.map((contender) => contender.acquire()));
    assert.equal(results.filter((result) => result.ok).length, 1, `round ${round}: ${results.map((result) => result.ok).join(" ")}`);
    assert.deepEqual(await Promise.all(contenders.map((contender) => contender.held())), results.map((result) => result.ok));
    for (const contender of contenders) contender.release();
  }
});

/** An engine over the real store in `dir`, with a source that pays `turns()` unpaid turns on each read. `fs` is the store's file system. */
function engineOver(dir, lock, turns = () => 0, fs = fsPromises) {
  let paid = 0;
  const source = {
    async read(watermark) {
      const events = Array.from({ length: turns() - paid }, (_, index) => ({ id: `turn-${paid + index}`, kind: "turn", at: Date.now(), outcome: "completed", inputTokens: 50_000, outputTokens: 2_000 }));
      paid += events.length;
      return { ok: true, events, watermark: { at: Date.now(), seen: [] } };
    },
  };
  return createRewardEngine({ config: CONFIG, store: createPetsStore({ dir, fs }), source, lock });
}

/**
 * node:fs/promises whose `step` (such as "rename") stops at a gate once `shut()` was called, until `open()`.
 * `reached` settles when a save has arrived at the gate.
 */
function gated(step) {
  let shut = false;
  let arrive = () => {};
  let release = () => {};
  const gate = {
    reached: null,
    shut() {
      shut = true;
      gate.reached = new Promise((resolve) => { arrive = resolve; });
      gate.opened = new Promise((resolve) => { release = resolve; });
    },
    open() { shut = false; release(); },
    fs: { ...fsPromises, async [step](...args) { if (shut) { arrive(); await gate.opened; } return fsPromises[step](...args); } },
  };
  return gate;
}
const savedCoins = (dir) => JSON.parse(readFileSync(join(dir, "pets.json"), "utf8")).state.wallet.coins;

test("a second engine on the same state folder is refused, never writes, and opens once the first is done", async (t) => {
  const dir = stateDir(t);
  const { lock } = processes(dir);
  const first = engineOver(dir, lock(1001));
  await first.start();
  assert.equal((await first.buy("recruit")).ok, false, "25 coins do not buy a recruit, so the save stays as it began");
  const before = readFileSync(join(dir, "pets.json"), "utf8");

  const second = engineOver(dir, lock(1002));
  await assert.rejects(second.start(), (error) => error.code === LOCKED && error.message === HELD_MESSAGE);
  let retry = null;
  const lines = [];
  const service = createPetsService({ engine: second, setTimer: (run) => { retry = run; return {}; }, clearTimer: () => {}, log: (line) => lines.push(line) });
  await service.begin();
  assert.deepEqual(service.status(), { ready: false, reason: "locked", message: "Another Goblin Horde on this computer already runs the game." });
  await retry();
  await retry();
  assert.deepEqual(service.status(), { ready: false, reason: "locked", message: HELD_MESSAGE });
  assert.equal(lines.length, 1, "the refusal is logged once, not on every try");
  await assert.rejects(second.buy("recruit"), /start\(\)/);
  assert.equal(readFileSync(join(dir, "pets.json"), "utf8"), before, "the refused engine wrote nothing");
  assert.deepEqual(readdirSync(dir).sort(), ["pets.json", "pets.lock"]);

  await first.close();
  await retry();
  assert.equal(service.status().ready, true, "the next try finds the lock free");
  assert.equal(holder(dir).pid, 1002);
  await service.stop();
  assert.equal(existsSync(join(dir, LOCK_FILE)), false, "a stopped service gives the saved game up");
});

test("an engine that lost its lock saves nothing more, so two engines never both write", async (t) => {
  const dir = stateDir(t);
  const { lock } = processes(dir);
  let finished = 0;
  const first = engineOver(dir, lock(1001), () => finished);
  await first.start();
  finished = 1;
  assert.equal((await first.tick()).ok, true);
  const coins = savedCoins(dir);
  assert.ok(coins > CONFIG.horde.startCoins, "the holder is paid and saves");

  rmSync(join(dir, LOCK_FILE));
  const second = engineOver(dir, lock(1002));
  await second.start();
  finished = 2;
  const refused = await first.tick();
  assert.deepEqual([refused.ok, refused.reason], [false, "save"]);
  assert.match(refused.message, /another Goblin Horde on this computer took over the saved game\.$/);
  await assert.rejects(first.fight(0));
  assert.equal(savedCoins(dir), coins, "the engine without the lock paid nothing into the save");
  assert.equal(first.snapshot().state.wallet.coins, coins, "and shows no coins it could not save");
  await first.close();
  assert.equal(holder(dir).pid, 1002, "closing it leaves the new holder's lock alone");
});

test("closing an engine waits for the save it is in the middle of, so the lock is never free while that save can still land", async (t) => {
  const dir = stateDir(t);
  const { lock } = processes(dir);
  const gate = gated("rename");
  let finished = 0;
  const first = engineOver(dir, lock(1001), () => finished, gate.fs);
  await first.start();
  const before = savedCoins(dir);

  // The review's case: a save that has passed the lock check and now waits, and a close that comes meanwhile.
  finished = 1;
  gate.shut();
  const paying = first.tick();
  await gate.reached;
  let closed = false;
  const closing = Promise.resolve(first.close()).then(() => { closed = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(closed, false, "close has not finished while the save is on its way");
  assert.equal(holder(dir).pid, 1001, "and the lock is still the closing engine's");
  let later = 0;
  const second = engineOver(dir, lock(1002), () => later);
  await assert.rejects(second.start(), (error) => error.code === LOCKED, "so no other engine opens the saved game under the pending save");
  await assert.rejects(first.buy("recruit"), /closing/, "the closing engine takes no new work");
  await assert.rejects(first.tick(), /closing/);
  assert.equal(savedCoins(dir), before);

  gate.open();
  assert.equal((await paying).ok, true, "the save that was on its way lands");
  await closing;
  const paid = savedCoins(dir);
  assert.ok(paid > before);
  assert.equal(existsSync(join(dir, LOCK_FILE)), false, "and only then is the lock given up");

  await second.start();
  assert.equal(second.snapshot().state.wallet.coins, paid, "the next engine starts from the save that landed");
  later = 2;
  assert.equal((await second.tick()).turns, 2);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(savedCoins(dir) > paid);
  assert.equal(savedCoins(dir), second.snapshot().state.wallet.coins, "nothing of the first engine lands after the second one saved");
  await second.close();
});

test("on the real clock, an engine that is slow to save and closing keeps its lock from a contender that watches it, because its heartbeat goes on", async (t) => {
  const dir = stateDir(t);
  const always = { alive: () => true, confirm: async () => true };
  const gate = gated("rename");
  let finished = 0;
  // A real heartbeat, every 40 ms. The contender would call a lock gone after 600 ms without one.
  const slow = engineOver(dir, createPetsLock({ dir, pid: 710_001, startedAt: 1, ...always, beatMs: 40 }), () => finished, gate.fs);
  await slow.start();
  finished = 1;
  gate.shut();
  const paying = slow.tick();
  await gate.reached;
  const closing = slow.close();
  const contender = createPetsLock({ dir, pid: 710_002, startedAt: 2, ...always, staleMs: 600, lookMs: 30 });
  assert.deepEqual(await contender.acquire(), { ok: false, holder: { pid: 710_001, startedAt: 1 } }, "the closing engine's lock shows its heartbeat, and is left alone");
  // The save stays on its way for longer than the 600 ms after which a silent lock would be taken.
  await sleep(800);
  assert.deepEqual(await contender.acquire(), { ok: false, holder: { pid: 710_001, startedAt: 1 } }, "however long the save takes, a holder that beats holds");
  assert.equal(holder(dir).pid, 710_001);

  gate.open();
  assert.equal((await paying).ok, true, "the save lands");
  await closing;
  assert.deepEqual(await contender.acquire(), { ok: true }, "and with the engine closed the lock is free at once");
  contender.release();
});

test("a save that was on its way when the lock was taken over writes nothing, so the new holder's save stays", async (t) => {
  const dir = stateDir(t);
  const { lock, watch } = processes(dir);
  const gate = gated("open");
  let finishedHere = 0;
  let finishedThere = 0;
  // Its heartbeat never runs, as in a process that is stopped in the middle of a save.
  const stuck = engineOver(dir, lock(1001, { setTimer: () => 1, clearTimer: () => {} }), () => finishedHere, gate.fs);
  await stuck.start();
  const shown = stuck.snapshot().state.wallet.coins;

  finishedHere = 1;
  gate.shut();
  const paying = stuck.tick();
  await gate.reached;
  // The stuck engine's process showed no heartbeat for 21 seconds, so another engine takes the lock, and saves.
  const next = engineOver(dir, lock(1002), () => finishedThere);
  await assert.rejects(next.start(), (error) => error.code === LOCKED, "its first look finds the lock held");
  watch.pass(21_000);
  await next.start();
  finishedThere = 3;
  assert.equal((await next.tick()).turns, 3);
  const theirs = readFileSync(join(dir, "pets.json"), "utf8");
  const theirBackup = readFileSync(join(dir, "pets.json.bak"), "utf8");

  gate.open();
  const refused = await paying;
  assert.deepEqual([refused.ok, refused.reason], [false, "save"]);
  assert.match(refused.message, /another Goblin Horde on this computer took over the saved game\.$/);
  assert.equal(readFileSync(join(dir, "pets.json"), "utf8"), theirs, "the late save did not land over the new holder's");
  assert.equal(readFileSync(join(dir, "pets.json.bak"), "utf8"), theirBackup, "nor over its backup");
  assert.deepEqual(readdirSync(dir).sort(), ["pets.json", "pets.json.bak", "pets.lock"], "and it left no temp file");
  assert.equal(stuck.snapshot().state.wallet.coins, shown, "the engine that could not save shows no coins it did not save");
  await stuck.close();
  assert.equal(holder(dir).pid, 1002);
  await next.close();
});

test("an engine with no lock runs as before, for tests and tools that own their folder", async (t) => {
  const dir = stateDir(t);
  const engine = engineOver(dir, null);
  await engine.start();
  await engine.close();
  assert.deepEqual(readdirSync(dir), ["pets.json"]);
  await assert.rejects(engine.tick(), /closing/, "a closed engine does nothing more");
});
