#!/usr/bin/env node
/**
 * Make a signed release of Goblin Horde, on the one computer that holds the signing key.
 *
 *   node scripts/release.mjs keygen [--private-out PATH]
 *   node scripts/release.mjs build [--key PATH] [--force-version]
 *   node scripts/release.mjs publish [--run]
 *
 * keygen makes the Ed25519 key pair, once. The private key goes to PATH, by default
 * .goblin-horde-release\update-key.pem in your user folder, readable by your account only and never printed. The
 * public key goes into lib/update-key.mjs, which every build ships and every installation checks updates against.
 * build packs dist/release/GoblinHorde-Team.zip from package-files.json, signs its version, size and SHA-256 into
 * dist/release/update.json, and checks both with the same verification every installation runs. publish prints the
 * gh command that puts the two files on a GitHub release of this commit, and runs it only with --run.
 */
import { execFileSync } from "node:child_process";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createPrivateFile } from "../lib/private-file.mjs";
import { MANIFEST_NAME, ZIP_NAME, compareVersions, folderSources, isVersion, sha256Of, signedText, verifyRelease } from "../lib/updater.mjs";
import { buildPackage } from "./package.mjs";

const KEY_LINE = /^export const UPDATE_KEY = "([A-Za-z0-9+/=]*)";(\r?)$/m;
// Every version is newer than this, so the build's own check takes any version and checks everything else.
const ANY_VERSION = { newerThan: "0.0.0" };

export const defaultKeyPath = (env = process.env) => join(env.USERPROFILE || homedir(), ".goblin-horde-release", "update-key.pem");
const keyFileOf = (sourceDir) => join(sourceDir, "lib", "update-key.mjs");
const releaseDir = (sourceDir) => join(sourceDir, "dist", "release");

/** The key an installation built from `sourceDir` would check updates with, read as the installation reads it. */
async function shippedKey(sourceDir) {
  const url = `${pathToFileURL(keyFileOf(sourceDir)).href}?read=${Date.now()}-${Math.random()}`;
  return (await import(url)).UPDATE_KEY;
}

/**
 * Make the key pair. The private key is written to `privateOut`, which must not exist, made private to this account
 * before anything is in it. The public key goes into lib/update-key.mjs, which must still be empty, since installed
 * copies trust the key it holds and a new one would stop their updates.
 */
export function keygen({ sourceDir, privateOut }) {
  const keyFile = keyFileOf(sourceDir);
  const text = readFileSync(keyFile, "utf8");
  const line = KEY_LINE.exec(text);
  if (!line || text.match(new RegExp(KEY_LINE.source, "gm")).length !== 1) throw new Error("lib/update-key.mjs does not hold the one UPDATE_KEY line keygen writes, so nothing was changed.");
  if (line[1]) throw new Error("lib/update-key.mjs already holds an update key. Installed copies trust that key, and a new one would stop their updates, so nothing was changed.");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  mkdirSync(dirname(privateOut), { recursive: true });
  try {
    createPrivateFile(privateOut, privateKey.export({ type: "pkcs8", format: "pem" }));
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`${privateOut} is there already, so no key was made. Keep that file, or choose another place with --private-out.`);
    throw error;
  }
  const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  try {
    const temp = `${keyFile}.${process.pid}.tmp`;
    writeFileSync(temp, text.replace(KEY_LINE, `export const UPDATE_KEY = "${spki}";$2`));
    renameSync(temp, keyFile);
  } catch (error) {
    throw new Error(`The private key is in ${privateOut}, but lib/update-key.mjs could not be written (${error.code || error.message}). Put this public key between its quotes: ${spki}`);
  }
  return { privateOut, publicKey: spki };
}

/** The tags of the checkout at `sourceDir` that start with v. */
export function gitTags(sourceDir) {
  try { return execFileSync("git", ["tag", "--list", "v*"], { cwd: sourceDir, encoding: "utf8", windowsHide: true }).split(/\r?\n/).filter(Boolean); } catch (error) {
    throw new Error(`The git tags could not be listed (${error.code || error.message}), so the version could not be compared with the last release. Pass --force-version to build anyway.`);
  }
}

/** The newest x.y.z among tags named vX.Y.Z, or "". */
export function newestTag(tags) {
  return tags.map((tag) => tag.slice(1)).filter((tag, index) => tags[index].startsWith("v") && isVersion(tag)).sort(compareVersions).at(-1) || "";
}

/**
 * Build and sign the release of the version package.json names, into dist/release, then check it with
 * verifyRelease, as an installation would. Refuses a version that is not newer than the newest vX.Y.Z tag unless
 * `forceVersion`, a checkout whose lib/update-key.mjs is empty, and a signing key that is not that key's other half.
 * When its own output does not pass, the output is removed.
 */
export async function build({ sourceDir, keyPath, forceVersion = false, tags }) {
  const { version } = JSON.parse(readFileSync(join(sourceDir, "package.json"), "utf8"));
  if (!isVersion(version)) throw new Error(`package.json says version ${version}, which is not a plain x.y.z version.`);
  if (!forceVersion) {
    const newest = newestTag(tags ?? gitTags(sourceDir));
    if (newest && compareVersions(version, newest) <= 0)
      throw new Error(`package.json says ${version}, which is not newer than the newest release tag, v${newest}. Raise the version in package.json, or pass --force-version to build it anyway.`);
  }
  const key = await shippedKey(sourceDir);
  if (!key) throw new Error("lib/update-key.mjs has no update key, so no installation could check a release. Run keygen first.");
  let privateKey;
  try { privateKey = createPrivateKey(readFileSync(keyPath)); } catch (error) { throw new Error(`The signing key could not be read from ${keyPath} (${error.code || error.message}).`); }
  if (privateKey.asymmetricKeyType !== "ed25519" || createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64") !== key)
    throw new Error(`The signing key in ${keyPath} is not the other half of the key in lib/update-key.mjs, so installations would refuse what it signs. Nothing was built.`);

  const outDir = releaseDir(sourceDir);
  const zipFile = join(outDir, ZIP_NAME);
  const manifestFile = join(outDir, MANIFEST_NAME);
  rmSync(manifestFile, { force: true });
  buildPackage({ sourceDir, outFile: zipFile });
  const zip = readFileSync(zipFile);
  const signed = { version, size: zip.length, sha256: sha256Of(zip) };
  const signature = sign(null, Buffer.from(signedText(signed), "utf8"), privateKey).toString("base64");
  writeFileSync(manifestFile, `${JSON.stringify({ format: 1, version, zip: ZIP_NAME, size: signed.size, sha256: signed.sha256, signature }, null, 2)}\n`);
  const verdict = await verifyRelease({ key, ...folderSources(outDir), rule: ANY_VERSION });
  if (!verdict.ok) {
    rmSync(zipFile, { force: true });
    rmSync(manifestFile, { force: true });
    throw new Error(`The release did not pass the check every installation makes, so it was removed: ${verdict.message}`);
  }
  return { version, zipFile, manifestFile, size: signed.size, sha256: signed.sha256, files: verdict.release.files.length };
}

const quoted = (arg) => (/^[A-Za-z0-9._/:=@-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`);

/**
 * The gh command that makes release v<version> of the commit checked out, with the two files of dist/release, once
 * they pass the check every installation makes and are of the version package.json names. `run` runs it, after
 * `gh auth status` says gh is signed in. `exec` runs a program, as execFileSync does.
 */
export async function publish({ sourceDir, run = false, exec = execFileSync }) {
  const { version } = JSON.parse(readFileSync(join(sourceDir, "package.json"), "utf8"));
  const verdict = await verifyRelease({ key: await shippedKey(sourceDir), ...folderSources(releaseDir(sourceDir)), rule: ANY_VERSION });
  if (!verdict.ok) throw new Error(`dist/release does not hold a release that passes the check every installation makes (${verdict.message}). Run build first.`);
  if (verdict.release.version !== version) throw new Error(`dist/release holds ${verdict.release.version}, but package.json says ${version}. Run build again.`);
  const commit = String(exec("git", ["rev-parse", "HEAD"], { cwd: sourceDir, encoding: "utf8", windowsHide: true })).trim();
  const args = ["release", "create", `v${version}`, `dist/release/${ZIP_NAME}`, `dist/release/${MANIFEST_NAME}`, "--target", commit,
    "--title", `Goblin Horde ${version}`, "--notes", `Goblin Horde ${version}. Installed copies find it and check its signature by themselves.`];
  const command = `gh ${args.map(quoted).join(" ")}`;
  if (!run) return { command, ran: false };
  try { exec("gh", ["auth", "status"], { cwd: sourceDir, stdio: "inherit", windowsHide: true }); } catch {
    throw new Error("gh auth status did not pass, so nothing was published. Sign in with: gh auth login");
  }
  exec("gh", args, { cwd: sourceDir, stdio: "inherit", windowsHide: true });
  return { command, ran: true };
}

const fold = (path) => (process.platform === "win32" ? path.toLowerCase() : path);
if (fold(resolve(process.argv[1] || "")) === fold(fileURLToPath(import.meta.url))) {
  const sourceDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      "private-out": { type: "string" }, key: { type: "string" }, "force-version": { type: "boolean" }, run: { type: "boolean" } } });
    const [command] = positionals;
    if (command === "keygen") {
      const made = keygen({ sourceDir, privateOut: resolve(values["private-out"] || defaultKeyPath()) });
      console.log(`Made the update key pair. The private key is in ${made.privateOut}, readable by your account only: keep it there and back it up offline.`);
      console.log("The public key is now in lib/update-key.mjs. Commit it, and install that build on each computer by hand once.");
    } else if (command === "build") {
      const built = await build({ sourceDir, keyPath: resolve(values.key || defaultKeyPath()), forceVersion: Boolean(values["force-version"]) });
      console.log(`Built and signed Goblin Horde ${built.version}: ${built.zipFile} (${built.size} bytes, ${built.files} files, SHA-256 ${built.sha256}) and ${built.manifestFile}.`);
      console.log("Both pass the check every installation makes. Next: node scripts/release.mjs publish");
    } else if (command === "publish") {
      const published = await publish({ sourceDir, run: Boolean(values.run) });
      console.log(published.ran ? "Published." : `Run this from ${sourceDir} to publish, or run publish --run:\n${published.command}`);
    } else {
      console.log("Usage: node scripts/release.mjs keygen [--private-out PATH] | build [--key PATH] [--force-version] | publish [--run]");
      process.exitCode = command ? 2 : 0;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
