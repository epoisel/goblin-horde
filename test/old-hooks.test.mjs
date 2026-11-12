/**
 * Taking out the Claude Code hook entries earlier versions added, from settings written the way those versions
 * wrote them. Every file is in a temporary folder.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUP_SUFFIX, HOOK_MARKER, LAST_BACKUP_SUFFIX, removeGoblinHooks, removeOldHooks } from "../lib/old-hooks.mjs";

// The twelve events an earlier version hooked, and whether each took a matcher.
const EVENTS = [["SessionStart", true], ["SessionEnd", true], ["UserPromptSubmit", false], ["PreToolUse", true], ["PostToolUse", true],
  ["PostToolUseFailure", true], ["PermissionRequest", true], ["Notification", true], ["SubagentStart", true], ["SubagentStop", true], ["Stop", false],
  ["StopFailure", true]];
const OURS = "C:\\Users\\you\\AppData\\Local\\Programs\\GoblinHorde\\claude-hook.mjs";
const THEIRS = "D:\\Apps\\GoblinHorde\\claude-hook.mjs";
const windows = { hookPath: OURS, platform: "win32" };

/** One handler as an earlier version wrote it: exec form, the receiver first, then the marker. */
const handler = (hookPath) => ({ type: "command", command: "C:\\Program Files\\nodejs\\node.exe", args: [hookPath, HOOK_MARKER, "--state-dir", "C:\\state"], async: true, timeout: 10 });
/** Settings with one group per event for each receiver, after the person's own groups. */
function withHooks(settings, ...receivers) {
  const hooks = { ...(settings.hooks || {}) };
  for (const hookPath of receivers) {
    for (const [event, matcher] of EVENTS) hooks[event] = [...(hooks[event] || []), matcher ? { matcher: "*", hooks: [handler(hookPath)] } : { hooks: [handler(hookPath)] }];
  }
  return { ...settings, hooks };
}
// Someone's real-looking settings: unrelated keys, their own hooks on shared events, and an event Goblin Horde never touched.
const own = () => ({
  model: "opus",
  permissions: { allow: ["Bash(npm test)"], deny: [] },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.cmd", timeout: 30 }] }],
    Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
    PreCompact: [{ matcher: "manual", hooks: [{ type: "command", command: "echo compact" }] }],
  },
  statusLine: { type: "command", command: "status.cmd" },
});

test("only this installation's entries go: the person's own hooks and another installation's stay as they were", () => {
  const { settings, removed } = removeGoblinHooks(withHooks(own(), OURS, THEIRS), windows);
  assert.equal(removed, EVENTS.length);
  assert.deepEqual(settings, withHooks(own(), THEIRS), "exactly what the other installation alone would have left");
  assert.deepEqual(removeGoblinHooks(withHooks(own(), OURS), windows), { settings: own(), removed: EVENTS.length }, "and with ours alone, the person's settings exactly");
});

test("this installation's receiver is matched however Windows spells it, and a look-alike is someone else's", () => {
  for (const spelling of ["c:\\users\\YOU\\appdata\\local\\programs\\goblinhorde\\claude-hook.mjs", "C:/Users/you/AppData/Local/Programs/GoblinHorde/claude-hook.mjs"])
    assert.equal(removeGoblinHooks(withHooks(own(), spelling), windows).removed, EVENTS.length, spelling);
  for (const lookalike of [`${OURS}.bak`, OURS.replace("GoblinHorde", "GoblinHorde-old"), "C:\\Users\\you\\AppData\\Local\\Programs\\claude-hook.mjs"])
    assert.equal(removeGoblinHooks(withHooks(own(), lookalike), windows).removed, 0, lookalike);
  // A handler that runs our receiver without the marker was not added by Goblin Horde.
  const unmarked = { hooks: { Stop: [{ hooks: [{ type: "command", command: "node", args: [OURS] }] }] } };
  assert.equal(removeGoblinHooks(unmarked, windows).removed, 0);
});

test("the older single-command form is matched by its receiver too, and a shared group keeps its other handlers", () => {
  const legacy = { hooks: { Stop: [{ hooks: [
    { type: "command", command: `node "${OURS}" ${HOOK_MARKER}` },
    { type: "command", command: `node "${THEIRS}" ${HOOK_MARKER}` },
    { type: "command", command: "say done" },
  ] }], Notification: [{ matcher: "*", hooks: [handler(OURS)] }] } };
  const { settings, removed } = removeGoblinHooks(legacy, windows);
  assert.equal(removed, 2);
  assert.deepEqual(settings, { hooks: { Stop: [{ hooks: [{ type: "command", command: `node "${THEIRS}" ${HOOK_MARKER}` }, { type: "command", command: "say done" }] }] } },
    "the emptied event is gone, and the shared group keeps the rest in order");
  assert.deepEqual(removeGoblinHooks({ theme: "dark", hooks: { Stop: [{ hooks: [handler(OURS)] }] } }, windows).settings, { theme: "dark" }, "an emptied hooks object goes too");
});

function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), "goblin-old-hooks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the file loses only this installation's entries, keeps the person's first file as a backup, and is left alone after", (t) => {
  const dir = folder(t);
  const settingsPath = join(dir, "settings.json");
  const before = JSON.stringify(withHooks(own(), OURS, THEIRS), null, 4);
  writeFileSync(settingsPath, before);
  assert.deepEqual(removeOldHooks({ settingsPath, ...windows }), { removed: EVENTS.length, error: "" });
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), withHooks(own(), THEIRS));
  assert.equal(readFileSync(`${settingsPath}${BACKUP_SUFFIX}`, "utf8"), before, "the file as it was, byte for byte");
  assert.equal(readFileSync(`${settingsPath}${LAST_BACKUP_SUFFIX}`, "utf8"), before);
  const after = readFileSync(settingsPath, "utf8");
  assert.deepEqual(removeOldHooks({ settingsPath, ...windows }), { removed: 0, error: "" });
  assert.equal(readFileSync(settingsPath, "utf8"), after, "with nothing of ours left, the file is not written again");
  assert.deepEqual(readdirSync(dir).sort(), ["settings.json", `settings.json${BACKUP_SUFFIX}`, `settings.json${LAST_BACKUP_SUFFIX}`], "and no temp file is left");

  // An earlier first backup is the person's own file, and it is never written over.
  writeFileSync(settingsPath, JSON.stringify(withHooks({ model: "sonnet" }, OURS)));
  assert.equal(removeOldHooks({ settingsPath, ...windows }).removed, EVENTS.length);
  assert.equal(readFileSync(`${settingsPath}${BACKUP_SUFFIX}`, "utf8"), before);
  assert.equal(JSON.parse(readFileSync(`${settingsPath}${LAST_BACKUP_SUFFIX}`, "utf8")).model, "sonnet");
});

test("a missing file, one that is not JSON, and one not shaped like Claude Code settings are left untouched, and nothing throws", (t) => {
  const dir = folder(t);
  assert.deepEqual(removeOldHooks({ settingsPath: join(dir, "missing", "settings.json"), ...windows }), { removed: 0, error: "" });
  const ourEntry = JSON.stringify(handler(OURS));
  for (const [name, text] of [["comment.json", `{\n  "model": "opus",\n  // a comment\n  "hooks": { "Stop": [{ "hooks": [${ourEntry}] }] }\n}`],
    ["list.json", `[${ourEntry}]`], ["hooks-list.json", `{ "hooks": [{ "hooks": [${ourEntry}] }] }`], ["empty.json", ""]]) {
    const settingsPath = join(dir, name);
    writeFileSync(settingsPath, text);
    assert.deepEqual(removeOldHooks({ settingsPath, ...windows }), { removed: 0, error: "" }, name);
    assert.equal(readFileSync(settingsPath, "utf8"), text, `${name} is byte for byte as it was`);
    assert.equal(existsSync(`${settingsPath}${BACKUP_SUFFIX}`), false, `${name} has no backup`);
  }
});

test("entries that cannot be written out say why, and the file is left as it was", (t) => {
  const dir = folder(t);
  const settingsPath = join(dir, "settings.json");
  const text = JSON.stringify(withHooks(own(), OURS));
  writeFileSync(settingsPath, text);
  // A folder where the latest backup belongs: the copy fails before the settings file is touched.
  mkdirSync(`${settingsPath}${LAST_BACKUP_SUFFIX}`);
  const failed = removeOldHooks({ settingsPath, ...windows });
  assert.equal(failed.removed, 0);
  assert.match(failed.error, /\S/, "a reason, such as the error's code");
  assert.equal(readFileSync(settingsPath, "utf8"), text);
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), [], "no temp file is left");
});
