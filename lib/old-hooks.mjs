/**
 * Take out the Claude Code hook entries an earlier Goblin Horde added to the user's settings.json.
 *
 * Earlier versions could add hooks that ran this installation's claude-hook.mjs on every Claude Code event. That
 * file no longer ships, and a hook that runs a missing file makes Claude Code report an error on every tool call,
 * so install, start, and uninstall take this installation's entries out. Nothing adds a hook any more.
 *
 * Only handlers that carry HOOK_MARKER and run this installation's own claude-hook.mjs are removed, so another
 * installation that shares the settings file keeps its entries. Every other setting, hook, and matcher group stays
 * as it was, in its order. A file that is missing, cannot be read, or is not a JSON object shaped the way Claude
 * Code documents it is left untouched. A changed file keeps the person's first file beside it as BACKUP_SUFFIX,
 * and the file from just before the latest change as LAST_BACKUP_SUFFIX.
 */
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { samePath } from "./paths.mjs";

export const HOOK_MARKER = "--goblin-horde-hook";
export const HOOK_RECEIVER = "claude-hook.mjs";
export const BACKUP_SUFFIX = ".goblin-horde-backup";
export const LAST_BACKUP_SUFFIX = ".goblin-horde-backup.last";

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const claudeSettingsPath = (claudeDir) => join(claudeDir, "settings.json");

/**
 * Whether `handler` is one Goblin Horde added for the receiver at `hookPath`: the exec form (command and args), or
 * the older single-command form, in which the receiver must appear whole, quoted or bare.
 */
export function isGoblinHandler(handler, { hookPath, platform = process.platform }) {
  if (!isObject(handler)) return false;
  if (Array.isArray(handler.args) && handler.args.includes(HOOK_MARKER)) {
    return typeof handler.args[0] === "string" && handler.args[0] !== "" && samePath(handler.args[0], hookPath, platform);
  }
  if (typeof handler.command !== "string" || !handler.command.includes(HOOK_MARKER)) return false;
  const fold = (text) => (platform === "win32" ? text.replace(/\//g, "\\").toLowerCase() : text);
  const command = fold(handler.command);
  const target = fold(hookPath);
  return [`"${target}"`, `'${target}'`, ` ${target} `].some((form) => command.includes(form));
}

/**
 * `settings` without the handlers of the receiver at `hookPath`, and how many were removed. Pure. A group that
 * held only such handlers goes, an event left with no group goes, and so does a hooks object left empty.
 */
export function removeGoblinHooks(settings, scope) {
  if (!isObject(settings.hooks)) return { settings, removed: 0 };
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
      if (handlers.length) kept.push({ ...group, hooks: handlers });
    }
    if (touched && !kept.length) continue;
    hooks[event] = kept;
  }
  if (!removed) return { settings, removed };
  const next = { ...settings, hooks };
  if (!Object.keys(hooks).length) delete next.hooks;
  return { settings: next, removed };
}

/**
 * Remove the entries that run the receiver at `hookPath` from the settings file at `settingsPath`. Never throws.
 * `removed` counts them. `error` says why entries that were found could not be written out of the file, or is "".
 * @returns {{ removed: number, error: string }}
 */
export function removeOldHooks({ settingsPath, hookPath, platform = process.platform }) {
  let text;
  let settings;
  try {
    text = readFileSync(settingsPath, "utf8");
    settings = JSON.parse(text.replace(/^﻿/, ""));
  } catch { return { removed: 0, error: "" }; }
  if (!isObject(settings) || (settings.hooks !== undefined && !isObject(settings.hooks))) return { removed: 0, error: "" };
  const { settings: next, removed } = removeGoblinHooks(settings, { hookPath, platform });
  if (!removed) return { removed: 0, error: "" };
  const temp = `${settingsPath}.goblin-horde-${process.pid}.tmp`;
  try {
    if (!existsSync(`${settingsPath}${BACKUP_SUFFIX}`)) copyFileSync(settingsPath, `${settingsPath}${BACKUP_SUFFIX}`);
    copyFileSync(settingsPath, `${settingsPath}${LAST_BACKUP_SUFFIX}`);
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, settingsPath);
  } catch (error) {
    rmSync(temp, { force: true });
    return { removed: 0, error: error.code || error.message };
  }
  return { removed, error: "" };
}
