"""Rendered geometry checks for the Windows compact party dock."""

import _tkinter
import os
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from desktop_widget import GoblinWidget
from goblin_cues import cue_for, cue_runs
from stream_windows import HEIGHT, ROSTER_BADGE, ROSTER_SPRITE, ROSTER_TILE, WIDTH


def quiet(widget):
    """Stop every network timer so the check renders only the data it sets."""
    for timer in (widget.poll_after, widget.receive_after, widget.catalog_after, widget.animate_after,
                  widget.restore_after, widget.board_after):
        if timer:
            widget.root.after_cancel(timer)
    widget.poll_after = widget.receive_after = widget.animate_after = None
    widget.catalog_after = widget.restore_after = widget.board_after = None
    # A focused read already in flight, or one started by opening a party, never lands.
    widget.pending = None
    widget.fetch_now = lambda: None
    widget.kick_board = lambda: None
    widget.refresh_catalog = lambda: None


def settle(widget, limit=5_000):
    """Process pending window events with every stream beat stopped, and fail rather than hang.

    Each open stream re-arms a 360 ms beat; with many streams the repaints can outpace an
    unbounded root.update(). Beats are driven by hand in these checks instead."""
    for stream in widget.streams.values():
        if stream.motion_after:
            stream.window.after_cancel(stream.motion_after)
            stream.motion_after = None
    widget.root.update_idletasks()
    for _ in range(limit):
        if not widget.root.tk.dooneevent(_tkinter.ALL_EVENTS | _tkinter.DONT_WAIT):
            return
    raise AssertionError(f"Tk events kept arriving after {limit} were processed")


@unittest.skipUnless(sys.platform == "win32", "Desktop widget requires Windows Tk")
class LaunchpadGeometryTests(unittest.TestCase):
    def test_launchpad_separates_working_from_recent_and_every_state_has_one_click_routes(self):
        with tempfile.TemporaryDirectory(prefix="goblin-launchpad-test-") as folder:
            with patch.dict(os.environ, {"LOCALAPPDATA": folder}):
                widget = GoblinWidget("one", 43917)
                try:
                    quiet(widget)
                    now = time.time() * 1000
                    widget.board_connection = "LIVE"
                    widget.board_success = time.time()
                    widget.board_actors = [
                        {"id": f"chat-{index}", "source": "codex", "status": "active",
                         "name": "A very long chat title that certainly needs an ellipsis to fit " * 2,
                         "turnStates": [{"status": "inProgress"}], "updatedAt": now - index * 60_000,
                         "activities": [{"kind": "file", "title": "Changed app.py", "status": "inProgress"}]}
                        for index in range(3)
                    ] + [
                        {"id": f"agent-{index}", "source": "orca", "parentThreadId": "orca:ws",
                         "name": f"Agent {index}", "status": "working", "updatedAt": now,
                         "activities": [{"kind": "research", "title": "Searched the web"}]}
                        for index in range(6)
                    ]
                    widget.source_catalog = [
                        {"id": "orca:ws", "name": "Orca · greenhouse", "source": "orca", "agentCount": 6,
                         "updatedAt": now, "cwd": "C:/orca/workspaces/greenhouse/map"}
                    ] + [
                        {"id": f"old-{index}", "name": f"Older chat number {index} with a long descriptive title",
                         "source": "codex", "updatedAt": now - (index + 1) * 3_600_000, "cwd": "C:/work/project"}
                        for index in range(30)
                    ]
                    widget.show_launchpad()
                    settle(widget)
                    pad = widget.launchpad
                    self.assertTrue(pad.window.winfo_ismapped())
                    self.assertFalse(widget.root.winfo_ismapped())
                    self.assertIn("4 WORKING", pad.base_status)
                    self.assertIn("4 RECENT", pad.base_status)
                    self.assertIn("26 MORE IN FIND", pad.base_status)
                    self.assertGreaterEqual(pad.window.winfo_height(), pad.window.winfo_reqheight())
                    width = int(pad.body.cget("width"))
                    labels = []
                    for item in pad.body.find_all():
                        if pad.body.type(item) == "text":
                            labels.append(pad.body.itemcget(item, "text"))
                            self.assertLessEqual(pad.body.bbox(item)[2], width, labels[-1])
                    self.assertTrue(any(label.startswith("▶ WORKING NOW") for label in labels))
                    self.assertTrue(any(label.startswith("◷ RECENTLY USED") for label in labels))
                    self.assertTrue(any(label.startswith("⌕ FIND ANY CHAT") for label in labels))
                    self.assertIn("+2", labels)
                    self.assertEqual(len(pad.sprites), 3 + 4)

                    pad.start_search("number 29")
                    settle(widget)
                    self.assertEqual([source["id"] for source in pad.results], ["old-29"])
                    pad.stop_search()

                    widget.hide_party()
                    settle(widget)
                    dock = widget.party_dock
                    self.assertFalse(pad.window.winfo_ismapped())
                    self.assertIn("ALL PARTIES", dock.mini_badge.cget("text"))
                    self.assertEqual(dock.mini_actions.winfo_manager(), "")
                    widget.restore_hidden_party()
                    settle(widget)
                    self.assertTrue(pad.window.winfo_ismapped())

                    widget.condense_party()
                    widget.hide_party()
                    settle(widget)
                    self.assertEqual(dock.mini_actions.winfo_manager(), "pack")
                    right = dock.window.winfo_rootx() + dock.window.winfo_width()
                    for button in dock.mini_buttons:
                        self.assertLessEqual(button.winfo_rootx() + button.winfo_width(), right)
                    self.assertEqual([button.cget("text") for button in dock.mini_buttons],
                                     ["◂ ALL", "CONDENSE", "EXPAND"])
                finally:
                    widget.close()


    def test_many_working_parties_fold_and_a_partial_feed_says_what_it_missed(self):
        with tempfile.TemporaryDirectory(prefix="goblin-launchpad-test-") as folder:
            with patch.dict(os.environ, {"LOCALAPPDATA": folder}):
                widget = GoblinWidget("all", 43917)
                try:
                    quiet(widget)
                    now = time.time() * 1000
                    widget.board_connection = "PARTIAL"
                    widget.board_success = time.time()
                    widget.board_coverage = {"complete": False, "codexPending": 3, "codexAvailable": True}
                    widget.board_actors = [
                        {"id": f"chat-{index}", "source": "codex", "status": "notLoaded", "name": f"Busy chat {index}",
                         "turnStates": [{"status": "inProgress"}], "updatedAt": now - index * 60_000,
                         "activities": [{"kind": "file", "title": "Changed app.py", "status": "inProgress"}]}
                        for index in range(9)
                    ]
                    widget.source_catalog = [
                        {"id": f"chat-{index}", "name": f"Busy chat {index}", "source": "codex",
                         "updatedAt": now - index * 60_000} for index in range(9)]
                    widget.show_launchpad()
                    settle(widget)
                    pad = widget.launchpad
                    self.assertTrue(pad.base_status.startswith("CHECKING 3 CHATS · 9 WORKING"), pad.base_status)
                    self.assertEqual(len(pad.sprites), 6)
                    labels = [pad.body.itemcget(item, "text") for item in pad.body.find_all()
                              if pad.body.type(item) == "text"]
                    self.assertIn("▾ SHOW 3 MORE WORKING", labels)
                    toggle = next(box[4] for box in pad.hitboxes if box[5] == "List every working party")
                    toggle()
                    settle(widget)
                    self.assertEqual(len(pad.sprites), 9)
                    labels = [pad.body.itemcget(item, "text") for item in pad.body.find_all()
                              if pad.body.type(item) == "text"]
                    self.assertIn("▴ SHOW FEWER", labels)

                    # A failed poll keeps the last good rows and says they are old.
                    widget.board_connection = "STALE"
                    pad.refresh(force=True)
                    self.assertTrue(pad.base_status.startswith("STALE"), pad.base_status)
                    self.assertEqual(len(pad.sprites), 9)

                    # With nothing seen yet, a partial feed does not claim that nothing is working.
                    widget.board_connection = "PARTIAL"
                    widget.board_actors = []
                    pad.refresh(force=True)
                    labels = [pad.body.itemcget(item, "text") for item in pad.body.find_all()
                              if pad.body.type(item) == "text"]
                    self.assertIn("None seen yet · checking 3 chats.", labels)
                finally:
                    widget.close()


@unittest.skipUnless(sys.platform == "win32", "Desktop widget requires Windows Tk")
class PartyDockGeometryTests(unittest.TestCase):
    def test_long_names_stay_inside_cards_and_bottom_border_stays_visible(self):
        with tempfile.TemporaryDirectory(prefix="goblin-dock-test-") as folder:
            with patch.dict(os.environ, {"LOCALAPPDATA": folder}):
                widget = GoblinWidget("one", 43917)
                try:
                    quiet(widget)
                    widget.connection = "LIVE"
                    widget.source_name = "Explore a two-player roguelite with a very long party name"
                    for count in (1, 5, 20):
                        widget.actors = [
                            {"id": str(index), "name": "Explore a two-player roguelite with a very long member name",
                             "source": "codex", "status": "completed", "activities": []}
                            for index in range(count)
                        ]
                        # The first member is building, so its card carries a raised hammer cue.
                        widget.actors[0] = {**widget.actors[0], "status": "working", "activities": [
                            {"kind": "file", "title": "Changed app.py", "status": "inProgress"}]}
                        widget.condense_party()
                        settle(widget)
                        dock = widget.party_dock
                        self.assertGreaterEqual(dock.window.winfo_height(), dock.window.winfo_reqheight())
                        self.assertGreaterEqual(dock.body.winfo_height(), dock.body.winfo_reqheight())
                        header_width = dock.header.winfo_width()
                        for button in dock.header_buttons:
                            self.assertLessEqual(button.winfo_x() + button.winfo_width(), header_width)
                        for x1, y1, x2, y2, _actor_id in dock.member_hitboxes:
                            self.assertLess(y2, dock.body.winfo_height())
                            labels = []
                            for item in dock.body.find_all():
                                if dock.body.type(item) != "text":
                                    continue
                                bx1, by1, bx2, by2 = dock.body.bbox(item)
                                if x1 <= bx1 <= x2 and y1 <= by1 <= y2:
                                    labels.append((bx1, by1, bx2, by2))
                                    self.assertLessEqual(bx2, x2 - 4)
                            self.assertEqual(len(labels), 2)
                        # Each card animates its own whole goblin, kept inside the card.
                        self.assertEqual(len(dock.sprites), len(dock.member_hitboxes))
                        for (tag, *_rest), (x1, y1, x2, y2, _actor_id) in zip(dock.sprites, dock.member_hitboxes):
                            bx1, by1, bx2, by2 = dock.body.bbox(tag)
                            self.assertGreaterEqual(bx1, x1)
                            self.assertGreaterEqual(by1, y1)
                            self.assertLessEqual(bx2, x2)
                            self.assertLessEqual(by2, y2)
                finally:
                    widget.close()


def roster_member(member_id: str, status: str, activity: dict) -> dict:
    # Stamped a minute ago: steady actions, not a just-landed step that would pulse on first sight.
    return {"id": member_id, "name": f"Goblin {member_id}", "source": "codex", "status": status,
            "updatedAt": time.time() * 1000 - 60_000, "activities": [activity]}


WORKING = {
    "a": ("search", {"kind": "research", "title": "Searched the web", "status": "inProgress"}),
    "b": ("build", {"kind": "file", "title": "Changed app.py", "status": "inProgress"}),
    "c": ("think", {"kind": "update", "title": "Update", "description": "Planning the layout",
                    "status": "inProgress"}),
}
DONE = {"kind": "update", "title": "Update", "description": "Done."}


@unittest.skipUnless(sys.platform == "win32", "Desktop widget requires Windows Tk")
class StreamRosterGeometryTests(unittest.TestCase):
    def test_roster_tiles_act_out_each_members_work_inside_their_tiles(self):
        with tempfile.TemporaryDirectory(prefix="goblin-roster-test-") as folder:
            with patch.dict(os.environ, {"LOCALAPPDATA": folder}):
                widget = GoblinWidget("one", 43917)
                try:
                    quiet(widget)
                    widget.reduced_motion = False
                    widget.connection = "LIVE"
                    widget.actors = (
                        [roster_member(key, "working", activity) for key, (_, activity) in WORKING.items()]
                        + [roster_member("d", "waiting", DONE), roster_member("e", "failed", DONE)]
                        + [roster_member(key, "completed", DONE) for key in "fghijkl"])
                    expected = {"a": "search", "b": "build", "c": "think", "d": "waiting", "e": "trouble",
                                **{key: "idle" for key in "fghijkl"}}
                    widget.open_party("a")
                    settle(widget)  # Stops every stream's beat before draining their first paints.
                    self.assertTrue(all(item.motion_after is None for item in widget.streams.values()))
                    stream = widget.streams["a"]
                    roster = stream.roster
                    self.assertTrue(stream.window.winfo_ismapped())

                    # The stream keeps its size and dialogue box; the roster fits the gutter.
                    self.assertEqual((stream.window.winfo_width(), stream.window.winfo_height()), (WIDTH, HEIGHT))
                    self.assertEqual(stream.panel.winfo_x(), 103)
                    self.assertLessEqual(roster.winfo_x() + roster.winfo_width(), stream.panel.winfo_x())
                    self.assertLessEqual(roster.winfo_y() + roster.winfo_height(), stream.roster_hint.winfo_y())
                    self.assertLessEqual(stream.roster_hint.winfo_y() + stream.roster_hint.winfo_height(),
                                         stream.sprite.winfo_y())
                    self.assertEqual(len(stream.roster_cells), 10)
                    self.assertIn("↕", stream.roster_hint.cget("text"))

                    def check_tiles(first_number: int) -> None:
                        still = stream.roster_still()
                        numbers = [roster.itemcget(item, "text") for item in roster.find_withtag("badge")
                                   if roster.type(item) == "text"]
                        self.assertEqual(numbers, [str(first_number + index) for index in range(len(numbers))])
                        for tag, x, y, _style, actor in stream.roster_cells:
                            left, top = x - ROSTER_SPRITE[0], y - ROSTER_SPRITE[1]
                            bx1, by1, bx2, by2 = (left + ROSTER_BADGE[0], top + ROSTER_BADGE[1],
                                                  left + ROSTER_BADGE[2], top + ROSTER_BADGE[3])
                            items = roster.find_withtag(tag)
                            self.assertTrue(items, tag)
                            for item in items:
                                x1, y1, x2, y2 = roster.coords(item)
                                self.assertGreaterEqual(x1, left, tag)
                                self.assertGreaterEqual(y1, top, tag)
                                self.assertLessEqual(x2, left + ROSTER_TILE[0], tag)
                                self.assertLessEqual(y2, top + ROSTER_TILE[1], tag)
                                if roster.type(item) == "rectangle":
                                    self.assertTrue(x2 <= bx1 or x1 >= bx2 or y2 <= by1 or y1 >= by2, tag)
                            # The slot plaque stays on top of its goblin.
                            topmost = roster.find_overlapping((bx1 + bx2) // 2, (by1 + by2) // 2,
                                                              (bx1 + bx2) // 2, (by1 + by2) // 2)[-1]
                            self.assertIn("badge", roster.gettags(topmost))
                            self.assertIs(stream.roster_actor_at(x + 24, y + 20), actor)
                            member_id = str(actor["id"])
                            action = "idle" if stream.connection in ("STALE", "OFFLINE") else expected[member_id]
                            frame = stream.motion_clock.frame(("roster", member_id), action, stream.motion_frame)
                            cue = cue_for(action, frame, still)
                            shown = {roster.itemcget(item, "fill") for item in items if "cue" in roster.gettags(item)}
                            self.assertEqual(shown, {color for *_, color in cue_runs(cue)} if cue else set(),
                                             f"{member_id} {action} frame {frame}")

                    # Every action shows on first render, and every beat stays inside its tile.
                    check_tiles(1)
                    poses = set()
                    for _ in range(4):
                        stream.animate_sprite()
                        stream.window.after_cancel(stream.motion_after)
                        check_tiles(1)
                        poses.add(tuple(tuple(roster.coords(item)) for item in roster.find_withtag("roster-1")))
                    self.assertGreater(len(poses), 1)

                    # New party data repaints the changed member at once.
                    widget.actors[1] = roster_member("b", "failed", DONE)
                    expected["b"] = "trouble"
                    stream.set_party(widget.visible_actors())
                    check_tiles(1)

                    # Scrolling moves both the drawn tiles and their hit targets.
                    stream.scroll_roster(SimpleNamespace(delta=-120))
                    self.assertEqual(stream.roster_cells[0][0], "roster-2")
                    check_tiles(3)
                    stream.scroll_roster(SimpleNamespace(delta=120))
                    check_tiles(1)

                    # A withdrawn stream keeps time without repainting.
                    stream.window.withdraw()
                    settle(widget)
                    drawn = roster.find_all()
                    stream.animate_sprite()
                    stream.window.after_cancel(stream.motion_after)
                    self.assertEqual(roster.find_all(), drawn)
                    stream.window.deiconify()
                    settle(widget)

                    # Reduced motion shows one still frame and beats leave it alone.
                    widget.toggle_reduced_motion()
                    self.assertTrue(widget.reduced_motion)
                    check_tiles(1)
                    drawn = roster.find_all()
                    stream.animate_sprite()
                    stream.window.after_cancel(stream.motion_after)
                    self.assertEqual(roster.find_all(), drawn)
                    widget.toggle_reduced_motion()

                    # A stale feed rests every goblin without cues and stops the beats.
                    stream.render_actor(stream.actor, "STALE")
                    check_tiles(1)
                    drawn = roster.find_all()
                    stream.animate_sprite()
                    stream.window.after_cancel(stream.motion_after)
                    self.assertEqual(roster.find_all(), drawn)
                finally:
                    widget.close()


if __name__ == "__main__":
    unittest.main()
