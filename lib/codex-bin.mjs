/**
 * How to start the Codex CLI. CODEX_CLI_PATH wins; otherwise "codex" from PATH.
 *
 * On Windows, npm installs Codex as a `codex.cmd` shim, which Node cannot start without a shell.
 * The shim only runs the native codex.exe the npm package ships, so that binary is started
 * directly when it is there; failing that, the shim runs through `cmd.exe /d /s /c` with every
 * argument quoted. The arguments are the app's own fixed constants, never user text.
 */
import { statSync } from "node:fs";
import { win32 } from "node:path";

const WINDOWS_TARGETS = Object.freeze({
  x64: { pkg: "codex-win32-x64", triple: "x86_64-pc-windows-msvc" },
  arm64: { pkg: "codex-win32-arm64", triple: "aarch64-pc-windows-msvc" },
});
const RUNNABLE = [".com", ".exe", ".bat", ".cmd"];

function defaultIsFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

/** Windows environment names are case-insensitive; an injected env object is not. */
function envValue(env, name, platform) {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env).find((item) => item.toUpperCase() === name.toUpperCase());
  return key ? env[key] : undefined;
}

/** The first runnable `name` on PATH the way cmd.exe looks: each folder in order, each PATHEXT entry in order. */
export function findOnWindowsPath(name, { env = process.env, isFile = defaultIsFile } = {}) {
  const dirs = String(envValue(env, "PATH", "win32") || "").split(";").map((dir) => dir.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
  // Only extensions CreateProcess or cmd.exe can run; a PATHEXT .PS1 or .JS would need its own host.
  const exts = String(envValue(env, "PATHEXT", "win32") || RUNNABLE.join(";")).split(";")
    .map((ext) => ext.trim().toLowerCase()).filter((ext) => RUNNABLE.includes(ext));
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = win32.join(dir, `${name}${ext}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return "";
}

/** The native codex.exe beside an npm shim (global prefix or node_modules/.bin), or "". */
export function nativeCodexBeside(shim, { arch = process.arch, isFile = defaultIsFile } = {}) {
  const dir = win32.dirname(shim);
  const scopes = [win32.join(dir, "node_modules", "@openai"), win32.join(dir, "..", "@openai")];
  // This computer's architecture first; Windows on Arm also runs the x64 build.
  const targets = [WINDOWS_TARGETS[arch], WINDOWS_TARGETS.x64, WINDOWS_TARGETS.arm64].filter(Boolean);
  for (const scope of scopes) {
    for (const { pkg, triple } of targets) {
      for (const root of [win32.join(scope, "codex", "node_modules", "@openai", pkg), win32.join(scope, pkg)]) {
        const exe = win32.join(root, "vendor", triple, "bin", "codex.exe");
        if (isFile(exe)) return { exe, packageRoot: win32.join(scope, "codex") };
      }
    }
  }
  return null;
}

/** One argument inside `cmd /s /c "..."`; `%` expands and `"` ends quoting even there, so neither is allowed. */
function cmdQuote(arg) {
  const text = String(arg);
  if (/["%\r\n\0]/.test(text)) throw new Error(`Cannot pass ${JSON.stringify(text)} safely through cmd.exe.`);
  return `"${text}"`;
}

/**
 * { command, args, options, env } for spawn: `options` and `env` are extra spawn options and
 * environment variables to add. Throws only when a .cmd path cannot be quoted safely.
 */
export function codexCommand(args, { env = process.env, platform = process.platform, arch = process.arch, isFile = defaultIsFile } = {}) {
  const configured = envValue(env, "CODEX_CLI_PATH", platform) || "";
  if (platform !== "win32") return { command: configured || "codex", args, options: {}, env: {} };
  const target = configured || findOnWindowsPath("codex", { env, isFile });
  // Not found: spawning the bare name fails with ENOENT, which the reader reports as a missing CLI.
  if (!target) return { command: "codex", args, options: {}, env: {} };
  if (!/\.(cmd|bat)$/i.test(target)) return { command: target, args, options: {}, env: {} };
  const native = nativeCodexBeside(target, { arch, isFile });
  // The same markers npm's own codex.js launcher sets, so Codex knows how it was installed.
  if (native) return { command: native.exe, args, options: {}, env: { CODEX_MANAGED_BY_NPM: "1", CODEX_MANAGED_PACKAGE_ROOT: native.packageRoot } };
  const line = [target, ...args].map(cmdQuote).join(" ");
  return {
    command: envValue(env, "ComSpec", platform) || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    options: { windowsVerbatimArguments: true },
    env: {},
  };
}

export const CODEX_NOT_FOUND = "The Codex CLI was not found.";

/**
 * Codex's connection in the shape every source uses. Codex is optional: a computer without the
 * Codex CLI is told so plainly, not shown a fault to fix (it is still retried, so installing it later
 * is noticed on its own).
 */
export function codexSourceState(health, { restarts = 0, now = Date.now() } = {}) {
  const wait = Math.max(0, Math.round((health.nextRetryAt - now) / 1000));
  // A retry briefly reads "starting" again; with no CLI found last time it is still not installed.
  const missing = health.state !== "ready" && health.lastError === CODEX_NOT_FOUND;
  const state = health.state === "ready" ? "ok" : missing ? "not-installed" : health.state === "unavailable" ? "unavailable" : "starting";
  const detail = state === "ok" ? "Reading local Codex chats."
    : state === "not-installed" ? "Optional: install the Codex CLI to see Codex chats."
      : state === "starting" ? "Starting Codex…"
        : `${health.lastError || "Codex stopped."} Retrying${wait ? ` in ${wait}s` : " now"}; reconnect to try at once.`;
  return { state, detail, replies: true, restarts, nextRetryAt: health.nextRetryAt || 0 };
}
