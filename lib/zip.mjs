/**
 * A minimal ZIP writer and a strict reader, so packaging needs nothing beyond Node on any platform.
 * Entries are deflated, use forward slashes, and carry a fixed timestamp so builds are repeatable.
 * The reader takes an update downloaded from the internet, so it takes only archives as plain as the writer's.
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index++) crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// 2026-01-01 00:00 in DOS time.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

/** entries: [{ name, data: Buffer }] → Buffer of a complete ZIP archive. */
export function createZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    if (!/^[^\\/][^\\]*$/.test(name) || name.split("/").includes("..")) throw new Error(`Unsafe archive path: ${name}`);
    const nameBytes = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names.
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // Made by Unix, so permissions below are honoured.
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
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

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const UTF8_NAMES = 0x0800;
const ENCRYPTED = 0x0041; // Traditional and strong encryption.
const ZIP64 = 0xffffffff;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * The entries of an untrusted ZIP archive: [{ name, data }]. Only a plain archive is read: one disk, an end record
 * with no comment in the last 22 bytes, no ZIP64, no encryption, no data descriptors, extra fields or comments, each
 * entry stored or deflated, with a UTF-8 name, and with local and central records that agree. There are at most
 * `maxEntries` entries and at most `maxBytes` declared in all, which is checked before anything is inflated, and each
 * entry must inflate to exactly its declared size and checksum. Throws an Error that says what is wrong otherwise.
 * @param {Buffer} buffer @param {{ maxEntries?: number, maxBytes?: number }} [limits]
 * @returns {{ name: string, data: Buffer }[]}
 */
export function readZip(buffer, { maxEntries = 200, maxBytes = 60 * 1024 * 1024 } = {}) {
  const fail = (why) => { throw new Error(`The ZIP archive ${why}.`); };
  const end = buffer.length - 22;
  if (end < 0 || buffer.readUInt32LE(end) !== END) fail("does not end with a plain end record");
  if (end >= 20 && buffer.readUInt32LE(end - 20) === ZIP64_LOCATOR) fail("is a ZIP64 archive");
  const count = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  const directoryAt = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || directorySize === ZIP64 || directoryAt === ZIP64) fail("is a ZIP64 archive");
  if (buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0 || buffer.readUInt16LE(end + 8) !== count || buffer.readUInt16LE(end + 20) !== 0)
    fail("spans disks or has a comment");
  if (count > maxEntries) fail(`has ${count} entries, more than ${maxEntries}`);
  if (directoryAt + directorySize !== end) fail("has a damaged directory");

  const entries = [];
  let declared = 0;
  let at = directoryAt;
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || buffer.readUInt32LE(at) !== CENTRAL) fail("has a damaged directory");
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const packed = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const localAt = buffer.readUInt32LE(at + 42);
    if (flags & ENCRYPTED) fail("holds an encrypted entry");
    if (packed === ZIP64 || size === ZIP64 || localAt === ZIP64) fail("is a ZIP64 archive");
    if ((flags & ~UTF8_NAMES) || buffer.readUInt16LE(at + 30) || buffer.readUInt16LE(at + 32) || buffer.readUInt16LE(at + 34)) fail("uses a feature this reader does not take");
    if (method !== 0 && method !== 8) fail(`uses compression method ${method}`);
    if (at + 46 + nameLength > end) fail("has a damaged directory");
    const nameBytes = buffer.subarray(at + 46, at + 46 + nameLength);
    let name = "";
    try { name = strictUtf8.decode(nameBytes); } catch { fail("has an entry name that is not UTF-8"); }
    if (localAt + 30 + nameLength > directoryAt || buffer.readUInt32LE(localAt) !== LOCAL) fail(`has a damaged entry (${name})`);
    const agrees = buffer.readUInt16LE(localAt + 6) === flags && buffer.readUInt16LE(localAt + 8) === method && buffer.readUInt32LE(localAt + 14) === crc
      && buffer.readUInt32LE(localAt + 18) === packed && buffer.readUInt32LE(localAt + 22) === size && buffer.readUInt16LE(localAt + 26) === nameLength
      && buffer.readUInt16LE(localAt + 28) === 0 && buffer.subarray(localAt + 30, localAt + 30 + nameLength).equals(nameBytes);
    if (!agrees) fail(`has local and central records that disagree (${name})`);
    const dataAt = localAt + 30 + nameLength;
    if (dataAt + packed > directoryAt) fail(`has an entry that runs past its data (${name})`);
    declared += size;
    if (declared > maxBytes) fail(`unpacks to more than ${maxBytes} bytes`);
    entries.push({ name, method, crc, size, raw: buffer.subarray(dataAt, dataAt + packed) });
    at += 46 + nameLength;
  }
  if (at !== end) fail("has a damaged directory");

  return entries.map(({ name, method, crc, size, raw }) => {
    let data = Buffer.from(raw);
    if (method === 8) {
      try { data = inflateRawSync(raw, { maxOutputLength: Math.max(1, size) }); } catch (error) {
        fail(error.code === "ERR_BUFFER_TOO_LARGE" ? `has an entry that unpacks to more than it declares (${name})` : `has an entry that does not unpack (${name})`);
      }
    }
    if (data.length !== size) fail(`has an entry whose size is not the one it declares (${name})`);
    if (crc32(data) !== crc) fail(`has an entry whose checksum is wrong (${name})`);
    return { name, data };
  });
}
