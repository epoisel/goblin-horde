#!/usr/bin/env node
/**
 * Goblin Horde manager, for the pet game on Windows.
 *
 *   node goblin.mjs doctor                  Check what this computer has; changes nothing.
 *   node goblin.mjs install | start | stop | status
 *   node goblin.mjs uninstall [--remove-settings]
 *   node goblin.mjs pets-host enable | disable | status | code      Share this computer's pet game on Tailscale.
 *   node goblin.mjs pets-join --host ADDRESS[:PORT] --code-file FILE | --off
 *   node goblin.mjs pets-adopt PATH [--replace]
 *   node goblin.mjs update [--check | --rollback | --off | --on]     Signed updates from GitHub releases.
 *
 * Common options: --install-dir DIR, --state-dir DIR, --claude-config-dir DIR, --codex-home DIR,
 * --port N, --json (machine-readable output). See README.md.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  console.error(`Goblin Horde needs Node.js 20 or newer (this is ${process.versions.node}).`);
  process.exit(2);
}

const { ManagerError, doctor, install, makeContext, skipReason, start, status, stop, uninstall, update, windowsOnly } = await import("./lib/manager.mjs");
const { petsAdopt, petsHost, petsHostCode, petsJoin } = await import("./lib/shared-manager.mjs");

const BOOLEAN = new Set(["json", "no-start", "skip-skill", "remove-settings", "help", "off", "replace", "code-stdin", "check", "rollback", "on", "apply-staged", "no-update"]);
const VALUE = new Set(["install-dir", "state-dir", "claude-config-dir", "codex-home", "codex-skill-dir", "port", "host", "code-file"]);

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (BOOLEAN.has(name)) { flags[name] = true; continue; }
    if (!VALUE.has(name)) throw new ManagerError(`Unknown option --${name}. Run: node goblin.mjs help`);
    const value = inline ?? argv[++index];
    if (value === undefined || value.startsWith("--")) throw new ManagerError(`--${name} needs a value.`);
    flags[name] = value;
  }
  return { command: positional[0] || "help", sub: positional[1] || "", rest: positional.slice(1), flags };
}

function managerFlags(flags) {
  return {
    installDir: flags["install-dir"], stateDir: flags["state-dir"], claudeConfigDir: flags["claude-config-dir"], codexHome: flags["codex-home"],
    codexSkillDir: flags["codex-skill-dir"], port: flags.port,
    noStart: Boolean(flags["no-start"]), skipSkill: Boolean(flags["skip-skill"]), removeSettings: Boolean(flags["remove-settings"]), noUpdate: Boolean(flags["no-update"]),
  };
}

const HELP = `Goblin Horde manager (the pet game, on Windows)

  node goblin.mjs doctor            Check what the pet game needs, the port, and the shared game.
                                    Changes nothing.
  node goblin.mjs install           Copy the app to your user folder and start it.
      --no-start                    Install without starting.
  node goblin.mjs start             Start the game's server and the desktop goblins.
  node goblin.mjs stop              Stop only this installation's own processes.
  node goblin.mjs status            Show what is installed and running.
  node goblin.mjs uninstall         Remove the app and its manager skills. The saved game and settings stay.
      --remove-settings             Also remove settings, the saved pet game, and the pairing code.
  node goblin.mjs pets-host enable  Share this computer's pet game with your other computers on Tailscale. It
                                    listens on this computer's Tailscale address only, and a caller needs the
                                    pairing code. This computer keeps the one saved game and pays the coins.
      disable | status              Stop sharing and sign every computer out, or show the address to join.
      code                          Show the pairing code, only in a terminal on this computer.
  node goblin.mjs pets-join --host ADDRESS[:PORT] --code-file FILE
                                    Show the game of the computer at that Tailscale address here. Then
                                    "stop" and "start" show its horde. --code-stdin reads the code from
                                    standard input. The code is never taken from the command line.
      --off                         Go back to this computer's own game.
  node goblin.mjs pets-adopt PATH   On a host with no saved game: start from a pets.json brought from another
                                    computer. Earlier work here is not paid. --replace keeps a copy of the
                                    present saved game and replaces it.
  node goblin.mjs update            Look on github.com for a newer signed release, and put it in place now.
                                    A release is used only once its signature and files check out.
      --check                       Only say what is there. Changes nothing.
      --off | --on                  Stop or resume the daily look the running game makes by itself. A
                                    release it finds is put in place at the next start.
      --rollback                    Go back to the version installed before the last update.

Options: --install-dir DIR --state-dir DIR --claude-config-dir DIR --codex-home DIR --codex-skill-dir DIR --port N --json
Environment: GOBLIN_HORDE_INSTALL_DIR, GOBLIN_HORDE_STATE_DIR, CLAUDE_CONFIG_DIR, CODEX_HOME.`;

function printDoctor(report, log) {
  const marks = { ok: "✓", missing: "✗", error: "✗", conflict: "✗", warning: "!", optional: "·", none: "·" };
  const line = (check) => log(`  ${marks[check.state] || "·"} ${check.name.padEnd(16)} ${check.detail}`);
  log(`Goblin Horde check (${report.platform})`);
  report.checks.filter((check) => !check.group).forEach(line);
  log("  Pet game:");
  report.checks.filter((check) => check.group === "pets").forEach(line);
  log("  Shared game (pets-host, pets-join):");
  report.checks.filter((check) => check.group === "shared").forEach(line);
  log("  Updates:");
  report.checks.filter((check) => check.group === "update").forEach(line);
  log(`  Install folder: ${report.installDir}`);
  log(`  State folder:   ${report.stateDir}`);
}

function printStatus(report, log) {
  log(report.installed ? `Installed: yes (${report.version || "unknown version"}) at ${report.installDir}` : `Installed: no (${report.installDir})`);
  log(report.server ? `Server: running (process ${report.server.pid}) at ${report.url}${report.server.healthy ? "" : " - not answering yet"}` : "Server: stopped");
  log(report.widget ? `Desktop goblins: running (process ${report.widget.pid})` : "Desktop goblins: stopped");
  const { update } = report;
  if (!update.key) log("Updates: this build has no update key, so it cannot check for updates.");
  else log(update.checking ? "Updates: the game looks on github.com once a day (update --off turns that off)." : "Updates: the game does not look by itself (update --on turns that on).");
  log(update.lastCheck ? `Last update check: ${update.lastCheck.checkedAt}. ${update.lastCheck.message}` : "Last update check: none yet.");
  if (update.staged) log(`Update waiting: Goblin Horde ${update.staged}, put in place at the next start.`);
  if (update.skip) log(`Not put in place by itself: ${update.skip.version}, because ${skipReason(update.skip)}.`);
  for (const note of report.notes || []) log(note);
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 4096) throw new ManagerError("Too much input on standard input.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function main(argv = process.argv.slice(2), ctx = makeContext({ sourceDir: dirname(fileURLToPath(import.meta.url)) })) {
  const { command, sub, flags } = parseArgs(argv);
  const options = managerFlags(flags);
  const log = ctx.log;
  const out = (data, print) => (flags.json ? log(JSON.stringify(data, null, 2)) : print(data));
  const lines = (data) => { for (const line of data.messages) log(line); };
  if (flags.help || command === "help") { log(HELP); return 0; }
  if (ctx.platform !== "win32") throw windowsOnly(ctx.platform);
  switch (command) {
    case "doctor": {
      const report = await doctor(ctx, options);
      out(report, (data) => printDoctor(data, log));
      return report.checks.some((check) => check.name === "node" && check.state !== "ok") ? 2 : 0;
    }
    case "status":
      out(await status(ctx, options), (data) => printStatus(data, log));
      return 0;
    case "install":
      out(await install(ctx, options), (data) => { for (const line of [...data.messages, ...(data.started?.messages || [])]) log(line); });
      return 0;
    case "start":
      out(await start(ctx, options), lines);
      return 0;
    case "stop":
      out(await stop(ctx, options), (data) => { log(data.stopped ? `Goblin Horde stopped (${data.stopped} ${data.stopped === 1 ? "process" : "processes"}).` : "Goblin Horde was not running."); for (const line of data.notes) log(line); });
      return 0;
    case "uninstall":
      out(await uninstall(ctx, options), lines);
      return 0;
    case "pets-host":
      if (sub === "code") {
        petsHostCode(ctx, options);
        return 0;
      }
      out(await petsHost(ctx, options, sub || "status"), lines);
      return 0;
    case "pets-join":
      out(await petsJoin(ctx, options, { host: flags.host, codeFile: flags["code-file"], off: Boolean(flags.off),
        ...(flags["code-stdin"] ? { codeText: await readStdin() } : {}) }), lines);
      return 0;
    case "pets-adopt":
      out(await petsAdopt(ctx, options, { path: sub, replace: Boolean(flags.replace) }), lines);
      return 0;
    case "update": {
      const result = await update(ctx, options, { check: Boolean(flags.check), rollback: Boolean(flags.rollback), on: Boolean(flags.on), off: Boolean(flags.off),
        applyStaged: Boolean(flags["apply-staged"]) });
      out(result, lines);
      return result.ok ? 0 : 1;
    }
    default:
      throw new ManagerError(`Unknown command "${command}". Run: node goblin.mjs help`);
  }
}

// Run only when started as a program, not when tests import main().
const self = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? resolve(process.argv[1]) : "";

if (invoked.toLowerCase() === self.toLowerCase()) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error?.name === "ManagerError" ? error.message : `Goblin Horde manager failed: ${error?.message || error}`);
    process.exitCode = error?.exitCode || 1;
  }
}
