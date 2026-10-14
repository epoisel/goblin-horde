/**
 * Starting the Codex CLI, from synthetic file lists only: nothing here runs Codex.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CODEX_NOT_FOUND, codexCommand, codexSourceState, findOnWindowsPath, nativeCodexBeside } from "../lib/codex-bin.mjs";

const ARGS = ["app-server", "--listen", "stdio://"];
const files = (...paths) => {
  const known = new Set(paths.map((path) => path.toLowerCase()));
  return (path) => known.has(path.toLowerCase());
};
const NPM = "C:\\Users\\me\\.npm-global";
const NATIVE_X64 = `${NPM}\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`;
const NATIVE_ARM = `${NPM}\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-arm64\\vendor\\aarch64-pc-windows-msvc\\bin\\codex.exe`;

test("outside Windows, CODEX_CLI_PATH or plain codex runs directly", () => {
  assert.deepEqual(codexCommand(ARGS, { platform: "linux", env: {} }).command, "codex");
  assert.deepEqual(codexCommand(ARGS, { platform: "darwin", env: { CODEX_CLI_PATH: "/opt/codex" } }),
    { command: "/opt/codex", args: ARGS, options: {}, env: {} });
});

test("on Windows, PATH is searched folder by folder with PATHEXT, in any letter case", () => {
  const env = { Path: `C:\\empty;"${NPM}"`, PATHEXT: ".COM;.EXE;.BAT;.CMD;.JS;.PS1" };
  const isFile = files(`${NPM}\\codex`, `${NPM}\\codex.ps1`, `${NPM}\\codex.cmd`);
  assert.equal(findOnWindowsPath("codex", { env, isFile }), `${NPM}\\codex.cmd`, "never the extensionless sh script or the .ps1");
  assert.equal(findOnWindowsPath("codex", { env: { PATH: "C:\\bin" }, isFile: files("C:\\bin\\codex.exe") }), "C:\\bin\\codex.exe");
  assert.equal(findOnWindowsPath("codex", { env: {}, isFile: () => true }), "");
});

test("an npm codex.cmd shim is replaced by the native codex.exe it would run", () => {
  const env = { PATH: NPM };
  const found = codexCommand(ARGS, { platform: "win32", arch: "x64", env, isFile: files(`${NPM}\\codex.cmd`, NATIVE_X64) });
  assert.equal(found.command, NATIVE_X64);
  assert.deepEqual(found.args, ARGS);
  assert.equal(found.env.CODEX_MANAGED_BY_NPM, "1");
  assert.equal(found.env.CODEX_MANAGED_PACKAGE_ROOT, `${NPM}\\node_modules\\@openai\\codex`);
  // Windows on Arm prefers its own build, and still runs the x64 one when that is all there is.
  assert.equal(nativeCodexBeside(`${NPM}\\codex.cmd`, { arch: "arm64", isFile: files(NATIVE_X64, NATIVE_ARM) }).exe, NATIVE_ARM);
  assert.equal(nativeCodexBeside(`${NPM}\\codex.cmd`, { arch: "arm64", isFile: files(NATIVE_X64) }).exe, NATIVE_X64);
  // A project-local shim in node_modules/.bin.
  const local = "C:\\proj\\node_modules\\.bin\\codex.cmd";
  const localExe = "C:\\proj\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe";
  assert.equal(nativeCodexBeside(local, { arch: "x64", isFile: files(localExe) }).exe, localExe);
});

test("CODEX_CLI_PATH wins, and a .cmd with no native binary runs through cmd.exe with quoted arguments", () => {
  const shim = "C:\\Program Files\\Tools\\codex.cmd";
  const found = codexCommand(ARGS, { platform: "win32", env: { CODEX_CLI_PATH: shim, ComSpec: "C:\\Windows\\system32\\cmd.exe", PATH: NPM },
    isFile: files(shim, `${NPM}\\codex.exe`) });
  assert.equal(found.command, "C:\\Windows\\system32\\cmd.exe");
  assert.deepEqual(found.args, ["/d", "/s", "/c", `""${shim}" "app-server" "--listen" "stdio://""`]);
  assert.equal(found.options.windowsVerbatimArguments, true);
  assert.throws(() => codexCommand(ARGS, { platform: "win32", env: { CODEX_CLI_PATH: "C:\\100%\\codex.cmd" }, isFile: () => false }), /cmd\.exe/);
  // An .exe path, found or configured, runs as is; nothing found leaves the bare name to fail as "not found".
  assert.equal(codexCommand(ARGS, { platform: "win32", env: { CODEX_CLI_PATH: "D:\\codex.exe" }, isFile: () => false }).command, "D:\\codex.exe");
  assert.equal(codexCommand(ARGS, { platform: "win32", env: { PATH: "C:\\none" }, isFile: () => false }).command, "codex");
});

test("a computer without the Codex CLI is told it is optional, not shown a fault to fix", () => {
  const now = 1_800_000_000_000;
  const missing = codexSourceState({ state: "unavailable", lastError: CODEX_NOT_FOUND, nextRetryAt: now + 60_000 }, { now });
  assert.equal(missing.state, "not-installed");
  assert.equal(missing.detail, "Optional: install the Codex CLI to see Codex chats.");
  // Each quiet retry briefly reads "starting"; it is still not installed.
  assert.equal(codexSourceState({ state: "restarting", lastError: CODEX_NOT_FOUND, nextRetryAt: 0 }, { now }).state, "not-installed");
  const crashed = codexSourceState({ state: "unavailable", lastError: "Codex stopped (exit code 3).", nextRetryAt: now + 5000 }, { now, restarts: 2 });
  assert.equal(crashed.state, "unavailable");
  assert.match(crashed.detail, /Retrying in 5s/);
  assert.equal(crashed.restarts, 2);
  assert.equal(codexSourceState({ state: "ready", lastError: "", nextRetryAt: 0 }, { now }).state, "ok");
  assert.equal(codexSourceState({ state: "starting", lastError: "", nextRetryAt: 0 }, { now }).state, "starting");
});
