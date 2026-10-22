"""Watching a chat shows at once but follows the server; joining and separating parties go to the server."""

import unittest
from concurrent.futures import Future
from unittest.mock import Mock

from desktop_widget import GoblinWidget


def watching_widget():
    widget = GoblinWidget.__new__(GoblinWidget)
    widget.demo = False
    widget.closing = False
    widget.watched_ids = ["chat-a"]
    widget.watch_pending = None
    widget.refresh = Mock()
    widget.fetch_now = Mock()
    widget.root = Mock()
    widget.api = Mock()
    widget.executor = Mock()
    return widget


class WatchToggleTests(unittest.TestCase):
    def settle(self, widget):
        # Run the scheduled check the way Tk would, once the request has finished.
        callback = widget.root.after.call_args.args[1]
        callback()

    def test_watching_shows_at_once_and_keeps_what_the_server_saved(self):
        widget = watching_widget()
        future = Future()
        widget.executor.submit.return_value = future
        widget.set_watched("chat-b", True)
        widget.executor.submit.assert_called_once_with(widget.api.watch, "chat-b", True)
        self.assertEqual(widget.watched_ids, ["chat-b", "chat-a"])
        widget.refresh.assert_called_once_with()
        # A poll that lands before the server answers does not undo the change on screen.
        widget.take_watched(["chat-a"])
        self.assertEqual(widget.watched_ids, ["chat-b", "chat-a"])
        future.set_result(["chat-b", "chat-a"])
        self.settle(widget)
        self.assertEqual(widget.watched_ids, ["chat-b", "chat-a"])
        self.assertIsNone(widget.watch_pending)
        widget.fetch_now.assert_called_once_with()

    def test_an_older_answer_never_overrides_a_newer_change(self):
        widget = watching_widget()
        first, second = Future(), Future()
        widget.executor.submit.side_effect = [first, second]
        widget.set_watched("chat-b", True)
        settle_first = widget.root.after.call_args.args[1]
        widget.set_watched("chat-c", True)
        settle_second = widget.root.after.call_args.args[1]
        second.set_result(["chat-c", "chat-b", "chat-a"])
        settle_second()
        first.set_result(["chat-b", "chat-a"])  # Arrives last, but describes an older state.
        settle_first()
        self.assertEqual(widget.watched_ids, ["chat-c", "chat-b", "chat-a"])

    def test_a_change_the_server_refused_is_taken_back(self):
        widget = watching_widget()
        future = Future()
        widget.executor.submit.return_value = future
        widget.set_watched("chat-a", False)
        self.assertEqual(widget.watched_ids, [])
        future.set_exception(OSError("viewer stopped"))
        self.settle(widget)
        self.assertEqual(widget.watched_ids, ["chat-a"])

    def test_the_all_parties_entry_cannot_be_watched(self):
        widget = watching_widget()
        widget.set_watched("all", True)
        widget.set_watched("", True)
        widget.executor.submit.assert_not_called()
        self.assertEqual(widget.watched_ids, ["chat-a"])


class JoinedPartyTests(unittest.TestCase):
    def test_join_choices_go_to_the_server_and_refresh_the_roster(self):
        widget = GoblinWidget.__new__(GoblinWidget)
        widget.closing = False
        widget.root = Mock()
        widget.fetch_now = Mock()
        widget.manual_links = {}
        future = Future()
        widget.api = Mock()
        widget.executor = Mock(submit=Mock(return_value=future))
        widget.set_join("orca:wt1", "")
        widget.executor.submit.assert_called_once_with(widget.api.join, "orca:wt1", "")
        future.set_result({"manualLinks": {"orca:wt1": ""}})
        widget.root.after.call_args.args[1]()
        self.assertEqual(widget.manual_links, {"orca:wt1": ""})
        widget.fetch_now.assert_called_once_with()

    def test_the_newest_codex_chats_are_offered_to_join(self):
        widget = GoblinWidget.__new__(GoblinWidget)
        widget.source_catalog = [{"id": "orca:ws", "source": "orca", "updatedAt": 9},
                                 {"id": "chat-old", "source": "codex", "updatedAt": 1, "name": "Old"},
                                 {"id": "chat-new", "source": "codex", "updatedAt": 5, "name": "New"}]
        self.assertEqual([chat["id"] for chat in widget.recent_chats(5)], ["chat-new", "chat-old"])
        self.assertEqual(widget.source_label_for("chat-new"), "New")
        self.assertEqual(widget.source_label_for("gone"), "gone")


if __name__ == "__main__":
    unittest.main()
