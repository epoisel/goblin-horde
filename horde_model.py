"""What the Horde window shows, decided without a display.

Everything here is pure: it reads scene actors (GET /api/scene?id=all), agent details
(GET /api/agent?id=), and saved settings, and returns plain values the Tk views draw. Keeping the
decisions here means the roster's sections and order, the line under each goblin, which detail
sections appear, the strip's overflow, and the settings migration are all unit-tested without Tk.

Every field the server added for 0.6 (`ask`, `waitingOn`, `now`, `progress`, `dismissedAsk`) is
optional: an older viewer that does not send them still gets a sensible roster.
"""

from __future__ import annotations

import time
from typing import NamedTuple

from goblin_motion import stamp_ms
from goblin_sprite import model_of

NOT_AGENTS = ("", "all", "standby")
DAY_MS = 86_400_000
# Classes of agent, from most to least urgent.
NEEDS, FAILED, WORKING, DONE = "needs", "failed", "working", "done"
ACTIVE_STATES = {"inprogress", "working", "running", "active", "blocked"}
# Model badges take their tribe's colour: Claude's hexers in ochre, OpenAI's sappers in forge steel.
FAMILY_INK = {"claude": "#eba27a", "openai": "#8fcbd6"}
FAMILY_INK_OTHER = "#c9b991"
SOURCE_NAMES = {"codex": "Codex", "claude": "Claude Code", "orca": "Orca", "extension": "Feed"}
APP_NAMES = {"codex": "Codex", "claude": "Claude Code", "orca": "Orca", "extension": "its app"}
DONE_LIMIT = 40
STRIP_LIMIT = 12


# Small facts about one actor -------------------------------------------------------------------
def actor_id(actor: dict) -> str:
    return str(actor.get("id") or "")


def is_agent(actor) -> bool:
    return isinstance(actor, dict) and actor_id(actor) not in NOT_AGENTS


def source_of(actor: dict) -> str:
    """codex, claude, orca, or extension, from the source field or the id's prefix."""
    source = str(actor.get("source") or "")
    key = actor_id(actor)
    if source == "orca" or key.startswith(("orca:", "orca-agent:")):
        return "orca"
    if source == "claude" or key.startswith(("claude:", "claude-agent:")):
        return "claude"
    if source == "extension" or key.startswith(("ext:", "ext-agent:")):
        return "extension"
    return "codex"


def party_scope(actor: dict) -> str:
    """Members belong to their parent chat or workspace party."""
    return str(actor.get("parentThreadId") or actor.get("id") or "")


def project_for(source: dict) -> tuple[str, str]:
    """A grouping key and a short project name from a working folder ('workspaces/<name>' wins)."""
    path = str(source.get("cwd") or "").replace("\\", "/").rstrip("/")
    parts = [part for part in path.split("/") if part]
    if "workspaces" in parts:
        index = parts.index("workspaces")
        if index + 1 < len(parts):
            project = parts[index + 1]
            return f"workspace:{project.lower()}", project
    if parts:
        return f"path:{path.lower()}", parts[-1]
    return "project:other", "Other work"


def project_name(source: dict) -> str:
    """The project's short name, or '' when the source has no working folder."""
    return project_for(source)[1] if str(source.get("cwd") or "").strip("/\\ ") else ""


def model_badge(actor: dict, with_effort: bool = False) -> str:
    """The short model label a goblin wears, e.g. 'Opus 5.5' or 'GPT-5.6 Sol · high'; '' when unknown."""
    model = model_of(actor)
    label = str(model.get("label") or "").strip()
    if not label:
        return ""
    effort = str(model.get("effort") or "") if with_effort else ""
    return f"{label} · {effort}" if effort else label


def family_ink(actor: dict) -> str:
    return FAMILY_INK.get(str(model_of(actor).get("family") or ""), FAMILY_INK_OTHER)


def join_reason(actor: dict) -> str:
    """Why a member is in this party when it joined from elsewhere (see lib/links.mjs), or ''."""
    joined = actor.get("joined")
    if not isinstance(joined, dict):
        return ""
    reason = joined.get("reason")
    if reason == "manual":
        return "Joined to this chat by you."
    if reason == "worker":
        return "A worker started by this chat's Orca coordinator."
    if reason == "worktree":
        return "Works in the Orca worktree this chat drives."
    verb = str(joined.get("verb") or "")
    return f"This chat drives it{f' (orca {verb})' if verb else ''}."


def display_name(actor: dict, aliases: dict | None = None) -> str:
    """The name to show: a local alias beside the agent's own name, so the real one stays visible.
    A subagent goes by its nickname ("Explore subagent"); a chat or session by its title."""
    names = (actor.get("nickname"), actor.get("name")) if _is_subagent(actor) else (actor.get("name"), actor.get("nickname"))
    original = " ".join(str(next((name for name in names if name), "") or actor_id(actor) or "Goblin").split())
    alias = (aliases or {}).get(actor_id(actor), "")
    return f"{alias} · {original}" if alias and alias != original else original


def updated_ms(actor: dict) -> float:
    return stamp_ms(actor.get("updatedAt")) or 0.0


def clip(value, limit: int) -> str:
    text = " ".join(str(value or "").split())
    return text if len(text) <= limit else text[:limit - 1].rstrip() + "…"


# Time ------------------------------------------------------------------------------------------
def elapsed(ms: float) -> str:
    """A running timer: '12s', '4m 05s', '1h 12m', '2d 3h'."""
    seconds = max(0, int((ms or 0) // 1000))
    if seconds < 60:
        return f"{seconds}s"
    minutes, seconds = divmod(seconds, 60)
    if minutes < 60:
        return f"{minutes}m {seconds:02d}s"
    hours, minutes = divmod(minutes, 60)
    if hours < 24:
        return f"{hours}h {minutes:02d}m"
    days, hours = divmod(hours, 24)
    return f"{days}d {hours}h"


def duration(ms) -> str:
    """How long a finished step took: '0.4s', '2.3s', '1m 12s'."""
    try:
        value = float(ms)
    except (TypeError, ValueError):
        return ""
    if value < 0:
        return ""
    if value < 60_000:
        return f"{value / 1000:.1f}s"
    return elapsed(value)


def age_short(stamp, now_ms: float) -> str:
    """How long ago, as short as a roster row can afford: 'now', '4m', '3h', '2d', 'Oct 3'."""
    then = stamp_ms(stamp)
    if not then:
        return ""
    minutes = max(0, int((now_ms - then) / 60_000))
    if minutes < 1:
        return "now"
    if minutes < 60:
        return f"{minutes}m"
    if minutes < 48 * 60:
        return f"{minutes // 60}h"
    if minutes < 14 * 24 * 60:
        return f"{minutes // (24 * 60)}d"
    return time.strftime("%b %d", time.localtime(then / 1000)).replace(" 0", " ")


def age_label(stamp, now_ms: float | None = None) -> str:
    """A short, honest age for sentences: 'now', '4m ago', '3h ago', '2d ago', or a date."""
    short = age_short(stamp, now_ms if now_ms is not None else time.time() * 1000)
    return f"{short} ago" if short[:-1].isdigit() and short[-1:] in ("m", "h", "d") else short


def clock_label(stamp) -> str:
    """The local time of day of a trail step, '14:05'."""
    then = stamp_ms(stamp)
    return time.strftime("%H:%M", time.localtime(then / 1000)) if then else ""


def start_of_day(now_ms: float) -> float:
    local = time.localtime(now_ms / 1000)
    return time.mktime((local.tm_year, local.tm_mon, local.tm_mday, 0, 0, 0, 0, 0, -1)) * 1000


# What an agent is doing -------------------------------------------------------------------------
def _questions(actor: dict) -> list[str]:
    turns = actor.get("turnStates") or []
    last = turns[-1] if turns and isinstance(turns[-1], dict) else {}
    return [str(item) for item in last.get("questions") or [] if str(item).strip()]


def _is_subagent(actor: dict) -> bool:
    """A subagent reports to its parent; it never asks the person anything (SPEC root cause 2)."""
    if actor.get("childOf"):
        return True
    source = source_of(actor)
    return source == "codex" and bool(actor.get("parentThreadId")) and not actor.get("joined")


def ask_of(actor: dict) -> dict | None:
    """The question this agent is waiting on the person for, or None.

    A viewer that sends `ask` decides: null means nothing to ask (or it was dismissed). An older
    viewer only says `needsInput` or lists questions at the end of a turn; those become a plain ask
    that can only be answered in the agent's own app. Orca's "waiting" and a subagent's closing
    question are never asks for the person."""
    if "ask" in actor:
        ask = actor.get("ask")
        return ask if isinstance(ask, dict) else None
    if str(actor.get("attention") or "").lower() == "quiet" or source_of(actor) == "orca" or _is_subagent(actor):
        return None
    questions = _questions(actor)
    if not questions and not actor.get("needsInput"):
        return None
    if questions:
        text, kind = questions[-1], "question"
    elif source_of(actor) == "codex":
        text, kind = "Waiting for you to approve a step in Codex.", "approval"
    else:
        text, kind = f"Waiting for you in {APP_NAMES.get(source_of(actor), 'its app')}.", "permission"
    at = updated_ms(actor)
    return {"kind": kind, "text": text, "at": at, "answerHere": None, "key": f"legacy:{actor_id(actor)}:{int(at)}",
            "legacy": True}


def ask_text(ask: dict | None) -> str:
    """The words of an ask: its text, else its first question, else the command it wants to run."""
    if not ask:
        return ""
    text = str(ask.get("text") or "").strip()
    if not text:
        questions = ask.get("questions") or []
        if questions and isinstance(questions[0], dict):
            text = str(questions[0].get("text") or "").strip()
    return text or str(ask.get("command") or "").strip() or "Waiting for you."


def waiting_of(actor: dict) -> dict | None:
    waiting = actor.get("waitingOn")
    return waiting if isinstance(waiting, dict) else None


def waiting_text(waiting: dict) -> str:
    who = "Asked the coordinator" if waiting.get("who") != "parent" else "Waiting on its parent agent"
    text = " ".join(str(waiting.get("text") or "").split())
    return f"{who}: {text}" if text else who


def now_of(actor: dict) -> dict | None:
    current = actor.get("now")
    return current if isinstance(current, dict) and current.get("title") else None


def progress_of(actor: dict) -> dict | None:
    progress = actor.get("progress")
    if not isinstance(progress, dict):
        return None
    try:
        done, total = int(progress.get("done") or 0), int(progress.get("total") or 0)
    except (TypeError, ValueError):
        return None
    return {**progress, "done": max(0, min(done, total)), "total": total} if total > 0 else None


def progress_label(actor: dict) -> str:
    progress = progress_of(actor)
    return f"{progress['done']}/{progress['total']}" if progress else ""


def failed_step(item: dict) -> bool:
    return item.get("status") == "failed" or item.get("exitCode") not in (None, 0)


def failure_text(actor: dict) -> str:
    """What failed, in a few words: 'Failed: Ran project tests · exit 1'."""
    for item in reversed(actor.get("activities") or []):
        if isinstance(item, dict) and failed_step(item):
            exit_code = item.get("exitCode")
            command = str(item.get("detail") or "") if item.get("kind") == "command" else ""
            title = clip(command.splitlines()[0] if command.strip() else item.get("title") or "a step", 80)
            return f"Failed: {title}" + (f" · exit {exit_code}" if exit_code not in (None, 0) else "")
    turns = actor.get("turnStates") or []
    error = str((turns[-1] or {}).get("error") or "") if turns and isinstance(turns[-1], dict) else ""
    return f"Failed: {clip(error, 120)}" if error else "Something failed."


def latest_line(actor: dict) -> str:
    """The newest public step in plain words, for agents whose viewer sends no `now`."""
    activities = actor.get("activities") or []
    if not activities:
        return ""
    item = activities[-1]
    if item.get("title") == "Status" and item.get("description") == "Finished the task.":
        item = next((entry for entry in reversed(activities[:-1])
                     if entry.get("kind") == "update" and entry.get("description")), item)
    description = " ".join(str(item.get("description") or "").split())
    if item.get("kind") == "update":
        return description or "Has an update."
    if item.get("kind") == "file":
        return f"Changed {description}" if description else "Changed project files."
    if failed_step(item):
        return "That check failed."
    return str(item.get("title") or "") or description or "Working on a step."


def actor_class(actor: dict) -> str:
    """needs, failed, working, or done. Only a real ask needs the person; an agent waiting on its
    coordinator is still at work."""
    if ask_of(actor):
        return NEEDS
    attention = str(actor.get("attention") or "").lower()
    if attention == "failed":
        return FAILED
    if waiting_of(actor) or now_of(actor) or attention == "working":
        return WORKING
    if attention in ("quiet", "waiting", "needs"):
        # "needs" without an ask was dismissed or was never for the person; Orca's waiting is idle.
        return DONE
    status = str(actor.get("status") or "").lower()
    turns = actor.get("turnStates") or []
    turn_status = str((turns[-1] or {}).get("status") or "").lower() if turns and isinstance(turns[-1], dict) else ""
    if status in ("failed", "error", "systemerror") or turn_status == "failed":
        return FAILED
    if status in ACTIVE_STATES or turn_status in ACTIVE_STATES:
        return WORKING
    return DONE


class Line(NamedTuple):
    """The second line of a roster row: its tone (ask, waiting, failed, now, done) and words."""
    tone: str
    text: str


def row_line(actor: dict, klass: str | None = None) -> Line:
    """ask > waitingOn > failure > now > the newest step. Each tone has its own colour."""
    klass = klass or actor_class(actor)
    ask = ask_of(actor)
    if ask:
        return Line("ask", ask_text(ask))
    waiting = waiting_of(actor)
    if waiting:
        return Line("waiting", waiting_text(waiting))
    if klass == FAILED:
        return Line("failed", failure_text(actor))
    current = now_of(actor)
    if current:
        return Line("now", " ".join(str(current["title"]).split()))
    if klass == WORKING:
        return Line("now", latest_line(actor) or "Working…")
    return Line("done", latest_line(actor) or "Done.")


def motion_view(actor: dict, klass: str) -> dict:
    """The actor as goblin_action should read it: the bell is rung only for a real ask, so an
    Orca agent idle at its prompt or a subagent's closing question never waves for attention."""
    view = dict(actor)
    view["needsInput"] = klass == NEEDS
    if klass == NEEDS:
        return view
    if str(view.get("status") or "").lower() == "waiting":
        view["status"] = "working" if klass == WORKING else "idle"
    turns = view.get("turnStates") or []
    if turns and isinstance(turns[-1], dict) and turns[-1].get("questions"):
        view["turnStates"] = [*turns[:-1], {**turns[-1], "questions": []}]
    if klass == DONE:
        view["attention"] = "quiet"
    return view


# Parties ---------------------------------------------------------------------------------------
def parent_map(members: list[dict]) -> dict[str, str]:
    """Which member each member reports to: a Claude subagent to its session, an Orca worker to the
    pane that started it, a Codex subagent or joined worker to its chat. Only parents present count."""
    ids = {actor_id(actor) for actor in members}
    panes = {str(actor.get("pane")): actor_id(actor) for actor in members if actor.get("pane")}
    parents: dict[str, str] = {}
    for actor in members:
        own = actor_id(actor)
        candidates = (str(actor.get("childOf") or ""), panes.get(str(actor.get("parentPane") or ""), ""),
                      str(actor.get("parentThreadId") or ""))
        parent = next((value for value in candidates if value and value != own and value in ids), "")
        if parent:
            parents[own] = parent
    # Break any loop a confused feed could describe: walk up and cut where an id repeats.
    for own in list(parents):
        seen = {own}
        current = parents.get(own)
        while current:
            if current in seen:
                parents.pop(own, None)
                break
            seen.add(current)
            current = parents.get(current)
    return parents


def coordinator_id(members: list[dict], party_id: str, parents: dict[str, str]) -> str:
    """The party's lead: the chat the party is named after, a lead the viewer names, or the member
    others report to."""
    ids = [actor_id(actor) for actor in members]
    if party_id in ids:
        return party_id
    for actor in members:
        party = actor.get("party")
        if isinstance(party, dict) and str(party.get("coordinatorId") or "") in ids:
            return str(party["coordinatorId"])
    children: dict[str, int] = {}
    for parent in parents.values():
        children[parent] = children.get(parent, 0) + 1
    roots = [own for own in ids if own not in parents and children.get(own)]
    return max(roots, key=lambda own: children[own]) if roots else ""


def stable_order(keys: list[str], previous: list[str]) -> list[str]:
    """Keys in the order they were first seen; newcomers go after the known ones, as given."""
    known = [key for key in previous if key in keys]
    return known + [key for key in keys if key not in known]


def party_tree(members: list[dict], party_id: str, previous: list[str] | None = None) -> list[tuple[dict, int]]:
    """(member, depth) with the coordinator first and every member under the one it reports to.
    Siblings keep the order they were first seen in, so rows never jump between polls."""
    parents = parent_map(members)
    lead = coordinator_id(members, party_id, parents)
    by_id = {actor_id(actor): actor for actor in members}
    order = stable_order([actor_id(actor) for actor in members], previous or [])
    children: dict[str, list[str]] = {}
    roots: list[str] = []
    for own in order:
        if own in parents:
            children.setdefault(parents[own], []).append(own)
        elif own != lead:
            roots.append(own)
    result: list[tuple[dict, int]] = []

    def walk(own: str, depth: int) -> None:
        result.append((by_id[own], depth))
        for child in children.get(own, []):
            walk(child, depth + 1)

    if lead:
        walk(lead, 0)
    for own in roots:
        walk(own, 1 if lead else 0)
    return result


def party_name(party_id: str, members: list[dict], catalog: dict[str, dict]) -> str:
    """The party's title: the chat or workspace name from the catalog, else its lead's."""
    source = catalog.get(party_id) or {}
    if source.get("name"):
        return " ".join(str(source["name"]).split())
    for actor in members:
        party = actor.get("party")
        if isinstance(party, dict) and party.get("name"):
            return " ".join(str(party["name"]).split())
    lead = next((actor for actor in members if actor_id(actor) == party_id), None)
    lead = lead or next((actor for actor in members if source_of(actor) == "claude" and not actor.get("childOf")), None)
    if lead and lead.get("name"):
        return " ".join(str(lead["name"]).split())
    workflow = next((str(actor.get("workflowName")) for actor in members if actor.get("workflowName")), "")
    if workflow:
        return workflow
    if party_id.startswith("orca:") and members:
        return f"Orca · {project_for(members[0])[1]}"
    return display_name(members[0]) if members else party_id


# The roster ------------------------------------------------------------------------------------
class Row(NamedTuple):
    """One line of the roster. ``key`` is unique and stable across polls: the actor id for an agent,
    'section:<name>', 'party:<id>', 'watch:<id>', 'result:<id>', or 'note:<section>'."""
    kind: str  # section, party, agent, watch, result, note
    key: str
    title: str = ""
    depth: int = 0
    actor: dict | None = None
    party: str = ""
    section: str = ""
    count: int = 0
    open: bool = True
    line: Line | None = None
    right: str = ""
    meta: str = ""
    context: bool = False  # Shown only to hold its party together; it is not itself working.
    klass: str = ""  # needs, failed, working, or done, for an agent row.


class Counts(NamedTuple):
    needs: int = 0
    working: int = 0
    failed: int = 0
    done_today: int = 0


class RosterMemory:
    """Orders first seen, kept between polls so parties and members never jump around."""

    def __init__(self) -> None:
        self.parties: list[str] = []
        self.members: dict[str, list[str]] = {}

    def parties_in(self, keys: list[str], urgency: dict[str, int]) -> list[str]:
        known = stable_order(keys, self.parties)
        self.parties = (known + [key for key in self.parties if key not in known])[-400:]
        return sorted(known, key=lambda key: urgency.get(key, 9))  # Stable: failures rise, order holds.

    def members_of(self, party: str, ids: list[str]) -> list[str]:
        order = stable_order(ids, self.members.get(party, []))
        self.members[party] = order[-200:]
        if len(self.members) > 400:
            self.members.pop(next(iter(self.members)))
        return order


def _matches(terms: list[str], *fields: str) -> bool:
    haystack = " ".join(field.lower() for field in fields if field)
    return all(term in haystack for term in terms)


def agent_row(actor: dict, klass: str, *, depth: int = 0, section: str, now_ms: float, aliases: dict | None,
              party: str = "", meta: str = "", context: bool = False) -> Row:
    right = " · ".join(part for part in (progress_label(actor), age_short(actor.get("updatedAt"), now_ms)) if part)
    return Row("agent", actor_id(actor), display_name(actor, aliases), depth, actor, party, section,
               line=row_line(actor, klass), right=right, meta=meta, context=context, klass=klass)


def build_roster(actors: list[dict], *, now_ms: float | None = None, catalog: list[dict] | tuple = (),
                 watched: list[str] | tuple = (), aliases: dict | None = None, memory: RosterMemory | None = None,
                 done_open: bool = False, query: str = "", results: list[dict] | None = None) -> tuple[list[Row], Counts]:
    """The roster's rows: Needs you (the ask in amber), Working grouped by party (lead first, members
    indented), Watching, Done today (folded unless opened), and chat search results after Enter."""
    now = now_ms if now_ms is not None else time.time() * 1000
    memory = memory or RosterMemory()
    by_catalog = {str(source.get("id")): source for source in catalog if isinstance(source, dict) and source.get("id")}
    agents = [actor for actor in actors if is_agent(actor)]
    seen: set[str] = set()
    unique = []
    for actor in agents:
        if actor_id(actor) not in seen:
            seen.add(actor_id(actor))
            unique.append(actor)
    classes = {actor_id(actor): actor_class(actor) for actor in unique}
    parties: dict[str, list[dict]] = {}
    for actor in unique:
        parties.setdefault(party_scope(actor), []).append(actor)
    names = {party: party_name(party, members, by_catalog) for party, members in parties.items()}
    terms = query.lower().split()

    def wanted(actor: dict) -> bool:
        if not terms:
            return True
        line = row_line(actor, classes[actor_id(actor)]).text
        return _matches(terms, display_name(actor, aliases), names.get(party_scope(actor), ""),
                        project_name(actor), line, SOURCE_NAMES.get(source_of(actor), ""))

    rows: list[Row] = []
    shown: set[str] = set()

    # Needs you: every ask, the longest waiting first.
    needs = sorted((actor for actor in unique if classes[actor_id(actor)] == NEEDS),
                   key=lambda actor: (stamp_ms((ask_of(actor) or {}).get("at")) or updated_ms(actor), actor_id(actor)))
    needs_rows = [agent_row(actor, NEEDS, section="needs", now_ms=now, aliases=aliases,
                            party=party_scope(actor), meta=names.get(party_scope(actor), ""))
                  for actor in needs if wanted(actor)]
    if needs_rows:
        rows.append(Row("section", "section:needs", "Needs you", section="needs", count=len(needs_rows)))
        rows.extend(needs_rows)
    shown.update(actor_id(actor) for actor in needs)

    # Working, grouped by party.
    hot = {WORKING, FAILED}
    working_total = sum(classes[own] in hot for own in classes)
    urgency = {party: 0 if any(classes[actor_id(actor)] == FAILED for actor in members) else 1
               for party, members in parties.items()}
    working_parties = [party for party, members in parties.items()
                       if any(classes[actor_id(actor)] in hot for actor in members)]
    working_rows: list[Row] = []
    counted = 0
    for party in memory.parties_in(working_parties, urgency):
        members = parties[party]
        order = memory.members_of(party, [actor_id(actor) for actor in members])
        tree = party_tree(members, party, order)
        parents = parent_map(members)
        lead = coordinator_id(members, party, parents)
        keep: set[str] = set()
        for actor, _depth in tree:
            own = actor_id(actor)
            if classes[own] in hot:
                keep.add(own)
                parent = parents.get(own)
                while parent:  # Keep the chain up to the lead so the tree reads correctly.
                    keep.add(parent)
                    parent = parents.get(parent)
        if lead:
            keep.add(lead)
        members_rows = []
        for actor, depth in tree:
            own = actor_id(actor)
            if own not in keep or classes[own] == NEEDS or not wanted(actor):
                continue
            context = classes[own] not in hot
            members_rows.append(agent_row(actor, classes[own], depth=depth, section="working", now_ms=now,
                                          aliases=aliases, party=party, context=context))
        if not members_rows:
            continue
        counted += sum(not row.context for row in members_rows)
        shown.update(row.key for row in members_rows)
        if len(members_rows) == 1 and members_rows[0].key in (party, lead):
            # A chat working on its own needs no banner: its row already says what it is.
            working_rows.append(members_rows[0]._replace(depth=0))
            continue
        listed = by_catalog.get(party) or {}
        project = project_name(listed if listed.get("cwd") else next((actor for actor in members if actor.get("cwd")), {}))
        if project and project.lower() in names[party].lower():
            project = ""  # "Orca · search-service" already says where it works.
        working_rows.append(Row("party", f"party:{party}", names[party], party=party, section="working",
                                meta=project, count=len(members)))
        for row in members_rows:
            if row.key == lead and row.title == names[party]:
                # The banner already names the party after its lead; the lead's row says what it is.
                label = " · ".join(part for part in (SOURCE_NAMES.get(source_of(row.actor), ""), model_badge(row.actor))
                                   if part)
                row = row._replace(title=f"Lead · {label}" if label else "Lead")
            working_rows.append(row)
    rows.append(Row("section", "section:working", "Working", section="working",
                    count=counted if terms else working_total))
    if working_rows:
        rows.extend(working_rows)
    else:
        rows.append(Row("note", "note:working", "Nothing matches." if terms else "No goblins are working right now.",
                        section="working"))

    # Watching: watched parties with nobody working or waiting on you.
    active_parties = {party_scope(actor) for actor in unique if classes[actor_id(actor)] in (NEEDS, WORKING, FAILED)}
    watch_rows = []
    for party in watched:
        party = str(party)
        if party in active_parties or (party not in by_catalog and party not in parties):
            continue
        members = parties.get(party, [])
        source = by_catalog.get(party) or (members[0] if members else {})
        name = names.get(party) or party_name(party, members, by_catalog)
        if terms and not _matches(terms, name, project_name(source)):
            continue
        lead = next((actor for actor in members if actor_id(actor) == party), members[0] if members else None)
        stamp = max([updated_ms(source)] + [updated_ms(actor) for actor in members])
        detail = " · ".join(part for part in (project_name(source), f"active {age_label(stamp, now)}" if stamp else "")
                            if part)
        watch_rows.append(Row("watch", f"watch:{party}", name, actor=lead, party=party, section="watching",
                              line=Line("done", detail or "Watched chat"), right=age_short(stamp, now)))
        if lead:
            shown.add(actor_id(lead))
    if watch_rows:
        rows.append(Row("section", "section:watching", "Watching", section="watching", count=len(watch_rows)))
        rows.extend(watch_rows)

    # Done today, newest first, folded unless opened.
    midnight = start_of_day(now)
    done = sorted((actor for actor in unique if classes[actor_id(actor)] == DONE and actor_id(actor) not in shown
                   and updated_ms(actor) >= midnight and wanted(actor)),
                  key=lambda actor: -updated_ms(actor))
    if done:
        is_open = done_open or bool(terms)
        rows.append(Row("section", "section:done", "Done today", section="done", count=len(done), open=is_open))
        if is_open:
            rows.extend(agent_row(actor, DONE, section="done", now_ms=now, aliases=aliases, party=party_scope(actor),
                                  meta=names.get(party_scope(actor), ""))
                        for actor in done[:DONE_LIMIT])
            if len(done) > DONE_LIMIT:
                rows.append(Row("note", "note:done", f"{len(done) - DONE_LIMIT} more finished earlier today.",
                                section="done"))

    # Older chats from the catalog, after Enter in "Find a chat…".
    if results is not None:
        rows.append(Row("section", "section:results", "Older chats", section="results", count=len(results)))
        for source in results:
            party = str(source.get("id") or "")
            stamp = source.get("updatedAt")
            meta = " · ".join(part for part in (project_name(source), SOURCE_NAMES.get(source_of(source), "")) if part)
            rows.append(Row("result", f"result:{party}", clip(source.get("name") or party, 120), party=party,
                            section="results", line=Line("done", meta or "Chat"), right=age_short(stamp, now),
                            meta=source.get("name") or ""))
        if not results:
            rows.append(Row("note", "note:results", "No chat matches those words.", section="results"))

    counts = Counts(needs=len(needs), working=working_total,
                    failed=sum(klass == FAILED for klass in classes.values()),
                    done_today=sum(classes[actor_id(actor)] == DONE and updated_ms(actor) >= midnight for actor in unique))
    return rows, counts


def selectable(rows: list[Row]) -> list[Row]:
    """Rows that can hold the selection: agents, watched parties, and search results."""
    return [row for row in rows if row.kind in ("agent", "watch", "result")]


def default_selection(rows: list[Row]) -> str:
    """With nothing chosen: the first goblin that needs you, else the first one working, else none."""
    for section in ("needs", "working"):
        row = next((row for row in rows if row.kind == "agent" and row.section == section and not row.context), None)
        if row:
            return row.key
    return ""


def move_selection(rows: list[Row], current: str, step: int) -> str:
    """Up/Down through the selectable rows; from nothing, Down picks the first."""
    keys = [row.key for row in selectable(rows)]
    if not keys:
        return current
    if current not in keys:
        return keys[0] if step > 0 else keys[-1]
    return keys[max(0, min(len(keys) - 1, keys.index(current) + step))]


# The goblin strip ------------------------------------------------------------------------------
class StripItem(NamedTuple):
    actor: dict
    party: str
    klass: str
    gap: bool  # The first goblin of a new party gets a small gap before it.


def strip_items(actors: list[dict], *, now_ms: float | None = None, limit: int = STRIP_LIMIT,
                memory: RosterMemory | None = None) -> tuple[list[StripItem], int, int]:
    """The strip's goblins grouped by party (parties that need you first, then failures, then work,
    then today's finished goblins, faded), at most ``limit``. Returns (items, hidden, needs)."""
    now = now_ms if now_ms is not None else time.time() * 1000
    midnight = start_of_day(now)
    memory = memory or RosterMemory()
    agents = [actor for actor in actors if is_agent(actor)]
    classes = {actor_id(actor): actor_class(actor) for actor in agents}
    shown = [actor for actor in agents
             if classes[actor_id(actor)] != DONE or updated_ms(actor) >= midnight]
    parties: dict[str, list[dict]] = {}
    for actor in shown:
        parties.setdefault(party_scope(actor), []).append(actor)
    rank = {NEEDS: 0, FAILED: 1, WORKING: 2, DONE: 3}
    urgency = {party: min(rank[classes[actor_id(actor)]] for actor in members) for party, members in parties.items()}
    ordered: list[StripItem] = []
    for party in memory.parties_in(list(parties), urgency):
        members = parties[party]
        tree = party_tree(members, party, memory.members_of(party, [actor_id(actor) for actor in members]))
        live = [actor for actor, _depth in tree if classes[actor_id(actor)] != DONE]
        finished = [actor for actor, _depth in tree if classes[actor_id(actor)] == DONE]
        for index, actor in enumerate(live + finished):
            ordered.append(StripItem(actor, party, classes[actor_id(actor)], index == 0 and bool(ordered)))
    # Finished goblins only fill seats nobody busy needs.
    busy = [item for item in ordered if item.klass != DONE]
    done = [item for item in ordered if item.klass == DONE]
    keep = {id(item) for item in (busy + done)[:limit]}
    items = [item for item in ordered if id(item) in keep]
    # A gap marks a new party among the goblins actually shown.
    regapped = [item._replace(gap=index > 0 and item.party != items[index - 1].party) for index, item in enumerate(items)]
    return regapped, len(ordered) - len(items), sum(item.klass == NEEDS for item in ordered)


def strip_tooltip(actor: dict, aliases: dict | None = None) -> str:
    """Name, then what it is doing or asking, for the strip's hover tip."""
    klass = actor_class(actor)
    line = row_line(actor, klass)
    return f"{display_name(actor, aliases)}\n{clip(line.text, 160)}" if line.text else display_name(actor, aliases)


# The detail pane -------------------------------------------------------------------------------
DETAIL_ORDER = ("ask", "waiting", "mission", "plan", "now", "said", "trail", "files", "screen")
TRAIL_KINDS = {"command", "edit", "write", "read", "search", "web", "agent", "tool", "message", "ask", "error"}
ACTIVITY_TRAIL = {"command": "command", "file": "edit", "research": "web", "tool": "tool", "update": "message"}


def trail_from_activities(activities: list) -> list[dict]:
    """A trail (newest first) from the public steps an older viewer sends with every actor."""
    trail = []
    for index, item in enumerate(activities or []):
        if not isinstance(item, dict) or (item.get("kind") == "update" and item.get("title") == "Status"):
            continue
        kind = ACTIVITY_TRAIL.get(str(item.get("kind") or ""), "tool")
        description = " ".join(str(item.get("description") or "").split())
        if kind == "message":
            title, detail = clip(description or item.get("title") or "Said something", 140), description
        else:
            title = str(item.get("title") or "A step")
            detail = str(item.get("detail") or "") or description
        status = "running" if item.get("status") == "inProgress" else "failed" if failed_step(item) else "ok"
        trail.append({"id": str(item.get("id") or f"step-{index}"), "at": item.get("at") or item.get("turnStartedAt"),
                      "kind": kind, "title": title, "detail": detail, "status": status,
                      "exitCode": item.get("exitCode"), "durationMs": item.get("durationMs"),
                      "output": str(item.get("output") or "")})
    return list(reversed(trail))[:60]


def detail_from_actor(actor: dict) -> dict:
    """What can be shown when the viewer has no /api/agent: the actor's own public steps."""
    activities = actor.get("activities") or []
    said = next((item for item in reversed(activities)
                 if isinstance(item, dict) and item.get("kind") == "update" and item.get("title") != "Status"
                 and str(item.get("description") or "").strip()), None)
    return {
        "agent": actor, "mission": None, "plan": None, "now": now_of(actor),
        "said": {"text": str(said["description"]), "at": said.get("at")} if said else None,
        "trail": trail_from_activities(activities), "files": [], "screen": None, "fallback": True,
    }


def merged_agent(actor: dict | None, detail: dict | None) -> dict:
    """The detail's agent, with anything it left out taken from the scene's copy of the actor."""
    base = dict(actor or {})
    agent = (detail or {}).get("agent")
    if isinstance(agent, dict):
        base.update({key: value for key, value in agent.items() if value is not None or key in ("ask", "now", "waitingOn", "progress")})
    return base


def plan_steps(plan) -> list[dict]:
    steps = (plan or {}).get("steps") if isinstance(plan, dict) else None
    return [step for step in steps or [] if isinstance(step, dict) and str(step.get("text") or "").strip()]


def plan_counts(plan) -> tuple[int, int]:
    steps = plan_steps(plan)
    return sum(step.get("status") == "done" for step in steps), len(steps)


def detail_sections(detail: dict | None, agent: dict | None = None) -> list[str]:
    """Which sections the detail pane shows, in order; each one appears only when it has something."""
    detail = detail or {}
    agent = agent if agent is not None else (detail.get("agent") or {})
    present = {
        "ask": bool(ask_of(agent)),
        "waiting": bool(waiting_of(agent)),
        "mission": bool(str(((detail.get("mission") or {}) if isinstance(detail.get("mission"), dict) else {}).get("text") or "").strip()),
        "plan": bool(plan_steps(detail.get("plan"))),
        "now": bool(now_of({"now": detail.get("now")}) or now_of(agent)),
        "said": bool(str(((detail.get("said") or {}) if isinstance(detail.get("said"), dict) else {}).get("text") or "").strip()),
        "trail": bool(detail.get("trail")),
        "files": bool(detail.get("files")),
        "screen": bool(((detail.get("screen") or {}) if isinstance(detail.get("screen"), dict) else {}).get("lines")),
    }
    return [name for name in DETAIL_ORDER if present[name]]


def trail_result(item: dict, now_ms: float | None = None) -> list[tuple[str, str]]:
    """The right side of a trail row as (text, tone) parts: 'running 12s', 'exit 1 · 2.3s', '+42 −7'."""
    now = now_ms if now_ms is not None else time.time() * 1000
    status = str(item.get("status") or "")
    if status == "running":
        started = stamp_ms(item.get("at"))
        return [(f"running {elapsed(now - started)}" if started else "running", "lively")]
    parts: list[tuple[str, str]] = []
    added, removed = item.get("added"), item.get("removed")
    if isinstance(added, int) or isinstance(removed, int):
        parts.append((f"+{int(added or 0)}", "lively"))
        parts.append((f"−{int(removed or 0)}", "coral"))
        return parts
    exit_code = item.get("exitCode")
    took = duration(item.get("durationMs")) if item.get("durationMs") is not None else ""
    failed = status == "failed" or exit_code not in (None, 0)
    words = [f"exit {exit_code}"] if exit_code is not None else []
    if took:
        words.append(took)
    if not words and failed:
        words.append("failed")
    paths = item.get("paths")
    if not words and isinstance(paths, list) and len(paths) > 1:
        words.append(f"{len(paths)} files")
    return [(" · ".join(words), "coral" if failed else "muted")] if words else []


def screen_tail(screen, limit: int = 20) -> list[str]:
    lines = (screen or {}).get("lines") if isinstance(screen, dict) else None
    lines = [str(line).rstrip() for line in lines or []]
    while lines and not lines[-1]:
        lines.pop()
    return lines[-limit:]


def status_chip(agent: dict, now_ms: float | None = None) -> tuple[str, str]:
    """The status chip beside a goblin's name, with how long it has been so: ('Working · 4m 05s', tone)."""
    now = now_ms if now_ms is not None else time.time() * 1000
    klass = actor_class(agent)
    if klass == NEEDS:
        ask = ask_of(agent) or {}
        since = stamp_ms(ask.get("at"))
        return (f"Needs you · {elapsed(now - since)}" if since else "Needs you"), "ask"
    if klass == FAILED:
        return "Failed", "failed"
    if klass == WORKING:
        waiting = waiting_of(agent)
        current = now_of(agent)
        since = stamp_ms((current or waiting or {}).get("startedAt") or (waiting or {}).get("at"))
        word = "Waiting on coordinator" if waiting else "Working"
        return (f"{word} · {elapsed(now - since)}" if since else word), "waiting" if waiting else "now"
    stamp = updated_ms(agent)
    return (f"Done · {age_label(stamp, now)}" if stamp else "Done"), "done"


# Sources, search, and settings -----------------------------------------------------------------
class SourceChip(NamedTuple):
    key: str
    label: str
    glyph: str
    tone: str  # ok, starting, off, broken, offer
    action: str  # "" or the app method that fixes it: reconnect_codex, connect_claude
    tip: str


SOURCE_LABELS = (("codex", "Codex"), ("claude", "Claude"), ("orca", "Orca"), ("extensions", "Feeds"))


def source_chips(sources: dict) -> list[SourceChip]:
    """One chip per feed the viewer reports: ✓ connected, … starting, – not in use, ✕ needs a fix
    (Codex: click to reconnect). Claude Code is optional: unconnected reads as an offer, not an error."""
    chips: list[SourceChip] = []
    for key, name in SOURCE_LABELS:
        source = (sources or {}).get(key)
        if not isinstance(source, dict):
            continue  # A viewer that does not report this feed says nothing about it.
        state = str(source.get("state") or "")
        detail = str(source.get("detail") or "")
        action = ""
        if state == "ok":
            glyph, tone = "✓", "ok"
        elif state == "starting":
            glyph, tone = "…", "starting"
        elif key == "claude" and state == "not-connected":
            glyph, tone = "–", "off"
            if source.get("canConnect"):
                glyph, tone, action = "+", "offer", "connect_claude"
                detail = f"{detail} Click to connect it.".strip()
        elif state in ("none", "not-installed") or (key == "orca" and state == "unavailable"):
            glyph, tone = "–", "off"
        else:
            glyph, tone = "✕", "broken"
            if key == "codex":
                action, detail = "reconnect_codex", f"{detail} Click to reconnect now.".strip()
        if key == "codex" and state == "ok":
            detail = f"{detail} Replies from this window, the browser, or a phone are available.".strip()
        elif state == "ok" and source.get("replies") is False:
            detail = f"{detail} Watch-only here: reply in the app itself.".strip()
        chips.append(SourceChip(key, name, glyph, tone, action, detail))
    return chips


def search_sources(catalog: list[dict], query: str, limit: int = 60) -> list[dict]:
    """Match every word against title, project, and path; title matches come first."""
    terms = query.lower().split()
    matches: list[tuple[int, int, dict]] = []
    for index, source in enumerate(catalog):
        if not isinstance(source, dict) or str(source.get("id") or "") in NOT_AGENTS:
            continue
        name = str(source.get("name") or "").lower()
        haystack = f"{name} {project_for(source)[1].lower()} {str(source.get('cwd') or '').lower()} {source.get('source') or ''}"
        if all(term in haystack for term in terms):
            matches.append((0 if terms and all(term in name for term in terms) else 1, index, source))
    return [source for _rank, _index, source in sorted(matches, key=lambda item: item[:2])][:limit]


def coverage_note(coverage: dict | None) -> str:
    """A short, honest gap in the all-parties feed, or '' when the server checked everything."""
    if not coverage or coverage.get("complete", True):
        return ""
    pending = int(coverage.get("codexPending") or 0)
    if pending:
        return f"Checking {pending} {'chat' if pending == 1 else 'chats'}"
    if int(coverage.get("activeTotal") or 0) > int(coverage.get("activeShown") or 0):
        return "Too many active agents to list them all"
    if not coverage.get("codexAvailable", True):
        return "Codex is unavailable"
    if coverage.get("codexFailed"):
        return "Some chats could not be read"
    if not coverage.get("codexListComplete", True):
        return "The chat list was cut short"
    if not coverage.get("orcaAvailable", True):
        return "Orca is unavailable"
    return "Partial feed"


# Settings keys from earlier widgets (goblin line, launchpad, streams, notes) that nothing reads now.
RETIRED_SETTINGS = frozenset({
    "x", "y", "columns", "rotating", "hiddenIds", "threadId", "sourceName", "displayMode", "dockX", "dockY",
    "partyView", "hiddenFrom", "partyMode", "homeView", "focusedStreamId", "streams", "dismissedStreams",
    "placements", "partingNotes", "retiredMarkers",
})
WINDOW_MIN = (720, 460)
WINDOW_DEFAULT = (1000, 660)


def _int(value, low: int = -100_000, high: int = 100_000) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = int(value)
    return number if low <= number <= high else None


def read_settings(saved) -> dict:
    """The window's settings from goblins.json; each value is checked on its own, so one bad value
    (or a file from an older widget) never drops the rest."""
    saved = saved if isinstance(saved, dict) else {}
    settings = {
        "window": None, "strip": None, "showStrip": False, "surface": "window", "keepOnTop": False,
        "reducedMotion": None, "scaleWithDisplay": True, "selected": "", "doneOpen": False, "welcomed": False,
        "aliases": {}, "paletteOffset": 0,
    }
    window = saved.get("window")
    if isinstance(window, dict):
        values = [_int(window.get(key)) for key in ("x", "y")] + [_int(window.get(key), 100, 20_000) for key in ("width", "height")]
        if all(value is not None for value in values):
            settings["window"] = {"x": values[0], "y": values[1], "width": values[2], "height": values[3],
                                  "zoomed": window.get("zoomed") is True}
    strip = saved.get("strip")
    if isinstance(strip, dict) and _int(strip.get("right")) is not None and _int(strip.get("bottom")) is not None:
        # The strip's bottom-right corner: it grows to the left as goblins join.
        settings["strip"] = {"right": _int(strip["right"]), "bottom": _int(strip["bottom"])}
    for key in ("showStrip", "keepOnTop", "doneOpen", "welcomed", "scaleWithDisplay"):
        if isinstance(saved.get(key), bool):
            settings[key] = saved[key]
    if isinstance(saved.get("reducedMotion"), bool):
        settings["reducedMotion"] = saved["reducedMotion"]
    surface = saved.get("surface")
    if surface in ("window", "strip"):
        settings["surface"] = surface
    elif saved.get("displayMode") == "hidden":
        settings["surface"] = "strip"  # The old widget was collapsed to its tab.
    if isinstance(saved.get("selected"), str):
        settings["selected"] = saved["selected"][:200]
    aliases = saved.get("aliases")
    if isinstance(aliases, dict):
        settings["aliases"] = {str(key)[:200]: value.strip()[:40] for key, value in aliases.items()
                               if str(key) and isinstance(value, str) and value.strip()}
    offset = _int(saved.get("paletteOffset"), 0, 10_000)
    if offset is not None:
        settings["paletteOffset"] = offset
    return settings


def settings_to_save(previous, settings: dict) -> dict:
    """The file to write: our settings over whatever else the file held (a newer widget's keys
    survive), without keys of retired views."""
    base = {key: value for key, value in (previous if isinstance(previous, dict) else {}).items()
            if key not in RETIRED_SETTINGS}
    base.update(settings)
    return base


def clamp_window(window: dict | None, areas: list[tuple[int, int, int, int]], scale: float = 1.0) -> dict:
    """A saved window that still fits on a display, or the default size centred on the first one."""
    min_w, min_h = (round(value * scale) for value in WINDOW_MIN)
    def_w, def_h = (round(value * scale) for value in WINDOW_DEFAULT)
    if window and areas:
        x, y, w, h = window["x"], window["y"], max(min_w, window["width"]), max(min_h, window["height"])
        for left, top, right, bottom in areas:
            # The title bar (its top 40 pixels, 160 wide) must be on some display to grab it.
            if min(x + w, right) - max(x, left) >= 160 and top <= y <= bottom - 40:
                return {**window, "width": min(w, right - left), "height": min(h, bottom - top)}
    left, top, right, bottom = areas[0] if areas else (0, 0, def_w + 80, def_h + 80)
    w, h = min(def_w, right - left - 40), min(def_h, bottom - top - 40)
    return {"x": left + (right - left - w) // 2, "y": top + (bottom - top - h) // 2, "width": w, "height": h,
            "zoomed": False}


def reachable(spot: tuple[int, int], size: tuple[int, int], areas: list[tuple[int, int, int, int]],
              minimum: tuple[int, int] = (40, 24)) -> bool:
    """True when a window at ``spot`` of ``size`` shows enough of itself on some display to be grabbed.
    Displays may sit at negative coordinates. With no display list, a saved spot is trusted."""
    if not areas:
        return True
    x1, y1, x2, y2 = spot[0], spot[1], spot[0] + size[0], spot[1] + size[1]
    return any(min(x2, right) - max(x1, left) >= minimum[0] and min(y2, bottom) - max(y1, top) >= minimum[1]
               for left, top, right, bottom in areas)
