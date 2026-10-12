"""Watched parties get their own launchpad rows, and the toggle shows at once but follows the server."""

import unittest
from concurrent.futures import Future
from unittest.mock import Mock

from desktop_widget import GoblinWidget
from party_layout import launchpad_board, watched_cards

NOW = 1_800_000_000_000
catalog = [
    {"id": "chat-new", "name": "New chat", "updatedAt": NOW - 60_000},
    {"id": "chat-old", "name": "Old chat", "updatedAt": NOW - 30 * 86_400_000},
    {"id": "chat-busy", "name": "Busy chat", "updatedAt": NOW - 1000},
]
busy = {"id": "chat-busy", "status": "active", "attention": "working",
        "activities": [{"kind": "command", "title": "Ran checks", "status": "inProgress"}]}


class WatchedRowsTests(unittest.TestCase):
    def test_watched_parties_leave_recent_and_search_and_get_their_own_rows(self):
        active, recent, older = launchpad_board([busy], catalog, now_ms=NOW, watched=["chat-old", "chat-busy"])
        self.assertEqual([card.id for card in active], ["chat-busy"])
        self.assertEqual([card.id for card in recent], ["chat-new"])
        self.assertEqual(older, 0)
        # A watched party that is working stays in the working rows; the rest are listed in watch order.
        rows = watched_cards([busy], catalog, ["chat-old", "chat-busy"], {card.id for card in active})
        self.assertEqual([card.id for card in rows], ["chat-old"])
        self.assertEqual(rows[0].name, "Old chat")

    def test_a_watched_party_no_longer_listed_anywhere_has_no_row(self):
        self.assertEqual(watched_cards([], catalog, ["gone-chat-id"]), [])


def watching_widget():
    widget = GoblinWidget.__new__(GoblinWidget)
    widget.demo = False
    widget.closing = False
    widget.watched_ids = ["chat-a"]
    widget.watch_pending = None
    widget.launchpad = Mock()
    widget.kick_board = Mock()
    widget.root = Mock()
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
        self.assertEqual(widget.watched_ids, ["chat-b", "chat-a"])
        # A poll that lands before the server answers does not undo the change on screen.
        widget.take_watched(["chat-a"])
        self.assertEqual(widget.watched_ids, ["chat-b", "chat-a"])
        future.set_result(["chat-b", "chat-a"])
        self.settle(widget)
        self.assertEqual(widget.watched_ids, ["chat-b", "chat-a"])
        self.assertIsNone(widget.watch_pending)
        widget.kick_board.assert_called_once_with()

    def test_a_change_the_server_refused_is_taken_back(self):
        widget = watching_widget()
        future = Future()
        widget.executor.submit.return_value = future
        widget.set_watched("chat-a", False)
        self.assertEqual(widget.watched_ids, [])
        future.set_exception(OSError("viewer stopped"))
        self.settle(widget)
        self.assertEqual(widget.watched_ids, ["chat-a"])

    def test_the_all_parties_entry_and_the_demo_cannot_be_watched(self):
        widget = watching_widget()
        widget.set_watched("all", True)
        widget.demo = True
        widget.set_watched("chat-b", True)
        widget.executor.submit.assert_not_called()
        self.assertEqual(widget.watched_ids, ["chat-a"])


if __name__ == "__main__":
    unittest.main()
