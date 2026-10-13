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

    def test_the_all_parties_entry_and_the_demo_cannot_be_watched(self):
        widget = watching_widget()
        widget.set_watched("all", True)
        widget.demo = True
        widget.set_watched("chat-b", True)
        widget.executor.submit.assert_not_called()
        self.assertEqual(widget.watched_ids, ["chat-a"])


if __name__ == "__main__":
    unittest.main()


class JoinedPartyTests(unittest.TestCase):
    def test_a_party_joined_to_a_chat_is_not_listed_again_under_recently_used(self):
        orca_party = {"id": "orca:wt1", "name": "Orca · INT-122", "updatedAt": NOW - 120_000, "joinedTo": "chat-new"}
        _active, recent, _older = launchpad_board([], catalog + [orca_party], now_ms=NOW)
        self.assertNotIn("orca:wt1", [card.id for card in recent])

    def test_a_joined_goblin_says_why_it_is_in_the_party(self):
        from party_layout import join_reason
        self.assertEqual(join_reason({"joined": {"reason": "drives", "verb": "orchestration worker-start"}}),
                         "This chat drives it (orca orchestration worker-start).")
        self.assertEqual(join_reason({"joined": {"reason": "worker"}}), "A worker started by this chat's Orca coordinator.")
        self.assertEqual(join_reason({}), "")

    def test_join_choices_go_to_the_server_and_refresh_the_board(self):
        widget = GoblinWidget.__new__(GoblinWidget)
        widget.closing = False
        widget.thread_id = "all"
        widget.root = Mock()
        widget.kick_board = Mock()
        widget.manual_links = {}
        future = Future()
        widget.executor = Mock(submit=Mock(return_value=future))
        widget.post_local = Mock()
        widget.set_join("orca:wt1", "")
        widget.executor.submit.assert_called_once_with(widget.post_local, "/api/join", {"party": "orca:wt1", "chat": ""})
        future.set_result({"manualLinks": {"orca:wt1": ""}})
        widget.root.after.call_args.args[1]()
        self.assertEqual(widget.manual_links, {"orca:wt1": ""})
        widget.kick_board.assert_called_once_with()
