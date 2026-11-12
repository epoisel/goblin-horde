/**
 * The display side of a shared game, on loopback: a local viewer whose pets routes forward to a shared host
 * (the real shared handler from test/helpers/shared-host.mjs). The loopback stand-in lets 127.0.0.1 count as
 * the tailnet, and only where a test passes it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  REMOTE_CODE_FILE, REMOTE_FILE, askHost, checkHost, createRemotePets, parseHost, readRemoteSetting, removeRemoteSetting, writeRemoteSetting,
} from "../lib/pets-remote.mjs";
import { CODE, GAME, displayViewer as display, sharedHost } from "./helpers/shared-host.mjs";
import { freePort, json } from "./helpers/viewer.mjs";

const STAND_IN = { GOBLIN_SHARED_LOOPBACK: "45123" };
const UNREACHABLE = (name) => `The shared game on ${name} is not reachable. Is Goblin Horde running there?`;
const WRONG_CODE = (name) => `The shared game on ${name} did not accept this computer's pairing code.`;
const SENTENCE = /^[A-Z][^\n]*[.?]$/;
const setting = (port, code = CODE) => ({ name: "127.0.0.1", port, origin: `http://127.0.0.1:${port}`, code });

test("a host is a Tailscale address or a DNS name with a port, and nothing a pairing code should not be sent to", () => {
  const at = (text, options) => parseHost(text, { defaultPort: 43917, ...options });
  assert.deepEqual(at("100.101.102.103"), { name: "100.101.102.103", port: 43917, origin: "http://100.101.102.103:43917" });
  assert.deepEqual(at(" 100.101.102.103:43918 "), { name: "100.101.102.103", port: 43918, origin: "http://100.101.102.103:43918" });
  assert.deepEqual(at("http://Servitor.tail1234.ts.net:43917/"), { name: "servitor.tail1234.ts.net", port: 43917, origin: "http://servitor.tail1234.ts.net:43917" });
  assert.equal(at("servitor").origin, "http://servitor:43917");
  const refused = ["", "192.168.1.20", "10.0.0.5:43917", "8.8.8.8", "127.0.0.1", "100.63.0.1", "100.128.0.1", "0.0.0.0", "1.2.3", "100.101.102.103:80", "100.101.102.103:70000",
    "100.101.102.103:port", "https://100.101.102.103", "http://100.101.102.103/app", "user@100.101.102.103", "100.101.102.103 --x", "[fd7a:115c:a1e0::1]:43917", "evil.example/100.101.102.103",
    "-servitor", "servitor..ts.net", null, undefined, 43917];
  for (const text of refused) assert.equal(at(text), null, String(text));
  assert.equal(parseHost("100.101.102.103"), null, "a host without a port needs a default one");
  assert.deepEqual(at("127.0.0.1:45000", { loopback: true }), { name: "127.0.0.1", port: 45000, origin: "http://127.0.0.1:45000" });
  assert.equal(at("127.0.0.2:45000", { loopback: true }), null);
});

test("pets-join's two files round-trip, and a damaged pair still marks this computer as a display", () => {
  const dir = mkdtempSync(join(tmpdir(), "goblin-remote-"));
  try {
    assert.equal(readRemoteSetting(dir), null, "no remote.json: this computer plays its own game");
    writeRemoteSetting(dir, { origin: "http://100.101.102.103:43917", code: CODE });
    assert.deepEqual(readdirSync(dir).sort(), [REMOTE_CODE_FILE, REMOTE_FILE]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, REMOTE_FILE), "utf8")), { host: "http://100.101.102.103:43917" });
    assert.ok(!readFileSync(join(dir, REMOTE_FILE), "utf8").includes(CODE), "the code is not in remote.json");
    if (process.platform !== "win32") assert.equal(statSync(join(dir, REMOTE_CODE_FILE)).mode & 0o777, 0o600);
    assert.deepEqual(readRemoteSetting(dir), { name: "100.101.102.103", port: 43917, origin: "http://100.101.102.103:43917", code: CODE });

    const problem = (text) => {
      const read = readRemoteSetting(dir);
      assert.deepEqual(Object.keys(read), ["problem"], text);
      assert.match(read.problem, SENTENCE);
      assert.ok(!read.problem.includes(CODE));
    };
    for (const host of ["http://192.168.1.20:43917", "http://127.0.0.1:43917", "https://100.101.102.103:43917", "http://100.101.102.103", 5, null]) {
      writeFileSync(join(dir, REMOTE_FILE), JSON.stringify({ host }));
      problem(`host ${host}`);
    }
    for (const text of ["", "not json", "[]", "{}"]) {
      writeFileSync(join(dir, REMOTE_FILE), text);
      problem(text);
    }
    writeRemoteSetting(dir, { origin: "http://100.101.102.103:43917", code: CODE });
    for (const code of ["", "short", "zqxzqxzq1", "ZQXZQXZ0"]) {
      writeFileSync(join(dir, REMOTE_CODE_FILE), code);
      problem(`code ${code}`);
    }
    rmSync(join(dir, REMOTE_CODE_FILE));
    problem("no code file");

    writeFileSync(join(dir, REMOTE_FILE), JSON.stringify({ host: "http://127.0.0.1:45000" }));
    writeFileSync(join(dir, REMOTE_CODE_FILE), `${CODE}\n`);
    assert.equal(readRemoteSetting(dir, { env: STAND_IN }).origin, "http://127.0.0.1:45000", "the stand-in lets a display join 127.0.0.1");
    assert.ok(readRemoteSetting(dir, { env: {} }).problem, "and nothing else does");

    removeRemoteSetting(dir);
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(readRemoteSetting(dir), null);
    removeRemoteSetting(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a display's game is the host's own answer, unchanged, from one pairing", async (t) => {
  const host = await sharedHost(t);
  const view = await display(t, createRemotePets(setting(host.port), { env: STAND_IN }));
  const direct = (await host.call("GET", "/api/pets", { cookie: await host.session() })).body;
  host.pairing.endSessions();

  const shown = await view.get("/api/pets");
  assert.equal(shown.status, 200);
  assert.deepEqual(shown.body, direct, "boot, seq, events, game and source are the host's");
  assert.deepEqual(shown.body.game, GAME);
  assert.deepEqual((await view.get("/api/pets?after=1")).body.events, [], "the event number asked for goes to the host");
  assert.deepEqual((await view.get("/api/pets?after=0")).body.events.map((event) => event.type), ["launch"]);
  for (const query of ["?after=-4", "?after=1.5", "?after=soon", "?after=1e99"]) assert.equal((await view.get(`/api/pets${query}`)).body.events.length, 1, `${query} means 0`);
  for (let poll = 0; poll < 5; poll += 1) await view.get("/api/pets");
  assert.equal(host.pairing.sessionCount(), 1, "eleven polls, one pairing");
  assert.equal(host.seen.filter((line) => line === "POST /api/pair").length, 2, "this test's own pairing, and the display's one");
  assert.ok(!JSON.stringify(shown.body).includes(CODE) && !shown.text.includes("goblin_horde_session"), "neither the code nor the session reaches the widget");
});

test("a display pairs again when the host has signed it out or restarted", async (t) => {
  const host = await sharedHost(t);
  const view = await display(t, createRemotePets(setting(host.port), { env: STAND_IN }));
  assert.equal((await view.get("/api/pets")).body.ready, true);
  host.pairing.endSessions();
  assert.equal(host.pairing.sessionCount(), 0);
  assert.equal((await view.get("/api/pets")).body.ready, true, "the poll that met a 401 still answers the game");
  assert.equal(host.pairing.sessionCount(), 1);
  host.pairing.endSessions();
  const bought = await view.post("/api/pets/buy", { kind: "recruit" });
  assert.deepEqual([bought.status, bought.body.ok], [200, true], "and so does a purchase");
});

test("a purchase and a fight through a display reach the host's game with only their one field", async (t) => {
  const host = await sharedHost(t);
  const bodies = [];
  const remote = createRemotePets(setting(host.port), { env: STAND_IN });
  const view = await display(t, { get: remote.get, post: (path, body) => { bodies.push([path, body]); return remote.post(path, body); } });

  const bought = await view.post("/api/pets/buy", { kind: "recruit", note: "private words", boss: 3 });
  assert.equal(bought.status, 200);
  assert.deepEqual(bought.body, { ok: true, reason: null, game: GAME });
  const fought = await view.post("/api/pets/fight", { boss: 0, kind: "recruit" });
  assert.deepEqual(fought.body, { won: true, ratio: 1.2, first: true, rewards: { coins: 20, scrap: 4, xp: 40 }, reason: null, game: GAME });
  assert.deepEqual(host.game.calls, [["buy", "recruit"], ["fight", 0]]);
  assert.deepEqual(bodies, [["/api/pets/buy", { kind: "recruit" }], ["/api/pets/fight", { boss: 0 }]], "nothing else from the local request is sent on");
});

test("a display keeps the local checks: a phone, another site's page, and a bad body never reach the host", async (t) => {
  const host = await sharedHost(t);
  const view = await display(t, createRemotePets(setting(host.port), { env: STAND_IN }));
  const phone = { "x-phone": "1" };
  assert.deepEqual(await view.get("/api/pets", phone).then(({ status, body }) => [status, body]), [403, { error: "The game is on this computer only." }]);
  const own = { Origin: `http://127.0.0.1:${view.port}`, "Content-Type": "application/json" };
  for (const [path, body] of [["/api/pets/buy", { kind: "recruit" }], ["/api/pets/fight", { boss: 0 }]]) {
    for (const [who, headers] of [["a phone", { ...own, ...phone }], ["no Origin", { "Content-Type": "application/json" }],
      ["another site's page", { ...own, Origin: "http://evil.example" }], ["a form", { ...own, "Content-Type": "text/plain" }]])
      assert.equal((await view.post(path, body, headers)).status, 403, `${path} from ${who}`);
  }
  for (const [path, body] of [["/api/pets/buy", { kind: "dragon" }], ["/api/pets/buy", {}], ["/api/pets/fight", { boss: -1 }], ["/api/pets/fight", { boss: "0" }], ["/api/pets/buy", "{"]]) {
    const answer = await view.post(path, body);
    assert.equal(answer.status, 400, `${path} ${JSON.stringify(body)}`);
    assert.match(answer.body.error, SENTENCE);
  }
  assert.equal((await view.get("/api/pets/buy")).status, 404, "only a POST buys");
  assert.equal((await view.get("/api/scene")).status, 404, "other routes pass through");
  assert.deepEqual(host.seen, [], "none of it reached the host");
  assert.deepEqual(host.game.calls, []);
});

test("a host that cannot be reached reads as a game that is not ready, in one plain sentence", async (t) => {
  const closed = await freePort();
  const view = await display(t, createRemotePets(setting(closed), { env: STAND_IN }));
  const shown = await view.get("/api/pets");
  assert.deepEqual([shown.status, shown.body], [200, { ready: false, message: UNREACHABLE("127.0.0.1") }]);
  for (const [path, body] of [["/api/pets/buy", { kind: "recruit" }], ["/api/pets/fight", { boss: 0 }]])
    assert.deepEqual(await view.post(path, body).then(({ status, body: answer }) => [status, answer]), [503, { error: UNREACHABLE("127.0.0.1") }]);
  assert.ok(!/ECONN|Error|\bat \b|[A-Za-z]:\\/.test(shown.text), "no error code, stack or path");
  assert.deepEqual((await view.get("/api/health")).body, { product: "GoblinHorde" }, "the viewer's other routes answer as ever");
});

test("while a host hangs, the viewer's other routes answer at once, and the wait ends at the timeout", async (t) => {
  const hung = createServer(() => {});
  await new Promise((resolve) => hung.listen(0, "127.0.0.1", resolve));
  t.after(() => { hung.closeAllConnections(); hung.close(); });
  const { port } = hung.address();
  const ask250 = (method, path, options) => askHost(`http://127.0.0.1:${port}`, method, path, { ...options, loopback: true, timeoutMs: 250 });
  const view = await display(t, createRemotePets(setting(port), { ask: ask250 }));
  const started = Date.now();
  const waiting = view.get("/api/pets");
  const health = await view.get("/api/health");
  assert.ok(Date.now() - started < 200, "the other route did not wait for the host");
  assert.equal(health.status, 200);
  assert.deepEqual((await waiting).body, { ready: false, message: UNREACHABLE("127.0.0.1") });
  const took = Date.now() - started;
  assert.ok(took >= 240 && took < 2000, `the forwarded poll gave up after ${took} ms`);
});

// What a host that is still opening its game sends, its own sentence included, and what a display makes of it: the code, in the display's own words.
const OPENING = { ready: false, reason: "opening", message: "Goblin Horde is opening your saved game." };
const SHOWN_OPENING = { ready: false, reason: "opening", message: "The shared game's computer is opening its saved game." };

/** A host scripted by status code, counting what it is asked, for the timing rules. */
function scripted({ pair = () => ({ status: 200, data: { paired: true }, session: "a".repeat(64) }), game = () => ({ status: 200, data: OPENING, session: "" }) } = {}) {
  const asked = [];
  const ask = async (method, path, options = {}) => {
    asked.push(`${method} ${path}`);
    return path === "/api/pair" ? pair(options) : game(options);
  };
  return { asked, ask, pairs: () => asked.filter((line) => line === "POST /api/pair").length };
}
function clock() {
  let time = 1_000_000;
  return { now: () => time, pass: (ms) => { time += ms; } };
}

test("a host that is down is left alone for 2 seconds, then 4, up to 30, and a poll in between is answered at once", async () => {
  const time = clock();
  let up = false;
  const host = scripted({ pair: () => { if (!up) throw new Error("connect ECONNREFUSED 127.0.0.1:1"); return { status: 200, data: {}, session: "b".repeat(64) }; } });
  const remote = createRemotePets(setting(45000), { ask: host.ask, now: time.now });
  const down = { ok: false, kind: "unreachable", message: UNREACHABLE("127.0.0.1") };

  assert.deepEqual(await remote.get(0), down);
  const tried = [];
  for (let second = 1; second <= 120; second += 1) {
    time.pass(1000);
    const before = host.asked.length;
    assert.deepEqual(await remote.get(0), down);
    if (host.asked.length > before) tried.push(second);
  }
  assert.deepEqual(tried, [2, 6, 14, 30, 60, 90, 120], "the waits double from 2 seconds and stop growing at 30");
  assert.equal(host.asked.length, 8);
  assert.deepEqual(await remote.post("/api/pets/buy", { kind: "recruit" }), down, "a purchase waits out the same pause");

  up = true;
  time.pass(30_000);
  assert.deepEqual(await remote.get(0), { ok: true, status: 200, data: SHOWN_OPENING });
  up = false;
  host.asked.length = 0;
  const failing = scripted({ game: () => { throw new Error("socket hang up"); } });
  const again = createRemotePets(setting(45000), { ask: failing.ask, now: time.now });
  await again.get(0);
  time.pass(2000);
  await again.get(0);
  assert.equal(failing.asked.filter((line) => line.startsWith("GET")).length, 2, "after a recovery the wait starts from 2 seconds again");
});

test("a wrong pairing code says so and never uses up the host's five tries in ten minutes", async (t) => {
  const host = await sharedHost(t);
  const time = clock();
  const real = (method, path, options) => askHost(`http://127.0.0.1:${host.port}`, method, path, { ...options, loopback: true });
  const remote = createRemotePets(setting(host.port, "AAAAAAAA"), { ask: real, now: time.now });
  const view = await display(t, remote);
  const shown = await view.get("/api/pets");
  assert.deepEqual([shown.status, shown.body], [200, { ready: false, message: WRONG_CODE("127.0.0.1") }]);
  assert.ok(!shown.text.includes("AAAAAAAA"), "the code that was tried is not repeated");
  assert.deepEqual(await view.post("/api/pets/buy", { kind: "recruit" }).then(({ status, body }) => [status, body]), [503, { error: WRONG_CODE("127.0.0.1") }]);

  for (let second = 1; second <= 600; second += 1) {
    time.pass(1000);
    assert.equal((await remote.get(0)).kind, "code");
  }
  const tries = host.seen.filter((line) => line === "POST /api/pair").length;
  assert.ok(tries >= 2 && tries <= 3, `${tries} tries in ten minutes of polling every second`);
  assert.equal((await host.pair()).status, 200, "so the right code still pairs from this address");
  assert.deepEqual(host.game.calls, []);
});

test("a host that refuses this computer, or is not a shared game, reads as not ready and never as a missing route", async () => {
  const refused = { ready: false, message: "The shared game on 127.0.0.1 refused this computer. Run Goblin Horde's doctor on both computers to see why." };
  const cases = [
    ["whois refuses the pairing", { pair: () => ({ status: 403, data: { error: "This computer is not signed in to the same Tailscale account." }, session: "" }) }],
    ["another program answers 404", { pair: () => ({ status: 404, data: { error: "Not found" }, session: "" }) }],
    ["pairing sets no session", { pair: () => ({ status: 200, data: { paired: true }, session: "" }) }],
    ["the game answers 404", { game: () => ({ status: 404, data: { error: "Not found" }, session: "" }) }],
    ["the game answers a page, not JSON", { game: () => ({ status: 200, data: null, session: "" }) }],
    ["the game answers 500", { game: () => ({ status: 500, data: { error: "Something went wrong." }, session: "" }) }],
    ["the session is refused again right after pairing", { game: () => ({ status: 401, data: { error: "Pair first." }, session: "" }) }],
  ];
  for (const [what, script] of cases) {
    const host = scripted(script);
    const time = clock();
    const remote = createRemotePets(setting(45000), { ask: host.ask, now: time.now });
    const view = { get: remote.get, post: remote.post };
    const answer = await view.get(0);
    assert.deepEqual([answer.ok, answer.kind, answer.message], [false, "refused", refused.message], what);
    const before = host.asked.length;
    time.pass(4000);
    await remote.get(0);
    assert.equal(host.asked.length, before, `${what}: left alone for 5 seconds`);
    time.pass(2000);
    await remote.get(0);
    assert.ok(host.asked.length > before, `${what}: then tried again`);
  }
  const wrongCode = scripted({ pair: () => ({ status: 429, data: { error: "Too many attempts." }, session: "" }) });
  assert.equal((await createRemotePets(setting(45000), { ask: wrongCode.ask }).get(0)).message, WRONG_CODE("127.0.0.1"), "too many tries is about the code too");
  const closed = scripted({ game: ({ body }) => ({ status: body ? 503 : 200, data: body ? { reason: "opening", error: "Goblin Horde is opening your saved game." } : OPENING, session: "" }) });
  const opening = createRemotePets(setting(45000), { ask: closed.ask });
  assert.deepEqual(await opening.get(0), { ok: true, status: 200, data: SHOWN_OPENING }, "a host still opening its game is an answer, said in this computer's words");
  assert.deepEqual(await opening.post("/api/pets/buy", { kind: "recruit" }), { ok: true, status: 503, data: { error: "The shared game's computer is opening its saved game." } });
  // A host with a code this version does not know: this computer has only its plain sentence for it.
  const newer = scripted({ game: ({ body }) => ({ status: body ? 503 : 200, data: body ? { reason: "migrating" } : { ready: false, reason: "migrating" }, session: "" }) });
  const plain = createRemotePets(setting(45000), { ask: newer.ask });
  assert.deepEqual(await plain.get(0), { ok: true, status: 200, data: { ready: false, reason: "error", message: "The shared game is not ready yet." } });
  assert.deepEqual(await plain.post("/api/pets/buy", { kind: "recruit" }), { ok: true, status: 503, data: { error: "The shared game could not do that." } });
  // A host of an older version sends its sentence and no code. Its sentence is not shown, and this computer has only its plain one.
  const older = scripted({ game: ({ body }) => ({ status: body ? 503 : 200, data: body ? { error: "Goblin Horde is opening your saved game." } : { ready: false, message: "Goblin Horde is opening your saved game." }, session: "" }) });
  const wordless = createRemotePets(setting(45000), { ask: older.ask });
  assert.deepEqual(await wordless.get(0), { ok: true, status: 200, data: { ready: false, reason: "error", message: "The shared game is not ready yet." } });
  assert.deepEqual(await wordless.post("/api/pets/buy", { kind: "recruit" }), { ok: true, status: 503, data: { error: "The shared game could not do that." } });
});

test("damaged settings read as not ready, and nothing is sent anywhere", async (t) => {
  const view = await display(t, createRemotePets({ problem: "This computer's shared game settings could not be read. Run pets-join again, or pets-join --off to play this computer's own game." }));
  const shown = await view.get("/api/pets");
  assert.equal(shown.status, 200);
  assert.equal(shown.body.ready, false);
  assert.match(shown.body.message, /^This computer's shared game settings could not be read\./);
  assert.equal((await view.post("/api/pets/buy", { kind: "recruit" })).status, 503);
});

test("the pairing code is only ever sent to an address on the tailnet", async (t) => {
  let connections = 0;
  const server = createServer((request, response) => json(response, 200, { ok: true }));
  server.on("connection", () => { connections += 1; });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { port } = server.address();
  const offTailnet = (failure) => failure.code === "ENOTTAILNET";

  await assert.rejects(askHost(`http://localhost:${port}`, "POST", "/api/pair", { body: { code: CODE } }), offTailnet, "a name that resolves to an address outside the tailnet");
  await assert.rejects(askHost(`http://127.0.0.1:${port}`, "POST", "/api/pair", { body: { code: CODE } }), offTailnet, "an address outside the tailnet");
  await assert.rejects(askHost(`http://192.168.1.20:${port}`, "GET", "/api/pets/whoami"), offTailnet);
  await assert.rejects(askHost(`http://[::1]:${port}`, "GET", "/api/pets/whoami"), offTailnet);
  assert.equal(connections, 0, "nothing was connected to");
  assert.deepEqual((await askHost(`http://localhost:${port}`, "GET", "/api/pets/whoami", { loopback: true })).data, { ok: true }, "the stand-in allows this computer itself");
  assert.equal(connections, 1);

  const remote = createRemotePets(setting(port), { env: {} });
  assert.deepEqual(await remote.get(0), { ok: false, kind: "unreachable", message: UNREACHABLE("127.0.0.1") }, "a display pointed off the tailnet shows nothing and sends nothing");
  assert.equal(connections, 1);
});

test("pets-join's check tells an unreachable host, a wrong code, a refusal, and another program apart", async (t) => {
  const host = await sharedHost(t);
  assert.deepEqual(await checkHost(setting(host.port), { env: STAND_IN }), { ok: true });
  assert.deepEqual(host.seen, ["GET /api/pets/whoami", "POST /api/pair", "GET /api/pets?after=0"], "a health check, a pairing, and the game with that session");

  assert.deepEqual(await checkHost(setting(host.port, "AAAAAAAA"), { env: STAND_IN }), { ok: false, problem: WRONG_CODE("127.0.0.1") });
  assert.deepEqual(await checkHost(setting(await freePort()), { env: STAND_IN }), { ok: false, problem: UNREACHABLE("127.0.0.1") });
  assert.deepEqual(await checkHost(setting(host.port), { env: {} }), { ok: false, problem: "127.0.0.1 is not an address on your Tailscale network." });

  const account = "This computer is not signed in to the same Tailscale account as the shared game's computer.";
  const guest = await sharedHost(t, { network: { whois: async () => false } });
  assert.deepEqual(await checkHost(setting(guest.port), { env: STAND_IN }), { ok: false, problem: `The shared game on 127.0.0.1 refused this computer. It said: ${account}` });

  const other = createServer((request, response) => json(response, 404, { error: "Not found" }));
  await new Promise((resolve) => other.listen(0, "127.0.0.1", resolve));
  t.after(() => { other.closeAllConnections(); other.close(); });
  const notGame = await checkHost(setting(other.address().port), { env: STAND_IN });
  assert.equal(notGame.ok, false);
  assert.match(notGame.problem, /answered, but not as a Goblin Horde shared game\./);
  for (const result of [notGame]) assert.ok(!result.problem.includes(CODE));

  const rude = async () => ({ status: 403, data: { error: "x\u001b[31m rm -rf \n".repeat(3) }, session: "" });
  assert.equal((await checkHost(setting(45000), { ask: rude })).problem, "The shared game on 127.0.0.1 refused this computer.", "only a plain short line from the host is repeated");
});

test("join checks from the computer a display runs on leave the display signed in, however many there are", async (t) => {
  // The host keeps one session for each computer, as the viewer's shared listener does.
  const host = await sharedHost(t, { sessions: { onePerPeer: true } });
  const remote = createRemotePets(setting(host.port), { env: STAND_IN });
  assert.equal((await remote.get(0)).ok, true, "the display is signed in");
  const pairs = () => host.seen.filter((line) => line === "POST /api/pair").length;
  assert.equal(pairs(), 1);

  // The review's case was seven checks. Each is a whole pets-join check: a health check, a pairing, and the game.
  for (let check = 1; check <= 12; check += 1) {
    assert.deepEqual(await checkHost(setting(host.port), { env: STAND_IN }), { ok: true }, `join check ${check}`);
    assert.equal((await remote.get(0)).ok, true, `the display still shows the game after join check ${check}`);
  }
  assert.equal(pairs(), 13, "each check gave the code once, and the display never had to give it again");
  assert.equal(host.pairing.sessionCount(), 1, "one session, the computer's own");
  assert.equal(host.pairing.pairings.get("127.0.0.1")?.length ?? host.pairing.pairings.values().next().value.length, 1, "and one pairing counted against its eight in ten minutes");

  // Two displays on one computer share that computer's session: neither signs the other out.
  const second = createRemotePets(setting(host.port), { env: STAND_IN });
  for (let turn = 0; turn < 3; turn += 1) {
    assert.equal((await second.get(0)).ok, true);
    assert.equal((await remote.get(0)).ok, true);
    assert.equal((await second.post("/api/pets/buy", { kind: "recruit" })).ok, true);
  }
  assert.equal(pairs(), 14, "the second display gave the code once");
  assert.equal(host.pairing.sessionCount(), 1);

  // Signed out by the host, the display pairs again, once.
  host.pairing.endSessions();
  assert.equal((await remote.get(0)).ok, true);
  assert.equal(pairs(), 15);
});

test("a display that forwards makes no saved game and no lock of its own", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "goblin-display-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = await sharedHost(t);
  writeRemoteSetting(dir, { origin: `http://127.0.0.1:${host.port}`, code: CODE });
  const view = await display(t, createRemotePets(readRemoteSetting(dir, { env: STAND_IN }), { env: STAND_IN }));
  await view.get("/api/pets");
  await view.post("/api/pets/buy", { kind: "recruit" });
  await sleep(50);
  assert.deepEqual(readdirSync(dir).sort(), [REMOTE_CODE_FILE, REMOTE_FILE]);
  assert.equal(existsSync(join(dir, "pets.json")), false);
});
