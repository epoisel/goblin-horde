/**
 * Updates end to end, as a person and the desktop goblins use them: a real installation of 0.6.0 in temporary
 * folders, releases signed with a key made for the test and served by a stand-in GitHub, and the real manager,
 * installs and servers in between. PATH holds only Node.js and PowerShell, so no desktop goblins open, and every
 * folder a manager could touch is inside the sandbox. Another process holds the saved game's lock throughout, as a
 * second Goblin Horde would, so no server ever opens pets.json, and its bytes show what the updates did to it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { MARKER, install, makeContext, readRun, stop } from "../lib/manager.mjs";
import { listProcesses } from "../lib/processes.mjs";
import {
  automaticRule, checkForUpdate, githubSources, keepInstalledFiles, readSettings, readSkip, takeApplyLock, updatePaths, workAt,
} from "../lib/updater.mjs";
import { main } from "../goblin.mjs";
import { fakeGitHub, makeRelease, packageCopy, testKey } from "./helpers/release-kit.mjs";
import { ask, freePort } from "./helpers/viewer.mjs";

const CONTENDER = fileURLToPath(new URL("./helpers/lock-contender.mjs", import.meta.url));
const SAVED = ["pets.json", "goblins.json", "shared.json"];

/** A sandbox computer with Goblin Horde `version` installed from a package that carries `kit`'s key. */
async function sandbox(t, kit) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "goblin-update-")));
  const dir = Object.fromEntries(["app", "state", "home", "local", "roaming", "claude", "codex", "releases"].map((name) => [name, join(root, name)]));
  for (const name of ["home", "local", "roaming", "claude", "codex", "releases"]) mkdirSync(dir[name], { recursive: true });
  const system = process.env.SystemRoot || "C:\\Windows";
  const env = {
    PATH: [dirname(process.execPath), join(system, "System32", "WindowsPowerShell", "v1.0")].join(";"), PATHEXT: process.env.PATHEXT, SystemRoot: system,
    windir: process.env.windir, TEMP: process.env.TEMP, TMP: process.env.TMP, USERPROFILE: dir.home, HOME: dir.home, LOCALAPPDATA: dir.local,
    APPDATA: dir.roaming, CLAUDE_CONFIG_DIR: dir.claude, CODEX_HOME: dir.codex, GOBLIN_T3_DB: join(root, "no-t3.sqlite"), GOBLIN_SHARED_LOOPBACK: "45123",
  };
  const lines = [];
  const github = { serve: null };
  const ctx = makeContext({ platform: "win32", env, home: dir.home, log: (line) => lines.push(line), updateKey: kit.key, listProcesses,
    sourceDir: packageCopy(join(dir.releases, "installed-0.6.0"), { version: "0.6.0", key: kit.key }),
    fetch: (...args) => github.serve.fetch(...args) });
  const flags = { installDir: dir.app, stateDir: dir.state, port: await freePort() };
  const argv = ["--install-dir", dir.app, "--state-dir", dir.state, "--port", String(flags.port)];
  t.after(async () => {
    // stop finds processes through a process listing, which comes back empty when it fails, so the processes the last
    // start recorded are ended by their ids too, and nothing that names the sandbox may still run before it goes.
    const recorded = [readRun(dir.state)?.server?.pid, readRun(dir.state)?.widget?.pid].filter(Boolean);
    await stop(ctx, flags).catch(() => {});
    const inSandbox = () => listProcesses().filter((item) => item.command.includes(root));
    const listed = listProcesses();
    for (const pid of recorded) {
      // When the listing works, an id is ended only while it still runs from the sandbox, never once another program has it.
      if (listed.length && !listed.some((item) => item.pid === pid && item.command.includes(root))) continue;
      try { process.kill(pid); } catch { /* Gone already. */ }
    }
    for (const end = Date.now() + 20_000; inSandbox().length && Date.now() < end;) await sleep(500);
    try { rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 }); } catch (error) {
      console.error(`Left ${root} behind (${error.code} on ${error.path}); still running there: ${inSandbox().map((item) => item.pid).join(", ") || "nothing"}.`);
    }
  });
  /** Run the manager's command line as a person would, with what it printed. */
  const run = async (...args) => {
    lines.length = 0;
    const code = await main([...args, ...argv], ctx).catch((error) => { lines.push(error.message); return error.exitCode || 1; });
    return { code, out: lines.join("\n") };
  };
  return { root, dir, env, ctx, flags, argv, run, github, port: flags.port };
}

/** Hold the saved game's lock from a process of its own, as another Goblin Horde would, until `release()`. */
async function holdSavedGame(t, stateDir) {
  mkdirSync(stateDir, { recursive: true });
  const holder = spawn(process.execPath, [CONTENDER, stateDir, "20000"], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  const said = createInterface({ input: holder.stdout });
  const next = () => new Promise((resolve) => said.once("line", resolve));
  assert.equal(await next(), "ready");
  holder.stdin.write("go\n");
  assert.equal(JSON.parse(await next()).ok, true, "the stand-in Goblin Horde holds the saved game");
  const release = () => { if (holder.exitCode === null) holder.stdin.end(); };
  t.after(release);
  return { release };
}

const health = async (port) => { try { return await (await fetch(`http://127.0.0.1:${port}/api/health`)).json(); } catch { return null; } };
async function waitFor(read, done, what, ms = 90_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
    const value = await read();
    if (done(value)) return value;
  }
  throw new Error(`Timed out waiting for ${what}.`);
}
const bytesOf = (stateDir) => Object.fromEntries([...SAVED, "pets.lock"].map((name) => [name, readFileSync(join(stateDir, name))]));
const marker = (box) => JSON.parse(readFileSync(join(box.dir.app, MARKER), "utf8"));
const kept = (box, name) => { try { return JSON.parse(readFileSync(join(updatePaths(box.dir.state)[name], "update.json"), "utf8")).version; } catch { return ""; } };
/** As the server's daily check does: keep the release GitHub serves now, when this computer takes it by itself. */
const serverCheck = (box, kit, installed) => checkForUpdate(box.dir.state, { key: kit.key, sources: githubSources(box.github.serve.fetch, installed),
  rule: automaticRule(installed, readSkip(box.dir.state)) });

test("update, the menu's update, rollback, a release that fails part way, and an apply cut short, on one installation", { timeout: 600_000 }, async (t) => {
  const kit = testKey();
  const box = await sandbox(t, kit);
  const releases = box.dir.releases;
  const v061 = makeRelease(releases, kit, "0.6.1", { change: (dir) => writeFileSync(join(dir, "README.md"), `${readFileSync(join(dir, "README.md"), "utf8")}\nRelease 0.6.1.\n`) });
  const v062 = makeRelease(releases, kit, "0.6.2");
  // 0.6.3 ships one more file, listed right after server.mjs. On this computer a folder stands where that file goes, so
  // its install stops part way: after it copied the files listed before it, README.md among them.
  const v063 = makeRelease(releases, kit, "0.6.3", { change: (dir) => {
    writeFileSync(join(dir, "README.md"), "# Goblin Horde 0.6.3, which never goes in\n");
    writeFileSync(join(dir, "lib", "blocker.mjs"), "// 0.6.3\n");
    const list = JSON.parse(readFileSync(join(dir, "package-files.json"), "utf8"));
    list.splice(list.indexOf("server.mjs") + 1, 0, "lib/blocker.mjs");
    writeFileSync(join(dir, "package-files.json"), `${JSON.stringify(list, null, 2)}\n`);
  } });

  await install(box.ctx, { ...box.flags, noStart: true });
  assert.equal(marker(box).version, "0.6.0");
  for (const [name, text] of [["pets.json", '{"schema":1,"coins":4321}\n'], ["goblins.json", '{"petScreen":1}\n'], ["shared.json", '{"enabled":false}\n']])
    writeFileSync(join(box.dir.state, name), text);
  const holder = await holdSavedGame(t, box.dir.state);
  const before = bytesOf(box.dir.state);

  assert.equal((await box.run("update", "--on")).code, 0);
  assert.equal(readSettings(box.dir.state).check, true);
  const off = await box.run("update", "--off");
  assert.equal(off.code, 0);
  assert.match(off.out, /no longer looks for releases by itself/);
  assert.equal(readSettings(box.dir.state).check, false, "every server started below stays off GitHub");

  box.github.serve = fakeGitHub({ manifest: v061.manifest, zip: v061.zip });
  const checked = await box.run("update", "--check");
  assert.equal(checked.code, 0);
  assert.match(checked.out, /Goblin Horde 0\.6\.1 is available, and its signature, size, SHA-256 and files check out/);
  assert.deepEqual(readdirSync(updatePaths(box.dir.state).root), ["settings.json"], "--check changes nothing");

  const updated = await box.run("update");
  assert.equal(updated.code, 0, updated.out);
  assert.match(updated.out, /Found Goblin Horde 0\.6\.1\. Its signature, size, SHA-256 and files check out\./);
  assert.match(updated.out, /Installing Goblin Horde 0\.6\.1 with its own manager:\n {2}Installed Goblin Horde 0\.6\.1 at /);
  assert.match(updated.out, /Updated Goblin Horde from 0\.6\.0 to 0\.6\.1\./);
  assert.deepEqual(box.github.serve.asked.map((request) => request.init.headers["User-Agent"]), Array(8).fill("GoblinHorde/0.6.0"));
  const after061 = await health(box.port);
  assert.deepEqual([after061?.version, after061?.installDir], ["0.6.1", box.dir.app], "0.6.1's server runs from the app folder");
  assert.equal(marker(box).version, "0.6.1");
  assert.match(readFileSync(join(box.dir.app, "README.md"), "utf8"), /Release 0\.6\.1\./);
  assert.deepEqual([kept(box, "installed"), kept(box, "previous")], ["0.6.1", ""], "0.6.0 came by hand, so there is nothing to go back to yet");
  assert.deepEqual(readdirSync(updatePaths(box.dir.state).ready), []);
  assert.equal(JSON.parse(readFileSync(updatePaths(box.dir.state).state, "utf8")).message, "Goblin Horde 0.6.1 is installed.",
    "the last check no longer says the release waits for the next start");
  assert.deepEqual(bytesOf(box.dir.state), before, "the saved game, the settings, the shared game's file and the lock are byte for byte as they were");

  // A server learns of a release that waits when it starts, and a plain start would put that release in place first, so
  // 0.6.1 starts again with --no-update to offer it from the menu.
  box.github.serve = fakeGitHub({ manifest: v062.manifest, zip: v062.zip });
  assert.equal((await serverCheck(box, kit, "0.6.1")).ok, true);
  assert.equal((await box.run("stop")).code, 0);
  const restarted = await box.run("start", "--no-update");
  assert.equal(restarted.code, 0, restarted.out);
  assert.equal((await health(box.port)).version, "0.6.1", "--no-update starts the installed version and leaves the waiting one");
  const pets = await waitFor(async () => (await ask(box.port, "GET", "/api/pets", { headers: { Host: `127.0.0.1:${box.port}` } })).body, (body) => body?.update, "the update field");
  assert.deepEqual(pets.update, { version: "0.6.2" });
  const running = await box.run("start");
  assert.match(running.out, /The game's server is already running/);
  assert.equal((await health(box.port)).version, "0.6.1", "a start while the game runs leaves the waiting release for later");
  assert.deepEqual(readdirSync(updatePaths(box.dir.state).ready), ["0.6.2"]);
  const own = { Host: `127.0.0.1:${box.port}`, Origin: `http://127.0.0.1:${box.port}`, "Content-Type": "application/json" };
  for (const [headers, why] of [[{ ...own, Origin: "http://evil.example" }, "a page on another site"], [{ ...own, Origin: undefined }, "no Origin"],
    [{ ...own, "Content-Type": "text/plain" }, "a plain form"], [{ ...own, Host: `evil.example:${box.port}` }, "another name for this computer"]]) {
    const refused = await ask(box.port, "POST", "/api/update/apply", { headers: Object.fromEntries(Object.entries(headers).filter(([, value]) => value)), body: {} });
    assert.equal(refused.status, 403, why);
  }
  assert.equal((await health(box.port)).version, "0.6.1", "nothing refused started an update");
  const applying = await ask(box.port, "POST", "/api/update/apply", { headers: own, body: {} });
  assert.deepEqual([applying.status, applying.body], [200, { applying: true, version: "0.6.2" }]);
  await waitFor(() => health(box.port), (answer) => answer?.version === "0.6.2", "0.6.2's server");
  const log = await waitFor(async () => { try { return readFileSync(join(box.dir.state, "run", "update.log"), "utf8"); } catch { return ""; } },
    (text) => /Updated Goblin Horde from 0\.6\.1 to 0\.6\.2\./.test(text), "the update log");
  assert.match(log, /Stopped the running copy to put Goblin Horde 0\.6\.2 in place\./);
  assert.deepEqual([kept(box, "installed"), kept(box, "previous")], ["0.6.2", "0.6.1"]);
  assert.deepEqual(bytesOf(box.dir.state), before);

  const back = await box.run("update", "--rollback");
  assert.equal(back.code, 0, back.out);
  assert.match(back.out, /Went back from Goblin Horde 0\.6\.2 to 0\.6\.1\./);
  assert.equal((await health(box.port)).version, "0.6.1");
  assert.deepEqual([kept(box, "installed"), kept(box, "previous")], ["0.6.1", ""]);
  assert.deepEqual([readSkip(box.dir.state)?.version, readSkip(box.dir.state)?.reason], ["0.6.2", "rollback"]);
  const again = await box.run("update", "--rollback");
  assert.equal(again.code, 1);
  assert.match(again.out, /No earlier version is kept on this computer/);
  const daily = await serverCheck(box, kit, "0.6.1");
  assert.deepEqual([daily.ok, daily.current], [false, true], "the daily check does not take 0.6.2 again");
  assert.deepEqual(readdirSync(updatePaths(box.dir.state).ready), []);
  assert.match((await box.run("status")).out, /Not put in place by itself: 0\.6\.2, because you went back from it with update --rollback\./);
  assert.deepEqual(bytesOf(box.dir.state), before);

  box.github.serve = fakeGitHub({ manifest: v063.manifest, zip: v063.zip });
  assert.equal((await serverCheck(box, kit, "0.6.1")).ok, true, "0.6.3 is newer than the version skipped");
  mkdirSync(join(box.dir.app, "lib", "blocker.mjs", "in-the-way"), { recursive: true });
  const readme = readFileSync(join(box.dir.app, "README.md"), "utf8");
  assert.equal((await box.run("stop")).code, 0);
  const failed = await box.run("start");
  assert.equal(failed.code, 0, failed.out);
  assert.match(failed.out, /Installing Goblin Horde 0\.6\.3 with its own manager:/);
  assert.match(failed.out, /Putting Goblin Horde 0\.6\.1 back:/);
  assert.match(failed.out, /Goblin Horde 0\.6\.3 was not put in place \(its install did not finish\), so 0\.6\.1 is installed again\./);
  assert.match(failed.out, /The game's server is running at/);
  assert.equal((await health(box.port)).version, "0.6.1", "the earlier version starts");
  assert.equal(marker(box).version, "0.6.1");
  assert.equal(readFileSync(join(box.dir.app, "README.md"), "utf8"), readme, "a file 0.6.3 had already written is 0.6.1's again");
  assert.deepEqual([readSkip(box.dir.state)?.version, readSkip(box.dir.state)?.reason], ["0.6.3", "failed"]);
  assert.deepEqual([readdirSync(updatePaths(box.dir.state).ready), readdirSync(updatePaths(box.dir.state).work)], [[], []]);
  assert.deepEqual(bytesOf(box.dir.state), before);
  rmSync(join(box.dir.app, "lib", "blocker.mjs"), { recursive: true });

  // As a manager stopped in the middle of an apply leaves things: a whole copy of the earlier files, part of the new
  // ones in the app folder, and a lock whose process is gone.
  assert.equal((await box.run("stop")).code, 0);
  const work = workAt(join(updatePaths(box.dir.state).work, "apply-cut"));
  mkdirSync(work.release, { recursive: true });
  writeFileSync(join(work.release, "update.json"), JSON.stringify({ version: "0.6.4" }));
  keepInstalledFiles(box.dir.app, marker(box).files, work);
  writeFileSync(join(box.dir.app, "README.md"), "half of 0.6.4\n");
  writeFileSync(updatePaths(box.dir.state).lock, JSON.stringify({ pid: 999_999, at: Date.now() - 60_000 }));
  const recovered = await box.run("start");
  assert.equal(recovered.code, 0, recovered.out);
  assert.match(recovered.out, /An update to Goblin Horde 0\.6\.4 was cut short, so the version before it is installed again\./);
  assert.equal(readFileSync(join(box.dir.app, "README.md"), "utf8"), readme);
  assert.equal((await health(box.port)).version, "0.6.1");
  assert.equal(readSkip(box.dir.state)?.version, "0.6.4");
  assert.deepEqual(readdirSync(updatePaths(box.dir.state).work), []);
  assert.equal(existsSync(updatePaths(box.dir.state).lock), false);

  // A release whose own start says it started, and starts no server.
  const v065 = makeRelease(releases, kit, "0.6.5", { change: (dir) => {
    const [shebang, ...rest] = readFileSync(join(dir, "goblin.mjs"), "utf8").split("\n");
    writeFileSync(join(dir, "goblin.mjs"), [shebang, 'if (process.argv[2] === "start") { console.log("Started, it says."); process.exit(0); }', ...rest].join("\n"));
  } });
  box.github.serve = fakeGitHub({ manifest: v065.manifest, zip: v065.zip });
  const lying = await box.run("update");
  assert.equal(lying.code, 1, lying.out);
  assert.match(lying.out, /Starting Goblin Horde 0\.6\.5:\n {2}Started, it says\./);
  assert.match(lying.out, /Goblin Horde 0\.6\.5 was not put in place \(it did not start\), so 0\.6\.1 is installed again\./);
  assert.equal((await health(box.port)).version, "0.6.1");
  assert.equal(marker(box).version, "0.6.1");
  assert.deepEqual([readSkip(box.dir.state)?.version, readSkip(box.dir.state)?.reason], ["0.6.5", "failed"]);
  assert.deepEqual(bytesOf(box.dir.state), before);

  assert.equal((await box.run("uninstall")).code, 0);
  assert.deepEqual(readdirSync(updatePaths(box.dir.state).root), ["settings.json"], "uninstall keeps only the choice of whether to look");
  assert.deepEqual(bytesOf(box.dir.state), before, "a plain uninstall keeps the saved game");
  holder.release();
});

test("a release kept for the next start is checked again from its own bytes, and one that does not pass is never used", { timeout: 300_000 }, async (t) => {
  const kit = testKey();
  const box = await sandbox(t, kit);
  const v061 = makeRelease(box.dir.releases, kit, "0.6.1");
  await install(box.ctx, { ...box.flags, noStart: true });
  assert.equal((await box.run("update", "--off")).code, 0);
  box.github.serve = fakeGitHub({ manifest: v061.manifest, zip: v061.zip });
  assert.equal((await serverCheck(box, kit, "0.6.0")).ok, true);
  const zip = join(updatePaths(box.dir.state).ready, "0.6.1", "GoblinHorde-Team.zip");
  const changed = readFileSync(zip);
  changed[200] ^= 0xff;
  writeFileSync(zip, changed);
  const status = await box.run("status");
  assert.doesNotMatch(status.out, /Update waiting/, "status does not offer a release that does not pass");
  const started = await box.run("start");
  assert.equal(started.code, 0, started.out);
  assert.match(started.out, /The downloaded update 0\.6\.1 was removed without being used: The update package's SHA-256 is not the one its signature names/);
  assert.equal(marker(box).version, "0.6.0");
  assert.equal((await health(box.port)).version, "0.6.0");
  assert.deepEqual(readdirSync(updatePaths(box.dir.state).ready), []);

  assert.equal((await box.run("stop")).code, 0);
  const busy = takeApplyLock(box.dir.state);
  const waiting = await box.run("start");
  busy.release();
  assert.equal(waiting.code, 0, waiting.out);
  assert.match(waiting.out, /Another Goblin Horde manager is putting an update in place right now\. It starts Goblin Horde when it is done\./);
  assert.equal(await health(box.port), null, "nothing was started beside the update");
  assert.equal((await box.run("start")).code, 0);

  box.github.serve = fakeGitHub({ manifest: v061.manifest, zip: v061.zip });
  const said = [];
  const keyless = { ...box.ctx, updateKey: "", log: (line) => said.push(line) };
  assert.equal(await main(["update", ...box.argv], keyless), 1);
  assert.equal(await main(["update", "--check", ...box.argv], keyless), 0);
  assert.equal(said.filter((line) => line === "This build has no update key, so it cannot check for updates.").length, 2, said.join("\n"));
  assert.deepEqual(box.github.serve.asked, []);
  assert.equal((await health(box.port)).version, "0.6.0");
});
