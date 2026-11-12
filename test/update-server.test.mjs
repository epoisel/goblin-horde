/**
 * The running game's side of updates: when the server looks for a release, what --off does to that, what it reports
 * and starts for the desktop goblins' Update row, and that no update route is reachable from another computer. Its
 * clock, its spawn and GitHub are stand-ins, so nothing here waits a day, starts a manager, or goes to the network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHECK_EVERY_MS, CHECK_JITTER_MS, FIRST_CHECK_MS, createUpdateService } from "../lib/update-service.mjs";
import { MANIFEST_URL, readLastCheck, updatePaths, writeSettings } from "../lib/updater.mjs";
import { fakeGitHub, makeRelease, testKey } from "./helpers/release-kit.mjs";
import { sharedHost } from "./helpers/shared-host.mjs";
import { ask, freePort, until, viewerPaths } from "./helpers/viewer.mjs";

const SOURCE = fileURLToPath(new URL("..", import.meta.url));
const kit = testKey();
const root = mkdtempSync(join(tmpdir(), "goblin-update-server-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
const release = makeRelease(root, kit, "0.6.1");

/** The service of a server at 0.6.0 over a stand-in GitHub, with timers that are only noted. */
function service({ github = fakeGitHub({ manifest: release.manifest, zip: release.zip }), random = () => 0.5 } = {}) {
  const stateDir = mkdtempSync(join(root, "state-"));
  const timers = [];
  const spawned = [];
  const logged = [];
  const updates = createUpdateService({
    stateDir, installDir: "C:\\Apps\\GoblinHorde", port: 43917, version: "0.6.0", key: kit.key, fetch: github.fetch, random,
    nodePath: "C:\\node\\node.exe", setTimer: (run, ms) => { timers.push({ run, ms }); return { unref() {} }; }, clearTimer: () => {},
    spawn: (program, args, options) => { spawned.push({ program, args, options }); return { on() {}, unref() {} }; },
    log: { log: (line) => logged.push(line), error: (line) => logged.push(line) },
  });
  return { stateDir, timers, spawned, logged, github, updates };
}
const tick = async (box) => { box.timers.at(-1).run(); await until(async () => box.timers.length, (count) => count > 1, "the next check to be set", 5000); };

test("the server looks two minutes after it starts, then about once a day, and keeps what passes for the next start", async () => {
  const box = service();
  box.updates.begin();
  assert.deepEqual(box.timers.map((timer) => timer.ms), [FIRST_CHECK_MS], "the first look waits two minutes");
  assert.equal(box.github.asked.length, 0, "nothing is asked at start");
  await tick(box);
  assert.equal(box.timers[1].ms, CHECK_EVERY_MS + CHECK_JITTER_MS / 2, "then a day, and up to an hour more");
  assert.ok(box.timers[1].ms >= CHECK_EVERY_MS && box.timers[1].ms < CHECK_EVERY_MS + CHECK_JITTER_MS);
  assert.deepEqual(box.updates.staged(), { version: "0.6.1" });
  assert.deepEqual(readdirSync(join(updatePaths(box.stateDir).ready, "0.6.1")).sort(), ["GoblinHorde-Team.zip", "update.json"]);
  assert.equal(readLastCheck(box.stateDir).ok, true);
});

test("update --off stops the server's looks: it asks GitHub nothing until update --on", async () => {
  const box = service();
  writeSettings(box.stateDir, { check: false });
  box.updates.begin();
  await tick(box);
  assert.equal(box.github.asked.length, 0, "no request while checking is off");
  assert.equal(box.updates.staged(), null);
  assert.equal(readLastCheck(box.stateDir), null, "and no check is recorded");
  writeSettings(box.stateDir, { check: true });
  await box.updates.check();
  assert.equal(box.github.asked[0].url, MANIFEST_URL);
  assert.deepEqual(box.updates.staged(), { version: "0.6.1" });
});

test("a check that fails leaves its reason and nothing to offer, and the next one is still set", async () => {
  const box = service({ github: fakeGitHub({ routes: { [MANIFEST_URL]: () => { throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }); } } }) });
  box.updates.begin();
  await tick(box);
  assert.equal(box.updates.staged(), null);
  assert.match(readLastCheck(box.stateDir).message, /GitHub could not be reached \(ECONNRESET\)/);
  assert.deepEqual(readdirSync(updatePaths(box.stateDir).root), ["state.json"]);
  assert.ok(box.logged.some((line) => /ECONNRESET/.test(line)));
  assert.equal(box.timers.length, 2);
});

test("a release an earlier check kept is offered from the start, once it passes again", async () => {
  const first = service();
  await first.updates.check();
  const again = createUpdateService({ stateDir: first.stateDir, installDir: "C:\\Apps\\GoblinHorde", port: 43917, version: "0.6.0", key: kit.key,
    fetch: first.github.fetch, spawn: () => ({ on() {}, unref() {} }), setTimer: () => ({ unref() {} }), clearTimer: () => {} });
  again.begin();
  await until(async () => again.staged(), Boolean, "the kept release to be found");
  assert.deepEqual(again.staged(), { version: "0.6.1" });
  const otherKey = createUpdateService({ stateDir: first.stateDir, installDir: "C:\\Apps\\GoblinHorde", port: 43917, version: "0.6.0", key: testKey().key,
    fetch: first.github.fetch, spawn: () => ({ on() {}, unref() {} }), setTimer: () => ({ unref() {} }), clearTimer: () => {} });
  otherKey.begin();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(otherKey.staged(), null, "a release kept under another key is not offered");
});

test("the Update row's route starts this installation's manager once, detached, and only when a release waits", async () => {
  const box = service();
  assert.deepEqual(box.updates.apply(), { status: 409, body: { error: "No update is waiting." } });
  assert.equal(box.spawned.length, 0);
  await box.updates.check();
  assert.deepEqual(box.updates.apply(), { status: 200, body: { applying: true, version: "0.6.1" } });
  assert.deepEqual(box.spawned.map(({ program, args }) => [program, ...args]), [["C:\\node\\node.exe", "C:\\Apps\\GoblinHorde\\goblin.mjs", "update", "--apply-staged",
    "--install-dir", "C:\\Apps\\GoblinHorde", "--state-dir", box.stateDir, "--port", "43917"]]);
  assert.equal(box.spawned[0].options.detached, true);
  assert.equal(box.spawned[0].options.windowsHide, true);
  assert.deepEqual(box.updates.apply().status, 200);
  assert.equal(box.spawned.length, 1, "a second click starts no second manager");
});

test("the shared listener serves no update route to another computer, by any spelling", async (t) => {
  assert.ok(viewerPaths().includes("/api/update/apply"), "the route list read from server.mjs holds the update route, so the five-route test covers it too");
  const shared = await sharedHost(t);
  const cookie = await shared.session();
  for (const path of ["/api/update", "/api/update/apply", "/api/update/apply?now=1", "/api/update/", "/api/update/check", "/API/UPDATE/APPLY", "/api/pets/../update/apply"]) {
    for (const method of ["GET", "POST"]) {
      const { status, body } = await shared.call(method, path, { cookie, body: {} });
      assert.deepEqual([status, body], [404, { error: "Not found" }], `${method} ${path}`);
    }
  }
  const { body } = await shared.call("GET", "/api/pets", { cookie });
  assert.equal("update" in body, false, "the game another computer reads says nothing of updates");
});

test("the real server reports no waiting update, refuses the route to other pages, and has nothing to apply", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(root, "server-"));
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), GOBLIN_HORDE_STATE_DIR: join(dir, "state"), LOCALAPPDATA: join(dir, "local"), USERPROFILE: join(dir, "home"),
    HOME: join(dir, "home"), GOBLIN_T3_DB: join(dir, "no-t3.sqlite") };
  const child = spawn(process.execPath, [join(SOURCE, "server.mjs")], { env, stdio: "ignore", windowsHide: true });
  try {
    const host = `127.0.0.1:${port}`;
    const pets = await until(async () => (await ask(port, "GET", "/api/pets", { headers: { Host: host } })).body, (body) => body && "update" in body, "the server to answer");
    assert.equal(pets.update, null, "this checkout's build has no key, so nothing can be waiting");
    const own = { Host: host, Origin: `http://${host}`, "Content-Type": "application/json" };
    assert.equal((await ask(port, "POST", "/api/update/apply", { headers: { ...own, Origin: "http://evil.example" }, body: {} })).status, 403);
    assert.equal((await ask(port, "POST", "/api/update/apply", { headers: { ...own, Host: `goblin.example:${port}` }, body: {} })).status, 403);
    assert.equal((await ask(port, "GET", "/api/update/apply", { headers: { Host: host } })).status, 404);
    const none = await ask(port, "POST", "/api/update/apply", { headers: own, body: {} });
    assert.deepEqual([none.status, none.body], [409, { error: "No update is waiting." }]);
  } finally {
    child.kill();
  }
});
