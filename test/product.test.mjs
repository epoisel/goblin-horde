/**
 * Installer and everyday-use behaviour: shortcuts that belong to this installation, Node moving after an
 * upgrade, the documented install command, the double-click installers, and the server's own routes. Every
 * folder is temporary; shortcuts go to a temporary APPDATA.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MARKER, install, makeContext, readManifest, status } from "../lib/manager.mjs";
import { ownsShortcut, shortcutSpec, writeShortcut } from "../lib/shortcuts.mjs";
import { main, parseArgs } from "../goblin.mjs";
import { PACKAGE_NAME } from "../scripts/package.mjs";
import { ask, freePort } from "./helpers/viewer.mjs";

const sourceDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "goblin-product-"));
  const home = join(root, "home");
  const claudeDir = join(home, "claude-config");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, "settings.json"), "{}\n");
  const env = { PATH: process.env.PATH, Path: process.env.Path, PATHEXT: process.env.PATHEXT, SystemRoot: process.env.SystemRoot,
    LOCALAPPDATA: join(root, "local"), APPDATA: join(root, "roaming"), CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: join(home, "codex-home"), GOBLIN_SHARED_LOOPBACK: "45123" };
  const lines = [];
  const written = [];
  // A stand-in for the Windows shortcut writer: a file that names its target, as a real .lnk does.
  const fakeWriter = (link, spec) => {
    written.push({ link, spec });
    mkdirSync(dirname(link), { recursive: true });
    writeFileSync(link, Buffer.from(`${spec.target} ${spec.args}`, "utf16le"));
  };
  const ctx = makeContext({ env, home, sourceDir, log: (line) => lines.push(line), listProcesses: () => [], writeShortcut: fakeWriter });
  const flags = { installDir: join(root, "app"), stateDir: join(root, "state"), port: 43993, noStart: true, skipSkill: true };
  const programs = join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs");
  const argv = ["--install-dir", flags.installDir, "--state-dir", flags.stateDir, "--port", "43993", "--no-start", "--skip-skill"];
  return { root, claudeDir, env, ctx, flags, argv, lines, written, menu: join(programs, "Goblin Horde.lnk"),
    startup: join(programs, "Startup", "Goblin Horde.lnk"), marker: () => JSON.parse(readFileSync(join(flags.installDir, MARKER), "utf8")),
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("real shortcuts are recognised whether their arguments start on an even or an odd byte", () => {
  const root = mkdtempSync(join(tmpdir(), "goblin-lnk-"));
  try {
    const installDir = join(root, "app");
    const alignments = new Set();
    // The target's path length shifts everything after it in the .lnk, so these cover both alignments.
    for (let length = 1; length <= 4; length++) {
      const node = join(root, "n".repeat(length), "node.exe");
      mkdirSync(dirname(node), { recursive: true });
      writeFileSync(node, "");
      const link = join(root, `link${length}.lnk`);
      writeShortcut(link, shortcutSpec({ nodePath: node, installDir }));
      const bytes = readFileSync(link);
      const even = Buffer.from(bytes.subarray(0, bytes.length & ~1)).toString("utf16le").toLowerCase()
        .includes(join(installDir, "goblin.mjs").toLowerCase());
      alignments.add(even ? "even" : "odd");
      assert.equal(ownsShortcut(link, installDir), true, `link${length}`);
      assert.equal(ownsShortcut(link, join(root, "other-app")), false, `link${length} is not another copy's`);
    }
    assert.deepEqual([...alignments].sort(), ["even", "odd"], "both alignments were exercised");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("install leaves another copy's Start menu entry alone and says how to start this one", async () => {
  const box = sandbox();
  try {
    const other = join(box.root, "other-copy");
    box.ctx.writeShortcut(box.menu, shortcutSpec({ nodePath: process.execPath, installDir: other }));
    box.written.length = 0;
    const result = await install(box.ctx, box.flags);
    assert.ok(ownsShortcut(box.menu, other), "still the other copy's");
    assert.equal(box.written.some((item) => item.link === box.menu), false);
    assert.equal(result.startMenu, false, "install does not point at a Start menu entry that opens another copy");
    assert.ok(result.messages.some((line) => /opens another Goblin Horde copy, so it was left as it is.*goblin\.mjs" --install-dir "[^"]+" start/.test(line)),
      result.messages.join("\n"));
    // This copy's own entry is still refreshed on the next install.
    rmSync(box.menu);
    assert.equal((await install(box.ctx, box.flags)).startMenu, true);
  } finally { box.cleanup(); }
});

test("manage.ps1 passes its action to the manager", { timeout: 60_000 }, async () => {
  const box = sandbox();
  // Something else holds the port, so an accepted start stops there, before anything is started.
  const blocker = createServer((socket) => socket.destroy());
  await new Promise((resolvePromise) => blocker.listen(0, "127.0.0.1", resolvePromise));
  try {
    await install(box.ctx, box.flags);
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(sourceDir, "manage.ps1"),
      "-Action", "Start", "-InstallRoot", box.flags.installDir, "-Port", String(blocker.address().port)],
    { env: { ...process.env, ...box.env }, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let said = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { said += chunk; });
    const code = await new Promise((resolvePromise) => child.on("close", resolvePromise));
    assert.equal(code, 3, said);
    assert.match(said, /already used by another program/);
  } finally {
    blocker.close();
    box.cleanup();
  }
});

const AGENT_DOCS = ["AGENTS.md", "docs/SETUP-PROMPT.md", "skills/goblin-horde-manager/SKILL.md"];
const readDoc = (file) => readFileSync(join(sourceDir, file), "utf8");

test("the install command the documents give installs without touching Claude Code or starting at sign-in", async () => {
  const documented = (file) => readDoc(file).match(/node goblin\.mjs (install[^\n`]*)/)?.[1].trim();
  const command = documented("docs/SETUP-PROMPT.md");
  assert.ok(command, "the setup prompt gives the install command");
  for (const file of ["AGENTS.md", "README.md"]) assert.equal(documented(file), command, `${file} gives the same command`);
  const box = sandbox();
  try {
    assert.equal(await main([...command.split(" "), ...box.argv], box.ctx), 0);
    assert.equal(readFileSync(join(box.claudeDir, "settings.json"), "utf8"), "{}\n", "Claude Code's settings are untouched");
    assert.equal(existsSync(box.startup), false, "nothing starts at sign-in");
    assert.equal(existsSync(box.menu), true);
  } finally { box.cleanup(); }
});

test("the agent documents name only options the manager has, in plain punctuation", () => {
  let named = 0;
  for (const file of AGENT_DOCS) {
    const options = new Set(readDoc(file).match(/--[a-z][a-z-]*/g));
    named += options.size;
    for (const option of options) assert.doesNotThrow(() => parseArgs(["doctor", option, "value"]), `${file} names ${option}`);
  }
  assert.ok(named > 0, "the documents' options were read");
  for (const file of ["AGENTS.md", "docs/SETUP-PROMPT.md"]) assert.doesNotMatch(readDoc(file), /[–—]/, `${file} has a long dash`);
});

test("the setup prompt is one block of at most 15 lines that says where the package is and what to run", () => {
  const blocks = [...readDoc("docs/SETUP-PROMPT.md").matchAll(/```\r?\n([\s\S]*?)\r?\n```/g)].map((match) => match[1]);
  assert.equal(blocks.length, 1);
  const lines = blocks[0].split(/\r?\n/);
  assert.ok(lines.length <= 15, `${lines.length} lines`);
  for (const needed of ["https://github.com/epoisel/goblin-horde", "goblin-pets", PACKAGE_NAME, "AGENTS.md", "node goblin.mjs doctor"])
    assert.ok(blocks[0].includes(needed), needed);
  assert.ok(readManifest(sourceDir).includes("docs/SETUP-PROMPT.md"), "the prompt ships in the package");
});

test("after Node moves, status rewrites this installation's Start menu entry and records the new Node", async () => {
  const box = sandbox();
  try {
    await install(box.ctx, box.flags);
    const gone = join(box.root, "nvm", "v20.0.0", "node.exe");
    writeFileSync(join(box.flags.installDir, MARKER), JSON.stringify({ ...box.marker(), nodePath: gone }));
    box.ctx.writeShortcut(box.menu, shortcutSpec({ nodePath: gone, installDir: box.flags.installDir }));
    box.written.length = 0;
    const report = await status(box.ctx, box.flags);
    // The entry runs the install folder's launcher, which finds whichever Node.js is on PATH.
    assert.deepEqual(box.written.map((item) => [item.link, item.spec.target]), [[box.menu, join(box.flags.installDir, "launch.cmd")]]);
    assert.equal(box.marker().nodePath, process.execPath);
    assert.ok(report.notes.some((line) => /updated the Start menu entry/.test(line)));
    box.written.length = 0;
    await status(box.ctx, box.flags);
    assert.equal(box.written.length, 0, "nothing to do once they match");
  } finally { box.cleanup(); }
});

test("the installer refuses to run from inside the ZIP and installs or starts, and the uninstaller asks first; both ship with CRLF line endings", () => {
  for (const file of ["Install Goblin Horde.cmd", "Uninstall Goblin Horde.cmd", "launch.cmd"]) assert.ok(readManifest(sourceDir).includes(file), file);
  const installer = readFileSync(join(sourceDir, "Install Goblin Horde.cmd"), "utf8");
  assert.match(installer, /if not exist "%~dp0goblin\.mjs" goto :not_extracted/);
  assert.match(installer, /Right-click the ZIP, choose Extract All, then run Install Goblin Horde\.cmd from the extracted folder\./);
  assert.match(installer, /if exist "%~dp0goblin-horde-install\.json" \(\r\n\s+node goblin\.mjs start\r\n\) else \(\r\n\s+node goblin\.mjs install\r\n\)/,
    "in the installed app folder it starts the game; anywhere else it installs");
  const uninstaller = readFileSync(join(sourceDir, "Uninstall Goblin Horde.cmd"), "utf8");
  assert.match(uninstaller, /choice \/c YN/);
  assert.match(uninstaller, /%GH_MANAGER%" uninstall/);
  for (const text of [installer, uninstaller]) {
    assert.equal(text.replace(/\r\n/g, "").includes("\n"), false, "CRLF only");
    for (const [, command] of text.matchAll(/node (?:goblin\.mjs|"%GH_MANAGER%") ([a-z-]+)/g)) assert.ok(["start", "install", "uninstall"].includes(command), command);
  }
});

test("the server answers the game's routes only, and POST /api/quit stops it, from this computer's own page only", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "goblin-quit-"));
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), GOBLIN_HORDE_STATE_DIR: join(root, "state"), LOCALAPPDATA: join(root, "local"),
    USERPROFILE: join(root, "home"), HOME: join(root, "home"), GOBLIN_T3_DB: join(root, "no-t3.sqlite") };
  const child = spawn(process.execPath, [join(sourceDir, "server.mjs")], { env, stdio: "ignore", windowsHide: true });
  const exited = new Promise((resolvePromise) => child.once("exit", (code) => resolvePromise(code)));
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let tries = 0; ; tries++) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* Not up yet. */ }
      if (tries > 100) throw new Error("The server did not start.");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.deepEqual([health.product, health.pid], ["GoblinHorde", child.pid]);
    assert.equal((await (await fetch(`${base}/api/shared`)).json()).shared.enabled, false);
    assert.equal((await fetch(`${base}/api/pets`)).status, 200);
    for (const path of ["/", "/index.html", "/api/scene", "/api/threads", "/api/capabilities", "/api/config", "/api/mobile", "/api/diagnostics", "/pair.html", "/goblin_art.json"])
      assert.equal((await fetch(`${base}${path}`)).status, 404, path);
    const own = { "Content-Type": "application/json", Origin: base };
    for (const path of ["/api/phone", "/api/phone/reset", "/api/reply", "/api/respond", "/api/connect-claude", "/api/autostart", "/api/dismiss", "/api/pair"])
      assert.equal((await fetch(`${base}${path}`, { method: "POST", headers: own, body: "{}" })).status, 405, path);
    assert.equal((await ask(port, "GET", "/api/health", { headers: { Host: `evil.example:${port}` } })).status, 403, "only this computer's own name for itself");

    const refused = await fetch(`${base}/api/quit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(refused.status, 403, "without its own page's Origin, quitting is refused");
    assert.equal((await fetch(`${base}/api/health`)).ok, true);
    const quit = await fetch(`${base}/api/quit`, { method: "POST", headers: own, body: "{}" });
    assert.deepEqual(await quit.json(), { quitting: true });
    assert.equal(await Promise.race([exited, new Promise((resolvePromise) => setTimeout(() => resolvePromise("still running"), 10_000))]), 0);
  } finally {
    if (child.exitCode === null) child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});
