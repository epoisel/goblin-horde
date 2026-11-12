import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
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
    // Everything needed to install and run is present, and nothing of the agent monitor is.
    for (const needed of ["goblin.mjs", "server.mjs", "desktop_widget.py", "lib/manager.mjs", "lib/old-hooks.mjs", "manage.ps1", "launch.cmd"])
      assert.ok(manifest.includes(needed), needed);
    for (const name of manifest) assert.doesNotMatch(name, /^public\/|^claude-hook\.mjs$|^EXTENSIONS\.md$|^lib\/(?:claude|orca|codex|phone|transcript|tasks?|feed|links|watch|dismiss|extension)/);
    // Nothing local, generated, or test-only: no tests, working notes, design drafts, dev scripts, or saved games.
    for (const name of manifest) assert.doesNotMatch(name, /^(test|dist|\.git|\.audit)\/|^docs\/(?!(?:SETUP-PROMPT|SHARED-PETS|SHARED-HOST-PROMPT|SHARED-JOIN-PROMPT)\.md$)|^scripts\/(?!package\.mjs$)|pairing-code|goblins\.json|pets\.json|\.jsonl$|\.ndjson$|\.log$|\.png$|__pycache__|REVIEW\.md$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const CODE = /\.(py|mjs|js)$/;
const RUNTIME_FILE = /\.(py|mjs|js|json|ico|cmd|html|css|svg)$/;

/**
 * The files one shipped source file needs beside it when it runs: the local Python modules it imports, the
 * files a Node or browser module imports by relative path, and any code or data file it names in a string.
 * `isFile` says whether a package path is a file in the source folder, so the standard library is left out.
 */
function needs(file, text, isFile) {
  const found = new Set();
  const local = (path) => { if (path !== file && isFile(path)) found.add(path); };
  if (file.endsWith(".py")) {
    for (const [, module] of text.matchAll(/^[ \t]*from[ \t]+([A-Za-z_]\w*)[\w.]*[ \t]+import\b/gm)) local(`${module}.py`);
    for (const [, list] of text.matchAll(/^[ \t]*import[ \t]+([^\n#;]+)/gm))
      for (const item of list.split(",")) local(`${item.trim().split(/[ \t.]/)[0]}.py`);
  } else {
    for (const [, target] of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g)) local(posix.join(posix.dirname(file), target));
  }
  for (const [, , name] of text.matchAll(/(["'`])([\w][\w./ -]*)\1/g)) {
    if (!RUNTIME_FILE.test(name)) continue;
    local(name);
    local(posix.join(posix.dirname(file), name));
  }
  return [...found];
}

/** Every "file needs other" where `other` is not in the package, over the code that is. */
function missingFromPackage(files, read, isFile) {
  const shipped = new Set(files);
  return files.filter((file) => CODE.test(file))
    .flatMap((file) => needs(file, read(file), isFile).filter((other) => !shipped.has(other)).map((other) => `${file} needs ${other}`));
}

const readSource = (file) => readFileSync(join(sourceDir, file), "utf8");
const isSourceFile = (file) => { try { return statSync(join(sourceDir, file)).isFile(); } catch { return false; } };

test("every module and data file the shipped code imports or names ships with it", () => {
  const manifest = readManifest(sourceDir);
  assert.deepEqual(missingFromPackage(manifest, readSource, isSourceFile), []);
  // The scan sees the pet game: these are found as needs of the widget and the server, not assumed.
  const widget = new Set();
  for (let pending = ["desktop_widget.py"]; pending.length;) {
    const file = pending.pop();
    if (widget.has(file)) continue;
    widget.add(file);
    pending.push(...needs(file, readSource(file), isSourceFile).filter((other) => other.endsWith(".py")));
  }
  for (const module of ["pet_field.py", "pet_field_canvas.py", "pet_world.py", "pet_behaviors.py", "pet_battle.py", "pet_art.py", "pet_boss.py", "pet_boss_ogre.py",
    "pet_platform.py", "desktop_windows.py", "goblin_look.py", "pets_feed.py", "pets_text.py"]) assert.ok(widget.has(module), `${module} is reached from desktop_widget.py`);
  const viewer = needs("server.mjs", readSource("server.mjs"), isSourceFile);
  for (const file of ["game_config.json", "lib/t3-source.mjs", "lib/pets-store.mjs", "lib/pets-service.mjs", "lib/pets-routes.mjs", "lib/reward-engine.mjs", "lib/rewards.mjs",
    "lib/pets-lock.mjs", "lib/pets-remote.mjs", "lib/shared.mjs"])
    assert.ok(viewer.includes(file), `${file} is needed by server.mjs`);
  // The shared game's commands and its Tailscale helpers are reached from the manager and the listener.
  assert.ok(needs("goblin.mjs", readSource("goblin.mjs"), isSourceFile).includes("lib/shared-manager.mjs"));
  assert.ok(needs("lib/shared.mjs", readSource("lib/shared.mjs"), isSourceFile).includes("lib/tailscale.mjs"));
});

test("every Node module that ships is reached from the manager, the server, or the packager, and nothing else lies in lib", () => {
  const manifest = readManifest(sourceDir);
  const reached = new Set();
  for (let pending = ["goblin.mjs", "server.mjs", "scripts/package.mjs"]; pending.length;) {
    const file = pending.pop();
    if (reached.has(file)) continue;
    reached.add(file);
    pending.push(...needs(file, readSource(file), isSourceFile).filter((other) => other.endsWith(".mjs")));
  }
  assert.deepEqual(manifest.filter((file) => file.endsWith(".mjs") && !reached.has(file)), [], "no module ships that nothing runs");
  assert.deepEqual(readdirSync(join(sourceDir, "lib")).filter((name) => !manifest.includes(`lib/${name}`)), [], "and every module in lib ships");
});

test("a module or data file left out of package-files.json is named by the check", () => {
  const manifest = readManifest(sourceDir);
  const without = (...gone) => missingFromPackage(manifest.filter((file) => !gone.includes(file)), readSource, isSourceFile);
  assert.deepEqual(without("pet_boss_ogre.py"), ["pet_boss.py needs pet_boss_ogre.py"]);
  assert.ok(without("goblin_look.py").includes("pet_field.py needs goblin_look.py"));
  assert.ok(without("desktop_windows.py").includes("pet_field.py needs desktop_windows.py"));
  assert.deepEqual(without("game_config.json"), ["server.mjs needs game_config.json"]);
  assert.ok(without("lib/t3-source.mjs").includes("server.mjs needs lib/t3-source.mjs"));
  // Every way Python spells an import, and nothing from the standard library.
  const tree = new Set(["a.py", "pet_one.py", "pet_two.py", "pet_three.py", "pet_four.py", "art.json"]);
  const source = ["import json, pet_one", "from pet_two import Thing", "    import pet_three as three  # inside a function", "from pet_four.part import x",
    "import os.path", "DATA = \"art.json\""].join("\n");
  assert.deepEqual(needs("a.py", source, (file) => tree.has(file)).sort(), ["art.json", "pet_four.py", "pet_one.py", "pet_three.py", "pet_two.py"]);
});

test("every link in a shipped document to another file points at a file that ships too", () => {
  const manifest = readManifest(sourceDir);
  for (const doc of manifest.filter((file) => file.endsWith(".md"))) {
    const text = readFileSync(join(sourceDir, doc), "utf8");
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(?:[a-z]+:|#)/i.test(target)) continue; // Web links and anchors.
      const file = join(dirname(doc), target.split("#")[0]).replace(/\\/g, "/");
      assert.ok(manifest.includes(file), `${doc} links to ${target}, which is not in the package`);
    }
  }
});

test("the README's status line names the release package.json ships", () => {
  const { version } = JSON.parse(readFileSync(join(sourceDir, "package.json"), "utf8"));
  const [major, minor] = version.split(".");
  const readme = readFileSync(join(sourceDir, "README.md"), "utf8");
  assert.match(readme, new RegExp(String.raw`\*\*Status: early \(${major}\.${minor}\)\.\*\*`));
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
