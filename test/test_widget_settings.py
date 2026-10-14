"""Saved settings survive bad values, crashes, and older widgets; goblins pick their tribe from the model."""

import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import desktop_widget
from desktop_widget import GoblinWidget, read_saved_settings, write_settings
from goblin_sprite import ART, TRIBES, style_for, tribe_for
from horde_model import read_settings


def bare_widget(raw: dict) -> GoblinWidget:
    """A widget with only what save_settings reads, as if it had loaded ``raw``."""
    widget = GoblinWidget.__new__(GoblinWidget)
    widget.raw_settings = raw
    widget.settings = read_settings(raw)
    widget.surface, widget.show_strip_pref, widget.keep_on_top = "strip", True, False
    widget.reduced_motion_choice, widget.done_open, widget.welcomed = None, True, True
    widget.aliases, widget.palette_offset = {"chat-1": "Scout"}, 2
    widget.geometry = {"x": -1200, "y": 40, "width": 1100, "height": 700, "zoomed": False}
    widget.strip = SimpleNamespace(anchor=(1900, 1040))
    widget.demo, widget.selected, widget.chosen = False, "orca-agent:p1", True
    widget.save_after = None
    return widget


class SettingsFileTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.file = Path(self.folder.name) / "goblins.json"
        patcher = patch.object(desktop_widget, "state_file", return_value=self.file)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_saving_keeps_unknown_keys_and_drops_the_old_views(self):
        old = {"columns": 3, "streams": [{"id": "s"}], "partingNotes": [{"id": "n"}], "dockX": 5,
               "fromANewerWidget": {"keep": True}, "window": {"x": 1, "y": 2, "width": 900, "height": 600}}
        widget = bare_widget(old)
        widget.save_settings()
        saved = json.loads(self.file.read_text(encoding="utf-8"))
        self.assertEqual(saved["fromANewerWidget"], {"keep": True})
        for retired in ("columns", "streams", "partingNotes", "dockX"):
            self.assertNotIn(retired, saved)
        self.assertEqual(saved["window"], {"x": -1200, "y": 40, "width": 1100, "height": 700, "zoomed": False})
        self.assertEqual(saved["strip"], {"right": 1900, "bottom": 1040})
        self.assertEqual((saved["surface"], saved["showStrip"], saved["doneOpen"]), ("strip", True, True))
        self.assertEqual(saved["selected"], "orca-agent:p1")
        self.assertEqual(saved["aliases"], {"chat-1": "Scout"})
        again = read_settings(saved)
        self.assertEqual(again["window"]["x"], -1200, "a display left of the primary is kept")
        self.assertEqual(again["strip"], {"right": 1900, "bottom": 1040})

    def test_the_demo_never_saves_its_invented_selection(self):
        widget = bare_widget({})
        widget.demo = True
        widget.save_settings()
        self.assertNotIn("selected", json.loads(self.file.read_text(encoding="utf-8")))

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
        write_settings(self.file, '{"surface": "window"}')
        write_settings(self.file, '{"surface": "strip"}')
        self.assertEqual(json.loads(self.file.read_text(encoding="utf-8")), {"surface": "strip"})
        self.assertEqual([path.name for path in Path(self.folder.name).iterdir()], ["goblins.json"])

    def test_a_failed_write_leaves_the_old_file_and_no_temporary(self):
        write_settings(self.file, '{"surface": "window"}')
        with patch.object(desktop_widget.os, "replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                write_settings(self.file, '{"surface": "strip"}')
        self.assertEqual(json.loads(self.file.read_text(encoding="utf-8")), {"surface": "window"})
        self.assertEqual(len(os.listdir(self.folder.name)), 1)

    def test_a_failed_save_is_quiet(self):
        widget = bare_widget({})
        with patch.object(desktop_widget, "write_settings", side_effect=OSError("read-only")):
            widget.save_settings()  # Nothing raised; the next save tries again.
        self.assertEqual(widget.raw_settings, {})


class TribeTests(unittest.TestCase):
    def test_the_model_family_picks_the_tribe_before_the_source(self):
        self.assertEqual(tribe_for({"source": "codex", "model": {"family": "openai"}}), "sapper")
        self.assertEqual(tribe_for({"source": "claude", "model": {"family": "claude"}}), "shaman")
        # A feed or Orca agent running a Claude model is a hexer too.
        self.assertEqual(tribe_for({"source": "extension", "model": {"family": "claude"}}), "shaman")
        self.assertEqual(tribe_for({"source": "codex"}), "sapper")
        self.assertEqual(tribe_for({"source": "orca"}), "raider")
        self.assertEqual(tribe_for({"source": "extension", "model": {"family": "other"}}), "raider")
        self.assertEqual(tribe_for({"model": "not a dict"}), "raider")

    def test_outfits_stay_within_the_tribe_and_are_stable(self):
        actor = {"id": "thread-1", "source": "claude"}
        style = style_for(actor)
        self.assertEqual(style["tribe"], "shaman")
        self.assertIs(style_for(actor), style)
        self.assertIn(style_for(actor, 1), TRIBES["shaman"])
        self.assertNotEqual(style_for(actor, 1)["name"], style["name"])

    def test_every_tribe_has_a_body_arm_and_gear_in_the_art(self):
        layers = ART["layers"]
        for name, outfits in TRIBES.items():
            for outfit in outfits:
                with self.subTest(tribe=name, outfit=outfit["name"]):
                    self.assertIn(outfit["body"], layers)
                    self.assertIn(outfit["arm"], layers)
                    self.assertIn(f"gear.{outfit['gear']}", layers)
                    self.assertEqual(len(layers[outfit["body"]]["rows"]), 16)


if __name__ == "__main__":
    unittest.main()
