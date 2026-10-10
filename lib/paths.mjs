/**
 * Per-user locations for Goblin Horde on Windows, macOS, and Linux.
 *
 * Every function takes { env, platform, home } so tests can describe another computer without
 * touching this one. Explicit absolute overrides always win; relative ones are ignored.
 */
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { goblinStateDir } from "./claude.mjs";

export { goblinStateDir };

export const PRODUCT = "GoblinHorde";
export const DEFAULT_PORT = 43917;

const defaults = (options = {}) => ({ env: process.env, platform: process.platform, home: homedir(), ...options });
export const pathFor = (platform) => (platform === "win32" ? win32 : posix);

function absolute(value, platform) {
  return typeof value === "string" && value.trim() && pathFor(platform).isAbsolute(value) ? pathFor(platform).normalize(value) : "";
}

/** Where the app files are copied. Kept apart from state so removing the app never touches settings. */
export function defaultInstallDir(options) {
  const { env, platform, home } = defaults(options);
  const path = pathFor(platform);
  const override = absolute(env.GOBLIN_HORDE_INSTALL_DIR, platform);
  if (override) return override;
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Programs", "GoblinHorde");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "GoblinHorde", "app");
  const data = absolute(env.XDG_DATA_HOME, platform) || path.join(home, ".local", "share");
  return path.join(data, "goblin-horde");
}

export function defaultStateDir(options) {
  const { env, platform, home } = defaults(options);
  return goblinStateDir({ env, platform, home });
}

/** Claude Code's user configuration folder: CLAUDE_CONFIG_DIR when set, otherwise ~/.claude. */
export function claudeConfigDir(options) {
  const { env, platform, home } = defaults(options);
  return absolute(env.CLAUDE_CONFIG_DIR, platform) || pathFor(platform).join(home, ".claude");
}

export function codexHome(options) {
  const { env, platform, home } = defaults(options);
  return absolute(env.CODEX_HOME, platform) || pathFor(platform).join(home, ".codex");
}

/** Resolve CLI options against the environment. Relative paths are rejected rather than guessed. */
export function resolveLocations(flags = {}, options) {
  const { platform } = defaults(options);
  const path = pathFor(platform);
  const pick = (flag, fallback, name) => {
    if (flag == null || flag === "") return fallback;
    if (!path.isAbsolute(flag)) throw new Error(`${name} must be an absolute path.`);
    return path.normalize(flag);
  };
  return {
    installDir: pick(flags.installDir, defaultInstallDir(options), "--install-dir"),
    stateDir: pick(flags.stateDir, defaultStateDir(options), "--state-dir"),
    claudeDir: pick(flags.claudeConfigDir, claudeConfigDir(options), "--claude-config-dir"),
    codexDir: pick(flags.codexHome, codexHome(options), "--codex-home"),
  };
}

/** Case-insensitive on Windows and macOS's default file system, exact elsewhere. */
export function samePath(a, b, platform = process.platform) {
  const path = pathFor(platform);
  const left = path.resolve(a);
  const right = path.resolve(b);
  return platform === "linux" ? left === right : left.toLowerCase() === right.toLowerCase();
}

/** True when child is parent itself or somewhere beneath it. */
export function isInside(child, parent, platform = process.platform) {
  const path = pathFor(platform);
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (relative === "") return true;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Folders the installer must never treat as its own. */
export function isUnsafeTarget(dir, options) {
  const { env, platform, home } = defaults(options);
  const path = pathFor(platform);
  const resolved = path.resolve(dir);
  if (resolved === path.parse(resolved).root) return true;
  const guarded = [home, env.LOCALAPPDATA, env.APPDATA, env.USERPROFILE, env.XDG_DATA_HOME, path.join(home, "Library", "Application Support"),
    path.join(home, ".local", "share"), path.join(home, ".local", "state"), path.join(home, "Desktop"), path.join(home, "Documents")]
    .filter(Boolean);
  return guarded.some((item) => samePath(item, resolved, platform));
}
