/**
 * The task view's own window: http://127.0.0.1:<port>/app opened as an app window of a Chromium browser
 * (Edge, else Chrome or Chromium) with Goblin Horde's own browser profile, so it reads as an app beside
 * the goblin strip rather than as one more tab. Without such a browser the default browser opens it.
 *
 * Only that one local address is ever opened, with the task and agent ids checked first; the browser is
 * started without a shell, from a fixed list of places (or GOBLIN_HORDE_APP_BROWSER, an absolute path
 * the person set). Every outside call (spawn, file checks, the Windows registry) is injectable for tests.
 */
import { execFileSync, spawn as spawnProcess } from "node:child_process";
import { statSync } from "node:fs";
import { posix, win32 } from "node:path";

const TASK_ID = /^[A-Za-z0-9_:.-]{1,400}$/;
const APP_URL = /^http:\/\/127\.0\.0\.1:\d{2,5}\/app(?:#[A-Za-z0-9%=&._:-]{0,1200})?$/;
export const APP_WINDOW_SIZE = "1500,950";

/** The task view's address on this computer, opened on a task (and one of its agents) when given. */
export function appUrl(port, { taskId = "", agentId = "" } = {}) {
  const number = Number(port);
  if (!Number.isInteger(number) || number < 1024 || number > 65535) throw Object.assign(new Error("Choose a valid port."), { statusCode: 400 });
  const parts = [];
  if (taskId) {
    if (!TASK_ID.test(String(taskId))) throw Object.assign(new Error("Choose a valid task."), { statusCode: 400 });
    parts.push(`task=${encodeURIComponent(taskId)}`);
  }
  if (agentId) {
    if (!TASK_ID.test(String(agentId))) throw Object.assign(new Error("Choose a valid agent."), { statusCode: 400 });
    parts.push(`focus=${encodeURIComponent(agentId)}`);
  }
  return `http://127.0.0.1:${number}/app${parts.length ? `#${parts.join("&")}` : ""}`;
}

const isFile = (path) => { try { return statSync(path).isFile(); } catch { return false; } };

/** The default value of an App Paths key ("…\msedge.exe"), read with reg.exe; "" when it is not there. */
function registryAppPath(exe) {
  for (const hive of ["HKCU", "HKLM"]) {
    try {
      const out = execFileSync("reg.exe", ["query", `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, "/ve"],
        { encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      const value = /REG_(?:EXPAND_)?SZ\s+(.+)$/m.exec(out)?.[1]?.trim().replace(/^"(.*)"$/, "$1");
      if (value) return value;
    } catch { /* Not in this hive. */ }
  }
  return "";
}

/** Places a browser installs to on Windows, Program Files (x86) first as Edge uses it. */
function windowsCandidates(env, folders, exe) {
  const roots = [env["ProgramFiles(x86)"], env.ProgramFiles, env.ProgramW6432, env.LOCALAPPDATA].filter(Boolean);
  return roots.map((root) => win32.join(root, ...folders, exe));
}

/**
 * Which browser opens the app window: { kind: "edge" | "chrome" | "chromium" | "custom" | "default", path }.
 * Windows looks in Program Files (x86), Program Files, and the user's own programs folder, then the App
 * Paths registry; macOS in /Applications; Linux on PATH.
 */
export function findAppBrowser({ platform = process.platform, env = process.env, exists = isFile, registry = registryAppPath, home = env.HOME || "" } = {}) {
  const custom = env.GOBLIN_HORDE_APP_BROWSER || "";
  if (custom && (win32.isAbsolute(custom) || posix.isAbsolute(custom)) && exists(custom)) return { kind: "custom", path: custom };
  if (platform === "win32") {
    for (const [kind, folders, exe] of [["edge", ["Microsoft", "Edge", "Application"], "msedge.exe"], ["chrome", ["Google", "Chrome", "Application"], "chrome.exe"]]) {
      const found = windowsCandidates(env, folders, exe).find((path) => exists(path));
      if (found) return { kind, path: found };
      const registered = registry(exe);
      if (registered && win32.isAbsolute(registered) && /\.exe$/i.test(registered) && exists(registered)) return { kind, path: registered };
    }
    return { kind: "default", path: "" };
  }
  if (platform === "darwin") {
    for (const [kind, app] of [["edge", "Microsoft Edge"], ["chrome", "Google Chrome"], ["chromium", "Chromium"]]) {
      if ([`/Applications/${app}.app`, home && posix.join(home, "Applications", `${app}.app`)].filter(Boolean).some((path) => exists(posix.join(path, "Contents", "Info.plist"))))
        return { kind, path: app };
    }
    return { kind: "default", path: "" };
  }
  const folders = String(env.PATH || "").split(":").filter((folder) => posix.isAbsolute(folder));
  for (const [kind, names] of [["edge", ["microsoft-edge", "microsoft-edge-stable"]], ["chrome", ["google-chrome", "google-chrome-stable"]], ["chromium", ["chromium", "chromium-browser"]]]) {
    for (const name of names) {
      const found = folders.map((folder) => posix.join(folder, name)).find((path) => exists(path));
      if (found) return { kind, path: found };
    }
  }
  return { kind: "default", path: "" };
}

/**
 * The command that opens `url` in an app window: { command, args }. `profileDir` is Goblin Horde's own
 * browser profile (<state>/app-window): the window keeps its size and never touches the person's own
 * browser profile. If that profile's window is already open, the browser reuses it. Pure.
 */
export function appWindowCommand({ platform = process.platform, browser, url, profileDir }) {
  if (!APP_URL.test(String(url))) throw new Error("Only the task view's own address opens in its window.");
  // --disable-sync: a new Edge profile otherwise signs in with the Windows account and starts syncing
  // the person's browsing data into Goblin Horde's profile, behind a prompt in the app window.
  const flags = [`--app=${url}`, `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", "--disable-sync", `--window-size=${APP_WINDOW_SIZE}`];
  if (browser?.kind === "default" || !browser?.path) {
    if (platform === "win32") return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
    if (platform === "darwin") return { command: "open", args: [url] };
    return { command: "xdg-open", args: [url] };
  }
  if (platform === "darwin" && browser.kind !== "custom") return { command: "open", args: ["-na", browser.path, "--args", ...flags] };
  return { command: browser.path, args: flags };
}

/**
 * Open the task view in its own window. Returns { opened, browser, url }; `opened` is false when nothing
 * could be started. `spawn` and the browser lookup are injectable, so tests start nothing.
 */
export function openAppWindow({ port, taskId = "", agentId = "", stateDir, platform = process.platform, env = process.env, spawn = spawnProcess,
  find = findAppBrowser, exists = isFile, registry = registryAppPath } = {}) {
  const url = appUrl(port, { taskId, agentId });
  const path = platform === "win32" ? win32 : posix;
  const profileDir = path.join(String(stateDir || ""), "app-window");
  if (!path.isAbsolute(profileDir)) throw new Error("Goblin Horde's state folder is not known.");
  const attempt = (browser) => {
    const { command, args } = appWindowCommand({ platform, browser, url, profileDir });
    try {
      const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: browser.kind === "default" });
      child?.on?.("error", () => {});
      child?.unref?.();
      return true;
    } catch { return false; }
  };
  const browser = find({ platform, env, exists, registry });
  if (attempt(browser)) return { opened: true, browser: browser.kind, url };
  // A browser that would not start: the default browser still shows the page.
  if (browser.kind !== "default" && attempt({ kind: "default", path: "" })) return { opened: true, browser: "default", url };
  return { opened: false, browser: browser.kind, url };
}
