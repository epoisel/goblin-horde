"""Goblin Horde's pet game on the Windows desktop: a hidden Tk root under the pet field.

This module is the app: its lifecycle (the ready line, the error log, closing and quitting), its
settings file, and the field's menu. The game itself is pet_field's, and every request to the local
server goes through horde_api.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import sys
import threading
import time
import tkinter as tk
import traceback

import desktop_platform
from desktop_platform import UNAVAILABLE_EXIT, TransparencyUnavailable
from horde_api import HordeApi
from horde_theme import Theme, Tooltip
from pet_field import PetField
from pets_text import UPDATE_FAILED, update_label, updating_line

# Failed callbacks are noted in run/widget.log: every one of the first few, then one in a hundred.
LOGGED_ERRORS = 20
QUIT_LABEL = "Quit Goblin Horde"


def state_file() -> Path:
    """goblins.json in the state folder: the manager's GOBLIN_HORDE_STATE_DIR, or GoblinHorde in
    %LOCALAPPDATA% for a widget started by hand."""
    base = Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "GoblinHorde"
    override = os.environ.get("GOBLIN_HORDE_STATE_DIR") or ""
    if override and Path(override).is_absolute():
        base = Path(override)
    base.mkdir(parents=True, exist_ok=True)
    return base / "goblins.json"


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
        pass  # Nowhere to write; the count is still kept.


def error_line(count: int, kind, trace) -> str:
    """Type and place only: an error's own message can quote private text."""
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


def read_settings(saved) -> dict:
    """The game's settings from goblins.json. Each value is checked on its own, so one bad value never
    drops the rest. ``reducedMotion`` is None until the player chooses, and then the system's choice is
    followed. ``petScreen`` is the display the horde stands on, by its place from the left."""
    saved = saved if isinstance(saved, dict) else {}
    motion, scale, screen = saved.get("reducedMotion"), saved.get("scaleWithDisplay"), saved.get("petScreen")
    return {
        "reducedMotion": motion if isinstance(motion, bool) else None,
        "scaleWithDisplay": scale if isinstance(scale, bool) else True,
        "petScreen": screen if type(screen) is int and 0 <= screen <= 64 else 0,
    }


class GoblinWidget:
    """The desktop app: a hidden Tk root, the pet field on it, and the field's menu."""

    error_count = 0  # Callbacks that failed since start.
    closing = False

    def __init__(self, port: int = 43917) -> None:
        desktop_platform.check_support()
        self.api = HordeApi(port)
        self.raw_settings = read_saved_settings()
        self.settings = read_settings(self.raw_settings)
        self.reduced_motion_choice = self.settings["reducedMotion"]
        self.pet_screen = self.settings["petScreen"]
        if self.settings["scaleWithDisplay"]:
            desktop_platform.enable_dpi_awareness()
        self.root = tk.Tk()
        self.root.withdraw()
        # pythonw has no console: a failed callback is counted and noted in run/widget.log instead.
        self.root.report_callback_exception = self.report_callback_error
        self.executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="goblin-horde")
        self.reduced_motion = (self.reduced_motion_choice if self.reduced_motion_choice is not None
                               else desktop_platform.system_prefers_reduced_motion())
        scale = desktop_platform.display_scale(self.root) if self.settings["scaleWithDisplay"] else 1.0
        self.theme = Theme(self.root, scale)
        self.tooltip = Tooltip(self.root, self.theme)
        self.field = PetField(self, self.theme, self.pet_screen)
        self.field.show()

    def report_callback_error(self, kind, _value, trace) -> None:
        """Tk's handler for a callback that raised. The loops reschedule themselves regardless."""
        self.error_count += 1
        if self.error_count <= LOGGED_ERRORS or self.error_count % 100 == 0:
            note_widget_error(error_line(self.error_count, kind, trace))

    # Settings ---------------------------------------------------------------------------------
    def settings_now(self) -> dict:
        return {"reducedMotion": self.reduced_motion_choice, "scaleWithDisplay": self.settings["scaleWithDisplay"],
                "petScreen": self.pet_screen}

    def save_settings(self) -> None:
        """Write the settings file whole and at once. Keys this version does not read are kept, so an
        older widget's settings and a newer one's survive."""
        merged = {**self.raw_settings, **self.settings_now()}
        try:
            write_settings(state_file(), json.dumps(merged))
            self.raw_settings = merged
        except OSError:
            pass

    def screen_chosen(self, place: int) -> None:
        """The field moved to another display: keep it there from now on."""
        self.pet_screen = place
        self.save_settings()

    def toggle_reduced_motion(self) -> None:
        """Switch between animated goblins and still frames. The field reads it every frame."""
        self.reduced_motion = self.reduced_motion_choice = not self.reduced_motion
        self.save_settings()

    # The menu ---------------------------------------------------------------------------------
    def show_pets_menu(self, event) -> None:
        self.pets_menu().tk_popup(event.x_root, event.y_root)

    def pets_menu(self) -> tk.Menu:
        """The rows the field lists, then Reduced motion beside its other choices of how the goblins
        show, then the update the viewer keeps, when there is one, and Quit."""
        field = self.field
        actions = {"buy": field.buy, "fight": field.fight, "goblins": field.toggle_goblins, "screen": field.move_to}
        menu = tk.Menu(self.root, tearoff=False)
        self.add_rows(menu, field.menu_rows(), actions)
        self.motion_var = tk.BooleanVar(self.root, self.reduced_motion)
        menu.add_checkbutton(label="Reduced motion", variable=self.motion_var, command=self.toggle_reduced_motion)
        menu.add_separator()
        if field.update_version:
            menu.add_command(label=update_label(field.update_version), command=self.apply_update)
        menu.add_command(label=QUIT_LABEL, command=self.quit_all)
        return menu

    def apply_update(self) -> None:
        """Ask the server to put its waiting update in place. Its manager then stops the goblins and the
        new version brings them back, so only a request that did not go through is answered here."""
        field = self.field
        field.say(updating_line(field.update_version))
        self.when_done(self.executor.submit(self.api.update_apply),
                       lambda _reply, error: field.say(UPDATE_FAILED) if error is not None else None)

    def add_rows(self, menu: tk.Menu, rows: list, actions: dict) -> None:
        """Menu items for (label, action, enabled) rows: a row with no label is a divider, an action that
        is a list of rows a submenu, and any other action names an entry of ``actions`` and its arguments."""
        for label, action, enabled in rows:
            state = "normal" if enabled else "disabled"
            if not label:
                menu.add_separator()
            elif isinstance(action, list):
                submenu = tk.Menu(menu, tearoff=False)
                self.add_rows(submenu, action, actions)
                menu.add_cascade(label=label, menu=submenu, state=state)
            elif action is None:
                menu.add_command(label=label, state="disabled")
            else:
                name, *values = action
                menu.add_command(label=label, state=state,
                                 command=lambda name=name, values=values: actions[name](*values))

    # Background requests ----------------------------------------------------------------------
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

    # Closing ----------------------------------------------------------------------------------
    def quit_all(self) -> None:
        """Stop the local server too, then close. The request has its own thread, not the pool that
        close() cancels, and Python waits for it before exiting."""
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
        self.field.destroy()
        self.executor.shutdown(wait=False, cancel_futures=True)
        self.root.destroy()

    def run(self) -> None:
        self.root.mainloop()


def main() -> None:
    parser = argparse.ArgumentParser(description="Goblin Horde's pet game on the Windows desktop")
    parser.add_argument("--port", type=int, default=43917)
    # An older manager or shortcut may still name a surface. The pet field is the only one now.
    parser.add_argument("--surface", default="", help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        widget = GoblinWidget(args.port)
    except (TransparencyUnavailable, tk.TclError) as error:
        # The manager reads this exit code and says why the goblins did not show.
        print(f"Transparent desktop goblins are unavailable: {error}", file=sys.stderr, flush=True)
        sys.exit(UNAVAILABLE_EXIT)
    desktop_platform.announce_ready()
    widget.run()


if __name__ == "__main__":
    main()
