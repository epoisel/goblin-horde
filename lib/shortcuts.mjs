/**
 * Windows shortcuts: a Start Menu entry to open Goblin Horde again, and an optional one in the
 * Startup folder so it opens when the person signs in. Both run the installed manager's `start`,
 * which starts the viewer and the desktop goblins if they are not already running.
 *
 * Shortcuts are written with the Windows Script Host's shortcut object through PowerShell; values
 * travel in environment variables, never inside the script text, so no path needs quoting.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { win32 } from "node:path";

export const SHORTCUT_NAME = "Goblin Horde.lnk";

/** Where the two shortcuts live, or null off Windows or without an APPDATA folder. */
export function shortcutPaths({ platform = process.platform, env = process.env } = {}) {
  if (platform !== "win32" || !env.APPDATA || !win32.isAbsolute(env.APPDATA)) return null;
  const programs = win32.join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs");
  return { menu: win32.join(programs, SHORTCUT_NAME), startup: win32.join(programs, "Startup", SHORTCUT_NAME) };
}

/** What a shortcut runs: this installation's manager, started minimized so no console stays in view. */
export function shortcutSpec({ nodePath, installDir }) {
  return {
    target: nodePath,
    // The install folder's marker names its state folder and port, so this finds a custom install too.
    args: `"${win32.join(installDir, "goblin.mjs")}" start --install-dir "${installDir}"`,
    dir: installDir,
    icon: win32.join(installDir, "goblin.ico"),
    description: "Goblin Horde: see what your AI coding agents are doing",
  };
}

const SCRIPT = [
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:GH_LINK)",
  "$s.TargetPath = $env:GH_TARGET",
  "$s.Arguments = $env:GH_ARGS",
  "$s.WorkingDirectory = $env:GH_DIR",
  "$s.WindowStyle = 7",
  "if (Test-Path -LiteralPath $env:GH_ICON) { $s.IconLocation = $env:GH_ICON }",
  "$s.Description = $env:GH_DESCRIPTION",
  "$s.Save()",
].join("; ");

/** Write (or rewrite) one shortcut. */
export function writeShortcut(link, spec, { run = execFileSync, env = process.env } = {}) {
  mkdirSync(win32.dirname(link), { recursive: true });
  try {
    runScript(run, link, spec, env);
  } catch (error) {
    // Say what Windows said, not the whole command line.
    const said = String(error.stderr || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    throw new Error(said || "Windows could not write the shortcut.");
  }
}

function runScript(run, link, spec, env) {
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT], {
    windowsHide: true, timeout: 20_000, stdio: ["ignore", "ignore", "pipe"],
    env: { ...env, GH_LINK: link, GH_TARGET: spec.target, GH_ARGS: spec.args, GH_DIR: spec.dir, GH_ICON: spec.icon,
      GH_DESCRIPTION: spec.description },
  });
}

export function removeShortcut(link) {
  if (link && existsSync(link)) rmSync(link, { force: true });
}
