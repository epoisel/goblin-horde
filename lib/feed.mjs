/** Choose which chats the all-parties feed checks, and which parties it reports. */

export const FEED_LIMITS = Object.freeze({
  windowMs: 24 * 60 * 60_000, // How long a chat seen waiting, failed, or working stays followed, and quiet context lasts.
  activeMs: 15 * 60_000, // A chat updated this recently is in use and gets read; older ones only when watched or opened.
  retryMs: 30_000, // A chat that failed to read waits this long before the next try, doubling up to maxRetryMs.
  maxRetryMs: 10 * 60_000,
  askWindowMs: 6 * 60 * 60_000, // A finished reply that ends in a question stays urgent this long.
  readBudget: 16, // New or changed chats read per scene; the rest wait for the next poll.
  recheckMs: 5000, // A chat seen working is reread this often even when its timestamp holds still.
  quietLimit: 5, // Recent quiet chats and Orca agents kept for context, as before.
  hotLimit: 60, // Upper bound on working, waiting, and failed members in one response.
  cacheLimit: 600, // Upper bound on remembered chat checks.
});

const ORCA_HOT = new Set(["working", "running", "blocked", "error", "failed"]);
const ORCA_RECENT_WAIT = new Set(["waiting"]);

/** needs | failed | working | quiet, from a transformed Codex thread. */
export function classifyCodex(actor, { hasRequest = false, now = Date.now(), askWindowMs = FEED_LIMITS.askWindowMs } = {}) {
  const last = actor?.turnStates?.at(-1);
  const status = String(actor?.status || "").toLowerCase();
  if (hasRequest) return "needs";
  if (last?.questions?.length && Number(actor.updatedAt) >= now - askWindowMs) return "needs";
  if (status === "systemerror" || String(last?.status || "").toLowerCase() === "failed") return "failed";
  if (String(last?.status || "").toLowerCase() === "inprogress" || status === "active") return "working";
  return "quiet";
}

/** Orca reports every live agent in one snapshot, so no reads are needed. */
export function classifyOrca(agent, { now = Date.now(), windowMs = FEED_LIMITS.windowMs } = {}) {
  const state = String(agent?.status || "").toLowerCase();
  if (state === "error" || state === "failed") return "failed";
  if (ORCA_HOT.has(state)) return "working";
  if (ORCA_RECENT_WAIT.has(state) && Number(agent.updatedAt) >= now - windowMs) return "waiting";
  return "quiet";
}

/** A list status from thread/list that already says the chat needs a look. */
export function listSaysBusy(summary) {
  const type = String(summary?.status || "").toLowerCase();
  return type === "active" || type === "systemerror" || Boolean(summary?.activeFlags?.length);
}

/**
 * Plan one scene's Codex reads, reading only chats that are in use.
 *
 * A chat is read when it changed in the last `activeMs`, when its last check found it working,
 * waiting on the person, or failed (for up to `windowMs`), when the list status or a pending request
 * flags it, or when the person watches it. Every other chat stays in the catalog and is read only when
 * someone opens it. A saved check is reused while the chat's timestamp is unchanged; only chats last
 * seen working are rechecked every few seconds. Reads beyond the budget wait for a later poll and are
 * counted, and their older saved check, when there is one, stands in until then.
 *
 * The budget goes to the chats whose last attempt is oldest, so every due chat gets its turn even
 * when more than a budget's worth stay busy; urgency only breaks ties. A chat whose read failed backs
 * off (`failures`: id -> { count, until }) instead of costing a slow read on every poll. Planned reads
 * are recorded in `attempts` whether or not they later succeed.
 */
export function planCodexReads(threads, {
  now = Date.now(), cache = new Map(), attempts = new Map(), mustIds = new Set(), watched = new Set(),
  failures = new Map(), limits = FEED_LIMITS,
} = {}) {
  const active = now - limits.activeMs;
  const followed = now - limits.windowMs;
  const known = new Map(threads.map((thread) => [thread.id, thread]));
  const candidates = [];
  for (const id of mustIds) if (!known.has(id)) candidates.push({ summary: { id, updatedAt: 0, source: "codex" }, must: true });
  for (const thread of threads) {
    const must = mustIds.has(thread.id) || listSaysBusy(thread);
    const saved = cache.get(thread.id);
    const updated = Number(thread.updatedAt);
    const unsettled = saved && saved.attention !== "quiet" && updated >= followed;
    if (must || watched.has(thread.id) || updated >= active || unsettled) candidates.push({ summary: thread, must });
  }
  const urgency = ({ summary, must }) => {
    const saved = cache.get(summary.id);
    return must ? 0 : saved && saved.attention !== "quiet" ? 1 : 2;
  };
  const lastTry = ({ summary }) => attempts.get(summary.id) ?? 0;

  const due = [];
  const reused = [];
  let backingOff = 0;
  for (const candidate of candidates) {
    const saved = cache.get(candidate.summary.id);
    const unchanged = saved && saved.updatedAt === candidate.summary.updatedAt && candidate.summary.updatedAt;
    // Waiting and failed chats only change when their timestamp does; working ones are polled.
    const settled = saved && (saved.attention !== "working" || now - saved.checkedAt < limits.recheckMs);
    const failure = failures.get(candidate.summary.id);
    if (unchanged && settled && !candidate.must) reused.push(saved);
    else if (failure && now < failure.until && !candidate.must) {
      backingOff++;
      if (saved) reused.push(saved);
    } else due.push(candidate);
  }
  due.sort((a, b) => lastTry(a) - lastTry(b) || urgency(a) - urgency(b)
    || Number(b.summary.updatedAt) - Number(a.summary.updatedAt));
  const reads = due.slice(0, limits.readBudget).map((candidate) => candidate.summary);
  for (const summary of reads) attempts.set(summary.id, now);
  for (const candidate of due.slice(limits.readBudget)) {
    const saved = cache.get(candidate.summary.id);
    if (saved) reused.push(saved);
  }
  const ids = new Set(candidates.map((item) => item.summary.id));
  for (const id of attempts.keys()) if (!ids.has(id)) attempts.delete(id);
  for (const id of failures.keys()) if (!ids.has(id)) failures.delete(id);
  return { reads, reused, pending: due.length - reads.length, backingOff, candidates: candidates.length, ids };
}

/** Record a failed read: the next try waits retryMs, doubling with each failure up to maxRetryMs. */
export function noteReadFailure(failures, id, { now = Date.now(), limits = FEED_LIMITS } = {}) {
  const count = (failures.get(id)?.count || 0) + 1;
  failures.set(id, { count, until: now + Math.min(limits.maxRetryMs, limits.retryMs * 2 ** (count - 1)) });
}

/** Keep remembered checks to the current candidates, newest first, within the cap. */
export function pruneCache(cache, ids, limit = FEED_LIMITS.cacheLimit) {
  for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
  if (cache.size <= limit) return false;
  const oldest = [...cache.values()].sort((a, b) => Number(a.updatedAt) - Number(b.updatedAt));
  for (const entry of oldest.slice(0, cache.size - limit)) cache.delete(entry.id);
  return true;
}

/**
 * Every working, waiting, or failed member up to hotLimit, plus a few recent quiet ones for
 * context. Members that need the person come first so a cut never drops them.
 */
export function selectFeedMembers(codex, orca, { now = Date.now(), limits = FEED_LIMITS, claude = [], extension = [] } = {}) {
  const order = { needs: 0, failed: 1, waiting: 2, working: 3 };
  const tagged = [
    ...codex.map((actor) => ({ actor, attention: actor.attention || "quiet", source: "codex" })),
    // Claude and extension-feed members arrive classified by their readers, as Codex members do.
    ...claude.map((actor) => ({ actor, attention: actor.attention || "quiet", source: "claude" })),
    ...extension.map((actor) => ({ actor, attention: actor.attention || "quiet", source: "extension" })),
    ...orca.map((actor) => ({ actor, attention: classifyOrca(actor, { now, windowMs: limits.windowMs }), source: "orca" })),
  ];
  const hot = tagged.filter((item) => item.attention !== "quiet")
    .sort((a, b) => order[a.attention] - order[b.attention] || Number(b.actor.updatedAt) - Number(a.actor.updatedAt));
  const kept = hot.slice(0, limits.hotLimit);
  const since = now - limits.windowMs;
  const quiet = (source) => tagged.filter((item) => item.source === source && item.attention === "quiet"
      && Number(item.actor.updatedAt) >= since)
    .sort((a, b) => Number(b.actor.updatedAt) - Number(a.actor.updatedAt)).slice(0, limits.quietLimit);
  // Every member carries the feed's classification so the widget groups and counts the same way.
  const agents = [...kept, ...quiet("codex"), ...quiet("claude"), ...quiet("extension"), ...quiet("orca")].map((item) => ({ ...item.actor, attention: item.attention }))
    .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
  return { agents, hotTotal: hot.length, hotShown: kept.length };
}

const emptyCounts = () => ({ updates: 0, commands: 0, research: 0, tools: 0 });

/**
 * The all-parties scene from what each source returned. Pure: the server does the reads.
 *
 * codex: { ok, threads, listComplete, checked, checkFailed }
 * claude: { ok, snapshot: { sessions, warning } }
 * orca: { ok, snapshot: { workspaces, warning, missing } }; Orca that is simply not installed
 * has no warning, so it never marks a healthy Codex or Claude scene partial.
 * extension: { ok, snapshot: { sessions, feeds, warning } }; optional, empty when no feed exists.
 */
export function composeAllScene({ codex, claude, orca, extension = { ok: true, snapshot: { sessions: [], feeds: [] } },
  listRequests = () => [], now = Date.now(), limits = FEED_LIMITS }) {
  const threads = codex.ok ? codex.threads : [];
  const checked = codex.checked || { records: [], pending: 0, failed: 0, candidates: 0, capped: false };
  const orcaSnapshot = orca.ok ? orca.snapshot : { workspaces: [], warning: "Orca feed is unavailable." };
  const claudeSnapshot = claude.ok ? claude.snapshot : { sessions: [], warning: "Claude Code feed is unavailable." };
  const extensionSnapshot = extension.ok ? extension.snapshot : { sessions: [], feeds: [], warning: "Extension feeds are unavailable." };
  const recentSince = now - limits.windowMs;
  const warnings = [
    codex.ok ? "" : "Codex feed is unavailable.",
    codex.checkFailed ? "Codex chats could not be checked." : "",
    orcaSnapshot.warning || "",
    claudeSnapshot.warning || "",
    extensionSnapshot.warning || "",
  ].filter(Boolean);
  if (checked.failed) warnings.push("Some Codex chats could not be read.");
  const codexActors = checked.records.map(({ thread, attention }) => {
    const needsInput = listRequests(thread.id).length > 0 || Boolean(thread.awaitingApproval)
      || (attention === "needs" && Boolean(thread.turnStates.at(-1)?.questions?.length));
    return { ...thread, source: "codex", nickname: thread.nickname || thread.name, role: thread.role || "Codex chat", needsInput, attention };
  });
  const orcaAll = orcaSnapshot.workspaces.flatMap((workspace) => workspace.agents);
  const claudeAll = claudeSnapshot.sessions.flatMap((session) => session.agents);
  const extensionAll = extensionSnapshot.sessions.flatMap((party) => party.agents);
  const { agents, hotTotal: hotListed, hotShown } = selectFeedMembers(codexActors, orcaAll, { now, limits, claude: claudeAll, extension: extensionAll });
  // Members the Claude and extension readers' own caps left out never reached the list above; the
  // readers keep urgent and working members first, so only a flood of them is ever cut.
  const cut = (truncated) => ({ feeds: 0, parties: 0, agents: 0, active: 0, urgent: 0, ...(truncated || {}) });
  const claudeCut = cut(claudeSnapshot.truncated);
  const extensionCut = cut(extensionSnapshot.truncated);
  const hotTotal = hotListed + claudeCut.active + extensionCut.active;
  const included = new Set(agents.map((actor) => actor.id));
  const requests = codexActors.filter((actor) => included.has(actor.id)).flatMap((actor) => listRequests(actor.id));
  // Say plainly what this scene could not cover; the widget shows it instead of claiming the full machine.
  const coverage = {
    windowHours: limits.windowMs / 3_600_000,
    codexListed: threads.length,
    codexAvailable: codex.ok,
    codexListComplete: codex.ok && codex.listComplete !== false,
    codexChecked: checked.records.length,
    codexPending: checked.pending,
    codexFailed: checked.failed,
    orcaAvailable: orca.ok && !orcaSnapshot.warning,
    orcaInstalled: orca.ok && !orcaSnapshot.missing,
    claudeAvailable: claude.ok && !claudeSnapshot.warning,
    claudeSessions: claudeSnapshot.sessions.length,
    claudeTruncated: { sessions: claudeCut.parties, agents: claudeCut.agents, active: claudeCut.active, urgent: claudeCut.urgent },
    extensionFeeds: (extensionSnapshot.feeds || []).length,
    extensionParties: extensionSnapshot.sessions.length,
    extensionTruncated: { feeds: extensionCut.feeds, parties: extensionCut.parties, agents: extensionCut.agents, active: extensionCut.active, urgent: extensionCut.urgent },
    activeTotal: hotTotal,
    activeShown: hotShown,
  };
  if (checked.pending) warnings.push(`Still checking ${checked.pending} recent Codex ${checked.pending === 1 ? "chat" : "chats"}.`);
  if (checked.capped) warnings.push("Too many recent Codex chats to check them all.");
  // The list is newest first, so a cut only matters when its oldest chat is still inside the window.
  if (coverage.codexAvailable && !coverage.codexListComplete && Number(threads.at(-1)?.updatedAt) >= recentSince)
    warnings.push("The Codex chat list was cut short inside the past day.");
  if (hotTotal > hotShown) warnings.push(`${hotTotal - hotShown} more active members were left out of this update.`);
  // Feeds past the reader's cap were not read at all, so whether they hold active members is unknown.
  if (extensionCut.feeds) warnings.push(`${extensionCut.feeds} older extension ${extensionCut.feeds === 1 ? "feed was" : "feeds were"} not read.`);
  coverage.complete = !warnings.length;
  const countIn = (source) => agents.filter((actor) => actor.source === source && Number(actor.updatedAt) >= recentSince).length;
  return {
    root: { id: "all", source: "all", name: "All chats and agents", cwd: "", status: "active", turns: threads.length,
      turnStates: [], activities: [], latest: null, counts: emptyCounts() },
    agents, requests, warning: warnings.join(" "), checkedAt: now, coverage,
    totals: { codexChats: threads.length, orcaWorkspaces: orcaSnapshot.workspaces.length, orcaAgents: orcaAll.length,
      claudeSessions: claudeSnapshot.sessions.length, claudeAgents: claudeAll.length,
      extensionParties: extensionSnapshot.sessions.length, extensionAgents: extensionAll.length,
      recentCodex: countIn("codex"), recentOrca: countIn("orca"), recentClaude: countIn("claude"), recentExtension: countIn("extension"), active: hotTotal },
  };
}
