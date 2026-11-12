/**
 * Doctor's pet game group on invented computers. The Node.js version, T3 Code's database, and Python
 * are faked, and every folder is one that exists nowhere, so nothing here runs Python, reads a real T3
 * database, or touches this computer's settings. The last test reads a temporary fixture database.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { doctor, makeContext } from "../lib/manager.mjs";
import { defaultT3Path, openT3 } from "../lib/t3-source.mjs";
import { main } from "../goblin.mjs";
import { TRAP, createT3Fixture, hasSqlite } from "./helpers/t3-fixture.mjs";

const HOME = "C:\\nonexistent-goblin-horde-test\\you";
const T3 = `${HOME}\\t3\\statev2.sqlite`;
const PY_LAUNCHER = "C:\\Windows\\py.exe";
const PYTHON = "C:\\Python313\\python.exe";
const PYTHONW = "C:\\Python313\\pythonw.exe";
const FLAGS = { installDir: `${HOME}\\app`, stateDir: `${HOME}\\state`, port: 43994 };
const ARGV = ["--install-dir", FLAGS.installDir, "--state-dir", FLAGS.stateDir, "--port", String(FLAGS.port)];
const SCHEMA_DRIFT = { ok: false, reason: "schema", message: "This T3 Code version has no turns.status in its database, so counting stopped until Goblin Horde is updated to match it." };
const BUSY = { ok: false, reason: "locked", message: "T3 Code's database is busy right now, so Goblin Horde will try again on the next check." };

/**
 * A Windows computer: `node` is its Node.js version, `python` whether Python with Tkinter is installed,
 * and `t3` what opening T3 Code's database answers (null when the file is not there).
 */
function windows({ node = "22.13.0", python = true, t3 = { ok: true }, t3Path = T3, env = { GOBLIN_T3_DB: T3 } } = {}) {
  const seen = { opened: [], closed: 0, lines: [] };
  const ctx = makeContext({
    platform: "win32", home: HOME, log: (line) => seen.lines.push(line), listProcesses: () => [],
    env: { CLAUDE_CONFIG_DIR: `${HOME}\\.claude`, CODEX_HOME: `${HOME}\\.codex`, LOCALAPPDATA: `${HOME}\\local`, ...env },
    nodeVersion: () => node,
    which: (name) => (python && name === "py" ? PY_LAUNCHER : ""),
    exists: (path) => (python && [PYTHON, PYTHONW].includes(path)) || (t3 !== null && path === t3Path),
    probe: () => (python ? `${PYTHON}\r\n` : ""),
    openT3: async (path) => {
      seen.opened.push(path);
      return t3.ok ? { ok: true, db: { close: () => { seen.closed += 1; } } } : t3;
    },
  });
  return { ctx, seen };
}

const pets = (report) => Object.fromEntries(report.checks.filter((check) => check.group === "pets").map((check) => [check.name, check]));

test("on a Windows computer with everything the pet game needs, the pets group says so and leaves the database closed", async () => {
  const box = windows();
  const group = pets(await doctor(box.ctx, FLAGS));
  assert.deepEqual(Object.keys(group), ["pets-node", "pets-t3", "pets-python"]);
  for (const check of Object.values(group)) assert.equal(check.state, "ok", check.name);
  assert.match(group["pets-node"].detail, /Node\.js 22\.13\.0/);
  assert.ok(group["pets-t3"].detail.includes(T3), group["pets-t3"].detail);
  assert.match(group["pets-t3"].detail, /read-only/);
  assert.ok(group["pets-python"].detail.includes(PYTHONW), group["pets-python"].detail);
  assert.deepEqual(box.seen.opened, [T3], "GOBLIN_T3_DB names the database, as it does for the viewer");
  assert.equal(box.seen.closed, 1);
});

test("without GOBLIN_T3_DB, doctor looks for T3 Code's database in its usual place under the home folder", async () => {
  const usual = defaultT3Path(HOME);
  const box = windows({ env: {}, t3Path: usual });
  assert.equal(pets(await doctor(box.ctx, FLAGS))["pets-t3"].state, "ok");
  assert.deepEqual(box.seen.opened, [usual]);
});

test("a Node.js older than 22.13 is a warning that says what still runs, and never changes doctor's exit code", async () => {
  for (const [node, state] of [["20.11.1", "warning"], ["22.12.0", "warning"], ["22.13.0", "ok"], ["24.1.0", "ok"]]) {
    const report = await doctor(windows({ node }).ctx, FLAGS);
    assert.equal(pets(report)["pets-node"].state, state, node);
    assert.equal(report.checks.find((check) => check.name === "node").state, "ok", `${node} still runs the game`);
  }
  const old = windows({ node: "20.11.1" });
  const warning = pets(await doctor(old.ctx, FLAGS))["pets-node"].detail;
  assert.match(warning, /Node\.js 20\.11\.1 runs the game/);
  assert.match(warning, /pays no coins for AI work until Node\.js 22\.13 or newer/);
  assert.equal(await main(["doctor", ...ARGV], old.ctx), 0);
  assert.ok(old.seen.lines.some((line) => line.startsWith("  ! pets-node")), old.seen.lines.join("\n"));
  // The one check that decides the exit code is the manager's own Node.js check.
  assert.equal(await main(["doctor", ...ARGV], windows({ node: "18.19.0" }).ctx), 2);
});

test("a missing, busy, or unrecognized T3 Code database is reported in a plain sentence and exits 0", async () => {
  const missing = windows({ t3: null });
  const absent = pets(await doctor(missing.ctx, FLAGS))["pets-t3"];
  assert.equal(absent.state, "missing");
  assert.ok(absent.detail.includes(T3), absent.detail);
  assert.match(absent.detail, /Open T3 Code once on this computer/);
  assert.deepEqual(missing.seen.opened, [], "there is nothing to open");
  assert.equal(await main(["doctor", ...ARGV], missing.ctx), 0);

  const drifted = pets(await doctor(windows({ t3: SCHEMA_DRIFT }).ctx, FLAGS))["pets-t3"];
  assert.deepEqual([drifted.state, drifted.detail], ["error", SCHEMA_DRIFT.message]);
  const busy = pets(await doctor(windows({ t3: BUSY }).ctx, FLAGS))["pets-t3"];
  assert.deepEqual([busy.state, busy.detail], ["warning", BUSY.message]);
  assert.equal(await main(["doctor", ...ARGV], windows({ t3: SCHEMA_DRIFT }).ctx), 0);
});

test("without Python and Tkinter the pets group says what to install", async () => {
  const report = await doctor(windows({ python: false }).ctx, FLAGS);
  const check = pets(report)["pets-python"];
  assert.equal(check.state, "missing");
  assert.match(check.detail, /the desktop goblins need it/);
  assert.match(check.detail, /python\.org/);
});

test("doctor prints the pets group under its own heading", async () => {
  const box = windows({ node: "20.11.1", t3: null });
  assert.equal(await main(["doctor", ...ARGV], box.ctx), 0);
  const heading = box.seen.lines.indexOf("  Pet game:");
  assert.ok(heading > box.seen.lines.findIndex((line) => line.includes(" install ")), box.seen.lines.join("\n"));
  assert.deepEqual(box.seen.lines.slice(heading + 1, heading + 4).map((line) => line.trim().split(/\s+/).slice(0, 2).join(" ")),
    ["! pets-node", "✗ pets-t3", "✓ pets-python"]);
});

test("on macOS and Linux every command but help says the pet game runs on Windows only, and reads or changes nothing", async () => {
  const home = "/nonexistent-goblin-horde-test/Users/you";
  const argv = ["--install-dir", `${home}/app`, "--state-dir", `${home}/state`, "--port", String(FLAGS.port)];
  for (const platform of ["darwin", "linux"]) {
    const touched = [];
    const lines = [];
    const note = (what) => (...args) => { touched.push([what, ...args]); throw new Error(`${what} was called`); };
    const ctx = makeContext({ platform, home, sourceDir: home, env: {}, log: (line) => lines.push(line), listProcesses: note("listProcesses"), which: note("which"),
      exists: note("exists"), probe: note("probe"), nodeVersion: note("nodeVersion"), openT3: note("openT3"), spawn: note("spawn"), writeShortcut: note("writeShortcut"),
      runTailscale: note("runTailscale") });
    for (const command of ["doctor", "install", "start", "status", "stop", "uninstall", "pets-host"]) {
      await assert.rejects(main([command, ...argv], ctx), (error) => error.name === "ManagerError"
        && error.message === `Goblin Horde's pet game runs on Windows only, and this computer runs ${platform}. Nothing was checked or changed.`, `${platform} ${command}`);
    }
    assert.deepEqual(touched, [], `${platform}: nothing was looked at, run, or written`);
    assert.equal(await main(["help"], ctx), 0, "help still prints");
    assert.match(lines.join("\n"), /on Windows/);
  }
});

test("doctor opens a real T3 Code database read-only, closes it, and prints nothing that was in it",
  { skip: !hasSqlite && "this Node.js has no node:sqlite" }, async () => {
    for (const [omit, state] of [[[], "ok"], [["orchestration_v2_projection_provider_turns.status"], "error"]]) {
      const fixture = createT3Fixture({ omit });
      try {
        if (!omit.length) fixture.addTurn({ id: "t1", completedAt: Date.now() - 60_000 });
        const base = windows().ctx;
        const ctx = { ...base, env: { ...base.env, GOBLIN_T3_DB: fixture.path }, exists: (path) => base.exists(path) || existsSync(path), openT3 };
        const report = await doctor(ctx, FLAGS);
        assert.equal(pets(report)["pets-t3"].state, state, pets(report)["pets-t3"].detail);
        for (const secret of Object.values(TRAP)) assert.ok(!JSON.stringify(report).includes(secret), "nothing from the database leaves doctor");
      } finally {
        // Windows refuses to remove a database that is still open, so this also proves doctor closed it.
        fixture.close();
      }
      assert.equal(existsSync(fixture.dir), false);
    }
  });
