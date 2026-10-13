#!/usr/bin/env node
/**
 * Draws goblin.ico, the Start Menu and taskbar icon, from goblin_art.json: a raider's head and shoulders
 * at 16, 24, 32, 48, 64, and 256 pixels, each a PNG inside the icon file. Run after changing the art:
 *   node scripts/make-icon.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const art = JSON.parse(readFileSync(join(root, "goblin_art.json"), "utf8"));
const tribe = art.tribes.raider;
const style = tribe.outfits[0];

// The 16x16 goblin grid, with headgear rising above row 0: paint body, eyes, gear, and the resting arm.
const GRID = 18;
const TOP = 2; // Rows of headroom for the cap.
const pixels = Array.from({ length: GRID }, () => Array(GRID).fill(null));
const shade = (hex, factor) => {
  const value = parseInt(hex.slice(1), 16);
  return [16, 8, 0].map((shift) => Math.round(((value >> shift) & 255) * factor));
};
const rgb = (hex) => shade(hex, 1);
const color = (key) => {
  const role = art.styleColors[key];
  if (!role) return rgb(art.colors[key]);
  return role === "coatDark" ? shade(style.coat, art.coatDark) : rgb(style[role]);
};
for (const name of [tribe.body, "eyesFwd", `gear.${style.gear}`]) {
  const layer = art.layers[name];
  const [lx, ly] = layer.at;
  layer.rows.forEach((row, r) => [...row].forEach((key, c) => {
    const x = lx + c + 1;
    const y = ly + r + TOP;
    if (key !== "." && x >= 0 && x < GRID && y >= 0 && y < GRID) pixels[y][x] = color(key);
  }));
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

/** One square RGBA PNG, the goblin scaled by whole pixels and centred. */
function png(size) {
  const scale = Math.max(1, Math.floor(size / GRID));
  const offset = Math.floor((size - GRID * scale) / 2);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const gx = Math.floor((x - offset) / scale);
      const gy = Math.floor((y - offset) / scale);
      const value = gx >= 0 && gy >= 0 && gx < GRID && gy < GRID ? pixels[gy][gx] : null;
      const at = y * (size * 4 + 1) + 1 + x * 4;
      if (value) { raw[at] = value[0]; raw[at + 1] = value[1]; raw[at + 2] = value[2]; raw[at + 3] = 255; }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const sizes = [16, 24, 32, 48, 64, 256];
const images = sizes.map(png);
const directory = Buffer.alloc(6 + 16 * sizes.length);
directory.writeUInt16LE(0, 0);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(sizes.length, 4);
let offset = directory.length;
sizes.forEach((size, index) => {
  const at = 6 + 16 * index;
  directory[at] = size >= 256 ? 0 : size;
  directory[at + 1] = size >= 256 ? 0 : size;
  directory.writeUInt16LE(1, at + 4);
  directory.writeUInt16LE(32, at + 6);
  directory.writeUInt32LE(images[index].length, at + 8);
  directory.writeUInt32LE(offset, at + 12);
  offset += images[index].length;
});
writeFileSync(join(root, "goblin.ico"), Buffer.concat([directory, ...images]));
console.log(`Wrote goblin.ico (${sizes.join(", ")} px).`);
