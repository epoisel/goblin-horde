/**
 * Signed updates from Goblin Horde's GitHub releases.
 *
 * A release is two files on the repository's rolling pets-latest pre-release (never the repository's "Latest" release,
 * which belongs to the earlier monitor app): GoblinHorde-Team.zip, as scripts/package.mjs builds it,
 * and update.json, which names the ZIP's version, size and SHA-256 and signs them with an Ed25519 key that only the
 * release author holds. The public half ships in every build (lib/update-key.mjs). GitHub, the network and the ZIP
 * are trusted with nothing: verifyRelease is the one way a release is checked, for every caller, and nothing of a
 * release is written anywhere until every check passed.
 *
 * What it keeps in <state folder>/updates, one fact to a file:
 *   settings.json     { check }: whether the server looks for a release once a day (update --off, --on). On when missing.
 *   state.json        { checkedAt, ok, message }: the last check, by whoever made it.
 *   skip.json         { version, reason, message, at }: a version not to take by itself, after going back from it or
 *                     failing to put it in place.
 *   ready/<version>/  a verified release waiting for the next start: its update.json and ZIP.
 *   installed/        the release installed now, when it came as an update.
 *   previous/         the one installed before it, which update --rollback goes back to.
 *   work/apply-<id>/  one apply, under apply.lock: the release it took, its files, and a copy of the files it replaces.
 * The saved game, the settings, the pairing files and the locks beside this folder are never opened here.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { isAlive } from "./processes.mjs";
import { readZip } from "./zip.mjs";

export const ROLLING_TAG = "pets-latest";
export const MANIFEST_URL = `https://github.com/epoisel/goblin-horde/releases/download/${ROLLING_TAG}/update.json`;
export const ZIP_URL = `https://github.com/epoisel/goblin-horde/releases/download/${ROLLING_TAG}/GoblinHorde-Team.zip`;
export const MANIFEST_NAME = "update.json";
export const ZIP_NAME = "GoblinHorde-Team.zip";
export const MANIFEST_LIMIT = 16 * 1024;
export const ZIP_LIMIT = 25 * 1024 * 1024;
export const UNPACKED_LIMIT = 60 * 1024 * 1024;
export const FILE_LIMIT = 200;
export const REDIRECT_LIMIT = 5;
export const REQUEST_MS = 30_000;
export const NO_KEY = "This build has no update key, so it cannot check for updates.";
// In the state folder's run/: what the manager that the desktop goblins' Update row starts says, since nobody watches it.
export const UPDATE_LOG = "update.log";
const TOP = "GoblinHorde/";
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const GITHUB = ["github.com", "githubusercontent.com"];
const LOCK_STALE_MS = 10 * 60_000;
const LOCK_WRITE_MS = 5000;

/** Why a release was not taken, in a sentence for the person. */
class Refusal extends Error {}
const refuse = (message) => { throw new Refusal(message); };

const VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;
/** Whether `text` is a plain x.y.z version. */
export const isVersion = (text) => typeof text === "string" && VERSION.test(text);

/** -1, 0 or 1 as version `a` is older than, the same as, or newer than version `b`. */
export function compareVersions(a, b) {
  const [left, right] = [a, b].map((text) => text.split(".").map(Number));
  for (let part = 0; part < 3; part++) if (left[part] !== right[part]) return left[part] < right[part] ? -1 : 1;
  return 0;
}

/** The exact text a release's signature covers. */
export const signedText = ({ version, size, sha256 }) => `goblin-horde-update\nformat=1\nversion=${version}\nsize=${size}\nsha256=${sha256}\n`;

export const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Check 1: the build's key, as Node's key object. */
function keyObject(key) {
  if (typeof key !== "string" || key === "") refuse(NO_KEY);
  let object = null;
  try { object = createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" }); } catch { /* Said below. */ }
  if (object?.asymmetricKeyType !== "ed25519") refuse("This build's update key cannot be read, so it cannot check for updates.");
  return object;
}

/** Check 2: update.json in the form of a release. Nothing it says is believed until check 3. */
function readManifest(bytes) {
  let data = null;
  try { data = JSON.parse(bytes.toString("utf8")); } catch { refuse("update.json is not JSON, so the update was refused."); }
  const wrong = (what) => refuse(`update.json is not a Goblin Horde update (${what}), so the update was refused.`);
  if (data === null || typeof data !== "object" || Array.isArray(data)) wrong("it is not an object");
  if (data.format !== 1) wrong("its format is not 1");
  if (!isVersion(data.version)) wrong("its version is not a plain x.y.z version");
  if (data.zip !== ZIP_NAME) wrong(`its package is not ${ZIP_NAME}`);
  if (!Number.isSafeInteger(data.size) || data.size < 1 || data.size > ZIP_LIMIT) wrong("its size is not a whole number of bytes up to 25 MB");
  if (typeof data.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(data.sha256)) wrong("its SHA-256 is not 64 lowercase hexadecimal digits");
  if (typeof data.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(data.signature)) wrong("its signature is not 64 bytes of base64");
  return { version: data.version, size: data.size, sha256: data.sha256, signature: Buffer.from(data.signature, "base64") };
}

/** Check 4: whether `rule` takes `version`; a refusal otherwise, which says when the build is simply up to date. */
function ruleRefusal(version, { newerThan, olderThan } = {}) {
  if (newerThan === undefined && olderThan === undefined) return { current: false, message: "No version was asked for, so the update was refused." };
  if (newerThan !== undefined && compareVersions(version, newerThan) <= 0)
    return { current: true, message: `The newest release, ${version}, is not newer than ${newerThan}.` };
  if (olderThan !== undefined && compareVersions(version, olderThan) >= 0)
    return { current: false, message: `The kept release ${version} is not older than ${olderThan}, so it is not a way back.` };
  return null;
}

// What an entry name may not be or hold, in the order the reason is told. Each is a way to write outside the
// package's folder or to two names Windows takes for one file.
const DEVICE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)(?:\..*)?$/i;
const NAME_RULES = [
  ["has a NUL, another control character, or a character outside plain ASCII", (name) => /[^ -~]/.test(name)],
  ["has a backslash", (name) => name.includes("\\")],
  ["is absolute", (name) => name.startsWith("/")],
  ["has a drive letter or another colon", (name) => name.includes(":")],
  ["climbs out of its folder with ..", (name) => name.split("/").includes("..")],
  ["is not inside the GoblinHorde folder", (name) => !name.startsWith(TOP) || name === TOP],
  ["has an empty part, a . part, or a part that ends in a dot or a space", (name) => name.split("/").some((part) => part === "" || /[. ]$/.test(part))],
  ["is a Windows device name", (name) => name.split("/").some((part) => DEVICE.test(part))],
];

/**
 * Check 6, after the ZIP was read: its entries as the package's files [{ path, data }], with `path` relative to the
 * package folder. Every name is safe and given once, every file is one the package's own package-files.json lists
 * and every file it lists is there, and its package.json carries the signed version.
 */
function packageFiles(entries, version) {
  const files = new Map();
  const folded = new Set();
  for (const { name, data } of entries) {
    const unsafe = NAME_RULES.find(([, breaks]) => breaks(name));
    if (unsafe) refuse(`The update package was refused: the entry ${JSON.stringify(name)} ${unsafe[0]}.`);
    if (folded.has(name.toLowerCase())) refuse(`The update package was refused: the entry ${JSON.stringify(name)} is in it twice.`);
    folded.add(name.toLowerCase());
    files.set(name.slice(TOP.length), data);
  }
  let listed = null;
  try { listed = JSON.parse(files.get("package-files.json")?.toString("utf8")); } catch { /* Said below. */ }
  if (!Array.isArray(listed) || !listed.every((file) => typeof file === "string")) refuse("The update package was refused: its package-files.json is not a list of files.");
  const list = new Set(listed);
  const unlisted = [...files.keys()].find((file) => !list.has(file));
  if (unlisted) refuse(`The update package was refused: it holds ${unlisted}, which its package-files.json does not list.`);
  const missing = listed.find((file) => !files.has(file));
  if (missing) refuse(`The update package was refused: its package-files.json lists ${missing}, which is not in it.`);
  let packaged = "";
  try { packaged = JSON.parse(files.get("package.json").toString("utf8")).version; } catch { /* Said below. */ }
  if (packaged !== version) refuse(`The update package was refused: it says it is version ${packaged || "unknown"}, but its signature says ${version}.`);
  return [...files].map(([path, data]) => ({ path, data }));
}

/**
 * @typedef {{ version: string, size: number, sha256: string, manifest: Buffer, zip: Buffer, files: { path: string, data: Buffer }[] }} Release
 *   A release that passed every check: its two files as they came, and the package's files, unpacked in memory.
 * @typedef {{ manifest: () => Promise<Buffer>, zip: () => Promise<Buffer> }} Sources  Where a release's two files come from.
 * @typedef {{ newerThan?: string, olderThan?: string }} VersionRule  Which versions a caller takes.
 */

/**
 * The one way a release is checked, for the server's daily check, update, start, update --rollback, and the release
 * build checking its own output. Each check runs only once those before it passed:
 *   1. this build has an update key;
 *   2. update.json has the form of a release;
 *   3. its signature verifies with the key, over the signed text;
 *   4. its version is one `rule` takes;
 *   5. the ZIP has exactly the signed size and SHA-256;
 *   6. the ZIP unpacks, in memory, to a safe package that lists exactly its own files, of the signed version.
 * update.json is asked for only after check 1 and the ZIP only after check 4. Never throws.
 * @param {{ key: string, rule: VersionRule } & Sources} options
 * @returns {Promise<{ ok: true, release: Release } | { ok: false, current: boolean, version?: string, message: string }>}
 *   `current` marks a release that passed checks 1 to 3 and is not newer: the build is up to date with it.
 */
export async function verifyRelease({ key, manifest, zip, rule }) {
  try {
    const publicKey = keyObject(key);
    const manifestBytes = await manifest();
    const signed = readManifest(manifestBytes);
    if (!verify(null, Buffer.from(signedText(signed), "utf8"), publicKey, signed.signature))
      refuse("update.json's signature does not match this build's update key, so the update was refused.");
    const outside = ruleRefusal(signed.version, rule);
    if (outside) return { ok: false, ...outside, version: signed.version };
    const zipBytes = await zip();
    if (zipBytes.length !== signed.size) refuse(`The update package is ${zipBytes.length} bytes, not the ${signed.size} its signature names, so it was refused.`);
    if (sha256Of(zipBytes) !== signed.sha256) refuse("The update package's SHA-256 is not the one its signature names, so it was refused.");
    let entries;
    try { entries = readZip(zipBytes, { maxEntries: FILE_LIMIT, maxBytes: UNPACKED_LIMIT }); } catch (error) { refuse(`The update package was refused: ${error.message}`); }
    const files = packageFiles(entries, signed.version);
    return { ok: true, release: { version: signed.version, size: signed.size, sha256: signed.sha256, manifest: manifestBytes, zip: zipBytes, files } };
  } catch (error) {
    return { ok: false, current: false, message: error instanceof Refusal ? error.message : `The update could not be checked (${error.code || error.message}).` };
  }
}

// ---------------------------------------------------------------------------------------------
// Where a release comes from

const onGitHub = (host) => GITHUB.some((domain) => host === domain || host.endsWith(`.${domain}`));
const reachRefusal = (error) => (["TimeoutError", "AbortError"].includes(error?.name)
  ? "GitHub did not answer within 30 seconds, so there was no update check."
  : `GitHub could not be reached (${error?.cause?.code || error?.code || error?.message || "no answer"}), so there was no update check.`);

// A body that is not wanted is let go without waiting, since letting go of one can itself wait on the network.
const letGo = (response) => { response.body?.cancel().catch(() => {}); };

async function readLimited(response, limit, label) {
  const tooLarge = () => { letGo(response); refuse(`${label} is larger than ${limit} bytes, so it was refused.`); };
  if (Number(response.headers.get("content-length")) > limit) tooLarge();
  const reader = response.body?.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    let next;
    try { next = reader ? await reader.read() : { done: true }; } catch (error) { refuse(reachRefusal(error)); }
    if (next.done) return Buffer.concat(chunks);
    size += next.value.length;
    if (size > limit) tooLarge();
    chunks.push(next.value);
  }
}

/**
 * The file at `url` on GitHub, at most `limit` bytes of it. Redirects are followed one by one, at most five, and every
 * address asked, the first and each one a redirect names, must be https on github.com or githubusercontent.com or a
 * name under them. Each request has `timeoutMs`, and it carries one header of its own, the User-Agent.
 * @param {typeof fetch} fetchImpl
 */
export async function download(fetchImpl, url, { limit, userAgent, label, timeoutMs = REQUEST_MS }) {
  let address = url;
  for (let hop = 0; ; hop++) {
    let where = null;
    try { where = new URL(address); } catch { refuse(`An update address could not be read, so ${label} was not asked for.`); }
    if (where.protocol !== "https:") refuse(`${label} was sent to an address that is not https (${where.protocol}), so it was refused.`);
    if (!onGitHub(where.hostname)) refuse(`${label} was sent to ${where.hostname}, which is not GitHub, so it was refused.`);
    const signal = AbortSignal.timeout(timeoutMs);
    let response;
    try { response = await fetchImpl(where.href, { redirect: "manual", headers: { "User-Agent": userAgent }, signal }); } catch (error) { refuse(reachRefusal(error)); }
    if (REDIRECTS.has(response.status)) {
      letGo(response);
      if (hop >= REDIRECT_LIMIT) refuse(`GitHub sent ${label} through more than ${REDIRECT_LIMIT} redirects, so it was refused.`);
      const location = response.headers.get("location");
      try { address = new URL(location, where).href; } catch { address = ""; }
      if (!location || !address) refuse(`GitHub sent ${label} to an address that could not be read, so it was refused.`);
      continue;
    }
    if (response.status !== 200) {
      letGo(response);
      refuse(`GitHub answered ${response.status} for ${label}, so there was no update.`);
    }
    return readLimited(response, limit, label);
  }
}

/** The current pets release on GitHub, asked for with `fetchImpl` as Goblin Horde `version`. */
export function githubSources(fetchImpl, version) {
  const userAgent = `GoblinHorde/${version}`;
  return {
    manifest: () => download(fetchImpl, MANIFEST_URL, { limit: MANIFEST_LIMIT, userAgent, label: "update.json" }),
    zip: () => download(fetchImpl, ZIP_URL, { limit: ZIP_LIMIT, userAgent, label: "The update package" }),
  };
}

function readKept(file, limit, label) {
  if (statSync(file).size > limit) refuse(`${label} is larger than ${limit} bytes, so it was refused.`);
  return readFileSync(file);
}

/** A release kept in a folder of the state folder, read with the same limits as a download. */
export const folderSources = (dir) => ({
  manifest: async () => readKept(join(dir, MANIFEST_NAME), MANIFEST_LIMIT, "update.json"),
  zip: async () => readKept(join(dir, ZIP_NAME), ZIP_LIMIT, "The update package"),
});

// ---------------------------------------------------------------------------------------------
// What is kept in the state folder

/** @param {string} stateDir */
export function updatePaths(stateDir) {
  const root = join(stateDir, "updates");
  return { root, settings: join(root, "settings.json"), state: join(root, "state.json"), skip: join(root, "skip.json"), lock: join(root, "apply.lock"),
    ready: join(root, "ready"), installed: join(root, "installed"), previous: join(root, "previous"), work: join(root, "work") };
}

function writeJsonFile(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(temp, file);
}

function readJsonFile(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

/**
 * Whether the server looks for a release by itself: { check }. On when the file is missing; off when it holds anything
 * but `"check": true`, so a file that cannot be read never turns on a check the person turned off.
 */
export function readSettings(stateDir) {
  const file = updatePaths(stateDir).settings;
  return { check: existsSync(file) ? readJsonFile(file)?.check === true : true };
}

export const writeSettings = (stateDir, { check }) => writeJsonFile(updatePaths(stateDir).settings, { check: check === true });

/** The last check: { checkedAt, ok, message }, or null before the first. */
export function readLastCheck(stateDir) {
  const saved = readJsonFile(updatePaths(stateDir).state);
  return saved && typeof saved.checkedAt === "string" && typeof saved.ok === "boolean" && typeof saved.message === "string"
    ? { checkedAt: saved.checkedAt, ok: saved.ok, message: saved.message } : null;
}

/** A version not to take by itself: { version, reason, message, at }, or null. `reason` is "rollback" or "failed". */
export function readSkip(stateDir) {
  const saved = readJsonFile(updatePaths(stateDir).skip);
  return saved && isVersion(saved.version) ? { version: saved.version, reason: String(saved.reason || ""), message: String(saved.message || ""), at: String(saved.at || "") } : null;
}

export const writeSkip = (stateDir, skip) => writeJsonFile(updatePaths(stateDir).skip, skip);
export const clearSkip = (stateDir) => rmSync(updatePaths(stateDir).skip, { force: true });

/** What the server and start take by themselves: newer than the installed version and than a version skipped here. */
export function automaticRule(installed, skip) {
  return { newerThan: skip && compareVersions(skip.version, installed) > 0 ? skip.version : installed };
}

/** The versions kept in `dir` as folders named for them, newest first. */
export function keptVersions(dir) {
  let names = [];
  try { names = readdirSync(dir); } catch { /* None kept. */ }
  return names.filter(isVersion).sort((a, b) => compareVersions(b, a));
}

/** The version a kept release's update.json names, unchecked, or "". Only for knowing which folder is which. */
export function keptVersion(dir) {
  const version = readJsonFile(join(dir, MANIFEST_NAME))?.version;
  return isVersion(version) ? version : "";
}

function writeRelease(dir, release) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, MANIFEST_NAME), release.manifest);
  writeFileSync(join(dir, ZIP_NAME), release.zip);
}

/**
 * Keep a verified release in ready/<version> for the next start. It is written in a folder of its own and renamed
 * into place, so nobody finds half of it, and a release of that version already there is kept. Older ones go.
 * @param {Release} release
 */
export function stageRelease(stateDir, release) {
  const { root, ready } = updatePaths(stateDir);
  mkdirSync(ready, { recursive: true });
  // What a check that stopped part way through writing left, once it is surely not being written any more.
  for (const name of readdirSync(root).filter((entry) => entry.startsWith("incoming-"))) {
    try { if (Date.now() - statSync(join(root, name)).mtimeMs > LOCK_STALE_MS) rmSync(join(root, name), { recursive: true, force: true }); } catch { /* Gone. */ }
  }
  const target = join(ready, release.version);
  if (!existsSync(target)) {
    const incoming = mkdtempSync(join(root, "incoming-"));
    try {
      writeRelease(incoming, release);
      renameSync(incoming, target);
    } catch (error) {
      if (!existsSync(target)) throw error;
    } finally { rmSync(incoming, { recursive: true, force: true }); }
  }
  for (const version of keptVersions(ready)) if (compareVersions(version, release.version) < 0) rmSync(join(ready, version), { recursive: true, force: true });
}

/**
 * Look for the current pets release, keep it in ready/ when it is one `rule` takes, and remember how the check went in
 * state.json, which is all a check that failed leaves behind. Returns verifyRelease's verdict.
 * @param {{ key: string, sources: Sources, rule: VersionRule, now?: () => number }} options
 */
export async function checkForUpdate(stateDir, { key, sources, rule, now = Date.now }) {
  let verdict = await verifyRelease({ key, ...sources, rule });
  if (verdict.ok) {
    try { stageRelease(stateDir, verdict.release); } catch (error) {
      verdict = { ok: false, current: false, message: `Goblin Horde ${verdict.release.version} passed every check but could not be kept in the state folder (${error.code || error.message}).` };
    }
  }
  const message = verdict.ok ? `Goblin Horde ${verdict.release.version} is downloaded and checked, and is put in place at the next start.`
    : verdict.current ? `Up to date. The newest release is ${verdict.version}.` : verdict.message;
  writeJsonFile(updatePaths(stateDir).state, { checkedAt: new Date(now()).toISOString(), ok: verdict.ok || verdict.current, message });
  return verdict;
}

/**
 * The newest release in ready/ that verifies again from its own bytes under `rule`, as { dir, release }, or null.
 * Reads only, so status and doctor can ask.
 */
export async function findStaged(stateDir, { key, rule }) {
  const { ready } = updatePaths(stateDir);
  for (const version of keptVersions(ready)) {
    const verdict = await verifyRelease({ key, ...folderSources(join(ready, version)), rule });
    if (verdict.ok && verdict.release.version === version) return { dir: join(ready, version), release: verdict.release };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Putting a release in place: what the manager keeps while it does

/**
 * The lock that lets one apply run at a time, or null while another holds it. A lock whose process is gone, or that
 * is older than ten minutes, is taken over. `release` gives it up only while it is still this one.
 */
export function takeApplyLock(stateDir, { pid = process.pid, now = Date.now, alive = isAlive } = {}) {
  const { root, lock } = updatePaths(stateDir);
  mkdirSync(root, { recursive: true });
  const mine = JSON.stringify({ pid, at: now() });
  for (let tries = 0; tries < 2; tries++) {
    try {
      writeFileSync(lock, mine, { flag: "wx" });
      return { release: () => { try { if (readFileSync(lock, "utf8") === mine) rmSync(lock, { force: true }); } catch { /* Already gone. */ } } };
    } catch (error) { if (error.code !== "EEXIST") throw error; }
    const holder = readJsonFile(lock);
    let age = Infinity;
    try { age = now() - statSync(lock).mtimeMs; } catch { continue; }
    const held = holder ? Number.isInteger(holder.pid) && alive(holder.pid) && now() - holder.at < LOCK_STALE_MS : age < LOCK_WRITE_MS;
    if (held) return null;
    rmSync(lock, { force: true });
  }
  return null;
}

/**
 * The folders of one apply: `release` holds the release it took, `package` its unpacked files, `backup` a copy of the
 * files installed before, which is renamed into place only when whole, and `restoring` is there while that copy is
 * being put back.
 */
export function workAt(dir) {
  return { dir, release: join(dir, "release"), package: join(dir, "package"), backup: join(dir, "backup"), restoring: join(dir, "restoring") };
}

export function newWork(stateDir) {
  const { work } = updatePaths(stateDir);
  mkdirSync(work, { recursive: true });
  return workAt(mkdtempSync(join(work, "apply-")));
}

/** The applies a manager that stopped part way left behind, oldest first. Only call it while holding the apply lock. */
export function leftoverWork(stateDir) {
  const { work } = updatePaths(stateDir);
  let names = [];
  try { names = readdirSync(work); } catch { /* None. */ }
  return names.filter((name) => name.startsWith("apply-")).map((name) => workAt(join(work, name)));
}

/** Move the kept release at `from` into the apply's own folder, so no other start or check can use it meanwhile. */
export function claimRelease(from, work) {
  try { renameSync(from, work.release); return true; } catch { return false; }
}

/** Write a verified release's files under `work.package`, and answer the package folder they make. */
export function unpackRelease(release, work) {
  const root = join(work.package, "GoblinHorde");
  for (const { path, data } of release.files) {
    const target = join(root, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data, { flag: "wx" });
  }
  return root;
}

/**
 * Copy the files installed in `installDir`, as its marker lists them, to `work.backup`, which then is a package of the
 * installed version that its own install can put back. Throws, leaving no backup, when any file cannot be copied.
 */
export function keepInstalledFiles(installDir, files, work) {
  if (!Array.isArray(files) || !files.includes("package-files.json")) throw new Error("the installation does not list its files");
  const partial = `${work.backup}.partial`;
  for (const file of files) {
    if (typeof file !== "string" || isAbsolute(file) || file.split(/[\\/]/).some((part) => part === ".." || part === "")) throw new Error(`the installation lists ${file}`);
    const target = join(partial, ...file.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(installDir, ...file.split("/")), target);
  }
  renameSync(partial, work.backup);
}

/**
 * After an update went in: the release installed until now becomes previous/ when it is the one that was installed,
 * and the new one becomes installed/. Releases waiting in ready/ that are not newer go.
 */
export function recordUpdate(stateDir, work, { from, to }) {
  const { installed, previous, ready } = updatePaths(stateDir);
  rmSync(previous, { recursive: true, force: true });
  if (keptVersion(installed) === from) renameSync(installed, previous);
  else rmSync(installed, { recursive: true, force: true });
  renameSync(work.release, installed);
  for (const version of keptVersions(ready)) if (compareVersions(version, to) <= 0) rmSync(join(ready, version), { recursive: true, force: true });
  writeJsonFile(updatePaths(stateDir).state, { checkedAt: new Date().toISOString(), ok: true, message: `Goblin Horde ${to} is installed.` });
}

/** After going back: the release gone back to is installed/, and the one gone back from is not kept. */
export function recordRollback(stateDir, work) {
  const { installed } = updatePaths(stateDir);
  rmSync(installed, { recursive: true, force: true });
  renameSync(work.release, installed);
}

/** Put a release an apply took but did not use back where it was kept, unless another took its place meanwhile. */
export function giveBack(stateDir, work, { kind, version }) {
  const { ready, previous } = updatePaths(stateDir);
  const home = kind === "rollback" ? previous : join(ready, version);
  if (existsSync(work.release) && !existsSync(home)) {
    mkdirSync(dirname(home), { recursive: true });
    renameSync(work.release, home);
  }
  rmSync(work.dir, { recursive: true, force: true });
}

/**
 * Clear away what updating kept: downloaded releases, the last check, a skipped version, and applies left part way.
 * Whether the server looks for releases is a setting, and goes only with `settings`.
 */
export function removeUpdates(stateDir, { settings = false } = {}) {
  const paths = updatePaths(stateDir);
  for (const path of [paths.ready, paths.installed, paths.previous, paths.work, paths.state, paths.skip, paths.lock, ...(settings ? [paths.settings] : [])])
    rmSync(path, { recursive: true, force: true });
  let names = [];
  try { names = readdirSync(paths.root); } catch { return; }
  for (const name of names) if (name.startsWith("incoming-")) rmSync(join(paths.root, name), { recursive: true, force: true });
  try { rmdirSync(paths.root); } catch { /* The setting is kept, or something else is there. */ }
}
