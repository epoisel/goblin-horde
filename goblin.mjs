#!/usr/bin/env node
/**
 * Goblin Horde manager for Windows, macOS, and Linux.
 *
 *   node goblin.mjs doctor                  Check what this computer has; changes nothing.
 *   node goblin.mjs install [--claude-hooks | --no-claude-hooks]
 *   node goblin.mjs start | stop | status | open [--compact]
 *   node goblin.mjs uninstall [--remove-settings]
 *   node goblin.mjs hooks install | remove | status
 *   node goblin.mjs emit --feed NAME [--check] [--record '{...}']   (or NDJSON on stdin)
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

const { ManagerError, doctor, getLocalJson, hooksInstall, hooksRemove, hooksStatus, install, locate, makeContext, start, status, stop, uninstall } = await import("./lib/manager.mjs");
const { appendExtensionRecord, extensionFeedDir, validateExtensionRecord } = await import("./lib/extension.mjs");

const BOOLEAN = new Set(["json", "no-start", "skip-skill", "remove-settings", "claude-hooks", "no-claude-hooks", "check", "no-browser", "compact", "help", "report"]);
const VALUE = new Set(["install-dir", "state-dir", "claude-config-dir", "codex-home", "codex-skill-dir", "port", "ui", "feed", "record"]);

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
    codexSkillDir: flags["codex-skill-dir"], port: flags.port, ui: flags.ui,
    noStart: Boolean(flags["no-start"]), skipSkill: Boolean(flags["skip-skill"]), removeSettings: Boolean(flags["remove-settings"]),
    claudeHooks: flags["claude-hooks"] ? true : flags["no-claude-hooks"] ? false : undefined,
    openBrowser: !flags["no-browser"],
  };
}

const HELP = `Goblin Horde manager

  node goblin.mjs doctor            Check prerequisites, feeds, and the port. Changes nothing.
  node goblin.mjs doctor --report   A short report safe to paste into a bug report: states, counts, and
                                    timings only, with no chats, names, paths, or pairing codes.
  node goblin.mjs install           Copy the app to your user folder and start it.
      --claude-hooks                Also connect Claude Code (adds hooks to your Claude settings).
      --no-claude-hooks             Do not connect Claude Code (removes this installation's hooks if present).
      --no-start                    Install without starting.
  node goblin.mjs start             Start the viewer (and desktop goblins on Windows and macOS).
      --ui auto|widget|browser|none --no-browser
  node goblin.mjs open [--compact]  Open the viewer in your browser.
  node goblin.mjs stop              Stop only this installation's own processes.
  node goblin.mjs status            Show what is installed and running.
  node goblin.mjs uninstall         Remove the app, its skills, and its Claude Code hooks.
      --remove-settings             Also remove settings, the pairing code, and recorded activity.
  node goblin.mjs hooks install|remove|status
  node goblin.mjs emit --feed NAME  Validate and record extension-feed events (NDJSON on stdin,
      or --record '{"v":1,...}'). --check validates without recording. See EXTENSIONS.md.

Options: --install-dir DIR --state-dir DIR --claude-config-dir DIR --codex-home DIR --port N --json
Environment: GOBLIN_HORDE_INSTALL_DIR, GOBLIN_HORDE_STATE_DIR, CLAUDE_CONFIG_DIR, CODEX_HOME.`;

function printDoctor(report, log) {
  const marks = { ok: "✓", missing: "✗", error: "✗", conflict: "✗", optional: "·", none: "·", unsupported: "·" };
  log(`Goblin Horde check (${report.platform})`);
  for (const check of report.checks) log(`  ${marks[check.state] || "·"} ${check.name.padEnd(16)} ${check.detail}`);
  log(`  Install folder: ${report.installDir}`);
  log(`  State folder:   ${report.stateDir}`);
}

function printStatus(report, log) {
  log(report.installed ? `Installed: yes (${report.version || "unknown version"}) at ${report.installDir}` : `Installed: no (${report.installDir})`);
  log(report.server ? `Viewer: running (process ${report.server.pid}) at ${report.url}${report.server.healthy ? "" : " - not answering yet"}` : "Viewer: stopped");
  log(report.widget ? `Desktop goblins: running (process ${report.widget.pid})` : ["win32", "darwin"].includes(process.platform) ? "Desktop goblins: stopped" : "Desktop goblins: Windows and macOS only; using the browser viewer");
  const hooks = report.claudeHooks;
  log(`Claude Code: ${hooks.state === "installed" && !hooks.broken ? "connected" : hooks.state === "unreadable" ? `settings unreadable (${hooks.error})` : hooks.broken ? "hook points to a missing file; run: node goblin.mjs hooks install" : hooks.state === "partial" ? "partly connected" : "not connected"}${hooks.disabled ? " (all hooks are disabled in Claude Code settings)" : ""}`);
  log(`Extension feeds: ${report.feeds.length ? report.feeds.map((feed) => feed.feed).join(", ") : "none"}`);
  if (report.sources) {
    for (const [name, source] of Object.entries(report.sources)) log(`  ${name}: ${source.state} - ${source.detail}`);
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 4_000_000) throw new ManagerError("Too much input for one emit (4 MB limit).");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function emit(ctx, flags) {
  const loc = locate(ctx, managerFlags(flags));
  const feed = flags.feed || "";
  const lines = flags.record ? [flags.record] : (await readStdin()).split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) throw new ManagerError("Nothing to emit. Pass --record '{...}' or NDJSON on stdin.");
  const results = [];
  for (const [index, line] of lines.entries()) {
    let raw;
    try { raw = JSON.parse(line); } catch { results.push({ line: index + 1, ok: false, errors: ["Not valid JSON."] }); continue; }
    if (raw && typeof raw === "object" && !Array.isArray(raw) && feed && raw.feed === undefined) raw.feed = feed;
    if (flags.check) {
      const { record, errors, dropped } = validateExtensionRecord(raw);
      results.push({ line: index + 1, ok: Boolean(record), errors, dropped });
    } else {
      const outcome = appendExtensionRecord(raw, { dir: extensionFeedDir(loc.stateDir) });
      results.push({ line: index + 1, ok: outcome.ok, errors: outcome.errors, dropped: outcome.dropped });
    }
  }
  return { accepted: results.filter((item) => item.ok).length, rejected: results.filter((item) => !item.ok).length, results, checkOnly: Boolean(flags.check) };
}

/**
 * `doctor --report`: what to paste into a bug report. Check names and states only (their details can
 * hold folder paths), plus the running viewer's own diagnostic summary when it answers.
 */
async function safeReport(report, ctx, options) {
  const lines = [`Goblin Horde doctor (${report.platform}): ` + report.checks.map((check) => `${check.name} ${check.state}`).join(" · ")];
  try {
    const port = locate(ctx, options).port;
    const live = await getLocalJson(port, "/api/diagnostics", 4000);
    if (live?.text) lines.push(live.text);
    else lines.push("Viewer: no live report (it is not running, or it is an older version; start or reinstall it).");
  } catch {
    lines.push("Viewer: not answering on its port (start it with: node goblin.mjs start).");
  }
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2), ctx = makeContext({ sourceDir: dirname(fileURLToPath(import.meta.url)) })) {
  const { command, sub, flags } = parseArgs(argv);
  const options = managerFlags(flags);
  const log = ctx.log;
  const out = (data, print) => (flags.json ? log(JSON.stringify(data, null, 2)) : print(data));
  if (flags.help) { log(HELP); return 0; }
  switch (command) {
    case "help":
      log(HELP);
      return 0;
    case "doctor": {
      const report = await doctor(ctx, options);
      if (flags.report) {
        log(await safeReport(report, ctx, options));
        return 0;
      }
      out(report, (data) => printDoctor(data, log));
      return report.checks.some((check) => check.name === "node" && check.state !== "ok") ? 2 : 0;
    }
    case "status":
      out(await status(ctx, options), (data) => printStatus(data, log));
      return 0;
    case "install": {
      const result = await install(ctx, options);
      out(result, (data) => { for (const line of [...data.messages, ...(data.started?.messages || [])]) log(line); });
      return 0;
    }
    case "start": {
      const result = await start(ctx, options);
      out(result, (data) => { for (const line of data.messages) log(line); });
      return 0;
    }
    case "open": {
      const loc = locate(ctx, options);
      const url = `http://127.0.0.1:${loc.port}/${flags.compact ? "?compact=1" : ""}`;
      ctx.openUrl(url, ctx.platform);
      out({ url }, () => log(`Opened ${url}`));
      return 0;
    }
    case "stop": {
      const result = await stop(ctx, options);
      out(result, (data) => { log(data.stopped ? `Goblin Horde stopped (${data.stopped} ${data.stopped === 1 ? "process" : "processes"}).` : "Goblin Horde was not running."); for (const line of data.notes) log(line); });
      return 0;
    }
    case "uninstall": {
      const result = await uninstall(ctx, options);
      out(result, (data) => { for (const line of data.messages) log(line); });
      return 0;
    }
    case "hooks": {
      if (sub === "install") { const result = hooksInstall(ctx, options); out(result, (data) => log(data.message)); return 0; }
      if (sub === "remove") { const result = hooksRemove(ctx, options); out(result, (data) => log(data.message)); return 0; }
      if (sub === "status" || !sub) {
        const report = hooksStatus(ctx, options);
        out(report, (data) => log(`Claude Code hooks: ${data.state}${data.error ? ` (${data.error})` : ""}${data.disabled ? " - disableAllHooks is on" : ""} in ${data.settingsPath}`));
        return 0;
      }
      throw new ManagerError("Use: node goblin.mjs hooks install|remove|status");
    }
    case "emit": {
      const result = await emit(ctx, flags);
      out(result, (data) => {
        log(`${data.checkOnly ? "Valid" : "Recorded"}: ${data.accepted}. Rejected: ${data.rejected}.`);
        for (const item of data.results) {
          for (const error of item.errors || []) log(`  line ${item.line}: ${error}`);
          if (item.dropped?.length) log(`  line ${item.line}: ignored unknown fields ${item.dropped.join(", ")}`);
        }
      });
      return result.rejected ? 1 : 0;
    }
    default:
      throw new ManagerError(`Unknown command "${command}". Run: node goblin.mjs help`);
  }
}

// Run only when started as a program, not when tests import main().
const self = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
const invokedDirectly = process.platform === "win32" ? invoked.toLowerCase() === self.toLowerCase() : invoked === self;

if (invokedDirectly) {
  try {
    process.exitCode = await main();
  } catch (error) {
    if (error?.name === "ManagerError" || error?.name === "HookSettingsError") {
      console.error(error.message);
      process.exitCode = error.exitCode || 1;
    } else {
      console.error(`Goblin Horde manager failed: ${error?.message || error}`);
      process.exitCode = 1;
    }
  }
}
