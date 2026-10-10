/**
 * Add and remove Goblin Horde's Claude Code hooks in the user's settings.json.
 *
 * Only handlers carrying HOOK_MARKER and running this installation's own receiver are ever
 * changed, so two installations sharing one settings file never remove each other's hooks. Every other setting, hook, and matcher
 * group is kept as it was, in its original order. Settings that cannot be read as a JSON object,
 * or whose hooks are not shaped the way Claude Code documents them, are left untouched and the
 * operation fails with a reason the person can act on.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { samePath } from "./paths.mjs";

export const HOOK_MARKER = "--goblin-horde-hook";
export const BACKUP_SUFFIX = ".goblin-horde-backup";

/** The Claude Code hook events the receiver understands; `matcher` marks events that accept one. */
export const HOOK_EVENTS = Object.freeze([
  { event: "SessionStart", matcher: true },
  { event: "SessionEnd", matcher: true },
  { event: "UserPromptSubmit", matcher: false },
  { event: "PreToolUse", matcher: true },
  { event: "PostToolUse", matcher: true },
  { event: "PostToolUseFailure", matcher: true },
  { event: "PermissionRequest", matcher: true },
  { event: "Notification", matcher: true },
  { event: "SubagentStart", matcher: true },
  { event: "SubagentStop", matcher: true },
  { event: "Stop", matcher: false },
  { event: "StopFailure", matcher: true },
]);

export class HookSettingsError extends Error {
  constructor(message) {
    super(message);
    this.name = "HookSettingsError";
  }
}

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const claudeSettingsPath = (claudeDir) => join(claudeDir, "settings.json");

/**
 * One exec-form command handler. Exec form (command + args) starts Node directly with no shell,
 * so paths with spaces work the same in Git Bash, PowerShell, zsh, and bash. It runs async so
 * Claude Code never waits on it.
 */
export function hookHandler({ nodePath, hookPath, stateDir = "" }) {
  if (!nodePath || !hookPath) throw new Error("The hook needs absolute Node and receiver paths.");
  return {
    type: "command",
    command: nodePath,
    args: [hookPath, HOOK_MARKER, ...(stateDir ? ["--state-dir", stateDir] : [])],
    async: true,
    timeout: 10,
  };
}

/**
 * A handler Goblin Horde added, in exec form or in an older single-command form. With `hookPath`,
 * only a handler that runs exactly that receiver counts, so one installation never touches the
 * hooks of another installation that shares the same Claude Code settings.
 */
export function isGoblinHandler(handler, { hookPath = "", platform = process.platform } = {}) {
  if (!isObject(handler)) return false;
  if (Array.isArray(handler.args) && handler.args.includes(HOOK_MARKER)) {
    return !hookPath || (typeof handler.args[0] === "string" && handler.args[0] !== "" && samePath(handler.args[0], hookPath, platform));
  }
  if (typeof handler.command !== "string" || !handler.command.includes(HOOK_MARKER)) return false;
  if (!hookPath) return true;
  // Older form: node "<receiver>" --goblin-horde-hook. The receiver must appear whole, quoted or bare.
  const fold = (text) => (platform === "win32" ? text.replace(/\//g, "\\").toLowerCase() : platform === "darwin" ? text.toLowerCase() : text);
  const command = fold(handler.command);
  const target = fold(hookPath);
  return [`"${target}"`, `'${target}'`, ` ${target} `].some((form) => command.includes(form));
}

function checkShape(settings) {
  if (!isObject(settings)) throw new HookSettingsError("Claude Code settings.json is not a JSON object.");
  if (settings.hooks === undefined) return;
  if (!isObject(settings.hooks)) throw new HookSettingsError("Claude Code settings.json has a \"hooks\" value that is not an object.");
  for (const { event } of HOOK_EVENTS) {
    const groups = settings.hooks[event];
    if (groups !== undefined && !Array.isArray(groups))
      throw new HookSettingsError(`Claude Code settings.json has a "hooks.${event}" value that is not a list.`);
  }
}

/**
 * Remove Goblin Horde handlers. Pure: returns a new settings object and how many were removed.
 * With `hookPath`, only the handlers of the installation whose receiver is at that path go.
 */
export function removeGoblinHooks(settings, scope = {}) {
  checkShape(settings);
  if (!settings.hooks) return { settings, removed: 0 };
  let removed = 0;
  const hooks = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) { hooks[event] = groups; continue; }
    const kept = [];
    let touched = false;
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) { kept.push(group); continue; }
      const handlers = group.hooks.filter((handler) => !isGoblinHandler(handler, scope));
      const gone = group.hooks.length - handlers.length;
      if (!gone) { kept.push(group); continue; }
      removed += gone;
      touched = true;
      // A group that held only our handlers goes away; a shared group keeps its other handlers.
      if (handlers.length) kept.push({ ...group, hooks: handlers });
    }
    if (touched && !kept.length) continue;
    hooks[event] = kept;
  }
  const next = { ...settings };
  if (Object.keys(hooks).length || !removed) next.hooks = hooks;
  else delete next.hooks;
  return { settings: removed ? next : settings, removed };
}

/**
 * Add one group per event for the given handler, replacing this installation's earlier groups
 * (same receiver, perhaps another Node or state folder). Other installations' groups stay. Pure.
 */
export function addGoblinHooks(settings, handler, { platform = process.platform } = {}) {
  const base = removeGoblinHooks(settings ?? {}, { hookPath: handler.args[0], platform }).settings;
  const hooks = { ...(base.hooks || {}) };
  for (const { event, matcher } of HOOK_EVENTS) {
    const group = matcher ? { matcher: "*", hooks: [{ ...handler }] } : { hooks: [{ ...handler }] };
    hooks[event] = [...(hooks[event] || []), group];
  }
  return { ...base, hooks };
}

/** Which Goblin Horde hooks are present (for one receiver, with `hookPath`), and where their handler points. */
export function goblinHookStatus(settings, scope = {}) {
  const events = [];
  const handlers = [];
  if (isObject(settings) && isObject(settings.hooks)) {
    for (const { event } of HOOK_EVENTS) {
      const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
      const found = groups.flatMap((group) => (isObject(group) && Array.isArray(group.hooks) ? group.hooks : []))
        .filter((handler) => isGoblinHandler(handler, scope));
      if (found.length) { events.push(event); handlers.push(...found); }
    }
  }
  const missing = HOOK_EVENTS.map(({ event }) => event).filter((event) => !events.includes(event));
  const state = !events.length ? "missing" : missing.length ? "partial" : "installed";
  const first = handlers[0];
  return {
    state, events, missing, disabled: isObject(settings) && settings.disableAllHooks === true,
    nodePath: first?.command || "", hookPath: Array.isArray(first?.args) ? String(first.args[0] || "") : "",
  };
}

/** Read settings.json. A missing file is an empty object; anything unreadable is an error with a reason. */
export function readClaudeSettings(file) {
  if (!existsSync(file)) return { exists: false, settings: {} };
  let text;
  try { text = readFileSync(file, "utf8"); }
  catch (error) { throw new HookSettingsError(`Could not read ${file}: ${error.code || error.message}.`); }
  if (!text.trim()) return { exists: true, settings: {} };
  let settings;
  try { settings = JSON.parse(text.replace(/^﻿/, "")); }
  catch { throw new HookSettingsError(`${file} is not valid JSON, so it was left unchanged. Fix or remove the broken text, then try again.`); }
  checkShape(settings);
  return { exists: true, settings, text };
}

/** Write through a temporary file and keep one copy of the previous file beside it. */
function writeClaudeSettings(file, settings, previousText) {
  mkdirSync(dirname(file), { recursive: true });
  if (previousText !== undefined) copyFileSync(file, `${file}${BACKUP_SUFFIX}`);
  const temp = `${file}.goblin-horde-${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

export function installClaudeHooks({ settingsPath, nodePath, hookPath, stateDir, platform = process.platform }) {
  const { settings, text } = readClaudeSettings(settingsPath);
  const next = addGoblinHooks(settings, hookHandler({ nodePath, hookPath, stateDir }), { platform });
  if (JSON.stringify(next) === JSON.stringify(settings)) return { changed: false, settingsPath };
  writeClaudeSettings(settingsPath, next, text);
  return { changed: true, settingsPath, events: HOOK_EVENTS.map(({ event }) => event) };
}

/** Remove one installation's hooks: `hookPath` is required so another installation's hooks stay. */
export function uninstallClaudeHooks({ settingsPath, hookPath, platform = process.platform }) {
  if (!hookPath) throw new Error("Removing hooks needs the receiver path of the installation they belong to.");
  if (!existsSync(settingsPath)) return { changed: false, removed: 0, settingsPath };
  const { settings, text } = readClaudeSettings(settingsPath);
  const { settings: next, removed } = removeGoblinHooks(settings, { hookPath, platform });
  if (!removed) return { changed: false, removed: 0, settingsPath };
  writeClaudeSettings(settingsPath, next, text);
  return { changed: true, removed, settingsPath };
}

/** Status for doctor and the viewer; never throws. With `hookPath`, only that installation's hooks count. */
export function claudeHookReport(settingsPath, scope = {}) {
  try {
    const { exists, settings } = readClaudeSettings(settingsPath);
    const status = goblinHookStatus(settings, scope);
    // Hooks from another Goblin Horde installation are reported, never counted as this one's.
    const otherInstall = Boolean(scope.hookPath) && !status.events.length && goblinHookStatus(settings).events.length > 0;
    const broken = status.state !== "missing" && (!existsSync(status.nodePath) || !existsSync(status.hookPath));
    return { settingsPath, exists, ...status, broken, otherInstall, error: "" };
  } catch (error) {
    return { settingsPath, exists: true, state: "unreadable", events: [], missing: [], disabled: false, broken: false, otherInstall: false, error: error.message };
  }
}
