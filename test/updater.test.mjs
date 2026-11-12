/**
 * The one check every release passes before any of it is written: its order, each of its steps, the ZIP reader under
 * it, and the rules for asking GitHub. GitHub is a stand-in that answers through fetch's interface, so nothing here
 * goes to the network, and every folder is a temporary one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, sign } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManifest } from "../lib/manager.mjs";
import {
  MANIFEST_LIMIT, MANIFEST_URL, NO_KEY, ZIP_LIMIT, ZIP_NAME, ZIP_URL, checkForUpdate, download, githubSources, readLastCheck, readSettings, takeApplyLock,
  updatePaths, verifyRelease, writeSettings,
} from "../lib/updater.mjs";
import { createZip, readZip } from "../lib/zip.mjs";
import { PACKAGE_NAME } from "../scripts/package.mjs";
import { SOURCE, fakeGitHub, makeRelease, manifestFor, packageEntries, rawZip, testKey } from "./helpers/release-kit.mjs";

const kit = testKey();
const root = mkdtempSync(join(tmpdir(), "goblin-updater-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
const good = makeRelease(root, kit, "0.6.1");
const NEWER = { newerThan: "0.6.0" };

/** Check a release served by a stand-in GitHub, as the update command does for a build at 0.6.0. */
async function check({ manifest = good.manifest, zip = good.zip, key = kit.key, rule = NEWER, routes } = {}) {
  const github = fakeGitHub({ manifest, zip, routes });
  const verdict = await verifyRelease({ key, ...githubSources(github.fetch, "0.6.0"), rule });
  return { verdict, urls: github.urls(), asked: github.asked, zipAsked: github.urls().includes(ZIP_URL) };
}
/** A small package of `version`, made from `entries`, signed so that it passes every check before the ZIP's own. */
const signedPackage = (entries, version = "0.6.1") => {
  const zip = rawZip(entries);
  return { zip, manifest: manifestFor(zip, { version, privateKey: kit.privateKey }) };
};

test("a good release passes every check and comes back as the package's own files", async () => {
  const { verdict, urls } = await check();
  assert.equal(verdict.ok, true, verdict.message);
  assert.equal(verdict.release.version, "0.6.1");
  assert.deepEqual(verdict.release.files.map((file) => file.path), readManifest(SOURCE), "exactly the files package-files.json lists");
  assert.deepEqual(urls, [MANIFEST_URL, "https://objects.githubusercontent.com/assets/update.json", ZIP_URL, "https://objects.githubusercontent.com/assets/zip"]);
  assert.equal(ZIP_NAME, PACKAGE_NAME, "the ZIP the updater asks for is the one the package builder makes");
});

test("every request carries only the User-Agent of the installed version, and follows redirects by hand", async () => {
  const { asked } = await check();
  for (const { init } of asked) {
    assert.deepEqual(init.headers, { "User-Agent": "GoblinHorde/0.6.0" });
    assert.equal(init.redirect, "manual");
    assert.ok(init.signal instanceof AbortSignal);
  }
});

test("the signature covers exactly the text the release format names, so a release signed by other tools verifies", async () => {
  const sha256 = createHash("sha256").update(good.zip).digest("hex");
  const text = `goblin-horde-update\nformat=1\nversion=0.6.1\nsize=${good.zip.length}\nsha256=${sha256}\n`;
  const signature = sign(null, Buffer.from(text, "utf8"), kit.privateKey).toString("base64");
  const manifest = Buffer.from(JSON.stringify({ format: 1, version: "0.6.1", zip: "GoblinHorde-Team.zip", size: good.zip.length, sha256, signature }));
  const { verdict } = await check({ manifest });
  assert.equal(verdict.ok, true, verdict.message);
});

test("1. a build with no update key refuses before anything is asked of GitHub", async () => {
  for (const key of ["", null]) {
    const { verdict, urls } = await check({ key });
    assert.deepEqual([verdict.ok, verdict.message, urls], [false, NO_KEY, []]);
  }
  const { verdict, urls } = await check({ key: "bm90IGEga2V5" });
  assert.match(verdict.message, /update key cannot be read/);
  assert.deepEqual(urls, []);
});

test("2. update.json must have the form of a release, and the ZIP is not asked for when it does not", async () => {
  const sign = (written, signed = {}) => manifestFor(good.zip, { version: "0.6.1", privateKey: kit.privateKey, written, signed });
  const cases = [
    [Buffer.from("not json"), /not JSON/],
    [Buffer.from("[1, 2]"), /it is not an object/],
    [sign({ format: 2 }), /its format is not 1/],
    [sign({ format: "1" }), /its format is not 1/],
    [sign({ version: "0.6" }, { version: "0.6" }), /its version is not a plain x\.y\.z version/],
    [sign({ version: "v0.6.1" }, { version: "v0.6.1" }), /its version is not/],
    [sign({ version: "0.6.1-beta" }, { version: "0.6.1-beta" }), /its version is not/],
    [sign({ version: "00.6.1" }, { version: "00.6.1" }), /its version is not/],
    [sign({ zip: "Other.zip" }), /its package is not GoblinHorde-Team\.zip/],
    [sign({ size: 0 }, { size: 0 }), /its size/],
    [sign({ size: 1.5 }, { size: 1.5 }), /its size/],
    [sign({ size: "12" }, { size: "12" }), /its size/],
    [sign({ size: ZIP_LIMIT + 1 }, { size: ZIP_LIMIT + 1 }), /its size/],
    [sign({ sha256: "A".repeat(64) }, { sha256: "A".repeat(64) }), /its SHA-256/],
    [sign({ sha256: "a".repeat(63) }, { sha256: "a".repeat(63) }), /its SHA-256/],
    [sign({ signature: "c2hvcnQ=" }), /its signature is not 64 bytes/],
  ];
  for (const [manifest, reason] of cases) {
    const { verdict, zipAsked } = await check({ manifest });
    assert.equal(verdict.ok, false, String(manifest));
    assert.match(verdict.message, reason, String(manifest));
    assert.equal(zipAsked, false, `the ZIP was not asked for: ${manifest}`);
  }
});

test("3. a signature that is not this build's key's over the signed text is refused, and the ZIP is not asked for", async () => {
  const other = testKey();
  const json = JSON.parse(good.manifest);
  const cases = {
    "a signature by another key": manifestFor(good.zip, { version: "0.6.1", privateKey: other.privateKey }),
    "a version changed after signing": Buffer.from(JSON.stringify({ ...json, version: "0.6.2" })),
    "a size changed after signing": Buffer.from(JSON.stringify({ ...json, size: json.size + 1 })),
    "a SHA-256 changed after signing": Buffer.from(JSON.stringify({ ...json, sha256: "0".repeat(64) })),
    "a signature over other text": Buffer.from(JSON.stringify({ ...json, signature: JSON.parse(manifestFor(good.zip, { version: "9.9.9", privateKey: kit.privateKey })).signature })),
  };
  for (const [name, manifest] of Object.entries(cases)) {
    const { verdict, zipAsked } = await check({ manifest });
    assert.deepEqual([verdict.ok, verdict.current], [false, false], name);
    assert.match(verdict.message, /signature does not match this build's update key/, name);
    assert.equal(zipAsked, false, name);
  }
});

test("4. a signed release that is not newer is up to date and is never downloaded, but only once its signature checks out", async () => {
  for (const version of ["0.6.0", "0.5.9", "0.0.1"]) {
    const { verdict, zipAsked } = await check({ manifest: manifestFor(good.zip, { version, privateKey: kit.privateKey }) });
    assert.deepEqual([verdict.ok, verdict.current, verdict.version, zipAsked], [false, true, version, false], version);
  }
  const forged = manifestFor(good.zip, { version: "0.5.0", privateKey: testKey().privateKey });
  const { verdict } = await check({ manifest: forged });
  assert.equal(verdict.current, false, "an older version with a bad signature is refused for its signature, never called up to date");
  assert.match(verdict.message, /signature/);
  const back = await check({ manifest: manifestFor(good.zip, { version: "0.6.1", privateKey: kit.privateKey }), rule: { olderThan: "0.6.1" } });
  assert.deepEqual([back.verdict.ok, back.verdict.current, back.zipAsked], [false, false, false], "a way back must be older than what is installed");
  assert.match((await check({ rule: {} })).verdict.message, /No version was asked for/, "no rule takes nothing");
});

test("5. the ZIP must have exactly the signed size and SHA-256, the size being checked first", async () => {
  const flipped = Buffer.from(good.zip);
  flipped[100] ^= 0xff;
  const hash = await check({ zip: flipped });
  assert.match(hash.verdict.message, /SHA-256 is not the one its signature names/);
  const longer = await check({ zip: Buffer.concat([flipped, Buffer.from([0])]) });
  assert.match(longer.verdict.message, /is \d+ bytes, not the \d+ its signature names/, "a ZIP of another length is refused by its size, before its hash");
  const shorter = await check({ zip: good.zip.subarray(1) });
  assert.match(shorter.verdict.message, /not the \d+ its signature names/);
});

test("6. entries that would land outside the package's folder, or twice on one file, are refused with the reason", async () => {
  const cases = [
    ["GoblinHorde/../x.mjs", /climbs out of its folder/],
    ["../x.mjs", /climbs out of its folder/],
    ["/GoblinHorde/x.mjs", /is absolute/],
    ["C:/x.mjs", /drive letter/],
    ["GoblinHorde/C:/x.mjs", /drive letter/],
    ["GoblinHorde/goblin.mjs:stream", /drive letter or another colon/],
    ["GoblinHorde\\x.mjs", /backslash/],
    ["GoblinHorde/x\u0000.mjs", /NUL/],
    ["GoblinHorde/caf\u00e9.mjs", /outside plain ASCII/],
    ["Other/x.mjs", /not inside the GoblinHorde folder/],
    ["GoblinHorde/", /not inside the GoblinHorde folder/],
    ["GoblinHorde//x.mjs", /empty part/],
    ["GoblinHorde/./x.mjs", /empty part, a \. part/],
    ["GoblinHorde/x.mjs.", /ends in a dot or a space/],
    ["GoblinHorde/x.mjs ", /ends in a dot or a space/],
    ["GoblinHorde/lib/NUL.mjs", /Windows device name/],
    ["GoblinHorde/com1", /Windows device name/],
  ];
  for (const [name, reason] of cases) {
    const entries = packageEntries("0.6.1", { listed: ["package.json", "package-files.json", "goblin.mjs", name.replace(/^GoblinHorde\//, "")],
      extra: [{ name, data: Buffer.from("x") }] });
    const { verdict } = await check(signedPackage(entries));
    assert.equal(verdict.ok, false, name);
    assert.match(verdict.message, reason, JSON.stringify(name));
  }
  for (const twin of ["GoblinHorde/goblin.mjs", "GoblinHorde/GOBLIN.mjs"]) {
    const { verdict } = await check(signedPackage(packageEntries("0.6.1", { extra: [{ name: twin, data: Buffer.from("again") }] })));
    assert.match(verdict.message, /is in it twice/, twin);
  }
});

test("6. the package must list exactly its own files, and say the signed version", async () => {
  const unlisted = await check(signedPackage(packageEntries("0.6.1", { extra: [{ name: "GoblinHorde/sneaky.mjs", data: Buffer.from("x") }] })));
  assert.match(unlisted.verdict.message, /holds sneaky\.mjs, which its package-files\.json does not list/);
  const missing = await check(signedPackage(packageEntries("0.6.1", { listed: ["package.json", "package-files.json", "goblin.mjs", "lib/manager.mjs"] })));
  assert.match(missing.verdict.message, /lists lib\/manager\.mjs, which is not in it/);
  const noList = await check(signedPackage(packageEntries("0.6.1").filter((entry) => !entry.name.endsWith("package-files.json"))));
  assert.match(noList.verdict.message, /package-files\.json is not a list of files/);
  const otherVersion = await check(signedPackage(packageEntries("0.6.2")));
  assert.match(otherVersion.verdict.message, /says it is version 0\.6\.2, but its signature says 0\.6\.1/);
  const small = await check(signedPackage(packageEntries("0.6.1")));
  assert.equal(small.verdict.ok, true, `${small.verdict.message} (the small package itself is fine)`);
});

test("6. too many entries, too much to unpack, and entries that unpack to other than they declare are refused", async () => {
  const files = Object.fromEntries(Array.from({ length: 198 }, (_, index) => [`f${index}.txt`, "x"]));
  const ok = await check(signedPackage(packageEntries("0.6.1", { files })));
  assert.equal(ok.verdict.ok, true, `200 entries are fine: ${ok.verdict.message}`);
  const many = await check(signedPackage(packageEntries("0.6.1", { files: { ...files, "one-more.txt": "x" } })));
  assert.match(many.verdict.message, /has 201 entries, more than 200/);
  const huge = await check(signedPackage(packageEntries("0.6.1", { extra: [{ name: "GoblinHorde/big.bin", data: Buffer.from("x"), size: 61 * 1024 * 1024 }] })));
  assert.match(huge.verdict.message, /unpacks to more than 62914560 bytes/);
  const bomb = await check(signedPackage(packageEntries("0.6.1", { extra: [{ name: "GoblinHorde/bomb.bin", data: Buffer.alloc(100_000), size: 10 }] })));
  assert.match(bomb.verdict.message, /unpacks to more than it declares \(GoblinHorde\/bomb\.bin\)/);
  const short = await check(signedPackage(packageEntries("0.6.1", { extra: [{ name: "GoblinHorde/short.bin", data: Buffer.from("abc"), size: 4 }] })));
  assert.match(short.verdict.message, /size is not the one it declares/);
  const crc = await check(signedPackage(packageEntries("0.6.1", { extra: [{ name: "GoblinHorde/crc.bin", data: Buffer.from("abc"), crc: 1 }] })));
  assert.match(crc.verdict.message, /checksum is wrong/);
});

test("the ZIP reader takes only plain archives: no ZIP64, no encryption, no other method, no comment, no damage", () => {
  const plain = [{ name: "GoblinHorde/a.txt", data: Buffer.from("hello") }];
  assert.deepEqual(readZip(rawZip(plain)).map((entry) => entry.data.toString()), ["hello"]);
  assert.deepEqual(readZip(rawZip([{ ...plain[0], method: 0 }])).map((entry) => entry.data.toString()), ["hello"], "stored entries are read");
  const refusals = [
    [rawZip([{ ...plain[0], flags: 0x0801 }]), /encrypted/],
    [rawZip([{ ...plain[0], flags: 0x0840 }]), /encrypted/],
    [rawZip([{ ...plain[0], flags: 0x0808 }]), /feature this reader does not take/],
    [rawZip([{ ...plain[0], method: 12 }]), /compression method 12/],
    [Buffer.concat([rawZip(plain), Buffer.from("trailing")]), /plain end record/],
    [Buffer.from("PK\u0005\u0006 not really"), /plain end record/],
  ];
  const withSize = (zip, at, value) => { const copy = Buffer.from(zip); copy.writeUInt32LE(value, at); return copy; };
  const zip = rawZip(plain);
  const end = zip.length - 22;
  refusals.push([withSize(zip, end + 16, 0xffffffff), /ZIP64/]);
  refusals.push([withSize(zip, end - 20, 0x07064b50), /is a ZIP64 archive/]);
  const central = zip.readUInt32LE(end + 16);
  refusals.push([withSize(zip, central + 24, 0xffffffff), /ZIP64/]);
  const disagree = Buffer.from(zip);
  disagree.write("X", 30 + "GoblinHorde/".length);
  refusals.push([disagree, /local and central records that disagree/]);
  refusals.push([rawZip([{ ...plain[0], packedSize: 5000 }]), /runs past its data/]);
  const two = rawZip([plain[0], { name: "GoblinHorde/b.txt", data: Buffer.from("b") }]);
  for (const at of [two.length - 22 + 8, two.length - 22 + 10]) two.writeUInt16LE(1, at);
  refusals.push([two, /damaged directory/]);
  for (const [bytes, reason] of refusals) assert.throws(() => readZip(bytes), reason);
  const round = createZip([{ name: "GoblinHorde/x.txt", data: Buffer.from("x") }]);
  assert.equal(readZip(round)[0].data.toString(), "x", "what createZip writes, readZip reads");
});

test("GitHub is asked over https only, on its own hosts, through at most five redirects", async () => {
  const redirect = (location) => new Response(null, { status: 302, headers: { location } });
  const through = (location) => check({ routes: { [MANIFEST_URL]: redirect(location) } });
  for (const location of ["http://objects.githubusercontent.com/assets/update.json", "ftp://github.com/update.json", "file:///C:/update.json"])
    assert.match((await through(location)).verdict.message, /not https/, location);
  for (const location of ["https://example.com/update.json", "https://evilgithub.com/update.json", "https://github.com.evil.example/update.json",
    "https://objects.githubusercontent.com.example/x", "https://githubusercontent.co/x", "https://127.0.0.1/update.json"])
    assert.match((await through(location)).verdict.message, /which is not GitHub/, location);
  const relative = await through("/epoisel/goblin-horde/releases/download/v0.6.1/update.json");
  assert.match(relative.verdict.message, /GitHub answered 404/, "a redirect within GitHub is followed");
  assert.match((await check({ routes: { [MANIFEST_URL]: new Response(null, { status: 302 }) } })).verdict.message, /could not be read/, "a redirect with no address");

  const chain = (hops) => {
    const routes = {};
    for (let hop = 0; hop < hops; hop++) routes[hop ? `https://github.com/hop/${hop}` : MANIFEST_URL] = redirect(`https://github.com/hop/${hop + 1}`);
    routes[`https://github.com/hop/${hops}`] = new Response(good.manifest, { status: 200 });
    return check({ routes });
  };
  assert.equal((await chain(5)).verdict.ok, true, "five redirects are followed");
  const six = await chain(6);
  assert.match(six.verdict.message, /more than 5 redirects/);
  assert.equal(six.urls.length, 6, "the sixth redirect is not followed");

  const plain = await download(async () => { throw new Error("must not be asked"); }, "http://github.com/x", { limit: 10, userAgent: "GoblinHorde/0.6.0", label: "update.json" })
    .then(() => "asked", (error) => error.message);
  assert.match(plain, /not https/, "an http address is refused before it is asked");
});

test("update.json past 16 KB and a ZIP past 25 MB are refused, whatever length GitHub claims", async () => {
  const declared = await check({ routes: { "https://objects.githubusercontent.com/assets/update.json": new Response("x", { status: 200, headers: { "content-length": String(MANIFEST_LIMIT + 1) } }) } });
  assert.match(declared.verdict.message, /update\.json is larger than 16384 bytes/);
  const streamed = await check({ routes: { "https://objects.githubusercontent.com/assets/update.json": new Response(Buffer.alloc(MANIFEST_LIMIT + 1, 32), { status: 200 }) } });
  assert.match(streamed.verdict.message, /update\.json is larger than 16384 bytes/);
  let sent = 0;
  // Far more than the limit, with no length said; it does end, so a reader with no limit is caught by the size check instead of running out of memory.
  const endless = () => new Response(new ReadableStream({
    pull(controller) {
      if (sent >= 40 * 1024 * 1024) return controller.close();
      sent += 1024 * 1024;
      controller.enqueue(new Uint8Array(1024 * 1024));
    },
  }), { status: 200 });
  const big = await check({ routes: { "https://objects.githubusercontent.com/assets/zip": endless } });
  assert.match(big.verdict.message, /The update package is larger than 26214400 bytes/);
  assert.ok(sent <= ZIP_LIMIT + 3 * 1024 * 1024, `reading stopped at the limit (${sent} bytes were made)`);
});

test("a network that fails, a GitHub that answers other than 200, and one that does not answer in time are said plainly", { timeout: 20_000 }, async (t) => {
  const unreachable = await check({ routes: { [MANIFEST_URL]: () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" }) }); } } });
  assert.match(unreachable.verdict.message, /GitHub could not be reached \(ENOTFOUND\)/);
  const missing = await check({ routes: { "https://objects.githubusercontent.com/assets/zip": new Response(null, { status: 404 }) } });
  assert.match(missing.verdict.message, /GitHub answered 404 for The update package/);
  // A real request holds a socket open while it waits. These stand-ins hold nothing, and the timeout's own timer does not keep Node running.
  const awake = setInterval(() => {}, 1000);
  t.after(() => clearInterval(awake));
  const silent = await download((url, init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))),
    MANIFEST_URL, { limit: 10, userAgent: "GoblinHorde/0.6.0", label: "update.json", timeoutMs: 50 }).then(() => "answered", (error) => error.message);
  assert.match(silent, /did not answer within 30 seconds/);
  const stalls = await download(async (url, init) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(3));
    init.signal.addEventListener("abort", () => controller.error(init.signal.reason));
  } }), { status: 200 }), MANIFEST_URL, { limit: 10, userAgent: "GoblinHorde/0.6.0", label: "update.json", timeoutMs: 50 }).then(() => "answered", (error) => error.message);
  assert.match(stalls, /did not answer within 30 seconds/, "a body that stops coming is given up on too");
});

test("a check keeps a verified release in ready/, remembers how it went, and one that fails leaves only that", async () => {
  const stateDir = mkdtempSync(join(root, "state-"));
  const paths = updatePaths(stateDir);
  const github = fakeGitHub({ manifest: good.manifest, zip: good.zip });
  const now = () => Date.parse("2026-11-12T10:00:00Z");
  const kept = await checkForUpdate(stateDir, { key: kit.key, sources: githubSources(github.fetch, "0.6.0"), rule: NEWER, now });
  assert.equal(kept.ok, true);
  assert.deepEqual(readdirSync(join(paths.ready, "0.6.1")).sort(), [ZIP_NAME, "update.json"].sort());
  assert.deepEqual(readLastCheck(stateDir), { checkedAt: "2026-11-12T10:00:00.000Z", ok: true, message: "Goblin Horde 0.6.1 is downloaded and checked, and is put in place at the next start." });

  const failing = mkdtempSync(join(root, "state-"));
  const flipped = Buffer.from(good.zip);
  flipped[100] ^= 0xff;
  const refused = await checkForUpdate(failing, { key: kit.key, sources: githubSources(fakeGitHub({ manifest: good.manifest, zip: flipped }).fetch, "0.6.0"), rule: NEWER, now });
  assert.equal(refused.ok, false);
  assert.deepEqual(readdirSync(updatePaths(failing).root), ["state.json"], "a failed check leaves its time and reason and nothing else");
  assert.equal(readLastCheck(failing).ok, false);
  assert.match(readLastCheck(failing).message, /SHA-256/);
});

test("one apply at a time: the lock is refused while its holder runs, and taken over once it is gone or ten minutes old", () => {
  const stateDir = mkdtempSync(join(root, "lock-"));
  const first = takeApplyLock(stateDir, { pid: 111, alive: () => true });
  assert.ok(first);
  assert.equal(takeApplyLock(stateDir, { pid: 222, alive: () => true }), null, "a holder that runs keeps it");
  const taken = takeApplyLock(stateDir, { pid: 222, alive: () => false });
  assert.ok(taken, "a holder that is gone loses it");
  first.release();
  assert.ok(existsSync(updatePaths(stateDir).lock), "a holder that lost the lock does not free the one that took it");
  taken.release();
  assert.equal(existsSync(updatePaths(stateDir).lock), false);
  assert.ok(takeApplyLock(stateDir, { pid: 333, now: () => Date.now() - 11 * 60_000, alive: () => true }));
  assert.ok(takeApplyLock(stateDir, { pid: 444, alive: () => true }), "a lock older than ten minutes is taken over");
});

test("the daily check is on until update --off, and a settings file that cannot be read means off", () => {
  const stateDir = mkdtempSync(join(root, "settings-"));
  assert.equal(readSettings(stateDir).check, true);
  writeSettings(stateDir, { check: false });
  assert.equal(readSettings(stateDir).check, false);
  writeSettings(stateDir, { check: true });
  assert.equal(readSettings(stateDir).check, true);
  writeFileSync(updatePaths(stateDir).settings, "{ half written");
  assert.equal(readSettings(stateDir).check, false, "an unreadable choice never turns the check on");
  rmSync(updatePaths(stateDir).settings);
  assert.equal(existsSync(updatePaths(stateDir).settings), false);
  assert.equal(readSettings(stateDir).check, true);
});
