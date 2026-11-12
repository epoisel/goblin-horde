import test from "node:test";
import assert from "node:assert/strict";
import { createPetsService } from "../lib/pets-service.mjs";
import { UNREADABLE } from "../lib/pets-store.mjs";

const QUIET = { welcome: false, away: null, caughtUp: { turns: 0, coins: 0 } };
const NO_COUNTS = { coins: 0, xp: 0, turns: 0, subagents: 0 };
const NOTHING = { ok: true, ...NO_COUNTS };
const SNAPSHOT = { state: { wallet: { coins: 25 } }, power: 3 };
const SENTENCE = /^[A-Z][^\n]*\.$/;
const paid = (coins) => ({ ok: true, coins, xp: 1, turns: 1, subagents: 0 });

/** Timers the test holds: `fire()` runs the one live timer, as setInterval would on its next turn. */
function fakeTimers() {
  const all = [];
  const live = () => all.filter((timer) => !timer.cleared);
  return {
    live,
    setTimer(run, ms) {
      const timer = { run, ms, cleared: false, unrefs: 0, unref() { this.unrefs += 1; } };
      all.push(timer);
      return timer;
    },
    clearTimer(timer) { timer.cleared = true; },
    fire() {
      const timers = live();
      assert.equal(timers.length, 1, "exactly one timer runs at a time");
      return timers[0].run();
    },
  };
}

/** An engine that answers start() and tick() from scripts: an Error rejects, a function is called, anything else resolves. */
function fakeEngine({ starts = [], ticks = [] } = {}) {
  const calls = { start: 0, tick: 0, buy: [], fight: [] };
  const play = (script, fallback) => {
    const next = script.length ? script.shift() : fallback;
    if (next instanceof Error) return Promise.reject(next);
    return typeof next === "function" ? next() : Promise.resolve(next);
  };
  return {
    calls,
    start() { calls.start += 1; return play(starts, QUIET); },
    tick() { calls.tick += 1; return play(ticks, NOTHING); },
    snapshot: () => SNAPSHOT,
    async buy(kind) { calls.buy.push(kind); return { ok: true, reason: null }; },
    async fight(boss) { calls.fight.push(boss); return { won: true, ratio: 1.2 }; },
  };
}

function serviceOver(engine, options = {}) {
  const timers = fakeTimers();
  const lines = [];
  let time = 1_000;
  const service = createPetsService({ engine, now: () => (time += 1), setTimer: timers.setTimer, clearTimer: timers.clearTimer, log: (line) => lines.push(line), ...options });
  return { service, timers, lines };
}

test("begin opens the saved game once, and then every tick pays the work that finished", async () => {
  const engine = fakeEngine({ ticks: [NOTHING, paid(12), NOTHING] });
  const { service, timers, lines } = serviceOver(engine, { tickMs: 250 });
  const waiting = service.status();
  assert.equal(waiting.ready, false);
  assert.match(waiting.message, SENTENCE);
  assert.deepEqual(timers.live(), [], "nothing runs before begin");

  await service.begin();
  await service.begin();
  assert.equal(engine.calls.start, 1, "a second begin opens nothing again");
  assert.deepEqual(service.status(), { ready: true, boot: service.status().boot, seq: 0, source: { ok: true } }, "the first check ran, so a ready game knows its source");
  assert.deepEqual(timers.live().map((timer) => [timer.ms, timer.unrefs]), [[250, 1]], "one tick timer, which never keeps the process alive");

  await timers.fire();
  assert.deepEqual(service.eventsAfter(0), [{ seq: 1, at: 1_001, type: "work", coins: 12, xp: 1, turns: 1, subagents: 0 }]);
  assert.equal(service.status().seq, 1);
  await timers.fire();
  assert.equal(service.status().seq, 1, "a tick that pays nothing is no event");
  assert.equal(engine.calls.tick, 3);
  assert.deepEqual(lines, []);
});

test("a tick is an event when any of its coins, xp, turns or subagents is above 0", async () => {
  for (const field of ["coins", "xp", "turns", "subagents"]) {
    const { service, timers } = serviceOver(fakeEngine({ ticks: [NOTHING, { ...NOTHING, [field]: 2, ids: ["provider-turn:abc"] }] }));
    await service.begin();
    await timers.fire();
    assert.deepEqual(service.eventsAfter(0), [{ seq: 1, at: 1_001, type: "work", ...NO_COUNTS, [field]: 2 }], field);
  }
});

test("a tick that fires while the last one still runs is skipped", async () => {
  let finish;
  const slow = () => new Promise((resolve) => { finish = resolve; });
  const engine = fakeEngine({ ticks: [NOTHING, slow] });
  const { service, timers } = serviceOver(engine);
  await service.begin();
  const running = timers.fire();
  await timers.fire();
  await timers.fire();
  assert.equal(engine.calls.tick, 2, "the check from begin and the slow tick, and no other");
  finish(paid(5));
  await running;
  assert.equal(service.status().seq, 1);
  await timers.fire();
  assert.equal(engine.calls.tick, 3, "the next tick runs once the slow one is done");
});

test("event numbers start at 1 and keep growing while the list drops its oldest", async () => {
  const engine = fakeEngine({ ticks: [NOTHING, ...[10, 20, 30, 40, 50].map(paid)] });
  const { service, timers } = serviceOver(engine, { ringSize: 3 });
  await service.begin();
  for (let tick = 0; tick < 5; tick += 1) await timers.fire();
  assert.deepEqual(service.eventsAfter(0).map((event) => [event.seq, event.coins]), [[3, 30], [4, 40], [5, 50]]);
  assert.equal(service.status().seq, 5);
  assert.deepEqual(service.eventsAfter(4).map((event) => event.seq), [5]);
  assert.deepEqual(service.eventsAfter(5), []);
});

test("a start that fails is tried again every 30 seconds until the game opens, and never throws", async () => {
  const broken = new Error("Goblin Horde could not read pets.json (EPERM), so it left the saved game untouched.\n    at readText (pets-store.mjs:81:13)");
  const back = { welcome: false, away: { minutes: 90, coins: 3 }, caughtUp: { turns: 0, coins: 0 } };
  const engine = fakeEngine({ starts: [broken, broken, back] });
  const { service, timers, lines } = serviceOver(engine);

  await service.begin();
  const waiting = service.status();
  assert.equal(waiting.ready, false);
  assert.match(waiting.message, SENTENCE);
  assert.ok(!waiting.message.includes("EPERM"), "the answer is fixed words; the cause goes to the log");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /could not read pets\.json \(EPERM\)/);
  assert.ok(!lines[0].includes("\n"), "one line, without the stack");
  assert.deepEqual(timers.live().map((timer) => [timer.ms, timer.unrefs]), [[30_000, 1]]);
  assert.equal(engine.calls.tick, 0, "nothing is paid before the game opens");

  await timers.fire();
  assert.equal(service.status().ready, false);
  assert.equal(lines.length, 1, "the same problem is not logged again on every try");
  assert.deepEqual(timers.live().map((timer) => timer.ms), [30_000]);

  await timers.fire();
  assert.equal(engine.calls.start, 3);
  assert.deepEqual(service.status(), { ready: true, boot: service.status().boot, seq: 1, source: { ok: true } });
  assert.deepEqual(service.eventsAfter(0), [{ seq: 1, at: 1_001, type: "launch", ...back }]);
  assert.deepEqual(timers.live().map((timer) => timer.ms), [1000], "the retry timer gave way to the tick timer");
});

test("a saved game that cannot be read is said so in its own words, changes nothing, and opens once the owner has moved it away", async () => {
  const words = "The saved game could not be read. A copy was kept next to it. Nothing was replaced.";
  const unreadable = () => Object.assign(new Error(words), { code: UNREADABLE });
  const engine = fakeEngine({ starts: [unreadable(), unreadable(), { welcome: true, away: null, caughtUp: { turns: 0, coins: 0 } }] });
  const { service, timers, lines } = serviceOver(engine);
  await service.begin();
  assert.deepEqual([service.status().ready, service.status().message], [false, words]);
  assert.equal(engine.calls.tick, 0, "no work is paid into a game that is not open");
  assert.deepEqual(timers.live().map((timer) => timer.ms), [30_000], "it looks again every 30 seconds");
  await timers.fire();
  assert.deepEqual([service.status().ready, service.status().message], [false, words]);
  assert.equal(lines.length, 1, "and says so in the log once");
  assert.match(lines[0], /The saved game could not be read\. A copy was kept next to it\. Nothing was replaced\.$/);
  await timers.fire();
  assert.equal(service.status().ready, true, "with the file moved away, a game opens");
});

test("a tick that fails or rejects adds no event, shows as the source's state, and never throws", async () => {
  const busy = { ok: false, reason: "locked", message: "T3 Code's database is busy right now, so Goblin Horde will try again on the next check." };
  const crash = () => new Error("EPERM: operation not permitted, open 'C:\\Users\\someone\\pets.json'\n    at open");
  const engine = fakeEngine({ ticks: [NOTHING, { ...busy, ids: ["provider-turn:abc"] }, crash(), crash(), paid(7), crash()] });
  const { service, timers, lines } = serviceOver(engine);
  await service.begin();

  await timers.fire();
  assert.deepEqual(service.status(), { ready: true, boot: service.status().boot, seq: 0, source: busy });
  assert.deepEqual(lines, [], "a source that cannot be read is a state, not a log line");

  await timers.fire();
  const { source } = service.status();
  assert.equal(source.ok, false);
  assert.match(source.message, SENTENCE);
  assert.ok(!source.message.includes("someone"), "the answer is fixed words; the cause goes to the log");
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("EPERM") && !lines[0].includes("\n"));
  await timers.fire();
  assert.equal(lines.length, 1, "the same problem is not logged again on every tick");
  assert.equal(service.status().seq, 0);

  await timers.fire();
  assert.deepEqual(service.status(), { ready: true, boot: service.status().boot, seq: 1, source: { ok: true } });
  await timers.fire();
  assert.equal(lines.length, 2, "a problem that comes back after a good tick is logged again");
});

test("the launch is an event only when there is something to show", async () => {
  const cases = [
    ["a new player", { welcome: true, away: null, caughtUp: { turns: 0, coins: 0 } }, true],
    ["coins banked while away", { welcome: false, away: { minutes: 180, coins: 18 }, caughtUp: { turns: 0, coins: 0 } }, true],
    ["missed work that paid", { welcome: false, away: null, caughtUp: { turns: 2, coins: 24 } }, true],
    ["nothing new", QUIET, false],
    ["missed work that paid nothing", { welcome: false, away: null, caughtUp: { turns: 3, coins: 0 } }, false],
  ];
  for (const [name, launch, shown] of cases) {
    const { service } = serviceOver(fakeEngine({ starts: [{ ...launch, record: { sources: { t3: { seen: ["provider-turn:abc"] } } } }] }));
    await service.begin();
    assert.deepEqual(service.eventsAfter(0), shown ? [{ seq: 1, at: 1_001, type: "launch", ...launch }] : [], name);
  }
});

test("stop ends the ticking, the retrying, and a start still on its way", async () => {
  const ticking = serviceOver(fakeEngine());
  await ticking.service.begin();
  ticking.service.stop();
  assert.deepEqual(ticking.timers.live(), []);
  assert.equal(ticking.service.status().ready, false);

  const retrying = serviceOver(fakeEngine({ starts: [new Error("no save")] }));
  await retrying.service.begin();
  retrying.service.stop();
  assert.deepEqual(retrying.timers.live(), []);

  for (const outcome of [QUIET, new Error("no save")]) {
    let finish;
    const engine = fakeEngine({ starts: [() => new Promise((resolve, reject) => { finish = () => (outcome instanceof Error ? reject(outcome) : resolve(outcome)); })] });
    const starting = serviceOver(engine);
    const begun = starting.service.begin();
    starting.service.stop();
    finish();
    await begun;
    assert.deepEqual(starting.timers.live(), [], "no timer starts after stop");
    assert.equal(starting.service.status().ready, false);
  }
});

test("stop is done only when the engine has closed, so whoever stops the game can wait for its last save", async () => {
  let closed;
  const closing = new Promise((resolve) => { closed = resolve; });
  const engine = { ...fakeEngine(), close: () => closing };
  const { service, timers } = serviceOver(engine);
  await service.begin();
  let stopped = false;
  const stopping = service.stop().then(() => { stopped = true; });
  assert.deepEqual(timers.live(), [], "the ticking ends at once");
  assert.equal(service.status().ready, false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stopped, false, "but stop waits while the engine is closing");
  closed();
  await stopping;
  assert.equal(stopped, true);
  await service.stop();
});

test("without an engine the game stays off and says why", async () => {
  const { service, timers, lines } = serviceOver(null);
  await service.begin();
  const status = service.status();
  assert.equal(status.ready, false);
  assert.match(status.message, SENTENCE);
  assert.deepEqual(timers.live(), []);
  service.stop();
  assert.deepEqual(lines, []);
});

test("the game, a purchase and a fight go straight to the engine", async () => {
  const engine = fakeEngine();
  const { service } = serviceOver(engine);
  await service.begin();
  assert.equal(service.game(), SNAPSHOT);
  assert.deepEqual(await service.buy("recruit"), { ok: true, reason: null });
  assert.deepEqual(await service.fight(2), { won: true, ratio: 1.2 });
  assert.deepEqual([engine.calls.buy, engine.calls.fight], [["recruit"], [2]]);
});

test("boot stays the same through a run and differs from the next run's, so a client knows event numbers began again", async () => {
  const first = serviceOver(fakeEngine({ ticks: [paid(3), paid(4)] }));
  await first.service.begin();
  const opened = first.service.status().boot;
  await first.timers.fire();
  assert.equal(first.service.status().boot, opened, "a tick does not change it");
  assert.match(opened, /^[0-9a-f]{8}$/);
  const second = serviceOver(fakeEngine({ ticks: [paid(3)] }));
  await second.service.begin();
  assert.notEqual(second.service.status().boot, opened);
});
