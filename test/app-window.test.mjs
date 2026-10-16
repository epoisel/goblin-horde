import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { APP_CACHE_BYTES, APP_WINDOW_SIZE, appUrl, appWindowCommand, findAppBrowser, openAppWindow } from "../lib/app-window.mjs";
import { main } from "../goblin.mjs";
import { makeContext } from "../lib/manager.mjs";

const WINDOWS_ENV = { "ProgramFiles(x86)": "C:\\Program Files (x86)", ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\you\\AppData\\Local" };
const EDGE_X86 = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

function spawner(fail = () => false) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    if (fail(command)) throw new Error("cannot start");
    return { on() {}, unref() {} };
  };
  return { calls, spawn };
}

test("the address is the local task view, with its task and agent in the hash, and nothing else", () => {
  assert.equal(appUrl(44901), "http://127.0.0.1:44901/app");
  assert.equal(appUrl(44901, { taskId: "chat-0001-lead", agentId: "claude-agent:abc:def" }), "http://127.0.0.1:44901/app#task=chat-0001-lead&focus=claude-agent%3Aabc%3Adef");
  assert.throws(() => appUrl(44901, { taskId: "x\" --flag" }), /valid task/);
  assert.throws(() => appUrl(44901, { agentId: "a b" }), /valid agent/);
  assert.throws(() => appUrl(80), /valid port/);
  assert.throws(() => appWindowCommand({ platform: "win32", browser: { kind: "edge", path: EDGE_X86 }, url: "https://example.com/", profileDir: "C:\\s" }), /Only the task view/);
  assert.throws(() => appWindowCommand({ platform: "win32", browser: { kind: "edge", path: EDGE_X86 }, url: "http://127.0.0.1:44901/app#x\" --remote-debugging-port=1", profileDir: "C:\\s" }));
});

test("Windows opens Edge as an app window with Goblin Horde's own profile, looking in Program Files (x86) first, then the registry, then Chrome", () => {
  const { calls, spawn } = spawner();
  const result = openAppWindow({ port: 44902, taskId: "chat-0001-lead", stateDir: "C:\\Users\\you\\AppData\\Local\\GoblinHorde", platform: "win32", env: WINDOWS_ENV, spawn,
    exists: (path) => path === EDGE_X86, registry: () => "" });
  assert.deepEqual(result, { opened: true, browser: "edge", url: "http://127.0.0.1:44902/app#task=chat-0001-lead" });
  assert.equal(calls[0].command, EDGE_X86);
  assert.deepEqual(calls[0].args, ["--app=http://127.0.0.1:44902/app#task=chat-0001-lead", "--user-data-dir=C:\\Users\\you\\AppData\\Local\\GoblinHorde\\app-window",
    "--no-first-run", "--no-default-browser-check", "--disable-sync", `--disk-cache-size=${APP_CACHE_BYTES}`, `--window-size=${APP_WINDOW_SIZE}`]);
  assert.equal(calls[0].options.shell, undefined, "never through a shell");
  assert.equal(calls[0].options.detached, true);
  const registered = "D:\\Apps\\Edge\\msedge.exe";
  assert.deepEqual(findAppBrowser({ platform: "win32", env: WINDOWS_ENV, exists: (path) => path === registered, registry: (exe) => (exe === "msedge.exe" ? registered : "") }),
    { kind: "edge", path: registered });
  const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  assert.deepEqual(findAppBrowser({ platform: "win32", env: WINDOWS_ENV, exists: (path) => path === chrome, registry: () => "" }), { kind: "chrome", path: chrome });
  assert.deepEqual(findAppBrowser({ platform: "win32", env: WINDOWS_ENV, exists: () => false, registry: () => "relative\\msedge.exe" }), { kind: "default", path: "" });
  // Without either browser, the default browser opens the address.
  const fallback = spawner();
  openAppWindow({ port: 44902, stateDir: "C:\\state", platform: "win32", env: WINDOWS_ENV, spawn: fallback.spawn, exists: () => false, registry: () => "" });
  assert.deepEqual(fallback.calls[0], { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", "http://127.0.0.1:44902/app"], options: fallback.calls[0].options });
  // A chosen browser (GOBLIN_HORDE_APP_BROWSER) wins when it is an absolute path that exists.
  assert.deepEqual(findAppBrowser({ platform: "win32", env: { ...WINDOWS_ENV, GOBLIN_HORDE_APP_BROWSER: "E:\\Brave\\brave.exe" }, exists: () => true, registry: () => "" }),
    { kind: "custom", path: "E:\\Brave\\brave.exe" });
});

test("macOS opens a new Edge or Chrome app instance with open -na, else the default browser", () => {
  const exists = (path) => path === "/Applications/Google Chrome.app/Contents/Info.plist";
  const { calls, spawn } = spawner();
  openAppWindow({ port: 44903, agentId: "chat-0002-x", stateDir: "/Users/you/Library/Application Support/GoblinHorde", platform: "darwin", env: { HOME: "/Users/you" }, spawn, exists });
  assert.equal(calls[0].command, "open");
  assert.deepEqual(calls[0].args.slice(0, 3), ["-na", "Google Chrome", "--args"]);
  assert.equal(calls[0].args[3], "--app=http://127.0.0.1:44903/app#focus=chat-0002-x");
  assert.equal(calls[0].args[4], `--user-data-dir=${posix.join("/Users/you/Library/Application Support/GoblinHorde", "app-window")}`);
  const plain = spawner();
  openAppWindow({ port: 44903, stateDir: "/Users/you/state", platform: "darwin", env: { HOME: "/Users/you" }, spawn: plain.spawn, exists: () => false });
  assert.deepEqual([plain.calls[0].command, plain.calls[0].args], ["open", ["http://127.0.0.1:44903/app"]]);
});

test("Linux looks for Edge, Chrome, or Chromium on PATH, else xdg-open; a browser that will not start falls back to the default one", () => {
  const exists = (path) => path === "/usr/bin/chromium";
  assert.deepEqual(findAppBrowser({ platform: "linux", env: { PATH: "relative:/usr/local/bin:/usr/bin" }, exists }), { kind: "chromium", path: "/usr/bin/chromium" });
  const { calls, spawn } = spawner((command) => command === "/usr/bin/chromium");
  const result = openAppWindow({ port: 44904, stateDir: "/home/you/.local/state/goblin-horde", platform: "linux", env: { PATH: "/usr/bin" }, spawn, exists });
  assert.deepEqual(result, { opened: true, browser: "default", url: "http://127.0.0.1:44904/app" });
  assert.deepEqual(calls.map((call) => call.command), ["/usr/bin/chromium", "xdg-open"]);
  const none = spawner(() => true);
  assert.equal(openAppWindow({ port: 44904, stateDir: "/s", platform: "linux", env: {}, spawn: none.spawn, exists: () => false }).opened, false);
  assert.throws(() => openAppWindow({ port: 44904, stateDir: "relative", platform: "linux", env: {}, spawn: none.spawn }), /state folder/);
  assert.equal(win32.isAbsolute(join("C:\\x", "app-window")), true);
});

test("goblin.mjs app opens the task view for the running viewer, and says how to start one that is not", async () => {
  const state = mkdtempSync(join(tmpdir(), "goblin-app-cmd-"));
  const server = createServer((request, response) => {
    response.writeHead(request.url === "/api/health" ? 200 : 404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ product: "GoblinHorde", version: "0.6.0" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const opened = [];
    const lines = [];
    // Every folder temporary: nothing of a real installation is read.
    const env = { ...process.env, LOCALAPPDATA: join(state, "local"), APPDATA: join(state, "roaming"), HOME: state, USERPROFILE: state };
    const ctx = makeContext({ env, log: (line) => lines.push(line), openApp: (options) => { opened.push(options); return { opened: true, browser: "edge", url: appUrl(options.port, options) }; } });
    assert.equal(await main(["app", "--port", String(port), "--state-dir", state, "--install-dir", join(state, "app"), "--task", "chat-0001-lead"], ctx), 0);
    assert.equal(opened[0].port, port);
    assert.equal(opened[0].taskId, "chat-0001-lead");
    assert.equal(opened[0].stateDir, state);
    assert.match(lines[0], /Opened the task view \(edge\)/);
    await new Promise((resolve) => server.close(resolve));
    await assert.rejects(main(["app", "--port", String(port), "--state-dir", state, "--install-dir", join(state, "app")], ctx), /not running on port/);
  } finally {
    server.close();
    rmSync(state, { recursive: true, force: true });
  }
});
