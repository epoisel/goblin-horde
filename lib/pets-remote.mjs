/**
 * The display side of a shared pet game: this viewer shows the game another computer on the tailnet runs.
 *
 * `pets-join` leaves remote.json ({ host }) and remote-code.txt (that host's pairing code) in the state folder.
 * A viewer that finds remote.json opens no saved game of its own. Its pets routes keep their local, Origin, and
 * JSON checks and forward to the host: pair once, keep the session in memory, pair again after a 401. A host's
 * answer is cut down to the game's own fields and codes before it is passed on (lib/pets-answers.mjs). No
 * sentence a host sends is ever shown: this computer says each code in its own words, and what a host says when
 * it refuses is never repeated. A host that cannot be reached, that refuses, or whose answer cannot be read is a
 * game that is not ready, with one sentence of this computer's own.
 *
 * The pairing code is sent only in the body of POST /api/pair, only to an address in Tailscale's range, and is
 * never logged or put in a message. An answer that holds it, however it is spelled, is not passed on.
 */
import { lookup as dnsLookup } from "node:dns";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { localOnlyRefusal } from "./local-only.mjs";
import { PAIRING_CODE } from "./pairing.mjs";
import { inWords, knownRefusal, readAnswer } from "./pets-answers.mjs";
import { ACTIONS, LOCAL_ONLY } from "./pets-routes.mjs";
import { protectFile, writePrivateFile } from "./private-file.mjs";
import { isDnsName, isLoopback, isTailscaleAddress, isTailscaleIPv4, loopbackStandIn } from "./tailscale.mjs";

/**
 * @typedef {{ name: string, port: number, origin: string }} Host
 *   `name` is a Tailscale IPv4 address or a MagicDNS name, and `origin` is "http://name:port".
 * @typedef {Host & { code: string }} RemoteSetting
 * @typedef {{ status: number, data: object | null, session: string }} HostAnswer
 *   `data` is the answer's JSON object as the host sent it, or null when it was anything else. `session` is the
 *   token of a session cookie the answer set, or "".
 * @typedef {{ ok: true, status: number, data: object } | { ok: false, kind: string, message: string }} Forwarded
 *   `data` is the host's answer cut down to the game's own fields.
 */

const TIMEOUT_MS = 4000;
const ANSWER_LIMIT = 512_000;

export const REMOTE_FILE = "remote.json";
export const REMOTE_CODE_FILE = "remote-code.txt";

const BROKEN = "This computer's shared game settings could not be read. Run pets-join again, or pets-join --off to play this computer's own game.";
const EXPOSED = `${REMOTE_CODE_FILE} could not be made private to your account on this computer, so this computer does not show the shared game. `
  + "Run pets-join again, or pets-join --off to play this computer's own game.";
const error = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// What stops this computer showing the host's game: what the person is told, and how long to leave the host
// alone after it, doubling up to a limit. A host takes five wrong codes from an address in ten minutes, so a
// refused code is tried at most three times in that long, which leaves room for the right one.
const TROUBLE = {
  unreachable: { firstMs: 2_000, maxMs: 30_000, words: (name) => `The shared game on ${name} is not reachable. Is Goblin Horde running there?` },
  code: { firstMs: 120_000, maxMs: 600_000, words: (name) => `The shared game on ${name} did not accept this computer's pairing code.` },
  refused: { firstMs: 5_000, maxMs: 60_000, words: (name) => `The shared game on ${name} refused this computer. Run Goblin Horde's doctor on both computers to see why.` },
  garbled: { firstMs: 5_000, maxMs: 60_000, words: (name) => `The shared game on ${name} sent an answer this computer could not read. Both computers need the same version of Goblin Horde.` },
};

// Four decimal numbers from 0 to 255 with no leading zero: the one spelling of an IPv4 address every parser reads alike.
const DOTTED_IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
// Digits, dots, and the letters of a hexadecimal number: what a URL parser or a resolver may read as an address.
const NUMBER_LIKE = /^[0-9a-fx.]+$/;

/**
 * The host a person typed as `address[:port]`, or null when it is not one this computer may send a pairing code
 * to: a Tailscale IPv4 address in plain dotted decimals, or a DNS name. A URL parser reads "0x7f000001",
 * "2130706433", "0177.0.0.1" and "127.1" as 127.0.0.1, so its reading of the host is the only one kept, and a
 * host it read differently from what was typed is refused. So is a name that could be a number. A name is checked
 * again when it is looked up, since only then is its address known. `loopback` also allows 127.0.0.1, for the
 * stand-in. No IPv6 address is a host, because a host listens on its Tailscale IPv4 address.
 * @returns {Host | null}
 */
export function parseHost(text, { defaultPort = 0, loopback = false } = {}) {
  const match = /^(?:http:\/\/)?([a-z0-9.-]+)(?::(\d{1,5}))?\/?$/i.exec(String(text ?? "").trim());
  if (!match) return null;
  const port = Number(match[2] || defaultPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
  let name;
  try { name = new URL(`http://${match[1]}:${port}/`).hostname; } catch { return null; }
  if (name !== match[1].toLowerCase()) return null;
  const allowed = NUMBER_LIKE.test(name) ? DOTTED_IPV4.test(name) && (isTailscaleIPv4(name) || (loopback && name === "127.0.0.1")) : isDnsName(name);
  return allowed ? { name, port, origin: `http://${name}:${port}` } : null;
}

/**
 * What pets-join saved: null when this computer plays its own game, the host and its code, or `{ problem }` when
 * remote.json is there but it or the code cannot be used. A computer with a problem is still a display.
 * @returns {RemoteSetting | { problem: string } | null}
 */
export function readRemoteSetting(stateDir, { env = process.env } = {}) {
  let saved;
  try { saved = JSON.parse(readFileSync(join(stateDir, REMOTE_FILE), "utf8")); } catch (failure) {
    return failure.code === "ENOENT" ? null : { problem: BROKEN };
  }
  const host = parseHost(saved?.host, { loopback: loopbackStandIn(env) > 0 });
  let code = "";
  try { code = readFileSync(join(stateDir, REMOTE_CODE_FILE), "utf8").trim(); } catch { /* Reported below. */ }
  return host && PAIRING_CODE.test(code) ? { ...host, code } : { problem: BROKEN };
}

/**
 * What a viewer that is starting goes by: `readRemoteSetting`, once the file that holds the host's code has been
 * made private to this account. A file an older version or another program left with its folder's permissions is
 * repaired where it is. When it cannot be, the code is not read, and this computer is a display with a problem:
 * it shows no host's game and sends its host nothing. `protect` makes one file private, or throws.
 * @returns {RemoteSetting | { problem: string } | null}
 */
export function startingRemoteSetting(stateDir, { env = process.env, protect = protectFile } = {}) {
  const codeFile = join(stateDir, REMOTE_CODE_FILE);
  if (existsSync(join(stateDir, REMOTE_FILE)) && existsSync(codeFile)) {
    try { protect(codeFile); } catch { return { problem: EXPOSED }; }
  }
  return readRemoteSetting(stateDir, { env });
}

function replaceFile(file, text) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, text, { mode: 0o600 });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

/**
 * Save the host and its pairing code. The code lands first, so a viewer never finds a host without one, and it
 * lands in a file only this account can read. When that file cannot be made private, nothing is saved.
 */
export function writeRemoteSetting(stateDir, { origin, code }) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writePrivateFile(join(stateDir, REMOTE_CODE_FILE), `${code}\n`);
  replaceFile(join(stateDir, REMOTE_FILE), `${JSON.stringify({ host: origin })}\n`);
}

/** Forget the host and its code, so this computer plays its own game again. */
export function removeRemoteSetting(stateDir) {
  for (const name of [REMOTE_FILE, REMOTE_CODE_FILE]) rmSync(join(stateDir, name), { force: true });
}

const offTailnet = () => Object.assign(new Error("That host is not an address on the tailnet."), { code: "ENOTTAILNET" });

// A name is only connected to when it resolves to a tailnet address: the pairing code must not leave the tailnet.
const tailnetLookup = (loopback, resolve) => (hostname, options, callback) => {
  resolve(hostname, { ...options, all: true }, (failure, addresses) => {
    if (failure) return callback(failure);
    const allowed = addresses.filter(({ address }) => isTailscaleAddress(address) || (loopback && isLoopback(address)));
    if (!allowed.length) return callback(offTailnet());
    return options?.all ? callback(null, allowed) : callback(null, allowed[0].address, allowed[0].family);
  });
};

/**
 * One JSON request to the host, over a connection of its own and never through a proxy. It rejects when the host
 * has not finished its answer within `timeoutMs`, whatever it sent meanwhile, or when its name is not an address
 * on the tailnet. `resolve` looks a name up as dns.lookup does.
 * @returns {Promise<HostAnswer>}
 */
export function askHost(origin, method, path, { session = "", body, timeoutMs = TIMEOUT_MS, loopback = false, resolve = dnsLookup } = {}) {
  return new Promise((answer, reject) => {
    // The host is read once, here. The connection is made to that reading of it and to no other text, so the
    // request is never given a URL to read again. An address is never looked up, so its range was checked here.
    const host = parseHost(origin, { loopback });
    if (!host) { reject(offTailnet()); return; }
    const text = body === undefined ? "" : JSON.stringify(body);
    let settled = false;
    const settle = (finish, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      finish(value);
    };
    const giveUp = (failure) => {
      settle(reject, failure);
      request.destroy();
    };
    const request = httpRequest({
      host: host.name, port: host.port, method, path, agent: false, lookup: tailnetLookup(loopback, resolve),
      headers: {
        Accept: "application/json",
        ...(session ? { Cookie: `goblin_horde_session=${session}` } : {}),
        ...(method === "POST" ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text), Origin: host.origin } : {}),
      },
    }, (response) => {
      let received = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        received += chunk;
        if (received.length > ANSWER_LIMIT) giveUp(new Error("The host's answer is too large."));
      });
      response.on("end", () => {
        let data = null;
        try { data = JSON.parse(received); } catch { /* Not JSON: no data. */ }
        const session = (response.headers["set-cookie"] || []).map((cookie) => /^goblin_horde_session=([a-f0-9]{64})(?:;|$)/.exec(cookie)?.[1]).find(Boolean) || "";
        settle(answer, { status: response.statusCode, data: isObject(data) ? data : null, session });
      });
      response.on("error", giveUp);
    });
    // The one deadline for the whole exchange. No answer the host sends meanwhile, 101 included, moves or clears it.
    const deadline = setTimeout(() => giveUp(new Error("The host did not answer in time.")), timeoutMs);
    // A host that changes protocol is not a shared game. Its socket would otherwise stay open with nobody reading it.
    for (const event of ["upgrade", "connect"]) {
      request.on(event, (response, socket) => {
        socket.destroy();
        giveUp(new Error("The host did not answer as a shared game."));
      });
    }
    request.on("close", () => giveUp(new Error("The host closed the connection before it answered.")));
    request.on("error", giveUp);
    request.end(text);
  });
}

/**
 * The host's game as this viewer forwards to it. `get(after)` and `post(path, body)` never throw: each answers
 * the host's answer cut down to the game's own fields, or the trouble and its sentence. After trouble the host is left alone for a while, and
 * a call in that time answers the same trouble at once, so a host that is down costs the viewer nothing.
 * @param {RemoteSetting | { problem: string }} setting
 * @param {{ ask?: (method: string, path: string, options?: { session?: string, body?: object }) => Promise<HostAnswer>, now?: () => number,
 *   env?: NodeJS.ProcessEnv }} [options] `ask` replaces the HTTP client in tests. `env` is read for the loopback stand-in.
 * @returns {{ get(after: number): Promise<Forwarded>, post(path: string, body: object): Promise<Forwarded> }}
 */
export function createRemotePets(setting, { ask, now = Date.now, env = process.env } = {}) {
  if (setting.problem) {
    const broken = async () => ({ ok: false, kind: "settings", message: setting.problem });
    return { get: broken, post: broken };
  }
  const { name, origin, code } = setting;
  const loopback = loopbackStandIn(env) > 0;
  const send = ask ?? ((method, path, options) => askHost(origin, method, path, { ...options, loopback }));
  let session = "";
  let pairing = null;
  let down = null;

  const said = (kind) => ({ ok: false, kind, message: TROUBLE[kind].words(name) });
  function trouble(kind) {
    const { firstMs, maxMs } = TROUBLE[kind];
    const waitMs = down?.kind === kind ? Math.min(maxMs, down.waitMs * 2) : firstMs;
    down = { kind, waitMs, until: now() + waitMs };
    return said(kind);
  }
  // One pairing at a time, however many requests wait for it.
  const pair = () => (pairing ??= send("POST", "/api/pair", { body: { code } }).finally(() => { pairing = null; }));

  async function call(method, path, query, body, accepted) {
    if (down && now() < down.until) return said(down.kind);
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!session) {
          const paired = await pair();
          if (paired.status === 401 || paired.status === 429) return trouble("code");
          if (paired.status !== 200 || !paired.session) return trouble("refused");
          session = paired.session;
        }
        const answer = await send(method, `${path}${query}`, { session, body });
        // A 401 means the host restarted or signed this computer out, so pair again, once.
        if (answer.status === 401) { session = ""; continue; }
        if (!accepted.includes(answer.status) || !answer.data) return trouble("refused");
        // Only the game's own fields and codes go on to the widget, with this computer's own sentence for each
        // code, and nothing at all from an answer that holds the pairing code.
        const kept = readAnswer(`${method} ${path}`, answer.status, answer.data, { code });
        if (!kept) return trouble("garbled");
        down = null;
        return { ok: true, status: answer.status, data: inWords(`${method} ${path}`, answer.status, kept) };
      }
      return trouble("refused");
    } catch {
      return trouble("unreachable");
    }
  }

  return {
    get: (after) => call("GET", "/api/pets", `?after=${after}`, undefined, [200]),
    // A purchase the host cannot use (400) and a game not open yet (503) are answers too.
    post: (path, body) => call("POST", path, "", body, [200, 400, 503]),
  };
}

/**
 * Whether `setting`'s host answers as a shared game and takes its code: `{ ok: true }`, or `{ ok: false, problem }`
 * with one plain sentence. pets-join runs it before it saves anything.
 * @param {RemoteSetting} setting
 */
export async function checkHost({ name, origin, code }, { ask, env = process.env } = {}) {
  const loopback = loopbackStandIn(env) > 0;
  const send = ask ?? ((method, path, options) => askHost(origin, method, path, { ...options, loopback }));
  const no = (problem) => ({ ok: false, problem });
  // The host's words are never printed. A refusal that is, word for word, one a host makes is told from this computer's own copy of it.
  const why = (answer) => {
    const refusal = knownRefusal(answer.data?.error);
    return refusal ? ` It said: ${refusal}` : "";
  };
  try {
    const hello = await send("GET", "/api/pets/whoami");
    if (hello.status === 403) return no(`The shared game on ${name} refused this computer.${why(hello)}`);
    if (hello.status !== 200 || hello.data?.ok !== true)
      return no(`${name} answered, but not as a Goblin Horde shared game. Run pets-host enable there, and check the port.`);
    const paired = await send("POST", "/api/pair", { body: { code } });
    if (paired.status === 401 || paired.status === 429) return no(TROUBLE.code.words(name));
    if (paired.status !== 200 || !paired.session) return no(`The shared game on ${name} refused this computer.${why(paired)}`);
    const game = await send("GET", "/api/pets?after=0", { session: paired.session });
    return game.status === 200 && readAnswer("GET /api/pets", 200, game.data, { code }) ? { ok: true } : no(`The shared game on ${name} paired this computer but did not answer with the game.`);
  } catch (failure) {
    return no(failure?.code === "ENOTTAILNET" ? `${name} is not an address on your Tailscale network.` : TROUBLE.unreachable.words(name));
  }
}

/**
 * The game's routes for a display, as one handler for server.mjs; returns true when it answered. The same three
 * routes as lib/pets-routes.mjs, with the same checks on who asks, answered by the host through `remote`.
 * Only the one field a purchase or a fight takes is sent on.
 * @param {ReturnType<typeof createRemotePets>} remote
 */
export function remotePetsRoutes(remote) {
  return async function handleRemotePetsRoute(request, response, { url, local, origin, json, readBody, fail = (res, status, message) => json(res, status, { error: message }) }) {
    const path = url.pathname;
    if (path === "/api/pets" && request.method === "GET") {
      if (!local) { json(response, 403, { error: LOCAL_ONLY }); return true; }
      const after = Number(url.searchParams.get("after"));
      const result = await remote.get(Number.isSafeInteger(after) && after > 0 ? after : 0);
      json(response, 200, result.ok ? result.data : { ready: false, message: result.message });
      return true;
    }
    const action = request.method === "POST" ? ACTIONS.get(path) : undefined;
    if (!action) return false;
    const refusal = localOnlyRefusal({ local, origin, headers: request.headers });
    if (refusal) { json(response, refusal.status, { error: refusal.error }); return true; }
    try {
      const value = (await readBody(request))?.[action.field];
      if (!action.valid(value)) throw error(400, action.invalid);
      const result = await remote.post(path, { [action.field]: value });
      if (!result.ok) throw error(503, result.message);
      json(response, result.status, result.data);
    } catch (failure) { fail(response, failure.statusCode || 500, failure.statusCode ? failure.message : action.failed); }
    return true;
  };
}
