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
import { win32 } from "node:path";

export const OWNED_SCRIPTS = Object.freeze(["server.mjs", "desktop_widget.py"]);
// node, nodejs, python, python3, python3.12, pythonw, pythonw3.12 (Microsoft Store).
const INTERPRETER = /^(node|nodejs|pythonw?(\d+(\.\d+)*)?)(\.exe)?$/i;
// WQL for the process list; `python%.exe` also covers pythonw.exe and the Microsoft Store's
// python3.12.exe / pythonw3.12.exe, which INTERPRETER then checks exactly.
export const WINDOWS_PROCESS_FILTER = "name='node.exe' or name like 'python%.exe'";

/**
 * Every Node and Python process with its command line: [{ pid, command, started }]. `started` identifies this
 * run of the process id. Empty when the list cannot be read.
 */
export function listProcesses() {
  try {
    const script = `Get-CimInstance Win32_Process -Filter "${WINDOWS_PROCESS_FILTER}" | `
      + "Select-Object ProcessId,CommandLine,@{n='Started';e={if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }}} | ConvertTo-Json -Compress";
    const text = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", timeout: 20_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    return (Array.isArray(parsed) ? parsed : [parsed])
      .map((item) => ({ pid: Number(item.ProcessId), command: String(item.CommandLine || ""), started: String(item.Started || "") }))
      .filter((item) => item.pid > 0);
  } catch {
    return [];
  }
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

const fold = (text) => String(text).replace(/\//g, "\\").toLowerCase();

/**
 * Which of this installation's scripts a process runs ("server.mjs", "desktop_widget.py"), or "".
 * `processInfo` is a command line, or { command }, or { argv } when the exact arguments are known.
 */
export function ownedScript(processInfo, installDir, { scripts = OWNED_SCRIPTS } = {}) {
  const command = typeof processInfo === "string" ? processInfo : String(processInfo?.command || "");
  const argv = typeof processInfo === "object" && Array.isArray(processInfo?.argv) ? processInfo.argv : splitWindowsCommandLine(command);
  if (argv.length < 2 || !INTERPRETER.test(win32.basename(String(argv[0])))) return "";
  const script = fold(argv[1]);
  return scripts.find((name) => fold(win32.join(installDir, name)) === script) || "";
}

/** True when a command line runs one of this installation's own scripts. */
export function commandBelongsTo(processInfo, installDir, options) {
  return Boolean(ownedScript(processInfo, installDir, options));
}

export function ownedProcesses(installDir, { list = listProcesses() } = {}) {
  return list.filter((item) => item.pid !== process.pid)
    .map((item) => ({ ...item, script: ownedScript(item, installDir) }))
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
 * Ask a process to stop and wait briefly; insist if it does not. The caller checks the process just before
 * calling; `verify` is asked again before insisting, and when the id no longer belongs to the same process,
 * nothing more is sent and the result is false: that id now runs another program, so it is not reported as stopped.
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
