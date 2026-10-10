"""Decide when a party member has retired, and keep the short note it leaves behind.

Retirement is a claim about someone else's work, so it needs explicit evidence from the
source itself: a Codex child whose latest turn completed or was interrupted, or an Orca
member marked done. That evidence must hold, unchanged, in two good (complete) reads of the
selected party in a row; the widget need not have watched the member work first, so a
child that finished before a restart still parts. Failed and waiting members stay, and so
does anything idle without a turn. A member that drops out of the list is only marked as
having left after two complete reads, only if it was seen working, and never when much of
the party disappears at once, which looks like a feed problem rather than people leaving.
Any sign of new work revives the goblin and removes its note.

A retirement is remembered by a small marker (outcome, when, and the turn and event ids it
ended on), saved apart from the notes. Dismissing, clearing, or expiring a note therefore
never brings a retired goblin back; only public work newer than its marker does.

Notes hold only public, already-clipped facts: the last public update, file names, and
counts of steps the feed showed. Never reasoning, command text, or command output.
"""

from __future__ import annotations

import time
from collections import OrderedDict
from typing import NamedTuple

from goblin_motion import ACTIVE, event_mark, goblin_action, member_status


NOTE_LIMIT = 20
NOTE_DAYS = 14
EXCERPT_LIMIT = 180
FILE_LIMIT = 4
CONFIRMATIONS = 2
OUTCOMES = ("finished", "stopped", "left")
NOT_MEMBERS = ("", "all", "standby")
DAY_MS = 86_400_000
# Retirement markers outlive notes, so a dismissed or expired note never revives a goblin.
MARKER_LIMIT = 400
MARKER_DAYS = 90
MARKER_TURNS = 8  # Recent turn ids kept per marker; a lagging read shows one of these.
MARKER_EVENTS = 12
MARK_LENGTH = 200
# Observation memory for parties and members that are not retired; it is never saved.
PARTY_LIMIT = 24
MEMBER_LIMIT = 200


def clip(value, limit: int) -> str:
    text = " ".join(str(value or "").split())
    return text if len(text) <= limit else text[:limit - 1].rstrip() + "…"


def is_working(actor: dict) -> bool:
    return goblin_action(actor) in ("search", "build", "think")


def is_active_again(actor: dict) -> bool:
    """Working, waiting on you, or failing: positive evidence a retired member resumed."""
    return is_working(actor) or bool(actor.get("needsInput")) or member_status(actor).rank in (1, 2)


def ending(actor: dict) -> str | None:
    """'finished' or 'stopped' when the feed itself says the member's work ended, else None."""
    if actor.get("needsInput") or member_status(actor).rank in (1, 2):
        return None  # Needs you, asked a question, or failed: the goblin stays.
    state = str(actor.get("status") or "").lower()
    source = actor.get("source")
    if source == "orca":
        return "finished" if state == "done" else None
    if source not in ("codex", "claude", "extension"):  # Claude hooks and extension feeds report turns the way Codex does.
        return None
    turns = actor.get("turnStates") or []
    if not turns or turns[-1].get("questions") or state in ACTIVE or state == "systemerror":
        return None
    last = str(turns[-1].get("status") or "").lower()
    return {"completed": "finished", "interrupted": "stopped"}.get(last)


class Transition(NamedTuple):
    kind: str  # "retired" or "revived"
    actor_id: str
    outcome: str  # finished, stopped, left; empty for revived
    actor: dict
    index: int  # Where the member stood in the party, so a departing ghost keeps its place.


def work_identity(actor: dict) -> tuple[list[str], list[str]]:
    """The recent turn ids and public event ids a read shows, oldest first."""
    turns = [str(turn.get("id"))[:MARK_LENGTH] for turn in actor.get("turnStates") or []
             if isinstance(turn, dict) and turn.get("id")]
    events = [str(event_mark(item))[:MARK_LENGTH] for item in actor.get("activities") or []
              if isinstance(item, dict) and not (item.get("kind") == "update" and item.get("title") == "Status")
              and event_mark(item)]
    return turns[-MARKER_TURNS:], events[-MARKER_EVENTS:]


def newer_work(marker: dict, actor: dict) -> bool:
    """True when a read shows a turn, or failing turns an event, that the marker never saw.

    Turns decide when both sides know them, so a repeat of the retired turn never revives.
    A read that only lacks detail shows nothing new, and a lagging read shows a known id."""
    turns, events = work_identity(actor)
    if turns and marker["turns"]:
        return turns[-1] not in marker["turns"]
    if events and marker["events"]:
        return events[-1] not in marker["events"]
    return False


def clean_marker(raw, now_ms: float) -> dict | None:
    """Validate one stored retirement marker; anything malformed, unknown, or too old is dropped."""
    if not isinstance(raw, dict):
        return None
    party, actor_id, at = raw.get("party"), raw.get("id"), raw.get("at")
    if not (isinstance(party, str) and isinstance(actor_id, str) and party.strip() and actor_id.strip()):
        return None
    if party in NOT_MEMBERS or actor_id in NOT_MEMBERS or actor_id == party or actor_id.startswith("demo-"):
        return None
    if raw.get("outcome") not in OUTCOMES or isinstance(at, bool) or not isinstance(at, (int, float)):
        return None
    if not now_ms - MARKER_DAYS * DAY_MS <= at <= now_ms + DAY_MS:
        return None

    def marks(key: str, limit: int) -> list[str]:
        values = raw.get(key) if isinstance(raw.get(key), list) else []
        return [value[:MARK_LENGTH] for value in values if isinstance(value, str) and value][-limit:]
    return {"party": party[:MARK_LENGTH], "id": actor_id[:MARK_LENGTH], "outcome": raw["outcome"],
            "at": float(at), "turns": marks("turns", MARKER_TURNS), "events": marks("events", MARKER_EVENTS)}


def ending_mark(actor: dict, end: str) -> tuple:
    """What two reads must agree on: the ending, the turn it ended on, and the newest event.

    A member still adding public events between reads has not settled, even if each read
    shows a completed turn."""
    turns, events = work_identity(actor)
    return end, turns[-1] if turns else "", events[-1] if events else ""


class _Member:
    __slots__ = ("seen_working", "ending", "streak", "missing", "mass_gone", "last", "index")

    def __init__(self) -> None:
        self.seen_working = False
        self.ending: tuple | None = None  # The ending_mark the current streak agrees on.
        self.streak = 0
        self.missing = 0
        self.mass_gone = False
        self.last: dict = {}
        self.index = 0


class _Party:
    def __init__(self) -> None:
        self.members: dict[str, _Member] = {}
        self.present: list[str] = []


class RetirementTracker:
    """Per-party observation memory plus the saved retirement markers.

    Observation memory (who was seen working, confirmation streaks) is never saved, so after
    a restart an ending must again hold for two complete reads before anyone new retires.
    Markers are saved, bounded to the newest MARKER_LIMIT within MARKER_DAYS, and validated
    when loaded, so a goblin that already parted never parts twice."""

    def __init__(self) -> None:
        self.parties: OrderedDict[str, _Party] = OrderedDict()
        self.markers: dict[str, dict[str, dict]] = {}
        self.changed = False  # Markers changed since the widget last saved them.

    def load(self, raw, now_ms: float) -> None:
        for item in raw if isinstance(raw, list) else []:
            marker = clean_marker(item, now_ms)
            if marker:
                self.markers.setdefault(marker["party"], {})[marker["id"]] = marker
        self.trim(now_ms)

    def seed(self, party_id: str, actor_id: str, outcome: str, at: float | None = None) -> None:
        """Remember a member retired before markers were saved (from its note), with no ids yet.

        The first read of it adopts the turn and events it shows, since those predate the seed."""
        if actor_id not in self.markers.get(party_id, {}):
            self.markers.setdefault(party_id, {})[actor_id] = {
                "party": party_id, "id": actor_id, "outcome": outcome,
                "at": float(at if at is not None else time.time() * 1000), "turns": [], "events": []}
            self.changed = True

    def retired(self, party_id: str) -> dict[str, str]:
        return {actor_id: marker["outcome"] for actor_id, marker in self.markers.get(party_id, {}).items()}

    def trim(self, now_ms: float) -> None:
        markers = sorted((marker for party in self.markers.values() for marker in party.values()
                          if marker["at"] >= now_ms - MARKER_DAYS * DAY_MS),
                         key=lambda marker: marker["at"], reverse=True)[:MARKER_LIMIT]
        before = sum(len(party) for party in self.markers.values())
        self.markers = {}
        for marker in markers:
            self.markers.setdefault(marker["party"], {})[marker["id"]] = marker
        self.changed = self.changed or len(markers) != before

    def to_json(self) -> list[dict]:
        return [{**marker, "turns": list(marker["turns"]), "events": list(marker["events"])}
                for party in self.markers.values() for marker in party.values()]

    def _retire(self, party_id: str, actor_id: str, outcome: str, actor: dict, now_ms: float) -> None:
        turns, events = work_identity(actor)
        self.markers.setdefault(party_id, {})[actor_id] = {
            "party": party_id, "id": actor_id, "outcome": outcome, "at": float(now_ms),
            "turns": turns, "events": events}
        self.changed = True
        self.trim(now_ms)

    def _revive(self, party_id: str, actor_id: str) -> None:
        self.markers.get(party_id, {}).pop(actor_id, None)
        if party_id in self.markers and not self.markers[party_id]:
            del self.markers[party_id]
        self.changed = True

    def _party(self, party_id: str) -> _Party:
        party = self.parties.get(party_id)
        if party is None:
            party = self.parties[party_id] = _Party()
            while len(self.parties) > PARTY_LIMIT:
                self.parties.popitem(last=False)
        self.parties.move_to_end(party_id)
        return party

    def observe(self, party_id: str, root_id: str, agents: list[dict], *, complete: bool,
                now_ms: float | None = None) -> tuple[list[Transition], list[tuple[int, dict]]]:
        """Read one successful selected-party scene.

        ``complete`` is False for a scene that carried a warning. Returns transitions and the
        members to keep showing while a disappearance waits for its second complete read."""
        now = now_ms if now_ms is not None else time.time() * 1000
        party = self._party(party_id)
        transitions: list[Transition] = []
        order: list[str] = []
        for index, actor in enumerate(agents):
            actor_id = str(actor.get("id") or "")
            if actor_id in NOT_MEMBERS or actor_id in (party_id, str(root_id or "")) or actor_id.startswith("demo-"):
                continue
            order.append(actor_id)
            member = party.members.setdefault(actor_id, _Member())
            member.last, member.index, member.missing, member.mass_gone = actor, index, 0, False
            end = ending(actor)
            marker = self.markers.get(party_id, {}).get(actor_id)
            if marker is not None:
                if not marker["turns"] and not marker["events"]:
                    # A marker seeded from an old note adopts what this first read shows.
                    marker["turns"], marker["events"] = work_identity(actor)
                    self.changed = self.changed or bool(marker["turns"] or marker["events"])
                    if marker["outcome"] != "left" and not is_active_again(actor):
                        continue
                # Back in the list after leaving, visibly active again, or showing a turn the
                # marker never saw (even one that already completed): it is back. A read that
                # merely lacks detail, or repeats the retired turn, is not evidence of new work.
                fresh = marker["outcome"] != "left" and newer_work(marker, actor)
                if marker["outcome"] == "left" or (end is None and is_active_again(actor)) or fresh:
                    self._revive(party_id, actor_id)
                    member.seen_working = fresh or is_working(actor)
                    # Newer work that already ended counts as its first good read, so the
                    # goblin parts again with a fresh note after one more.
                    member.ending, member.streak = ((ending_mark(actor, end), 1) if fresh and end and complete
                                                    else (None, 0))
                    transitions.append(Transition("revived", actor_id, "", actor, index))
                continue
            if is_working(actor):
                member.seen_working = True
            if end is None:
                member.ending, member.streak = None, 0
            elif complete:
                # The source's own terminal state is the evidence; first sight counts, but only
                # an ending that holds unchanged across two complete reads retires.
                mark = ending_mark(actor, end)
                member.streak = member.streak + 1 if member.ending == mark else 1
                member.ending = mark
                if member.streak >= CONFIRMATIONS:
                    self._retire(party_id, actor_id, end, actor, now)
                    transitions.append(Transition("retired", actor_id, end, actor, index))
            # A warned scene neither confirms nor cancels an ending it still shows.

        held: list[tuple[int, dict]] = []
        listed = set(order)
        retired = self.markers.get(party_id, {})
        waiting = [(actor_id, member) for actor_id, member in party.members.items()
                   if actor_id not in listed and actor_id not in retired
                   and member.seen_working and not member.mass_gone]
        if not complete:
            for _actor_id, member in waiting:
                member.missing = 0
            self._forget(party, listed)
            return transitions, held
        vanished = [actor_id for actor_id in party.present if actor_id not in listed]
        if vanished and (not order or (len(vanished) >= 2 and len(vanished) * 2 > len(party.present))):
            # Most or all of the party vanished in one read: a feed gap, not members leaving.
            for _actor_id, member in waiting:
                member.missing, member.mass_gone = 0, True
        else:
            for actor_id, member in waiting:
                member.missing += 1
                if member.missing >= CONFIRMATIONS:
                    self._retire(party_id, actor_id, "left", member.last, now)
                    transitions.append(Transition("retired", actor_id, "left", member.last, member.index))
                else:
                    held.append((member.index, member.last))
        party.present = order
        self._forget(party, listed)
        return transitions, held

    @staticmethod
    def _forget(party: _Party, listed: set[str]) -> None:
        """Keep member memory bounded: the oldest members not in this read go first."""
        extra = len(party.members) - MEMBER_LIMIT
        for actor_id in [actor_id for actor_id in party.members if actor_id not in listed][:max(0, extra)]:
            del party.members[actor_id]


def _excerpt(actor: dict, activities: list, outcome: str) -> tuple[str, bool]:
    """The newest public update, and whether it is the final answer of the turn that ended."""
    turns = actor.get("turnStates") or []
    last_turn = str(turns[-1].get("id") or "") if turns and isinstance(turns[-1], dict) else ""
    for item in reversed(activities):
        if (item.get("kind") == "update" and item.get("title") != "Status"
                and str(item.get("description") or "").strip()):
            final = (outcome == "finished" and item.get("title") == "Answer"
                     and (not last_turn or str(item.get("turnId") or "") == last_turn))
            return clip(item["description"], EXCERPT_LIMIT), final
    return "", False


def parting_note(actor: dict, party_id: str, party_name: str, outcome: str, now_ms: float) -> dict:
    """A note built only from what the feed showed publicly about this member."""
    activities = [item for item in actor.get("activities") or [] if isinstance(item, dict)]
    files: list[str] = []
    for item in activities:
        if item.get("kind") != "file":
            continue
        for name in str(item.get("description") or "").split(" · "):
            name = name.strip()
            # The feed clips long lists with an ellipsis; a cut-off name is not a file name.
            if name and not name.endswith("…") and name not in files:
                files.append(name)
    reported, final = _excerpt(actor, activities, outcome)
    return clean_note({
        "party": party_id, "partyName": party_name, "id": str(actor.get("id") or ""),
        "name": actor.get("nickname") or actor.get("name") or actor.get("id"),
        "source": actor.get("source") or "", "parent": actor.get("parentThreadId") or "",
        "outcome": outcome, "at": now_ms, "reported": reported, "final": final,
        "files": files[:FILE_LIMIT], "fileCount": len(files),
        "commands": sum(item.get("kind") == "command" for item in activities),
        "searches": sum(item.get("kind") == "research" for item in activities),
        "tools": sum(item.get("kind") == "tool" for item in activities),
    }, now_ms) or {}


def _count(value) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 <= value < 100_000 else 0


def clean_note(raw, now_ms: float) -> dict | None:
    """Validate one stored note; anything malformed, unknown, or too old is dropped."""
    if not isinstance(raw, dict):
        return None
    party, actor_id = raw.get("party"), raw.get("id")
    at = raw.get("at")
    if not (isinstance(party, str) and isinstance(actor_id, str) and party.strip() and actor_id.strip()):
        return None
    if party in NOT_MEMBERS or actor_id in NOT_MEMBERS or actor_id == party or actor_id.startswith("demo-"):
        return None
    if raw.get("outcome") not in OUTCOMES or isinstance(at, bool) or not isinstance(at, (int, float)):
        return None
    if not now_ms - NOTE_DAYS * DAY_MS <= at <= now_ms + DAY_MS:
        return None
    files = raw.get("files") if isinstance(raw.get("files"), list) else []
    files = [clip(name, 60) for name in files if isinstance(name, str) and name.strip()][:FILE_LIMIT]
    source = raw.get("source") if raw.get("source") in ("codex", "orca", "claude", "extension") else ""
    text = lambda key, limit: clip(raw.get(key), limit) if isinstance(raw.get(key), str) else ""
    return {
        "party": party[:200], "partyName": text("partyName", 80), "id": actor_id[:200],
        "name": text("name", 70) or actor_id[:70], "source": source, "parent": text("parent", 200),
        "outcome": raw["outcome"], "at": float(at), "reported": text("reported", EXCERPT_LIMIT),
        # Only a final answer of the turn that ended is called one; older notes never were.
        "final": raw.get("final") is True and raw["outcome"] == "finished" and bool(text("reported", 1)),
        "files": files, "fileCount": max(_count(raw.get("fileCount")), len(files)),
        "commands": _count(raw.get("commands")), "searches": _count(raw.get("searches")),
        "tools": _count(raw.get("tools")), "read": raw.get("read") is True,
    }


def seen_summary(note: dict) -> str:
    """The steps the feed showed, in words; empty when it showed none."""
    parts = []
    files, count = note.get("files") or [], note.get("fileCount") or 0
    if files:
        more = count - len(files)
        parts.append("changed " + ", ".join(files) + (f" +{more} more" if more > 0 else ""))
    for key, one, many in (("commands", "command", "commands"), ("searches", "web search", "web searches"),
                           ("tools", "tool step", "tool steps")):
        value = note.get(key) or 0
        if value:
            parts.append(f"{value} {one if value == 1 else many}")
    return " · ".join(parts)


def outcome_word(outcome: str, source: str = "") -> str:
    """One short word for the band, the card, the panel, and the stream.

    A completed Codex turn is only that turn ending, never a verdict on the whole task."""
    if outcome == "left":
        return "LEFT"
    if outcome == "stopped":
        return "STOPPED"
    return "MARKED DONE" if source == "orca" else "TURN DONE"


OUTCOME_COLORS = {"finished": "#a7d6b0", "stopped": "#b3c9b4", "left": "#dfbb78"}


def outcome_line(note: dict) -> str:
    """What the feed showed, without claiming more: leaving says nothing about success."""
    if note["outcome"] == "left":
        return "Left the party list · outcome unknown"
    if note["outcome"] == "stopped":
        return "Its last turn was interrupted"
    return "Orca marked it done" if note.get("source") == "orca" else "Its last turn completed"


def observed_clock(at_ms: float, now_ms: float | None = None) -> str:
    now = now_ms if now_ms is not None else time.time() * 1000
    stamp = time.localtime(at_ms / 1000)
    clock = time.strftime("%I:%M %p", stamp).lstrip("0")
    return clock if now - at_ms < 20 * 3_600_000 else time.strftime("%b %d ", stamp).replace(" 0", " ") + clock


def note_lines(note: dict, name: str, now_ms: float | None = None) -> tuple[str, str, str, str]:
    """Title, source line, the excerpt, and the seen-in-feed summary.

    The excerpt is called a final answer only when the feed marked it as the answer of the
    turn that ended; anything else is the last update the feed showed."""
    source = {"codex": "CODEX", "orca": "ORCA", "claude": "CLAUDE", "extension": "FEED"}.get(note.get("source"), "AGENT")
    seen = seen_summary(note)
    if note.get("reported"):
        excerpt = f"{'Final answer' if note.get('final') else 'Last update'}: “{note['reported']}”"
    else:
        excerpt = "No public update captured."
    return (f"✉ {name} · {outcome_word(note['outcome'], note.get('source', ''))}",
            f"{source} · {outcome_line(note)} · seen {observed_clock(note['at'], now_ms)}",
            excerpt, f"Seen in feed: {seen}" if seen else "")


class PartingNotes:
    """The newest notes, at most 20 and at most two weeks old, saved with the widget settings."""

    def __init__(self) -> None:
        self.items: list[dict] = []

    @classmethod
    def load(cls, raw, now_ms: float) -> "PartingNotes":
        notes = cls()
        for item in raw if isinstance(raw, list) else []:
            note = clean_note(item, now_ms)
            if note and not any((other["party"], other["id"]) == (note["party"], note["id"])
                                for other in notes.items):
                notes.items.append(note)
        notes.trim(now_ms)
        return notes

    def trim(self, now_ms: float) -> None:
        self.items = sorted((note for note in self.items if note["at"] >= now_ms - NOTE_DAYS * DAY_MS),
                            key=lambda note: note["at"], reverse=True)[:NOTE_LIMIT]

    def add(self, note: dict, now_ms: float) -> None:
        if not note:
            return
        self.remove(note["party"], note["id"])
        self.items.append(note)
        self.trim(now_ms)

    def remove(self, party_id: str, actor_id: str) -> bool:
        return bool(self.take(party_id, actor_id))

    def take(self, party_id: str, actor_id: str) -> list[dict]:
        """Remove one note and hand it back, so the caller can offer an undo."""
        taken = [note for note in self.items if (note["party"], note["id"]) == (party_id, actor_id)]
        self.items = [note for note in self.items if (note["party"], note["id"]) != (party_id, actor_id)]
        return taken

    def take_party(self, party_id: str) -> list[dict]:
        taken = [note for note in self.items if note["party"] == party_id]
        self.items = [note for note in self.items if note["party"] != party_id]
        return taken

    def clear(self, party_id: str) -> int:
        return len(self.take_party(party_id))

    def restore(self, notes: list[dict], now_ms: float) -> int:
        """Put taken notes back as they were; a newer note for the same goblin wins."""
        restored = 0
        for note in notes:
            if not self.find(note["party"], note["id"]):
                self.items.append(note)
                restored += 1
        self.trim(now_ms)
        return restored

    def mark_read(self, party_id: str) -> bool:
        changed = False
        for note in self.items:
            if note["party"] == party_id and not note.get("read"):
                note["read"] = changed = True
        return changed

    def for_party(self, party_id: str) -> list[dict]:
        return [note for note in self.items if note["party"] == party_id]

    def find(self, party_id: str, actor_id: str) -> dict | None:
        return next((note for note in self.items if (note["party"], note["id"]) == (party_id, actor_id)), None)

    def to_json(self) -> list[dict]:
        return [dict(note) for note in self.items]
