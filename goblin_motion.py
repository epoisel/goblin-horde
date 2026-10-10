"""Choose a visible goblin action from public Goblin Horde activity."""

from __future__ import annotations

import re
import time
from typing import NamedTuple


SEARCH = re.compile(r"\b(search|research|investigat|inspect|explor|browse|look|find|read|review|check|test|query|open(?:ed)? a source|rg|grep|Get-Content)\w*\b", re.I)
BUILD = re.compile(r"\b(build|implement|creat|edit|writ|patch|chang|fix|refactor|add|modif|design|draw|render|install|assembl|apply_patch)\w*\b", re.I)
ACTIVE = {"inprogress", "working", "running", "active"}


def latest_public_event(activities: list) -> dict:
    """The newest step a goblin can act out; status pings are not steps."""
    return next((event for event in reversed(activities)
                 if not (event.get("title") == "Status" and event.get("kind") == "update")),
                activities[-1] if activities else {})


def event_action(item: dict) -> str:
    """The prop for one public event: magnifier to read or search, hammer to write, dots to update."""
    kind = str(item.get("kind") or "").lower()
    title = str(item.get("title") or "")
    signal = f"{title} {item.get('description') or ''} {str(item.get('detail') or '')[:500]}"
    if kind == "update":
        return "think"
    if kind == "file":
        return "build"
    if kind == "research":
        return "search"
    # A step's title leads with its verb: "Read a local file", "Checked Git changes".
    if SEARCH.match(title):
        return "search"
    if BUILD.search(title):
        return "build"
    if SEARCH.search(signal):
        return "search"
    if BUILD.search(signal):
        return "build"
    return "think"


def stamp_ms(value) -> float | None:
    """A feed timestamp in milliseconds; second-based stamps are scaled up."""
    try:
        stamp = float(value)
    except (TypeError, ValueError):
        return None
    return stamp * 1000 if stamp < 1e12 else stamp


def goblin_action(actor: dict, *, needs_input: bool = False, now_ms: float | None = None) -> str:
    """Return idle, search, build, think, waiting, or trouble.

    This is an illustration of observable work, not access to private reasoning.
    """
    state = str(actor.get("status") or "").lower()
    turns = actor.get("turnStates") or []
    activities = actor.get("activities") or []
    latest = activities[-1] if activities else {}
    if needs_input or state == "waiting" or (turns and turns[-1].get("questions")):
        return "waiting"
    if state == "failed" or latest.get("status") == "failed" or latest.get("exitCode") not in (None, 0):
        return "trouble"
    turn_state = str(turns[-1].get("status") or "").lower() if turns else ""
    active = turn_state in ACTIVE if turns else (state in ACTIVE or str(latest.get("status") or "").lower() in ACTIVE)
    if not active:
        return "idle"

    item = latest_public_event(activities)
    action = event_action(item)

    # A completed action does not keep swinging its prop throughout a long pause.
    if action in {"search", "build"} and item.get("status") != "inProgress":
        updated_ms = stamp_ms(actor.get("updatedAt"))
        if updated_ms is not None and (now_ms if now_ms is not None else time.time() * 1000) - updated_ms > 45_000:
            return "think"
    return action


BEAT_MS = 360  # Every surface animates on a 360 ms beat.
PULSE_MS = 8 * BEAT_MS  # Two full four-beat cycles.
FIRST_SIGHT_MIN_MS = 4 * BEAT_MS  # A fresh step seen late still gets one visible cycle.
CLOCK_SKEW_MS = 2_000
RESYNC_MS = 20_000
ACTOR_LIMIT = 256  # Goblins remembered by the pulse record; the least recently seen go first.


def event_mark(item: dict) -> str | None:
    if not item:
        return None
    return str(item.get("id") or (item.get("turnId"), item.get("order"), item.get("title")))


class ActionPulse:
    """Act out each newly seen public event for a few beats, even if it already finished.

    One tracker is shared by every surface, so a goblin's portrait, party tile, dock card,
    and launchpad row agree. Every look records every event in view (up to ``memory``), so
    a surface still holding an older list never acts out a step that was already history.
    The first look at a goblin, or a look after a long gap, only records: old events never
    replay and a revisited event never pulses twice. The one exception is a step the feed
    itself dates to within the pulse window; it still gets a brief pulse so a goblin seen
    just as it finishes does not stand still. Waiting and failure always win over a pulse,
    and still goblins never pulse, even mid-way through one that began before.
    """

    def __init__(self, duration_ms: float = PULSE_MS, memory: int = 64, actors: int = ACTOR_LIMIT) -> None:
        self.duration_ms = duration_ms
        self.memory = memory
        self.actors = actors
        self._seen: dict[str, dict[str, None]] = {}
        self._looked: dict[str, float] = {}  # Least recently looked-at first.
        self._pulses: dict[str, tuple[str, float]] = {}

    def _touch(self, key: str, now_ms: float) -> None:
        self._looked.pop(key, None)
        self._looked[key] = now_ms
        while len(self._looked) > self.actors:
            oldest = next(iter(self._looked))
            del self._looked[oldest]
            self._seen.pop(oldest, None)
            self._pulses.pop(oldest, None)

    def observe(self, actor: dict, now_ms: float, animate: bool = True) -> str | None:
        """Record the actor's events; return the action it is pulsing, if any."""
        key = str(actor.get("id") or "")
        if not key:
            return None
        activities = actor.get("activities") or []
        item = latest_public_event(activities)
        mark = event_mark(item)
        dormant = now_ms - self._looked.get(key, float("-inf")) > RESYNC_MS
        self._touch(key, now_ms)
        if not animate:
            self._pulses.pop(key, None)
        if mark:
            seen = self._seen.get(key)
            new = mark not in (seen or {})
            if seen is None or dormant:
                age = self.fresh_age(actor, item, now_ms) if animate and new else None
                self._pulses.pop(key, None)
                if age is not None:
                    remaining = max(self.duration_ms - age, FIRST_SIGHT_MIN_MS)
                    self._pulses[key] = (event_action(item), now_ms + remaining)
            elif new and animate:
                self._pulses[key] = (event_action(item), now_ms + self.duration_ms)
            seen = self._seen.setdefault(key, {})
            for event in (*activities[-self.memory:], item):
                event_id = event_mark(event) if isinstance(event, dict) else None
                if event_id:
                    seen.pop(event_id, None)
                    seen[event_id] = None
            while len(seen) > self.memory:
                seen.pop(next(iter(seen)))
        pulse = self._pulses.get(key)
        if pulse and now_ms >= pulse[1]:
            del self._pulses[key]
            return None
        return pulse[0] if pulse else None

    def pulsing(self, actor_id: str, now_ms: float | None = None) -> str | None:
        """The action a goblin is acting out right now, without recording anything."""
        pulse = self._pulses.get(str(actor_id or ""))
        now = now_ms if now_ms is not None else time.time() * 1000
        return pulse[0] if pulse and now < pulse[1] else None

    def fresh_age(self, actor: dict, item: dict, now_ms: float) -> float | None:
        """How long ago a first-seen step landed, only when the feed's own stamps vouch for it.

        The step must be the actor's last activity (not one hidden behind a status ping), the
        actor's update stamp must fall inside the pulse window, allowing small clock skew, and
        the step's turn must not have started after that stamp. Anything else is history."""
        activities = actor.get("activities") or []
        if not activities or activities[-1] is not item:
            return None
        updated = stamp_ms(actor.get("updatedAt"))
        if not updated:
            return None
        started = stamp_ms(item.get("turnStartedAt"))
        if started is not None and started > updated + CLOCK_SKEW_MS:
            return None
        age = now_ms - updated
        if -CLOCK_SKEW_MS <= age < self.duration_ms:
            return max(age, 0.0)
        return None

    def action(self, actor: dict, *, needs_input: bool = False, now_ms: float | None = None,
               animate: bool = True) -> str:
        """goblin_action plus a short pulse for a new event; ``animate=False`` only records."""
        now = now_ms if now_ms is not None else time.time() * 1000
        base = goblin_action(actor, needs_input=needs_input, now_ms=now)
        pulse = self.observe(actor, now, animate)
        if not animate or not pulse or base in ("waiting", "trouble"):
            return base
        return pulse


ACTION_LABELS = {
    "search": "SEARCHING", "build": "BUILDING", "think": "THINKING",
    "waiting": "NEEDS YOU", "trouble": "FAILED", "idle": "", "exit": "PARTING",
}
# While a finished step is acted out, the label says what just happened, not that it is ongoing.
PAST_LABELS = {"search": "CHECKED", "build": "BUILT", "think": "UPDATED"}


class MemberStatus(NamedTuple):
    glyph: str
    word: str
    color: str
    rank: int


def member_status(actor: dict, connection: str = "LIVE") -> MemberStatus:
    """One public, readable status for the stream, roster, and overview."""
    turns = actor.get("turnStates") or []
    latest = (actor.get("activities") or [{}])[-1]
    state = str(actor.get("status") or "").lower()
    if state in ("", "notloaded", "unknown") and turns:
        state = str(turns[-1].get("status") or "").lower()
    if actor.get("needsInput") or connection == "NEEDS YOU":
        return MemberStatus("!", "NEEDS YOU", "#dfbb78", 1)
    if state == "failed" or latest.get("status") == "failed" or latest.get("exitCode") not in (None, 0):
        return MemberStatus("✕", "FAILED", "#e18a78", 2)
    if connection == "CONNECTING":
        return MemberStatus("…", "LOADING", "#b3c9b4", 8)
    if turns and turns[-1].get("questions"):
        return MemberStatus("?", "ASKED YOU", "#dfbb78", 1)
    if connection in ("STALE", "OFFLINE"):
        return MemberStatus("·", connection, "#82978a", 7)
    action = goblin_action(actor)
    if action in ("search", "build", "think"):
        return MemberStatus("▶", ACTION_LABELS[action], "#a7d6b0", 4)
    if state in ("completed", "done"):
        return MemberStatus("✓", "DONE", "#b3c9b4", 5)
    if state == "idle":
        return MemberStatus("–", "IDLE", "#b3c9b4", 6)
    return MemberStatus("·", "QUIET", "#b3c9b4", 7)


def with_pulse(status: MemberStatus, pulse: str | None) -> MemberStatus:
    """A resting goblin acting out a finished step says what it just did ("✓ CHECKED").

    Waiting, failure, live work, and connection states keep their own word."""
    if pulse in PAST_LABELS and status.word in ("DONE", "IDLE", "QUIET"):
        return MemberStatus("✓", PAST_LABELS[pulse], "#a7d6b0", status.rank)
    return status
