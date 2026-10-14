"""Goblin Horde on the desktop (Windows and macOS): the Horde window and the goblin strip.

This module is the app: its lifecycle (the ready line, the error log, coming forward when `start`
asks, closing and quitting), its settings file, the polling of the local viewer, and the menu
actions. What the window shows is decided in horde_model, drawn by horde_window / horde_roster /
horde_detail / goblin_strip, and every request goes through horde_api.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
import tkinter as tk
from tkinter import messagebox, simpledialog
import traceback
import webbrowser

import desktop_platform
from desktop_platform import UNAVAILABLE_EXIT, TransparencyUnavailable
from goblin_cues import ActionClock, system_prefers_reduced_motion
from goblin_motion import ActionPulse
from goblin_sprite import KINDS, SpriteImages, style_for
from goblin_strip import GoblinStrip
from horde_api import ApiError, HordeApi
from horde_demo import DemoApi
from horde_model import (NEEDS, Counts, RosterMemory, actor_id, ask_of, build_roster, clamp_window, coverage_note,
                         default_selection, detail_from_actor, display_name, is_agent, merged_agent, motion_view,
                         move_selection, party_scope, read_settings, search_sources, settings_to_save, source_chips,
                         strip_items)
from horde_theme import HEADER, Theme, Tooltip, WheelRouter
from horde_window import HordeWindow

HERE = Path(__file__).resolve().parent
# The manager's `start` leaves this file in the state folder's run/ when the widget is already
# running (lib/manager.mjs SHOW_REQUEST); the widget checks every second and comes forward.
SHOW_REQUEST = "show-widget"
SHOW_CHECK_MS = 1000
# Failed callbacks are noted in run/widget.log: every one of the first few, then one in a hundred.
LOGGED_ERRORS = 20
SCENE_MS = 2000  # The roster's read of every party.
DETAIL_MS = 2000  # The selected goblin's own records, only while the window is open.
TICK_MS = 1000  # Live timers.
BEAT_MS = 360  # The goblins' shared animation beat.
CATALOG_MS = 60_000
SOURCES_MS = 30_000
OFFLINE_AFTER = 2  # Failed reads in a row before the window says the viewer is not answering.
DETAIL_CACHE = 40
QUIT_LABEL = "Quit Goblin Horde"


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
    """Set an unreadable settings file aside (once) instead of losing its contents to the next save."""
    try:
        target = state_file()
        aside = target.with_name(f"{target.name}.unreadable")
        if not aside.exists():
            aside.write_bytes(raw)
    except OSError:
        pass


def read_saved_settings() -> dict:
    """The settings file as it is on disk ({} when missing, unreadable, or not an object)."""
    try:
        raw = state_file().read_bytes()
    except OSError:
        return {}
    try:
        saved = json.loads(raw.decode("utf-8"))
    except ValueError:  # Also UnicodeDecodeError: not UTF-8 at all.
        keep_unreadable_settings(raw)
        return {}
    return saved if isinstance(saved, dict) else {}


class GoblinWidget:
    """The desktop app: one Horde window, one goblin strip, and the loops that keep them current."""

    error_count = 0  # Callbacks that failed since start, for the diagnostic report.
    closing = False
    show_after = None

    def __init__(self, thread_id: str = "", port: int = 43917, demo: bool = False, demo_set: str = "default",
                 select: str = "", surface: str = "") -> None:
        self.port = port
        self.demo = bool(demo)
        self.api = DemoApi(demo_set) if self.demo else HordeApi(port)
        self.raw_settings = read_saved_settings()
        self.settings = read_settings(self.raw_settings)
        self.aliases: dict[str, str] = dict(self.settings["aliases"])
        self.palette_offset = self.settings["paletteOffset"] % len(KINDS)
        self.reduced_motion_choice = self.settings["reducedMotion"]
        self.keep_on_top = self.settings["keepOnTop"]
        self.show_strip_pref = self.settings["showStrip"]
        self.surface = surface if surface in ("window", "strip") else self.settings["surface"]
        self.done_open = self.settings["doneOpen"]
        self.welcomed = self.settings["welcomed"]
        self.focus_thread = thread_id or select
        self.selected = "" if self.demo and not select else (select or self.settings["selected"])
        self.chosen = bool(self.selected)
        self.executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="goblin-horde")
        self.actors: list[dict] = []
        self.known: dict[str, dict] = {}  # Last copy of every goblin seen, so a finished one can still be shown.
        self.requests: list[dict] = []
        self.details: dict[str, dict | None] = {}
        self.detail_route: bool | None = None  # False once the viewer answered that it has no /api/agent.
        self.detail_pending = None
        self.dismissed_keys: set[str] = set()
        self.rows: list = []
        self.counts = Counts()
        self.memory = RosterMemory()
        self.strip_memory = RosterMemory()
        self.query = ""
        self.results: list[dict] | None = None
        self.watched_ids: list[str] = []
        self.watch_pending = None
        self.manual_links: dict[str, str] = {}
        self.joined_parties: dict[str, str] = {}
        self.source_catalog: list[dict] = []
        self.catalog_unavailable: list[str] = []
        self.catalog_failed = False
        self.catalog_at = 0.0
        self.catalog_pending = None
        self.sources: dict = {}
        self.autostart: dict = {}  # {available, enabled}: starting at Windows sign-in.
        self.phone: dict = {}  # {enabled, listening, url, adapter, problem}: phone access over Wi-Fi, off by default.
        self.sources_pending = None
        self.connection = "CONNECTING"
        self.warning = ""
        self.coverage: dict = {}
        self.last_success = 0.0
        self.failures = 0
        self.board_age = 0.0  # Seconds the server's scene was old when it was served.
        self.restarting = False
        self.pending = None
        self.phase = 0
        self.motion_clock = ActionClock()
        # One record of each goblin's newest public step, so every surface pulses together.
        self.action_pulses = ActionPulse()
        self.geometry: dict | None = self.settings["window"]
        self.save_after = None
        self.poll_after = self.receive_after = self.detail_after = self.animate_after = None
        self.tick_after = self.catalog_after = self.sources_after = self.show_after = None

        desktop_platform.prepare_process()
        if self.settings["scaleWithDisplay"]:
            desktop_platform.enable_dpi_awareness()
        self.root = tk.Tk()
        self.root.withdraw()
        try:
            # The strip is see-through; a Tk that cannot draw that falls back to the browser viewer.
            desktop_platform.check_support(self.root)
        except (TransparencyUnavailable, tk.TclError):
            self.executor.shutdown(wait=False)
            self.root.destroy()
            raise
        desktop_platform.prepare_app(self.root, on_quit=self.close, on_reopen=self.come_forward)
        # pythonw has no console: a failed callback is counted and noted in run/widget.log instead.
        self.root.report_callback_exception = self.report_callback_error
        # The window's X collapses to the goblin strip; Quit is in the menu.
        self.root.protocol("WM_DELETE_WINDOW", self.collapse_to_strip)
        self.reduced_motion = (self.reduced_motion_choice if self.reduced_motion_choice is not None
                               else system_prefers_reduced_motion())
        scale = desktop_platform.display_scale(self.root) if self.settings["scaleWithDisplay"] else 1.0
        self.theme = Theme(self.root, scale)
        self.sprite_images = SpriteImages(self.root)  # Every goblin frame, painted once.
        desktop_platform.set_icon(self.root, str(HERE / "goblin.ico"))
        self.wheel = WheelRouter(self.root)
        self.tooltip = Tooltip(self.root, self.theme)
        self.window = HordeWindow(self, self.root, self.theme, self.wheel)
        self.roster = self.window.roster
        self.detail_view = self.window.detail
        self.strip = GoblinStrip(self, self.theme)
        strip_anchor = self.settings["strip"]
        if strip_anchor:
            self.strip.anchor = (strip_anchor["right"], strip_anchor["bottom"])
        self.root.bind("<Configure>", self.on_root_configure, add="+")
        if self.keep_on_top:
            self.root.wm_attributes("-topmost", True)

        self.place_window()
        self.refresh()
        if self.surface == "strip":
            self.strip.show()
        else:
            self.open_window(initial=True)
        self.poll_after = self.root.after(50, self.poll)
        self.animate_after = self.root.after(BEAT_MS, self.animate)
        self.tick_after = self.root.after(TICK_MS, self.tick)
        self.detail_after = self.root.after(400, self.poll_detail)
        self.catalog_after = self.root.after(300, self.load_catalog)
        self.sources_after = self.root.after(200, self.poll_sources)
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
        """`start` (or the Dock icon) asked for Goblin Horde: open the window in front."""
        self.open_window()

    def report_callback_error(self, kind, _value, trace) -> None:
        """Tk's handler for a callback that raised. The loops reschedule themselves regardless."""
        self.error_count += 1
        if self.error_count <= LOGGED_ERRORS or self.error_count % 100 == 0:
            note_widget_error(error_line(self.error_count, kind, trace))

    # Surfaces ---------------------------------------------------------------------------------
    def place_window(self) -> None:
        """Restore the window where it was, on a display that still exists, or centre it."""
        areas = desktop_platform.monitor_areas() or [desktop_platform.monitor_work_area(self.root)]
        spot = clamp_window(self.geometry, areas, self.theme.scale)
        self.geometry = spot
        self.root.geometry(f"{spot['width']}x{spot['height']}"
                           f"{desktop_platform.screen_geometry(spot['x'], spot['y'])}")

    def window_visible(self) -> bool:
        try:
            return self.root.state() in ("normal", "zoomed")
        except tk.TclError:
            return False

    def open_window(self, select: str | None = None, initial: bool = False) -> None:
        """Show the Horde window in front, optionally on one goblin."""
        was_hidden = not self.window_visible()
        self.surface = "window"
        self.root.deiconify()
        if was_hidden:
            desktop_platform.dark_title_bar(self.root, caption=HEADER)
            if self.geometry and self.geometry.get("zoomed"):
                try:
                    self.root.state("zoomed")
                except tk.TclError:
                    pass
        self.root.lift()
        try:
            self.root.focus_force()
        except tk.TclError:
            pass
        if not self.show_strip_pref:
            self.strip.hide()
        elif not self.strip.shown:
            self.strip.show()
        if select:
            self.select(select)
        else:
            self.show_detail()
        if not initial:
            self.save_settings()
        self.kick_detail()

    def collapse_to_strip(self) -> None:
        """The window's X: the goblins stay on the desktop in their strip."""
        self.remember_geometry()
        self.surface = "strip"
        self.tooltip.hide()
        self.root.withdraw()
        self.strip.show()
        self.save_settings()

    def remember_geometry(self) -> None:
        if not self.window_visible():
            return
        try:
            zoomed = self.root.state() == "zoomed"
            if zoomed:
                self.geometry = {**(self.geometry or {}), "zoomed": True}
            else:
                self.geometry = {"x": self.root.winfo_x(), "y": self.root.winfo_y(), "width": self.root.winfo_width(),
                                 "height": self.root.winfo_height(), "zoomed": False}
        except tk.TclError:
            pass

    def on_root_configure(self, event) -> None:
        if event.widget is self.root and self.window_visible():
            self.remember_geometry()
            self.save_settings_soon()

    def strip_moved(self, anchor: tuple[int, int]) -> None:
        self.save_settings()

    def dialog_parent(self) -> tk.Misc:
        return self.root if self.window_visible() else self.strip.window

    # Settings ---------------------------------------------------------------------------------
    def settings_now(self) -> dict:
        settings = {
            "surface": self.surface, "showStrip": self.show_strip_pref, "keepOnTop": self.keep_on_top,
            "reducedMotion": self.reduced_motion_choice, "scaleWithDisplay": self.settings["scaleWithDisplay"],
            "doneOpen": self.done_open, "welcomed": self.welcomed, "aliases": self.aliases,
            "paletteOffset": self.palette_offset,
        }
        if self.geometry and all(isinstance(self.geometry.get(key), int) for key in ("x", "y", "width", "height")):
            settings["window"] = dict(self.geometry)
        if self.strip.anchor:
            settings["strip"] = {"right": int(self.strip.anchor[0]), "bottom": int(self.strip.anchor[1])}
        if not self.demo:
            settings["selected"] = self.selected if self.chosen else ""
        return settings

    def save_settings(self) -> None:
        """Write the settings file whole and at once; keys this version does not know are kept."""
        if self.save_after:
            try:
                self.root.after_cancel(self.save_after)
            except (tk.TclError, AttributeError):
                pass
            self.save_after = None
        merged = settings_to_save(self.raw_settings, self.settings_now())
        try:
            write_settings(state_file(), json.dumps(merged))
            self.raw_settings = merged
        except OSError:
            pass

    def save_settings_soon(self) -> None:
        if self.save_after is None and not self.closing:
            self.save_after = self.root.after(800, self.save_settings)

    # Reading the viewer -------------------------------------------------------------------------
    def poll(self) -> None:
        self.poll_after = None
        if self.closing:
            return
        try:
            self.fetch_now()
        finally:
            if not self.closing:
                self.poll_after = self.root.after(SCENE_MS, self.poll)

    def fetch_now(self) -> None:
        if self.closing or self.pending is not None:
            return
        self.pending = self.executor.submit(self.api.scene)
        self.receive_after = self.root.after(30, self.receive_scene)

    def retry_now(self) -> None:
        self.window.show_banner("Trying the viewer again…", restart=False)
        self.fetch_now()

    def receive_scene(self) -> None:
        self.receive_after = None
        if self.closing or self.pending is None:
            return
        if not self.pending.done():
            self.receive_after = self.root.after(80, self.receive_scene)
            return
        future, self.pending = self.pending, None
        # Only the read and its shape count as connection loss; rendering errors surface as errors.
        try:
            scene = future.result()
            agents = scene.get("agents")
            if agents is not None and not isinstance(agents, list):
                raise ValueError("agents")
        except Exception:
            self.failures += 1
            self.connection = "STALE" if self.last_success else "OFFLINE"
        else:
            self.take_scene(scene)
        self.refresh()

    def take_scene(self, scene: dict) -> None:
        self.actors = [actor for actor in scene.get("agents") or [] if is_agent(actor)]
        for actor in self.actors:
            self.known[actor_id(actor)] = actor
        while len(self.known) > 400:
            self.known.pop(next(iter(self.known)))
        self.requests = [item for item in scene.get("requests") or [] if isinstance(item, dict)]
        self.take_watched(scene.get("watched"))
        if isinstance(scene.get("joinedParties"), dict):
            self.joined_parties = {str(key): str(value) for key, value in scene["joinedParties"].items()}
        if isinstance(scene.get("manualLinks"), dict):
            self.manual_links = {str(key): str(value) for key, value in scene["manualLinks"].items()}
        self.warning = str(scene.get("warning") or "")
        self.coverage = scene.get("coverage") if isinstance(scene.get("coverage"), dict) else {}
        self.connection = "PARTIAL" if self.warning else "LIVE"
        self.last_success = time.time()
        self.failures = 0
        try:
            self.board_age = max(0.0, (float(scene.get("servedAt")) - float(scene.get("checkedAt"))) / 1000)
        except (TypeError, ValueError):
            self.board_age = 0.0
        # A dismissal is local only until the viewer's own list stops showing that ask.
        live = {str((ask_of(actor) or {}).get("key")) for actor in self.actors}
        self.dismissed_keys &= live
        if self.focus_thread:
            wanted, self.focus_thread = self.focus_thread, ""
            match = next((actor for actor in self.actors if actor_id(actor) == wanted), None) or next(
                (actor for actor in self.actors if party_scope(actor) == wanted), None)
            if match:
                self.selected, self.chosen = actor_id(match), True

    def visible_actors(self) -> list[dict]:
        """The scene's actors with this window's own dismissals applied at once."""
        return [self.apply_local(actor) for actor in self.actors]

    def apply_local(self, actor: dict) -> dict:
        ask = actor.get("ask")
        if isinstance(ask, dict) and str(ask.get("key")) in self.dismissed_keys:
            attention = "working" if actor.get("now") else "quiet"
            return {**actor, "ask": None, "needsInput": False, "dismissedAsk": {"key": ask.get("key")},
                    "attention": attention if str(actor.get("attention")) == "needs" else actor.get("attention")}
        return actor

    def actor(self, ident: str) -> dict | None:
        found = next((actor for actor in self.actors if actor_id(actor) == ident), None)
        return self.apply_local(found or self.known[ident]) if found or ident in self.known else None

    def has_agent(self, ident: str) -> bool:
        return any(actor_id(actor) == ident for actor in self.actors)

    # Drawing ------------------------------------------------------------------------------------
    def refresh(self) -> None:
        """Rebuild the rows from the latest scene and update every surface in place."""
        if self.closing:
            return
        now = time.time() * 1000
        actors = self.visible_actors()
        rows, counts = build_roster(actors, now_ms=now, catalog=self.source_catalog, watched=self.watched_ids,
                                    aliases=self.aliases, memory=self.memory, done_open=self.done_open,
                                    query=self.query, results=self.results)
        self.rows, self.counts = rows, counts
        if self.chosen and self.last_success and self.selected not in self.known and \
                not any(row.key == self.selected for row in rows):
            self.chosen = False  # A goblin saved from an earlier run that is gone: choose afresh.
        if not self.chosen:
            automatic = default_selection(rows)
            if automatic or not self.query:  # A search that hides everyone keeps the goblin on show.
                self.selected = automatic
        self.roster.render(rows, self.selected)
        note = coverage_note(self.coverage) if self.connection == "PARTIAL" else ""
        if not note and self.connection == "LIVE" and self.board_age >= 20:
            # The viewer answered with the last list it built while a fresher one is on its way.
            note = f"Updated {int(self.board_age)}s ago"
        self.window.update_counts(counts, note)
        # The taskbar and alt-tab say when someone is waiting.
        title = f"Goblin Horde · {counts.needs} need{'s' if counts.needs == 1 else ''} you" if counts.needs else "Goblin Horde"
        if self.root.title() != title:
            self.root.title(title)
        self.window.update_sources(source_chips(self.sources))
        self.update_banner()
        items, hidden, needs = strip_items(actors, now_ms=now, memory=self.strip_memory)
        self.strip.update(items, hidden, needs)
        self.show_detail()

    def update_banner(self) -> None:
        if self.connection in ("LIVE", "PARTIAL", "CONNECTING") or self.failures < OFFLINE_AFTER or self.restarting:
            if not self.restarting:
                self.window.hide_banner()
            return
        if self.last_success:
            minutes = max(0, int((time.time() - self.last_success) / 60))
            when = "just now" if minutes < 1 else f"{minutes} minute{'s' if minutes != 1 else ''} ago"
            text = f"Goblin Horde's viewer is not answering. This is what it reported {when}; retrying every few seconds."
        else:
            text = "Goblin Horde's viewer is not answering yet. Retrying every few seconds."
        self.window.show_banner(text, restart=self.restart_possible())

    def show_detail(self) -> None:
        key = self.selected
        view = self.detail_view
        if not key:
            view.show_welcome(self.welcome_note())
            return
        if key.startswith("result:"):
            party = key.split(":", 1)[1]
            source = next((item for item in self.source_catalog if str(item.get("id")) == party), {"id": party})
            view.show_chat(source, party in self.watched_ids)
            return
        ident = key
        if key.startswith("watch:"):
            party = key.split(":", 1)[1]
            row = next((row for row in self.rows if row.key == key), None)
            if row is None or not row.actor:
                source = next((item for item in self.source_catalog if str(item.get("id")) == party), {"id": party})
                view.show_chat(source, party in self.watched_ids,
                               sum(party_scope(actor) == party for actor in self.actors))
                return
            ident = actor_id(row.actor)
        actor = self.actor(ident)
        if actor is None:
            view.show_welcome(self.welcome_note())
            return
        if self.detail_route is False:
            detail = detail_from_actor(actor)
        else:
            detail = self.details.get(ident)
            if detail is None and ident in self.details:
                detail = detail_from_actor(actor)  # The viewer no longer has this agent's records.
        view.show_agent(self.apply_local(merged_agent(actor, detail)), detail)

    def welcome_note(self) -> str:
        names = {"codex": "Codex chats", "claude": "Claude Code sessions", "orca": "Orca workspaces",
                 "extensions": "extension feeds"}
        reading = [names[key] for key in ("codex", "claude", "orca", "extensions")
                   if (self.sources.get(key) or {}).get("state") == "ok"]
        parts = []
        if reading:
            parts.append("Reading " + (", ".join(reading[:-1]) + " and " + reading[-1] if len(reading) > 1 else reading[0]) + ".")
        elif not self.demo:
            parts.append("Connecting to the viewer…" if self.connection == "CONNECTING" else
                         "No sources are connected yet; the header shows what needs a fix.")
        parts.append("Phone access is on." if self.phone.get("enabled") else
                     "Phone access is off; turn it on from the ⋯ menu.")
        return " ".join(parts)

    def sprite_action(self, actor: dict, klass: str) -> str:
        """The public action a goblin acts out; an unconfirmed connection shows it resting."""
        if not self.demo and self.connection in ("CONNECTING", "STALE", "OFFLINE"):
            return "idle"
        view = motion_view(actor, klass)
        return self.action_pulses.action(view, needs_input=klass == NEEDS, animate=not self.reduced_motion)

    def sprite_state(self, actor: dict, klass: str, surface: str) -> tuple[dict, str, int, bool]:
        """Outfit, action, frame, and stillness for one goblin on one surface; a new action starts
        on its first frame."""
        action = self.sprite_action(actor, klass)
        frame = self.motion_clock.frame((surface, actor_id(actor)), action, self.phase)
        return style_for(actor, self.palette_offset), action, frame, self.reduced_motion

    def animate(self) -> None:
        if self.closing:
            return
        # The beat is rescheduled even when a step fails, so one bad frame never freezes the goblins.
        try:
            self.animate_step()
        finally:
            if not self.closing:
                self.animate_after = self.root.after(BEAT_MS, self.animate)

    def animate_step(self) -> None:
        self.phase += 1
        if self.reduced_motion:
            return  # Still goblins are repainted only when their action changes.
        if self.window_visible():
            self.roster.paint_sprites()
            self.detail_view.animate()
        self.strip.animate()

    def tick(self) -> None:
        self.tick_after = None
        if self.closing:
            return
        try:
            if self.window_visible():
                self.detail_view.tick(time.time() * 1000)
        finally:
            if not self.closing:
                self.tick_after = self.root.after(TICK_MS, self.tick)

    # The selected goblin's records ------------------------------------------------------------------
    def detail_target(self) -> str:
        key = self.selected
        if not key or key.startswith("result:"):
            return ""
        if key.startswith("watch:"):
            row = next((row for row in self.rows if row.key == key), None)
            return actor_id(row.actor) if row is not None and row.actor else ""
        return key

    def poll_detail(self) -> None:
        self.detail_after = None
        if self.closing:
            return
        try:
            target = self.detail_target()
            if target and self.window_visible() and self.detail_pending is None and self.detail_route is not False:
                future = self.executor.submit(self.api.agent, target)
                self.detail_pending = future
                self.when_done(future, lambda result, error: self.take_detail(target, result, error))
        finally:
            if not self.closing:
                self.detail_after = self.root.after(DETAIL_MS, self.poll_detail)

    def kick_detail(self) -> None:
        if self.closing:
            return
        if self.detail_after:
            self.root.after_cancel(self.detail_after)
        self.detail_after = self.root.after(10, self.poll_detail)

    def take_detail(self, ident: str, result, error) -> None:
        self.detail_pending = None
        if error is not None:
            if isinstance(error, ApiError) and error.missing:
                self.detail_route = False  # An older viewer: show what the scene itself carries.
            elif isinstance(error, ApiError) and error.status in (403, 404):
                self.details[ident] = None
            else:
                return  # A hiccup: keep showing the last good records.
        else:
            self.detail_route = True
            self.details.pop(ident, None)
            self.details[ident] = result if isinstance(result, dict) else None
            while len(self.details) > DETAIL_CACHE:
                self.details.pop(next(iter(self.details)))
        if self.detail_target() == ident:
            self.show_detail()

    # Selection ----------------------------------------------------------------------------------
    def select(self, key: str, chosen: bool = True) -> None:
        self.selected = key
        self.chosen = self.chosen or chosen
        self.roster.set_selected(key)
        self.roster.ensure_visible(key)
        self.show_detail()
        self.kick_detail()
        self.save_settings_soon()

    def select_first(self, section: str) -> None:
        row = next((row for row in self.rows if row.kind == "agent" and row.section == section), None)
        if row is not None:
            self.select(row.key)

    def move_selection(self, step: int) -> None:
        key = move_selection(self.rows, self.selected, step)
        if key and key != self.selected:
            self.select(key)

    def on_row_click(self, row) -> None:
        if row.kind == "section" and row.section == "done":
            self.toggle_done()
        elif row.kind == "party":
            member = next((item for item in self.rows if item.kind == "agent" and item.party == row.party
                           and item.section == "working"), None)
            if member is not None:
                self.select(member.key)
        elif row.kind in ("agent", "watch", "result"):
            self.select(row.key)

    def toggle_done(self, open_: bool | None = None) -> None:
        self.done_open = (not self.done_open) if open_ is None else open_
        self.refresh()
        self.save_settings_soon()
        if self.done_open:
            self.roster.ensure_visible("section:done")

    def on_query(self, text: str) -> None:
        if text != self.query:
            self.query = text
            if not text:
                self.results = None
            self.refresh()

    def search_catalog(self, text: str) -> None:
        """Enter in "Find a chat…": older chats from the catalog, to open or watch."""
        self.query = text
        self.refresh_catalog()
        self.results = search_sources(self.source_catalog, text, limit=40) if text else None
        self.refresh()
        if self.results:
            self.roster.ensure_visible("section:results")

    def clear_results(self) -> None:
        self.results = None
        self.refresh()

    # Answering, opening, messaging -------------------------------------------------------------------
    def can(self, *paths: str) -> bool:
        """Whether the viewer has any of these routes (an older one answers 404 and is not asked again)."""
        return any(self.api.available(path) for path in paths)

    def request_for(self, ask: dict) -> dict | None:
        wanted = str(ask.get("requestId") or "")
        return next((item for item in self.requests if str(item.get("id")) == wanted), None) if wanted else None

    def party_label(self, party: str) -> str:
        source = next((item for item in self.source_catalog if str(item.get("id")) == party), None)
        if source and source.get("name"):
            return str(source["name"])
        row = next((row for row in self.rows if row.kind == "party" and row.party == party), None)
        return row.title if row is not None else ""

    def after_action(self) -> None:
        self.fetch_now()
        self.kick_detail()

    def open_agent(self, actor: dict, view=None) -> None:
        """Open the agent in its own app (Codex, Orca, Claude)."""
        view = view or self.detail_view

        def done(result, error) -> None:
            if error:
                view.say(str(error), error=True, seconds=10)
            elif isinstance(result, dict) and result.get("message"):
                view.say(str(result["message"]))
        self.when_done(self.executor.submit(self.api.open_agent, actor_id(actor)), done)

    def dismiss_ask(self, actor: dict) -> None:
        """Stop the alert for this ask now; the viewer remembers it, and a new ask alerts again."""
        ask = ask_of(actor) or {}
        key = str(ask.get("key") or "")
        if not key or ask.get("legacy"):
            return
        self.dismissed_keys.add(key)
        self.refresh()

        def done(_result, error) -> None:
            if error:
                self.dismissed_keys.discard(key)
                self.refresh()
                self.detail_view.say(f"The alert was not dismissed: {error}", error=True, seconds=10)
            else:
                self.after_action()
        self.when_done(self.executor.submit(self.api.dismiss, actor_id(actor), key), done)

    def send_message(self, actor: dict, text: str, done) -> None:
        def finished(result, error) -> None:
            done(result, error)
            if not error:
                self.after_action()
        self.when_done(self.executor.submit(self.api.message, actor_id(actor), text), finished)

    def respond(self, actor: dict, request_id: str, *, decision: str | None = None, answers: dict | None = None,
                done=None) -> None:
        def finished(result, error) -> None:
            if done:
                done(result, error)
            if not error:
                self.after_action()
        # Only the api's own method goes to the worker: nothing that holds Tk objects may be released there.
        self.when_done(self.executor.submit(self.api.respond, actor_id(actor), request_id, decision=decision,
                                            answers=answers), finished)

    def open_viewer(self, party: str = "") -> None:
        if self.demo:
            self.detail_view.say("The demo has no browser viewer.", error=True)
            return
        webbrowser.open(self.api.viewer_url(party))

    # Background requests ----------------------------------------------------------------------------
    def when_done(self, future, done) -> None:
        """Call done(result, error) on the Tk thread once a background request finishes."""
        def check() -> None:
            if self.closing:
                return
            if not future.done():
                self.root.after(120, check)
                return
            try:
                result = future.result()
            except Exception as error:  # A failed request is reported, never raised into Tk.
                done(None, error)
                return
            done(result, None)
        self.root.after(60, check)

    def load_catalog(self) -> None:
        self.catalog_after = None
        if self.closing:
            return
        delay = CATALOG_MS
        try:
            if self.catalog_pending is None:
                self.catalog_pending = self.executor.submit(self.api.threads)
            if not self.catalog_pending.done():
                delay = 150
                return
            try:
                catalog = self.catalog_pending.result()
                self.source_catalog = [item for item in catalog.get("threads") or [] if isinstance(item, dict)]
                self.catalog_unavailable = [str(name) for name in catalog.get("unavailable") or []]
                self.take_watched(catalog.get("watched"))
                self.catalog_failed = False
            except Exception:
                self.catalog_failed = not self.source_catalog
            self.catalog_pending = None
            self.catalog_at = time.monotonic()
            if self.results is not None and self.query:
                self.results = search_sources(self.source_catalog, self.query, limit=40)
            self.refresh()
        finally:
            # Scheduled even after a failed refresh; a nested refresh_catalog may have done it already.
            if not self.closing and self.catalog_after is None:
                self.catalog_after = self.root.after(delay, self.load_catalog)

    def refresh_catalog(self) -> None:
        """Reload the full chat list when someone starts looking through it."""
        if self.catalog_pending is None and time.monotonic() - self.catalog_at > 20:
            if self.catalog_after:
                self.root.after_cancel(self.catalog_after)
                self.catalog_after = None
            self.load_catalog()

    def poll_sources(self) -> None:
        """Which feeds are connected, starting, or need setup; every 30 seconds, or at once after a fix."""
        self.sources_after = None
        if self.closing:
            return
        delay = SOURCES_MS
        try:
            if self.sources_pending is None:
                self.sources_pending = self.executor.submit(self.api.capabilities)
            if not self.sources_pending.done():
                delay = 200
                return
            try:
                capabilities = self.sources_pending.result()
                self.sources = capabilities.get("sources") or {}
                self.autostart = capabilities.get("autostart") or {}
                self.phone = capabilities.get("phone") or {}
            except Exception:
                pass  # The banner already says when the viewer itself is not answering.
            self.sources_pending = None
            self.refresh()
        finally:
            if not self.closing and self.sources_after is None:
                self.sources_after = self.root.after(delay, self.poll_sources)

    def refresh_sources_soon(self, delay: int = 1500) -> None:
        if self.sources_after:
            self.root.after_cancel(self.sources_after)
        self.sources_after = self.root.after(delay, self.poll_sources)

    # Feeds --------------------------------------------------------------------------------------------
    def source_tip(self, key: str, event) -> None:
        chip = next((item for item in source_chips(self.sources) if item.key == key), None)
        if chip is not None and chip.tip:
            self.tooltip.schedule(chip.tip, event.x_root, event.y_root, delay=250)

    def fix_source(self, key: str) -> None:
        chip = next((item for item in source_chips(self.sources) if item.key == key), None)
        if chip is not None and chip.action:
            getattr(self, chip.action)()

    def reconnect_codex(self) -> None:
        """Restart the viewer's Codex connection now instead of waiting for its next retry."""
        def done(_result, error) -> None:
            if error:
                messagebox.showwarning("Goblin Horde", f"Codex could not be reconnected: {error}",
                                       parent=self.dialog_parent())
            self.refresh_sources_soon(2500)
            self.fetch_now()
        self.sources["codex"] = {**self.sources.get("codex", {}), "state": "starting", "detail": "Starting Codex…"}
        self.refresh()
        self.when_done(self.executor.submit(self.api.reconnect), done)

    def connect_claude(self) -> None:
        """Connect Claude Code after an explicit yes: it adds Goblin Horde hooks to Claude Code's user settings."""
        if not messagebox.askyesno(
                "Connect Claude Code",
                "Show Claude Code sessions here?\n\nThis adds Goblin Horde entries to your Claude Code settings "
                f"({claude_settings_label()}). Your other settings and hooks stay as they are, and a backup is kept beside it.\n\n"
                "Undo any time with: node goblin.mjs hooks remove", parent=self.dialog_parent()):
            return

        def done(result, error) -> None:
            if error:
                messagebox.showwarning("Goblin Horde", f"Claude Code was not connected: {error}", parent=self.dialog_parent())
            else:
                messagebox.showinfo("Goblin Horde", str(result.get("message") or "Connected Claude Code."),
                                    parent=self.dialog_parent())
            self.refresh_sources_soon(300)
        self.when_done(self.executor.submit(self.api.connect_claude), done)

    def toggle_autostart(self) -> None:
        """Start Goblin Horde when the person signs in to Windows, or stop doing so."""
        enable = not self.autostart.get("enabled")

        def done(result, error) -> None:
            if error:
                messagebox.showwarning("Goblin Horde", f"That did not change: {error}", parent=self.dialog_parent())
            else:
                self.autostart = result.get("autostart") or self.autostart
        self.when_done(self.executor.submit(self.api.autostart, enable), done)

    def toggle_phone(self) -> None:
        """Turn phone access over Wi-Fi on (after an explicit yes) or off; off signs every phone out."""
        enable = not self.phone.get("enabled")
        if enable and not messagebox.askyesno(
                "Phone access",
                "Turn on phone access?\n\nThis computer starts answering on your Wi-Fi. A phone on the same network that "
                "enters the pairing code can read these chats, send replies to Codex, and approve or decline Codex "
                "commands. Phones see summaries only, never full commands or transcripts.\n\nIt uses plain HTTP, so "
                "only turn it on at home or on another network you trust. Turn it off here any time.",
                parent=self.dialog_parent()):
            return

        def done(result, error) -> None:
            if error:
                messagebox.showwarning("Goblin Horde", f"Phone access did not change: {error}", parent=self.dialog_parent())
                return
            self.phone = result.get("phone") or self.phone
            if not enable:
                messagebox.showinfo("Goblin Horde", "Phone access is off. Paired phones were signed out.",
                                    parent=self.dialog_parent())
            elif self.phone.get("listening"):
                messagebox.showinfo(
                    "Goblin Horde",
                    f"Phone access is on ({self.phone.get('adapter') or 'Wi-Fi'}).\n\nOn your phone, open:\n"
                    f"{self.phone.get('url', '')}\n\nThen enter this pairing code:\n{result.get('code', '')}",
                    parent=self.dialog_parent())
            else:
                messagebox.showwarning("Goblin Horde", str(self.phone.get("problem") or "No Wi-Fi address is available yet."),
                                       parent=self.dialog_parent())
            self.refresh()
        self.when_done(self.executor.submit(self.api.phone, enable), done)

    def reset_pairing(self) -> None:
        """A new pairing code: every paired phone is signed out and must pair again."""
        if not messagebox.askyesno("New pairing code", "Make a new pairing code?\n\nEvery paired phone is signed out "
                                   "and must pair again with the new code.", parent=self.dialog_parent()):
            return

        def done(result, error) -> None:
            if error:
                messagebox.showwarning("Goblin Horde", f"The pairing code did not change: {error}",
                                       parent=self.dialog_parent())
                return
            self.phone = result.get("phone") or self.phone
            where = f"\n\nOn your phone, open {self.phone['url']}" if self.phone.get("listening") and self.phone.get("url") else \
                "\n\nPhone access is off; turn it on from this menu to pair a phone."
            messagebox.showinfo("Goblin Horde", f"New pairing code: {result.get('code', '')}\n\nPaired phones were signed out."
                                + where, parent=self.dialog_parent())
        self.when_done(self.executor.submit(self.api.phone_reset), done)

    def copy_diagnostics(self) -> None:
        """Copy a short report that is safe to share: versions, states, counts, timings; no chats or codes."""
        widget_facts = (f"widget: {self.surface} · {len(self.actors)} goblins · scene {self.connection.lower()}, "
                        f"{int(self.board_age)}s old · detail {'unavailable' if self.detail_route is False else 'ok'} · "
                        f"scale {getattr(getattr(self, 'theme', None), 'scale', 1.0)} · "
                        f"errors since start: {self.error_count}")

        def done(result, error) -> None:
            if error:
                messagebox.showwarning("Goblin Horde", f"The viewer did not answer: {error}", parent=self.dialog_parent())
                return
            text = f"{result.get('text', '')}\n{widget_facts}"
            self.root.clipboard_clear()
            self.root.clipboard_append(text)
            messagebox.showinfo("Goblin Horde", "Diagnostic report copied. Paste it into your bug report.\n\n" + text,
                                parent=self.dialog_parent())
        self.when_done(self.executor.submit(self.api.diagnostics), done)

    def restart_possible(self) -> bool:
        """Only an installed copy started by its manager can restart its own viewer."""
        return (not self.demo and bool(os.environ.get("GOBLIN_HORDE_STATE_DIR"))
                and (HERE / "goblin-horde-install.json").is_file() and (HERE / "goblin.mjs").is_file()
                and shutil.which("node") is not None)

    def restart_viewer(self) -> None:
        """Start the viewer again with this installation's own manager; it never starts a second widget."""
        if not self.restart_possible():
            return
        self.restarting = True
        self.window.show_banner("Starting the viewer…", restart=False)
        command = [shutil.which("node") or "node", str(HERE / "goblin.mjs"), "start", "--ui", "none",
                   "--port", str(self.port), "--install-dir", str(HERE),
                   "--state-dir", os.environ.get("GOBLIN_HORDE_STATE_DIR", "")]
        if os.environ.get("CLAUDE_CONFIG_DIR"):
            command += ["--claude-config-dir", os.environ["CLAUDE_CONFIG_DIR"]]
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0

        def run() -> int:
            return subprocess.run(command, cwd=str(HERE), env=os.environ.copy(), capture_output=True, text=True,
                                  timeout=90, creationflags=flags).returncode

        def done(code, error) -> None:
            self.restarting = False
            if error or code:
                self.window.show_banner("The viewer did not start. Run Goblin Horde from the Start menu, or "
                                        "`node goblin.mjs doctor` to see why.", restart=True)
            self.fetch_now()
        self.when_done(self.executor.submit(run), done)

    # Watching and parties ---------------------------------------------------------------------------
    def take_watched(self, ids) -> None:
        """The server's watch list, unless a change made here is still on its way there."""
        if isinstance(ids, list) and self.watch_pending is None:
            self.watched_ids = [str(item) for item in ids if isinstance(item, str)]

    def is_watched(self, party_id: str) -> bool:
        return party_id in self.watched_ids

    def set_watched(self, party_id: str, watched: bool) -> None:
        """Watch a chat (the viewer always reads it) or stop; shown at once, saved by the server."""
        if not party_id or party_id == "all":
            return
        previous = list(self.watched_ids)
        rest = [item for item in self.watched_ids if item != party_id]
        self.watched_ids = [party_id, *rest] if watched else rest
        self.refresh()
        future = self.executor.submit(self.api.watch, party_id, watched)
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
            self.refresh()
            self.fetch_now()
        self.root.after(150, settle)

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
                messagebox.showwarning("Goblin Horde", f"That did not change: {error}", parent=self.dialog_parent())
                return
            self.manual_links = {str(key): str(value) for key, value in (result.get("manualLinks") or {}).items()}
            self.fetch_now()
        self.when_done(self.executor.submit(self.api.join, party_id, chat_id), done)

    def rename(self, actor: dict) -> None:
        ident = actor_id(actor)
        chosen = simpledialog.askstring("Goblin Horde", "Name this goblin (blank restores its own name):",
                                        initialvalue=self.aliases.get(ident, ""), parent=self.dialog_parent())
        if chosen is None:
            return
        alias = chosen.strip()[:40]
        if alias:
            self.aliases[ident] = alias
        else:
            self.aliases.pop(ident, None)
        self.refresh()
        self.save_settings()

    # Menus --------------------------------------------------------------------------------------------
    def on_row_menu(self, row, event) -> None:
        if row is None or row.kind not in ("agent", "watch", "result", "party"):
            self.show_menu(event)
            return
        menu = tk.Menu(self.root, tearoff=False)
        actor = row.actor or {}
        party = row.party
        joined = actor.get("joined") if isinstance(actor.get("joined"), dict) else None
        origin = str(joined.get("from") or party) if joined else party
        if row.kind != "result" and party:
            if origin.startswith(("orca:", "claude:", "ext:")):
                if joined or self.joined_parties.get(origin):
                    menu.add_command(label="Separate from its Codex chat", command=lambda: self.set_join(origin, ""))
                chats = tk.Menu(menu, tearoff=False)
                for chat in self.recent_chats(12):
                    chat_id = str(chat.get("id"))
                    if chat_id == party:
                        continue
                    chats.add_command(label=str(chat.get("name") or chat_id)[:60],
                                      command=lambda chat_id=chat_id: self.set_join(origin, chat_id))
                if not self.recent_chats(1):
                    chats.add_command(label="No Codex chats yet", state="disabled")
                menu.add_cascade(label="Join party to a Codex chat", menu=chats)
            else:
                separable = [(item, self.source_label_for(item)) for item, chat in self.joined_parties.items()
                             if chat == party]
                for item, label in separable:
                    menu.add_command(label=f"Separate {label[:40]} from this chat",
                                     command=lambda item=item: self.set_join(item, ""))
                if not separable:
                    menu.add_command(label="Nothing is joined to this chat", state="disabled")
            if origin in self.manual_links:
                menu.add_command(label="Back to automatic joining", command=lambda: self.set_join(origin, None))
            menu.add_separator()
        watch_target = party or str(actor.get("id") or "")
        if watch_target and self.can("/api/watch"):
            watched = self.is_watched(watch_target)
            menu.add_command(label="Stop watching this chat" if watched else "Watch this chat",
                             command=lambda: self.set_watched(watch_target, not watched))
        ask = ask_of(actor) if actor else None
        if ask and not ask.get("legacy") and self.can("/api/dismiss"):
            menu.add_command(label="Dismiss alert", command=lambda: self.dismiss_ask(actor))
        if row.kind == "agent":
            menu.add_command(label="Rename goblin…", command=lambda: self.rename(actor))
            menu.add_command(label="Copy name", command=lambda: (self.root.clipboard_clear(),
                                                                 self.root.clipboard_append(display_name(actor))))
        menu.tk_popup(event.x_root, event.y_root)

    def show_menu(self, event=None) -> None:
        menu = tk.Menu(self.root, tearoff=False)
        menu.add_command(label="Reconnect Codex", command=self.reconnect_codex)
        if (self.sources.get("claude") or {}).get("canConnect"):
            menu.add_command(label="Connect Claude Code…", command=self.connect_claude)
        if self.autostart.get("available"):
            self.autostart_var = tk.BooleanVar(self.root, bool(self.autostart.get("enabled")))
            menu.add_checkbutton(label="Start with Windows", variable=self.autostart_var, command=self.toggle_autostart)
        menu.add_command(label=f"Phone access (Wi-Fi): {'On' if self.phone.get('enabled') else 'Off'}",
                         command=self.toggle_phone)
        menu.add_command(label="New pairing code (signs out phones)", command=self.reset_pairing)
        menu.add_command(label="Copy diagnostic report", command=self.copy_diagnostics)
        menu.add_separator()
        self.motion_var = tk.BooleanVar(self.root, self.reduced_motion)
        self.top_var = tk.BooleanVar(self.root, self.keep_on_top)
        self.strip_var = tk.BooleanVar(self.root, self.show_strip_pref)
        menu.add_checkbutton(label="Reduced motion", variable=self.motion_var, command=self.toggle_reduced_motion)
        menu.add_checkbutton(label="Keep on top", variable=self.top_var, command=self.toggle_keep_on_top)
        menu.add_checkbutton(label="Show goblin strip", variable=self.strip_var, command=self.toggle_strip)
        menu.add_command(label="Change goblin outfits", command=self.change_outfits)
        menu.add_command(label="Open the browser viewer", command=lambda: self.open_viewer(""))
        menu.add_separator()
        menu.add_command(label=QUIT_LABEL, command=self.quit_all)
        if event is not None and hasattr(event, "x_root"):
            x, y = event.x_root, event.y_root
        else:
            button = self.window.menu_button
            x, y = button.winfo_rootx(), button.winfo_rooty() + button.winfo_height()
        menu.tk_popup(x, y)

    def show_strip_menu(self, event) -> None:
        menu = tk.Menu(self.root, tearoff=False)
        menu.add_command(label="Open Goblin Horde", command=self.open_window)
        self.motion_var = tk.BooleanVar(self.root, self.reduced_motion)
        menu.add_checkbutton(label="Reduced motion", variable=self.motion_var, command=self.toggle_reduced_motion)
        if self.window_visible():
            menu.add_command(label="Hide goblin strip", command=self.toggle_strip)
        menu.add_separator()
        menu.add_command(label=QUIT_LABEL, command=self.quit_all)
        menu.tk_popup(event.x_root, event.y_root)

    def toggle_reduced_motion(self) -> None:
        """Switch between animated goblins and one still, readable frame per action."""
        self.reduced_motion = self.reduced_motion_choice = not self.reduced_motion
        self.save_settings()
        self.roster.paint_sprites(force=True)
        self.detail_view.paint_sprite(force=True)
        self.strip.paint_sprites(force=True)

    def toggle_keep_on_top(self) -> None:
        self.keep_on_top = not self.keep_on_top
        self.root.wm_attributes("-topmost", self.keep_on_top)
        self.save_settings()

    def toggle_strip(self) -> None:
        self.show_strip_pref = not self.show_strip_pref
        if self.show_strip_pref:
            self.strip.show()
        elif self.window_visible():
            self.strip.hide()
        self.save_settings()

    def change_outfits(self) -> None:
        self.palette_offset = (self.palette_offset + 1) % len(KINDS)
        self.save_settings()
        self.roster.paint_sprites(force=True)
        self.detail_view.paint_sprite(force=True)
        self.strip.paint_sprites(force=True)

    # Closing ------------------------------------------------------------------------------------------
    def quit_all(self) -> None:
        """Stop the viewer too, then close. The request has its own thread, not the pool that close()
        cancels, and Python waits for it before exiting."""
        if not self.demo:
            def ask() -> None:
                try:
                    self.api.quit()
                except Exception:
                    pass  # Already stopped, or not ours to stop; the goblins close either way.
            threading.Thread(target=ask, name="goblin-horde-quit").start()
        self.close()

    def close(self) -> None:
        if self.closing:
            return
        self.remember_geometry()
        self.save_settings()
        self.closing = True
        # Every pending timer, including request checks and tooltips nobody tracks by name. Only the
        # timers are cancelled here; destroy() then removes their commands with the widgets that own them.
        try:
            pending = self.root.tk.splitlist(self.root.tk.call("after", "info"))
        except tk.TclError:
            pending = ()
        for callback in pending:
            try:
                self.root.tk.call("after", "cancel", callback)
            except tk.TclError:
                pass
        self.tooltip.destroy()
        self.strip.destroy()
        self.sprite_images.clear()  # Tk images are freed here, on the Tk thread.
        self.executor.shutdown(wait=False, cancel_futures=True)
        self.root.destroy()

    def run(self) -> None:
        self.root.mainloop()


def main() -> None:
    parser = argparse.ArgumentParser(description="Goblin Horde on the desktop: the Horde window and the goblin strip")
    parser.add_argument("--thread", default="", help="Select this chat or agent when it appears.")
    parser.add_argument("--port", type=int, default=43917)
    parser.add_argument("--demo", nargs="?", const="default", default=None,
                        help="Invented goblins, no viewer: default, empty, one, crowd, or long.")
    parser.add_argument("--select", default="", help="Select this agent id at start (with --demo, for screenshots).")
    parser.add_argument("--surface", choices=("window", "strip"), default="")
    args = parser.parse_args()
    try:
        widget = GoblinWidget(args.thread, args.port, args.demo is not None, args.demo or "default", args.select,
                              args.surface)
    except (TransparencyUnavailable, tk.TclError) as error:
        # The manager reads this exit code and opens the browser viewer, saying why.
        print(f"Transparent desktop goblins are unavailable: {error}", file=sys.stderr, flush=True)
        sys.exit(UNAVAILABLE_EXIT)
    desktop_platform.close_on_terminate(widget.root, widget.close)
    desktop_platform.announce_ready()
    widget.run()


if __name__ == "__main__":
    main()
