/**
 * The pet game's routes: `GET /api/pets`, `POST /api/pets/buy`, and `POST /api/pets/fight`, all for this
 * computer only (any other caller is answered 403).
 *
 * The desktop widget polls the GET for the coin count and for the events numbered above the last one it
 * showed, and posts a purchase or a fight. Each answer names its fields one by one, so it carries the game's
 * numbers and fixed words and nothing else a source may have read. Whatever is said in a sentence also has a
 * short code, its `reason`, so a shared game's host can send the code and leave the sentence here.
 */
import { localOnlyRefusal } from "./local-only.mjs";
import { PURCHASES } from "./rewards.mjs";

const KINDS = new Set(PURCHASES);
const error = (statusCode, message, reason) => Object.assign(new Error(message), { statusCode, reason });

export const LOCAL_ONLY = "The game is on this computer only.";

// For each POST, the body field it takes, when that is valid, the service call, and the result fields answered.
export const ACTIONS = new Map([
  ["/api/pets/buy", {
    field: "kind",
    valid: (kind) => KINDS.has(kind),
    invalid: "Choose what to buy: recruit, level, gear, hoard, training, or grip.",
    run: (service, kind) => service.buy(kind),
    answer: ({ ok, reason }) => ({ ok, reason }),
    failed: "The purchase could not be saved, so nothing changed.",
  }],
  ["/api/pets/fight", {
    field: "boss",
    valid: (boss) => Number.isInteger(boss) && boss >= 0,
    invalid: "Choose a boss by its number, a whole number from 0 up.",
    run: (service, boss) => service.fight(boss),
    answer: ({ won, ratio, first, rewards, reason }) => ({ won, ratio, first, rewards, reason }),
    failed: "The fight could not be saved, so nothing changed.",
  }],
]);

/**
 * The game's routes as one handler for server.mjs; returns true when it answered. `service` is a pets service
 * (lib/pets-service.mjs).
 *
 * `GET /api/pets?after=N` answers `{ ready: false, reason, message }` until the game is open, then
 * `{ ready: true, boot, seq, events, game, source }`. `events` are those numbered above N and `seq` is the newest
 * number. `boot` names this run of the viewer: when it differs from the last one a client saw, event numbers
 * began again at 1, so the client asks again from 0.
 * The POSTs take the same local, Origin, and JSON checks as the other local routes. A purchase answers
 * `{ ok, reason, game }` and a fight `{ won, ratio, first, rewards, reason, game }`, where `game` is the game
 * after it. Before the game is open they answer 503.
 * `fail(response, status, message, reason)` answers a request that was not done. Its `reason` is the code for
 * why: "invalid" for a body the game cannot use, "failed" for a change that could not be saved, and for a game
 * that is not open the reason it is not.
 */
export function petsRoutes(service) {
  const game = () => {
    const { state, quotes, power, nextBoss } = service.game();
    return { state, quotes, power, nextBoss };
  };
  return async function handlePetsRoute(request, response, { url, local, origin, json, readBody, fail = (res, status, message) => json(res, status, { error: message }) }) {
    const path = url.pathname;
    if (path === "/api/pets" && request.method === "GET") {
      if (!local) { json(response, 403, { error: LOCAL_ONLY }); return true; }
      try {
        const status = service.status();
        if (!status.ready) json(response, 200, { ready: false, reason: status.reason, message: status.message });
        else {
          const after = Number(url.searchParams.get("after"));
          json(response, 200, { ready: true, boot: status.boot, seq: status.seq, events: service.eventsAfter(Number.isInteger(after) ? after : 0), game: game(), source: status.source });
        }
      } catch { fail(response, 500, "Unable to read the game.", "failed"); }
      return true;
    }
    const action = request.method === "POST" ? ACTIONS.get(path) : undefined;
    if (!action) return false;
    const refusal = localOnlyRefusal({ local, origin, headers: request.headers });
    if (refusal) { json(response, refusal.status, { error: refusal.error }); return true; }
    try {
      const value = (await readBody(request))?.[action.field];
      if (!action.valid(value)) throw error(400, action.invalid, "invalid");
      const status = service.status();
      if (!status.ready) throw error(503, status.message, status.reason);
      json(response, 200, { ...action.answer(await action.run(service, value)), game: game() });
    } catch (failure) {
      if (failure.statusCode) fail(response, failure.statusCode, failure.message, failure.reason);
      else fail(response, 500, action.failed, "failed");
    }
    return true;
  };
}
