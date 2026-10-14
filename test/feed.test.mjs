import test from "node:test";
import assert from "node:assert/strict";
import { classifyCodex, classifyOrca, composeAllScene, FEED_LIMITS, listedThread, noteReadFailure, planCodexReads, pruneCache,
  selectFeedMembers, uniqueThreads } from "../lib/feed.mjs";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const summary = (id, ago, extra = {}) => ({ id, updatedAt: NOW - ago, source: "codex", ...extra });
// A saved check holds the thread it classified; the plan classifies it again as time passes.
const TURN_FOR = { working: { status: "inProgress", questions: [] }, needs: { status: "completed", questions: ["Ship it?"] },
  failed: { status: "failed", questions: [] }, quiet: { status: "completed", questions: [] } };
const saved = (id, updatedAt, attention, checkedAt = NOW - 1000) => ({ id, updatedAt, checkedAt, attention,
  thread: { id, updatedAt, turnStates: [{ id: "t", ...TURN_FOR[attention] }] } });
const actor = (id, attention, ago = 1000) => ({ id, source: "codex", updatedAt: NOW - ago, attention });

test("reads every recent chat, not just five, and never touches dormant ones", () => {
  const threads = [
    ...Array.from({ length: 12 }, (_, index) => summary(`recent-${index}`, index * 60_000)),
    ...Array.from({ length: 300 }, (_, index) => summary(`old-${index}`, 30 * HOUR + index * HOUR)),
  ];
  const plan = planCodexReads(threads, { now: NOW });
  assert.equal(plan.reads.length, 12);
  assert.ok(plan.reads.every((item) => item.id.startsWith("recent-")));
  assert.equal(plan.pending, 0);
  assert.equal(plan.candidates, 12);
});

test("unchanged quiet chats are reused without a read on the next poll", () => {
  const threads = Array.from({ length: 40 }, (_, index) => summary(`chat-${index}`, index * 20_000));
  const cache = new Map(threads.map((thread) => [thread.id, saved(thread.id, thread.updatedAt, "quiet", NOW - 10 * 60_000)]));
  const plan = planCodexReads(threads, { now: NOW, cache });
  assert.equal(plan.reads.length, 0);
  assert.equal(plan.reused.length, 40);
});

test("a chat seen working is rechecked after a few seconds even with the same timestamp", () => {
  const thread = summary("busy", 60_000);
  const cache = new Map([["busy", saved("busy", thread.updatedAt, "working", NOW - FEED_LIMITS.recheckMs - 1)]]);
  assert.deepEqual(planCodexReads([thread], { now: NOW, cache }).reads.map((item) => item.id), ["busy"]);
  cache.get("busy").checkedAt = NOW - 1000;
  assert.equal(planCodexReads([thread], { now: NOW, cache }).reads.length, 0);
});

test("a burst of changed chats is read within the budget and the rest are counted as pending", () => {
  const threads = Array.from({ length: 40 }, (_, index) => summary(`chat-${index}`, index * 20_000));
  const cache = new Map([["chat-39", saved("chat-39", NOW - 99 * HOUR, "working")]]);
  const plan = planCodexReads(threads, { now: NOW, cache });
  assert.equal(plan.reads.length, FEED_LIMITS.readBudget);
  assert.equal(plan.pending, 40 - FEED_LIMITS.readBudget);
  // A chat last seen working is read before newer quiet ones.
  assert.equal(plan.reads[0].id, "chat-39");
  // Saved checks stand in for chats that wait; unseen ones are simply pending.
  assert.equal(plan.reused.length, 0);
});

test("a stale saved check stands in for a chat that waits behind the budget", () => {
  const threads = Array.from({ length: 20 }, (_, index) => summary(`chat-${index}`, index * 20_000));
  const cache = new Map([["chat-19", saved("chat-19", NOW - 99 * HOUR, "quiet")]]);
  const plan = planCodexReads(threads, { now: NOW, cache, limits: { ...FEED_LIMITS, readBudget: 4 } });
  assert.equal(plan.reads.length, 4);
  assert.equal(plan.pending, 16);
  assert.deepEqual(plan.reused.map((item) => item.id), ["chat-19"]);
});

test("pending requests and busy list status are read first, even outside the window or the list", () => {
  const threads = [
    summary("fresh", 1000),
    summary("old-busy", 72 * HOUR, { status: "active" }),
    summary("old-flagged", 72 * HOUR, { activeFlags: ["waitingOnApproval"] }),
    summary("old-quiet", 72 * HOUR, { status: "notLoaded" }),
  ];
  const plan = planCodexReads(threads, { now: NOW, mustIds: new Set(["subagent-asks"]) });
  assert.deepEqual(plan.reads.map((item) => item.id).sort(), ["fresh", "old-busy", "old-flagged", "subagent-asks"].sort());
  assert.equal(plan.reads.at(-1).id, "fresh");
});

test("only chats in use are read; older ones wait until watched or opened", () => {
  const threads = [
    summary("in-use", 5 * 60_000),
    summary("earlier-today", 3 * HOUR),
    summary("watched-old", 9 * 24 * HOUR),
    summary("old-asked", 2 * HOUR),
  ];
  const cache = new Map([["old-asked", saved("old-asked", NOW - 2 * HOUR, "needs", NOW - HOUR)]]);
  const plan = planCodexReads(threads, { now: NOW, cache, watched: new Set(["watched-old"]) });
  assert.deepEqual(plan.reads.map((item) => item.id).sort(), ["in-use", "watched-old"]);
  // A chat last seen waiting on the person stays followed, from its saved check while unchanged.
  assert.deepEqual(plan.reused.map((item) => item.id), ["old-asked"]);
  assert.ok(!plan.ids.has("earlier-today"));
  assert.equal(plan.candidates, 3);
});

test("a chat that fails to read backs off, doubling, instead of costing a read every poll", () => {
  const failures = new Map();
  noteReadFailure(failures, "slow", { now: NOW });
  assert.equal(failures.get("slow").until, NOW + FEED_LIMITS.retryMs);
  noteReadFailure(failures, "slow", { now: NOW });
  assert.equal(failures.get("slow").until, NOW + 2 * FEED_LIMITS.retryMs);
  for (let index = 0; index < 10; index++) noteReadFailure(failures, "slow", { now: NOW });
  assert.equal(failures.get("slow").until, NOW + FEED_LIMITS.maxRetryMs);

  const thread = summary("slow", 60_000);
  const waiting = planCodexReads([thread], { now: NOW, failures });
  assert.equal(waiting.reads.length, 0);
  assert.equal(waiting.backingOff, 1);
  // A pending request still forces the read, and the backoff ends on time.
  assert.equal(planCodexReads([thread], { now: NOW, failures, mustIds: new Set(["slow"]) }).reads.length, 1);
  assert.equal(planCodexReads([thread], { now: NOW + FEED_LIMITS.maxRetryMs, failures }).reads.length, 1);
});

test("a chat guessed to be waiting on an approval is rechecked, so the guess clears when it ends", () => {
  const thread = summary("held", 20 * HOUR);
  const guess = { ...saved("held", thread.updatedAt, "needs", NOW - FEED_LIMITS.recheckMs - 1), thread: { id: "held", awaitingApproval: true } };
  assert.deepEqual(planCodexReads([thread], { now: NOW, cache: new Map([["held", guess]]) }).reads.map((item) => item.id), ["held"]);
  // A question the chat asked in its answer only changes with the chat, so it is not reread.
  const asked = saved("held", thread.updatedAt, "needs", NOW - FEED_LIMITS.recheckMs - 1);
  assert.equal(planCodexReads([thread], { now: NOW, cache: new Map([["held", asked]]) }).reads.length, 0);
});

// Run polls a second apart, as the server would, and note when each chat is first read.
function pollUntilAllRead(threads, { mustIds = new Set(), succeeds = () => true, polls = 20 } = {}) {
  const cache = new Map();
  const attempts = new Map();
  const firstRead = new Map();
  for (let poll = 0; poll < polls; poll++) {
    const now = NOW + poll * 1000;
    const plan = planCodexReads(threads, { now, cache, attempts, mustIds });
    assert.ok(plan.reads.length <= FEED_LIMITS.readBudget);
    for (const { id, updatedAt } of plan.reads) {
      if (!firstRead.has(id)) firstRead.set(id, poll);
      if (succeeds(id)) cache.set(id, { id, updatedAt, checkedAt: now, attention: "working", thread: { id, updatedAt } });
    }
  }
  return firstRead;
}

test("more busy chats than the budget each get read within a few polls", () => {
  const threads = Array.from({ length: 17 }, (_, index) => summary(`busy-${index}`, index * 1000, { status: "active" }));
  const firstRead = pollUntilAllRead(threads, { polls: 4 });
  assert.equal(firstRead.size, 17);
  assert.equal(firstRead.get("busy-16"), 1);
  // A fortieth pending request still has its turn.
  const many = Array.from({ length: 40 }, (_, index) => summary(`must-${index}`, index * 1000));
  const reached = pollUntilAllRead(many, { mustIds: new Set(many.map((item) => item.id)), polls: 3 });
  assert.equal(reached.size, 40);
});

test("chats whose reads keep failing do not starve the rest", () => {
  const threads = Array.from({ length: 20 }, (_, index) => summary(`chat-${index}`, index * 1000, { status: "active" }));
  const broken = new Set(threads.slice(0, 16).map((item) => item.id));
  const firstRead = pollUntilAllRead(threads, { succeeds: (id) => !broken.has(id), polls: 4 });
  assert.equal(firstRead.size, 20);
  for (const id of ["chat-16", "chat-17", "chat-18", "chat-19"]) assert.ok(firstRead.get(id) <= 1, id);
});

test("attempts are forgotten once a chat leaves the candidates", () => {
  const attempts = new Map([["gone", NOW - 1000]]);
  planCodexReads([summary("here", 1000)], { now: NOW, attempts });
  assert.deepEqual([...attempts.keys()], ["here"]);
});

test("classification is honest about questions, failures, and running turns", () => {
  const base = { updatedAt: NOW - 1000, status: "notLoaded" };
  assert.equal(classifyCodex({ ...base, turnStates: [] }, { hasRequest: true, now: NOW }), "needs");
  assert.equal(classifyCodex({ ...base, turnStates: [{ status: "completed", questions: ["Ship it?"] }] }, { now: NOW }), "needs");
  assert.equal(classifyCodex({ ...base, updatedAt: NOW - 12 * HOUR, turnStates: [{ status: "completed", questions: ["Ship it?"] }] }, { now: NOW }), "quiet");
  assert.equal(classifyCodex({ ...base, turnStates: [{ status: "failed", questions: [] }] }, { now: NOW }), "failed");
  assert.equal(classifyCodex({ ...base, status: "systemError", turnStates: [] }, { now: NOW }), "failed");
  assert.equal(classifyCodex({ ...base, turnStates: [{ status: "inProgress", questions: [] }] }, { now: NOW }), "working");
  assert.equal(classifyCodex({ ...base, turnStates: [{ status: "completed", questions: [] }] }, { now: NOW }), "quiet");
  assert.equal(classifyOrca({ status: "working", updatedAt: NOW - 50 * HOUR }, { now: NOW }), "working");
  assert.equal(classifyOrca({ status: "error", updatedAt: NOW }, { now: NOW }), "failed");
  assert.equal(classifyOrca({ status: "waiting", updatedAt: NOW - 50 * HOUR }, { now: NOW }), "quiet");
  assert.equal(classifyOrca({ status: "done", updatedAt: NOW }, { now: NOW }), "quiet");
  // Orca "waiting" is needs-you only with a real prompt on screen; asking the coordinator is work; idle is quiet.
  assert.equal(classifyOrca({ status: "waiting", updatedAt: NOW - 1000 }, { now: NOW }), "quiet");
  assert.equal(classifyOrca({ status: "waiting", updatedAt: NOW - 1000, ask: { kind: "permission", text: "Allow?" } }, { now: NOW }), "needs");
  assert.equal(classifyOrca({ status: "waiting", updatedAt: NOW - 1000, waitingOn: { who: "coordinator" } }, { now: NOW }), "working");
  assert.equal(classifyOrca({ status: "unavailable", updatedAt: NOW - 1000, ask: { kind: "permission", text: "Allow?" } }, { now: NOW }), "quiet");
});

test("the feed carries every active member beyond five plus a few quiet ones", () => {
  const codex = [
    ...Array.from({ length: 9 }, (_, index) => actor(`busy-${index}`, "working", index * 1000)),
    actor("asks", "needs", 20 * HOUR),
    ...Array.from({ length: 8 }, (_, index) => actor(`quiet-${index}`, "quiet", index * 1000)),
  ];
  const orca = [
    ...Array.from({ length: 7 }, (_, index) => ({ id: `orca-${index}`, source: "orca", status: "working", updatedAt: NOW - index })),
    { id: "orca-done", source: "orca", status: "done", updatedAt: NOW },
  ];
  const { agents, hotTotal, hotShown } = selectFeedMembers(codex, orca, { now: NOW });
  const ids = new Set(agents.map((item) => item.id));
  assert.equal(hotTotal, 17);
  assert.equal(hotShown, 17);
  for (let index = 0; index < 9; index++) assert.ok(ids.has(`busy-${index}`));
  for (let index = 0; index < 7; index++) assert.ok(ids.has(`orca-${index}`));
  assert.ok(ids.has("asks"));
  assert.equal(agents.filter((item) => item.id.startsWith("quiet-")).length, FEED_LIMITS.quietLimit);
  assert.ok(ids.has("orca-done"));
});

test("a cut over the active limit keeps the members that need the person", () => {
  const codex = [
    ...Array.from({ length: 5 }, (_, index) => actor(`busy-${index}`, "working", index)),
    actor("asks", "needs", 30 * HOUR),
    actor("broke", "failed", 30 * HOUR),
  ];
  const { agents, hotTotal, hotShown } = selectFeedMembers(codex, [], { now: NOW, limits: { ...FEED_LIMITS, hotLimit: 3 } });
  assert.equal(hotTotal, 7);
  assert.equal(hotShown, 3);
  const ids = agents.map((item) => item.id);
  assert.ok(ids.includes("asks"));
  assert.ok(ids.includes("broke"));
});

test("every returned member carries the feed classification the widget groups by", () => {
  const oldQuestion = actor("old-ask", classifyCodex({ updatedAt: NOW - 12 * HOUR, status: "notLoaded",
    turnStates: [{ status: "completed", questions: ["Ship it?"] }] }, { now: NOW }), 12 * HOUR);
  const blocked = { id: "orca-blocked", source: "orca", status: "blocked", updatedAt: NOW - 1000 };
  // Orca's "waiting" alone is an agent idle at its prompt: only a real prompt (ask) needs the person.
  const waiting = { id: "orca-wait", source: "orca", status: "waiting", updatedAt: NOW - 1000 };
  const prompt = { id: "orca-prompt", source: "orca", status: "waiting", updatedAt: NOW - 1000, ask: { kind: "permission", text: "Do you want to proceed?" } };
  const done = { id: "orca-done", source: "orca", status: "done", updatedAt: NOW };
  const { agents } = selectFeedMembers([oldQuestion], [blocked, waiting, prompt, done], { now: NOW });
  const byId = Object.fromEntries(agents.map((item) => [item.id, item.attention]));
  assert.deepEqual(byId, { "old-ask": "quiet", "orca-blocked": "working", "orca-wait": "quiet", "orca-prompt": "needs", "orca-done": "quiet" });
  // The source snapshot is left untouched.
  assert.equal(blocked.attention, undefined);
});

test("remembered checks are pruned to current candidates and capped", () => {
  const cache = new Map(Array.from({ length: 10 }, (_, index) => [`chat-${index}`, saved(`chat-${index}`, NOW - index, "quiet")]));
  const ids = new Set([...cache.keys()].filter((id) => id !== "chat-0"));
  assert.equal(pruneCache(cache, ids, 100), false);
  assert.equal(cache.has("chat-0"), false);
  assert.equal(pruneCache(cache, ids, 5), true);
  assert.equal(cache.size, 5);
  assert.ok(cache.has("chat-1"));
  assert.ok(!cache.has("chat-9"));
});

test("a failure stays urgent for a while after the last activity, then becomes history", () => {
  const failedTurn = { turnStates: [{ id: "t", status: "failed", questions: [] }] };
  assert.equal(classifyCodex({ ...failedTurn, updatedAt: NOW - 5 * 60_000 }, { now: NOW }), "failed");
  assert.equal(classifyCodex({ ...failedTurn, updatedAt: NOW - FEED_LIMITS.failedMs - 1000 }, { now: NOW }), "quiet");
  // Orca keeps an errored pane until it is closed; once it has been quiet for a while it no longer calls for attention.
  assert.equal(classifyOrca({ status: "error", updatedAt: NOW - 60_000 }, { now: NOW }), "failed");
  assert.equal(classifyOrca({ status: "error", updatedAt: NOW - 3 * HOUR }, { now: NOW }), "quiet");
  assert.equal(classifyOrca({ status: "error" }, { now: NOW }), "quiet", "a failure with no time cannot be fresh");
});

test("an old failure or question ages out on time without a reread while the chat's timestamp holds still", () => {
  const T0 = NOW - 1000;
  const broke = { id: "broke", updatedAt: T0, source: "codex" };
  const asked = { id: "asked", updatedAt: T0, source: "codex" };
  const records = { broke: saved("broke", T0, "failed", T0), asked: saved("asked", T0, "needs", T0) };
  const at = (minutes) => {
    const cache = new Map(Object.entries(records));
    const plan = planCodexReads([broke, asked], { now: T0 + minutes * 60_000, cache });
    assert.equal(plan.reads.length, 0, `no reread at ${minutes} min`);
    const shown = Object.fromEntries(plan.reused.map((item) => [item.id, item.attention]));
    return { shown, broke: cache.get("broke")?.attention, asked: cache.get("asked")?.attention };
  };
  assert.deepEqual(at(20).shown, { broke: "failed", asked: "needs" });
  for (const minutes of [31, 120]) {
    const later = at(minutes);
    assert.equal(later.broke, "quiet", `${minutes} min`);
    assert.equal(later.shown.broke, undefined, "a quiet chat this old is no longer followed");
    assert.equal(later.shown.asked, "needs", "a question stays urgent for its own window");
  }
  const dayLater = at(1380);
  assert.deepEqual(dayLater.shown, {});
  assert.equal(dayLater.asked, "quiet");
  // A request still pending keeps it urgent, however old.
  const cache = new Map([["broke", records.broke]]);
  const plan = planCodexReads([broke], { now: T0 + 1380 * 60_000, cache, mustIds: new Set(["broke"]) });
  assert.equal(cache.get("broke").attention, "needs");
  assert.deepEqual(plan.reads.map((item) => item.id), ["broke"]);
});

test("after a restart a chat that may have ended in a question is read once, then follows the usual rules", () => {
  const seen = new Set();
  const cache = new Map();
  const asked = summary("asked", 20 * 60_000);
  const done = summary("done", 40 * 60_000);
  const old = summary("old", 7 * HOUR);
  const threads = [asked, done, old];
  let plan = planCodexReads(threads, { now: NOW, cache, seen });
  assert.deepEqual(plan.reads.map((item) => item.id).sort(), ["asked", "done"]);
  // The reads land: one ended in a question, one simply finished.
  cache.set("asked", saved("asked", asked.updatedAt, "needs", NOW));
  cache.set("done", saved("done", done.updatedAt, "quiet", NOW));
  pruneCache(cache, plan.ids);
  for (let poll = 1; poll <= 3; poll++) {
    plan = planCodexReads(threads, { now: NOW + poll * 2000, cache, seen });
    pruneCache(cache, plan.ids);
    assert.equal(plan.reads.length, 0, `poll ${poll} reads nothing again`);
    assert.deepEqual(plan.reused.map((item) => [item.id, item.attention]), [["asked", "needs"]]);
  }
  assert.ok(!cache.has("done"));
  // A read that failed is tried again (after its backoff), not forgotten.
  const failures = new Map();
  const fresh = new Set();
  planCodexReads([asked], { now: NOW, seen: fresh, failures });
  noteReadFailure(failures, "asked", { now: NOW });
  assert.equal(planCodexReads([asked], { now: NOW + 1000, seen: fresh, failures }).backingOff, 1);
  assert.deepEqual(planCodexReads([asked], { now: NOW + FEED_LIMITS.retryMs, seen: fresh, failures }).reads.map((item) => item.id), ["asked"]);
});

test("a listed chat's time is read from seconds, milliseconds, or ISO text", () => {
  const iso = listedThread({ id: "a", updatedAt: "2026-10-13T10:00:00Z", recencyAt: "2026-10-13T10:05:00.000Z" });
  assert.equal(iso.updatedAt, Date.parse("2026-10-13T10:05:00Z"));
  assert.equal(listedThread({ id: "b", updatedAt: 1_800_000_000 }).updatedAt, 1_800_000_000_000);
  assert.equal(listedThread({ id: "c", updatedAt: 1_800_000_000_123, recencyAt: null }).updatedAt, 1_800_000_000_123);
  assert.equal(listedThread({ id: "d" }).updatedAt, 0);
  assert.deepEqual(listedThread({ id: "e", status: { type: "active", activeFlags: ["waitingOnApproval"] } }).activeFlags, ["waitingOnApproval"]);
});

test("a computer without the Codex CLI is not told its scene is partial", () => {
  const empty = { ok: true, snapshot: { sessions: [], workspaces: [] } };
  const scene = composeAllScene({ codex: { ok: false, threads: [], missing: true }, claude: empty, orca: { ok: true, snapshot: { workspaces: [], warning: "", missing: true } }, now: NOW });
  assert.equal(scene.warning, "");
  assert.match(composeAllScene({ codex: { ok: false, threads: [] }, claude: empty, orca: empty, now: NOW }).warning, /Codex feed is unavailable/);
});

test("a chat listed on two pages (it changed while they were read) appears once, as its newest copy", () => {
  const listed = uniqueThreads([
    { id: "moved", updatedAt: NOW, name: "newest" },
    { id: "steady", updatedAt: NOW - 5000 },
    { id: "moved", updatedAt: NOW - 60_000, name: "older page" },
    { id: "moved", updatedAt: NOW - 90_000, name: "oldest page" },
  ]);
  assert.deepEqual(listed.map((thread) => thread.id), ["moved", "steady"]);
  assert.equal(listed[0].name, "newest");
});
