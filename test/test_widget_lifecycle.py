"""The widget keeps running through closed windows and failed callbacks.

Alt+F4 hides a window instead of destroying it, `start` brings a running widget forward, every
polling loop reschedules itself after an error, and errors are counted and logged by type and place.
"""

import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import desktop_widget
from desktop_widget import SHOW_REQUEST, GoblinWidget


def loop_widget():
    widget = GoblinWidget.__new__(GoblinWidget)
    widget.closing = False
    widget.root = Mock()
    widget.root.after.return_value = "after-id"
    return widget


class LoopRescheduleTests(unittest.TestCase):
    """Each loop that reschedules at its end used to stop for good after one exception."""

    def test_animate_keeps_its_beat_after_a_failed_frame(self):
        widget = loop_widget()
        widget.animate_step = Mock(side_effect=RuntimeError("bad frame"))
        with self.assertRaises(RuntimeError):  # Tk reports it; the beat goes on.
            widget.animate()
        widget.root.after.assert_called_once_with(360, widget.animate)

    def test_poll_keeps_polling_after_a_failed_fetch(self):
        widget = loop_widget()
        widget.fetch_now = Mock(side_effect=KeyError("root"))
        with self.assertRaises(KeyError):
            widget.poll()
        widget.root.after.assert_called_once_with(3000, widget.poll)

    def test_board_keeps_updating_after_a_failed_refresh(self):
        widget = loop_widget()
        future = Mock()
        future.done.return_value = True
        future.result.return_value = {}
        widget.board_pending = future
        widget.board_after = None
        widget.take_board_scene = Mock()
        widget.launchpad = Mock()
        widget.launchpad.refresh.side_effect = ValueError("bad row")
        with self.assertRaises(ValueError):
            widget.poll_board()
        widget.root.after.assert_called_once_with(1000, widget.poll_board)

    def test_sources_and_catalog_keep_reading_after_a_failed_refresh(self):
        for name, pending, delay in (("poll_sources", "sources_pending", 30_000),
                                     ("load_catalog", "catalog_pending", 60_000)):
            with self.subTest(loop=name):
                widget = loop_widget()
                widget.demo = False
                future = Mock()
                future.done.return_value = True
                future.result.return_value = {}
                setattr(widget, pending, future)
                widget.launchpad = Mock()
                widget.launchpad.refresh.side_effect = ValueError("bad row")
                with self.assertRaises(ValueError):
                    getattr(widget, name)()
                widget.root.after.assert_called_once_with(delay, getattr(widget, name))

    def test_a_closing_widget_schedules_nothing(self):
        widget = loop_widget()
        widget.animate_step = Mock(side_effect=lambda: setattr(widget, "closing", True))
        widget.animate()
        widget.root.after.assert_not_called()


class ErrorReportTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix="goblin-errors-test-")
        self.addCleanup(self.folder.cleanup)
        env = patch.dict(os.environ, {"GOBLIN_HORDE_STATE_DIR": self.folder.name, "LOCALAPPDATA": self.folder.name})
        env.start()
        self.addCleanup(env.stop)

    def failure(self):
        try:
            {"chat": "PRIVATE CHAT TEXT"}["missing"]
        except KeyError as error:
            return type(error), error, error.__traceback__

    def test_errors_are_counted_and_logged_by_type_and_place_only(self):
        widget = GoblinWidget.__new__(GoblinWidget)
        with patch.object(sys, "stderr", None):  # pythonw: no console, so the log file is written.
            widget.report_callback_error(*self.failure())
            widget.report_callback_error(*self.failure())
        self.assertEqual(widget.error_count, 2)
        log = (Path(self.folder.name) / "run" / "widget.log").read_text(encoding="utf-8")
        lines = log.splitlines()
        self.assertEqual(len(lines), 2)
        self.assertIn("widget error #1: KeyError at test_widget_lifecycle.py:", lines[0])
        self.assertIn("in failure", lines[0])
        self.assertNotIn("PRIVATE", log)
        self.assertNotIn("missing", log)

    def test_a_widget_started_by_the_manager_writes_to_its_own_output(self):
        widget = GoblinWidget.__new__(GoblinWidget)
        output = io.StringIO()
        with patch.object(sys, "stderr", output):
            widget.report_callback_error(*self.failure())
        self.assertIn("widget error #1: KeyError", output.getvalue())

    def test_a_failing_loop_is_logged_now_and_then_not_every_beat(self):
        widget = GoblinWidget.__new__(GoblinWidget)
        output = io.StringIO()
        with patch.object(sys, "stderr", output):
            for _ in range(250):
                widget.report_callback_error(*self.failure())
        self.assertEqual(widget.error_count, 250)
        self.assertEqual(len(output.getvalue().splitlines()), desktop_widget.LOGGED_ERRORS + 2)  # Then #100 and #200.

    def test_the_diagnostic_report_includes_the_error_count(self):
        widget = GoblinWidget.__new__(GoblinWidget)
        widget.home_view, widget.display_mode, widget.streams = "launchpad", "overview", {}
        widget.board_connection, widget.board_age, widget.error_count = "LIVE", 2.0, 3
        widget.root = Mock()
        widget.executor = Mock()
        widget.when_done = Mock()
        widget.copy_diagnostics()
        done = widget.when_done.call_args.args[1]
        with patch.object(desktop_widget.messagebox, "showinfo"):
            done({"text": "viewer: ok"}, None)
        copied = widget.root.clipboard_append.call_args.args[0]
        self.assertIn("errors since start: 3", copied)


class ComeForwardTests(unittest.TestCase):
    def test_start_brings_back_the_view_that_was_last_shown(self):
        for mode, thread, expected in (("hidden", "chat", "restore_hidden_party"), ("compact", "chat", "condense_party"),
                                       ("expanded", "chat", "expand_party"), ("overview", "all", "show_overview"),
                                       ("compact", "all", "show_overview")):
            with self.subTest(mode=mode, thread=thread):
                widget = GoblinWidget.__new__(GoblinWidget)
                widget.display_mode, widget.thread_id, widget.demo = mode, thread, False
                for name in ("restore_hidden_party", "condense_party", "expand_party", "show_overview"):
                    setattr(widget, name, Mock())
                widget.come_forward()
                getattr(widget, expected).assert_called_once_with()

    def test_the_request_file_is_used_once(self):
        with tempfile.TemporaryDirectory(prefix="goblin-show-test-") as folder, \
                patch.dict(os.environ, {"GOBLIN_HORDE_STATE_DIR": folder}):
            widget = loop_widget()
            widget.come_forward = Mock()
            request = Path(folder) / "run" / SHOW_REQUEST
            request.parent.mkdir(parents=True)
            request.write_text("now")
            widget.check_show_request()
            widget.check_show_request()
            widget.come_forward.assert_called_once_with()
            self.assertFalse(request.exists())
            self.assertEqual(widget.root.after.call_count, 2, "it keeps checking")


@unittest.skipUnless(sys.platform == "win32", "Desktop widget requires Windows Tk")
class CloseButtonTests(unittest.TestCase):
    """Alt+F4 (WM_DELETE_WINDOW) on the real windows: nothing is destroyed, and `start` brings it back."""

    def setUp(self):
        try:
            from test_party_dock_geometry import quiet, settle
        except ImportError:
            from test.test_party_dock_geometry import quiet, settle
        self.settle = settle
        self.folder = tempfile.TemporaryDirectory(prefix="goblin-close-test-")
        self.addCleanup(self.folder.cleanup)
        env = patch.dict(os.environ, {"LOCALAPPDATA": self.folder.name, "GOBLIN_HORDE_STATE_DIR": self.folder.name})
        env.start()
        self.addCleanup(env.stop)
        self.widget = GoblinWidget("", 43992)  # A port nothing listens on; every network timer is stopped.
        self.addCleanup(self.widget.close)
        quiet(self.widget)
        self.widget.open_viewer = lambda *_args, **_kwargs: None

    def close_button(self, window):
        """What Windows does on Alt+F4: run the window's WM_DELETE_WINDOW handler, or destroy it."""
        handler = window.tk.call("wm", "protocol", window._w, "WM_DELETE_WINDOW")
        self.assertTrue(handler, f"{window} has a close handler")
        window.tk.eval(handler)
        self.settle(self.widget)

    def test_alt_f4_collapses_and_hides_instead_of_destroying_and_start_brings_it_back(self):
        widget = self.widget
        widget.show_launchpad()
        self.settle(widget)
        self.assertEqual(widget.launchpad.window.state(), "normal")

        self.close_button(widget.launchpad.window)
        self.assertTrue(widget.launchpad.window.winfo_exists())
        self.assertEqual(widget.launchpad.window.state(), "withdrawn")
        self.assertEqual((widget.display_mode, widget.party_dock.mode), ("hidden", "hidden"))
        self.assertEqual(widget.party_dock.window.state(), "normal", "the tab is shown")

        self.close_button(widget.party_dock.window)  # Alt+F4 on the tab.
        self.assertTrue(widget.party_dock.window.winfo_exists())
        self.assertEqual(widget.party_dock.window.state(), "withdrawn")
        widget.launchpad.refresh(force=True)  # Callbacks still work on the hidden windows.

        request = Path(self.folder.name) / "run" / SHOW_REQUEST
        request.parent.mkdir(parents=True, exist_ok=True)
        request.write_text("now")
        widget.check_show_request()
        self.settle(widget)
        self.assertEqual(widget.display_mode, "overview")
        self.assertEqual(widget.launchpad.window.state(), "normal")
        self.assertFalse(request.exists())

    def test_alt_f4_on_the_goblin_line_the_roster_and_the_notes_hides_them(self):
        widget = self.widget
        widget.set_home_view("line")
        widget.show_overview()
        self.settle(widget)
        self.close_button(widget.root)
        self.assertTrue(widget.root.winfo_exists())
        self.assertEqual(widget.display_mode, "hidden")

        widget.thread_id = "chat"
        widget.condense_party()
        self.settle(widget)
        self.assertEqual(widget.party_dock.mode, "compact")
        self.close_button(widget.party_dock.window)
        self.assertEqual((widget.display_mode, widget.party_dock.mode), ("hidden", "hidden"))

        widget.show_notes()
        self.settle(widget)
        self.close_button(widget.notes_panel.window)
        self.assertTrue(widget.notes_panel.window.winfo_exists())
        self.assertFalse(widget.notes_panel.shown)

    def test_a_failing_callback_is_counted_and_the_widget_keeps_running(self):
        widget = self.widget
        with patch.object(sys, "stderr", None):
            widget.root.after(0, lambda: 1 / 0)
            self.settle(widget)
        self.assertEqual(widget.error_count, 1)
        log = (Path(self.folder.name) / "run" / "widget.log").read_text(encoding="utf-8")
        self.assertIn("ZeroDivisionError", log)
        self.assertTrue(widget.root.winfo_exists())


if __name__ == "__main__":
    unittest.main()
