/**
 * The shared listener's access checks, on loopback. The network a test hands the handler says which peers
 * count as the tailnet and what whois answers, so no test needs Tailscale or leaves this computer. The pairing
 * route is the viewer's real one (answerPair), and the pets routes are the real ones over a scripted engine.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Pairing, answerPair } from "../lib/pairing.mjs";
import { LOCKED } from "../lib/pets-lock.mjs";
import { UNREADABLE } from "../lib/pets-store.mjs";
import { SHARED_FILE, SharedAccess, readSharedSetting, sharedHandler, sharedNetwork, writeSharedSetting } from "../lib/shared.mjs";
import { createWhois, isLoopback, isTailscaleAddress } from "../lib/tailscale.mjs";
import { CODE, GAME, NAMES, engine, sharedHost as host } from "./helpers/shared-host.mjs";
import { ask, freePort, json, readBody, until, viewerPaths } from "./helpers/viewer.mjs";

const OWNER = "owner@example.com";
const SHARED_ROUTES = ["POST /api/pair", "GET /api/pets", "POST /api/pets/buy", "POST /api/pets/fight", "GET /api/pets/whoami"];
const LOCAL_PATH = "C:\\Users\\someone\\AppData\\Local\\GoblinHorde\\pets.json";

/** The handler asked directly, as a peer at `address` would reach it. Only for requests refused or answered without a body. */
function direct(handler, address, { method = "GET", url = "/api/pets/whoami", headers = {} } = {}) {
  return new Promise((resolve) => {
    const response = { headersSent: false, writeHead(status) { this.status = status; this.headersSent = true; }, end(text) { resolve({ status: this.status, body: JSON.parse(text) }); } };
    handler({ socket: { remoteAddress: address }, method, url, headers }, response);
  });
}

test("the shared listener answers its five routes and no other route the viewer has", async (t) => {
  const paths = viewerPaths();
  for (const known of ["/api/quit", "/api/shared", "/api/health", "/api/pets", "/api/pets/buy", "/api/pets/fight"])
    assert.ok(paths.includes(known), `the route list read from server.mjs holds ${known}`);
  for (const older of ["/api/scene", "/api/phone/reset", "/", "/pair.js"]) assert.ok(paths.includes(older), `and an older viewer's ${older}`);
  assert.ok(paths.length >= 30, `${paths.length} paths`);

  const shared = await host(t);
  const cookie = await shared.session();
  const answered = [];
  for (const path of [...paths, "/api/pets/whoami", "/api/pair"]) {
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      const { status, body } = await shared.call(method, path, { cookie, body: { kind: "recruit", boss: 0, enabled: false, code: "nope" } });
      if (status === 404) assert.deepEqual(body, { error: "Not found" }, `${method} ${path}`);
      else answered.push(`${method} ${path}`);
    }
  }
  assert.deepEqual(answered.sort(), [...SHARED_ROUTES].sort(), "a paired computer with the right Origin reaches these and nothing else");
  for (const path of ["/api/pets/", "/api/pets/../scene", "//other/api/pets", "/api/pets%2Fbuy", "/API/PETS", "/api/pets/whoami/x", "*"])
    assert.equal((await shared.call("GET", path, { cookie })).status, 404, path);
  assert.equal((await shared.call("HEAD", "/api/pets", { cookie })).status, 404);
  assert.equal((await shared.call("OPTIONS", "/api/pets/buy", { cookie })).status, 404);
});

test("a route is the request's own path, letter for letter, so no other spelling of a path reaches the game", async (t) => {
  const shared = await host(t);
  const cookie = await shared.session();
  const spellings = ["/ignored/../api/pets", "/ignored/%2e%2e/api/pets", "/api//../pets", "/api\\pets", "/api/pets#x", "/api/pets/", "//api/pets", "/api//pets", "/api%2Fpets",
    "/api/pets%2F", "/./api/pets", "/api/./pets", "/api/pets/.", "/api/pets;x", "/Api/pets", "/api/pets%00", "/api/pets/whoami/.."];
  for (const path of spellings) {
    const answer = await shared.call("GET", path, { cookie });
    assert.deepEqual([answer.status, answer.body], [404, { error: "Not found" }], `GET ${path}`);
  }
  for (const path of ["/ignored/../api/pets/buy", "/api/pets/./buy", "/api/pets/buy/", "/api/pets%2Fbuy", "/api/pets/buy#x", "/api/pets//buy", "/api/pets\\buy", "/api/pets/fight/../buy", "/api/../api/pair"]) {
    const answer = await shared.call("POST", path, { cookie, body: { kind: "recruit", boss: 0, code: CODE } });
    assert.deepEqual([answer.status, answer.body], [404, { error: "Not found" }], `POST ${path}`);
  }
  assert.deepEqual(shared.game.calls, [], "none of them reached the game");
  assert.equal(shared.pairing.sessionCount(), 1, "and none of them paired");

  const after = async (query) => (await shared.call("GET", `/api/pets${query}`, { cookie })).body.events.length;
  assert.deepEqual([await after("?after=0"), await after("?after=1"), await after("?"), await after("?after=1&x=/../buy#y")], [1, 0, 1, 0], "what follows the first ? is the query, and only that");
  assert.deepEqual((await shared.call("GET", "/api/pets/whoami?x=1")).body, { ok: true });
});

test("only the three game routes ever reach the game's handler, even one that would answer anything", async (t) => {
  // The viewer's pets handler ignores what it does not know. This one answers everything, as a handler added later might.
  const reached = [];
  const pairing = new Pairing({ code: CODE });
  let handler = null;
  const server = createServer((request, response) => handler(request, response));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { port } = server.address();
  const own = `127.0.0.1:${port}`;
  handler = sharedHandler({
    network: { address: "127.0.0.1", port, names: [], isPeer: isLoopback, whois: async () => true, standIn: false }, pairing, json, readBody,
    pair: (request, response, origin) => answerPair(pairing, request, response, { origin, json }),
    pets: async (request, response, { url }) => { reached.push(`${request.method} ${url.pathname}`); json(response, 200, {}); return true; },
  });
  const send = (method, path, cookie) => ask(port, method, path, { ...(method === "GET" ? {} : { body: { code: CODE } }),
    headers: { Host: own, Origin: `http://${own}`, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) } });
  const { cookie } = await send("POST", "/api/pair");
  for (const path of [...viewerPaths(), "/api/pets/whoami", "/api/pets/sell", "/api/pets/", "/api"]) {
    for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH"]) await send(method, path, cookie);
  }
  assert.deepEqual(reached.sort(), ["GET /api/pets", "POST /api/pets/buy", "POST /api/pets/fight"]);
  reached.length = 0;
  for (const path of ["/api/pets", "/api/pets/buy", "/api/pets/fight"]) await send(path === "/api/pets" ? "GET" : "POST", path, "");
  assert.deepEqual(reached, [], "and none of them without a session");
});

test("a peer outside Tailscale's ranges is refused on every route, whatever a forwarded header claims", async (t) => {
  const shared = await host(t, { network: { isPeer: isTailscaleAddress } });
  for (const route of SHARED_ROUTES) {
    const [method, path] = route.split(" ");
    for (const headers of [{}, { "X-Forwarded-For": "100.100.1.1" }, { Forwarded: "for=100.100.1.1", "X-Real-IP": "100.100.1.1", "X-Client-IP": "fd7a:115c:a1e0::1" }]) {
      const refused = await shared.call(method, path, { headers, body: { code: CODE } });
      assert.equal(refused.status, 403, `${route} from loopback with ${JSON.stringify(headers)}`);
      assert.match(refused.body.error, /Tailscale network only\.$/);
    }
  }
  assert.equal(shared.pairing.sessionCount(), 0, "the right code from the wrong network pairs nothing");

  let handler = null;
  const pairing = new Pairing({ code: CODE });
  handler = sharedHandler({ network: { address: "100.101.102.103", port: 43917, names: [], isPeer: isTailscaleAddress, whois: async () => true, standIn: false }, pairing,
    pair: () => {}, pets: async () => false, json, readBody });
  const headers = { host: "100.101.102.103:43917" };
  for (const address of ["127.0.0.1", "::1", "192.168.1.20", "10.0.0.5", "8.8.8.8", "100.63.255.255", "100.128.0.1", "::ffff:192.168.1.20", "fe80::1", "fd7a:115c:a1e1::1", "", undefined])
    assert.equal((await direct(handler, address, { headers })).status, 403, String(address));
  for (const address of ["100.100.1.1", "100.64.0.1", "::ffff:100.100.1.1", "fd7a:115c:a1e0::1"])
    assert.deepEqual(await direct(handler, address, { headers }), { status: 200, body: { ok: true } }, address);
});

test("a peer on the tailnet is refused unless whois names this computer's own login for it", async (t) => {
  const answers = { status: JSON.stringify({ BackendState: "Running", Self: { UserID: 1 }, User: { 1: { LoginName: OWNER } } }) };
  const run = async (cli, args) => {
    const answer = answers[args[0]];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const whoisSays = (login) => { answers.whois = login instanceof Error ? login : JSON.stringify({ Node: {}, UserProfile: { LoginName: login } }); };
  const cases = [["guest@example.org", 403], [new Error("tailscale stopped"), 403], ["tagged-devices", 403], [OWNER, 200]];
  for (const [login, expected] of cases) {
    whoisSays(login);
    const shared = await host(t, { network: { whois: createWhois({ cli: "tailscale", run }) } });
    const label = login instanceof Error ? "a failed lookup" : login;
    for (const route of SHARED_ROUTES) {
      const [method, path] = route.split(" ");
      const { status, body } = await shared.call(method, path, { body: { code: CODE } });
      if (expected === 403) {
        assert.equal(status, 403, `${route} for ${label}`);
        assert.match(body.error, /same Tailscale account/);
      } else assert.notEqual(status, 403, `${route} for the owner`);
    }
    if (expected === 403) assert.equal(shared.pairing.sessionCount(), 0, `${label} pairs nothing, even with the right code`);
  }
});

test("every caller is checked by login: a network with no login check answers nobody, and the stand-in answers this computer only", async () => {
  const over = (network) => sharedHandler({ network: { address: "100.101.102.103", port: 43917, names: [], isPeer: () => true, ...network },
    pairing: new Pairing({ code: CODE }), pair: () => {}, pets: async () => false, json, readBody });
  const headers = { host: "100.101.102.103:43917" };
  for (const whois of [null, undefined, "yes", async () => false]) {
    for (const address of ["100.100.1.1", "fd7a:115c:a1e0::1", "127.0.0.1"]) {
      const refused = await direct(over({ whois, standIn: false }), address, { headers });
      assert.equal(refused.status, 403, `${address} with a login check of ${whois}`);
      assert.match(refused.body.error, /same Tailscale account/);
    }
  }
  assert.deepEqual(await direct(over({ whois: async () => true, standIn: false }), "100.100.1.1", { headers }), { status: 200, body: { ok: true } }, "a caller whose login is this computer's own");

  for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"])
    assert.equal((await direct(over({ whois: null, standIn: true }), address, { headers })).status, 200, `the stand-in answers ${address}`);
  for (const whois of [null, async () => true]) {
    for (const address of ["100.100.1.1", "192.168.1.20", "fd7a:115c:a1e0::1"])
      assert.equal((await direct(over({ whois, standIn: true }), address, { headers })).status, 403, `the stand-in never answers ${address}`);
  }
});

test("only the listener's own address and MagicDNS names are accepted as Host", async (t) => {
  const shared = await host(t);
  const cookie = await shared.session();
  for (const hostHeader of [shared.own, `servitor:${shared.port}`, `servitor.tail1234.ts.net:${shared.port}`, `SERVITOR.Tail1234.ts.net:${shared.port}`])
    assert.equal((await shared.call("GET", "/api/pets", { hostHeader, cookie })).status, 200, hostHeader);
  const wrong = ["evil.example", `evil.example:${shared.port}`, "127.0.0.1", `127.0.0.1:${shared.port + 1}`, `localhost:${shared.port}`, `servitor.tail1234.ts.net.evil.example:${shared.port}`,
    `servitor.evil.example:${shared.port}`, `100.100.1.1:${shared.port}`, "servitor"];
  for (const hostHeader of wrong) {
    for (const [method, path] of [["GET", "/api/pets"], ["GET", "/api/pets/whoami"], ["POST", "/api/pets/buy"], ["POST", "/api/pair"]]) {
      const refused = await shared.call(method, path, { hostHeader, cookie, origin: `http://${hostHeader}`, body: { kind: "recruit", code: CODE } });
      assert.equal(refused.status, 403, `${method} ${path} with Host "${hostHeader}"`);
      assert.match(refused.body.error, /Tailscale address or MagicDNS name only\.$/);
    }
  }
  assert.deepEqual(shared.game.calls, []);

  const handler = sharedHandler({ network: { address: "100.101.102.103", port: 43917, names: NAMES, isPeer: isTailscaleAddress, whois: async () => true, standIn: false },
    pairing: new Pairing({ code: CODE }), pair: () => {}, pets: async () => false, json, readBody });
  for (const headers of [{}, { host: "" }, { host: "100.101.102.103" }])
    assert.equal((await direct(handler, "100.100.1.1", { headers })).status, 403, `Host ${JSON.stringify(headers.host)}`);
  assert.equal((await direct(handler, "100.100.1.1", { headers: { host: "100.101.102.103:43917" } })).status, 200);
});

test("a POST without the listener's own Origin is refused, so a web page cannot pair or buy for the owner", async (t) => {
  const shared = await host(t);
  const cookie = await shared.session();
  const before = shared.pairing.sessionCount();
  for (const origin of [null, "http://evil.example", `http://localhost:${shared.port}`, `https://${shared.own}`, `http://${shared.own}/`, "null"]) {
    for (const [path, body] of [["/api/pets/buy", { kind: "recruit" }], ["/api/pets/fight", { boss: 0 }], ["/api/pair", { code: CODE }]]) {
      const refused = await shared.call("POST", path, { cookie, body, origin: origin ?? undefined, headers: origin === null ? { Origin: [] } : {} });
      assert.equal(refused.status, 403, `${path} with Origin ${origin}`);
    }
  }
  assert.equal((await shared.call("POST", "/api/pets/buy", { cookie, body: { kind: "recruit" }, headers: { "Content-Type": "text/plain" } })).status, 403, "a form post is not JSON");
  assert.deepEqual(shared.game.calls, [], "no refused request reached the game");
  assert.equal(shared.pairing.sessionCount(), before, "and none paired");
  assert.equal((await shared.pair()).status, 200, "six tries from other pages did not use up the owner's five pairing tries");
  assert.equal((await shared.call("POST", "/api/pets/buy", { cookie, body: { kind: "recruit" } })).status, 200);
  assert.deepEqual(shared.game.calls, [["buy", "recruit"]]);
});

test("the game needs a paired session, a wrong code earns none, and guesses are cut off after five", async (t) => {
  const shared = await host(t);
  for (const cookie of [undefined, "goblin_horde_session=", `goblin_horde_session=${"a".repeat(64)}`, "session=1"]) {
    for (const [method, path] of [["GET", "/api/pets"], ["POST", "/api/pets/buy"], ["POST", "/api/pets/fight"]]) {
      const refused = await shared.call(method, path, { cookie, body: { kind: "recruit", boss: 0 } });
      assert.deepEqual([refused.status, refused.body], [401, { error: "Pair this computer with the shared game first." }], `${method} ${path} with ${cookie}`);
    }
  }
  assert.deepEqual((await shared.call("GET", "/api/pets/whoami")).body, { ok: true }, "the health check needs no session and says nothing else");
  assert.deepEqual(shared.game.calls, []);

  const wrong = await shared.pair("AAAAAAAA");
  assert.deepEqual([wrong.status, wrong.cookie], [401, ""]);
  const paired = await shared.pair();
  assert.equal(paired.status, 200);
  assert.match(paired.cookie, /^goblin_horde_session=[a-f0-9]{64}$/);
  assert.ok(!paired.text.includes(CODE) && !wrong.text.includes(CODE), "no answer repeats the code");
  const game = await shared.call("GET", "/api/pets", { cookie: paired.cookie });
  assert.deepEqual([game.status, game.body.ready, game.body.game], [200, true, GAME]);

  for (let guess = 0; guess < 5; guess += 1) assert.equal((await shared.pair("BBBBBBBB")).status, 401, `guess ${guess + 1}`);
  assert.equal((await shared.pair("CCCCCCCC")).status, 429, "the sixth try in ten minutes is not even checked");
  assert.equal((await shared.pair()).status, 429, "nor is the right code, until the ten minutes pass");
  assert.equal((await shared.call("GET", "/api/pets", { cookie: paired.cookie })).status, 200, "a session already earned keeps working");
});

test("an answer carries the game's own fields and a code for what went wrong, and no words or path of the host's leave it", async (t) => {
  const failing = engine({ tick: { ok: false, reason: "save", message: `EPERM: operation not permitted, open '${LOCAL_PATH}'` } });
  const shared = await host(t, { game: failing });
  const { body, text } = await shared.call("GET", "/api/pets", { cookie: await shared.session() });
  assert.deepEqual(Object.keys(body).sort(), ["boot", "events", "game", "ready", "seq", "source"]);
  assert.deepEqual(body.source, { ok: false, reason: "save" }, "why work is not counted leaves as a code, without the sentence");
  assert.ok(!text.includes("someone") && !text.includes("AppData") && !text.includes("EPERM") && !text.includes("operation"), text);
  failing.buy = async () => { throw new Error(`EPERM: operation not permitted, mkdir '${LOCAL_PATH}'`); };
  const failed = await shared.call("POST", "/api/pets/buy", { cookie: await shared.session(), body: { kind: "recruit" } });
  assert.deepEqual([failed.status, failed.body], [500, { reason: "failed" }]);
  const invalid = await shared.call("POST", "/api/pets/buy", { cookie: await shared.session(), body: { kind: "dragon" } });
  assert.deepEqual([invalid.status, invalid.body], [400, { reason: "invalid" }], "a request the game cannot use is answered with a code too");
  assert.deepEqual((await shared.call("POST", "/api/pets/fight", { cookie: await shared.session(), body: { boss: "first" } })).body, { reason: "invalid" });
});

test("a host that has no game to show says why with a code, on every route, and never with its own sentence", async (t) => {
  const held = Object.assign(new Error("Another Goblin Horde on this computer already runs the game."), { code: LOCKED });
  const unreadable = Object.assign(new Error("The saved game could not be read. A copy was kept next to it. Nothing was replaced."), { code: UNREADABLE });
  const broken = new Error(`Goblin Horde could not read pets.json (EPERM) at ${LOCAL_PATH}, so it left the saved game untouched.`);
  for (const [reason, failure] of [["locked", held], ["unreadable", unreadable], ["retrying", broken]]) {
    const shared = await host(t, { game: { ...engine(), start: async () => { throw failure; } } });
    const cookie = await shared.session();
    const waiting = await shared.call("GET", "/api/pets", { cookie });
    assert.deepEqual([waiting.status, waiting.body], [200, { ready: false, reason }]);
    for (const [path, body] of [["/api/pets/buy", { kind: "recruit" }], ["/api/pets/fight", { boss: 0 }]]) {
      const refused = await shared.call("POST", path, { cookie, body });
      assert.deepEqual([refused.status, refused.body], [503, { reason }], path);
    }
    assert.deepEqual(shared.service.status(), { ready: false, reason, message: shared.service.status().message }, "on the host itself the status has its sentence as well");
    assert.match(shared.service.status().message, /^[A-Z].*\.$/);
  }
});

test("whatever the routes behind the listener answer, only the game's own fields leave it, and never the pairing code", async (t) => {
  // A pets handler that answers more than it should, as a route changed later might.
  const READY = { ready: true, boot: "0a1b2c3d", seq: 0, events: [], game: GAME, source: { ok: true } };
  let answer = null;
  const pairing = new Pairing({ code: CODE });
  let handler = null;
  const server = createServer((request, response) => handler(request, response));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { port } = server.address();
  const own = `127.0.0.1:${port}`;
  handler = sharedHandler({
    network: { address: "127.0.0.1", port, names: [], isPeer: isLoopback, whois: async () => true, standIn: false }, pairing, json, readBody,
    pair: (request, response, origin) => answerPair(pairing, request, response, { origin, json }),
    pets: async (request, response, { json: send }) => { send(response, answer.status, answer.data); return true; },
  });
  const headers = { Host: own, Origin: `http://${own}`, "Content-Type": "application/json" };
  const { cookie } = await ask(port, "POST", "/api/pair", { body: { code: CODE }, headers });
  const get = async (status, data) => {
    answer = { status, data };
    return ask(port, "GET", "/api/pets", { headers: { Host: own, Cookie: cookie } });
  };

  const extra = await get(200, { ...READY, chats: ["private words"], game: { ...GAME, state: { ...GAME.state, title: "Project Nightingale" } }, source: { ok: false, reason: "save", message: "line one\nline two", path: "x" } });
  assert.deepEqual(extra.body, { ...READY, source: { ok: false, reason: "save" } });
  // A sentence a route answers with, plain as it may be, stays on this computer.
  for (const message of ["Goblin Horde is opening your saved game.", "Customer meeting notes are copied here."]) {
    assert.deepEqual((await get(200, { ready: false, reason: "opening", message })).body, { ready: false, reason: "opening" });
    assert.deepEqual((await get(200, { ...READY, source: { ok: false, reason: "locked", message } })).body.source, { ok: false, reason: "locked" });
  }
  // The code spelled in a way a reader would still take for it, where a sentence or a code belongs.
  for (const spelled of [CODE.split("").join(" "), `${CODE.slice(0, 4)}-${CODE.slice(4)}`.toLowerCase(), CODE.split("").join("\t")]) {
    for (const data of [{ ready: false, reason: "opening", message: spelled }, { ready: false, reason: spelled }, { ...READY, source: { ok: false, reason: "save", message: spelled } },
      { ready: false, reason: CODE.slice(0, 4), message: CODE.slice(4) }]) {
      const refused = await get(200, data);
      assert.deepEqual([refused.status, refused.body], [500, { error: "Something went wrong on the computer running Goblin Horde." }], JSON.stringify(data).slice(0, 80));
    }
  }
  for (const data of [{ ...READY, code: CODE }, { ...READY, note: `the code is ${CODE.toLowerCase()}` }, { ready: false, message: `Pair with ${CODE}` }]) {
    const refused = await get(200, data);
    assert.deepEqual([refused.status, refused.body], [500, { error: "Something went wrong on the computer running Goblin Horde." }]);
    assert.ok(!refused.text.toUpperCase().includes(CODE), "the code did not leave");
  }
  assert.equal((await get(200, { scene: "everything" })).status, 500, "an answer that is not the game's is not sent");
  assert.deepEqual((await get(503, { error: "Goblin Horde is opening your saved game.", reason: "opening", stack: "at x" })).body, { reason: "opening" });
  assert.deepEqual((await get(503, { error: "Goblin Horde is opening your saved game.", stack: "at x" })).body, { reason: "error" }, "with no code there is nothing to say but that it failed");
});

const made = [];
const withDir = (run) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "goblin-shared-"));
  try { await run(dir, t); } finally {
    // A listener left open by a failed assertion would keep this test file from ending.
    for (const shared of made.splice(0)) await shared.close();
    rmSync(dir, { recursive: true, force: true });
  }
};

/** A SharedAccess whose network is a loopback stand-in on a free port, with every server it made kept to look at. */
async function access(dir, { network, display = false, retryMs = 30_000, watchMs = 60_000, ...timing } = {}) {
  const port = await freePort();
  const servers = [];
  const pairing = new Pairing({ code: CODE });
  const standIn = { address: "127.0.0.1", port, names: [], isPeer: isLoopback, whois: null, standIn: true };
  const shared = new SharedAccess({
    stateDir: dir, port: 43917, pairing, display, retryMs, watchMs, ...timing, network: async () => ({ ...standIn, ...(network?.() ?? {}) }), log: {},
    routes: { pair: (request, response, origin) => answerPair(pairing, request, response, { origin, json }), pets: async () => false, json, readBody },
    serve: (handler) => { const server = createServer(handler); servers.push(server); return server; },
  });
  made.push(shared);
  return { shared, pairing, port, servers };
}
const opens = (port) => new Promise((resolve) => {
  const socket = connect({ port, host: "127.0.0.1" });
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => resolve(false));
});

test("the shared game is off until it is turned on, and an unreadable setting is off", withDir(async (dir) => {
  assert.deepEqual(readSharedSetting(dir), { enabled: false, address: "" });
  const { shared, port, servers } = await access(dir);
  const state = await shared.apply();
  assert.deepEqual([state.enabled, state.listening, state.url, state.problem], [false, false, "", ""]);
  assert.equal(servers.length, 0);
  assert.equal(await opens(port), false);
  for (const text of ["{\"enabled\":\"yes\"}", "not json", "[]", "{\"enabled\":1,\"address\":\"100.101.102.103\"}"]) {
    writeFileSync(join(dir, SHARED_FILE), text);
    assert.equal(readSharedSetting(dir).enabled, false, text);
  }
  writeSharedSetting(dir, { enabled: true, address: "0.0.0.0" });
  assert.deepEqual(readSharedSetting(dir), { enabled: true, address: "" }, "only a Tailscale address, or the stand-in's, is ever saved");
  writeSharedSetting(dir, { enabled: true, address: "192.168.1.20" });
  assert.equal(readSharedSetting(dir).address, "");
  writeSharedSetting(dir, { enabled: true, address: "100.101.102.103" });
  assert.deepEqual(readSharedSetting(dir), { enabled: true, address: "100.101.102.103" });
}));

test("turned on, it listens on this computer's one tailnet address and never on every address", withDir(async (dir) => {
  const { shared, port, servers } = await access(dir);
  const on = await shared.setEnabled(true);
  assert.deepEqual(on, { enabled: true, listening: true, address: "127.0.0.1", port, url: `http://127.0.0.1:${port}`, whois: false, standIn: true, problem: "", sessions: 0 });
  assert.deepEqual(readSharedSetting(dir), { enabled: true, address: "127.0.0.1" });
  assert.equal(servers.length, 1);
  assert.deepEqual([servers[0].address().address, servers[0].address().port], ["127.0.0.1", port]);
  assert.ok(!["0.0.0.0", "::", ""].includes(servers[0].address().address));
  assert.deepEqual((await ask(port, "GET", "/api/pets/whoami", { headers: { Host: `127.0.0.1:${port}` } })).body, { ok: true });
  assert.equal((await shared.apply()).listening, true);
  assert.equal(servers.length, 1, "applying the same choice again keeps the one listener");
  await shared.close();
}));

test("turning it off closes the port and signs every paired computer out", withDir(async (dir) => {
  const { shared, pairing, port } = await access(dir);
  await shared.setEnabled(true);
  const paired = await ask(port, "POST", "/api/pair", { body: { code: CODE }, headers: { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" } });
  const token = paired.cookie.split("=")[1];
  assert.equal(pairing.hasSession(token), true);
  assert.equal((await shared.apply()).sessions, 1);

  const off = await shared.setEnabled(false);
  assert.deepEqual([off.enabled, off.listening, off.url, off.sessions], [false, false, "", 0]);
  assert.equal(await opens(port), false, "nothing listens any more");
  assert.equal(pairing.hasSession(token), false, "the session is gone");
  assert.equal(readSharedSetting(dir).enabled, false);
  await assert.rejects(shared.setEnabled("yes"), /Say whether/);

  await shared.setEnabled(true);
  assert.equal(await opens(port), true, "on again, it listens again");
  assert.equal(pairing.hasSession(token), false, "and the old session stays signed out");
  await shared.close();
}));

/** Pair with the listener on `port` and return what a paired computer holds: its cookie and its session token. */
async function pairedWith(port) {
  const own = `127.0.0.1:${port}`;
  const paired = await ask(port, "POST", "/api/pair", { body: { code: CODE }, headers: { Host: own, Origin: `http://${own}`, "Content-Type": "application/json" } });
  assert.equal(paired.status, 200);
  return { cookie: paired.cookie, token: paired.cookie.split("=")[1] };
}
/** What a paired computer gets when it asks the listener on `port` for the game: the status, or "closed" when nothing listens. */
const asksFor = (port, cookie) => ask(port, "GET", "/api/pets/whoami", { headers: { Host: `127.0.0.1:${port}`, Cookie: cookie } })
  .then(({ status, body }) => ({ status, error: body?.error }), () => "closed");

test("two viewers on one state folder: turning the shared game off through the other one refuses the old session and closes the listener", withDir(async (dir) => {
  // The review's case: the viewer that listens and has a paired computer is not the viewer that was asked.
  const serving = await access(dir, { watchMs: 60_000 });
  await serving.shared.setEnabled(true);
  const { cookie, token } = await pairedWith(serving.port);
  assert.deepEqual(await asksFor(serving.port, cookie), { status: 200, error: undefined });
  const asked = await access(dir);
  const off = await asked.shared.setEnabled(false);
  assert.deepEqual([off.enabled, off.listening], [false, false], "the viewer that was asked says it is off, and it is");

  assert.deepEqual(await asksFor(serving.port, cookie), { status: 403, error: "The shared game is turned off on this computer." }, "the old session's very next request is refused by the other viewer");
  const closed = await until(async () => serving.shared.state(), (state) => !state.listening, "The other viewer's listener never closed.", 3000);
  assert.deepEqual([closed.enabled, closed.listening, closed.sessions], [false, false, 0]);
  assert.equal(serving.pairing.hasSession(token), false, "and its session is ended");
  assert.equal(await asksFor(serving.port, cookie), "closed");
  assert.equal(await opens(serving.port), false);

  await serving.shared.setEnabled(true);
  assert.equal((await asksFor(serving.port, cookie)).status, 200, "on again, it answers");
  assert.equal(serving.pairing.hasSession(token), false, "but the old session stays signed out");
}));

test("a listener closes by itself within seconds when shared.json is turned off, removed, or set to another address by anything else", withDir(async (dir) => {
  const changes = [
    ["turned off in the file, as a manager with no viewer to ask does", () => writeSharedSetting(dir, { enabled: false })],
    ["turned off in so many words", () => writeFileSync(join(dir, SHARED_FILE), "{\"enabled\":false,\"address\":\"127.0.0.1\"}")],
    ["removed", () => rmSync(join(dir, SHARED_FILE))],
    ["turned on for another address", () => writeFileSync(join(dir, SHARED_FILE), JSON.stringify({ enabled: true, address: "100.101.102.103" }))],
  ];
  for (const [what, change] of changes) {
    const { shared, pairing, port } = await access(dir, { watchMs: 25 });
    await shared.setEnabled(true);
    const { token } = await pairedWith(port);
    change();
    // Nobody asks it anything: the listener looks at the file by itself.
    const closed = await until(async () => shared.state(), (state) => !state.listening, `The listener stayed open after shared.json was ${what}.`, 3000);
    assert.equal(closed.listening, false, what);
    assert.equal(await opens(port), false, what);
    if (!readSharedSetting(dir).enabled) assert.equal(pairing.hasSession(token), false, `${what}: the paired computer is signed out`);
    await shared.close();
    rmSync(join(dir, SHARED_FILE), { force: true });
  }
}));

test("a shared.json caught half written is not an off: the listener and its sessions stay for 30 seconds, and it opens again when the file reads", withDir(async (dir) => {
  // The listener's own clock is held here. It looks at the file every 15 ms where a real one looks every second.
  let clock = 0;
  const { shared, pairing, port, servers } = await access(dir, { watchMs: 15, tornMs: 15, monotonic: () => clock });
  const torn = () => writeFileSync(join(dir, SHARED_FILE), "{");
  const mended = () => writeSharedSetting(dir, { enabled: true, address: "127.0.0.1" });
  await shared.setEnabled(true);
  const { cookie, token } = await pairedWith(port);

  // The review's case: the file holds "{" for a moment, as it does in the middle of a write that is not atomic.
  for (const text of ["{", "", "{\"enabled\":tr", "[]", "{\"enabled\":\"yes\"}"]) {
    writeFileSync(join(dir, SHARED_FILE), text);
    await sleep(80);
    assert.deepEqual([shared.state().listening, shared.state().enabled], [true, true], `the listener stays open over ${JSON.stringify(text)}`);
    assert.deepEqual(await asksFor(port, cookie), { status: 200, error: undefined }, "and it goes on answering the computer that is paired");
    mended();
    await sleep(60);
  }
  assert.equal(servers.length, 1, "it is still the one listener: nothing was closed and opened again");
  assert.equal(pairing.hasSession(token), true);

  // Unreadable for 29 seconds of the listener's clock, it still stands. Past 30 it is off, and the paired computer is signed out.
  torn();
  await sleep(80);
  clock += 29_000;
  await sleep(80);
  assert.equal(shared.state().listening, true, "29 seconds after it was first found unreadable, the last setting that could be read still stands");
  assert.equal(pairing.hasSession(token), true);
  clock += 2_000;
  const off = await until(async () => shared.state(), (state) => !state.listening, "The listener stayed open over a shared.json that could not be read for 31 seconds.", 3000);
  assert.deepEqual([off.enabled, off.sessions], [false, 0]);
  assert.match(off.problem, /^shared\.json could not be read, so the shared game is off until it can be\./);
  assert.equal(pairing.hasSession(token), false, "the paired computer is signed out");
  assert.equal(await opens(port), false);

  // Nobody asks it anything, and it still looks: when the file reads again and says on, it opens again.
  clock += 600_000;
  mended();
  const back = await until(async () => shared.state(), (state) => state.listening, "The listener did not open again when shared.json could be read.", 3000);
  assert.deepEqual([back.enabled, back.problem], [true, ""]);
  assert.equal(await opens(port), true);
  assert.equal(pairing.hasSession(token), false, "a session that was ended stays ended");

  // An off in so many words is an off at once, straight after a moment the file could not be read.
  const again = await pairedWith(port);
  torn();
  await sleep(50);
  assert.equal(shared.state().listening, true);
  writeSharedSetting(dir, { enabled: false });
  const closed = await until(async () => shared.state(), (state) => !state.listening, "An explicit off waited for the 30 seconds.", 2000);
  assert.deepEqual([closed.enabled, closed.problem], [false, ""]);
  assert.equal(pairing.hasSession(again.token), false);
  await shared.close();
}));

test("a viewer that starts on a shared.json it cannot read is off, and opens once the file reads and says on", withDir(async (dir) => {
  writeFileSync(join(dir, SHARED_FILE), "{\"enabled\":tr");
  const { shared, port, servers } = await access(dir, { watchMs: 15, tornMs: 15 });
  const state = await shared.apply();
  assert.deepEqual([state.enabled, state.listening], [false, false], "with no setting it ever read, there is nothing to keep");
  assert.equal(servers.length, 0);
  writeSharedSetting(dir, { enabled: true, address: "127.0.0.1" });
  const open = await until(async () => shared.state(), (now) => now.listening, "The listener never opened once shared.json could be read.", 3000);
  assert.equal(open.url, `http://127.0.0.1:${port}`);
  await shared.close();
  // Closed for good, it looks at nothing any more.
  writeFileSync(join(dir, SHARED_FILE), "{");
  writeSharedSetting(dir, { enabled: true, address: "127.0.0.1" });
  await sleep(80);
  assert.equal(shared.state().listening, false);
}));

test("a listener asks Tailscale for this computer's address again every minute, and closes and says so when it is no longer the one it listens on", withDir(async (dir) => {
  // The tailscale program is a function here whose answer changes. Nothing is listened on: the server is a stand-in that records.
  let address = "100.101.102.103";
  const asked = [];
  const run = async (cli, args) => {
    asked.push(args[0]);
    if (address === null) throw new Error("The tailscale program did not answer.");
    return args[0] === "ip" ? `${address}\n` : JSON.stringify({ BackendState: "Running", Self: { UserID: 1, DNSName: "servitor.tail1234.ts.net.", TailscaleIPs: [address] }, User: { 1: { LoginName: OWNER } } });
  };
  const adapters = { Tailscale: ["100.101.102.103", "100.99.1.1"].map((ip) => ({ family: "IPv4", internal: false, address: ip })) };
  const lines = [];
  const listens = [];
  let closes = 0;
  const serve = () => ({ once() {}, off() {}, on() {}, closeAllConnections() {}, close(done) { closes += 1; done?.(); },
    listen(port, where, done) { listens.push(where); done(); }, address: () => ({ address: listens.at(-1) }) });
  const pairing = new Pairing({ code: CODE });
  const shared = new SharedAccess({ stateDir: dir, port: 43917, pairing, serve, recheckMs: 25, retryMs: 25, log: { error: (line) => lines.push(line) },
    network: () => sharedNetwork({ port: 43917, env: {}, interfaces: adapters, cli: "tailscale", run }), routes: { pair: () => {}, pets: async () => false, json, readBody } });
  made.push(shared);
  assert.deepEqual([(await shared.setEnabled(true)).address, listens], ["100.101.102.103", ["100.101.102.103"]]);

  const before = asked.length;
  await sleep(120);
  assert.ok(asked.slice(before).filter((what) => what === "ip").length >= 2, "it asked again by itself, more than once");
  assert.deepEqual([shared.state().listening, listens.length, closes, lines], [true, 1, 0, []], "and with the same answer nothing changed");

  // Tailscale gives this computer another address.
  address = "100.99.1.1";
  const moved = await until(async () => shared.state(), (state) => !state.listening, "The listener stayed open on an address that is no longer this computer's Tailscale address.", 3000);
  assert.equal(moved.problem, "This computer's Tailscale address is not the one the shared game was turned on for. Run pets-host enable again.");
  assert.equal(closes, 1);
  await sleep(120);
  assert.deepEqual(listens, ["100.101.102.103"], "it never listens on the new address by itself");
  assert.deepEqual(lines, ["Shared game: This computer's Tailscale address is not the one the shared game was turned on for. Run pets-host enable again."], "the reason is logged, once");

  // The old address comes back, and so does the listener. Then Tailscale stops answering, and it closes again.
  address = "100.101.102.103";
  await until(async () => shared.state(), (state) => state.listening, "The listener did not open again on its own address.", 3000);
  assert.deepEqual(listens, ["100.101.102.103", "100.101.102.103"]);
  address = null;
  const down = await until(async () => shared.state(), (state) => !state.listening, "The listener stayed open with no word from Tailscale.", 3000);
  assert.equal(down.problem, "Tailscale is not connected on this computer, so the shared game is not listening.");
  assert.equal(closes, 2);
  assert.equal(lines.at(-1), "Shared game: Tailscale is not connected on this computer, so the shared game is not listening.");
  await shared.close();
}));

test("it stays closed with no Tailscale address, with another address than it was turned on for, and on a display", withDir(async (dir) => {
  let address = "";
  const none = await access(dir, { network: () => ({ address }) });
  await assert.rejects(none.shared.setEnabled(true), (error) => error.statusCode === 409 && /Tailscale is not connected/.test(error.message));
  assert.equal(existsSync(join(dir, SHARED_FILE)), false, "a refused enable saves nothing");

  writeFileSync(join(dir, SHARED_FILE), JSON.stringify({ enabled: true, address: "100.101.102.103" }));
  const down = await none.shared.apply();
  assert.deepEqual([down.enabled, down.listening], [true, false]);
  assert.match(down.problem, /Tailscale is not connected/);
  address = "127.0.0.1";
  const moved = await none.shared.apply();
  assert.equal(moved.listening, false);
  assert.match(moved.problem, /not the one the shared game was turned on for/);

  for (const wildcard of ["0.0.0.0", "::", ""]) {
    writeFileSync(join(dir, SHARED_FILE), JSON.stringify({ enabled: true, address: wildcard }));
    address = wildcard;
    assert.equal((await none.shared.apply()).listening, false, `a setting of "${wildcard}"`);
  }
  assert.equal(none.servers.length, 0, "no listener was ever made");
  assert.equal(await opens(none.port), false);

  writeSharedSetting(dir, { enabled: true, address: "127.0.0.1" });
  const display = await access(dir, { display: true });
  const state = await display.shared.apply();
  assert.equal(state.listening, false);
  assert.match(state.problem, /shows another computer's shared game/);
  await assert.rejects(display.shared.setEnabled(true), (error) => error.statusCode === 409);
  assert.equal(display.servers.length, 0);
}));

test("a listener that could not open because Tailscale was not up yet opens by itself once it is", withDir(async (dir) => {
  let address = "";
  const { shared, port } = await access(dir, { network: () => ({ address }), retryMs: 25 });
  writeSharedSetting(dir, { enabled: true, address: "127.0.0.1" });
  const down = await shared.apply();
  assert.equal(down.listening, false);
  assert.match(down.problem, /Tailscale is not connected/);
  await sleep(80);
  assert.equal(await opens(port), false, "still closed while there is no address");

  address = "127.0.0.1";
  const up = await until(async () => shared.state(), (state) => state.listening, "The listener never opened by itself.", 5000);
  assert.deepEqual([up.url, up.problem], [`http://127.0.0.1:${port}`, ""]);
  assert.equal(await opens(port), true);

  await shared.setEnabled(false);
  await sleep(80);
  assert.equal(await opens(port), false, "turned off, it is not tried again");
}));

const STATUS = JSON.stringify({ BackendState: "Running", Self: { UserID: 1, DNSName: "servitor.tail1234.ts.net.", TailscaleIPs: ["100.101.102.103"] }, User: { 1: { LoginName: OWNER } } });
// The review's computer: Tailscale's own adapter, and a Wi-Fi adapter whose provider handed it an address in Tailscale's range.
const ADAPTERS = { "Wi-Fi": [{ family: "IPv4", internal: false, address: "100.72.9.9" }], Tailscale: [{ family: "IPv4", internal: false, address: "100.101.102.103" }] };
const NO_PROGRAM = "Tailscale's program was not found, so the shared game cannot check who is calling.";

test("the loopback stand-in replaces Tailscale whole, and without it the network comes from Tailscale alone", async () => {
  const never = async () => { throw new Error("the tailscale program must not be run"); };
  const standIn = await sharedNetwork({ port: 43917, env: { GOBLIN_SHARED_LOOPBACK: "45123" }, interfaces: {}, cli: "tailscale", run: never });
  assert.deepEqual([standIn.address, standIn.port, standIn.names, standIn.whois, standIn.standIn], ["127.0.0.1", 45123, [], null, true]);
  assert.deepEqual([standIn.isPeer("127.0.0.1"), standIn.isPeer("::ffff:127.0.0.1"), standIn.isPeer("100.100.1.1"), standIn.isPeer("192.168.1.20")], [true, true, false, false]);
  for (const bad of ["", "0", "80", "70000", "abc", "45123.5"]) {
    const real = await sharedNetwork({ port: 43917, env: { GOBLIN_SHARED_LOOPBACK: bad }, interfaces: {}, cli: "", run: never });
    assert.deepEqual([real.address, real.standIn], ["", false], `"${bad}" is no stand-in`);
  }

  const run = async (cli, args) => (args[0] === "ip" ? "100.101.102.103\n" : STATUS);
  const real = await sharedNetwork({ port: 43917, env: {}, interfaces: ADAPTERS, cli: "tailscale", run });
  assert.deepEqual([real.address, real.port, real.names, real.standIn, real.problem], ["100.101.102.103", 43917, NAMES, false, ""]);
  assert.equal(typeof real.whois, "function", "with the tailscale program, callers are checked by login");
  assert.deepEqual([real.isPeer("100.100.1.1"), real.isPeer("127.0.0.1")], [true, false]);
  const noProgram = await sharedNetwork({ port: 43917, env: {}, interfaces: ADAPTERS, cli: "", run: never });
  assert.deepEqual([noProgram.address, noProgram.whois, noProgram.names, noProgram.problem], ["", null, [], NO_PROGRAM], "with no tailscale program there is no address to listen on, whatever the adapters are called");
});

/** A SharedAccess whose listener is a recording stand-in for a server: `listens` holds every [port, address] it was asked to open. */
function recorded(dir, network) {
  const listens = [];
  const pairing = new Pairing({ code: CODE });
  const serve = () => ({
    once() {}, off() {}, on() {}, closeAllConnections() {}, close(done) { done?.(); },
    listen(port, address, done) { listens.push([port, address]); done(); },
    address: () => ({ address: listens.at(-1)[1] }),
  });
  const shared = new SharedAccess({ stateDir: dir, port: 43917, pairing, network, serve, log: {}, routes: { pair: () => {}, pets: async () => false, json, readBody } });
  made.push(shared);
  return { shared, listens };
}

test("with no tailscale program, or without its word on this computer's address, nothing listens and the reason is said", withDir(async (dir) => {
  const never = async () => { throw new Error("there is no tailscale program to run"); };
  const cases = [
    ["no tailscale program", { cli: "", run: never }, NO_PROGRAM],
    ["a tailscale program that does not answer", { cli: "tailscale", run: async () => { throw new Error("stopped"); } }, "Tailscale is not connected on this computer, so the shared game is not listening."],
    ["a tailscale program whose address its own status does not list", { cli: "tailscale", run: async (cli, args) => (args[0] === "ip" ? "100.72.9.9\n" : STATUS) },
      "Tailscale is not connected on this computer, so the shared game is not listening."],
  ];
  for (const [what, tailscale, problem] of cases) {
    const network = () => sharedNetwork({ port: 43917, env: {}, interfaces: ADAPTERS, ...tailscale });
    for (const saved of ["100.72.9.9", "100.101.102.103"]) {
      writeFileSync(join(dir, SHARED_FILE), JSON.stringify({ enabled: true, address: saved }));
      const { shared, listens } = recorded(dir, network);
      const state = await shared.apply();
      assert.deepEqual([state.enabled, state.listening, state.address, state.url, state.problem], [true, false, "", "", problem], `${what}, turned on for ${saved}`);
      assert.deepEqual(listens, [], `${what}: no address was listened on`);
      await shared.close();
    }
    rmSync(join(dir, SHARED_FILE));
    const { shared, listens } = recorded(dir, network);
    await assert.rejects(shared.setEnabled(true), (error) => error.statusCode === 409 && error.message === problem, what);
    assert.equal(existsSync(join(dir, SHARED_FILE)), false, `${what}: a refused enable saves nothing`);
    assert.deepEqual(listens, []);
  }

  const run = async (cli, args) => (args[0] === "ip" ? "100.101.102.103\n" : STATUS);
  const { shared, listens } = recorded(dir, () => sharedNetwork({ port: 43917, env: {}, interfaces: ADAPTERS, cli: "tailscale", run }));
  const on = await shared.setEnabled(true);
  assert.deepEqual([on.listening, on.address, on.whois, on.problem], [true, "100.101.102.103", true, ""], "with the program's word on the address, it listens there, with the login check on");
  assert.deepEqual(listens, [[43917, "100.101.102.103"]], "and on no other address");
}));

test("an address is listened on only when it is a Tailscale address with a login check, or 127.0.0.1 as the stand-in", withDir(async (dir) => {
  const whois = async () => true;
  const refused = [
    ["this computer itself without the stand-in", { address: "127.0.0.1", standIn: false, whois }, /cannot check who is calling|not a Tailscale address/],
    ["a Tailscale address with no login check", { address: "100.101.102.103", standIn: false, whois: null }, /cannot check who is calling/],
    ["a Tailscale address as the stand-in", { address: "100.101.102.103", standIn: true, whois: null }, /not a Tailscale address/],
    ["a network that names its own problem", { address: "100.101.102.103", standIn: false, whois, problem: NO_PROGRAM }, /cannot check who is calling/],
  ];
  for (const [what, network, problem] of refused) {
    writeFileSync(join(dir, SHARED_FILE), JSON.stringify({ enabled: true, address: network.address }));
    const { shared, listens } = recorded(dir, async () => ({ port: 43917, names: [], isPeer: () => true, problem: "", ...network }));
    const state = await shared.apply();
    assert.equal(state.listening, false, what);
    assert.match(state.problem, problem, what);
    assert.deepEqual(listens, [], what);
    await shared.close();
  }
  for (const network of [{ address: "100.101.102.103", standIn: false, whois }, { address: "127.0.0.1", standIn: true, whois: null }]) {
    writeFileSync(join(dir, SHARED_FILE), JSON.stringify({ enabled: true, address: network.address }));
    const { shared, listens } = recorded(dir, async () => ({ port: 43917, names: [], isPeer: () => true, problem: "", ...network }));
    assert.equal((await shared.apply()).listening, true, network.address);
    assert.deepEqual(listens, [[43917, network.address]]);
    await shared.close();
  }
}));
