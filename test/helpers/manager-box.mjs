/**
 * An invented computer for tests of the manager's shared game commands: temporary folders, a port nothing listens
 * on, a scripted tailscale program, and a saved game as another computer would hand it over. Nothing here runs
 * the real tailscale program or touches this computer's state folder.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeContext } from "../../lib/manager.mjs";
import { createState, loadConfig } from "../../lib/rewards.mjs";
import { CODE } from "./shared-host.mjs";
import { TRAP } from "./t3-fixture.mjs";
import { freePort } from "./viewer.mjs";

export const CONFIG = loadConfig(fileURLToPath(new URL("../../game_config.json", import.meta.url)));
export const OWNER = "owner@example.com";
export const MIN = 60_000;
export const DAY = 24 * 60 * MIN;
// Any three letters of the code in a row, anywhere, would be a leak of part of it.
export const PARTS = [0, 1, 2, 3, 4, 5].map((start) => CODE.slice(start, start + 3));
const TAILSCALE = "C:\\Program Files\\Tailscale\\tailscale.exe";

/**
 * A computer for the manager: temporary folders, a port nothing listens on, and a tailscale program that is
 * either absent or answers from `tailscale` ({ login, address, peers: { ip: login } }). `context` replaces
 * pieces of the manager's context, such as its clock.
 */
export async function computer(t, { tailscale = null, env = {}, adapters, context = {} } = {}) {
  // The temp folder by its real path: on some computers its usual name goes through a link, and pets-adopt reads no file through one.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "goblin-shared-manager-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lines = [];
  const ran = [];
  const stateDir = join(root, "state");
  const status = (login) => JSON.stringify({ BackendState: login ? "Running" : "NeedsLogin", Self: { UserID: 1, DNSName: "servitor.tail1234.ts.net.", TailscaleIPs: [tailscale.address] },
    User: { 1: { LoginName: login } } });
  const interfaces = adapters ?? (tailscale?.address ? { Tailscale: [{ family: "IPv4", internal: false, address: tailscale.address }] } : {});
  const ctx = makeContext({
    platform: "win32", home: join(root, "home"), log: (line) => lines.push(line), listProcesses: () => [], openUrl: () => {},
    env: { CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_HOME: join(root, "codex"), LOCALAPPDATA: join(root, "local"), ProgramFiles: "C:\\Program Files", GOBLIN_T3_DB: join(root, "no-t3.sqlite"), ...env },
    nodeVersion: () => "22.13.0", which: () => "", probe: () => "", exists: (path) => Boolean(tailscale) && path === TAILSCALE, openT3: async () => ({ ok: false, reason: "missing", message: "No T3." }),
    interfaces: () => interfaces,
    runTailscale: async (cli, args) => {
      ran.push(args.join(" "));
      if (args[0] === "ip") return `${tailscale.address}\n`;
      if (args[0] === "status") return status(tailscale.login);
      const login = tailscale.peers?.[args.at(-1)] ?? (args.at(-1) === tailscale.address ? tailscale.login : null);
      if (login === null) throw new Error("no such peer");
      return JSON.stringify({ Node: {}, UserProfile: { LoginName: login } });
    },
    ...context,
  });
  const flags = { installDir: join(root, "app"), stateDir, port: await freePort() };
  const argv = ["--install-dir", flags.installDir, "--state-dir", stateDir, "--port", String(flags.port)];
  return { root, ctx, flags, argv, stateDir, lines, ran, said: () => lines.join("\n") };
}
export const servitor = { login: OWNER, address: "100.101.102.103" };

/** A saved game as another computer would hand it over, with text no save should carry. */
export function laptopSave({ coins = 4321, horde = 17, bosses = 4, lastSeenAt = Date.now() - 10 * DAY } = {}) {
  const state = createState(CONFIG, "2026-11-01");
  return {
    schema: 1, lastSeenAt, note: TRAP.prompt, apiKey: TRAP.secret,
    state: { ...state, wallet: { coins, scrap: 9, lifetimeCoins: 9000 }, horde: { ...state.horde, size: horde, level: 3 }, bosses: { cleared: bosses }, title: TRAP.title },
    sources: { t3: { at: Date.now() - 10 * DAY, seen: ["laptop-turn-1", "laptop-turn-2"] }, other: { path: TRAP.label } },
  };
}
/** Write `save` (a saved game, or any text) as `name` in the computer's own folder, and return its path. */
export function saveFile(box, save = laptopSave(), name = "laptop-pets.json") {
  const file = join(box.root, name);
  writeFileSync(file, typeof save === "string" ? save : JSON.stringify(save));
  return file;
}
export const saved = (box) => JSON.parse(readFileSync(join(box.stateDir, "pets.json"), "utf8"));
export const plain = (error) => error.name === "ManagerError";
