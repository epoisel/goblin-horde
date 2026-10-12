/**
 * A diagnostic summary that is safe to paste into a bug report.
 *
 * It carries versions, connection states, counts, error categories, and timings, and is built from
 * an explicit allowlist: no chat or party names, no messages, no file paths, no free text
 * from sources, no addresses, and never the pairing code or a session token.
 */

const STATES = new Set(["ok", "starting", "unavailable", "not-connected", "not-installed", "partial", "broken", "disabled",
  "unreadable", "none", "missing", "optional", "unsupported", "error", "conflict"]);
const state = (value) => (STATES.has(value) ? value : "other");
const count = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : null);

function ago(ms, now) {
  if (!ms) return "never";
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function duration(ms) {
  if (!ms) return "0 ms";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** { data, text }: the same facts as JSON and as a short block of plain text. */
export function diagnosticReport({ version, platform, node, stats, now = Date.now(), capabilities = {}, scene = null, watched = 0,
  codexRestarts = 0, phone = {}, widget = null }) {
  const sources = capabilities.sources || {};
  const coverage = scene?.coverage || {};
  const data = {
    version: String(version || ""), platform: String(platform || ""), node: String(node || ""),
    uptimeMinutes: count((now - stats.startedAt) / 60_000),
    sources: {
      codex: { state: state(sources.codex?.state), restarts: count(codexRestarts) },
      claude: { state: state(sources.claude?.state), sessions: count(sources.claude?.sessions), lastEvent: ago(sources.claude?.lastEventAt, now) },
      orca: { state: state(sources.orca?.state) },
      extensions: { state: state(sources.extensions?.state), feeds: count(sources.extensions?.feeds?.length || 0) },
    },
    scene: {
      builds: count(stats.sceneBuilds), failures: count(stats.sceneFailures),
      last: duration(stats.lastSceneMs), slowest: duration(stats.slowestSceneMs),
      builtAgo: ago(scene?.checkedAt, now), partial: Boolean(scene?.warning),
      codexListed: count(coverage.codexListed), codexRead: count(coverage.codexChecked), codexPending: count(coverage.codexPending),
      codexReadFailures: count(stats.codexReadFailures), agents: count(scene?.agents?.length || 0),
    },
    watched: count(watched),
    phone: { lanListener: Boolean(phone.available), pairedSessions: phone.pairedSessions == null ? null : count(phone.pairedSessions) },
    ...(widget ? { widget } : {}),
  };
  const s = data.sources;
  const text = [
    "Goblin Horde diagnostic report (no chats, names, paths, addresses, or pairing codes)",
    `version ${data.version} · ${data.platform} · Node ${data.node} · up ${data.uptimeMinutes} min`,
    `sources: codex ${s.codex.state} (restarts ${s.codex.restarts}) · claude ${s.claude.state} (${s.claude.sessions ?? 0} sessions, last event ${s.claude.lastEvent})`
      + ` · orca ${s.orca.state} · extensions ${s.extensions.state} (${s.extensions.feeds} feeds)`,
    `all-parties scene: built ${data.scene.builtAgo}${data.scene.partial ? " (partial)" : ""} · last ${data.scene.last} · slowest ${data.scene.slowest}`
      + ` · ${data.scene.builds} builds, ${data.scene.failures} failed`,
    `codex chats: ${data.scene.codexListed ?? 0} listed, ${data.scene.codexRead ?? 0} read, ${data.scene.codexPending ?? 0} waiting,`
      + ` ${data.scene.codexReadFailures} read failures so far · ${data.watched} watched · ${data.scene.agents} agents shown`,
    `phone: ${data.phone.lanListener ? "Wi-Fi listener on" : "Wi-Fi listener off"}${data.phone.pairedSessions == null ? "" : ` · ${data.phone.pairedSessions} paired`}`,
    ...(widget ? [`widget: ${Object.entries(widget).map(([key, value]) => `${key} ${value}`).join(" · ")}`] : []),
  ].join("\n");
  return { data, text };
}
