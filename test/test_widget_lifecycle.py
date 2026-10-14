"""The app keeps running through closed windows and failed callbacks.

The window's X collapses to the goblin strip instead of quitting, `start` brings a running widget
forward, every polling loop reschedules itself after an error, and errors are counted and logged by
type and place only.
"""

import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import desktop_widget
from desktop_widget import BEAT_MS, CATALOG_MS, DETAIL_MS, SCENE_MS, SHOW_REQUEST, SOURCES_MS, GoblinWidget

try:
    from widget_fixtures import isolate, load, quiet, settle
except ImportError:
    from test.widget_fixtures import isolate, load, quiet, settle


def loop_widget():
    widget = GoblinWidget.__new__(GoblinWidget)
    widget.closing = False
    widget.root = Mock()
    widget.root.after.return_value = "after-id"
    return widget


class LoopRescheduleTests(unittest.TestCase):
    """Each loop that reschedules at its end must not stop for good after one exception."""

    def test_animate_keeps_its_beat_after_a_failed_frame(self):
        widget = loop_widget()
        widget.animate_step = Mock(side_effect=RuntimeError("bad frame"))
        with self.assertRaises(RuntimeError):  # Tk reports it; the beat goes on.
            widget.animate()
        widget.root.after.assert_called_once_with(BEAT_MS, widget.animate)

    def test_poll_keeps_polling_after_a_failed_fetch(self):
        widget = loop_widget()
        widget.fetch_now = Mock(side_effect=KeyError("root"))
        with self.assertRaises(KeyError):
            widget.poll()
        widget.root.after.assert_called_once_with(SCENE_MS, widget.poll)

    def test_detail_and_timers_keep_running_after_a_failure(self):
        widget = loop_widget()
        widget.detail_target = Mock(side_effect=ValueError("bad row"))
        with self.assertRaises(ValueError):
            widget.poll_detail()
        widget.root.after.assert_called_once_with(DETAIL_MS, widget.poll_detail)
        widget = loop_widget()
        widget.window_visible = Mock(return_value=True)
        widget.detail_view = Mock()
        widget.detail_view.tick.side_effect = ValueError("bad timer")
        with self.assertRaises(ValueError):
            widget.tick()
        widget.root.after.assert_called_once_with(desktop_widget.TICK_MS, widget.tick)

    def test_sources_and_catalog_keep_reading_after_a_failed_refresh(self):
        for name, pending, delay in (("poll_sources", "sources_pending", SOURCES_MS),
                                     ("load_catalog", "catalog_pending", CATALOG_MS)):
            with self.subTest(loop=name):
                widget = loop_widget()
                widget.results = None
                widget.source_catalog = []
                future = Mock()
                future.done.return_value = True
                future.result.return_value = {}
                setattr(widget, pending, future)
                widget.refresh = Mock(side_effect=ValueError("bad row"))
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
        widget.surface, widget.actors, widget.connection = "window", [{"id": "a"}], "LIVE"
        widget.board_age, widget.error_count, widget.detail_route = 2.0, 3, None
        widget.root = Mock()
        widget.root.state.return_value = "normal"
        widget.api = Mock()
        widget.executor = Mock()
        widget.when_done = Mock()
        widget.copy_diagnostics()
        widget.executor.submit.assert_called_once_with(widget.api.diagnostics)
        done = widget.when_done.call_args.args[1]
        with patch.object(desktop_widget.messagebox, "showinfo"):
            done({"text": "viewer: ok"}, None)
        copied = widget.root.clipboard_append.call_args.args[0]
        self.assertIn("errors since start: 3", copied)
        self.assertIn("1 goblins", copied)
        self.assertNotIn("PRIVATE", copied)


class ComeForwardTests(unittest.TestCase):
    def test_start_opens_the_window(self):
        widget = GoblinWidget.__new__(GoblinWidget)
        widget.open_window = Mock()
        widget.come_forward()
        widget.open_window.assert_called_once_with()

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


class RestartTests(unittest.TestCase):
    def test_only_an_installed_copy_started_by_its_manager_offers_a_restart(self):
        widget = GoblinWidget.__new__(GoblinWidget)
        widget.demo = False
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {"GOBLIN_HORDE_STATE_DIR": folder}), \
                patch.object(desktop_widget, "HERE", Path(folder)), patch.object(desktop_widget.shutil, "which",
                                                                                  return_value="node"):
            self.assertFalse(widget.restart_possible(), "a source checkout has no install marker")
            (Path(folder) / "goblin-horde-install.json").write_text("{}")
            (Path(folder) / "goblin.mjs").write_text("")
            self.assertTrue(widget.restart_possible())
            widget.demo = True
            self.assertFalse(widget.restart_possible())
        with patch.dict(os.environ, {"GOBLIN_HORDE_STATE_DIR": ""}):
            widget.demo = False
            self.assertFalse(widget.restart_possible(), "never against the default (live) state folder")


@unittest.skipUnless(sys.platform == "win32", "Builds the real window with Windows Tk")
class CloseButtonTests(unittest.TestCase):
    """The window's X (WM_DELETE_WINDOW) on the real window: it collapses, and `start` brings it back."""

    def setUp(self):
        self.folder = isolate(self)
        self.widget = GoblinWidget("", 44190, demo=True)
        self.addCleanup(self.widget.close)
        quiet(self.widget)
        load(self.widget)

    def close_button(self, window):
        """What Windows does on the X or Alt+F4: run the window's WM_DELETE_WINDOW handler."""
        handler = window.tk.call("wm", "protocol", window._w, "WM_DELETE_WINDOW")
        self.assertTrue(handler, f"{window} has a close handler")
        window.tk.eval(handler)
        settle(self.widget)

    def test_the_x_collapses_to_the_strip_and_start_brings_the_window_back(self):
        widget = self.widget
        self.assertEqual(widget.root.state(), "normal")
        self.close_button(widget.root)
        self.assertTrue(widget.root.winfo_exists())
        self.assertEqual(widget.root.state(), "withdrawn")
        self.assertEqual(widget.surface, "strip")
        self.assertEqual(widget.strip.window.state(), "normal", "the goblins stay on the desktop")
        self.close_button(widget.strip.window)  # Alt+F4 on the strip leaves it be.
        self.assertEqual(widget.strip.window.state(), "normal")
        request = Path(self.folder) / "run" / SHOW_REQUEST
        request.parent.mkdir(parents=True, exist_ok=True)
        request.write_text("now")
        widget.check_show_request()
        quiet(widget)
        settle(widget)
        self.assertEqual(widget.root.state(), "normal")
        self.assertEqual(widget.surface, "window")
        self.assertEqual(widget.strip.window.state(), "withdrawn", "the strip hides unless asked to stay")
        self.assertFalse(request.exists())

    def test_the_first_x_says_where_goblin_horde_went_once(self):
        widget = self.widget
        self.assertFalse(widget.strip_hinted)
        self.close_button(widget.root)
        self.assertTrue(widget.strip_hinted)
        widget.show_strip_hint()
        self.assertEqual(widget.tooltip.label.cget("text"), desktop_widget.STRIP_HINT)
        self.assertIn("Quit is in the ⋯ menu", desktop_widget.STRIP_HINT)
        # True whether the strip shows goblins or only its "all quiet" label: a click anywhere on it opens the window.
        self.assertIn("Click the strip to open the window again", desktop_widget.STRIP_HINT)
        self.assertNotIn("Click a goblin", desktop_widget.STRIP_HINT)
        widget.hide_strip_hint()
        self.assertEqual(widget.tooltip.window.state(), "withdrawn")
        saved = json.loads((Path(self.folder) / "goblins.json").read_text(encoding="utf-8"))
        self.assertIs(saved["stripHinted"], True, "remembered, so it is said only the first time")
        opened = []
        widget.open_window = lambda select=None: opened.append(select)
        strip = widget.strip
        strip.slots = [(10, 60, "pill", "")]
        strip.on_press(SimpleNamespace(x_root=0, y_root=0))
        strip.on_release(SimpleNamespace(x=200, y=10))  # Past the pill: nothing there but the strip itself.
        self.assertEqual(opened, [None])

    def test_starting_again_after_the_x_opens_the_window_not_the_strip(self):
        widget = self.widget
        self.close_button(widget.root)
        widget.close()
        saved = json.loads((Path(self.folder) / "goblins.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["surface"], "strip", "closed to the strip")
        again = GoblinWidget("", 44190, demo=True)
        self.addCleanup(again.close)
        quiet(again)
        settle(again)
        self.assertEqual(again.root.state(), "normal", "the Start menu or `start` opens the window")
        self.assertEqual(again.surface, "window")

    def test_a_failing_callback_is_counted_and_the_widget_keeps_running(self):
        widget = self.widget
        with patch.object(sys, "stderr", None):
            widget.root.after(0, lambda: 1 / 0)
            settle(widget)
        self.assertEqual(widget.error_count, 1)
        log = (Path(self.folder) / "run" / "widget.log").read_text(encoding="utf-8")
        self.assertIn("ZeroDivisionError", log)
        self.assertTrue(widget.root.winfo_exists())


if __name__ == "__main__":
    unittest.main()
