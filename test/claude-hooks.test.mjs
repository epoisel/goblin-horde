import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUP_SUFFIX, HOOK_EVENTS, HOOK_MARKER, HookSettingsError, LAST_BACKUP_SUFFIX, addGoblinHooks, claudeHookReport, goblinHookStatus, hookHandler,
  installClaudeHooks, removeGoblinHooks, uninstallClaudeHooks,
} from "../lib/claude-hooks.mjs";

const handler = hookHandler({ nodePath: "/opt/node/bin/node", hookPath: "/opt/goblin horde/claude-hook.mjs", stateDir: "/var/goblin" });

// Someone's real-looking settings: unrelated keys, their own hooks on shared events, and an event we never touch.
const existing = () => ({
  model: "opus",
  permissions: { allow: ["Bash(npm test)"], deny: [] },
  env: { SOME_FLAG: "1" },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "~/.claude/hooks/guard.sh", timeout: 30 }] }],
    Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
    PreCompact: [{ matcher: "manual", hooks: [{ type: "command", command: "echo compact" }] }],
  },
  statusLine: { type: "command", command: "status.sh" },
});

test("hook handlers use exec form with absolute paths and a removal marker", () => {
  assert.equal(handler.type, "command");
  assert.equal(handler.command, "/opt/node/bin/node");
  assert.deepEqual(handler.args, ["/opt/goblin horde/claude-hook.mjs", HOOK_MARKER, "--state-dir", "/var/goblin"]);
  assert.equal(handler.async, true);
});

test("adding hooks keeps every unrelated setting and hook in place", () => {
  const before = existing();
  const after = addGoblinHooks(before, handler);
  assert.deepEqual(before, existing(), "the input is not mutated");
  assert.equal(after.model, "opus");
  assert.deepEqual(after.permissions, before.permissions);
  assert.deepEqual(after.statusLine, before.statusLine);
  assert.deepEqual(after.hooks.PreCompact, before.hooks.PreCompact);
  // The person's own groups stay first and unchanged.
  assert.deepEqual(after.hooks.PreToolUse[0], before.hooks.PreToolUse[0]);
  assert.deepEqual(after.hooks.Stop[0], before.hooks.Stop[0]);
  for (const { event, matcher } of HOOK_EVENTS) {
    const ours = after.hooks[event].at(-1);
    assert.deepEqual(ours.hooks, [handler], event);
    assert.equal(ours.matcher, matcher ? "*" : undefined, event);
  }
  assert.equal(goblinHookStatus(after).state, "installed");
});

const linux = { platform: "linux" };
const goblinGroups = (settings, event) => settings.hooks[event].filter((group) => group.hooks.some((item) => item.args?.includes(HOOK_MARKER)));

test("adding twice is idempotent and refreshes this installation's Node path", () => {
  const once = addGoblinHooks(existing(), handler, linux);
  const newerNode = hookHandler({ nodePath: "/usr/bin/node", hookPath: "/opt/goblin horde/claude-hook.mjs", stateDir: "/var/goblin" });
  const twice = addGoblinHooks(addGoblinHooks(once, handler, linux), newerNode, linux);
  for (const { event } of HOOK_EVENTS) {
    const ours = goblinGroups(twice, event);
    assert.equal(ours.length, 1, event);
    assert.equal(ours[0].hooks[0].command, "/usr/bin/node");
  }
});

test("two installations sharing one settings file never add over or remove each other's hooks", () => {
  const a = hookHandler({ nodePath: "/n", hookPath: "/apps/a/claude-hook.mjs", stateDir: "/state/a" });
  const b = hookHandler({ nodePath: "/n", hookPath: "/apps/b/claude-hook.mjs", stateDir: "/state/b" });
  const both = addGoblinHooks(addGoblinHooks(existing(), a, linux), b, linux);
  for (const { event } of HOOK_EVENTS) {
    assert.deepEqual(goblinGroups(both, event).map((group) => group.hooks[0].args[0]), ["/apps/a/claude-hook.mjs", "/apps/b/claude-hook.mjs"], event);
  }
  assert.equal(goblinHookStatus(both, { hookPath: "/apps/a/claude-hook.mjs", ...linux }).state, "installed");

  // Removing A leaves exactly what installing only B would have produced.
  const withoutA = removeGoblinHooks(both, { hookPath: "/apps/a/claude-hook.mjs", ...linux });
  assert.equal(withoutA.removed, HOOK_EVENTS.length);
  assert.deepEqual(withoutA.settings, addGoblinHooks(existing(), b, linux));
  assert.equal(goblinHookStatus(withoutA.settings, { hookPath: "/apps/a/claude-hook.mjs", ...linux }).state, "missing");
  assert.equal(goblinHookStatus(withoutA.settings, { hookPath: "/apps/b/claude-hook.mjs", ...linux }).state, "installed");

  // Look-alike receivers are someone else's.
  for (const lookalike of ["/apps/a/claude-hook.mjs.bak", "/apps/a-old/claude-hook.mjs", "/apps/claude-hook.mjs", "/APPS/B/claude-hook.mjs"]) {
    assert.equal(removeGoblinHooks(withoutA.settings, { hookPath: lookalike, ...linux }).removed, 0, lookalike);
  }
  // On Windows the same receiver may be written with other letter case or slashes.
  const win = hookHandler({ nodePath: "C:\\node\\node.exe", hookPath: "c:\\apps\\a\\claude-hook.mjs" });
  const onWindows = addGoblinHooks(existing(), win, { platform: "win32" });
  assert.equal(removeGoblinHooks(onWindows, { hookPath: "C:/Apps/A/claude-hook.mjs", platform: "win32" }).removed, HOOK_EVENTS.length);
  assert.equal(removeGoblinHooks(onWindows, { hookPath: "C:\\Apps\\B\\claude-hook.mjs", platform: "win32" }).removed, 0);

  // The older single-command form is matched by its receiver too.
  const legacy = { hooks: { Stop: [{ hooks: [
    { type: "command", command: `node "/apps/a/claude-hook.mjs" ${HOOK_MARKER}` },
    { type: "command", command: `node "/apps/b/claude-hook.mjs" ${HOOK_MARKER}` },
  ] }] } };
  const legacyWithoutA = removeGoblinHooks(legacy, { hookPath: "/apps/a/claude-hook.mjs", ...linux });
  assert.equal(legacyWithoutA.removed, 1);
  assert.match(legacyWithoutA.settings.hooks.Stop[0].hooks[0].command, /\/apps\/b\//);

  // Removing from a file always names the installation.
  assert.throws(() => uninstallClaudeHooks({ settingsPath: "/nowhere/settings.json" }), /receiver path/);
});

test("removing restores the original settings exactly", () => {
  const original = existing();
  const { settings, removed } = removeGoblinHooks(addGoblinHooks(original, handler));
  assert.equal(removed, HOOK_EVENTS.length);
  assert.deepEqual(settings, original);
});

test("removing from a shared group keeps the other handlers and drops only emptied events", () => {
  const shared = { hooks: { Notification: [{ matcher: "*", hooks: [{ type: "command", command: "notify-send hi" }, handler] }], Stop: [{ hooks: [handler] }] } };
  const { settings, removed } = removeGoblinHooks(shared);
  assert.equal(removed, 2);
  assert.deepEqual(settings, { hooks: { Notification: [{ matcher: "*", hooks: [{ type: "command", command: "notify-send hi" }] }] } });
  const onlyOurs = removeGoblinHooks({ theme: "dark", hooks: { Stop: [{ hooks: [handler] }] } });
  assert.deepEqual(onlyOurs.settings, { theme: "dark" });
});

test("an older single-command Goblin Horde hook is also recognised for removal", () => {
  const legacy = { hooks: { Stop: [{ hooks: [{ type: "command", command: `node "/x/claude-hook.mjs" ${HOOK_MARKER}` }] }] } };
  assert.equal(removeGoblinHooks(legacy).removed, 1);
});

test("settings that are not shaped like Claude Code settings are refused, not rewritten", () => {
  assert.throws(() => addGoblinHooks([], handler), HookSettingsError);
  assert.throws(() => addGoblinHooks({ hooks: [] }, handler), HookSettingsError);
  assert.throws(() => addGoblinHooks({ hooks: { PreToolUse: { matcher: "*" } } }, handler), /hooks\.PreToolUse/);
});

test("file install and uninstall round-trip, with a backup and without touching other keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "goblin-hooks-"));
  try {
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify(existing(), null, 4));
    const result = installClaudeHooks({ settingsPath, nodePath: "/opt/node", hookPath: "/opt/app/claude-hook.mjs", stateDir: "/var/goblin" });
    assert.equal(result.changed, true);
    assert.ok(existsSync(`${settingsPath}${BACKUP_SUFFIX}`));
    assert.deepEqual(JSON.parse(readFileSync(`${settingsPath}${BACKUP_SUFFIX}`, "utf8")), existing());
    assert.equal(installClaudeHooks({ settingsPath, nodePath: "/opt/node", hookPath: "/opt/app/claude-hook.mjs", stateDir: "/var/goblin" }).changed, false);
    const report = claudeHookReport(settingsPath);
    assert.equal(report.state, "installed");
    assert.equal(report.broken, true, "the fake node path does not exist on this computer");
    // Another installation's receiver removes nothing.
    assert.equal(uninstallClaudeHooks({ settingsPath, hookPath: "/opt/other/claude-hook.mjs" }).changed, false);
    const removed = uninstallClaudeHooks({ settingsPath, hookPath: "/opt/app/claude-hook.mjs" });
    assert.equal(removed.removed, HOOK_EVENTS.length);
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), existing());
    assert.equal(uninstallClaudeHooks({ settingsPath, hookPath: "/opt/app/claude-hook.mjs" }).changed, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("install, remove, install keeps the original backup and refreshes only the latest one", () => {
  const dir = mkdtempSync(join(tmpdir(), "goblin-hooks-"));
  try {
    const settingsPath = join(dir, "settings.json");
    const options = { settingsPath, nodePath: "/opt/node", hookPath: "/opt/app/claude-hook.mjs" };
    writeFileSync(settingsPath, JSON.stringify(existing()));
    installClaudeHooks(options);
    const installed = readFileSync(settingsPath, "utf8");
    uninstallClaudeHooks(options);
    // The person edits their settings between runs; the original backup must still be the first file.
    writeFileSync(settingsPath, JSON.stringify({ ...existing(), model: "sonnet" }));
    installClaudeHooks(options);
    assert.deepEqual(JSON.parse(readFileSync(`${settingsPath}${BACKUP_SUFFIX}`, "utf8")), existing());
    assert.equal(JSON.parse(readFileSync(`${settingsPath}${LAST_BACKUP_SUFFIX}`, "utf8")).model, "sonnet");
    assert.notEqual(readFileSync(`${settingsPath}${LAST_BACKUP_SUFFIX}`, "utf8"), installed);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a missing settings file is created with only the Goblin Horde hooks", () => {
  const dir = mkdtempSync(join(tmpdir(), "goblin-hooks-"));
  try {
    const settingsPath = join(dir, "nested", "settings.json");
    installClaudeHooks({ settingsPath, nodePath: "/n", hookPath: "/h" });
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(settingsPath, "utf8"))), ["hooks"]);
    uninstallClaudeHooks({ settingsPath, hookPath: "/h" });
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("malformed settings.json fails with a reason and is left byte-for-byte unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "goblin-hooks-"));
  try {
    const settingsPath = join(dir, "settings.json");
    const broken = "{\n  \"model\": \"opus\",\n  // a comment Claude Code would not accept\n}";
    writeFileSync(settingsPath, broken);
    assert.throws(() => installClaudeHooks({ settingsPath, nodePath: "/n", hookPath: "/h" }), /not valid JSON/);
    assert.throws(() => uninstallClaudeHooks({ settingsPath, hookPath: "/h" }), HookSettingsError);
    assert.equal(readFileSync(settingsPath, "utf8"), broken);
    assert.equal(existsSync(`${settingsPath}${BACKUP_SUFFIX}`), false);
    assert.equal(claudeHookReport(settingsPath).state, "unreadable");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
