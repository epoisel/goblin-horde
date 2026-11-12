"""Failed callbacks never stop the app: they are counted, and logged by type and place only."""

import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import desktop_widget
from desktop_widget import GoblinWidget


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


if __name__ == "__main__":
    unittest.main()
