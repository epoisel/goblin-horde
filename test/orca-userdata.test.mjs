import test from "node:test";
import assert from "node:assert/strict";
import { win32 } from "node:path";
import { OrcaReader, orcaUserDataPath } from "../lib/orca.mjs";

// A packaged app (the Codex desktop app is one) gets its own copy of %APPDATA%: an Orca it starts writes its
// runtime file there, and the usual file keeps naming an Orca that is long gone.
const ENV = { APPDATA: "C:\\Users\\dev\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" };
const STANDARD = win32.join(ENV.APPDATA, "orca");
const PACKAGED = win32.join(ENV.LOCALAPPDATA, "Packages", "Vendor.App_abc123", "LocalCache", "Roaming", "orca");

function world(files) {
  return {
    existsSync: (path) => path in files,
    readdirSync: (path) => (path === win32.join(ENV.LOCALAPPDATA, "Packages") ? ["Vendor.App_abc123", "Other.App_x", "bad name!"] : []),
    readFileSync: (path) => { if (!(path in files)) throw new Error("ENOENT"); return files[path]; },
  };
}
const runtime = (pid, startedAt) => JSON.stringify({ runtimeId: "r", pid, startedAt });

test("the Orca CLI is pointed at the packaged app's copy when only that one names a running Orca", () => {
  const fs = world({ [win32.join(STANDARD, "orca-runtime.json")]: runtime(111, 1), [win32.join(PACKAGED, "orca-runtime.json")]: runtime(222, 2) });
  assert.equal(orcaUserDataPath({ env: ENV, platform: "win32", fs, alive: (pid) => pid === 222 }), PACKAGED);
});

test("the usual folder is kept when its Orca is the running one, or when no copy names a running Orca", () => {
  const fs = world({ [win32.join(STANDARD, "orca-runtime.json")]: runtime(111, 5), [win32.join(PACKAGED, "orca-runtime.json")]: runtime(222, 2) });
  assert.equal(orcaUserDataPath({ env: ENV, platform: "win32", fs, alive: (pid) => pid === 111 }), null);
  assert.equal(orcaUserDataPath({ env: ENV, platform: "win32", fs, alive: () => false }), null);
  // Both running: the one started last.
  assert.equal(orcaUserDataPath({ env: ENV, platform: "win32", fs, alive: () => true }), null);
  const newer = world({ [win32.join(STANDARD, "orca-runtime.json")]: runtime(111, 1), [win32.join(PACKAGED, "orca-runtime.json")]: runtime(222, 9) });
  assert.equal(orcaUserDataPath({ env: ENV, platform: "win32", fs: newer, alive: () => true }), PACKAGED);
});

test("a folder the person chose, other systems, and unreadable files leave the CLI's default alone", () => {
  const fs = world({ [win32.join(PACKAGED, "orca-runtime.json")]: "{ broken" });
  assert.equal(orcaUserDataPath({ env: { ...ENV, ORCA_USER_DATA_PATH: "D:\\orca" }, platform: "win32", fs, alive: () => true }), null);
  assert.equal(orcaUserDataPath({ env: ENV, platform: "darwin", fs, alive: () => true }), null);
  assert.equal(orcaUserDataPath({ env: ENV, platform: "win32", fs, alive: () => true }), null, "a broken runtime file names no Orca");
});

test("every CLI call carries the folder found, looked up again at most every 30 seconds", async () => {
  let lookups = 0;
  const calls = [];
  let now = 1_000_000;
  const reader = new OrcaReader({
    clock: () => now,
    userData: () => { lookups++; return PACKAGED; },
    run: async (command, args, options) => { calls.push(options); return { stdout: JSON.stringify({ ok: true, result: {} }) }; },
  });
  await reader.call(["status", "--json"]);
  await reader.call(["status", "--json"]);
  assert.equal(lookups, 1);
  assert.equal(calls[0].env.ORCA_USER_DATA_PATH, PACKAGED);
  assert.equal(calls[1].env.ORCA_USER_DATA_PATH, PACKAGED);
  now += 31_000;
  await reader.call(["status", "--json"]);
  assert.equal(lookups, 2);
  const plain = new OrcaReader({ userData: () => null, run: async (command, args, options) => { calls.push(options); return { stdout: "{\"ok\":true,\"result\":{}}" }; } });
  await plain.call(["status", "--json"]);
  assert.equal(calls.at(-1).env, undefined, "without a found folder the CLI runs with the viewer's own environment");
});
