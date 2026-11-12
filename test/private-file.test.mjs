/**
 * The files that hold a pairing code or switch the shared game on, in a temp folder that hands read access to
 * every user of the computer, as a shared or badly set up state folder can. On Windows the permissions are read
 * back with icacls here, apart from the code under test. No file outside the temp folder is touched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PAIRING_CODE, Pairing } from "../lib/pairing.mjs";
import { REMOTE_CODE_FILE, createRemotePets, readRemoteSetting, startingRemoteSetting, writeRemoteSetting } from "../lib/pets-remote.mjs";
import { UNREADABLE, createPetsStore } from "../lib/pets-store.mjs";
import { CODE_FILE, loadPairingCode, savePairingCode, startingPairingCode } from "../lib/phone.mjs";
import { PrivateFileError, createPrivateFile, protectFile, readersOf, writePrivateFile } from "../lib/private-file.mjs";
import { createState, loadConfig } from "../lib/rewards.mjs";
import { SHARED_FILE, SharedAccess, readSharedSetting, writeSharedSetting } from "../lib/shared.mjs";
import { CODE } from "./helpers/shared-host.mjs";

const CONFIG = loadConfig(fileURLToPath(new URL("../game_config.json", import.meta.url)));
const windows = process.platform === "win32";
const onWindows = { skip: !windows && "Windows permissions" };
const USERS = "*S-1-5-32-545";
const system32 = windows ? join(process.env.SystemRoot, "System32") : "";

function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), "goblin-private-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
/** A folder whose every new file every user of this computer may read, the way the review's state folder was. */
function sharedFolder(t) {
  const dir = folder(t);
  execFileSync(join(system32, "icacls.exe"), [dir, "/grant", `${USERS}:(OI)(CI)R`], { windowsHide: true, stdio: "ignore" });
  return dir;
}
/** Who may open `file`, read with icacls by this test itself: the trustees of its allow entries, as SDDL names them. */
function allowed(file) {
  const out = `${file}.test-acl`;
  execFileSync(join(system32, "icacls.exe"), [file, "/save", out], { windowsHide: true, stdio: "ignore" });
  const sddl = readFileSync(out).toString("utf16le").trim().split(/\r?\n/).at(-1);
  rmSync(out);
  return [...sddl.matchAll(/\(A;[^;]*;[^;]*;[^;]*;[^;]*;([^)]*)\)/g)].map((entry) => entry[1]);
}
const mySid = () => /"(S-1-[0-9-]+)"\s*$/.exec(execFileSync(join(system32, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }).trim())[1];

test("in a folder every user may read, the files that hold a code or the shared setting can be read by this account only", onWindows, (t) => {
  const dir = sharedFolder(t);
  writeFileSync(join(dir, "ordinary.txt"), "anything\n", { mode: 0o600 });
  assert.ok(allowed(join(dir, "ordinary.txt")).includes("BU"), "an ordinary file in this folder is readable by every user, whatever mode it was made with");

  const me = mySid();
  const mineOnly = (name) => {
    const trustees = allowed(join(dir, name));
    assert.ok(trustees.includes(me), `${name}: this account may read it`);
    assert.deepEqual(trustees.filter((trustee) => ![me, "SY", "BA"].includes(trustee)), [], `${name}: nobody else may, apart from SYSTEM and Administrators`);
  };
  writeRemoteSetting(dir, { origin: "http://100.101.102.103:43917", code: CODE });
  assert.equal(readFileSync(join(dir, REMOTE_CODE_FILE), "utf8"), `${CODE}\n`);
  mineOnly(REMOTE_CODE_FILE);
  savePairingCode(dir, CODE);
  assert.equal(readFileSync(join(dir, CODE_FILE), "utf8"), `${CODE}\n`);
  mineOnly(CODE_FILE);
  writeSharedSetting(dir, { enabled: true, address: "100.101.102.103" });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, SHARED_FILE), "utf8")), { enabled: true, address: "100.101.102.103" });
  mineOnly(SHARED_FILE);

  // Written again over the first, each is still private and holds the new text.
  writeRemoteSetting(dir, { origin: "http://100.101.102.103:43917", code: "ABCDEFGH" });
  savePairingCode(dir, "ABCDEFGH");
  writeSharedSetting(dir, { enabled: false });
  for (const name of [REMOTE_CODE_FILE, CODE_FILE, SHARED_FILE]) mineOnly(name);
  assert.equal(readFileSync(join(dir, CODE_FILE), "utf8"), "ABCDEFGH\n");
  assert.deepEqual(readdirSync(dir).sort(), ["ordinary.txt", CODE_FILE, "remote-code.txt", "remote.json", SHARED_FILE].sort(), "no temp file is left");

  // A code that a code-less viewer makes up on its first start is saved the same way.
  rmSync(join(dir, CODE_FILE));
  const made = loadPairingCode(dir, { env: {} });
  assert.equal(readFileSync(join(dir, CODE_FILE), "utf8"), `${made}\n`);
  mineOnly(CODE_FILE);
});

test("turning the shared game on makes a pairing code file that is already there private first", onWindows, async (t) => {
  const dir = sharedFolder(t);
  // A code saved by an older version: it took the folder's permissions.
  writeFileSync(join(dir, CODE_FILE), `${CODE}\n`, { mode: 0o600 });
  assert.ok(allowed(join(dir, CODE_FILE)).includes("BU"));
  const pairing = new Pairing({ code: CODE });
  const network = async () => ({ address: "127.0.0.1", port: 45999, names: [], isPeer: () => false, whois: null, standIn: true, problem: "" });
  const serve = () => ({ once() {}, off() {}, on() {}, closeAllConnections() {}, close(done) { done?.(); }, listen(port, address, done) { done(); }, address: () => ({ address: "127.0.0.1" }) });
  const shared = new SharedAccess({ stateDir: dir, port: 43917, pairing, network, serve, log: {}, routes: {} });
  await shared.setEnabled(true);
  await shared.close();
  const me = mySid();
  assert.deepEqual(allowed(join(dir, CODE_FILE)).filter((trustee) => ![me, "SY", "BA"].includes(trustee)), [], "the code a caller needs is no longer readable by every user");
  assert.equal(readFileSync(join(dir, CODE_FILE), "utf8"), `${CODE}\n`, "and it is the same code");
});

const standIn = async () => ({ address: "127.0.0.1", port: 45999, names: [], isPeer: () => false, whois: null, standIn: true, problem: "" });
/** A stand-in for a server that keeps every address it was asked to listen on in `listens`. */
const recording = (listens, did = []) => () => ({ once() {}, off() {}, on() {}, closeAllConnections() {}, close(done) { done?.(); },
  listen(port, address, done) { listens.push(address); did.push("listen"); done(); }, address: () => ({ address: "127.0.0.1" }) });
const grantUsers = (file) => execFileSync(join(system32, "icacls.exe"), [file, "/grant", `${USERS}:R`], { windowsHide: true, stdio: "ignore" });

test("a host that starts with sharing on makes the pairing code and the shared setting private before it listens", onWindows, async (t) => {
  const me = mySid();
  // The review's case: both files were written by an older version, in a folder that hands every new file to every user.
  const dir = sharedFolder(t);
  writeFileSync(join(dir, CODE_FILE), `${CODE}\n`);
  writeFileSync(join(dir, SHARED_FILE), JSON.stringify({ enabled: true, address: "127.0.0.1" }));
  for (const name of [CODE_FILE, SHARED_FILE]) assert.ok(allowed(join(dir, name)).includes("BU"), `${name} starts out readable by every user`);
  const listens = [];
  const shared = new SharedAccess({ stateDir: dir, port: 43917, pairing: new Pairing({ code: startingPairingCode(dir, { env: {}, log: {} }) }), network: standIn, serve: recording(listens), log: {}, routes: {} });
  const state = await shared.apply();
  assert.deepEqual([state.listening, state.problem, listens], [true, "", ["127.0.0.1"]]);
  for (const name of [CODE_FILE, SHARED_FILE])
    assert.deepEqual(allowed(join(dir, name)).filter((trustee) => ![me, "SY", "BA"].includes(trustee)), [], `${name} is this account's alone now`);
  assert.equal(readFileSync(join(dir, CODE_FILE), "utf8"), `${CODE}\n`, "the code is the same code");
  assert.deepEqual(readSharedSetting(dir), { enabled: true, address: "127.0.0.1" }, "and the setting the same setting");
  await shared.close();

  // A file that names another account outright cannot be made private where it is. Then nothing listens, and the reason is said.
  for (const name of [CODE_FILE, SHARED_FILE]) {
    const exposed = sharedFolder(t);
    writeFileSync(join(exposed, CODE_FILE), `${CODE}\n`);
    writeFileSync(join(exposed, SHARED_FILE), JSON.stringify({ enabled: true, address: "127.0.0.1" }));
    grantUsers(join(exposed, name));
    const opened = [];
    const closed = new SharedAccess({ stateDir: exposed, port: 43917, pairing: new Pairing({ code: CODE }), network: standIn, serve: recording(opened), log: {}, routes: {} });
    const refused = await closed.apply();
    assert.deepEqual([refused.enabled, refused.listening, refused.problem], [true, false, `${name} could not be made private to your account on this computer, so the shared game is not listening.`]);
    assert.deepEqual(opened, [], `${name}: nothing was listened on`);
    await closed.close();
  }

  // Turning sharing on over a code file that cannot be made private is refused, and the choice is not saved.
  const fresh = sharedFolder(t);
  writeFileSync(join(fresh, CODE_FILE), `${CODE}\n`);
  grantUsers(join(fresh, CODE_FILE));
  const never = new SharedAccess({ stateDir: fresh, port: 43917, pairing: new Pairing({ code: CODE }), network: standIn, serve: recording([]), log: {}, routes: {} });
  await assert.rejects(never.setEnabled(true), (error) => error instanceof PrivateFileError && error.message === "pairing-code.txt could not be made private to your account on this computer.");
  assert.equal(existsSync(join(fresh, SHARED_FILE)), false, "a refused enable saves nothing");
  assert.equal((await never.apply()).enabled, false);
  await never.close();
});

test("the files are made private before the listener opens, and a file that cannot be keeps it closed, on any computer", async (t) => {
  const dir = folder(t);
  writeFileSync(join(dir, CODE_FILE), `${CODE}\n`);
  writeFileSync(join(dir, SHARED_FILE), JSON.stringify({ enabled: true, address: "127.0.0.1" }));
  const did = [];
  const fine = new SharedAccess({ stateDir: dir, port: 43917, pairing: new Pairing({ code: CODE }), network: standIn, serve: recording([], did), log: {}, routes: {},
    protect: (file) => did.push(`protect ${file.slice(dir.length + 1)}`) });
  assert.equal((await fine.apply()).listening, true);
  assert.deepEqual(did, [`protect ${CODE_FILE}`, `protect ${SHARED_FILE}`, "listen"], "both files, and only then the listener");
  await fine.apply();
  assert.equal(did.length, 3, "a listener that is open is not opened, or its files gone over, again");
  await fine.close();

  for (const name of [CODE_FILE, SHARED_FILE]) {
    const listens = [];
    const closed = new SharedAccess({ stateDir: dir, port: 43917, pairing: new Pairing({ code: CODE }), network: standIn, serve: recording(listens), log: {}, routes: {},
      protect: (file) => { if (file.endsWith(name)) throw new PrivateFileError(file, ""); } });
    const state = await closed.apply();
    assert.deepEqual([state.listening, state.problem, listens], [false, `${name} could not be made private to your account on this computer, so the shared game is not listening.`, []]);
    await closed.close();
  }
});

test("a display that starts makes the file with its host's code private before it reads the code, and shows no host's game when it cannot", onWindows, (t) => {
  const me = mySid();
  const dir = sharedFolder(t);
  writeFileSync(join(dir, "remote.json"), JSON.stringify({ host: "http://100.101.102.103:43917" }));
  writeFileSync(join(dir, REMOTE_CODE_FILE), `${CODE}\n`);
  assert.ok(allowed(join(dir, REMOTE_CODE_FILE)).includes("BU"), "the code file starts out readable by every user");
  assert.equal(readRemoteSetting(dir).code, CODE);
  assert.ok(allowed(join(dir, REMOTE_CODE_FILE)).includes("BU"), "a command that only looks, as doctor does, changes nothing");

  assert.deepEqual(startingRemoteSetting(dir), { name: "100.101.102.103", port: 43917, origin: "http://100.101.102.103:43917", code: CODE });
  assert.deepEqual(allowed(join(dir, REMOTE_CODE_FILE)).filter((trustee) => ![me, "SY", "BA"].includes(trustee)), [], "a viewer that starts leaves the code readable by this account alone");

  grantUsers(join(dir, REMOTE_CODE_FILE));
  const refused = startingRemoteSetting(dir);
  assert.deepEqual(refused, { problem: "remote-code.txt could not be made private to your account on this computer, so this computer does not show the shared game. "
    + "Run pets-join again, or pets-join --off to play this computer's own game." });
  assert.ok(!JSON.stringify(refused).includes(CODE), "and the code was not loaded");
});

test("a display's code file that cannot be made private is not read, on any computer, and a computer that is no display is not asked", async (t) => {
  const dir = folder(t);
  const protects = [];
  const cannot = (file) => { protects.push(file); throw new PrivateFileError(file, ""); };
  assert.equal(startingRemoteSetting(dir, { protect: cannot }), null, "no remote.json: this computer plays its own game");
  assert.deepEqual(protects, []);
  writeRemoteSetting(dir, { origin: "http://100.101.102.103:43917", code: CODE });
  const refused = startingRemoteSetting(dir, { protect: cannot });
  assert.deepEqual(Object.keys(refused), ["problem"]);
  assert.match(refused.problem, /^remote-code\.txt could not be made private to your account on this computer, so this computer does not show the shared game\./);
  assert.deepEqual(protects, [join(dir, REMOTE_CODE_FILE)]);
  // What its viewer then shows is that sentence, and it sends its host nothing.
  let asked = 0;
  const shown = await createRemotePets(refused, { ask: async () => { asked += 1; return { status: 200, data: {}, session: "" }; } }).get(0);
  assert.deepEqual([shown.ok, shown.message, asked], [false, refused.problem, 0]);
  assert.equal(startingRemoteSetting(dir, { protect: () => {} }).code, CODE, "with the file made private, the code is read");
});

test("the copy kept of a saved game that cannot be read is private, in a folder every user may read", onWindows, async (t) => {
  const me = mySid();
  const mineOnly = (file) => assert.deepEqual(allowed(file).filter((trustee) => ![me, "SY", "BA"].includes(trustee)), [], `${file}: nobody but this account, SYSTEM and Administrators`);
  const copies = (dir) => readdirSync(dir).filter((name) => /^pets\.json\.unreadable\.\d+-[0-9a-f]{8}$/.test(name));
  const game = JSON.stringify({ schema: 1, state: createState(CONFIG, "2026-11-10"), sources: { t3: { at: 1, seen: [] } }, lastSeenAt: 1 });

  // The review's case: the owner made their saved game private, in a folder that hands every new file to every user.
  for (const how of ["a load that refuses to start over it", "a save that is about to replace it"]) {
    const dir = sharedFolder(t);
    const unreadable = "{\"schema\":1,\"state\":{\"wallet\":{\"coins\":987654";
    writeFileSync(join(dir, "pets.json"), unreadable);
    protectFile(join(dir, "pets.json"));
    assert.ok(!allowed(join(dir, "pets.json")).includes("BU"), "the saved game itself is private");
    const store = createPetsStore({ dir, config: CONFIG });
    if (how.startsWith("a load")) await assert.rejects(store.load(), (error) => error.code === UNREADABLE);
    else await store.save(JSON.parse(game));
    const [copy] = copies(dir);
    assert.equal(copies(dir).length, 1, how);
    assert.equal(readFileSync(join(dir, copy), "utf8"), unreadable, `${how}: the copy holds what the file held`);
    mineOnly(join(dir, copy));
    writeFileSync(join(dir, "ordinary.txt"), "x");
    assert.ok(allowed(join(dir, "ordinary.txt")).includes("BU"), "while an ordinary new file there is every user's");
  }
});

test("a private file is made only under a name no file has, and one that cannot be made private is not left behind", (t) => {
  const dir = folder(t);
  const file = join(dir, "pets.json.unreadable.1-abcd1234");
  const fine = { owner: "owner", restrict() {}, readers: () => ["owner"] };
  createPrivateFile(file, Buffer.from([0x7b, 0xff, 0x00]), { acl: fine });
  assert.deepEqual([...readFileSync(file)], [0x7b, 0xff, 0x00], "bytes go in as they are");
  assert.throws(() => createPrivateFile(file, "another", { acl: fine }), (error) => error.code === "EEXIST", "a file that is there is never written over");
  assert.deepEqual([...readFileSync(file)], [0x7b, 0xff, 0x00]);

  const order = [];
  const watched = { owner: "owner", restrict: (path) => order.push(`restrict ${readFileSync(path).length}`), readers: (path) => { order.push(`read back ${readFileSync(path).length}`); return ["owner"]; } };
  createPrivateFile(join(dir, "second"), "the bytes", { acl: watched });
  assert.deepEqual(order, ["restrict 0", "read back 0"], "the file is made private, and its permissions read back, while it is still empty");

  for (const [why, acl] of [["its permissions cannot be changed", { restrict() { throw new Error("icacls failed"); }, readers: () => ["owner"] }],
    ["another reader is still there", { restrict() {}, readers: () => ["owner", "BU"] }]]) {
    assert.throws(() => createPrivateFile(join(dir, "third"), "the bytes", { acl: { owner: "owner", ...acl } }), PrivateFileError, why);
    assert.equal(existsSync(join(dir, "third")), false, `${why}: no file is left, not even an empty one`);
  }
});

test("a file that cannot be made private is not written, and what was there stays", (t) => {
  const dir = folder(t);
  const file = join(dir, "remote-code.txt");
  writeFileSync(file, "the code from before\n");
  const cannot = [
    ["the permissions cannot be changed", { restrict() { throw new Error("icacls failed"); }, readers: () => ["owner"] }],
    ["another reader is still there afterwards", { restrict() {}, readers: () => ["owner", "BU"] }],
    ["the permissions cannot be read back", { restrict() {}, readers() { throw new Error("icacls failed"); } }],
    ["nobody is named as a reader at all", { restrict() {}, readers: () => [] }],
  ];
  for (const [why, acl] of cannot) {
    assert.throws(() => writePrivateFile(file, `${CODE}\n`, { acl: { owner: "owner", ...acl } }), (error) => error instanceof PrivateFileError
      && error.message === "remote-code.txt could not be made private to your account on this computer, so it was not saved." && !error.message.includes(CODE), why);
    assert.equal(readFileSync(file, "utf8"), "the code from before\n", `${why}: the file is as it was`);
    assert.deepEqual(readdirSync(dir), ["remote-code.txt"], `${why}: no temp file holds the code`);
    assert.throws(() => protectFile(file, { acl: { owner: "owner", ...acl } }), PrivateFileError, why);
  }
  // With SYSTEM and Administrators beside the owner it is private, since they can read every file anyway.
  writePrivateFile(file, `${CODE}\n`, { acl: { owner: "owner", restrict() {}, readers: () => ["owner", "SY", "BA", "S-1-5-18", "S-1-5-32-544"] } });
  assert.equal(readFileSync(file, "utf8"), `${CODE}\n`);
  assert.throws(() => savePairingCode(join(dir, "no-such-folder", "\u0000"), CODE), "a folder that cannot be made is an error too, never a silent skip");
});

test("a viewer whose new pairing code cannot be saved privately starts with a code for that run and saves none", (t) => {
  const dir = folder(t);
  // Nothing can be saved under this name: a folder has it.
  mkdirSync(join(dir, CODE_FILE));
  assert.throws(() => loadPairingCode(dir, { env: {} }), PrivateFileError, "the code is not saved, and whoever asked for the saved code is told");
  const lines = [];
  const code = startingPairingCode(dir, { env: {}, log: { error: (line) => lines.push(line) } });
  assert.match(code, PAIRING_CODE);
  assert.deepEqual(lines, ["pairing-code.txt could not be made private to your account on this computer, so it was not saved. A pairing code for this run only is in use."]);
  assert.ok(!lines.join().includes(code), "the code is not in the log line");
  assert.deepEqual(readdirSync(dir), [CODE_FILE], "no file, and no temp file, holds the code");
  assert.deepEqual(readdirSync(join(dir, CODE_FILE)), []);
  assert.notEqual(startingPairingCode(dir, { env: {}, log: {} }), code, "the next run has another code");

  // The shared setting is the same when it is turned on, and turning it off works whatever the file is.
  mkdirSync(join(dir, SHARED_FILE));
  assert.throws(() => writeSharedSetting(dir, { enabled: true, address: "100.101.102.103" }), PrivateFileError);
  assert.equal(readSharedSetting(dir).enabled, false, "a setting that could not be saved is off");
  writeSharedSetting(dir, { enabled: false });
  assert.equal(readSharedSetting(dir).enabled, false);
  assert.equal(existsSync(join(dir, SHARED_FILE)), false, "turning it off removed the file that could not be written");
});

test("the readers of a file are read from its permissions as text, and anything unclear names a stranger", () => {
  const me = "S-1-5-21-1111111111-2222222222-3333333333-1001";
  assert.deepEqual(readersOf(`D:PAI(A;;FA;;;${me})`), [me]);
  assert.deepEqual(readersOf(`D:PAI(A;;FA;;;${me})(A;;FA;;;SY)(A;;FA;;;BA)`), [me, "SY", "BA"]);
  assert.deepEqual(readersOf(`O:${me}G:${me}D:AI(A;ID;FR;;;BU)(A;ID;FA;;;${me})S:AI`), ["BU", me], "an inherited entry for every user is a reader");
  assert.deepEqual(readersOf(`D:(A;;FR;;;WD)(A;;FA;;;${me})`), ["WD", me]);
  for (const unclear of ["", "D:NO_ACCESS_CONTROL", `O:${me}`, "garbage", `D:P(D;;FA;;;BU)(A;;FA;;;${me})`, `D:P(XA;;FA;;;${me};(x))`, `D:P(OA;;CR;ab721a53-1e2f-11d0-9819-00aa0040529b;;${me})`, `D:P(A;;FA;;;${me}`])
    assert.ok(readersOf(unclear).includes("?"), unclear || "(nothing)");
});

test("elsewhere a private file is one whose mode is 0600, checked after it is written", { skip: windows && "POSIX modes" }, (t) => {
  const dir = folder(t);
  writeSharedSetting(dir, { enabled: true, address: "100.101.102.103" });
  savePairingCode(dir, CODE);
  writeRemoteSetting(dir, { origin: "http://100.101.102.103:43917", code: CODE });
  for (const name of [SHARED_FILE, CODE_FILE, REMOTE_CODE_FILE]) assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600, name);
  writeFileSync(join(dir, "loose.txt"), "x", { mode: 0o644 });
  protectFile(join(dir, "loose.txt"));
  assert.equal(statSync(join(dir, "loose.txt")).mode & 0o777, 0o600);
  assert.equal(existsSync(join(dir, "loose.txt")), true);
});
