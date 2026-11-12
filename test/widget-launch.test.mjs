/**
 * Starting the desktop goblins, with every program and process faked: no Python runs, no window opens,
 * and every folder is temporary.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WIDGET_READY, WIDGET_UNAVAILABLE_EXIT, doctor, findPythonTk, install, launchWidget, makeContext, readManifest, start, uninstall } from "../lib/manager.mjs";

const sourceDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const PYTHONW = "C:\\Python\\pythonw.exe";

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
const launch = (spawn, loc, waitMs = 5000) => launchWidget(makeContext({ platform: "win32", env: {}, spawn }), loc, PYTHONW, "instance-1", { waitMs });

test("start waits for the widget's ready line, keeps its output in widget.log, and passes it only --port", async () => {
  const box = folders();
  try {
    const fake = fakeSpawn({ output: `${WIDGET_READY}\n`, pid: 77 });
    const result = await launch(fake.spawn, box.loc, 2000);
    assert.deepEqual(result, { ok: true, pid: 77, message: "The desktop goblins are running." });
    const [call] = fake.calls;
    assert.equal(call.command, PYTHONW);
    assert.deepEqual(call.args, [join(box.loc.installDir, "desktop_widget.py"), "--port", "43999"]);
    assert.equal(call.options.env.GOBLIN_HORDE_STATE_DIR, box.loc.stateDir);
    assert.equal(call.options.env.PORT, "43999");
    assert.equal(call.options.detached, true);
    assert.ok(Array.isArray(call.options.stdio), "pythonw writes to the log, not nowhere");
    assert.equal(call.options.windowsHide, true);
    assert.equal(readFileSync(join(box.loc.stateDir, "run", "widget.log"), "utf8"), `${WIDGET_READY}\n`);
  } finally { box.cleanup(); }
});

test("a widget that cannot draw transparent windows, or crashes, is reported with its reason, and nothing else is opened", async () => {
  const box = folders();
  try {
    const reason = "Transparent desktop goblins are unavailable: couldn't connect to display";
    const unavailable = await launch(fakeSpawn({ output: `${reason}\n`, exitCode: WIDGET_UNAVAILABLE_EXIT }).spawn, box.loc);
    assert.deepEqual([unavailable.ok, unavailable.pid], [false, 0]);
    assert.ok(unavailable.message.startsWith(`${reason} Nothing was opened.`), unavailable.message);
    const crashed = await launch(fakeSpawn({ output: "ModuleNotFoundError: No module named 'goblin_cues'\n", exitCode: 1 }).spawn, box.loc);
    assert.equal(crashed.ok, false);
    assert.match(crashed.message, /stopped while starting: ModuleNotFoundError: No module named 'goblin_cues'\. Nothing was opened\./);
    assert.ok(crashed.message.includes(join(box.loc.stateDir, "run", "widget.log")));
    const refused = await launchWidget(makeContext({ platform: "win32", env: {}, spawn: () => { throw new Error("spawn EACCES"); } }), box.loc, PYTHONW, "i");
    assert.deepEqual(refused, { ok: false, pid: 0, message: "The desktop goblins could not start (spawn EACCES), so nothing was opened." });
  } finally { box.cleanup(); }
});

test("a widget that reports ready and then crashes before the next check is not counted as running", async () => {
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
    const result = await launch(spawn, box.loc);
    assert.deepEqual([result.ok, result.pid], [false, 0]);
    assert.match(result.message, /stopped while starting: RuntimeError: boom/);
  } finally { box.cleanup(); }
});

test("a slow widget that is still alive is kept", async () => {
  const box = folders();
  try {
    assert.deepEqual(await launch(fakeSpawn().spawn, box.loc, 0), { ok: true, pid: 4242, message: "The desktop goblins are still starting." });
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
    listProcesses: () => [], log: () => {},
  });
  return { ctx, probed };
}

test("python.org Python is found through the py launcher when python is not on PATH", () => {
  const { ctx, probed } = windows({ onPath: { py: PY_LAUNCHER, pyw: "C:\\Windows\\pyw.exe", python: STORE_STUB } });
  assert.equal(findPythonTk(ctx), REAL_PYTHONW);
  assert.deepEqual(probed, [[PY_LAUNCHER, "-3", "-c", "import sys, tkinter; print(sys.executable)"]]);
});

test("pythonw on PATH is still preferred, and the Microsoft Store stub is never run", () => {
  const onPath = { pythonw: REAL_PYTHONW, py: PY_LAUNCHER, python: STORE_STUB };
  const { ctx, probed } = windows({ onPath });
  assert.equal(findPythonTk(ctx), REAL_PYTHONW);
  assert.deepEqual(probed.map(([file]) => file), [REAL_PYTHON]);
  const stubOnly = windows({ onPath: { python: STORE_STUB, python3: STORE_STUB }, files: [STORE_STUB] });
  assert.equal(findPythonTk(stubOnly.ctx), "");
  assert.deepEqual(stubOnly.probed, [], "the stub opens the Store; it is never run");
});

test("no widget is found when the launcher's Python has no Tkinter", () => {
  const { ctx } = windows({ onPath: { py: PY_LAUNCHER }, tk: false });
  assert.equal(findPythonTk(ctx), "");
});

test("doctor with only py on PATH finds the Python; without Python it says what to install", async () => {
  const root = "C:\\nonexistent-goblin-horde-test\\you";
  const flags = { installDir: `${root}\\app`, stateDir: `${root}\\state`, port: 43997 };
  const env = { CLAUDE_CONFIG_DIR: `${root}\\.claude`, CODEX_HOME: `${root}\\.codex`, LOCALAPPDATA: `${root}\\local`, GOBLIN_SHARED_LOOPBACK: "45123" };
  const found = await doctor({ ...windows({ onPath: { py: PY_LAUNCHER } }).ctx, env, home: root }, flags);
  const ok = found.checks.find((check) => check.name === "pets-python");
  assert.equal(ok.state, "ok");
  assert.ok(ok.detail.includes(REAL_PYTHONW), ok.detail);
  const none = (await doctor({ ...windows().ctx, env, home: root }, flags)).checks.find((check) => check.name === "pets-python");
  assert.equal(none.state, "missing");
  assert.match(none.detail, /python\.org/);
  assert.match(none.detail, /"Add python\.exe to PATH" is not needed/);
  assert.match(none.detail, /Start menu/);
});

function installedComputer(root, { python = { py: PY_LAUNCHER } } = {}) {
  const home = join(root, "home");
  const flags = { installDir: join(root, "app"), stateDir: join(root, "state"), port: 43996, skipSkill: true };
  const env = { PATH: process.env.PATH, Path: process.env.Path, PATHEXT: process.env.PATHEXT, SystemRoot: process.env.SystemRoot,
    LOCALAPPDATA: join(root, "local"), APPDATA: join(root, "roaming"), CLAUDE_CONFIG_DIR: join(home, "claude-config"), CODEX_HOME: join(home, "codex-home") };
  // The server is listed as already running, so start launches only the widget; ids are far above real ones.
  const procs = [{ pid: 999_999_981, command: `"${process.execPath}" "${join(flags.installDir, "server.mjs")}"`, started: "s" }];
  const spawned = [];
  const shortcuts = [];
  const base = windows({ onPath: python }).ctx;
  const ctx = makeContext({
    ...base, env, home, sourceDir, nodePath: process.execPath,
    listProcesses: () => procs.slice(),
    // A stand-in for the Windows shortcut writer: a file that names its target, as a real .lnk does.
    writeShortcut: (link, spec) => {
      shortcuts.push(spec.args);
      mkdirSync(dirname(link), { recursive: true });
      writeFileSync(link, Buffer.from(`${spec.target} ${spec.args}`, "utf16le"));
    },
    exists: (path) => base.exists(path) || existsSync(path),
    spawn: (command, args, options) => {
      spawned.push({ command, args });
      writeSync(options.stdio[1], `${WIDGET_READY}\n`);
      procs.push({ pid: 999_999_982, command: `"${command}" "${args[0]}" ${args.slice(1).join(" ")}`, started: "w" });
      const child = new EventEmitter();
      child.pid = 999_999_982;
      child.unref = () => {};
      return child;
    },
  });
  return { ctx, flags, env, spawned, shortcuts };
}

test("start with only the py launcher on PATH launches the desktop goblins with the pythonw beside the real Python, once", async () => {
  const root = mkdtempSync(join(tmpdir(), "goblin-py-launcher-"));
  try {
    const box = installedComputer(root);
    await install(box.ctx, { ...box.flags, noStart: true });
    const result = await start(box.ctx, box.flags);
    assert.equal(result.widget, 999_999_982);
    assert.equal(result.reason, "");
    assert.deepEqual(box.spawned.map((call) => [call.command, ...call.args.slice(1)]), [[REAL_PYTHONW, "--port", "43996"]]);
    assert.ok(result.messages.includes("The desktop goblins are running."), result.messages.join("\n"));
    assert.equal(existsSync(join(box.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Goblin Horde.lnk")), false, "nothing starts at sign-in");
    assert.equal(box.shortcuts.length, 1, "only install's Start menu entry was written");
    // A second start (the Start menu entry, say) leaves the running widget as it is.
    const again = await start(box.ctx, box.flags);
    assert.equal(box.spawned.length, 1);
    assert.equal(again.widget, 999_999_982);
    assert.ok(again.messages.includes("The desktop goblins are already running."), again.messages.join("\n"));
    assert.equal(existsSync(join(box.flags.stateDir, "run", "show-widget")), false, "no window is asked to come forward");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("start without Python says the desktop goblins did not start and that nothing was opened, and keeps the server", async () => {
  const root = mkdtempSync(join(tmpdir(), "goblin-no-python-"));
  try {
    const box = installedComputer(root, { python: {} });
    await install(box.ctx, { ...box.flags, noStart: true });
    const result = await start(box.ctx, box.flags);
    assert.deepEqual([result.widget, result.server], [null, 999_999_981]);
    assert.deepEqual(box.spawned, []);
    assert.match(result.reason, /^Python with Tkinter was not found, so the desktop goblins did not start and nothing was opened\. Install Python 3 from python\.org/);
    assert.ok(result.messages.includes(result.reason));
    const run = JSON.parse(readFileSync(join(box.flags.stateDir, "run", "goblin-horde.json"), "utf8"));
    assert.deepEqual([run.server, run.widget], [{ pid: 999_999_981 }, null]);
  } finally { rmSync(root, { recursive: true, force: true }); }
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
    const ctx = makeContext({ env, home, sourceDir, log: () => {}, listProcesses: () => [] });
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

test("every Python module the widget imports ships with it", () => {
  const files = readManifest(sourceDir);
  const shipped = new Set(files.filter((file) => file.endsWith(".py")));
  for (const file of ["desktop_widget.py", "desktop_platform.py", "pet_field.py"]) assert.ok(shipped.has(file), file);
  // Follow the imports from the entry point: a local module that is not listed would fail at start.
  const pending = ["desktop_widget.py"];
  const seen = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    assert.ok(shipped.has(file), `${file} is imported by the widget but not in package-files.json`);
    const text = readFileSync(join(sourceDir, file), "utf8");
    // UTF-8 read back as Windows-1252 turns "…" into "â€¦" and "·" into "Â·" on screen.
    assert.doesNotMatch(text, /â€|Â·|â‹/, `${file} has mis-encoded characters`);
    for (const [, name] of text.matchAll(/^\s*(?:from|import)\s+([A-Za-z_][A-Za-z0-9_]*)/gm))
      if (existsSync(join(sourceDir, `${name}.py`))) pending.push(`${name}.py`);
  }
  assert.ok(seen.size >= 10, "the widget's own modules were followed");
  assert.deepEqual([...shipped].filter((file) => !seen.has(file)), [], "and every module that ships is one the widget imports");
  for (const gone of ["stream_windows.py", "goblin_parting.py", "party_layout.py"]) assert.ok(!shipped.has(gone), gone);
});
