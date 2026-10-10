// Synthetic parties for the viewer's demo mode. Every name, file, and line here is invented;
// nothing is read from real chats, projects, or settings.
const start = Date.now();
const DAY = 86_400_000;

// Party ids reuse each source's prefix so the demo shows the same reply rules as real parties.
const PARTIES = [
  { id: "demo-lantern-shop", source: "codex", name: "Lantern Shop", cwd: "/demo/lantern-shop" },
  { id: "claude:demo-dungeon-map", source: "claude", name: "Dungeon Map", cwd: "/demo/dungeon-map" },
  { id: "ext:demo/rune-docs", source: "extension", name: "Rune Docs", cwd: "/demo/rune-docs" },
  { id: "orca:demo-tavern-bot", source: "orca", name: "Tavern Bot", cwd: "/demo/workspaces/tavern-bot" },
];
const RECENT = [
  { id: "demo-quest-log", source: "codex", name: "Quest Log", cwd: "/demo/quest-log", updatedAt: start - DAY - 3_600_000 },
  { id: "demo-pixel-forge", source: "codex", name: "Pixel Forge", cwd: "/demo/pixel-forge", updatedAt: start - 3 * DAY },
  { id: "demo-map-tiles", source: "codex", name: "Map tile cleanup", cwd: "/demo/dungeon-map", updatedAt: start - 9 * DAY },
  { id: "demo-sound-pass", source: "codex", name: "Sound pass", cwd: "/demo/tavern-bot", updatedAt: start - 20 * DAY },
];

const say = (text, title = "Update") => ({ kind: "update", title, description: text });
const run = (title, description, extra = {}) => ({ kind: "command", title, description, ...extra });
const edit = (file) => ({ kind: "file", title: `Changed ${file}`, description: file });
const look = (title, description) => ({ kind: "research", title, description });

// [party, member id, name, role, lead?, end state, script]
const MEMBERS = [
  ["demo-lantern-shop", "demo-lantern-shop", "Scout", "Lead", true, "needs", [
    say("I'm sorting out the shop sign first, then the price list with Tinker."),
    look("Searched assets for \"sign\"", "Found two sign sketches in the assets folder."),
    run("Read 3 files", "sign.svg · sign_preview.css · palette.json"),
    edit("sign_preview.css"),
    say("Two sign designs are ready. Should the shop use lantern gold or moss green?", "Answer"),
  ]],
  ["demo-lantern-shop", "demo-lantern-tinker", "Tinker", "Builder", false, "working", [
    run("Read inventory.js", "Looked at how the inventory grid draws prices."),
    say("Wiring the new price list into the inventory grid."),
    edit("inventory.js"),
    run("Ran tests · 18 passed", "All 18 inventory checks passed.", { exitCode: 0 }),
    edit("price_list.json"),
    say("Price list wired in. Running the tests once more before I hand it back."),
    run("Running tests", "Checking the inventory grid again.", { status: "inProgress" }),
  ]],
  ["demo-lantern-shop", "demo-lantern-lumen", "Lumen", "Reviewer", false, "working", [
    look("Opened the style guide", "Checked the shop's color rules."),
    say("Reviewing the sign colors against the style guide."),
    run("Checked contrast", "Gold on moss reads at 7.1:1."),
  ]],
  ["claude:demo-dungeon-map", "claude-agent:demo-dungeon-grub", "Grub", "Tiles", true, "failed", [
    say("Cleaning up the tile loader so big maps open faster."),
    edit("tile_loader.ts"),
    run("Lint check", "2 lint errors in tile_loader.ts.", { status: "failed", exitCode: 1 }),
    say("The lint check failed on two unused imports. I'll stop here so you can see it."),
  ]],
  ["claude:demo-dungeon-map", "claude-agent:demo-dungeon-mire", "Mire", "Explorer", false, "working", [
    look("Searched for \"slow tiles\"", "Three places load tiles one by one."),
    say("Found the slow tile loader. Reading it now."),
    run("Read map_cache.ts", "Looked at how tiles are cached."),
    say("Planning a smaller cache so the map doesn't redraw every tile."),
  ]],
  ["ext:demo/rune-docs", "ext-agent:demo/rune-docs/quill", "Quill", "Writer", true, "working", [
    run("Read README.md", "Checked what the docs promise today."),
    say("Rewriting the install section in plain words."),
    edit("README.md"),
  ]],
  ["ext:demo/rune-docs", "ext-agent:demo/rune-docs/inka", "Inka", "Builder", false, "working", [
    edit("docs/runes.md"),
    say("Adding a short example for each rune."),
    edit("docs/examples.md"),
  ]],
  ["ext:demo/rune-docs", "ext-agent:demo/rune-docs/pip", "Pip", "Checker", false, "working", [
    look("Searched the changelog", "Collected this month's changes."),
    run("Checked links", "41 links checked."),
    say("All the doc links work. Drafting release notes next."),
  ]],
  ["orca:demo-tavern-bot", "orca:demo-tavern-bot:brew", "Brew", "Builder", true, "working", [
    say("Teaching the tavern bot to greet new players."),
    edit("greetings.yaml"),
    run("Ran unit tests · 24 passed", "All greeting checks passed.", { exitCode: 0 }),
  ]],
  ["orca:demo-tavern-bot", "orca:demo-tavern-bot:hops", "Hops", "Explorer", false, "working", [
    look("Searched the docs", "Found the chat command reference."),
    say("Checking which commands players use most."),
  ]],
];

function member([partyId, id, name, role, lead, end, script], step) {
  const party = PARTIES.find((item) => item.id === partyId);
  const shown = Math.min(script.length, 2 + Math.floor(step / 2) + (id.length % 2));
  const done = shown === script.length;
  const now = Date.now();
  const activities = script.slice(0, shown).map((event, index) => ({
    id: `${id}:${index}`, turnId: `${id}:turn`, turnStartedAt: Math.floor(start / 1000) + index, order: index,
    detail: "", output: "", status: "completed", exitCode: null, ...event,
  }));
  if (!done && activities.at(-1)?.status === "completed" && activities.at(-1).kind !== "update") activities.at(-1).status = "inProgress";
  const state = done ? end : "working";
  const lastQuestion = state === "needs" ? script.at(-1).description : "";
  return {
    id, name, nickname: name, role, source: party.source, cwd: party.cwd, parentThreadId: lead ? "" : partyId,
    status: state === "failed" ? "failed" : state === "needs" ? "waiting" : "running",
    attention: state === "needs" ? "needs" : state, needsInput: state === "needs",
    updatedAt: now - 4000, turns: 1, activities, latest: activities.at(-1) || null,
    turnStates: [{ id: `${id}:turn`, status: state === "working" ? "inProgress" : state === "failed" ? "failed" : "completed",
      questions: lastQuestion ? [lastQuestion] : [], error: "" }],
    counts: { updates: 0, commands: 0, research: 0, tools: 0 },
  };
}

const members = (step) => MEMBERS.map((row) => ({ ...member(row, step), partyId: row[0] }));

export const demoLength = 14;

export function demoCatalog() {
  return [...PARTIES.map((party) => ({ ...party, updatedAt: Date.now() - 4000 })), ...RECENT];
}

/** The all-parties scene, shaped like /api/scene?id=all. Leads use their party id. */
export function demoAll(step) {
  const agents = members(step).map(({ partyId, ...actor }) => ({ ...actor, id: actor.parentThreadId ? actor.id : partyId }));
  return { root: { id: "all", source: "all", name: "All parties", activities: [], turnStates: [], counts: {} }, agents, requests: [], checkedAt: Date.now(),
    coverage: { complete: true }, totals: {} };
}

/** One party's scene, shaped like /api/scene?id=<party>. */
export function demoParty(partyId, step) {
  const party = PARTIES.find((item) => item.id === partyId) || RECENT.find((item) => item.id === partyId);
  const own = members(step).filter((actor) => actor.partyId === partyId).map(({ partyId: _party, ...actor }) => actor);
  const lead = own.find((actor) => !actor.parentThreadId);
  const root = lead ? { ...lead, id: partyId, name: party.name } : {
    id: partyId, name: party?.name || "Demo party", nickname: "Keeper", source: party?.source || "codex", cwd: party?.cwd || "",
    status: "completed", updatedAt: party?.updatedAt || Date.now(), turnStates: [{ id: "t", status: "completed", questions: [] }],
    activities: [{ id: `${partyId}:0`, turnId: "t", order: 0, kind: "update", title: "Answer", status: "completed",
      description: "All done here. The quest log saves between sessions now." }],
  };
  return { root, agents: own.filter((actor) => actor.parentThreadId), requests: [], checkedAt: Date.now() };
}
