/**
 * The host side of a shared pet game: a listener on this computer's own Tailscale address, off until
 * `pets-host enable` turns it on (shared.json in the state folder).
 *
 * It is a server of its own, apart from the viewer's 127.0.0.1 one and from phone access, with its own handler.
 * A route the viewer has is not reachable here unless it is one of the five in sharedHandler. Every request must
 * pass, in this order:
 *
 *   1. the peer's address, as its socket reports it and never from a forwarded header, is a tailnet address;
 *   2. the Host header is this listener's address or one of its MagicDNS names, with its port;
 *   3. the route is one of the five, spelled exactly;
 *   4. `tailscale whois` names the peer's login as this computer's own;
 *   5. a POST carries this listener's own Origin;
 *   6. for the game itself, a session cookie earned with the pairing code at POST /api/pair.
 *
 * It listens only on the address this computer's own tailscale program names, so a computer without that program
 * hosts nothing. The one other address is 127.0.0.1 under the loopback stand-in, which tests use, where there are
 * no logins to ask about and only this computer is answered.
 *
 * What it answers is the game's own fields and short codes (lib/pets-answers.mjs). No sentence of this computer's
 * is in an answer of the game's, so no path and no error text is either.
 * Turning it off closes the listener and signs every paired computer out.
 */
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { sessionCookie } from "./pairing.mjs";
import { REFUSED, readAnswer } from "./pets-answers.mjs";
import { readRemoteSetting } from "./pets-remote.mjs";
import { CODE_FILE, errorText } from "./phone.mjs";
import { protectFile, writePrivateFile } from "./private-file.mjs";
import {
  LOOPBACK_ENV, createWhois, findTailscale, isLoopback, isTailscaleAddress, isTailscaleIPv4, loopbackStandIn, plainAddress, readStatus, runTailscale,
  tailscaleSelf,
} from "./tailscale.mjs";

/**
 * @typedef {{ address: string, port: number, names: string[], isPeer: (address: string) => boolean,
 *   whois: null | ((ip: string) => Promise<boolean>), standIn: boolean, problem: string }} SharedNetwork
 *   Where the shared listener listens and who may call it. `address` is "" when the tailscale program named none.
 *   `whois` is the login check, null only for the loopback stand-in, which `standIn` marks, and for a computer
 *   with no tailscale program. `problem` is why this computer cannot host, or "".
 */

export const SHARED_FILE = "shared.json";
export const NO_TAILSCALE_PROGRAM = "Tailscale's program was not found, so the shared game cannot check who is calling.";

const PROBLEM = {
  display: "This computer shows another computer's shared game, so it does not host one. Run pets-join --off first.",
  noAddress: "Tailscale is not connected on this computer, so the shared game is not listening.",
  notTailscale: "The address the shared game was given is not a Tailscale address, so it is not listening.",
  moved: "This computer's Tailscale address is not the one the shared game was turned on for. Run pets-host enable again.",
  torn: "shared.json could not be read, so the shared game is off until it can be. Run pets-host enable again to write it anew.",
};
const OFF = Object.freeze({ enabled: false, address: "" });
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Why `network` may not be listened on, or "". Two kinds may: an address in Tailscale's range with a login check,
 * and 127.0.0.1 as the loopback stand-in.
 * @param {SharedNetwork} network
 */
function networkProblem(network) {
  if (network.problem) return network.problem;
  if (!network.address) return PROBLEM.noAddress;
  if (network.standIn) return network.address === "127.0.0.1" ? "" : PROBLEM.notTailscale;
  if (typeof network.whois !== "function") return NO_TAILSCALE_PROGRAM;
  return isTailscaleIPv4(network.address) ? "" : PROBLEM.notTailscale;
}
const refusal = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const savedAddress = (address) => (isTailscaleIPv4(address) || address === "127.0.0.1" ? address : "");

/**
 * shared.json as it is on disk: the choice it holds, which is off when there is no such file, or null when the
 * file is there and holds no choice, as when it is caught half written.
 * @returns {{ enabled: boolean, address: string } | null}
 */
function readSharedFile(stateDir) {
  let text;
  try { text = readFileSync(join(stateDir, SHARED_FILE), "utf8"); } catch (failure) { return failure.code === "ENOENT" ? { ...OFF } : null; }
  try {
    const saved = JSON.parse(text);
    return isObject(saved) && typeof saved.enabled === "boolean" ? { enabled: saved.enabled, address: savedAddress(saved.address) } : null;
  } catch { return null; }
}

/** The saved choice: { enabled, address }. Anything unreadable means off, to whoever reads it once. */
export const readSharedSetting = (stateDir) => readSharedFile(stateDir) ?? { ...OFF };

/**
 * Save the choice where only this account can read or change it. Turning the shared game on throws, and saves
 * nothing, when the file cannot be made private. Turning it off always works: with no file, the shared game is off.
 */
export function writeSharedSetting(stateDir, { enabled, address = "" }) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = join(stateDir, SHARED_FILE);
  try { writePrivateFile(file, `${JSON.stringify({ enabled: enabled === true, ...(savedAddress(address) ? { address } : {}) })}\n`); } catch (failure) {
    if (enabled === true) throw failure;
    rmSync(file, { force: true, recursive: true });
  }
}

/**
 * Turn the shared game on for `address` in `stateDir`. The pairing code is what a caller needs from then on, so
 * a code file an older version left with its folder's permissions is made private first. When it cannot be, the
 * shared game stays off.
 */
export function saveSharedOn(stateDir, address) {
  const code = join(stateDir, CODE_FILE);
  if (existsSync(code)) protectFile(code);
  writeSharedSetting(stateDir, { enabled: true, address });
}

/**
 * Where this computer would listen for the shared game, and who may call. `port` is the viewer's port, which the
 * listener shares on its own address. Without the tailscale program there is no address and no login check, so
 * there is nothing to listen on. The loopback stand-in (GOBLIN_SHARED_LOOPBACK) replaces all of it.
 * @returns {Promise<SharedNetwork>}
 */
export async function sharedNetwork({ port, env = process.env, platform = process.platform, interfaces = networkInterfaces(),
  cli = findTailscale({ env, platform }), run = runTailscale }) {
  const standIn = loopbackStandIn(env);
  if (standIn) return { address: "127.0.0.1", port: standIn, names: [], isPeer: isLoopback, whois: null, standIn: true, problem: "" };
  const tailnet = { port, isPeer: isTailscaleAddress, standIn: false };
  if (!cli) return { ...tailnet, address: "", names: [], whois: null, problem: NO_TAILSCALE_PROGRAM };
  const { address, names } = await tailscaleSelf({ interfaces, cli, run });
  return { ...tailnet, address, names, whois: createWhois({ cli, run }), problem: address ? "" : PROBLEM.noAddress };
}

/**
 * The shared listener's whole request handler over `network`. `pair` answers POST /api/pair for `pairing`, and
 * `pets` is the viewer's pets route handler (lib/pets-routes.mjs); `json` and `readBody` are the viewer's own.
 * A peer that passed every check is to the pets routes what this computer is, so they are called as local.
 * @param {{ network: SharedNetwork, pairing: import("./pairing.mjs").Pairing, pair: Function, pets: Function, json: Function, readBody: Function }} options
 */
export function sharedHandler({ network, pairing, pair, pets, json, readBody }) {
  const hosts = new Set([network.address, ...network.names].map((name) => `${name}:${network.port}`));
  const refuse = (response, status, message) => json(response, status, { error: message });

  async function game({ request, response, url, origin }) {
    if (!pairing.hasSession(sessionCookie(request.headers.cookie))) return refuse(response, 401, REFUSED.session);
    // Whatever the routes behind this handler answer, what leaves is the game's own fields and codes: never a
    // sentence of this computer's, and never the pairing code. An answer that cannot be cut down to that is not sent.
    const route = `${request.method} ${url.pathname}`;
    const answer = (res, status, data) => {
      const kept = readAnswer(route, status, data, { code: pairing.code });
      return kept ? json(res, status, kept) : refuse(res, 500, errorText({ local: false, status: 500 }));
    };
    // A request a route could not do leaves as the code for why. Its words stay here.
    const fail = (res, status, message, reason) => (res.headersSent ? res.destroy() : answer(res, status, { reason }));
    if (!(await pets(request, response, { url, local: true, origin, json: answer, readBody, fail }))) refuse(response, 404, "Not found");
  }
  const ROUTES = new Map([
    ["POST /api/pair", ({ request, response, origin }) => pair(request, response, origin)],
    ["GET /api/pets", game],
    ["POST /api/pets/buy", game],
    ["POST /api/pets/fight", game],
    ["GET /api/pets/whoami", ({ response }) => json(response, 200, { ok: true })],
  ]);

  return async function handleShared(request, response) {
    const peer = plainAddress(request.socket.remoteAddress);
    if (!network.isPeer(peer)) return refuse(response, 403, REFUSED.peer);
    const host = String(request.headers.host || "");
    if (!hosts.has(host.toLowerCase())) return refuse(response, 403, REFUSED.host);
    const origin = `http://${host}`;
    // A route is the request's own text up to its first "?", letter for letter. Nothing parses the path, because
    // a parser reads "/x/../api/pets", "/api%2Fpets" and "/api\pets" as routes they do not spell.
    const text = String(request.url ?? "");
    const cut = text.indexOf("?");
    const url = { pathname: cut < 0 ? text : text.slice(0, cut), searchParams: new URLSearchParams(cut < 0 ? "" : text.slice(cut + 1)) };
    const route = ROUTES.get(`${request.method} ${url.pathname}`);
    if (!route) return refuse(response, 404, "Not found");
    // Every caller is checked by login. The loopback stand-in has no logins to ask about, so it answers this computer alone.
    const sameAccount = network.standIn ? isLoopback(peer) : typeof network.whois === "function" && await network.whois(peer);
    if (!sameAccount) return refuse(response, 403, REFUSED.account);
    // Checked here, before the pairing route counts a try, so a page on another site cannot use up the owner's tries.
    if (request.method === "POST" && request.headers.origin !== origin) return refuse(response, 403, REFUSED.origin);
    return route({ request, response, url, origin });
  };
}

/**
 * The shared listener and its on/off switch. `routes` is what sharedHandler needs beside the network and pairing.
 * A listener that is turned on but could not open is tried again every `retryMs`.
 *
 * shared.json is the switch, whoever writes it. An open listener reads it again before every answer and every
 * `watchMs`, and closes itself once the file no longer asks for it. So a change another viewer or a manager
 * made to the file takes effect here too, and no listener goes on serving after the shared game was turned off.
 *
 * A file that cannot be read is not an off. It is what a file looks like in the middle of a write, so the last
 * choice that could be read stands while the file is read again every `tornMs`, for up to `graceMs` on this
 * viewer's own clock (`monotonic`). After that the shared game is off and its paired computers are signed out,
 * and the file is still looked at, so the listener opens again when it reads and says on.
 *
 * An open listener also asks for this computer's Tailscale address again every `recheckMs`, the way it was
 * found at the start. When it is no longer the address listened on, the listener closes and the reason is logged.
 * `protect` makes one file private, or throws.
 */
export class SharedAccess {
  constructor({ stateDir, port, pairing, routes, display = false, network = () => sharedNetwork({ port }), serve = createServer, retryMs = 30_000, watchMs = 3000,
    tornMs = 1000, graceMs = 30_000, recheckMs = 60_000, monotonic = () => performance.now(), protect = protectFile, log = console }) {
    Object.assign(this, { stateDir, port, pairing, routes, display, network, serve, retryMs, watchMs, tornMs, graceMs, recheckMs, monotonic, protect, log });
    this.server = null;
    this.current = { enabled: false, address: "", port, whois: false, standIn: false, problem: "" };
    this.listening = false;
    this.changing = Promise.resolve();
    this.retry = null;
    this.watch = null;
    this.recheck = null;
    this.closed = false;
    // The last choice shared.json held when it could be read, and when it was first found unreadable since.
    this.known = { ...OFF };
    this.tornSince = null;
  }

  /**
   * The choice to go by now, and whether shared.json is `torn`, which is to say there and unreadable. A torn file
   * is answered with the last choice that could be read, for `graceMs`, and with off after that.
   * @returns {{ enabled: boolean, address: string, torn: boolean }}
   */
  setting() {
    const read = readSharedFile(this.stateDir);
    if (read) {
      this.known = read;
      this.tornSince = null;
      return { ...read, torn: false };
    }
    this.tornSince ??= this.monotonic();
    return { ...(this.monotonic() - this.tornSince < this.graceMs ? this.known : OFF), torn: true };
  }

  /** The name of the first of the pairing code's file and shared.json that is there and cannot be made private, or "". */
  exposedFile() {
    for (const name of [CODE_FILE, SHARED_FILE]) {
      const file = join(this.stateDir, name);
      try { if (existsSync(file)) this.protect(file); } catch { return name; }
    }
    return "";
  }

  /** Whether shared.json still asks for the listener that is open now. */
  stillWanted() {
    const setting = this.setting();
    return setting.enabled && setting.address === this.current.address;
  }

  /**
   * Look at shared.json again in a while, by itself: while a listener is open, so that it never outlives the
   * switch by more than a few seconds, and while the file cannot be read, so that it is seen when it can be.
   */
  lookLater() {
    clearTimeout(this.watch);
    this.watch = null;
    const torn = this.tornSince !== null;
    if (this.closed || !(this.listening || torn)) return;
    const soon = torn && this.monotonic() - this.tornSince < this.graceMs;
    this.watch = setTimeout(() => this.look(), soon ? this.tornMs : this.watchMs);
    this.watch.unref?.();
  }

  look() {
    const setting = this.setting();
    // An open listener must still be asked for. A closed one is here because the file could not be read, and waits for one that can.
    const changed = this.listening ? !(setting.enabled && setting.address === this.current.address) : !setting.torn;
    if (changed) this.apply().catch(() => {});
    else this.lookLater();
  }

  /**
   * What `pets-host status` and doctor show: { enabled, listening, address, port, url, whois, standIn, problem,
   * sessions }. `whois` says whether callers are checked by login. Never the pairing code.
   */
  state() {
    const { enabled, address, port, whois, standIn, problem } = this.current;
    return { enabled, listening: this.listening, address: this.listening ? address : "", port, url: this.listening ? `http://${address}:${port}` : "",
      whois, standIn, problem, sessions: this.pairing.sessionCount() };
  }

  /** Apply the saved choice: at startup, and after every change. One change at a time. */
  apply() {
    clearTimeout(this.retry);
    this.changing = this.changing.then(() => this.reconcile(), () => this.reconcile());
    return this.changing.then(() => {
      // At sign-in the viewer can start before Tailscale has its address, so a listener that should be open is tried again.
      if (this.current.enabled && !this.listening && !this.display && !this.closed) {
        this.retry = setTimeout(() => this.apply().catch(() => {}), this.retryMs);
        this.retry.unref?.();
      }
      this.lookLater();
      return this.state();
    });
  }

  async reconcile() {
    const setting = this.setting();
    const off = (problem = "") => ({ enabled: setting.enabled, address: "", port: this.port, whois: false, standIn: false, problem });
    // A viewer that is stopping opens nothing again, whatever was still waiting to be applied.
    if (this.closed) return this.closeListener();
    if (!setting.enabled || this.display) {
      await this.closeListener();
      // Off signs every paired computer out, whoever turned it off. So does a file that stayed unreadable past its time.
      if (!setting.enabled) this.pairing.endSessions();
      this.current = off(setting.enabled ? PROBLEM.display : setting.torn ? PROBLEM.torn : "");
      return;
    }
    const network = await this.network();
    const problem = networkProblem(network) || (network.address !== setting.address ? PROBLEM.moved : "");
    const wanted = { enabled: true, address: network.address, port: network.port, whois: !network.standIn, standIn: network.standIn, problem };
    if (!problem && this.listening && this.current.address === wanted.address && this.current.port === wanted.port) return;
    await this.closeListener();
    this.current = problem ? off(problem) : wanted;
    if (problem) return;
    // The pairing code is what a caller needs, and this switch is what opens the listener. One that an older
    // version or another program left with its folder's permissions is made private before anything listens.
    const exposed = this.exposedFile();
    if (exposed) {
      this.current = off(`${exposed} could not be made private to your account on this computer, so the shared game is not listening.`);
      return;
    }
    const handler = sharedHandler({ network, pairing: this.pairing, ...this.routes });
    const server = this.serve((request, response) => {
      // The switch is read again for every request. Once it is off, this request is refused and the listener closes behind it.
      if (!this.stillWanted()) {
        response.once("finish", () => this.apply().catch(() => {}));
        return this.routes.json(response, 403, { error: REFUSED.off });
      }
      return handler(request, response).catch(() => (response.headersSent ? response.destroy()
        : this.routes.json(response, 500, { error: errorText({ local: false, status: 500 }) })));
    });
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(wanted.port, wanted.address, () => { server.off("error", reject); resolve(); });
      });
      // Listening anywhere but the one address asked for would open the game to another network.
      if (server.address().address !== wanted.address) throw new Error("the listener is not on that address");
    } catch (error) {
      server.close();
      this.current = off(`Could not listen on ${wanted.address}: ${error.code || error.message}`);
      return;
    }
    server.on("error", (error) => this.log.error?.(`Shared game listener: ${error.message}`));
    this.server = server;
    this.listening = true;
    // Tailscale can give this computer another address while it runs, so the address is asked for again, the same way.
    this.recheck = setInterval(() => this.checkAddress(), this.recheckMs);
    this.recheck.unref?.();
    this.log.log?.(`Shared game: http://${wanted.address}:${wanted.port}`);
  }

  /** Apply the choice again, which asks Tailscale for this computer's address. A listener that closes over it says why in the log. */
  checkAddress() {
    this.apply().then((state) => { if (!state.listening && state.problem) this.log.error?.(`Shared game: ${state.problem}`); }, () => {});
  }

  async closeListener() {
    clearInterval(this.recheck);
    this.recheck = null;
    const server = this.server;
    this.server = null;
    this.listening = false;
    if (!server) return;
    // Displays poll over connections of their own, but end any left open so nothing answers after "off".
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }

  /** Turn the shared game on or off and remember it. Off also signs every paired computer out. */
  async setEnabled(enabled) {
    if (typeof enabled !== "boolean") throw refusal(400, "Say whether the shared game is on.");
    if (!enabled) {
      writeSharedSetting(this.stateDir, { enabled: false });
      return this.apply();
    }
    if (this.display) throw refusal(409, PROBLEM.display);
    const network = await this.network();
    const problem = networkProblem(network);
    if (problem) throw refusal(409, problem);
    saveSharedOn(this.stateDir, network.address);
    return this.apply();
  }

  /** Close the listener for good, as the viewer does when it stops. */
  close() {
    this.closed = true;
    clearTimeout(this.retry);
    clearTimeout(this.watch);
    return this.closeListener();
  }
}

/**
 * Doctor's "shared" group: Tailscale, this computer's address in it, the login check, the host listener, and the
 * display settings. A missing piece is a problem only on a computer that hosts or shows a shared game. `live` is
 * the running viewer's own word on its listener (GET /api/shared), or null when no viewer of this installation
 * answers. A login is never part of a detail.
 */
export async function sharedChecks({ stateDir, port, env = process.env, platform = process.platform, exists, interfaces = networkInterfaces(),
  run = runTailscale, live = null }) {
  const setting = readSharedSetting(stateDir);
  const remote = readRemoteSetting(stateDir, { env });
  const used = setting.enabled || Boolean(remote);
  const checks = [];
  const add = (name, state, detail) => checks.push({ name, state, detail, group: "shared" });

  // Whether a host here could listen: with the stand-in, or with the tailscale program whose word the listener needs.
  let canHost = true;
  if (loopbackStandIn(env)) {
    add("shared-tailscale", "optional", `A loopback stand-in is set (${LOOPBACK_ENV}), so Tailscale is not asked. It is for tests only.`);
  } else {
    const cli = findTailscale({ env, platform, ...(exists ? { exists } : {}) });
    canHost = Boolean(cli);
    let status = { running: false, login: "" };
    if (cli) { try { status = readStatus(await run(cli, ["status", "--json"])); } catch { /* Reported as not connected. */ } }
    const { address } = await tailscaleSelf({ interfaces, cli, run });
    const missing = used ? "missing" : "optional";
    if (!cli) add("shared-tailscale", missing, "The tailscale program was not found. A shared game needs Tailscale on every computer that hosts or shows it.");
    else if (!status.running || !status.login) add("shared-tailscale", used ? "warning" : "optional", `Tailscale is installed (${cli}) but is not connected and signed in. Open Tailscale and sign in.`);
    else add("shared-tailscale", "ok", `Tailscale is connected and signed in (${cli}).`);
    add("shared-address", address ? "ok" : missing, address ? `This computer's Tailscale address is ${address}.`
      : cli ? "The tailscale program names no Tailscale address for this computer right now." : "Only the tailscale program can say which address is this computer's Tailscale address, and it was not found.");
    if (!cli) add("shared-whois", missing, `${NO_TAILSCALE_PROGRAM} A host does not listen without it.`);
    else if (!address || !status.login) add("shared-whois", missing, "The login check cannot be tried until Tailscale is connected and signed in.");
    else if (await createWhois({ cli, run })(address)) add("shared-whois", "ok", "The login check works: tailscale whois names this computer's own account for its own address.");
    else add("shared-whois", "error", "tailscale whois did not name this computer's own account, so a host here would refuse every caller.");
  }

  if (!setting.enabled) add("shared-host", "none", "Off. This computer does not host a shared game.");
  else if (live?.listening) add("shared-host", "ok", `On: other computers join at ${live.address}:${live.port}. ${live.sessions} paired sessions now.`);
  else if (live) add("shared-host", "warning", `On, but not listening. ${live.problem || "The listener is not open yet."}`);
  else if (!canHost) add("shared-host", "error", `On, but it cannot listen. ${NO_TAILSCALE_PROGRAM}`);
  else add("shared-host", "ok", `On for ${setting.address || "this computer"}, port ${loopbackStandIn(env) || port}. The listener runs while Goblin Horde runs.`);

  if (!remote) add("shared-remote", "none", "Not joined. This computer plays its own game.");
  else if (remote.problem) add("shared-remote", "error", remote.problem);
  else add("shared-remote", "ok", `Joined: this computer shows the game on ${remote.name}:${remote.port} and keeps no saved game of its own in use.`);

  if (setting.enabled && remote) {
    add("shared-role", "conflict", "WARNING: THIS COMPUTER IS SET UP AS BOTH A HOST AND A DISPLAY. A computer is one or the other, so the host listener stays closed. "
      + "Run pets-join --off to host, or pets-host disable to stay a display.");
  }
  return checks;
}
