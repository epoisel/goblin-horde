"""Saved settings survive bad values, crashes, and the files of older widgets."""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import desktop_widget
from desktop_widget import GoblinWidget, read_saved_settings, read_settings, write_settings

DEFAULTS = {"reducedMotion": None, "scaleWithDisplay": True, "petScreen": 0}


def bare_widget(raw: dict) -> GoblinWidget:
    """A widget with only what save_settings reads, as if it had loaded ``raw`` and the player had then
    turned reduced motion on and moved the horde to the second display."""
    widget = GoblinWidget.__new__(GoblinWidget)
    widget.raw_settings = raw
    widget.settings = read_settings(raw)
    widget.reduced_motion_choice, widget.pet_screen = True, 1
    return widget


class SettingsFileTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.file = Path(self.folder.name) / "goblins.json"
        patcher = patch.object(desktop_widget, "state_file", return_value=self.file)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_saving_keeps_every_key_it_does_not_read(self):
        old = {"surface": "strip", "window": {"x": 1, "y": 2, "width": 900, "height": 600}, "aliases": {"a": "Scout"},
               "columns": 3, "fromANewerWidget": {"keep": True}, "reducedMotion": "yes", "petScreen": 0}
        widget = bare_widget(old)
        widget.save_settings()
        saved = json.loads(self.file.read_text(encoding="utf-8"))
        self.assertEqual(saved, {**old, "reducedMotion": True, "scaleWithDisplay": True, "petScreen": 1},
                         "an older widget's settings and a newer one's survive, beside the game's own")
        self.assertEqual(read_settings(saved), {"reducedMotion": True, "scaleWithDisplay": True, "petScreen": 1})

    def test_an_unreadable_file_is_set_aside_not_lost(self):
        self.file.write_text('{"window": [', encoding="utf-8")
        self.assertEqual(read_saved_settings(), {})
        aside = self.file.with_name("goblins.json.unreadable")
        self.assertEqual(aside.read_text(encoding="utf-8"), '{"window": [')
        # A second bad file never overwrites the first one set aside.
        self.file.write_text("also broken", encoding="utf-8")
        read_saved_settings()
        self.assertEqual(aside.read_text(encoding="utf-8"), '{"window": [')

    def test_a_file_that_is_not_utf8_or_not_an_object_still_starts(self):
        self.file.write_bytes(b'{"surface": "strip", "name": "caf\xe9"}')
        self.assertEqual(read_saved_settings(), {})
        self.assertEqual(self.file.with_name("goblins.json.unreadable").read_bytes()[:12], b'{"surface": ')
        self.file.write_text("[1, 2]", encoding="utf-8")
        self.assertEqual(read_saved_settings(), {})

    def test_settings_are_replaced_whole(self):
        write_settings(self.file, '{"petScreen": 0}')
        write_settings(self.file, '{"petScreen": 1}')
        self.assertEqual(json.loads(self.file.read_text(encoding="utf-8")), {"petScreen": 1})
        self.assertEqual([path.name for path in Path(self.folder.name).iterdir()], ["goblins.json"])

    def test_a_failed_write_leaves_the_old_file_and_no_temporary(self):
        write_settings(self.file, '{"petScreen": 0}')
        with patch.object(desktop_widget.os, "replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                write_settings(self.file, '{"petScreen": 1}')
        self.assertEqual(json.loads(self.file.read_text(encoding="utf-8")), {"petScreen": 0})
        self.assertEqual(len(os.listdir(self.folder.name)), 1)

    def test_a_failed_save_is_quiet(self):
        widget = bare_widget({})
        with patch.object(desktop_widget, "write_settings", side_effect=OSError("read-only")):
            widget.save_settings()  # Nothing raised; the next save tries again.
        self.assertEqual(widget.raw_settings, {})


class ReadSettingsTests(unittest.TestCase):
    def test_one_bad_value_keeps_every_other_setting(self):
        self.assertEqual(read_settings({"reducedMotion": "yes", "scaleWithDisplay": False, "petScreen": 2}),
                         {"reducedMotion": None, "scaleWithDisplay": False, "petScreen": 2})
        self.assertEqual(read_settings({"reducedMotion": False, "scaleWithDisplay": 0, "petScreen": "2"}),
                         {"reducedMotion": False, "scaleWithDisplay": True, "petScreen": 0})
        self.assertEqual(read_settings("not a dict"), DEFAULTS)

    def test_the_chosen_screen_is_read_back_when_it_is_a_small_whole_number(self):
        self.assertEqual(read_settings({"petScreen": 2})["petScreen"], 2)
        for bad in (-1, 65, "1", True, None):
            self.assertEqual(read_settings({"petScreen": bad})["petScreen"], 0, bad)

    def test_an_older_widgets_file_loads_with_the_defaults(self):
        old = {"x": 5, "y": 6, "columns": 3, "displayMode": "hidden", "surface": "pets", "keepOnTop": True,
               "aliases": {"a": "Scout"}, "paletteOffset": 2}
        self.assertEqual(read_settings(old), DEFAULTS)


if __name__ == "__main__":
    unittest.main()
