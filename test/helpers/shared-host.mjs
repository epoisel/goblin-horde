/**
 * A shared game host on loopback for tests: the real shared handler, the viewer's real pairing route, and the
 * real pets routes over a scripted engine. The network a test passes says which peers count as the tailnet.
 */
import { createServer } from "node:http";
import { Pairing, answerPair } from "../../lib/pairing.mjs";
import { remotePetsRoutes } from "../../lib/pets-remote.mjs";
import { petsRoutes } from "../../lib/pets-routes.mjs";
import { createPetsService } from "../../lib/pets-service.mjs";
import { sharedHandler } from "../../lib/shared.mjs";
import { isLoopback } from "../../lib/tailscale.mjs";
import { ask, json, readBody } from "./viewer.mjs";

// A pairing code of letters that no sentence holds side by side, so a leak of any part of it is easy to see.
export const CODE = "ZQXZQXZQ";
export const NAMES = ["servitor.tail1234.ts.net", "servitor"];
export const STATE = { schema: 1, wallet: { coins: 64, scrap: 0, lifetimeCoins: 39 }, horde: { size: 3, level: 1, xp: 1, gear: 0 }, upgrades: { hoard: 0, training: 0 },
  bosses: { cleared: 0 }, today: { key: "2026-11-10", reruns: {} } };
export const GAME = { state: STATE, quotes: { recruit: { coins: 40 }, level: { xp: 40, coins: 15 }, gear: { scrap: 20 }, hoard: { coins: 40 }, training: null },
  power: 3, nextBoss: { index: 0, requiredPower: 2.5 } };

/** An engine that answers from fixed values and keeps the purchases and fights it was asked for in `calls`. */
export function engine({ tick = { ok: true, coins: 0, xp: 0, turns: 0, subagents: 0 } } = {}) {
  const calls = [];
  return {
    calls,
    start: async () => ({ welcome: true, away: null, caughtUp: { turns: 0, coins: 0 } }),
    tick: async () => tick,
    snapshot: () => GAME,
    async buy(kind) { calls.push(["buy", kind]); return { state: STATE, ok: true, reason: null }; },
    async fight(boss) { calls.push(["fight", boss]); return { state: STATE, won: true, ratio: 1.2, first: true, rewards: { coins: 20, scrap: 4, xp: 40 }, reason: null }; },
  };
}

/**
 * A shared listener on loopback over `network`. Unless the test says otherwise, loopback counts as the tailnet and
 * the login check takes every caller for the owner.
 * `call` sends one request with this listener's own Host, and its own Origin on a POST, unless told otherwise.
 * `seen` lists every request that reached the listener, as "METHOD path". `sessions` are options for its pairing,
 * such as `{ onePerPeer: true }`, which the viewer's shared listener has.
 */
export async function sharedHost(t, { network = {}, game = engine(), code = CODE, sessions = {} } = {}) {
  const pairing = new Pairing({ code, ...sessions });
  const service = createPetsService({ engine: game, setTimer: () => ({}), clearTimer: () => {}, log: () => {} });
  await service.begin();
  const seen = [];
  let handler = null;
  const server = createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    return handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  t.after(close);
  const { port } = server.address();
  handler = sharedHandler({
    network: { address: "127.0.0.1", port, names: NAMES, isPeer: isLoopback, whois: async () => true, standIn: false, ...network }, pairing,
    pair: (request, response, origin) => answerPair(pairing, request, response, { origin, json }), pets: petsRoutes(service), json, readBody,
  });
  const own = `127.0.0.1:${port}`;
  const call = (method, path, { hostHeader = own, origin = method === "POST" ? `http://${hostHeader}` : undefined, cookie, body, headers = {} } = {}) => ask(port, method, path, {
    body: body ?? (method === "POST" ? {} : undefined),
    headers: { Host: hostHeader, ...(origin ? { Origin: origin } : {}), ...(method === "POST" ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
  });
  const pair = async (attempt = code, options = {}) => call("POST", "/api/pair", { body: { code: attempt }, ...options });
  return { port, own, pairing, game, service, seen, call, pair, close, session: async () => (await pair()).cookie };
}

/**
 * A local viewer that mounts a display's pets routes over `remote` as server.mjs mounts them, plus one other
 * local route. A request with the x-phone header stands for one that is not from this computer.
 */
export async function displayViewer(t, remote) {
  const route = remotePetsRoutes(remote);
  const server = createServer(async (request, response) => {
    const origin = `http://${request.headers.host}`;
    const url = new URL(request.url, origin);
    if (url.pathname === "/api/health") return json(response, 200, { product: "GoblinHorde" });
    const fail = (res, status, message) => json(res, status, { error: message });
    try {
      if (!(await route(request, response, { url, local: !request.headers["x-phone"], origin, json, readBody, fail }))) json(response, 404, { error: "Not found" });
    } catch { json(response, 500, { error: "Unexpected error." }); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { port } = server.address();
  const own = { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" };
  return {
    port,
    get: (path, headers = {}) => ask(port, "GET", path, { headers }),
    post: (path, body, headers = own) => ask(port, "POST", path, { body, headers }),
  };
}
