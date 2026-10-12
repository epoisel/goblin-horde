"""Saved settings survive bad values and crashes, and goblins pick their tribe from the model."""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import desktop_widget
from desktop_widget import GoblinWidget, TRIBES, model_badge, style_for, tribe_for, write_settings
from goblin_parting import PartingNotes, RetirementTracker


def bare_widget():
    widget = GoblinWidget.__new__(GoblinWidget)
    widget.notes = PartingNotes()
    widget.retirement = RetirementTracker()
    widget.columns = 2
    widget.rotating = True
    widget.hidden_ids = set()
    widget.palette_offset = 0
    widget.saved_streams = []
    widget.dismissed = {}
    widget.placements = {}
    widget.aliases = {}
    widget.party_mode = False
    widget.display_mode = "overview"
    widget.party_view = "expanded"
    widget.hidden_from = "expanded"
    widget.dock_x = widget.dock_y = None
    widget.home_view = "launchpad"
    widget.reduced_motion_choice = None
    widget.focused_stream_id = ""
    widget.explicit_thread = False
    widget.thread_id = "all"
    widget.source_name = "Recent activity"
    return widget


class SettingsFileTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.file = Path(self.folder.name) / "goblins.json"
        patcher = patch.object(desktop_widget, "state_file", return_value=self.file)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_one_bad_value_keeps_every_other_setting(self):
        self.file.write_text(json.dumps({
            "dockX": "not a number", "columns": 3, "threadId": "thread-123", "sourceName": "Lantern",
            "displayMode": "compact", "homeView": "line", "reducedMotion": True,
            "aliases": {"a": "Scout"},
        }), encoding="utf-8")
        widget = bare_widget()
        widget.load_settings()
        self.assertEqual(widget.columns, 3)
        self.assertEqual(widget.thread_id, "thread-123")
        self.assertEqual(widget.source_name, "Lantern")
        self.assertEqual(widget.display_mode, "compact")
        self.assertEqual(widget.home_view, "line")
        self.assertIs(widget.reduced_motion_choice, True)
        self.assertEqual(widget.aliases, {"a": "Scout"})
        self.assertIsNone(widget.dock_x)

    def test_all_parties_never_restores_a_party_view(self):
        self.file.write_text(json.dumps({"threadId": "all", "displayMode": "expanded", "partyMode": True}),
                             encoding="utf-8")
        widget = bare_widget()
        widget.load_settings()
        self.assertEqual(widget.display_mode, "overview")
        self.assertFalse(widget.party_mode)
        self.assertEqual(widget.source_name, "Recent activity")

    def test_an_unreadable_file_is_set_aside_not_lost(self):
        self.file.write_text('{"partingNotes": [', encoding="utf-8")
        widget = bare_widget()
        widget.load_settings()
        aside = self.file.with_name("goblins.json.unreadable")
        self.assertEqual(aside.read_text(encoding="utf-8"), '{"partingNotes": [')
        # A second bad file never overwrites the first one set aside.
        self.file.write_text("also broken", encoding="utf-8")
        widget.load_settings()
        self.assertEqual(aside.read_text(encoding="utf-8"), '{"partingNotes": [')

    def test_settings_are_replaced_whole(self):
        write_settings(self.file, '{"columns": 2}')
        write_settings(self.file, '{"columns": 3}')
        self.assertEqual(json.loads(self.file.read_text(encoding="utf-8")), {"columns": 3})
        self.assertEqual([path.name for path in Path(self.folder.name).iterdir()], ["goblins.json"])

    def test_a_failed_write_leaves_the_old_file_and_no_temporary(self):
        write_settings(self.file, '{"columns": 2}')
        with patch.object(desktop_widget.os, "replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                write_settings(self.file, '{"columns": 3}')
        self.assertEqual(json.loads(self.file.read_text(encoding="utf-8")), {"columns": 2})
        self.assertEqual(len(os.listdir(self.folder.name)), 1)


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
        layers = desktop_widget.ART["layers"]
        for name, outfits in TRIBES.items():
            for outfit in outfits:
                with self.subTest(tribe=name, outfit=outfit["name"]):
                    self.assertIn(outfit["body"], layers)
                    self.assertIn(outfit["arm"], layers)
                    self.assertIn(f"gear.{outfit['gear']}", layers)
                    self.assertEqual(len(layers[outfit["body"]]["rows"]), 16)

    def test_a_party_lists_each_model_once_lead_first_then_the_catalog(self):
        from party_layout import launchpad_board, party_models
        opus = {"label": "Opus 5.5", "family": "claude"}
        haiku = {"label": "Haiku 5.5", "family": "claude"}
        members = [{"id": "lead", "model": opus}, {"id": "helper", "model": haiku}, {"id": "other", "model": opus},
                   {"id": "quiet"}]
        self.assertEqual(party_models(members), (opus, haiku))
        self.assertEqual(party_models([], {"model": haiku}), (haiku,))
        self.assertEqual(party_models([{"model": "bad"}], None), ())
        catalog = [{"id": "chat-1", "name": "Shop", "updatedAt": 1_800_000_000_000, "model": opus}]
        _active, recent, _older = launchpad_board([], catalog, now_ms=1_800_000_060_000)
        self.assertEqual(recent[0].models, (opus,))

    def test_model_badges(self):
        actor = {"model": {"label": "GPT-5.6 Sol", "effort": "xhigh"}}
        self.assertEqual(model_badge(actor), "GPT-5.6 SOL")
        self.assertEqual(model_badge(actor, with_effort=True), "GPT-5.6 SOL · XHIGH")
        self.assertEqual(model_badge({"model": None}), "")
        self.assertEqual(model_badge({}), "")


if __name__ == "__main__":
    unittest.main()
