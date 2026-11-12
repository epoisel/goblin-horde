/**
 * Process ownership from synthetic command lines only: nothing here lists or signals real processes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { WINDOWS_PROCESS_FILTER, commandBelongsTo, ownedProcesses, ownedScript, sameProcess, splitWindowsCommandLine } from "../lib/processes.mjs";

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
    assert.ok(commandBelongsTo(`"C:\\Py\\${name}" "C:\\App\\desktop_widget.py"`, "C:\\App"), name);
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

test("only an interpreter running this installation's script directly is ours", () => {
  const dir = "C:\\Apps\\GoblinHorde";
  const ours = (command) => commandBelongsTo(command, dir);
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
  assert.equal(commandBelongsTo("\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Apps\\Goblin Horde\\server.mjs\"", spaced), true);
  assert.equal(commandBelongsTo("node C:\\Apps\\Goblin Horde\\server.mjs", spaced), false, "unquoted, that is two arguments");
  assert.equal(ownedScript("pythonw C:\\Apps\\GoblinHorde\\desktop_widget.py", dir), "desktop_widget.py");
  // Exact arguments, when they are known, are read as they are.
  assert.equal(ownedScript({ argv: ["pythonw.exe", "C:\\Apps\\GoblinHorde\\desktop_widget.py", "--port", "43917"] }, dir), "desktop_widget.py");
  assert.equal(ownedScript({ argv: ["node.exe", "C:\\Tools\\x.mjs", "C:\\Apps\\GoblinHorde\\server.mjs"] }, dir), "");
});

test("owned processes carry which script they run, and a reused process id is not the same process", () => {
  const list = [
    { pid: 11, command: "node C:\\Apps\\GoblinHorde\\server.mjs", started: "a" },
    { pid: 12, command: "pythonw.exe C:\\Apps\\GoblinHorde\\desktop_widget.py", started: "b" },
    { pid: 13, command: "node C:\\Tools\\editor.mjs C:\\Apps\\GoblinHorde\\server.mjs", started: "c" },
  ];
  const owned = ownedProcesses("C:\\Apps\\GoblinHorde", { list });
  assert.deepEqual(owned.map((item) => [item.pid, item.script]), [[11, "server.mjs"], [12, "desktop_widget.py"]]);
  assert.equal(sameProcess(owned[0], list), true);
  assert.equal(sameProcess(owned[0], [{ ...list[0], started: "later" }]), false, "same id, started again");
  assert.equal(sameProcess(owned[0], [{ ...list[0], command: "node C:\\Tools\\other.mjs" }]), false, "same id, another program");
  assert.equal(sameProcess(owned[0], []), false, "gone");
});
