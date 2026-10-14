/**
 * Installer and everyday-use behaviour: shortcuts that belong to this installation, setup answers
 * that keep what the person chose, Node moving after an upgrade, plain Orca warnings, and quitting
 * the viewer from the widget. Every folder is temporary; shortcuts go to a temporary APPDATA.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MARKER, autostart, install, makeContext, readManifest, start, status } from "../lib/manager.mjs";
import { ownsShortcut, setSignInStart, shortcutSpec, writeShortcut } from "../lib/shortcuts.mjs";
import { OrcaReader } from "../lib/orca.mjs";
import { finishLine, main } from "../goblin.mjs";

const sourceDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const windowsOnly = { skip: process.platform !== "win32" && "Windows shortcuts" };

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "goblin-product-"));
  const home = join(root, "home");
  const claudeDir = join(home, "claude-config");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, "settings.json"), "{}\n");
  const env = { PATH: process.env.PATH, Path: process.env.Path, PATHEXT: process.env.PATHEXT, SystemRoot: process.env.SystemRoot,
    LOCALAPPDATA: join(root, "local"), APPDATA: join(root, "roaming"), CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: join(home, "codex-home") };
  const lines = [];
  const written = [];
  // A stand-in for the Windows shortcut writer: a file that names its target, as a real .lnk does.
  const fakeWriter = (link, spec) => {
    written.push({ link, spec });
    mkdirSync(dirname(link), { recursive: true });
    writeFileSync(link, Buffer.from(`${spec.target} ${spec.args}`, "utf16le"));
  };
  const ctx = makeContext({ env, home, sourceDir, log: (line) => lines.push(line), listProcesses: () => [], openUrl: () => {}, writeShortcut: fakeWriter });
  const flags = { installDir: join(root, "app"), stateDir: join(root, "state"), port: 43993, noStart: true, skipSkill: true };
  const programs = join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs");
  const argv = ["--install-dir", flags.installDir, "--state-dir", flags.stateDir, "--port", "43993", "--no-start", "--skip-skill"];
  return { root, claudeDir, env, ctx, flags, argv, lines, written, menu: join(programs, "Goblin Horde.lnk"),
    startup: join(programs, "Startup", "Goblin Horde.lnk"), marker: () => JSON.parse(readFileSync(join(flags.installDir, MARKER), "utf8")),
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("real shortcuts are recognised whether their arguments start on an even or an odd byte", windowsOnly, () => {
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

test("the window's Start with Windows starts the strip and never takes over another copy's shortcut", () => {
  const link = "C:\\Users\\dev\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Goblin Horde.lnk";
  const installDir = "C:\\Users\\dev\\AppData\\Local\\Programs\\GoblinHorde";
  const run = ({ enable, present = false, ours = false }) => {
    const calls = [];
    const result = setSignInStart({ enable, link, installDir, nodePath: "C:\\node\\node.exe", exists: () => present, owns: () => ours,
      write: (path, spec) => calls.push(["write", path, spec.args]), remove: (path) => calls.push(["remove", path]) });
    return { result, calls };
  };
  const on = run({ enable: true });
  assert.deepEqual(on.result, { status: 200 });
  assert.equal(on.calls.length, 1);
  assert.match(on.calls[0][2], /start --install-dir ".+GoblinHorde" --surface strip$/, "signing in starts the strip only");
  assert.match(run({ enable: true, present: true, ours: true }).calls[0][2], /--surface strip$/, "this copy's own shortcut is rewritten");
  const taken = run({ enable: true, present: true, ours: false });
  assert.equal(taken.result.status, 409);
  assert.match(taken.result.error, /Another Goblin Horde copy .* autostart on/);
  assert.deepEqual(taken.calls, [], "another copy's shortcut is not replaced");
  assert.deepEqual(run({ enable: false, present: true, ours: false }).calls, []);
  assert.equal(run({ enable: false, present: true, ours: false }).result.status, 409);
  assert.deepEqual(run({ enable: false, present: true, ours: true }).calls, [["remove", link]]);
});

test("autostart off and install leave another copy's sign-in shortcut alone", windowsOnly, async () => {
  const box = sandbox();
  try {
    await install(box.ctx, box.flags);
    box.ctx.writeShortcut(box.startup, shortcutSpec({ nodePath: process.execPath, installDir: join(box.root, "other-copy") }));
    assert.equal(autostart(box.ctx, box.flags).enabled, false, "another copy's shortcut is not this one's");
    assert.match(autostart(box.ctx, box.flags, false).message, /another Goblin Horde copy/);
    assert.equal(existsSync(box.startup), true);
    await install(box.ctx, { ...box.flags, autostart: false });
    assert.equal(existsSync(box.startup), true);
    assert.ok(ownsShortcut(box.startup, join(box.root, "other-copy")));
  } finally { box.cleanup(); }
});

test("signing in starts the goblin strip; the Start menu entry opens the window", windowsOnly, async () => {
  const box = sandbox();
  try {
    await install(box.ctx, { ...box.flags, autostart: true });
    const args = (link) => box.written.filter((item) => item.link === link).at(-1).spec.args;
    assert.doesNotMatch(args(box.menu), /--surface/);
    assert.match(args(box.startup), /" start --install-dir ".*" --surface strip$/);
    box.written.length = 0;
    assert.equal(autostart(box.ctx, box.flags, true).enabled, true);
    assert.match(args(box.startup), /--surface strip$/);
  } finally { box.cleanup(); }
});

test("install leaves another copy's Start menu entry alone and says how to start this one", windowsOnly, async () => {
  const box = sandbox();
  try {
    const other = join(box.root, "other-copy");
    box.ctx.writeShortcut(box.menu, shortcutSpec({ nodePath: process.execPath, installDir: other }));
    box.written.length = 0;
    const result = await install(box.ctx, box.flags);
    assert.ok(ownsShortcut(box.menu, other), "still the other copy's");
    assert.equal(box.written.some((item) => item.link === box.menu), false);
    assert.equal(result.startMenu, false, "setup does not point at a Start menu entry that opens another copy");
    assert.ok(result.messages.some((line) => /opens another Goblin Horde copy, so it was left as it is.*goblin\.mjs" --install-dir "[^"]+" start/.test(line)),
      result.messages.join("\n"));
    // This copy's own entry is still refreshed on the next install.
    rmSync(box.menu);
    assert.equal((await install(box.ctx, box.flags)).startMenu, true);
  } finally { box.cleanup(); }
});

test("start brings a running widget's window forward, but the sign-in start leaves it as it is", async () => {
  const box = sandbox();
  try {
    await install(box.ctx, box.flags);
    const { installDir, stateDir } = box.flags;
    const running = [
      { pid: 990001, argv: ["pythonw.exe", join(installDir, "desktop_widget.py"), "--port", "43993"], command: "", started: "1" },
      { pid: 990002, argv: ["node.exe", join(installDir, "server.mjs")], command: "", started: "1" },
    ];
    const ctx = { ...box.ctx, listProcesses: () => running };
    const request = join(stateDir, "run", "show-widget");
    const signIn = await start(ctx, { ...box.flags, surface: "strip" });
    assert.equal(signIn.ui, "widget");
    assert.equal(existsSync(request), false, "signing in does not pop the window open");
    await start(ctx, box.flags);
    assert.equal(existsSync(request), true, "the Start menu or `start` opens the window");
    await assert.rejects(start(ctx, { ...box.flags, surface: "corner" }), /--surface must be window or strip/);
  } finally { box.cleanup(); }
});

test("setup --yes --no-claude-hooks never connects Claude Code", async () => {
  const box = sandbox();
  try {
    assert.equal(await main(["setup", "--yes", "--no-claude-hooks", ...box.argv], box.ctx), 0);
    assert.deepEqual(JSON.parse(readFileSync(join(box.claudeDir, "settings.json"), "utf8")), {}, "Claude Code's settings are untouched");
    assert.equal(box.marker().claudeHooks.installed, false);
    assert.equal(box.marker().claudeHooks.declined, true, "the no is remembered");
    // An explicit yes connects it, and a later explicit no takes this copy's hooks out again.
    assert.equal(await main(["setup", "--yes", "--claude-hooks", ...box.argv], box.ctx), 0);
    assert.equal(box.marker().claudeHooks.installed, true);
    assert.equal(await main(["setup", "--yes", "--no-claude-hooks", ...box.argv], box.ctx), 0);
    assert.deepEqual(JSON.parse(readFileSync(join(box.claudeDir, "settings.json"), "utf8")), {});
  } finally { box.cleanup(); }
});

test("setup --yes keeps sign-in start on and a declined Claude Code connection declined", async () => {
  const box = sandbox();
  try {
    await install(box.ctx, { ...box.flags, claudeHooks: false, autostart: process.platform === "win32" ? true : undefined });
    assert.equal(box.marker().claudeHooks.declined, true, "the no is remembered");
    assert.equal(await main(["setup", "--yes", ...box.argv], box.ctx), 0);
    assert.deepEqual(JSON.parse(readFileSync(join(box.claudeDir, "settings.json"), "utf8")), {}, "Claude Code stays disconnected");
    assert.equal(box.marker().claudeHooks.declined, true);
    assert.ok(box.lines.some((line) => /chose not to connect it before/.test(line)));
    if (process.platform === "win32") assert.equal(existsSync(box.startup), true, "sign-in start stays on");
  } finally { box.cleanup(); }
});

test("a first setup --yes connects Claude Code and does not start at sign-in", async () => {
  const box = sandbox();
  try {
    assert.equal(await main(["setup", "--yes", ...box.argv], box.ctx), 0);
    assert.equal(box.marker().claudeHooks.installed, true);
    assert.equal(box.marker().claudeHooks.declined, false);
    assert.equal(existsSync(box.startup), false);
    assert.ok(box.lines.some((line) => line.includes(join(box.claudeDir, "settings.json"))), "setup names the real settings file");
  } finally { box.cleanup(); }
});

test("setup's last line says where the goblins are", () => {
  assert.match(finishLine({ startMenu: true, started: { ui: "widget" } }), /on the desktop; find Goblin Horde in the Start menu/);
  const browser = finishLine({ startMenu: true, started: { ui: "browser", reason: "Python with Tkinter was not found." } });
  assert.match(browser, /opened in your browser instead of on the desktop: Python with Tkinter was not found\./);
  assert.doesNotMatch(browser, /on the desktop;/);
  assert.match(finishLine({ startMenu: false, started: null }), /node goblin\.mjs start/);
});

test("after Node moves, status rewrites this installation's shortcuts and records the new Node", windowsOnly, async () => {
  const box = sandbox();
  try {
    await install(box.ctx, { ...box.flags, autostart: true });
    const gone = join(box.root, "nvm", "v20.0.0", "node.exe");
    writeFileSync(join(box.flags.installDir, MARKER), JSON.stringify({ ...box.marker(), nodePath: gone }));
    for (const link of [box.menu, box.startup]) box.ctx.writeShortcut(link, shortcutSpec({ nodePath: gone, installDir: box.flags.installDir }));
    box.written.length = 0;
    const report = await status(box.ctx, box.flags);
    // The shortcuts run the install folder's launcher, which finds whichever Node.js is on PATH.
    const launcher = join(box.flags.installDir, "launch.cmd");
    assert.deepEqual(box.written.map((item) => [item.link, item.spec.target]), [[box.menu, launcher], [box.startup, launcher]]);
    assert.equal(box.marker().nodePath, process.execPath);
    assert.ok(report.notes.some((line) => /updated the Start menu entry/.test(line)));
    box.written.length = 0;
    await status(box.ctx, box.flags);
    assert.equal(box.written.length, 0, "nothing to do once they match");
  } finally { box.cleanup(); }
});

test("install repairs Claude Code hooks that name a Node that is gone, even when connected from the widget", async () => {
  const box = sandbox();
  try {
    await install(box.ctx, { ...box.flags, claudeHooks: true });
    const settingsFile = join(box.claudeDir, "settings.json");
    const gone = join(box.root, "volta", "node.exe");
    const quoted = (path) => JSON.stringify(path).slice(1, -1);
    writeFileSync(settingsFile, readFileSync(settingsFile, "utf8").replaceAll(quoted(process.execPath), quoted(gone)));
    // As if connected from the widget: the marker does not know about the hooks.
    writeFileSync(join(box.flags.installDir, MARKER), JSON.stringify({ ...box.marker(), claudeHooks: { installed: false } }));
    const result = await install(box.ctx, box.flags);
    assert.ok(result.messages.some((line) => /Updated the Claude Code hooks/.test(line)), result.messages.join("\n"));
    const settings = readFileSync(settingsFile, "utf8");
    assert.ok(settings.includes(quoted(process.execPath)));
    assert.ok(!settings.includes(quoted(gone)));
  } finally { box.cleanup(); }
});

test("Orca warnings are plain words, not the command that failed", async () => {
  const closed = new OrcaReader({ ttlMs: 0, run: async () => { throw Object.assign(new Error("Command failed: orca worktree ps --json\nconnect ECONNREFUSED"), { code: 1 }); } });
  const warning = (await closed.snapshot()).warning;
  assert.equal(warning, "Orca feed is unavailable: Orca is not running.");
  const garbled = new OrcaReader({ ttlMs: 0, run: async () => ({ stdout: "not json" }) });
  assert.equal((await garbled.snapshot()).warning, "Orca feed is unavailable: Orca could not be read.");
});

test("the installer refuses to run from inside the ZIP, and an uninstaller ships with CRLF line endings", () => {
  assert.ok(readManifest(sourceDir).includes("Uninstall Goblin Horde.cmd"));
  const installer = readFileSync(join(sourceDir, "Install Goblin Horde.cmd"), "utf8");
  assert.match(installer, /if not exist "%~dp0goblin\.mjs" goto :not_extracted/);
  assert.match(installer, /Right-click the ZIP, choose Extract All, then run Install Goblin Horde\.cmd from the extracted folder\./);
  const uninstaller = readFileSync(join(sourceDir, "Uninstall Goblin Horde.cmd"), "utf8");
  assert.match(uninstaller, /choice \/c YN/);
  assert.match(uninstaller, /goblin\.mjs" uninstall|%GH_MANAGER%" uninstall/);
  for (const text of [installer, uninstaller]) assert.equal(text.replace(/\r\n/g, "").includes("\n"), false, "CRLF only");
});

async function freePort() {
  const probe = createServer(() => {});
  await new Promise((resolvePromise) => probe.listen(0, "127.0.0.1", resolvePromise));
  const { port } = probe.address();
  await new Promise((resolvePromise) => probe.close(resolvePromise));
  return port;
}

test("POST /api/quit stops the viewer, only from this computer's own page", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "goblin-quit-"));
  const port = await freePort();
  // No Codex, no Orca, and every folder temporary. The Wi-Fi address is one this computer does not
  // have, so no phone listener opens on a real network.
  const env = { ...process.env, PORT: String(port), GOBLIN_HORDE_STATE_DIR: join(root, "state"), LOCALAPPDATA: join(root, "local"),
    CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_HOME: join(root, "codex"), CODEX_CLI_PATH: join(root, "no-codex.exe"),
    ORCA_CLI_COMMAND: join(root, "no-orca"), LAN_IP: "10.255.255.254" };
  const child = spawn(process.execPath, [join(sourceDir, "server.mjs")], { env, stdio: "ignore", windowsHide: true });
  const exited = new Promise((resolvePromise) => child.once("exit", (code) => resolvePromise(code)));
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let tries = 0; ; tries++) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* Not up yet. */ }
      if (tries > 100) throw new Error("The viewer did not start.");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    const refused = await fetch(`${base}/api/quit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(refused.status, 403, "without its own page's Origin, quitting is refused");
    assert.equal((await fetch(`${base}/api/health`)).ok, true);
    const quit = await fetch(`${base}/api/quit`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: "{}" });
    assert.deepEqual(await quit.json(), { quitting: true });
    assert.equal(await Promise.race([exited, new Promise((resolvePromise) => setTimeout(() => resolvePromise("still running"), 10_000))]), 0);
  } finally {
    if (child.exitCode === null) child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});
