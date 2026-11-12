/**
 * scripts/release.mjs on a copy of the package in a temporary folder: keygen with its key written to that folder, a
 * build whose output must pass the installations' own check, and a publish that runs gh only when asked, through a
 * stand-in that records what would run. Nothing here uses the real signing key, git tags, gh, or the network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZIP_NAME, folderSources, verifyRelease } from "../lib/updater.mjs";
import { readZip } from "../lib/zip.mjs";
import { build, defaultKeyPath, keygen, newestTag, publish } from "../scripts/release.mjs";
import { packageCopy } from "./helpers/release-kit.mjs";

const windows = process.platform === "win32";
const system32 = windows ? join(process.env.SystemRoot, "System32") : "";

function sandbox(t, version = "0.6.1") {
  const root = mkdtempSync(join(tmpdir(), "goblin-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceDir = packageCopy(join(root, "source"), { version, key: "" });
  // A folder every user of this computer may read, so only a key that keygen made private is private.
  const keys = join(root, "keys");
  mkdirSync(keys);
  if (windows) execFileSync(join(system32, "icacls.exe"), [keys, "/grant", "*S-1-5-32-545:(OI)(CI)R"], { windowsHide: true, stdio: "ignore" });
  return { root, sourceDir, keyPath: join(keys, "update-key.pem") };
}
const shippedKey = (sourceDir) => /UPDATE_KEY = "([^"]*)"/.exec(readFileSync(join(sourceDir, "lib", "update-key.mjs"), "utf8"))[1];

/** Who may open `file`, read with icacls by this test itself. */
function allowed(file) {
  const out = `${file}.test-acl`;
  execFileSync(join(system32, "icacls.exe"), [file, "/save", out], { windowsHide: true, stdio: "ignore" });
  const sddl = readFileSync(out).toString("utf16le").trim().split(/\r?\n/).at(-1);
  rmSync(out);
  return [...sddl.matchAll(/\(A;[^;]*;[^;]*;[^;]*;[^;]*;([^)]*)\)/g)].map((entry) => entry[1]);
}
const mySid = () => /"(S-1-[0-9-]+)"\s*$/.exec(execFileSync(join(system32, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }).trim())[1];

test("keygen writes a private key only this account can read and its public half into lib/update-key.mjs, once", (t) => {
  const box = sandbox(t);
  const made = keygen({ sourceDir: box.sourceDir, privateOut: box.keyPath });
  const pem = readFileSync(box.keyPath, "utf8");
  assert.match(pem, /^-----BEGIN PRIVATE KEY-----/);
  assert.equal(createPrivateKey(pem).asymmetricKeyType, "ed25519");
  assert.equal(shippedKey(box.sourceDir), createPublicKey(createPrivateKey(pem)).export({ type: "spki", format: "der" }).toString("base64"));
  assert.equal(made.publicKey, shippedKey(box.sourceDir));
  assert.ok(!JSON.stringify(made).includes("PRIVATE KEY"), "keygen hands back no part of the private key");
  if (windows) {
    const readers = allowed(box.keyPath);
    assert.ok(readers.includes(mySid()), "this account can read it");
    assert.deepEqual(readers.filter((reader) => ![mySid(), "SY", "BA"].includes(reader)), [], "and nobody else but SYSTEM and Administrators");
  }

  const key = shippedKey(box.sourceDir);
  assert.throws(() => keygen({ sourceDir: box.sourceDir, privateOut: join(box.root, "other.pem") }), /already holds an update key/);
  assert.equal(existsSync(join(box.root, "other.pem")), false);
  assert.equal(shippedKey(box.sourceDir), key, "the key installed copies trust is never replaced");

  const fresh = sandbox(t);
  writeFileSync(fresh.keyPath, "someone's key\n");
  assert.throws(() => keygen({ sourceDir: fresh.sourceDir, privateOut: fresh.keyPath }), /is there already, so no key was made/);
  assert.equal(readFileSync(fresh.keyPath, "utf8"), "someone's key\n");
  assert.equal(shippedKey(fresh.sourceDir), "");
  assert.match(defaultKeyPath({ USERPROFILE: "C:\\Users\\you" }), /^C:\\Users\\you\\\.goblin-horde-release\\update-key\.pem$/);
});

test("build signs the package and its output passes the check every installation makes", async (t) => {
  const box = sandbox(t);
  keygen({ sourceDir: box.sourceDir, privateOut: box.keyPath });
  const built = await build({ sourceDir: box.sourceDir, keyPath: box.keyPath, tags: ["v0.2.0-preview", "v0.4.1", "v0.6.0", "monitor-final"] });
  assert.equal(built.version, "0.6.1");
  const outDir = join(box.sourceDir, "dist", "release");
  const verdict = await verifyRelease({ key: shippedKey(box.sourceDir), ...folderSources(outDir), rule: { newerThan: "0.6.0" } });
  assert.equal(verdict.ok, true, verdict.message);
  const manifest = JSON.parse(readFileSync(join(outDir, "update.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest), ["format", "version", "zip", "size", "sha256", "signature"]);
  assert.deepEqual([manifest.format, manifest.version, manifest.zip, manifest.size], [1, "0.6.1", ZIP_NAME, readFileSync(join(outDir, ZIP_NAME)).length]);
  const inside = readZip(readFileSync(join(outDir, ZIP_NAME))).find((entry) => entry.name === "GoblinHorde/lib/update-key.mjs").data.toString();
  assert.ok(inside.includes(shippedKey(box.sourceDir)), "the release carries the key, so the version it installs can check the next one");
  assert.doesNotMatch(readFileSync(join(outDir, ZIP_NAME)).toString("latin1"), /PRIVATE KEY/);
});

test("build refuses an old version, a checkout with no key, and a signing key that is not that key's other half", async (t) => {
  const box = sandbox(t);
  await assert.rejects(build({ sourceDir: box.sourceDir, keyPath: box.keyPath, tags: [] }), /has no update key, so no installation could check a release\. Run keygen first/);
  keygen({ sourceDir: box.sourceDir, privateOut: box.keyPath });
  await assert.rejects(build({ sourceDir: box.sourceDir, keyPath: box.keyPath, tags: ["v0.6.1"] }), /not newer than the newest release tag, v0\.6\.1/);
  await assert.rejects(build({ sourceDir: box.sourceDir, keyPath: box.keyPath, tags: ["v0.7.0", "v0.6.9"] }), /v0\.7\.0/);
  assert.equal((await build({ sourceDir: box.sourceDir, keyPath: box.keyPath, tags: ["v0.6.1"], forceVersion: true })).version, "0.6.1", "--force-version skips only that check");

  const stranger = sandbox(t);
  keygen({ sourceDir: stranger.sourceDir, privateOut: stranger.keyPath });
  const outDir = join(box.sourceDir, "dist", "release");
  rmSync(outDir, { recursive: true });
  await assert.rejects(build({ sourceDir: box.sourceDir, keyPath: stranger.keyPath, tags: [] }), /is not the other half of the key in lib\/update-key\.mjs/);
  await assert.rejects(build({ sourceDir: box.sourceDir, keyPath: join(box.root, "missing.pem"), tags: [] }), /could not be read/);
  assert.equal(existsSync(outDir), false, "nothing was built");
  assert.deepEqual(newestTag(["v0.10.0", "v0.9.9", "v1.0.0-rc", "x1.2.3"]), "0.10.0");
});

test("a build whose own output does not pass the installations' check removes it", async (t) => {
  const box = sandbox(t);
  // A file name the package builder takes and an installation refuses.
  const odd = "lib/caf\u00e9.mjs";
  writeFileSync(join(box.sourceDir, ...odd.split("/")), "// odd\n");
  const list = JSON.parse(readFileSync(join(box.sourceDir, "package-files.json"), "utf8"));
  writeFileSync(join(box.sourceDir, "package-files.json"), JSON.stringify([...list, odd]));
  keygen({ sourceDir: box.sourceDir, privateOut: box.keyPath });
  await assert.rejects(build({ sourceDir: box.sourceDir, keyPath: box.keyPath, tags: [] }), /did not pass the check every installation makes, so it was removed: .*outside plain ASCII/);
  for (const name of [ZIP_NAME, "update.json"]) assert.equal(existsSync(join(box.sourceDir, "dist", "release", name)), false, name);
});

test("publish prints the gh command for the checked release, and runs it only with --run once gh is signed in", async (t) => {
  const box = sandbox(t);
  keygen({ sourceDir: box.sourceDir, privateOut: box.keyPath });
  await build({ sourceDir: box.sourceDir, keyPath: box.keyPath, tags: [] });
  const ran = [];
  const exec = (signedIn) => (program, args) => {
    ran.push([program, ...args].join(" "));
    if (program === "git") return "0123456789abcdef0123456789abcdef01234567\n";
    if (args[0] === "auth" && !signedIn) throw new Error("not logged in");
    return "";
  };
  const printed = await publish({ sourceDir: box.sourceDir, exec: exec(true) });
  assert.equal(printed.ran, false);
  const commit = "0123456789abcdef0123456789abcdef01234567";
  assert.deepEqual(printed.command.split("\n"), [
    `gh release create v0.6.1 dist/release/GoblinHorde-Team.zip dist/release/update.json --prerelease --target ${commit}`
      + " --title \"Goblin Horde 0.6.1\" --notes \"Goblin Horde 0.6.1. Installed copies find it and check its signature by themselves.\"",
    `(first time only) gh release create pets-latest --prerelease --target ${commit} --title \"Goblin Horde pets (current)\" --notes`
      + " \"The release installed copies look at. It always holds the newest signed build. Releases named v<version> keep each build.\"",
    "gh release upload pets-latest dist/release/GoblinHorde-Team.zip dist/release/update.json --clobber"]);
  assert.doesNotMatch(printed.command, /--latest/, "the repository's Latest release belongs to the monitor app and is never taken");
  assert.deepEqual(ran, ["git rev-parse HEAD"], "without --run, gh is not run");

  ran.length = 0;
  await assert.rejects(publish({ sourceDir: box.sourceDir, run: true, exec: exec(false) }), /gh auth status did not pass, so nothing was published/);
  assert.deepEqual(ran, ["git rev-parse HEAD", "gh auth status"]);
  ran.length = 0;
  assert.equal((await publish({ sourceDir: box.sourceDir, run: true, exec: exec(true) })).ran, true);
  assert.deepEqual(ran.map((line) => line.split(" ").slice(0, 4).join(" ")),
    ["git rev-parse HEAD", "gh auth status", "gh release create v0.6.1", "gh release view pets-latest", "gh release upload pets-latest"],
    "the rolling release already exists, so it is only given the new files");
  assert.match(ran[2], /--prerelease/);

  const fresh = [];
  const exec2 = (program, args) => {
    fresh.push([program, ...args].join(" "));
    if (program === "git") return `${commit}\n`;
    if (args[0] === "release" && args[1] === "view") throw new Error("release not found");
    return "";
  };
  await publish({ sourceDir: box.sourceDir, run: true, exec: exec2 });
  assert.deepEqual(fresh.map((line) => line.split(" ").slice(0, 4).join(" ")),
    ["git rev-parse HEAD", "gh auth status", "gh release create v0.6.1", "gh release view pets-latest", "gh release create pets-latest", "gh release upload pets-latest"],
    "the first publish makes the rolling release before it uploads");

  const zip = join(box.sourceDir, "dist", "release", ZIP_NAME);
  const changed = readFileSync(zip);
  changed[50] ^= 1;
  writeFileSync(zip, changed);
  ran.length = 0;
  await assert.rejects(publish({ sourceDir: box.sourceDir, run: true, exec: exec(true) }), /does not hold a release that passes the check/);
  assert.deepEqual(ran, [], "a changed release is never published");
});
