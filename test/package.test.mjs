import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_NAME, buildPackage, scanFile } from "../scripts/package.mjs";
import { readManifest } from "../lib/manager.mjs";
import { createZip, crc32, readZip } from "../lib/zip.mjs";

const sourceDir = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the zip writer round-trips and computes standard CRCs", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  const entries = [{ name: "GoblinHorde/a.txt", data: Buffer.from("hello") }, { name: "GoblinHorde/lib/b.mjs", data: Buffer.alloc(5000, 65) }];
  const back = readZip(createZip(entries));
  assert.deepEqual(back.map((entry) => [entry.name, entry.data.toString()]), entries.map((entry) => [entry.name, entry.data.toString()]));
  assert.throws(() => createZip([{ name: "../evil", data: Buffer.alloc(1) }]), /Unsafe/);
  assert.throws(() => createZip([{ name: "C:\\evil", data: Buffer.alloc(1) }]), /Unsafe/);
});

test("the team package holds exactly the allowlist, byte for byte", () => {
  const dir = mkdtempSync(join(tmpdir(), "goblin-package-"));
  try {
    const outFile = join(dir, PACKAGE_NAME);
    const result = buildPackage({ sourceDir, outFile });
    const manifest = readManifest(sourceDir);
    const entries = readZip(readFileSync(outFile));
    assert.deepEqual(entries.map((entry) => entry.name), manifest.map((file) => `GoblinHorde/${file}`));
    for (const entry of entries) assert.deepEqual(entry.data, readFileSync(join(sourceDir, entry.name.slice("GoblinHorde/".length))), entry.name);
    assert.equal(result.files.length, manifest.length);
    // Everything needed to install and run on any platform is present.
    for (const needed of ["goblin.mjs", "server.mjs", "claude-hook.mjs", "lib/manager.mjs", "lib/extension.mjs", "public/index.html", "EXTENSIONS.md", "manage.ps1"])
      assert.ok(manifest.includes(needed), needed);
    // Nothing local, generated, or test-only.
    for (const name of manifest) assert.doesNotMatch(name, /^(test|dist|\.git)\/|pairing-code|goblins\.json|\.jsonl$|\.ndjson$|\.log$|\.png$|__pycache__|REVIEW\.md$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the privacy scan catches personal paths, addresses, credentials, and state files", () => {
  const findings = (text, file = "x.md") => scanFile(file, text).map((item) => item.rule);
  assert.deepEqual(findings("Open C:\\Users\\alice\\AppData"), ["a Windows user folder"]);
  assert.deepEqual(findings("see /Users/bob/Library"), ["a macOS user folder"]);
  assert.deepEqual(findings("see /home/carol/.config"), ["a Linux home folder"]);
  assert.deepEqual(findings("mail dave@corp.io"), ["an e-mail address"]);
  assert.deepEqual(findings(`key ghp_${"x".repeat(30)}`), ["a credential"]);
  assert.deepEqual(findings("{}", "pairing-code.txt"), ["a local state or generated file"]);
  assert.deepEqual(findings("C:\\Users\\you\\, /home/user/, noreply@anthropic.com, %LOCALAPPDATA%"), []);
});
