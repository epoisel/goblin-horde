"""Helpers for tests that build the real Tk window from the demo world (imported, not collected)."""

import _tkinter
import gc
import os
import tempfile
import time
from unittest.mock import patch


def isolate(test) -> str:
    """A temporary state folder (and LOCALAPPDATA/APPDATA) for one test; nothing real is read or written.

    The last cleanup collects garbage on the main thread: a window's Tk objects sit in reference
    cycles, and Tk must never be torn down by a collection that happens to run on a worker thread."""
    test.addCleanup(gc.collect)
    folder = tempfile.TemporaryDirectory(prefix="goblin-window-test-")
    test.addCleanup(folder.cleanup)
    env = patch.dict(os.environ, {"GOBLIN_HORDE_STATE_DIR": folder.name, "LOCALAPPDATA": folder.name,
                                  "APPDATA": folder.name})
    env.start()
    test.addCleanup(env.stop)
    return folder.name


def quiet(widget) -> None:
    """Stop every timer so a test drives the window by hand."""
    for name in ("poll_after", "receive_after", "detail_after", "animate_after", "tick_after", "catalog_after",
                 "sources_after", "show_after", "save_after"):
        timer = getattr(widget, name, None)
        if timer:
            try:
                widget.root.after_cancel(timer)
            except Exception:
                pass
            setattr(widget, name, None)


def settle(widget, limit: int = 20_000) -> None:
    """Process pending window events, failing rather than hanging."""
    widget.root.update_idletasks()
    for _ in range(limit):
        if not widget.root.tk.dooneevent(_tkinter.ALL_EVENTS | _tkinter.DONT_WAIT):
            widget.root.update_idletasks()
            if not widget.root.tk.dooneevent(_tkinter.ALL_EVENTS | _tkinter.DONT_WAIT):
                return
    raise AssertionError(f"Tk events kept arriving after {limit} were processed")


def wait_for(widget, condition, seconds: float = 5.0) -> None:
    """Run the event loop until ``condition()`` holds (background requests finish on worker threads)."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        widget.root.update()
        if condition():
            return
        time.sleep(0.01)
    raise AssertionError("timed out waiting for the window")


def load(widget) -> None:
    """Read the demo scene, sources, and catalog once, as the loops would. Pending timers are
    cancelled first: a loop called by hand reschedules itself, and an orphaned timer would fire
    into the next test's Tk."""
    wait_for(widget, lambda: widget.pending is None)  # A read already on its way lands first.
    quiet(widget)
    widget.fetch_now()
    wait_for(widget, lambda: widget.pending is None and widget.connection != "CONNECTING")
    quiet(widget)
    widget.poll_sources()
    widget.load_catalog()
    wait_for(widget, lambda: widget.sources_pending is None and widget.catalog_pending is None)
    quiet(widget)
    settle(widget)


def load_detail(widget) -> None:
    """Read the selected goblin's records once."""
    quiet(widget)
    widget.poll_detail()
    wait_for(widget, lambda: widget.detail_pending is None)
    quiet(widget)
    settle(widget)
