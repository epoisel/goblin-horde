/**
 * The desktop goblins on macOS, with every program and process faked: no Python runs, no window
 * opens, and every folder is temporary. This pins what the manager does on a Mac; it does not
 * replace trying the widget on one (README, "macOS smoke check").
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { MARKER, SHOW_REQUEST, WIDGET_READY, WIDGET_UNAVAILABLE_EXIT, doctor, findMacPythonTk, findPythonTk, install, launchWidget, makeContext, readManifest, start, status, stop, uninstall } from "../lib/manager.mjs";
import { ownedScript } from "../lib/processes.mjs";

const sourceDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const FRAMEWORK = "/Library/Frameworks/Python.framework/Versions/Current/bin/python3";
const CLT = "/Library/Developer/CommandLineTools/usr/bin/python3";

/** A Mac with the given python3 programs (path -> Tk version, or "" for no Tkinter). */
function mac({ pythons = {}, onPath = "", files = [] } = {}) {
  const probed = [];
  const ctx = makeContext({
    platform: "darwin",
    which: (name) => (name === "python3" ? onPath : ""),
    exists: (path) => path in pythons || files.includes(path),
    probe: (file) => { probed.push(file); return pythons[file] ? `${pythons[file]}\n` : ""; },
    listProcesses: () => [], openUrl: () => {}, log: () => {},
  });
  return { ctx, probed };
}

test("macOS uses the python3 on PATH when its Tkinter has Tk 8.6 or newer", () => {
  const { ctx } = mac({ pythons: { "/opt/homebrew/bin/python3": "8.6", [FRAMEWORK]: "9.0" }, onPath: "/opt/homebrew/bin/python3" });
  assert.deepEqual(findMacPythonTk(ctx), { python: "/opt/homebrew/bin/python3", tkVersion: "8.6" });
  assert.equal(findPythonTk(ctx), "/opt/homebrew/bin/python3");
});

test("macOS skips a Python without Tkinter or with Tk 8.5 and says why when none fits", () => {
  const { ctx } = mac({ pythons: { "/usr/local/bin/python3": "", [FRAMEWORK]: "8.5" } });
  const found = findMacPythonTk(ctx);
  assert.equal(found.python, "");
  assert.match(found.reason, /Tk 8\.5/);
  assert.match(found.reason, /8\.6 or newer/);
  assert.equal(findPythonTk(ctx), "");
});

test("macOS never runs Apple's python3 stub when the Command Line Tools are missing", () => {
  const without = mac({ pythons: { "/usr/bin/python3": "8.6" }, onPath: "/usr/bin/python3" });
  assert.equal(findMacPythonTk(without.ctx).python, "");
  assert.equal(without.probed.includes("/usr/bin/python3"), false, "running the stub would ask to install developer tools");
  const withTools = mac({ pythons: { "/usr/bin/python3": "8.6" }, files: [CLT] });
  assert.equal(findMacPythonTk(withTools.ctx).python, "/usr/bin/python3");
});

test("Linux still has no desktop widget", () => {
  const ctx = makeContext({ platform: "linux", which: () => "/usr/bin/python3", exists: () => true, probe: () => "8.6" });
  assert.equal(findPythonTk(ctx), "");
});

function folders() {
  const root = mkdtempSync(join(tmpdir(), "goblin-widget-"));
  const loc = { installDir: join(root, "app"), stateDir: join(root, "state"), port: 43999, claudeDir: join(root, "claude") };
  return { root, loc, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A fake child: writes `output` to its stdout file as the widget would, then maybe exits. */
function fakeSpawn({ output = "", exitCode = null, pid = 4242 } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    if (output && Array.isArray(options.stdio)) writeSync(options.stdio[1], output);
    const child = new EventEmitter();
    child.pid = pid;
    child.unref = () => {};
    if (exitCode !== null) setImmediate(() => child.emit("exit", exitCode));
    return child;
  };
  return { spawn, calls };
}

test("macOS start waits for the widget's ready line and records its process", async () => {
  const box = folders();
  try {
    const fake = fakeSpawn({ output: `${WIDGET_READY}\n` });
    const ctx = makeContext({ platform: "darwin", env: {}, spawn: fake.spawn });
    const result = await launchWidget(ctx, box.loc, FRAMEWORK, "instance-1", { waitMs: 2000 });
    assert.deepEqual(result, { ok: true, pid: 4242, message: "The desktop goblins are running." });
    const [call] = fake.calls;
    assert.equal(call.command, FRAMEWORK);
    assert.deepEqual(call.args, [join(box.loc.installDir, "desktop_widget.py"), "--port", "43999"]);
    assert.equal(call.options.env.GOBLIN_HORDE_STATE_DIR, box.loc.stateDir);
    assert.equal(call.options.detached, true);
  } finally { box.cleanup(); }
});

test("macOS start falls back to the browser and says why when transparency is unavailable", async () => {
  const box = folders();
  try {
    const reason = "Transparent desktop goblins are unavailable: This Python uses an x11 Tk; the transparent widget needs the native macOS (Aqua) Tk.";
    const fake = fakeSpawn({ output: `${reason}\n`, exitCode: WIDGET_UNAVAILABLE_EXIT });
    const ctx = makeContext({ platform: "darwin", env: {}, spawn: fake.spawn });
    const result = await launchWidget(ctx, box.loc, FRAMEWORK, "instance-1", { waitMs: 5000 });
    assert.equal(result.ok, false);
    assert.equal(result.pid, 0);
    assert.ok(result.message.startsWith(reason), result.message);
    assert.match(result.message, /browser viewer/);
    assert.ok(result.message.includes(join(box.loc.stateDir, "run", "widget.log")));
  } finally { box.cleanup(); }
});

test("macOS start reports a widget that crashed while starting", async () => {
  const box = folders();
  try {
    const fake = fakeSpawn({ output: "Traceback (most recent call last):\nRuntimeError: boom\n", exitCode: 1 });
    const ctx = makeContext({ platform: "darwin", env: {}, spawn: fake.spawn });
    const result = await launchWidget(ctx, box.loc, FRAMEWORK, "instance-1", { waitMs: 5000 });
    assert.equal(result.ok, false);
    assert.match(result.message, /stopped while starting: RuntimeError: boom/);
  } finally { box.cleanup(); }
});

test("a macOS widget that reports ready and then crashes before the next check is not counted as running", async () => {
  const box = folders();
  try {
    const log = join(box.loc.stateDir, "run", "widget.log");
    const spawn = () => {
      const child = new EventEmitter();
      child.pid = 4242;
      child.unref = () => {};
      // Both happen between two checks: the ready line, then the crash.
      setTimeout(() => appendFileSync(log, `${WIDGET_READY}\nRuntimeError: boom\n`), 20);
      setTimeout(() => child.emit("exit", 1), 40);
      return child;
    };
    const ctx = makeContext({ platform: "darwin", env: {}, spawn });
    const result = await launchWidget(ctx, box.loc, FRAMEWORK, "instance-1", { waitMs: 5000 });
    assert.equal(result.ok, false);
    assert.equal(result.pid, 0);
    assert.match(result.message, /stopped while starting: RuntimeError: boom/);
    assert.match(result.message, /browser viewer/);
  } finally { box.cleanup(); }
});

test("a slow macOS widget that is still alive is kept, not replaced by the browser", async () => {
  const box = folders();
  try {
    const ctx = makeContext({ platform: "darwin", env: {}, spawn: fakeSpawn().spawn });
    const result = await launchWidget(ctx, box.loc, FRAMEWORK, "instance-1", { waitMs: 0 });
    assert.deepEqual(result, { ok: true, pid: 4242, message: "The desktop goblins are still starting." });
  } finally { box.cleanup(); }
});

test("Windows start waits for the widget's ready line and keeps its output in widget.log", async () => {
  const box = folders();
  try {
    const fake = fakeSpawn({ output: `${WIDGET_READY}\n`, pid: 77 });
    const ctx = makeContext({ platform: "win32", env: {}, spawn: fake.spawn });
    const result = await launchWidget(ctx, box.loc, "C:\\Python\\pythonw.exe", "instance-1", { waitMs: 2000 });
    assert.deepEqual(result, { ok: true, pid: 77, message: "The desktop goblins are running." });
    assert.ok(Array.isArray(fake.calls[0].options.stdio), "pythonw writes to the log, not nowhere");
    assert.equal(fake.calls[0].options.windowsHide, true);
    assert.equal(readFileSync(join(box.loc.stateDir, "run", "widget.log"), "utf8"), `${WIDGET_READY}\n`);
  } finally { box.cleanup(); }
});

test("Windows start falls back to the browser, saying why, when the widget exits or crashes", async () => {
  const box = folders();
  try {
    const reason = "Transparent desktop goblins are unavailable: couldn't connect to display";
    const unavailable = await launchWidget(makeContext({ platform: "win32", env: {}, spawn: fakeSpawn({ output: `${reason}\n`, exitCode: WIDGET_UNAVAILABLE_EXIT }).spawn }),
      box.loc, "C:\\Python\\pythonw.exe", "instance-1", { waitMs: 5000 });
    assert.equal(unavailable.ok, false);
    assert.ok(unavailable.message.startsWith(reason), unavailable.message);
    assert.match(unavailable.message, /browser viewer/);
    const crashed = await launchWidget(makeContext({ platform: "win32", env: {}, spawn: fakeSpawn({ output: "ModuleNotFoundError: No module named 'goblin_cues'\n", exitCode: 1 }).spawn }),
      box.loc, "C:\\Python\\pythonw.exe", "instance-1", { waitMs: 5000 });
    assert.equal(crashed.ok, false);
    assert.match(crashed.message, /stopped while starting: ModuleNotFoundError/);
    assert.ok(crashed.message.includes(join(box.loc.stateDir, "run", "widget.log")));
  } finally { box.cleanup(); }
});

// A default python.org install: "Add python.exe to PATH" unticked, so only the launcher is on PATH.
const PY_LAUNCHER = "C:\\Windows\\py.exe";
const REAL_PYTHON = "C:\\Users\\you\\AppData\\Local\\Programs\\Python\\Python313\\python.exe";
const REAL_PYTHONW = "C:\\Users\\you\\AppData\\Local\\Programs\\Python\\Python313\\pythonw.exe";
const STORE_STUB = "C:\\Users\\you\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe";

function windows({ onPath = {}, files = [REAL_PYTHON, REAL_PYTHONW], tk = true } = {}) {
  const probed = [];
  const ctx = makeContext({
    platform: "win32", env: {},
    which: (name) => onPath[name] || "",
    exists: (path) => files.includes(path),
    probe: (file, args) => {
      probed.push([file, ...args]);
      if (file === STORE_STUB) return "Python was not found; run without arguments to install from the Microsoft Store\n";
      return tk && (file === PY_LAUNCHER || file === REAL_PYTHON) ? `${REAL_PYTHON}\r\n` : "";
    },
    listProcesses: () => [], openUrl: () => {}, log: () => {},
  });
  return { ctx, probed };
}

test("Windows finds python.org Python through the py launcher when python is not on PATH", () => {
  const { ctx, probed } = windows({ onPath: { py: PY_LAUNCHER, pyw: "C:\\Windows\\pyw.exe", python: STORE_STUB } });
  assert.equal(findPythonTk(ctx), REAL_PYTHONW);
  assert.deepEqual(probed, [[PY_LAUNCHER, "-3", "-c", "import sys, tkinter; print(sys.executable)"]]);
});

test("Windows still prefers pythonw on PATH, and never runs the Microsoft Store stub", () => {
  const onPath = { pythonw: REAL_PYTHONW, py: PY_LAUNCHER, python: STORE_STUB };
  const { ctx, probed } = windows({ onPath });
  assert.equal(findPythonTk(ctx), REAL_PYTHONW);
  assert.deepEqual(probed.map(([file]) => file), [REAL_PYTHON]);
  const stubOnly = windows({ onPath: { python: STORE_STUB, python3: STORE_STUB }, files: [STORE_STUB] });
  assert.equal(findPythonTk(stubOnly.ctx), "");
  assert.deepEqual(stubOnly.probed, [], "the stub opens the Store; it is never run");
});

test("Windows reports no widget when the launcher's Python has no Tkinter", () => {
  const { ctx } = windows({ onPath: { py: PY_LAUNCHER }, tk: false });
  assert.equal(findPythonTk(ctx), "");
});

test("doctor with only py on PATH shows the desktop widget available; without Python it says what to install", async () => {
  const root = "C:\\nonexistent-goblin-horde-test\\you";
  const flags = { installDir: `${root}\\app`, stateDir: `${root}\\state`, port: 43997 };
  const env = { CLAUDE_CONFIG_DIR: `${root}\\.claude`, CODEX_HOME: `${root}\\.codex`, LOCALAPPDATA: `${root}\\local` };
  const found = await doctor({ ...windows({ onPath: { py: PY_LAUNCHER } }).ctx, env, home: root }, flags);
  const ok = found.checks.find((check) => check.name === "desktop-widget");
  assert.equal(ok.state, "ok");
  assert.ok(ok.detail.includes(REAL_PYTHONW), ok.detail);
  const none = (await doctor({ ...windows().ctx, env, home: root }, flags)).checks.find((check) => check.name === "desktop-widget");
  assert.equal(none.state, "missing");
  assert.match(none.detail, /python\.org/);
  assert.match(none.detail, /"Add python\.exe to PATH" is not needed/);
  assert.match(none.detail, /Start menu/);
});

test("start with only the py launcher on PATH launches the desktop goblins with the pythonw beside the real Python", { skip: process.platform !== "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "goblin-py-launcher-"));
  try {
    const home = join(root, "home");
    const flags = { installDir: join(root, "app"), stateDir: join(root, "state"), port: 43996, skipSkill: true };
    const env = { PATH: process.env.PATH, Path: process.env.Path, PATHEXT: process.env.PATHEXT, SystemRoot: process.env.SystemRoot,
      LOCALAPPDATA: join(root, "local"), CLAUDE_CONFIG_DIR: join(home, "claude-config"), CODEX_HOME: join(home, "codex-home") };
    const serverCommand = `"${process.execPath}" "${join(flags.installDir, "server.mjs")}"`;
    // The viewer is listed as already running, so start launches only the widget; ids are far above real ones.
    const procs = [{ pid: 999_999_981, command: serverCommand, started: "s" }];
    const spawned = [];
    const opened = [];
    const base = windows({ onPath: { py: PY_LAUNCHER } }).ctx;
    const ctx = makeContext({
      ...base, env, home, sourceDir, nodePath: process.execPath,
      listProcesses: () => procs.slice(), openUrl: (url) => opened.push(url), writeShortcut: () => {},
      exists: (path) => base.exists(path) || existsSync(path),
      spawn: (command, args, options) => {
        spawned.push({ command, args });
        writeSync(options.stdio[1], `${WIDGET_READY}\n`);
        procs.push({ pid: 999_999_982, command: `"${command}" "${args[0]}" --port 43996`, started: "w" });
        const child = new EventEmitter();
        child.pid = 999_999_982;
        child.unref = () => {};
        return child;
      },
    });
    await install(ctx, { ...flags, noStart: true });
    const result = await start(ctx, flags);
    assert.equal(result.ui, "widget");
    assert.deepEqual(spawned.map((call) => call.command), [REAL_PYTHONW]);
    assert.deepEqual(opened, []);
    // A second start (the Start menu entry, say) asks the running widget to come forward instead.
    const again = await start(ctx, flags);
    assert.equal(spawned.length, 1);
    assert.match(again.messages.join("\n"), /already running; they will come to the front/);
    assert.ok(existsSync(join(flags.stateDir, "run", SHOW_REQUEST)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("doctor on macOS names the Python it will use, or what to install", async () => {
  // Doctor only reads. These macOS-style folders do not exist on any test computer, so nothing is found or written.
  const mac = "/nonexistent-goblin-horde-test/Users/you";
  const flags = { installDir: `${mac}/app`, stateDir: `${mac}/state`, port: 43998 };
  const env = { CLAUDE_CONFIG_DIR: `${mac}/.claude`, CODEX_HOME: `${mac}/.codex` };
  const base = { platform: "darwin", env, home: mac, listProcesses: () => [], log: () => {} };
  const found = await doctor(makeContext({ ...base, which: (name) => (name === "python3" ? FRAMEWORK : ""),
    exists: (path) => path === FRAMEWORK, probe: () => "8.6\n" }), flags);
  const ok = found.checks.find((check) => check.name === "desktop-widget");
  assert.equal(ok.state, "ok");
  assert.match(ok.detail, /Tk 8\.6/);
  const missing = await doctor(makeContext({ ...base, which: () => "", exists: () => false, probe: () => "" }), flags);
  const none = missing.checks.find((check) => check.name === "desktop-widget");
  assert.equal(none.state, "missing");
  assert.match(none.detail, /python\.org|Homebrew/);
  assert.match(none.detail, /browser viewer/);
});

test("macOS framework Python running the widget from Application Support is this installation's", () => {
  const installDir = "/Users/you/Library/Application Support/GoblinHorde/app";
  const python = "/Library/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python";
  assert.equal(ownedScript(`${python} ${installDir}/desktop_widget.py --port 43917`, installDir, { platform: "darwin" }), "desktop_widget.py");
  assert.equal(ownedScript(`/opt/homebrew/bin/python3 ${installDir}/desktop_widget.py`, installDir, { platform: "darwin" }), "desktop_widget.py");
  assert.equal(ownedScript(`${python} /tmp/other/desktop_widget.py`, installDir, { platform: "darwin" }), "");
});

test("uninstall removes the widget's start log with the other run files", async () => {
  const root = mkdtempSync(join(tmpdir(), "goblin-widget-log-"));
  try {
    const home = join(root, "home");
    const claudeDir = join(home, "claude-config");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "settings.json"), "{}\n");
    const env = { PATH: process.env.PATH, Path: process.env.Path, PATHEXT: process.env.PATHEXT, SystemRoot: process.env.SystemRoot,
      LOCALAPPDATA: join(root, "local"), CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: join(home, "codex-home") };
    const ctx = makeContext({ env, home, sourceDir, log: () => {}, listProcesses: () => [], openUrl: () => {} });
    const flags = { installDir: join(root, "app"), stateDir: join(root, "state"), noStart: true };
    await install(ctx, flags);
    const log = join(flags.stateDir, "run", "widget.log");
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(log, "GOBLIN_HORDE_WIDGET_READY\n");
    await uninstall(ctx, flags);
    assert.equal(existsSync(log), false);
    assert.equal(existsSync(join(flags.stateDir, "run")), false);
    assert.ok(existsSync(flags.stateDir), "settings stay without --remove-settings");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The macOS life cycle with a Python under a home folder with spaces. Processes are a fake list;
// their ids are far above any real process id, so stop never signals anything on this computer.
const SPACED_PYTHON = "/Users/Jane Smith/.pyenv/versions/3.13.3/bin/python3";
const FAKE_PIDS = { server: 999_999_993, widget: 999_999_991 };

function spacedMac(root, { shown = SPACED_PYTHON } = {}) {
  const home = join(root, "home");
  const flags = { installDir: join(root, "Application Support", "GoblinHorde", "app"), stateDir: join(root, "state"), port: 43987, skipSkill: true };
  const env = { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: join(home, "claude-config"), CODEX_HOME: join(home, "codex-home") };
  const widgetCommand = `${shown} ${posix.join(flags.installDir, "desktop_widget.py")} --port ${flags.port}`;
  const procs = [{ pid: FAKE_PIDS.server, command: `/usr/local/bin/node ${posix.join(flags.installDir, "server.mjs")}`, started: "s" }];
  const spawned = [];
  const opened = [];
  const ctx = makeContext({
    platform: "darwin", env, home, sourceDir, log: () => {},
    which: (name) => (name === "python3" ? SPACED_PYTHON : ""),
    exists: (path) => path === SPACED_PYTHON,
    probe: () => "8.6\n",
    listProcesses: () => procs.slice(),
    openUrl: (url) => opened.push(url),
    spawn: (command, args, options) => {
      spawned.push({ command, args });
      writeSync(options.stdio[1], `${WIDGET_READY}\n`);
      procs.push({ pid: FAKE_PIDS.widget, command: widgetCommand, started: "w" });
      const child = new EventEmitter();
      child.pid = FAKE_PIDS.widget;
      child.unref = () => {};
      return child;
    },
  });
  const marker = () => JSON.parse(readFileSync(join(flags.installDir, MARKER), "utf8"));
  return { ctx, flags, procs, spawned, opened, widgetCommand, marker };
}

for (const [label, shown] of [["the Python it ran", SPACED_PYTHON],
  ["the framework Python.app ps shows instead", "/Users/Jane Smith/Py Builds/Python.framework/Versions/3.13/Resources/Python.app/Contents/MacOS/Python"]]) {
  test(`macOS start, status, install, and uninstall find a widget run by a Python under a folder with spaces (${label})`, async (t) => {
    if (process.platform === "win32") { t.skip("macOS paths need a POSIX file system for the temporary installation."); return; }
    const root = mkdtempSync(join(tmpdir(), "goblin-spaced-python-"));
    try {
      const mac = spacedMac(root, { shown });
      await install(mac.ctx, { ...mac.flags, noStart: true });
      const first = await start(mac.ctx, mac.flags);
      assert.equal(first.ui, "widget");
      assert.equal(first.widget, FAKE_PIDS.widget);
      assert.deepEqual(mac.spawned.map((call) => call.command), [SPACED_PYTHON]);
      assert.deepEqual(mac.opened, [], "the desktop goblins are up, so no browser fallback");
      assert.ok(mac.marker().widgetPythons.includes(SPACED_PYTHON));
      assert.ok(mac.marker().widgetPythons.includes(shown));

      assert.equal((await status(mac.ctx, mac.flags)).widget?.pid, FAKE_PIDS.widget);
      const again = await start(mac.ctx, mac.flags);
      assert.equal(mac.spawned.length, 1, "a repeated start does not launch a second widget");
      assert.ok(again.messages.includes("The desktop goblins are already running; they will come to the front."));

      const updated = await install(mac.ctx, { ...mac.flags, noStart: true });
      assert.ok(updated.messages.includes("Stopped the running copy to update it."));
      assert.deepEqual(mac.marker().widgetPythons, [shown, SPACED_PYTHON].filter((item, index, list) => list.indexOf(item) === index),
        "reinstall keeps the recorded Pythons");

      const stopped = await stop(mac.ctx, mac.flags);
      assert.equal(stopped.stopped, 2, "the fake processes are still listed, so stop finds the server and the widget");
      const removed = await uninstall(mac.ctx, mac.flags);
      assert.ok(removed.messages.includes("Stopped 2 Goblin Horde processes."));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("macOS start adopts a widget an older manager started from a Python with spaces instead of launching another", async (t) => {
  if (process.platform === "win32") { t.skip("macOS paths need a POSIX file system for the temporary installation."); return; }
  const root = mkdtempSync(join(tmpdir(), "goblin-spaced-python-"));
  try {
    const mac = spacedMac(root);
    await install(mac.ctx, { ...mac.flags, noStart: true });
    assert.equal(mac.marker().widgetPythons, undefined);
    mac.procs.push({ pid: FAKE_PIDS.widget, command: mac.widgetCommand, started: "w" });
    assert.equal((await status(mac.ctx, mac.flags)).widget, null, "unrecorded, a path with spaces is not claimed");
    const result = await start(mac.ctx, mac.flags);
    assert.equal(mac.spawned.length, 0);
    assert.equal(result.widget, FAKE_PIDS.widget);
    assert.deepEqual(mac.marker().widgetPythons, [SPACED_PYTHON]);
    assert.equal((await stop(mac.ctx, mac.flags)).stopped, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the platform layer ships with the widget", () => {
  const files = readManifest(sourceDir);
  for (const file of ["desktop_widget.py", "desktop_platform.py", "stream_windows.py"]) assert.ok(files.includes(file), file);
});
