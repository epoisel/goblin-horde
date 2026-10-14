/**
 * Install and uninstall in throwaway folders. Every path (app, state, Claude config, Codex home,
 * home) points into a temporary directory; nothing here reads or writes this computer's real
 * settings, and no viewer is started.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOOK_EVENTS, HOOK_MARKER, claudeHookReport, claudeSettingsPath, installClaudeHooks, markHooksConnected } from "../lib/claude-hooks.mjs";
import { claudeActivityDir } from "../lib/claude.mjs";
import { DismissStore } from "../lib/dismiss.mjs";
import { LinkStore } from "../lib/links.mjs";
import { CODE_FILE, PHONE_FILE } from "../lib/phone.mjs";
import { claudeConfigDir } from "../lib/paths.mjs";
import { WatchList } from "../lib/watch.mjs";
import { MARKER, SKILL_MARKER, autostart, childEnv, install, locate, makeContext, readManifest, start, stateFiles, status, stop, uninstall, versionBefore } from "../lib/manager.mjs";
import { isAlive, listProcesses, stopPid } from "../lib/processes.mjs";
import { main, parseArgs } from "../goblin.mjs";

const sourceDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const userSettings = {
  model: "sonnet",
  permissions: { allow: ["Read"] },
  hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "prettier --write" }] }] },
};

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "goblin-manager-"));
  const home = join(root, "home");
  const claudeDir = join(home, "claude-config");
  const codexDir = join(home, "codex-home");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(join(claudeDir, "settings.json"), JSON.stringify(userSettings, null, 2));
  // A minimal environment: PATH for Node itself, and every Goblin Horde location pointed at the sandbox.
  const env = { PATH: process.env.PATH, Path: process.env.Path, PATHEXT: process.env.PATHEXT, SystemRoot: process.env.SystemRoot,
    LOCALAPPDATA: join(root, "local"), CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir };
  const lines = [];
  const opened = [];
  const ctx = makeContext({ env, home, sourceDir, log: (line) => lines.push(line), listProcesses: () => [], openUrl: (url) => opened.push(url) });
  const flags = { installDir: join(root, "app"), stateDir: join(root, "state"), noStart: true };
  return { root, home, claudeDir, codexDir, env, ctx, flags, lines, opened, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const settingsOf = (box) => JSON.parse(readFileSync(join(box.claudeDir, "settings.json"), "utf8"));

test("install copies exactly the manifest, writes skills, and merges Claude hooks without disturbing settings", async () => {
  const box = sandbox();
  try {
    const result = await install(box.ctx, { ...box.flags, claudeHooks: true });
    const manifest = readManifest(sourceDir);
    for (const file of manifest) assert.ok(existsSync(join(box.flags.installDir, ...file.split("/"))), file);
    assert.equal(existsSync(join(box.flags.installDir, "test")), false, "tests are not installed");
    const marker = JSON.parse(readFileSync(join(box.flags.installDir, MARKER), "utf8"));
    assert.equal(marker.product, "GoblinHorde");
    assert.deepEqual(marker.files, manifest);
    assert.equal(marker.claudeHooks.installed, true);
    assert.equal(marker.stateDir, box.flags.stateDir);

    for (const dir of [join(box.codexDir, "skills", "goblin-horde-manager"), join(box.claudeDir, "skills", "goblin-horde-manager")]) {
      const skill = readFileSync(join(dir, "SKILL.md"), "utf8");
      assert.ok(skill.includes(join(box.flags.installDir, "goblin.mjs")), "the skill names this installation's manager");
      assert.doesNotMatch(skill, /\{\{/);
      assert.ok(existsSync(join(dir, SKILL_MARKER)));
    }

    const settings = settingsOf(box);
    assert.equal(settings.model, "sonnet");
    assert.deepEqual(settings.permissions, userSettings.permissions);
    assert.deepEqual(settings.hooks.PostToolUse[0], userSettings.hooks.PostToolUse[0]);
    for (const { event } of HOOK_EVENTS) {
      const ours = settings.hooks[event].flatMap((group) => group.hooks).filter((item) => item.args?.includes(HOOK_MARKER));
      assert.equal(ours.length, 1, event);
      assert.equal(ours[0].command, process.execPath);
      assert.equal(ours[0].args[0], join(box.flags.installDir, "claude-hook.mjs"));
      assert.deepEqual(ours[0].args.slice(-2), ["--state-dir", box.flags.stateDir]);
    }
    assert.ok(result.messages.some((line) => /Connected Claude Code/.test(line)));

    // Installing again changes nothing about the hooks.
    await install(box.ctx, { ...box.flags });
    assert.deepEqual(settingsOf(box), settings);
  } finally { box.cleanup(); }
});

test("updating removes files an older version listed, but never a listed path that climbs out of the app", async () => {
  const box = sandbox();
  try {
    await install(box.ctx, box.flags);
    const markerPath = join(box.flags.installDir, MARKER);
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    writeFileSync(join(box.flags.installDir, "retired.txt"), "old");
    const victim = join(box.root, "victim.txt");
    writeFileSync(victim, "not ours");
    // A tampered or corrupted marker: both slash styles, which Windows treats alike.
    writeFileSync(markerPath, JSON.stringify({ ...marker, files: [...marker.files, "retired.txt", "..\\victim.txt", "../victim.txt", "sub/..\\..\\victim.txt"] }));
    await install(box.ctx, box.flags);
    assert.equal(existsSync(join(box.flags.installDir, "retired.txt")), false, "a file the new version dropped is removed");
    assert.equal(readFileSync(victim, "utf8"), "not ours");
  } finally { box.cleanup(); }
});

test("upgrading a 0.5 folder with compiled Python leftovers installs, uninstalls, and installs again", async () => {
  const box = sandbox();
  try {
    await install(box.ctx, box.flags);
    const markerPath = join(box.flags.installDir, MARKER);
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    const cache = join(box.flags.installDir, "__pycache__");
    // As 0.5 left it: modules this version dropped, with Python's compiled copies of them and of current ones.
    const retired = ["stream_windows.py", "party_layout.py", "goblin_parting.py"];
    for (const file of retired) writeFileSync(join(box.flags.installDir, file), "# 0.5\n");
    mkdirSync(cache, { recursive: true });
    for (const name of ["stream_windows", "party_layout", "goblin_parting", "horde_model", "desktop_widget"])
      writeFileSync(join(cache, `${name}.cpython-312.pyc`), "pyc");
    writeFileSync(markerPath, JSON.stringify({ ...marker, version: "0.5.0", files: [...marker.files, ...retired] }));

    await install(box.ctx, box.flags);
    for (const file of retired) assert.equal(existsSync(join(box.flags.installDir, file)), false, file);
    assert.equal(existsSync(cache), false, "the compiled copies go with their modules");

    // Python compiles again while it runs; uninstall then leaves nothing behind.
    mkdirSync(cache, { recursive: true });
    for (const name of ["horde_model", "goblin_strip", "stream_windows"]) writeFileSync(join(cache, `${name}.cpython-313.pyc`), "pyc");
    await uninstall(box.ctx, box.flags);
    assert.equal(existsSync(box.flags.installDir), false);
    await install(box.ctx, box.flags);
    assert.ok(existsSync(markerPath));
  } finally { box.cleanup(); }
});

test("a folder whose only leftovers are Goblin Horde's compiled modules is not someone else's", async () => {
  const box = sandbox();
  try {
    // An older uninstall that left its __pycache__ behind.
    const cache = join(box.flags.installDir, "__pycache__");
    mkdirSync(cache, { recursive: true });
    for (const name of ["stream_windows", "party_layout", "goblin_parting"]) writeFileSync(join(cache, `${name}.cpython-312.pyc`), "pyc");
    await install(box.ctx, box.flags);
    assert.equal(existsSync(cache), false);
    await uninstall(box.ctx, box.flags);

    // Someone else's compiled module is theirs: the folder is refused and left as it was.
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "party_layout.cpython-312.pyc"), "pyc");
    writeFileSync(join(cache, "their_tool.cpython-312.pyc"), "theirs");
    await assert.rejects(install(box.ctx, box.flags), /not a Goblin Horde installation/);
    assert.deepEqual(readdirSync(cache).sort(), ["party_layout.cpython-312.pyc", "their_tool.cpython-312.pyc"]);
  } finally { box.cleanup(); }
});

test("the installed hook receiver records filtered activity into the chosen state folder only", async () => {
  const box = sandbox();
  try {
    await install(box.ctx, { ...box.flags, claudeHooks: true });
    const handler = settingsOf(box).hooks.PreToolUse.at(-1).hooks[0];
    const payload = {
      hook_event_name: "PreToolUse", session_id: "sess-1", cwd: "/work/shop", tool_name: "Bash", tool_use_id: "toolu_1",
      tool_input: { command: "curl -H 'Authorization: Bearer SECRETSECRETSECRET' https://example.com" }, prompt: "my private prompt",
    };
    const run = spawnSync(handler.command, handler.args, { input: JSON.stringify(payload), encoding: "utf8", env: { ...box.env, GOBLIN_HORDE_STATE_DIR: "" } });
    assert.equal(run.status, 0);
    assert.equal(run.stdout, "");
    const log = readFileSync(join(box.flags.stateDir, "claude", "activity.jsonl"), "utf8");
    assert.match(log, /"event":"PreToolUse"/);
    // The command is kept for this computer with its credential removed; a prompt never rides on a tool call.
    assert.match(log, /"detail":"curl -H 'Authorization: Bearer \[secret removed\]' https:\/\/example\.com"/);
    assert.doesNotMatch(log, /SECRET|private prompt/);
  } finally { box.cleanup(); }
});

test("uninstall removes the app, its skills, and only its hooks; settings stay unless asked", async () => {
  const box = sandbox();
  try {
    await install(box.ctx, { ...box.flags, claudeHooks: true });
    writeFileSync(join(box.flags.stateDir, "goblins.json"), "{}");
    writeFileSync(join(box.flags.stateDir, "pairing-code.txt"), "ABCDEFGH\n");
    writeFileSync(join(box.flags.stateDir, "my-notes.txt"), "not ours");
    // Someone added their own skill file beside ours; it must survive.
    writeFileSync(join(box.claudeDir, "skills", "goblin-horde-manager", "extra.md"), "mine");

    const result = await uninstall(box.ctx, box.flags);
    assert.equal(existsSync(box.flags.installDir), false);
    assert.deepEqual(settingsOf(box), userSettings, "Claude settings are back to exactly what the person had");
    assert.equal(existsSync(join(box.codexDir, "skills", "goblin-horde-manager")), false);
    assert.deepEqual(readdirSync(join(box.claudeDir, "skills", "goblin-horde-manager")), ["extra.md"]);
    assert.ok(existsSync(join(box.flags.stateDir, "pairing-code.txt")), "settings are kept by default");
    assert.ok(result.messages.some((line) => /Kept settings/.test(line)));

    // A folder holding someone else's file is not taken over by a later install.
    await assert.rejects(install(box.ctx, box.flags), /did not install/);
    rmSync(join(box.claudeDir, "skills", "goblin-horde-manager"), { recursive: true });
    await install(box.ctx, box.flags);
    // Every file the viewer, the widget, and the hook write there.
    const written = ["watched.json", "dismissed.json", "links.json", "phone.json", "goblins.json.unreadable"];
    for (const name of written) writeFileSync(join(box.flags.stateDir, name), "{}");
    mkdirSync(join(box.flags.stateDir, "claude"), { recursive: true });
    writeFileSync(join(box.flags.stateDir, "claude", "activity.jsonl"), "");
    const reset = await uninstall(box.ctx, { ...box.flags, removeSettings: true });
    assert.equal(existsSync(join(box.flags.stateDir, "pairing-code.txt")), false);
    assert.equal(existsSync(join(box.flags.stateDir, "goblins.json")), false);
    for (const name of written) assert.equal(existsSync(join(box.flags.stateDir, name)), false, name);
    assert.equal(existsSync(join(box.flags.stateDir, "claude")), false);
    assert.deepEqual(readdirSync(box.flags.stateDir), ["my-notes.txt"], "only the person's own file is left");
    assert.ok(reset.messages.some((line) => /watched chats, dismissed alerts, party links/.test(line)));
    assert.equal(readFileSync(join(box.flags.stateDir, "my-notes.txt"), "utf8"), "not ours", "unrelated files are never removed");
  } finally { box.cleanup(); }
});

test("a full reset also takes Goblin Horde's settings backups and the skill folders it made, and says so", async () => {
  const box = sandbox();
  try {
    // The Codex home already had a skills folder of its own; the Claude config folder had none.
    mkdirSync(join(box.codexDir, "skills", "their-skill"), { recursive: true });
    await install(box.ctx, { ...box.flags, claudeHooks: true });
    await install(box.ctx, box.flags); // An update keeps what the first install made.
    const settingsPath = claudeSettingsPath(box.claudeDir);
    for (const suffix of [".goblin-horde-backup", ".goblin-horde-backup.last"]) assert.ok(existsSync(`${settingsPath}${suffix}`), suffix);
    const kept = await uninstall(box.ctx, box.flags);
    assert.ok(existsSync(`${settingsPath}.goblin-horde-backup`), "backups stay without --remove-settings");
    assert.equal(existsSync(join(box.claudeDir, "skills")), false, "the empty skills folder Goblin Horde made goes");
    assert.ok(existsSync(join(box.codexDir, "skills", "their-skill")), "a skills folder that was there before stays");
    assert.ok(!kept.messages.some((line) => /backup/i.test(line)));
    await install(box.ctx, { ...box.flags, claudeHooks: true });
    const reset = await uninstall(box.ctx, { ...box.flags, removeSettings: true });
    for (const suffix of [".goblin-horde-backup", ".goblin-horde-backup.last"]) assert.equal(existsSync(`${settingsPath}${suffix}`), false, suffix);
    assert.ok(reset.messages.some((line) => /Removed Goblin Horde's backups of .*settings\.json/.test(line)), reset.messages.join("\n"));
    assert.equal(existsSync(join(box.claudeDir, "skills")), false);
    assert.deepEqual(settingsOf(box), userSettings);
  } finally { box.cleanup(); }
});

test("a full reset knows every file the viewer's stores keep in the state folder", () => {
  const dir = join(tmpdir(), "goblin-state-names");
  const named = new Set(stateFiles(dir).map((file) => basename(file)));
  const stores = [new WatchList({ dir }).file, new DismissStore({ dir }).file, new LinkStore({ dir }).file];
  for (const file of [...stores, join(dir, PHONE_FILE), join(dir, CODE_FILE), join(claudeActivityDir({ env: { GOBLIN_HORDE_STATE_DIR: dir } }), "activity.jsonl")])
    assert.ok(named.has(basename(file)), basename(file));
});

test("upgrading from 0.5 with Claude Code connected says once what the hook now records", async () => {
  const box = sandbox();
  try {
    await install(box.ctx, { ...box.flags, claudeHooks: true });
    const markerPath = join(box.flags.installDir, MARKER);
    const as05 = () => writeFileSync(markerPath, JSON.stringify({ ...JSON.parse(readFileSync(markerPath, "utf8")), version: "0.5.0" }));
    const notice = (result) => result.messages.filter((line) => /also records redacted commands, prompt excerpts, questions, and todo lists/.test(line));
    as05();
    const upgraded = await install(box.ctx, box.flags);
    assert.equal(notice(upgraded).length, 1, upgraded.messages.join("\n"));
    assert.match(notice(upgraded)[0], /hooks remove/);
    assert.equal(notice(await install(box.ctx, box.flags)).length, 0, "said once: 0.6 over 0.6 is quiet");
    as05();
    assert.equal(notice(await install(box.ctx, { ...box.flags, claudeHooks: false })).length, 0, "not when disconnecting");
    as05();
    assert.equal(notice(await install(box.ctx, box.flags)).length, 0, "not when it was never connected");
  } finally { box.cleanup(); }
});

test("Claude Code connected from the window stays connected on an update, and install says so once", async () => {
  const box = sandbox();
  try {
    await install(box.ctx, box.flags);
    // The window's "Connect Claude Code…" adds this installation's hooks; the installer was not involved.
    installClaudeHooks({ settingsPath: claudeSettingsPath(box.claudeDir), nodePath: process.execPath,
      hookPath: join(box.flags.installDir, "claude-hook.mjs"), stateDir: box.flags.stateDir });
    const said = (result, pattern) => result.messages.filter((line) => pattern.test(line));
    const updated = await install(box.ctx, box.flags);
    assert.deepEqual(said(updated, /not connected/i), [], updated.messages.join("\n"));
    assert.equal(said(updated, /stays connected/i).length, 1, updated.messages.join("\n"));
    assert.deepEqual(said(updated, /Connected Claude Code: added/), []);
    assert.equal(JSON.parse(readFileSync(join(box.flags.installDir, MARKER), "utf8")).claudeHooks.installed, true);
    assert.equal(claudeHookReport(claudeSettingsPath(box.claudeDir)).state, "installed");
    // The window also notes the connection in the marker, every other field kept.
    const markerPath = join(box.flags.installDir, MARKER);
    writeFileSync(markerPath, JSON.stringify({ ...JSON.parse(readFileSync(markerPath, "utf8")), claudeHooks: { installed: false, declined: true } }));
    assert.equal(markHooksConnected(markerPath, claudeSettingsPath(box.claudeDir)), true);
    const marked = JSON.parse(readFileSync(markerPath, "utf8"));
    assert.deepEqual(marked.claudeHooks, { installed: true, settingsPath: claudeSettingsPath(box.claudeDir), declined: false });
    assert.equal(marked.installRoot, box.flags.installDir);
    assert.equal(markHooksConnected(join(box.root, "no-marker.json"), "x"), false);
    // Connected by install, then installed again with the same answer: it stays connected, it is not added again.
    const again = await install(box.ctx, { ...box.flags, claudeHooks: true });
    assert.deepEqual(said(again, /Connected Claude Code: added/), []);
    assert.equal(said(again, /stays connected/i).length, 1);
  } finally { box.cleanup(); }
});

test("every command install prints for a custom install folder names that folder", async () => {
  const box = sandbox();
  try {
    const commands = (result) => result.messages.flatMap((line) => line.match(/node "[^"]*goblin\.mjs"[^.;)(]*/g) || []);
    const flag = `--install-dir "${box.flags.installDir}"`;
    const plain = await install(box.ctx, box.flags);
    const hooked = await install(box.ctx, { ...box.flags, claudeHooks: true });
    for (const result of [plain, hooked]) {
      assert.ok(commands(result).length > 0, result.messages.join("\n"));
      for (const command of commands(result)) assert.ok(command.includes(flag), command);
      assert.ok(!result.messages.some((line) => /\bnode goblin\.mjs\b/.test(line)), "never the bare source-folder command");
    }
    // The installed skill tells an agent the same command.
    const skill = readFileSync(join(box.codexDir, "skills", "goblin-horde-manager", "SKILL.md"), "utf8");
    assert.ok(skill.includes(`goblin.mjs" ${flag}`) || skill.includes(`goblin.mjs' --install-dir '${box.flags.installDir}'`), skill.slice(0, 400));
  } finally { box.cleanup(); }
});

test("without a hook choice, install never opens Claude settings; --no-claude-hooks removes ours", async () => {
  const box = sandbox();
  try {
    writeFileSync(join(box.claudeDir, "settings.json"), "{ broken");
    const result = await install(box.ctx, box.flags);
    assert.equal(readFileSync(join(box.claudeDir, "settings.json"), "utf8"), "{ broken");
    assert.ok(result.messages.some((line) => /not connected/i.test(line)));
    // Uninstall still works: hooks were never recorded, so the broken file is reported and left alone.
    const removed = await uninstall(box.ctx, box.flags);
    assert.ok(removed.messages.some((line) => /Did not check/.test(line)));
    assert.equal(readFileSync(join(box.claudeDir, "settings.json"), "utf8"), "{ broken");

    writeFileSync(join(box.claudeDir, "settings.json"), JSON.stringify(userSettings));
    await install(box.ctx, { ...box.flags, claudeHooks: true });
    await install(box.ctx, { ...box.flags, claudeHooks: false });
    assert.deepEqual(settingsOf(box), userSettings);
  } finally { box.cleanup(); }
});

test("malformed Claude settings stop an install that asked for hooks before anything is copied", async () => {
  const box = sandbox();
  try {
    writeFileSync(join(box.claudeDir, "settings.json"), "[1, 2");
    await assert.rejects(install(box.ctx, { ...box.flags, claudeHooks: true }), /not valid JSON/);
    assert.equal(existsSync(box.flags.installDir), false);
    assert.equal(readFileSync(join(box.claudeDir, "settings.json"), "utf8"), "[1, 2");
  } finally { box.cleanup(); }
});

test("install refuses unrelated folders, the package itself, and state inside the app", async () => {
  const box = sandbox();
  try {
    mkdirSync(box.flags.installDir, { recursive: true });
    writeFileSync(join(box.flags.installDir, "someone-else.txt"), "x");
    await assert.rejects(install(box.ctx, box.flags), /not a Goblin Horde installation/);
    await assert.rejects(install(box.ctx, { ...box.flags, installDir: join(sourceDir, "nested") }), /outside the package folder/);
    await assert.rejects(install(box.ctx, { ...box.flags, installDir: join(box.root, "app2"), stateDir: join(box.root, "app2", "state") }), /outside the installation folder/);
    await assert.rejects(install(box.ctx, { ...box.flags, installDir: box.home }), /shared folder/);
    assert.throws(() => locate(box.ctx, { installDir: "relative/path" }), /absolute path/);
    assert.equal(readFileSync(join(box.flags.installDir, "someone-else.txt"), "utf8"), "x");
  } finally { box.cleanup(); }
});

test("a busy port is reported before anything is installed or started", async () => {
  const box = sandbox();
  const blocker = createServer(() => {});
  await new Promise((resolvePromise) => blocker.listen(0, "127.0.0.1", resolvePromise));
  const { port } = blocker.address();
  try {
    await assert.rejects(install(box.ctx, { ...box.flags, noStart: false, port: String(port) }),
      (error) => error.code === "PORT_IN_USE" && /another program/.test(error.message));
    assert.equal(existsSync(box.flags.installDir), false);
    await install(box.ctx, { ...box.flags, port: String(port) });
    await assert.rejects(start(box.ctx, { ...box.flags, port: String(port) }), (error) => error.exitCode === 3);
  } finally {
    blocker.close();
    box.cleanup();
  }
});

test("status and doctor describe an isolated installation without starting it", async () => {
  const box = sandbox();
  try {
    await install(box.ctx, box.flags);
    const report = await status(box.ctx, box.flags);
    assert.equal(report.installed, true);
    assert.equal(report.server, null);
    assert.equal(report.claudeHooks.state, "missing");
    // A port nothing listens on, so the check never talks to a real viewer on this computer.
    const probe = createServer(() => {});
    await new Promise((resolvePromise) => probe.listen(0, "127.0.0.1", resolvePromise));
    const { port } = probe.address();
    await new Promise((resolvePromise) => probe.close(resolvePromise));
    const code = await main(["doctor", "--json", "--install-dir", box.flags.installDir, "--state-dir", box.flags.stateDir, "--port", String(port)], box.ctx);
    assert.equal(code, 0);
    const doctorReport = JSON.parse(box.lines.at(-1));
    assert.ok(doctorReport.checks.some((check) => check.name === "claude-hooks" && check.state === "missing"));
    assert.ok(doctorReport.checks.some((check) => check.name === "desktop-widget"));
  } finally { box.cleanup(); }
});

test("the viewer reads the Claude settings folder chosen with --claude-config-dir", async () => {
  const box = sandbox();
  try {
    // A different folder from CLAUDE_CONFIG_DIR, so the env alone would point the viewer at the wrong settings.
    const chosen = join(box.root, "chosen-claude");
    mkdirSync(chosen, { recursive: true });
    writeFileSync(join(chosen, "settings.json"), JSON.stringify(userSettings));
    const flags = { ...box.flags, claudeConfigDir: chosen };
    await install(box.ctx, { ...flags, claudeHooks: true });
    assert.equal((await status(box.ctx, flags)).claudeHooks.state, "installed");

    const env = childEnv(box.ctx, locate(box.ctx, flags), "instance");
    // server.mjs resolves its settings path exactly this way for /api/capabilities.
    const viewerSettings = claudeSettingsPath(claudeConfigDir({ env, platform: box.ctx.platform, home: box.home }));
    assert.equal(viewerSettings, join(chosen, "settings.json"));
    assert.equal(claudeHookReport(viewerSettings).state, "installed");
  } finally { box.cleanup(); }
});

test("the viewer, and the Codex it starts, use the Codex home chosen with --codex-home", async () => {
  const box = sandbox();
  try {
    const chosen = join(box.root, "chosen-codex");
    const env = childEnv(box.ctx, locate(box.ctx, { ...box.flags, codexHome: chosen }), "instance");
    assert.equal(env.CODEX_HOME, chosen);
    assert.equal(childEnv(box.ctx, locate(box.ctx, box.flags), "instance").CODEX_HOME, box.codexDir, "else the one the environment names");
  } finally { box.cleanup(); }
});

test("emit validates and records into the isolated state folder", async () => {
  const box = sandbox();
  try {
    const good = JSON.stringify({ v: 1, at: Date.now() - 1000, party: "p1", agent: "a1", event: "start" });
    assert.equal(await main(["emit", "--feed", "relay", "--record", good, "--state-dir", box.flags.stateDir, "--install-dir", box.flags.installDir], box.ctx), 0);
    assert.match(readFileSync(join(box.flags.stateDir, "feeds", "relay.ndjson"), "utf8"), /"party":"p1"/);
    const bad = JSON.stringify({ v: 1, at: Date.now(), party: "p1", agent: "a1", event: "step", step: "command", output: "x" });
    assert.equal(await main(["emit", "--feed", "relay", "--check", "--record", bad, "--state-dir", box.flags.stateDir, "--install-dir", box.flags.installDir], box.ctx), 1);
    assert.ok(box.lines.some((line) => /"output" is not accepted/.test(line)));
  } finally { box.cleanup(); }
});

test("release versions compare by number, and an unknown one counts as older", () => {
  assert.equal(versionBefore("0.5.0", "0.6.0"), true);
  assert.equal(versionBefore("0.6.0", "0.6.0"), false);
  assert.equal(versionBefore("0.10.0", "0.6.0"), false);
  assert.equal(versionBefore("1.0", "0.6.0"), false);
  assert.equal(versionBefore("", "0.6.0"), true);
  assert.equal(versionBefore(undefined, "0.6.0"), true);
});

test("argument parsing rejects unknown options", () => {
  assert.deepEqual(parseArgs(["install", "--port=5000", "--claude-hooks"]).flags, { port: "5000", "claude-hooks": true });
  assert.throws(() => parseArgs(["install", "--force"]), /Unknown option/);
  assert.throws(() => parseArgs(["install", "--install-dir"]), /needs a value/);
});

test("uninstalling one installation keeps another installation's Claude hooks and every unrelated hook", async () => {
  const box = sandbox();
  try {
    const a = { ...box.flags, installDir: join(box.root, "app-a"), stateDir: join(box.root, "state-a") };
    // B shares the same Claude Code settings; its manager skill is skipped because A's already owns that folder.
    const b = { ...box.flags, installDir: join(box.root, "app-b"), stateDir: join(box.root, "state-b"), skipSkill: true };
    const receiver = (flags) => join(flags.installDir, "claude-hook.mjs");
    const receivers = (event) => settingsOf(box).hooks[event].flatMap((group) => group.hooks)
      .filter((item) => item.args?.includes(HOOK_MARKER)).map((item) => item.args[0]).sort();
    await install(box.ctx, { ...a, claudeHooks: true });
    await install(box.ctx, { ...b, claudeHooks: true });
    for (const { event } of HOOK_EVENTS) assert.deepEqual(receivers(event), [receiver(a), receiver(b)].sort(), event);

    // Reinstalling A replaces only A's own entries.
    await install(box.ctx, a);
    for (const { event } of HOOK_EVENTS) assert.deepEqual(receivers(event), [receiver(a), receiver(b)].sort(), event);
    // Declining hooks for A removes only A's.
    await install(box.ctx, { ...a, claudeHooks: false });
    for (const { event } of HOOK_EVENTS) assert.deepEqual(receivers(event), [receiver(b)], event);
    await install(box.ctx, { ...a, claudeHooks: true });

    const removed = await uninstall(box.ctx, a);
    assert.ok(removed.messages.some((line) => new RegExp(`Removed ${HOOK_EVENTS.length} Goblin Horde hook entries`).test(line)));
    const settings = settingsOf(box);
    for (const { event } of HOOK_EVENTS) assert.deepEqual(receivers(event), [receiver(b)], event);
    assert.equal(settings.model, userSettings.model);
    assert.deepEqual(settings.permissions, userSettings.permissions);
    assert.deepEqual(settings.hooks.PostToolUse[0], userSettings.hooks.PostToolUse[0]);
    const report = await status(box.ctx, b);
    assert.equal(report.claudeHooks.state, "installed", "B is still connected");
    assert.equal((await status(box.ctx, a)).claudeHooks.otherInstall, true, "A's status sees B's hooks without claiming them");

    await uninstall(box.ctx, b);
    assert.deepEqual(settingsOf(box), userSettings, "after both are gone the settings are exactly the person's own");
  } finally { box.cleanup(); }
});

test("stop ends only processes started from this installation", { timeout: 60_000 }, async (t) => {
  if (!listProcesses().length) { t.skip("This computer's process list could not be read."); return; }
  const box = sandbox();
  const mine = join(box.root, "mine");
  const theirs = join(box.root, "theirs");
  const script = "setInterval(() => {}, 1000);\n";
  for (const dir of [mine, theirs]) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "server.mjs"), script); }
  const ours = spawn(process.execPath, [join(mine, "server.mjs")], { stdio: "ignore" });
  const other = spawn(process.execPath, [join(theirs, "server.mjs")], { stdio: "ignore" });
  try {
    const ctx = { ...box.ctx, listProcesses };
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    const result = await stop(ctx, { installDir: mine, stateDir: box.flags.stateDir });
    assert.equal(result.stopped, 1);
    assert.equal(isAlive(ours.pid), false);
    assert.equal(isAlive(other.pid), true);
  } finally {
    ours.kill();
    other.kill();
    box.cleanup();
  }
});

test("a process id that now runs another program is not reported as stopped, and is not killed", { timeout: 20_000 }, async (t) => {
  // Windows ends a process on the first signal, so only POSIX reaches the check before insisting.
  if (process.platform === "win32") { t.skip("Windows has no signal a process can ignore."); return; }
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });
  try {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    assert.equal(await stopPid(child.pid, { waitMs: 300, verify: () => false }), false);
    assert.equal(isAlive(child.pid), true, "the other program was left running");
  } finally { child.kill("SIGKILL"); }
});

test("on Windows, install adds a Start menu entry, sign-in start is opt-in, and uninstall removes both", { skip: process.platform !== "win32" }, async () => {
  const box = sandbox();
  try {
    box.env.APPDATA = join(box.root, "roaming");
    const written = [];
    // A stand-in for the Windows shortcut writer: a file that names its target, as a real .lnk does.
    box.ctx.writeShortcut = (link, spec) => {
      written.push({ link, spec });
      mkdirSync(dirname(link), { recursive: true });
      writeFileSync(link, Buffer.from(`${spec.target} ${spec.args}`, "utf16le"));
    };
    const programs = join(box.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs");
    const menu = join(programs, "Goblin Horde.lnk");
    const startup = join(programs, "Startup", "Goblin Horde.lnk");

    const result = await install(box.ctx, box.flags);
    assert.equal(existsSync(menu), true);
    assert.equal(existsSync(startup), false, "starting at sign-in is never assumed");
    assert.equal(result.startMenu, true);
    assert.match(written[0].spec.args, /goblin\.mjs" start --install-dir "/);
    assert.equal(written[0].spec.icon, join(box.flags.installDir, "goblin.ico"));

    assert.equal(autostart(box.ctx, box.flags, true).enabled, true);
    assert.equal(existsSync(startup), true);
    assert.equal(autostart(box.ctx, box.flags).enabled, true);
    // Reinstalling keeps a sign-in shortcut that is already there.
    await install(box.ctx, box.flags);
    assert.equal(existsSync(startup), true);

    await uninstall(box.ctx, box.flags);
    assert.equal(existsSync(menu), false);
    assert.equal(existsSync(startup), false);
  } finally { box.cleanup(); }
});

test("uninstall leaves another installation's shortcuts alone", { skip: process.platform !== "win32" }, async () => {
  const box = sandbox();
  try {
    box.env.APPDATA = join(box.root, "roaming");
    box.ctx.writeShortcut = () => { throw new Error("no shortcut writer here"); };
    const result = await install(box.ctx, box.flags);
    assert.equal(result.startMenu, false);
    assert.ok(result.messages.some((line) => /Could not add the Start menu entry \(no shortcut writer here\)/.test(line)));
    const menu = join(box.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Goblin Horde.lnk");
    mkdirSync(dirname(menu), { recursive: true });
    writeFileSync(menu, Buffer.from("C:\Other\GoblinHorde\goblin.mjs start", "utf16le"));
    await uninstall(box.ctx, box.flags);
    assert.equal(existsSync(menu), true);
  } finally { box.cleanup(); }
});
