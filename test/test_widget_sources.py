"""The launchpad names every feed with a one-click fix, and says when its list is old."""

import unittest
from unittest.mock import Mock

from desktop_widget import GoblinWidget, Launchpad


class FreshnessTests(unittest.TestCase):
    def test_the_board_remembers_how_old_the_served_scene_was(self):
        widget = GoblinWidget.__new__(GoblinWidget)
        widget.watch_pending = None
        widget.watched_ids = []
        widget.take_board_scene({"agents": [], "checkedAt": 1_000_000, "servedAt": 1_045_000, "watched": ["chat-a"]})
        self.assertEqual(widget.board_age, 45.0)
        self.assertEqual(widget.watched_ids, ["chat-a"])
        widget.take_board_scene({"agents": []})
        self.assertEqual(widget.board_age, 0.0)

    def test_an_old_scene_says_how_old_instead_of_live(self):
        pad = Launchpad.__new__(Launchpad)
        pad.searching = False
        pad.owner = Mock(paused=False, board_age=45.0)
        self.assertTrue(pad.status_line([], [], 0, "LIVE").startswith("UPDATED 45s AGO"))
        pad.owner.board_age = 3.0
        self.assertTrue(pad.status_line([], [], 0, "LIVE").startswith("LIVE"))


class SourcesRowTests(unittest.TestCase):
    def draw(self, sources):
        pad = Launchpad.__new__(Launchpad)
        pad.owner = Mock(sources=sources)
        pad.body = Mock()
        pad.hitboxes = []
        pad.tag_font = Mock(measure=lambda text: 6 * len(text))
        bottom = pad.draw_sources(4, 420)
        return pad, bottom

    def test_each_feed_is_named_and_broken_ones_offer_their_fix(self):
        pad, bottom = self.draw({
            "codex": {"state": "unavailable", "detail": "Codex stopped."},
            "claude": {"state": "not-connected", "detail": "Not connected.", "canConnect": True, "replies": False},
            "orca": {"state": "ok", "detail": "Reading Orca workspaces.", "replies": False},
            "extensions": {"state": "none", "detail": "No extension feeds yet."},
        })
        self.assertEqual(bottom, 28)
        labels = [call.kwargs["text"] for call in pad.body.create_text.call_args_list]
        self.assertEqual(labels, ["CODEX ✕ FIX", "CLAUDE – CONNECT", "ORCA ✓", "FEEDS –"])
        codex, claude, orca, _feeds = pad.hitboxes
        codex[4]()
        pad.owner.reconnect_codex.assert_called_once_with()
        claude[4]()
        pad.owner.connect_claude.assert_called_once_with()
        self.assertIn("reply in the app itself", orca[5])

    def test_an_optional_feed_not_in_use_is_neutral_not_an_error(self):
        pad, _ = self.draw({"claude": {"state": "not-connected", "detail": "Not connected.", "canConnect": False},
                            "orca": {"state": "unavailable", "detail": "Orca is not answering."}})
        self.assertEqual([call.kwargs["text"] for call in pad.body.create_text.call_args_list], ["CLAUDE –", "ORCA –"])
        pad.hitboxes[0][4]()
        pad.owner.connect_claude.assert_not_called()

    def test_codex_not_installed_is_neutral_with_no_fix(self):
        detail = "Optional: install the Codex CLI to see Codex chats."
        pad, _ = self.draw({"codex": {"state": "not-installed", "detail": detail, "replies": True}})
        self.assertEqual([call.kwargs["text"] for call in pad.body.create_text.call_args_list], ["CODEX –"])
        pad.hitboxes[0][4]()
        pad.owner.reconnect_codex.assert_not_called()
        self.assertEqual(pad.hitboxes[0][5], detail)

    def test_no_row_until_the_viewer_has_said_what_it_sees(self):
        pad, bottom = self.draw({})
        self.assertEqual(bottom, 4)
        pad.body.create_text.assert_not_called()


if __name__ == "__main__":
    unittest.main()
