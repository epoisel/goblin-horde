import test from "node:test";
import assert from "node:assert/strict";
import { isLocalPath } from "../lib/paths.mjs";

const REMOTE = ["\\\\files.example.test\\share\\billing-api", "//files.example.test/share/billing-api", "\\\\?\\C:\\work\\billing-api",
  "\\\\.\\pipe\\billing-api", "\\??\\C:\\work\\billing-api", "\\\\?\\UNC\\files.example.test\\share", "C:\\work\\CON", "C:\\work\\nul.txt\\x",
  "C:\\work\\billing-api:hidden", "work\\billing-api", "C:work", "/dev/tty", "/proc/self", "", null];

test("only an ordinary local folder counts as local", () => {
  for (const path of REMOTE) assert.equal(isLocalPath(path, "win32"), false, String(path));
  for (const path of ["C:\\work\\billing-api", "c:/work/billing-api", "\\work\\billing-api", "/work/billing-api"]) assert.equal(isLocalPath(path, "win32"), true, path);
  // Elsewhere a POSIX folder may hold ":" or be called "aux".
  assert.equal(isLocalPath("/home/dev/aux/a:b", "linux"), true);
  assert.equal(isLocalPath("//files.example.test/share", "linux"), false);
});
