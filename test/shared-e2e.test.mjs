/**
 * A shared game between two real viewers on this computer: a host with a fixture T3 database and its shared
 * listener on the loopback stand-in, and a display with its own state folder that pets-join pointed at it. The
 * manager commands run as real `node goblin.mjs` processes. Every folder is temporary, the Tailscale program is
 * never run, and nothing listens off 127.0.0.1.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { savePairingCode } from "../lib/phone.mjs";
import { CODE } from "./helpers/shared-host.mjs";
import { createT3Fixture, hasSqlite, TRAP, usage } from "./helpers/t3-fixture.mjs";
import { ask, freePort, startViewer, until, viewerEnv, viewerPaths } from "./helpers/viewer.mjs";

const SOURCE = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]+$/, "");
const SHARED_ROUTES = ["GET /api/pets", "GET /api/pets/whoami", "POST /api/pair", "POST /api/pets/buy", "POST /api/pets/fight"];
const BIG_TURN = usage(5_000_000, 200_000);
const LOCKED = "Another Goblin Horde on this computer already runs the game.";
// Any three letters of the code in a row, anywhere, would be a leak of part of it.
const CODE_PARTS = [0, 1, 2, 3, 4, 5].map((start) => CODE.slice(start, start + 3));
const holdsCode = (text) => CODE_PARTS.some((part) => text.includes(part));

test("two viewers share one game: the host pays and saves, the display shows and buys, and nothing else is reachable",
  { skip: !hasSqlite && "this Node.js has no node:sqlite", timeout: 180_000 }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "goblin-shared-e2e-"));
    const dir = Object.fromEntries(["host", "display", "claude", "codex"].map((name) => [name, join(root, name)]));
    for (const folder of Object.values(dir)) mkdirSync(folder);
    const fixture = createT3Fixture({ dir: join(root, "t3") });
    fixture.addTurn({ id: "before-anything", completedAt: Date.now() - 3_600_000, tokens: BIG_TURN });
    const [hostPort, sharedPort, displayPort, secondPort, secondShared] = [await freePort(), await freePort(), await freePort(), await freePort(), await freePort()];
    const standIn = { GOBLIN_SHARED_LOOPBACK: String(sharedPort) };
    const hostEnv = viewerEnv(root, { port: hostPort, stateDir: dir.host, extra: { GOBLIN_T3_DB: fixture.path, ...standIn } });
    const displayEnv = viewerEnv(root, { port: displayPort, stateDir: dir.display, extra: { GOBLIN_T3_DB: join(root, "no-t3.sqlite"), ...standIn } });
    const logs = { host: join(root, "host.log"), display: join(root, "display.log"), second: join(root, "second.log") };
    const said = [];
    savePairingCode(dir.host, CODE);
    writeFileSync(join(root, "code.txt"), `${CODE}\n`);

    /** Run the real manager on a state folder, told `port`, and keep everything it printed. */
    const manager = (stateDir, port, env, args) => {
      const done = spawnSync(process.execPath, [join(SOURCE, "goblin.mjs"), ...args, "--install-dir", SOURCE, "--state-dir", stateDir, "--port", String(port),
        "--claude-config-dir", dir.claude, "--codex-home", dir.codex], { env, encoding: "utf8", windowsHide: true, input: "" });
      const out = `${done.stdout || ""}${done.stderr || ""}`;
      said.push(out);
      return { status: done.status, out };
    };
    const goblin = (who, ...args) => (who === "host" ? manager(dir.host, hostPort, hostEnv, args) : manager(dir.display, displayPort, displayEnv, args));
    /** The manager for the host's state folder, told a port its viewer does not run on. */
    const goblinAt = (port, ...args) => manager(dir.host, port, hostEnv, args);
    const local = (port) => async (path = "/api/pets?after=0") => (await fetch(`http://127.0.0.1:${port}${path}`)).json();
    const [hostPets, displayPets] = [local(hostPort), local(displayPort)];
    const post = async (port, path, body) => {
      const origin = `http://127.0.0.1:${port}`;
      const response = await fetch(`${origin}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const coins = (answer) => answer.game.state.wallet.coins;
    const viewers = [];
    const start = (env, log) => { const viewer = startViewer(env, log); viewers.push(viewer); return viewer; };
    t.after(async () => {
      for (const viewer of viewers) await viewer.stop();
      fixture.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    const enabled = goblin("host", "pets-host", "enable");
    assert.equal(enabled.status, 0, enabled.out);
    assert.match(enabled.out, new RegExp(`Shared game host: on for 127\\.0\\.0\\.1:${sharedPort}\\.`));
    let host = start(hostEnv, logs.host);
    const opened = await until(hostPets, (answer) => answer.ready, "The host's game did not open.");
    assert.deepEqual(opened.source, { ok: true });
    const startCoins = coins(opened);

    await t.test("pets-join checks the host, saves the two files, and prints no part of the code", async () => {
      const wrongFile = join(root, "wrong.txt");
      writeFileSync(wrongFile, "AAAAAAAA\n");
      const wrong = goblin("display", "pets-join", "--host", `127.0.0.1:${sharedPort}`, "--code-file", wrongFile);
      assert.equal(wrong.status, 1);
      assert.match(wrong.out, /did not accept this computer's pairing code\. Nothing was changed\./);
      assert.deepEqual(readdirSync(dir.display), [], "a join that fails saves nothing");
      assert.equal(goblin("display", "pets-join", "--host", `127.0.0.1:${await freePort()}`, "--code-file", join(root, "code.txt")).status, 1);
      assert.equal(goblin("display", "pets-join", "--host", "192.168.1.20", "--code-file", join(root, "code.txt")).status, 1);
      const typed = goblin("display", "pets-join", "--host", `127.0.0.1:${sharedPort}`, "--code-file", CODE);
      assert.equal(typed.status, 1, "the code typed where the file belongs is not a file");
      assert.equal(goblin("display", "pets-join", "--host", `127.0.0.1:${sharedPort}`, "--code", CODE).status, 1, "there is no option that takes the code itself");
      assert.deepEqual(readdirSync(dir.display), []);

      const joined = goblin("display", "pets-join", "--host", `127.0.0.1:${sharedPort}`, "--code-file", join(root, "code.txt"));
      assert.equal(joined.status, 0, joined.out);
      assert.match(joined.out, /^Joined\. This computer now shows the shared game on 127\.0\.0\.1/);
      assert.deepEqual(readdirSync(dir.display).sort(), ["remote-code.txt", "remote.json"]);
      assert.deepEqual(JSON.parse(readFileSync(join(dir.display, "remote.json"), "utf8")), { host: `http://127.0.0.1:${sharedPort}` });
    });

    const display = start(displayEnv, logs.display);
    const shown = await until(displayPets, (answer) => answer.ready, "The display never showed the host's game.");

    await t.test("the display shows the host's own game", async () => {
      const own = await hostPets();
      assert.deepEqual([shown.boot, coins(shown), shown.game.state.horde.size], [own.boot, startCoins, own.game.state.horde.size]);
      assert.deepEqual(shown.source, { ok: true });
      assert.deepEqual(shown.events.map((event) => event.type), ["launch"]);
    });

    let paidCoins = 0;
    await t.test("a turn finished on the host raises the display's coins within 3 seconds, as one work event, once", async () => {
      const finishedAt = Date.now();
      fixture.addTurn({ id: "shared-turn", completedAt: finishedAt, tokens: BIG_TURN });
      const paid = await until(() => displayPets(`/api/pets?after=${shown.seq}`), (answer) => answer.ready && coins(answer) > startCoins, "The display never showed the paid turn.", 10_000);
      const took = Date.now() - finishedAt;
      assert.ok(took < 3000, `the display's coins rose ${took} ms after the turn finished`);
      paidCoins = coins(paid);
      assert.deepEqual(paid.events.map((event) => [event.type, event.turns, event.coins]), [["work", 1, paidCoins - startCoins]]);
      await sleep(2500);
      const later = await displayPets(`/api/pets?after=${shown.seq}`);
      assert.equal(coins(later), paidCoins, "the turn is not paid a second time");
      assert.equal(later.events.filter((event) => event.type === "work").length, 1);
      assert.equal(coins(await hostPets()), paidCoins, "the host shows the same coins");
    });

    await t.test("a purchase on the display changes the host's saved game, and the display keeps no game of its own", async () => {
      const before = (await hostPets()).game;
      const price = before.quotes.recruit.coins;
      assert.ok(paidCoins >= price, "one big turn pays for a recruit");
      const bought = await post(displayPort, "/api/pets/buy", { kind: "recruit" });
      assert.deepEqual([bought.status, bought.body.ok, bought.body.reason], [200, true, null]);
      assert.equal(bought.body.game.state.horde.size, before.state.horde.size + 1);
      const saved = JSON.parse(readFileSync(join(dir.host, "pets.json"), "utf8")).state;
      assert.deepEqual([saved.horde.size, saved.wallet.coins], [before.state.horde.size + 1, paidCoins - price], "the host's pets.json holds the purchase");
      paidCoins -= price;
      const fought = await post(displayPort, "/api/pets/fight", { boss: 0 });
      assert.equal(fought.status, 200);
      assert.equal(typeof fought.body.won, "boolean");
      paidCoins = fought.body.game.state.wallet.coins;
      assert.equal((await post(displayPort, "/api/pets/buy", { kind: "dragon" })).status, 400);
      const files = readdirSync(dir.display);
      assert.ok(files.includes("remote.json") && files.includes("remote-code.txt"), files.join(", "));
      assert.deepEqual(files.filter((name) => name.startsWith("pets")), [], "the display's state folder has no pets.json, no backup and no lock");
    });

    await t.test("a paired computer reaches the five shared routes on the host and no other route the viewer has", async () => {
      const own = `127.0.0.1:${sharedPort}`;
      const call = (method, path, { hostHeader = own, origin = `http://${own}`, cookie = "", body = {} } = {}) => ask(sharedPort, method, path, {
        ...(method === "POST" ? { body } : {}),
        headers: { Host: hostHeader, ...(cookie ? { Cookie: cookie } : {}), ...(method === "POST" ? { Origin: origin, "Content-Type": "application/json" } : {}) },
      });
      const paired = await call("POST", "/api/pair", { body: { code: CODE } });
      assert.equal(paired.status, 200);
      const cookie = paired.cookie;
      // The display paired from this same address, and an address is one computer: its session was replaced, not added to.
      assert.equal((await (await fetch(`http://127.0.0.1:${hostPort}/api/shared`)).json()).shared.sessions, 1, "one computer holds one session");
      const answered = [];
      for (const path of [...viewerPaths(), "/api/pets/whoami"]) {
        for (const method of ["GET", "POST"]) {
          // A purchase and a fight the game refuses, so asking every route changes nothing.
          const { status } = await call(method, path, { cookie, body: { kind: "dragon", boss: -1, enabled: false, code: "nope", id: "x" } });
          if (status !== 404) answered.push(`${method} ${path}`);
        }
      }
      assert.deepEqual(answered.sort(), SHARED_ROUTES);
      assert.equal((await hostPets()).ready, true, "POST /api/quit on the shared listener did not stop the host");
      assert.equal((await (await fetch(`http://127.0.0.1:${hostPort}/api/shared`)).json()).shared.enabled, true, "nor did POST /api/shared turn sharing off");

      assert.equal((await call("GET", "/api/pets")).status, 401, "no session");
      assert.equal((await call("GET", "/api/pets", { cookie, hostHeader: `evil.example:${sharedPort}` })).status, 403, "another Host");
      assert.equal((await call("POST", "/api/pets/buy", { cookie, origin: "http://evil.example", body: { kind: "recruit" } })).status, 403, "another site's page");
      assert.equal((await call("GET", "/api/pets", { cookie })).status, 200);
      const game = (await call("GET", "/api/pets", { cookie })).text;
      for (const trap of Object.values(TRAP)) assert.ok(!game.includes(trap), `"${trap}" crossed the shared listener`);
      // The viewer's own port still refuses a Host that is the shared listener's, and has no whoami.
      assert.equal((await ask(hostPort, "GET", "/api/pets/whoami", { headers: { Host: `127.0.0.1:${hostPort}` } })).status, 404);
    });

    await t.test("a second viewer on the host's state folder is refused by the lock and writes nothing", async () => {
      const lockBefore = readFileSync(join(dir.host, "pets.lock"), "utf8");
      assert.deepEqual([JSON.parse(lockBefore).pid, JSON.parse(lockBefore).port], [host.child.pid, hostPort]);
      const saveBefore = readFileSync(join(dir.host, "pets.json"), "utf8");
      const second = start(viewerEnv(root, { port: secondPort, stateDir: dir.host, extra: { GOBLIN_T3_DB: fixture.path, GOBLIN_SHARED_LOOPBACK: String(secondShared) } }), logs.second);
      const refused = await until(local(secondPort), (answer) => answer.ready === false && answer.message === LOCKED, "The second viewer was not refused by the lock.");
      assert.deepEqual(refused, { ready: false, reason: "locked", message: LOCKED });
      assert.deepEqual(await post(secondPort, "/api/pets/buy", { kind: "level" }), { status: 503, body: { error: LOCKED } });
      await sleep(1500);
      assert.equal(readFileSync(join(dir.host, "pets.json"), "utf8"), saveBefore, "the saved game is untouched");
      assert.equal(readFileSync(join(dir.host, "pets.lock"), "utf8"), lockBefore, "and the first viewer still holds the lock");
      assert.equal(coins(await hostPets()), paidCoins, "the first viewer carries on");
      assert.match(readFileSync(logs.second, "utf8"), /Another Goblin Horde on this computer already runs the game./, "the second viewer's log says why");
      await second.stop();
    });

    await t.test("pets-host status names the address and the paired sessions, and never the code", async () => {
      const status = goblin("host", "pets-host", "status");
      assert.equal(status.status, 0);
      assert.match(status.out, new RegExp(`Shared game host: on, listening at 127\\.0\\.0\\.1:${sharedPort}\\.`));
      assert.match(status.out, /Saved game: yes, with \d+ coins?, \d+ goblins?, and \d+ boss(es)? cleared\./);
      assert.doesNotMatch(status.out, /Another Goblin Horde on this computer holds the saved game/, "the host's own viewer holds its own game");
      assert.match(status.out, /Paired sessions: [1-9]\d*\./);
      assert.match(status.out, /Login check: off\./);
      const code = goblin("host", "pets-host", "code");
      assert.equal(code.status, 1, "this test's output is a pipe, not a terminal");
      assert.match(code.out, /shown only in a terminal on this computer with a person at it\. To read it yourself, open .*pairing-code\.txt in a text editor\./);
      const json = JSON.parse(goblin("host", "pets-host", "status", "--json").out);
      assert.deepEqual([json.enabled, json.listening, json.address, json.port, json.heldBy], [true, true, "127.0.0.1", sharedPort, null]);
      assert.equal(json.save.coins, paidCoins);
      const doctor = goblin("host", "doctor");
      assert.match(doctor.out, /Shared game \(pets-host, pets-join\):/);
      assert.match(doctor.out, new RegExp(`✓ shared-host\\s+On: other computers join at 127\\.0\\.0\\.1:${sharedPort}\\.`));
      assert.match(goblin("display", "doctor").out, new RegExp(`✓ shared-remote\\s+Joined: this computer shows the game on 127\\.0\\.0\\.1:${sharedPort}`));
    });

    await t.test("with the host stopped the display says so in plain words, keeps its other routes, and comes back with the host", async () => {
      await host.stop();
      const down = await until(displayPets, (answer) => answer.ready === false, "The display kept showing a game with the host stopped.");
      assert.deepEqual(down, { ready: false, message: "The shared game on 127.0.0.1 is not reachable. Is Goblin Horde running there?" });
      const started = Date.now();
      const [health, config] = await Promise.all([local(displayPort)("/api/health"), local(displayPort)("/api/config")]);
      assert.deepEqual([health.product, typeof config.pollMs], ["GoblinHorde", "number"]);
      assert.ok(Date.now() - started < 1000, "the display's other routes do not wait for the host");
      assert.deepEqual(await post(displayPort, "/api/pets/buy", { kind: "level" }).then(({ status }) => status), 503);

      host = start(hostEnv, logs.host);
      const back = await until(hostPets, (answer) => answer.ready, "The host's game did not open again.");
      assert.equal(coins(back), paidCoins, "the turn the host paid before it stopped is not paid again after a restart");
      assert.equal(back.events.filter((event) => event.type === "work").length, 0);
      assert.notEqual(back.boot, shown.boot);
      const again = await until(displayPets, (answer) => answer.ready, "The display did not come back with the host.", 45_000);
      assert.deepEqual([again.boot, coins(again)], [back.boot, paidCoins], "the display paired again and shows the restarted host");
    });

    await t.test("pets-host disable asked on another port still reaches the viewer that holds the saved game, and the session it ends is refused", async () => {
      const own = `127.0.0.1:${sharedPort}`;
      const paired = await ask(sharedPort, "POST", "/api/pair", { body: { code: CODE }, headers: { Host: own, Origin: `http://${own}`, "Content-Type": "application/json" } });
      assert.equal(paired.status, 200);
      const game = () => ask(sharedPort, "GET", "/api/pets", { headers: { Host: own, Cookie: paired.cookie } }).then(({ status }) => status, () => "closed");
      assert.equal(await game(), 200);
      // The manager is told a port nothing answers on, as when another copy of it runs. pets.lock names the viewer.
      const elsewhere = await freePort();
      const off = goblinAt(elsewhere, "pets-host", "disable");
      assert.equal(off.status, 0, off.out);
      assert.match(off.out, /Shared game host: off\./);
      assert.match(off.out, /Every computer that had joined is signed out\./);
      assert.equal(await game(), "closed", "the session that was paired is refused: nothing listens any more");
      assert.equal((await (await fetch(`http://127.0.0.1:${hostPort}/api/shared`)).json()).shared.sessions, 0, "and the viewer holds no session");
      assert.equal(JSON.parse(readFileSync(join(dir.host, "shared.json"), "utf8")).enabled, false);

      const on = goblinAt(elsewhere, "pets-host", "enable");
      assert.match(on.out, new RegExp(`Shared game host: on, listening at 127\\.0\\.0\\.1:${sharedPort}\\.`));
      assert.equal(await game(), 401, "open again, and the old session is still signed out");
    });

    await t.test("pets-host disable closes the listener at once, and enable opens it again", async () => {
      const off = goblin("host", "pets-host", "disable");
      assert.equal(off.status, 0, off.out);
      assert.match(off.out, /Shared game host: off\./);
      await assert.rejects(ask(sharedPort, "GET", "/api/pets/whoami", { headers: { Host: `127.0.0.1:${sharedPort}` } }), "the port is closed");
      assert.equal((await hostPets()).ready, true, "the host's own game goes on");
      const on = goblin("host", "pets-host", "enable");
      assert.match(on.out, new RegExp(`Shared game host: on, listening at 127\\.0\\.0\\.1:${sharedPort}\\.`));
      assert.match(on.out, /Paired sessions: 0\./, "turning it off signed everyone out");
      assert.deepEqual((await ask(sharedPort, "GET", "/api/pets/whoami", { headers: { Host: `127.0.0.1:${sharedPort}` } })).body, { ok: true });
      const refusedBoth = goblin("host", "pets-join", "--host", `127.0.0.1:${sharedPort}`, "--code-file", join(root, "code.txt"));
      assert.equal(refusedBoth.status, 1);
      assert.match(refusedBoth.out, /A computer is a host or a display, not both\./);
      assert.match(goblin("display", "pets-host", "enable").out, /A computer is a host or a display, not both\./);
    });

    await t.test("a new pairing code on the host signs the display out until it joins with the new code", async () => {
      await until(displayPets, (answer) => answer.ready, "The display did not come back after the listener opened again.", 45_000);
      const reset = await post(hostPort, "/api/phone/reset", {});
      assert.equal(reset.status, 200);
      assert.notEqual(reset.body.code, CODE);
      const out = await until(displayPets, (answer) => answer.ready === false, "The display kept its session after the code changed.");
      assert.deepEqual(out, { ready: false, message: "The shared game on 127.0.0.1 did not accept this computer's pairing code." });
      const own = `127.0.0.1:${sharedPort}`;
      const old = await ask(sharedPort, "POST", "/api/pair", { body: { code: CODE }, headers: { Host: own, Origin: `http://${own}`, "Content-Type": "application/json" } });
      assert.equal(old.status, 401, "the old code no longer pairs");
    });

    await t.test("pets-join --off puts the display back on its own game", async () => {
      const off = goblin("display", "pets-join", "--off");
      assert.equal(off.status, 0);
      assert.match(off.out, /plays its own game again/);
      assert.equal(existsSync(join(dir.display, "remote.json")) || existsSync(join(dir.display, "remote-code.txt")), false);
      await display.stop();
      // Its own pets.json was saved when the game had more bosses than it has now. The viewer opens it as the same game, held to the bosses there are.
      const older = JSON.stringify({ schema: 1, lastSeenAt: Date.now(), sources: { t3: { at: Date.now(), seen: [] } },
        state: { ...(await hostPets()).game.state, wallet: { coins: 987_654, scrap: 0, lifetimeCoins: 987_654 }, horde: { size: 17, level: 9, xp: 0, gear: 0 }, bosses: { cleared: 4000 } } });
      writeFileSync(join(dir.display, "pets.json"), older);
      const returning = start(displayEnv, logs.display);
      const kept17 = await until(displayPets, (answer) => answer.ready, "The display did not open the game it had saved when there were more bosses.");
      assert.deepEqual([kept17.game.state.horde.size, kept17.game.state.wallet.coins, kept17.game.nextBoss], [17, 987_654, null], "the same game, with its 17 goblins and its coins");
      assert.ok(kept17.game.state.bosses.cleared < 4000 && kept17.game.state.bosses.cleared > 0, "and no more bosses cleared than the game has");
      assert.deepEqual(readdirSync(dir.display).filter((name) => name.startsWith("pets.json.unreadable")), [], "nothing was set aside");
      await returning.stop();
      rmSync(join(dir.display, "pets.json.bak"), { force: true });
      // A pets.json no game could have made is waiting there: a horde of no goblins.
      const impossible = JSON.stringify({ schema: 1, lastSeenAt: Date.now(), sources: { t3: { at: Date.now(), seen: [] } },
        state: { ...(await hostPets()).game.state, wallet: { coins: 987_654, scrap: 0, lifetimeCoins: 987_654 }, horde: { size: 0, level: 9, xp: 0, gear: 0 }, bosses: { cleared: 4 } } });
      writeFileSync(join(dir.display, "pets.json"), impossible);
      const refusing = start(displayEnv, logs.display);
      const unread = await until(displayPets, (answer) => answer.ready === false && answer.reason === "unreadable", "The display did not say that its saved game cannot be read.");
      assert.deepEqual(unread, { ready: false, reason: "unreadable", message: "The saved game could not be read. A copy was kept next to it. Nothing was replaced." });
      assert.deepEqual(await post(displayPort, "/api/pets/buy", { kind: "recruit" }), { status: 503, body: { error: unread.message } });
      assert.equal(readFileSync(join(dir.display, "pets.json"), "utf8"), impossible, "the viewer did not start a new game over the save it could not read");
      const kept = readdirSync(dir.display).filter((name) => /^pets\.json\.unreadable\.\d+-[0-9a-f]{8}$/.test(name));
      assert.equal(kept.length, 1, readdirSync(dir.display).join(", "));
      assert.equal(readFileSync(join(dir.display, kept[0]), "utf8"), impossible, "and it kept a copy of what it could not read");
      assert.equal(existsSync(join(dir.display, "pets.json.bak")), false);
      await refusing.stop();
      // The owner moves the file away, and only then does a game of this computer's own begin.
      renameSync(join(dir.display, "pets.json"), join(dir.display, "moved-away-by-the-owner.json"));
      const alone = start(displayEnv, logs.display);
      const own = await until(displayPets, (answer) => answer.ready, "The display did not open its own game.");
      assert.equal(own.game.state.horde.size, 3, "a new game of its own, now that no saved game is there");
      assert.notEqual(coins(own), paidCoins);
      assert.equal(existsSync(join(dir.display, "pets.json")), true);
      assert.equal(readFileSync(join(dir.display, kept[0]), "utf8"), impossible, "the copy is still there");
      assert.equal(JSON.parse(readFileSync(join(dir.display, "pets.lock"), "utf8")).pid, alone.child.pid);
      // Quit Goblin Horde, as the widget's menu does it: the viewer waits for its game to close before it exits.
      const exited = new Promise((resolve) => alone.child.once("exit", resolve));
      assert.equal((await post(displayPort, "/api/quit", {})).status, 200);
      await exited;
      assert.equal(existsSync(join(dir.display, "pets.lock")), false, "a viewer that quits gives the saved game's lock up before it is gone");
      assert.equal(JSON.parse(readFileSync(join(dir.display, "pets.json"), "utf8")).state.horde.size, 3, "and its saved game is whole");
    });

    for (const viewer of viewers) await viewer.stop();
    const written = [...said, ...Object.values(logs).filter((file) => existsSync(file)).map((file) => readFileSync(file, "utf8")),
      readFileSync(join(dir.host, "shared.json"), "utf8")].join("\n");
    assert.ok(said.length >= 15 && written.length > 2000, "the commands and the viewers did print");
    assert.equal(holdsCode(written), false, "no command's output and no viewer's log holds any part of the pairing code");
    for (const trap of Object.values(TRAP)) assert.ok(!written.includes(trap), `"${trap}" reached an output or a log`);
  });
