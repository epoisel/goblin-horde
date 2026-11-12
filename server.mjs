/**
 * The pet game's local server, for this computer only on 127.0.0.1. The desktop goblins (desktop_widget.py) read
 * the game and send purchases, fights, and Quit here. The manager recognises its own server by /api/health, and
 * turns the shared game on and off through /api/shared, whose listener on the Tailscale address is lib/shared.mjs.
 * It also looks for signed updates once a day, and the desktop goblins put one in place through /api/update/apply
 * (lib/update-service.mjs).
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { localOnlyRefusal } from "./lib/local-only.mjs";
import { Pairing, answerPair, startingPairingCode } from "./lib/pairing.mjs";
import { defaultStateDir } from "./lib/paths.mjs";
import { createPetsLock } from "./lib/pets-lock.mjs";
import { createRemotePets, remotePetsRoutes, startingRemoteSetting } from "./lib/pets-remote.mjs";
import { petsRoutes } from "./lib/pets-routes.mjs";
import { createPetsService } from "./lib/pets-service.mjs";
import { createPetsStore } from "./lib/pets-store.mjs";
import { createRewardEngine } from "./lib/reward-engine.mjs";
import { loadConfig } from "./lib/rewards.mjs";
import { SharedAccess } from "./lib/shared.mjs";
import { t3Source } from "./lib/t3-source.mjs";
import { UPDATE_KEY } from "./lib/update-key.mjs";
import { createUpdateService } from "./lib/update-service.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 43917);
const host = "127.0.0.1";
const version = JSON.parse(readFileSync(join(here, "package.json"), "utf8")).version || "0.0.0";
// The manager passes a random instance id so `goblin stop` can tell this copy from any other server on the port.
const instance = /^[a-f0-9]{16,64}$/.test(process.env.GOBLIN_HORDE_INSTANCE || "") ? process.env.GOBLIN_HORDE_INSTANCE : "";
const stateDir = defaultStateDir();
const commonHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" };

function json(response, status, data) {
  response.writeHead(status, { ...commonHeaders, "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

function isLocal(request) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress);
}

const BODY_LIMIT = 12_000;
const tooLarge = () => Object.assign(new Error("Request is too large."), { statusCode: 413 });

/**
 * A small JSON body. An oversized one is answered with 413: the rest is read and dropped rather than
 * breaking off mid-stream, which would destroy the socket before the answer could be sent.
 */
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

/** An error answer, unless a reply is already under way; then the connection is simply ended. */
function fail(response, status, message) {
  if (response.headersSent) return response.destroy();
  return json(response, status, { error: message });
}

// The pet game: finished T3 Code work pays coins (see lib/pets-service.mjs).
// GOBLIN_T3_DB names another T3 database, so a test or an isolated server never reads the real one.
// The engine holds pets.lock, so a second server on this state folder never loads or saves the game.
function petsEngine() {
  try {
    const config = loadConfig(join(here, "game_config.json"));
    return createRewardEngine({ config, store: createPetsStore({ dir: stateDir, config }),
      source: t3Source(process.env.GOBLIN_T3_DB || undefined), lock: createPetsLock({ dir: stateDir, port }) });
  } catch (error) {
    console.error(`The pet game is off: ${error.message}`);
    return null;
  }
}
// A display (pets-join left remote.json) shows another computer's game: it makes no engine and never opens
// pets.json, and its pets routes forward to that host (see lib/pets-remote.mjs). The file with the host's code is
// made private before the code is read, and a display that cannot do that shows no game and says why.
const remote = startingRemoteSetting(stateDir);
const petsService = remote ? null : createPetsService({ engine: petsEngine() });
const petsRoute = remote ? remotePetsRoutes(createRemotePets(remote)) : petsRoutes(petsService);
// The shared game on this computer's Tailscale address, only once pets-host turned it on (see lib/shared.mjs).
// A Tailscale address is one computer, so each address holds one session, and pairing again replaces it.
const pairing = new Pairing({ code: startingPairingCode(stateDir), onePerPeer: true });
const shared = new SharedAccess({ stateDir, port, pairing, display: Boolean(remote), routes: {
  pair: (request, response, origin) => answerPair(pairing, request, response, { origin, json, headers: commonHeaders }), pets: petsRoute, json, readBody,
} });
const updates = createUpdateService({ stateDir, installDir: here.replace(/[\\/]+$/, ""), port, version, key: UPDATE_KEY, fetch: globalThis.fetch, spawn });

const handler = async (request, response) => {
  const hostHeader = request.headers.host || "";
  // This computer only, by its own name for itself, so a page on another site that points its name at 127.0.0.1 is refused.
  if (!isLocal(request) || !["127.0.0.1", "localhost"].includes(hostHeader.split(":")[0])) return json(response, 403, { error: "This computer only." });
  const url = new URL(request.url || "/", `http://${hostHeader}`);
  const origin = `http://${hostHeader}`;
  // The game as this computer's own goblins read it says whether a verified update waits. The shared listener mounts
  // the pets routes without this, so no other computer learns it.
  const answer = request.method === "GET" && url.pathname === "/api/pets"
    ? (res, status, data) => json(res, status, status === 200 ? { ...data, update: updates.staged() } : data) : json;
  if (await petsRoute(request, response, { url, local: isLocal(request), origin, json: answer, readBody, fail })) return;
  if (request.method === "POST" && ["/api/quit", "/api/shared", "/api/update/apply"].includes(url.pathname)) {
    // Quitting, switching the shared game, and putting an update in place come from this computer's own windows, with a JSON body.
    const refusal = localOnlyRefusal({ local: isLocal(request), origin, headers: request.headers });
    if (refusal) return json(response, refusal.status, { error: refusal.error });
    try {
      const data = await readBody(request);
      if (url.pathname === "/api/update/apply") {
        const { status, body } = updates.apply();
        return json(response, status, body);
      }
      if (url.pathname === "/api/quit") {
        // The widget's "Quit Goblin Horde": answer first, then stop the game and exit like a stop would.
        response.on("finish", () => setTimeout(async () => { await stopGame(); process.exit(0); }, 50));
        return json(response, 200, { quitting: true });
      }
      // What `pets-host enable` and `disable` ask of a running server. The answer never holds the pairing code.
      // It names this server's state folder, so a manager knows the answer is about the folder it asked for.
      return json(response, 200, { shared: await shared.setEnabled(data.enabled), stateDir });
    } catch (error) { return fail(response, error.statusCode || 500, error.message || "That did not work."); }
  }
  if (request.method !== "GET") return json(response, 405, { error: "Not allowed." });
  // The manager uses this to recognise its own server before stopping anything.
  if (url.pathname === "/api/health") return json(response, 200, { product: "GoblinHorde", version, pid: process.pid, installDir: here.replace(/[\\/]+$/, ""), instance });
  // `pets-host status` and doctor read the shared listener's state here.
  if (url.pathname === "/api/shared") return json(response, 200, { shared: shared.state(), stateDir });
  return json(response, 404, { error: "Not found" });
};

// Last line of defence: one bad request must never become an unhandled rejection that ends the server.
const safeHandler = (request, response) => handler(request, response).catch(() => fail(response, 500, "Unexpected error."));
const localServer = createServer(safeHandler);
localServer.on("error", (error) => {
  // Say plainly why the server cannot start; the manager reads this from the server log.
  console.error(error.code === "EADDRINUSE" ? `PORT_IN_USE: Port ${port} is already used by another program. Choose another port with --port.`
    : `Could not start the game's server: ${error.message}`);
  process.exit(error.code === "EADDRINUSE" ? 3 : 1);
});
localServer.listen(port, host, () => {
  console.log(`Goblin Horde: http://${host}:${port}`);
  // Only the copy that holds the port opens the saved game, so a copy that exits on a busy port never writes it.
  petsService?.begin();
  if (remote) console.log(remote.problem || `The pet game here shows the shared game on ${remote.name}.`);
  // The Tailscale listener only when pets-host turned the shared game on, and only beside a server that holds its port.
  shared.apply().then((state) => { if (state.problem) console.error(`Shared game: ${state.problem}`); }, (error) => console.error(`Shared game: ${error.message}`));
  updates.begin();
});
/**
 * Stop the pet game before this process exits, and wait for it: the saved game's lock is given up only once the
 * save on its way has landed. A save that hangs is waited on for five seconds. After that the process exits with
 * the lock still in place, and the lock's stopped heartbeat frees it for the next Goblin Horde.
 */
function stopGame() {
  const stopped = Promise.resolve(petsService?.stop()).catch(() => {});
  return Promise.race([stopped, new Promise((resolve) => { setTimeout(resolve, 5000).unref(); })]);
}
// Keep-alive connections would hold the process open, so exit right after stopping the game.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    localServer.close();
    shared.close();
    updates.close();
    await stopGame();
    process.exit(0);
  });
}
