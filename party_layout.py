"""Choose a thread party and tile its most relevant observable streams."""

from __future__ import annotations

from dataclasses import dataclass
import re
import time

from goblin_motion import member_status
from stream_windows import workflow_for


@dataclass(frozen=True)
class LayoutPlan:
    positions: dict[str, tuple[int, int]]
    hidden: tuple[str, ...]
    order: tuple[str, ...]
    capacity: int
    loop_groups: frozenset[str]
    slots: tuple[tuple[int, int], ...] = ()


@dataclass(frozen=True)
class PartyCard:
    """One launchpad row: a chat or workspace and the agents seen working in it."""
    id: str
    name: str
    project: str
    source: str
    members: tuple[dict, ...]
    rank: int
    needs: int
    failed: int
    working: int
    updated_ms: float
    agent_count: int

    @property
    def active(self) -> bool:
        return self.rank <= 4

    @property
    def attention(self) -> bool:
        return self.rank <= 2


def party_scope(actor: dict) -> str:
    """Members belong to their parent chat or workspace party."""
    return str(actor.get("parentThreadId") or actor.get("id") or "")


def project_for(source: dict) -> tuple[str, str]:
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


def phase_for_event(event: dict) -> str:
    text = " ".join(str(event.get(key) or "") for key in ("title", "description", "detail")).lower()
    if re.search(r"\b(review|test|verify|validat|check|audit)\w*\b", text):
        return "CHECK"
    if event.get("kind") == "file" or re.search(r"\b(build|edit|patch|implement|fix|write|creat|install)\w*\b", text):
        return "BUILD"
    if event.get("kind") == "research" or re.search(r"\b(search|research|investigat|explor|browse|read)\w*\b", text):
        return "EXPLORE"
    if re.search(r"\b(plan|think|decid|design|map out)\w*\b", text):
        return "PLAN"
    return ""


def phase_for(actor: dict) -> str:
    activities = actor.get("activities") or []
    latest = activities[-1] if activities else {}
    turns = actor.get("turnStates") or []
    if actor.get("needsInput") or str(actor.get("status") or "").lower() == "waiting" or (turns and turns[-1].get("questions")):
        return "WAIT"
    if str(actor.get("status") or "").lower() == "failed" or latest.get("status") == "failed" or latest.get("exitCode") not in (None, 0):
        return "REPAIR"
    for event in reversed(activities):
        phase = phase_for_event(event)
        if phase:
            return phase
    return "DONE" if str(actor.get("status") or "").lower() in ("completed", "done") else "NO STEP"


def observed_loop(actors: list[dict]) -> bool:
    """Only mark a loop when saved public events show a return to an earlier phase."""
    for actor in actors:
        phases: list[str] = []
        for event in actor.get("activities") or []:
            phase = phase_for_event(event)
            if phase and (not phases or phases[-1] != phase):
                phases.append(phase)
        if any(phases[index] == phases[index + 2] != phases[index + 1]
               for index in range(len(phases) - 2)):
            return True
    return False


def priority_for(actor: dict, now_ms: float) -> tuple[int, float]:
    latest = (actor.get("activities") or [{}])[-1]
    turns = actor.get("turnStates") or []
    state = str(actor.get("status") or "").lower()
    turn_state = str(turns[-1].get("status") or "").lower() if turns else ""
    if actor.get("needsInput") or state == "waiting" or (turns and turns[-1].get("questions")):
        importance = 5
    elif state == "failed" or latest.get("status") == "failed" or latest.get("exitCode") not in (None, 0):
        importance = 4
    elif state in ("working", "running", "inprogress", "active") or turn_state in ("inprogress", "working"):
        importance = 3
    elif state in ("completed", "done") or turn_state == "completed":
        importance = 1
    else:
        importance = 2
    try:
        updated = float(actor.get("updatedAt") or 0)
        if updated and updated < 1e12:
            updated *= 1000
    except (TypeError, ValueError):
        updated = 0
    return importance, min(updated, now_ms)


def loop_groups(actors: list[dict]) -> frozenset[str]:
    """The workflow groups whose public events show a return to an earlier phase."""
    groups: dict[str, list[dict]] = {}
    for actor in actors:
        groups.setdefault(workflow_for(actor)[0], []).append(actor)
    return frozenset(key for key, members in groups.items() if observed_loop(members))


def tile_plan(actors: list[dict], area: tuple[int, int, int, int], width: int, height: int,
              focus_id: str = "", now_ms: float | None = None, gap: int = 12) -> LayoutPlan:
    """Select by urgency, keep workflows together, and never place tiles atop one another."""
    left, top, right, bottom = area
    columns = max(1, (right - left - gap) // (width + gap))
    rows = max(1, (bottom - top - gap) // (height + gap))
    capacity = columns * rows
    clock = now_ms if now_ms is not None else time.time() * 1000
    unique = {str(actor["id"]): actor for actor in actors if actor.get("id")}
    groups: dict[str, list[dict]] = {}
    for actor in unique.values():
        groups.setdefault(workflow_for(actor)[0], []).append(actor)
    group_keys = sorted(groups, key=lambda key: max(priority_for(actor, clock) for actor in groups[key]), reverse=True)
    ranked = sorted(unique.values(), key=lambda actor: priority_for(actor, clock), reverse=True)
    selected: dict[str, dict] = {}
    # A request for input or a failed step outranks workflow diversity.
    for actor in ranked:
        if priority_for(actor, clock)[0] < 4 or len(selected) >= capacity:
            break
        selected[str(actor["id"])] = actor
    # Give every active workflow a representative before filling remaining seats.
    for key in group_keys:
        if len(selected) >= capacity:
            break
        if any(str(actor["id"]) in selected for actor in groups[key]):
            continue
        actor = max(groups[key], key=lambda item: priority_for(item, clock))
        selected[str(actor["id"])] = actor
    for actor in ranked:
        if len(selected) >= capacity:
            break
        selected[str(actor["id"])] = actor
    if focus_id in unique and focus_id not in selected:
        if len(selected) >= capacity:
            victim = min(selected, key=lambda actor_id: priority_for(selected[actor_id], clock))
            del selected[victim]
        selected[focus_id] = unique[focus_id]
    phase_order = {"PLAN": 0, "EXPLORE": 1, "BUILD": 2, "CHECK": 3, "WAIT": 4, "REPAIR": 5, "DONE": 6}
    ordered = [actor for key in group_keys for actor in sorted(
        (item for item in groups[key] if str(item["id"]) in selected),
        key=lambda item: (0 if priority_for(item, clock)[0] >= 4 else 1,
                          0 if not item.get("parentThreadId") else 1,
                          phase_order.get(phase_for(item), 7),
                          -priority_for(item, clock)[1]))]
    total_width = columns * width + (columns - 1) * gap
    total_height = rows * height + (rows - 1) * gap
    start_x = left + max(gap, (right - left - total_width) // 2)
    start_y = top + max(gap, (bottom - top - total_height) // 2)
    positions = {str(actor["id"]): (start_x + index % columns * (width + gap),
                                    start_y + index // columns * (height + gap))
                 for index, actor in enumerate(ordered)}
    loops = loop_groups(list(unique.values()))
    slots =tuple((start_x + index % columns * (width + gap), start_y + index // columns * (height + gap))
                  for index in range(capacity))
    return LayoutPlan(positions, tuple(actor_id for actor_id in unique if actor_id not in positions),
                      tuple(positions), capacity, loops, slots)


def _overlaps(first: tuple[int, int], second: tuple[int, int], width: int, height: int) -> bool:
    return abs(first[0] - second[0]) < width and abs(first[1] - second[1]) < height


def reachable(spot: tuple[int, int], grip: tuple[int, int, int, int],
              areas: list[tuple[int, int, int, int]], minimum: tuple[int, int] = (80, 24)) -> bool:
    """True when a window at ``spot`` shows enough of its ``grip`` (a box relative to the window,
    such as its header) on some display to be seen and dragged. Displays may sit at negative
    coordinates. With no display list, a saved spot is trusted rather than thrown away."""
    if not areas:
        return True
    x1, y1, x2, y2 = spot[0] + grip[0], spot[1] + grip[1], spot[0] + grip[2], spot[1] + grip[3]
    return any(min(x2, right) - max(x1, left) >= minimum[0] and min(y2, bottom) - max(y1, top) >= minimum[1]
               for left, top, right, bottom in areas)


def stable_layout(plan: LayoutPlan, shown: dict[str, tuple[int, int]],
                  remembered: dict[str, tuple[int, int]], width: int, height: int,
                  pinned: dict[str, tuple[int, int]] | None = None) -> dict[str, tuple[int, int]]:
    """Place the plan's members without moving windows a person can already see.

    Visible windows stay put, and so do ``pinned`` windows the person placed by hand (on any
    display; they are outside the plan and never compete for its tiles). A member that was
    placed before returns to that spot if it is still free. Newcomers take a free grid slot;
    when dragged windows cover every slot, they try the spots flush beside those windows inside
    the grid. Only when nothing is free do they share the slot that the fewest windows cover.
    """
    result: dict[str, tuple[int, int]] = dict(pinned or {})
    for actor_id in plan.order:
        if actor_id in shown and actor_id not in result:
            result[actor_id] = shown[actor_id]

    def covering(spot: tuple[int, int]) -> int:
        return sum(_overlaps(spot, other, width, height) for other in result.values())

    def free(spot: tuple[int, int]) -> bool:
        return not covering(spot)

    slots = plan.slots or tuple(plan.positions.values())
    if not slots or not plan.order:
        return result
    low_x, high_x = min(x for x, _ in slots), max(x for x, _ in slots)
    low_y, high_y = min(y for _, y in slots), max(y for _, y in slots)

    def candidates():
        yield from slots
        for x, y in list(result.values()):
            for spot in ((x + width, y), (x - width, y), (x, y + height), (x, y - height)):
                if low_x <= spot[0] <= high_x and low_y <= spot[1] <= high_y:
                    yield spot

    for actor_id in plan.order:
        if actor_id not in result and actor_id in remembered and free(remembered[actor_id]):
            result[actor_id] = remembered[actor_id]
    for actor_id in plan.order:
        if actor_id not in result:
            spot = next((spot for spot in candidates() if free(spot)), None)
            result[actor_id] = spot if spot is not None else min(slots, key=covering)
    return result


def _stamp_ms(value) -> float:
    try:
        stamp = float(value or 0)
    except (TypeError, ValueError):
        return 0.0
    return stamp * 1000 if 0 < stamp < 1e12 else stamp


def age_label(updated_ms: float, now_ms: float | None = None) -> str:
    """A short, honest age: 'now', '4m', '3h', '2d', or a calendar date."""
    if not updated_ms:
        return ""
    clock = now_ms if now_ms is not None else time.time() * 1000
    minutes = max(0, int((clock - updated_ms) / 60_000))
    if minutes < 1:
        return "now"
    if minutes < 60:
        return f"{minutes}m ago"
    if minutes < 48 * 60:
        return f"{minutes // 60}h ago"
    if minutes < 14 * 24 * 60:
        return f"{minutes // (24 * 60)}d ago"
    return time.strftime("%b %d", time.localtime(updated_ms / 1000)).replace(" 0", " ")


FEED_RANKS = {"needs": 1, "waiting": 1, "failed": 2, "working": 4}


def feed_rank(actor: dict) -> int:
    """Launchpad rank from the server's feed classification; local status only when it is missing.

    Goblin animation keeps its own reading of the actor; this only decides grouping and counts.
    """
    local = member_status(actor).rank
    attention = str(actor.get("attention") or "").lower()
    if attention in FEED_RANKS:
        return FEED_RANKS[attention]
    if attention == "quiet":
        return max(local, 5)
    return local


def source_label(origin: dict, party_id: str = "") -> str:
    """ORCA, CLAUDE, or CODEX for a party or member."""
    source = str(origin.get("source") or "")
    if source == "orca" or party_id.startswith("orca:"):
        return "ORCA"
    if source == "claude" or party_id.startswith("claude:"):
        return "CLAUDE"
    if source == "extension" or party_id.startswith("ext:"):
        return "FEED"
    return "CODEX"


def _card(party_id: str, source: dict | None, members: list[dict]) -> PartyCard:
    origin = source or (members[0] if members else {"id": party_id})
    ranks = [feed_rank(member) for member in members]
    updated = max([_stamp_ms(origin.get("updatedAt"))] + [_stamp_ms(member.get("updatedAt")) for member in members])
    name = str(origin.get("name") or origin.get("nickname") or party_id)
    return PartyCard(
        id=party_id, name=name, project=project_for(origin)[1],
        source=source_label(origin, party_id),
        members=tuple(members), rank=min(ranks, default=9),
        needs=sum(rank == 1 for rank in ranks),
        failed=sum(rank == 2 for rank in ranks),
        working=sum(rank == 4 for rank in ranks),
        updated_ms=updated, agent_count=max(len(members), int(origin.get("agentCount") or 0)))


def launchpad_board(actors: list[dict], catalog: list[dict], previous_order: tuple[str, ...] | list[str] = (),
                    now_ms: float | None = None, recent_limit: int = 4,
                    recent_days: int = 7) -> tuple[list[PartyCard], list[PartyCard], int]:
    """Split parties into working-now and recently-used rows; count the rest for search.

    Working parties keep their previous order so rows do not jump on every poll; a party that
    needs input or reports a failure rises to the top.
    """
    clock = now_ms if now_ms is not None else time.time() * 1000
    sources = {str(source.get("id")): source for source in catalog if source.get("id")}
    grouped: dict[str, list[dict]] = {}
    for actor in actors:
        scope = party_scope(actor)
        if scope and scope not in ("all", "standby"):
            grouped.setdefault(scope, []).append(actor)
    cards = [_card(party_id, sources.get(party_id), members) for party_id, members in grouped.items()]
    order = {party_id: index for index, party_id in enumerate(previous_order)}
    active = sorted((card for card in cards if card.active),
                    key=lambda card: (0 if card.attention else 1, order.get(card.id, len(order)), -card.updated_ms))
    shown = {card.id for card in active}
    observed = {card.id: card for card in cards}
    cutoff = clock - recent_days * 86_400_000
    pool = sorted(catalog or [{"id": card.id, "name": card.name, "updatedAt": card.updated_ms} for card in cards],
                  key=lambda source: -_stamp_ms(source.get("updatedAt")))
    recent: list[PartyCard] = []
    for source in pool:
        party_id = str(source.get("id") or "")
        if not party_id or party_id in shown or _stamp_ms(source.get("updatedAt")) < cutoff:
            continue
        recent.append(_card(party_id, sources.get(party_id, source),
                            list(observed[party_id].members) if party_id in observed else []))
        shown.add(party_id)
        if len(recent) >= recent_limit:
            break
    older = sum(1 for source in catalog if str(source.get("id") or "") not in shown)
    return active, recent, older


def compact_active(active: list[PartyCard], limit: int = 6) -> tuple[list[PartyCard], int]:
    """Rows to draw and how many working rows wait behind 'show more'.

    Parties that need the person or failed are never folded away; quieter working rows fill the rest.
    """
    urgent = [card for card in active if card.attention]
    working = [card for card in active if not card.attention]
    room = max(0, limit - len(urgent))
    shown = set(id(card) for card in urgent + working[:room])
    return [card for card in active if id(card) in shown], max(0, len(working) - room)


def coverage_note(coverage: dict | None) -> str:
    """A short, honest gap in the all-parties feed, or '' when the server checked everything."""
    if not coverage or coverage.get("complete", True):
        return ""
    pending = int(coverage.get("codexPending") or 0)
    if pending:
        return f"CHECKING {pending} {'CHAT' if pending == 1 else 'CHATS'}"
    if int(coverage.get("activeTotal") or 0) > int(coverage.get("activeShown") or 0):
        return "TOO MANY ACTIVE TO LIST"
    if not coverage.get("codexAvailable", True):
        return "CODEX UNAVAILABLE"
    if coverage.get("codexFailed"):
        return "SOME CHATS UNREADABLE"
    if not coverage.get("codexListComplete", True):
        return "CHAT LIST CUT SHORT"
    if not coverage.get("orcaAvailable", True):
        return "ORCA UNAVAILABLE"
    return "PARTIAL FEED"


def search_sources(catalog: list[dict], query: str, limit: int = 60) -> list[dict]:
    """Match every word against title, project, and path; title matches come first."""
    terms = query.lower().split()
    matches: list[tuple[int, int, dict]] = []
    for index, source in enumerate(catalog):
        name = str(source.get("name") or "").lower()
        haystack = f"{name} {project_for(source)[1].lower()} {str(source.get('cwd') or '').lower()} {source.get('source') or ''}"
        if all(term in haystack for term in terms):
            matches.append((0 if terms and all(term in name for term in terms) else 1, index, source))
    return [source for _rank, _index, source in sorted(matches, key=lambda item: item[:2])][:limit]
