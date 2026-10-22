import { demoAll, demoParty, demoCatalog, demoLength } from "./demo.js";
import {
  ActionPulse, ACTION_WORDS, SOURCE_LABELS, ageLabel, feedRank, fieldGlyph, foldActive, launchpadBoard, memberStatus,
  needsYou, partySignal, partyScope, projectName, replyMode, searchSources, sourceOf, splitStream, stampMs, streamOrder,
} from "./party.js";
import { createGoblin, loadArt, modelBadge, setGoblinAction, tribeFor } from "./goblins.js";

const $ = (selector, root = document) => root.querySelector(selector);
const params = new URLSearchParams(location.search);
const demoMode = params.has("demo");
const compactMode = params.has("compact");
const pulse = new ActionPulse();
const VIEW_KEY = "goblin-horde-view";
const DIALOGUE_PAGE = 40;
const LOG_LIMIT = 120;

let scope = params.get("thread") || "all";
let catalog = [];
let pollMs = 2000;
let polling = false;
let refreshQueued = false;
let demoStep = 0;
let allScene = null;
let partyScene = null;
let partyError = "";
let allFailed = false;
let boardOrder = [];
let boardCards = new Map(); // party id -> card, from the latest all-parties scene
let memberParty = new Map(); // member id -> party id
let showAllActive = false;
let lastStreamOrder = [];
let mobilePairingCode = "";
const view = loadView();
const streams = new Map(); // member id -> stream state
const partyNodes = new Map();
const replyDrafts = new Map();
const branchOffers = new Map();
const sendingReplies = new Set();

// ------------------------------------------------------------------ small helpers
function el(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function clip(text, length = 275) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

async function getJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(value.error || `Request failed (${response.status})`), { status: response.status });
  return value;
}

async function postJson(path, value) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(result.error || `Request failed (${response.status})`), { requiresBranch: result.requiresBranch === true });
  return result;
}

function loadView() {
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_KEY) || "{}");
    return { launchpadHidden: Boolean(saved.launchpadHidden ?? compactMode), modes: saved.modes || {}, hidden: saved.hidden || {} };
  } catch { return { launchpadHidden: compactMode, modes: {}, hidden: {} }; }
}

function saveView() {
  // Keep the saved view small: only the most recently changed modes are remembered.
  const modes = Object.fromEntries(Object.entries(view.modes).slice(-200));
  localStorage.setItem(VIEW_KEY, JSON.stringify({ ...view, modes }));
}

function memberName(actor, partyName = "") {
  const name = String(actor.nickname || actor.name || "").trim();
  if (!name || name === "Untitled chat" || (partyName && name === partyName && !actor.parentThreadId)) return "Lead";
  return clip(name, 32);
}

function sourceTag(source) {
  return el("span", `source-tag source-${source}`, SOURCE_LABELS[source] || "CODEX");
}

function setLive(state, label) {
  const badge = $("#live-badge");
  badge.dataset.state = state;
  $("#live-label").textContent = label;
}

// ------------------------------------------------------------------ launchpad
function coverageNote(coverage) {
  if (!coverage || coverage.complete !== false) return "";
  if (coverage.codexPending) return `Still checking ${coverage.codexPending} recent ${coverage.codexPending === 1 ? "chat" : "chats"}.`;
  if (Number(coverage.activeTotal) > Number(coverage.activeShown)) return "Too many active goblins to list them all.";
  if (coverage.codexAvailable === false) return "Codex chats are unavailable right now.";
  if (coverage.codexFailed) return "Some chats could not be read.";
  if (coverage.codexListComplete === false) return "The chat list was cut short.";
  if (coverage.orcaAvailable === false && coverage.orcaInstalled) return "Orca is not answering.";
  return "Some sources are delayed.";
}

function goblinRow(card, limit = 4) {
  const row = el("span", "pc-goblins");
  const members = [...card.members].sort((a, b) => feedRank(a) - feedRank(b)).slice(0, limit);
  for (const member of members) {
    const action = pulse.action(member);
    row.append(createGoblin(member.id, action, { size: 1.5, tribe: tribeFor(member), label: `${memberName(member, card.name)}${modelBadge(member) ? ` (${modelBadge(member)})` : ""}, ${ACTION_WORDS[action].toLowerCase()}` }));
  }
  if (card.members.length > limit) row.append(el("span", "pc-more", `+${card.members.length - limit}`));
  return row;
}

function partyButton(card, recent = false) {
  const signal = partySignal(card);
  const button = el("button", `party-card tone-${recent ? "quiet" : signal.tone}${recent ? " recent" : ""}`);
  button.type = "button";
  button.dataset.id = card.id;
  if (card.id === scope) button.setAttribute("aria-current", "true");
  const text = el("span", "pc-text");
  const title = el("span", "pc-name", clip(card.name, 44));
  text.append(title);
  if (recent) {
    button.append(text, el("span", "pc-age", ageLabel(card.updated)));
  } else {
    const meta = el("span", "pc-meta");
    meta.append(el("span", `signal tone-${signal.tone}`, signal.label), sourceTag(card.source));
    text.append(meta);
    button.append(text, goblinRow(card));
  }
  button.title = `${card.name}${card.project && card.project !== card.name ? ` · ${card.project}` : ""}`;
  button.addEventListener("click", () => selectScope(card.id));
  return button;
}

function renderLaunchpad() {
  const active = $("#lp-active");
  if (!allScene) {
    if (allFailed) active.replaceChildren(el("div", "lp-empty failed", "Can't reach the viewer right now. Retrying…"));
    return;
  }
  const now = Date.now();
  const board = launchpadBoard(allScene.agents || [], catalog, boardOrder, now);
  boardOrder = board.active.map((card) => card.id);
  boardCards = new Map([...board.active, ...board.recent].map((card) => [card.id, card]));
  memberParty = new Map();
  for (const member of allScene.agents || []) memberParty.set(member.id, partyScope(member));
  const { shown, folded } = foldActive(board.active, showAllActive ? Infinity : compactMode ? 4 : 6);
  // Keyed update keeps focus and goblin canvases steady between polls.
  const fingerprint = JSON.stringify([scope, shown.map((card) => [card.id, partySignal(card).label, card.members.map((m) => [m.id, pulse.action(m)])])]);
  if (active.dataset.fingerprint !== fingerprint) {
    active.dataset.fingerprint = fingerprint;
    const focusedId = document.activeElement?.closest?.(".party-card")?.dataset.id;
    const fragment = document.createDocumentFragment();
    for (const card of shown) fragment.append(partyButton(card));
    if (!shown.length) {
      const empty = el("div", "lp-empty");
      empty.append(createGoblin("resting-camp", "idle", { size: 2 }), el("p", "", "No party is working right now."),
        el("small", "", demoMode ? "The demo is warming up…" : "Recent chats are below. Try the party demo to see a busy horde."));
      fragment.append(empty);
    }
    active.replaceChildren(fragment);
    if (focusedId) active.querySelector(`[data-id="${CSS.escape(focusedId)}"]`)?.focus();
  }
  const more = $("#lp-more");
  more.hidden = !folded && !showAllActive;
  more.textContent = showAllActive ? "Show fewer" : `Show ${folded} more working`;
  const recentList = $("#lp-recent");
  const recentPrint = JSON.stringify([scope, board.recent.map((card) => [card.id, ageLabel(card.updated, now)])]);
  if (recentList.dataset.fingerprint !== recentPrint) {
    recentList.dataset.fingerprint = recentPrint;
    recentList.replaceChildren(...board.recent.map((card) => partyButton(card, true)));
  }
  $("#lp-recent-title").hidden = !board.recent.length;
  $("#lp-older").textContent = board.older ? `· ${board.older} more` : "";
  const working = board.active.length;
  $("#lp-all-count").textContent = working ? `${working} active` : "";
  $("#lp-all").setAttribute("aria-current", String(scope === "all"));
  const note = [coverageNote(allScene.coverage), allScene.warning && !allScene.coverage ? allScene.warning : ""].filter(Boolean)[0] || "";
  $("#lp-note").textContent = note;
  $("#lp-note").hidden = !note;
  renderPill(board.active[0]);
}

function renderPill(top) {
  const signal = top ? partySignal(top) : { tone: "quiet", label: "ALL QUIET" };
  $("#pill-name").textContent = top ? clip(top.name, 28).toUpperCase() : "ALL PARTIES";
  const pillSignal = $("#pill-signal");
  pillSignal.textContent = signal.label;
  pillSignal.className = `signal tone-${signal.tone}`;
  const flag = $("#pill-flag");
  flag.hidden = !(signal.tone === "needs" || signal.tone === "failed");
  flag.textContent = signal.tone === "needs" ? "INPUT REQUEST" : "FAILED";
  flag.dataset.tone = signal.tone;
  $("#lp-pill").dataset.tone = signal.tone;
  const slot = $("#pill-goblin");
  const lead = top?.members?.slice().sort((a, b) => feedRank(a) - feedRank(b))[0];
  const id = lead?.id || "resting-camp";
  const action = lead ? pulse.action(lead) : "idle";
  let goblin = slot.firstChild;
  if (!goblin || goblin.dataset.member !== id) {
    goblin = createGoblin(id, action, { size: 1.5, tribe: tribeFor(lead) });
    goblin.dataset.member = id;
    slot.replaceChildren(goblin);
  } else setGoblinAction(goblin, action);
}

function setLaunchpadHidden(hidden, moveFocus = true) {
  view.launchpadHidden = hidden;
  document.body.classList.toggle("lp-hidden", hidden);
  $("#lp-pill").hidden = !hidden;
  saveView();
  if (moveFocus) (hidden ? $("#lp-pill") : $("#lp-hide")).focus({ preventScroll: true });
}

function renderSearch() {
  const query = $("#lp-query").value;
  const results = query.trim().length >= 2 ? searchSources(catalog, query) : [];
  $("#lp-search-count").textContent = query.trim().length < 2 ? "Type at least two letters." : `${results.length} ${results.length === 1 ? "match" : "matches"}`;
  $("#lp-results").replaceChildren(...results.map((source) => {
    const item = el("li");
    const button = el("button", "result", "");
    button.type = "button";
    const kind = sourceOf(source, source.id);
    const name = el("span", "pc-name", clip(source.name || source.id, 60));
    const meta = el("span", "result-meta", [projectName(source), ageLabel(stampMs(source.updatedAt))].filter(Boolean).join(" · "));
    button.append(sourceTag(kind), name, meta);
    button.addEventListener("click", () => { toggleSearch(false); selectScope(String(source.id)); });
    item.append(button);
    return item;
  }));
}

function toggleSearch(open) {
  const panel = $("#lp-search");
  panel.hidden = !open;
  $("#lp-find").setAttribute("aria-expanded", String(open));
  if (open) { if (view.launchpadHidden) setLaunchpadHidden(false); $("#lp-query").focus(); renderSearch(); }
  else $("#lp-query").value = "";
}

// ------------------------------------------------------------------ streams
function segments(text) {
  const result = [];
  for (const paragraph of String(text || "").split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean)) {
    let rest = paragraph;
    while (rest.length > 360) {
      const at = rest.lastIndexOf(". ", 340);
      const cut = at > 120 ? at + 1 : rest.lastIndexOf(" ", 340) > 120 ? rest.lastIndexOf(" ", 340) : 340;
      result.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) result.push(rest);
  }
  return result;
}

const atBottom = (node) => node.scrollHeight - node.scrollTop - node.clientHeight < 40;

function createStream(actor) {
  const node = $("#stream-template").content.firstElementChild.cloneNode(true);
  const state = {
    id: actor.id, node, bubbles: new Map(), rows: new Map(), dialogueStart: -1, newTalk: 0, newLog: 0, followLog: true,
    goblin: createGoblin(actor.id, "idle", { size: 4, tribe: tribeFor(actor) }), mini: createGoblin(actor.id, "idle", { size: 1, tribe: tribeFor(actor) }), dialogue: [],
  };
  $(".goblin-slot", node).append(state.goblin);
  $(".stream-goblin-mini", node).append(state.mini);
  const talk = $(".dialogue", node);
  const log = $(".fl-list", node);
  talk.addEventListener("scroll", () => { if (atBottom(talk)) { state.newTalk = 0; $(".jump", node).hidden = true; } });
  $(".jump", node).addEventListener("click", () => { talk.scrollTo({ top: talk.scrollHeight, behavior: "smooth" }); state.newTalk = 0; $(".jump", node).hidden = true; });
  log.addEventListener("scroll", () => {
    const following = atBottom(log);
    if (following !== state.followLog) { state.followLog = following; if (following) state.newLog = 0; paintFollow(state); }
  });
  $(".follow", node).addEventListener("click", () => { state.followLog = true; state.newLog = 0; log.scrollTo({ top: log.scrollHeight, behavior: "smooth" }); paintFollow(state); });
  $(".older", node).addEventListener("click", () => showEarlier(state));
  $(".act-condense", node).addEventListener("click", () => setMode(state, node.dataset.mode === "condensed" ? "normal" : "condensed"));
  $(".act-expand", node).addEventListener("click", () => setMode(state, node.dataset.mode === "expanded" ? "normal" : "expanded"));
  $(".act-hide", node).addEventListener("click", () => hideStream(state.id));
  $(".stream-head", node).addEventListener("dblclick", (event) => { if (!event.target.closest("button")) setMode(state, node.dataset.mode === "condensed" ? "normal" : "condensed"); });
  for (const tab of node.querySelectorAll(".stream-tabs [data-tab]")) tab.addEventListener("click", () => {
    node.dataset.tab = tab.dataset.tab;
    for (const other of node.querySelectorAll(".stream-tabs [data-tab]")) other.setAttribute("aria-selected", String(other === tab));
    const pane = tab.dataset.tab === "log" ? log : talk;
    pane.scrollTop = pane.scrollHeight;
  });
  $(".party-link", node).addEventListener("click", () => selectScope(scope === "all" ? node.dataset.party : "all"));
  streams.set(actor.id, state);
  return state;
}

function paintFollow(state) {
  const button = $(".follow", state.node);
  button.setAttribute("aria-pressed", String(state.followLog));
  button.lastChild.textContent = state.followLog ? " Follow new" : state.newLog ? ` ${state.newLog} new` : " Follow new";
}

function setMode(state, mode, remember = true) {
  const node = state.node;
  node.dataset.mode = mode;
  $(".act-condense", node).textContent = mode === "condensed" ? "Open" : "Condense";
  $(".act-expand", node).textContent = mode === "expanded" ? "Fit" : "Expand";
  $(".act-condense", node).setAttribute("aria-expanded", String(mode !== "condensed"));
  if (remember) { if (mode === "normal") delete view.modes[state.id]; else view.modes[state.id] = mode; saveView(); }
  if (mode !== "condensed") requestAnimationFrame(() => {
    const talk = $(".dialogue", node);
    talk.scrollTop = talk.scrollHeight;
    const log = $(".fl-list", node);
    if (state.followLog) log.scrollTop = log.scrollHeight;
  });
  if (mode === "expanded") node.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function scopeKey() { return demoMode ? `demo:${scope}` : scope; }

function hideStream(id) {
  const hidden = new Set(view.hidden[scopeKey()] || []);
  hidden.add(id);
  view.hidden[scopeKey()] = [...hidden].slice(-60);
  saveView();
  renderStreams();
}

function bubbleNode(text, item) {
  const bubble = el("div", "bubble");
  if (item.title === "Answer") bubble.classList.add("answer");
  bubble.append(el("p", "", text));
  return bubble;
}

function renderDialogue(state, actor, ask) {
  const node = state.node;
  const talk = $(".dialogue", node);
  const { dialogue } = splitStream(actor.activities || []);
  state.dialogue = dialogue;
  if (state.dialogueStart < 0) state.dialogueStart = Math.max(0, dialogue.length - DIALOGUE_PAGE);
  $(".older", node).hidden = state.dialogueStart === 0;
  const following = atBottom(talk) || !state.bubbles.size;
  let added = 0;
  for (const item of dialogue.slice(state.dialogueStart)) {
    segments(item.description).forEach((text, index) => {
      const key = `${item.id}:${index}`;
      const existing = state.bubbles.get(key);
      if (existing) { const body = existing.firstChild; if (body.textContent !== text) body.textContent = text; return; }
      const bubble = bubbleNode(text, item);
      state.bubbles.set(key, bubble);
      talk.append(bubble);
      added++;
    });
  }
  talk.querySelector(".bubble-empty")?.remove();
  if (!state.bubbles.size) {
    const quiet = el("div", "bubble bubble-empty");
    quiet.append(el("p", "", actor.activities?.length ? "No words yet. The field log shows what this goblin is doing." : "Listening for the first step…"));
    talk.append(quiet);
  }
  const bubbles = talk.querySelectorAll(".bubble:not(.bubble-empty)");
  bubbles.forEach((bubble, index) => {
    const last = index === bubbles.length - 1;
    bubble.classList.toggle("latest", last);
    bubble.classList.toggle("ask", last && ask);
  });
  if (following) { talk.scrollTop = talk.scrollHeight; state.newTalk = 0; $(".jump", node).hidden = true; }
  else if (added) {
    state.newTalk += added;
    $(".jump", node).textContent = `${state.newTalk} new ${state.newTalk === 1 ? "line" : "lines"} ↓`;
    $(".jump", node).hidden = false;
  }
}

function showEarlier(state) {
  const talk = $(".dialogue", state.node);
  const oldHeight = talk.scrollHeight;
  const oldStart = state.dialogueStart;
  state.dialogueStart = Math.max(0, oldStart - DIALOGUE_PAGE);
  const fragment = document.createDocumentFragment();
  for (const item of state.dialogue.slice(state.dialogueStart, oldStart)) segments(item.description).forEach((text, index) => {
    const key = `${item.id}:${index}`;
    if (state.bubbles.has(key)) return;
    const bubble = bubbleNode(text, item);
    state.bubbles.set(key, bubble);
    fragment.append(bubble);
  });
  talk.prepend(fragment);
  talk.scrollTop += talk.scrollHeight - oldHeight;
  $(".older", state.node).hidden = state.dialogueStart === 0;
}

const GLYPHS = { search: "⌕", read: "▤", edit: "✎", run: "▶", tool: "◇", failed: "✕", running: "◌", ask: "?" };

function logRow(item) {
  const row = el("li", "fl-row");
  const head = el("button", "fl-line");
  head.type = "button";
  head.append(el("span", "fl-icon", ""), el("span", "fl-title", ""), el("span", "fl-desc", ""));
  row.append(head);
  head.addEventListener("click", () => {
    const open = row.classList.toggle("open");
    head.setAttribute("aria-expanded", String(open));
  });
  return row;
}

function paintRow(row, item) {
  const glyph = item.ask ? "ask" : fieldGlyph(item);
  row.dataset.glyph = glyph;
  const head = row.firstChild;
  head.children[0].textContent = GLYPHS[glyph];
  head.children[1].textContent = clip(item.title, 90);
  const description = item.description && item.description !== item.title ? clip(item.description, 140) : "";
  head.children[2].textContent = description;
  const hasDetail = Boolean(item.detail || item.output);
  head.disabled = !hasDetail;
  head.title = hasDetail ? "Show the command and result" : "";
  const print = `${item.detail?.length || 0}:${item.output?.length || 0}`;
  if (hasDetail && row.dataset.detail !== print) {
    row.dataset.detail = print;
    row.querySelector(".fl-detail")?.remove();
    const detail = el("div", "fl-detail");
    if (item.detail) detail.append(el("small", "", "Command or tool input"), el("pre", "", item.detail));
    if (item.output) detail.append(el("small", "", "Result preview"), el("pre", "", item.output));
    row.append(detail);
  }
}

function renderLog(state, actor, ask) {
  const log = $(".fl-list", state.node);
  const items = splitStream(actor.activities || []).log.slice(-LOG_LIMIT);
  const question = actor.turnStates?.at(-1)?.questions?.length || actor.needsInput;
  if (ask && question) items.push({ id: `${actor.id}:ask`, ask: true, title: "Asked you a question", description: "" });
  const keep = new Set(items.map((item) => String(item.id)));
  for (const [id, row] of state.rows) if (!keep.has(id)) { row.remove(); state.rows.delete(id); }
  const following = state.followLog;
  const settled = state.rows.size > 0; // Only steps that arrive after the first look flash.
  let added = 0;
  for (const item of items) {
    const id = String(item.id);
    let row = state.rows.get(id);
    // Steps only ever arrive at the end, so existing rows stay put; the question row stays last.
    if (!row) { row = logRow(item); row.classList.toggle("fresh", settled); state.rows.set(id, row); log.append(row); added++; }
    else if (item.ask && row !== log.lastElementChild) log.append(row);
    paintRow(row, item);
  }
  log.querySelector(".fl-empty")?.remove();
  if (!items.length) log.append(el("li", "fl-empty", "No visible steps yet."));
  $(".tab-count", state.node).textContent = items.length ? String(items.length) : "";
  if (following) log.scrollTop = log.scrollHeight;
  else if (added) state.newLog += added;
  paintFollow(state);
}

function updateStream(state, actor, context) {
  const node = state.node;
  const status = memberStatus(actor);
  const action = pulse.action(actor);
  const ask = needsYou(actor);
  const tone = status.tone === "working" || status.tone === "done" ? (status.tone === "working" ? "working" : "quiet") : status.tone;
  node.dataset.tone = tone;
  node.dataset.party = context.partyId;
  const name = memberName(actor, context.partyName);
  $(".stream-name", node).textContent = name;
  const model = modelBadge(actor, { effort: true });
  const modelTag = model ? [Object.assign(el("span", "model-tag", model), { title: actor.model.id })] : [];
  if (model) modelTag[0].dataset.family = actor.model.family;
  $(".stream-party", node).replaceChildren(el("span", "", `· ${clip(context.partyName, 40)}`), ...(scope === "all" ? [sourceTag(context.source)] : []), ...modelTag);
  const link = $(".party-link", node);
  link.innerHTML = scope === "all" ? 'Party <span aria-hidden="true">▸</span>' : '<span aria-hidden="true">◂</span> All';
  link.setAttribute("aria-label", scope === "all" ? `Open the ${context.partyName} party` : "Back to all parties");
  const pill = $(".status-pill", node);
  pill.textContent = status.tone === "working" ? ACTION_WORDS[action] === "RESTING" ? status.word : ACTION_WORDS[action] : status.word;
  pill.dataset.tone = tone;
  pill.dataset.action = tone === "needs" ? "waiting" : tone === "failed" ? "trouble" : tone === "working" ? action : "idle";
  const word = $(".action-word", node);
  word.textContent = ACTION_WORDS[action];
  word.dataset.action = action;
  const label = `${name}, ${ACTION_WORDS[action].toLowerCase()}`;
  setGoblinAction(state.goblin, action, label);
  setGoblinAction(state.mini, action, label);
  renderDialogue(state, actor, ask);
  renderLog(state, actor, ask);
  const latest = latestLine(actor);
  $(".stream-latest", node).textContent = latest;
  $(".stream-latest", node).title = latest;
  node.setAttribute("aria-label", `${name} in ${context.partyName}: ${status.word.toLowerCase()}`);
}

function latestLine(actor) {
  const { dialogue, log } = splitStream(actor.activities || []);
  const words = dialogue.at(-1);
  const step = log.at(-1);
  const newest = !words ? step : !step ? words : (words.order ?? 0) >= (step.order ?? 0) ? words : step;
  return clip(newest ? (newest.kind === "update" ? newest.description : newest.title) : "Listening for the first step…", 140);
}

function scopeMembers() {
  if (scope === "all") {
    const agents = allScene?.agents || [];
    return agents.filter((actor) => feedRank(actor) <= 4).map((actor) => {
      const partyId = memberParty.get(actor.id) || partyScope(actor);
      const card = boardCards.get(partyId);
      const origin = catalog.find((item) => item.id === partyId);
      return { actor, partyId, partyName: card?.name || origin?.name || actor.name || "Party", source: sourceOf(card || origin || actor, partyId) };
    });
  }
  if (!partyScene) return [];
  const partyName = partyTitle();
  const source = sourceOf(partyScene.root, scope);
  return [partyScene.root, ...(partyScene.agents || [])].filter(Boolean).map((actor) => ({ actor, partyId: scope, partyName, source }));
}

function partyTitle() {
  return catalog.find((item) => item.id === scope)?.name || boardCards.get(scope)?.name || partyScene?.root?.name || "Party";
}

function renderStreams() {
  const list = $("#stream-list");
  const members = scopeMembers();
  const hidden = new Set(view.hidden[scopeKey()] || []);
  const leadId = scope === "all" ? "" : scope;
  const ordered = streamOrder(members.map((entry) => entry.actor), lastStreamOrder, leadId);
  lastStreamOrder = ordered.map((actor) => actor.id);
  const byId = new Map(members.map((entry) => [entry.actor.id, entry]));
  const visible = ordered.filter((actor) => !hidden.has(actor.id));
  const wanted = new Set(visible.map((actor) => actor.id));
  for (const [id, state] of streams) if (!wanted.has(id)) { state.node.remove(); streams.delete(id); }
  let previous = null;
  for (const actor of visible) {
    let state = streams.get(actor.id);
    if (!state) {
      state = createStream(actor);
      setMode(state, view.modes[actor.id] || "normal", false);
    }
    updateStream(state, actor, byId.get(actor.id));
    const target = previous ? previous.nextSibling : list.firstChild;
    if (state.node !== target) list.insertBefore(state.node, target);
    previous = state.node;
  }
  const emptyKey = visible.length ? "" : JSON.stringify([scope, Boolean(partyScene), partyError, Boolean(allScene), hidden.size]);
  const live = new Set([...streams.values()].map((state) => state.node));
  for (const stray of [...list.children]) if (!live.has(stray) && stray.dataset.key !== emptyKey) stray.remove();
  const hiddenCount = ordered.filter((actor) => hidden.has(actor.id)).length;
  const restore = $("#restore-hidden");
  restore.hidden = !hiddenCount;
  restore.textContent = `${hiddenCount} hidden · Show`;
  if (!visible.length && !list.firstElementChild) {
    const empty = emptyStreams(members.length, hiddenCount);
    empty.dataset.key = emptyKey;
    list.append(empty);
  }
  $("#condense-all").hidden = visible.length < 2;
  $("#expand-all").hidden = visible.length < 2;
}

function emptyStreams(total, hiddenCount) {
  const empty = el("div", "streams-empty");
  if (scope !== "all" && !partyScene) {
    if (partyError) empty.append(createGoblin("lost-scout", "trouble", { size: 3 }), el("p", "", "This party couldn't be opened."), el("small", "", partyError));
    else empty.append(createGoblin("loading-scout", "search", { size: 3 }), el("p", "", "Opening this party…"));
    return empty;
  }
  if (hiddenCount) {
    empty.append(createGoblin("tucked", "idle", { size: 3 }), el("p", "", "Every stream here is hidden."), el("small", "", "Use “Show” above to bring them back."));
    return empty;
  }
  if (scope === "all") {
    empty.append(createGoblin("resting-camp", "idle", { size: 4 }), el("p", "", allScene ? "The horde is resting." : "Gathering the horde…"),
      el("small", "", allScene ? "Working goblins appear here. Pick a recent party on the left to read its streams." : "Reading Codex, Claude Code, and any other feeds on this computer."));
  } else empty.append(createGoblin("quiet-party", "idle", { size: 3 }), el("p", "", total ? "" : "No goblins in this party yet."));
  return empty;
}

function renderScopeChrome() {
  const all = scope === "all";
  $("#scope-back").hidden = all;
  const source = all ? "" : sourceOf(partyScene?.root || catalog.find((item) => item.id === scope) || {}, scope);
  $("#scope-name").textContent = all ? "All parties" : partyTitle();
  const tag = $("#scope-source");
  tag.hidden = all;
  if (!all) { tag.className = `source-tag source-${source}`; tag.textContent = SOURCE_LABELS[source]; }
  const members = scopeMembers();
  const count = (tone) => members.filter(({ actor }) => memberStatus(actor).tone === tone).length;
  const bits = [];
  if (count("needs")) bits.push(`${count("needs")} need${count("needs") === 1 ? "s" : ""} you`);
  if (count("failed")) bits.push(`${count("failed")} failed`);
  if (count("working")) bits.push(`${count("working")} working`);
  if (!all && partyScene) {
    bits.unshift(`${members.length} ${members.length === 1 ? "goblin" : "goblins"}`);
    const project = projectName(partyScene.root);
    if (project && project !== partyTitle()) bits.push(project);
  }
  $("#scope-sub").textContent = bits.join(" · ");
  document.title = all ? "Goblin Horde · All parties" : `Goblin Horde · ${partyTitle()}`;
  // Replies only reach Codex chats; every other source is watch-only and says where to reply.
  const mode = all ? "all" : replyMode(partyScene?.root || {}, scope);
  $("#reply-dock").hidden = mode !== "reply" || !partyScene;
  const note = {
    claude: "Watching only. Reply in Claude Code; Goblin Horde can't send messages to Claude Code sessions.",
    extension: "Watching an extension feed. Reply in the tool that runs these agents.",
    orca: "Watching an Orca workspace. Reply to these agents in Orca.",
  }[mode] || "";
  $("#watch-note").textContent = note;
  $("#watch-note").hidden = !note;
  if (mode !== "reply") $("#requests-panel").hidden = true;
  $("#reply-label").textContent = `Reply to ${clip(partyTitle(), 48)}`;
}

// ------------------------------------------------------------------ alerts
let alertState = {};
let alertKey = "";
let alertInitialized = false;
let alerts = [];
let unreadAlerts = 0;

function readAlertStorage(key, suffix) {
  const name = `goblin-horde-${suffix}-${key}`;
  const saved = localStorage.getItem(name);
  if (saved !== null) return saved;
  const legacy = localStorage.getItem(`activity-lens-${suffix}-${key}`);
  if (legacy !== null) localStorage.setItem(name, legacy);
  return legacy;
}

function renderAlerts() {
  const list = $("#alerts-list");
  list.replaceChildren(...(alerts.length ? alerts.slice(0, 30).map((alert) => {
    const card = el("article", `alert-card tone-${alert.type === "input" ? "needs" : alert.type === "failed" ? "failed" : "working"}`);
    card.append(el("strong", "", alert.title), el("p", "", alert.body), el("small", "", new Date(alert.at).toLocaleTimeString()));
    return card;
  }) : [el("p", "drawer-help", "No alerts yet. Needs-you and failed steps will land here.")]));
  const count = $("#alert-count");
  count.textContent = String(unreadAlerts);
  count.hidden = !unreadAlerts;
}

function showAlert(type, title, body) {
  alerts.unshift({ type, title, body: clip(body, 180), at: Date.now() });
  alerts = alerts.slice(0, 30);
  if ($("#alerts-drawer").hidden) unreadAlerts++;
  renderAlerts();
  if (!demoMode) localStorage.setItem(`goblin-horde-alerts-${alertKey}`, JSON.stringify(alerts));
  if ("Notification" in window && window.isSecureContext && Notification.permission === "granted")
    new Notification(title, { body: clip(body, 140), tag: `${alertKey}-${type}-${Date.now()}` });
}

function observeAlerts(agents, requests = []) {
  const key = demoMode ? "demo:all" : "live:all";
  if (alertKey !== key) {
    alertKey = key;
    const saved = demoMode ? null : readAlertStorage(key, "observed");
    alertState = saved ? JSON.parse(saved) : {};
    alertInitialized = saved !== null;
    alerts = demoMode ? [] : JSON.parse(readAlertStorage(key, "alerts") || "[]");
    renderAlerts();
  }
  const fresh = {};
  const baseline = alertInitialized;
  for (const actor of agents) {
    const partyName = boardCards.get(memberParty.get(actor.id))?.name || "";
    const who = `${memberName(actor, partyName)}${partyName ? ` · ${partyName}` : ""}`;
    const actorKey = `actor:${actor.id}`;
    const seenBefore = Boolean(alertState[actorKey]);
    fresh[actorKey] = true;
    const needsKey = `needs:${actor.id}`;
    fresh[needsKey] = needsYou(actor);
    if (baseline && fresh[needsKey] && !alertState[needsKey]) {
      const question = actor.turnStates?.at(-1)?.questions?.[0];
      const where = { claude: "Answer in Claude Code.", orca: "Answer in Orca.", extension: "Answer in the tool that runs it." }[sourceOf(actor, actor.id)];
      showAlert("input", `${who} needs you`, question || where || "Open the party to answer.");
    }
    if (actor.source === "orca") {
      const stateKey = `state:${actor.id}`;
      fresh[stateKey] = actor.status;
      if (baseline && alertState[stateKey] && alertState[stateKey] !== actor.status && actor.status === "done") showAlert("finished", `${who} finished`, "The latest update is ready.");
    }
    for (const turn of actor.turnStates || []) {
      const turnKey = `turn:${actor.id}:${turn.id}`;
      fresh[turnKey] = turn.status;
      if (baseline && seenBefore && alertState[turnKey] && alertState[turnKey] !== turn.status && turn.status === "completed" && !(turn.questions || []).length)
        showAlert("finished", `${who} finished`, "A reply is ready in the stream.");
    }
    for (const activity of actor.activities || []) {
      if (activity.status !== "failed" && !(activity.exitCode != null && activity.exitCode !== 0)) continue;
      const failureKey = `failure:${actor.id}:${activity.id}`;
      fresh[failureKey] = true;
      if (baseline && seenBefore && !alertState[failureKey]) showAlert("failed", `${who}: ${activity.title}`, activity.description || "A step failed.");
    }
  }
  for (const request of requests) {
    const requestKey = `request:${request.id}`;
    fresh[requestKey] = true;
    if (baseline && !alertState[requestKey]) showAlert("input", "Codex needs your decision", request.params?.reason || "Open the party to respond.");
  }
  alertState = fresh;
  alertInitialized = true;
  if (!demoMode) localStorage.setItem(`goblin-horde-observed-${key}`, JSON.stringify(fresh));
}

// ------------------------------------------------------------------ Codex requests and replies
let lastRequestFingerprint = "";

function renderRequests(requests = [], requestThreadId = scope) {
  const fingerprint = JSON.stringify([requestThreadId, requests.map((request) => [request.id, request.method, request.params?.questions,
    request.params?.questionCount, request.params?.reason, request.params?.command])]);
  if (fingerprint === lastRequestFingerprint) return;
  lastRequestFingerprint = fingerprint;
  $("#requests-panel").hidden = requests.length === 0;
  const fragment = document.createDocumentFragment();
  for (const request of requests) {
    const card = el("article", "request-card");
    const details = request.params || {};
    if (request.method === "item/tool/requestUserInput" && request.summaryOnly) {
      // A phone is not sent Codex's questions, only how many there are.
      const count = Number(details.questionCount) || 1;
      card.append(el("h3", "", count === 1 ? "Codex is asking you a question" : `Codex is asking you ${count} questions`),
        el("p", "", "Answer on this computer: questions are not sent to phones."));
    } else if (request.method === "item/tool/requestUserInput") {
      card.append(el("h3", "", "Answer Codex"));
      const form = document.createElement("form");
      for (const question of details.questions || []) {
        const inputId = `request-${request.id}-${question.id}`;
        const label = el("label", "", question.question || question.header || "Your answer");
        label.htmlFor = inputId;
        form.append(label);
        if (question.options?.length) {
          const select = document.createElement("select");
          select.id = inputId;
          select.dataset.questionId = question.id;
          select.required = true;
          select.append(new Option("Choose an answer", ""));
          for (const option of question.options) select.append(new Option(option.label, option.label));
          if (question.isOther) select.append(new Option("Other…", "__other__"));
          form.append(select);
          if (question.isOther) {
            const other = document.createElement("input");
            other.type = question.isSecret ? "password" : "text";
            other.placeholder = "Type your answer";
            other.hidden = true;
            other.maxLength = 2000;
            select.addEventListener("change", () => { other.hidden = select.value !== "__other__"; other.required = !other.hidden; });
            form.append(other);
          }
        } else {
          const input = document.createElement("input");
          input.id = inputId;
          input.type = question.isSecret ? "password" : "text";
          input.dataset.questionId = question.id;
          input.maxLength = 2000;
          input.required = true;
          form.append(input);
        }
      }
      const actions = el("div", "request-actions");
      const button = el("button", "button gold", "Send answer");
      button.type = "submit";
      actions.append(button);
      const error = el("p", "request-error");
      error.hidden = true;
      form.append(actions, error);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const answers = {};
        for (const control of form.querySelectorAll("[data-question-id]")) {
          let value = control.value;
          if (value === "__other__") value = control.nextElementSibling.value;
          answers[control.dataset.questionId] = value;
        }
        button.disabled = true;
        try { await postJson("/api/respond", { threadId: requestThreadId, requestId: request.id, answers }); lastRequestFingerprint = ""; await refresh(true); }
        catch (cause) { error.textContent = cause.message; error.hidden = false; button.disabled = false; }
      });
      card.append(form);
    } else if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(request.method)) {
      card.append(el("h3", "", request.method.includes("commandExecution") ? "Approve a command?" : "Approve file changes?"));
      if (details.reason) card.append(el("p", "", details.reason));
      if (details.networkApprovalContext) card.append(el("p", "", `Network access: ${details.networkApprovalContext.host || "destination"}`));
      if (details.command) card.append(el("pre", "", clip(details.command, 2000)));
      if (details.grantRoot) card.append(el("p", "", `Files under ${details.grantRoot}`));
      const actions = el("div", "request-actions");
      for (const [decision, label] of [["decline", "Decline"], ["accept", "Approve once"]]) {
        const button = el("button", decision === "accept" ? "button gold" : "button", label);
        button.type = "button";
        button.addEventListener("click", async () => {
          for (const child of actions.querySelectorAll("button")) child.disabled = true;
          try { await postJson("/api/respond", { threadId: requestThreadId, requestId: request.id, decision }); lastRequestFingerprint = ""; await refresh(true); }
          catch (cause) { card.append(el("p", "request-error", cause.message)); for (const child of actions.querySelectorAll("button")) child.disabled = false; }
        });
        actions.append(button);
      }
      card.append(actions);
    } else {
      card.append(el("h3", "", "Codex is waiting"), el("p", "", "This kind of request can't be answered here yet. Answer it in Codex."));
    }
    fragment.append(card);
  }
  $("#requests-list").replaceChildren(fragment);
}

function showReplyState() {
  const body = $("#reply-text");
  body.value = replyDrafts.get(scope) || "";
  const offer = branchOffers.get(scope);
  $("#branch-choice").hidden = !offer || offer.message !== body.value.trim();
  $("#reply-send").disabled = demoMode || sendingReplies.has(scope);
  $("#branch-send").disabled = demoMode || sendingReplies.has(scope);
  $("#reply-status").textContent = demoMode ? "Replies are off in the demo." : "";
  body.disabled = demoMode;
}

async function sendReply(createBranch = false) {
  const body = $("#reply-text");
  const button = $("#reply-send");
  const branchButton = $("#branch-send");
  const status = $("#reply-status");
  const target = scope;
  const offer = branchOffers.get(target);
  const message = createBranch ? offer?.message : body.value.trim();
  if (createBranch && (!offer || body.value.trim() !== offer.message)) { $("#branch-choice").hidden = true; return; }
  // Only Codex chats take replies; Claude Code, Orca, and extension parties are watch-only.
  if (!message || demoMode || target === "all" || replyMode({}, target) !== "reply" || sendingReplies.has(target)) return;
  replyDrafts.set(target, body.value);
  sendingReplies.add(target);
  button.disabled = true;
  branchButton.disabled = true;
  status.className = "";
  status.textContent = createBranch ? "Starting your mobile branch…" : "Sending…";
  try {
    const result = await postJson("/api/reply", { threadId: target, message, createBranch });
    const stillHere = scope === target;
    if (replyDrafts.get(target)?.trim() === message) replyDrafts.delete(target);
    if (stillHere && body.value.trim() === message) body.value = "";
    branchOffers.delete(target);
    if (stillHere) $("#branch-choice").hidden = true;
    if (result.branchedFrom) {
      catalog.unshift({ id: result.threadId, name: "Mobile branch", source: "codex", updatedAt: Date.now() });
      if (scope === target) selectScope(result.threadId, { keepStatus: true });
    }
    if (scope === target || scope === result.threadId) {
      status.className = "ok";
      status.textContent = result.branchedFrom ? "Sent in your mobile branch. This view now follows that branch." : "Sent. The answer will appear in the stream.";
      await refresh(true);
    }
  } catch (error) {
    if (error.requiresBranch) branchOffers.set(target, { message });
    if (scope === target) {
      status.className = "error";
      status.textContent = error.message;
      $("#branch-choice").hidden = !error.requiresBranch || body.value.trim() !== message;
    }
  } finally {
    sendingReplies.delete(target);
    button.disabled = demoMode || sendingReplies.has(scope);
    branchButton.disabled = demoMode || sendingReplies.has(scope);
  }
}

// ------------------------------------------------------------------ data flow
function selectScope(id, { keepStatus = false } = {}) {
  if (!id || id === scope) { if (id === "all") document.querySelector(".streams").scrollTo?.({ top: 0 }); return; }
  replyDrafts.set(scope, $("#reply-text").value);
  scope = id;
  partyScene = null;
  partyError = "";
  lastStreamOrder = [];
  lastRequestFingerprint = "";
  for (const state of streams.values()) state.node.remove();
  streams.clear();
  $("#requests-panel").hidden = true;
  showReplyState();
  if (!keepStatus) $("#reply-status").textContent = demoMode ? "Replies are off in the demo." : "";
  const url = new URL(location.href);
  if (id === "all") url.searchParams.delete("thread"); else url.searchParams.set("thread", id);
  history.replaceState(null, "", url);
  if (matchMedia("(max-width: 820px)").matches && id !== "all") setLaunchpadHidden(true, false);
  renderScopeChrome();
  renderStreams();
  renderLaunchpad();
  refresh(true);
}

async function refresh(urgent = false) {
  if (polling) { if (urgent) refreshQueued = true; return; }
  polling = true;
  const wanted = scope;
  try {
    const [allResult, partyResult] = await Promise.allSettled([
      demoMode ? demoAll(demoStep) : getJson("/api/scene?id=all"),
      wanted === "all" ? null : demoMode ? demoParty(wanted, demoStep) : getJson(`/api/scene?id=${encodeURIComponent(wanted)}`),
    ]);
    if (wanted !== scope) { refreshQueued = true; return; }
    const problems = [];
    if (allResult.status === "fulfilled") { allScene = allResult.value; allFailed = false; }
    else { allFailed = true; problems.push(allResult.reason.message); }
    if (wanted !== "all") {
      if (partyResult.status === "fulfilled") { partyScene = partyResult.value; partyError = ""; }
      else {
        partyError = partyResult.reason.status === 404 || partyResult.reason.status === 403
          ? `${partyResult.reason.message} Pick another party from the launchpad.` : partyResult.reason.message;
        problems.push(partyError);
      }
    }
    const warning = (wanted === "all" ? allScene?.warning : partyScene?.warning) || "";
    if (problems.length) setLive("offline", allFailed ? "OFFLINE" : "PARTIAL");
    else setLive(demoMode ? "demo" : warning ? "partial" : "live", demoMode ? "DEMO" : warning ? "PARTIAL" : "LIVE");
    const banner = $("#error");
    banner.textContent = problems.join(" ") || "";
    banner.hidden = !problems.length;
    renderLaunchpad();
    if (allResult.status === "fulfilled") observeAlerts(allScene.agents || [], allScene.requests || []);
    renderScopeChrome();
    renderStreams();
    if (wanted !== "all" && partyScene && replyMode(partyScene.root, wanted) === "reply") renderRequests(partyScene.requests || [], wanted);
  } catch (error) {
    console.error(error);
    $("#error").textContent = `Something went wrong drawing this view: ${error.message}`;
    $("#error").hidden = false;
  } finally {
    polling = false;
    if (refreshQueued) { refreshQueued = false; queueMicrotask(() => refresh()); }
  }
}

async function loadCatalog() {
  if (demoMode) { catalog = demoCatalog(); return; }
  try {
    const { threads } = await getJson("/api/threads");
    const selected = catalog.find((item) => item.id === scope);
    catalog = threads;
    if (selected && !catalog.some((item) => item.id === selected.id)) catalog.unshift(selected);
    if (!$("#lp-search").hidden) renderSearch();
  } catch { /* Keep the current catalog if a source is briefly unavailable. */ }
}

const FEED_LABELS = { codex: "Codex", claude: "Claude Code", orca: "Orca", extensions: "Extension feeds" };

async function refreshCapabilities() {
  if (demoMode) {
    $("#feeds-list").replaceChildren(el("li", "drawer-help", "The demo uses invented parties only; no feeds are read."));
    return;
  }
  try {
    const { sources, widget } = await getJson("/api/capabilities");
    $("#feeds-list").replaceChildren(...Object.entries(sources || {}).map(([key, source]) => {
      const state = source.state === "ok" ? "ok" : ["none", "not-installed"].includes(source.state) ? "quiet" : "missing";
      const item = el("li", `feed-item feed-${state}`);
      item.append(el("span", "feed-dot"), el("strong", "", FEED_LABELS[key] || key), el("small", "", source.detail || source.state));
      if (key === "extensions") for (const entry of source.feeds || [])
        item.append(el("small", "feed-sub", `${entry.feed}: ${entry.parties} ${entry.parties === 1 ? "party" : "parties"}${entry.skipped ? `, ${entry.skipped} invalid lines skipped` : ""}`));
      return item;
    }));
    $("#widget-note").textContent = widget?.note || "";
  } catch { $("#feeds-list").replaceChildren(el("li", "drawer-help", "This viewer can't report its feeds.")); }
}

// ------------------------------------------------------------------ wiring
function toggleDrawer(id, open) {
  const drawer = $(`#${id}`);
  const show = open ?? drawer.hidden;
  for (const other of document.querySelectorAll(".drawer")) if (other !== drawer) other.hidden = true;
  drawer.hidden = !show;
  $("#alerts-toggle").setAttribute("aria-expanded", String(!$("#alerts-drawer").hidden));
  $("#camp-toggle").setAttribute("aria-expanded", String(!$("#camp-drawer").hidden));
  if (id === "alerts-drawer" && show) { unreadAlerts = 0; renderAlerts(); }
  if (id === "camp-drawer" && show) refreshCapabilities();
}

$("#alerts-toggle").addEventListener("click", () => toggleDrawer("alerts-drawer"));
$("#camp-toggle").addEventListener("click", () => toggleDrawer("camp-drawer"));
for (const button of document.querySelectorAll("[data-close]")) button.addEventListener("click", () => toggleDrawer(button.dataset.close, false));
$("#lp-hide").addEventListener("click", () => setLaunchpadHidden(true));
$("#lp-pill").addEventListener("click", () => setLaunchpadHidden(false));
$("#lp-find").addEventListener("click", () => toggleSearch($("#lp-search").hidden));
$("#lp-find-any").addEventListener("click", () => toggleSearch(true));
$("#lp-query").addEventListener("input", renderSearch);
$("#lp-query").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("#lp-results button")?.click();
  if (event.key === "Escape") toggleSearch(false);
});
$("#lp-all").addEventListener("click", () => selectScope("all"));
$("#lp-more").addEventListener("click", () => { showAllActive = !showAllActive; $("#lp-active").dataset.fingerprint = ""; renderLaunchpad(); });
$("#scope-back").addEventListener("click", () => selectScope("all"));
$("#restore-hidden").addEventListener("click", () => { delete view.hidden[scopeKey()]; saveView(); renderStreams(); });
$("#condense-all").addEventListener("click", () => { for (const state of streams.values()) setMode(state, "condensed"); });
$("#expand-all").addEventListener("click", () => { for (const state of streams.values()) setMode(state, "normal"); });
$("#reply-text").addEventListener("input", () => {
  const message = $("#reply-text").value;
  replyDrafts.set(scope, message);
  const offer = branchOffers.get(scope);
  if (offer && offer.message !== message.trim()) { branchOffers.delete(scope); $("#branch-choice").hidden = true; }
});
$("#reply-text").addEventListener("keydown", (event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) $("#reply-form").requestSubmit(); });
$("#reply-form").addEventListener("submit", (event) => { event.preventDefault(); sendReply(false); });
$("#branch-send").addEventListener("click", () => sendReply(true));
$("#demo-toggle").textContent = demoMode ? "Back to live" : "Party demo";
$("#demo-toggle").addEventListener("click", () => {
  const url = new URL(location.href);
  if (demoMode) url.searchParams.delete("demo"); else url.searchParams.set("demo", "1");
  url.searchParams.delete("thread");
  location.href = url;
});
$("#popout-toggle").hidden = compactMode;
$("#compact-exit").hidden = !compactMode;
$("#popout-toggle").addEventListener("click", () => {
  const url = new URL(location.href);
  url.searchParams.set("compact", "1");
  const popup = window.open(url.toString(), "goblin-horde-compact", "popup,width=480,height=760");
  if (!popup) location.href = url.toString();
});
$("#compact-exit").addEventListener("click", () => { const url = new URL(location.href); url.searchParams.delete("compact"); location.href = url.toString(); });
$("#mobile-toggle").addEventListener("click", () => {
  const details = $("#mobile-details");
  details.hidden = !details.hidden;
  $("#mobile-toggle").setAttribute("aria-expanded", String(!details.hidden));
  $("#mobile-toggle").textContent = details.hidden ? "Pair a phone" : "Hide pairing code";
  $("#mobile-code").textContent = details.hidden ? "" : mobilePairingCode; // Shown only on request.
});
// Phone access is off until the person turns it on here or in the desktop goblins' ⋯ menu. Only this
// computer sees the switch; a paired phone never gets this panel.
let phoneEnabled = false;
function showPhone(mobile) {
  if (!mobile.local) return;
  phoneEnabled = Boolean(mobile.enabled);
  const paired = Boolean(mobile.available && mobile.code);
  $("#mobile-status").textContent = !mobile.enabled
    ? "Phone access is off. Turn it on to read these chats, reply to Codex, and approve Codex requests from a phone on the same Wi-Fi."
    : paired ? `Phone access is on${mobile.adapter ? ` (${mobile.adapter})` : ""}. Anyone with the code on this network can read and reply.`
      : mobile.problem || "Phone access is on, but no Wi-Fi address is available yet.";
  $("#mobile-switch").textContent = mobile.enabled ? "Turn off phone access" : "Turn on phone access";
  $("#mobile-pair").hidden = !paired;
  $("#mobile-address").textContent = paired ? mobile.address : "";
  $("#mobile-address").href = paired ? mobile.address : "#";
  mobilePairingCode = paired ? mobile.code : "";
  if (!paired) { $("#mobile-details").hidden = true; $("#mobile-code").textContent = ""; $("#mobile-toggle").textContent = "Pair a phone"; }
  $("#mobile-panel").hidden = false;
}
async function changePhone(path, value) {
  try {
    await postJson(path, value);
    showPhone(await getJson("/api/mobile"));
  } catch (error) { $("#mobile-status").textContent = error.message; }
}
$("#mobile-switch").addEventListener("click", () => {
  if (!phoneEnabled && !confirm("Turn on phone access?\n\nThis computer starts answering on your Wi-Fi. A phone that enters the pairing code can read these chats, send replies to Codex, and approve or decline Codex commands. It uses plain HTTP, so only do this on a network you trust.")) return;
  changePhone("/api/phone", { enabled: !phoneEnabled });
});
$("#mobile-reset").addEventListener("click", () => {
  if (confirm("Make a new pairing code? Every paired phone is signed out and must pair again with the new code.")) changePhone("/api/phone/reset", {});
});
$("#enable-system-alerts").addEventListener("click", async () => {
  const permission = await Notification.requestPermission();
  $("#enable-system-alerts").textContent = permission === "granted" ? "System alerts on" : "Unavailable";
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") for (const drawer of document.querySelectorAll(".drawer")) if (!drawer.hidden) toggleDrawer(drawer.id, false);
  if (event.key === "/" && !event.target.closest("input, textarea, select")) { event.preventDefault(); toggleSearch(true); }
});

document.body.classList.toggle("compact", compactMode);
document.body.classList.toggle("demo-mode", demoMode);
setLaunchpadHidden(view.launchpadHidden, false);
$("#brand-goblin").append(createGoblin("goblin-horde-brand", "idle", { size: 1.25 }));
if ("Notification" in window && window.isSecureContext && Notification.permission !== "granted") $("#enable-system-alerts").hidden = false;
else if (!window.isSecureContext) $("#alert-help").textContent = "Alerts collect here while this page is open. Phone notifications in the background need HTTPS.";
renderAlerts();
showReplyState();
renderScopeChrome();
renderStreams();
loadArt().catch(() => document.body.classList.add("no-art"));

try {
  if (!demoMode) {
    const config = await getJson("/api/config");
    pollMs = config.pollMs || pollMs;
    // A launcher started with -ThreadId opens on that chat; the launchpad is one click away.
    if (!params.has("thread") && config.defaultThreadId && config.defaultThreadId !== "all") scope = config.defaultThreadId;
    getJson("/api/mobile").then(showPhone).catch(() => {});
  }
  await loadCatalog();
  if (scope !== "all" && !catalog.some((item) => item.id === scope) && !/^(claude|orca|ext):/.test(scope) && !demoMode)
    catalog.unshift({ id: scope, name: "This chat", source: "codex", updatedAt: Date.now() });
  await refresh();
  setInterval(refresh, pollMs);
  if (demoMode) setInterval(() => { if (demoStep < demoLength) demoStep++; }, 1600);
  else setInterval(loadCatalog, 10_000);
} catch (error) {
  setLive("offline", "OFFLINE");
  $("#error").textContent = error.message;
  $("#error").hidden = false;
  allFailed = true;
  renderLaunchpad();
}
