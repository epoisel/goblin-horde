/**
 * Process ownership from synthetic command lines only: nothing here lists or signals real processes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  WINDOWS_PROCESS_FILTER, commandBelongsTo, interpreterBefore, ownedProcesses, ownedScript, sameProcess, splitWindowsCommandLine,
} from "../lib/processes.mjs";

test("the Windows process query lists every interpreter name ownership accepts, including Store Python", () => {
  // WQL: `=` is exact and case-insensitive; LIKE's % is any run of characters.
  const clauses = WINDOWS_PROCESS_FILTER.split(/\s+or\s+/i).map((clause) => {
    const [, op, value] = /^name\s*(=|like)\s*'([^']*)'$/i.exec(clause.trim());
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${op === "=" ? escaped : escaped.replace(/%/g, ".*")}$`, "i");
  });
  const listed = (name) => clauses.some((pattern) => pattern.test(name));
  for (const name of ["node.exe", "python.exe", "pythonw.exe", "python3.12.exe", "pythonw3.12.exe", "PythonW3.13.exe"]) {
    assert.ok(listed(name), name);
    assert.ok(commandBelongsTo(`"C:\\Py\\${name}" "C:\\App\\desktop_widget.py"`, "C:\\App", { platform: "win32" }), name);
  }
  assert.equal(listed("code.exe"), false);
});

test("Windows command lines split the way the C runtime splits them", () => {
  assert.deepEqual(splitWindowsCommandLine('"C:\\Program Files\\node.exe" "a b" c\\"d "e\\\\" f'),
    ["C:\\Program Files\\node.exe", "a b", "c\"d", "e\\", "f"]);
  assert.deepEqual(splitWindowsCommandLine("node.exe   C:\\x\\server.mjs\t--port 1"), ["node.exe", "C:\\x\\server.mjs", "--port", "1"]);
  assert.deepEqual(splitWindowsCommandLine('node "say ""hi"""'), ["node", "say \"hi\""]);
  assert.deepEqual(splitWindowsCommandLine(""), []);
});

test("on Windows, only an interpreter running this installation's script directly is ours", () => {
  const dir = "C:\\Apps\\GoblinHorde";
  const ours = (command) => commandBelongsTo(command, dir, { platform: "win32" });
  for (const command of [
    "\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Apps\\GoblinHorde\\server.mjs\"",
    "node C:\\Apps\\GoblinHorde\\server.mjs",
    "NODE.EXE c:/apps/goblinhorde/SERVER.MJS",
    "pythonw.exe C:\\Apps\\GoblinHorde\\desktop_widget.py --port 43917",
    "\"C:\\Program Files\\WindowsApps\\PythonSoftwareFoundation.Python.3.12\\pythonw3.12.exe\" \"C:\\Apps\\GoblinHorde\\desktop_widget.py\" --port 43917",
  ]) assert.equal(ours(command), true, command);
  for (const command of [
    // The review's case: another script that merely receives our path as an argument.
    "node C:\\Tools\\editor.mjs C:\\Apps\\GoblinHorde\\server.mjs",
    "\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Tools\\watch.mjs\" \"C:\\Apps\\GoblinHorde\\server.mjs\"",
    "node -e \"require('C:\\\\Apps\\\\GoblinHorde\\\\server.mjs')\"",
    "node --require C:\\Apps\\GoblinHorde\\server.mjs C:\\Tools\\x.mjs",
    "node --inspect C:\\Apps\\GoblinHorde\\server.mjs",
    "notepad.exe C:\\Apps\\GoblinHorde\\server.mjs",
    "code.exe C:\\Apps\\GoblinHorde\\desktop_widget.py",
    "\"C:\\Apps\\GoblinHorde\\server.mjs\"",
    "node \"C:\\Apps\\GoblinHorde-old\\server.mjs\"",
    "node C:\\Apps\\GoblinHorde\\server.mjs.bak",
    "node C:\\Apps\\GoblinHorde\\sub\\..\\server.mjs",
    "node server.mjs",
    "node \"C:\\Apps\\GoblinHorde\\other.mjs\"",
    "node \"C:\\Apps\\Goblin Horde\\server.mjs\"",
    // An escaped quote makes the path part of a longer argument.
    "node \"C:\\Apps\\GoblinHorde\\server.mjs\\\" x\"",
  ]) assert.equal(ours(command), false, command);

  const spaced = "C:\\Apps\\Goblin Horde";
  assert.equal(commandBelongsTo("\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Apps\\Goblin Horde\\server.mjs\"", spaced, { platform: "win32" }), true);
  assert.equal(commandBelongsTo("node C:\\Apps\\Goblin Horde\\server.mjs", spaced, { platform: "win32" }), false, "unquoted, that is two arguments");
  assert.equal(ownedScript("pythonw C:\\Apps\\GoblinHorde\\desktop_widget.py", dir, { platform: "win32" }), "desktop_widget.py");
});

test("on macOS and Linux, ps text and exact argv both need the script right after the interpreter", () => {
  const dir = "/opt/goblin horde";
  const on = (platform, command, options = {}) => commandBelongsTo(command, dir, { platform, ...options });
  for (const platform of ["linux", "darwin"]) {
    assert.equal(on(platform, "node /opt/goblin horde/server.mjs"), true, platform);
    assert.equal(on(platform, "/usr/local/bin/node /opt/goblin horde/server.mjs --trace"), true, platform);
    assert.equal(on(platform, "python3 /opt/goblin horde/desktop_widget.py --port 1"), true, platform);
    for (const command of [
      "node /tmp/editor.mjs /opt/goblin horde/server.mjs",
      "node /tmp/node /opt/goblin horde/server.mjs",
      "vim /opt/goblin horde/server.mjs",
      "node -e require(\"/opt/goblin horde/server.mjs\")",
      "node /opt/goblin horde/server.mjs.bak",
      "node /opt/goblin horde-old/server.mjs",
      "tail -f /opt/goblin horde/server.mjs",
    ]) assert.equal(on(platform, command), false, `${platform}: ${command}`);
    // A Node under a folder with spaces is recognised when it is the Node the manager uses.
    const fnm = "/Volumes/Tools/My Node/bin/node";
    assert.equal(on(platform, `${fnm} /opt/goblin horde/server.mjs`), false, "unknown interpreter path with spaces");
    assert.equal(on(platform, `${fnm} /opt/goblin horde/server.mjs`, { interpreters: [fnm] }), true);
    assert.equal(on(platform, `${fnm} /tmp/x.mjs /opt/goblin horde/server.mjs`, { interpreters: [fnm] }), false);
  }
  assert.equal(on("darwin", "NODE /OPT/GOBLIN HORDE/SERVER.MJS"), true, "macOS paths are case-insensitive by default");
  assert.equal(on("linux", "NODE /OPT/GOBLIN HORDE/SERVER.MJS"), false);
  // Exact argv from /proc.
  assert.equal(on("linux", { argv: ["/usr/bin/node", "/opt/goblin horde/server.mjs"], command: "" }), true);
  assert.equal(on("linux", { argv: ["/usr/bin/node", "/tmp/editor.mjs", "/opt/goblin horde/server.mjs"], command: "" }), false);
  assert.equal(on("linux", { argv: ["/usr/bin/node", "--require", "/opt/goblin horde/server.mjs"], command: "" }), false);
});

test("on macOS, a recorded Python under a folder with spaces runs the widget, and nothing else is classified", () => {
  const dir = "/Users/Jane Smith/Library/Application Support/GoblinHorde/app";
  const widget = `${dir}/desktop_widget.py`;
  const pyenv = "/Users/Jane Smith/.pyenv/versions/3.13.3/bin/python3";
  const on = (command, interpreters = [pyenv]) => ownedScript(command, dir, { platform: "darwin", interpreters });
  assert.equal(on(`${pyenv} ${widget} --port 43917`, []), "", "unrecorded, the path is ambiguous and is not claimed");
  assert.equal(on(`${pyenv} ${widget} --port 43917`), "desktop_widget.py");
  assert.equal(on(`${pyenv} ${widget}`), "desktop_widget.py");
  for (const command of [
    `${pyenv} /tmp/other.py ${widget}`,
    `${pyenv} -c import runpy ${widget}`,
    `${pyenv} ${widget}.bak`,
    `${pyenv} ${dir}-old/desktop_widget.py`,
    `/Users/Jane Smith/bin/editor ${widget}`,
    `/Users/Jane Smith/.pyenv/versions/3.13.3/bin/python3-wrapper ${widget}`,
    `/Users/Jane ${widget}`,
  ]) assert.equal(on(command), "", command);
  // A recorded program that is not Node or Python is never treated as an interpreter.
  assert.equal(on(`/Users/Jane Smith/Apps/editor ${dir}/server.mjs`, ["/Users/Jane Smith/Apps/editor"]), "", "not an interpreter");
});

test("the interpreter ps shows in front of the widget is read only from an exact direct run", () => {
  const widget = "/Users/Jane Smith/Library/Application Support/GoblinHorde/app/desktop_widget.py";
  const framework = "/Users/Jane Smith/Py Builds/Python.framework/Versions/3.13/Resources/Python.app/Contents/MacOS/Python";
  assert.equal(interpreterBefore(`${framework} ${widget} --port 43917`, widget), framework);
  assert.equal(interpreterBefore(`/opt/homebrew/bin/python3 ${widget}`, widget), "/opt/homebrew/bin/python3");
  for (const command of [
    `${framework} ${widget}.bak`,
    `/Users/Jane Smith/bin/editor ${widget}`,
    `python3 ${widget}`,
    widget,
    `${framework} /tmp/other.py`,
  ]) assert.equal(interpreterBefore(command, widget), "", command);
});

test("owned processes carry which script they run, and a reused process id is not the same process", () => {
  const list = [
    { pid: 11, command: "node /opt/goblin/server.mjs", started: "a" },
    { pid: 12, command: "python3 /opt/goblin/desktop_widget.py", started: "b" },
    { pid: 13, command: "node /tmp/editor.mjs /opt/goblin/server.mjs", started: "c" },
  ];
  const owned = ownedProcesses("/opt/goblin", { platform: "linux", list });
  assert.deepEqual(owned.map((item) => [item.pid, item.script]), [[11, "server.mjs"], [12, "desktop_widget.py"]]);
  assert.equal(sameProcess(owned[0], list), true);
  assert.equal(sameProcess(owned[0], [{ ...list[0], started: "later" }]), false, "same id, started again");
  assert.equal(sameProcess(owned[0], [{ ...list[0], command: "node /tmp/other.mjs" }]), false, "same id, another program");
  assert.equal(sameProcess(owned[0], []), false, "gone");
});
