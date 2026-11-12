/**
 * What crosses between the host of a shared pet game and a display: the host's refusal sentences, the one shape
 * each of the game's three answers may have, and the sentences a display says for itself.
 *
 * No words cross. An answer holds numbers, true and false, a run's name, a date, and short codes from fixed
 * lists: why a game is not ready, why work is not being counted, why a request was not done. The host sends, and
 * a display takes, only what `readAnswer` keeps. A field that is not named here is dropped, a sentence is never
 * looked at, and a code that is not on its list reads "error". What a display shows for a code is its own
 * sentence, from the tables here (`inWords`), and its plain one for "error", which is also what it makes of an
 * older version's host that sends a sentence and no code. An answer that is not this shape is not passed on at
 * all, and neither is one that holds the pairing code anywhere in it, however the code is spelled.
 */
import { ACTIONS } from "./pets-routes.mjs";

/** Why the host refused a request, in the words it answers with. */
export const REFUSED = {
  peer: "The shared game answers computers on its own Tailscale network only.",
  host: "The shared game is reached at its Tailscale address or MagicDNS name only.",
  account: "This computer is not signed in to the same Tailscale account as the shared game's computer.",
  origin: "The shared game takes a change only from its own address.",
  session: "Pair this computer with the shared game first.",
  off: "The shared game is turned off on this computer.",
};

/**
 * This computer's own copy of the host's refusal sentence when `said` is exactly one of them, else "". What a
 * display repeats is never the host's text, which could hold anything, the pairing code included.
 */
export const knownRefusal = (said) => Object.values(REFUSED).find((sentence) => sentence === said) ?? "";

// A display's own sentence for each code a host gives, and its plain one for a code it does not know.
const NOT_READY = "The shared game is not ready yet.";
const WAITING = {
  off: "The game is off on the shared game's computer, because its game_config.json could not be read.",
  opening: "The shared game's computer is opening its saved game.",
  retrying: "The shared game's computer could not open its saved game, and it is trying again.",
  locked: "Another Goblin Horde on the shared game's computer already runs the game.",
  unreadable: "The saved game on the shared game's computer could not be read. Nothing was replaced there.",
  stopped: "Goblin Horde is closing on the shared game's computer.",
};
const NOT_COUNTING = "The shared game's computer cannot read finished work right now.";
const UNCOUNTED = {
  missing: "The shared game's computer cannot read T3 Code's database yet, so it is not counting finished work. Run Goblin Horde's doctor there to see why.",
  locked: "T3 Code's database is busy on the shared game's computer, so it counts finished work on its next check.",
  schema: "The shared game's computer cannot read this version of T3 Code's database, so counting stopped until Goblin Horde is updated there.",
  save: "The shared game's computer could not save the game, so finished work is not paid yet.",
};
const NOT_DONE = "The shared game could not do that.";

// A shape is a function from a value to the part of it that is kept, or undefined when the value does not fit.
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const flag = (value) => (typeof value === "boolean" ? value : undefined);
const oneOf = (...allowed) => (value) => (allowed.includes(value) ? value : undefined);
/** One of the codes in `known`. Anything else in its place, a sentence or nothing at all, is "error": never the text that was there. */
const coded = (known) => (value) => (typeof value === "string" && Object.hasOwn(known, value) ? value : "error");
const text = (pattern) => (value) => (typeof value === "string" && pattern.test(value) ? value : undefined);
const orNull = (shape) => (value) => (value === null ? null : shape(value));
const either = (...shapes) => (value) => shapes.map((shape) => shape(value)).find((kept) => kept !== undefined);
/** An object with every one of `fields`, each cut to its shape. Any other key is dropped. */
const record = (fields) => (value) => {
  if (!isObject(value)) return undefined;
  const kept = {};
  for (const [key, shape] of Object.entries(fields)) {
    if ((kept[key] = shape(value[key])) === undefined) return undefined;
  }
  return kept;
};
/** An object with some of `fields` and at least one. */
const some = (fields) => (value) => {
  if (!isObject(value)) return undefined;
  const kept = {};
  for (const [key, shape] of Object.entries(fields)) {
    if (value[key] !== undefined && (kept[key] = shape(value[key])) === undefined) return undefined;
  }
  return Object.keys(kept).length ? kept : undefined;
};
/** A list of at most `max` items. An item that does not fit is left out, as the widget leaves out an event it does not know. */
const fitting = (shape, max) => (value) => (Array.isArray(value) && value.length <= max ? value.map(shape).filter((item) => item !== undefined) : undefined);
const counts = (key, shape, max) => (value) => {
  if (!isObject(value) || Object.keys(value).length > max) return undefined;
  const kept = {};
  for (const [name, count] of Object.entries(value)) {
    if (!key.test(name) || (kept[name] = shape(count)) === undefined) return undefined;
  }
  return kept;
};

const price = some({ coins: number, scrap: number, xp: number });
const game = record({
  state: record({
    schema: number,
    wallet: record({ coins: number, scrap: number, lifetimeCoins: number }),
    horde: record({ size: number, level: number, xp: number, gear: number }),
    upgrades: record({ hoard: number, training: number }),
    bosses: record({ cleared: number }),
    today: record({ key: text(/^\d{4}-\d{2}-\d{2}$/), reruns: counts(/^\d{1,6}$/, number, 1000) }),
  }),
  quotes: record({ recruit: orNull(price), level: orNull(price), gear: orNull(price), hoard: orNull(price), training: orNull(price) }),
  power: number,
  nextBoss: orNull(record({ index: number, requiredPower: number })),
});
const event = either(
  record({ seq: number, at: number, type: oneOf("work"), coins: number, xp: number, turns: number, subagents: number }),
  record({ seq: number, at: number, type: oneOf("launch"), welcome: flag, away: orNull(record({ minutes: number, coins: number })), caughtUp: record({ turns: number, coins: number }) }),
);
const source = either(record({ ok: oneOf(true) }), record({ ok: oneOf(false), reason: coded(UNCOUNTED) }));
// Why a request was not done: it could not be used, it could not be saved, or the game is not ready, for one of the reasons a game is not.
const failed = record({ reason: coded({ invalid: true, failed: true, ...WAITING }) });

// For each route, the shape of its answer by status. Any other status is a request that was not done, which is one code under `reason`.
const ANSWERS = {
  "GET /api/pets": {
    200: either(
      record({ ready: oneOf(true), boot: text(/^[a-f0-9]{8}$/), seq: number, events: fitting(event, 200), game, source }),
      record({ ready: oneOf(false), reason: coded(WAITING) }),
    ),
  },
  "POST /api/pets/buy": { 200: record({ ok: flag, reason: oneOf(null, "unknown", "maxed", "coins", "scrap", "xp"), game }) },
  "POST /api/pets/fight": {
    200: record({ won: flag, ratio: number, first: flag, rewards: record({ coins: number, scrap: number, xp: number }), reason: oneOf(null, "unknown", "locked"), game }),
  },
};

// A text as only the letters and digits in it, in capitals: what is left of a pairing code however it is spaced, dashed or cased.
const skeleton = (value) => String(value).toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * Whether the pairing code is in `data`: in a field's name, in a text or in a number, whatever the case of its
 * letters and whatever stands between them, or run on across the values that follow one another.
 */
function holdsCode(data, code) {
  const secret = skeleton(code ?? "");
  if (!secret) return false;
  const names = [];
  const values = [];
  // Walked with a list of its own, in the order the answer is written, so an answer nested a thousand deep is walked like any other.
  const todo = [data];
  while (todo.length) {
    const value = todo.pop();
    if (typeof value === "string" || typeof value === "number") values.push(skeleton(value));
    else if (Array.isArray(value)) todo.push(...value.toReversed());
    else if (isObject(value)) {
      for (const [name, inner] of Object.entries(value).reverse()) {
        names.push(skeleton(name));
        todo.push(inner);
      }
    }
  }
  return names.some((name) => name.includes(secret)) || values.join("").includes(secret);
}

/**
 * The answer to `route` ("GET /api/pets", "POST /api/pets/buy" or "POST /api/pets/fight") with `status`, cut down
 * to its shape, or null when `data` is not such an answer or holds `code`. A status the route's table does not
 * name is a request that was not done: it keeps one code under `reason`.
 * @param {string} route @param {number} status @param {unknown} data @param {{ code?: string }} [options]
 * @returns {object | null}
 */
export function readAnswer(route, status, data, { code = "" } = {}) {
  if (!Object.hasOwn(ANSWERS, route) || holdsCode(data, code)) return null;
  return (ANSWERS[route][status] ?? failed)(data) ?? null;
}

/**
 * `answer`, which `readAnswer` kept, as a display hands it to its own widget: each code in it with this
 * computer's sentence for it beside it, under `message`, or under `error` for a request that was not done.
 * @param {string} route @param {number} status @param {object} answer
 */
export function inWords(route, status, answer) {
  if (status !== 200) {
    const action = ACTIONS.get(route.split(" ")[1]);
    return { error: { invalid: action?.invalid, failed: action?.failed }[answer.reason] ?? WAITING[answer.reason] ?? NOT_DONE };
  }
  if (answer.ready === false) return { ...answer, message: WAITING[answer.reason] ?? NOT_READY };
  if (answer.source?.ok === false) return { ...answer, source: { ...answer.source, message: UNCOUNTED[answer.source.reason] ?? NOT_COUNTING } };
  return answer;
}
