"""Real Tk checks: × keeps one stream closed, and a moved stream keeps its spot on any display.

Every scene is synthetic and the widget's settings live in a temporary folder, never the user's."""

import json
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from desktop_widget import state_file
from stream_windows import ROSTER_COLUMNS, ROSTER_STEP_X, ROSTER_STEP_Y

try:
    from test_party_dock_geometry import settle
    from test_parting_render import PARTY, Fixture, member, receive
except ImportError:  # Run as a package from the repository root.
    from test.test_party_dock_geometry import settle
    from test.test_parting_render import PARTY, Fixture, member, receive


STREAM_TIMERS = ("adopt_os_move", "animate_sprite", "_show_latest", "sync_follow_to_scroll")


def orphaned_stream_timers(widget):
    """Queued stream timers whose callback is already gone; each would be a Tk background error."""
    tk = widget.root.tk
    orphans = []
    for timer in tk.splitlist(tk.call("after", "info")):
        script = str(tk.splitlist(tk.call("after", "info", timer))[0])
        if script.endswith(STREAM_TIMERS) and not tk.call("info", "commands", script):
            orphans.append(script)
    return orphans


def tile_click(stream, actor_id):
    """Where a click lands on this member's roster tile."""
    index = next(index for index, actor in enumerate(stream.party) if actor["id"] == actor_id)
    column, row = index % ROSTER_COLUMNS, index // ROSTER_COLUMNS - stream.roster_row_offset
    return SimpleNamespace(x=1 + column * ROSTER_STEP_X + 25, y=1 + row * ROSTER_STEP_Y + 22)


@unittest.skipUnless(sys.platform == "win32", "Desktop widget requires Windows Tk")
class ClosedStreamUiTests(unittest.TestCase):
    def test_closing_one_of_six_stays_closed_until_its_tile_is_clicked(self):
        fixture = Fixture(self)
        widget = fixture.widget(self)
        party = [member(name) for name in "abcde"]
        receive(widget, party)
        widget.open_party("a")
        settle(widget)
        self.assertEqual(set(widget.streams), {PARTY, "a", "b", "c", "d", "e"})

        widget.streams["c"].close_button.invoke()
        settle(widget)
        self.assertNotIn("c", widget.streams)
        # Polls keep it closed; it is still a member, on every other stream's roster.
        for _ in range(3):
            receive(widget, party)
        self.assertNotIn("c", widget.streams)
        self.assertNotIn("c", widget.parted)
        self.assertIn("c", [actor["id"] for actor in widget.streams["a"].party])
        self.assertEqual(widget.display_mode, "expanded")

        # Hiding and expanding again, or a restart, does not bring it back either.
        widget.hide_party()
        widget.restore_hidden_party()
        settle(widget)
        self.assertNotIn("c", widget.streams)
        widget.close()
        saved = json.loads(state_file().read_text(encoding="utf-8"))
        self.assertEqual(saved["dismissedStreams"], {PARTY: ["c"]})
        again = fixture.widget(self)
        receive(again, party)
        self.assertEqual(set(again.streams), {PARTY, "a", "b", "d", "e"})
        receive(again, party + [member("f")])  # A genuinely new member still opens.
        self.assertIn("f", again.streams)
        self.assertNotIn("c", again.streams)

        # Its roster tile reopens just that one.
        stream = again.streams["a"]
        stream.on_roster_click(tile_click(stream, "c"))
        settle(again)
        self.assertIn("c", again.streams)
        self.assertTrue(again.streams["c"].window.winfo_ismapped())
        self.assertEqual(again.dismissed, {})

    def test_closing_every_window_leaves_the_party_condensed(self):
        fixture = Fixture(self)
        widget = fixture.widget(self)
        party = [member("a"), member("b")]
        receive(widget, party)
        widget.open_party("a")
        settle(widget)
        for actor_id in list(widget.streams):
            widget.streams[actor_id].close_button.invoke()
            settle(widget)
        self.assertEqual((widget.streams, widget.display_mode), ({}, "compact"))
        receive(widget, party)
        self.assertEqual((widget.streams, widget.display_mode), ({}, "compact"))
        # EXPAND on an all-closed party would show nothing, so it opens everyone again.
        widget.expand_party()
        settle(widget)
        self.assertEqual(set(widget.streams), {PARTY, "a", "b"})


@unittest.skipUnless(sys.platform == "win32", "Desktop widget requires Windows Tk")
class MovedStreamUiTests(unittest.TestCase):
    def setUp(self):
        self.fixture = Fixture(self)

    def displays(self, widget):
        """The real primary plus a pretend second display to its right."""
        width, height = widget.root.winfo_screenwidth(), widget.root.winfo_screenheight()
        return [(0, 0, width, height), (width, 0, width + 1600, 900)]

    def test_a_stream_moved_to_another_display_keeps_its_spot(self):
        widget = self.fixture.widget(self)
        displays = self.displays(widget)
        monitors = patch("desktop_widget.monitor_areas", return_value=displays)
        monitors.start()
        self.addCleanup(monitors.stop)
        receive(widget, [member("a"), member("b")])
        widget.open_party("a")
        settle(widget)
        stream = widget.streams["a"]
        target = (displays[1][0] + 200, 120)

        # Dragged by its header onto the second display.
        start_x, start_y = stream.window.winfo_x(), stream.window.winfo_y()
        stream.start_drag(SimpleNamespace(x_root=500, y_root=500))
        stream.drag(SimpleNamespace(x_root=500 + target[0] - start_x, y_root=500 + target[1] - start_y))
        stream.end_drag(None)
        settle(widget)
        self.assertEqual((stream.x, stream.y, stream.manual), (*target, True))

        # Refreshes and a joining member never move it.
        for agents in ([member("a"), member("b")], [member("a"), member("b"), member("c")]):
            receive(widget, agents)
        self.assertEqual((stream.window.winfo_x(), stream.window.winfo_y()), target)
        # Nor does hiding and expanding the party.
        widget.hide_party()
        widget.restore_hidden_party()
        settle(widget)
        self.assertEqual((stream.window.winfo_x(), stream.window.winfo_y()), target)

        # A move made with Windows' own keys is adopted too.
        moved = (target[0] + 300, target[1] + 40)
        stream.window.geometry(f"+{moved[0]}+{moved[1]}")
        settle(widget)
        stream.moved_at = 0.0
        stream.adopt_os_move()
        self.assertEqual((stream.x, stream.y), moved)

        # A restart puts it back on the second display, not on a tile, and leaves no timer behind.
        widget.close()
        self.assertEqual(orphaned_stream_timers(widget), [])
        again = self.fixture.widget(self)
        receive(again, [member("a"), member("b"), member("c")])
        reopened = again.streams["a"]
        self.assertEqual((reopened.x, reopened.y, reopened.manual), (*moved, True))
        self.assertEqual((reopened.window.winfo_x(), reopened.window.winfo_y()), moved)

        # Closed and reopened from the roster, it still returns there.
        reopened.close_button.invoke()
        settle(again)
        again.streams["b"].on_roster_click(tile_click(again.streams["b"], "a"))
        settle(again)
        self.assertEqual((again.streams["a"].window.winfo_x(), again.streams["a"].window.winfo_y()), moved)

        # Rebalance is the one reset.
        again.rebalance_streams()
        settle(again)
        x = again.streams["a"].window.winfo_x()
        self.assertTrue(displays[0][0] <= x < displays[0][2], x)
        self.assertFalse(again.streams["a"].manual)

    def test_a_spot_left_of_the_primary_is_saved_and_restored_with_negative_coordinates(self):
        widget = self.fixture.widget(self)
        width, height = widget.root.winfo_screenwidth(), widget.root.winfo_screenheight()
        displays = [(0, 0, width, height), (-1600, -200, 0, 700)]
        monitors = patch("desktop_widget.monitor_areas", return_value=displays)
        monitors.start()
        self.addCleanup(monitors.stop)
        receive(widget, [member("a"), member("b")])
        widget.open_party("a")
        settle(widget)
        stream = widget.streams["a"]
        target = (-1400, -120)
        start_x, start_y = stream.window.winfo_x(), stream.window.winfo_y()
        stream.start_drag(SimpleNamespace(x_root=500, y_root=500))
        stream.drag(SimpleNamespace(x_root=500 + target[0] - start_x, y_root=500 + target[1] - start_y))
        stream.end_drag(None)
        settle(widget)
        self.assertEqual((stream.window.winfo_x(), stream.window.winfo_y(), stream.manual), (*target, True))

        # Polls and a joining member leave it there.
        for agents in ([member("a"), member("b")], [member("a"), member("b"), member("c")]):
            receive(widget, agents)
        self.assertEqual((stream.window.winfo_x(), stream.window.winfo_y()), target)

        widget.close()
        saved = json.loads(state_file().read_text(encoding="utf-8"))
        self.assertEqual(saved["placements"]["a"], {"x": target[0], "y": target[1], "manual": True})
        spot = next(item for item in saved["streams"] if item["id"] == "a")
        self.assertEqual((spot["x"], spot["y"], spot["manual"]), (*target, True))

        again = self.fixture.widget(self)
        receive(again, [member("a"), member("b"), member("c")])
        reopened = again.streams["a"]
        self.assertEqual((reopened.window.winfo_x(), reopened.window.winfo_y(), reopened.manual), (*target, True))

    def test_a_spot_on_an_unplugged_display_is_tiled_on_the_primary(self):
        widget = self.fixture.widget(self)
        displays = self.displays(widget)
        with patch("desktop_widget.monitor_areas", return_value=displays):
            receive(widget, [member("a"), member("b")])
            widget.open_party("a")
            settle(widget)
            moved = widget.streams["a"]
            moved.move_to(displays[1][0] + 200, 120)
            moved.manual = True  # As a drag there would leave it.
            widget.on_manual_stream_move(moved)
            widget.close()
        again = self.fixture.widget(self)
        with patch("desktop_widget.monitor_areas", return_value=displays[:1]):
            receive(again, [member("a"), member("b")])
        stream = again.streams["a"]
        self.assertTrue(displays[0][0] <= stream.window.winfo_x() < displays[0][2], stream.window.winfo_x())
        self.assertFalse(stream.manual)


if __name__ == "__main__":
    unittest.main()
