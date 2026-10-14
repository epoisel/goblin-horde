"""Transparent desktop goblins for the local Goblin Horde viewer (Windows and macOS)."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
import time
import tkinter as tk
from tkinter import font as tkfont, messagebox, simpledialog
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path
import sys
import threading
import traceback
from typing import NamedTuple

import desktop_platform
from desktop_platform import (UNAVAILABLE_EXIT, WINDOWS_KEY, TransparencyUnavailable, bind_context, float_window,
                              make_transparent, ui_family, ui_font)
from goblin_cues import (HELD, PORTAL_BEATS, PORTAL_CLIP, PORTAL_TOP, ActionClock, Pose, art_runs, cue_for,
                         cue_runs, exit_frame, pose_for, system_prefers_reduced_motion)
from goblin_motion import ActionPulse, MemberStatus, goblin_action, member_status, with_pulse
from goblin_parting import (OUTCOME_COLORS, PartingNotes, RetirementTracker, note_lines, outcome_word,
                            parting_note)
from party_layout import (age_label, compact_active, coverage_note, family_ink, launchpad_board, loop_groups,
                          join_reason, model_badge, model_of, party_models, party_scope, priority_for, project_for, reachable,
                          search_sources, stable_layout, tile_plan, watched_cards)
from stream_windows import (StreamWindow, WIDTH as STREAM_WIDTH, HEIGHT as STREAM_HEIGHT, monitor_areas,
                            monitor_work_area, screen_geometry, workflow_for)


TRANSPARENT = WINDOWS_KEY
INK = "#24352b"
CARD = "#fffbed"
COL_WIDTH = 210
HEIGHT = 296
BODY_LINES = 4
TEXT_STEP = 3
TEXT_ADVANCE_SECONDS = 4.0
MAX_PAGE_HOLD_SECONDS = 24.0
# Launchpad, roster, and tab share the dark dialogue palette of the stream windows.
# The camp palette shared with the browser viewer and the product reel.
PANEL = "#1b2a22"
PANEL_HEADER = "#1f3328"
CARD_FILL = "#243a2e"
CARD_LINE = "#3d5a4a"
PILL_INK = "#15201a"
BUTTON = "#2e4739"
IVORY = "#f6ecd2"
MUTED = "#b3c9b4"
GOLD = "#dfbb78"
ALERT = "#e18a78"
LIVELY = "#a7d6b0"
LAUNCHPAD_WIDTH = 440
ACTIVE_ROW = 66
QUIET_ROW = 26
BOARD_SECONDS = 4.0
ACTIVE_LIMIT = 6  # Working rows before 'show more'; parties that need you or failed always show.
# A 2x goblin is 34 pixels wide and its action cue adds 14 more beside its head.
GOBLIN_STEP = 48
DOCK_CARD = 128
DOCK_STEP = DOCK_CARD + 4
# A retiring goblin's portal plays on the shared 360 ms beat, then holds its last frame for one.
EXIT_BEAT_SECONDS = 0.36
EXIT_SECONDS = (PORTAL_BEATS + 1) * EXIT_BEAT_SECONDS
LILAC = "#c7b9e2"
# The note band under the cards; its READ, ×, and UNDO targets are at least 24x22 pixels.
NOTE_BAND = 32
NOTE_CHIP = (24, 22)
# A dismissed or cleared note can be brought back with one UNDO for this long.
UNDO_SECONDS = 30.0
# Streams closed with ×, remembered per party so polls and restarts never reopen them.
DISMISSED_PARTIES = 24
DISMISSED_LIMIT = 200
# Where each stream last stood, by actor id, so a reopened window returns to its spot.
PLACEMENT_LIMIT = 200
# The part of a stream window (its dialogue header) that must stay on some display to be grabbed.
STREAM_GRIP = (103, 8, STREAM_WIDTH - 8, 80)
# The one explicit "open every window" action; expanding and polls leave ×-closed streams shut.
RALLY_LABEL = "Rally whole party (reopen closed)"
# "Close goblins" closes only this widget; this also stops the viewer it talks to.
QUIT_LABEL = "Quit Goblin Horde (goblins and viewer)"
# The manager's `start` leaves this file in the state folder's run/ when the widget is already
# running (lib/manager.mjs SHOW_REQUEST); the widget checks every second and comes forward.
SHOW_REQUEST = "show-widget"
SHOW_CHECK_MS = 1000
# Failed callbacks are noted in run/widget.log: every one of the first few, then one in a hundred.
LOGGED_ERRORS = 20
# Expanding a party opens at most this many stream windows; members who need you or failed always open.
# The rest wait on the roster (click one to open it); the rally opens everyone.
STREAM_LIMIT = 3


def parting_status(outcome: str, source: str = "") -> MemberStatus:
    """A card mid-portal names its outcome in the same words as the note it leaves."""
    return MemberStatus("✉", outcome_word(outcome, source), OUTCOME_COLORS.get(outcome, LILAC), 5)


class Undo(NamedTuple):
    """The last dismissed or cleared notes, kept for one UNDO."""
    party: str
    notes: list
    label: str
    until: float  # time.monotonic() deadline


class Exit(NamedTuple):
    """A portal in progress: when it opened, and the departing member's last-seen place."""
    start: float
    outcome: str
    actor: dict
    index: int
# Goblin bodies, faces, gear, and outfits come from goblin_art.json, the sprite file the browser viewer
# draws from too, so a goblin looks the same on every surface. Action props stay in goblin_cues.
ART = json.loads(Path(__file__).with_name("goblin_art.json").read_text(encoding="utf-8"))
# Each agent's model picks its tribe: Claude models are hooded hexers, OpenAI models sapper
# war-machinists, and everything else (Orca, feeds without a model) ragged raiders.
TRIBES: dict[str, list[dict]] = {
    name: [{**outfit, "tribe": name, "body": spec["body"], "arm": spec["arm"]} for outfit in spec["outfits"]]
    for name, spec in ART["tribes"].items()
}
KINDS = [outfit for outfits in TRIBES.values() for outfit in outfits]
FAMILY_TRIBE = {"claude": "shaman", "openai": "sapper"}
# The action preview shows every tribe in turn, each with an invented model.
DEMO_KINDS = [outfit for group in zip(*TRIBES.values()) for outfit in group]
DEMO_IDENTITY = {
    "shaman": {"source": "claude", "model": {"id": "claude-opus-5-5", "label": "Opus 5.5", "family": "claude"}},
    "sapper": {"source": "codex", "model": {"id": "gpt-5.6-sol", "label": "GPT-5.6 Sol", "family": "openai", "effort": "high"}},
    "raider": {"source": "orca"},
}
SOURCE_TRIBE = {"claude": "shaman", "codex": "sapper"}
ART_EYES = {"front": "eyesFwd", "right": "eyesRight", "up": "eyesFwd", "squint": "eyesWorry", "blink": "eyesShut"}
# The art sits one column right and one row down on the widget grid: its feet stand on the shadow at
# row 16 and a tall helm or hood (art rows -1 to -4) still drops fully through the floor portal.
ART_COL, ART_ROW = 1, 1
FEET_ROW = ART_ROW + len(ART["layers"]["body"]["rows"]) - 1
_ART_RUNS: dict[str, tuple[tuple[int, int, int, str], ...]] = {}


def art_layer_runs(name: str) -> tuple[tuple[int, int, int, str], ...]:
    """Horizontal (column, row, length, palette key) runs of one goblin_art layer, in widget sprite pixels."""
    if name not in _ART_RUNS:
        layer = ART["layers"][name]
        left, top = layer["at"]
        runs = []
        for row, line in enumerate(layer["rows"]):
            column = 0
            while column < len(line):
                key, length = line[column], 1
                while column + length < len(line) and line[column + length] == key:
                    length += 1
                if key != ".":
                    runs.append((ART_COL + left + column, ART_ROW + top + row, length, key))
                column += length
        _ART_RUNS[name] = tuple(runs)
    return _ART_RUNS[name]


def art_color(key: str, style: dict) -> str:
    role = ART["styleColors"].get(key)
    if role is None:
        return ART["colors"][key]
    if role == "coatDark":
        value = int(style["coat"][1:], 16)
        return "#" + "".join(f"{round(((value >> shift) & 255) * ART['coatDark']):02x}" for shift in (16, 8, 0))
    return style[role]


def state_file() -> Path:
    local = Path(os.environ.get("LOCALAPPDATA") or Path.home())
    base = local / "GoblinHorde"
    if desktop_platform.is_mac() and not os.environ.get("LOCALAPPDATA"):
        # The manager's default macOS state folder, for a widget started by hand.
        base = Path.home() / "Library" / "Application Support" / "GoblinHorde"
    # The cross-platform manager can point an isolated installation at its own state folder.
    override = os.environ.get("GOBLIN_HORDE_STATE_DIR") or ""
    if override and Path(override).is_absolute():
        base = Path(override)
    base.mkdir(parents=True, exist_ok=True)
    target = base / "goblins.json"
    legacy = local / "ActivityLens" / "goblins.json"
    if not target.exists() and legacy.is_file():
        target.write_bytes(legacy.read_bytes())
    return target


def run_folder() -> Path:
    """The state folder's run/, where the manager keeps its records and the widget's log."""
    return state_file().parent / "run"


def note_widget_error(line: str) -> None:
    """Add one line to run/widget.log. A widget started by the manager writes its output there
    already, so stderr is used when there is one; pythonw started any other way has none."""
    try:
        if sys.stderr is not None:
            sys.stderr.write(line + "\n")
            sys.stderr.flush()
            return
    except (OSError, ValueError):
        pass
    try:
        folder = run_folder()
        folder.mkdir(parents=True, exist_ok=True)
        with open(folder / "widget.log", "a", encoding="utf-8") as log:
            log.write(line + "\n")
    except OSError:
        pass  # Nowhere to write; the count still reaches the diagnostic report.


def claude_settings_label() -> str:
    """The Claude Code settings file the viewer would change, written the way this system names it.
    The manager passes the viewer and the widget the same CLAUDE_CONFIG_DIR."""
    folder = os.environ.get("CLAUDE_CONFIG_DIR") or ""
    if folder and Path(folder).is_absolute():
        return str(Path(folder) / "settings.json")
    return "%USERPROFILE%\\.claude\\settings.json" if sys.platform == "win32" else "~/.claude/settings.json"


def error_line(count: int, kind, trace) -> str:
    """Type and place only: an error's own message can quote chat text."""
    frames = traceback.extract_tb(trace) if trace is not None else []
    where = f"{Path(frames[-1].filename).name}:{frames[-1].lineno} in {frames[-1].name}" if frames else "unknown place"
    name = getattr(kind, "__name__", "Error")
    return f"{time.strftime('%Y-%m-%d %H:%M:%S')} widget error #{count}: {name} at {where}"


def write_settings(target: Path, text: str) -> None:
    """Replace the settings file in one step, so a crash mid-write never leaves half a file."""
    temporary = target.with_name(f"{target.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(text, encoding="utf-8")
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def keep_unreadable_settings(raw: bytes) -> None:
    """Set an unreadable settings file aside (once) instead of losing its notes and layout to the next save."""
    try:
        target = state_file()
        aside = target.with_name(f"{target.name}.unreadable")
        if not aside.exists():
            aside.write_bytes(raw)
    except OSError:
        pass


def latest_line(actor: dict) -> str:
    activities = actor.get("activities") or []
    if not activities:
        return "Listening for the next step."
    item = activities[-1]
    if item.get("title") == "Status" and item.get("description") == "Finished the task.":
        item = next((entry for entry in reversed(activities[:-1])
                     if entry.get("kind") == "update" and entry.get("description")), item)
    description = " ".join(str(item.get("description") or "").split())
    if item.get("kind") == "update":
        return description or "I have an update."
    if item.get("kind") == "file":
        return f"I changed {description}." if description else "I changed project files."
    if item.get("status") == "failed" or (item.get("exitCode") not in (None, 0)):
        return "That check failed."
    return description or str(item.get("title") or "Working on a step.")


def stable_style(actor_id: str) -> int:
    """A stable hash of an actor id; the same agent always wears the same outfit."""
    value = 2166136261
    for byte in actor_id.encode("utf-8"):
        value = ((value ^ byte) * 16777619) & 0xffffffff
    return value


def tribe_for(actor: dict) -> str:
    """The goblin tribe for an agent: its model's family first, then the source it came from."""
    family = str(model_of(actor).get("family") or "")
    return FAMILY_TRIBE.get(family) or SOURCE_TRIBE.get(str(actor.get("source") or ""), "raider")


def tribe_title(actor: dict) -> str:
    """The tribe's name for tooltips: 'Hexer', 'Sapper', or 'Raider'."""
    return str(ART["tribes"].get(tribe_for(actor), {}).get("label") or "")


def style_for(actor: dict, offset: int = 0, index: int | None = None) -> dict:
    """The outfit an agent wears: its tribe's outfit by a stable hash of its id (or ``index``)."""
    outfits = TRIBES.get(tribe_for(actor)) or TRIBES["raider"]
    named = [index for index, outfit in enumerate(outfits) if outfit["name"] == actor.get("outfit")]
    if named and index is None:
        index = named[0]
    base = stable_style(str(actor.get("id") or "")) if index is None else index
    return outfits[(base + offset) % len(outfits)]


def fit_text(font: tkfont.Font, value: str, max_width: int) -> str:
    value = " ".join(str(value).split())
    if font.measure(value) <= max_width:
        return value
    while value and font.measure(value + "…") > max_width:
        value = value[:-1]
    return value.rstrip() + "…"


def wrap_text(font: tkfont.Font, value: str, max_width: int) -> list[str]:
    words = " ".join(str(value).split()).split(" ")
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if font.measure(candidate) <= max_width:
            current = candidate
            continue
        if current:
            lines.append(current)
            current = ""
        if font.measure(word) > max_width:
            while word and font.measure(word) > max_width:
                prefix = fit_text(font, word, max_width).removesuffix("…")
                if not prefix:
                    break
                lines.append(prefix)
                word = word[len(prefix):]
        current = word
    if current:
        lines.append(current)
    return lines or [""]


def text_window(lines: list[str], offset: int) -> tuple[int, list[str], int]:
    maximum = max(0, len(lines) - BODY_LINES)
    start = max(0, min(offset, maximum))
    return start, lines[start:start + BODY_LINES], maximum


def place_at_anchor(owner, window: tk.Toplevel, width: int, height: int) -> None:
    """Launchpad, party roster, and hidden tab all grow up and left from one home corner."""
    left, top, right, bottom = monitor_work_area(owner.root)
    anchor_x = owner.dock_x if owner.dock_x is not None else owner.root.winfo_x() + owner.width
    anchor_y = owner.dock_y if owner.dock_y is not None else owner.root.winfo_y() + HEIGHT
    x = max(left, min(int(anchor_x) - width, right - width))
    y = max(top, min(int(anchor_y) - height, bottom - height))
    window.geometry(f"{width}x{height}{screen_geometry(x, y)}")


def dock_button(parent: tk.Misc, label: str, command) -> tk.Button:
    return tk.Button(parent, text=label, command=command, bg=BUTTON, fg=IVORY,
                     activebackground="#456b50", activeforeground=IVORY,
                     font=ui_font("Consolas", 8, "bold"), bd=1, relief="solid",
                     padx=5, pady=2, cursor="hand2")


class PartyDock:
    """One compact home for a selected party and a small restore tab."""

    def __init__(self, owner) -> None:
        self.owner = owner
        self.mode = ""
        self.member_hitboxes: list[tuple[int, int, int, int, str]] = []
        # (left, top, right, bottom, command, hint) for the parting-note band under the cards.
        self.note_hitboxes: list[tuple[int, int, int, int, object, str]] = []
        self.sprites: list[tuple[str, int, int, dict, dict]] = []
        # (canvas text item, actor) for each card's status line, kept in step with its goblin.
        self.labels: list[tuple[int, dict]] = []
        self.drag_start: tuple[int, int, int, int] | None = None
        self.row_offset = 0
        self.tab_moved = False
        self.full_title = "◆ PARTY"
        self.full_status = "PARTY"
        self.status_text = "PARTY"
        self.status_parts: list[tuple[str, str]] = [("party", "PARTY")]
        self.hover_member: dict | None = None
        self.title_cut = False
        self.status_cut = False
        self.title_font = tkfont.Font(family=ui_family("Consolas"), size=9, weight="bold")
        self.status_font = tkfont.Font(family=ui_family("Consolas"), size=7)
        self.member_font = tkfont.Font(family=ui_family("Consolas"), size=8, weight="bold")
        self.model_font = tkfont.Font(family=ui_family("Consolas"), size=7, weight="bold")
        self.note_font = tkfont.Font(family=ui_family("Consolas"), size=8)
        self.tooltip_after: str | None = None
        self.tooltip: tk.Toplevel | None = None
        self.window = tk.Toplevel(owner.root)
        self.window.withdraw()
        float_window(self.window)
        self.window.configure(bg="#dfbb78")
        self.window.title("Goblin Horde · Party")
        self.shell = tk.Frame(self.window, bg="#162c23", bd=2, relief="solid")
        self.shell.pack(fill="both", expand=True, padx=2, pady=2)

        self.full = tk.Frame(self.shell, bg="#162c23")
        header = tk.Frame(self.full, bg="#233f31")
        self.header = header
        header.pack(fill="x")
        self.title = tk.Label(header, text="PARTY", bg="#233f31", fg="#f6ecd2",
                              font=self.title_font, anchor="w", padx=8)
        self.header_buttons: list[tk.Button] = []
        # "◂ ALL" returns to the launchpad; the right-hand verbs act on this party only.
        back = dock_button(header, "◂ ALL", owner.show_launchpad)
        back.pack(side="left", padx=(3, 0), pady=3)
        self.header_buttons.append(back)
        for label, command in (("⋯", owner.show_party_menu), ("HIDE", owner.hide_party),
                               ("EXPAND", owner.expand_party)):
            button = dock_button(header, label, command)
            button.pack(side="right", padx=2, pady=3)
            self.header_buttons.append(button)
        self.header_controls_width = sum(button.winfo_reqwidth() + 4 for button in self.header_buttons)
        self.title.pack(side="left", fill="x", expand=True)
        header.bind("<Configure>", lambda event: self.fit_header(event.width))
        self.title.bind("<Enter>", lambda _event: self.schedule_tooltip(self.full_title)
                        if self.title_cut else None)
        self.title.bind("<Leave>", lambda _event: self.hide_tooltip())
        self.status_strip = tk.Label(self.full, text="PARTY", bg="#162c23", fg="#b3c9b4",
                                      font=self.status_font, anchor="w", padx=8)
        self.status_strip.pack(fill="x")
        self.status_strip.bind("<Enter>", lambda _event: self.schedule_tooltip(self.full_status)
                               if self.status_cut else None)
        self.status_strip.bind("<Leave>", lambda _event: self.hide_tooltip())
        header.bind("<ButtonPress-1>", self.start_drag)
        header.bind("<B1-Motion>", self.drag)
        header.bind("<ButtonRelease-1>", self.end_drag)
        self.title.bind("<ButtonPress-1>", self.start_drag)
        self.title.bind("<B1-Motion>", self.drag)
        self.title.bind("<ButtonRelease-1>", self.end_drag)
        self.status_strip.bind("<ButtonPress-1>", self.start_drag)
        self.status_strip.bind("<B1-Motion>", self.drag)
        self.status_strip.bind("<ButtonRelease-1>", self.end_drag)
        self.body = tk.Canvas(self.full, bg="#162c23", bd=0, highlightthickness=0,
                              cursor="hand2")
        self.body.pack(fill="both", expand=True, padx=5, pady=5)
        self.body.bind("<Button-1>", self.on_member_click)
        self.body.bind("<Motion>", self.on_member_hover)
        self.body.bind("<Leave>", lambda _event: self.show_base_status())
        self.body.bind("<MouseWheel>", self.scroll_members)
        for surface in (self.full, header, self.title, self.status_strip, self.body):
            bind_context(surface, lambda _event: owner.show_party_menu())
        for button in self.header_buttons:
            button.bind("<ButtonPress-1>", lambda _event: self.hide_tooltip(), add="+")

        self.mini = tk.Frame(self.shell, bg="#162c23")
        self.badge_font = tkfont.Font(family=ui_family("Consolas"), size=8, weight="bold")
        self.mini_badge = tk.Label(self.mini, text="◆ PARTY", bg="#315b45", fg="#f6ecd2",
                                    font=self.badge_font, bd=1, relief="solid",
                                    cursor="hand2", padx=4)
        self.mini_badge.pack(side="left", fill="both", expand=True, padx=(3, 2), pady=3)
        self.mini_badge.bind("<ButtonPress-1>", self.start_tab_drag)
        self.mini_badge.bind("<B1-Motion>", self.drag_tab)
        self.mini_badge.bind("<ButtonRelease-1>", self.end_tab_drag)
        # The tab uses the same verbs as the roster and streams; the badge restores the hidden view.
        self.mini_actions = tk.Frame(self.mini, bg="#162c23")
        self.mini_actions.pack(side="right", padx=(0, 1), before=self.mini_badge)
        self.mini_buttons = [dock_button(self.mini_actions, label, command) for label, command in (
            ("◂ ALL", owner.show_launchpad), ("CONDENSE", owner.condense_party), ("EXPAND", owner.expand_party))]
        for button in self.mini_buttons:
            button.pack(side="left", padx=2, pady=3)
        # Parting notes stay reachable while the party is hidden: one click opens the roster
        # (the party's launchpad) with the notes beside it.
        self.mini_notes = tk.Button(self.mini_actions, text="✉", command=owner.read_notes_from_tab,
                                    bg="#3b3352", fg=IVORY, activebackground="#4d4368", activeforeground=IVORY,
                                    font=ui_font("Consolas", 8, "bold"), bd=1, relief="solid", padx=5, pady=2,
                                    cursor="hand2")
        for surface in (self.mini, self.mini_badge, self.mini_actions, *self.mini_buttons, self.mini_notes):
            bind_context(surface, lambda _event: owner.show_party_menu())
        self.window.bind("<Escape>", lambda _event: owner.hide_party()
                         if self.mode == "compact" else None)
        # Alt+F4 must never destroy a window the widget keeps using (see on_close_request).
        self.window.protocol("WM_DELETE_WINDOW", self.on_close_request)

    def on_close_request(self) -> None:
        """Alt+F4 on the roster collapses it to the tab; on the tab it hides the tab. The widget keeps
        running either way, and opening Goblin Horde from the Start menu brings it back."""
        if self.mode == "compact":
            self.owner.hide_party()
        else:
            self.withdraw()

    def place(self, width: int, height: int) -> None:
        place_at_anchor(self.owner, self.window, width, height)

    def show_compact(self) -> None:
        self.mode = "compact"
        self.mini.pack_forget()
        self.full.pack(fill="both", expand=True)
        self.refresh()
        self.window.deiconify()
        self.window.lift()

    def show_hidden(self) -> None:
        self.hide_tooltip()
        self.mode = "hidden"
        self.full.pack_forget()
        self.mini.pack(fill="both", expand=True)
        self.refresh()
        self.window.deiconify()
        self.window.lift()

    def withdraw(self) -> None:
        self.hide_tooltip()
        self.mode = ""
        self.window.withdraw()

    def fit_header(self, header_width: int) -> None:
        available = max(32, header_width - self.header_controls_width - 16)
        shown = fit_text(self.title_font, self.full_title, available)
        self.title_cut = shown != self.full_title
        self.title.configure(text=shown)
        if self.hover_member:
            self.show_member_status(self.hover_member, header_width)
        else:
            self.show_base_status(header_width)

    def show_base_status(self, header_width: int | None = None) -> None:
        self.hover_member = None
        parts = list(self.status_parts)
        available = max(40, (header_width or self.window.winfo_width() - 8) - 16)
        self.status_text = " · ".join(value for _key, value in parts)
        for removable in ("leftout", "count", "live", "party"):
            if self.status_font.measure(" · ".join(value for _key, value in parts)) <= available:
                break
            parts = [item for item in parts if item[0] != removable]
        shown = " · ".join(value for _key, value in parts)
        self.full_status = self.status_text
        self.status_cut = shown != self.status_text
        self.status_strip.configure(text=shown)

    def show_member_status(self, actor: dict, header_width: int | None = None) -> None:
        self.hover_member = actor
        actor_id = str(actor.get("id") or "")
        status = self.card_status(actor)
        try:
            stamp = float(actor.get("updatedAt") or 0)
            if stamp <= 0:
                raise ValueError("no timestamp")
            age = f" · {max(0, int((time.time() - (stamp / 1000 if stamp > 1e12 else stamp)) / 60))}m ago"
        except (TypeError, ValueError):
            age = ""
        position = next((index + 1 for index, item in enumerate(self.owner.actors)
                         if str(item.get("id")) == actor_id), 1)
        prefix = f"{position}/{max(1, len(self.owner.actors))} "
        name = self.owner.display_name(actor)
        badge = model_badge(actor, with_effort=True)
        suffix = f" · {badge}" * bool(badge) + f" · {status.word}{age}"
        available = max(40, (header_width or self.window.winfo_width() - 8) - 16)
        name_width = max(1, available - self.status_font.measure(prefix + suffix))
        shown = prefix + fit_text(self.status_font, name, name_width) + suffix
        if self.status_font.measure(shown) > available:
            suffix = f" · {model_badge(actor)}" * bool(badge) + f" · {status.word}"
            name_width = max(1, available - self.status_font.measure(prefix + suffix))
            shown = prefix + fit_text(self.status_font, name, name_width) + suffix
        self.full_status = prefix + name + f" · {badge}" * bool(badge) + f" · {status.word}{age}"
        self.status_cut = shown != self.full_status
        self.status_strip.configure(text=shown)

    def schedule_tooltip(self, full_text: str) -> None:
        self.hide_tooltip()
        self.tooltip_after = self.window.after(500, lambda: self.show_tooltip(full_text))

    def show_tooltip(self, full_text: str) -> None:
        self.tooltip_after = None
        if self.mode != "compact" or not self.window.winfo_ismapped():
            return
        tip = tk.Toplevel(self.window)
        tip.withdraw()
        float_window(tip)
        tip.configure(bg="#dfbb78")
        tk.Label(tip, text=full_text, bg="#162c23", fg="#f6ecd2", padx=8, pady=5,
                 font=ui_font("Consolas", 8), wraplength=380, justify="left").pack(padx=2, pady=2)
        tip.update_idletasks()
        left, top, right, bottom = monitor_work_area(self.owner.root)
        x = max(left, min(self.window.winfo_pointerx() + 12, right - tip.winfo_reqwidth()))
        y = max(top, min(self.window.winfo_pointery() + 16, bottom - tip.winfo_reqheight()))
        tip.geometry(f"+{x}+{y}")
        tip.deiconify()
        self.tooltip = tip

    def hide_tooltip(self) -> None:
        if self.tooltip_after:
            self.window.after_cancel(self.tooltip_after)
            self.tooltip_after = None
        if self.tooltip:
            self.tooltip.destroy()
            self.tooltip = None

    def refresh(self) -> None:
        all_actors = [] if self.owner.pending_party and self.owner.connection == "CONNECTING" else (
            self.owner.actors or [stream.actor for stream in self.owner.streams.values()])
        if not all_actors and not self.owner.pending_party and self.owner.connection == "CONNECTING":
            all_actors = self.owner.saved_streams
        # Retired members have left the live party; their notes sit in the band below the cards.
        all_actors = [actor for actor in all_actors if str(actor.get("id") or "") not in ("", "all", "standby")
                      and str(actor["id"]) not in self.owner.parted]
        actors = [actor for actor in all_actors if str(actor["id"]) not in self.owner.hidden_ids]
        statuses = [member_status(actor, self.owner.connection) for actor in all_actors]
        needs = sum(status.rank == 1 for status in statuses)
        failed = sum(status.rank == 2 for status in statuses)
        hidden = len(all_actors) - len(actors)
        if self.mode == "hidden":
            from_home = self.owner.hidden_from == "overview" or self.owner.thread_id == "all"
            connection = self.owner.connection
            if from_home:
                active, _recent, _older = self.owner.board_cards()
                needs = sum(card.needs for card in active)
                failed = sum(card.failed for card in active)
                label, count = "ALL PARTIES", f"{len(active)} WORKING"
                connection = self.owner.board_connection
            else:
                label = fit_text(self.badge_font, self.owner.source_name, 170)
                count = f"{len(all_actors)} {'GOBLIN' if len(all_actors) == 1 else 'GOBLINS'}"
            attention = (f" · {needs} NEED YOU" if needs else f" · {failed} FAILED" if failed else
                         " · STALE" if connection in ("STALE", "OFFLINE") else "")
            notes = [] if from_home else self.owner.party_notes()
            unread = sum(not note.get("read") for note in notes)
            # New notes are counted on their own, never folded into the live attention counts.
            text = f"◆ {label} · {count}{attention}" + (f" · ✉ {unread} NEW" if unread else "")
            self.mini_badge.configure(text=text, bg="#715a2f" if needs else "#713d36" if failed else
                                      "#4a3f66" if unread else "#315b45")
            if from_home and self.mini_actions.winfo_manager():
                self.mini_actions.pack_forget()
            elif not from_home and not self.mini_actions.winfo_manager():
                self.mini_actions.pack(side="right", padx=(0, 1), before=self.mini_badge)
            if notes:
                self.mini_notes.configure(text=f"✉ {len(notes)}", bg="#6a5a92" if unread else "#3b3352")
                if not self.mini_notes.winfo_manager():
                    self.mini_notes.pack(side="left", padx=2, pady=3, before=self.mini_buttons[0])
            elif self.mini_notes.winfo_manager():
                self.mini_notes.pack_forget()
            buttons = [*self.mini_buttons, self.mini_notes] if notes else self.mini_buttons
            actions = 0 if from_home else sum(button.winfo_reqwidth() + 4 for button in buttons) + 2
            self.place(max(200, min(620, self.badge_font.measure(text) + 34 + actions)), 38)
            return
        if self.mode != "compact":
            return
        left, top, right, bottom = monitor_work_area(self.owner.root)
        columns = min(max(1, (right - left - 34) // DOCK_STEP), max(1, len(actors)), 6)
        total_rows = max(1, (len(actors) + columns - 1) // columns)
        rows = min(3, total_rows)
        self.row_offset = min(self.row_offset, total_rows - rows)
        overflow = total_rows > rows
        width = min(max(360, columns * DOCK_STEP + 18, self.header_controls_width + 170),
                    max(240, right - left - 24))
        notes = self.owner.party_notes()
        undo = self.owner.party_undo()
        grid_height = rows * 55 + (16 if overflow else 0)
        body_height = grid_height + (NOTE_BAND if notes or undo else 0)
        self.body.configure(width=width - 14, height=body_height)
        # Window/shell borders and the canvas's vertical pack padding use 18 pixels.
        height = self.header.winfo_reqheight() + self.status_strip.winfo_reqheight() + body_height + 18
        self.place(width, height)
        opening = self.owner.connection == "CONNECTING"
        self.full_title = ("OPENING ◆ " if self.owner.pending_party and opening else "◆ ") + self.owner.source_name
        self.status_parts = [("party", "PARTY"),
                             ("count", f"{len(actors)} {'MEMBER' if len(actors) == 1 else 'MEMBERS'}"),
                             ("live" if self.owner.connection == "LIVE" else "connection", self.owner.connection)]
        if needs:
            self.status_parts.append(("needs", f"{needs} NEED YOU"))
        if failed:
            self.status_parts.append(("failed", f"{failed} FAILED"))
        if hidden:
            self.status_parts.append(("leftout", f"+{hidden} LEFT OUT"))
        # Notes are counted on their own, never folded into the live needs or failed counts.
        if notes:
            self.status_parts.append(("notes", f"✉ {len(notes)} {'NOTE' if len(notes) == 1 else 'NOTES'}"))
        self.show_base_status(width - 8)
        self.fit_header(width - 8)
        self.body.delete("all")
        self.member_hitboxes = []
        self.note_hitboxes = []
        self.sprites = []
        self.labels = []
        if not actors:
            settled = notes and self.owner.connection in ("LIVE", "PARTIAL")
            self.body.create_text(12, 24, text="No one is working here now." if settled else "Waiting for this party…",
                                  anchor="w", fill="#b3c9b4", font=ui_font("Consolas", 9))
        first = self.row_offset * columns
        for index, actor in enumerate(actors[first:first + rows * columns], start=first):
            x = 5 + (index % columns) * DOCK_STEP
            y = 3 + (index // columns - self.row_offset) * 55
            actor_id = str(actor["id"])
            style = self.owner.stream_style(actor)
            leaving = self.owner.exit_beat(actor_id) is not None
            status = self.card_status(actor)
            selected = actor_id == self.owner.peek_id
            self.body.create_rectangle(x, y, x + DOCK_CARD, y + 49, fill="#233f31",
                                       outline="#dfbb78" if selected or status.rank == 1 else
                                       "#e18a78" if status.rank == 2 else LILAC if leaving else style["accent"],
                                       width=3 if selected else 2)
            if selected:
                self.body.create_rectangle(x + 3, y + 3, x + DOCK_CARD - 3, y + 46,
                                           outline="#dfbb78", width=1)
            # The whole 2x goblin with its action cue, animated like the launchpad's.
            tag = f"dock-sprite-{index}"
            self.sprites.append((tag, x + 4, y + 5, style, actor))
            self.paint_sprite(tag, x + 4, y + 5, style, actor)
            short_name = self.owner.aliases.get(actor_id) or str(actor.get("nickname") or actor.get("name") or actor_id)
            self.body.create_text(x + 54, y + 7,
                                  text=fit_text(self.member_font, f"{index + 1} {short_name}", DOCK_CARD - 60),
                                  anchor="nw", fill="#f6ecd2", font=self.member_font)
            label = self.body.create_text(x + 54, y + 24, text=f"{status.glyph} {status.word}", anchor="nw",
                                          fill=status.color, font=ui_font("Consolas", 7))
            badge = model_badge(actor)
            if badge:
                self.body.create_text(x + 54, y + 36, text=fit_text(self.model_font, badge, DOCK_CARD - 60),
                                      anchor="nw", font=self.model_font,
                                      fill=family_ink(actor))
            self.labels.append((label, actor))
            self.member_hitboxes.append((x, y, x + DOCK_CARD, y + 49, actor_id))
        if overflow:
            remaining = max(0, len(actors) - (first + rows * columns))
            hint = f"▼ {remaining} more · wheel to scroll" if remaining else "▲ wheel to scroll back"
            self.body.create_text(8, rows * 55 + 5, text=hint, anchor="nw",
                                  fill="#dfbb78", font=ui_font("Consolas", 7))
        if notes or undo:
            self.draw_note_band(notes, undo, grid_height + 2, width - 14)
        # Painting a goblin may have just started its pulse; its words follow at once.
        self.sync_labels()

    def card_status(self, actor: dict) -> MemberStatus:
        """A card's words: its outcome mid-portal, else its status, past tense while a step replays."""
        actor_id = str(actor.get("id") or "")
        leaving = self.owner.exits.get(actor_id)
        if leaving is not None:
            return parting_status(leaving.outcome, str(leaving.actor.get("source") or ""))
        return self.owner.status_for(actor, self.owner.connection)

    def chip(self, right: int, top: int, bottom: int, label: str, command, hint: str,
             fill: str = "#315b45") -> int:
        """One band button, at least NOTE_CHIP in size; returns its left edge."""
        left = right - max(NOTE_CHIP[0], self.note_font.measure(label) + 14)
        c = self.body
        c.create_rectangle(left, top, right, bottom, fill=fill, outline="#dfbb78")
        c.create_text((left + right) // 2, (top + bottom) // 2, text=label, fill="#f6ecd2", font=self.note_font)
        self.note_hitboxes.append((left, top, right, bottom, command, hint))
        return left

    def draw_note_band(self, notes: list[dict], undo: Undo | None, top: int, canvas_width: int) -> None:
        """The newest parting note, one click to read every note and one to dismiss this one.

        Right after a dismissal the band offers UNDO for UNDO_SECONDS, even with no notes left."""
        c = self.body
        owner = self.owner
        bottom = top + NOTE_BAND - 4
        right = canvas_width - 6
        c.create_rectangle(5, top, right, bottom, fill="#272338", outline=LILAC, width=1)
        chip_top, chip_bottom = top + 2, bottom - 2
        left = right - 2
        if undo:
            left = self.chip(left, chip_top, chip_bottom, "UNDO", owner.undo_notes,
                             f"Bring back {undo.label}", fill="#4a3f66") - 4
        if not notes:
            c.create_text(12, (top + bottom) // 2, anchor="w", fill=MUTED, font=self.note_font,
                          text=fit_text(self.note_font, f"✉ Dismissed {undo.label}", left - 20))
            return
        newest = notes[0]
        left = self.chip(left, chip_top, chip_bottom, "×",
                         lambda: owner.dismiss_note(newest["party"], newest["id"]),
                         f"Dismiss the note from {owner.note_name(newest)} (UNDO brings it back)") - 4
        left = self.chip(left, chip_top, chip_bottom, f"READ {len(notes)}" if len(notes) > 1 else "READ",
                         lambda: owner.show_notes(newest["id"]), "Read every parting note in this party")
        unread = sum(not note.get("read") for note in notes)
        more = f" · +{len(notes) - 1} more" if len(notes) > 1 else ""
        new = f" · {unread} new" if unread else ""
        text = (f"✉ {owner.note_name(newest)} · {outcome_word(newest['outcome'], newest.get('source', ''))} · "
                f"{age_label(newest['at'])}{more}{new}")
        c.create_text(12, (top + bottom) // 2, anchor="w", fill=OUTCOME_COLORS.get(newest["outcome"], IVORY),
                      font=self.note_font, text=fit_text(self.note_font, text, left - 20))
        # The rest of the band reads the note; it is listed last so the buttons win a click.
        self.note_hitboxes.append((5, top, right, bottom, lambda: owner.show_notes(newest["id"]),
                                   "Read this parting note"))

    def paint_sprite(self, tag: str, x: int, y: int, style: dict, actor: dict) -> None:
        self.body.delete(tag)
        actor_id = str(actor.get("id"))
        self.owner.paint_member(self.body, ("dock", actor_id), tag, x, y, style, actor,
                                self.owner.connection, exit_beat=self.owner.exit_beat(actor_id),
                                exit_outcome=self.owner.exit_outcome(actor_id))

    def sync_labels(self) -> None:
        """Keep each card's words with its goblin, so a replayed step never reads IDLE."""
        for item, actor in self.labels:
            status = self.card_status(actor)
            text = f"{status.glyph} {status.word}"
            if self.body.itemcget(item, "text") != text:
                self.body.itemconfigure(item, text=text, fill=status.color)

    def animate(self) -> None:
        if self.mode != "compact":
            return
        for sprite in self.sprites:
            self.paint_sprite(*sprite)
        self.sync_labels()

    def note_hit(self, x: int, y: int):
        return next((box for box in self.note_hitboxes if box[0] <= x <= box[2] and box[1] <= y <= box[3]), None)

    def on_member_click(self, event: tk.Event) -> None:
        self.hide_tooltip()
        box = self.note_hit(event.x, event.y)
        if box:
            box[4]()
            return
        for left, top, right, bottom, actor_id in self.member_hitboxes:
            if left <= event.x <= right and top <= event.y <= bottom:
                self.owner.peek_member(actor_id)
                return

    def on_member_hover(self, event: tk.Event) -> None:
        box = self.note_hit(event.x, event.y)
        if box:
            self.hover_member = None
            self.status_strip.configure(text=fit_text(self.status_font, box[5], max(40, self.window.winfo_width() - 24)))
            return
        for left, top, right, bottom, actor_id in self.member_hitboxes:
            if left <= event.x <= right and top <= event.y <= bottom:
                actor = next((item for item in self.owner.actors if str(item.get("id")) == actor_id), None)
                if actor:
                    self.hide_tooltip()
                    self.show_member_status(actor)
                return
        self.show_base_status()

    def scroll_members(self, event: tk.Event) -> str:
        actors = [actor for actor in self.owner.visible_actors()
                  if str(actor.get("id") or "") not in ("", "all", "standby")]
        columns = max(1, len({box[0] for box in self.member_hitboxes}))
        total_rows = max(1, (len(actors) + columns - 1) // columns)
        self.row_offset = max(0, min(max(0, total_rows - 3),
                                      self.row_offset + (-1 if event.delta > 0 else 1)))
        self.refresh()
        return "break"

    def start_drag(self, event: tk.Event) -> None:
        self.hide_tooltip()
        self.drag_start = (event.x_root, event.y_root, self.window.winfo_x(), self.window.winfo_y())

    def drag(self, event: tk.Event) -> None:
        if self.drag_start:
            px, py, x, y = self.drag_start
            self.window.geometry(f"+{x + event.x_root - px}+{y + event.y_root - py}")

    def end_drag(self, event: tk.Event) -> None:
        start, self.drag_start = self.drag_start, None
        # A plain click on the header is not a move: nothing to remember, nothing to write.
        if not start or (event.x_root, event.y_root) == start[:2]:
            return
        self.owner.dock_x = self.window.winfo_x() + self.window.winfo_width()
        self.owner.dock_y = self.window.winfo_y() + self.window.winfo_height()
        self.owner.save_position()

    def start_tab_drag(self, event: tk.Event) -> None:
        self.tab_moved = False
        self.start_drag(event)

    def drag_tab(self, event: tk.Event) -> None:
        if self.drag_start:
            self.tab_moved = self.tab_moved or abs(event.x_root - self.drag_start[0]) + abs(event.y_root - self.drag_start[1]) > 4
            if self.tab_moved:
                self.drag(event)

    def end_tab_drag(self, event: tk.Event) -> None:
        if self.tab_moved:
            self.end_drag(event)
        else:
            self.drag_start = None
            self.owner.restore_hidden_party()

    def destroy(self) -> None:
        self.hide_tooltip()
        self.window.destroy()


class NotesPanel:
    """The selected party's parting notes, newest first, each with open-chat and dismiss.

    The panel sizes itself to its notes (one note is a short card, many scroll with the
    wheel or the scrollbar) and can be dragged by its header. It stays on top like every
    other widget surface: it has no taskbar entry, so a panel that fell behind a window
    would be lost. It opens beside the roster or stream rather than over it, and × or Esc
    closes it."""

    WIDTH = 420
    HEIGHT = 360  # The tallest it grows before its notes scroll.
    MIN_HEIGHT = 120
    COLORS = OUTCOME_COLORS

    def __init__(self, owner) -> None:
        self.owner = owner
        self.shown = False
        self.focus_id = ""
        self.fingerprint = ""
        self.cards: dict[str, tk.Frame] = {}
        self.height = self.MIN_HEIGHT
        self.drag_start: tuple[int, int, int, int] | None = None
        self.moved_to: tuple[int, int] | None = None  # Where someone dragged it, kept for the session.
        self.window = tk.Toplevel(owner.root)
        self.window.withdraw()
        float_window(self.window)
        self.window.configure(bg=LILAC)
        self.window.title("Goblin Horde · Parting notes")
        shell = tk.Frame(self.window, bg=PANEL, bd=0)
        shell.pack(fill="both", expand=True, padx=2, pady=2)
        header = tk.Frame(shell, bg=PANEL_HEADER, cursor="fleur")
        header.pack(fill="x")
        self.header = header
        self.close_button = dock_button(header, "×", self.withdraw)
        self.close_button.pack(side="right", padx=(2, 3), pady=3)
        self.clear_button = dock_button(header, "CLEAR ALL", owner.clear_notes)
        self.clear_button.pack(side="right", padx=2, pady=3)
        self.undo_button = dock_button(header, "UNDO", owner.undo_notes)
        self.undo_button.configure(bg="#4a3f66")
        self.title_font = tkfont.Font(family=ui_family("Consolas"), size=9, weight="bold")
        self.title = tk.Label(header, text="✉ PARTING NOTES", bg=PANEL_HEADER, fg=IVORY,
                              font=self.title_font, anchor="w", padx=8, cursor="fleur")
        self.title.pack(side="left", fill="x", expand=True)
        for surface in (header, self.title):
            surface.bind("<ButtonPress-1>", self.start_drag)
            surface.bind("<B1-Motion>", self.drag)
            surface.bind("<ButtonRelease-1>", self.end_drag)
        body = tk.Frame(shell, bg=PANEL)
        body.pack(fill="both", expand=True)
        self.scrollbar = tk.Scrollbar(body, width=12, bg="#456650", troughcolor="#11261d",
                                      activebackground=GOLD, bd=0, highlightthickness=0)
        self.scrollbar.pack(side="right", fill="y", padx=(0, 2), pady=2)
        text_font = tkfont.Font(family=ui_family("Consolas"), size=9)
        # Sized in characters to the panel's width, so text wraps the same before it is first shown.
        self.text = tk.Text(body, wrap="word", bg=PANEL, fg=IVORY, relief="flat", bd=0, padx=6, pady=6,
                            font=text_font, cursor="arrow", highlightthickness=0,
                            width=max(20, (self.WIDTH - 40) // max(1, text_font.measure("0"))),
                            height=4, yscrollcommand=self.scrollbar.set)
        self.text_font = text_font
        self.text.pack(side="left", fill="both", expand=True)
        self.scrollbar.configure(command=self.text.yview)
        self.text.tag_configure("muted", foreground=MUTED)
        self.text.configure(state="disabled")
        for surface in (self.text, self.scrollbar, body):
            surface.bind("<MouseWheel>", self.on_wheel)
        self.window.bind("<Escape>", lambda _event: self.withdraw())
        self.window.protocol("WM_DELETE_WINDOW", self.withdraw)  # Alt+F4 closes it like ×.

    def show(self, focus_id: str = "") -> None:
        self.shown = True
        self.focus_id = focus_id
        self.owner.mark_notes_read()
        self.refresh(force=True)
        self.window.deiconify()
        self.window.lift()
        self.window.focus_force()

    def withdraw(self) -> None:
        self.shown = False
        self.window.withdraw()

    def refresh(self, force: bool = False) -> None:
        """Rebuild only when the notes change, so polls never reset someone's reading position."""
        if not self.shown:
            return
        notes = self.owner.party_notes()
        undo = self.owner.party_undo()
        fingerprint = repr((self.owner.source_name, [(note["id"], note["at"], self.owner.note_name(note))
                                                     for note in notes], undo and (undo.label, len(undo.notes))))
        if fingerprint == self.fingerprint and not force:
            return
        self.fingerprint = fingerprint
        count = f"{len(notes)} {'NOTE' if len(notes) == 1 else 'NOTES'}"
        if undo and not self.undo_button.winfo_manager():
            self.undo_button.pack(side="right", padx=2, pady=3, before=self.clear_button)
        elif not undo and self.undo_button.winfo_manager():
            self.undo_button.pack_forget()
        controls = sum(button.winfo_reqwidth() + 4 for button in (self.close_button, self.clear_button,
                                                                  *((self.undo_button,) if undo else ())))
        self.title.configure(text=fit_text(self.title_font, f"✉ {count} · {self.owner.source_name}",
                                           self.WIDTH - controls - 24))
        self.clear_button.configure(state="normal" if notes else "disabled")
        self.text.configure(state="normal")
        self.text.delete("1.0", "end")
        for card in self.cards.values():
            card.destroy()
        self.cards = {}
        if undo:
            self.text.insert("end", f"Dismissed {undo.label}. UNDO brings it back.", "muted")
        if not notes:
            self.text.insert("end", ("\n" if undo else "") + "No parting notes in this party. A goblin leaves "
                             "one when it is seen ending a turn, stopping, or leaving the party list.", "muted")
        for note in notes:
            card = self.card(note)
            self.cards[note["id"]] = card
            # Lines go between items only, so no blank line pads the bottom of the panel.
            if self.text.index("end-1c") != "1.0":
                self.text.insert("end", "\n")
            self.text.window_create("end", window=card, padx=1, pady=4)
        self.text.configure(state="disabled")
        self.fit_height()
        self.place()
        if self.focus_id in self.cards:
            self.text.update_idletasks()
            self.text.see(str(self.cards[self.focus_id]))  # An embedded window's name is a text index.

    def fit_height(self) -> None:
        """Just tall enough for its notes, up to HEIGHT; the rest scrolls."""
        self.window.update_idletasks()
        try:
            content = int(self.text.tk.call(self.text._w, "count", "-update", "-ypixels", "1.0", "end"))
        except (tk.TclError, ValueError):
            content = sum(card.winfo_reqheight() + 9 for card in self.cards.values()) + 60
        # The text's own top and bottom padding, the panel border, and a pixel of slack.
        self.height = max(self.MIN_HEIGHT, min(self.HEIGHT, self.header.winfo_reqheight() + content + 12 + 4 + 2))

    def card(self, note: dict) -> tk.Frame:
        title, meta, reported, seen = note_lines(note, self.owner.note_name(note))
        color = self.COLORS.get(note["outcome"], MUTED)
        wrap = self.WIDTH - 66
        outer = tk.Frame(self.text, bg=PANEL)
        tk.Frame(outer, bg=color, width=4).pack(side="left", fill="y")
        inner = tk.Frame(outer, bg="#1e392d", width=wrap + 16)
        inner.pack(side="left", fill="both", expand=True)
        labels = [tk.Label(inner, text=title, bg="#1e392d", fg=color, font=ui_font("Consolas", 9, "bold"),
                           anchor="w", justify="left", wraplength=wrap),
                  tk.Label(inner, text=meta, bg="#1e392d", fg=MUTED, font=ui_font("Consolas", 8),
                           anchor="w", justify="left", wraplength=wrap),
                  tk.Label(inner, text=reported, bg="#1e392d", fg=IVORY if note.get("reported") else MUTED,
                           font=ui_font("Consolas", 9), anchor="w", justify="left", wraplength=wrap)]
        if seen:
            labels.append(tk.Label(inner, text=seen, bg="#1e392d", fg="#c4d6bd", font=ui_font("Consolas", 8),
                                   anchor="w", justify="left", wraplength=wrap))
        for label in labels:
            label.pack(fill="x", padx=8, pady=(4 if label is labels[0] else 0, 2))
        actions = tk.Frame(inner, bg="#1e392d")
        actions.pack(fill="x", padx=8, pady=(2, 6))
        buttons = [dock_button(actions, "OPEN CHAT", lambda: self.owner.open_note_chat(note)),
                   dock_button(actions, "DISMISS", lambda: self.owner.dismiss_note(note["party"], note["id"]))]
        buttons[0].pack(side="left")
        buttons[1].pack(side="left", padx=(4, 0))
        # The wheel scrolls the list from anywhere on a card, buttons included.
        for widget in (outer, inner, actions, *labels, *buttons):
            widget.bind("<MouseWheel>", self.on_wheel)
        return outer

    def on_wheel(self, event: tk.Event) -> str:
        notches = max(1, abs(int(event.delta)) // 120)
        try:
            self.text.yview_scroll((-40 if event.delta > 0 else 40) * notches, "pixels")
        except tk.TclError:
            self.text.yview_scroll(-notches if event.delta > 0 else notches, "units")
        return "break"

    def start_drag(self, event: tk.Event) -> None:
        self.drag_start = (event.x_root, event.y_root, self.window.winfo_x(), self.window.winfo_y())

    def drag(self, event: tk.Event) -> None:
        if self.drag_start:
            px, py, x, y = self.drag_start
            self.moved_to = (x + event.x_root - px, y + event.y_root - py)
            self.window.geometry(f"+{self.moved_to[0]}+{self.moved_to[1]}")

    def end_drag(self, _event: tk.Event) -> None:
        self.drag_start = None

    def place(self) -> None:
        """Where it was dragged, else beside the party roster or the focused stream."""
        owner = self.owner
        left, top, right, bottom = monitor_work_area(owner.root)
        if self.moved_to:
            x, y = self.moved_to
        else:
            anchor = owner.party_dock.window if owner.party_dock.window.winfo_ismapped() else next(
                (stream.window for stream in owner.streams.values() if stream.window.winfo_ismapped()), owner.root)
            x = anchor.winfo_x() - self.WIDTH - 10
            if x < left:
                x = anchor.winfo_x() + anchor.winfo_width() + 10
            y = anchor.winfo_y()
        x = max(left, min(x, right - self.WIDTH))
        y = max(top, min(y, bottom - self.height))
        self.window.geometry(f"{self.WIDTH}x{self.height}{screen_geometry(x, y)}")

    def destroy(self) -> None:
        self.window.destroy()


class Launchpad:
    """Home view: parties working now, recently used parties, and search for everything else.

    Working parties get tall rows with their goblins huddled together and animated by public
    activity. Recently used parties get quiet one-line rows. Older chats stay off screen until
    FIND, so a long history never crowds the parties that matter now.
    """

    def __init__(self, owner) -> None:
        self.owner = owner
        self.shown = False
        self.searching = False
        self.show_all_working = False
        self.selection = 0
        self.results: list[dict] = []
        self.row_tops: list[int] = []
        self.content = 1
        self.hitboxes: list[tuple[int, int, int, int, object, str]] = []
        self.sprites: list[tuple[str, int, int, dict, dict]] = []
        self.fingerprint = ""
        self.base_status = "LOADING PARTIES…"
        self.drag_start: tuple[int, int, int, int] | None = None
        self.dragged = False
        # Bahnschrift and Segoe UI ship with Windows 10 and 11; Tk substitutes a close font elsewhere.
        self.title_font = tkfont.Font(family=ui_family("Bahnschrift"), size=11, weight="bold")
        self.row_font = tkfont.Font(family=ui_family("Bahnschrift"), size=11, weight="bold")
        self.small_font = tkfont.Font(family=ui_family("Segoe UI"), size=8)
        self.tag_font = tkfont.Font(family=ui_family("Bahnschrift"), size=8, weight="bold")
        self.window = tk.Toplevel(owner.root)
        self.window.withdraw()
        float_window(self.window)
        self.window.configure(bg=GOLD)
        self.window.title("Goblin Horde · All parties")
        shell = tk.Frame(self.window, bg=PANEL, bd=2, relief="solid")
        shell.pack(fill="both", expand=True, padx=2, pady=2)
        self.header = tk.Frame(shell, bg=PANEL_HEADER)
        self.header.pack(fill="x")
        for label, command in (("HIDE", owner.hide_party), ("⋯", self.show_menu)):
            dock_button(self.header, label, command).pack(side="right", padx=2, pady=3)
        self.find_button = dock_button(self.header, "FIND ⌕", self.toggle_search)
        self.find_button.pack(side="right", padx=2, pady=3)
        self.title = tk.Label(self.header, text="ALL PARTIES", bg=PANEL_HEADER,
                              fg=IVORY, font=self.title_font, anchor="w", padx=8)
        self.title.pack(side="left", fill="x", expand=True)
        self.status = tk.Label(shell, text=self.base_status, bg=PANEL, fg=MUTED,
                               font=ui_font("Segoe UI", 7), anchor="w", padx=8)
        self.status.pack(fill="x")
        self.search_row = tk.Frame(shell, bg=PANEL)
        self.query = tk.StringVar(self.window)
        self.entry = tk.Entry(self.search_row, textvariable=self.query, bg="#0f2018", fg=IVORY,
                              insertbackground=GOLD, relief="solid", bd=1, font=ui_font("Consolas", 10))
        self.entry.pack(side="left", fill="x", expand=True, padx=(6, 3), pady=(4, 2), ipady=2)
        dock_button(self.search_row, "×", self.stop_search).pack(side="right", padx=(0, 6), pady=(4, 2))
        self.body = tk.Canvas(shell, bg=PANEL, bd=0, highlightthickness=0, cursor="hand2",
                              width=LAUNCHPAD_WIDTH - 12, height=120, yscrollincrement=QUIET_ROW)
        self.body.pack(fill="both", expand=True, padx=2, pady=(2, 4))

        for surface in (self.header, self.title, self.status):
            surface.bind("<ButtonPress-1>", self.start_drag)
            surface.bind("<B1-Motion>", self.drag)
            surface.bind("<ButtonRelease-1>", self.end_drag)
        for surface in (self.header, self.title, self.status):
            bind_context(surface, lambda _event: self.show_menu())
        # On a party row the menu offers joining or separating it; elsewhere it is the launchpad menu.
        bind_context(self.body, self.show_row_menu)
        self.body.bind("<Button-1>", self.on_click)
        self.body.bind("<Motion>", self.on_hover)
        self.body.bind("<Leave>", lambda _event: self.clear_hover())
        self.body.bind("<MouseWheel>", self.on_wheel)
        self.entry.bind("<KeyRelease>", self.on_query)
        self.entry.bind("<Return>", lambda _event: self.open_selection())
        self.entry.bind("<Escape>", lambda _event: self.stop_search())
        self.entry.bind("<Down>", lambda _event: self.move_selection(1))
        self.entry.bind("<Up>", lambda _event: self.move_selection(-1))
        self.entry.bind("<MouseWheel>", self.on_wheel)
        self.window.bind("<Key>", self.type_to_search)
        # Alt+F4 collapses the launchpad to its tab, as HIDE does, instead of destroying it.
        self.window.protocol("WM_DELETE_WINDOW", owner.hide_party)

    # Visibility -----------------------------------------------------------
    def show(self) -> None:
        self.shown = True
        # Measure the header before sizing, and paint before Windows shows the window.
        self.window.update_idletasks()
        self.refresh(force=True)
        self.window.update_idletasks()
        self.window.deiconify()
        self.window.lift()

    def withdraw(self) -> None:
        self.shown = False
        self.window.withdraw()

    def destroy(self) -> None:
        self.window.destroy()

    # Search ---------------------------------------------------------------
    def toggle_search(self) -> None:
        self.stop_search() if self.searching else self.start_search()

    def start_search(self, query: str = "") -> None:
        self.searching = True
        self.selection = 0
        self.query.set(query)
        if not self.search_row.winfo_manager():
            self.search_row.pack(fill="x", before=self.body)
            self.window.update_idletasks()
        self.find_button.configure(text="CLOSE ⌕")
        self.owner.refresh_catalog()
        self.body.yview_moveto(0)
        self.refresh(force=True)
        self.entry.focus_force()
        self.entry.icursor("end")

    def stop_search(self, redraw: bool = True) -> None:
        self.searching = False
        self.query.set("")
        if self.search_row.winfo_manager():
            self.search_row.pack_forget()
        self.find_button.configure(text="FIND ⌕")
        self.body.yview_moveto(0)
        if redraw:
            self.refresh(force=True)

    def type_to_search(self, event: tk.Event) -> None:
        if not self.searching and event.char and event.char.isprintable() and not event.char.isspace():
            self.start_search(event.char)

    def on_query(self, event: tk.Event) -> None:
        if event.keysym in ("Up", "Down", "Return", "Escape"):
            return
        self.selection = 0
        self.body.yview_moveto(0)
        self.refresh()

    def move_selection(self, amount: int) -> str:
        if self.results:
            self.selection = max(0, min(len(self.results) - 1, self.selection + amount))
            self.refresh(force=True)
            top = self.row_tops[self.selection] if self.selection < len(self.row_tops) else 0
            first, last = self.body.yview()
            total = max(1, self.content)
            if top < first * total or top + QUIET_ROW > last * total:
                self.body.yview_moveto(max(0, top - QUIET_ROW * 2) / total)
        return "break"

    def open_selection(self, view: str = "compact") -> None:
        if self.results:
            self.open_source(self.results[min(self.selection, len(self.results) - 1)], view)

    def open_source(self, source: dict, view: str, focus_id: str = "", peek: bool = False) -> None:
        party_id = party_scope(source)
        name = str(source.get("name") or source.get("nickname") or party_id)
        self.stop_search(redraw=False)
        self.owner.choose_party(party_id, name, view, focus_id=focus_id, peek=peek)

    # Drawing --------------------------------------------------------------
    def refresh(self, force: bool = False) -> None:
        if not self.shown:
            return
        owner = self.owner
        active, recent, older = owner.board_cards()
        query = self.query.get().strip() if self.searching else ""
        self.results = search_sources(owner.source_catalog, query, limit=80) if self.searching else []
        connection = owner.board_connection

        def card_key(card) -> tuple:
            return (card.id, card.name, card.rank, card.needs, card.failed, card.working,
                    age_label(card.updated_ms), card.agent_count,
                    tuple((str(member.get("id")), member_status(member).word, goblin_action(member))
                          for member in card.members[:4]))

        def result_key(source: dict) -> tuple:
            # Every field a result row draws, so a refreshed catalog repaints renamed or moved chats.
            return (party_scope(source), source.get("name"), project_for(source)[1], source.get("updatedAt"))

        fingerprint = repr((
            self.searching, query, self.selection, [result_key(source) for source in self.results],
            owner.thread_id, owner.source_name, owner.party_view, connection, owner.paused,
            int((time.time() - owner.board_success) / 60) if owner.board_success else -1,
            [card_key(card) for card in active], [card_key(card) for card in recent], older,
            len(owner.source_catalog), owner.catalog_failed, owner.palette_offset,
            self.show_all_working, coverage_note(owner.board_coverage),
            tuple(owner.watched_ids), tuple(owner.catalog_unavailable), int(owner.board_age) // 10, owner.welcomed,
            tuple((key, str(value.get("state")), bool(value.get("canConnect"))) for key, value in sorted(owner.sources.items())),
        ))
        if fingerprint == self.fingerprint and not force:
            return
        self.fingerprint = fingerprint
        self.base_status = self.status_line(active, recent, older, connection)
        self.status.configure(text=self.base_status)
        self.draw(active, recent, older)

    def status_line(self, active, recent, older, connection: str) -> str:
        if self.searching:
            return "TYPE TO FILTER · ↑↓ CHOOSE · ENTER OPENS ROSTER · ESC CLOSES"
        if self.owner.paused:
            state = "PAUSED"
        elif connection == "CONNECTING":
            return "LOADING PARTIES…"
        elif connection == "STALE":
            state = f"STALE {max(0, int((time.time() - self.owner.board_success) / 60))}m · LAST GOOD LIST"
        elif connection == "OFFLINE":
            return "OFFLINE · GOBLIN HORDE IS NOT ANSWERING · RETRYING"
        elif connection == "PARTIAL":
            state = coverage_note(self.owner.board_coverage) or "PARTIAL FEED"
        elif self.owner.board_age >= 20:
            # The server answered with the last scene it built while a fresher one is on its way.
            state = f"UPDATED {int(self.owner.board_age)}s AGO"
        else:
            state = connection
        parts = [state, f"{len(active)} WORKING"]
        needs = sum(card.needs for card in active)
        failed = sum(card.failed for card in active)
        if needs:
            parts.append(f"{needs} NEED YOU")
        if failed:
            parts.append(f"{failed} FAILED")
        parts.append(f"{len(recent)} RECENT")
        if older:
            parts.append(f"{older} MORE IN FIND")
        return " · ".join(parts)

    def draw(self, active, recent, older) -> None:
        c = self.body
        c.delete("all")
        self.hitboxes = []
        self.row_parties = []
        self.sprites = []
        self.row_tops = []
        width = LAUNCHPAD_WIDTH - 12
        y = 4
        if self.searching:
            y = self.draw_results(y, width)
        else:
            y = self.draw_sources(y, width)
            if not self.owner.welcomed and not self.owner.demo:
                y = self.draw_welcome(y, width)
            if self.owner.thread_id != "all":
                y = self.draw_current(y, width)
            needs = sum(card.needs for card in active)
            y = self.section(y, width, f"▶ WORKING NOW · {len(active)}", GOLD if needs else LIVELY)
            if not active:
                gap = coverage_note(self.owner.board_coverage)
                c.create_text(14, y + 4, anchor="nw", fill=MUTED, font=self.small_font,
                              text=f"None seen yet · {gap.lower()}." if gap and self.owner.board_connection == "PARTIAL"
                              else "No goblins are working right now.")
                y += 24
            rows, folded = compact_active(active, ACTIVE_LIMIT)
            for card in active if self.show_all_working else rows:
                y = self.draw_active(card, y, width)
            if folded:
                y = self.draw_fold(y, width, 0 if self.show_all_working else folded)
            watching = self.owner.board_watching
            if watching:
                y = self.section(y + 2, width, f"★ WATCHING · {len(watching)}", GOLD)
                for card in watching:
                    y = self.draw_quiet(card.id, card.name, card.project, card.updated_ms, y, width,
                                        models=card.models)
            y = self.section(y + 2, width, f"◷ RECENTLY USED · {len(recent)}", MUTED)
            if not recent:
                c.create_text(14, y + 4, anchor="nw", fill=MUTED, font=self.small_font,
                              text="Nothing else used in the past week.")
                y += 24
            for card in recent:
                y = self.draw_quiet(card.id, card.name, card.project, card.updated_ms, y, width, models=card.models)
            y = self.draw_footer(y + 4, width, older)
        content = self.content = y + 4
        left, top, right, bottom = monitor_work_area(self.owner.root)
        chrome = (self.header.winfo_reqheight() + self.status.winfo_reqheight()
                  + (self.search_row.winfo_reqheight() if self.searching else 0) + 14)
        limit = int((bottom - top) * 0.75) - chrome
        # Search keeps one steady height so the window does not jump while someone types.
        view = min(24 + 14 * QUIET_ROW, limit) if self.searching else max(60, min(content, limit))
        c.configure(height=view, scrollregion=(0, 0, width, content))
        if content <= view:
            c.yview_moveto(0)
        c.create_rectangle(0, 0, 0, 0, outline=GOLD, width=1, state="hidden", tags="hover")
        place_at_anchor(self.owner, self.window, LAUNCHPAD_WIDTH, view + chrome)

    WELCOME = (
        "Each goblin is one AI agent at work. Claude models are hooded hexers, OpenAI models are sappers, "
        "and everything else is a raider; the badge beside a party names its model.",
        "Gold means it needs you, red means it failed, green means it is working. Click a party for its "
        "goblins, or EXPAND for what each one is saying and doing.",
        "☆ keeps a chat on this list. The row above shows what is connected; FIX repairs it. "
        "The ⋯ menu has the rest, including Start with Windows.",
    )

    def draw_welcome(self, y: int, width: int) -> int:
        """A one-time card that says what the goblins, colours, and buttons mean."""
        c = self.body
        lines = [line for paragraph in self.WELCOME for line in [*wrap_text(self.small_font, paragraph, width - 32), ""]][:-1]
        step = self.small_font.metrics("linespace") + 1
        bottom = y + 28 + len(lines) * step + 6
        c.create_rectangle(4, y, width - 4, bottom, fill="#2b4a39", outline=GOLD, width=2)
        c.create_text(14, y + 7, anchor="nw", text="WELCOME TO GOBLIN HORDE", fill=GOLD, font=self.tag_font)
        self.chip(width - 12, y + 5, "GOT IT", self.owner.dismiss_welcome, "Hide this card", strong=True)
        for index, line in enumerate(lines):
            c.create_text(14, y + 28 + index * step, anchor="nw", text=line, fill=IVORY, font=self.small_font)
        return bottom + 6

    SOURCE_NAMES = (("codex", "CODEX"), ("claude", "CLAUDE"), ("orca", "ORCA"), ("extensions", "FEEDS"))

    def draw_sources(self, y: int, width: int) -> int:
        """One row naming every feed: ✓ connected, … starting, ✕ needs a fix (click to fix), – not in use."""
        owner = self.owner
        sources = owner.sources
        if not sources:
            return y
        c = self.body
        x = 8
        for key, name in self.SOURCE_NAMES:
            source = sources.get(key)
            if not isinstance(source, dict):
                continue  # A viewer that does not report this feed says nothing about it.
            state = str(source.get("state") or "")
            detail = str(source.get("detail") or "")
            command = None
            action = ""
            if state == "ok":
                glyph, ink = "✓", LIVELY
            elif state == "starting":
                glyph, ink = "…", MUTED
            elif key == "claude" and state == "not-connected":
                # Optional: someone who uses only Codex is not told something is wrong.
                glyph, ink = "–", "#7f9a88"
                if source.get("canConnect"):
                    command, action, ink = owner.connect_claude, " CONNECT", GOLD
                    detail = f"{detail} Click to connect it."
            elif state in ("none", "not-installed") or (key == "orca" and state == "unavailable"):
                glyph, ink = "–", "#7f9a88"
            else:
                glyph, ink = "✕", ALERT
                if key == "codex":
                    command, action, detail = owner.reconnect_codex, " FIX", f"{detail} Click to reconnect now."
            if key == "codex" and state == "ok":
                detail += " Replies from the browser or phone are available."
            elif state == "ok" and source.get("replies") is False:
                detail += " Watch-only here: reply in the app itself."
            label = f"{name} {glyph}{action}"
            right = x + self.tag_font.measure(label) + 12
            c.create_rectangle(x, y, right, y + 17, fill=PILL_INK, outline=ink if command else CARD_LINE)
            c.create_text((x + right) // 2, y + 9, text=label, fill=ink, font=self.tag_font)
            self.hitboxes.append((x, y, right, y + 17, command or (lambda: None), detail))
            x = right + 5
        return y + 24

    def section(self, y: int, width: int, text: str, color: str) -> int:
        self.body.create_text(8, y + 4, anchor="nw", text=text, fill=color, font=self.tag_font)
        start = 14 + self.tag_font.measure(text)
        self.body.create_line(start, y + 11, width - 6, y + 11, fill=CARD_LINE)
        return y + 22

    def chip(self, right: int, top: int, label: str, command, tip: str = "", strong: bool = False) -> int:
        """Draw a small right-aligned button and return its left edge."""
        left = right - self.tag_font.measure(label) - 14
        self.body.create_rectangle(left, top, right, top + 17, fill=BUTTON if strong else "#24402f",
                                   outline=GOLD if strong else "#4f7a60")
        self.body.create_text((left + right) // 2, top + 9, text=label, fill=IVORY, font=self.tag_font)
        self.hitboxes.append((left, top, right, top + 17, command, tip))
        return left

    def watch_chip(self, right: int, top: int, party_id: str, name: str) -> int:
        """☆ watches a party: the server always reads it and it stays on the launchpad. ★ stops."""
        owner = self.owner
        if not party_id or party_id == "all" or owner.demo:
            return right + 4
        watched = owner.is_watched(party_id)
        tip = (f"Stop watching {name}: read it only while in use or when opened" if watched
               else f"Watch {name}: always read it and keep it on the launchpad")
        return self.chip(right, top, "★" if watched else "☆", lambda: owner.set_watched(party_id, not watched), tip,
                         strong=watched)

    def model_chip(self, left: int, middle: int, models, room: int, effort: bool = False) -> int:
        """A dark badge naming the party's model (and how many more), tinted by its family; returns its right edge."""
        if not models or room < 40:
            return left
        first = models[0]
        label = str(first.get("label") or "").upper()
        if effort and first.get("effort"):
            label += f" · {str(first['effort']).upper()}"
        if len(models) > 1:
            label += f" +{len(models) - 1}"
        label = fit_text(self.tag_font, label, room - 12)
        right = left + self.tag_font.measure(label) + 12
        ink = family_ink({"model": first})
        self.body.create_rectangle(left, middle - 8, right, middle + 8, fill=PILL_INK, outline=ink)
        self.body.create_text((left + right) // 2, middle, text=label, fill=ink, font=self.tag_font)
        return right

    def draw_current(self, y: int, width: int) -> int:
        owner = self.owner
        c = self.body
        c.create_rectangle(4, y, width - 4, y + 42, fill="#2b4a39", outline=GOLD, width=2)
        self.hitboxes.append((4, y, width - 4, y + 42, owner.restore_party_view,
                              f"Return to {owner.source_name} as the {('roster' if owner.party_view == 'compact' else 'streams')}"))
        c.create_text(12, y + 5, anchor="nw", fill=GOLD, font=self.tag_font,
                      text=f"◆ YOUR PARTY · LAST VIEW {'ROSTER' if owner.party_view == 'compact' else 'STREAMS'}")
        left = self.chip(width - 10, y + 19, "EXPAND", owner.expand_party,
                          "Open the members' streams; windows you closed stay closed")
        left = self.chip(left - 4, y + 19, "CONDENSE", owner.condense_party, "Open the party roster")
        c.create_text(12, y + 21, anchor="nw", fill=IVORY, font=self.row_font,
                      text=fit_text(self.row_font, owner.source_name, left - 22))
        return y + 48

    @staticmethod
    def signal_label(card) -> str:
        """The pill under a party's name, the same words as the browser launchpad."""
        if card.needs:
            questions = sum(len((member.get("turnStates") or [{}])[-1].get("questions") or []) for member in card.members)
            return f"NEEDS YOU · {questions} QUESTION{'S' if questions != 1 else ''}" if questions else f"NEEDS YOU · {card.needs} WAITING"
        if card.failed:
            for member in card.members:
                for item in reversed(member.get("activities") or []):
                    if item.get("status") == "failed" or item.get("exitCode") not in (None, 0):
                        return f"FAILED · {str(item.get('title') or 'A STEP').upper()}"
            return f"{card.failed} FAILED"
        if len(card.members) == 1:
            return member_status(card.members[0]).word
        return f"{card.working} WORKING"

    def draw_active(self, card, y: int, width: int) -> int:
        """One working party: a status stripe, its name over a signal pill, and its goblins on the right."""
        owner = self.owner
        c = self.body
        bottom = y + ACTIVE_ROW - 4
        color = GOLD if card.needs else ALERT if card.failed else LIVELY
        stale = owner.board_connection in ("STALE", "OFFLINE")
        selected = card.id == owner.thread_id
        c.create_rectangle(4, y, width - 4, bottom, fill=CARD_FILL,
                           outline=GOLD if selected or card.needs else CARD_LINE, width=2 if selected or card.needs else 1)
        c.create_rectangle(4, y, 10, bottom, fill=color, outline="")
        self.hitboxes.append((4, y, width - 4, bottom,
                              lambda: owner.choose_party(card.id, card.name, "compact"),
                              f"{card.name} · {card.project} · open roster · right-click to join or separate"))
        self.row_parties.append((4, y, width - 4, bottom, card.id, card.name))
        members = card.members[:4]
        goblins_left = width - 10 - len(members) * GOBLIN_STEP
        for index, member in enumerate(members):
            gx = goblins_left + index * GOBLIN_STEP
            tag = f"lp-sprite-{len(self.sprites)}"
            self.sprites.append((tag, gx, y + 22, owner.stream_style(member), member))
            self.paint_sprite(tag, gx, y + 22, owner.stream_style(member), member)
            status = member_status(member)
            self.hitboxes.append((gx + 2, y + 20, gx + GOBLIN_STEP - 2, bottom,
                                  lambda member_id=str(member.get("id")): owner.choose_party(
                                      card.id, card.name, "compact", focus_id=member_id, peek=True),
                                  " · ".join(part for part in (owner.display_name(member), tribe_title(member),
                                                               model_badge(member, with_effort=True), status.word,
                                                               join_reason(member))
                                             if part) + " · peek this goblin"))
        extra = card.agent_count - len(members)
        if extra > 0:
            c.create_text(goblins_left - 4, y + 42, anchor="e", text=f"+{extra}", fill=GOLD, font=self.tag_font)
            goblins_left -= 4 + self.tag_font.measure(f"+{extra}")
        chip_left = self.chip(width - 10, y + 3, "EXPAND", lambda: owner.choose_party(card.id, card.name, "expanded"),
                              f"Open every stream in {card.name}", strong=True)
        chip_left = self.watch_chip(chip_left - 4, y + 3, card.id, card.name)
        title = ("◆ " if selected else "★ " if owner.is_watched(card.id) else "") + card.name
        c.create_text(18, y + 5, anchor="nw", fill=IVORY, font=self.row_font,
                      text=fit_text(self.row_font, title, min(chip_left, goblins_left) - 26))
        # The signal pill: what is most urgent, in a few plain words, on dark ink.
        label = fit_text(self.tag_font, self.signal_label(card), goblins_left - 48)
        pill_right = 18 + self.tag_font.measure(label) + 14
        c.create_rectangle(16, y + 33, pill_right, y + 50, fill=PILL_INK, outline=CARD_LINE if stale else PILL_INK)
        c.create_text(23, y + 42, anchor="w", text=label, font=self.tag_font, fill=MUTED if stale else color)
        # Which model the party runs sits right beside what it is doing.
        model_right = self.model_chip(pill_right + 6, y + 42, card.models, goblins_left - pill_right - 14)
        meta = " · ".join(part for part in (card.source, age_label(card.updated_ms)) if part)
        meta_left = model_right + 6 if model_right > pill_right + 6 else pill_right + 6
        room = goblins_left - meta_left - 8
        if room > 40:
            c.create_text(meta_left, y + 42, anchor="w", fill=MUTED, font=self.small_font,
                          text=fit_text(self.small_font, meta, room))
        return y + ACTIVE_ROW

    def draw_fold(self, y: int, width: int, folded: int) -> int:
        """One row that reveals or folds the quieter working parties."""
        def toggle() -> None:
            self.show_all_working = not self.show_all_working
            self.refresh(force=True)
        label = f"▾ SHOW {folded} MORE WORKING" if folded else "▴ SHOW FEWER"
        tip = "List every working party" if folded else "Keep the working list short"
        self.body.create_rectangle(4, y, width - 4, y + 20, fill="#1a3026", outline="#2a4436")
        self.body.create_text(width // 2, y + 10, text=label, fill=LIVELY, font=self.tag_font)
        self.hitboxes.append((4, y, width - 4, y + 20, toggle, tip))
        return y + 24

    def draw_quiet(self, party_id: str, name: str, project: str, updated_ms: float, y: int, width: int,
                   highlighted: bool = False, source: dict | None = None, models=()) -> int:
        owner = self.owner
        c = self.body
        selected = party_id == owner.thread_id
        bottom = y + QUIET_ROW - 3
        self.row_tops.append(y)
        c.create_rectangle(4, y, width - 4, bottom, fill="#2b4a39" if highlighted else "#1a3026",
                           outline=GOLD if selected or highlighted else "#2a4436")
        target = source or {"id": party_id, "name": name}
        self.row_parties.append((4, y, width - 4, bottom, party_id, name))
        self.hitboxes.append((4, y, width - 4, bottom, lambda: self.open_source(target, "compact"),
                              f"{name} · {project} · {age_label(updated_ms)} · open roster"))
        chip_left = self.chip(width - 8, y + 3, "EXPAND", lambda: self.open_source(target, "expanded"),
                              f"Open every stream in {name}")
        chip_left = self.watch_chip(chip_left - 4, y + 3, party_id, name)
        age = age_label(updated_ms)
        c.create_text(chip_left - 6, y + 11, anchor="e", text=age, fill=MUTED, font=self.small_font)
        age_left = chip_left - 6 - self.small_font.measure(age)
        # The model's family colour and short name, quietly, before the age.
        if models:
            first = models[0]
            ink = family_ink({"model": first})
            tag = fit_text(self.tag_font, str(first.get("label") or "").upper(), 86)
            age_left -= 8
            c.create_text(age_left, y + 11, anchor="e", text=tag, fill=ink, font=self.tag_font)
            age_left -= self.tag_font.measure(tag)
        # Text runs from x=12 to just before the model and age; the title gets what the project does not need.
        room = age_left - 18 - 12
        project_room = min(self.small_font.measure(project) + 10, int(room * 0.35)) if project else 0
        mark = "◆" if selected else "★" if owner.is_watched(party_id) else "◷"
        shown = fit_text(self.small_font, f"{mark} {name}", room - project_room)
        c.create_text(12, y + 11, anchor="w", text=shown, fill=IVORY if selected or highlighted else "#d6dfd2",
                      font=self.small_font)
        project_left = 12 + self.small_font.measure(shown) + 10
        if project_room > 30:
            c.create_text(project_left, y + 11, anchor="w", fill="#7f9a88", font=self.small_font,
                          text=fit_text(self.small_font, project, 12 + room - project_left))
        return y + QUIET_ROW

    def draw_footer(self, y: int, width: int, older: int) -> int:
        c = self.body
        split = int(width * 0.64)
        label = f"⌕ FIND ANY CHAT · {older} MORE" if older else "⌕ FIND ANY CHAT"
        for left, right, text, command, tip in (
                (4, split - 3, label, self.start_search, "Search every chat and workspace by title or project"),
                (split + 3, width - 4, "BY PROJECT ▾", self.owner.show_source_menu, "Browse all chats grouped by project")):
            c.create_rectangle(left, y, right, y + 24, fill="#24402f", outline="#4f7a60")
            c.create_text((left + right) // 2, y + 12, text=text, fill=GOLD, font=self.tag_font)
            self.hitboxes.append((left, y, right, y + 24, command, tip))
        return y + 28

    def draw_results(self, y: int, width: int) -> int:
        owner = self.owner
        c = self.body
        query = self.query.get().strip()
        catalog = owner.source_catalog
        if not catalog:
            text = ("The chat list is unavailable right now." if owner.catalog_failed
                    else "Loading the chat list…")
            c.create_text(12, y + 6, anchor="nw", text=text, fill=MUTED, font=self.small_font)
            self.chip(width - 8, y + 2, "OPEN BROWSER CATALOG", owner.open_viewer)
            return y + 30
        if query:
            heading = f"⌕ {len(self.results)} {'MATCH' if len(self.results) == 1 else 'MATCHES'} FOR “{query[:24]}”"
        else:
            heading = f"ALL {len(catalog)} CHATS AND WORKSPACES · NEWEST FIRST"
        if owner.catalog_unavailable:
            heading += f" · {', '.join(owner.catalog_unavailable).upper()} LIST UNAVAILABLE"
        elif owner.catalog_failed or (owner.catalog_at and time.monotonic() - owner.catalog_at > 180):
            heading += f" · LIST FROM {max(1, int((time.monotonic() - owner.catalog_at) / 60))}m AGO"
        y = self.section(y, width, heading, GOLD)
        if not self.results:
            c.create_text(12, y + 4, anchor="nw", fill=MUTED, font=self.small_font,
                          text="Nothing matches. Search covers titles, projects, and folders.")
            return y + 24
        for index, source in enumerate(self.results):
            party_id = party_scope(source)
            stamp = float(source.get("updatedAt") or 0)
            y = self.draw_quiet(party_id, str(source.get("name") or party_id), project_for(source)[1],
                                stamp * 1000 if 0 < stamp < 1e12 else stamp, y, width,
                                highlighted=index == self.selection, source=source, models=party_models([], source))
        if len(self.results) >= 80:
            c.create_text(12, y + 4, anchor="nw", fill=MUTED, font=self.small_font,
                          text="Showing the newest 80 · add words to narrow the list.")
            y += 22
        return y

    # Goblins ---------------------------------------------------------------
    def paint_sprite(self, tag: str, x: int, y: int, style: dict, actor: dict) -> None:
        self.body.delete(tag)
        self.owner.paint_member(self.body, ("launchpad", str(actor.get("id") or tag)), tag, x, y, style, actor,
                                self.owner.board_connection)

    def animate(self) -> None:
        if not self.shown:
            return
        for tag, x, y, style, actor in self.sprites:
            self.paint_sprite(tag, x, y, style, actor)
        self.body.tag_raise("hover")

    # Pointer ---------------------------------------------------------------
    def hit_at(self, event: tk.Event):
        x, y = self.body.canvasx(event.x), self.body.canvasy(event.y)
        for box in reversed(self.hitboxes):
            if box[0] <= x <= box[2] and box[1] <= y <= box[3]:
                return box
        return None

    def on_click(self, event: tk.Event) -> None:
        box = self.hit_at(event)
        if box:
            box[4]()

    def on_hover(self, event: tk.Event) -> None:
        box = self.hit_at(event)
        if box:
            self.body.coords("hover", box[0], box[1], box[2], box[3])
            self.body.itemconfigure("hover", state="normal")
            self.body.tag_raise("hover")
            self.status.configure(text=box[5] or self.base_status)
        else:
            self.clear_hover()

    def clear_hover(self) -> None:
        self.body.itemconfigure("hover", state="hidden")
        self.status.configure(text=self.base_status)

    def on_wheel(self, event: tk.Event) -> str:
        self.body.yview_scroll(-1 if event.delta > 0 else 1, "units")
        return "break"

    def start_drag(self, event: tk.Event) -> None:
        self.dragged = False
        self.drag_start = (event.x_root, event.y_root, self.window.winfo_x(), self.window.winfo_y())

    def drag(self, event: tk.Event) -> None:
        if self.drag_start:
            px, py, x, y = self.drag_start
            self.dragged = self.dragged or abs(event.x_root - px) + abs(event.y_root - py) > 4
            self.window.geometry(f"+{x + event.x_root - px}+{y + event.y_root - py}")

    def end_drag(self, _event: tk.Event) -> None:
        self.drag_start = None
        if self.dragged:
            self.owner.dock_x = self.window.winfo_x() + self.window.winfo_width()
            self.owner.dock_y = self.window.winfo_y() + self.window.winfo_height()
            self.owner.save_position()

    def show_row_menu(self, event: tk.Event) -> None:
        x, y = self.body.canvasx(event.x), self.body.canvasy(event.y)
        row = next((item for item in reversed(getattr(self, "row_parties", [])) if item[0] <= x <= item[2] and item[1] <= y <= item[3]), None)
        if not row or self.owner.demo:
            self.show_menu()
            return
        _l, _t, _r, _b, party_id, name = row
        owner = self.owner
        menu = tk.Menu(self.window, tearoff=False)
        separable = [(party, owner.source_label_for(party)) for party, chat in owner.joined_parties.items() if chat == party_id]
        is_chat = not party_id.startswith(("orca:", "claude:", "ext:"))
        if is_chat:
            for party, label in separable:
                menu.add_command(label=f"Separate {label[:40]} from this chat",
                                 command=lambda party=party: owner.set_join(party, ""))
            if not separable:
                menu.add_command(label="Nothing is joined to this chat", state="disabled")
        else:
            joined_to = owner.joined_parties.get(party_id)
            if joined_to:
                menu.add_command(label="Separate from its Codex chat", command=lambda: owner.set_join(party_id, ""))
            chats = tk.Menu(menu, tearoff=False)
            for chat in owner.recent_chats(12):
                chat_id = str(chat.get("id"))
                chats.add_command(label=fit_text(self.small_font, str(chat.get("name") or chat_id), 320),
                                  command=lambda chat_id=chat_id: owner.set_join(party_id, chat_id))
            if not owner.recent_chats(1):
                chats.add_command(label="No Codex chats yet", state="disabled")
            menu.add_cascade(label=f"Join {name[:32]} to a Codex chat", menu=chats)
        if party_id in owner.manual_links or any(party in owner.manual_links for party, _ in separable):
            menu.add_separator()
            for party in [party_id, *(party for party, _ in separable)]:
                if party in owner.manual_links:
                    menu.add_command(label="Back to automatic joining" + ("" if party == party_id else f" ({owner.source_label_for(party)[:30]})"),
                                     command=lambda party=party: owner.set_join(party, None))
        menu.add_separator()
        menu.add_command(label="More…", command=self.show_menu)
        menu.tk_popup(self.window.winfo_pointerx(), self.window.winfo_pointery())

    def show_menu(self) -> None:
        owner = self.owner
        menu = tk.Menu(self.window, tearoff=False)
        menu.add_command(label="Find a chat or workspace…", command=self.start_search)
        owner.add_project_menus(menu)
        menu.add_command(label="Open the browser catalog…", command=owner.open_viewer)
        menu.add_separator()
        if owner.thread_id != "all":
            menu.add_command(label=f"Return to {owner.source_name[:32]}", command=owner.restore_party_view)
        menu.add_command(label="Show the goblin line instead", command=lambda: owner.set_home_view("line"))
        menu.add_command(label="Change goblin outfits", command=owner.change_outfits)
        menu.add_command(label=owner.motion_label(), command=owner.toggle_reduced_motion)
        menu.add_command(label="Resume updates" if owner.paused else "Pause updates", command=owner.toggle_pause)
        menu.add_separator()
        menu.add_command(label="Reconnect Codex", command=owner.reconnect_codex)
        if (owner.sources.get("claude") or {}).get("canConnect"):
            menu.add_command(label="Connect Claude Code…", command=owner.connect_claude)
        if owner.autostart.get("available"):
            menu.add_command(label=("✓ " if owner.autostart.get("enabled") else "") + "Start with Windows",
                             command=owner.toggle_autostart)
        menu.add_command(label=f"Phone access (Wi-Fi): {'On' if owner.phone.get('enabled') else 'Off'}", command=owner.toggle_phone)
        menu.add_command(label="New pairing code (forget phones)", command=owner.reset_pairing)
        menu.add_command(label="Copy diagnostic report", command=owner.copy_diagnostics)
        menu.add_separator()
        menu.add_command(label="Close goblins", command=owner.close)
        menu.add_command(label=QUIT_LABEL, command=owner.quit_all)
        menu.tk_popup(self.window.winfo_pointerx(), self.window.winfo_pointery())


class GoblinWidget:
    # The launchpad is home; "line" keeps the original row of goblin cards as an option.
    home_view = "launchpad"
    peek_id = ""
    peek_home: tuple[int, int, bool] | None = None
    pending_peek = ""
    board_actors: list[dict] = []
    board_coverage: dict = {}
    board_connection = "CONNECTING"
    board_success = 0.0
    board_order: list[str] = []
    catalog_failed = False
    # Retired members of the selected party whose portal has finished, and portals still playing.
    parted: frozenset[str] = frozenset()
    parted_outcomes: dict = {}
    exits: dict = {}
    notes_panel = None
    undo = None
    # Replaced, never mutated in place, so these class defaults stay empty.
    dismissed: dict = {}
    placements: dict = {}
    error_count = 0  # Callbacks that failed since start, for the diagnostic report.
    show_after = None

    def __init__(self, thread_id: str, port: int, demo: bool = False) -> None:
        self.thread_id = thread_id or "all"
        self.explicit_thread = bool(thread_id)
        self.port = port
        self.demo = demo
        self.paused = False
        self.rotating = True
        self.columns = 2
        self.page = 0
        self.page_changed_at = time.monotonic()
        self.hidden_ids: set[str] = set()
        self.palette_offset = 0
        self.actors: list[dict] = []
        self.root_id = ""
        self.message = "Connecting to Goblin Horde…"
        self.source_name = "Recent activity" if self.thread_id == "all" else self.thread_id
        self.connection = "CONNECTING"
        self.attention = ""
        self.last_success = 0.0
        self.phase = 0
        self.motion_clock = ActionClock()
        # One record of each goblin's newest public step, so every surface pulses together.
        self.action_pulses = ActionPulse()
        # None follows Windows' animation setting; True or False is the user's own choice.
        self.reduced_motion_choice: bool | None = None
        self.drag_start: tuple[int, int, int, int] | None = None
        self.dragged = False
        self.hovered = False
        self.last_drawn = ""
        self.text_offsets: dict[str, int] = {}
        self.text_keys: dict[str, str] = {}
        self.text_lines: dict[str, list[str]] = {}
        self.text_advanced_at: dict[str, float] = {}
        self.executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="goblin-horde")
        self.roster_only: set[str] = set()  # Members left on the roster when a party opened calmly.
        self.joined_parties: dict[str, str] = {}  # Orca or Claude party -> the Codex chat it joined.
        self.manual_links: dict[str, str] = {}  # The person's own choices: party -> chat, or "" for separate.
        # Parties the person watches: always read by the server and kept on the launchpad.
        self.watched_ids: list[str] = []
        self.watch_pending = None
        self.board_watching: list = []
        self.pending = None
        self.pending_scope = ""
        self.closing = False
        self.restore_after = None
        self.poll_after = None
        self.receive_after = None
        self.animate_after = None
        self.streams: dict[str, StreamWindow] = {}
        self.saved_streams: list[dict] = []
        # party id -> actor ids whose stream was closed with ×; only an explicit open undoes it.
        self.dismissed: dict[str, list[str]] = {}
        # actor id -> {"x", "y", "manual"}: the last spot of every stream, open or closed.
        self.placements: dict[str, dict] = {}
        self.aliases: dict[str, str] = {}
        self.visible_stream_ids: set[str] = set()
        self.focused_stream_id = ""
        self.party_mode = False
        self.display_mode = "overview"
        self.party_view = "expanded"
        self.hidden_from = "expanded"
        self.peek_id = ""
        self.peek_home: tuple[int, int, bool] | None = None
        self.pending_peek = ""
        self.dock_x: int | None = None
        self.dock_y: int | None = None
        self.source_catalog: list[dict] = []
        self.catalog_pending = None
        self.catalog_after = None
        self.catalog_at = 0.0
        self.catalog_failed = False
        self.pending_party: tuple[str, str] | None = None
        self.board_actors = []
        self.board_coverage = {}
        self.board_connection = "CONNECTING"
        self.board_success = 0.0
        self.board_order = []
        self.board_pending = None
        self.board_requested = 0.0
        self.board_after = None
        self.board_age = 0.0  # Seconds the server's all-parties scene was old when it was served.
        self.catalog_unavailable: list[str] = []
        # Which feeds the viewer can see (Codex, Claude Code, Orca, extensions), refreshed every 30 seconds.
        self.sources: dict = {}
        self.autostart: dict = {}  # {available, enabled}: starting at Windows sign-in.
        self.phone: dict = {}  # {enabled, listening, url, adapter, problem}: phone access over Wi-Fi, off by default.
        self.welcomed = False  # The launchpad's welcome card stays until "Got it".
        self.sources_pending = None
        self.sources_after = None
        self.notes = PartingNotes()
        self.retirement = RetirementTracker()
        # actor id -> Exit; one monotonic start per portal so every surface shows the same beat.
        self.exits: dict[str, Exit] = {}
        self.parted = frozenset()
        self.parted_outcomes: dict[str, str] = {}
        self.notes_panel: NotesPanel | None = None
        self.undo: Undo | None = None

        self.root = tk.Tk()
        self.root.withdraw()
        try:
            desktop_platform.check_support(self.root)
            float_window(self.root)
            self.clear = make_transparent(self.root)
        except (TransparencyUnavailable, tk.TclError):
            self.executor.shutdown(wait=False)
            self.root.destroy()
            raise
        desktop_platform.prepare_app(self.root, on_quit=self.close)
        # pythonw has no console: a failed callback is counted and noted in run/widget.log instead.
        self.root.report_callback_exception = self.report_callback_error
        # Alt+F4 on the goblin line collapses to the tab instead of ending the widget unsaved.
        self.root.protocol("WM_DELETE_WINDOW", self.hide_party)
        self.root.title("Goblin Horde")
        self.load_settings()
        self.refresh_parted()
        self.reduced_motion = (self.reduced_motion_choice if self.reduced_motion_choice is not None
                               else system_prefers_reduced_motion())
        self.width = min(self.root.winfo_screenwidth() - 20, COL_WIDTH * self.columns + 12)
        self.canvas = tk.Canvas(self.root, width=self.width, height=HEIGHT, bg=self.clear,
                                bd=0, highlightthickness=0)
        self.canvas.pack()
        self.header_font = tkfont.Font(family=ui_family("Consolas"), size=-12, weight="bold")
        self.body_font = tkfont.Font(family=ui_family("Consolas"), size=-13, weight="bold")
        self.meta_font = tkfont.Font(family=ui_family("Consolas"), size=-10)
        self.load_position()

        self.canvas.bind("<ButtonPress-1>", self.start_drag)
        self.canvas.bind("<B1-Motion>", self.drag)
        self.canvas.bind("<ButtonRelease-1>", self.end_drag)
        bind_context(self.canvas, self.show_menu)
        self.canvas.bind("<MouseWheel>", self.scroll_bubble)
        self.canvas.bind("<Enter>", lambda _event: setattr(self, "hovered", True))
        self.canvas.bind("<Leave>", lambda _event: setattr(self, "hovered", False))
        self.root.bind("<Escape>", lambda _event: self.toggle_pause())
        self.menu = tk.Menu(self.root, tearoff=False)
        self.menu.add_command(label="Open Goblin Horde", command=self.open_viewer)
        self.menu.add_command(label="Pause updates", command=self.toggle_pause)
        self.menu.add_command(label="Hold this page", command=self.toggle_rotation)
        self.menu.add_command(label="Previous page", command=lambda: self.change_page(-1))
        self.menu.add_command(label="Next page", command=lambda: self.change_page(1))
        self.menu.add_command(label="Choose source…", command=self.show_source_menu)
        self.menu.add_command(label="Hide this goblin", command=self.hide_selected)
        self.menu.add_command(label="Restore hidden goblins", command=self.restore_hidden)
        self.menu.add_command(label="Show 1 goblin", command=lambda: self.set_columns(1))
        self.menu.add_command(label="Show 2 goblins", command=lambda: self.set_columns(2))
        self.menu.add_command(label="Show 3 goblins", command=lambda: self.set_columns(3))
        self.menu.add_command(label="Show 4 goblins", command=lambda: self.set_columns(4))
        self.menu.add_command(label="Preview goblin actions", command=self.toggle_demo)
        self.menu.add_command(label="Change goblin outfits", command=self.change_outfits)
        self.menu.add_command(label="Open party, focus this goblin", command=self.open_selected_stream)
        self.menu.add_command(label="Open related streams", command=self.open_related_streams)
        self.menu.add_command(label=RALLY_LABEL, command=self.open_full_party)
        self.menu.add_command(label="Rebalance party windows", command=self.rebalance_streams)
        self.menu.add_command(label="Show overview", command=self.show_overview)
        self.menu.add_command(label="Manage open streams…", command=self.show_party_menu)
        self.menu.add_command(label="Close all stream windows", command=self.close_all_streams)
        self.menu.add_command(label="Condense party", command=self.condense_party)
        self.menu.add_command(label="Hide party", command=self.hide_party)
        self.menu.add_command(label="Show the launchpad (home)", command=lambda: self.set_home_view("launchpad"))
        self.menu.add_command(label=self.motion_label(), command=self.toggle_reduced_motion)
        self.motion_menu_index = self.menu.index("end")
        self.menu.add_separator()
        self.menu.add_command(label="Close goblins", command=self.close)
        self.menu.add_command(label=QUIT_LABEL, command=self.quit_all)
        self.menu.entryconfigure(2, label="Hold this page" if self.rotating else "Resume page rotation")
        self.party_dock = PartyDock(self)
        self.launchpad = Launchpad(self)

        # Paint the complete widget before Windows shows its transparent window.
        self.draw()
        self.root.update_idletasks()
        if self.display_mode == "hidden" or (self.thread_id != "all" and self.display_mode != "overview"):
            if self.display_mode == "hidden":
                self.party_dock.show_hidden()
            else:
                self.party_dock.show_compact()
        else:
            self.show_home()
        self.restore_after = self.root.after(80, self.restore_streams)
        self.poll_after = self.root.after(100, self.poll)
        self.animate_after = self.root.after(650, self.animate)
        self.catalog_after = self.root.after(200, self.load_catalog)
        self.sources_after = self.root.after(400, self.poll_sources)
        if self.board_after is None:  # Showing the launchpad above may already have started it.
            self.board_after = self.root.after(120, self.poll_board)
        self.take_show_request()  # One left from before this start is already answered.
        self.show_after = self.root.after(SHOW_CHECK_MS, self.check_show_request)

    # Coming back when every window was closed ---------------------------------------
    def take_show_request(self) -> bool:
        """Whether `start` asked this running widget to come forward; the request is used up."""
        try:
            (run_folder() / SHOW_REQUEST).unlink()
            return True
        except OSError:
            return False

    def check_show_request(self) -> None:
        self.show_after = None
        if self.closing:
            return
        try:
            if self.take_show_request():
                self.come_forward()
        finally:
            if not self.closing:
                self.show_after = self.root.after(SHOW_CHECK_MS, self.check_show_request)

    def come_forward(self) -> None:
        """Show the view the person last had: a hidden party or launchpad opens again, and an
        open roster or set of streams is raised."""
        mode = self.display_mode
        if mode == "hidden":
            self.restore_hidden_party()
        elif mode == "compact" and (self.thread_id != "all" or self.demo):
            self.condense_party()
        elif mode == "expanded" and (self.thread_id != "all" or self.demo):
            self.expand_party()
        else:
            self.show_overview()

    def report_callback_error(self, kind, _value, trace) -> None:
        """Tk's handler for a callback that raised. The loops reschedule themselves regardless."""
        self.error_count += 1
        if self.error_count <= LOGGED_ERRORS or self.error_count % 100 == 0:
            note_widget_error(error_line(self.error_count, kind, trace))

    def quit_all(self) -> None:
        """Stop the viewer too, then close. The request has its own thread, not the pool that close()
        cancels, and Python waits for it before exiting."""
        if not self.demo:
            def ask() -> None:
                try:
                    self.post_local("/api/quit")
                except Exception:
                    pass  # Already stopped, or not ours to stop; the goblins close either way.
            threading.Thread(target=ask, name="goblin-horde-quit").start()
        self.close()

    def load_settings(self) -> None:
        """Restore saved settings. Each group is applied on its own, so one bad value never drops the rest."""
        try:
            raw = state_file().read_bytes()
        except OSError:
            return
        try:
            saved = json.loads(raw.decode("utf-8"))
        except ValueError:  # Also UnicodeDecodeError: not UTF-8 at all.
            # Keep the unreadable file for recovery; the next save writes fresh settings beside it.
            keep_unreadable_settings(raw)
            return
        if not isinstance(saved, dict):
            return

        def notes() -> None:
            # Each stored note and retirement marker is validated on its own; a bad one is dropped.
            now_ms = time.time() * 1000
            self.notes = PartingNotes.load(saved.get("partingNotes"), now_ms)
            self.retirement.load(saved.get("retiredMarkers"), now_ms)
            # Settings from before markers were saved: a note is the only record of a retirement.
            for note in self.notes.items:
                self.retirement.seed(note["party"], note["id"], note["outcome"], note["at"])

        def line() -> None:
            self.columns = max(1, min(4, int(saved.get("columns", self.columns))))
            self.rotating = bool(saved.get("rotating", True))
            self.hidden_ids = set(map(str, saved.get("hiddenIds", [])))
            self.palette_offset = int(saved.get("paletteOffset", 0)) % len(KINDS)

        def streams() -> None:
            self.saved_streams = [item for item in saved.get("streams", [])
                                  if isinstance(item, dict) and item.get("id")
                                  and not str(item["id"]).startswith("demo-")][:24]
            self.load_dismissed(saved.get("dismissedStreams"))
            self.load_placements(saved.get("placements"))

        def aliases() -> None:
            raw_aliases = saved.get("aliases") or {}
            if isinstance(raw_aliases, dict):
                self.aliases = {str(actor_id): str(alias).strip()[:40]
                                for actor_id, alias in raw_aliases.items()
                                if str(actor_id) and isinstance(alias, str) and alias.strip()}

        def modes() -> None:
            legacy_party = bool(saved.get("partyMode", False)) and bool(self.saved_streams)
            mode = str(saved.get("displayMode") or ("expanded" if legacy_party else "overview"))
            self.display_mode = mode if mode in ("overview", "expanded", "compact", "hidden") else "overview"
            preferred = str(saved.get("partyView") or (
                "compact" if self.display_mode == "compact" else "expanded"))
            self.party_view = preferred if preferred in ("expanded", "compact") else "expanded"
            previous = str(saved.get("hiddenFrom") or self.party_view)
            self.hidden_from = previous if previous in ("overview", "expanded", "compact") else self.party_view
            self.home_view = "line" if saved.get("homeView") == "line" else "launchpad"

        def dock() -> None:
            dock_x, dock_y = saved.get("dockX"), saved.get("dockY")
            self.dock_x = int(dock_x) if dock_x is not None else None
            self.dock_y = int(dock_y) if dock_y is not None else None

        def preferences() -> None:
            if isinstance(saved.get("reducedMotion"), bool):
                self.reduced_motion_choice = saved["reducedMotion"]
            self.welcomed = saved.get("welcomed") is True
            self.focused_stream_id = str(saved.get("focusedStreamId") or "")
            if not self.explicit_thread:
                self.thread_id = str(saved.get("threadId") or "all")
                self.source_name = str(saved.get("sourceName") or self.thread_id)

        for group in (notes, line, streams, aliases, modes, dock, preferences):
            try:
                group()
            except (ValueError, TypeError, AttributeError, KeyError, OverflowError):
                pass
        # Whatever was restored, the modes must agree with each other and with the source.
        self.party_mode = self.display_mode == "expanded"
        if self.thread_id == "all":
            self.source_name = "Recent activity"
            self.party_mode = False
            if self.display_mode in ("expanded", "compact"):
                self.display_mode = "overview"

    def load_dismissed(self, raw) -> None:
        """Closed-stream ids per party; anything malformed is dropped."""
        dismissed: dict[str, list[str]] = {}
        for party_id, ids in list(raw.items() if isinstance(raw, dict) else ())[-DISMISSED_PARTIES:]:
            if not isinstance(party_id, str) or party_id in ("", "all", "standby") or not isinstance(ids, list):
                continue
            clean = list(dict.fromkeys(item[:200] for item in ids if isinstance(item, str) and item
                                       and not item.startswith("demo-")))[-DISMISSED_LIMIT:]
            if clean:
                dismissed[party_id[:200]] = clean
        self.dismissed = dismissed

    def load_placements(self, raw) -> None:
        """Last window spots by actor id; a spot must be two plain integers in a sane range."""
        placements: dict[str, dict] = {}
        for actor_id, spot in list(raw.items() if isinstance(raw, dict) else ())[-PLACEMENT_LIMIT:]:
            if not isinstance(actor_id, str) or not actor_id or actor_id.startswith("demo-") or not isinstance(spot, dict):
                continue
            x, y = spot.get("x"), spot.get("y")
            if all(isinstance(value, int) and not isinstance(value, bool) and abs(value) < 100_000 for value in (x, y)):
                placements[actor_id[:200]] = {"x": x, "y": y, "manual": spot.get("manual") is True}
        self.placements = placements

    def dismissed_ids(self, party_id: str) -> set[str]:
        return set(self.dismissed.get(party_id, ()))

    def set_dismissed(self, party_id: str, ids) -> None:
        """Replace one party's closed-stream ids; the most recently touched party is kept longest."""
        if not party_id or party_id == "all":
            return
        before = self.dismissed.get(party_id, [])
        kept = [actor_id for actor_id in before if actor_id in ids]
        kept += [actor_id for actor_id in ids if actor_id not in kept and not actor_id.startswith("demo-")]
        if kept == before:
            return
        dismissed = {key: value for key, value in self.dismissed.items() if key != party_id}
        if kept:
            dismissed[party_id] = kept[-DISMISSED_LIMIT:]
        while len(dismissed) > DISMISSED_PARTIES:
            dismissed.pop(next(iter(dismissed)))
        self.dismissed = dismissed

    def reopen_member(self, actor_id: str) -> None:
        """An explicit open of one member undoes its × for the selected party."""
        if actor_id in self.dismissed.get(self.thread_id, ()):
            self.set_dismissed(self.thread_id, self.dismissed_ids(self.thread_id) - {actor_id})

    def remember_placement(self, actor_id: str, x: int, y: int, manual: bool) -> None:
        if not actor_id or actor_id.startswith("demo-"):
            return
        spot = {"x": int(x), "y": int(y), "manual": bool(manual)}
        if self.placements.get(actor_id) == spot:
            return
        placements = {key: value for key, value in self.placements.items() if key != actor_id}
        placements[actor_id] = spot
        while len(placements) > PLACEMENT_LIMIT:
            placements.pop(next(iter(placements)))
        self.placements = placements

    def load_position(self) -> None:
        x = max(0, self.root.winfo_screenwidth() - self.width - 40)
        y = max(0, self.root.winfo_screenheight() - HEIGHT - 95)
        try:
            saved = json.loads(state_file().read_text(encoding="utf-8"))
            x = int(saved.get("x", x))
            y = int(saved.get("y", y))
        except (OSError, ValueError, TypeError):
            pass
        self.root.geometry(f"{self.width}x{HEIGHT}{screen_geometry(x, y)}")

    def stream_states(self) -> list[dict]:
        """Saved stream state; a peeked stream saves its home tile, not its borrowed spot."""
        states = []
        for stream in self.streams.values():
            if stream.actor_id.startswith("demo-"):
                continue
            state = stream.state()
            if stream.actor_id == self.peek_id and self.peek_home:
                state["x"], state["y"], state["placed"] = self.peek_home
            states.append(state)
        return states

    def save_position(self) -> None:
        try:
            write_settings(state_file(), json.dumps({
                "x": self.root.winfo_x(), "y": self.root.winfo_y(), "columns": self.columns,
                "rotating": self.rotating, "hiddenIds": sorted(self.hidden_ids),
                "paletteOffset": self.palette_offset, "threadId": self.thread_id,
                "sourceName": self.source_name,
                "aliases": self.aliases,
                "displayMode": self.display_mode, "dockX": self.dock_x, "dockY": self.dock_y,
                "partyView": self.party_view, "hiddenFrom": self.hidden_from,
                "partyMode": self.party_mode, "homeView": self.home_view,
                "focusedStreamId": self.focused_stream_id,
                "reducedMotion": self.reduced_motion_choice,
                "welcomed": self.welcomed,
                "streams": self.stream_states(),
                "dismissedStreams": self.dismissed,
                "placements": self.placements,
                "partingNotes": self.notes.to_json(),
                "retiredMarkers": self.retirement.to_json(),
            }))
            self.retirement.changed = False
        except OSError:
            pass

    def start_drag(self, event: tk.Event) -> None:
        self.dragged = False
        if event.y < 55:
            self.drag_start = None
            return
        self.drag_start = (event.x_root, event.y_root, self.root.winfo_x(), self.root.winfo_y())

    def drag(self, event: tk.Event) -> None:
        if not self.drag_start:
            return
        pointer_x, pointer_y, start_x, start_y = self.drag_start
        self.dragged = self.dragged or abs(event.x_root - pointer_x) + abs(event.y_root - pointer_y) > 5
        self.root.geometry(f"+{start_x + event.x_root - pointer_x}+{start_y + event.y_root - pointer_y}")

    def end_drag(self, event: tk.Event) -> None:
        if event.y < 55 and not self.dragged:
            self.toolbar_click(event.x, event.y)
        elif not self.dragged and 58 <= event.y <= HEIGHT:
            actors = self.page_actors()
            index = max(0, (event.x - 9) // COL_WIDTH)
            if index < len(actors):
                actor = actors[index]
                if 170 <= event.y <= 189 and event.x >= index * COL_WIDTH + 115 and self.actor_text(actor)[3] > 0:
                    self.more_text(actor)
                elif self.thread_id == "all" and not self.demo:
                    self.select_party_for_actor(actor)
                else:
                    self.enter_party(str(actor.get("id") or ""))
        self.drag_start = None
        if self.dragged:
            self.save_position()

    def show_menu(self, event: tk.Event) -> None:
        actors = self.page_actors()
        index = max(0, (event.x - 9) // COL_WIDTH)
        self.selected_actor = actors[index] if index < len(actors) and event.y >= 55 else None
        enabled = "normal" if self.selected_actor and self.selected_actor.get("id") != "standby" else "disabled"
        self.menu.entryconfigure(6, state=enabled)
        self.menu.entryconfigure(14, state=enabled)
        self.menu.entryconfigure(15, state=enabled)
        self.menu.entryconfigure(16, label="Choose a party…" if self.thread_id == "all" and not self.demo
                                 else RALLY_LABEL)
        self.menu.tk_popup(event.x_root, event.y_root)

    def scroll_bubble(self, event: tk.Event) -> str:
        if 58 <= event.y <= 189:
            actors = self.page_actors()
            index = max(0, (event.x - 9) // COL_WIDTH)
            if index < len(actors):
                self.shift_text(actors[index], -TEXT_STEP if event.delta > 0 else TEXT_STEP)
        return "break"

    def open_viewer(self, actor: dict | None = None) -> None:
        actor = actor or {}
        source_id = ("all" if self.demo else actor.get("id")) or self.thread_id
        # Orca, Claude, and extension-feed goblins open their whole party; a Codex child opens its own chat.
        if actor.get("source") in ("orca", "claude", "extension") and actor.get("parentThreadId"):
            source_id = actor["parentThreadId"]
        path = f"/?thread={urllib.parse.quote(str(source_id))}"
        webbrowser.open(f"http://127.0.0.1:{self.port}{path}")

    def toggle_pause(self) -> None:
        self.paused = not self.paused
        self.menu.entryconfigure(1, label="Resume updates" if self.paused else "Pause updates")
        self.last_drawn = ""
        self.draw()
        self.launchpad.refresh()

    def toggle_rotation(self) -> None:
        self.rotating = not self.rotating
        self.menu.entryconfigure(2, label="Hold this page" if self.rotating else "Resume page rotation")
        self.page_changed_at = time.monotonic()
        self.save_position()
        self.draw()

    def change_page(self, amount: int) -> None:
        self.page = (self.page + amount) % self.page_count()
        self.page_changed_at = time.monotonic()
        self.draw()

    def set_columns(self, amount: int) -> None:
        self.columns = amount
        self.width = min(self.root.winfo_screenwidth() - 20, COL_WIDTH * amount + 12)
        self.canvas.configure(width=self.width)
        self.root.geometry(f"{self.width}x{HEIGHT}")
        self.page = 0
        self.save_position()
        self.last_drawn = ""
        self.draw()

    def follow_source(self, source_id: str, name: str = "", *, open_party: bool = False,
                      focus_id: str = "") -> None:
        if not open_party or source_id == "all":
            self.show_overview()
        else:
            self.party_mode = False
            self.end_peek()
            for stream in self.streams.values():
                stream.window.withdraw()
            self.visible_stream_ids.clear()
            self.hide_home()
            self.display_mode = self.party_view
        self.thread_id = source_id
        # A portal belongs to the party it played in; switching settles it, and returning never replays it.
        self.exits = {}
        self.refresh_parted()
        if self.notes_panel:
            self.notes_panel.withdraw()
        self.pending_party = (source_id, focus_id) if open_party and source_id != "all" else None
        self.source_name = name or ("Recent activity" if source_id == "all" else source_id)
        self.connection = "CONNECTING"
        self.attention = ""
        self.last_success = 0.0
        self.root_id = ""
        self.message = "Connecting to this source…"
        self.actors = []
        self.text_offsets.clear()
        self.text_keys.clear()
        self.text_lines.clear()
        self.text_advanced_at.clear()
        self.page = 0
        self.last_drawn = ""
        if open_party and source_id != "all":
            self.party_dock.show_compact()
        self.save_position()
        self.draw()
        self.fetch_now()

    def select_party_for_actor(self, actor: dict) -> None:
        scope = party_scope(actor)
        if scope and scope != "all":
            self.follow_source(scope, str(actor.get("name") or actor.get("nickname") or scope),
                               open_party=True, focus_id=str(actor.get("id") or ""))

    def choose_party(self, party_id: str, name: str = "", view: str = "compact",
                     focus_id: str = "", peek: bool = False) -> None:
        """Launchpad entry: open one party as its roster or its streams in a single click."""
        if not party_id or party_id == "all":
            return
        if view in ("compact", "expanded"):
            self.party_view = view
        self.pending_peek = focus_id if peek else ""
        if party_id == self.thread_id and self.actors and self.connection in ("LIVE", "PARTIAL"):
            # Already following this party: reuse the live scene instead of reloading it.
            if self.party_view == "compact":
                if focus_id:
                    self.focused_stream_id = focus_id
                self.condense_party()
                self.apply_pending_peek()
            else:
                self.open_party(focus_id or self.focused_stream_id)
            return
        self.follow_source(party_id, name, open_party=True, focus_id=focus_id or party_id)

    def apply_pending_peek(self) -> None:
        peek, self.pending_peek = self.pending_peek, ""
        if peek and peek != self.peek_id and any(str(actor.get("id")) == peek for actor in self.visible_actors()):
            self.peek_member(peek)

    def restore_party_view(self) -> None:
        """Return from the launchpad to the selected party's last view."""
        if self.thread_id == "all" and not self.demo:
            return
        self.condense_party() if self.party_view == "compact" else self.expand_party()

    def fetch_catalog(self) -> dict:
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/api/threads", timeout=20) as response:
            return json.load(response)

    def load_catalog(self) -> None:
        self.catalog_after = None
        if self.closing:
            return
        delay = 60_000
        try:
            if self.catalog_pending is None:
                self.catalog_pending = self.executor.submit(self.fetch_catalog)
            if not self.catalog_pending.done():
                delay = 150
                return
            try:
                catalog = self.catalog_pending.result()
                self.source_catalog = catalog.get("threads") or []
                self.catalog_unavailable = [str(name) for name in catalog.get("unavailable") or []]
                self.take_watched(catalog.get("watched"))
                self.catalog_failed = False
            except Exception:
                self.catalog_failed = not self.source_catalog
            self.catalog_pending = None
            self.catalog_at = time.monotonic()
            self.launchpad.refresh()
        finally:
            # Scheduled even after a failed refresh; a nested refresh_catalog may have done it already.
            if not self.closing and self.catalog_after is None:
                self.catalog_after = self.root.after(delay, self.load_catalog)

    # Party links -------------------------------------------------------------
    def recent_chats(self, limit: int) -> list[dict]:
        """The newest Codex chats in the catalog, for "Join to a Codex chat"."""
        chats = [source for source in self.source_catalog if source.get("source") == "codex" and source.get("id")]
        return sorted(chats, key=lambda source: -float(source.get("updatedAt") or 0))[:limit]

    def source_label_for(self, party_id: str) -> str:
        source = next((item for item in self.source_catalog if str(item.get("id")) == party_id), None)
        return str((source or {}).get("name") or party_id)

    def set_join(self, party_id: str, chat_id: str | None) -> None:
        """Join a party to a chat, keep it separate (""), or go back to automatic (None); the server remembers."""
        def done(result, error) -> None:
            if error:
                messagebox.showwarning("Goblin Horde", f"That did not change: {error}", parent=self.root)
                return
            self.manual_links = {str(key): str(value) for key, value in (result.get("manualLinks") or {}).items()}
            self.kick_board()
            if self.thread_id != "all":
                self.fetch_now()
        self.when_done(self.executor.submit(self.post_local, "/api/join", {"party": party_id, "chat": chat_id}), done)

    # Sources -----------------------------------------------------------------
    def poll_sources(self) -> None:
        """Which feeds are connected, starting, or need setup; every 30 seconds, or at once after a fix."""
        self.sources_after = None
        if self.closing:
            return
        delay = 30_000
        try:
            if self.sources_pending is None and not self.demo:
                self.sources_pending = self.executor.submit(self.get_local, "/api/capabilities")
            if self.sources_pending is not None:
                if not self.sources_pending.done():
                    delay = 200
                    return
                try:
                    capabilities = self.sources_pending.result()
                    self.sources = capabilities.get("sources") or {}
                    self.autostart = capabilities.get("autostart") or {}
                    self.phone = capabilities.get("phone") or {}
                except Exception:
                    pass  # The board already says when the viewer itself is not answering.
                self.sources_pending = None
                self.launchpad.refresh()
        finally:
            if not self.closing and self.sources_after is None:
                self.sources_after = self.root.after(delay, self.poll_sources)

    def refresh_sources_soon(self, delay: int = 1500) -> None:
        if self.sources_after:
            self.root.after_cancel(self.sources_after)
        self.sources_after = self.root.after(delay, self.poll_sources)

    def get_local(self, path: str) -> dict:
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}", timeout=10) as response:
            return json.load(response)

    def post_local(self, path: str, data: dict | None = None) -> dict:
        origin = f"http://127.0.0.1:{self.port}"
        request = urllib.request.Request(f"{origin}{path}", method="POST", data=json.dumps(data or {}).encode("utf-8"),
                                         headers={"Content-Type": "application/json", "Origin": origin})
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            try:
                message = json.load(error).get("error")
            except (ValueError, AttributeError):
                message = ""
            raise RuntimeError(message or f"The viewer answered {error.code}.") from None

    def when_done(self, future, done) -> None:
        """Call done(result, error) on the Tk thread once a background request finishes."""
        def check() -> None:
            if self.closing:
                return
            if not future.done():
                self.root.after(150, check)
                return
            try:
                done(future.result(), None)
            except Exception as error:  # A failed request is reported, never raised into Tk.
                done(None, error)
        self.root.after(150, check)

    def reconnect_codex(self) -> None:
        """Restart the viewer's Codex connection now instead of waiting for its next retry."""
        def done(_result, error) -> None:
            if error:
                messagebox.showwarning("Goblin Horde", f"Codex could not be reconnected: {error}", parent=self.root)
            self.refresh_sources_soon(2500)
            self.kick_board()
        self.sources["codex"] = {**self.sources.get("codex", {}), "state": "starting", "detail": "Starting Codex…"}
        self.launchpad.refresh(force=True)
        self.when_done(self.executor.submit(self.post_local, "/api/reconnect"), done)

    def connect_claude(self) -> None:
        """Connect Claude Code after an explicit yes: it adds Goblin Horde hooks to Claude Code's user settings."""
        if not messagebox.askyesno(
                "Connect Claude Code",
                "Show Claude Code sessions here?\n\nThis adds Goblin Horde entries to your Claude Code settings "
                f"({claude_settings_label()}). Your other settings and hooks stay as they are, and a backup is kept beside it.\n\n"
                "Undo any time with: node goblin.mjs hooks remove", parent=self.root):
            return

        def done(result, error) -> None:
            if error:
                messagebox.showwarning("Goblin Horde", f"Claude Code was not connected: {error}", parent=self.root)
            else:
                messagebox.showinfo("Goblin Horde", str(result.get("message") or "Connected Claude Code."), parent=self.root)
            self.refresh_sources_soon(300)
        self.when_done(self.executor.submit(self.post_local, "/api/connect-claude"), done)

    def dismiss_welcome(self) -> None:
        self.welcomed = True
        self.save_position()
        self.launchpad.refresh(force=True)

    def toggle_autostart(self) -> None:
        """Start Goblin Horde when the person signs in to Windows, or stop doing so."""
        enable = not self.autostart.get("enabled")

        def done(result, error) -> None:
            if error:
                messagebox.showwarning("Goblin Horde", f"That did not change: {error}", parent=self.root)
            else:
                self.autostart = result.get("autostart") or self.autostart
        self.when_done(self.executor.submit(self.post_local, "/api/autostart", {"enabled": enable}), done)

    def toggle_phone(self) -> None:
        """Turn phone access over Wi-Fi on (after an explicit yes) or off; off signs every phone out."""
        enable = not self.phone.get("enabled")
        if enable and not messagebox.askyesno(
                "Phone access",
                "Turn on phone access?\n\nThis computer starts answering on your Wi-Fi. A phone on the same network that "
                "enters the pairing code can read these chats, send replies to Codex, and approve or decline Codex "
                "commands.\n\nIt uses plain HTTP, so only turn it on at home or on another network you trust. "
                "Turn it off here any time.", parent=self.root):
            return

        def done(result, error) -> None:
            if error:
                messagebox.showwarning("Goblin Horde", f"Phone access did not change: {error}", parent=self.root)
                return
            self.phone = result.get("phone") or self.phone
            if not enable:
                messagebox.showinfo("Goblin Horde", "Phone access is off. Paired phones were signed out.", parent=self.root)
            elif self.phone.get("listening"):
                messagebox.showinfo(
                    "Goblin Horde",
                    f"Phone access is on ({self.phone.get('adapter') or 'Wi-Fi'}).\n\nOn your phone, open:\n"
                    f"{self.phone.get('url', '')}\n\nThen enter this pairing code:\n{result.get('code', '')}", parent=self.root)
            else:
                messagebox.showwarning("Goblin Horde", str(self.phone.get("problem") or "No Wi-Fi address is available yet."),
                                       parent=self.root)
        self.when_done(self.executor.submit(self.post_local, "/api/phone", {"enabled": enable}), done)

    def reset_pairing(self) -> None:
        """A new pairing code: every paired phone is signed out and must pair again."""
        if not messagebox.askyesno("New pairing code", "Make a new pairing code?\n\nEvery paired phone is signed out "
                                   "and must pair again with the new code.", parent=self.root):
            return

        def done(result, error) -> None:
            if error:
                messagebox.showwarning("Goblin Horde", f"The pairing code did not change: {error}", parent=self.root)
                return
            self.phone = result.get("phone") or self.phone
            where = f"\n\nOn your phone, open {self.phone['url']}" if self.phone.get("listening") and self.phone.get("url") else \
                "\n\nPhone access is off; turn it on from this menu to pair a phone."
            messagebox.showinfo("Goblin Horde", f"New pairing code: {result.get('code', '')}\n\nPaired phones were signed out."
                                + where, parent=self.root)
        self.when_done(self.executor.submit(self.post_local, "/api/phone/reset"), done)

    def copy_diagnostics(self) -> None:
        """Copy a short report that is safe to share: versions, states, counts, timings; no chats or codes."""
        widget_facts = f"widget: home {self.home_view} · view {self.display_mode} · {len(self.streams)} streams · " \
                       f"board {self.board_connection.lower()}, {int(self.board_age)}s old · " \
                       f"errors since start: {self.error_count}"

        def done(result, error) -> None:
            if error:
                messagebox.showwarning("Goblin Horde", f"The viewer did not answer: {error}", parent=self.root)
                return
            text = f"{result.get('text', '')}\n{widget_facts}"
            self.root.clipboard_clear()
            self.root.clipboard_append(text)
            messagebox.showinfo("Goblin Horde", "Diagnostic report copied. Paste it into your bug report.\n\n" + text,
                                parent=self.root)
        self.when_done(self.executor.submit(self.get_local, "/api/diagnostics"), done)

    # Watching --------------------------------------------------------------
    def take_watched(self, ids) -> None:
        """The server's watch list, unless a change made here is still on its way there."""
        if isinstance(ids, list) and self.watch_pending is None:
            self.watched_ids = [str(item) for item in ids if isinstance(item, str)]

    def is_watched(self, party_id: str) -> bool:
        return party_id in self.watched_ids

    def set_watched(self, party_id: str, watched: bool) -> None:
        """Watch a party (always read, always on the launchpad) or stop; shown at once, saved by the server."""
        if not party_id or party_id == "all" or self.demo:
            return
        previous = list(self.watched_ids)
        rest = [item for item in self.watched_ids if item != party_id]
        self.watched_ids = [party_id, *rest] if watched else rest
        self.launchpad.refresh(force=True)
        future = self.executor.submit(self.post_watch, party_id, watched)
        self.watch_pending = future

        def settle() -> None:
            if self.closing:
                return
            if not future.done():
                self.root.after(150, settle)
                return
            if self.watch_pending is not future:
                return  # A newer change is on its way; its answer is the one that counts.
            self.watch_pending = None
            try:
                self.watched_ids = list(future.result())
            except Exception:
                self.watched_ids = previous  # Not saved: show the list as it really is.
            self.launchpad.refresh(force=True)
            self.kick_board()
        self.root.after(150, settle)

    def post_watch(self, party_id: str, watched: bool) -> list[str]:
        origin = f"http://127.0.0.1:{self.port}"
        request = urllib.request.Request(f"{origin}/api/watch", method="POST",
                                         data=json.dumps({"id": party_id, "watched": watched}).encode("utf-8"),
                                         headers={"Content-Type": "application/json", "Origin": origin})
        with urllib.request.urlopen(request, timeout=10) as response:
            return [str(item) for item in json.load(response).get("watched") or []]

    def refresh_catalog(self) -> None:
        """Reload the full chat list when someone starts looking through it."""
        if self.catalog_pending is None and time.monotonic() - self.catalog_at > 20:
            if self.catalog_after:
                self.root.after_cancel(self.catalog_after)
            self.load_catalog()

    def open_search(self, query: str = "") -> None:
        self.show_overview(launchpad=True)
        self.launchpad.start_search(query)

    def add_project_menus(self, picker: tk.Menu) -> None:
        """Every catalogued chat, grouped by project and newest first, so old work stays reachable."""
        projects: dict[str, tuple[str, list[dict]]] = {}
        for source in self.source_catalog:
            if party_scope(source):
                key, label = project_for(source)
                projects.setdefault(key, (label, []))[1].append(source)
        browse = tk.Menu(picker, tearoff=False)
        for label, sources in list(projects.values())[:30]:
            group_menu = tk.Menu(browse, tearoff=False)
            for source in sources[:20]:
                source_id = party_scope(source)
                name = str(source.get("name") or source.get("nickname") or source_id)
                stamp = float(source.get("updatedAt") or 0)
                age = age_label(stamp * 1000 if 0 < stamp < 1e12 else stamp)
                group_menu.add_command(label=f"{name[:46]}  ·  {age}" if age else name[:48],
                                       command=lambda value=source_id, title=name: self.follow_source(
                                           value, title, open_party=True, focus_id=value))
            if len(sources) > 20:
                group_menu.add_separator()
                group_menu.add_command(label=f"Find among all {len(sources)} in {label[:24]}…",
                                       command=lambda value=label: self.open_search(value))
            browse.add_cascade(label=f"{label[:30]} ({len(sources)})", menu=group_menu)
        if len(projects) > 30:
            browse.add_separator()
            browse.add_command(label=f"{len(projects) - 30} more projects: find by name…",
                               command=self.open_search)
        if not projects:
            browse.add_command(label="The chat list is still loading", state="disabled")
        picker.add_cascade(label="Browse every chat by project", menu=browse)

    def show_source_menu(self) -> None:
        picker = tk.Menu(self.root, tearoff=False)
        picker.add_command(label="◂ All parties (launchpad)", command=self.show_launchpad)
        picker.add_command(label="Find a chat or workspace…", command=self.open_search)
        if self.home_view == "line":
            picker.add_command(label="Recent activity (goblin line)", command=lambda: self.follow_source("all"))
        picker.add_separator()
        def recent_or_active(source: dict) -> bool:
            try:
                stamp = float(source.get("updatedAt") or 0)
                if 0 < stamp < 1e12:
                    stamp *= 1000
            except (TypeError, ValueError):
                stamp = 0
            return stamp >= time.time() * 1000 - 7 * 86_400_000 or bool(source.get("agentCount"))

        recent = [source for source in self.source_catalog
                  if recent_or_active(source)][:40]
        if not recent:
            recent = [actor for actor in self.actors if party_scope(actor) not in ("", "all")]
        picker.add_command(label="RECENT PARTIES", state="disabled")
        shown: set[str] = set()
        for source in recent:
            source_id = party_scope(source)
            if not source_id or source_id in shown:
                continue
            shown.add(source_id)
            name = str(source.get("name") or source.get("nickname") or source_id)
            project = project_for(source)[1]
            marker = "✓ " if source_id == self.thread_id else "  "
            picker.add_command(label=f"{marker}{name[:27]} · {project[:16]}",
                               command=lambda value=source_id, title=name: self.follow_source(
                                   value, title, open_party=True, focus_id=value))
            if len(shown) >= 6:
                break
        picker.add_separator()
        self.add_project_menus(picker)
        picker.add_command(label="Open the browser catalog…", command=self.open_viewer)
        picker.tk_popup(self.root.winfo_pointerx(), self.root.winfo_pointery())

    def hide_selected(self) -> None:
        actor = getattr(self, "selected_actor", None)
        if actor and actor.get("id"):
            self.hidden_ids.add(str(actor["id"]))
            self.save_position()
            self.draw()
            self.party_dock.refresh()

    def restore_hidden(self) -> None:
        self.hidden_ids.clear()
        self.save_position()
        self.draw()
        self.party_dock.refresh()

    def toolbar_click(self, x: int, y: int) -> None:
        if y < 27:
            if x >= self.width - 96:
                self.show_source_menu() if self.thread_id == "all" and not self.demo else self.enter_party()
            else:
                self.show_source_menu()
            return
        segment = min(5, max(0, int((x - 8) / max(1, self.width - 16) * 6)))
        if segment == 0:
            self.change_page(-1)
        elif segment == 1:
            pass
        elif segment == 2:
            self.change_page(1)
        elif segment == 3:
            self.toggle_rotation()
        elif segment == 4:
            self.toggle_pause()
        else:
            self.show_menu_at_pointer()

    def show_menu_at_pointer(self) -> None:
        self.selected_actor = None
        self.menu.entryconfigure(6, state="disabled")
        self.menu.entryconfigure(14, state="disabled")
        self.menu.entryconfigure(15, state="disabled")
        self.menu.entryconfigure(16, label="Choose a party…" if self.thread_id == "all" and not self.demo
                                 else RALLY_LABEL)
        self.menu.tk_popup(self.root.winfo_pointerx(), self.root.winfo_pointery())

    def stream_style(self, actor: dict) -> dict:
        return style_for(actor, self.palette_offset)

    def display_name(self, actor: dict) -> str:
        actor_id = str(actor.get("id") or "")
        original = str(actor.get("nickname") or actor.get("name") or actor_id)
        alias = self.aliases.get(actor_id, "")
        return f"{alias} · {original}" if alias and alias != original else original

    def rename_stream(self, actor_id: str) -> None:
        stream = self.streams.get(actor_id)
        if not stream:
            return
        chosen = simpledialog.askstring("Goblin Horde", "Name this goblin (blank restores its Codex name):",
                                        initialvalue=self.aliases.get(actor_id, ""), parent=stream.window)
        if chosen is None:
            return
        alias = chosen.strip()[:40]
        if alias:
            self.aliases[actor_id] = alias
        else:
            self.aliases.pop(actor_id, None)
        for item in self.streams.values():
            item.set_party(item.party)
            item.render_actor(item.actor, item.connection)
        self.last_drawn = ""
        self.draw()
        self.party_dock.refresh()
        self.save_position()

    def actor_group_key(self, actor: dict) -> str:
        if (self.root_id and self.root_id != "all" and actor.get("source") == "codex"
                and (actor.get("id") == self.root_id or actor.get("parentThreadId") == self.root_id)):
            return f"codex-parent:{self.root_id}"
        return workflow_for(actor)[0]

    def open_stream(self, actor: dict, saved: dict | None = None) -> None:
        actor_id = str(actor.get("id") or "")
        if not actor_id or actor_id == "standby" or actor_id == "all":
            return
        if (self.root_id and self.root_id != "all" and actor.get("source") == "codex"
                and (actor_id == self.root_id or actor.get("parentThreadId") == self.root_id)):
            actor = {**actor, "workflowGroupId": f"codex-parent:{self.root_id}",
                     "workflowName": self.source_name}
        existing = self.streams.get(actor_id)
        if existing:
            if self.demo or self.connection in ("LIVE", "PARTIAL"):
                existing.receive_actor(actor, self.stream_connection(actor))
            return
        party = [item for item in self.visible_actors()
                 if str(item.get("id") or "") not in ("", "all", "standby")]
        if not any(str(item["id"]) == actor_id for item in party):
            party = [actor]
        spot = self.placements.get(actor_id)
        if saved is None and spot:
            # A reopened window returns to where it last stood, whichever party showed it there.
            saved = {"x": spot["x"], "y": spot["y"], "placed": True, "manual": spot["manual"]}
        stream = StreamWindow(self, actor, self.stream_style(actor), saved, party)
        stream.party_id = str((saved or {}).get("party") or "")[:200] or (
            self.thread_id if self.thread_id != "all" else party_scope(actor))
        self.streams[actor_id] = stream
        stream.show_note(self.pinned_note(actor_id), self.pinned_undo(actor_id))
        if self.demo or self.connection in ("LIVE", "PARTIAL"):
            stream.receive_actor(actor, self.stream_connection(actor))
        self.save_position()

    def stream_connection(self, actor: dict) -> str:
        if self.demo:
            return "DEMO"
        if actor.get("needsInput"):
            return "NEEDS YOU"
        return self.connection

    def open_selected_stream(self) -> None:
        actor = getattr(self, "selected_actor", None)
        if actor:
            if self.thread_id == "all" and not self.demo:
                self.select_party_for_actor(actor)
            else:
                self.enter_party(str(actor.get("id") or ""))

    def enter_party(self, focus_id: str = "") -> None:
        if self.party_view == "compact" and self.thread_id != "all":
            self.focused_stream_id = focus_id
            self.condense_party()
        else:
            self.open_party(focus_id)

    def open_related_streams(self) -> None:
        actor = getattr(self, "selected_actor", None)
        if not actor:
            return
        if self.thread_id == "all" and not self.demo:
            self.select_party_for_actor(actor)
            return
        key = self.actor_group_key(actor)
        for related in self.visible_actors():
            if self.actor_group_key(related) == key:
                self.open_stream(related)
        self.align_streams()

    def calm_streams(self, actors: list[dict], focus_id: str) -> set[str]:
        """Which members get a window: the one asked for, those already open, anyone who needs you or
        failed, then the busiest and newest until STREAM_LIMIT. Returns the ids that wait on the roster."""
        now_ms = time.time() * 1000
        ranked = sorted(actors, key=lambda actor: priority_for(actor, now_ms), reverse=True)
        chosen = {str(actor["id"]) for actor in actors
                  if str(actor["id"]) == focus_id or str(actor["id"]) in self.streams
                  or priority_for(actor, now_ms)[0] >= 4}
        for actor in ranked:
            if len(chosen) >= STREAM_LIMIT:
                break
            chosen.add(str(actor["id"]))
        return {str(actor["id"]) for actor in actors} - chosen

    def open_party(self, focus_id: str = "", bring_forward: bool = True, *, from_poll: bool = False,
                   everyone: bool = False) -> None:
        """Open the selected source's goblins, including actors on other pages.

        Streams closed with × stay closed. A person expanding the party reopens the goblin they
        asked to focus, or every window if all were closed (otherwise nothing would appear);
        a poll never reopens any. Only the rally (open_full_party) reopens them all."""
        if self.thread_id == "all" and not self.demo:
            actor = next((item for item in self.visible_actors()
                          if str(item.get("id")) == focus_id), None)
            if actor:
                self.select_party_for_actor(actor)
            else:
                self.show_source_menu()
            return
        actors = [actor for actor in self.visible_actors()
                  if str(actor.get("id") or "") not in ("", "all", "standby")]
        if not actors:
            self.party_view = "expanded"
            self.display_mode = "expanded"
            self.show_loading_party()
            self.save_position()
            return
        member_ids = {str(actor["id"]) for actor in actors}
        closed = self.dismissed_ids(self.thread_id) & member_ids
        if closed and not from_poll:
            reopened = member_ids if closed >= member_ids else {focus_id} & closed
            if reopened:
                self.set_dismissed(self.thread_id, self.dismissed_ids(self.thread_id) - reopened)
                closed -= reopened
        candidates = [actor for actor in actors if str(actor["id"]) not in closed]
        # A large party opens calmly: a few windows, the rest a click away on the roster.
        self.roster_only = set() if everyone else self.calm_streams(candidates, focus_id)
        closed = closed | self.roster_only
        open_ids = [str(actor["id"]) for actor in actors if str(actor["id"]) not in closed]
        self.focused_stream_id = focus_id if focus_id in open_ids else open_ids[0] if open_ids else ""
        self.end_peek()
        for actor in actors:
            if str(actor["id"]) not in closed:
                self.open_stream(actor)
        for actor in actors:
            stream = self.streams.get(str(actor["id"]))
            if stream:
                stream.set_party(actors)
        self.party_mode = True
        self.display_mode = "expanded"
        self.party_view = "expanded"
        if hasattr(self, "party_dock"):
            self.party_dock.withdraw()
        # Placement is stable: open windows stay put and only newcomers take a free tile.
        self.align_streams()
        if bring_forward:
            self.bring_stream_forward(self.focused_stream_id)

    def open_full_party(self, focus_id: str = "") -> None:
        """The explicit rally: every member's window, including ones closed with ×."""
        if self.thread_id != "all" or self.demo:
            self.set_dismissed(self.thread_id, set())
        self.open_party(focus_id, everyone=True)

    def bring_stream_forward(self, actor_id: str) -> None:
        stream = self.streams.get(actor_id)
        if stream:
            if actor_id not in {str(actor.get("id")) for actor in self.visible_actors()} and not self.demo:
                self.follow_source(party_scope(stream.actor),
                                   str(stream.actor.get("name") or stream.actor.get("nickname") or actor_id),
                                   open_party=True, focus_id=actor_id)
                return
            self.focused_stream_id = actor_id
            self.party_mode = True
            self.align_streams()
            stream.window.lift()
            stream.window.focus_set()
            self.save_position()

    def close_stream(self, actor_id: str) -> None:
        stream = self.streams.get(actor_id)
        if stream:
            stream.close()

    def close_all_streams(self) -> None:
        for stream in list(self.streams.values()):
            stream.dispose()
        self.streams.clear()
        self.visible_stream_ids.clear()
        if self.thread_id != "all" or self.demo:
            self.condense_party()
        else:
            self.show_overview()
        self.save_position()

    def show_party_menu(self, actor_id: str = "") -> None:
        """Choose a party first, then focus or close its individual streams."""
        picker = tk.Menu(self.root, tearoff=False)
        picker.add_command(label="◂ All parties (launchpad)", command=self.show_launchpad)
        picker.add_command(label="Switch party: recent and by project…", command=self.show_source_menu)
        picker.add_command(label="Find a chat or workspace…", command=self.open_search)
        picker.add_command(label="Expand party streams", command=self.expand_party)
        picker.add_command(label="Condense to party", command=self.condense_party)
        picker.add_command(label="Hide party", command=self.hide_party)
        if self.thread_id == "all" and not self.demo:
            picker.entryconfigure("Expand party streams", state="disabled")
            picker.entryconfigure("Condense to party", state="disabled")
        notes = self.party_notes()
        if notes:
            picker.add_command(label=f"Read parting notes ({len(notes)})…", command=self.show_notes)
            picker.add_command(label="Clear this party's parting notes", command=self.clear_notes)
        picker.add_command(label=self.motion_label(), command=self.toggle_reduced_motion)
        picker.add_command(label="Close goblins", command=self.close)
        picker.add_command(label=QUIT_LABEL, command=self.quit_all)
        if actor_id in self.streams:
            stream = self.streams[actor_id]
            picker.add_command(label="Rename this goblin…",
                               command=lambda value=actor_id: self.rename_stream(value))
            picker.add_command(label="Stop motion preview" if stream.motion_preview else "Preview motions (demo)",
                               command=stream.toggle_motion_preview)
        actors = [] if self.thread_id == "all" and not self.demo else [
            actor for actor in self.visible_actors()
            if str(actor.get("id") or "") not in ("", "all", "standby")]
        if actors:
            picker.add_command(label=f"Rally whole party ({len(actors)} goblins, reopens closed)",
                               command=self.open_full_party)
            picker.add_separator()
        for actor in actors:
            actor_id = str(actor["id"])
            name = self.display_name(actor)[:35]
            marker = "●" if actor_id in self.streams else "○"
            picker.add_command(label=f"{marker}  {name}",
                               command=lambda item=actor: self.open_and_focus_stream(item))
        if self.streams:
            picker.add_separator()
            bring_menu = tk.Menu(picker, tearoff=False)
            close_menu = tk.Menu(picker, tearoff=False)
            for actor_id, stream in self.streams.items():
                name = self.display_name(stream.actor)[:35]
                bring_menu.add_command(label=name,
                                       command=lambda value=actor_id: self.bring_stream_forward(value))
                close_menu.add_command(label=name,
                                       command=lambda value=actor_id: self.close_stream(value))
            picker.add_cascade(label="Focus or switch to a stream", menu=bring_menu)
            picker.add_cascade(label="Close a stream", menu=close_menu)
            picker.add_command(label="Close all streams", command=self.close_all_streams)
            picker.add_command(label="Rebalance party windows", command=self.rebalance_streams)
        picker.tk_popup(self.root.winfo_pointerx(), self.root.winfo_pointery())

    def open_and_focus_stream(self, actor: dict) -> None:
        """A roster tile or menu entry: reopen this one member's stream, even after ×."""
        self.reopen_member(str(actor["id"]))
        self.open_stream(actor)
        self.bring_stream_forward(str(actor["id"]))

    def peek_member(self, actor_id: str) -> None:
        """Open one member beside the compact roster without expanding the party."""
        if self.display_mode != "compact":
            return
        if self.peek_id == actor_id:
            self.end_peek()
            self.party_dock.refresh()
            self.save_position()
            return
        actor = next((item for item in self.visible_actors()
                      if str(item.get("id")) == actor_id), None)
        if not actor:
            return
        self.end_peek()
        self.reopen_member(actor_id)
        self.open_stream(actor)
        stream = self.streams[actor_id]
        stream.set_party(self.visible_actors())
        # A peek borrows the window; its tile in the expanded layout is remembered for later.
        self.peek_home = (stream.x, stream.y, stream.placed)
        left, top, right, bottom = monitor_work_area(self.root)
        dock = self.party_dock.window
        x = dock.winfo_x() - STREAM_WIDTH - 10
        if x < left:
            x = dock.winfo_x() + dock.winfo_width() + 10
        x = max(left, min(x, right - STREAM_WIDTH))
        y = max(top, min(dock.winfo_y(), bottom - STREAM_HEIGHT))
        stream.move_to(x, y)
        stream.window.deiconify()
        stream.window.lift()
        stream.ensure_latest_visible()
        self.peek_id = actor_id
        self.focused_stream_id = actor_id
        self.party_dock.refresh()
        self.save_position()

    def restore_streams(self) -> None:
        if self.closing:
            return
        for saved in self.saved_streams:
            actor = next((item for item in self.actors if str(item.get("id")) == str(saved["id"])), saved)
            self.open_stream(actor, saved)
        if self.display_mode == "compact" and self.thread_id != "all":
            self.condense_party()
        elif self.display_mode == "hidden":
            self.show_loading_party(hidden=True)
        elif self.party_mode and self.streams:
            if self.actors:
                self.align_streams()
        elif self.display_mode == "overview" or self.thread_id == "all":
            self.show_overview()

    def end_peek(self) -> None:
        """Close a roster peek and give the stream back its remembered tile."""
        stream = self.streams.get(self.peek_id)
        if stream:
            stream.window.withdraw()
            if self.peek_home:
                stream.x, stream.y, stream.placed = self.peek_home
        self.peek_id = ""
        self.peek_home = None

    def rebalance_streams(self) -> None:
        """The one explicit retile: forget every remembered and hand-placed position and tile again.

        Closed members' spots are forgotten too, so reopening one later takes a fresh tile."""
        forget = set(self.streams) | self.dismissed_ids(self.thread_id)
        for stream in self.streams.values():
            stream.placed = stream.manual = False
        self.placements = {key: value for key, value in self.placements.items() if key not in forget}
        self.align_streams(retile=True)

    def set_home_view(self, view: str) -> None:
        self.home_view = "line" if view == "line" else "launchpad"
        self.save_position()
        if self.display_mode == "overview":
            self.show_home()

    def show_home(self, launchpad: bool | None = None) -> None:
        if launchpad is None:
            launchpad = self.home_view == "launchpad"
        if launchpad:
            self.root.withdraw()
            self.launchpad.show()
            self.kick_board()
        else:
            self.launchpad.withdraw()
            self.last_drawn = ""
            self.draw()
            self.root.deiconify()
            self.root.lift()

    def hide_home(self) -> None:
        self.root.withdraw()
        if hasattr(self, "launchpad"):
            self.launchpad.withdraw()

    def show_overview(self, launchpad: bool | None = None) -> None:
        """Go home. The selected party keeps updating so one click returns to it."""
        self.party_mode = False
        self.display_mode = "overview"
        self.pending_party = None
        self.end_peek()
        if hasattr(self, "party_dock"):
            self.party_dock.withdraw()
        if self.notes_panel:
            self.notes_panel.withdraw()
        for stream in self.streams.values():
            stream.set_follow(True)
            stream.window.withdraw()
        self.visible_stream_ids.clear()
        self.show_home(launchpad)
        self.save_position()

    def show_launchpad(self) -> None:
        """Every "◂ ALL" button: the list of all parties, whichever home view is preferred."""
        self.show_overview(launchpad=True)

    def show_loading_party(self, hidden: bool = False) -> None:
        """Show a safe party surface without changing the chosen layout."""
        self.party_mode = False
        for stream in self.streams.values():
            stream.window.withdraw()
        self.visible_stream_ids.clear()
        self.hide_home()
        if hidden:
            self.party_dock.show_hidden()
        else:
            self.party_dock.show_compact()

    def condense_party(self) -> None:
        """Replace all stream windows with one party roster."""
        if self.thread_id == "all" and not self.demo:
            return
        self.party_mode = False
        self.display_mode = "compact"
        self.party_view = "compact"
        self.end_peek()
        for stream in self.streams.values():
            stream.set_follow(True)
            stream.window.withdraw()
        self.visible_stream_ids.clear()
        self.hide_home()
        self.party_dock.show_compact()
        self.save_position()

    def hide_party(self) -> None:
        """Hide the party while keeping a small, one-click restore tab."""
        if self.display_mode != "hidden":
            self.hidden_from = self.display_mode
        self.party_mode = False
        self.display_mode = "hidden"
        if self.notes_panel:
            self.notes_panel.withdraw()
        for stream in self.streams.values():
            stream.set_follow(True)
            stream.window.withdraw()
        self.visible_stream_ids.clear()
        self.hide_home()
        self.party_dock.show_hidden()
        self.kick_board()
        self.save_position()

    def expand_party(self) -> None:
        if self.thread_id == "all" and not self.demo:
            self.show_overview()
        else:
            self.party_view = "expanded"
            self.open_party(self.focused_stream_id)

    def restore_hidden_party(self) -> None:
        if self.hidden_from == "overview":
            self.show_overview()
        elif self.hidden_from == "compact":
            self.condense_party()
        else:
            self.expand_party()

    def on_stream_closed(self, actor_id: str, party_id: str = "") -> None:
        """× closes only this window: the member stays in the roster, and is not retired.

        The closure is remembered for the selected party so polls and restarts leave it shut;
        its roster tile, a member menu entry, or the rally reopens it. A window kept from an
        earlier party (closed from the menu) is remembered for that party alone."""
        if not actor_id.startswith("demo-"):
            members = set() if self.thread_id == "all" else {
                str(actor.get("id")) for actor in self.visible_actors()} | self.parted
            owner = self.thread_id if actor_id in members else party_id
            self.set_dismissed(owner, self.dismissed_ids(owner) | {actor_id})  # Ignores "" and "all".
        if self.peek_id == actor_id:
            self.peek_id = ""
            self.peek_home = None
            self.party_dock.refresh()
        self.visible_stream_ids.discard(actor_id)
        if self.focused_stream_id == actor_id:
            self.focused_stream_id = next(iter(self.visible_stream_ids), "")
        if self.streams and self.party_mode:
            # The closed window leaves a gap; the remaining windows stay where they are.
            self.align_streams()
        elif not self.streams:
            self.condense_party() if self.thread_id != "all" or self.demo else self.show_overview()
        self.save_position()

    def on_manual_stream_move(self, stream: StreamWindow | None = None) -> None:
        """A stream the person moved (by dragging or with Windows' keys) keeps that spot."""
        if stream is not None:
            if stream.actor_id == self.peek_id and self.peek_home:
                # Moving a peek gives the window a new home rather than snapping it back later.
                self.peek_home = (stream.x, stream.y, True)
            self.remember_placement(stream.actor_id, stream.x, stream.y, stream.manual)
        self.save_position()

    def align_streams(self, retile: bool = False) -> None:
        if not self.streams:
            if self.thread_id != "all" or self.demo:
                self.condense_party()
            return
        party_ids = {str(actor.get("id")) for actor in self.visible_actors()} if self.thread_id != "all" or self.demo else set()
        # A retired member's open stream keeps its tile to show the pinned note until it is closed.
        party_ids |= {actor_id for actor_id in self.parted
                      if actor_id in self.streams and self.streams[actor_id].window.winfo_ismapped()}
        # A window closed with × for this party stays closed, even one kept open by another party.
        party_ids -= self.dismissed_ids(self.thread_id)
        members =[stream.actor for actor_id, stream in self.streams.items() if actor_id in party_ids]
        if not members:
            if self.connection in ("CONNECTING", "STALE", "OFFLINE"):
                self.show_loading_party()
            else:
                self.condense_party()
            return
        member_ids = {actor_id for actor_id in self.streams if actor_id in party_ids}
        # A spot on a display that is gone (or otherwise out of reach) is forgotten, so the
        # window is tiled again instead of opening where nobody can see or grab it.
        areas = monitor_areas()
        for actor_id in member_ids:
            stream = self.streams[actor_id]
            if (stream.placed or stream.manual) and not reachable((stream.x, stream.y), STREAM_GRIP, areas):
                stream.placed = stream.manual = False
        lost = {actor_id for actor_id in member_ids
                if not reachable((self.streams[actor_id].x, self.streams[actor_id].y), STREAM_GRIP, areas)}
        # Windows the person placed by hand stay exactly there, on any display, and never
        # compete for tiles; only Rebalance (retile) puts them back on the grid.
        pinned = {} if retile else {actor_id: (self.streams[actor_id].x, self.streams[actor_id].y)
                                    for actor_id in member_ids if self.streams[actor_id].manual}
        plan = tile_plan([actor for actor in members if str(actor.get("id")) not in pinned],
                         monitor_work_area(self.root), STREAM_WIDTH, STREAM_HEIGHT, self.focused_stream_id)
        # The plan decides who gets a tile; stable_layout decides where. Polls, joins, and
        # outages therefore never drag a window someone is reading or has arranged.
        shown = {} if retile else {actor_id: (stream.x, stream.y) for actor_id, stream in self.streams.items()
                                   if actor_id in plan.positions and actor_id not in lost
                                   and stream.window.winfo_ismapped()}
        remembered = {} if retile else {actor_id: (stream.x, stream.y) for actor_id, stream in self.streams.items()
                                        if actor_id in plan.positions and stream.placed}
        positions = stable_layout(plan, shown, remembered, STREAM_WIDTH, STREAM_HEIGHT, pinned)
        loops = loop_groups(members)
        self.visible_stream_ids = set(positions)
        # A retired member's pinned-note window is not a live tile: "2/2 TILES" counts the party.
        live_shown = sum(actor_id not in self.parted for actor_id in positions)
        live_total = sum(str(actor.get("id")) not in self.parted for actor in members)
        for actor_id, stream in self.streams.items():
            if actor_id in positions:
                newly_shown = not stream.window.winfo_ismapped()
                if (stream.x, stream.y) != positions[actor_id] or newly_shown:
                    stream.move_to(*positions[actor_id])
                stream.placed = True
                self.remember_placement(actor_id, *positions[actor_id], stream.manual)
                stream.window.deiconify()
                if newly_shown:
                    stream.ensure_latest_visible()
                stream.set_flow(workflow_for(stream.actor)[0] in loops, live_shown, live_total)
            else:
                if stream.window.winfo_ismapped():
                    stream.set_follow(True)
                stream.window.withdraw()
        self.party_mode = True
        self.display_mode = "expanded"
        self.party_view = "expanded"
        if hasattr(self, "party_dock"):
            self.party_dock.withdraw()
        self.hide_home()
        self.save_position()

    def toggle_demo(self) -> None:
        self.demo = not self.demo
        self.refresh_parted()
        if not self.demo:
            for actor_id in [item for item in self.streams if item.startswith("demo-")]:
                self.close_stream(actor_id)
        self.menu.entryconfigure(12, label="Return to live agents" if self.demo else "Preview goblin actions")
        self.last_drawn = ""
        self.page = 0
        self.draw()
        if not self.demo:
            self.fetch_now()

    def change_outfits(self) -> None:
        self.palette_offset = (self.palette_offset + 1) % len(KINDS)
        self.save_position()
        self.last_drawn = ""
        self.draw()
        self.launchpad.refresh()

    def motion_label(self) -> str:
        return "Animate goblin actions" if self.reduced_motion else "Still goblins (reduce motion)"

    def toggle_reduced_motion(self) -> None:
        """Switch between animated cues and one still, readable frame per action."""
        self.reduced_motion = self.reduced_motion_choice = not self.reduced_motion
        self.menu.entryconfigure(self.motion_menu_index, label=self.motion_label())
        self.save_position()
        self.last_drawn = ""
        self.draw()
        self.launchpad.refresh(force=True)
        self.party_dock.refresh()
        for stream in self.streams.values():
            stream.render_sprite()
            stream.paint_roster()

    def sprite_action(self, actor: dict, connection: str, needs_input: bool = False) -> str:
        """The public action a goblin acts out; an unconfirmed connection shows it resting."""
        if connection in ("CONNECTING", "STALE", "OFFLINE"):
            return "idle"
        return self.acted(actor, needs_input or bool(actor.get("needsInput")))

    def acted(self, actor: dict, needs_input: bool = False) -> str:
        """The goblin's action, briefly acting out each new public step even once it has finished.

        Still goblins keep their steady action; the shared record still notes what they have seen."""
        return self.action_pulses.action(actor, needs_input=needs_input, animate=not self.reduced_motion)

    def status_for(self, actor: dict, connection: str) -> MemberStatus:
        """The words beside a goblin: while it acts out a finished step, what it just did."""
        status = member_status(actor, connection)
        if self.reduced_motion or connection in ("CONNECTING", "STALE", "OFFLINE"):
            return status
        return with_pulse(status, self.action_pulses.pulsing(str(actor.get("id") or "")))

    def paint_member(self, canvas: tk.Canvas, key: tuple, tag: str, x: int, y: int, style: dict,
                     actor: dict, connection: str, exit_beat: int | None = None,
                     exit_outcome: str = "finished") -> None:
        """Draw one 2x goblin; a new action always starts on its first frame."""
        action = self.sprite_action(actor, connection)
        frame = self.motion_clock.frame(key, action, self.phase)
        self.draw_sprite(x, y, style, canvas=canvas, action=action, frame=frame, scale=2,
                         still=self.reduced_motion, tag=tag, exit_beat=exit_beat, exit_outcome=exit_outcome)

    # Retirement ------------------------------------------------------------
    def refresh_parted(self) -> None:
        """Members of the selected party that have retired and finished their portal."""
        if self.thread_id == "all" or self.demo:
            self.parted_outcomes = {}
        else:
            self.parted_outcomes = self.retirement.retired(self.thread_id)
        self.parted = frozenset(actor_id for actor_id in self.parted_outcomes if actor_id not in self.exits)

    def exit_beat(self, actor_id: str) -> int | None:
        """The portal beat every surface shows for this member, from one shared start time."""
        leaving = self.exits.get(actor_id)
        if leaving is None:
            return PORTAL_BEATS - 1 if actor_id in self.parted else None
        return min(PORTAL_BEATS - 1, int((time.monotonic() - leaving.start) / EXIT_BEAT_SECONDS))

    def exit_outcome(self, actor_id: str) -> str:
        """How a member's portal plays: only a finished turn waves goodbye."""
        leaving = self.exits.get(actor_id)
        return leaving.outcome if leaving else self.parted_outcomes.get(actor_id, "finished")

    def observe_party(self, party_id: str, agents: list[dict], complete: bool) -> list[dict]:
        """Feed one selected-party read to the retirement tracker; return the members to show.

        With reduced motion there is no portal: the goblin leaves at once and its note is
        ready immediately, rather than a half-sunk still frame followed by a jump."""
        transitions, held = self.retirement.observe(party_id, self.root_id, agents, complete=complete)
        now_ms = time.time() * 1000
        for change in transitions:
            if change.kind == "revived":
                self.exits.pop(change.actor_id, None)
                self.notes.remove(party_id, change.actor_id)
                if self.undo and self.undo.party == party_id:
                    # A goblin back at work has no note to bring back.
                    kept = [note for note in self.undo.notes if note["id"] != change.actor_id]
                    self.undo = self.undo._replace(notes=kept) if kept else None
            else:
                self.notes.add(parting_note(change.actor, party_id, self.source_name, change.outcome, now_ms), now_ms)
                if not self.reduced_motion:
                    self.exits[change.actor_id] = Exit(time.monotonic(), change.outcome, change.actor, change.index)
        if transitions or self.retirement.changed:
            self.refresh_parted()
            self.save_position()
        # A member that just vanished stays in its place until a second complete read, then portals out.
        ghosts = held + [(leaving.index, leaving.actor) for leaving in self.exits.values() if leaving.outcome == "left"]
        members = list(agents)
        listed = {str(actor.get("id")) for actor in agents}
        for index, actor in sorted(ghosts, key=lambda ghost: ghost[0]):
            if str(actor.get("id")) not in listed:
                members.insert(min(index, len(members)), actor)
                listed.add(str(actor.get("id")))
        return members

    def finish_exits(self) -> None:
        """Retire every member whose portal has played out, once, from the live party."""
        if not self.exits:
            return
        now = time.monotonic()
        done = [actor_id for actor_id, leaving in self.exits.items() if now - leaving.start >= EXIT_SECONDS]
        if not done:
            return
        departed = {actor_id for actor_id in done if self.exits.pop(actor_id).outcome == "left"}
        self.actors = [actor for actor in self.actors if str(actor.get("id")) not in departed]
        self.refresh_parted()
        members = self.visible_actors()
        member_ids = {str(actor.get("id")) for actor in members}
        for actor_id, stream in self.streams.items():
            if stream.window.winfo_ismapped() and (actor_id in member_ids or actor_id in done):
                stream.set_party(members)
                if actor_id in done:
                    stream.render_sprite()
        self.refresh_notes_ui()
        if self.party_dock.mode:
            self.party_dock.refresh()
        self.last_drawn = ""
        self.draw()

    def party_notes(self) -> list[dict]:
        """The selected party's notes, newest first, once each goblin's portal has closed."""
        if self.thread_id == "all" or self.demo:
            return []
        return [note for note in self.notes.for_party(self.thread_id) if note["id"] not in self.exits]

    def pinned_note(self, actor_id: str) -> dict | None:
        if actor_id not in self.parted:
            return None
        return next((note for note in self.party_notes() if note["id"] == actor_id), None)

    def note_name(self, note: dict) -> str:
        return self.display_name({"id": note["id"], "name": note["name"]})

    def pinned_undo(self, actor_id: str) -> bool:
        """True while this retired member's dismissed note can still be brought back."""
        undo = self.party_undo()
        return bool(undo and actor_id in self.parted and any(note["id"] == actor_id for note in undo.notes))

    def refresh_notes_ui(self) -> None:
        for actor_id, stream in self.streams.items():
            stream.show_note(self.pinned_note(actor_id), self.pinned_undo(actor_id))
        if self.notes_panel:
            self.notes_panel.refresh()

    def show_notes(self, focus_id: str = "") -> None:
        if self.thread_id == "all" or self.demo:
            return
        if self.notes_panel is None:
            self.notes_panel = NotesPanel(self)
        self.notes_panel.show(focus_id)

    def read_notes_from_tab(self) -> None:
        """The hidden tab's ✉: back to the roster, the party's launchpad, with the notes beside it."""
        notes = self.party_notes()
        newest_new = next((note["id"] for note in notes if not note.get("read")), "")
        self.condense_party()
        if notes:
            self.show_notes(newest_new or notes[0]["id"])

    def mark_notes_read(self) -> None:
        if self.thread_id != "all" and self.notes.mark_read(self.thread_id):
            self.save_position()
            if self.party_dock.mode:
                self.party_dock.refresh()

    def notes_changed(self) -> None:
        self.save_position()
        self.refresh_notes_ui()
        if self.party_dock.mode:
            self.party_dock.refresh()

    def party_undo(self) -> Undo | None:
        """The one pending UNDO, if it belongs to the selected party and has not run out."""
        undo = self.undo
        if undo and (undo.party != self.thread_id or time.monotonic() >= undo.until):
            return None
        return undo

    def offer_undo(self, party_id: str, notes: list[dict], label: str) -> None:
        """Keep what was just removed for one UNDO; a newer removal replaces it."""
        self.undo = Undo(party_id, notes, label, time.monotonic() + UNDO_SECONDS) if notes else None
        self.notes_changed()

    def dismiss_note(self, party_id: str, actor_id: str) -> None:
        """Dismissing a note keeps the goblin retired; only new work brings it back. UNDO restores it."""
        taken = self.notes.take(party_id, actor_id)
        if taken:
            self.offer_undo(party_id, taken, f"the note from {self.note_name(taken[0])}")

    def clear_notes(self) -> None:
        if self.thread_id == "all":
            return
        taken = self.notes.take_party(self.thread_id)
        if taken:
            self.offer_undo(self.thread_id, taken, f"{len(taken)} notes" if len(taken) > 1
                            else f"the note from {self.note_name(taken[0])}")

    def undo_notes(self) -> None:
        """Bring back the last dismissed or cleared notes of goblins that are still retired."""
        undo = self.party_undo()
        self.undo = None
        if undo:
            retired = self.retirement.retired(undo.party)
            self.notes.restore([note for note in undo.notes if note["id"] in retired], time.time() * 1000)
        self.notes_changed()

    def expire_undo(self) -> None:
        if self.undo and time.monotonic() >= self.undo.until:
            self.undo = None
            self.refresh_notes_ui()
            if self.party_dock.mode:
                self.party_dock.refresh()

    def open_note_chat(self, note: dict) -> None:
        self.open_viewer({"id": note["id"], "source": note["source"], "parentThreadId": note["parent"]})

    def fetch_scene(self, scope: str) -> dict:
        suffix = f"?id={urllib.parse.quote(scope)}"
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/api/scene{suffix}", timeout=20) as response:
            return json.load(response)

    def update_party_streams(self, root: dict, agents: list[dict], warning: bool) -> None:
        """Refresh every open member from the one selected-party read."""
        scene_actors = {str(actor["id"]): actor for actor in (root, *agents)
                        if actor and actor.get("id")}
        members = self.visible_actors() if self.thread_id != "all" else []
        for actor_id, stream in self.streams.items():
            actor = scene_actors.get(actor_id)
            if actor:
                condition = "NEEDS YOU" if actor.get("needsInput") else "PARTIAL" if warning else "LIVE"
                # Lay out the new party first; receive_actor paints it once with the fresh actor.
                if members:
                    stream.set_party(members, paint=False)
                stream.receive_actor(actor, condition)

    def poll(self) -> None:
        if self.closing:
            return
        try:
            self.fetch_now()
        finally:
            if not self.closing:
                self.poll_after = self.root.after(3000, self.poll)

    def fetch_now(self) -> None:
        if self.closing or self.paused or self.demo:
            return
        if self.pending is not None and self.pending_scope != self.thread_id:
            # A new party must not wait behind the old one's read; that late answer is simply dropped.
            if self.receive_after:
                self.root.after_cancel(self.receive_after)
                self.receive_after = None
            self.pending = None
        if self.pending is None:
            self.pending_scope = self.thread_id
            self.pending = self.executor.submit(self.fetch_scene, self.pending_scope)
            self.receive_after = self.root.after(100, self.receive_scene)

    def receive_scene(self) -> None:
        if self.closing:
            return
        if self.pending is None or not self.pending.done():
            self.receive_after = self.root.after(100, self.receive_scene)
            return
        future, scope = self.pending, self.pending_scope
        self.pending = None
        # Only the read and its shape count as connection loss; rendering errors surface as errors.
        try:
            scene = future.result()
            root = scene["root"]
        except Exception:
            if scope == "all":
                self.board_connection = "STALE" if self.board_success else "OFFLINE"
            if scope == self.thread_id:
                self.connection = "STALE" if self.last_success else "OFFLINE"
                self.message = "Connection lost. Retrying…" if self.last_success else "Goblin Horde is unavailable. Retrying…"
                current_ids = {str(actor.get("id")) for actor in self.actors}
                for actor_id, stream in self.streams.items():
                    if actor_id in current_ids:
                        stream.render_actor(stream.actor, "STALE" if stream.last_success else "OFFLINE")
                # Expanded streams stay open and marked stale; only an empty desktop falls back to the roster.
                if self.display_mode == "expanded" and not self.visible_stream_ids:
                    self.show_loading_party()
        else:
            if scope != self.thread_id or self.demo:
                self.fetch_now()
                return
            if scope == "all":
                # The all-parties poll already read the launchpad's feed; the board reuses it.
                self.take_board_scene(scene)
            if scene.get("requests"):
                root = {**root, "needsInput": True}
            self.root_id = root.get("id", "")
            self.source_name = "Recent activity" if scope == "all" else str(root.get("name") or self.source_name)
            agents = scene.get("agents") or []
            if scope != "all":
                # Only a selected party's members can retire; a failed or 404 read never gets here.
                agents = self.observe_party(scope, agents, complete=not scene.get("warning"))
            self.actors = ([root] if root.get("activities") else []) + agents
            self.connection = "PARTIAL" if scene.get("warning") else "LIVE"
            self.attention = "INPUT" if scene.get("requests") else ""
            if not self.attention:
                latest = [actor.get("activities", [])[-1] for actor in self.actors if actor.get("activities")]
                if any(item.get("status") == "failed" or item.get("exitCode") not in (None, 0) for item in latest):
                    self.attention = "FAILED"
                elif any(item.get("status") == "inProgress" for item in latest):
                    self.attention = "WORKING"
            self.message = "No recent activity in this source."
            self.last_success = time.time()
            self.update_party_streams(root, agents, bool(scene.get("warning")))
            if self.pending_party and self.pending_party[0] == scope:
                _, focus_id = self.pending_party
                self.pending_party = None
                # Someone who went home or hid the party while it loaded is not pulled back.
                if self.display_mode in ("compact", "expanded"):
                    if self.party_view == "compact":
                        self.focused_stream_id = focus_id
                        self.condense_party()
                        self.apply_pending_peek()
                    else:
                        self.open_party(focus_id)
            elif self.display_mode == "expanded" and scope != "all":
                # A stream closed with × stays closed; only genuinely new members open here.
                # Members waiting on the roster by choice are not "missing" windows.
                party_ids = ({str(actor.get("id")) for actor in self.visible_actors()} - self.dismissed_ids(scope)
                             - self.roster_only)
                if not self.party_mode or any(actor_id not in self.streams for actor_id in party_ids):
                    # A joining member or a recovered feed gets a free tile without stealing focus.
                    self.open_party(self.focused_stream_id, bring_forward=False, from_poll=True)
                else:
                    self.align_streams()
            self.refresh_notes_ui()
        if self.party_dock.mode:
            self.party_dock.refresh()
        self.launchpad.refresh()
        self.draw()

    def board_wanted(self) -> bool:
        return ((self.display_mode == "overview" and self.launchpad.shown)
                or (self.display_mode == "hidden" and self.hidden_from == "overview"))

    def kick_board(self) -> None:
        """Read the all-parties scene now instead of waiting for the next tick."""
        if self.closing or not hasattr(self, "launchpad"):
            return
        self.board_requested = 0.0
        if self.board_after:
            self.root.after_cancel(self.board_after)
        self.board_after = self.root.after(10, self.poll_board)

    def poll_board(self) -> None:
        """The launchpad has its own feed, so the selected party keeps its focused feed."""
        self.board_after = None
        if self.closing:
            return
        try:
            future = self.board_pending
            if future is not None and future.done():
                self.board_pending = None
                try:
                    self.take_board_scene(future.result())
                except Exception:
                    # Keep the last good rows in place and say how old they are.
                    self.board_connection = "STALE" if self.board_success else "OFFLINE"
                self.launchpad.refresh()
                if self.party_dock.mode == "hidden":
                    self.party_dock.refresh()
            elif (future is None and not self.paused and self.board_wanted()
                  # Following all parties, the main poll reads the same scene and hands it to the board.
                  and (self.thread_id != "all" or self.demo)
                  and time.monotonic() - self.board_requested >= BOARD_SECONDS):
                self.board_requested = time.monotonic()
                self.board_pending = self.executor.submit(self.fetch_scene, "all")
        finally:
            # A refresh that fails must not end the board's updates.
            if not self.closing and self.board_after is None:
                self.board_after = self.root.after(150 if self.board_pending else 1000, self.poll_board)

    def take_board_scene(self, scene: dict) -> None:
        self.take_watched(scene.get("watched"))
        if isinstance(scene.get("joinedParties"), dict):
            self.joined_parties = {str(key): str(value) for key, value in scene["joinedParties"].items()}
        if isinstance(scene.get("manualLinks"), dict):
            self.manual_links = {str(key): str(value) for key, value in scene["manualLinks"].items()}
        self.board_actors = [actor for actor in scene.get("agents") or [] if actor.get("id")]
        self.board_coverage = scene.get("coverage") or {}
        self.board_connection = "PARTIAL" if scene.get("warning") else "LIVE"
        self.board_success = time.time()
        self.board_requested = time.monotonic()
        try:
            self.board_age = max(0.0, (float(scene.get("servedAt")) - float(scene.get("checkedAt"))) / 1000)
        except (TypeError, ValueError):
            self.board_age = 0.0

    def board_cards(self):
        """Working and recent parties. The selected party uses its fuller focused scene."""
        actors = list(self.board_actors)
        if self.thread_id != "all" and self.actors and self.connection in ("LIVE", "PARTIAL", "STALE"):
            # Keep the machine-wide feed's classification so counts match before and after a visit.
            feed = {str(actor["id"]): actor["attention"] for actor in actors if actor.get("attention")}
            focused = [actor if actor.get("attention") or str(actor["id"]) not in feed
                       else {**actor, "attention": feed[str(actor["id"])]}
                       for actor in self.actors if actor.get("id") and actor.get("id") != "all"]
            ids = {str(actor["id"]) for actor in focused}
            actors = [actor for actor in actors
                      if str(actor.get("id")) not in ids and party_scope(actor) != self.thread_id] + focused
        active, recent, older = launchpad_board(actors, self.source_catalog, self.board_order,
                                                watched=self.watched_ids)
        self.board_order = [card.id for card in active]
        self.board_watching = watched_cards(actors, self.source_catalog, self.watched_ids,
                                            {card.id for card in active})
        return active, recent, older

    def animate(self) -> None:
        if self.closing:
            return
        # The beat is rescheduled even when a step fails, so one bad frame never freezes the goblins.
        try:
            self.animate_step()
        finally:
            if not self.closing:
                self.animate_after = self.root.after(360, self.animate)

    def animate_step(self) -> None:
        self.phase += 1
        now = time.monotonic()
        self.finish_exits()
        self.expire_undo()
        # Still goblins are repainted only when their action changes, by each surface's refresh.
        if not self.paused and not self.reduced_motion:
            # The goblin-line canvas is withdrawn while the launchpad or a party is home.
            for index, actor in enumerate(self.page_actors() if self.root.winfo_ismapped() else ()):
                style = style_for(actor, self.palette_offset)
                self.paint_overview_sprite(index, actor, style)
            self.launchpad.animate()
            self.party_dock.animate()
        if not self.paused:
            self.advance_visible_text(now)
        if (self.rotating and not self.paused and not self.hovered and self.page_count() > 1
                and now - self.page_changed_at >= (5 if self.demo else 8)
                and (self.visible_text_complete(now)
                     or now - self.page_changed_at >= MAX_PAGE_HOLD_SECONDS)):
            self.change_page(1)

    def close(self) -> None:
        if self.closing:
            return
        self.closing = True
        self.save_position()
        for callback in (self.restore_after, self.poll_after, self.receive_after, self.animate_after,
                         self.catalog_after, self.board_after, self.sources_after, self.show_after):
            if callback:
                self.root.after_cancel(callback)
        for stream in self.streams.values():
            stream.dispose()
        self.streams.clear()
        if self.notes_panel:
            self.notes_panel.destroy()
        self.party_dock.destroy()
        self.launchpad.destroy()
        self.executor.shutdown(wait=False, cancel_futures=True)
        self.root.destroy()

    def visible_actors(self) -> list[dict]:
        if self.demo:
            return [
                {"id": f"demo-{i}", "nickname": kind["name"], "outfit": kind["name"], "status": "working",
                 **DEMO_IDENTITY[kind["tribe"]],
                 "activities": [{"kind": "update", "title": "Update", "description": line}]}
                for i, (kind, line) in enumerate(zip(DEMO_KINDS, [
                    "I’m searching for a fresh trail of clues.", "I’m building the next piece.",
                    "I’m thinking through the layout.", "I’m investigating the signals.",
                    "I’m editing this little scene.", "I’m checking the details.",
                    "I’m planning a brighter color.", "I’m building with the team."
                ]))
            ]
        return [actor for actor in self.actors
                if str(actor.get("id")) not in self.hidden_ids and str(actor.get("id")) not in self.parted]

    def page_count(self) -> int:
        return max(1, (len(self.visible_actors()) + self.columns - 1) // self.columns)

    def page_actors(self) -> list[dict]:
        actors = self.visible_actors()
        if not actors:
            return [{"id": "standby", "nickname": "Moss", "activities": [
                {"kind": "update", "description": self.message}
            ]}]
        self.page %= self.page_count()
        return actors[self.page * self.columns:(self.page + 1) * self.columns]

    def actor_text(self, actor: dict) -> tuple[str, list[str], int, int]:
        actor_id = str(actor.get("id") or "standby")
        line = latest_line(actor)
        if self.text_keys.get(actor_id) != line:
            self.text_keys[actor_id] = line
            self.text_lines[actor_id] = wrap_text(self.body_font, line, COL_WIDTH - 42)
            self.text_offsets[actor_id] = 0
            self.text_advanced_at[actor_id] = time.monotonic()
        lines = self.text_lines[actor_id]
        offset, _, maximum = text_window(lines, self.text_offsets.get(actor_id, 0))
        return actor_id, lines, offset, maximum

    def shift_text(self, actor: dict, amount: int) -> None:
        actor_id, _lines, offset, maximum = self.actor_text(actor)
        next_offset = max(0, min(maximum, offset + amount))
        if next_offset != offset:
            self.text_offsets[actor_id] = next_offset
            self.text_advanced_at[actor_id] = time.monotonic()
            self.draw()

    def more_text(self, actor: dict) -> None:
        actor_id, _lines, offset, maximum = self.actor_text(actor)
        self.text_offsets[actor_id] = 0 if offset >= maximum else min(maximum, offset + TEXT_STEP)
        self.text_advanced_at[actor_id] = time.monotonic()
        self.draw()

    def advance_visible_text(self, now: float) -> None:
        changed = False
        for actor in self.page_actors():
            actor_id, _lines, offset, maximum = self.actor_text(actor)
            if offset < maximum and now - self.text_advanced_at[actor_id] >= TEXT_ADVANCE_SECONDS:
                self.text_offsets[actor_id] = min(maximum, offset + TEXT_STEP)
                self.text_advanced_at[actor_id] = now
                changed = True
        if changed:
            self.draw()

    def visible_text_complete(self, now: float) -> bool:
        for actor in self.page_actors():
            actor_id, _lines, offset, maximum = self.actor_text(actor)
            if offset < maximum or (maximum > 0 and now - self.text_advanced_at[actor_id] < TEXT_ADVANCE_SECONDS):
                return False
        return True

    def draw(self) -> None:
        actors = self.page_actors()
        fingerprint = repr([(actor.get("id"), latest_line(actor), self.actor_text(actor)[2],
                             goblin_action(actor, needs_input=self.attention == "INPUT" and actor.get("id") == self.root_id))
                            for actor in actors]) + repr((
            self.page, self.page_count(), self.palette_offset, self.connection, self.paused,
            self.rotating, self.thread_id, self.source_name, self.columns, self.attention,
            int((time.time() - self.last_success) / 60) if self.last_success and self.connection == "STALE" else 0,
        ))
        if fingerprint == self.last_drawn:
            return
        self.last_drawn = fingerprint
        self.canvas.delete("all")
        state = "DEMO" if self.demo else "PAUSED" if self.paused else (
            "NEEDS YOU" if self.attention == "INPUT" and self.connection == "LIVE" else self.connection
        )
        age = f" {max(0, int((time.time() - self.last_success) / 60))}m" if self.last_success and state in ("STALE", "PAUSED") else ""
        self.canvas.create_rectangle(8, 4, self.width - 8, 26, fill=CARD, outline=INK, width=1)
        self.canvas.create_text(14, 15, text=fit_text(self.meta_font, f"{state}{age} · {self.source_name} ▾", self.width - 116),
                                fill=INK, font=self.meta_font, anchor="w")
        self.canvas.create_rectangle(self.width - 96, 4, self.width - 8, 26, fill=INK, outline=INK)
        party_label = "CHOOSE ›" if self.thread_id == "all" and not self.demo else f"PARTY {len(self.visible_actors())} ›"
        self.canvas.create_text(self.width - 52, 15, text=party_label,
                                fill=CARD, font=self.meta_font)
        labels = ["◀", f"{self.page + 1}/{self.page_count()}", "▶", "AUTO" if self.rotating else "HOLD",
                  "GO" if self.paused else "PAUSE", "⋯"]
        control_width = (self.width - 16) / 6
        for index, label in enumerate(labels):
            left = int(8 + index * control_width)
            right = int(8 + (index + 1) * control_width)
            self.canvas.create_rectangle(left, 28, right, 52, fill=CARD, outline=INK, width=1)
            self.canvas.create_text((left + right) // 2, 40, text=fit_text(self.meta_font, label, right - left - 4),
                                    fill=INK, font=self.meta_font)
        for index, actor in enumerate(actors):
            style = style_for(actor, self.palette_offset)
            self.draw_goblin(index, index * COL_WIDTH + 9, actor, style)

    def draw_goblin(self, index: int, left: int, actor: dict, style: dict) -> None:
        x = left + 14
        y = 58
        right = left + COL_WIDTH - 8
        _actor_id, lines, offset, maximum = self.actor_text(actor)
        _, wrapped, _ = text_window(lines, offset)
        is_root = actor.get("id") == self.root_id and not self.demo
        label = "INSPECTOR" if is_root else self.display_name(actor)
        source = {"orca": "ORCA", "codex": "CODEX", "claude": "CLAUDE", "extension": "FEED"}.get(str(actor.get("source") or ""), "GOBLIN")
        status = member_status(actor, "LIVE" if self.demo else
                               "NEEDS YOU" if is_root and self.attention == "INPUT" else self.connection)
        actor_state = f"{status.glyph} {status.word}"
        project = str(actor.get("cwd") or "").replace("\\", "/").rstrip("/").split("/")[-1]
        age = actor.get("updatedAt")
        try:
            age_text = f" · {max(0, int((time.time() * 1000 - float(age)) / 60_000))}m ago" if age else ""
        except (TypeError, ValueError):
            age_text = ""
        badge = model_badge(actor)
        meta = f"{source}{(' · ' + badge) if badge else ''}{(' · ' + actor_state) if actor_state else ''}{age_text}"
        if not age_text and project:
            meta += f" · {project}"
        # Pixel border, solid paper, and a pointer anchored above the goblin.
        self.canvas.create_rectangle(x + 2, y + 3, right + 2, 189, fill=style["shade"], outline=style["shade"])
        self.canvas.create_rectangle(x, y, right, 186, fill=CARD, outline=INK, width=2)
        self.canvas.create_rectangle(x + 6, y + 7, x + 13, y + 14, fill=style["coat"], outline="")
        self.canvas.create_text(x + 20, y + 6, text=fit_text(self.header_font, label, right - x - 27),
                                anchor="nw", fill=style["coat"], font=self.header_font)
        self.canvas.create_text(x + 10, y + 25, text=fit_text(self.meta_font, meta, right - x - 20),
                                anchor="nw", fill=INK, font=self.meta_font)
        for line_index, text in enumerate(wrapped):
            self.canvas.create_text(x + 10, y + 47 + line_index * 17, text=text, anchor="nw", fill=INK,
                                    font=self.body_font)
        if maximum:
            ending = min(len(lines), offset + BODY_LINES)
            hint = "MORE ›" if offset < maximum else "REPLAY ↺"
            self.canvas.create_text(right - 9, y + 113, text=f"{offset + 1}–{ending}/{len(lines)}  {hint}",
                                    anchor="ne", fill=style["coat"], font=self.meta_font)
        self.canvas.create_polygon(left + 72, 186, left + 85, 186, left + 78, 197,
                                   fill=CARD, outline=INK, width=2)
        self.paint_overview_sprite(index, actor, style)

    def paint_overview_sprite(self, index: int, actor: dict, style: dict) -> None:
        tag = f"sprite-{index}"
        self.canvas.delete(tag)
        # The goblin line follows the same guard as every surface: no pulses on an unconfirmed feed.
        action = self.sprite_action(actor, "DEMO" if self.demo else self.connection,
                                    self.attention == "INPUT" and actor.get("id") == self.root_id)
        frame = self.motion_clock.frame(("line", str(actor.get("id") or index)), action, self.phase)
        actor_id = str(actor.get("id"))
        self.draw_sprite(index * COL_WIDTH + 58, 204, style, action=action, frame=frame,
                         still=self.reduced_motion, tag=tag, exit_beat=self.exit_beat(actor_id),
                         exit_outcome=self.exit_outcome(actor_id))

    def draw_sprite(self, x: int, y: int, style: dict, canvas: tk.Canvas | None = None,
                    action: str = "idle", frame: int = 0, scale: int = 4,
                    still: bool = False, tag: str = "", exit_beat: int | None = None,
                    exit_outcome: str = "finished") -> None:
        """Draw a goblin on a 17x16 pixel grid with its action cue in the 8 columns to its right.

        Body offsets and cues move whole sprite pixels, so every beat stays visible at scale 2.
        ``still`` draws one readable frame for reduced motion. ``exit_beat`` draws the retiring
        goblin sinking through a floor portal instead, in the same footprint; only a finished
        ``exit_outcome`` waves and sparkles on the way down.
        """
        c = canvas or self.canvas
        s = scale
        k = scale / 4  # The shadow was drawn for the 4x goblin.
        extra = {"tags": tag} if tag else {}
        leaving = exit_frame(exit_beat, still, exit_outcome) if exit_beat is not None else None
        ground_x, ground_y = x, y
        clip_y = None
        if leaving:
            action = "exit"
            pose = Pose(0, leaving.sink, leaving.arm)
            # The body vanishes row by row into the portal's middle line.
            clip_y = ground_y + PORTAL_CLIP * s
            for column, row, length, color in art_runs(leaving.ring or (), 0, PORTAL_TOP):
                c.create_rectangle(x + column * s, y + row * s, x + (column + length) * s, y + (row + 1) * s,
                                   fill=color, outline=color, tags=(tag, "exit") if tag else ("exit",))
        else:
            pose = pose_for(action, frame, still)
            c.create_oval(x + round(7 * k), y + round(69 * k), x + round(69 * k), y + round(80 * k),
                          fill="#6d765b", outline="", stipple="gray50", **extra)
        x += pose.dx * s
        y += pose.dy * s

        def block(ox: int, oy: int, px: int, py: int, w: int, h: int, color: str) -> None:
            top, bottom = oy + py * s, oy + (py + h) * s
            if clip_y is not None:
                if top >= clip_y:
                    return
                bottom = min(bottom, clip_y)
            c.create_rectangle(ox + px * s, top, ox + (px + w) * s, bottom,
                               fill=color, outline=color, **extra)

        def rect(px: int, py: int, w: int, h: int, color: str) -> None:
            block(x, y, px, py, w, h, color)

        def layer(name: str, dy: int = 0) -> None:
            for column, row, length, key in art_layer_runs(name):
                rect(column, row + dy, length, 1, art_color(key, style))
        # The body, face, and gear are the shared goblin_art.json sprite. Feet are drawn on their own:
        # a slumped goblin sinks onto planted feet, a hopping one lifts one, and a goblin going
        # through a portal takes its feet with it.
        feet_y = ground_y if pose.dy > 0 and not leaving else y
        for column, row, length, key in art_layer_runs(style.get("body", "body")):
            if row == FEET_ROW:
                lift = 1 if (pose.step == 1 and column < 8 + ART_COL) or (pose.step == 2 and column >= 8 + ART_COL) else 0
                block(x, feet_y, column, row - lift, length, 1, art_color(key, style))
            else:
                rect(column, row, length, 1, art_color(key, style))
        blink = action == "idle" and not still and frame % 12 in (10, 11)
        layer(ART_EYES["blink" if blink else pose.eyes if pose.eyes in ART_EYES else "front"], dy=-1 if pose.eyes == "up" else 0)
        layer(f"gear.{style['gear']}")

        # Held tools (magnifier, hammer) travel with the body; signs (thought, bell, cross)
        # float beside the head. Idle goblins carry nothing.
        # A portal shows its sparkle or the note left behind, never the work prop.
        cue = leaving.cue if leaving else cue_for(action, frame, still)
        if cue:
            cue_x, cue_y = (x, y) if action in HELD else (ground_x, ground_y)
            kind = "exit" if leaving else "cue"
            cue_tags = (tag, kind) if tag else (kind,)
            for column, row, length, color in cue_runs(cue):
                c.create_rectangle(cue_x + column * s, cue_y + row * s,
                                   cue_x + (column + length) * s, cue_y + (row + 1) * s,
                                   fill=color, outline=color, tags=cue_tags)
        # The right arm draws last so a goblin visibly grips its tool; it starts at the art's shoulder
        # (row 11) and ends where the held props in goblin_cues expect a hand.
        sleeve, skin, ink = style["coat"], style["skin"], ART["colors"]["K"]
        arm = pose.arm
        if arm == "reach":
            rect(13, 11, 2, 1, sleeve); rect(14, 10, 2, 1, sleeve); rect(16, 8, 1, 2, skin); rect(16, 10, 1, 1, ink)
        elif arm == "reach_high":
            rect(13, 11, 1, 1, sleeve); rect(14, 9, 1, 2, sleeve); rect(15, 8, 1, 1, sleeve); rect(16, 7, 1, 2, skin)
        elif arm == "raise":
            rect(13, 10, 2, 2, sleeve); rect(14, 8, 1, 2, sleeve); rect(15, 6, 2, 2, skin)
        elif arm == "chin":
            layer("armChin")
        elif arm == "wave_high":
            layer("waveUp")
        elif arm == "wave_low":
            layer("waveOut")
        elif arm == "slump":
            rect(13, 12, 1, 2, sleeve); rect(13, 14, 1, 1, skin); rect(14, 12, 1, 3, ink)
        else:
            layer(style.get("arm", "armRest"))

    def run(self) -> None:
        self.root.mainloop()


def main() -> None:
    parser = argparse.ArgumentParser(description="Transparent Goblin Horde desktop goblins")
    parser.add_argument("--thread", default="")
    parser.add_argument("--port", type=int, default=43917)
    parser.add_argument("--demo", action="store_true")
    args = parser.parse_args()
    try:
        widget = GoblinWidget(args.thread, args.port, args.demo)
    except (TransparencyUnavailable, tk.TclError) as error:
        # The manager reads this exit code and opens the browser viewer, saying why.
        print(f"Transparent desktop goblins are unavailable: {error}", file=sys.stderr, flush=True)
        sys.exit(UNAVAILABLE_EXIT)
    desktop_platform.close_on_terminate(widget.root, widget.close)
    desktop_platform.announce_ready()
    widget.run()


if __name__ == "__main__":
    main()
