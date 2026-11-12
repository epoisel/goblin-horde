import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { localOnlyRefusal } from "../lib/local-only.mjs";
import { petsRoutes } from "../lib/pets-routes.mjs";
import { createPetsService } from "../lib/pets-service.mjs";
import { loadConfig } from "../lib/rewards.mjs";
import { createT3Fixture, hasSqlite, TRAP, usage } from "./helpers/t3-fixture.mjs";

const SENTENCE = /^[A-Z][^\n]*\.$/;
const STATE = {
  schema: 1,
  wallet: { coins: 64, scrap: 0, lifetimeCoins: 39 },
  horde: { size: 3, level: 1, xp: 1, gear: 0 },
  upgrades: { hoard: 0, training: 0, grip: 0 },
  bosses: { cleared: 0 },
  today: { key: "2026-11-10", reruns: {} },
};
const GAME = {
  state: STATE,
  quotes: { recruit: { coins: 40 }, level: { xp: 40, coins: 15 }, gear: { scrap: 20 }, hoard: { coins: 40 }, training: { coins: 30 }, grip: { coins: 50 } },
  power: 3,
  nextBoss: { index: 0, requiredPower: 2.5 },
};
const REWARDS = { coins: 20, scrap: 4, xp: 40 };
const NOTHING = { ok: true, coins: 0, xp: 0, turns: 0, subagents: 0 };
const MISSING = { ok: false, reason: "missing", message: "T3 Code's database was not found, so open T3 Code once on this computer and Goblin Horde will start counting its work." };
// What an engine and its source hold beside the game. The fake engine puts it on everything it returns.
const PRIVATE = { seen: [`provider-turn:abc:${TRAP.label}`], title: TRAP.title, prompt: TRAP.prompt, apiKey: TRAP.secret, path: "C:\\Users\\someone\\.t3\\userdata\\statev2.sqlite" };
const LEAKS = [...Object.values(TRAP), "provider-turn", "someone"];
const KEYS = {
  ready: ["boot", "events", "game", "ready", "seq", "source"],
  game: ["nextBoss", "power", "quotes", "state"],
  work: ["at", "coins", "seq", "subagents", "turns", "type", "xp"],
  launch: ["at", "away", "caughtUp", "seq", "type", "welcome"],
  buy: ["game", "ok", "reason"],
  fight: ["first", "game", "ratio", "reason", "rewards", "won"],
};
const keys = (value) => Object.keys(value).sort();

function fakeEngine({ start = async () => ({ welcome: true, away: null, caughtUp: { turns: 0, coins: 0 }, private: PRIVATE }), ticks = [], buy = null, fight = null } = {}) {
  const calls = [];
  return {
    calls,
    start,
    tick: async () => ({ ...(ticks.shift() ?? NOTHING), private: PRIVATE }),
    snapshot: () => ({ ...GAME, source: { ok: true, private: PRIVATE }, sources: { t3: PRIVATE } }),
    async buy(kind) {
      calls.push(["buy", kind]);
      return buy ? buy(kind) : { state: STATE, ok: kind !== "gear", reason: kind === "gear" ? "scrap" : null, private: PRIVATE };
    },
    async fight(boss) {
      calls.push(["fight", boss]);
      return fight ? fight(boss) : { state: STATE, won: true, ratio: 1.2, first: true, rewards: REWARDS, reason: null, private: PRIVATE };
    },
  };
}

// server.mjs's own json, readBody and fail, copied here because importing server.mjs starts the viewer.
const BODY_LIMIT = 12_000;
const tooLarge = () => Object.assign(new Error("Request is too large."), { statusCode: 413 });
function json(response, status, data) {
  response.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}
async function readBody(request) {
  if (Number(request.headers["content-length"]) > BODY_LIMIT) {
    request.resume();
    throw tooLarge();
  }
  const input = await new Promise((resolve, reject) => {
    let text = "";
    let overflow = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (overflow) return;
      text += chunk;
      if (text.length > BODY_LIMIT) { overflow = true; text = ""; }
    });
    request.on("end", () => (overflow ? reject(tooLarge()) : resolve(text)));
    request.on("error", reject);
  });
  try { return JSON.parse(input); } catch { throw Object.assign(new Error("Invalid request."), { statusCode: 400 }); }
}
// The real server tells another computer by its address. Every request here is local, so a test's caller from
// another computer says it is one.
const isLocal = (request) => !request.headers["x-elsewhere"];
function fail(response, status, message) {
  if (response.headersSent) return response.destroy();
  return json(response, status, { error: message });
}

/** A local HTTP server with the pets routes mounted as server.mjs mounts them, over a service on `engine`. */
async function viewer(t, engine) {
  let tick = null;
  const service = createPetsService({ engine, now: () => 1_800_000_000_000, setTimer: (run) => { tick = run; return {}; }, clearTimer: () => {}, log: () => {} });
  const route = petsRoutes(service);
  const server = createServer(async (request, response) => {
    const origin = `http://${request.headers.host}`;
    try {
      const answered = await route(request, response, { url: new URL(request.url, origin), local: isLocal(request), origin, json, readBody, fail });
      if (!answered) json(response, 404, { error: "Not found" });
    } catch { fail(response, 500, "Unexpected error."); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const own = { "Content-Type": "application/json", Origin: base };
  const texts = [];
  const ask = async (path, options) => {
    const response = await fetch(`${base}${path}`, options);
    const text = await response.text();
    texts.push(text);
    return { status: response.status, body: JSON.parse(text) };
  };
  return {
    service, base, own, texts,
    tick: () => tick(),
    get: (path, headers = {}) => ask(path, { headers }),
    post: (path, body, headers = own) => ask(path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }),
  };
}

function assertNothingPrivate(texts) {
  assert.ok(texts.length > 0);
  for (const text of texts) {
    for (const leak of LEAKS) assert.ok(!text.includes(leak), `"${leak}" reached an answer: ${text}`);
  }
}

test("GET /api/pets says the game is opening, and once it is open answers the game, its source, and the events after a number", async (t) => {
  const engine = fakeEngine({ ticks: [NOTHING, { ok: true, coins: 39, xp: 1, turns: 1, subagents: 0 }, MISSING] });
  const view = await viewer(t, engine);

  const opening = await view.get("/api/pets");
  assert.equal(opening.status, 200);
  assert.deepEqual(keys(opening.body), ["message", "ready", "reason"]);
  assert.deepEqual([opening.body.ready, opening.body.reason], [false, "opening"]);
  assert.match(opening.body.message, SENTENCE);

  await view.service.begin();
  await view.tick();
  const { status, body } = await view.get("/api/pets");
  assert.equal(status, 200);
  assert.deepEqual(keys(body), KEYS.ready);
  assert.deepEqual([body.ready, body.seq, body.source], [true, 2, { ok: true }]);
  assert.deepEqual(body.game, GAME);
  assert.deepEqual(keys(body.game), KEYS.game);
  assert.deepEqual(body.events.map((event) => [event.seq, event.type, keys(event)]), [[1, "launch", KEYS.launch], [2, "work", KEYS.work]]);
  assert.deepEqual(body.events[0], { seq: 1, at: 1_800_000_000_000, type: "launch", welcome: true, away: null, caughtUp: { turns: 0, coins: 0 } });
  assert.deepEqual(body.events[1], { seq: 2, at: 1_800_000_000_000, type: "work", coins: 39, xp: 1, turns: 1, subagents: 0 });

  const seqsAfter = async (query) => (await view.get(`/api/pets${query}`)).body.events.map((event) => event.seq);
  assert.deepEqual(await seqsAfter("?after=1"), [2]);
  assert.deepEqual(await seqsAfter("?after=2"), []);
  assert.deepEqual(await seqsAfter("?after=0"), [1, 2]);
  for (const query of ["?after=", "?after=soon", "?after=1.5", "?after=Infinity", "?before=2"]) assert.deepEqual(await seqsAfter(query), [1, 2], `${query} means 0`);

  await view.tick();
  const unread = (await view.get("/api/pets?after=2")).body;
  assert.deepEqual(unread.source, MISSING, "a source that cannot be read still leaves the game open");
  assert.deepEqual([unread.ready, unread.seq, unread.events], [true, 2, []]);
  assertNothingPrivate(view.texts);
});

test("only this computer, from its own page, with a JSON body, may use a route that changes something", () => {
  const origin = "http://127.0.0.1:5000";
  const json = { origin, "content-type": "application/json" };
  assert.deepEqual(localOnlyRefusal({ local: false, origin, headers: json }), { status: 403, error: "Only this computer can do that." });
  assert.equal(localOnlyRefusal({ local: true, origin, headers: { ...json, origin: "http://evil.example" } }).status, 403);
  assert.equal(localOnlyRefusal({ local: true, origin, headers: { origin, "content-type": "text/plain" } }).status, 403);
  assert.equal(localOnlyRefusal({ local: true, origin, headers: { "content-type": "application/json" } }).status, 403);
  assert.equal(localOnlyRefusal({ local: true, origin, headers: json }), null);
});

test("another computer is refused the game, and a purchase or a fight is taken only from this viewer's own page", async (t) => {
  const engine = fakeEngine();
  const view = await viewer(t, engine);
  await view.service.begin();
  const elsewhere = { "x-elsewhere": "1" };

  assert.deepEqual(await view.get("/api/pets", elsewhere), { status: 403, body: { error: "The game is on this computer only." } });
  for (const [path, body] of [["/api/pets/buy", { kind: "recruit" }], ["/api/pets/fight", { boss: 0 }]]) {
    const refusals = [
      ["another computer", { ...view.own, ...elsewhere }],
      ["no Origin", { "Content-Type": "application/json" }],
      ["another site's page", { "Content-Type": "application/json", Origin: "http://evil.example" }],
      ["a form, not JSON", { "Content-Type": "text/plain", Origin: view.base }],
    ];
    for (const [who, headers] of refusals) {
      const refused = await view.post(path, body, headers);
      assert.equal(refused.status, 403, `${path} from ${who}`);
      assert.deepEqual(keys(refused.body), ["error"]);
    }
  }
  assert.deepEqual(engine.calls, [], "a refused request reaches no engine");
  assert.equal((await view.get("/api/pets/buy")).status, 404, "only a POST buys");
  assert.equal((await view.get("/api/scene")).status, 404, "other routes pass through");
});

test("a body the game cannot use is answered 400 in plain words and reaches no engine", async (t) => {
  const engine = fakeEngine();
  const view = await viewer(t, engine);
  await view.service.begin();
  const bad = {
    "/api/pets/buy": [{}, { kind: "dragon" }, { kind: "vault" }, { kind: "" }, { kind: 3 }, { kind: ["recruit"] }, { kind: "constructor" }, { boss: 0 }, null, ["recruit"], "recruit", "{"],
    "/api/pets/fight": [{}, { boss: -1 }, { boss: 1.5 }, { boss: "0" }, { boss: null }, { boss: true }, { boss: [0] }, { kind: "recruit" }, null, 0, "{"],
  };
  for (const [path, bodies] of Object.entries(bad)) {
    for (const body of bodies) {
      const answer = await view.post(path, body);
      assert.equal(answer.status, 400, `${path} ${JSON.stringify(body)}`);
      assert.deepEqual(keys(answer.body), ["error"]);
      assert.match(answer.body.error, SENTENCE);
    }
  }
  assert.equal((await view.post("/api/pets/buy", { kind: "recruit", padding: "x".repeat(13_000) })).status, 413);
  assert.deepEqual(engine.calls, []);
});

test("a purchase and a fight answer their result and the game after it, and nothing else", async (t) => {
  const engine = fakeEngine();
  const view = await viewer(t, engine);
  await view.service.begin();

  const bought = await view.post("/api/pets/buy", { kind: "recruit" });
  assert.equal(bought.status, 200);
  assert.deepEqual(bought.body, { ok: true, reason: null, game: GAME });
  assert.deepEqual([keys(bought.body), keys(bought.body.game)], [KEYS.buy, KEYS.game]);
  const refused = await view.post("/api/pets/buy", { kind: "gear" });
  assert.deepEqual([refused.status, refused.body.ok, refused.body.reason], [200, false, "scrap"], "a purchase the game refuses is still an answer");
  for (const kind of ["level", "hoard", "training", "grip"]) assert.equal((await view.post("/api/pets/buy", { kind })).status, 200, kind);

  const fought = await view.post("/api/pets/fight", { boss: 0 });
  assert.equal(fought.status, 200);
  assert.deepEqual(fought.body, { won: true, ratio: 1.2, first: true, rewards: REWARDS, reason: null, game: GAME });
  assert.deepEqual([keys(fought.body), keys(fought.body.game)], [KEYS.fight, KEYS.game]);
  assert.equal((await view.post("/api/pets/fight", { boss: 35 })).status, 200);

  assert.deepEqual(engine.calls, [["buy", "recruit"], ["buy", "gear"], ["buy", "level"], ["buy", "hoard"], ["buy", "training"], ["buy", "grip"], ["fight", 0], ["fight", 35]]);
  assertNothingPrivate(view.texts);
});

test("until the game is open a purchase or a fight is answered 503, and a save that fails is answered in fixed words", async (t) => {
  const closed = fakeEngine({ start: async () => { throw new Error("Goblin Horde could not read pets.json (EPERM), so it left the saved game untouched."); } });
  for (const begin of [false, true]) {
    const view = await viewer(t, closed);
    if (begin) await view.service.begin();
    for (const [path, body] of [["/api/pets/buy", { kind: "recruit" }], ["/api/pets/fight", { boss: 0 }]]) {
      const answer = await view.post(path, body);
      assert.equal(answer.status, 503, path);
      assert.deepEqual(keys(answer.body), ["error"]);
      assert.match(answer.body.error, SENTENCE);
    }
    assert.equal((await view.get("/api/pets")).body.ready, false);
  }
  assert.deepEqual(closed.calls, []);

  const unsaved = async () => { throw new Error("EPERM: operation not permitted, mkdir 'C:\\Users\\someone\\AppData\\Local\\GoblinHorde'"); };
  const view = await viewer(t, fakeEngine({ buy: unsaved, fight: unsaved }));
  await view.service.begin();
  for (const [path, body] of [["/api/pets/buy", { kind: "recruit" }], ["/api/pets/fight", { boss: 0 }]]) {
    const answer = await view.post(path, body);
    assert.equal(answer.status, 500, path);
    assert.match(answer.body.error, SENTENCE);
  }
  assertNothingPrivate(view.texts);
});

async function freePort() {
  const probe = createServer(() => {});
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function until(read, done, problem) {
  for (let tries = 0; tries < 300; tries += 1) {
    const value = await read().catch(() => null);
    if (value && done(value)) return value;
    await sleep(50);
  }
  throw new Error(problem);
}

test("an isolated viewer pays a turn that finishes in T3 within 2 seconds, and sells a recruit for the coins",
  { skip: !hasSqlite && "this Node.js has no node:sqlite", timeout: 60_000 }, async () => {
    const config = loadConfig(fileURLToPath(new URL("../game_config.json", import.meta.url)));
    const root = mkdtempSync(join(tmpdir(), "goblin-pets-e2e-"));
    const state = join(root, "state");
    mkdirSync(state);
    const fixture = createT3Fixture({ dir: join(root, "t3") });
    const big = usage(5_000_000, 200_000);
    fixture.addTurn({ id: "before-launch", completedAt: Date.now() - 60_000, tokens: big });
    const port = await freePort();
    // Every folder temporary, and the fixture for T3.
    const env = { ...process.env, PORT: String(port), GOBLIN_HORDE_STATE_DIR: state, GOBLIN_T3_DB: fixture.path, LOCALAPPDATA: join(root, "local"), APPDATA: join(root, "roaming") };
    const url = `http://127.0.0.1:${port}`;
    const texts = [];
    const answer = async (response) => {
      const text = await response.text();
      texts.push(text);
      return JSON.parse(text);
    };
    const pets = async (after) => answer(await fetch(`${url}/api/pets?after=${after}`));
    const child = spawn(process.execPath, [fileURLToPath(new URL("../server.mjs", import.meta.url))], { env, stdio: "ignore", windowsHide: true });
    try {
      const opened = await until(() => pets(0), (body) => body.ready, "The game did not open.");
      assert.deepEqual(opened.source, { ok: true });
      assert.equal(opened.game.state.wallet.coins, config.horde.startCoins, "work that finished before the first launch pays nothing");
      assert.deepEqual(opened.events.map((event) => event.type), ["launch"]);

      const finishedAt = Date.now();
      fixture.addTurn({ id: "after-launch", completedAt: finishedAt, tokens: big });
      const paid = await until(() => pets(opened.seq), (body) => body.game.state.wallet.coins > opened.game.state.wallet.coins, "The finished turn was never paid.");
      const took = Date.now() - finishedAt;
      assert.ok(took < 2000, `the coins rose ${took} ms after the turn finished`);
      const earned = paid.game.state.wallet.coins - opened.game.state.wallet.coins;
      assert.deepEqual(paid.events.map((event) => [event.type, event.turns, event.coins]), [["work", 1, earned]]);

      const price = paid.game.quotes.recruit.coins;
      assert.ok(paid.game.state.wallet.coins >= price, "one big turn pays for a recruit");
      const bought = await answer(await fetch(`${url}/api/pets/buy`, { method: "POST", headers: { "Content-Type": "application/json", Origin: url }, body: JSON.stringify({ kind: "recruit" }) }));
      assert.deepEqual([bought.ok, bought.reason], [true, null]);
      assert.equal(bought.game.state.horde.size, paid.game.state.horde.size + 1);
      assert.equal(bought.game.state.wallet.coins, paid.game.state.wallet.coins - price);
      for (const text of texts) {
        for (const trap of Object.values(TRAP)) assert.ok(!text.includes(trap), `"${trap}" reached an answer`);
      }
    } finally {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
      fixture.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
