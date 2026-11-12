/**
 * Install and uninstall in throwaway folders. Every path (app, state, Claude config, Codex home,
 * home) points into a temporary directory; nothing here reads or writes this computer's real
 * settings, and no server is started.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKUP_SUFFIX, HOOK_MARKER, LAST_BACKUP_SUFFIX } from "../lib/old-hooks.mjs";
import { createPetsStore } from "../lib/pets-store.mjs";
import { createState, loadConfig } from "../lib/rewards.mjs";
import { initialWatermark } from "../lib/t3-source.mjs";
import { MARKER, SKILL_MARKER, install, locate, makeContext, managerCommand, readManifest, start, stateFiles, status, stop, uninstall } from "../lib/manager.mjs";
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
  // The loopback stand-in keeps doctor from running this computer's own tailscale program.
  const env = { PATH: process.env.PATH, Path: process.env.Path, PATHEXT: process.env.PATHEXT, SystemRoot: process.env.SystemRoot,
    LOCALAPPDATA: join(root, "local"), CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir, GOBLIN_SHARED_LOOPBACK: "45123" };
  const lines = [];
  const ctx = makeContext({ env, home, sourceDir, log: (line) => lines.push(line), listProcesses: () => [] });
  const flags = { installDir: join(root, "app"), stateDir: join(root, "state"), noStart: true };
  return { root, home, claudeDir, codexDir, env, ctx, flags, lines, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const settingsOf = (box, dir = box.claudeDir) => JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));

// The events an earlier version hooked, and whether each took a matcher.
const OLD_EVENTS = [["SessionStart", true], ["SessionEnd", true], ["UserPromptSubmit", false], ["PreToolUse", true], ["PostToolUse", true],
  ["PostToolUseFailure", true], ["PermissionRequest", true], ["Notification", true], ["SubagentStart", true], ["SubagentStop", true], ["Stop", false],
  ["StopFailure", true]];
/** Settings as an earlier version left them: the person's own, then a hook group per event for each installation folder. */
function withOldHooks(settings, ...installDirs) {
  const hooks = { ...settings.hooks };
  for (const installDir of installDirs) {
    const handler = { type: "command", command: process.execPath, args: [join(installDir, "claude-hook.mjs"), HOOK_MARKER, "--state-dir", join(installDir, "..", "state")],
      async: true, timeout: 10 };
    for (const [event, matcher] of OLD_EVENTS) hooks[event] = [...(hooks[event] || []), matcher ? { matcher: "*", hooks: [handler] } : { hooks: [handler] }];
  }
  return { ...settings, hooks };
}
/** The receivers of every Goblin Horde hook entry left in a settings object. */
const receivers = (settings) => Object.values(settings.hooks || {}).flat().flatMap((group) => group.hooks || [])
  .filter((handler) => handler.args?.includes(HOOK_MARKER)).map((handler) => handler.args[0]);

test("install copies exactly the manifest and writes the manager skills, and leaves Claude Code's settings alone", async () => {
  const box = sandbox();
  try {
    const before = readFileSync(join(box.claudeDir, "settings.json"), "utf8");
    const result = await install(box.ctx, box.flags);
    const manifest = readManifest(sourceDir);
    for (const file of manifest) assert.ok(existsSync(join(box.flags.installDir, ...file.split("/"))), file);
    assert.equal(existsSync(join(box.flags.installDir, "test")), false, "tests are not installed");
    const marker = JSON.parse(readFileSync(join(box.flags.installDir, MARKER), "utf8"));
    assert.equal(marker.product, "GoblinHorde");
    assert.deepEqual(marker.files, manifest);
    assert.equal(marker.stateDir, box.flags.stateDir);
    assert.equal(marker.claudeHooks, undefined, "nothing about hooks is recorded");

    for (const dir of [join(box.codexDir, "skills", "goblin-horde-manager"), join(box.claudeDir, "skills", "goblin-horde-manager")]) {
      const skill = readFileSync(join(dir, "SKILL.md"), "utf8");
      assert.ok(skill.includes(join(box.flags.installDir, "goblin.mjs")), "the skill names this installation's manager");
      assert.doesNotMatch(skill, /\{\{/);
      assert.ok(existsSync(join(dir, SKILL_MARKER)));
    }
    assert.equal(readFileSync(join(box.claudeDir, "settings.json"), "utf8"), before, "Claude Code's settings are byte for byte as they were");
    assert.equal(existsSync(join(box.claudeDir, `settings.json${BACKUP_SUFFIX}`)), false);
    assert.ok(!result.messages.some((line) => /hook/i.test(line)), result.messages.join("\n"));
  } finally { box.cleanup(); }
});

test("an earlier version's hook entries for this installation go at install, start, and uninstall, with a backup, and nobody else's do", async () => {
  const box = sandbox();
  const other = join(box.root, "other-app");
  try {
    // An earlier version of this installation connected Claude Code, beside another installation that did too.
    const old = withOldHooks(userSettings, box.flags.installDir, other);
    const oldText = JSON.stringify(old, null, 2);
    writeFileSync(join(box.claudeDir, "settings.json"), oldText);
    const installed = await install(box.ctx, box.flags);
    assert.deepEqual(settingsOf(box), withOldHooks(userSettings, other), "only this installation's entries went, and everything else is as it was");
    assert.equal(readFileSync(join(box.claudeDir, `settings.json${BACKUP_SUFFIX}`), "utf8"), oldText, "the file as it was is kept beside it");
    assert.equal(installed.messages.filter((line) => line.startsWith(`Removed ${OLD_EVENTS.length} Claude Code hook entries an earlier Goblin Horde added to ${join(box.claudeDir, "settings.json")}`)).length, 1,
      installed.messages.join("\n"));
    assert.ok(!existsSync(join(box.flags.installDir, "claude-hook.mjs")), "the receiver they ran does not ship");

    // Entries that come back, say from a copy of an old settings file, go at the next start and at uninstall.
    writeFileSync(join(box.claudeDir, "settings.json"), oldText);
    const blocker = createServer(() => {});
    await new Promise((resolvePromise) => blocker.listen(0, "127.0.0.1", resolvePromise));
    try {
      // A busy port stops the start, after the entries are taken out.
      await assert.rejects(start(box.ctx, { ...box.flags, port: String(blocker.address().port) }), (error) => error.code === "PORT_IN_USE");
    } finally { blocker.close(); }
    assert.deepEqual(receivers(settingsOf(box)), Array(OLD_EVENTS.length).fill(join(other, "claude-hook.mjs")));
    writeFileSync(join(box.claudeDir, "settings.json"), oldText);
    const removed = await uninstall(box.ctx, box.flags);
    assert.deepEqual(settingsOf(box), withOldHooks(userSettings, other));
    assert.ok(removed.messages.some((line) => /Removed 12 Claude Code hook entries an earlier Goblin Horde added/.test(line)), removed.messages.join("\n"));
    assert.equal(readFileSync(join(box.claudeDir, `settings.json${BACKUP_SUFFIX}`), "utf8"), oldText, "the first backup is never written over");
  } finally { box.cleanup(); }
});

test("hook entries in the settings an earlier version recorded, or under --claude-config-dir, go too", async () => {
  const box = sandbox();
  try {
    // An earlier install connected Claude Code in another settings folder, and recorded it in its marker.
    const recorded = join(box.root, "recorded-claude");
    mkdirSync(recorded, { recursive: true });
    writeFileSync(join(recorded, "settings.json"), JSON.stringify(withOldHooks(userSettings, box.flags.installDir)));
    await install(box.ctx, box.flags);
    const markerPath = join(box.flags.installDir, MARKER);
    writeFileSync(markerPath, JSON.stringify({ ...JSON.parse(readFileSync(markerPath, "utf8")), version: "0.6.0",
      claudeHooks: { installed: true, settingsPath: join(recorded, "settings.json") } }));
    await install(box.ctx, box.flags);
    assert.deepEqual(settingsOf(box, recorded), userSettings);

    const chosen = join(box.root, "chosen-claude");
    mkdirSync(chosen, { recursive: true });
    writeFileSync(join(chosen, "settings.json"), JSON.stringify(withOldHooks(userSettings, box.flags.installDir)));
    await uninstall(box.ctx, { ...box.flags, claudeConfigDir: chosen });
    assert.deepEqual(settingsOf(box, chosen), userSettings);
  } finally { box.cleanup(); }
});

test("a Claude Code settings file that is not JSON is left as it is, and install and uninstall go on", async () => {
  const box = sandbox();
  try {
    const broken = `{ "hooks": { "Stop": [{ "hooks": [{ "args": [${JSON.stringify(join(box.flags.installDir, "claude-hook.mjs"))}, "${HOOK_MARKER}"] }] }] }, // a comment`;
    writeFileSync(join(box.claudeDir, "settings.json"), broken);
    await install(box.ctx, box.flags);
    assert.equal(readFileSync(join(box.claudeDir, "settings.json"), "utf8"), broken);
    await uninstall(box.ctx, box.flags);
    assert.equal(existsSync(box.flags.installDir), false);
    assert.equal(readFileSync(join(box.claudeDir, "settings.json"), "utf8"), broken);
    assert.equal(existsSync(join(box.claudeDir, `settings.json${BACKUP_SUFFIX}`)), false);
    rmSync(join(box.claudeDir, "settings.json"));
    await install(box.ctx, box.flags);
    assert.equal(existsSync(join(box.claudeDir, "settings.json")), false, "a missing settings file is not made");
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
    for (const name of ["stream_windows", "party_layout", "goblin_parting", "pet_field", "desktop_widget"])
      writeFileSync(join(cache, `${name}.cpython-312.pyc`), "pyc");
    writeFileSync(markerPath, JSON.stringify({ ...marker, version: "0.5.0", files: [...marker.files, ...retired] }));

    await install(box.ctx, box.flags);
    for (const file of retired) assert.equal(existsSync(join(box.flags.installDir, file)), false, file);
    assert.equal(existsSync(cache), false, "the compiled copies go with their modules");

    // Python compiles again while it runs; uninstall then leaves nothing behind.
    mkdirSync(cache, { recursive: true });
    for (const name of ["pet_field", "desktop_widget", "stream_windows"]) writeFileSync(join(cache, `${name}.cpython-313.pyc`), "pyc");
    await uninstall(box.ctx, box.flags);
    assert.equal(existsSync(box.flags.installDir), false);
    await install(box.ctx, box.flags);
    assert.ok(existsSync(markerPath));
  } finally { box.cleanup(); }
});

test("a folder whose only leftovers are Goblin Horde's compiled modules is not someone else's", async () => {
  const box = sandbox();
  try {
    // An older uninstall that left its __pycache__ behind, with the agent monitor's modules among them.
    const cache = join(box.flags.installDir, "__pycache__");
    mkdirSync(cache, { recursive: true });
    for (const name of ["stream_windows", "party_layout", "goblin_parting", "horde_window", "goblin_strip"]) writeFileSync(join(cache, `${name}.cpython-312.pyc`), "pyc");
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

test("uninstall removes the app and its skills; settings stay unless asked", async () => {
  const box = sandbox();
  try {
    await install(box.ctx, box.flags);
    writeFileSync(join(box.flags.stateDir, "goblins.json"), "{}");
    writeFileSync(join(box.flags.stateDir, "pairing-code.txt"), "ABCDEFGH\n");
    writeFileSync(join(box.flags.stateDir, "my-notes.txt"), "not ours");
    // Someone added their own skill file beside ours; it must survive.
    writeFileSync(join(box.claudeDir, "skills", "goblin-horde-manager", "extra.md"), "mine");

    const result = await uninstall(box.ctx, box.flags);
    assert.equal(existsSync(box.flags.installDir), false);
    assert.deepEqual(settingsOf(box), userSettings, "Claude settings are exactly what the person had");
    assert.equal(existsSync(join(box.codexDir, "skills", "goblin-horde-manager")), false);
    assert.deepEqual(readdirSync(join(box.claudeDir, "skills", "goblin-horde-manager")), ["extra.md"]);
    assert.ok(existsSync(join(box.flags.stateDir, "pairing-code.txt")), "settings are kept by default");
    assert.ok(result.messages.some((line) => /Kept settings/.test(line)));

    // A folder holding someone else's file is not taken over by a later install.
    await assert.rejects(install(box.ctx, box.flags), /did not install/);
    rmSync(join(box.claudeDir, "skills", "goblin-horde-manager"), { recursive: true });
    await install(box.ctx, box.flags);
    // Files the widget writes, and files earlier versions wrote there.
    const written = ["watched.json", "dismissed.json", "links.json", "phone.json", "goblins.json.unreadable"];
    for (const name of written) writeFileSync(join(box.flags.stateDir, name), "{}");
    for (const [folder, name] of [["claude", "activity.jsonl"], ["feeds", "relay.ndjson"], ["run", "show-widget"], ["run", "update.log"], ["updates", "settings.json"],
      [join("updates", "ready", "0.6.1"), "update.json"], [join("updates", "previous"), "GoblinHorde-Team.zip"]]) {
      mkdirSync(join(box.flags.stateDir, folder), { recursive: true });
      writeFileSync(join(box.flags.stateDir, folder, name), "");
    }
    const reset = await uninstall(box.ctx, { ...box.flags, removeSettings: true });
    assert.equal(existsSync(join(box.flags.stateDir, "pairing-code.txt")), false);
    assert.equal(existsSync(join(box.flags.stateDir, "goblins.json")), false);
    for (const name of written) assert.equal(existsSync(join(box.flags.stateDir, name)), false, name);
    for (const folder of ["claude", "feeds", "run", "updates"]) assert.equal(existsSync(join(box.flags.stateDir, folder)), false, folder);
    assert.deepEqual(readdirSync(box.flags.stateDir), ["my-notes.txt"], "only the person's own file is left");
    assert.ok(reset.messages.some((line) => /the saved pet game, the pairing code, the shared game's settings, and what earlier versions kept there/.test(line)), reset.messages.join("\n"));
    assert.equal(readFileSync(join(box.flags.stateDir, "my-notes.txt"), "utf8"), "not ours", "unrelated files are never removed");
  } finally { box.cleanup(); }
});

test("a full reset also takes Goblin Horde's settings backups and the skill folders it made, and says so", async () => {
  const box = sandbox();
  try {
    // The Codex home already had a skills folder of its own; the Claude config folder had none.
    mkdirSync(join(box.codexDir, "skills", "their-skill"), { recursive: true });
    writeFileSync(join(box.claudeDir, "settings.json"), JSON.stringify(withOldHooks(userSettings, box.flags.installDir)));
    await install(box.ctx, box.flags);
    writeFileSync(join(box.claudeDir, "settings.json"), JSON.stringify(withOldHooks(userSettings, box.flags.installDir)));
    await install(box.ctx, box.flags); // An update keeps what the first install made.
    const settingsPath = join(box.claudeDir, "settings.json");
    for (const suffix of [BACKUP_SUFFIX, LAST_BACKUP_SUFFIX]) assert.ok(existsSync(`${settingsPath}${suffix}`), suffix);
    const kept = await uninstall(box.ctx, box.flags);
    assert.ok(existsSync(`${settingsPath}${BACKUP_SUFFIX}`), "backups stay without --remove-settings");
    assert.equal(existsSync(join(box.claudeDir, "skills")), false, "the empty skills folder Goblin Horde made goes");
    assert.ok(existsSync(join(box.codexDir, "skills", "their-skill")), "a skills folder that was there before stays");
    assert.ok(!kept.messages.some((line) => /backup/i.test(line)));
    await install(box.ctx, box.flags);
    const reset = await uninstall(box.ctx, { ...box.flags, removeSettings: true });
    for (const suffix of [BACKUP_SUFFIX, LAST_BACKUP_SUFFIX]) assert.equal(existsSync(`${settingsPath}${suffix}`), false, suffix);
    assert.ok(reset.messages.some((line) => /Removed Goblin Horde's backups of .*settings\.json/.test(line)), reset.messages.join("\n"));
    assert.equal(existsSync(join(box.claudeDir, "skills")), false);
    assert.deepEqual(settingsOf(box), userSettings);
  } finally { box.cleanup(); }
});

test("a full reset knows every file Goblin Horde, and earlier versions of it, keep in the state folder", () => {
  const dir = join(tmpdir(), "goblin-state-names");
  const named = new Set(stateFiles(dir).map((file) => basename(file)));
  for (const name of ["goblins.json", "pets.json", "pets.json.bak", "pets.lock", "pairing-code.txt", "shared.json", "remote.json", "remote-code.txt",
    "phone.json", "watched.json", "dismissed.json", "links.json", "activity.jsonl", "activity.1.jsonl", "goblin-horde.json", "server.log", "widget.log", "show-widget"])
    assert.ok(named.has(name), name);
});

test("uninstall keeps the saved pet game, and a full reset removes it with its backup", async () => {
  const box = sandbox();
  try {
    const config = loadConfig(join(sourceDir, "game_config.json"));
    const record = { schema: 1, state: createState(config, "2026-01-01"), sources: { t3: initialWatermark(0) }, lastSeenAt: 0 };
    const saveTwice = async () => {
      const store = createPetsStore({ dir: box.flags.stateDir });
      await store.save(record);
      await store.save(record); // The second save keeps the first as the backup.
    };
    await install(box.ctx, box.flags);
    await saveTwice();
    const saved = readdirSync(box.flags.stateDir).sort();
    assert.ok(saved.length >= 2, saved.join(", "));
    const kept = await uninstall(box.ctx, box.flags);
    assert.deepEqual(readdirSync(box.flags.stateDir).sort(), saved, "a plain uninstall keeps the saved game");
    assert.ok(kept.messages.some((line) => /Kept settings, the saved pet game/.test(line)), kept.messages.join("\n"));
    await install(box.ctx, box.flags);
    const reset = await uninstall(box.ctx, { ...box.flags, removeSettings: true });
    assert.equal(existsSync(box.flags.stateDir), false, "nothing of the saved game is left, so the state folder goes too");
    assert.ok(reset.messages.some((line) => /the saved pet game/.test(line)), reset.messages.join("\n"));
  } finally { box.cleanup(); }
});

test("uninstall run from inside the app folder still removes the folder", { timeout: 60_000 }, async () => {
  const box = sandbox();
  try {
    await install(box.ctx, { ...box.flags, skipSkill: true });
    const { installDir, stateDir } = box.flags;
    // Its own process, standing in the app folder as someone who changed into it would be.
    const run = spawnSync(process.execPath, [join(installDir, "goblin.mjs"), "uninstall", "--install-dir", installDir, "--state-dir", stateDir],
      { cwd: installDir, env: box.env, encoding: "utf8", windowsHide: true });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(installDir), false, run.stdout);
    assert.doesNotMatch(run.stdout, /remain in/);
  } finally { box.cleanup(); }
});

test("every command install prints for a custom install folder names that folder", async () => {
  const box = sandbox();
  try {
    const commands = (result) => result.messages.flatMap((line) => line.match(/node "[^"]*goblin\.mjs"[^.;)(]*/g) || []);
    const expected = managerCommand(box.ctx, box.flags.installDir);
    const flag = expected.slice(expected.indexOf(" --install-dir ") + 1);
    const result = await install(box.ctx, box.flags);
    assert.ok(commands(result).length > 0, result.messages.join("\n"));
    for (const command of commands(result)) assert.ok(command.includes(flag), command);
    assert.ok(!result.messages.some((line) => /\bnode goblin\.mjs\b/.test(line)), "never the bare source-folder command");
    // The installed skill tells an agent the same command.
    const skill = readFileSync(join(box.codexDir, "skills", "goblin-horde-manager", "SKILL.md"), "utf8");
    assert.ok(skill.includes(expected), skill.slice(0, 400));
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
    assert.equal(report.widget, null);
    // A port nothing listens on, so the check never talks to a real server on this computer.
    const probe = createServer(() => {});
    await new Promise((resolvePromise) => probe.listen(0, "127.0.0.1", resolvePromise));
    const { port } = probe.address();
    await new Promise((resolvePromise) => probe.close(resolvePromise));
    const code = await main(["doctor", "--json", "--install-dir", box.flags.installDir, "--state-dir", box.flags.stateDir, "--port", String(port)], box.ctx);
    assert.equal(code, 0);
    const doctorReport = JSON.parse(box.lines.at(-1));
    assert.deepEqual(doctorReport.checks.filter((check) => !check.group).map((check) => [check.name, check.state]), [["node", "ok"], ["port", "ok"], ["install", "ok"]]);
    assert.deepEqual(doctorReport.checks.filter((check) => check.group === "pets").map((check) => check.name), ["pets-node", "pets-t3", "pets-python"]);
    assert.deepEqual(doctorReport.checks.filter((check) => check.group === "update").map((check) => [check.name, check.state]),
      [["update-key", box.ctx.updateKey ? "ok" : "warning"], ["update-check", "ok"], ["update-last", "none"], ["update-ready", "none"]]);
    box.lines.length = 0;
    assert.equal(await main(["status", "--install-dir", box.flags.installDir, "--state-dir", box.flags.stateDir], box.ctx), 0);
    assert.deepEqual(box.lines.slice(1), ["Server: stopped", "Desktop goblins: stopped",
      box.ctx.updateKey ? "Updates: the game looks on github.com once a day (update --off turns that off)." : "Updates: this build has no update key, so it cannot check for updates.",
      "Last update check: none yet."]);
  } finally { box.cleanup(); }
});

test("argument parsing rejects unknown options, the monitor's among them", () => {
  assert.deepEqual(parseArgs(["install", "--port=5000", "--no-start"]).flags, { port: "5000", "no-start": true });
  for (const option of ["--force", "--surface", "--ui", "--claude-hooks", "--no-claude-hooks", "--thread", "--demo", "--compact", "--no-browser", "--report"])
    assert.throws(() => parseArgs(["install", option, "x"]), /Unknown option/, option);
  assert.throws(() => parseArgs(["install", "--install-dir"]), /needs a value/);
});

test("the monitor's commands are gone", async () => {
  const box = sandbox();
  try {
    for (const command of ["hooks", "open", "app", "emit", "setup", "autostart"])
      await assert.rejects(main([command, "--install-dir", box.flags.installDir], box.ctx), new RegExp(`Unknown command "${command}"`));
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

test("install adds a Start menu entry and takes out this copy's old sign-in shortcut; uninstall removes the entry", async () => {
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
    assert.equal(existsSync(startup), false, "nothing starts at sign-in");
    assert.equal(result.startMenu, true);
    assert.match(written[0].spec.args, /goblin\.mjs" start --install-dir "[^"]+"$/);
    assert.equal(written[0].spec.icon, join(box.flags.installDir, "goblin.ico"));

    // An earlier version of this copy started the goblin strip at sign-in.
    box.ctx.writeShortcut(startup, { target: "launch.cmd", args: `"${join(box.flags.installDir, "goblin.mjs")}" start --install-dir "${box.flags.installDir}" --surface strip` });
    const again = await install(box.ctx, box.flags);
    assert.equal(existsSync(startup), false);
    assert.ok(again.messages.some((line) => /Removed the sign-in shortcut an earlier version added/.test(line)), again.messages.join("\n"));
    // Another copy's sign-in shortcut is that copy's.
    box.ctx.writeShortcut(startup, { target: "launch.cmd", args: `"C:\\Other\\GoblinHorde\\goblin.mjs" start --surface strip` });
    await install(box.ctx, box.flags);
    assert.equal(existsSync(startup), true);

    await uninstall(box.ctx, box.flags);
    assert.equal(existsSync(menu), false);
    assert.equal(existsSync(startup), true, "and uninstall leaves it too");
  } finally { box.cleanup(); }
});

test("uninstall leaves another installation's shortcuts alone", async () => {
  const box = sandbox();
  try {
    box.env.APPDATA = join(box.root, "roaming");
    box.ctx.writeShortcut = () => { throw new Error("no shortcut writer here"); };
    const result = await install(box.ctx, box.flags);
    assert.equal(result.startMenu, false);
    assert.ok(result.messages.some((line) => /Could not add the Start menu entry \(no shortcut writer here\)/.test(line)));
    const menu = join(box.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Goblin Horde.lnk");
    mkdirSync(dirname(menu), { recursive: true });
    writeFileSync(menu, Buffer.from("C:\\Other\\GoblinHorde\\goblin.mjs start", "utf16le"));
    await uninstall(box.ctx, box.flags);
    assert.equal(existsSync(menu), true);
  } finally { box.cleanup(); }
});
