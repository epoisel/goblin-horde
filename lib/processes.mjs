/**
 * Find and stop only processes that run a file from one Goblin Horde installation.
 *
 * A process counts as ours only when a Node or Python interpreter runs one of the app's own
 * scripts directly: the script must be the interpreter's first argument, with no options before
 * it, and its path must be exactly that installation's file. A process name, a busy port, or a
 * command line that merely mentions the path (as an argument to some other script) is never
 * enough. Before each signal the process is looked up again and must still have the same command
 * line and start time, so a reused process id is never stopped.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { posix, win32 } from "node:path";

export const OWNED_SCRIPTS = Object.freeze(["server.mjs", "desktop_widget.py"]);
// node, nodejs, python, python3, python3.12, pythonw, pythonw3.12 (Microsoft Store), macOS framework "Python".
const INTERPRETER = /^(node|nodejs|pythonw?(\d+(\.\d+)*)?)(\.exe)?$/i;
// WQL for the Windows process list; `python%.exe` also covers pythonw.exe and the Microsoft Store's
// python3.12.exe / pythonw3.12.exe, which INTERPRETER then checks exactly.
export const WINDOWS_PROCESS_FILTER = "name='node.exe' or name like 'python%.exe'";

/**
 * Every process with its command line: [{ pid, command, argv?, started }]. `argv` is present when
 * the exact arguments are known (Linux /proc); `started` identifies this run of the process id.
 * Empty when the list cannot be read.
 */
export function listProcesses({ platform = process.platform } = {}) {
  try {
    if (platform === "win32") {
      const script = `Get-CimInstance Win32_Process -Filter "${WINDOWS_PROCESS_FILTER}" | `
        + "Select-Object ProcessId,CommandLine,@{n='Started';e={if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }}} | ConvertTo-Json -Compress";
      const text = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", timeout: 20_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (!text) return [];
      const parsed = JSON.parse(text);
      return (Array.isArray(parsed) ? parsed : [parsed])
        .map((item) => ({ pid: Number(item.ProcessId), command: String(item.CommandLine || ""), started: String(item.Started || "") }))
        .filter((item) => item.pid > 0);
    }
    if (platform === "linux") {
      const list = listLinuxProcesses();
      if (list.length) return list;
    }
    const text = execFileSync("ps", ["-axww", "-o", "pid=,lstart=,command="],
      { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } });
    // lstart is a fixed five-field date, e.g. "Wed Oct  9 10:00:00 2026".
    return text.split("\n").map((line) => /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/.exec(line)).filter(Boolean)
      .map((match) => ({ pid: Number(match[1]), started: match[2].replace(/\s+/g, " "), command: match[3] }));
  } catch {
    return [];
  }
}

/** Exact argv from /proc, so paths with spaces are never ambiguous. */
function listLinuxProcesses() {
  const list = [];
  let names;
  try { names = readdirSync("/proc"); } catch { return list; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const argv = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0");
      if (argv.at(-1) === "") argv.pop();
      if (!argv.length) continue;
      // Field 22 of stat, counted after the parenthesised command name, is the start time in clock ticks.
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] || "";
      list.push({ pid: Number(name), argv, command: argv.join(" "), started });
    } catch { /* The process ended or is not readable. */ }
  }
  return list;
}

/**
 * Split a Windows command line the way the C runtime (CommandLineToArgvW) does: the program name
 * ends at the first space outside quotes with no escaping; later arguments treat 2n backslashes
 * before a quote as n backslashes and a quote toggle, 2n+1 as n backslashes and a literal quote.
 */
export function splitWindowsCommandLine(line) {
  const text = String(line || "");
  const args = [];
  let index = 0;
  let program = "";
  let quoted = false;
  for (; index < text.length; index++) {
    const char = text[index];
    if (char === "\"") { quoted = !quoted; continue; }
    if (!quoted && (char === " " || char === "\t")) break;
    program += char;
  }
  if (program || text.length) args.push(program);
  for (;;) {
    while (index < text.length && (text[index] === " " || text[index] === "\t")) index++;
    if (index >= text.length) break;
    let arg = "";
    quoted = false;
    for (; index < text.length; index++) {
      const char = text[index];
      if (char === "\\") {
        let slashes = 0;
        while (text[index] === "\\") { slashes++; index++; }
        if (text[index] === "\"") {
          arg += "\\".repeat(Math.floor(slashes / 2));
          if (slashes % 2) arg += "\"";
          else quoted = !quoted;
        } else {
          arg += "\\".repeat(slashes);
          index--;
        }
        continue;
      }
      if (char === "\"") {
        // Inside quotes, "" is a literal quote.
        if (quoted && text[index + 1] === "\"") { arg += "\""; index++; continue; }
        quoted = !quoted;
        continue;
      }
      if (!quoted && (char === " " || char === "\t")) break;
      arg += char;
    }
    args.push(arg);
  }
  return args;
}

const pathFor = (platform) => (platform === "win32" ? win32 : posix);
const fold = (text, platform) => {
  const value = platform === "win32" ? String(text).replace(/\//g, "\\") : String(text);
  return platform === "linux" ? value : value.toLowerCase();
};

/**
 * Which of this installation's scripts a process runs ("server.mjs", "desktop_widget.py"), or "".
 *
 * `process` is a command-line string or { command, argv }. On macOS (and Linux without /proc) `ps`
 * joins arguments with spaces and no quoting, so the interpreter must be one path with no spaces,
 * or exactly one of `interpreters` (the Node this manager runs, or a Python it started the widget
 * with, either of which may live under a folder with spaces), immediately followed by the script
 * path and then a space or the end.
 */
export function ownedScript(processInfo, installDir, { platform = process.platform, scripts = OWNED_SCRIPTS, interpreters = [] } = {}) {
  const command = typeof processInfo === "string" ? processInfo : String(processInfo?.command || "");
  const given = typeof processInfo === "object" && Array.isArray(processInfo?.argv) ? processInfo.argv : null;
  const path = pathFor(platform);
  const targets = scripts.map((script) => ({ script, path: fold(path.join(installDir, script), platform) }));
  const argv = given || (platform === "win32" ? splitWindowsCommandLine(command) : null);
  if (argv) {
    if (argv.length < 2 || !INTERPRETER.test(path.basename(String(argv[0])))) return "";
    const script = fold(argv[1], platform);
    return targets.find((target) => target.path === script)?.script || "";
  }
  // POSIX `ps` text: "<interpreter> <script>[ args]".
  const line = fold(command, platform);
  for (const target of targets) {
    const known = interpreters.filter(Boolean).map((item) => fold(item, platform))
      .find((item) => line.startsWith(`${item} ${target.path}`) && INTERPRETER.test(posix.basename(item)));
    const prefix = known ?? (/^(\S+) /.exec(line)?.[1] || "");
    if (!prefix || !INTERPRETER.test(posix.basename(prefix))) continue;
    const rest = line.slice(prefix.length + 1);
    if (rest === target.path || rest.startsWith(`${target.path} `)) return target.script;
  }
  return "";
}

/**
 * The interpreter in front of `scriptPath` in a POSIX `ps` line "<interpreter> <scriptPath>[ args]",
 * or "" when the line is not that shape or the program is not Node or Python. Used only on the
 * process the manager just started, to learn how `ps` shows its Python (a framework Python shows
 * its Python.app program, a pyenv shim the version's own python3), even when that path has spaces.
 */
export function interpreterBefore(command, scriptPath) {
  const line = String(command || "");
  const at = line.indexOf(` ${scriptPath}`);
  if (at <= 0) return "";
  const after = line.slice(at + 1 + scriptPath.length);
  if (after && !after.startsWith(" ")) return "";
  const prefix = line.slice(0, at);
  return prefix.startsWith("/") && INTERPRETER.test(posix.basename(prefix)) ? prefix : "";
}

/** True when a command line runs one of this installation's own scripts. */
export function commandBelongsTo(processInfo, installDir, options) {
  return Boolean(ownedScript(processInfo, installDir, options));
}

export function ownedProcesses(installDir, { platform = process.platform, list = listProcesses({ platform }), interpreters = [] } = {}) {
  return list.filter((item) => item.pid !== process.pid)
    .map((item) => ({ ...item, script: ownedScript(item, installDir, { platform, interpreters }) }))
    .filter((item) => item.script);
}

/** The same process, still running the same command line, started at the same moment. */
export function sameProcess(item, list) {
  const now = list.find((entry) => entry.pid === item.pid);
  return Boolean(now) && now.command === item.command && String(now.started || "") === String(item.started || "");
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask a process to stop and wait briefly; on POSIX, insist if it does not. The caller checks the
 * process just before calling; `verify` is asked again before insisting, and when the id no
 * longer belongs to the same process, nothing more is sent and the result is false: that id now
 * runs another program, so it is not reported as stopped.
 */
export async function stopPid(pid, { waitMs = 5000, verify = () => true } = {}) {
  if (!isAlive(pid)) return true;
  try { process.kill(pid, "SIGTERM"); } catch { return !isAlive(pid); }
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    if (!isAlive(pid)) return true;
    await pause(100);
  }
  if (!(await verify())) return false;
  try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
  await pause(200);
  return !isAlive(pid);
}
