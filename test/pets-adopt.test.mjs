/**
 * pets-adopt on invented computers and temporary folders: the cutoff an adopted game carries, the file a person
 * names for it, and the copies it keeps of a saved game it replaces. Every file here is in a temp folder, and the
 * network share and device paths are only ever text: nothing opens them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { appendFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import { stateFiles } from "../lib/manager.mjs";
import { LOCK_FILE, createPetsLock } from "../lib/pets-lock.mjs";
import { createPetsStore } from "../lib/pets-store.mjs";
import { createRewardEngine } from "../lib/reward-engine.mjs";
import { readSaveFile } from "../lib/save-file.mjs";
import { petsAdopt } from "../lib/shared-manager.mjs";
import { t3Source } from "../lib/t3-source.mjs";
import { main } from "../goblin.mjs";
import { CONFIG, MIN, computer, laptopSave, plain, saveFile, saved } from "./helpers/manager-box.mjs";
import { createT3Fixture, hasSqlite } from "./helpers/t3-fixture.mjs";

const needsSqlite = { skip: !hasSqlite && "this Node.js has no node:sqlite" };
const LIMIT = 1_000_000;
const COPY = /^pets\.json\.before-adopt-\d{8}T\d{9}Z-[a-f0-9]{6}$/;
const copies = (box) => readdirSync(box.stateDir).filter((name) => name.startsWith("pets.json.before-adopt-")).sort();
const refusedWith = (reason) => (error) => error.name === "SaveFileError" && error.reason === reason;
const THROUGH_A_LINK = "That path goes through a link or a folder that stands for another, so it was not read and nothing was changed. Give the path of the saved game file itself.";

test("an adopted game never pays work that finished before the adoption, whether T3 Code was unreadable then or wrote the row later", needsSqlite, async (t) => {
  const t3 = mkdtempSync(join(tmpdir(), "goblin-adopt-t3-"));
  t.after(() => rmSync(t3, { recursive: true, force: true }));
  for (const [what, readable] of [["T3 Code's database could not be read at the adoption", false], ["T3 Code wrote the rows after the adoption", true]]) {
    const dir = join(t3, readable ? "there" : "later");
    let fixture = readable ? createT3Fixture({ dir }) : null;
    const box = await computer(t, { env: { GOBLIN_T3_DB: join(dir, "statev2.sqlite") } });
    const before = Date.now();
    await petsAdopt(box.ctx, box.flags, { path: saveFile(box) });
    const adoptedAt = saved(box).notBefore;
    assert.ok(adoptedAt >= before && adoptedAt <= Date.now(), `${what}: the cutoff is the moment of adoption`);
    assert.deepEqual(saved(box).sources.t3, { at: adoptedAt, seen: [] });

    fixture ??= createT3Fixture({ dir });
    fixture.addTurn({ id: "a-minute-before", completedAt: adoptedAt - MIN });
    fixture.addTurn({ id: "nine-minutes-before", completedAt: adoptedAt - 9 * MIN });
    fixture.addSubagent({ id: "a-second-before", completedAt: adoptedAt - 1000 });
    const source = t3Source(fixture.path);
    try {
      const engine = createRewardEngine({ config: CONFIG, store: createPetsStore({ dir: box.stateDir, config: CONFIG }), source });
      assert.deepEqual(await engine.start(), { welcome: false, away: null, caughtUp: { turns: 0, coins: 0 } }, what);
      assert.deepEqual(await engine.tick(), { ok: true, coins: 0, xp: 0, turns: 0, subagents: 0 }, what);
      assert.equal(engine.snapshot().state.wallet.coins, 4321, what);
      fixture.addTurn({ id: "after-the-adoption", completedAt: Date.now() });
      const paid = await engine.tick();
      assert.ok(paid.ok && paid.turns === 1 && paid.coins > 0, `${what}: work that finishes after the adoption pays`);
      assert.equal(saved(box).notBefore, adoptedAt, "and the cutoff stays in the saved game");
    } finally {
      source.close();
      fixture.close();
    }
  }
});

test("pets-adopt takes a game saved when there were more bosses, with its count held to the bosses this game has", async (t) => {
  const box = await computer(t);
  const adopted = await petsAdopt(box.ctx, box.flags, { path: saveFile(box, laptopSave({ bosses: CONFIG.bosses.count + 4, horde: 17 })) });
  assert.deepEqual([adopted.horde, adopted.bosses], [17, CONFIG.bosses.count]);
  assert.match(adopted.messages[0], new RegExp(`17 goblins, and ${CONFIG.bosses.count} bosses cleared\\.$`));
  assert.deepEqual([saved(box).state.horde.size, saved(box).state.bosses.cleared], [17, CONFIG.bosses.count]);
});

test("pets-adopt refuses a network share and a device from the path's own text, before anything is opened", async (t) => {
  const box = await computer(t);
  const notLocal = ["\\\\fileserver\\share\\pets.json", "//fileserver/share/pets.json", "\\\\?\\C:\\saves\\pets.json", "\\\\?\\UNC\\fileserver\\share\\pets.json", "\\\\.\\pipe\\goblin",
    "\\\\.\\C:\\saves\\pets.json", "\\??\\C:\\saves\\pets.json", "\\\\127.0.0.1\\c$\\saves\\pets.json"];
  const onWindows = ["NUL", "C:\\saves\\CON", "C:\\saves\\com1.json", "C:\\saves\\pets.json:hidden"];
  // A file system that fails the test if it is asked for anything.
  const untouched = new Proxy({}, { get: (target, name) => (name === "constants" ? nodeFs.constants : () => { throw new Error(`fs.${String(name)} was called`); }) });
  for (const path of [...notLocal, ...(process.platform === "win32" ? onWindows : ["/dev/zero", "/proc/self/environ"])]) {
    assert.throws(() => readSaveFile(path, { limit: LIMIT, fs: untouched }), refusedWith("network"), path);
    await assert.rejects(petsAdopt(box.ctx, box.flags, { path, replace: true }), (error) => plain(error)
      && /^That path is a network share or a device, not a file on this computer's own disk, so it was not opened and nothing was changed\./.test(error.message), path);
  }
  assert.equal(nodeFs.existsSync(box.stateDir), false, "nothing was written");
});

test("pets-adopt refuses its own saved game under another name: a hard link, a link, and a folder that is a link", async (t) => {
  const box = await computer(t);
  await petsAdopt(box.ctx, box.flags, { path: saveFile(box, laptopSave({ coins: 100, horde: 5, bosses: 1 })) });
  await petsAdopt(box.ctx, box.flags, { path: saveFile(box, laptopSave({ coins: 200, horde: 6, bosses: 1 }), "second.json"), replace: true });
  const before = readdirSync(box.stateDir).sort();
  assert.ok(before.includes("pets.json.bak"), before.join(", "));
  const own = { save: join(box.stateDir, "pets.json"), backup: join(box.stateDir, "pets.json.bak") };
  const text = readFileSync(own.save, "utf8");

  const aliases = [];
  for (const [name, target] of Object.entries(own)) {
    linkSync(target, join(box.root, `hard-link-to-${name}.json`));
    aliases.push(join(box.root, `hard-link-to-${name}.json`));
    // A hard link inside the state folder is one too.
    linkSync(target, join(box.stateDir, `also-${name}.json`));
    aliases.push(join(box.stateDir, `also-${name}.json`));
  }
  // A folder that is a link to the state folder: the same file by another path. A junction needs no rights on Windows.
  symlinkSync(box.stateDir, join(box.root, "state-by-another-name"), "junction");
  aliases.push(join(box.root, "state-by-another-name", "pets.json"), join(box.root, "state-by-another-name", "pets.json.bak"));
  let fileLinks = true;
  try {
    symlinkSync(own.save, join(box.stateDir, "link-beside-it.json"), "file");
    aliases.push(join(box.stateDir, "link-beside-it.json"));
  } catch { fileLinks = false; }

  // A hard link is the saved game itself under another name. A path through a junction or a link is refused before it is opened.
  const refusal = (path) => (/hard-link-to|also-/.test(basename(path)) ? "That file is already this computer's own saved game." : THROUGH_A_LINK);
  for (const path of aliases) {
    for (const replace of [true, false]) {
      await assert.rejects(petsAdopt(box.ctx, box.flags, { path, replace }), (error) => plain(error) && error.message === refusal(path), `${basename(path)}, replace ${replace}`);
    }
  }
  assert.equal(readFileSync(own.save, "utf8"), text, "the saved game is as it was");
  assert.deepEqual(copies(box).length, 1, "and no further copy was made of it");
  if (!fileLinks) t.diagnostic("This account may not make file links, so the link to a file was not tried.");
});

test("pets-adopt follows no link to a file, wherever it points, and reads nothing that is not a file", async (t) => {
  const box = await computer(t);
  const elsewhere = join(box.root, "elsewhere");
  const given = join(box.root, "given");
  mkdirSync(elsewhere);
  mkdirSync(given);
  writeFileSync(join(elsewhere, "pets.json"), JSON.stringify(laptopSave({ coins: 999 })));
  writeFileSync(join(given, "real.json"), JSON.stringify(laptopSave({ coins: 555 })));
  await assert.rejects(petsAdopt(box.ctx, box.flags, { path: given }), (error) => plain(error) && error.message === "That path is not a file, so nothing was changed.", "a folder");
  assert.throws(() => readSaveFile(given, { limit: LIMIT }), refusedWith("not-file"));
  // What opens as something other than a file, even though it looked like one a moment before.
  const special = { ...nodeFs, fstatSync: (fd, options) => Object.assign(nodeFs.fstatSync(fd, options), { isFile: () => false }) };
  assert.throws(() => readSaveFile(join(given, "real.json"), { limit: LIMIT, fs: special }), refusedWith("not-file"));

  let linked = true;
  try {
    symlinkSync(join(elsewhere, "pets.json"), join(given, "points-away.json"), "file");
    symlinkSync(join(given, "real.json"), join(given, "points-beside.json"), "file");
  } catch { linked = false; }
  if (!linked) return t.diagnostic("This account may not make file links, so links to files were not tried.");
  for (const link of ["points-away.json", "points-beside.json"]) {
    assert.throws(() => readSaveFile(join(given, link), { limit: LIMIT }), refusedWith("link"), link);
    await assert.rejects(petsAdopt(box.ctx, box.flags, { path: join(given, link) }), (error) => plain(error) && error.message === THROUGH_A_LINK, link);
  }
  assert.equal(nodeFs.existsSync(box.stateDir), false, "nothing was written");
  assert.equal((await petsAdopt(box.ctx, box.flags, { path: join(given, "real.json") })).coins, 555, "the file itself, by its own path, is read");
});

test("pets-adopt refuses a path that goes through a junction or a link in a parent folder, and a path whose real place is a share", async (t) => {
  const box = await computer(t);
  const elsewhere = join(box.root, "elsewhere");
  const given = join(box.root, "given");
  mkdirSync(join(elsewhere, "deeper"), { recursive: true });
  mkdirSync(given);
  writeFileSync(join(elsewhere, "save.json"), JSON.stringify(laptopSave({ coins: 999 })));
  writeFileSync(join(elsewhere, "deeper", "save.json"), JSON.stringify(laptopSave({ coins: 888 })));
  // The review's case: parent\alias\save.json, where alias is a junction to another folder. A junction needs no rights on Windows.
  symlinkSync(elsewhere, join(given, "alias"), "junction");
  const through = [join(given, "alias", "save.json"), join(given, "alias", "deeper", "save.json")];
  let folderLinks = true;
  try {
    symlinkSync(elsewhere, join(given, "folder-link"), "dir");
    through.push(join(given, "folder-link", "save.json"));
  } catch { folderLinks = false; }
  for (const path of through) {
    assert.ok(readFileSync(path, "utf8").length > 100, `${path} does lead to a saved game`);
    assert.throws(() => readSaveFile(path, { limit: LIMIT }), refusedWith("link"), path);
    for (const replace of [false, true])
      await assert.rejects(petsAdopt(box.ctx, box.flags, { path, replace }), (error) => plain(error) && error.message === THROUGH_A_LINK, path);
  }
  assert.equal(nodeFs.existsSync(box.stateDir), false, "nothing was written");
  if (!folderLinks) t.diagnostic("This account may not make links to folders, so only the junction was tried. A link in a parent folder is refused the same way.");

  // A drive letter or a folder that stands for a share: the path's text is local, and only its real place says otherwise.
  const real = join(elsewhere, "save.json");
  for (const place of ["\\\\fileserver\\share\\save.json", "//fileserver/share/save.json", "\\\\?\\UNC\\fileserver\\share\\save.json"]) {
    const opened = [];
    const mapped = { ...nodeFs, realpathSync: Object.assign(() => place, { native: () => place }), openSync: (...args) => { opened.push(args[0]); return nodeFs.openSync(...args); } };
    assert.throws(() => readSaveFile(real, { limit: LIMIT, fs: mapped }), refusedWith("network"), place);
    assert.deepEqual(opened, [], `${place}: the file was not opened`);
  }
  // A real place elsewhere on this computer's disks is a link too, whatever it is made of.
  const moved = { ...nodeFs, realpathSync: Object.assign(() => join(elsewhere, "deeper", "save.json"), { native: () => join(elsewhere, "deeper", "save.json") }) };
  assert.throws(() => readSaveFile(real, { limit: LIMIT, fs: moved }), refusedWith("link"));

  // A plain path is read, and on Windows its letters' case does not make it another file.
  assert.equal(JSON.parse(readSaveFile(real, { limit: LIMIT })).state.wallet.coins, 999);
  if (process.platform === "win32") assert.equal(JSON.parse(readSaveFile(real.toUpperCase(), { limit: LIMIT })).state.wallet.coins, 999);
  assert.equal((await petsAdopt(box.ctx, box.flags, { path: real })).coins, 999);
});

test("pets-adopt never reads more than a saved game's size, however large the file is or grows", async (t) => {
  const box = await computer(t);
  const game = JSON.stringify(laptopSave());
  const padded = (bytes) => game + " ".repeat(bytes - Buffer.byteLength(game));
  const refuse = (path) => assert.rejects(petsAdopt(box.ctx, box.flags, { path }), (error) => plain(error) && /could not be read, so nothing was changed\.$/.test(error.message));
  await refuse(saveFile(box, padded(LIMIT + 1), "one-byte-over.json"));
  await refuse(saveFile(box, padded(5 * LIMIT), "five-times-over.json"));
  assert.equal(nodeFs.existsSync(box.stateDir), false);

  // A file that is small when its size is asked and is 3 MB by the time it is read.
  const growing = saveFile(box, game, "growing.json");
  let asked = 0;
  let most = 0;
  const grows = {
    ...nodeFs,
    fstatSync(fd, options) {
      const stat = nodeFs.fstatSync(fd, options);
      appendFileSync(growing, " ".repeat(3 * LIMIT));
      return stat;
    },
    readSync(fd, buffer, offset, length, position) {
      const read = nodeFs.readSync(fd, buffer, offset, length, position);
      asked += read;
      most = Math.max(most, buffer.length);
      return read;
    },
  };
  assert.throws(() => readSaveFile(growing, { limit: LIMIT, fs: grows }), refusedWith("too-large"));
  assert.ok(asked === LIMIT + 1 && most === LIMIT + 1, `it read ${asked} bytes into a buffer of ${most}`);

  assert.equal(readSaveFile(saveFile(box, padded(LIMIT), "exactly-the-limit.json"), { limit: LIMIT }).length, LIMIT, "a file of exactly the limit is read whole");
  assert.equal((await petsAdopt(box.ctx, box.flags, { path: join(box.root, "exactly-the-limit.json") })).coins, 4321);
});

test("each saved game that is replaced is kept under a name of its own, even two in the same millisecond", async (t) => {
  const at = Date.UTC(2026, 10, 11, 17, 13, 0, 123);
  const box = await computer(t, { context: { now: () => at } });
  const adopt = (coins, replace = true) => main(["pets-adopt", saveFile(box, laptopSave({ coins }), `save-${coins}.json`), ...(replace ? ["--replace"] : []), ...box.argv], box.ctx);
  await adopt(100, false);
  const first = readFileSync(join(box.stateDir, "pets.json"), "utf8");
  await adopt(200);
  const second = readFileSync(join(box.stateDir, "pets.json"), "utf8");
  await adopt(300);

  const kept = copies(box);
  assert.equal(kept.length, 2, `both replaced games are kept: ${kept.join(", ")}`);
  for (const name of kept) {
    assert.match(name, COPY);
    assert.ok(name.startsWith("pets.json.before-adopt-20261111T171300123Z-"), name);
    assert.ok(box.said().includes(name), "each copy's name is told");
  }
  assert.deepEqual(kept.map((name) => readFileSync(join(box.stateDir, name), "utf8")).sort(), [first, second].sort(), "one copy is the first game and the other the second, whole");
  assert.equal(saved(box).state.wallet.coins, 300);
  assert.equal(saved(box).notBefore, at);
  const reset = stateFiles(box.stateDir).map((file) => basename(file));
  for (const name of kept) assert.ok(reset.includes(name), "a full reset removes the copies too");
});

test("a copy of a replaced saved game is never written over: when its name is taken, nothing is changed", async (t) => {
  const at = Date.UTC(2026, 10, 11, 17, 13, 0, 123);
  const box = await computer(t, { context: { now: () => at, token: () => "abc123" } });
  await petsAdopt(box.ctx, box.flags, { path: saveFile(box, laptopSave({ coins: 100 })) });
  const first = readFileSync(join(box.stateDir, "pets.json"), "utf8");
  const second = await petsAdopt(box.ctx, box.flags, { path: saveFile(box, laptopSave({ coins: 200 })), replace: true });
  assert.equal(second.kept, "pets.json.before-adopt-20261111T171300123Z-abc123");
  const present = readFileSync(join(box.stateDir, "pets.json"), "utf8");

  await assert.rejects(petsAdopt(box.ctx, box.flags, { path: saveFile(box, laptopSave({ coins: 300 })), replace: true }), (error) => plain(error)
    && error.message === "A copy of the saved game that is here could not be kept, so nothing was changed. Try again.");
  assert.equal(readFileSync(join(box.stateDir, second.kept), "utf8"), first, "the copy that was there still holds the first game");
  assert.equal(readFileSync(join(box.stateDir, "pets.json"), "utf8"), present, "and the saved game was not replaced");
  assert.deepEqual(readdirSync(box.stateDir).sort(), ["pets.json", "pets.json.bak", second.kept], "the lock is released");
});

test("a lock that a crashed pets-adopt left behind stops holding the saved game once it has shown no heartbeat for long enough", async (t) => {
  // The command watches a lock on its own clock. Here that takes 600 ms where a real one takes 20 seconds.
  const box = await computer(t, { context: { lockTiming: { staleMs: 600, lookMs: 25 } } });
  mkdirSync(box.stateDir);
  const lock = join(box.stateDir, LOCK_FILE);
  // Another command holds the lock and runs. Its process id is one that is alive: this test's own parent.
  let heartbeat = null;
  const other = createPetsLock({ dir: box.stateDir, pid: process.ppid, startedAt: 1, beatMs: 40, setTimer: (run, ms) => (heartbeat = setInterval(run, ms)), clearTimer: clearInterval });
  t.after(() => clearInterval(heartbeat));
  await other.acquire();
  let started = performance.now();
  await assert.rejects(petsAdopt(box.ctx, box.flags, { path: saveFile(box) }), /Goblin Horde is running here and holds the saved game/, "a lock whose heartbeat is seen holds");
  assert.ok(performance.now() - started < 550, "and it is refused as soon as a heartbeat is seen, without watching the whole time");

  // It crashes: the lock stays, no heartbeat comes again, and its date is left an hour ahead and then an hour behind.
  clearInterval(heartbeat);
  for (const hours of [1, -1]) {
    const date = new Date(Date.now() + hours * 3_600_000);
    utimesSync(lock, date, date);
    started = performance.now();
    assert.equal((await petsAdopt(box.ctx, box.flags, { path: saveFile(box), replace: true })).coins, 4321, "with no heartbeat for long enough it is taken over, whatever its date");
    assert.ok(performance.now() - started >= 550, "after it was watched for that long");
    assert.deepEqual(readdirSync(box.stateDir).filter((name) => !name.startsWith("pets.json")), [], "and the lock is given up afterwards");
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, startedAt: 1 }));
  }
});
