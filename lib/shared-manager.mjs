/**
 * The manager's commands for a shared pet game: `pets-host` (this computer runs the game for the others),
 * `pets-join` (this computer shows another computer's game), and `pets-adopt` (start a host from a saved game
 * brought over from another computer).
 *
 * A computer is a host or a display, never both, so each refuses while the other is set up. The pairing code is
 * read from a file or standard input, never from the command line, and is printed only by `pets-host code`, to a
 * terminal a person is looking at.
 */
import { constants, copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { answerJson, askLocal } from "./local-viewer.mjs";
import { PAIRING_CODE } from "./pairing.mjs";
import { DEFAULT_PORT, samePath } from "./paths.mjs";
import { ManagerError, getLocalJson, locate, managerCommand, portOwner, readRun } from "./manager.mjs";
import { createPetsLock, lockHolder } from "./pets-lock.mjs";
import { checkHost, parseHost, readRemoteSetting, removeRemoteSetting, writeRemoteSetting } from "./pets-remote.mjs";
import { createPetsStore, parseRecord } from "./pets-store.mjs";
import { CODE_FILE, loadPairingCode } from "./phone.mjs";
import { loadConfig } from "./rewards.mjs";
import { readSaveFile } from "./save-file.mjs";
import { NO_TAILSCALE_PROGRAM, readSharedSetting, saveSharedOn, sharedNetwork, writeSharedSetting } from "./shared.mjs";
import { initialWatermark } from "./t3-source.mjs";
import { findTailscale, loopbackStandIn } from "./tailscale.mjs";

const SAVE = "pets.json";
const SAVE_LIMIT = 1_000_000;
const ONE_ROLE = "A computer is a host or a display, not both.";
const TOO_OLD = "The Goblin Horde that is running is older than this manager and has no shared game. Install this version over it, then try again.";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const tailscaleOf = (ctx) => findTailscale({ env: ctx.env, platform: ctx.platform, exists: ctx.exists });
/** The game config that ships beside this manager, which says what a saved game may hold, or null when it cannot be read. */
function gameConfig() {
  try { return loadConfig(fileURLToPath(new URL("../game_config.json", import.meta.url))); } catch { return null; }
}
const runs = async (ctx, loc) => (await portOwner(loc.port, loc.installDir, ctx.platform)).state === "ours";
const startHint = (ctx, loc, running) => {
  const manager = managerCommand(ctx, loc.installDir);
  return running ? `Goblin Horde is running, so restart it for this to take effect: ${manager} stop, then ${manager} start --surface pets`
    : `Start Goblin Horde to see it: ${manager} start --surface pets`;
};

/** Run `save`, which writes a file only this account may read. When the file cannot be made private, say so as the manager's own refusal. */
function keptPrivate(save) {
  try { return save(); } catch (error) {
    throw error?.name === "PrivateFileError" ? new ManagerError(`${error.message} Nothing was changed.`) : error;
  }
}

/**
 * Turn the running viewer's shared listener on or off; its answer is the listener's state, without the code. The
 * viewer has `ctx.viewerWaitMs` for its whole answer, which is long enough to ask Tailscale for its address.
 */
async function askViewer(ctx, port, enabled) {
  const answer = await askLocal(port, "/api/shared", { method: "POST", body: { enabled }, timeoutMs: ctx.viewerWaitMs ?? 20_000 });
  if (!answer.status) throw new ManagerError("Goblin Horde is running but did not answer. Try again in a moment.");
  if (answer.status === 404 || answer.status === 405) throw new ManagerError(TOO_OLD);
  const data = answerJson(answer);
  if (answer.status !== 200 || !isObject(data?.shared)) throw new ManagerError(String(data?.error || "Goblin Horde did not take that."));
  return data.shared;
}

/**
 * A viewer's answer to "turn the shared game off", or a refusal. Only an answer that says all three things is
 * taken: the shared game is off, nothing listens, and nobody is signed in. One that leaves any of them out says
 * nothing about it, so it confirms nothing.
 */
function confirmedOff(port, state) {
  if (state.enabled === false && state.listening === false && state.sessions === 0) return state;
  const open = state.enabled === true || state.listening === true || state.sessions > 0;
  throw new ManagerError(`The Goblin Horde on port ${port} answered, but ${open ? "its shared listener is not closed"
    : "did not say that its shared listener is closed and that nobody is signed in to it"}. Stop Goblin Horde to close it, then check with pets-host status.`);
}

/** What the viewer on `port` says of its shared listener, when it is a viewer of this state folder, or null. */
async function viewerOf(ctx, loc, port) {
  const answer = await getLocalJson(port, "/api/shared");
  return answer?.shared && typeof answer.stateDir === "string" && samePath(answer.stateDir, loc.stateDir, ctx.platform) ? answer.shared : null;
}

/** Whether the viewer a lock names answers as that very process. Then the lock is held, and there is nothing to watch for. */
const viewerAnswers = async (holder) => Boolean(holder?.port) && (await getLocalJson(holder.port, "/api/health"))?.pid === holder.pid;

/**
 * Who holds the saved game in this state folder, for certain, or null. A holder whose viewer answers as itself
 * holds it. Any other holder whose process id is alive is watched on this command's own clock: it holds the game
 * once its heartbeat is seen, and holds nothing once it has shown none for 20 seconds. That is the longest this
 * takes, and only for a lock that somebody left behind.
 * @returns {Promise<import("./pets-lock.mjs").Holder | null>}
 */
async function sureHolder(ctx, loc) {
  const holder = await lockHolder(loc.stateDir, ctx.lockTiming);
  if (!holder || await viewerAnswers(holder)) return holder;
  // Its process and its port were asked a moment ago, so from here only its heartbeat is watched.
  return lockHolder(loc.stateDir, { ...ctx.lockTiming, wait: true, confirm: async () => true });
}

/**
 * The running viewers of this state folder, wherever they run. Three things name one: pets.lock, which the viewer
 * that holds the saved game writes with its port, what the last start recorded, and the port this manager was
 * told. `ports` are those that answered for this folder, the lock's first. `holder` is who holds the saved game,
 * and `silent` is that holder when it names a viewer that did not answer.
 * @returns {Promise<{ ports: number[], holder: import("./pets-lock.mjs").Holder | null, silent: import("./pets-lock.mjs").Holder | null }>}
 */
async function liveViewers(ctx, loc) {
  const holder = await sureHolder(ctx, loc);
  const named = [holder?.port, readRun(loc.stateDir)?.port, loc.port].filter((port) => Number.isInteger(port) && port > 0);
  const ports = [];
  for (const port of new Set(named)) if (await viewerOf(ctx, loc, port)) ports.push(port);
  return { ports, holder, silent: holder?.port && !ports.includes(holder.port) ? holder : null };
}

/**
 * The saved game in `stateDir` as counts: null when there is none, `{ coins, horde, bosses }`, or `{}` for a
 * pets.json that is not a saved game. The file is only read.
 */
function savedGame(stateDir) {
  let text;
  try { text = readFileSync(join(stateDir, SAVE), "utf8"); } catch { return null; }
  const state = parseRecord(text, gameConfig() ?? undefined)?.state;
  return state ? { coins: state.wallet.coins, horde: state.horde.size, bosses: state.bosses.cleared } : {};
}

const some = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
/** A saved game's counts in words: "500 coins, 6 goblins, and 1 boss cleared". Counts are all that is ever printed of one. */
const counts = ({ coins, horde, bosses }) => `${some(coins, "coin")}, ${some(horde, "goblin")}, and ${some(bosses, "boss", "bosses")} cleared`;

/** `holder`, who holds the saved game, when it is not this installation's own running viewer, or null. */
async function otherHolder(loc, running, holder) {
  if (!holder) return null;
  const own = running ? (await getLocalJson(loc.port, "/api/health"))?.pid : 0;
  return holder.pid === own ? null : holder;
}

/** What `pets-host` prints: the listener, how to join it, the login check, the paired sessions, and the saved game. */
function hostLines(ctx, loc, host) {
  const where = `${host.address}:${host.port}`;
  const { save, heldBy } = host;
  const lines = [];
  if (!host.enabled) lines.push("Shared game host: off. This computer does not share its game.");
  else if (host.listening) lines.push(`Shared game host: on, listening at ${where}.`);
  else if (host.problem) lines.push(`Shared game host: on, but not listening. ${host.problem}`);
  else lines.push(`Shared game host: on for ${where}. Nothing listens until Goblin Horde runs: ${managerCommand(ctx, loc.installDir)} start --surface pets`);
  // A host with neither the stand-in nor the login check cannot listen, so it has no address to join at.
  if (host.enabled && (host.standIn || host.whois)) {
    if (host.address) lines.push(`Another computer joins with: node goblin.mjs pets-join --host ${where} --code-file <a file that holds the pairing code>`);
    lines.push(host.standIn ? "Login check: off. This is the loopback stand-in for tests, which answers this computer only."
      : "Login check: on. A caller must be signed in to the same Tailscale account as this computer.");
    lines.push(`Paired sessions: ${host.sessions}.`);
    lines.push("The pairing code is not printed here. To read it, run pets-host code in a terminal yourself.");
  }
  lines.push(!save ? "Saved game: none yet. A new game starts when Goblin Horde first runs here, or bring one over with pets-adopt."
    : save.coins === undefined ? "Saved game: pets.json is here, but it is not a saved game Goblin Horde can read."
      : `Saved game: yes, with ${counts(save)}.`);
  if (heldBy) lines.push(`Another Goblin Horde on this computer holds the saved game (process ${heldBy.pid}${heldBy.port ? `, port ${heldBy.port}` : ""}). `
    + "Only one may run a game, so stop the other one before you go on.");
  return lines;
}

/**
 * `pets-host enable | disable | status`. A viewer that runs on this state folder is asked to open or close its
 * listener at once, and "signed out" is said only when that viewer says its listener is closed and its sessions
 * are ended. With no viewer running, the choice is saved and the next start applies it. While a viewer holds the
 * saved game and does not answer, nothing is changed.
 */
export async function petsHost(ctx, flags = {}, action = "status") {
  const loc = locate(ctx, flags);
  const { ports, holder, silent } = await liveViewers(ctx, loc);
  const live = ports.length > 0;
  const standIn = loopbackStandIn(ctx.env);
  const offline = () => {
    const setting = readSharedSetting(loc.stateDir);
    // A host listens only with the tailscale program's word on its address and on who is calling.
    const whois = !standIn && Boolean(tailscaleOf(ctx));
    return { ...setting, listening: false, port: standIn || loc.port, whois, standIn: standIn > 0, problem: setting.enabled && !standIn && !whois ? NO_TAILSCALE_PROGRAM : "", sessions: 0 };
  };
  // A change is made through the viewer that runs on this folder. While one holds the folder and is silent, nothing is
  // changed. Nor is it while this installation's own viewer runs and has no shared game to ask: it would never read the choice.
  const holderMustAnswer = async () => {
    if (silent) throw new ManagerError(`A Goblin Horde on this computer (process ${silent.pid}, port ${silent.port}) holds the saved game here and did not answer, so nothing was changed. `
      + `Try again in a moment, or stop it first: ${managerCommand(ctx, loc.installDir)} stop`);
    if (!live && await runs(ctx, loc) && !(await getLocalJson(loc.port, "/api/shared"))) throw new ManagerError(TOO_OLD);
  };
  let state;
  let ending = [];
  if (action === "enable") {
    if (readRemoteSetting(loc.stateDir, { env: ctx.env })) throw new ManagerError(`This computer shows another computer's shared game. ${ONE_ROLE} Run pets-join --off first.`);
    await holderMustAnswer();
    if (live) state = await askViewer(ctx, ports[0], true);
    else {
      const network = await sharedNetwork({ port: loc.port, env: ctx.env, platform: ctx.platform, cli: tailscaleOf(ctx), run: ctx.runTailscale, interfaces: ctx.interfaces?.() });
      if (network.problem === NO_TAILSCALE_PROGRAM) throw new ManagerError(`${NO_TAILSCALE_PROGRAM} Install Tailscale on this computer, sign in, and try again.`);
      if (network.problem || !network.address) throw new ManagerError("Tailscale is not connected on this computer, so there is no address to share the game on. Open Tailscale, sign in, and try again.");
      keptPrivate(() => saveSharedOn(loc.stateDir, network.address));
      state = offline();
    }
  } else if (action === "disable") {
    await holderMustAnswer();
    if (live) {
      // Every viewer on this folder is told, and each must say its listener is closed and nobody is signed in to it.
      for (const port of ports) state = confirmedOff(port, await askViewer(ctx, port, false));
      ending = ["Every computer that had joined is signed out."];
    } else {
      writeSharedSetting(loc.stateDir, { enabled: false });
      state = offline();
      ending = ["No Goblin Horde runs on this state folder now, so nothing was listening."];
    }
  } else if (action === "status") {
    state = (live && await viewerOf(ctx, loc, ports[0])) || offline();
  } else throw new ManagerError("Use: node goblin.mjs pets-host enable | disable | status | code");
  // A listener that is closed still has an address to join at, the saved one.
  const host = { ...state, address: state.address || readSharedSetting(loc.stateDir).address, running: live, save: savedGame(loc.stateDir),
    heldBy: await otherHolder(loc, await runs(ctx, loc), holder) };
  return { ...host, messages: [...hostLines(ctx, loc, host), ...ending] };
}

/**
 * `pets-host code`: write the pairing code to the terminal. Refused when the output is not a terminal on this
 * computer, so the code never lands in an agent's transcript, a log, or a remote session by this route.
 */
export function petsHostCode(ctx, flags = {}) {
  const loc = locate(ctx, flags);
  const out = ctx.stdout ?? process.stdout;
  if (!out.isTTY || ctx.env.SSH_CONNECTION || ctx.env.SSH_TTY) {
    throw new ManagerError("The pairing code is shown only in a terminal on this computer with a person at it. "
      + `To read it yourself, open ${join(loc.stateDir, CODE_FILE)} in a text editor.`);
  }
  out.write(`Pairing code: ${keptPrivate(() => loadPairingCode(loc.stateDir, { env: ctx.env }))}\n`);
}

function codeFrom({ codeFile, codeText }) {
  if (Boolean(codeFile) === (codeText !== undefined))
    throw new ManagerError("Give the pairing code in a file with --code-file <path>, or on standard input with --code-stdin. It is never taken from the command line.");
  let text = codeText;
  if (codeFile) {
    // The words name no file: someone may have typed the code where the path belongs.
    try {
      if (statSync(codeFile).size > 1024) throw new Error("too large");
      text = readFileSync(codeFile, "utf8");
    } catch { throw new ManagerError("The file --code-file names could not be read. Nothing was changed."); }
  }
  const code = String(text).toUpperCase().replace(/\s/g, "");
  if (!PAIRING_CODE.test(code)) throw new ManagerError("That is not a Goblin Horde pairing code, which is 8 letters and digits. Nothing was changed.");
  return code;
}

/**
 * `pets-join --host <address[:port]> --code-file <path>` (or `codeText`, read from standard input), and
 * `pets-join --off`. The host is asked for a health check and a pairing before anything is saved, so a join
 * that fails leaves this computer playing its own game.
 */
export async function petsJoin(ctx, flags = {}, { host = "", codeFile = "", codeText, off = false } = {}) {
  const loc = locate(ctx, flags);
  const running = await runs(ctx, loc);
  if (off) {
    const joined = Boolean(readRemoteSetting(loc.stateDir, { env: ctx.env }));
    removeRemoteSetting(loc.stateDir);
    return { joined: false, messages: joined ? ["This computer plays its own game again, from its own saved game.", startHint(ctx, loc, running)]
      : ["This computer was not joined to a shared game."] };
  }
  if (readSharedSetting(loc.stateDir).enabled) throw new ManagerError(`This computer hosts a shared game. ${ONE_ROLE} Run pets-host disable first.`);
  const target = parseHost(host, { defaultPort: DEFAULT_PORT, loopback: loopbackStandIn(ctx.env) > 0 });
  if (!target) throw new ManagerError(`--host must be the host computer's Tailscale address (100.x.y.z) or MagicDNS name, with its port when that is not ${DEFAULT_PORT}. `
    + "Write the address as four plain numbers. A name made only of digits and the letters a to f and x is taken for a number, so give such a computer's full MagicDNS name.");
  const code = codeFrom({ codeFile, codeText });
  const checked = await checkHost({ ...target, code }, { env: ctx.env });
  if (!checked.ok) throw new ManagerError(`${checked.problem} Nothing was changed.`);
  keptPrivate(() => writeRemoteSetting(loc.stateDir, { origin: target.origin, code }));
  return { joined: true, host: `${target.name}:${target.port}`, messages: [
    `Joined. This computer now shows the shared game on ${target.name}, and its own saved game is left as it is.`,
    startHint(ctx, loc, running),
    "The pairing code is saved for Goblin Horde, so the file you gave can be deleted.",
  ] };
}

// A moment as 20261111T171300123Z, to the millisecond.
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:.]/g, "");
// Why a file was not adopted, by the reason lib/save-file.mjs gives.
const NOT_ADOPTED = {
  network: "That path is a network share or a device, not a file on this computer's own disk, so it was not opened and nothing was changed. Copy the saved game onto this computer first.",
  link: "That path goes through a link or a folder that stands for another, so it was not read and nothing was changed. Give the path of the saved game file itself.",
  "not-file": "That path is not a file, so nothing was changed.",
  own: "That file is already this computer's own saved game.",
  unreadable: "That saved game could not be read, so nothing was changed.",
};

/**
 * `pets-adopt <path-to-pets.json> [--replace]`: make a saved game from another computer this computer's own.
 * Only the format's numbers are taken from the file. The T3 Code watermark, the last-seen time, and the saved
 * game's cutoff (notBefore) are all set to now, so work that finished here up to this moment is never paid and
 * no coins are added for time away.
 * @returns {Promise<{ coins: number, horde: number, bosses: number, kept: string, messages: string[] }>}
 */
export async function petsAdopt(ctx, flags = {}, { path = "", replace = false } = {}) {
  const loc = locate(ctx, flags);
  if (!path) throw new ManagerError("Say which saved game to adopt: node goblin.mjs pets-adopt <path to pets.json>");
  if (readRemoteSetting(loc.stateDir, { env: ctx.env }))
    throw new ManagerError("This computer shows another computer's shared game, so its own saved game is not in use. Adopt the save on the host, or run pets-join --off first.");
  const target = join(loc.stateDir, SAVE);
  let text;
  try { text = readSaveFile(path, { limit: SAVE_LIMIT, own: [target, `${target}.bak`] }); } catch (error) {
    throw new ManagerError(NOT_ADOPTED[error?.reason] ?? NOT_ADOPTED.unreadable);
  }
  const config = gameConfig();
  if (!config) throw new ManagerError("game_config.json could not be read beside this manager, so a saved game cannot be checked and nothing was changed. Install Goblin Horde again.");
  const adopted = parseRecord(text, config);
  if (!adopted) throw new ManagerError("That file is not a Goblin Horde saved game, so nothing was changed.");

  const lock = createPetsLock({ dir: loc.stateDir, ...ctx.lockTiming });
  // A holder whose viewer answers as itself is running, and that is said at once. Any other holder the lock watches
  // itself, until it shows a heartbeat or has shown none for long enough to be gone: one look cannot tell the two apart.
  const running = await viewerAnswers(await lockHolder(loc.stateDir, ctx.lockTiming));
  if (running || !(await lock.acquire()).ok)
    throw new ManagerError(`Goblin Horde is running here and holds the saved game. Stop it first: ${managerCommand(ctx, loc.installDir)} stop`);
  try {
    const store = createPetsStore({ dir: loc.stateDir, config });
    // A saved game that survives only as its backup is one too, whether or not it can be read.
    const present = existsSync(target) || existsSync(`${target}.bak`);
    if (present && !replace)
      throw new ManagerError("This computer already has a saved game, and it was kept. To replace it with this one, add --replace, which keeps a copy of the present one first.");
    const now = ctx.now();
    let kept = "";
    if (existsSync(target)) {
      // The name holds the millisecond and a few random letters, and the copy is made only when no file has that
      // name, so a copy of an earlier saved game is never written over.
      kept = `${SAVE}.before-adopt-${stamp(now)}-${ctx.token()}`;
      try { copyFileSync(target, join(loc.stateDir, kept), constants.COPYFILE_EXCL); }
      catch { throw new ManagerError("A copy of the saved game that is here could not be kept, so nothing was changed. Try again."); }
    }
    // The game begins here now. The cutoff is saved with it, so nothing that finished on this computer up to this
    // moment is ever paid, whether T3 Code can be read now or writes the row later. T3 Code is not asked anything.
    await store.save({ ...adopted, sources: { t3: initialWatermark(now) }, lastSeenAt: now, notBefore: now });
    const { wallet, horde, bosses } = adopted.state;
    return { coins: wallet.coins, horde: horde.size, bosses: bosses.cleared, kept, messages: [
      `Adopted the saved game, with ${counts({ coins: wallet.coins, horde: horde.size, bosses: bosses.cleared })}.`,
      "Work that finished in T3 Code on this computer before now is not paid, and no coins were added for the time away.",
      ...(kept ? [`The saved game that was here is kept as ${kept} in ${loc.stateDir}.`] : []),
    ] };
  } finally {
    lock.release();
  }
}
