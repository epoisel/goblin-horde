"""Independent, scrollable desktop streams for Goblin Horde actors."""

from __future__ import annotations

import ctypes
import time
import tkinter as tk
from tkinter import font as tkfont

from desktop_platform import WINDOWS_KEY, bind_context, float_window, make_transparent, menu_bar_inset, ui_font
from goblin_cues import ActionClock
from goblin_motion import ACTION_LABELS, PAST_LABELS, goblin_action
from goblin_parting import note_lines, outcome_word


WIDTH = 506
HEIGHT = 400
EVENT_BATCH = 60
TRANSPARENT = WINDOWS_KEY
INK = "#17271f"
# The camp palette shared with the browser viewer and the product reel.
DIALOGUE = "#1b2a22"
EVENT = "#243a2e"
ACTION = "#1f3228"
IVORY = "#f6ecd2"
MUTED = "#b3c9b4"
GOLD = "#dfbb78"
GROUP_COLORS = ("#3f7257", "#7061a2", "#a2644c", "#437a96", "#826539")
# The roster gutter holds whole 2x goblins, the same size as the compact party roster.
# A goblin, its cue, its hop, and its shadow span 48x44 pixels, so each tile is 50x46,
# with the slot number on a plaque in the empty corner below the cue.
ROSTER_COLUMNS = 2
ROSTER_ROWS = 5
ROSTER_STEP_X = 51
ROSTER_STEP_Y = 47
ROSTER_TILE = (49, 45)
ROSTER_SPRITE = (1, 5)  # Sprite origin inside a tile.
ROSTER_BADGE = (35, 33, 47, 44)
# Without a confirmed feed, the party's goblins rest without cues and hold still.
UNCONFIRMED = ("CONNECTING", "STALE", "OFFLINE")
# The explicit motion preview cycles every action, ending with the portal a retiring goblin uses.
PREVIEW_ACTIONS = ("search", "build", "think", "waiting", "exit")
PARCHMENT = "#f6ecd2"
NOTE_INK = "#24352b"
NOTE_FADED = "#4d5a4f"
NOTE_TITLE = "#5b4a7a"


def workflow_for(actor: dict) -> tuple[str, str]:
    """Return a stable grouping key and a short, human-readable group name."""
    if actor.get("workflowGroupId"):
        return str(actor["workflowGroupId"]), str(actor.get("workflowName") or "Codex team")
    source = str(actor.get("source") or "")
    parent = str(actor.get("parentThreadId") or "")
    path = str(actor.get("cwd") or "").replace("\\", "/").rstrip("/")
    parts = [part for part in path.split("/") if part]
    if source == "orca":
        if "workspaces" in parts:
            index = parts.index("workspaces")
            if index + 1 < len(parts):
                name = parts[index + 1]
                return f"orca-project:{name.lower()}", name
        if parent:
            return parent, parts[-1] if parts else "Orca workspace"
    if source == "claude" and parent:
        return parent, f"Claude · {parts[-1]}" if parts else "Claude Code session"
    if source == "extension" and parent:
        return parent, str(actor.get("workflowName") or "Extension feed")
    if parent:
        return f"codex-parent:{parent}", str(actor.get("workflowName") or "Codex team")
    if path:
        return f"workspace:{path.lower()}", parts[-1]
    return f"actor:{actor.get('id')}", "Other work"


def group_color(key: str) -> str:
    value = 2166136261
    for byte in key.encode("utf-8"):
        value = ((value ^ byte) * 16777619) & 0xffffffff
    return GROUP_COLORS[value % len(GROUP_COLORS)]


def monitor_work_area(window: tk.Misc) -> tuple[int, int, int, int]:
    """Use the monitor holding the widget, including a second Windows display."""
    try:
        class Rect(ctypes.Structure):
            _fields_ = [(name, ctypes.c_long) for name in ("left", "top", "right", "bottom")]

        class MonitorInfo(ctypes.Structure):
            _fields_ = [("cbSize", ctypes.c_ulong), ("rcMonitor", Rect),
                        ("rcWork", Rect), ("dwFlags", ctypes.c_ulong)]

        user32 = ctypes.windll.user32
        user32.MonitorFromWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        user32.MonitorFromWindow.restype = ctypes.c_void_p
        user32.GetMonitorInfoW.argtypes = [ctypes.c_void_p, ctypes.POINTER(MonitorInfo)]
        user32.GetMonitorInfoW.restype = ctypes.c_int
        monitor = user32.MonitorFromWindow(window.winfo_id(), 2)
        info = MonitorInfo()
        info.cbSize = ctypes.sizeof(MonitorInfo)
        if monitor and user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
            work = info.rcWork
            return work.left, work.top, work.right, work.bottom
    except (AttributeError, OSError, ValueError):
        pass
    # Elsewhere (macOS), the main display, below its menu bar.
    return (window.winfo_vrootx(), window.winfo_vrooty() + menu_bar_inset(),
            window.winfo_vrootx() + window.winfo_vrootwidth(),
            window.winfo_vrooty() + window.winfo_vrootheight())


def screen_geometry(x: int, y: int) -> str:
    """A Tk position from the virtual screen's origin. Tk reads "-300" as 300 pixels in from
    the right edge, so a display left of or above the primary needs "+-300"."""
    return f"+{int(x)}+{int(y)}"


def monitor_areas() -> list[tuple[int, int, int, int]]:
    """Work areas of every connected Windows display, including ones left of or above the primary.

    An empty list means the displays could not be read; callers then trust saved positions."""
    areas: list[tuple[int, int, int, int]] = []
    try:
        class Rect(ctypes.Structure):
            _fields_ = [(name, ctypes.c_long) for name in ("left", "top", "right", "bottom")]

        class MonitorInfo(ctypes.Structure):
            _fields_ = [("cbSize", ctypes.c_ulong), ("rcMonitor", Rect),
                        ("rcWork", Rect), ("dwFlags", ctypes.c_ulong)]

        user32 = ctypes.windll.user32
        user32.GetMonitorInfoW.argtypes = [ctypes.c_void_p, ctypes.POINTER(MonitorInfo)]
        user32.GetMonitorInfoW.restype = ctypes.c_int
        callback_type = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p,
                                           ctypes.POINTER(Rect), ctypes.c_void_p)

        def collect(monitor, _dc, _rect, _data) -> int:
            info = MonitorInfo()
            info.cbSize = ctypes.sizeof(MonitorInfo)
            if user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
                work = info.rcWork
                areas.append((work.left, work.top, work.right, work.bottom))
            return 1

        callback = callback_type(collect)
        user32.EnumDisplayMonitors.argtypes = [ctypes.c_void_p, ctypes.c_void_p, callback_type, ctypes.c_void_p]
        user32.EnumDisplayMonitors.restype = ctypes.c_int
        if not user32.EnumDisplayMonitors(None, None, callback, None):
            return []
    except (AttributeError, OSError, ValueError, TypeError):
        return []
    return areas


class StreamWindow:
    """A movable goblin and its complete currently available event stream."""

    retired_view = False
    state_cache: str | None = None
    # The party this window was opened for, so × on a window kept from an earlier party
    # is remembered for that party rather than the one now selected.
    party_id = ""

    def __init__(self, owner, actor: dict, style: dict, saved: dict | None = None,
                 party: list[dict] | None = None) -> None:
        self.owner = owner
        self.actor = actor
        self.actor_id = str(actor["id"])
        self.style = style
        # Reviewing older output is temporary; a reopened stream starts live.
        self.follow_latest = True
        self.show_details = bool((saved or {}).get("showDetails", False))
        self.last_success = 0.0
        self.loaded_focused = False
        self.visible_start: int | None = None
        self.fingerprint = ""
        self.rendered_signatures: list[tuple] = []
        self.bubbles: list[tk.Frame] = []
        self.unread = 0
        self.closed = False
        self.drag_origin: tuple[int, int, int, int] | None = None
        # A move the app makes itself, so a Configure echo of it is not mistaken for the person's.
        self.moved_at = 0.0
        self.os_move_after: str | None = None
        self.motion_after: str | None = None
        self.latest_after: str | None = None
        self.follow_check_after: str | None = None
        self.motion_frame = 0
        # Owned by this window so a reopened stream or a reset preview starts its own cycle.
        self.motion_clock = ActionClock()
        self.motion_preview = False
        self.connection = "CONNECTING"
        self.party: list[dict] = []
        # (tag, x, y, style, actor) for each roster goblin in view.
        self.roster_cells: list[tuple[str, int, int, dict, dict]] = []
        self.party_position = 1
        self.roster_row_offset = 0
        self.flow_loop = False
        self.flow_visible = 0
        self.flow_total = 0
        # The pinned parting note, shown once this member has retired.
        self.note_frame: tk.Frame | None = None
        self.note_key: tuple | None = None
        # A retired member's log has ended: it no longer follows, and its header says so.
        self.retired_view = False
        self.state_cache: str | None = None

        self.window = tk.Toplevel(owner.root)
        self.window.withdraw()
        float_window(self.window)
        clear = make_transparent(self.window)
        self.window.title(f"Goblin Horde · {actor.get('name') or self.actor_id}")
        x = int((saved or {}).get("x", owner.root.winfo_x() - WIDTH - 18))
        y = int((saved or {}).get("y", owner.root.winfo_y()))
        self.x, self.y = x, y
        # True once this window has a spot in the party layout (tiled or dragged there).
        # Only an explicit rebalance clears it, so polls and new members never move it.
        self.placed = bool((saved or {}).get("placed", False))
        # True when the person put it there (dragged it, or moved it with Windows' own keys),
        # possibly on another display. A manual spot wins over tiling until Rebalance. Settings
        # saved before this flag existed treat any placed window as placed by hand.
        self.manual = bool((saved or {}).get("manual", self.placed))
        self.window.geometry(f"{WIDTH}x{HEIGHT}{screen_geometry(x, y)}")

        # The transparent window leaves the goblin standing beside one RPG dialogue box.
        self.tail = tk.Canvas(self.window, width=31, height=29, bg=clear,
                              bd=0, highlightthickness=0)
        self.tail.place(x=82, y=HEIGHT - 104)
        self.tail.create_polygon(30, 2, 1, 18, 30, 27, fill=DIALOGUE, outline=GOLD, width=2)

        panel = tk.Frame(self.window, bg=INK, bd=0)
        self.panel = panel
        panel.place(x=103, y=8, width=WIDTH - 111, height=HEIGHT - 16)
        rim = tk.Frame(panel, bg=GOLD, bd=0)
        rim.place(x=2, y=2, width=WIDTH - 115, height=HEIGHT - 20)
        inner = tk.Frame(rim, bg=DIALOGUE, bd=0)
        inner.place(x=2, y=2, width=WIDTH - 119, height=HEIGHT - 24)
        self.inner = inner

        header = tk.Frame(inner, bg=DIALOGUE, height=80)
        header.pack(fill="x")
        header.pack_propagate(False)
        header_top = tk.Frame(header, bg=DIALOGUE)
        header_top.pack(fill="x", padx=7, pady=(6, 3))
        self.close_button = self._button(header_top, "×", self.close)
        self.close_button.configure(bg="#7b4037", activebackground="#a45343")
        self.close_button.pack(side="right", padx=(4, 0))
        self.hide_button = self._button(header_top, "HIDE ALL", owner.hide_party)
        self.hide_button.pack(side="right", padx=(10, 0))
        self.condense_button = self._button(header_top, "CONDENSE", owner.condense_party)
        self.condense_button.pack(side="right", padx=(4, 0))
        self.switch_button = self._button(header_top, "◂ ALL", owner.show_launchpad)
        self.switch_button.pack(side="right", padx=(4, 0))
        self.group_label = tk.Label(header_top, text="", anchor="w", bg=DIALOGUE, fg=IVORY,
                                    font=ui_font("Consolas", 8, "bold"), padx=7)
        self.group_label.pack(side="left", fill="x", expand=True)
        # One line only: the header is a fixed height, and a wrapped name would push the status and
        # model row out of sight. A long name ends in "…"; the window title keeps it whole.
        self.name_font = tkfont.Font(font=ui_font("Bahnschrift", 12, "bold"))
        self.name_label = tk.Label(header, text="", anchor="w", justify="left",
                                   bg=DIALOGUE, fg=style["accent"], font=self.name_font)
        self.name_label.pack(fill="x", padx=10)
        state_row = tk.Frame(header, bg=DIALOGUE)
        state_row.pack(fill="x", padx=10, pady=(2, 0))
        # The model this goblin runs, in its tribe's colour, beside its source and status.
        self.model_label = tk.Label(state_row, text="", anchor="e", bg=DIALOGUE, fg=MUTED,
                                    font=ui_font("Consolas", 8, "bold"))
        self.model_label.pack(side="right")
        self.state_label = tk.Label(state_row, text="", anchor="w", bg=DIALOGUE, fg=MUTED,
                                    font=ui_font("Consolas", 8))
        self.state_label.pack(side="left", fill="x", expand=True)

        controls = tk.Frame(inner, bg=DIALOGUE)
        controls.pack(fill="x", padx=7, pady=(0, 5))
        self.follow_button = self._button(controls, "FOLLOW NEW", self.toggle_follow)
        self.follow_button.pack(side="left", padx=(0, 4))
        if self.follow_latest:
            self.follow_button.configure(text="FOLLOWING")
        self._button(controls, "OPEN CHAT", lambda: owner.open_viewer(self.actor)).pack(side="left", padx=(0, 4))
        self.details_button = self._button(controls, "DETAILS", self.toggle_details)
        self.details_button.pack(side="left", padx=(0, 4))
        if self.show_details:
            self.details_button.configure(text="LESS")
        self._button(controls, "PARTY ▾", lambda: owner.show_party_menu(self.actor_id)).pack(side="left", padx=(0, 4))

        self.older_button = self._button(inner, "EARLIER", self.show_earlier)
        self.footer_label = tk.Label(inner, text="FIELD LOG", bg="#1f3328", fg=GOLD,
                                     font=ui_font("Bahnschrift", 8, "bold"), anchor="w", padx=8, pady=2)
        self.footer_label.pack(side="bottom", fill="x", padx=7, pady=(0, 5))

        self.text_frame = tk.Frame(inner, bg=DIALOGUE)
        self.text_frame.pack(fill="both", expand=True, padx=7, pady=(0, 4))
        self.scrollbar = tk.Scrollbar(self.text_frame, width=10, bg="#456650",
                                     troughcolor="#11261d", activebackground=GOLD,
                                     bd=0, highlightthickness=0)
        self.scrollbar.pack(side="right", fill="y")
        self.text = tk.Text(self.text_frame, wrap="word", bg=DIALOGUE, fg=IVORY, relief="flat",
                            bd=0, padx=7, pady=6, font=ui_font("Consolas", 10),
                            yscrollcommand=self.scrollbar.set, cursor="arrow")
        self.text.pack(side="left", fill="both", expand=True)
        self.scrollbar.configure(command=self.scroll_command)
        self.text.tag_configure("turn", foreground=GOLD, font=ui_font("Consolas", 9, "bold"),
                                spacing1=11, spacing3=4)
        self.text.tag_configure("muted", foreground=MUTED, spacing3=7)
        self.text.bind("<MouseWheel>", self.on_scroll)
        self.text.bind("<KeyPress>", self.on_key)
        self.text.configure(state="disabled")
        self.bubble_menu = tk.Menu(self.window, tearoff=False)
        self.bubble_menu.add_command(label="Copy this bubble", command=self.copy_bubble)
        self.copy_value = ""
        # Wide enough for the 4x goblin and the action cue beside its head (24 sprite pixels).
        self.sprite = tk.Canvas(self.window, width=97, height=100, bg=clear,
                                bd=0, highlightthickness=0)
        self.sprite.place(x=3, y=HEIGHT - 109)
        self.roster = tk.Canvas(self.window, width=ROSTER_COLUMNS * ROSTER_STEP_X,
                                height=ROSTER_ROWS * ROSTER_STEP_Y + 1, bg=clear,
                                bd=0, highlightthickness=0, cursor="hand2")
        self.roster.place(x=1, y=42)
        self.roster.bind("<Button-1>", self.on_roster_click)
        self.roster.bind("<MouseWheel>", self.scroll_roster)
        self.roster.bind("<Motion>", self.on_roster_hover)
        self.roster.bind("<Leave>", lambda _event: self.set_party(self.party))
        self.roster_hint = tk.Label(self.window, text="", bg=INK, fg=IVORY,
                                    font=ui_font("Consolas", 7, "bold"), anchor="center")
        self.roster_hint.place(x=4, y=279, width=92, height=12)
        self.edge_close = tk.Button(self.window, text="×", command=self.close, bg=GOLD, fg=INK,
                                    activebackground=IVORY, activeforeground=INK,
                                    font=ui_font("Consolas", 11, "bold"), bd=1, relief="solid",
                                    highlightthickness=0, cursor="hand2")
        self.edge_close.place(x=5, y=8, width=26, height=25)
        self.set_party(party or [actor])
        for target in (header, self.sprite, self.group_label, self.name_label, self.state_label):
            target.bind("<ButtonPress-1>", self.start_drag)
            target.bind("<B1-Motion>", self.drag)
            target.bind("<ButtonRelease-1>", self.end_drag)
        self.window.bind("<Configure>", self.on_configure, add="+")
        self.window.protocol("WM_DELETE_WINDOW", self.close)
        self.window.bind("<Escape>", lambda _event: self.owner.condense_party())
        self.render_actor(actor, "DEMO" if self.actor_id.startswith("demo-") else "CONNECTING")
        self.window.update_idletasks()
        self.motion_after = self.window.after(360, self.animate_sprite)

    def _button(self, parent: tk.Misc, label: str, action) -> tk.Button:
        return tk.Button(parent, text=label, command=action, bg="#284537", fg=IVORY,
                         activebackground="#3e604b", activeforeground=IVORY,
                         bd=1, relief="solid", highlightthickness=0,
                         font=ui_font("Consolas", 8, "bold"), padx=5, pady=2, cursor="hand2")

    def set_party(self, actors: list[dict], paint: bool = True) -> None:
        """Keep a clickable goblin acting out every party member's work in the stream gutter.

        ``paint=False`` lays out the tiles for a caller that paints them right after."""
        self.party = [actor for actor in actors if actor.get("id")]
        self.party_position = next((index + 1 for index, actor in enumerate(self.party)
                                    if str(actor["id"]) == self.actor_id), 1)
        rows = self.roster_rows()
        self.roster_row_offset = min(self.roster_row_offset, max(0, rows - ROSTER_ROWS))
        self.roster.delete("all")
        self.roster_cells = []
        width, height = ROSTER_TILE
        for index, actor in enumerate(self.party):
            column = index % ROSTER_COLUMNS
            row = index // ROSTER_COLUMNS - self.roster_row_offset
            if not 0 <= row < ROSTER_ROWS:
                continue
            left, top = 1 + column * ROSTER_STEP_X, 1 + row * ROSTER_STEP_Y
            style = self.owner.stream_style(actor)
            selected = str(actor["id"]) == self.actor_id
            on_screen = str(actor["id"]) in self.owner.visible_stream_ids
            self.roster.create_rectangle(left, top, left + width, top + height,
                                         fill="#233d30" if on_screen or not self.owner.party_mode else "#15251c",
                                         outline=GOLD if selected else style["accent"],
                                         width=2 if selected else 1)
            self.roster_cells.append((f"roster-{index}", left + ROSTER_SPRITE[0], top + ROSTER_SPRITE[1],
                                      style, actor))
            # The slot number sits on a plaque in the corner the goblin and its cue never use.
            x1, y1, x2, y2 = ROSTER_BADGE
            self.roster.create_rectangle(left + x1, top + y1, left + x2, top + y2,
                                         fill=GOLD if selected else INK,
                                         outline=GOLD if selected else style["accent"], tags="badge")
            self.roster.create_text(left + (x1 + x2) // 2, top + (y1 + y2) // 2 + 1, text=str(index + 1),
                                    fill=INK if selected else IVORY,
                                    font=ui_font("Consolas", 7, "bold"), tags="badge")
        if paint:
            self.paint_roster()
        # Live tiles on screen out of the live party; a retired member's window is not counted.
        count = min(self.flow_visible, len(self.party)) if self.flow_visible else len(self.party)
        self.roster_hint.configure(text=f"{count}/{len(self.party)} TILES" + (" ↕" if rows > ROSTER_ROWS else ""))
        if hasattr(self, "name_label"):
            self.name_label.configure(text=self.name_line(self.owner.display_name(self.actor)))

    def position_text(self) -> str:
        """'2/5' for a party member; a retired member's stream is marked by its note instead."""
        if any(str(actor["id"]) == self.actor_id for actor in self.party):
            return f"{self.party_position}/{len(self.party)}"
        return "✉"

    def set_flow(self, loop: bool, visible_count: int, total: int) -> None:
        # Every scene refresh re-aligns; an unchanged flow already shows on the rail and label.
        if (self.flow_loop, self.flow_visible, self.flow_total) == (loop, visible_count, total):
            return
        self.flow_loop = loop
        self.flow_visible = visible_count
        self.flow_total = total
        self.set_party(self.party)
        self.refresh_group_label()

    def refresh_group_label(self) -> None:
        key, group = workflow_for(self.actor)
        prefix = "↺ " if self.flow_loop else "◆ "
        self.group_label.configure(text=f"{prefix}{group.replace('-', ' ').upper()[:27]}",
                                   bg=group_color(key), fg="#fffbed")

    def roster_rows(self) -> int:
        return (len(self.party) + ROSTER_COLUMNS - 1) // ROSTER_COLUMNS

    def roster_actor_at(self, x: int, y: int) -> dict | None:
        column, row = max(0, (x - 1) // ROSTER_STEP_X), max(0, (y - 1) // ROSTER_STEP_Y)
        index = (row + self.roster_row_offset) * ROSTER_COLUMNS + column
        return (self.party[index] if column < ROSTER_COLUMNS and row < ROSTER_ROWS
                and index < len(self.party) else None)

    def scroll_roster(self, event: tk.Event) -> str:
        self.roster_row_offset = max(0, min(max(0, self.roster_rows() - ROSTER_ROWS),
                                            self.roster_row_offset + (-1 if event.delta > 0 else 1)))
        self.set_party(self.party)
        return "break"

    def on_roster_click(self, event: tk.Event) -> None:
        actor = self.roster_actor_at(event.x, event.y)
        if actor:
            self.owner.open_and_focus_stream(actor)

    def on_roster_hover(self, event: tk.Event) -> None:
        actor = self.roster_actor_at(event.x, event.y)
        if actor:
            # Name the action the tile is showing, so a tiny cue can always be read in words;
            # a resting goblin replaying a finished step says what it just did.
            action = self.member_action(actor)
            label = PAST_LABELS[action] if action in PAST_LABELS and goblin_action(actor) == "idle" \
                else ACTION_LABELS[action]
            if self.owner.party_mode and str(actor["id"]) not in self.owner.visible_stream_ids:
                label = "▸ OPEN"  # Its window is closed (or has no tile); a click brings it back.
            name = self.owner.display_name(actor)[:16 - len(label) - bool(label)]
            self.roster_hint.configure(text=f"{name} {label}".strip())

    def current_action(self, connection: str | None = None) -> str:
        condition = connection or self.connection
        if condition in UNCONFIRMED:
            return "idle"
        return self.owner.acted(self.actor, condition == "NEEDS YOU" or bool(self.actor.get("needsInput")))

    def member_action(self, actor: dict) -> str:
        """This stream's goblin matches its portrait; the rest act from the shared party data."""
        if str(actor["id"]) == self.actor_id:
            return self.current_action()
        return self.owner.sprite_action(actor, self.connection)

    def roster_still(self) -> bool:
        return self.owner.reduced_motion or self.connection in UNCONFIRMED

    def paint_roster(self) -> None:
        """Draw every roster goblin on its own action's beat; slot plaques stay on top."""
        still = self.roster_still()
        for tag, x, y, style, actor in self.roster_cells:
            action = self.member_action(actor)
            frame = self.motion_clock.frame(("roster", str(actor["id"])), action, self.motion_frame)
            self.roster.delete(tag)
            member_id = str(actor["id"])
            self.owner.draw_sprite(x, y, style, canvas=self.roster, action=action, frame=frame,
                                   scale=2, still=still, tag=tag, exit_beat=self.owner.exit_beat(member_id),
                                   exit_outcome=self.owner.exit_outcome(member_id))
        self.roster.tag_raise("badge")

    def render_sprite(self) -> None:
        self.sprite.delete("all")
        action = self.displayed_action()
        # A new action starts on its first frame; the preview runs its own cycle.
        outcome = "finished"
        if self.motion_preview:
            frame = self.motion_frame
            exit_beat = frame % 8 if action == "exit" else None
        else:
            frame = self.motion_clock.frame("sprite", action, self.motion_frame)
            # A retiring goblin's portal follows the owner's single clock on every surface.
            exit_beat = self.owner.exit_beat(self.actor_id)
            if exit_beat is not None:
                outcome = self.owner.exit_outcome(self.actor_id)
        self.owner.draw_sprite(0, 14, self.style, canvas=self.sprite, action=action, frame=frame,
                               still=self.owner.reduced_motion and not self.motion_preview, exit_beat=exit_beat,
                               exit_outcome=outcome)

    def displayed_action(self) -> str:
        if self.motion_preview:
            return PREVIEW_ACTIONS[(self.motion_frame // 8) % len(PREVIEW_ACTIONS)]
        return self.current_action()

    def toggle_motion_preview(self) -> None:
        self.motion_preview = not self.motion_preview
        self.motion_frame = 0
        self.motion_clock = ActionClock()
        if not self.motion_preview:
            self.render_actor(self.actor, self.connection)
        else:
            self.render_sprite()

    def animate_sprite(self) -> None:
        if self.closed:
            return
        if not self.owner.paused:
            self.motion_frame += 1
            # A still goblin repaints when its actor changes (render_actor), not on every beat.
            # A retained, withdrawn stream keeps counting but draws nothing until it is shown.
            if self.window.winfo_ismapped():
                if self.motion_preview or not self.owner.reduced_motion:
                    self.render_sprite()
                if not self.roster_still():
                    self.paint_roster()
                if not self.motion_preview and self.state_cache is not None:
                    # A replayed step's past-tense word appears and expires with its motion.
                    self.refresh_state()
            if self.motion_preview:
                self.state_label.configure(text=f"MOTION PREVIEW · {ACTION_LABELS[self.displayed_action()]}")
        self.motion_after = self.window.after(360, self.animate_sprite)

    def start_drag(self, event: tk.Event) -> None:
        self.drag_origin = (event.x_root, event.y_root, self.window.winfo_x(), self.window.winfo_y())

    def drag(self, event: tk.Event) -> None:
        if self.drag_origin:
            px, py, x, y = self.drag_origin
            self.move_to(x + event.x_root - px, y + event.y_root - py)

    def end_drag(self, _event: tk.Event) -> None:
        if self.drag_origin:
            _px, _py, x, y = self.drag_origin
            self.drag_origin = None
            if abs(self.x - x) + abs(self.y - y) > 4:  # A click on the header is not a move.
                self.placed = self.manual = True
            self.owner.on_manual_stream_move(self)

    def on_configure(self, event: tk.Event) -> None:
        """Notice a move the app did not make, such as Win+Shift+Arrow to another display.

        Child widgets share this binding, so only the window's own events count, and the check
        waits for the window to settle so an echo of the app's own move is never adopted."""
        if event.widget is not self.window or self.closed or self.drag_origin:
            return
        if self.os_move_after:
            self.window.after_cancel(self.os_move_after)
        self.os_move_after = self.window.after(400, self.adopt_os_move)

    def adopt_os_move(self) -> None:
        # A direct call settles the pending check too, so no timer outlives the window.
        if self.os_move_after:
            self.window.after_cancel(self.os_move_after)
            self.os_move_after = None
        if self.closed or self.drag_origin or not self.window.winfo_ismapped():
            return
        if time.monotonic() - self.moved_at < 0.4:
            return
        x, y = self.window.winfo_x(), self.window.winfo_y()
        if (x, y) != (self.x, self.y):
            self.x, self.y = x, y
            self.placed = self.manual = True
            self.owner.on_manual_stream_move(self)

    def on_scroll(self, event: tk.Event) -> None:
        if event.delta > 0:
            self.set_follow(False)
        self.schedule_follow_check()

    def on_key(self, event: tk.Event) -> None:
        if event.keysym in ("Up", "Prior", "Home"):
            self.set_follow(False)
        if event.keysym in ("Up", "Down", "Prior", "Next", "Home", "End"):
            self.schedule_follow_check()

    def bubble_wheel(self, event: tk.Event) -> str:
        if event.delta > 0:
            self.set_follow(False)
        amount = max(1, abs(int(event.delta)) // 120)
        self.text.yview_scroll(-amount if event.delta > 0 else amount, "units")
        self.schedule_follow_check()
        return "break"

    def bubble_context(self, event: tk.Event, value: str) -> None:
        self.copy_value = value
        self.bubble_menu.tk_popup(event.x_root, event.y_root)

    def copy_bubble(self) -> None:
        self.window.clipboard_clear()
        self.window.clipboard_append(self.copy_value)

    def scroll_command(self, *args: str) -> None:
        self.text.yview(*args)
        self.schedule_follow_check()

    def schedule_follow_check(self) -> None:
        if self.follow_check_after:
            self.window.after_cancel(self.follow_check_after)
        self.follow_check_after = self.window.after(40, self.sync_follow_to_scroll)

    def sync_follow_to_scroll(self) -> None:
        self.follow_check_after = None
        if not self.closed:
            self.set_follow(self.text.yview()[1] >= 0.995)

    def ensure_latest_visible(self) -> None:
        """Scroll after Tk sizes embedded bubbles and after a hidden stream is shown."""
        if self.retired_view:
            self.show_final_turn()
            return
        if self.closed or not self.follow_latest:
            return
        if self.latest_after:
            self.window.after_cancel(self.latest_after)
        self.latest_after = self.window.after(80, self._show_latest)

    def _show_latest(self) -> None:
        self.latest_after = None
        if not self.closed and self.follow_latest and self.window.winfo_ismapped():
            self.text.see("end")
            self.text.yview_moveto(1.0)

    def set_follow(self, enabled: bool) -> None:
        if self.follow_latest == enabled or self.retired_view:
            return
        self.follow_latest = enabled
        if enabled:
            self.unread = 0
            self.follow_button.configure(text="FOLLOWING")
            self.ensure_latest_visible()
        else:
            if self.latest_after:
                self.window.after_cancel(self.latest_after)
                self.latest_after = None
            self.follow_button.configure(text=f"{self.unread} NEW ↓" if self.unread else "FOLLOW NEW")
        self.owner.save_position()

    def toggle_follow(self) -> None:
        self.set_follow(not self.follow_latest)

    def toggle_details(self) -> None:
        self.show_details = not self.show_details
        self.details_button.configure(text="LESS" if self.show_details else "DETAILS")
        self.fingerprint = ""
        self.rendered_signatures = []
        self.render_actor(self.actor, self.connection)
        self.owner.save_position()

    def show_note(self, note: dict | None, undo: bool = False) -> None:
        """Pin this retired member's parting note above its field log; None removes it.

        The note is a parchment card so it never reads as one more live event. Closing the
        stream leaves the note in the party's notes; only DISMISS removes it, and for a short
        while a slim strip in its place offers UNDO."""
        key = (tuple(sorted((name, repr(value)) for name, value in note.items() if name != "read")),
               self.owner.display_name({"id": note["id"], "name": note["name"]})) if note else (
            "undo" if undo else None)
        self.set_retired(self.actor_id in self.owner.parted)
        if key == self.note_key:
            return
        self.note_key = key
        if self.note_frame is not None:
            self.note_frame.destroy()
            self.note_frame = None
        self.note_buttons = []
        if not note and not undo:
            return
        frame = tk.Frame(self.inner, bg=GOLD)
        card = tk.Frame(frame, bg=PARCHMENT)
        card.pack(fill="both", padx=2, pady=2)
        top = tk.Frame(card, bg=PARCHMENT)
        top.pack(fill="x", padx=6, pady=(4, 0 if note else 4))
        if not note:
            self.note_title = tk.Label(top, text="✉ Parting note dismissed", bg=PARCHMENT, fg=NOTE_FADED,
                                       anchor="w", font=ui_font("Consolas", 8, "bold"))
            self.note_title.pack(side="left", fill="x", expand=True)
            self.note_buttons = [self._button(top, "UNDO", self.owner.undo_notes)]
            self.note_buttons[0].pack(side="right")
            frame.pack(before=self.text_frame, fill="x", padx=7, pady=(0, 6))
            self.note_frame = frame
            return
        title, meta, reported, seen = note_lines(note, "PARTING NOTE")
        wrap = WIDTH - 150
        self.note_title = tk.Label(top, text=title, bg=PARCHMENT, fg=NOTE_TITLE, anchor="w",
                                   font=ui_font("Consolas", 8, "bold"))
        self.note_title.pack(side="left", fill="x", expand=True)
        self.note_buttons = [
            self._button(top, "DISMISS", lambda: self.owner.dismiss_note(note["party"], note["id"])),
            self._button(top, "ALL NOTES", lambda: self.owner.show_notes(note["id"]))]
        for button in self.note_buttons:
            button.pack(side="right", padx=(4, 0))
        lines = [(meta, NOTE_FADED, ui_font("Consolas", 8)),
                 (reported, NOTE_INK if note.get("reported") else NOTE_FADED, ui_font("Consolas", 9))]
        if seen:
            lines.append((seen, NOTE_FADED, ui_font("Consolas", 8)))
        for index, (text, color, font) in enumerate(lines):
            tk.Label(card, text=text, bg=PARCHMENT, fg=color, font=font, anchor="w", justify="left",
                     wraplength=wrap).pack(fill="x", padx=6, pady=(0, 5 if index == len(lines) - 1 else 1))
        # Clearance below the parchment, so the log's first TURN header is never tucked under it.
        frame.pack(before=self.text_frame, fill="x", padx=7, pady=(0, 6))
        self.note_frame = frame
        self.show_final_turn()

    def set_retired(self, retired: bool) -> None:
        """A retired member's log has ended: freeze it on its last turn instead of following."""
        if retired == self.retired_view:
            return
        if retired:
            self.retired_view = False
            self.set_follow(False)  # Cancels any pending jump to the end.
            self.retired_view = True
            self.unread = 0
            self.follow_button.configure(text="LOG ENDED", state="disabled", disabledforeground=MUTED)
            self.show_final_turn()
        else:
            self.retired_view = False
            self.follow_button.configure(state="normal")
            self.follow_latest = False
            self.set_follow(True)
        self.refresh_state(force=True)
        self.footer_label.configure(text=self.footer_text())

    def show_final_turn(self) -> None:
        """Scroll an ended log so its last TURN header sits whole at the top, once laid out."""
        if self.closed or not self.retired_view:
            return
        if self.latest_after:
            self.window.after_cancel(self.latest_after)
        self.latest_after = self.window.after(80, self._show_final_turn)

    def _show_final_turn(self) -> None:
        self.latest_after = None
        if self.closed:
            return
        turns = self.text.tag_ranges("turn")
        if turns:
            self.text.yview(turns[-2])
        else:
            self.text.yview_moveto(1.0)

    def footer_text(self) -> str:
        activities = self.actor.get("activities") or []
        shown = len(activities) - (self.visible_start or 0)
        if self.retired_view:
            return f"FIELD LOG  ·  ENDED  ·  {shown} OF {len(activities)} EVENTS IN VIEW"
        return f"FIELD LOG  ·  {shown} OF {len(activities)} EVENTS IN VIEW"

    def state_text(self) -> str:
        """Source, phase, and one status word; a retired member says PARTING or PARTED and how."""
        from party_layout import phase_for

        actor, connection = self.actor, self.connection
        try:
            stamp = float(actor.get("updatedAt"))
            if stamp < 1e12:
                stamp *= 1000
            age_text = f" · {max(0, int((time.time() * 1000 - stamp) / 60_000))}m ago"
        except (TypeError, ValueError):
            age_text = ""
        source = str(actor.get("source") or "agent").upper()
        leaving = self.owner.exits.get(self.actor_id)
        if leaving is not None or self.actor_id in self.owner.parted:
            outcome = outcome_word(self.owner.exit_outcome(self.actor_id), str(actor.get("source") or ""))
            parts = (source, "PARTING" if leaving is not None else "PARTED", outcome)
        else:
            parts = (source, phase_for(actor), self.owner.status_for(actor, connection).word,
                     connection if connection not in ("LIVE", "NEEDS YOU") else "")
        return " · ".join(part for part in parts if part) + age_text

    def refresh_state(self, force: bool = False) -> None:
        text = self.state_text()
        if force or text != self.state_cache:
            self.state_cache = text
            self.state_label.configure(text=text)
            from party_layout import family_ink, model_badge

            badge = model_badge(self.actor, with_effort=True)
            self.model_label.configure(text=f"◈ {badge}" if badge else "", fg=family_ink(self.actor))

    def state(self) -> dict:
        return {"id": self.actor_id, "source": self.actor.get("source"),
                "parentThreadId": self.actor.get("parentThreadId") or "",
                "workflowGroupId": self.actor.get("workflowGroupId") or "",
                "workflowName": self.actor.get("workflowName") or "",
                "name": self.actor.get("name") or self.actor.get("nickname") or self.actor_id,
                "cwd": self.actor.get("cwd") or "", "x": self.x,
                "y": self.y, "placed": self.placed, "manual": self.manual,
                "showDetails": self.show_details, "party": self.party_id}

    def move_to(self, x: int, y: int) -> None:
        self.x, self.y = x, y
        self.moved_at = time.monotonic()
        self.window.geometry(screen_geometry(x, y))

    def receive_actor(self, actor: dict, connection: str) -> None:
        """Use the selected party's shared scene so every member stays in sync."""
        if not self.loaded_focused:
            self.visible_start = None
            self.loaded_focused = True
            self.fingerprint = ""
            self.rendered_signatures = []
            self.unread = 0
        self.last_success = time.time()
        self.render_actor(actor, connection)

    def make_bubble(self, item: dict, heading: str, body: str) -> tk.Frame:
        """What a goblin said is a parchment speech bubble; what it did is a field-log row."""
        failed = item.get("status") == "failed" or item.get("exitCode") not in (None, 0)
        is_update = item.get("kind") == "update"
        border = "#e8735e" if failed else self.style["accent"] if is_update else "#6f9b7d"
        background = PARCHMENT if is_update else ACTION
        outer = tk.Frame(self.text, bg=DIALOGUE, bd=0)
        stripe = tk.Frame(outer, bg=border, width=4 if not is_update else 0)
        if not is_update:
            stripe.pack(side="left", fill="y")
        inner = tk.Frame(outer, bg=background, bd=0)
        inner.pack(side="left", fill="both", expand=True)
        title = tk.Label(inner, text=heading, bg=background, fg=NOTE_TITLE if is_update else border,
                         font=ui_font("Bahnschrift", 9, "bold") if is_update else ui_font("Consolas", 9, "bold"),
                         anchor="w", justify="left", wraplength=WIDTH - 190)
        title.pack(fill="x", padx=10, pady=(7, 2) if is_update else (5, 1))
        content = tk.Label(inner, text=body, bg=background, fg=NOTE_INK if is_update else MUTED,
                           font=ui_font("Segoe UI", 10) if is_update else ui_font("Consolas", 9), anchor="nw", justify="left",
                           wraplength=WIDTH - 190)
        content.pack(fill="x", padx=10, pady=(0, 9) if is_update else (0, 6))
        details = []
        if self.show_details:
            detail = str(item.get("detail") or "").strip()
            output = str(item.get("output") or "").strip()
            for label, value in (("DETAILS", detail), ("RESULT", output)):
                if not value or value == body:
                    continue
                extra = tk.Label(inner, text=f"{label}\n{value}", bg="#10251b", fg="#c4d6bd",
                                 font=ui_font("Consolas", 8), anchor="nw", justify="left",
                                 wraplength=WIDTH - 198)
                extra.pack(fill="x", padx=9, pady=(0, 7))
                details.append(f"{label}\n{value}")
                extra.bind("<MouseWheel>", self.bubble_wheel)
                bind_context(extra, lambda event, value=body + "\n" + "\n".join(details): self.bubble_context(event, value))
        copy_text = "\n".join((heading, body, *details))
        for target in (outer, stripe, inner, title, content):
            target.bind("<MouseWheel>", self.bubble_wheel)
            bind_context(target, lambda event, value=copy_text: self.bubble_context(event, value))
        return outer

    def show_earlier(self) -> None:
        if not self.actor.get("activities"):
            return
        self.set_follow(False)
        self.visible_start = max(0, (self.visible_start or 0) - EVENT_BATCH)
        self.rendered_signatures = []
        self.fingerprint = ""
        self.render_actor(self.actor, self.connection)
        self.text.yview_moveto(0)

    def name_line(self, name: str) -> str:
        """The position and name, cut with an ellipsis to the header's single line."""
        text = f"{self.position_text()}  {name}"
        name_font = getattr(self, "name_font", None)
        if name_font is None:
            return text[:90]
        room = WIDTH - 119 - 24
        if name_font.measure(text) <= room:
            return text
        while text and name_font.measure(text + "…") > room:
            text = text[:-1]
        return text.rstrip() + "…"

    def render_actor(self, actor: dict, connection: str = "CONNECTING") -> None:
        for key in ("workflowName", "workflowGroupId"):
            if not actor.get(key) and self.actor.get(key):
                actor = {**actor, key: self.actor[key]}
        self.actor = actor
        self.connection = connection
        name = self.owner.display_name(actor)
        self.refresh_group_label()
        self.name_label.configure(text=self.name_line(name))
        self.window.title(f"Goblin Horde · {name}")
        self.render_sprite()
        self.paint_roster()
        # After the sprite, so a step it just started acting out is named in the same paint.
        self.refresh_state(force=True)
        activities = actor.get("activities") or []
        if self.visible_start is None or self.visible_start > len(activities):
            self.visible_start = max(0, len(activities) - EVENT_BATCH)
        remaining = self.visible_start
        self.older_button.configure(text=f"EARLIER ↑  {remaining} more")
        if remaining and not self.older_button.winfo_manager():
            self.older_button.pack(before=self.text_frame, fill="x", padx=7, pady=(0, 5))
        elif not remaining and self.older_button.winfo_manager():
            self.older_button.pack_forget()
        visible = activities[self.visible_start:]
        self.footer_label.configure(text=self.footer_text())
        signatures = [(item.get("id"), item.get("status"), item.get("title"), item.get("description"),
                       item.get("detail"), item.get("output"), item.get("exitCode")) for item in visible]
        fingerprint = repr((self.show_details, self.visible_start, signatures))
        if fingerprint == self.fingerprint:
            return
        if self.fingerprint and not self.follow_latest and not self.retired_view:
            previous = {str(signature[0]): signature for signature in self.rendered_signatures}
            self.unread += sum(previous.get(str(signature[0])) != signature for signature in signatures)
            self.follow_button.configure(text=f"{self.unread} NEW ↓" if self.unread else "FOLLOW NEW")
        append_only = (bool(self.rendered_signatures) and
                       signatures[:len(self.rendered_signatures)] == self.rendered_signatures and
                       len(signatures) > len(self.rendered_signatures))
        start_at = len(self.rendered_signatures) if append_only else 0
        old_index = self.text.index("@0,0")
        self.text.configure(state="normal")
        if not append_only:
            self.text.delete("1.0", "end")
            self.bubbles.clear()
        if not activities:
            self.text.insert("end", "Listening for this workflow's next step.\n", "muted")
        previous_turn = visible[start_at - 1].get("turnId") if start_at else None
        for item in visible[start_at:]:
            title = str(item.get("title") or item.get("kind") or "Activity")
            if item.get("status") == "failed" or item.get("exitCode") not in (None, 0):
                title = f"FAILED · {title}"
            when = item.get("turnStartedAt")
            try:
                stamp = time.strftime("%I:%M %p", time.localtime(float(when) / (1000 if float(when) > 1e12 else 1)))
            except (TypeError, ValueError, OSError):
                stamp = ""
            if actor.get("source") in ("codex", "claude", "extension") and item.get("turnId") != previous_turn:
                self.text.insert("end", f"TURN{(' · ' + stamp) if stamp else ''}\n", "turn")
            previous_turn = item.get("turnId")
            heading = f"{stamp}  {title}" if actor.get("source") == "orca" and stamp else title
            body = str(item.get("description") or item.get("detail") or "").strip()
            if not body:
                body = "Step recorded."
            bubble = self.make_bubble(item, heading, body)
            self.text.window_create("end", window=bubble, padx=1, pady=5)
            self.text.insert("end", "\n")
            self.bubbles.append(bubble)
        self.rendered_signatures = signatures
        self.fingerprint = fingerprint
        self.text.configure(state="disabled")
        if self.follow_latest:
            self.ensure_latest_visible()
        else:
            self.text.yview(old_index)

    def close(self) -> None:
        self.dispose()
        self.owner.streams.pop(self.actor_id, None)
        self.owner.on_stream_closed(self.actor_id, self.party_id)

    def dispose(self) -> None:
        if self.closed:
            return
        self.closed = True
        for callback in (self.motion_after, self.latest_after, self.follow_check_after, self.os_move_after):
            if callback:
                self.window.after_cancel(callback)
        self.window.destroy()
