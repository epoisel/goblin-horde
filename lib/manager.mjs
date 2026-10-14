/**
 * Install, start, stop, check, and remove Goblin Horde on Windows, macOS, and Linux.
 *
 * Everything the manager changes is recorded in the installation marker, so uninstall removes
 * exactly what install added: the listed app files, the manager skills it wrote, and its own
 * Claude Code hook handlers. Settings stay unless the person asks for a full reset.
 */
import { execFileSync, spawn } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { delimiter, dirname, isAbsolute, join, normalize, posix, resolve, win32 } from "node:path";
import { randomBytes } from "node:crypto";
import { DEFAULT_PORT, PRODUCT, defaultStateDir, isInside, isUnsafeTarget, resolveLocations, samePath } from "./paths.mjs";
import { HookSettingsError, claudeHookReport, claudeSettingsPath, installClaudeHooks, readClaudeSettings, uninstallClaudeHooks } from "./claude-hooks.mjs";
import { extensionFeedDir, listFeedFiles } from "./extension.mjs";
import { interpreterBefore, isAlive, listProcesses, ownedProcesses, sameProcess, stopPid } from "./processes.mjs";
import { ownsShortcut, removeShortcut, shortcutPaths, shortcutSpec, writeShortcut } from "./shortcuts.mjs";

export { ownsShortcut };

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

/** Shared context; tests replace pieces of it to stay away from this computer's real state. */
export function makeContext(overrides = {}) {
  return {
    platform: process.platform, env: process.env, nodePath: process.execPath, sourceDir: "", log: (line) => console.log(line),
    which: (name) => which(name, { env: overrides.env || process.env, platform: overrides.platform || process.platform }),
    openUrl, listProcesses, spawn, exists: existsSync, probe: runProbe, writeShortcut, ...overrides,
  };
}

/** Run a short check program and return its output, or "" when it fails. */
function runProbe(file, args) {
  try { return execFileSync(file, args, { encoding: "utf8", timeout: 15_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return ""; }
}

/** Find a program on PATH, honouring PATHEXT on Windows. */
export function which(name, { env = process.env, platform = process.platform } = {}) {
  const folders = String(env.PATH || env.Path || "").split(delimiter).filter(Boolean);
  const extensions = platform === "win32" ? ["", ...String(env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean).map((ext) => ext.toLowerCase())] : [""];
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
function readRun(stateDir) {
  try { return JSON.parse(readFileSync(runFile(stateDir), "utf8")); } catch { return null; }
}

// ---------------------------------------------------------------------------------------------
// Prerequisites

function nodeMajor(ctx) {
  try { return Number(execFileSync(ctx.nodePath, ["-p", "process.versions.node"], { encoding: "utf8", timeout: 10_000, windowsHide: true }).trim().split(".")[0]); }
  catch { return 0; }
}

// Where macOS Python 3 usually lives: PATH first, then python.org, Homebrew (Apple silicon, Intel).
const MAC_PYTHONS = ["/Library/Frameworks/Python.framework/Versions/Current/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"];
// Without the Command Line Tools, /usr/bin/python3 is a stub that asks to install them; never run it then.
const APPLE_PYTHON_REAL = ["/Library/Developer/CommandLineTools/usr/bin/python3", "/Applications/Xcode.app"];
export const WIDGET_READY = "GOBLIN_HORDE_WIDGET_READY";
export const WIDGET_UNAVAILABLE_EXIT = 3;
const WIDGET_LOG = "widget.log";
// `start` leaves this file in run/ when the widget is already running; the widget sees it within a
// second and comes forward (a window closed with its X only collapses to the goblin strip, so this brings it back).
export const SHOW_REQUEST = "show-widget";
const TK_PROBE = "import tkinter; print(tkinter.TkVersion)";

/** The Python the macOS widget runs with: python3 whose Tkinter has Tk 8.6 or newer. */
export function findMacPythonTk(ctx) {
  const candidates = [...new Set([ctx.which("python3"), ...MAC_PYTHONS].filter(Boolean))];
  const appleReal = APPLE_PYTHON_REAL.some((path) => ctx.exists(path));
  let older = "";
  for (const python of candidates) {
    if (!ctx.exists(python) || (python === "/usr/bin/python3" && !appleReal)) continue;
    const version = String(ctx.probe(python, ["-c", TK_PROBE]) || "").trim();
    if (!/^\d+\.\d+$/.test(version)) continue; // No Tkinter.
    const [major, minor] = version.split(".").map(Number);
    if (major > 8 || (major === 8 && minor >= 6)) return { python, tkVersion: version };
    older ||= `${python} has Tk ${version}`;
  }
  return { python: "", reason: older ? `${older}; the transparent widget needs Tk 8.6 or newer.` : "No Python 3 with Tkinter was found." };
}

const WINDOWS_TK_PROBE = "import sys, tkinter; print(sys.executable)";

/**
 * The pythonw.exe that runs the Windows widget: pythonw on PATH, else the Python Launcher (`py`),
 * which a default python.org install puts on PATH even with "Add python.exe to PATH" unticked.
 * Each candidate imports Tkinter and names its real interpreter; the widget uses the pythonw.exe
 * beside it. `python` on PATH is never run: it can be the Microsoft Store's "install Python" stub,
 * which opens the Store. (The Store installs no pythonw stub, so a pythonw on PATH is a real Python.)
 */
export function findWindowsPythonTk(ctx) {
  const candidates = [];
  const pythonw = ctx.which("pythonw");
  if (pythonw && ctx.exists(win32.join(win32.dirname(pythonw), "python.exe"))) candidates.push([win32.join(win32.dirname(pythonw), "python.exe"), []]);
  const launcher = ctx.which("py");
  if (launcher) candidates.push([launcher, ["-3"]]);
  for (const [program, prefix] of candidates) {
    const lines = String(ctx.probe(program, [...prefix, "-c", WINDOWS_TK_PROBE]) || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const executable = lines.at(-1) || "";
    if (!win32.isAbsolute(executable) || !/\.exe$/i.test(executable)) continue; // No Tkinter, or no Python 3.
    const found = win32.join(win32.dirname(executable), "pythonw.exe");
    if (ctx.exists(found)) return found;
  }
  return "";
}

/** The Python that runs the desktop goblins here, or "" when this system cannot show them. */
export function findPythonTk(ctx) {
  if (ctx.platform === "darwin") return findMacPythonTk(ctx).python;
  return ctx.platform === "win32" ? findWindowsPythonTk(ctx) : "";
}

/** What to do when Windows has no Python with Tkinter. */
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

export function getLocalJson(port, path, timeoutMs = 2000) {
  return new Promise((resolvePromise) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", timeout: timeoutMs, headers: { Host: "127.0.0.1" } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { if (body.length < 200_000) body += chunk; });
      res.on("end", () => {
        if (res.statusCode !== 200) return resolvePromise(null);
        try { resolvePromise(JSON.parse(body)); } catch { resolvePromise(null); }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolvePromise(null));
    req.end();
  });
}

/** Who holds the port: "free", "ours", "other-goblin", "old-goblin", or "other". */
export async function portOwner(port, installDir, platform = process.platform) {
  if (!(await probePort(port))) return { state: "free" };
  const health = await getLocalJson(port, "/api/health");
  if (health?.product === PRODUCT) {
    if (health.installDir && samePath(health.installDir, installDir, platform)) return { state: "ours", health };
    return { state: "other-goblin", health };
  }
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

export async function doctor(ctx, flags = {}) {
  const loc = locate(ctx, flags);
  const checks = [];
  const add = (name, state, detail, extra = {}) => checks.push({ name, state, detail, ...extra });
  const major = nodeMajor(ctx);
  add("node", major >= 20 ? "ok" : "missing", major >= 20 ? `Node.js ${major} at ${ctx.nodePath}` : "Node.js 20 or newer is needed.");
  const codex = ctx.which("codex");
  add("codex", codex ? "ok" : "missing", codex ? `Codex CLI found (${codex}).` : "Codex CLI not found: Codex chats will not appear. Claude Code and extension feeds still work.");
  const claudeCli = ctx.which("claude");
  const claudeConfig = existsSync(loc.claudeDir);
  const hooks = claudeHookReport(claudeSettingsPath(loc.claudeDir), hookScope(ctx, loc));
  const hookState = hooks.state === "installed" && !hooks.broken && !hooks.disabled ? "ok" : hooks.state === "unreadable" ? "error" : "missing";
  add("claude", claudeCli || claudeConfig ? "ok" : "missing", claudeCli ? `Claude Code CLI found (${claudeCli}).`
    : claudeConfig ? `Claude Code settings folder found (${loc.claudeDir}); the CLI is not on PATH.`
      : "Claude Code not found (no CLI on PATH and no settings folder).", { present: Boolean(claudeCli || claudeConfig) });
  add("claude-hooks", hookState, hooks.error || (hooks.disabled ? "Claude Code has disableAllHooks set, so no hooks run."
    : hooks.state === "missing" ? `Not connected.${hooks.otherInstall ? " Another Goblin Horde installation's hooks are present." : ""} Install connects it with --claude-hooks, or later: node goblin.mjs hooks install`
      : hooks.broken ? "Connected, but the hook points to a missing Node or receiver. Run: node goblin.mjs hooks install"
        : hooks.state === "partial" ? `Some events are missing: ${hooks.missing.join(", ")}` : `Connected in ${hooks.settingsPath}`));
  if (ctx.platform === "win32") {
    const pythonw = findPythonTk(ctx);
    add("desktop-widget", pythonw ? "ok" : "missing", pythonw ? `Python with Tkinter found (${pythonw}): transparent desktop goblins available.`
      : `Python with Tkinter not found: the browser viewer will open instead. ${WINDOWS_PYTHON_HINT}`);
  } else if (ctx.platform === "darwin") {
    const found = findMacPythonTk(ctx);
    add("desktop-widget", found.python ? "ok" : "missing", found.python
      ? `Python with Tk ${found.tkVersion} found (${found.python}): transparent desktop goblins available. Start confirms the window is transparent and otherwise opens the browser viewer.`
      : `${found.reason} Install Python 3 from python.org, or Homebrew python-tk, for the desktop goblins; the browser viewer opens instead.`);
  } else {
    add("desktop-widget", "unsupported", "Transparent desktop goblins run on Windows and macOS. The browser viewer (with a compact pop-out) is used here.");
  }
  const orcaCli = ctx.which("orca");
  add("orca", orcaCli ? "ok" : "optional", orcaCli ? `Orca CLI found (${orcaCli}).` : "Optional: Orca is not installed.");
  const feeds = listFeedFiles(extensionFeedDir(loc.stateDir));
  add("extension-feeds", feeds.length ? "ok" : "none", feeds.length ? `${feeds.length} feed(s): ${feeds.map((feed) => feed.feed).join(", ")}` : `None yet. Other orchestrators can write to ${extensionFeedDir(loc.stateDir)}`);
  const owner = await portOwner(loc.port, loc.installDir, ctx.platform);
  add("port", owner.state === "free" ? "ok" : owner.state === "ours" ? "ok" : "conflict",
    owner.state === "free" ? `Port ${loc.port} is free.` : owner.state === "ours" ? `Port ${loc.port} is used by this Goblin Horde.` : portMessage(loc.port, owner));
  add("install", loc.marker ? "ok" : "missing", loc.marker ? `Installed at ${loc.installDir}` : `Not installed at ${loc.installDir}`);
  return { platform: ctx.platform, installDir: loc.installDir, stateDir: loc.stateDir, port: loc.port, checks };
}

export async function status(ctx, flags = {}) {
  const loc = locate(ctx, flags);
  const running = owned(ctx, loc);
  // Shortcuts follow a moved Node here too; Claude Code's settings are only changed by start or install.
  const notes = loc.marker ? followNode(ctx, loc) : [];
  const run = readRun(loc.stateDir);
  const server = running.find((item) => item.script === "server.mjs");
  const widget = running.find((item) => item.script === "desktop_widget.py");
  const health = server ? await getLocalJson(loc.port, "/api/health") : null;
  const capabilities = health?.product === PRODUCT ? await getLocalJson(loc.port, "/api/capabilities", 8000) : null;
  return {
    installed: Boolean(loc.marker), installDir: loc.installDir, stateDir: loc.stateDir, version: loc.marker?.version || "",
    port: loc.port, url: `http://127.0.0.1:${loc.port}`,
    server: server ? { pid: server.pid, healthy: Boolean(health) } : null,
    widget: widget ? { pid: widget.pid } : null,
    ui: run?.ui || "",
    claudeHooks: claudeHookReport(claudeSettingsPath(loc.claudeDir), hookScope(ctx, loc)),
    feeds: listFeedFiles(extensionFeedDir(loc.stateDir)).map(({ feed, mtimeMs, bytes }) => ({ feed, updatedAt: mtimeMs, bytes })),
    sources: capabilities?.sources || null,
    notes,
  };
}

// ---------------------------------------------------------------------------------------------
// Start and stop

export function openUrl(url, platform = process.platform) {
  try {
    const [command, args] = platform === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
      : platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch { return false; }
}

const pause = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/**
 * The viewer reads the same Claude Code settings and Codex home the manager checked, including
 * --claude-config-dir and --codex-home (the Codex it starts reads CODEX_HOME).
 */
export function childEnv(ctx, loc, instance) {
  const env = { ...ctx.env, PORT: String(loc.port), GOBLIN_HORDE_STATE_DIR: loc.stateDir, GOBLIN_HORDE_INSTANCE: instance,
    CLAUDE_CONFIG_DIR: loc.claudeDir, ...(loc.codexDir ? { CODEX_HOME: loc.codexDir } : {}) };
  delete env.CODEX_VIEWER_THREAD_ID;
  return env;
}

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
      throw new ManagerError(`The viewer stopped while starting.${reason ? ` ${reason}` : ""} Details: ${logPath}`);
    }
    const health = await getLocalJson(loc.port, "/api/health", 1000);
    if (health?.product === PRODUCT && health.instance === instance) return child.pid;
  }
  throw new ManagerError(`The viewer did not answer within 20 seconds. Details: ${logPath}`);
}

/**
 * Start the desktop goblins and wait for the widget to report that its transparent windows are up,
 * so a Python/Tk that cannot draw them (an X11 Tk, Tk older than 8.6, no window server, a crash at
 * start) is reported and the browser viewer opens instead. The widget's output goes to
 * run/widget.log on Windows too: pythonw has no console, so that file is where its errors land.
 * The widget opens its window unless `surface` is "strip" (the sign-in shortcut's start).
 * Returns { ok, pid, message }.
 */
export async function launchWidget(ctx, loc, python, instance, { waitMs = 15_000, surface = "" } = {}) {
  const args = [join(loc.installDir, "desktop_widget.py"), "--port", String(loc.port), ...(surface === "strip" ? ["--surface", "strip"] : [])];
  const options = { cwd: loc.installDir, detached: true, windowsHide: true, env: childEnv(ctx, loc, instance) };
  try { unlinkSync(join(loc.stateDir, "run", SHOW_REQUEST)); } catch { /* None waiting. */ }
  const runDir = join(loc.stateDir, "run");
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const logPath = join(runDir, WIDGET_LOG);
  const fd = openSync(logPath, "w");
  let exited = null;
  let child;
  try { child = ctx.spawn(python, args, { ...options, stdio: ["ignore", fd, fd] }); }
  catch (error) { return { ok: false, pid: 0, message: `The desktop goblins could not start (${error.message}). Using the browser viewer instead.` }; }
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
      return { ok: false, pid: 0, message: `${why} Using the browser viewer instead. Details: ${logPath}` };
    }
    if (log.includes(WIDGET_READY)) return { ok: true, pid: child.pid || 0, message: "The desktop goblins are running." };
    if (waited >= waitMs) return { ok: true, pid: child.pid || 0, message: "The desktop goblins are still starting." };
    await pause(200);
  }
}

function noWidgetMessage(platform) {
  if (platform === "win32") return `Python with Tkinter was not found, so the browser viewer is used instead of desktop goblins. ${WINDOWS_PYTHON_HINT}`;
  if (platform === "darwin") return "Python 3 with Tk 8.6 or newer was not found (python.org Python, or Homebrew python-tk), so the browser viewer is used instead of desktop goblins.";
  return "Desktop goblins run on Windows and macOS; using the browser viewer.";
}

/**
 * Start the viewer (and, on Windows or macOS with Python/Tk, the desktop goblins). Safe to repeat: a
 * running copy is reused, and a port held by anything else is reported instead of taken over.
 * The desktop goblins open the Horde window, and a running copy is asked to bring it forward;
 * `--surface strip` (the sign-in shortcut) starts with only the goblin strip and leaves a running
 * copy as it is.
 */
export async function start(ctx, flags = {}) {
  const loc = locate(ctx, flags);
  if (!loc.marker) throw new ManagerError(`Goblin Horde is not installed at ${loc.installDir}. Run: node goblin.mjs install`, { code: "NOT_INSTALLED" });
  const ui = flags.ui || "auto";
  if (!["auto", "widget", "browser", "none"].includes(ui)) throw new ManagerError("--ui must be auto, widget, browser, or none.");
  const surface = flags.surface || "window";
  if (!["window", "strip"].includes(surface)) throw new ManagerError("--surface must be window or strip.");
  // Listed before a moved Node is recorded, so processes the old Node runs are still recognised.
  const running = owned(ctx, loc);
  const messages = followNode(ctx, loc);
  const repaired = repairHooks(ctx, loc);
  if (repaired) messages.push(repaired);
  let server = running.find((item) => item.script === "server.mjs");
  let instance = readRun(loc.stateDir)?.instance || "";
  if (server) {
    const owner = await portOwner(loc.port, loc.installDir, ctx.platform);
    if (owner.state !== "ours" && owner.state !== "old-goblin") messages.push(`A Goblin Horde viewer from this installation is running (process ${server.pid}) but is not answering on port ${loc.port}.`);
    else messages.push(`The viewer is already running at http://127.0.0.1:${loc.port}`);
  } else {
    const owner = await portOwner(loc.port, loc.installDir, ctx.platform);
    if (owner.state !== "free") throw new ManagerError(portMessage(loc.port, owner), { code: "PORT_IN_USE", exitCode: 3 });
    instance = randomBytes(16).toString("hex");
    const pid = await startServer(ctx, loc, instance);
    server = { pid };
    messages.push(`The viewer is running at http://127.0.0.1:${loc.port}`);
  }

  let mode = "none";
  let reason = ""; // Why the browser viewer opened instead of the desktop goblins.
  let widgetPid = running.find((item) => item.script === "desktop_widget.py")?.pid || 0;
  if (ui === "auto" || ui === "widget") {
    const python = widgetPid ? "" : findPythonTk(ctx);
    const darwin = ctx.platform === "darwin";
    // A widget whose Python path has spaces, started before that Python was recorded, is still ours.
    if (darwin && python && !widgetPid) {
      widgetPid = owned(ctx, loc, [python]).find((item) => item.script === "desktop_widget.py")?.pid || 0;
      if (widgetPid) rememberWidgetPythons(loc, [python]);
    }
    if (widgetPid && surface === "strip") {
      mode = "widget";
      messages.push("The desktop goblins are already running.");
    } else if (widgetPid) {
      mode = "widget";
      // A widget whose window was closed to its strip is still running; ask it to open the window.
      try {
        mkdirSync(join(loc.stateDir, "run"), { recursive: true, mode: 0o700 });
        writeFileSync(join(loc.stateDir, "run", SHOW_REQUEST), new Date().toISOString());
      } catch { /* It stays where it is. */ }
      messages.push("The desktop goblins are already running; they will come to the front.");
    } else if (python) {
      // Recorded before launching, so stop and uninstall find the widget even if this start is interrupted.
      if (darwin) rememberWidgetPythons(loc, [python]);
      const launched = await launchWidget(ctx, loc, python, instance, { surface });
      widgetPid = launched.pid;
      if (darwin && launched.ok) rememberWidgetPythons(loc, [shownInterpreter(ctx, loc, launched.pid), python]);
      mode = launched.ok ? "widget" : "browser";
      if (!launched.ok) reason = launched.message;
      messages.push(launched.message);
    } else {
      mode = "browser";
      reason = noWidgetMessage(ctx.platform);
      messages.push(reason);
    }
  } else if (ui === "browser") mode = "browser";
  if (mode === "browser" && flags.openBrowser !== false) {
    ctx.openUrl(`http://127.0.0.1:${loc.port}/`, ctx.platform);
    messages.push("Opened the viewer in your browser. Use \"Pop out\" for a small always-available window.");
  }
  writeJson(runFile(loc.stateDir), {
    product: PRODUCT, installRoot: loc.installDir, port: loc.port, instance, ui: mode,
    server: { pid: server.pid }, widget: widgetPid ? { pid: widgetPid } : null, startedAt: new Date().toISOString(),
  });
  return { url: `http://127.0.0.1:${loc.port}`, server: server.pid, widget: widgetPid || null, ui: mode, reason, messages };
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
  const verify = (item) => () => sameProcess(item, ctx.listProcesses({ platform: ctx.platform }));
  // The widget first, so it does not briefly report the viewer as missing.
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
const RETIRED_MODULES = ["stream_windows", "party_layout", "goblin_parting"];

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

/** The installed skill names this installation's manager command. */
function skillText(sourceDir, installDir, platform) {
  const template = readFileSync(join(sourceDir, SKILL_SOURCE), "utf8");
  const cli = join(installDir, "goblin.mjs");
  const quoted = platform === "win32" ? `node "${cli}"` : `node '${cli.replace(/'/g, "'\\''")}'`;
  return template.replaceAll("{{GOBLIN_CLI}}", quoted).replaceAll("{{INSTALL_DIR}}", installDir);
}

function removeSkill(dir, installDir, platform) {
  const marker = readSkillMarker(dir);
  if (marker?.product !== PRODUCT || !samePath(String(marker.installRoot || ""), installDir, platform)) return false;
  for (const name of ["SKILL.md", SKILL_MARKER]) { try { unlinkSync(join(dir, name)); } catch { /* Already gone. */ } }
  try { rmdirSync(dir); } catch { /* Something else lives there; keep it. */ }
  return true;
}

/** This installation's own hook receiver: hook removal and status are scoped to it. */
const hookScope = (ctx, loc) => ({ hookPath: join(loc.installDir, "claude-hook.mjs"), platform: ctx.platform });

function hookOptions(ctx, loc) {
  return { settingsPath: claudeSettingsPath(loc.claudeDir), nodePath: ctx.nodePath, stateDir: loc.stateDir, ...hookScope(ctx, loc) };
}

/** Rewrite this installation's Claude Code hooks when they name a Node or receiver that is gone. */
function repairHooks(ctx, loc) {
  const report = claudeHookReport(claudeSettingsPath(loc.claudeDir), hookScope(ctx, loc));
  if (report.state === "missing" || report.state === "unreadable" || !report.broken) return "";
  try {
    installClaudeHooks(hookOptions(ctx, loc));
    return `Updated the Claude Code hooks to use Node.js at ${ctx.nodePath}.`;
  } catch (error) {
    return `The Claude Code hooks name a Node.js that is gone (${error.message}). Run: node goblin.mjs hooks install`;
  }
}

/**
 * Shortcuts and Claude Code hooks name the Node.js that installed them. Upgrades that keep versioned
 * folders (winget, nvm, Volta, fnm) leave them pointing at a missing file, so when the recorded Node
 * is gone, rewrite this installation's shortcuts with the Node running now. `start` and `install`
 * also repair broken hooks (see repairHooks); `status` only says so. A shortcut to a missing Node
 * cannot start anything itself; the next manager run (the installer, `start`, `status`) repairs it.
 */
function followNode(ctx, loc) {
  const recorded = loc.marker?.nodePath;
  if (!recorded || samePath(recorded, ctx.nodePath, ctx.platform) || ctx.exists(recorded)) return [];
  const messages = [];
  const shortcuts = shortcutPaths({ platform: ctx.platform, env: ctx.env });
  const spec = (surface) => shortcutSpec({ nodePath: ctx.nodePath, installDir: loc.installDir, surface });
  for (const [link, label, surface] of shortcuts ? [[shortcuts.menu, "Start menu entry", ""], [shortcuts.startup, "sign-in shortcut", "strip"]] : []) {
    if (!ctx.exists(link) || !ownsShortcut(link, loc.installDir)) continue;
    try { ctx.writeShortcut(link, spec(surface), { env: ctx.env }); messages.push(`Node.js moved to ${ctx.nodePath}; updated the ${label}.`); }
    catch (error) { messages.push(`Could not update the ${label} for the new Node.js (${error.message}).`); }
  }
  loc.marker = { ...loc.marker, nodePath: ctx.nodePath, updatedAt: new Date().toISOString() };
  writeJson(join(loc.installDir, MARKER), loc.marker);
  return messages;
}

/** Whether release `version` ("0.5.0") comes before `than`; an unknown version counts as older. */
export function versionBefore(version, than) {
  const parts = (value) => String(value || "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  if (!/^\d+(\.\d+)*/.test(String(version || ""))) return true;
  const [a, b] = [parts(version), parts(than)];
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) < (b[index] || 0);
  }
  return false;
}

/** The Pythons recorded as having started this installation's widget on macOS, newest first. */
const MAX_WIDGET_PYTHONS = 4;
const widgetPythons = (loc) => (Array.isArray(loc.marker?.widgetPythons) ? loc.marker.widgetPythons : [])
  .filter((item) => typeof item === "string" && posix.isAbsolute(item));

/**
 * Record in the installation marker the Python that runs the widget, so later starts, status, stop,
 * and uninstall still recognise it when its path has spaces (`ps` shows arguments unquoted).
 */
function rememberWidgetPythons(loc, paths) {
  const known = widgetPythons(loc);
  const next = [...new Set([...paths.filter((item) => item && posix.isAbsolute(item)), ...known])].slice(0, MAX_WIDGET_PYTHONS);
  if (next.length === known.length && next.every((item, index) => item === known[index])) return;
  loc.marker = { ...loc.marker, widgetPythons: next };
  writeJson(join(loc.installDir, MARKER), loc.marker);
}

/** How `ps` shows the Python of the widget just started, which can differ from the program run. */
function shownInterpreter(ctx, loc, pid) {
  if (!pid) return "";
  const item = ctx.listProcesses({ platform: ctx.platform }).find((entry) => entry.pid === pid);
  return item ? interpreterBefore(item.command, posix.join(loc.installDir, "desktop_widget.py")) : "";
}

/** The Node and Python programs this manager starts, so `ps` output with spaces still matches. */
const interpreters = (ctx, loc, extra = []) => [ctx.nodePath, loc.marker?.nodePath, ...widgetPythons(loc), ...extra].filter(Boolean);
const owned = (ctx, loc, extra = []) =>
  ownedProcesses(loc.installDir, { platform: ctx.platform, list: ctx.listProcesses({ platform: ctx.platform }), interpreters: interpreters(ctx, loc, extra) });

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
  if (nodeMajor(ctx) < 20) throw new ManagerError("Node.js 20 or newer is needed.", { code: "MISSING_NODE" });

  const skills = skillTargets(ctx, loc, flags);
  for (const target of skills) checkSkillTarget(target, loc, platform);
  // Hooks: explicit yes, explicit no, or keep what the person chose last time.
  const wantHooks = flags.claudeHooks === true ? true : flags.claudeHooks === false ? false : Boolean(loc.marker?.claudeHooks?.installed);
  const settingsPath = claudeSettingsPath(loc.claudeDir);
  if (wantHooks || flags.claudeHooks === false) readClaudeSettings(settingsPath); // Fails early, before anything changes.

  // Whether this installation's Claude Code hooks were connected before an upgrade, by install or from the widget.
  const hooksBefore = loc.marker ? claudeHookReport(settingsPath, hookScope(ctx, loc)) : null;
  const wereConnected = ["installed", "partial"].includes(hooksBefore?.state);

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
    mkdirSync(target.dir, { recursive: true });
    writeFileSync(join(target.dir, "SKILL.md"), skillText(sourceDir, installDir, platform));
    writeJson(join(target.dir, SKILL_MARKER), { product: PRODUCT, installRoot: installDir });
    installedSkills.push(target);
  }
  for (const old of loc.marker?.skills || []) {
    if (!installedSkills.some((item) => samePath(item.dir, old.dir, platform))) removeSkill(old.dir, installDir, platform);
  }

  let claudeHooks = { installed: false, settingsPath };
  if (wantHooks) {
    installClaudeHooks(hookOptions(ctx, loc));
    claudeHooks = { installed: true, settingsPath };
    messages.push(`Connected Claude Code: added Goblin Horde hooks to ${settingsPath} (a backup of the previous file is beside it). New Claude Code sessions will appear; restart open ones. To disconnect: node "${join(installDir, "goblin.mjs")}" hooks remove`);
  } else {
    // Only an explicit "no" removes hooks; without a choice the settings are only read, and changed
    // only to repair hooks of this installation that already name a missing Node.
    if (flags.claudeHooks === false) {
      for (const path of new Set([settingsPath, loc.marker?.claudeHooks?.settingsPath].filter(Boolean))) {
        const removed = uninstallClaudeHooks({ settingsPath: path, ...hookScope(ctx, loc) });
        if (removed.removed) messages.push(`Removed Goblin Horde hooks from ${path}.`);
      }
    }
    if (flags.claudeHooks === undefined) {
      // Hooks connected from the widget are not in the marker; keep them working after a Node move.
      const repaired = repairHooks(ctx, loc);
      if (repaired) messages.push(repaired);
      else messages.push(`Claude Code is not connected. To show Claude Code sessions, run: node "${join(installDir, "goblin.mjs")}" hooks install (it adds Goblin Horde hook entries to your Claude Code settings; "hooks remove" takes them out).`);
    }
  }
  // A "no" is remembered, so a later setup asks with "no" as its default.
  if (wantHooks) claudeHooks.declined = false;
  else claudeHooks.declined = flags.claudeHooks === false || Boolean(loc.marker?.claudeHooks?.declined);

  const version = JSON.parse(readFileSync(join(sourceDir, "package.json"), "utf8")).version || "";
  // From 0.6 the hook records more than tool names. Someone who connected it before should hear that once.
  if (wereConnected && flags.claudeHooks !== false && versionBefore(loc.marker?.version, "0.6.0") && !versionBefore(version, "0.6.0"))
    messages.push(`Claude Code stays connected, and from this version its hook also records redacted commands, prompt excerpts, questions, and todo lists on this computer; to disconnect, run: node "${join(installDir, "goblin.mjs")}" hooks remove`);
  writeJson(join(installDir, MARKER), {
    product: PRODUCT, schema: 2, version, installRoot: installDir, stateDir, port: loc.port, files,
    skills: installedSkills, skillDirectory: installedSkills.find((item) => item.agent === "codex")?.dir || "",
    claudeHooks, nodePath: ctx.nodePath, ...(widgetPythons(loc).length ? { widgetPythons: widgetPythons(loc) } : {}), installedAt: loc.marker?.installedAt || new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  messages.unshift(`Installed Goblin Horde ${version} at ${installDir}`);
  // A Start Menu entry to open it again; a sign-in shortcut only when asked for (or already there, refreshed).
  // There is one entry of each name: one that runs another Goblin Horde copy is that copy's, and stays.
  const shortcuts = shortcutPaths({ platform, env: ctx.env });
  const manager = `node "${join(installDir, "goblin.mjs")}"`;
  if (shortcuts) {
    const spec = (surface) => shortcutSpec({ nodePath: ctx.nodePath, installDir, surface });
    const free = (link) => !ctx.exists(link) || ownsShortcut(link, installDir);
    try {
      if (free(shortcuts.menu)) {
        ctx.writeShortcut(shortcuts.menu, spec(""), { env: ctx.env });
        messages.push("Added Goblin Horde to the Start menu.");
      } else {
        messages.push(`The Start menu's Goblin Horde entry opens another Goblin Horde copy, so it was left as it is. Start this copy with: ${manager} start`);
      }
      if (flags.autostart === true && !free(shortcuts.startup)) {
        messages.push(`Another Goblin Horde copy already starts when you sign in to Windows, so its shortcut was left as it is. To start this copy instead: ${manager} autostart on`);
      } else if (flags.autostart === true || (flags.autostart !== false && ctx.exists(shortcuts.startup) && ownsShortcut(shortcuts.startup, installDir))) {
        ctx.writeShortcut(shortcuts.startup, spec("strip"), { env: ctx.env });
        messages.push("Goblin Horde starts as the goblin strip when you sign in to Windows (turn it off from the ⋯ menu or with: node goblin.mjs autostart off).");
      }
    } catch (error) {
      messages.push(`Could not add the Start menu entry (${error.message}); start it with: ${manager} start`);
    }
    if (flags.autostart === false && ownsShortcut(shortcuts.startup, installDir)) removeShortcut(shortcuts.startup);
  }
  let started = null;
  if (!flags.noStart) started = await start(ctx, { ...flags, installDir, stateDir: flags.stateDir });
  else messages.push("Not started (--no-start). Start it later with: node goblin.mjs start");
  return { installDir, stateDir, files: files.length, skills: installedSkills, claudeHooks, started, messages,
    startMenu: Boolean(shortcuts && ctx.exists(shortcuts.menu) && ownsShortcut(shortcuts.menu, installDir)) };
}

/**
 * State files the app owns; a full reset removes these and nothing else. Every file the viewer,
 * the widget, and the Claude Code hook write in the state folder is named here: the widget's
 * settings (and an unreadable copy it set aside), the pairing code and phone choice, watched chats,
 * dismissed alerts, party links, recorded Claude Code activity, extension feeds, and run files.
 */
export function stateFiles(stateDir) {
  const files = ["goblins.json", "goblins.json.unreadable", "pairing-code.txt", "phone.json", "watched.json", "dismissed.json", "links.json",
    join("claude", "activity.jsonl"), join("claude", "activity.1.jsonl"),
    join("run", RUN_FILE), join("run", "server.log"), join("run", WIDGET_LOG), join("run", SHOW_REQUEST)].map((name) => join(stateDir, name));
  const feeds = extensionFeedDir(stateDir);
  for (const entry of listFeedFiles(feeds, { feeds: 1000 })) for (const file of entry.files) files.push(join(feeds, file.name));
  return files;
}

export async function uninstall(ctx, flags = {}) {
  const loc = locate(ctx, flags);
  const { installDir, stateDir } = loc;
  if (!loc.marker) throw new ManagerError(`No Goblin Horde installation was found at ${installDir}.`, { code: "NOT_INSTALLED" });
  const options = { env: ctx.env, platform: ctx.platform, ...(ctx.home ? { home: ctx.home } : {}) };
  if (isUnsafeTarget(installDir, options)) throw new ManagerError(`Refusing to remove files from ${installDir}.`);
  // Check every Claude settings file before changing anything, so a broken file stops the removal cleanly.
  const settingsPaths = [...new Set([loc.marker.claudeHooks?.settingsPath, claudeSettingsPath(loc.claudeDir)].filter(Boolean))];
  const hooksRecorded = Boolean(loc.marker.claudeHooks?.installed);
  const readable = [];
  const messages = [];
  for (const path of settingsPaths) {
    try { readClaudeSettings(path); readable.push(path); }
    catch (error) {
      if (!(error instanceof HookSettingsError)) throw error;
      if (hooksRecorded) throw new ManagerError(`${error.message} Goblin Horde was not removed, so its hooks can still be taken out once the file is fixed.`);
      messages.push(`Did not check ${path} for hooks: ${error.message}`);
    }
  }
  const stopped = await stop(ctx, flags, loc);
  if (stopped.stopped) messages.push(`Stopped ${stopped.stopped} Goblin Horde ${stopped.stopped === 1 ? "process" : "processes"}.`);
  const shortcuts = shortcutPaths({ platform: ctx.platform, env: ctx.env });
  // Only shortcuts that run this installation are removed; another copy's stay.
  for (const link of shortcuts ? [shortcuts.menu, shortcuts.startup] : []) {
    if (ctx.exists(link) && ownsShortcut(link, installDir)) { removeShortcut(link); messages.push(`Removed ${link === shortcuts.startup ? "the sign-in shortcut" : "the Start menu entry"}.`); }
  }
  // Only this installation's own entries go; another installation sharing the settings keeps its hooks.
  for (const path of readable) {
    const removed = uninstallClaudeHooks({ settingsPath: path, ...hookScope(ctx, loc) });
    if (removed.removed) messages.push(`Removed ${removed.removed} Goblin Horde hook ${removed.removed === 1 ? "entry" : "entries"} from ${path}; other settings were kept.`);
  }
  const skills = [...(loc.marker.skills || []), ...(loc.marker.skillDirectory ? [{ dir: loc.marker.skillDirectory }] : [])];
  for (const skill of skills) if (skill?.dir && removeSkill(skill.dir, installDir, ctx.platform)) messages.push(`Removed the manager skill at ${skill.dir}.`);

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
  try { rmdirSync(installDir); } catch { messages.push(`Some files you added remain in ${installDir}; they were left alone.`); }
  messages.unshift(`Removed Goblin Horde from ${installDir}`);

  if (flags.removeSettings) {
    for (const file of stateFiles(stateDir)) { try { unlinkSync(file); } catch { /* Not there. */ } }
    for (const dir of ["claude", "feeds", "run"]) { try { rmdirSync(join(stateDir, dir)); } catch { /* Not empty or missing. */ } }
    try { rmdirSync(stateDir); } catch { /* Other files remain. */ }
    // The Windows predecessor's settings, only when using the default state folder.
    if (ctx.platform === "win32" && loc.defaultState && ctx.env.LOCALAPPDATA) {
      const legacy = join(ctx.env.LOCALAPPDATA, "ActivityLens");
      for (const name of ["goblins.json", "pairing-code.txt"]) { try { unlinkSync(join(legacy, name)); } catch { /* Not there. */ } }
      try { rmdirSync(legacy); } catch { /* Not empty or missing. */ }
    }
    messages.push("Removed Goblin Horde settings, the pairing code, watched chats, dismissed alerts, party links, and recorded activity.");
  } else {
    for (const name of [RUN_FILE, "server.log", WIDGET_LOG, SHOW_REQUEST]) { try { unlinkSync(join(stateDir, "run", name)); } catch { /* Not there. */ } }
    try { rmdirSync(join(stateDir, "run")); } catch { /* Not empty or missing. */ }
    messages.push(`Kept settings and the pairing code in ${stateDir}. Use --remove-settings for a full reset.`);
  }
  return { messages };
}

// ---------------------------------------------------------------------------------------------
// Claude Code hooks on their own

/**
 * Start Goblin Horde when the person signs in to Windows, or stop doing so. Only a sign-in shortcut
 * that runs this installation counts as on, and only that one is ever removed. Signing in starts
 * the goblin strip only; the Horde window opens from the strip or the Start menu.
 */
export function autostart(ctx, flags = {}, enable) {
  const shortcuts = shortcutPaths({ platform: ctx.platform, env: ctx.env });
  if (!shortcuts) throw new ManagerError("Starting at sign-in is available on Windows only.", { code: "UNSUPPORTED" });
  const loc = locate(ctx, flags);
  const present = ctx.exists(shortcuts.startup);
  const ours = present && ownsShortcut(shortcuts.startup, loc.installDir);
  if (enable === undefined) return { enabled: ours, message: ours ? "Goblin Horde starts when you sign in to Windows."
    : present ? "Another Goblin Horde copy starts at sign-in; this one does not." : "Goblin Horde does not start at sign-in." };
  if (enable) {
    if (!loc.marker) throw new ManagerError("Install Goblin Horde first.", { code: "NOT_INSTALLED" });
    ctx.writeShortcut(shortcuts.startup, shortcutSpec({ nodePath: ctx.nodePath, installDir: loc.installDir, surface: "strip" }), { env: ctx.env });
    return { enabled: true, message: "Goblin Horde will start when you sign in to Windows." };
  }
  if (present && !ours) return { enabled: false, message: "The sign-in shortcut runs another Goblin Horde copy, so it was left alone." };
  removeShortcut(shortcuts.startup);
  return { enabled: false, message: "Goblin Horde will no longer start at sign-in." };
}

export function hooksInstall(ctx, flags = {}) {
  const loc = locate(ctx, flags);
  if (!loc.marker) throw new ManagerError(`Install Goblin Horde first; the hook must point at an installed receiver (${loc.installDir}).`, { code: "NOT_INSTALLED" });
  const result = installClaudeHooks(hookOptions(ctx, loc));
  writeJson(join(loc.installDir, MARKER), { ...loc.marker, claudeHooks: { installed: true, settingsPath: result.settingsPath }, updatedAt: new Date().toISOString() });
  return { ...result, message: result.changed ? `Connected Claude Code in ${result.settingsPath}. New Claude Code sessions will appear; restart open ones.`
    : `Claude Code was already connected in ${result.settingsPath}.` };
}

export function hooksRemove(ctx, flags = {}) {
  const loc = locate(ctx, flags);
  const paths = [...new Set([claudeSettingsPath(loc.claudeDir), loc.marker?.claudeHooks?.settingsPath].filter(Boolean))];
  let removed = 0;
  for (const path of paths) removed += uninstallClaudeHooks({ settingsPath: path, ...hookScope(ctx, loc) }).removed;
  // Disconnecting is a choice setup remembers, like answering "no" there.
  if (loc.marker) writeJson(join(loc.installDir, MARKER), { ...loc.marker, claudeHooks: { installed: false, settingsPath: paths[0], declined: true }, updatedAt: new Date().toISOString() });
  return { removed, message: removed ? `Removed ${removed} Goblin Horde hook ${removed === 1 ? "entry" : "entries"}; other Claude Code settings were kept.` : "No Goblin Horde hooks were found." };
}

export function hooksStatus(ctx, flags = {}) {
  const loc = locate(ctx, flags);
  return claudeHookReport(claudeSettingsPath(loc.claudeDir), hookScope(ctx, loc));
}
