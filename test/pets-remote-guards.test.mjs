/**
 * What a display refuses, on loopback: a host spelled so that a URL parser reads another address, a host that
 * never finishes its answer, and an answer that carries the pairing code or anything but the game's own fields.
 * The receiver here stands for the place a pairing code must never reach, so it must get nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { REFUSED, inWords, readAnswer } from "../lib/pets-answers.mjs";
import { LOCKED } from "../lib/pets-lock.mjs";
import { askHost, checkHost, createRemotePets, parseHost, writeRemoteSetting } from "../lib/pets-remote.mjs";
import { createPetsService } from "../lib/pets-service.mjs";
import { UNREADABLE } from "../lib/pets-store.mjs";
import { CODE, GAME, displayViewer } from "./helpers/shared-host.mjs";
import { freePort, json, startViewer, until, viewerEnv } from "./helpers/viewer.mjs";

const SOURCE = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]+$/, "");
// Windows permissions are read here with icacls, apart from the code under test. Elsewhere there is nothing to read this way.
const icacls = process.platform === "win32" ? join(process.env.SystemRoot, "System32", "icacls.exe") : "";
/** Who may open `file`: the trustees of its allow entries, as SDDL names them ("BU" is every user of the computer). */
function readers(file) {
  const out = `${file}.test-acl`;
  execFileSync(icacls, [file, "/save", out], { windowsHide: true, stdio: "ignore" });
  const sddl = readFileSync(out).toString("utf16le").trim().split(/\r?\n/).at(-1);
  rmSync(out);
  return [...sddl.matchAll(/\(A;[^;]*;[^;]*;[^;]*;[^;]*;([^)]*)\)/g)].map((entry) => entry[1]);
}
// The Python that runs the widget's own reader of the game's answers, or "" when this computer has none.
const PYTHON = ["python", "python3"].find((name) => spawnSync(name, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)"], { windowsHide: true }).status === 0) ?? "";

const STAND_IN = { GOBLIN_SHARED_LOOPBACK: "45123" };
// Any three letters of the code in a row, anywhere, would be a leak of part of it.
const CODE_PARTS = [0, 1, 2, 3, 4, 5].map((start) => CODE.slice(start, start + 3));
const holdsCode = (value) => CODE_PARTS.some((part) => JSON.stringify(value).toUpperCase().includes(part));
const offTailnet = (failure) => failure.code === "ENOTTAILNET";
const setting = (port, name = "127.0.0.1") => ({ name, port, origin: `http://${name}:${port}`, code: CODE });
const READY = { ready: true, boot: "0a1b2c3d", seq: 1, events: [{ seq: 1, at: 1_000, type: "launch", welcome: true, away: null, caughtUp: { turns: 0, coins: 0 } }], game: GAME, source: { ok: true } };
const SESSION = `goblin_horde_session=${"c".repeat(64)}; HttpOnly`;

/** A server on 127.0.0.1 that keeps every connection and request it gets. `answer` says what it sends back. */
async function receiver(t, answer = (request, response) => json(response, 200, { ok: true })) {
  const got = { connections: 0, requests: [] };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => { got.requests.push({ line: `${request.method} ${request.url}`, host: request.headers.host, body }); answer(request, response, body); });
  });
  server.on("connection", () => { got.connections += 1; });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { port: server.address().port, got };
}

// Each of these is a spelling that a URL parser, a resolver, or both read as an IPv4 address.
const AS_LOOPBACK = ["0x7f000001", "0X7F000001", "0x7f.1", "0x7f.0.0.1", "0177.0.0.1", "017700000001", "2130706433", "127.1", "127.0.1", "127.0.0.1."];
const AS_ELSEWHERE = ["0xa9fea9fe", "0x08080808", "134744072", "010.010.010.010", "0xffffffff", "0x", "1.2.3"];
const AS_THE_TAILNET = ["0x64656667", "1684366951", "0144.0145.0146.0147", "100.101.26215", "100.6645351", "100.101.102.0x67", "100.101.102.103."];
const NOT_A_HOST = ["[::1]", "::1", "::ffff:127.0.0.1", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[fd7a:115c:a1e0::1]", "fd7a:115c:a1e0::1", "user@100.101.102.103", "user:pw@100.101.102.103",
  "http://user:pw@100.101.102.103:43917", "http://100.101.102.103:43917/api", "http://100.101.102.103:43917/?x=1", "http://100.101.102.103:43917#x", "https://100.101.102.103:43917",
  "ftp://100.101.102.103", "//100.101.102.103", "http:100.101.102.103", "http:///100.101.102.103", "100.101.102.103/..", "100.101.102.103\\x", "100.101.102.103%2e", "100.101.102.103 x",
  "\uff11\uff10\uff10.101.102.103", "servitor.123", "servitor.0x1f", "ser vitor", "servitor:", "servitor.", ".servitor", "xn--a"];

test("a host spelled as any number but a plain dotted Tailscale address is refused, whatever address it would mean", () => {
  const at = (text, options) => parseHost(text, { defaultPort: 43917, ...options });
  for (const spelling of [...AS_LOOPBACK, ...AS_ELSEWHERE, ...AS_THE_TAILNET, ...NOT_A_HOST]) {
    assert.equal(at(spelling), null, spelling);
    assert.equal(at(`${spelling}:43917`), null, `${spelling} with a port`);
    assert.equal(at(`http://${spelling}:43917`), null, `${spelling} as a URL`);
    assert.equal(at(spelling, { loopback: true }), null, `${spelling} with the loopback stand-in`);
  }
  // A name made only of digits, dots, and the letters of a hexadecimal number could be read as a number, so it is no name here.
  for (const name of ["cafe", "deadbeef", "abc.def", "beef.face", "a1", "x", "0x1f"]) assert.equal(at(name), null, name);

  for (const [typed, name] of [["100.101.102.103", "100.101.102.103"], ["100.64.0.1", "100.64.0.1"], ["100.127.255.255", "100.127.255.255"], ["servitor", "servitor"],
    ["Servitor.Tail1234.TS.net", "servitor.tail1234.ts.net"], ["goblin-box9.tail1234.ts.net", "goblin-box9.tail1234.ts.net"], ["http://100.101.102.103:43917/", "100.101.102.103"]])
    assert.deepEqual(at(typed), { name, port: 43917, origin: `http://${name}:43917` }, typed);
  assert.equal(at("127.0.0.1"), null, "this computer is no host without the stand-in");
  assert.equal(at("127.0.0.1", { loopback: true }).name, "127.0.0.1");
});

test("no spelling of a host gets the pairing code to an address off the tailnet, and nothing is connected to", async (t) => {
  const { port, got } = await receiver(t);
  const never = () => { throw new Error("no name may be looked up for a host that was refused"); };
  for (const spelling of [...AS_LOOPBACK, "[::1]", "::ffff:127.0.0.1", "[::ffff:127.0.0.1]", "user@127.0.0.1", "user:pw@localhost", "127.0.0.1"]) {
    const origin = `http://${spelling}:${port}`;
    await assert.rejects(askHost(origin, "POST", "/api/pair", { body: { code: CODE }, resolve: never }), offTailnet, spelling);
    assert.deepEqual(await checkHost({ name: spelling, port, origin, code: CODE }, { env: {} }), { ok: false, problem: `${spelling} is not an address on your Tailscale network.` }, spelling);
    assert.equal((await createRemotePets({ name: spelling, port, origin, code: CODE }, { env: {} }).get(0)).ok, false, spelling);
  }
  await assert.rejects(askHost(`http://localhost:${port}`, "POST", "/api/pair", { body: { code: CODE } }), offTailnet, "localhost is a name, and it resolves to this computer");
  // With the stand-in on, the one spelling of this computer that is allowed is 127.0.0.1 itself.
  for (const spelling of AS_LOOPBACK)
    await assert.rejects(askHost(`http://${spelling}:${port}`, "POST", "/api/pair", { body: { code: CODE }, loopback: true, resolve: never }), offTailnet, `${spelling} with the stand-in`);
  for (const spelling of [...AS_ELSEWHERE, ...AS_THE_TAILNET])
    await assert.rejects(askHost(`http://${spelling}:${port}`, "POST", "/api/pair", { body: { code: CODE }, resolve: never }), offTailnet, spelling);
  assert.deepEqual(got, { connections: 0, requests: [] }, "the receiver got no connection and no pairing code");

  assert.deepEqual((await askHost(`http://127.0.0.1:${port}`, "POST", "/api/pair", { body: { code: CODE }, loopback: true })).data, { ok: true }, "the receiver does see a request that is sent");
  assert.deepEqual(got.requests, [{ line: "POST /api/pair", host: `127.0.0.1:${port}`, body: JSON.stringify({ code: CODE }) }]);
});

test("a name is connected to only at the tailnet addresses it resolves to, under exactly the name that was checked", async (t) => {
  const { port, got } = await receiver(t);
  const asked = [];
  const resolvesTo = (...addresses) => (hostname, options, callback) => { asked.push(hostname); callback(null, addresses.map((address) => ({ address, family: 4 }))); };
  const origin = `http://Servitor.Tail1234.ts.net:${port}`;
  const send = (options) => askHost(origin, "POST", "/api/pair", { body: { code: CODE }, timeoutMs: 1500, ...options });

  await assert.rejects(send({ resolve: resolvesTo("127.0.0.1") }), offTailnet, "a MagicDNS-looking name that resolves to this computer");
  // 192.0.2.1 is an address kept for documents, so nothing answers there. A broken filter would time out on it, with another error.
  await assert.rejects(send({ resolve: resolvesTo("192.0.2.1"), loopback: true }), offTailnet, "a name that resolves off the tailnet, even with the stand-in");
  assert.equal(got.connections, 0);
  assert.deepEqual((await send({ resolve: resolvesTo("192.0.2.1", "127.0.0.1"), loopback: true })).data, { ok: true }, "of two addresses, the allowed one is used");
  assert.equal(got.requests[0].host, `servitor.tail1234.ts.net:${port}`);
  assert.deepEqual([...new Set(asked)], ["servitor.tail1234.ts.net"], "the resolver is asked for the checked name and no other spelling");
});

/** A raw server that sends `reply(socket)` once a request arrives and then leaves the connection as it is. */
async function rawHost(t, reply) {
  const sockets = new Set();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("data", () => reply(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  return server.address().port;
}

test("a host that answers 101, hangs up, or never finishes its answer is given up on, at the deadline at the latest", async (t) => {
  const cases = [
    ["101 with an upgrade", (socket) => socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")],
    ["101 and then other bytes", (socket) => socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\nConnection: Upgrade\r\n\r\n{\"ok\":true}")],
    ["a body that never ends", (socket) => socket.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 4000\r\n\r\n{\"ok\":")],
    ["headers that never end", (socket) => socket.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n")],
    ["an early answer with nothing after it", (socket) => socket.write("HTTP/1.1 103 Early Hints\r\nLink: </x>\r\n\r\n")],
    ["a hang-up with no answer", (socket) => socket.destroy()],
    ["a hang-up in the middle of the answer", (socket) => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 4000\r\n\r\n{\"ok\":")],
  ];
  for (const [what, reply] of cases) {
    const port = await rawHost(t, reply);
    const started = Date.now();
    const outcome = await Promise.race([
      askHost(`http://127.0.0.1:${port}`, "GET", "/api/pets/whoami", { loopback: true, timeoutMs: 300 }).then(() => "answered", () => "gave up"),
      sleep(2500).then(() => "still waiting"),
    ]);
    assert.equal(outcome, "gave up", what);
    assert.ok(Date.now() - started < 1500, `${what}: gave up after ${Date.now() - started} ms`);
  }
  // A host that changes protocol or hangs up is given up on at once, long before a deadline of 20 seconds.
  for (const [what, reply] of cases.filter(([name]) => /101|hang-up/.test(name))) {
    const port = await rawHost(t, reply);
    const outcome = await Promise.race([
      askHost(`http://127.0.0.1:${port}`, "GET", "/api/pets/whoami", { loopback: true, timeoutMs: 20_000 }).then(() => "answered", () => "gave up"),
      sleep(3000).then(() => "still waiting"),
    ]);
    assert.equal(outcome, "gave up", `${what}, with a long deadline`);
  }
  const port = await rawHost(t, cases[0][1]);
  const quick = (method, path, options) => askHost(`http://127.0.0.1:${port}`, method, path, { ...options, loopback: true, timeoutMs: 300 });
  const remote = createRemotePets(setting(port), { ask: quick });
  const shown = await Promise.race([remote.get(0), sleep(2500).then(() => "still waiting")]);
  assert.deepEqual(shown, { ok: false, kind: "unreachable", message: "The shared game on 127.0.0.1 is not reachable. Is Goblin Horde running there?" });
});

test("what a host says when it refuses is never repeated, so a host that answers with the pairing code prints nothing of it", async (t) => {
  const refusedPlainly = "The shared game on 127.0.0.1 refused this computer.";
  const echoes = [CODE, CODE.toLowerCase(), `No: ${CODE}`, `Use ${CODE.slice(0, 4)} ${CODE.slice(4)}`, "Please pair again with the code you sent."];
  for (const said of echoes) {
    const atHello = async () => ({ status: 403, data: { error: said }, session: "" });
    assert.deepEqual(await checkHost(setting(45000), { ask: atHello }), { ok: false, problem: refusedPlainly }, `whoami answered "${said}"`);
    const atPair = async (method, path) => (path === "/api/pair" ? { status: 403, data: { error: said, code: said }, session: "" } : { status: 200, data: { ok: true }, session: "" });
    assert.deepEqual(await checkHost(setting(45000), { ask: atPair }), { ok: false, problem: refusedPlainly }, `pairing answered "${said}"`);
  }
  // A host's own refusal is told apart by its exact words, and what is printed is this computer's copy of them.
  for (const sentence of Object.values(REFUSED)) {
    const known = async () => ({ status: 403, data: { error: sentence }, session: "" });
    assert.equal((await checkHost(setting(45000), { ask: known })).problem, `${refusedPlainly} It said: ${sentence}`);
  }

  // A real server that sends back whatever code it was sent, in every answer.
  const { port, got } = await receiver(t, (request, response, body) => json(response, 403, { error: JSON.parse(body || "{}").code ?? CODE, code: CODE }));
  const joined = await checkHost(setting(port), { env: STAND_IN });
  assert.deepEqual(joined, { ok: false, problem: refusedPlainly });
  const remote = createRemotePets(setting(port), { env: STAND_IN });
  const view = await displayViewer(t, remote);
  const shown = await view.get("/api/pets");
  assert.deepEqual(shown.body, { ready: false, message: "The shared game on 127.0.0.1 refused this computer. Run Goblin Horde's doctor on both computers to see why." });
  const bought = await view.post("/api/pets/buy", { kind: "recruit" });
  assert.equal(bought.status, 503);
  assert.ok(got.requests.length >= 2, "the host was asked");
  assert.equal(holdsCode([joined, shown.text, bought.text]), false, "no part of the code is in what the display says");
});

test("an answer that holds the pairing code is not passed on, and any other answer is cut down to the game's own fields", async (t) => {
  const scripted = (game) => async (method, path) => (path === "/api/pair" ? { status: 200, data: { paired: true }, session: "c".repeat(64) } : game(method, path));
  const garbled = { ok: false, kind: "garbled", message: "The shared game on 127.0.0.1 sent an answer this computer could not read. Both computers need the same version of Goblin Horde." };
  const carrying = [
    { ...READY, code: CODE },
    { ...READY, [CODE]: 1 },
    { ...READY, source: { ok: false, reason: "save", message: `Your code is ${CODE}.` } },
    { ...READY, game: { ...GAME, note: CODE.toLowerCase() } },
    { ready: false, message: `Pair again with ${CODE}` },
    { ready: false, message: "Goblin Horde is opening your saved game.", code: CODE },
  ];
  for (const data of carrying) {
    const remote = createRemotePets(setting(45000), { ask: scripted(() => ({ status: 200, data, session: "" })) });
    const view = await displayViewer(t, remote);
    const shown = await view.get("/api/pets");
    assert.deepEqual(shown.body, { ready: false, message: garbled.message }, JSON.stringify(data).slice(0, 80));
    assert.equal(holdsCode(shown.text), false);
    assert.deepEqual(await createRemotePets(setting(45000), { ask: scripted(() => ({ status: 200, data, session: "" })) }).post("/api/pets/buy", { kind: "recruit" }), garbled);
  }

  const extra = { ...READY, note: "private words", token: "abc", game: { ...GAME, secret: "x", state: { ...GAME.state, title: "Project Nightingale", wallet: { ...GAME.state.wallet, iban: "X" } } },
    events: [...READY.events, { seq: 2, at: 2_000, type: "chat", text: "private words" }, { seq: 3, at: 3_000, type: "work", coins: 5, xp: 1, turns: 1, subagents: 0, ids: ["provider-turn:abc"] }] };
  const cut = (await createRemotePets(setting(45000), { ask: scripted(() => ({ status: 200, data: extra, session: "" })) }).get(0)).data;
  assert.deepEqual(cut, { ...READY, events: [READY.events[0], { seq: 3, at: 3_000, type: "work", coins: 5, xp: 1, turns: 1, subagents: 0 }] }, "unknown fields and unknown events are dropped");

  const notTheShape = [{ ready: true }, { ...READY, boot: "<script>" }, { ...READY, seq: "7" }, { ...READY, game: { ...GAME, power: "strong" } }, { ...READY, game: { ...GAME, state: { ...GAME.state, wallet: { coins: "many" } } } },
    { ...READY, game: null }, { ...READY, events: "none" }, { ...READY, source: "fine" }, { ready: "yes", message: "Hello." }, {}, { ready: null }];
  for (const data of notTheShape)
    assert.deepEqual(await createRemotePets(setting(45000), { ask: scripted(() => ({ status: 200, data, session: "" })) }).get(0), garbled, JSON.stringify(data).slice(0, 80));
});

test("an older host's answer, which names no grip, reads as grip 0 with nothing to buy", () => {
  const { grip: _level, ...upgrades } = GAME.state.upgrades;
  const { grip: _price, ...quotes } = GAME.quotes;
  const older = { ...READY, game: { ...GAME, state: { ...GAME.state, upgrades }, quotes } };
  const read = readAnswer("GET /api/pets", 200, older, { code: CODE });
  assert.deepEqual(read.game.state.upgrades, { ...upgrades, grip: 0 });
  assert.deepEqual(read.game.quotes, { ...quotes, grip: null });
  const wordy = { ...older, game: { ...older.game, state: { ...older.game.state, upgrades: { ...upgrades, grip: "many" } } } };
  assert.equal(readAnswer("GET /api/pets", 200, wordy, { code: CODE }), null, "a grip that is there and is not a number is still refused");
});

const SENTENCE = /^[A-Z][A-Za-z0-9 ,.:'_-]{10,160}\.$/;
const PROSE = ["Goblin Horde is opening your saved game.", "Customer meeting notes are copied here.", "\u001b[31mred", "line one\nline two", "<img src=x onerror=alert(1)>", "x".repeat(400), "",
  "C:\\Users\\someone\\pets.json", "caf\u00e9 \u2603", "EPERM: operation not permitted, open '\u2026'"];

test("no words cross: an answer keeps a code for why, never a sentence, and a code that is not on its list reads as an error", () => {
  const read = (route, status, data) => readAnswer(route, status, data, { code: CODE });
  for (const said of [...PROSE, 7, null, undefined, { text: "x" }]) {
    assert.deepEqual(read("GET /api/pets", 200, { ready: false, reason: "locked", message: said }), { ready: false, reason: "locked" }, `a game that is not ready, with ${String(said).slice(0, 30)}`);
    assert.deepEqual(read("GET /api/pets", 200, { ...READY, source: { ok: false, reason: "save", message: said, detail: said } }).source, { ok: false, reason: "save" });
    for (const status of [400, 403, 413, 500, 503]) {
      assert.deepEqual(read("POST /api/pets/buy", status, { error: said, message: said, reason: "invalid", stack: "at x" }), { reason: "invalid" }, `a ${status}`);
      assert.deepEqual(read("POST /api/pets/fight", status, { error: said }), { reason: "error" }, `a ${status} with a sentence and no code`);
    }
  }
  // A code is one of a short list. Anything else in its place reads "error": a code a later version might send, a
  // sentence, capitals, letters of the pairing code, a number, or nothing at all.
  for (const odd of [...PROSE, "openin", "zqxz", "later", "not-yet-known", "OPENING", "save; rm -rf", "two words", 7, null, undefined, ["opening"], { reason: "opening" }]) {
    assert.deepEqual(read("GET /api/pets", 200, { ready: false, reason: odd, message: "Goblin Horde is opening your saved game." }), { ready: false, reason: "error" }, String(odd).slice(0, 30));
    assert.deepEqual(read("GET /api/pets", 200, { ...READY, source: { ok: false, reason: odd } }).source, { ok: false, reason: "error" });
    assert.deepEqual(read("POST /api/pets/buy", 503, { reason: odd }), { reason: "error" });
  }
  // The review's answer of words alone, as a host of an older version sends it: the words are dropped, and what is left says only that there is no game.
  assert.deepEqual(read("GET /api/pets", 200, { ready: false, message: "Customer meeting notes are copied here." }), { ready: false, reason: "error" });
  for (const reason of ["off", "opening", "retrying", "locked", "unreadable", "stopped"]) {
    assert.deepEqual(read("GET /api/pets", 200, { ready: false, reason }), { ready: false, reason });
    assert.deepEqual(read("POST /api/pets/fight", 503, { reason }), { reason });
  }
  for (const reason of ["missing", "locked", "schema", "save"]) assert.deepEqual(read("GET /api/pets", 200, { ...READY, source: { ok: false, reason } }).source, { ok: false, reason });

  const bought = { ok: false, reason: "coins", game: GAME };
  assert.deepEqual(read("POST /api/pets/buy", 200, { ...bought, extra: 1 }), bought);
  assert.equal(read("POST /api/pets/buy", 200, { ...bought, reason: "because I said so" }), null, "a reason is one of the game's own words");
  const fought = { won: true, ratio: 1.2, first: true, rewards: { coins: 20, scrap: 4, xp: 40 }, reason: null, game: GAME };
  assert.deepEqual(read("POST /api/pets/fight", 200, { ...fought, rewards: { ...fought.rewards, loot: "sword" } }), fought);
  assert.equal(read("POST /api/pets/fight", 200, { ...fought, ratio: "big" }), null);
  assert.equal(read("POST /api/pets/buy", 503, { error: `Try ${CODE}` }), null);
  assert.equal(read("GET /api/scene", 200, READY), null, "only the game's three routes have an answer");
  assert.equal(read("GET /api/pets", 200, null), null);
  // Every text that is left in an answer is a run's name, a date, or one of the fixed words.
  const texts = [];
  JSON.stringify([read("GET /api/pets", 200, { ...READY, source: { ok: false, reason: "save", message: "words" } }), read("POST /api/pets/buy", 200, bought), read("POST /api/pets/fight", 503, { reason: "locked" })],
    (key, value) => { if (typeof value === "string") texts.push(value); return value; });
  assert.deepEqual(texts.sort(), ["0a1b2c3d", "2026-11-10", "2026-11-10", "coins", "launch", "locked", "save"]);
});

test("a display says each code in its own words, and has a sentence for every reason a host can give", async () => {
  const shown = (route, status, data) => inWords(route, status, readAnswer(route, status, data, { code: CODE }));
  assert.deepEqual(shown("GET /api/pets", 200, { ready: false, reason: "opening", message: "Goblin Horde is opening your saved game." }),
    { ready: false, reason: "opening", message: "The shared game's computer is opening its saved game." });
  assert.deepEqual(shown("GET /api/pets", 200, { ready: false, reason: "unreadable", message: "anything" }),
    { ready: false, reason: "unreadable", message: "The saved game on the shared game's computer could not be read. Nothing was replaced there." });
  assert.deepEqual(shown("GET /api/pets", 200, { ready: false, reason: "whoknows" }), { ready: false, reason: "error", message: "The shared game is not ready yet." });
  assert.deepEqual(shown("GET /api/pets", 200, { ...READY, source: { ok: false, reason: "save", message: "EPERM: open 'C:\\Users\\someone'" } }).source,
    { ok: false, reason: "save", message: "The shared game's computer could not save the game, so finished work is not paid yet." });
  assert.deepEqual(shown("GET /api/pets", 200, { ...READY, source: { ok: false, reason: "unheard-of" } }).source, { ok: false, reason: "error", message: "The shared game's computer cannot read finished work right now." });
  assert.deepEqual(shown("GET /api/pets", 200, READY), READY, "an answer with nothing to say is passed on as it is");
  assert.deepEqual(shown("POST /api/pets/buy", 400, { reason: "invalid", error: "x" }), { error: "Choose what to buy: recruit, level, gear, hoard, training, or grip." });
  assert.deepEqual(shown("POST /api/pets/fight", 400, { reason: "invalid" }), { error: "Choose a boss by its number, a whole number from 0 up." });
  assert.deepEqual(shown("POST /api/pets/buy", 503, { reason: "locked" }), { error: "Another Goblin Horde on the shared game's computer already runs the game." });
  assert.deepEqual(shown("POST /api/pets/fight", 503, { reason: "sideways", error: "The fight could not be saved." }), { error: "The shared game could not do that." });

  // Every reason the host's own service gives while it has no game, and every one its T3 reader gives, has a sentence here.
  const starts = { opening: () => new Promise(() => {}), retrying: async () => { throw new Error("no"); }, locked: async () => { throw Object.assign(new Error("held"), { code: LOCKED }); },
    unreadable: async () => { throw Object.assign(new Error("unreadable"), { code: UNREADABLE }); } };
  const given = ["off", "stopped"];
  for (const [reason, start] of Object.entries(starts)) {
    const service = createPetsService({ engine: { start, close: async () => {} }, setTimer: () => ({}), clearTimer: () => {}, log: () => {} });
    service.begin();
    await sleep(5);
    assert.equal(service.status().reason, reason);
    given.push(service.status().reason);
  }
  assert.equal(createPetsService({ engine: null }).status().reason, "off");
  const stopped = createPetsService({ engine: { start: async () => ({}), close: async () => {} }, setTimer: () => ({}), clearTimer: () => {}, log: () => {} });
  await stopped.stop();
  assert.equal(stopped.status().reason, "stopped");
  for (const reason of given) {
    const said = shown("GET /api/pets", 200, { ready: false, reason });
    assert.equal(said.reason, reason);
    assert.match(said.message, SENTENCE, reason);
    assert.notEqual(said.message, "The shared game is not ready yet.", `${reason} has a sentence of its own`);
  }
  for (const reason of ["missing", "locked", "schema", "save"]) {
    const said = shown("GET /api/pets", 200, { ...READY, source: { ok: false, reason } }).source.message;
    assert.match(said, SENTENCE, reason);
    assert.notEqual(said, "The shared game's computer cannot read finished work right now.", reason);
  }
});

// The spellings a pairing code can be written in and still be that code to a reader.
const SPELLED = {
  spaced: CODE.split("").join(" "), dashed: `${CODE.slice(0, 4)}-${CODE.slice(4)}`, "in small letters": CODE.toLowerCase(), "in mixed case": CODE.replace(/[QZ]/g, (letter) => letter.toLowerCase()),
  dotted: CODE.split("").join("."), "with tabs and line ends": `${CODE.slice(0, 3)}\t${CODE.slice(3, 6)}\r\n${CODE.slice(6)}`, "with dashes and underscores": CODE.split("").join("-_"),
  "in a sentence": `Your pairing code is ${CODE.split("").join(" ")}, keep it.`, "in pairs": CODE.match(/../g).join(" / "),
};
const HALVES = [CODE.slice(0, 4), CODE.slice(4)];
// What is left of a text when everything but its letters and digits is taken away: the code, however it was spelled.
const skeleton = (value) => (typeof value === "string" ? value : JSON.stringify(value)).toUpperCase().replace(/[^A-Z0-9]/g, "");
const spellsCode = (value) => CODE_PARTS.some((part) => skeleton(value).includes(part));
/** Every answer a host can make with `first` and `second` in two of its text fields, by route and status. */
function answersWith(first, second = first) {
  const game = (change) => { const copy = structuredClone(GAME); change(copy); return copy; };
  return [
    ["GET", 200, { ready: false, message: first, reason: second }],
    ["GET", 200, { ready: false, reason: first, message: second }],
    ["GET", 200, { ready: false, reason: "opening", message: first, note: second }],
    ["GET", 200, { ...READY, source: { ok: false, reason: first, message: second } }],
    ["GET", 200, { ...READY, source: { ok: false, reason: "save", message: first, detail: second } }],
    ["GET", 200, { ...READY, boot: first, source: { ok: false, reason: "save", message: second } }],
    ["GET", 200, { ...READY, game: game((copy) => { copy.state.today.key = first; }), source: { ok: false, reason: second, message: "x" } }],
    ["GET", 200, { ...READY, events: [{ ...READY.events[0], type: first, note: second }] }],
    ["GET", 200, { ...READY, game: game((copy) => { copy.title = first; copy.state.name = second; }) }],
    ["POST", 200, { ok: false, reason: first, game: GAME, message: second }],
    ["POST", 200, { ok: true, reason: null, game: GAME, message: first, error: second }],
    ["POST", 400, { error: first, reason: second }],
    ["POST", 400, { reason: first, message: second }],
    ["POST", 503, { error: first, message: second }],
    ["POST", 503, { reason: "locked", error: first, detail: second }],
  ];
}

test("a pairing code spelled with spaces, dashes or other letters, or cut in two across fields, reaches no display in any answer", async (t) => {
  const paired = { status: 200, data: { paired: true }, session: "c".repeat(64) };
  const cases = [...Object.entries(SPELLED).map(([how, spelling]) => [how, spelling, spelling]), ["cut in two halves", ...HALVES], ["cut in two halves, the second first", HALVES[1], HALVES[0]],
    ["one half spaced and one dashed", HALVES[0].split("").join(" "), HALVES[1].split("").join("-")]];
  /** What a display says to its own widget when its host answers `data`. */
  async function shownFor([method, status, data]) {
    const host = async (asked, path) => (path === "/api/pair" ? paired : { status, data, session: "" });
    const view = await displayViewer(t, createRemotePets(setting(45000), { ask: host }));
    return method === "GET" ? view.get("/api/pets") : view.post("/api/pets/buy", { kind: "recruit" });
  }
  for (const [how, first, second] of cases) {
    assert.ok(spellsCode(`${first}${second}`), `${how} does spell the code`);
    for (const answer of answersWith(first, second)) {
      const shown = await shownFor(answer);
      assert.equal(spellsCode(shown.text), false, `${how}, in ${JSON.stringify(answer[2]).slice(0, 90)}: the display said ${shown.text.slice(0, 200)}`);
      assert.ok(!shown.text.includes(first) && !shown.text.includes(second));
    }
  }
  // The same answers with two of the game's own codes in those places. A display reads all but the three where a
  // code stands for a run's name, a date or a purchase's result. So above it was the pairing code that stopped an
  // answer, or the place it stood in, and not the rest of the answer.
  const unread = [];
  for (const answer of answersWith("opening", "save")) {
    if (/could not read/.test((await shownFor(answer)).text)) unread.push(JSON.stringify(answer[2]).slice(0, 60));
  }
  assert.equal(unread.length, 3, unread.join(" | "));
  // And with plain words in those places, none of them is in anything a display shows.
  for (const answer of answersWith("plain words", "more of them")) assert.ok(!/plain words|more of them/.test((await shownFor(answer)).text), JSON.stringify(answer[2]).slice(0, 60));
});

test("a code that could pass for a run's name, a date or a number is caught where those are", () => {
  // A code of the letters a to f and digits is a run's name in small letters, and a code of digits is a date with dashes in it.
  const hex = "ABCDEF23";
  const digits = "23456789";
  const withBoot = (boot) => readAnswer("GET /api/pets", 200, { ...READY, boot }, { code: hex });
  assert.equal(withBoot("abcdef23"), null, "the code as a run's name");
  assert.deepEqual(withBoot("abcdef24"), { ...READY, boot: "abcdef24" }, "another run's name is an answer");
  const dated = (key) => readAnswer("GET /api/pets", 200, { ...READY, game: { ...GAME, state: { ...GAME.state, today: { key, reruns: {} } } } }, { code: digits });
  assert.equal(dated("2345-67-89"), null, "the code as a date, with dashes between its digits");
  assert.equal(dated("2026-11-10").game.state.today.key, "2026-11-10");
  const coins = (wallet) => readAnswer("GET /api/pets", 200, { ...READY, game: { ...GAME, state: { ...GAME.state, wallet: { ...GAME.state.wallet, ...wallet } } } }, { code: digits });
  assert.equal(coins({ coins: 23456789 }), null, "the code as a number of coins");
  assert.equal(coins({ coins: 2345.6789 }), null, "the code as a number with a point in it");
  assert.equal(coins({ coins: 2345, scrap: 6789 }), null, "the code as two numbers that follow one another");
  assert.equal(coins({ coins: 2345, scrap: 678 }).game.state.wallet.coins, 2345, "numbers that do not spell it are the game's");
  // In a field's name, too.
  assert.equal(readAnswer("GET /api/pets", 200, { ...READY, "z-q-x-z q.x.z.q": 1 }, { code: CODE }), null);
  assert.deepEqual(readAnswer("GET /api/pets", 200, READY, { code: "" }), READY, "with no code to look for, an answer is read by its shape alone");
});

test("the widget's own reader takes what a display shows: a game, a game that is not ready, and a host that is not counting work",
  { skip: !PYTHON && "no Python on this computer" }, async (t) => {
    const paired = { status: 200, data: { paired: true }, session: "c".repeat(64) };
    const launch = { ...READY.events[0], at: Date.now() };
    const answers = [
      { ...READY, events: [launch, { seq: 2, at: Date.now(), type: "work", coins: 5, xp: 1, turns: 1, subagents: 0 }], seq: 2 },
      { ready: false, reason: "locked", message: "The host's own words." },
      { ...READY, events: [launch], source: { ok: false, reason: "save", message: "The host's own words." } },
    ];
    const shown = [];
    for (const data of answers) {
      const host = async (asked, path) => (path === "/api/pair" ? paired : { status: 200, data, session: "" });
      const view = await displayViewer(t, createRemotePets(setting(45000), { ask: host }));
      shown.push((await view.get("/api/pets")).body);
    }
    // pets_feed.py reads each answer through a stand-in for the viewer, as the widget does on its worker thread.
    const program = ["import json, sys", "sys.path.insert(0, sys.argv[1])", "from pets_feed import PetsFeed",
      "class Api:", "    def __init__(self, answer): self.answer = answer", "    def pets(self, after): return self.answer",
      "out = []", "for answer in json.load(sys.stdin):", "    feed = PetsFeed(Api(answer)).poll()",
      "    out.append({'ready': feed.ready, 'message': feed.message, 'coins': feed.game.coins if feed.game else None, 'size': feed.game.size if feed.game else None,",
      "                'events': [type(event).__name__ for event in feed.events], 'source': feed.source})", "print(json.dumps(out))"].join("\n");
    const python = spawn(PYTHON, ["-B", "-c", program, SOURCE], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let problems = "";
    python.stdout.on("data", (chunk) => { out += chunk; });
    python.stderr.on("data", (chunk) => { problems += chunk; });
    python.stdin.end(JSON.stringify(shown));
    assert.equal(await new Promise((resolve) => python.once("exit", resolve)), 0, problems);
    assert.deepEqual(JSON.parse(out), [
      { ready: true, message: "", coins: 64, size: 3, events: ["Work", "Launch"], source: { ok: true } },
      { ready: false, message: "Another Goblin Horde on the shared game's computer already runs the game.", coins: null, size: null, events: [], source: null },
      { ready: true, message: "", coins: 64, size: 3, events: ["Launch"], source: { ok: false, message: "The shared game's computer could not save the game, so finished work is not paid yet." } },
    ]);
  });

test("a real display viewer joined to a host that sends the pairing code back shows, saves, and logs nothing of it",
  { timeout: 60_000 }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "goblin-display-echo-"));
    const viewers = [];
    t.after(async () => {
      for (const viewer of viewers) await viewer.stop();
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const hosts = {
      // Pairs, then answers the game with the code in a field and in a sentence.
      carrying: await receiver(t, (request, response) => {
        if (request.url === "/api/pair") { response.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": SESSION }); return response.end(JSON.stringify({ paired: true, code: CODE })); }
        return json(response, 200, { ...READY, code: CODE, source: { ok: false, reason: "save", message: `Saved for ${CODE}` } });
      }),
      // Refuses every request with the code as its reason.
      refusing: await receiver(t, (request, response) => json(response, 403, { error: CODE })),
      // Pairs, then answers with the code spelled another way each time, where a sentence and where a code belongs.
      spelling: await receiver(t, (request, response) => {
        if (request.url === "/api/pair") { response.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": SESSION }); return response.end(JSON.stringify({ paired: true })); }
        const spellings = Object.values(SPELLED);
        const said = spellings[hosts.spelling.got.requests.length % spellings.length];
        return request.method === "GET" ? json(response, 200, { ready: false, reason: said, message: said }) : json(response, 503, { error: said, reason: said });
      }),
    };
    const displays = {};
    for (const [name, host] of Object.entries(hosts)) {
      const stateDir = join(root, name);
      mkdirSync(stateDir);
      writeRemoteSetting(stateDir, { origin: `http://127.0.0.1:${host.port}`, code: CODE });
      if (name === "refusing" && icacls) {
        // This display's code file is one an older version left: in a folder that hands every new file to every user, written as any file is.
        execFileSync(icacls, [stateDir, "/grant", "*S-1-5-32-545:(OI)(CI)R"], { windowsHide: true, stdio: "ignore" });
        rmSync(join(stateDir, "remote-code.txt"));
        writeFileSync(join(stateDir, "remote-code.txt"), `${CODE}\n`);
        assert.ok(readers(join(stateDir, "remote-code.txt")).includes("BU"), "the code file starts out readable by every user");
      }
      const port = await freePort();
      const log = join(root, `${name}.log`);
      viewers.push(startViewer(viewerEnv(root, { port, stateDir, extra: { ...STAND_IN, GOBLIN_T3_DB: join(root, "no-t3.sqlite") } }), log));
      displays[name] = { port, log, stateDir, origin: `http://127.0.0.1:${port}` };
    }
    const said = [];
    for (const [name, display] of Object.entries(displays)) {
      const pets = await until(async () => (await fetch(`${display.origin}/api/pets`)).json(), (answer) => typeof answer.ready === "boolean", `The ${name} display never answered.`);
      assert.equal(pets.ready, false, name);
      assert.match(pets.message, name === "refusing" ? /refused this computer/ : /sent an answer this computer could not read/);
      const bought = await fetch(`${display.origin}/api/pets/buy`, { method: "POST", headers: { "Content-Type": "application/json", Origin: display.origin }, body: JSON.stringify({ kind: "recruit" }) });
      assert.equal(bought.status, 503, name);
      said.push(JSON.stringify(pets), await bought.text());
      assert.ok(hosts[name].got.requests.length >= 1, `the ${name} host was asked`);
    }
    if (icacls) assert.ok(!readers(join(displays.refusing.stateDir, "remote-code.txt")).includes("BU"), "the viewer that started made its code file private before it read the code");
    for (const viewer of viewers) await viewer.stop();
    for (const display of Object.values(displays)) {
      said.push(readFileSync(display.log, "utf8"));
      // Every file the display wrote, but the one that is there to hold the code.
      for (const entry of readdirSync(display.stateDir, { recursive: true, withFileTypes: true })) {
        if (entry.isFile() && entry.name !== "remote-code.txt") said.push(readFileSync(join(entry.parentPath ?? entry.path, entry.name), "utf8"));
      }
    }
    assert.ok(said.join("").length > 200, "the viewers did answer and log");
    assert.equal(holdsCode(said), false, "no answer, no log line and no saved file holds any part of the pairing code");
    assert.equal(spellsCode(said.join("\n")), false, "however the code is spelled");
  });
