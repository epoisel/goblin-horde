/**
 * The manager's shared game commands on invented computers and temporary folders: pets-adopt against a
 * fixture T3 database, pets-host and pets-join without a viewer, and doctor's shared group with a scripted
 * tailscale program. Nothing here runs the real tailscale program or touches this computer's state folder.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { doctor, readManifest, stateFiles } from "../lib/manager.mjs";
import { LOCK_FILE, createPetsLock } from "../lib/pets-lock.mjs";
import { REMOTE_CODE_FILE, REMOTE_FILE, readRemoteSetting, writeRemoteSetting } from "../lib/pets-remote.mjs";
import { createPetsStore } from "../lib/pets-store.mjs";
import { CODE_FILE, savePairingCode } from "../lib/phone.mjs";
import { createRewardEngine } from "../lib/reward-engine.mjs";
import { SHARED_FILE, readSharedSetting, writeSharedSetting } from "../lib/shared.mjs";
import { petsAdopt, petsHost, petsJoin } from "../lib/shared-manager.mjs";
import { t3Source } from "../lib/t3-source.mjs";
import { main, parseArgs } from "../goblin.mjs";
import { CONFIG, MIN, OWNER, PARTS, computer, laptopSave, plain, saveFile, saved, servitor } from "./helpers/manager-box.mjs";
import { CODE, sharedHost } from "./helpers/shared-host.mjs";
import { createT3Fixture, hasSqlite, TRAP } from "./helpers/t3-fixture.mjs";

const needsSqlite = { skip: !hasSqlite && "this Node.js has no node:sqlite" };
// How long a command watches a lock that shows no heartbeat, and how often it looks: 600 ms here where a real one takes 20 seconds.
const QUICK_WATCH = { lockTiming: { staleMs: 600, lookMs: 25 } };

/**
 * Another Goblin Horde that holds the saved game in `stateDir` and runs: a lock with a heartbeat, under a process
 * id that is alive (this test's own parent, unless `pid` says otherwise). `crash()` stops the heartbeat and
 * leaves the lock where it is, and `release()` gives the lock up.
 */
async function runningHolder(t, stateDir, { pid = process.ppid, port } = {}) {
  let heartbeat = null;
  const lock = createPetsLock({ dir: stateDir, pid, startedAt: 1, port, beatMs: 40, alive: () => true, confirm: async () => true,
    setTimer: (run, ms) => (heartbeat = setInterval(run, ms)), clearTimer: clearInterval });
  assert.deepEqual(await lock.acquire(), { ok: true });
  t.after(() => clearInterval(heartbeat));
  return { crash: () => clearInterval(heartbeat), release: () => lock.release() };
}

test("pets-adopt takes a saved game's numbers, keeps the counts, and pays nothing for earlier work on this computer", needsSqlite, async (t) => {
  const fixture = createT3Fixture();
  t.after(() => fixture.close());
  const box = await computer(t, { env: { GOBLIN_T3_DB: fixture.path } });
  const now = Date.now();
  fixture.addTurn({ id: "two-hours-ago", completedAt: now - 120 * MIN });
  fixture.addTurn({ id: "five-minutes-ago", completedAt: now - 5 * MIN });
  fixture.addSubagent({ id: "a-minute-ago", completedAt: now - MIN });
  const laptop = laptopSave();

  assert.equal(await main(["pets-adopt", saveFile(box, laptop), ...box.argv], box.ctx), 0);
  assert.match(box.lines[0], /^Adopted the saved game, with 4321 coins, 17 goblins, and 4 bosses cleared\.$/);
  assert.match(box.lines[1], /before now is not paid, and no coins were added for the time away\.$/);
  const record = saved(box);
  const { title, ...numbers } = laptop.state;
  assert.equal(title, TRAP.title);
  assert.deepEqual(record.state, numbers, "the game's own numbers are the laptop's");
  assert.deepEqual(Object.keys(record).sort(), ["lastSeenAt", "notBefore", "schema", "sources", "state"]);
  assert.deepEqual(Object.keys(record.sources), ["t3"]);
  assert.ok(record.lastSeenAt >= now && record.sources.t3.at >= now - 1000, "the last-seen time and the watermark are now, not the laptop's");
  assert.deepEqual([record.notBefore, record.sources.t3], [record.lastSeenAt, { at: record.lastSeenAt, seen: [] }], "the cutoff, the watermark and the last-seen time are the one moment of adoption");
  assert.ok(!record.sources.t3.seen.some((id) => id.startsWith("laptop-")), "the laptop's paid work is forgotten");
  const text = readFileSync(join(box.stateDir, "pets.json"), "utf8");
  for (const trap of Object.values(TRAP)) assert.ok(!text.includes(trap) && !box.said().includes(trap), `"${trap}" came along with the save`);
  assert.deepEqual(readdirSync(box.stateDir).sort(), ["pets.json"], "the lock is released and no copy was needed");

  // The fixture is removed when the test ends, which Windows refuses while a database is open: so adopt closed its own.
  const source = t3Source(fixture.path);
  try {
    const engine = createRewardEngine({ config: CONFIG, store: createPetsStore({ dir: box.stateDir }), source });
    const launch = await engine.start();
    assert.deepEqual(launch, { welcome: false, away: null, caughtUp: { turns: 0, coins: 0 } }, "nothing is back-paid, for work in the overlap window or for ten days away");
    assert.equal(engine.snapshot().state.wallet.coins, 4321);
    fixture.addTurn({ id: "after-adoption", completedAt: Date.now() });
    const paid = await engine.tick();
    assert.ok(paid.ok && paid.turns === 1 && paid.coins > 0, "work that finishes after the adoption pays");
  } finally { source.close(); }
});

test("pets-adopt refuses when a saved game is here, and --replace keeps a copy of it first", async (t) => {
  const box = await computer(t);
  assert.equal(await main(["pets-adopt", saveFile(box, laptopSave({ coins: 100, horde: 5, bosses: 1 })), ...box.argv], box.ctx), 0, "with no T3 database the adoption still works");
  const first = readFileSync(join(box.stateDir, "pets.json"), "utf8");

  const second = saveFile(box, laptopSave({ coins: 7777, horde: 30, bosses: 9 }), "second.json");
  await assert.rejects(main(["pets-adopt", second, ...box.argv], box.ctx), (error) => plain(error) && /already has a saved game, and it was kept\..*--replace/.test(error.message));
  assert.equal(readFileSync(join(box.stateDir, "pets.json"), "utf8"), first);
  assert.deepEqual(readdirSync(box.stateDir).sort(), ["pets.json"]);

  box.lines.length = 0;
  assert.equal(await main(["pets-adopt", second, "--replace", ...box.argv], box.ctx), 0);
  assert.match(box.lines[0], /7777 coins, 30 goblins, and 9 bosses cleared/);
  const copies = readdirSync(box.stateDir).filter((name) => /^pets\.json\.before-adopt-\d{8}T\d{9}Z-[a-f0-9]{6}$/.test(name));
  assert.equal(copies.length, 1, readdirSync(box.stateDir).join(", "));
  assert.equal(readFileSync(join(box.stateDir, copies[0]), "utf8"), first, "the copy is the saved game as it was");
  assert.ok(box.said().includes(copies[0]));
  assert.equal(saved(box).state.wallet.coins, 7777);
  assert.ok(stateFiles(box.stateDir).map((file) => basename(file)).includes(copies[0]), "a full reset removes the copy too");

  rmSync(join(box.stateDir, "pets.json"));
  await assert.rejects(petsAdopt(box.ctx, box.flags, { path: second }), /already has a saved game/, "a saved game that survives only as its backup is still one");
});

test("pets-adopt refuses a file that is not a saved game, a running game, a display, and its own save", async (t) => {
  const box = await computer(t, { context: QUICK_WATCH });
  const refused = (path, pattern, options = {}) => assert.rejects(petsAdopt(box.ctx, box.flags, { path, ...options }), (error) => plain(error) && pattern.test(error.message));
  await refused("", /Say which saved game to adopt/);
  await refused(join(box.root, "missing.json"), /could not be read, so nothing was changed\.$/);
  const broken = [["not json", "{"], ["a list", "[]"], ["text in a number's place", JSON.stringify({ ...laptopSave(), state: { ...laptopSave().state, wallet: { coins: "many", scrap: 0, lifetimeCoins: 0 } } })],
    ["a negative horde", JSON.stringify({ ...laptopSave(), state: { ...laptopSave().state, horde: { size: -3, level: 1, xp: 0, gear: 0 } } })],
    ["another schema", JSON.stringify({ ...laptopSave(), schema: 2 })], ["a huge file", "x".repeat(1_100_000)],
    ["more bosses cleared than any game has", JSON.stringify(laptopSave({ bosses: 100_001 }))], ["half a boss cleared", JSON.stringify(laptopSave({ bosses: 0.5 }))],
    ["a horde no game could price", JSON.stringify(laptopSave({ horde: 900_000 }))]];
  for (const [what, text] of broken) await refused(saveFile(box, text, "bad.json"), /(is not a Goblin Horde saved game|could not be read), so nothing was changed\.$/, {}).catch((error) => assert.fail(`${what}: ${error.message}`));
  assert.equal(existsSync(box.stateDir), false, "nothing was written");

  mkdirSync(box.stateDir);
  const running = await runningHolder(t, box.stateDir);
  await refused(saveFile(box), /Goblin Horde is running here and holds the saved game\. Stop it first: node ".*goblin\.mjs".* stop$/);
  assert.deepEqual(readdirSync(box.stateDir), [LOCK_FILE], "the holder's lock and folder are untouched");
  running.release();
  writeFileSync(join(box.stateDir, LOCK_FILE), JSON.stringify({ pid: 999_999_999, startedAt: 1 }));
  assert.equal((await petsAdopt(box.ctx, box.flags, { path: saveFile(box) })).coins, 4321, "a lock left by a process that is gone does not stop it");
  await refused(join(box.stateDir, "pets.json"), /already this computer's own saved game/, { replace: true });

  const display = await computer(t, { env: { GOBLIN_SHARED_LOOPBACK: "45123" } });
  writeRemoteSetting(display.stateDir, { origin: "http://127.0.0.1:45000", code: CODE });
  await assert.rejects(petsAdopt(display.ctx, display.flags, { path: saveFile(display) }), /shows another computer's shared game.*Adopt the save on the host/);
  assert.deepEqual(readdirSync(display.stateDir).sort(), [REMOTE_CODE_FILE, REMOTE_FILE]);
});

test("pets-host code goes to a terminal on this computer and nowhere else", async (t) => {
  const box = await computer(t);
  savePairingCode(box.stateDir, CODE);
  const terminal = (isTTY) => ({ isTTY, text: "", write(chunk) { this.text += chunk; } });

  for (const [why, ctx] of [["a pipe", { ...box.ctx, stdout: terminal(false) }], ["a remote session", { ...box.ctx, stdout: terminal(true), env: { ...box.ctx.env, SSH_CONNECTION: "203.0.113.5 50000 10.0.0.2 22" } }]]) {
    await assert.rejects(main(["pets-host", "code", ...box.argv], ctx), (error) => plain(error)
      && /^The pairing code is shown only in a terminal on this computer with a person at it\. To read it yourself, open .*pairing-code\.txt in a text editor\.$/.test(error.message)
      && !PARTS.some((part) => error.message.includes(part)), why);
    assert.equal(ctx.stdout.text, "", why);
  }
  const seen = { ...box.ctx, stdout: terminal(true) };
  assert.equal(await main(["pets-host", "code", "--json", ...box.argv], seen), 0);
  assert.equal(seen.stdout.text, `Pairing code: ${CODE}\n`);
  assert.deepEqual(box.lines, [], "the code goes to the terminal itself, never through the manager's log or its JSON output");
});

test("pets-host enable saves this computer's Tailscale address, says how to join, and never prints the code", async (t) => {
  const box = await computer(t, { tailscale: servitor, context: QUICK_WATCH });
  savePairingCode(box.stateDir, CODE);
  assert.equal(await main(["pets-host", "status", ...box.argv], box.ctx), 0);
  assert.deepEqual(box.lines, ["Shared game host: off. This computer does not share its game.",
    "Saved game: none yet. A new game starts when Goblin Horde first runs here, or bring one over with pets-adopt."]);
  assert.equal(existsSync(join(box.stateDir, SHARED_FILE)), false, "status changes nothing");

  box.lines.length = 0;
  assert.equal(await main(["pets-host", "enable", ...box.argv], box.ctx), 0);
  assert.deepEqual(readSharedSetting(box.stateDir), { enabled: true, address: "100.101.102.103" });
  const said = box.said();
  assert.match(box.lines[0], new RegExp(`^Shared game host: on for 100\\.101\\.102\\.103:${box.flags.port}\\. Nothing listens until Goblin Horde runs: node .* start --surface pets$`));
  assert.ok(said.includes(`pets-join --host 100.101.102.103:${box.flags.port} --code-file`), said);
  assert.match(said, /Login check: on\. A caller must be signed in to the same Tailscale account as this computer\./);
  assert.match(said, /Saved game: none yet\./);
  assert.match(said, /Paired sessions: 0\./);
  assert.ok(!PARTS.some((part) => said.includes(part)) && !said.includes(OWNER), "neither the code nor the login is printed");

  box.lines.length = 0;
  const json = { ...box.ctx, log: (line) => box.lines.push(line) };
  assert.equal(await main(["pets-host", "status", "--json", ...box.argv], json), 0);
  const report = JSON.parse(box.said());
  assert.deepEqual([report.enabled, report.listening, report.address, report.port, report.whois, report.save, report.sessions, report.running], [true, false, "100.101.102.103", box.flags.port, true, null, 0, false]);
  assert.ok(!PARTS.some((part) => box.said().includes(part)));

  box.lines.length = 0;
  assert.equal(await main(["pets-host", "disable", ...box.argv], box.ctx), 0);
  assert.equal(readSharedSetting(box.stateDir).enabled, false);
  assert.deepEqual([box.lines[0], box.lines.at(-1)], ["Shared game host: off. This computer does not share its game.", "No Goblin Horde runs on this state folder now, so nothing was listening."]);
  assert.ok(!box.said().includes("signed out"), "with no viewer to confirm it, nothing is said about who is signed out");

  await petsAdopt(box.ctx, box.flags, { path: saveFile(box) });
  const withSave = await petsHost(box.ctx, box.flags, "status");
  assert.deepEqual(withSave.save, { coins: 4321, horde: 17, bosses: 4 });
  assert.ok(withSave.messages.includes("Saved game: yes, with 4321 coins, 17 goblins, and 4 bosses cleared."), withSave.messages.join(" | "));
  assert.equal(withSave.heldBy, null);
  const running = await runningHolder(t, box.stateDir);
  const held = await petsHost(box.ctx, box.flags, "status");
  assert.deepEqual(held.heldBy, { pid: process.ppid, startedAt: 1 });
  assert.match(held.messages.at(-1), /^Another Goblin Horde on this computer holds the saved game \(process \d+\)\. Only one may run a game, so stop the other one before you go on\.$/);
  // A lock that is left behind, under a process id another program has now, shows no heartbeat. Status watches it and then names nobody.
  running.crash();
  const left = await petsHost(box.ctx, box.flags, "status");
  assert.equal(left.heldBy, null, "a lock that showed no heartbeat for long enough holds nothing");
  assert.ok(!left.messages.some((line) => /Another Goblin Horde/.test(line)), left.messages.join(" | "));
  running.release();
  writeFileSync(join(box.stateDir, "pets.json"), "{");
  assert.ok((await petsHost(box.ctx, box.flags, "status")).messages.includes("Saved game: pets.json is here, but it is not a saved game Goblin Horde can read."));
  await assert.rejects(main(["pets-host", "sideways", ...box.argv], box.ctx), /Use: node goblin\.mjs pets-host enable \| disable \| status \| code/);
});

test("pets-host enable refuses without the tailscale program, whatever addresses this computer has, and without a Tailscale address", async (t) => {
  const nic = (address) => [{ family: "IPv4", internal: false, address }];
  // No adapter stands in for the program's word: not one named for Tailscale, and not a Wi-Fi one whose provider uses Tailscale's range.
  for (const adapters of [{ Tailscale: nic("100.90.1.2") }, { "Wi-Fi": nic("100.72.9.9") }, { "Wi-Fi": nic("100.72.9.9"), Tailscale: nic("100.90.1.2") }, {}]) {
    const noProgram = await computer(t, { adapters });
    await assert.rejects(petsHost(noProgram.ctx, noProgram.flags, "enable"), (error) => plain(error)
      && /^Tailscale's program was not found, so the shared game cannot check who is calling\. Install Tailscale on this computer, sign in, and try again\.$/.test(error.message), Object.keys(adapters).join());
    assert.equal(existsSync(join(noProgram.stateDir, SHARED_FILE)), false, "a refused enable saves nothing");
    assert.deepEqual(noProgram.ran, [], "and there was no program to ask");
  }
  const left = await computer(t, { adapters: { Tailscale: nic("100.90.1.2") } });
  writeSharedSetting(left.stateDir, { enabled: true, address: "100.90.1.2" });
  const status = await petsHost(left.ctx, left.flags, "status");
  assert.deepEqual([status.enabled, status.listening, status.whois], [true, false, false]);
  assert.equal(status.messages[0], "Shared game host: on, but not listening. Tailscale's program was not found, so the shared game cannot check who is calling.");
  assert.ok(!status.messages.some((line) => /Login check: on/.test(line) || /Another computer joins with/.test(line)), "a host that cannot listen offers no address to join at");

  for (const box of [await computer(t, { tailscale: servitor, adapters: { "Wi-Fi": nic("192.168.1.20") } }), await computer(t, { tailscale: servitor, adapters: { "Wi-Fi": nic("100.72.9.9") } }),
    await computer(t, { tailscale: servitor, adapters: { "Wi-Fi": nic("192.168.1.20"), Ethernet: nic("10.0.0.5") } })]) {
    await assert.rejects(petsHost(box.ctx, box.flags, "enable"), (error) => plain(error) && /^Tailscale is not connected on this computer/.test(error.message), "an address the program names but no adapter has");
    assert.equal(existsSync(join(box.stateDir, SHARED_FILE)), false);
  }
});

/**
 * A stand-in for a running viewer's local routes, on 127.0.0.1: it answers the health check as this test's own
 * process, GET and POST /api/shared from `shared()` as a viewer on `stateDir` would, and keeps every POST in `asked`.
 */
async function fakeViewer(t, stateDir, shared) {
  const asked = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const answer = (status, data) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(data)); };
      if (request.url === "/api/health") return answer(200, { product: "GoblinHorde", pid: process.pid });
      if (request.url !== "/api/shared") return answer(404, {});
      if (request.method === "POST") asked.push(JSON.parse(body));
      return answer(200, { shared: shared(request.method, asked), stateDir });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { port: server.address().port, asked };
}
const listening = (port) => ({ enabled: true, listening: true, address: "127.0.0.1", port, url: `http://127.0.0.1:${port}`, whois: false, standIn: true, problem: "", sessions: 2 });
const closed = (port) => ({ enabled: false, listening: false, address: "", port, url: "", whois: false, standIn: false, problem: "", sessions: 0 });

test("pets-host disable is applied through the viewer that holds the state folder, wherever it runs, and claims a sign-out only when that viewer confirms it", async (t) => {
  const box = await computer(t, { env: { GOBLIN_SHARED_LOOPBACK: "45123" } });
  mkdirSync(box.stateDir);
  writeSharedSetting(box.stateDir, { enabled: true, address: "127.0.0.1" });
  // The viewer runs on a port the manager was not told, and the saved game's lock is what names it.
  const viewer = await fakeViewer(t, box.stateDir, (method, asked) => (asked.length ? closed(45123) : listening(45123)));
  writeFileSync(join(box.stateDir, LOCK_FILE), JSON.stringify({ pid: process.pid, startedAt: 1, port: viewer.port }));
  assert.notEqual(viewer.port, box.flags.port);

  const status = await petsHost(box.ctx, box.flags, "status");
  assert.deepEqual([status.listening, status.sessions, status.running], [true, 2, true], "status is the live viewer's own word");
  assert.equal(await main(["pets-host", "disable", ...box.argv], box.ctx), 0);
  assert.deepEqual(viewer.asked, [{ enabled: false }], "the viewer that holds the folder was asked to turn it off");
  assert.deepEqual([box.lines[0], box.lines.at(-1)], ["Shared game host: off. This computer does not share its game.", "Every computer that had joined is signed out."]);

  // A viewer that answers but still listens, or still has a session, is not a sign-out.
  for (const still of [{ listening: true }, { sessions: 1 }, { enabled: true }]) {
    const stuck = await computer(t, { env: { GOBLIN_SHARED_LOOPBACK: "45123" } });
    mkdirSync(stuck.stateDir);
    writeSharedSetting(stuck.stateDir, { enabled: true, address: "127.0.0.1" });
    const open = await fakeViewer(t, stuck.stateDir, () => ({ ...closed(45123), ...still }));
    writeFileSync(join(stuck.stateDir, LOCK_FILE), JSON.stringify({ pid: process.pid, startedAt: 1, port: open.port }));
    await assert.rejects(main(["pets-host", "disable", ...stuck.argv], stuck.ctx), (error) => plain(error)
      && /answered, but its shared listener is not closed\./.test(error.message), JSON.stringify(still));
    assert.ok(!stuck.said().includes("signed out"), JSON.stringify(still));
  }

  // A viewer on the port the manager knows that runs on another state folder is not this folder's viewer.
  const elsewhere = await computer(t, { env: { GOBLIN_SHARED_LOOPBACK: "45123" } });
  const other = await fakeViewer(t, join(elsewhere.root, "another-state-folder"), () => listening(45123));
  elsewhere.flags.port = other.port;
  writeSharedSetting(elsewhere.stateDir, { enabled: true, address: "127.0.0.1" });
  const alone = await petsHost(elsewhere.ctx, elsewhere.flags, "disable");
  assert.deepEqual(other.asked, [], "it was not asked anything");
  assert.equal(alone.messages.at(-1), "No Goblin Horde runs on this state folder now, so nothing was listening.");
  assert.equal(readSharedSetting(elsewhere.stateDir).enabled, false);
});

test("pets-host disable claims a sign-out only from an answer that says all three things: off, not listening, and nobody signed in", async (t) => {
  // The review's answer first: the session count and nothing else, from a viewer whose listener stayed open.
  const halfSaid = [{ sessions: 0 }, {}, { enabled: false, listening: false }, { enabled: false, sessions: 0 }, { listening: false, sessions: 0 },
    { enabled: false, listening: false, sessions: "0" }, { enabled: false, listening: false, sessions: null }, { enabled: false, listening: false, sessions: [] },
    { enabled: 0, listening: false, sessions: 0 }, { enabled: false, listening: 0, sessions: 0 }, { enabled: null, listening: null, sessions: 0 },
    { enabled: "false", listening: "false", sessions: 0 }, { enabled: false, listening: "", sessions: 0 }];
  for (const said of halfSaid) {
    const box = await computer(t, { env: { GOBLIN_SHARED_LOOPBACK: "45123" } });
    mkdirSync(box.stateDir);
    writeSharedSetting(box.stateDir, { enabled: true, address: "127.0.0.1" });
    const viewer = await fakeViewer(t, box.stateDir, (method) => (method === "POST" ? said : listening(45123)));
    writeFileSync(join(box.stateDir, LOCK_FILE), JSON.stringify({ pid: process.pid, startedAt: 1, port: viewer.port }));
    await assert.rejects(main(["pets-host", "disable", ...box.argv], box.ctx), (error) => plain(error)
      && new RegExp(`^The Goblin Horde on port ${viewer.port} answered, but did not say that its shared listener is closed and that nobody is signed in to it\\. Stop Goblin Horde to close it, then check with pets-host status\\.$`).test(error.message),
    JSON.stringify(said));
    assert.deepEqual(viewer.asked, [{ enabled: false }], "the viewer was asked");
    assert.ok(!box.said().includes("signed out"), `${JSON.stringify(said)}: no sign-out is claimed`);
  }
});

/**
 * A raw stand-in for a viewer on 127.0.0.1 that answers the health check as this test's own process and GET
 * /api/shared as a viewer on `stateDir`, and whose answer to `stuck` ("GET" or "POST" of /api/shared) is a 200
 * and half a body that never ends.
 */
async function halfAnswering(t, stateDir, stuck) {
  const sockets = new Set();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk;
      if (!text.includes("\r\n\r\n")) return;
      const [method, path] = text.split(" ");
      const whole = (data) => { const body = JSON.stringify(data); socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`); };
      if (path === "/api/health") return whole({ product: "GoblinHorde", pid: process.pid });
      if (path === "/api/shared" && method !== stuck) return whole({ shared: listening(45123), stateDir });
      return socket.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"shared\":");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  return server.address().port;
}

test("pets-host gives up on a viewer that sends half an answer, at its deadline, and changes nothing", { timeout: 60_000 }, async (t) => {
  // The review's case: the viewer the lock names sends a 200 and an unfinished body to everything but the health check.
  for (const [stuck, words, deadline] of [["GET", /holds the saved game here and did not answer, so nothing was changed\./, 4000],
    ["POST", /^Goblin Horde is running but did not answer\. Try again in a moment\.$/, 2000]]) {
    const box = await computer(t, { env: { GOBLIN_SHARED_LOOPBACK: "45123" }, context: { viewerWaitMs: 400 } });
    mkdirSync(box.stateDir);
    writeSharedSetting(box.stateDir, { enabled: true, address: "127.0.0.1" });
    const port = await halfAnswering(t, box.stateDir, stuck);
    writeFileSync(join(box.stateDir, LOCK_FILE), JSON.stringify({ pid: process.pid, startedAt: 1, port }));
    const before = readFileSync(join(box.stateDir, SHARED_FILE), "utf8");
    const started = Date.now();
    const outcome = await Promise.race([petsHost(box.ctx, box.flags, "disable").then(() => "claimed", (error) => error), sleep(15_000).then(() => "still waiting")]);
    assert.ok(outcome instanceof Error && plain(outcome) && words.test(outcome.message), `${stuck}: ${outcome?.message ?? outcome}`);
    assert.ok(Date.now() - started < deadline, `${stuck}: refused after ${Date.now() - started} ms`);
    assert.equal(readFileSync(join(box.stateDir, SHARED_FILE), "utf8"), before, `${stuck}: shared.json is as it was`);
    assert.ok(!box.said().includes("signed out"));
  }
});

test("pets-host refuses to change anything while a viewer holds the state folder and does not answer", { timeout: 60_000 }, async (t) => {
  // It accepts connections and never answers, as a viewer that is stuck does.
  const stuck = createServer(() => {});
  await new Promise((resolve) => stuck.listen(0, "127.0.0.1", resolve));
  t.after(() => { stuck.closeAllConnections(); stuck.close(); });
  for (const [action, enabled] of [["disable", true], ["enable", false]]) {
    const box = await computer(t, { env: { GOBLIN_SHARED_LOOPBACK: "45123" }, context: QUICK_WATCH });
    mkdirSync(box.stateDir);
    writeSharedSetting(box.stateDir, { enabled, address: "127.0.0.1" });
    // Its heartbeat goes on, so it is alive, and its port takes a connection and says nothing.
    const viewer = await runningHolder(t, box.stateDir, { pid: process.pid, port: stuck.address().port });
    const before = readFileSync(join(box.stateDir, SHARED_FILE), "utf8");
    await assert.rejects(main(["pets-host", action, ...box.argv], box.ctx), (error) => plain(error)
      && new RegExp(`^A Goblin Horde on this computer \\(process ${process.pid}, port ${stuck.address().port}\\) holds the saved game here and did not answer, so nothing was changed\\.`).test(error.message), action);
    assert.equal(readFileSync(join(box.stateDir, SHARED_FILE), "utf8"), before, `${action}: shared.json is as it was`);
    assert.ok(!box.said().includes("signed out"));
    const status = await petsHost(box.ctx, box.flags, "status");
    assert.equal(status.heldBy.port, stuck.address().port, "status still answers, and names the holder");

    // Once its heartbeat has stopped for long enough it holds nothing, though another program still has its process id and its port.
    viewer.crash();
    if (action !== "disable") continue;
    const off = await petsHost(box.ctx, box.flags, "disable");
    assert.equal(off.messages.at(-1), "No Goblin Horde runs on this state folder now, so nothing was listening.");
    assert.equal(readSharedSetting(box.stateDir).enabled, false, "so the choice is saved for the next start");
  }
});

test("pets-host changes nothing, and says why, while this installation's viewer runs and is too old to share a game", async (t) => {
  const box = await computer(t, { env: { GOBLIN_SHARED_LOOPBACK: "45123" } });
  // A viewer from before the shared game: it answers the health check as this installation's own and has no /api/shared.
  const old = createServer((request, response) => {
    const known = request.url === "/api/health";
    response.writeHead(known ? 200 : 404, { "Content-Type": "application/json" });
    response.end(JSON.stringify(known ? { product: "GoblinHorde", pid: process.pid, installDir: box.flags.installDir } : { error: "Not found" }));
  });
  await new Promise((resolve) => old.listen(box.flags.port, "127.0.0.1", resolve));
  t.after(() => { old.closeAllConnections(); old.close(); });
  for (const action of ["enable", "disable"]) {
    await assert.rejects(petsHost(box.ctx, box.flags, action), (error) => plain(error)
      && error.message === "The Goblin Horde that is running is older than this manager and has no shared game. Install this version over it, then try again.", action);
  }
  assert.equal(existsSync(join(box.stateDir, SHARED_FILE)), false, "no choice was saved that the running viewer would never read");
  assert.equal((await petsHost(box.ctx, box.flags, "status")).enabled, false, "status still answers");
});

test("pets-join takes the code from a file or standard input only, checks the host first, and prints no part of the code", async (t) => {
  const host = await sharedHost(t);
  const box = await computer(t, { env: { GOBLIN_SHARED_LOOPBACK: "45123" } });
  const where = `127.0.0.1:${host.port}`;
  const refused = (options, pattern) => assert.rejects(petsJoin(box.ctx, box.flags, { host: where, ...options }), (error) => plain(error) && pattern.test(error.message)
    && !PARTS.some((part) => error.message.includes(part)));
  await refused({}, /in a file with --code-file <path>, or on standard input with --code-stdin\. It is never taken from the command line\.$/);
  await refused({ codeFile: join(box.root, "code.txt"), codeText: CODE }, /never taken from the command line/);
  await refused({ codeFile: CODE }, /^The file --code-file names could not be read\. Nothing was changed\.$/);
  await refused({ codeText: "" }, /is not a Goblin Horde pairing code, which is 8 letters and digits/);
  await refused({ codeText: `${CODE}${CODE}` }, /is not a Goblin Horde pairing code/);
  await refused({ codeText: "AAAAAAAA" }, /did not accept this computer's pairing code\. Nothing was changed\.$/);
  await refused({ codeText: CODE, host: "192.168.1.20" }, /--host must be the host computer's Tailscale address \(100\.x\.y\.z\) or MagicDNS name/);
  await refused({ codeText: CODE, host: "" }, /--host must be/);
  assert.equal(existsSync(box.stateDir), false, "no refused join saved anything");
  assert.throws(() => parseArgs(["pets-join", "--host", where, "--code", CODE]), /Unknown option --code\./);

  writeFileSync(join(box.root, "code.txt"), ` ${CODE.toLowerCase().slice(0, 4)} ${CODE.slice(4)}\r\n`);
  assert.equal(await main(["pets-join", "--host", where, "--code-file", join(box.root, "code.txt"), ...box.argv], box.ctx), 0);
  assert.deepEqual(readRemoteSetting(box.stateDir, { env: box.ctx.env }), { name: "127.0.0.1", port: host.port, origin: `http://${where}`, code: CODE });
  assert.match(box.lines[0], /^Joined\. This computer now shows the shared game on 127\.0\.0\.1, and its own saved game is left as it is\.$/);
  assert.match(box.lines[1], /^Start Goblin Horde to see it: node .* start --surface pets$/);
  assert.ok(!PARTS.some((part) => box.said().includes(part)), box.said());

  const piped = await computer(t, { env: { GOBLIN_SHARED_LOOPBACK: "45123" } });
  const joined = await petsJoin(piped.ctx, piped.flags, { host: where, codeText: `${CODE}\n` });
  assert.deepEqual([joined.joined, joined.host], [true, where]);
  assert.ok(!PARTS.some((part) => JSON.stringify(joined).includes(part)), "the result that --json prints holds no code");

  box.lines.length = 0;
  assert.equal(await main(["pets-join", "--off", ...box.argv], box.ctx), 0);
  assert.equal(readRemoteSetting(box.stateDir), null);
  assert.match(box.lines[0], /^This computer plays its own game again/);
  box.lines.length = 0;
  await main(["pets-join", "--off", ...box.argv], box.ctx);
  assert.deepEqual(box.lines, ["This computer was not joined to a shared game."]);
});

test("pets-join refuses a host spelled as a number before anything is sent, and never repeats what a host answers", async (t) => {
  // This server stands for a place the code must not reach. It answers every request with the code, as its reason.
  const got = { connections: 0, requests: [] };
  const echo = createServer((request, response) => {
    got.requests.push(`${request.method} ${request.url}`);
    response.writeHead(403, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: CODE, code: CODE }));
  });
  echo.on("connection", () => { got.connections += 1; });
  await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
  t.after(() => { echo.closeAllConnections(); echo.close(); });
  const { port } = echo.address();

  // The stand-in is on, so 127.0.0.1 itself is allowed: every other spelling of it must still be refused.
  const box = await computer(t, { env: { GOBLIN_SHARED_LOOPBACK: "45123" } });
  for (const spelling of ["0x7f000001", "0X7F000001", "2130706433", "017700000001", "0177.0.0.1", "127.1", "0x7f.1", "[::1]", "::ffff:127.0.0.1", "user@127.0.0.1", "0xa9fea9fe", "0x08080808", "0x64656667"]) {
    for (const host of [`${spelling}:${port}`, `http://${spelling}:${port}/`]) {
      await assert.rejects(petsJoin(box.ctx, box.flags, { host, codeText: CODE }), (error) => plain(error)
        && /^--host must be the host computer's Tailscale address \(100\.x\.y\.z\) or MagicDNS name/.test(error.message) && !PARTS.some((part) => error.message.includes(part)), host);
    }
  }
  assert.deepEqual(got, { connections: 0, requests: [] }, "nothing was sent anywhere");

  await assert.rejects(petsJoin(box.ctx, box.flags, { host: `127.0.0.1:${port}`, codeText: CODE }), (error) => plain(error)
    && error.message === "The shared game on 127.0.0.1 refused this computer. Nothing was changed.");
  assert.deepEqual(got.requests, ["GET /api/pets/whoami"], "the host was asked, and what it answered is not in the message");
  assert.equal(existsSync(box.stateDir), false, "and nothing was saved");
  assert.ok(!PARTS.some((part) => box.said().includes(part)));
});

test("a computer is a host or a display: each command refuses while the other is set up", async (t) => {
  const box = await computer(t, { tailscale: servitor, env: { GOBLIN_SHARED_LOOPBACK: "45123" } });
  writeRemoteSetting(box.stateDir, { origin: "http://127.0.0.1:45000", code: CODE });
  await assert.rejects(petsHost(box.ctx, box.flags, "enable"), /A computer is a host or a display, not both\. Run pets-join --off first\.$/);
  assert.equal(readSharedSetting(box.stateDir).enabled, false);

  const hosting = await computer(t, { env: { GOBLIN_SHARED_LOOPBACK: "45123" } });
  writeSharedSetting(hosting.stateDir, { enabled: true, address: "127.0.0.1" });
  await assert.rejects(petsJoin(hosting.ctx, hosting.flags, { host: "127.0.0.1:45000", codeText: CODE }), /A computer is a host or a display, not both\. Run pets-host disable first\.$/);
  assert.equal(readRemoteSetting(hosting.stateDir), null);
});

const shared = (report) => Object.fromEntries(report.checks.filter((check) => check.group === "shared").map((check) => [check.name, check]));

test("doctor's shared group is quiet on a computer that shares nothing, and prints under its own heading", async (t) => {
  const box = await computer(t);
  const group = shared(await doctor(box.ctx, box.flags));
  assert.deepEqual(Object.entries(group).map(([name, check]) => [name, check.state]),
    [["shared-tailscale", "optional"], ["shared-address", "optional"], ["shared-whois", "optional"], ["shared-host", "none"], ["shared-remote", "none"]]);
  assert.equal(await main(["doctor", ...box.argv], box.ctx), 0);
  const heading = box.lines.indexOf("  Shared game (pets-host, pets-join):");
  assert.ok(heading > box.lines.indexOf("  Pet game (start --surface pets):"), box.said());
  assert.deepEqual(box.lines.slice(heading + 1, heading + 6).map((line) => line.trim().split(/\s+/).slice(0, 2).join(" ")),
    ["· shared-tailscale", "· shared-address", "· shared-whois", "· shared-host", "· shared-remote"]);
  box.lines.length = 0;
  await main(["doctor", "--report", ...box.argv], box.ctx);
  assert.match(box.lines[0], /shared-tailscale optional · shared-address optional · shared-whois optional · shared-host none · shared-remote none/);
});

test("doctor says whether Tailscale is signed in, this computer's address, and whether the login check works, without the login", async (t) => {
  const box = await computer(t, { tailscale: servitor });
  writeSharedSetting(box.stateDir, { enabled: true, address: servitor.address });
  const group = shared(await doctor(box.ctx, box.flags));
  assert.deepEqual(Object.values(group).map((check) => check.state), ["ok", "ok", "ok", "ok", "none"]);
  assert.match(group["shared-tailscale"].detail, /^Tailscale is connected and signed in/);
  assert.equal(group["shared-address"].detail, "This computer's Tailscale address is 100.101.102.103.");
  assert.match(group["shared-whois"].detail, /^The login check works/);
  assert.match(group["shared-host"].detail, new RegExp(`^On for 100\\.101\\.102\\.103, port ${box.flags.port}\\. The listener runs while Goblin Horde runs\\.$`));
  assert.ok(!JSON.stringify(group).includes(OWNER) && !JSON.stringify(group).includes("owner"), "the login itself is never in a detail");
  assert.ok(box.ran.includes("whois --json 100.101.102.103"), "the login check is tried on this computer's own address");

  const tagged = await computer(t, { tailscale: { ...servitor, peers: { [servitor.address]: "tagged-devices" } } });
  writeSharedSetting(tagged.stateDir, { enabled: true, address: servitor.address });
  const broken = shared(await doctor(tagged.ctx, tagged.flags))["shared-whois"];
  assert.deepEqual([broken.state, broken.detail], ["error", "tailscale whois did not name this computer's own account, so a host here would refuse every caller."]);

  const signedOut = await computer(t, { tailscale: { login: "", address: "100.101.102.103" }, adapters: {} });
  writeSharedSetting(signedOut.stateDir, { enabled: true, address: servitor.address });
  assert.deepEqual(Object.values(shared(await doctor(signedOut.ctx, signedOut.flags))).map((check) => check.state), ["warning", "missing", "missing", "ok", "none"]);

  const noProgram = await computer(t, { adapters: { Tailscale: [{ family: "IPv4", internal: false, address: "100.90.1.2" }] } });
  writeSharedSetting(noProgram.stateDir, { enabled: true, address: "100.90.1.2" });
  const without = shared(await doctor(noProgram.ctx, noProgram.flags));
  assert.deepEqual([without["shared-tailscale"].state, without["shared-address"].state, without["shared-whois"].state, without["shared-host"].state], ["missing", "missing", "missing", "error"]);
  assert.equal(without["shared-whois"].detail, "Tailscale's program was not found, so the shared game cannot check who is calling. A host does not listen without it.");
  assert.equal(without["shared-host"].detail, "On, but it cannot listen. Tailscale's program was not found, so the shared game cannot check who is calling.");
  assert.equal(await main(["doctor", ...noProgram.argv], noProgram.ctx), 0, "none of this changes doctor's exit code");
  assert.ok(noProgram.lines.some((line) => line.startsWith("  ✗ shared-host")), noProgram.said());
});

test("doctor warns loudly when a computer is set up as both a host and a display, and names a joined or damaged display", async (t) => {
  const box = await computer(t, { env: { GOBLIN_SHARED_LOOPBACK: "45123" } });
  writeRemoteSetting(box.stateDir, { origin: "http://127.0.0.1:45000", code: CODE });
  let group = shared(await doctor(box.ctx, box.flags));
  assert.deepEqual([group["shared-remote"].state, group["shared-remote"].detail],
    ["ok", "Joined: this computer shows the game on 127.0.0.1:45000 and keeps no saved game of its own in use."]);
  assert.equal(group["shared-role"], undefined);
  assert.match(group["shared-tailscale"].detail, /loopback stand-in is set \(GOBLIN_SHARED_LOOPBACK\), so Tailscale is not asked/);
  assert.deepEqual(box.ran, [], "with the stand-in the tailscale program is not run");

  writeSharedSetting(box.stateDir, { enabled: true, address: "127.0.0.1" });
  group = shared(await doctor(box.ctx, box.flags));
  assert.equal(group["shared-role"].state, "conflict");
  assert.match(group["shared-role"].detail, /^WARNING: THIS COMPUTER IS SET UP AS BOTH A HOST AND A DISPLAY\./);
  await main(["doctor", ...box.argv], box.ctx);
  assert.ok(box.lines.some((line) => line.startsWith("  ✗ shared-role")), box.said());
  assert.ok(!PARTS.some((part) => box.said().includes(part)), "doctor never prints the code a display saved");

  writeFileSync(join(box.stateDir, REMOTE_FILE), "{");
  group = shared(await doctor(box.ctx, box.flags));
  assert.equal(group["shared-remote"].state, "error");
  assert.match(group["shared-remote"].detail, /^This computer's shared game settings could not be read\./);
});

test("a full reset knows the shared game's files, and the manager knows its new options", () => {
  const dir = join(tmpdir(), "goblin-shared-state-names");
  const named = new Set(stateFiles(dir).map((file) => basename(file)));
  for (const file of [SHARED_FILE, REMOTE_FILE, REMOTE_CODE_FILE, LOCK_FILE, CODE_FILE]) assert.ok(named.has(file), file);
  // The copies kept of saved games that could not be read are named as they are found.
  const withCopies = mkdtempSync(join(tmpdir(), "goblin-shared-state-copies-"));
  try {
    for (const name of ["pets.json.unreadable.1762880400000-abcd1234", "pets.json.unreadable.1762880430000-00ff00ff", "pets.json.unreadable", "pets.json.unrelated.txt"]) writeFileSync(join(withCopies, name), "x");
    const reset = stateFiles(withCopies).map((file) => basename(file));
    assert.deepEqual(reset.filter((name) => name.startsWith("pets.json.unr")).sort(), ["pets.json.unreadable", "pets.json.unreadable.1762880400000-abcd1234", "pets.json.unreadable.1762880430000-00ff00ff"]);
  } finally { rmSync(withCopies, { recursive: true, force: true }); }
  const parsed = parseArgs(["pets-join", "--host", "100.101.102.103:43917", "--code-file", "C:\\code.txt", "--off", "--replace", "--code-stdin"]);
  assert.deepEqual([parsed.command, parsed.flags.host, parsed.flags["code-file"], parsed.flags.off, parsed.flags.replace, parsed.flags["code-stdin"]],
    ["pets-join", "100.101.102.103:43917", "C:\\code.txt", true, true, true]);
  assert.deepEqual([parseArgs(["pets-adopt", "C:\\save\\pets.json"]).sub, parseArgs(["pets-host", "enable"]).sub], ["C:\\save\\pets.json", "enable"]);
});

test("manage.ps1 runs the shared game's commands, with the pairing code never a parameter", { skip: process.platform !== "win32" && "manage.ps1 is the Windows wrapper", timeout: 120_000 }, async (t) => {
  const box = await computer(t);
  const env = { ...process.env, LOCALAPPDATA: join(box.root, "local"), GOBLIN_HORDE_STATE_DIR: box.stateDir, GOBLIN_SHARED_LOOPBACK: "45123", GOBLIN_T3_DB: join(box.root, "no-t3.sqlite"),
    CLAUDE_CONFIG_DIR: join(box.root, "claude"), CODEX_HOME: join(box.root, "codex") };
  const script = fileURLToPath(new URL("../manage.ps1", import.meta.url));
  const run = (...args) => {
    const done = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args, "-InstallRoot", box.flags.installDir, "-Port", String(box.flags.port)],
      { env, encoding: "utf8", windowsHide: true });
    return { status: done.status, out: `${done.stdout || ""}${done.stderr || ""}` };
  };
  const enabled = run("-Action", "PetsHost", "-HostAction", "enable");
  assert.equal(enabled.status, 0, enabled.out);
  assert.match(enabled.out, /Shared game host: on for 127\.0\.0\.1:45123\./);
  assert.deepEqual(readSharedSetting(box.stateDir), { enabled: true, address: "127.0.0.1" });
  assert.match(run("-Action", "PetsHost").out, /Shared game host: on for 127\.0\.0\.1:45123\./, "with no -HostAction it shows the status");
  assert.equal(run("-Action", "PetsHost", "-HostAction", "code").status, 1, "a pipe is not a terminal");
  assert.match(run("-Action", "PetsHost", "-HostAction", "disable").out, /Shared game host: off\./);

  const adopted = run("-Action", "PetsAdopt", "-SaveFile", saveFile(box));
  assert.equal(adopted.status, 0, adopted.out);
  assert.match(adopted.out, /Adopted the saved game, with 4321 coins, 17 goblins, and 4 bosses cleared\./);
  assert.equal(run("-Action", "PetsAdopt", "-SaveFile", saveFile(box)).status, 1, "a second adoption needs -Replace");
  assert.equal(run("-Action", "PetsAdopt", "-SaveFile", saveFile(box), "-Replace").status, 0);

  const refused = run("-Action", "PetsJoin", "-HostAddress", "192.168.1.20", "-CodeFile", saveFile(box, `${CODE}\n`, "code.txt"));
  assert.equal(refused.status, 1);
  assert.match(refused.out, /--host must be the host computer's Tailscale address/);
  assert.match(run("-Action", "PetsJoin", "-Off").out, /This computer was not joined to a shared game\./);
  // PowerShell reads -Code as short for -CodeFile, so a code typed there is taken for a file name and never as a code.
  const typed = run("-Action", "PetsJoin", "-HostAddress", "127.0.0.1:45000", "-Code", CODE);
  assert.equal(typed.status, 1);
  assert.match(typed.out, /The file --code-file names could not be read\. Nothing was changed\./);
  assert.ok(!PARTS.some((part) => typed.out.includes(part)), typed.out);
  assert.ok(!existsSync(join(box.root, "home", ".t3")), "the stand-in home was never read for a T3 database");
});

const SHARED_DOCS = ["docs/SHARED-PETS.md", "docs/SHARED-HOST-PROMPT.md", "docs/SHARED-JOIN-PROMPT.md"];
const readDoc = (file) => readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8");
const promptBlock = (file) => {
  const blocks = [...readDoc(file).matchAll(/```\r?\n([\s\S]*?)\r?\n```/g)].map((match) => match[1]);
  assert.equal(blocks.length, 1, `${file} holds one prompt`);
  return blocks[0];
};

test("the shared game's documents ship, name only commands and options the manager has, and use plain punctuation", () => {
  const manifest = readManifest(fileURLToPath(new URL("..", import.meta.url)));
  const commands = new Set(["status", "doctor", "install", "start", "stop", "uninstall", "pets-host", "pets-join", "pets-adopt"]);
  for (const file of [...SHARED_DOCS, "AGENTS.md", "skills/goblin-horde-manager/SKILL.md"]) {
    const text = readDoc(file);
    for (const option of new Set(text.match(/--[a-z][a-z-]*/g))) assert.doesNotThrow(() => parseArgs(["doctor", option, "value"]), `${file} names ${option}`);
    assert.doesNotMatch(text, /[–—]/, `${file} has a long dash`);
    assert.doesNotMatch(text, /--code\b(?!-)/, `${file} never shows the code as an option`);
    for (const [, command] of text.matchAll(/node goblin\.mjs ([a-z-]+)/g)) assert.ok(commands.has(command), `${file} runs "${command}"`);
  }
  for (const file of SHARED_DOCS) assert.ok(manifest.includes(file), `${file} ships in the package`);
  for (const sub of [...readDoc("docs/SHARED-PETS.md").matchAll(/`pets-host ([a-z]+)`/g)].map((match) => match[1]))
    assert.ok(["enable", "disable", "status", "code"].includes(sub), `pets-host ${sub}`);
  for (const file of ["AGENTS.md", "README.md", "SECURITY.md"]) assert.match(readDoc(file), /pets-host enable/, `${file} says how the shared game is turned on`);
});

test("the host prompt checks before it changes, keeps a saved game, proves a paid turn, and never asks for the code", () => {
  const prompt = promptBlock("docs/SHARED-HOST-PROMPT.md");
  const lines = prompt.split(/\r?\n/);
  assert.ok(lines.length <= 20, `${lines.length} lines`);
  const order = ["Change nothing yet", "node goblin.mjs status", "node goblin.mjs pets-host status", "node goblin.mjs doctor", "counts only", "another Goblin Horde holds the saved game, stop",
    "node goblin.mjs install --no-start", "Never run uninstall", "--remove-settings", "Only if step 1 found no saved game", "pets-adopt", "pets-host enable", "start --surface pets",
    "http://127.0.0.1:43917/api/pets", "finish one turn in T3 Code on this computer", "/api/pets?after=", "\"work\" event whose coins", "above 0", "10 seconds apart", "risen once and stayed",
    "Tailscale address and port", "Never print, open, or send the pairing code"];
  let at = 0;
  for (const needed of order) {
    const found = prompt.indexOf(needed, at);
    assert.ok(found >= 0, `"${needed}" is missing or out of order`);
    at = found;
  }
  assert.match(prompt, /I read the code myself with pets-host code\./, "the owner reads the code, not the agent");
  assert.doesNotMatch(prompt, /--replace/, "the prompt never replaces a saved game");
  assert.doesNotMatch(prompt, /claude-hooks/, "an update leaves the Claude Code connection as it is");
  // The words the prompt waits for are the ones the manager prints.
  assert.match(readFileSync(fileURLToPath(new URL("../lib/shared-manager.mjs", import.meta.url)), "utf8"), /Another Goblin Horde on this computer holds the saved game/);
});

test("the join prompt installs, joins with a code file it never opens, and reports the host's numbers", () => {
  const prompt = promptBlock("docs/SHARED-JOIN-PROMPT.md");
  assert.ok(prompt.split(/\r?\n/).length <= 20);
  assert.doesNotMatch(prompt, /claude-hooks/, "an update leaves the Claude Code connection as it is");
  const order = ["node goblin.mjs doctor", "node goblin.mjs install --no-start", "host's Tailscale address and port", "Do not open, print, or copy that file",
    "pets-join --host <address>:<port> --code-file", "report the problem as worded and stop", "Run: stop, then start --surface pets", "http://127.0.0.1:43917/api/pets", "the host's numbers",
    "delete the text file", "Never print or send the pairing code", "pets-join --off"];
  let at = 0;
  for (const needed of order) {
    const found = prompt.indexOf(needed, at);
    assert.ok(found >= 0, `"${needed}" is missing or out of order`);
    at = found;
  }
  // A viewer chooses its game when it starts, so the prompt must stop one that runs before it starts the pet game.
  assert.match(prompt, /5\. Run: stop, then start --surface pets\. A viewer picks its own game or the host's when\s+it starts/);
});
