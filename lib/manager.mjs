/**
 * Install, start, stop, check, and remove Goblin Horde's pet game on Windows.
 *
 * Everything the manager changes is recorded in the installation marker, so uninstall removes
 * exactly what install added: the listed app files, the manager skills it wrote, and its Start menu
 * entry. Settings and the saved game stay unless the person asks for a full reset.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { basename, delimiter, dirname, isAbsolute, join, normalize, resolve, win32 } from "node:path";
import { randomBytes } from "node:crypto";
import { answerJson, askLocal } from "./local-viewer.mjs";
import { BACKUP_SUFFIX, HOOK_RECEIVER, LAST_BACKUP_SUFFIX, claudeSettingsPath, removeOldHooks } from "./old-hooks.mjs";
import { CODE_FILE } from "./pairing.mjs";
import { DEFAULT_PORT, PRODUCT, defaultInstallDir, defaultStateDir, isInside, isUnsafeTarget, resolveLocations, samePath } from "./paths.mjs";
import { LOCK_FILE } from "./pets-lock.mjs";
import { REMOTE_CODE_FILE, REMOTE_FILE } from "./pets-remote.mjs";
import { isAlive, listProcesses, ownedProcesses, sameProcess, stopPid } from "./processes.mjs";
import { SHARED_FILE, sharedChecks } from "./shared.mjs";
import { ownsShortcut, removeShortcut, shortcutPaths, shortcutSpec, writeShortcut } from "./shortcuts.mjs";
import { defaultT3Path, openT3 } from "./t3-source.mjs";
import { runTailscale } from "./tailscale.mjs";
import { UPDATE_KEY } from "./update-key.mjs";
import {
  NO_KEY, UPDATE_LOG, automaticRule, checkForUpdate, claimRelease, clearSkip, compareVersions, findStaged, folderSources, giveBack, githubSources, keepInstalledFiles,
  keptVersion, keptVersions, leftoverWork, newWork, readLastCheck, readSettings, readSkip, recordRollback, recordUpdate, removeUpdates, takeApplyLock,
  unpackRelease, updatePaths, verifyRelease, writeSettings, writeSkip,
} from "./updater.mjs";

export const MARKER = "goblin-horde-install.json";
export const SKILL_MARKER = "goblin-horde-skill.json";
export const SKILL_NAME = "goblin-horde-manager";
export const RUN_FILE = "goblin-horde.json";
const SKILL_SOURCE = "skills/goblin-horde-manager/SKILL.md";

export class ManagerError extends Error {
  constructor(message, { code = "FAILED", exitCode = 1 } = {}) {
    super(message);
    this.name = "ManagerError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

/** What every command but help says on a computer that is not Windows, where it changes nothing. */
export const windowsOnly = (platform) => new ManagerError(`Goblin Horde's pet game runs on Windows only, and this computer runs ${platform}. Nothing was checked or changed.`,
  { code: "UNSUPPORTED" });

/** Shared context; tests replace pieces of it to stay away from this computer's real state. */
export function makeContext(overrides = {}) {
  return {
    platform: process.platform, env: process.env, nodePath: process.execPath, sourceDir: "", log: (line) => console.log(line),
    which: (name) => which(name, { env: overrides.env || process.env }),
    listProcesses, spawn, exists: existsSync, probe: runProbe, writeShortcut, nodeVersion: readNodeVersion, openT3, runTailscale,
    // How update asks GitHub for a release, and the key every release must be signed with.
    fetch: globalThis.fetch, updateKey: UPDATE_KEY,
    // The clock, and a few random letters that keep two files made in one millisecond apart.
    now: () => Date.now(), token: () => randomBytes(3).toString("hex"), ...overrides,
  };
}

/** The version of the Node.js at `nodePath` ("22.13.1"), or "" when it does not answer. */
function readNodeVersion(nodePath) {
  try { return execFileSync(nodePath, ["-p", "process.versions.node"], { encoding: "utf8", timeout: 10_000, windowsHide: true }).trim(); }
  catch { return ""; }
}

/** Run a short check program and return its output, or "" when it fails. */
function runProbe(file, args) {
  try { return execFileSync(file, args, { encoding: "utf8", timeout: 15_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return ""; }
}

/** Find a program on PATH, honouring PATHEXT. */
export function which(name, { env = process.env } = {}) {
  const folders = String(env.PATH || env.Path || "").split(delimiter).filter(Boolean);
  const extensions = ["", ...String(env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean).map((ext) => ext.toLowerCase())];
  for (const folder of folders) {
    for (const ext of extensions) {
      const candidate = join(folder.replace(/^"|"$/g, ""), `${name}${ext}`);
      try { if (statSync(candidate).isFile()) return candidate; } catch { /* Keep looking. */ }
    }
  }
  return "";
}

// ---------------------------------------------------------------------------------------------
// Package manifest and installation marker

/** The explicit file list. Paths must be relative, forward-slash, and stay inside the package. */
export function readManifest(dir) {
  let files;
  try { files = JSON.parse(readFileSync(join(dir, "package-files.json"), "utf8")); }
  catch { throw new ManagerError(`package-files.json is missing or unreadable in ${dir}.`); }
  if (!Array.isArray(files) || !files.length) throw new ManagerError("package-files.json must list the package files.");
  for (const file of files) {
    if (typeof file !== "string" || !file || isAbsolute(file) || file.includes("\\") || file.split("/").some((part) => part === ".." || part === "." || part === ""))
      throw new ManagerError(`Invalid package path: ${file}`);
  }
  return [...new Set(files)];
}

export function checkSource(sourceDir) {
  const files = readManifest(sourceDir);
  for (const file of files) if (!existsSync(join(sourceDir, file))) throw new ManagerError(`Package file is missing: ${file}`);
  return files;
}

export function readMarker(installDir, platform = process.platform) {
  const file = join(installDir, MARKER);
  if (!existsSync(file)) return null;
  let marker;
  try { marker = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")); }
  catch { throw new ManagerError(`The installation marker in ${installDir} is unreadable.`); }
  if (marker?.product !== PRODUCT || typeof marker.installRoot !== "string" || !samePath(marker.installRoot, installDir, platform))
    throw new ManagerError(`The installation marker in ${installDir} belongs to another folder or product.`);
  return marker;
}

function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(temp, file);
}

/** Resolve where things are, letting an existing marker supply the state folder it was installed with. */
export function locate(ctx, flags = {}) {
  const options = { env: ctx.env, platform: ctx.platform, ...(ctx.home ? { home: ctx.home } : {}) };
  const locations = resolveLocations(flags, options);
  const marker = existsSync(join(locations.installDir, MARKER)) ? readMarker(locations.installDir, ctx.platform) : null;
  if (!flags.stateDir && marker?.stateDir && isAbsolute(marker.stateDir)) locations.stateDir = normalize(marker.stateDir);
  const port = Number(flags.port || marker?.port || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new ManagerError("--port must be a number from 1024 to 65535.");
  return { ...locations, port, marker, defaultState: samePath(locations.stateDir, defaultStateDir(options), ctx.platform) };
}

const runFile = (stateDir) => join(stateDir, "run", RUN_FILE);
/** What the last start recorded in the state folder: the server's port and process, or null. */
export function readRun(stateDir) {
  try { return JSON.parse(readFileSync(runFile(stateDir), "utf8")); } catch { return null; }
}

// ---------------------------------------------------------------------------------------------
// Prerequisites

const nodeMajor = (version) => Number(version.split(".")[0]) || 0;

// The pet game reads T3 Code's database with node:sqlite, which needs no flag from Node.js 22.13 on.
const PETS_NODE = [22, 13];

function nodeRunsPets(version) {
  const [major, minor] = version.split(".").map(Number);
  return major > PETS_NODE[0] || (major === PETS_NODE[0] && minor >= PETS_NODE[1]);
}

export const WIDGET_READY = "GOBLIN_HORDE_WIDGET_READY";
export const WIDGET_UNAVAILABLE_EXIT = 3;
const WIDGET_LOG = "widget.log";
const TK_PROBE = "import sys, tkinter; print(sys.executable)";

/**
 * The pythonw.exe that runs the desktop goblins: pythonw on PATH, else the Python Launcher (`py`),
 * which a default python.org install puts on PATH even with "Add python.exe to PATH" unticked.
 * Each candidate imports Tkinter and names its real interpreter; the widget uses the pythonw.exe
 * beside it. `python` on PATH is never run: it can be the Microsoft Store's "install Python" stub,
 * which opens the Store. (The Store installs no pythonw stub, so a pythonw on PATH is a real Python.)
 * "" when there is none.
 */
export function findPythonTk(ctx) {
  const candidates = [];
  const pythonw = ctx.which("pythonw");
  if (pythonw && ctx.exists(win32.join(win32.dirname(pythonw), "python.exe"))) candidates.push([win32.join(win32.dirname(pythonw), "python.exe"), []]);
  const launcher = ctx.which("py");
  if (launcher) candidates.push([launcher, ["-3"]]);
  for (const [program, prefix] of candidates) {
    const lines = String(ctx.probe(program, [...prefix, "-c", TK_PROBE]) || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const executable = lines.at(-1) || "";
    if (!win32.isAbsolute(executable) || !/\.exe$/i.test(executable)) continue; // No Tkinter, or no Python 3.
    const found = win32.join(win32.dirname(executable), "pythonw.exe");
    if (ctx.exists(found)) return found;
  }
  return "";
}

/** What to do when this computer has no Python with Tkinter. */
export const WINDOWS_PYTHON_HINT = "Install Python 3 from python.org (the default options are fine; \"Add python.exe to PATH\" is not needed), then open Goblin Horde again from the Start menu.";

export function probePort(port, host = "127.0.0.1", timeoutMs = 600) {
  return new Promise((resolvePromise) => {
    const socket = connect({ port, host });
    const done = (open) => { socket.destroy(); resolvePromise(open); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * What the server on `port` answers `path` with, or null when it answers anything but a 200 with JSON in it, or
 * has not finished its answer within `timeoutMs`.
 */
export async function getLocalJson(port, path, timeoutMs = 2000) {
  const answer = await askLocal(port, path, { timeoutMs });
  return answer.status === 200 ? answerJson(answer) : null;
}

/** Who holds the port: "free", "ours", "other-goblin", "old-goblin", or "other". */
export async function portOwner(port, installDir, platform = process.platform) {
  if (!(await probePort(port))) return { state: "free" };
  const health = await getLocalJson(port, "/api/health");
  if (health?.product === PRODUCT) {
    if (health.installDir && samePath(health.installDir, installDir, platform)) return { state: "ours", health };
    return { state: "other-goblin", health };
  }
  // Viewers from before /api/health answered /api/config.
  const config = await getLocalJson(port, "/api/config");
  if (config && "defaultThreadId" in config) return { state: "old-goblin" };
  return { state: "other" };
}

function portMessage(port, owner) {
  if (owner.state === "other-goblin") return `Port ${port} is used by another Goblin Horde copy${owner.health?.installDir ? ` (${owner.health.installDir})` : ""}. Stop that copy, or choose another port with --port.`;
  if (owner.state === "old-goblin") return `Port ${port} is used by an older Goblin Horde viewer that this manager did not start. Close it (or stop it with the tool that started it), or choose another port with --port.`;
  return `Port ${port} is already used by another program. Close it, or choose another port with --port.`;
}

// ---------------------------------------------------------------------------------------------
// Doctor and status

/**
 * Whether T3 Code's database is there, opens read-only, and has the tables the pet game reads.
 * GOBLIN_T3_DB names another database, as it does for the server. Only the verdict leaves here.
 */
async function t3Check(ctx) {
  const path = ctx.env.GOBLIN_T3_DB || defaultT3Path(ctx.home);
  if (!ctx.exists(path)) return { state: "missing", detail: `T3 Code's database was not found at ${path}. Open T3 Code once on this computer. Until then the game runs but pays no coins.` };
  const opened = await ctx.openT3(path);
  if (!opened.ok) return { state: opened.reason === "locked" ? "warning" : "error", detail: opened.message };
  opened.db.close();
  return { state: "ok", detail: `T3 Code's database opens read-only and has the tables the game counts work from (${path}).` };
}

/**
 * What the pet game needs: a Node.js with built-in SQLite, T3 Code's database, and the Python that draws the
 * desktop goblins. None of these changes doctor's exit code.
 */
async function petsChecks(ctx, version) {
  const pythonw = findPythonTk(ctx);
  return [
    nodeRunsPets(version) ? { name: "pets-node", state: "ok", detail: `Node.js ${version} has the built-in SQLite that reads T3 Code's database.` }
      : { name: "pets-node", state: "warning", detail: `Node.js ${version} runs the game, but it pays no coins for AI work until Node.js ${PETS_NODE.join(".")} or newer, whose built-in SQLite reads T3 Code's database.` },
    { name: "pets-t3", ...(await t3Check(ctx)) },
    pythonw ? { name: "pets-python", state: "ok", detail: `Python with Tkinter found (${pythonw}): it draws the desktop goblins.` }
      : { name: "pets-python", state: "missing", detail: `Python with Tkinter was not found, and the desktop goblins need it. ${WINDOWS_PYTHON_HINT}` },
  ];
}

export async function doctor(ctx, flags = {}) {
  const loc = locate(ctx, flags);
  const checks = [];
  const add = (name, state, detail, extra = {}) => checks.push({ name, state, detail, ...extra });
  const version = ctx.nodeVersion(ctx.nodePath);
  const major = nodeMajor(version);
  add("node", major >= 20 ? "ok" : "missing", major >= 20 ? `Node.js ${major} at ${ctx.nodePath}` : "Node.js 20 or newer is needed.");
  const owner = await portOwner(loc.port, loc.installDir, ctx.platform);
  add("port", owner.state === "free" ? "ok" : owner.state === "ours" ? "ok" : "conflict",
    owner.state === "free" ? `Port ${loc.port} is free.` : owner.state === "ours" ? `Port ${loc.port} is used by this Goblin Horde.` : portMessage(loc.port, owner));
  add("install", loc.marker ? "ok" : "missing", loc.marker ? `Goblin Horde ${loc.marker.version || "(version unknown)"} is installed at ${loc.installDir}` : `Not installed at ${loc.installDir}`);
  for (const check of await petsChecks(ctx, version)) add(check.name, check.state, check.detail, { group: "pets" });
  // The running server's own word on its shared listener, when it is this installation's.
  const live = owner.state === "ours" ? (await getLocalJson(loc.port, "/api/shared"))?.shared ?? null : null;
  checks.push(...await sharedChecks({ stateDir: loc.stateDir, port: loc.port, env: ctx.env, platform: ctx.platform, exists: ctx.exists,
    run: ctx.runTailscale, interfaces: ctx.interfaces?.(), live }));
  checks.push(...updateChecks(await updateReport(ctx, loc)));
  return { platform: ctx.platform, installDir: loc.installDir, stateDir: loc.stateDir, port: loc.port, checks };
}

/**
 * What status and doctor say about updates: whether this build has a key, whether the server looks once a day, the
 * last check, the version of a verified release waiting for the next start, and a version skipped here. Reads only.
 */
async function updateReport(ctx, loc) {
  const skip = readSkip(loc.stateDir);
  const staged = loc.marker?.version ? await findStaged(loc.stateDir, { key: ctx.updateKey, rule: automaticRule(loc.marker.version, skip) }) : null;
  return { key: Boolean(ctx.updateKey), checking: readSettings(loc.stateDir).check, lastCheck: readLastCheck(loc.stateDir), staged: staged?.release.version || "", skip };
}

const SKIPPED = { rollback: "you went back from it with update --rollback", failed: "putting it in place failed" };
/** Why `skip` is not taken by itself, in words. */
export const skipReason = (skip) => `${SKIPPED[skip.reason] || "it was skipped"}${skip.message ? ` (${skip.message})` : ""}`;

function updateChecks(report) {
  const check = (name, state, detail) => ({ name, state, detail, group: "update" });
  return [
    report.key ? check("update-key", "ok", "This build checks every update against its own signing key.") : check("update-key", "warning", NO_KEY),
    report.checking ? check("update-check", "ok", "The server looks on github.com for a signed release about once a day. update --off turns that off.")
      : check("update-check", "none", "Off: the server does not look for releases. update --on turns it on."),
    report.lastCheck ? check("update-last", report.lastCheck.ok ? "ok" : "warning", `${report.lastCheck.checkedAt}: ${report.lastCheck.message}`)
      : check("update-last", "none", "No update check yet."),
    report.staged ? check("update-ready", "ok", `Goblin Horde ${report.staged} is downloaded and checked, and is put in place at the next start.`)
      : check("update-ready", "none", "No update is waiting."),
    ...(report.skip ? [check("update-skip", "warning", `${report.skip.version} is not put in place by itself, because ${skipReason(report.skip)}. update puts it in place on request.`)] : []),
  ];
}

export async function status(ctx, flags = {}) {
  const loc = locate(ctx, flags);
  const running = owned(ctx, loc);
  // The Start menu entry follows a moved Node here too.
  const notes = loc.marker ? followNode(ctx, loc) : [];
  const server = running.find((item) => item.script === "server.mjs");
  const widget = running.find((item) => item.script === "desktop_widget.py");
  const health = server ? await getLocalJson(loc.port, "/api/health") : null;
  return {
    installed: Boolean(loc.marker), installDir: loc.installDir, stateDir: loc.stateDir, version: loc.marker?.version || "",
    port: loc.port, url: `http://127.0.0.1:${loc.port}`,
    server: server ? { pid: server.pid, healthy: Boolean(health) } : null,
    widget: widget ? { pid: widget.pid } : null,
    update: await updateReport(ctx, loc),
    notes,
  };
}

// ---------------------------------------------------------------------------------------------
// Start and stop

const pause = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** The environment of the server and the widget: this installation's port, state folder, and instance id. */
const childEnv = (ctx, loc, instance) => ({ ...ctx.env, PORT: String(loc.port), GOBLIN_HORDE_STATE_DIR: loc.stateDir, GOBLIN_HORDE_INSTANCE: instance });

async function startServer(ctx, loc, instance) {
  const runDir = join(loc.stateDir, "run");
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const logPath = join(runDir, "server.log");
  const fd = openSync(logPath, "w");
  let exited = null;
  const child = spawn(ctx.nodePath, [join(loc.installDir, "server.mjs")], {
    cwd: loc.installDir, detached: true, stdio: ["ignore", fd, fd], windowsHide: true, env: childEnv(ctx, loc, instance),
  });
  closeSync(fd);
  child.on("exit", (code) => { exited = code ?? 1; });
  child.on("error", () => { exited = 1; });
  child.unref();
  for (let waited = 0; waited < 20_000; waited += 250) {
    await pause(250);
    if (exited !== null) {
      let log = "";
      try { log = readFileSync(logPath, "utf8"); } catch { /* No log. */ }
      if (/PORT_IN_USE/.test(log)) throw new ManagerError(`Port ${loc.port} is already used by another program. Choose another port with --port.`, { code: "PORT_IN_USE", exitCode: 3 });
      const reason = log.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-3).join(" ");
      throw new ManagerError(`The game's server stopped while starting.${reason ? ` ${reason}` : ""} Details: ${logPath}`);
    }
    const health = await getLocalJson(loc.port, "/api/health", 1000);
    if (health?.product === PRODUCT && health.instance === instance) return child.pid;
  }
  throw new ManagerError(`The game's server did not answer within 20 seconds. Details: ${logPath}`);
}

/**
 * Start the desktop goblins (`desktop_widget.py --port <n>`) and wait for the widget to report that its
 * transparent windows are up, so a Python that cannot draw them, or a crash at start, is reported with its
 * reason. pythonw has no console, so the widget's output goes to run/widget.log, where its errors land.
 * Returns { ok, pid, message }.
 */
export async function launchWidget(ctx, loc, python, instance, { waitMs = 15_000 } = {}) {
  const args = [join(loc.installDir, "desktop_widget.py"), "--port", String(loc.port)];
  const options = { cwd: loc.installDir, detached: true, windowsHide: true, env: childEnv(ctx, loc, instance) };
  const runDir = join(loc.stateDir, "run");
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const logPath = join(runDir, WIDGET_LOG);
  const fd = openSync(logPath, "w");
  let exited = null;
  let child;
  try { child = ctx.spawn(python, args, { ...options, stdio: ["ignore", fd, fd] }); }
  catch (error) { return { ok: false, pid: 0, message: `The desktop goblins could not start (${error.message}), so nothing was opened.` }; }
  finally { closeSync(fd); }
  child.on("exit", (code) => { exited = code ?? 1; });
  child.on("error", () => { exited = exited ?? 1; });
  child.unref();
  const readLog = () => { try { return readFileSync(logPath, "utf8"); } catch { return ""; } };
  for (let waited = 0; ; waited += 200) {
    const log = readLog();
    // Exit first: a widget that reported ready and then crashed before this poll is not running.
    if (exited !== null) {
      const reason = log.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && line !== WIDGET_READY).at(-1) || "";
      const why = exited === WIDGET_UNAVAILABLE_EXIT && reason ? reason : `The desktop goblins stopped while starting${reason ? `: ${reason}` : ""}.`;
      return { ok: false, pid: 0, message: `${why} Nothing was opened. Details: ${logPath}` };
    }
    if (log.includes(WIDGET_READY)) return { ok: true, pid: child.pid || 0, message: "The desktop goblins are running." };
    if (waited >= waitMs) return { ok: true, pid: child.pid || 0, message: "The desktop goblins are still starting." };
    await pause(200);
  }
}

/**
 * Start the game's server and the desktop goblins. Safe to repeat: a running copy is reused, and a port held by
 * anything else is reported instead of taken over. When the desktop goblins cannot start, the reason is said,
 * nothing else is opened, and the server keeps running for a shared game.
 *
 * While nothing of this installation runs, a verified update the server kept goes in first (applyKept), and that
 * version is what starts. `noUpdate` skips that: it is the start an update runs once its release is installed.
 */
export async function start(ctx, flags = {}) {
  let loc = locate(ctx, flags);
  if (!loc.marker) throw new ManagerError(`Goblin Horde is not installed at ${loc.installDir}. Run: node goblin.mjs install`, { code: "NOT_INSTALLED" });
  // Listed before a moved Node is recorded, so processes the old Node runs are still recognised.
  const running = owned(ctx, loc);
  const notes = [];
  if (!flags.noUpdate && !running.length) {
    const applied = await applyKept(ctx, loc, flags, { kind: "update", rule: automaticRule(loc.marker.version, readSkip(loc.stateDir)) });
    if (applied.outcome === "started") return applied.started;
    if (applied.outcome === "busy") return { url: `http://127.0.0.1:${loc.port}`, server: null, widget: null, reason: "", messages: [`${applied.messages[0]} It starts Goblin Horde when it is done.`] };
    if (applied.outcome === "broken") throw new ManagerError(applied.messages.join("\n"));
    notes.push(...applied.messages);
    loc = locate(ctx, flags);
  }
  return launch(ctx, loc, running, notes);
}

/** Start the installed version as it is, reusing what of it already runs. */
async function launch(ctx, loc, running, notes = []) {
  const messages = [...notes, ...followNode(ctx, loc), ...removeHooksOf(ctx, loc)];
  let server = running.find((item) => item.script === "server.mjs");
  let instance = readRun(loc.stateDir)?.instance || "";
  if (server) {
    const owner = await portOwner(loc.port, loc.installDir, ctx.platform);
    if (owner.state !== "ours" && owner.state !== "old-goblin") messages.push(`The game's server from this installation is running (process ${server.pid}) but is not answering on port ${loc.port}.`);
    else messages.push(`The game's server is already running at http://127.0.0.1:${loc.port}`);
  } else {
    const owner = await portOwner(loc.port, loc.installDir, ctx.platform);
    if (owner.state !== "free") throw new ManagerError(portMessage(loc.port, owner), { code: "PORT_IN_USE", exitCode: 3 });
    instance = randomBytes(16).toString("hex");
    server = { pid: await startServer(ctx, loc, instance) };
    messages.push(`The game's server is running at http://127.0.0.1:${loc.port}`);
  }

  let widgetPid = running.find((item) => item.script === "desktop_widget.py")?.pid || 0;
  let reason = ""; // Why the desktop goblins are not showing.
  if (widgetPid) messages.push("The desktop goblins are already running.");
  else {
    const python = findPythonTk(ctx);
    const launched = python ? await launchWidget(ctx, loc, python, instance)
      : { ok: false, pid: 0, message: `Python with Tkinter was not found, so the desktop goblins did not start and nothing was opened. ${WINDOWS_PYTHON_HINT}` };
    widgetPid = launched.pid;
    if (!launched.ok) reason = launched.message;
    messages.push(launched.message);
  }
  writeJson(runFile(loc.stateDir), {
    product: PRODUCT, installRoot: loc.installDir, port: loc.port, instance,
    server: { pid: server.pid }, widget: widgetPid ? { pid: widgetPid } : null, startedAt: new Date().toISOString(),
  });
  return { url: `http://127.0.0.1:${loc.port}`, server: server.pid, widget: widgetPid || null, reason, messages };
}

/** Stop only processes whose command line runs this installation's own scripts. */
export async function stop(ctx, flags = {}, loc = locate(ctx, flags)) {
  const running = owned(ctx, loc);
  const run = readRun(loc.stateDir);
  const notes = [];
  for (const recorded of [run?.server?.pid, run?.widget?.pid].filter(Boolean)) {
    if (isAlive(recorded) && !running.some((item) => item.pid === recorded))
      notes.push(`Process ${recorded} from the last start is not running Goblin Horde any more, so it was left alone.`);
  }
  let stopped = 0;
  // Look each process up again right before signalling it: same id, command line, and start time,
  // so an id that was reused by another program in the meantime is never signalled.
  const verify = (item) => () => sameProcess(item, ctx.listProcesses());
  // The widget first, so it does not briefly report the server as missing.
  for (const item of running.sort((a, b) => Number(a.script === "server.mjs") - Number(b.script === "server.mjs"))) {
    if (!verify(item)()) { notes.push(`Process ${item.pid} changed before it could be stopped, so it was left alone.`); continue; }
    if (await stopPid(item.pid, { verify: verify(item) })) stopped++;
    else if (!verify(item)()) notes.push(`Process ${item.pid} now belongs to another program, so it was left alone.`);
    else notes.push(`Process ${item.pid} did not stop.`);
  }
  try { unlinkSync(runFile(loc.stateDir)); } catch { /* Nothing recorded. */ }
  return { stopped, notes };
}

// ---------------------------------------------------------------------------------------------
// Install and uninstall

function folderHasEntries(dir) {
  try { return readdirSync(dir).length > 0; } catch { return false; }
}

// Python modules earlier versions shipped and later dropped. Python keeps a compiled copy of each in
// __pycache__, which outlives the .py file, so these names stay Goblin Horde's to clean up.
const RETIRED_MODULES = ["stream_windows", "party_layout", "goblin_parting", "horde_window", "horde_roster", "horde_detail", "horde_model", "horde_demo",
  "goblin_strip", "goblin_sprite", "goblin_motion", "goblin_cues"];

/** The names of the top-level Python modules in a file list: "horde_model" for horde_model.py. */
const pythonModules = (files) => (Array.isArray(files) ? files : [])
  .filter((file) => typeof file === "string" && /^[^/\\]+\.py$/.test(file)).map((file) => file.slice(0, -3));

/** Every module name any Goblin Horde version installed in this folder: these files and the old marker's. */
const ownModules = (...lists) => new Set([...lists.flatMap(pythonModules), ...RETIRED_MODULES]);

/** Whether a __pycache__ entry is Python's compiled copy of one of `modules` ("horde_model.cpython-312.pyc"). */
const compiledCopy = (name, modules) => /\.pyc$/i.test(name) && modules.has(name.split(".")[0]);

/**
 * Remove Python's compiled copies of Goblin Horde's own modules, any version's, then the __pycache__
 * folder when nothing else is left in it. Anything else there (someone's own .pyc) stays.
 */
function clearPythonCache(installDir, modules) {
  const cache = join(installDir, "__pycache__");
  let names = [];
  try { names = readdirSync(cache); } catch { return; }
  for (const name of names) if (compiledCopy(name, modules)) { try { unlinkSync(join(cache, name)); } catch { /* Already gone. */ } }
  try { rmdirSync(cache); } catch { /* Other files in it. */ }
}

/**
 * What in a folder is not Goblin Horde's: everything except a __pycache__ that holds only compiled
 * copies of its own modules (left behind when an older version was removed).
 */
function foreignEntries(dir, modules) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.filter((entry) => {
    if (entry.name !== "__pycache__" || !entry.isDirectory()) return true;
    try { return !readdirSync(join(dir, entry.name)).every((name) => compiledCopy(name, modules)); } catch { return true; }
  }).map((entry) => entry.name);
}

function removeEmptyParents(file, stopAt) {
  let dir = dirname(file);
  while (isInside(dir, stopAt) && !samePath(dir, stopAt)) {
    try { rmdirSync(dir); } catch { return; }
    dir = dirname(dir);
  }
}

function skillTargets(ctx, loc, flags) {
  if (flags.skipSkill) return [];
  if (flags.codexSkillDir && !isAbsolute(flags.codexSkillDir)) throw new ManagerError("--codex-skill-dir must be an absolute path.");
  const targets = [];
  const codexSkill = flags.codexSkillDir || join(loc.codexDir, "skills", SKILL_NAME);
  if (flags.codexSkillDir || existsSync(loc.codexDir) || ctx.which("codex")) targets.push({ agent: "codex", dir: codexSkill });
  if (existsSync(loc.claudeDir) || ctx.which("claude")) targets.push({ agent: "claude", dir: join(loc.claudeDir, "skills", SKILL_NAME) });
  return targets;
}

function readSkillMarker(dir) {
  try { return JSON.parse(readFileSync(join(dir, SKILL_MARKER), "utf8").replace(/^﻿/, "")); } catch { return null; }
}

function checkSkillTarget(target, loc, platform) {
  if (isInside(target.dir, loc.installDir, platform)) throw new ManagerError("Choose a manager skill folder outside the application folder.");
  if (!folderHasEntries(target.dir)) return;
  const marker = readSkillMarker(target.dir);
  if (marker?.product !== PRODUCT) throw new ManagerError(`${target.dir} already holds a skill that Goblin Horde did not install; it was left unchanged.`);
  if (!samePath(String(marker.installRoot || ""), loc.installDir, platform)) throw new ManagerError(`${target.dir} belongs to another Goblin Horde installation.`);
}

/**
 * The command that runs an installation's manager, to print or to put in its skill: `node "<dir>\goblin.mjs"`,
 * plus `--install-dir "<dir>"` when the installation is not in the default folder (the manager otherwise
 * looks in the default folder, whichever copy of goblin.mjs runs). An action goes after it.
 */
export function managerCommand(ctx, installDir) {
  const options = { env: ctx.env, platform: ctx.platform, ...(ctx.home ? { home: ctx.home } : {}) };
  const custom = !samePath(installDir, defaultInstallDir(options), ctx.platform);
  return `node "${join(installDir, "goblin.mjs")}"${custom ? ` --install-dir "${installDir}"` : ""}`;
}

/** The installed skill names this installation's manager command. */
function skillText(sourceDir, installDir, ctx) {
  const template = readFileSync(join(sourceDir, SKILL_SOURCE), "utf8");
  return template.replaceAll("{{GOBLIN_CLI}}", managerCommand(ctx, installDir)).replaceAll("{{INSTALL_DIR}}", installDir);
}

function removeSkill(dir, installDir, platform) {
  const marker = readSkillMarker(dir);
  if (marker?.product !== PRODUCT || !samePath(String(marker.installRoot || ""), installDir, platform)) return false;
  for (const name of ["SKILL.md", SKILL_MARKER]) { try { unlinkSync(join(dir, name)); } catch { /* Already gone. */ } }
  try { rmdirSync(dir); } catch { /* Something else lives there; keep it. */ }
  return true;
}

/** The Claude Code settings files an earlier version may have added hooks to: the one in use, and the one its marker recorded. */
const claudeSettingsFiles = (loc) => [...new Set([claudeSettingsPath(loc.claudeDir), loc.marker?.claudeHooks?.settingsPath]
  .filter((path) => typeof path === "string" && isAbsolute(path)))];

/**
 * Take out the Claude Code hook entries an earlier version of this installation added, which run a claude-hook.mjs
 * that no longer ships (see lib/old-hooks.mjs). Says something only when it removed entries or could not.
 */
function removeHooksOf(ctx, loc) {
  const hookPath = join(loc.installDir, HOOK_RECEIVER);
  const messages = [];
  for (const settingsPath of claudeSettingsFiles(loc)) {
    const { removed, error } = removeOldHooks({ settingsPath, hookPath, platform: ctx.platform });
    if (removed) messages.push(`Removed ${removed} Claude Code hook ${removed === 1 ? "entry" : "entries"} an earlier Goblin Horde added to ${settingsPath}; your other settings were kept, and a backup is beside the file.`);
    if (error) messages.push(`Could not take the hook entries an earlier Goblin Horde added out of ${settingsPath} (${error}). Claude Code may report a missing claude-hook.mjs until they are removed.`);
  }
  return messages;
}

/**
 * The Start menu entry names the Node.js that installed it when an older package had no launch.cmd. Upgrades that
 * keep versioned folders (winget, nvm, Volta, fnm) leave such an entry pointing at a missing file, so when the
 * recorded Node is gone, rewrite this installation's entry with the Node running now and record it.
 */
function followNode(ctx, loc) {
  const recorded = loc.marker?.nodePath;
  if (!recorded || samePath(recorded, ctx.nodePath, ctx.platform) || ctx.exists(recorded)) return [];
  const messages = [];
  const menu = shortcutPaths({ platform: ctx.platform, env: ctx.env })?.menu;
  if (menu && ctx.exists(menu) && ownsShortcut(menu, loc.installDir)) {
    try { ctx.writeShortcut(menu, shortcutSpec({ nodePath: ctx.nodePath, installDir: loc.installDir }), { env: ctx.env }); messages.push(`Node.js moved to ${ctx.nodePath}; updated the Start menu entry.`); }
    catch (error) { messages.push(`Could not update the Start menu entry for the new Node.js (${error.message}).`); }
  }
  loc.marker = { ...loc.marker, nodePath: ctx.nodePath, updatedAt: new Date().toISOString() };
  writeJson(join(loc.installDir, MARKER), loc.marker);
  return messages;
}

const owned = (ctx, loc) => ownedProcesses(loc.installDir, { list: ctx.listProcesses() });

export async function install(ctx, flags = {}) {
  if (!ctx.sourceDir) throw new ManagerError("Run install from the Goblin Horde package folder.");
  const sourceDir = resolve(ctx.sourceDir);
  const files = checkSource(sourceDir);
  const loc = locate(ctx, flags);
  const { installDir, stateDir, platform = ctx.platform } = { ...loc, platform: ctx.platform };
  const options = { env: ctx.env, platform, ...(ctx.home ? { home: ctx.home } : {}) };
  if (isUnsafeTarget(installDir, options)) throw new ManagerError(`${installDir} is a shared folder; choose a dedicated installation folder.`);
  if (isInside(installDir, sourceDir, platform) || isInside(sourceDir, installDir, platform))
    throw new ManagerError("Choose an installation folder outside the package folder, and do not install over the package itself.");
  if (isInside(stateDir, installDir, platform)) throw new ManagerError("The state folder must be outside the installation folder, so removing the app never removes settings.");
  if (isUnsafeTarget(stateDir, options)) throw new ManagerError(`${stateDir} is a shared folder; choose a dedicated state folder.`);
  const modules = ownModules(files, loc.marker?.files);
  if (!loc.marker && foreignEntries(installDir, modules).length) throw new ManagerError(`${installDir} already has files that are not a Goblin Horde installation; nothing was changed.`);
  if (nodeMajor(ctx.nodeVersion(ctx.nodePath)) < 20) throw new ManagerError("Node.js 20 or newer is needed.", { code: "MISSING_NODE" });

  const skills = skillTargets(ctx, loc, flags);
  for (const target of skills) checkSkillTarget(target, loc, platform);

  const messages = [];
  const wasRunning = owned(ctx, loc).length > 0;
  if (!flags.noStart && !wasRunning) {
    const owner = await portOwner(loc.port, installDir, platform);
    if (owner.state !== "free") throw new ManagerError(`${portMessage(loc.port, owner)} Nothing was installed.`, { code: "PORT_IN_USE", exitCode: 3 });
  }
  if (wasRunning) {
    await stop(ctx, flags, loc);
    messages.push("Stopped the running copy to update it.");
  }
  // Before the files go, so no hook is left running a receiver that is no longer there.
  messages.push(...removeHooksOf(ctx, loc));

  mkdirSync(installDir, { recursive: true });
  for (const file of files) {
    const target = join(installDir, ...file.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(sourceDir, ...file.split("/")), target);
  }
  // Files an older version listed that this one no longer ships.
  for (const old of Array.isArray(loc.marker?.files) ? loc.marker.files : []) {
    // Same check as uninstall: on Windows "..\\x" is a parent step too, so split on both slashes and stay inside.
    if (files.includes(old) || typeof old !== "string" || isAbsolute(old) || old.split(/[\\/]/).includes("..")) continue;
    const target = join(installDir, ...old.split("/"));
    if (!isInside(target, installDir, platform)) continue;
    try { unlinkSync(target); removeEmptyParents(target, installDir); } catch { /* Already gone. */ }
  }
  // Compiled copies of the old modules, including ones this version dropped; Python rebuilds what it needs.
  clearPythonCache(installDir, modules);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  const installedSkills = [];
  for (const target of skills) {
    // Whether this install made the agent's skills folder itself (or an earlier one did): uninstall then
    // removes it once it is empty, and never one that was there before.
    const before = (loc.marker?.skills || []).find((item) => samePath(String(item?.dir || ""), target.dir, platform));
    target.madeSkillsFolder = Boolean(before?.madeSkillsFolder) || !existsSync(dirname(target.dir));
    mkdirSync(target.dir, { recursive: true });
    writeFileSync(join(target.dir, "SKILL.md"), skillText(sourceDir, installDir, ctx));
    writeJson(join(target.dir, SKILL_MARKER), { product: PRODUCT, installRoot: installDir });
    installedSkills.push(target);
  }
  for (const old of loc.marker?.skills || []) {
    if (!installedSkills.some((item) => samePath(item.dir, old.dir, platform))) removeSkill(old.dir, installDir, platform);
  }

  const version = JSON.parse(readFileSync(join(sourceDir, "package.json"), "utf8")).version || "";
  writeJson(join(installDir, MARKER), {
    product: PRODUCT, schema: 2, version, installRoot: installDir, stateDir, port: loc.port, files,
    skills: installedSkills, skillDirectory: installedSkills.find((item) => item.agent === "codex")?.dir || "",
    nodePath: ctx.nodePath, installedAt: loc.marker?.installedAt || new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  messages.unshift(`Installed Goblin Horde ${version} at ${installDir}`);
  // A Start menu entry to open it again. There is one entry of that name: one that runs another Goblin Horde copy
  // is that copy's, and stays. The game never starts at sign-in, so a sign-in shortcut an earlier version of this
  // copy left goes.
  const shortcuts = shortcutPaths({ platform, env: ctx.env });
  const manager = managerCommand(ctx, installDir);
  if (shortcuts) {
    try {
      if (!ctx.exists(shortcuts.menu) || ownsShortcut(shortcuts.menu, installDir)) {
        ctx.writeShortcut(shortcuts.menu, shortcutSpec({ nodePath: ctx.nodePath, installDir }), { env: ctx.env });
        messages.push("Added Goblin Horde to the Start menu.");
      } else {
        messages.push(`The Start menu's Goblin Horde entry opens another Goblin Horde copy, so it was left as it is. Start this copy with: ${manager} start`);
      }
    } catch (error) {
      messages.push(`Could not add the Start menu entry (${error.message}); start it with: ${manager} start`);
    }
    if (ctx.exists(shortcuts.startup) && ownsShortcut(shortcuts.startup, installDir)) {
      removeShortcut(shortcuts.startup);
      messages.push("Removed the sign-in shortcut an earlier version added: Goblin Horde starts when you open it.");
    }
  }
  let started = null;
  if (!flags.noStart) started = await start(ctx, { ...flags, installDir, stateDir: flags.stateDir });
  else messages.push(`Not started (--no-start). Start it later with: ${manager} start`);
  return { installDir, stateDir, files: files.length, skills: installedSkills, started, messages,
    startMenu: Boolean(shortcuts && ctx.exists(shortcuts.menu) && ownsShortcut(shortcuts.menu, installDir)) };
}

// Files earlier versions kept in the state folder, which a full reset removes too: the phone access choice, the
// agent monitor's watched chats, dismissed alerts, party links, recorded Claude Code activity, extension feeds, and
// the request that brought its window forward.
const RETIRED_STATE = ["phone.json", "watched.json", "dismissed.json", "links.json", join("claude", "activity.jsonl"), join("claude", "activity.1.jsonl"),
  join("run", "show-widget")];
const FEED_FILE = /^[a-z0-9][a-z0-9-]{0,31}(?:\.1)?\.ndjson$/;

/**
 * State files the app owns; a full reset removes these and nothing else: the widget's settings (and an unreadable
 * copy it set aside), the saved pet game, its backup, the copies of saved games it could not read, its lock, and
 * the copies pets-adopt kept, the pairing code, the shared game's host and display settings, the run files, and
 * what earlier versions kept there.
 */
export function stateFiles(stateDir) {
  let names = [];
  try { names = readdirSync(stateDir); } catch { /* No state folder. */ }
  const copies = names.filter((name) => /^pets\.json\.(?:before-adopt-[0-9TZ]+(?:-[0-9a-f]+)?|unreadable\.\d+-[0-9a-f]+)$/.test(name));
  let feeds = [];
  try { feeds = readdirSync(join(stateDir, "feeds")).filter((name) => FEED_FILE.test(name)).map((name) => join("feeds", name)); } catch { /* No feeds. */ }
  return ["goblins.json", "goblins.json.unreadable", "pets.json", "pets.json.bak", "pets.json.unreadable", LOCK_FILE, ...copies, CODE_FILE,
    SHARED_FILE, REMOTE_FILE, REMOTE_CODE_FILE, join("run", RUN_FILE), join("run", "server.log"), join("run", WIDGET_LOG), join("run", UPDATE_LOG), ...RETIRED_STATE, ...feeds]
    .map((name) => join(stateDir, name));
}

export async function uninstall(ctx, flags = {}) {
  const loc = locate(ctx, flags);
  const { installDir, stateDir } = loc;
  if (!loc.marker) throw new ManagerError(`No Goblin Horde installation was found at ${installDir}.`, { code: "NOT_INSTALLED" });
  const options = { env: ctx.env, platform: ctx.platform, ...(ctx.home ? { home: ctx.home } : {}) };
  if (isUnsafeTarget(installDir, options)) throw new ManagerError(`Refusing to remove files from ${installDir}.`);
  const messages = [];
  const stopped = await stop(ctx, flags, loc);
  if (stopped.stopped) messages.push(`Stopped ${stopped.stopped} Goblin Horde ${stopped.stopped === 1 ? "process" : "processes"}.`);
  const shortcuts = shortcutPaths({ platform: ctx.platform, env: ctx.env });
  // Only shortcuts that run this installation are removed; another copy's stay.
  for (const link of shortcuts ? [shortcuts.menu, shortcuts.startup] : []) {
    if (ctx.exists(link) && ownsShortcut(link, installDir)) { removeShortcut(link); messages.push(`Removed ${link === shortcuts.startup ? "the sign-in shortcut" : "the Start menu entry"}.`); }
  }
  messages.push(...removeHooksOf(ctx, loc));
  const skills = [...(loc.marker.skills || []), ...(loc.marker.skillDirectory ? [{ dir: loc.marker.skillDirectory }] : [])];
  for (const skill of skills) {
    if (!skill?.dir || !removeSkill(skill.dir, installDir, ctx.platform)) continue;
    messages.push(`Removed the manager skill at ${skill.dir}.`);
    // The agent's skills folder goes too when install made it and nothing else is in it now.
    if (skill.madeSkillsFolder) { try { rmdirSync(dirname(skill.dir)); } catch { /* Not empty, or already gone. */ } }
  }

  let files = Array.isArray(loc.marker.files) ? loc.marker.files : [];
  if (!files.length) { try { files = readManifest(installDir); } catch { files = []; } }
  for (const file of files) {
    if (typeof file !== "string" || isAbsolute(file) || file.split(/[\\/]/).includes("..")) continue;
    const target = join(installDir, ...file.split("/"));
    if (!isInside(target, installDir, ctx.platform)) continue;
    try { unlinkSync(target); } catch { /* Already gone. */ }
    removeEmptyParents(target, installDir);
  }
  // Python caches the desktop widget's own modules beside them (an older version's too); remove only those.
  clearPythonCache(installDir, ownModules(files));
  unlinkSync(join(installDir, MARKER));
  // Windows cannot remove the folder a running program stands in, and this manager may be run from the app folder.
  if (isInside(process.cwd(), installDir, ctx.platform)) process.chdir(dirname(installDir));
  try { rmdirSync(installDir); } catch { messages.push(`Some files you added remain in ${installDir}; they were left alone.`); }
  messages.unshift(`Removed Goblin Horde from ${installDir}`);

  // Downloaded releases belong to the app that is gone; whether to look for releases is a setting, kept unless asked.
  removeUpdates(stateDir, { settings: Boolean(flags.removeSettings) });
  if (flags.removeSettings) {
    for (const file of stateFiles(stateDir)) { try { unlinkSync(file); } catch { /* Not there. */ } }
    for (const dir of ["claude", "feeds", "run"]) { try { rmdirSync(join(stateDir, dir)); } catch { /* Not empty or missing. */ } }
    try { rmdirSync(stateDir); } catch { /* Other files remain. */ }
    // The Windows predecessor's settings, only when using the default state folder.
    if (loc.defaultState && ctx.env.LOCALAPPDATA) {
      const legacy = join(ctx.env.LOCALAPPDATA, "ActivityLens");
      for (const name of ["goblins.json", "pairing-code.txt"]) { try { unlinkSync(join(legacy, name)); } catch { /* Not there. */ } }
      try { rmdirSync(legacy); } catch { /* Not empty or missing. */ }
    }
    messages.push("Removed Goblin Horde's settings, the saved pet game, the pairing code, the shared game's settings, and what earlier versions kept there.");
    // The copies of Claude Code's settings that an earlier version kept beside them: only Goblin Horde's own backups.
    for (const path of claudeSettingsFiles(loc)) {
      const removed = [BACKUP_SUFFIX, LAST_BACKUP_SUFFIX].filter((suffix) => { try { unlinkSync(`${path}${suffix}`); return true; } catch { return false; } });
      if (removed.length) messages.push(`Removed Goblin Horde's backups of ${path} (${removed.map((suffix) => `${basename(path)}${suffix}`).join(", ")}); your settings file itself was kept.`);
    }
  } else {
    for (const name of [RUN_FILE, "server.log", WIDGET_LOG, UPDATE_LOG, "show-widget"]) { try { unlinkSync(join(stateDir, "run", name)); } catch { /* Not there. */ } }
    try { rmdirSync(join(stateDir, "run")); } catch { /* Not empty or missing. */ }
    messages.push(`Kept settings, the saved pet game, and the pairing code in ${stateDir}. Use --remove-settings for a full reset.`);
  }
  return { messages };
}

// ---------------------------------------------------------------------------------------------
// Updates. lib/updater.mjs finds a release and checks it; this puts one in place.

/** The options that point another run of a manager at this installation's folders and port. */
function locationArgs(loc, flags) {
  return ["--install-dir", loc.installDir, "--state-dir", loc.stateDir, "--port", String(loc.port),
    ...(flags.claudeConfigDir ? ["--claude-config-dir", flags.claudeConfigDir] : []), ...(flags.codexHome ? ["--codex-home", flags.codexHome] : []),
    ...(flags.codexSkillDir ? ["--codex-skill-dir", flags.codexSkillDir] : []), ...(flags.skipSkill ? ["--skip-skill"] : [])];
}

/**
 * Run the manager at `goblinPath` as a program of its own, so that version's own code does the work: whether it
 * finished well, and what it said, indented under `title`.
 */
function runManager(ctx, goblinPath, args, title) {
  const done = spawnSync(ctx.nodePath, [goblinPath, ...args], { cwd: dirname(goblinPath), env: ctx.env, encoding: "utf8", windowsHide: true, timeout: 180_000 });
  const said = `${done.stdout || ""}${done.stderr || ""}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (done.status !== 0 && !said.length) said.push(done.error ? `It did not run (${done.error.code || done.error.message}).` : `It stopped with exit code ${done.status}.`);
  return { ok: done.status === 0, lines: [title, ...said.map((line) => `  ${line}`)] };
}

const removeDir = (dir) => rmSync(dir, { recursive: true, force: true });
const isoNow = (ctx) => new Date(ctx.now()).toISOString();

/**
 * Take the release to put in place out of where it was kept, into `work`, and check it again from its own bytes: for
 * an update the newest release in ready/ that passes, for a rollback the one in previous/. A kept release that does
 * not pass is removed, and that is said.
 */
async function takeRelease(ctx, loc, work, { kind, rule }) {
  const { ready, previous } = updatePaths(loc.stateDir);
  const kept = kind === "rollback" ? [previous] : keptVersions(ready).map((version) => join(ready, version));
  const notes = [];
  for (const from of kept) {
    if (!claimRelease(from, work)) continue;
    const verdict = await verifyRelease({ key: ctx.updateKey, ...folderSources(work.release), rule });
    if (verdict.ok && (kind === "rollback" || verdict.release.version === basename(from))) return { release: verdict.release, notes };
    removeDir(work.release);
    notes.push(kind === "rollback" ? `The earlier version kept for going back was removed without being used: ${verdict.message}`
      : `The downloaded update ${basename(from)} was removed without being used: ${verdict.message}`);
  }
  if (kind === "rollback" && !notes.length) notes.push("No earlier version is kept on this computer, so there is nothing to go back to. One is kept once an update goes in over a version that came as an update too.");
  return { release: null, notes };
}

/**
 * Finish or undo an apply that a manager left part way, from what is on disk. Without a whole copy of the earlier
 * files, nothing of the installation was touched, and the apply is cleared away. With one, the installation's
 * marker, which install writes last, says whether the release went in whole; then it stays, unless putting the
 * earlier version back had begun. Otherwise the earlier version is put back, and an update is not taken again by
 * itself. `ok` is false when the earlier version could not be put back.
 */
function recoverWork(ctx, loc, flags, work) {
  const version = keptVersion(work.release);
  if (!existsSync(work.backup)) { removeDir(work.dir); return { ok: true, lines: [] }; }
  let marker = null;
  try { marker = readMarker(loc.installDir, ctx.platform); } catch { /* Put back below. */ }
  if (!existsSync(work.restoring) && version && marker?.version === version) {
    removeDir(work.dir);
    return { ok: true, lines: [`An update to Goblin Horde ${version} that was cut short had gone in whole, so it stays.`] };
  }
  writeFileSync(work.restoring, "");
  const back = runManager(ctx, join(work.backup, "goblin.mjs"), ["install", "--no-start", ...locationArgs(loc, flags)], "Putting back the version that an update cut short was replacing:");
  if (!back.ok) return { ok: false, lines: [...back.lines, `That did not work. The earlier files are kept in ${work.backup}.`] };
  const now = readMarker(loc.installDir, ctx.platform)?.version || "";
  if (version && now && compareVersions(version, now) > 0) writeSkip(loc.stateDir, { version, reason: "failed", message: "putting it in place was cut short", at: isoNow(ctx) });
  removeDir(work.dir);
  return { ok: true, lines: [...back.lines, `An update${version ? ` to Goblin Horde ${version}` : ""} was cut short, so the version before it is installed again.`] };
}

/**
 * Put the earlier version back after `to` failed to go in, with the earlier version's own install from the copy kept
 * in `work`. The `restoring` file marks that this is under way, so a manager that stops in the middle is followed by
 * one that puts it back again. An update that failed is not taken again by itself; a rollback's release is kept for
 * another try.
 */
function restore(ctx, loc, flags, work, { kind, from, to, why, messages }) {
  writeFileSync(work.restoring, "");
  const back = runManager(ctx, join(work.backup, "goblin.mjs"), ["install", "--no-start", ...locationArgs(loc, flags)], `Putting Goblin Horde ${from} back:`);
  messages.push(...back.lines);
  if (!back.ok) {
    messages.push(`Goblin Horde ${to} did not go in (${why}), and putting ${from} back did not work either. The files of ${from} are kept in ${work.backup}.`
      + ` Put them back with: node "${join(work.backup, "goblin.mjs")}" install --install-dir "${loc.installDir}" --state-dir "${loc.stateDir}"`);
    return { outcome: "broken", messages };
  }
  if (kind === "rollback") giveBack(loc.stateDir, work, { kind, version: to });
  else {
    writeSkip(loc.stateDir, { version: to, reason: "failed", message: why, at: isoNow(ctx) });
    removeDir(work.dir);
  }
  messages.push(kind === "rollback" ? `Going back to ${to} did not work (${why}), so ${from} is installed again.`
    : `Goblin Horde ${to} was not put in place (${why}), so ${from} is installed again. ${to} is not tried again by itself; update tries it on request.`);
  return { outcome: "restored", messages };
}

/**
 * Put a kept release in place of the installed version and start it. `kind` "update" takes the newest verified
 * release in ready/ that `rule` takes, and "rollback" the one in previous/. One apply runs at a time, and one that a
 * manager left part way is finished or undone first. The release is moved into the apply's own folder, checked again
 * from its own bytes, and unpacked beside a whole copy of the installed files. Only then is anything of this
 * installation stopped. The release's own manager installs it (`install --no-start`), the installed manager starts
 * it, and it counts as in place once its server answers with its version. When any of that fails, the earlier
 * version is put back (restore).
 * @returns {Promise<{ outcome: "none" | "busy" | "started" | "restored" | "broken", started?: object, messages: string[] }>}
 */
async function applyKept(ctx, loc, flags, { kind, rule }) {
  const lock = takeApplyLock(loc.stateDir);
  if (!lock) return { outcome: "busy", messages: ["Another Goblin Horde manager is putting an update in place right now."] };
  try {
    const messages = [];
    for (const leftover of leftoverWork(loc.stateDir)) {
      const recovered = recoverWork(ctx, loc, flags, leftover);
      messages.push(...recovered.lines);
      if (!recovered.ok) return { outcome: "broken", messages };
    }
    const marker = readMarker(loc.installDir, ctx.platform);
    const work = newWork(loc.stateDir);
    const { release, notes } = await takeRelease(ctx, loc, work, { kind, rule });
    messages.push(...notes);
    if (!release) { removeDir(work.dir); return { outcome: "none", messages }; }
    const [from, to] = [marker.version, release.version];
    let packageDir = "";
    try {
      packageDir = unpackRelease(release, work);
      keepInstalledFiles(loc.installDir, marker.files, work);
    } catch (error) {
      giveBack(loc.stateDir, work, { kind, version: to });
      messages.push(`Goblin Horde ${to} was not put in place, because it could not be made ready beside a copy of the installed files (${error.code || error.message}). Nothing was changed.`);
      return { outcome: "none", messages };
    }
    const stopped = await stop(ctx, flags, loc);
    if (stopped.stopped) messages.push(`Stopped the running copy to put Goblin Horde ${to} in place.`);
    const args = locationArgs(loc, flags);
    const installed = runManager(ctx, join(packageDir, "goblin.mjs"), ["install", "--no-start", ...args], `Installing Goblin Horde ${to} with its own manager:`);
    messages.push(...installed.lines);
    let why = "its install did not finish";
    if (installed.ok) {
      const launched = runManager(ctx, join(loc.installDir, "goblin.mjs"), ["start", "--no-update", ...args], `Starting Goblin Horde ${to}:`);
      messages.push(...launched.lines);
      const health = launched.ok ? await getLocalJson(loc.port, "/api/health") : null;
      if (health?.product === PRODUCT && health.version === to && samePath(String(health.installDir || ""), loc.installDir, ctx.platform)) {
        messages.push(kind === "rollback" ? `Went back from Goblin Horde ${from} to ${to}. ${from} is not put in place by itself again; a newer release is.`
          : `Updated Goblin Horde from ${from} to ${to}.`);
        // What is kept for going back is bookkeeping: the new version runs whether or not it can be written now, and an
        // apply folder left behind is cleared at the next start, since the marker already names the new version.
        try {
          if (kind === "rollback") {
            writeSkip(loc.stateDir, { version: from, reason: "rollback", message: "", at: isoNow(ctx) });
            recordRollback(loc.stateDir, work);
          } else {
            recordUpdate(loc.stateDir, work, { from, to });
            const skip = readSkip(loc.stateDir);
            if (skip && compareVersions(skip.version, to) <= 0) clearSkip(loc.stateDir);
          }
          removeDir(work.dir);
        } catch (error) {
          messages.push(kind === "rollback" ? `Recording that ${from} is skipped did not finish (${error.code || error.message}). If ${from} comes back by itself, update --off stops that.`
            : `The release kept for going back could not be recorded (${error.code || error.message}), so update --rollback may not find ${from}.`);
        }
        const run = readRun(loc.stateDir);
        return { outcome: "started", messages, started: { url: `http://127.0.0.1:${loc.port}`, server: run?.server?.pid || null, widget: run?.widget?.pid || null, reason: "", messages } };
      }
      why = "it did not start";
      await stop(ctx, flags, loc);
    }
    return restore(ctx, loc, flags, work, { kind, from, to, why, messages });
  } finally { lock.release(); }
}

/**
 * `update`: look on GitHub for the latest signed release and put it in place now: stop this installation, install the
 * release with its own manager, and start it. `check` only says what it finds and changes nothing. `off` and `on`
 * set whether the server looks for a release by itself once a day. `rollback` goes back to the release installed
 * before. `applyStaged` puts in place the release the server kept, as the desktop goblins' menu asks.
 * @returns {Promise<{ ok: boolean, messages: string[] }>}
 */
export async function update(ctx, flags = {}, { check = false, rollback = false, on = false, off = false, applyStaged = false } = {}) {
  if ([check, rollback, on, off, applyStaged].filter(Boolean).length > 1) throw new ManagerError("Choose one of --check, --rollback, --off and --on.");
  const loc = locate(ctx, flags);
  if (on || off) {
    writeSettings(loc.stateDir, { check: on });
    return { ok: true, messages: [on ? "Goblin Horde looks on github.com for a signed release about once a day while it runs, and puts one in place at the next start."
      : "Goblin Horde no longer looks for releases by itself. update still looks when you run it, and update --on turns the daily look back on."] };
  }
  if (!loc.marker) throw new ManagerError(`Goblin Horde is not installed at ${loc.installDir}. Run: node goblin.mjs install`, { code: "NOT_INSTALLED" });
  const installed = loc.marker.version;
  if (rollback || applyStaged) {
    const rule = rollback ? { olderThan: installed } : automaticRule(installed, readSkip(loc.stateDir));
    const applied = await applyKept(ctx, loc, flags, { kind: rollback ? "rollback" : "update", rule });
    if (applied.outcome === "none" && !applied.messages.length) applied.messages.push("No downloaded update is waiting, so nothing was changed.");
    return finishApply(ctx, flags, applied, [], false);
  }
  const sources = githubSources(ctx.fetch, installed);
  const rule = { newerThan: installed };
  const messages = [`Looking on github.com for a release newer than Goblin Horde ${installed}.`];
  if (check) {
    const verdict = await verifyRelease({ key: ctx.updateKey, ...sources, rule });
    const skip = readSkip(loc.stateDir);
    messages.push(verdict.ok ? `Goblin Horde ${verdict.release.version} is available, and its signature, size, SHA-256 and files check out. update puts it in place.` : verdictLine(verdict, installed));
    if (verdict.ok && skip && compareVersions(verdict.release.version, skip.version) <= 0) messages.push(`It is not put in place by itself, because ${skipReason(skip)}.`);
    const staged = await findStaged(loc.stateDir, { key: ctx.updateKey, rule: automaticRule(installed, skip) });
    if (staged) messages.push(`Goblin Horde ${staged.release.version} is downloaded and checked, and is put in place at the next start.`);
    return { ok: true, messages };
  }
  const verdict = await checkForUpdate(loc.stateDir, { key: ctx.updateKey, sources, rule, now: ctx.now });
  messages.push(verdict.ok ? `Found Goblin Horde ${verdict.release.version}. Its signature, size, SHA-256 and files check out.` : verdictLine(verdict, installed));
  return finishApply(ctx, flags, await applyKept(ctx, loc, flags, { kind: "update", rule }), messages, verdict.ok || verdict.current);
}

const verdictLine = (verdict, installed) => (verdict.current ? `Goblin Horde ${installed} is up to date. The newest release is ${verdict.version}.` : verdict.message);

/**
 * What an update command says once its apply is over. When the earlier version was put back it is started again.
 * `fine` says whether an apply that found nothing to do is a success.
 */
async function finishApply(ctx, flags, applied, messages, fine) {
  messages.push(...applied.messages);
  if (applied.outcome === "restored") {
    const loc = locate(ctx, flags);
    messages.push(...(await launch(ctx, loc, owned(ctx, loc))).messages);
    return { ok: false, messages };
  }
  return { ok: applied.outcome === "started" || (applied.outcome === "none" && fine), messages };
}
