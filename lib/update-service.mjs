/**
 * The running game's side of updates. Two minutes after the server starts, and about once a day after that, it looks
 * on GitHub for a newer signed release, unless update --off turned that off, and keeps one that passes every check in
 * the state folder for the next start (lib/updater.mjs). The version it keeps is what GET /api/pets reports, so the
 * desktop goblins can offer it, and POST /api/update/apply starts this installation's own manager to put it in place
 * now (`update --apply-staged`), answering at once, since that manager stops this server.
 */
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { UPDATE_LOG, automaticRule, checkForUpdate, findStaged, githubSources, readSettings, readSkip } from "./updater.mjs";

export const FIRST_CHECK_MS = 2 * 60_000;
export const CHECK_EVERY_MS = 24 * 60 * 60_000;
export const CHECK_JITTER_MS = 60 * 60_000;

/**
 * @param {{ stateDir: string, installDir: string, port: number, version: string, key: string, fetch: typeof fetch,
 *   spawn: typeof import("node:child_process").spawn, nodePath?: string, now?: () => number, random?: () => number,
 *   setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout, log?: Pick<Console, "log" | "error"> }} options
 */
export function createUpdateService({ stateDir, installDir, port, version, key, fetch, spawn, nodePath = process.execPath, now = Date.now,
  random = Math.random, setTimer = setTimeout, clearTimer = clearTimeout, log = console }) {
  let staged = null;
  let applying = false;
  let timer = null;
  const rule = () => automaticRule(version, readSkip(stateDir));

  /** Look once, unless the person turned looking off. */
  async function check() {
    if (!readSettings(stateDir).check) return;
    const verdict = await checkForUpdate(stateDir, { key, sources: githubSources(fetch, version), rule: rule(), now });
    if (verdict.ok) {
      staged = verdict.release.version;
      log.log?.(`Update: Goblin Horde ${staged} is downloaded and checked, and is put in place at the next start.`);
    } else if (!verdict.current) log.error?.(`Update check: ${verdict.message}`);
  }

  function schedule(ms) {
    timer = setTimer(() => {
      check().catch((error) => log.error?.(`Update check: ${error.message}`))
        .finally(() => schedule(CHECK_EVERY_MS + Math.floor(random() * CHECK_JITTER_MS)));
    }, ms);
    timer?.unref?.();
  }

  return {
    /** Remember a release an earlier check kept, and start looking. */
    begin() {
      findStaged(stateDir, { key, rule: rule() }).then((found) => { staged ??= found?.release.version ?? null; }, () => {});
      schedule(FIRST_CHECK_MS);
    },
    check,
    /** What GET /api/pets reports: { version } of a verified release waiting, or null. */
    staged: () => (staged ? { version: staged } : null),
    /**
     * Start this installation's manager to put the waiting release in place, its output going to run/update.log.
     * @returns {{ status: number, body: object }}
     */
    apply() {
      if (!staged) return { status: 409, body: { error: "No update is waiting." } };
      if (!applying) {
        const runDir = join(stateDir, "run");
        mkdirSync(runDir, { recursive: true });
        const output = openSync(join(runDir, UPDATE_LOG), "w");
        try {
          const child = spawn(nodePath, [join(installDir, "goblin.mjs"), "update", "--apply-staged", "--install-dir", installDir, "--state-dir", stateDir, "--port", String(port)],
            { cwd: stateDir, detached: true, stdio: ["ignore", output, output], windowsHide: true });
          child.on("error", () => { applying = false; });
          child.unref();
          applying = true;
        } catch (error) {
          return { status: 500, body: { error: `The update could not start (${error.code || error.message}).` } };
        } finally { closeSync(output); }
      }
      return { status: 200, body: { applying: true, version: staged } };
    },
    close() { clearTimer(timer); },
  };
}
