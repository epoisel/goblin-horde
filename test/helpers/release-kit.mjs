/**
 * Releases for update tests, made as scripts/release.mjs makes them but with a key made for the test: the package's
 * own files, or a version of them, packed by the real package builder and signed. A raw ZIP writer for archives no
 * builder should make. And GitHub as fetch sees it, serving the latest release behind redirects and keeping what was
 * asked. Nothing here goes to the network or reads this computer's Goblin Horde state.
 */
import { generateKeyPairSync, sign } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readManifest } from "../../lib/manager.mjs";
import { MANIFEST_URL, ZIP_NAME, ZIP_URL, sha256Of, signedText } from "../../lib/updater.mjs";
import { crc32 } from "../../lib/zip.mjs";
import { deflateRawSync } from "node:zlib";
import { buildPackage } from "../../scripts/package.mjs";

export const SOURCE = fileURLToPath(new URL("../..", import.meta.url));

/** An Ed25519 key pair: `key` as lib/update-key.mjs holds one, and the private key that signs. */
export function testKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { key: publicKey.export({ type: "spki", format: "der" }).toString("base64"), privateKey };
}

/** update.json for `zip` as release `version`, signed with `privateKey`. `signed` replaces what is signed, `written` what is written. */
export function manifestFor(zip, { version, privateKey, signed = {}, written = {} }) {
  const fields = { version, size: zip.length, sha256: sha256Of(zip), ...signed };
  const signature = sign(null, Buffer.from(signedText(fields), "utf8"), privateKey).toString("base64");
  return Buffer.from(JSON.stringify({ format: 1, version: fields.version, zip: ZIP_NAME, size: fields.size, sha256: fields.sha256, signature, ...written }));
}

/** A copy of the package's files in `dir` as version `version` with update key `key`, then changed by `change(dir)`. */
export function packageCopy(dir, { version, key, change = () => {} }) {
  for (const file of readManifest(SOURCE)) {
    const target = join(dir, ...file.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(SOURCE, ...file.split("/")), target);
  }
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
  writeFileSync(join(dir, "lib", "update-key.mjs"), `export const UPDATE_KEY = "${key}";\n`);
  change(dir);
  return dir;
}

/** Release `version` of the package, built under `root` and signed with `kit`'s key: { version, zip, manifest, source }. */
export function makeRelease(root, kit, version, { change } = {}) {
  const source = packageCopy(join(root, `source-${version}`), { version, key: kit.key, change });
  const outFile = join(root, `release-${version}.zip`);
  buildPackage({ sourceDir: source, outFile });
  const zip = readFileSync(outFile);
  return { version, zip, manifest: manifestFor(zip, { version, privateKey: kit.privateKey }), source };
}

/**
 * A ZIP written with none of createZip's checks, for archives no builder should make. Each entry is
 * { name, data, method?, flags?, size?, crc?, packedSize? }: `size`, `crc` and `packedSize` are what the records declare,
 * the data's own by default.
 */
export function rawZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, method = 8, flags = 0x0800, size = data.length, crc = crc32(data), packedSize } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const bytes = method === 8 ? deflateRawSync(data) : data;
    const packed = { length: packedSize ?? bytes.length, bytes };
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed.bytes);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.bytes.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/**
 * The entries of a small package of version `version`: package.json, package-files.json listing `files` and itself,
 * and each of `files`, all under GoblinHorde/. `extra` entries are added as they are, listed or not.
 */
export function packageEntries(version, { files = { "goblin.mjs": "// goblin\n" }, listed, extra = [] } = {}) {
  const names = listed ?? ["package.json", "package-files.json", ...Object.keys(files)];
  return [
    { name: "GoblinHorde/package.json", data: Buffer.from(JSON.stringify({ name: "goblin-horde", version })) },
    { name: "GoblinHorde/package-files.json", data: Buffer.from(JSON.stringify(names)) },
    ...Object.entries(files).map(([path, text]) => ({ name: `GoblinHorde/${path}`, data: Buffer.from(text) })),
    ...extra,
  ];
}

const answer = (status, body = "", headers = {}) => new Response(status === 200 ? body : null, { status, headers });

/**
 * GitHub as fetch sees it: update.json and the ZIP of the latest release, each behind a redirect to its own address
 * on objects.githubusercontent.com, as GitHub's latest/download addresses are. `routes` replaces the answer for an
 * address with an answer or a function of the request. `asked` keeps each request: its address and its options.
 */
export function fakeGitHub({ manifest, zip, routes = {} } = {}) {
  const asked = [];
  const assets = {
    [MANIFEST_URL]: answer(302, "", { location: "https://objects.githubusercontent.com/assets/update.json" }),
    [ZIP_URL]: answer(302, "", { location: "https://objects.githubusercontent.com/assets/zip" }),
    "https://objects.githubusercontent.com/assets/update.json": manifest,
    "https://objects.githubusercontent.com/assets/zip": zip,
  };
  const fetch = async (url, init = {}) => {
    asked.push({ url, init });
    const route = url in routes ? routes[url] : assets[url];
    if (typeof route === "function") return route(url, init);
    if (route instanceof Response) return route.clone();
    if (route === undefined || route === null) return answer(404);
    return answer(200, route);
  };
  return { fetch, asked, urls: () => asked.map((request) => request.url) };
}
