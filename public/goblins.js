/**
 * Pixel goblins drawn from goblin_art.json, the same sprite data the product reel uses.
 * Each goblin is a 26x28 canvas scaled up with CSS (image-rendering: pixelated). One shared
 * ticker advances every visible goblin; reduced-motion users get a single readable frame.
 */
import { outfitIndex } from "./party.js";

// The widget's eight outfits (desktop_widget.py KINDS), so a goblin looks the same everywhere.
export const OUTFITS = [
  { name: "Moss", skin: "#78b783", shade: "#417d58", coat: "#315b45", light: "#d3aa69", accent: "#a7d6b0", gear: "bandana" },
  { name: "Ember", skin: "#9fb663", shade: "#677d3c", coat: "#a84e38", light: "#e3b56d", accent: "#f0af89", gear: "helm" },
  { name: "Moon", skin: "#8ebba6", shade: "#4f8b7a", coat: "#665b8c", light: "#cbb18b", accent: "#c7b9e2", gear: "scarf" },
  { name: "Cog", skin: "#a9be74", shade: "#718946", coat: "#4c7186", light: "#d0aa68", accent: "#a5d5e6", gear: "goggles" },
  { name: "Marsh", skin: "#78ad86", shade: "#4c7e5d", coat: "#986940", light: "#dec481", accent: "#e3c48d", gear: "patch" },
  { name: "Frost", skin: "#a4cabb", shade: "#6c9a8b", coat: "#52728f", light: "#d8bd87", accent: "#b7dce5", gear: "visor" },
  { name: "Berry", skin: "#a0bd83", shade: "#6e8c53", coat: "#92536e", light: "#dfad79", accent: "#e7acca", gear: "bandana" },
  { name: "Sage", skin: "#a6c17b", shade: "#668b51", coat: "#66775b", light: "#d7b477", accent: "#cbdab1", gear: "patch" },
];
const GEAR_LAYER = { bandana: "gear.bandana", helm: "gear.hardhat", scarf: "gear.scarf", goggles: "gear.goggles", patch: "gear.cap", visor: "gear.visor" };
const BODY_DY = { "build.strike": 1, "build.settle": 1, "trouble.drop1": 1, "trouble.drop2": 1, "trouble.drop3": 1 };
// action -> [frame cycle, ms per frame]; the same timing as the reel.
const CYCLES = {
  search: [["search.peer", "search.out", "search.low", "search.out"], 300],
  build: [["build.raise", "build.raise", "build.strike", "build.settle"], 160],
  think: [["think.dots1", "think.dots2", "think.dots3", "think.dots3"], 420],
  waiting: [["waiting.up", "waiting.out"], 280],
  trouble: [["trouble.drop1", "trouble.drop2", "trouble.drop3"], 300],
  idle: [["idle.rest", "idle.rest", "idle.rest", "idle.rest", "idle.rest", "idle.rest", "idle.rest", "idle.blink"], 220],
};
const STILL = { search: "search.out", build: "build.strike", think: "think.dots3", waiting: "waiting.up", trouble: "trouble.drop2", idle: "idle.rest" };

let art = null;
const frames = new Map();
const live = new Set();
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

export async function loadArt() {
  if (art) return art;
  const response = await fetch("/goblin_art.json", { cache: "force-cache" });
  art = await response.json();
  for (const canvas of live) paint(canvas, true);
  return art;
}

function shade(hex, factor) {
  const value = parseInt(hex.slice(1), 16);
  const channel = (shift) => Math.round(((value >> shift) & 255) * factor);
  return `rgb(${channel(16)},${channel(8)},${channel(0)})`;
}

function frameImage(outfit, frame) {
  const key = `${outfit}:${frame}`;
  if (frames.has(key)) return frames.get(key);
  const style = OUTFITS[outfit % OUTFITS.length];
  const [width, height] = art.size;
  const [ox, oy] = art.origin;
  const palette = { ...art.colors };
  for (const [letter, role] of Object.entries(art.styleColors)) palette[letter] = role === "coatDark" ? shade(style.coat, art.coatDark) : style[role];
  const image = document.createElement("canvas");
  image.width = width;
  image.height = height;
  const ctx = image.getContext("2d");
  const dy = BODY_DY[frame] || 0;
  for (const name of ["shadow", "body", GEAR_LAYER[style.gear], ...(art.frames[frame] || [])]) {
    const layer = name && art.layers[name];
    if (!layer) continue;
    const [lx, ly] = layer.at;
    const shift = name === "shadow" ? 0 : dy;
    layer.rows.forEach((row, r) => {
      for (let c = 0; c < row.length; c++) {
        const letter = row[c];
        if (letter === ".") continue;
        ctx.fillStyle = palette[letter];
        ctx.fillRect(ox + lx + c, oy + ly + r + shift, 1, 1);
      }
    });
  }
  frames.set(key, image);
  return image;
}

function frameFor(canvas, now) {
  const action = CYCLES[canvas.dataset.action] ? canvas.dataset.action : "idle";
  if (reduceMotion.matches || canvas.dataset.still === "1") return STILL[action];
  const [cycle, step] = CYCLES[action];
  return cycle[Math.floor((now + Number(canvas.dataset.phase || 0)) / step) % cycle.length];
}

function paint(canvas, force = false) {
  if (!art) return;
  const frame = frameFor(canvas, performance.now());
  if (!force && canvas.dataset.frame === frame) return;
  canvas.dataset.frame = frame;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(frameImage(Number(canvas.dataset.outfit), frame), 0, 0);
}

/** A goblin canvas for this member id; size is CSS pixels per sprite pixel. */
export function createGoblin(id, action = "idle", { size = 3, label = "", still = false } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = 26;
  canvas.height = 28;
  canvas.className = "goblin";
  canvas.style.setProperty("--px", String(size));
  canvas.dataset.outfit = String(outfitIndex(id, OUTFITS.length));
  canvas.dataset.phase = String(outfitIndex(`${id}:phase`, 997));
  if (still) canvas.dataset.still = "1";
  canvas.setAttribute("role", "img");
  setGoblinAction(canvas, action, label);
  return canvas;
}

export function setGoblinAction(canvas, action, label = "") {
  live.add(canvas); // A goblin moved between panels rejoins the ticker.
  if (canvas.dataset.action !== action) {
    canvas.dataset.action = action;
    paint(canvas, true);
  }
  canvas.setAttribute("aria-label", label || `Goblin, ${action === "idle" ? "resting" : action}`);
}

function tick() {
  if (!document.hidden) for (const canvas of live) {
    if (!canvas.isConnected) { live.delete(canvas); continue; }
    paint(canvas);
  }
  setTimeout(tick, reduceMotion.matches ? 1000 : 80);
}
tick();
