#!/usr/bin/env node
/**
 * The team ZIP installed from a clean folder, in a sandbox: unzip it, run its own `doctor` and `install`,
 * load the pet game from the installed copy, run the installed viewer without its window, share its game with a
 * second installed copy over a loopback stand-in for Tailscale, and uninstall.
 *
 *   node scripts/dev/clean-install.mjs [--zip path/to/GoblinHorde-Team.zip] [--keep]
 *
 * Everything lives in one temp folder: the unzipped package, the app folder, the state folder, a stand-in
 * home, app-data, Claude and Codex folders, and a fixture T3 database that GOBLIN_T3_DB names. The manager
 * runs with those folders as flags and as its environment, so the real Goblin Horde state, ~/.claude,
 * ~/.codex, ~/.t3 and Start menu are never read or written. GOBLIN_SHARED_LOOPBACK makes the shared game's
 * listener a loopback one, so Tailscale is never asked and nothing listens off 127.0.0.1. No widget is started:
 * the pet game's Python modules are imported and built on a hidden Tk root. Exits 1 when any check fails. --keep
 * leaves the folder.
 *
 * Needs Node.js 22.13 or newer and, for the Python step, a Python with Tkinter.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createT3Fixture, hasSqlite } from "../../test/helpers/t3-fixture.mjs";

const SOURCE = fileURLToPath(new URL("../..", import.meta.url));
const SKILL = "goblin-horde-manager";
const OPEN_MS = 20_000;
const PAY_MS = 10_000;

// Every pet game module, loaded from the installed copy and put to work without a window on screen.
const PYTHON_CHECK = `
import glob, importlib, json, os, tkinter as tk
here = os.getcwd()
names = sorted(os.path.splitext(name)[0] for name in glob.glob("*.py"))
wanted = [name for name in names if name.startswith(("pet_", "pets_")) or name in ("goblin_look", "desktop_windows")]
modules = {name: importlib.import_module(name) for name in wanted}
elsewhere = [name for name, module in modules.items() if os.path.dirname(os.path.abspath(module.__file__)) != here]
root = tk.Tk()
root.withdraw()
world = modules["pet_world"].World(1920, 1080, 1040, unit=2, seed=7)
world.set_horde(40)
for _ in range(60):
    world.step(1 / 30)
art, boss = modules["pet_art"], modules["pet_boss"]
sprites, bosses = art.PetSprites(root), boss.PetBossImages(root)
goblin = sprites.image(modules["goblin_look"].look_for(0), next(iter(art.FRAMES)), 0, 2)
ogre = bosses.image(0, next(iter(boss.POSE_FRAMES)), 0, 2)
drawn = len(world.frame().draws)
started = world.start_battle(None, 0, True, 1.5)
events = []
for _ in range(3600):
    events += [name for name, _detail in world.step(1 / 30)]
    if "battle_over" in events:
        break
print(json.dumps({"modules": wanted, "elsewhere": elsewhere, "tk": str(root.getvar("tk_patchLevel")), "shown": world.shown, "drawn": drawn,
                  "goblin": [goblin.width(), goblin.height()], "boss": [ogre.width(), ogre.height()],
                  "battle": bool(started), "battleOver": "battle_over" in events,
                  "windows": len(modules["desktop_windows"].snapshot())}))
root.destroy()
`;

const failures = [];
const say = (line = "") => console.log(line);
function check(ok, what) {
  say(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
}

async function freePort() {
  const probe = createServer(() => {});
  await new Promise((done) => probe.listen(0, "127.0.0.1", done));
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}

/** Every file under `dir`, as forward-slash paths relative to it. */
function filesUnder(dir, prefix = "") {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory()
    ? filesUnder(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]));
}

function unzip(zip, into) {
  const [tool, args] = process.platform === "win32" ? [join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"), ["-xf", zip, "-C", into]]
    : ["unzip", ["-q", zip, "-d", into]];
  const done = spawnSync(tool, args, { encoding: "utf8" });
  if (done.status !== 0) throw new Error(`Could not unzip ${zip}: ${done.stderr || done.error?.message}`);
}

async function main() {
  const { values } = parseArgs({ options: { zip: { type: "string" }, keep: { type: "boolean" } } });
  const zip = resolve(values.zip || join(SOURCE, "dist", "GoblinHorde-Team.zip"));
  if (!existsSync(zip)) throw new Error(`${zip} is missing. Build it with: node scripts/package.mjs`);
  if (!hasSqlite) throw new Error(`The clean install check needs Node.js 22.13 or newer (this is ${process.versions.node}).`);

  const root = mkdtempSync(join(tmpdir(), "goblin-clean-install-"));
  const dir = Object.fromEntries(["package", "app", "state", "home", "roaming", "local", "claude", "codex", "codex-skill", "t3", "display-app", "display-state"]
    .map((name) => [name, join(root, name)]));
  for (const name of ["package", "home", "roaming", "local", "claude", "codex"]) mkdirSync(dir[name]);
  const fixture = createT3Fixture({ dir: dir.t3 });
  const port = await freePort();
  const [sharedPort, displayPort] = [await freePort(), await freePort()];
  // A second installed copy with its own state folder stands for the other computer, the one that shows the game.
  const displayFlags = ["--install-dir", dir["display-app"], "--state-dir", dir["display-state"], "--claude-config-dir", dir.claude, "--codex-home", dir.codex,
    "--port", String(displayPort)];
  const flags = ["--install-dir", dir.app, "--state-dir", dir.state, "--claude-config-dir", dir.claude, "--codex-home", dir.codex,
    "--codex-skill-dir", dir["codex-skill"], "--port", String(port)];
  const env = { ...process.env, USERPROFILE: dir.home, HOME: dir.home, APPDATA: dir.roaming, LOCALAPPDATA: dir.local, GOBLIN_T3_DB: fixture.path,
    CODEX_CLI_PATH: join(root, "no-codex.exe"), ORCA_CLI_COMMAND: join(root, "no-orca"), LAN_IP: "10.255.255.254", GOBLIN_SHARED_LOOPBACK: String(sharedPort) };
  for (const name of ["GOBLIN_HORDE_INSTALL_DIR", "GOBLIN_HORDE_STATE_DIR", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CODEX_VIEWER_THREAD_ID", "PORT"]) delete env[name];
  const shortcuts = join(dir.roaming, "Microsoft", "Windows", "Start Menu", "Programs");

  const copies = { [dir.app]: "the installed copy", [dir["display-app"]]: "the second installed copy" };
  /** Run a manager from `folder` with `its` folders and port, print what it said, and return { status, out }. */
  const manager = (its, folder, ...args) => {
    say(`\n$ node goblin.mjs ${args.join(" ").replaceAll(root, "<sandbox>")}   (in ${copies[folder] || "the unzipped package"})`);
    const done = spawnSync(process.execPath, [join(folder, "goblin.mjs"), ...args, ...its], { cwd: folder, env, encoding: "utf8", windowsHide: true });
    const out = `${done.stdout || ""}${done.stderr || ""}`;
    for (const line of out.trimEnd().split(/\r?\n/)) say(`    ${line.replaceAll(root, "<sandbox>")}`);
    say(`    exit ${done.status}`);
    return { status: done.status, out };
  };
  const goblin = (folder, ...args) => manager(flags, folder, ...args);
  const petsAt = (at) => async () => {
    try { return await (await fetch(`http://127.0.0.1:${at}/api/pets`)).json(); } catch { return null; }
  };
  const pets = petsAt(port);
  const until = async (ms, ready, read = pets) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
      const answer = await read();
      if (answer && ready(answer)) return answer;
    }
    return null;
  };

  /**
   * The running installed copy becomes a host, and a second installed copy joins it and shows its game. The
   * sandbox host's own pairing-code.txt is the code file handed to pets-join, and the code is read here only to
   * check that no command printed it.
   */
  async function sharedGame() {
    say("\nA shared game, over a loopback stand-in for Tailscale");
    const source = join(dir.package, "GoblinHorde");
    const display = (...args) => manager(displayFlags, dir["display-app"], ...args);
    const where = `127.0.0.1:${sharedPort}`;
    const enabled = goblin(dir.app, "pets-host", "enable");
    check(enabled.status === 0 && enabled.out.includes(`Shared game host: on, listening at ${where}.`), "pets-host enable opens the listener of the running copy");
    check(/Login check: off\. This is the loopback stand-in/.test(enabled.out), "it says the login check is off for the stand-in");
    check(manager([...displayFlags, "--skip-skill"], source, "install", "--no-claude-hooks", "--no-start").status === 0, "a second copy installs beside the first");
    const joined = display("pets-join", "--host", where, "--code-file", join(dir.state, "pairing-code.txt"));
    check(joined.status === 0 && /^Joined\./.test(joined.out), "pets-join checks the host and saves its two files");
    const code = readFileSync(join(dir.state, "pairing-code.txt"), "utf8").trim();
    check(code.length === 8 && ![enabled.out, joined.out].some((out) => out.includes(code)), "neither command printed the pairing code");
    check(display("start", "--ui", "none", "--no-browser").status === 0, "the second copy starts");
    const host = await pets();
    const shown = await until(OPEN_MS, (answer) => answer.ready, petsAt(displayPort));
    check(Boolean(shown) && shown.boot === host.boot && shown.game.state.wallet.coins === host.game.state.wallet.coins, "the second copy shows the first copy's game");
    fixture.addTurn({ id: "shared-turn", completedAt: Date.now() });
    const paid = await until(PAY_MS, (answer) => answer.ready && answer.game.state.wallet.coins > host.game.state.wallet.coins, petsAt(displayPort));
    check(Boolean(paid), `a turn that finished on the host paid coins on the second copy${paid ? ` (${host.game.state.wallet.coins} to ${paid.game.state.wallet.coins})` : ""}`);
    check(!filesUnder(dir["display-state"]).some((file) => /^pets/.test(file)), "the second copy keeps no saved game and no lock of its own");
    check(/✓ shared-remote/.test(display("doctor").out), "the second copy's doctor says it is joined");
    const status = goblin(dir.app, "pets-host", "status");
    check(/Paired sessions: [1-9]/.test(status.out) && /Saved game: yes, with \d+ coins/.test(status.out) && !status.out.includes(code), "pets-host status counts the paired sessions and the saved game, without the code");
    check(display("pets-join", "--off").status === 0 && display("stop").status === 0, "the second copy leaves the shared game and stops");
    check(display("uninstall", "--remove-settings").status === 0 && filesUnder(dir["display-state"]).length === 0, "the second copy uninstalls and leaves nothing behind");
    const off = goblin(dir.app, "pets-host", "disable");
    check(off.status === 0 && /Shared game host: off\./.test(off.out), "pets-host disable closes the listener");
    check(!(await fetch(`http://${where}/api/pets/whoami`).then(() => true, () => false)), "nothing listens on the stand-in's port any more");
  }

  try {
    say(`Sandbox: ${root}\nZIP: ${zip}`);
    unzip(zip, dir.package);
    const source = join(dir.package, "GoblinHorde");
    const manifest = JSON.parse(readFileSync(join(source, "package-files.json"), "utf8"));
    const unzipped = filesUnder(source);
    say("\nUnzip");
    check(unzipped.length === manifest.length && manifest.every((file) => unzipped.includes(file)), `the ZIP holds exactly the ${manifest.length} files package-files.json lists`);
    check(!unzipped.some((file) => /^(test|\.audit|dist)\//.test(file) || /pets\.json|goblins\.json|\.log$|__pycache__/.test(file)), "no tests, working notes, logs, or saved state came out of the ZIP");

    const doctor = goblin(source, "doctor");
    check(doctor.status === 0, "doctor exits 0");
    check(/✓ pets-t3/.test(doctor.out) && /✓ pets-node/.test(doctor.out), "doctor reads the sandbox T3 database and accepts this Node.js");

    const install = goblin(source, "install", "--no-claude-hooks", "--no-start");
    say("\nInstall");
    check(install.status === 0, "install exits 0");
    const installed = filesUnder(dir.app);
    check(manifest.every((file) => installed.includes(file)), "every listed file is in the app folder");
    check(installed.filter((file) => !manifest.includes(file)).join() === "goblin-horde-install.json", "the app folder holds nothing else but its install marker");
    check(existsSync(join(dir["codex-skill"], "SKILL.md")) && existsSync(join(dir.claude, "skills", SKILL, "SKILL.md")), "the manager skill is in the sandbox Codex and Claude folders");
    check(!existsSync(join(dir.claude, "settings.json")), "no Claude Code settings file was created");
    if (process.platform === "win32") {
      check(existsSync(join(shortcuts, "Goblin Horde.lnk")), "the Start menu entry is in the sandbox app-data folder");
      check(!existsSync(join(shortcuts, "Startup", "Goblin Horde.lnk")), "nothing starts at sign-in");
    }
    check(filesUnder(dir.home).length === 0 && filesUnder(dir.local).length === 0, "nothing was written to the stand-in home or local app-data folder");

    say("\nPython, from the installed copy");
    const { findPythonTk, makeContext } = await import(pathToFileURL(join(dir.app, "lib", "manager.mjs")).href);
    const widgetPython = findPythonTk(makeContext({ env }));
    check(Boolean(widgetPython), `the installed manager finds a Python with Tkinter${widgetPython ? ` (${widgetPython})` : ""}`);
    if (widgetPython) {
      // pythonw has no output to read, so the python.exe beside it runs the same modules.
      const python = process.platform === "win32" ? join(dirname(widgetPython), "python.exe") : widgetPython;
      const run = spawnSync(python, ["-c", PYTHON_CHECK], { cwd: dir.app, env, encoding: "utf8", windowsHide: true, timeout: 120_000 });
      let result = null;
      try { result = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1)); } catch { /* Reported below. */ }
      if (!result) say(`    ${(run.stderr || run.stdout || String(run.error || "")).trim().split(/\r?\n/).slice(-6).join("\n    ")}`);
      check(run.status === 0 && Boolean(result), "python imports every pet game module and builds the world and its images");
      if (result) {
        say(`    modules: ${result.modules.join(", ")}`);
        say(`    Tk ${result.tk}, ${result.drawn} goblins drawn, goblin image ${result.goblin.join("x")}, boss image ${result.boss.join("x")}, ${result.windows} window rectangles`);
        check(result.elsewhere.length === 0, "every module was loaded from the app folder");
        check(result.shown === 40 && result.drawn === 40 && result.goblin.every((side) => side > 0) && result.boss.every((side) => side > 0), "a World, a PetSprites image, and a PetBossImages image were built");
        check(result.battle && result.battleOver, "a boss battle ran to its end");
      }
    }

    say("\nThe installed viewer, without its window");
    const started = goblin(dir.app, "start", "--ui", "none", "--no-browser");
    check(started.status === 0, "start --ui none exits 0");
    const opened = await until(OPEN_MS, (answer) => answer.ready);
    check(Boolean(opened), "GET /api/pets says the game is open");
    if (opened) {
      const { wallet, horde } = opened.game.state;
      say(`    ${wallet.coins} coins, ${horde.size} goblins, source ${JSON.stringify(opened.source)}`);
      check(wallet.coins === 25 && horde.size === 3, "a new game starts with 25 coins and 3 goblins");
      check(opened.source.ok === true, "the viewer reads the sandbox T3 database");
      fixture.addTurn({ id: "clean-install-turn", completedAt: Date.now() });
      const paid = await until(PAY_MS, (answer) => answer.ready && answer.game.state.wallet.coins > wallet.coins);
      check(Boolean(paid), `a turn that finished in T3 Code paid coins${paid ? ` (${wallet.coins} to ${paid.game.state.wallet.coins})` : ""}`);
    }
    await sharedGame();
    const status = goblin(dir.app, "status");
    check(/Viewer: running/.test(status.out), "status says the viewer is running");
    const stopped = goblin(dir.app, "stop");
    check(stopped.status === 0 && /stopped \(1 process\)/.test(stopped.out), "stop ends the one viewer process");
    check((await pets()) === null, "the port is closed again");
    say(`    state folder now holds: ${filesUnder(dir.state).join(", ") || "(nothing)"}`);

    const removed = goblin(dir.app, "uninstall");
    say("\nUninstall");
    check(removed.status === 0, "uninstall exits 0");
    check(!existsSync(dir.app), "the app folder is gone");
    check(!existsSync(dir["codex-skill"]) && !existsSync(join(dir.claude, "skills")), "the manager skills are gone");
    check(!existsSync(join(shortcuts, "Goblin Horde.lnk")), "the Start menu entry is gone");
    const kept = filesUnder(dir.state);
    say(`    state folder keeps: ${kept.join(", ") || "(nothing)"}`);
    check(kept.includes("pets.json"), "the saved game is kept");

    say("\nFull reset");
    check(goblin(source, "install", "--no-claude-hooks", "--no-start").status === 0, "install again exits 0");
    check(goblin(dir.app, "uninstall", "--remove-settings").status === 0, "uninstall --remove-settings exits 0");
    const left = filesUnder(dir.state);
    check(left.length === 0, `the state folder is empty${left.length ? ` (left: ${left.join(", ")})` : ""}`);
    check(filesUnder(dir.home).length === 0 && filesUnder(dir.local).length === 0, "the stand-in home and local app-data folder are still empty");
  } finally {
    spawnSync(process.execPath, [join(dir["display-app"], "goblin.mjs"), "stop", ...displayFlags], { env, windowsHide: true });
    spawnSync(process.execPath, [join(dir.app, "goblin.mjs"), "stop", ...flags], { env, windowsHide: true });
    fixture.close();
    if (values.keep) say(`\nKept ${root}`);
    else rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  say(failures.length ? `\n${failures.length} check(s) failed:\n${failures.map((what) => `  ${what}`).join("\n")}` : "\nEvery check passed.");
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
