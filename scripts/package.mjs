#!/usr/bin/env node
/**
 * Build GoblinHorde-Team.zip from the explicit allowlist in package-files.json.
 *
 *   node scripts/package.mjs [--out path/to/GoblinHorde-Team.zip]
 *
 * Only listed files are packed, under a top-level GoblinHorde/ folder. The build stops if a listed
 * file is missing, looks like local state (chats, pairing codes, logs), or contains a personal
 * path, e-mail address, or credential-like string.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSource } from "../lib/manager.mjs";
import { createZip } from "../lib/zip.mjs";

export const PACKAGE_NAME = "GoblinHorde-Team.zip";
const STATE_NAMES = /^(pairing-code\.txt|goblins\.json|goblin-horde-install\.json|goblin-horde-skill\.json|settings(\.local)?\.json|\.env.*|.*\.(jsonl|ndjson|log|pem|key|zip|pyc))$/i;
const RULES = [
  { name: "a Windows user folder", pattern: /\b[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}(?!(?:Public|Default|you|me|name|example|USERNAME)\b)[A-Za-z0-9._-]+/i },
  { name: "a macOS user folder", pattern: /\/Users\/(?!(?:Shared|you|me|name|example)\b)[A-Za-z0-9._-]+/ },
  { name: "a Linux home folder", pattern: /\/home\/(?!(?:user|you|me|name|example)\b)[A-Za-z0-9._-]+/ },
  { name: "an e-mail address", pattern: /\b[A-Za-z0-9._%+-]+@(?!(?:example\.(?:com|org)|anthropic\.com)\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/ },
  { name: "a credential", pattern: /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

/** Findings for one file: [{ file, rule, line }]. */
export function scanFile(file, text) {
  const findings = [];
  if (STATE_NAMES.test(basename(file))) findings.push({ file, rule: "a local state or generated file", line: 0 });
  text.split(/\r?\n/).forEach((line, index) => {
    for (const rule of RULES) if (rule.pattern.test(line)) findings.push({ file, rule: rule.name, line: index + 1 });
  });
  return findings;
}

export function buildPackage({ sourceDir, outFile }) {
  const files = checkSource(sourceDir);
  const findings = [];
  const entries = files.map((file) => {
    const data = readFileSync(join(sourceDir, ...file.split("/")));
    findings.push(...scanFile(file, data.toString("utf8")));
    return { name: `GoblinHorde/${file}`, data };
  });
  if (findings.length) {
    const list = findings.map((item) => `  ${item.file}${item.line ? `:${item.line}` : ""} looks like ${item.rule}`).join("\n");
    throw new Error(`The package was not built because these files may contain private details:\n${list}`);
  }
  const archive = createZip(entries);
  mkdirSync(dirname(outFile), { recursive: true });
  const temp = `${outFile}.${process.pid}.tmp`;
  writeFileSync(temp, archive);
  renameSync(temp, outFile);
  return { outFile, files, bytes: archive.length };
}

const fold = (path) => (process.platform === "win32" ? path.toLowerCase() : path);
if (fold(resolve(process.argv[1] || "")) === fold(fileURLToPath(import.meta.url))) {
  const sourceDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const outFlag = process.argv.indexOf("--out");
  const outFile = resolve(outFlag > 0 && process.argv[outFlag + 1] ? process.argv[outFlag + 1] : join(sourceDir, "dist", PACKAGE_NAME));
  try {
    const result = buildPackage({ sourceDir, outFile });
    console.log(`Created ${result.outFile} (${result.files.length} files, ${Math.round(result.bytes / 1024)} KB)`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
