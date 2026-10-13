"""Navigation checks for the desktop party and its independently closable streams."""

import json
import unittest
from unittest.mock import Mock, patch
import time

from desktop_widget import GoblinWidget
from goblin_parting import PartingNotes, RetirementTracker


def animating_widget(mapped):
    widget = GoblinWidget.__new__(GoblinWidget)
    widget.closing = False
    widget.phase = 0
    widget.paused = False
    widget.reduced_motion = False
    widget.rotating = False
    widget.demo = False
    widget.page = 0
    widget.columns = 2
    widget.palette_offset = 0
    widget.page_actors = Mock(return_value=[{"id": "a"}, {"id": "b"}])
    widget.paint_overview_sprite = Mock()
    widget.launchpad = Mock()
    widget.party_dock = Mock()
    widget.advance_visible_text = Mock()
    widget.root = Mock()
    widget.root.winfo_ismapped.return_value = mapped
    return widget


class OverviewMotionTests(unittest.TestCase):
    def test_hidden_goblin_line_is_not_repainted(self):
        widget = animating_widget(mapped=False)
        widget.animate()
        widget.paint_overview_sprite.assert_not_called()
        # The other surfaces and the beat keep running.
        self.assertEqual(widget.phase, 1)
        widget.launchpad.animate.assert_called_once_with()
        widget.root.after.assert_called_once()

    def test_visible_goblin_line_repaints_every_goblin(self):
        widget = animating_widget(mapped=True)
        widget.animate()
        self.assertEqual(widget.paint_overview_sprite.call_count, 2)


class WidgetNavigationTests(unittest.TestCase):
    def test_open_party_includes_goblins_on_other_overview_pages(self):
        widget = GoblinWidget.__new__(GoblinWidget)
        widget.demo = False
        widget.thread_id = "chosen-chat"
        widget.hidden_ids = set()
        widget.actors = [{"id": "a"}, {"id": "b"}, {"id": "c"}, {"id": "d"}]
        widget.columns = 2
        widget.streams = {actor["id"]: Mock() for actor in widget.actors}
        widget.visible_stream_ids = set()
        widget.focused_stream_id = ""
        widget.open_stream = Mock()
        widget.align_streams = Mock()
        widget.bring_stream_forward = Mock()
        widget.save_position = Mock()

        widget.open_party("b")

        self.assertEqual([call.args[0]["id"] for call in widget.open_stream.call_args_list],
                         ["a", "b", "c", "d"])
        for stream in widget.streams.values():
            stream.set_party.assert_called_once_with(widget.actors)
        widget.align_streams.assert_called_once_with()
        widget.bring_stream_forward.assert_called_once_with("b")

        widget.open_party("workspace-root-without-activity")
        self.assertEqual(widget.focused_stream_id, "a")

    def test_close_all_streams_disposes_old_and_current_sources(self):
        widget = GoblinWidget.__new__(GoblinWidget)
        old, current = Mock(), Mock()
        widget.streams = {"old-chat": old, "current-chat": current}
        widget.visible_stream_ids = set(widget.streams)
        widget.thread_id = "current-chat"
        widget.demo = False
        widget.condense_party = Mock()
        widget.show_overview = Mock()
        widget.save_position = Mock()

        widget.close_all_streams()

        old.dispose.assert_called_once_with()
        current.dispose.assert_called_once_with()
        self.assertEqual(widget.streams, {})
        widget.condense_party.assert_called_once_with()
        widget.show_overview.assert_not_called()
        widget.save_position.assert_called_once_with()

    def test_recent_activity_card_selects_its_party_before_opening_streams(self):
        widget = GoblinWidget.__new__(GoblinWidget)
        widget.thread_id = "all"
        widget.demo = False
        widget.follow_source = Mock()
        widget.open_party = Mock()
        actor = {"id": "agent-7", "source": "orca", "parentThreadId": "workspace-2",
                 "nickname": "Builder"}

        widget.select_party_for_actor(actor)

        widget.follow_source.assert_called_once_with("workspace-2", "Builder", open_party=True,
                                                     focus_id="agent-7")
        widget.open_party.assert_not_called()

    def test_retained_stream_switches_back_to_its_party_explicitly(self):
        widget = GoblinWidget.__new__(GoblinWidget)
        widget.demo = False
        widget.actors = []
        widget.hidden_ids = set()
        widget.streams = {"member": Mock(actor={"id": "member", "source": "orca",
                                                 "parentThreadId": "old-workspace", "name": "Maker"})}
        widget.follow_source = Mock()

        widget.bring_stream_forward("member")

        widget.follow_source.assert_called_once_with("old-workspace", "Maker", open_party=True,
                                                     focus_id="member")

    def test_parent_scene_refreshes_child_stream_and_its_roster(self):
        widget = GoblinWidget.__new__(GoblinWidget)
        widget.thread_id = "parent-chat"
        widget.hidden_ids = set()
        widget.demo = False
        root = {"id": "parent-chat", "activities": [{"id": "root-event"}]}
        child = {"id": "child-chat", "parentThreadId": "parent-chat", "activities": [{"id": "new-event"}]}
        widget.actors = [root, child]
        stream = Mock()
        widget.streams = {"child-chat": stream}

        widget.update_party_streams(root, [child], False)

        stream.receive_actor.assert_called_once_with(child, "LIVE")
        stream.set_party.assert_called_once_with([root, child], paint=False)
        # The rail is laid out before the actor render, which paints it exactly once.
        self.assertEqual([name for name, *_ in stream.method_calls], ["set_party", "receive_actor"])

    def test_local_alias_keeps_underlying_agent_name_visible(self):
        widget = GoblinWidget.__new__(GoblinWidget)
        widget.aliases = {"child-chat": "Taro"}
        self.assertEqual(widget.display_name({"id": "child-chat", "nickname": "Cicero"}),
                         "Taro · Cicero")

    def test_recent_party_is_one_click_from_stream_switch_menu(self):
        widget = GoblinWidget.__new__(GoblinWidget)
        widget.root = Mock()
        widget.thread_id = "current-chat"
        widget.source_catalog = [{"id": "new-chat", "name": "New work", "source": "codex",
                                  "updatedAt": time.time() * 1000, "cwd": "C:/work/project"}]
        widget.actors = []
        widget.follow_source = Mock()
        widget.open_viewer = Mock()
        with patch("desktop_widget.tk.Menu") as menu_class:
            widget.show_source_menu()
            menu = menu_class.return_value
            recent = next(call.kwargs for call in menu.add_command.call_args_list
                          if "New work" in call.kwargs.get("label", ""))
            recent["command"]()

        widget.follow_source.assert_called_once_with("new-chat", "New work",
                                                     open_party=True, focus_id="new-chat")


def scene_widget(display_mode="expanded"):
    """A widget waiting on one finished party read, with the desktop surfaces stubbed out."""
    widget = GoblinWidget.__new__(GoblinWidget)
    widget.closing = False
    widget.demo = False
    widget.thread_id = "party"
    widget.source_name = "Party"
    widget.hidden_ids = set()
    widget.display_mode = display_mode
    widget.party_view = "compact"
    widget.party_mode = display_mode == "expanded"
    widget.pending_party = None
    widget.focused_stream_id = "party"
    widget.last_success = 5.0
    widget.pending_scope = "party"
    widget.pending = Mock()
    widget.pending.done.return_value = True
    widget.party_dock = Mock(mode="")
    widget.launchpad = Mock()
    widget.draw = Mock()
    widget.update_party_streams = Mock()
    widget.open_party = Mock()
    widget.align_streams = Mock()
    widget.condense_party = Mock()
    widget.show_loading_party = Mock()
    widget.retirement = RetirementTracker()
    widget.notes = PartingNotes()
    widget.exits = {}
    widget.roster_only = set()
    return widget


class LayoutPreservationTests(unittest.TestCase):
    def test_failed_read_keeps_expanded_streams_open_and_marks_them_stale(self):
        widget = scene_widget()
        stream = Mock(last_success=1.0, actor={"id": "party"})
        widget.streams = {"party": stream}
        widget.actors = [{"id": "party"}]
        widget.visible_stream_ids = {"party"}
        widget.pending.result.side_effect = OSError("server restarting")

        widget.receive_scene()

        widget.show_loading_party.assert_not_called()
        self.assertEqual(widget.connection, "STALE")
        stream.render_actor.assert_called_once_with(stream.actor, "STALE")

    def test_joining_member_opens_without_stealing_focus(self):
        widget = scene_widget()
        widget.streams = {"party": Mock()}
        widget.actors = []
        widget.pending.result.return_value = {
            "root": {"id": "party", "name": "Party", "activities": [{"id": "event"}]},
            "agents": [{"id": "helper", "parentThreadId": "party"}]}

        widget.receive_scene()

        widget.open_party.assert_called_once_with("party", bring_forward=False, from_poll=True)
        widget.align_streams.assert_not_called()

    def test_a_poll_never_reopens_a_closed_stream_but_opens_a_new_member(self):
        widget = scene_widget()
        six = ["party", "a", "b", "c", "d", "e"]
        widget.streams = {actor_id: Mock() for actor_id in six if actor_id != "c"}
        widget.dismissed = {"party": ["c"]}
        widget.actors = []
        agents = [{"id": actor_id, "parentThreadId": "party"} for actor_id in six[1:]]
        widget.pending.result.return_value = {
            "root": {"id": "party", "name": "Party", "activities": [{"id": "event"}]}, "agents": agents}

        widget.receive_scene()

        widget.open_party.assert_not_called()
        widget.align_streams.assert_called_once_with()

        # A genuinely new member does open, without reopening the closed one (open_party skips it).
        widget.align_streams.reset_mock()
        widget.pending = Mock()
        widget.pending.done.return_value = True
        widget.pending.result.return_value = {
            "root": {"id": "party", "name": "Party", "activities": [{"id": "event"}]},
            "agents": agents + [{"id": "new", "parentThreadId": "party"}]}
        widget.receive_scene()
        widget.open_party.assert_called_once_with("party", bring_forward=False, from_poll=True)

    def test_party_that_finishes_loading_after_going_home_stays_away(self):
        widget = scene_widget("overview")
        widget.streams = {}
        widget.actors = []
        widget.pending_party = ("party", "party")
        widget.pending.result.return_value = {"root": {"id": "party", "activities": [{"id": "e"}]}, "agents": []}

        widget.receive_scene()

        widget.condense_party.assert_not_called()
        widget.open_party.assert_not_called()
        self.assertIsNone(widget.pending_party)

    def test_align_keeps_visible_window_and_gives_newcomer_a_free_tile(self):
        widget = GoblinWidget.__new__(GoblinWidget)
        widget.demo = False
        widget.thread_id = "party"
        widget.hidden_ids = set()
        widget.connection = "LIVE"
        widget.focused_stream_id = "a"
        widget.root = Mock()
        widget.party_dock = Mock()
        widget.hide_home = Mock()
        widget.save_position = Mock()
        reading = Mock(x=900, y=300, placed=True, manual=False, actor={"id": "a", "status": "working"})
        reading.window.winfo_ismapped.return_value = True
        joining = Mock(x=0, y=0, placed=False, manual=False, actor={"id": "b", "status": "working"})
        joining.window.winfo_ismapped.return_value = False
        widget.streams = {"a": reading, "b": joining}
        widget.actors = [reading.actor, joining.actor]

        with patch("desktop_widget.monitor_work_area", return_value=(0, 0, 1600, 900)), \
                patch("desktop_widget.monitor_areas", return_value=[(0, 0, 1600, 900)]):
            widget.align_streams()

        reading.move_to.assert_not_called()
        joining.move_to.assert_called_once_with(29, 44)
        self.assertTrue(joining.placed)
        self.assertEqual(widget.visible_stream_ids, {"a", "b"})
        self.assertEqual(widget.placements["b"], {"x": 29, "y": 44, "manual": False})

    def test_a_window_closed_in_one_party_stays_closed_there_after_another_party_reopens_it(self):
        lead_a = window("a", 29, 44, mapped=True)
        shared = window("x", 900, 300, mapped=True, manual=True)
        widget = monitor_widget({"a": lead_a, "x": shared})
        widget.thread_id = "party-a"
        widget.dismissed, widget.placements, widget.visible_stream_ids = {}, {}, set()
        widget.party_mode, widget.parted, widget.peek_id = True, frozenset(), ""
        layout = widget.align_streams

        def align():
            with patch("desktop_widget.monitor_work_area", return_value=PRIMARY), \
                    patch("desktop_widget.monitor_areas", return_value=[PRIMARY]):
                layout()
        widget.align_streams = align

        # × on "x" in party A.
        widget.streams.pop("x")
        shared.window.winfo_ismapped.return_value = False
        widget.on_stream_closed("x")
        self.assertEqual(widget.dismissed, {"party-a": ["x"]})

        # Party B opens "x" again; A's closure is A's alone.
        widget.thread_id = "party-b"
        widget.actors = [{"id": "b", "status": "working"}, shared.actor]
        widget.streams = {"b": window("b", 0, 0, mapped=False, placed=False), "x": shared}
        align()
        self.assertIn("x", widget.visible_stream_ids)
        for stream in widget.streams.values():
            stream.window.winfo_ismapped.return_value = True

        # Back on party A, the retained (and hand-placed) "x" window stays hidden.
        widget.thread_id = "party-a"
        widget.actors = [lead_a.actor, shared.actor]
        widget.streams["a"] = lead_a
        shared.window.deiconify.reset_mock()
        align()
        self.assertEqual(widget.visible_stream_ids, {"a"})
        shared.window.withdraw.assert_called()
        shared.window.deiconify.assert_not_called()
        self.assertEqual(widget.dismissed, {"party-a": ["x"]})
        self.assertEqual(widget.placements["x"], {"x": 900, "y": 300, "manual": True})

        # Its roster tile still reopens it for party A.
        widget.reopen_member("x")
        align()
        self.assertIn("x", widget.visible_stream_ids)

    def test_rebalance_is_the_only_retile(self):
        widget = GoblinWidget.__new__(GoblinWidget)
        widget.thread_id = "party"
        widget.streams = {"a": Mock(placed=True, manual=True), "b": Mock(placed=True, manual=False)}
        widget.dismissed = {"party": ["closed"]}
        widget.placements = {"a": {"x": 2588, "y": 0, "manual": True}, "closed": {"x": 5, "y": 5, "manual": True},
                             "elsewhere": {"x": 1, "y": 1, "manual": False}}
        widget.align_streams = Mock()

        widget.rebalance_streams()

        self.assertFalse(any(stream.placed or stream.manual for stream in widget.streams.values()))
        self.assertEqual(list(widget.placements), ["elsewhere"])
        widget.align_streams.assert_called_once_with(retile=True)

    def test_ending_a_peek_returns_the_stream_to_its_tile(self):
        widget = GoblinWidget.__new__(GoblinWidget)
        stream = Mock(x=600, y=100, placed=True)
        widget.streams = {"a": stream}
        widget.peek_id = "a"
        widget.peek_home = (29, 44, True)

        widget.end_peek()

        stream.window.withdraw.assert_called_once_with()
        self.assertEqual((stream.x, stream.y, stream.placed), (29, 44, True))
        self.assertEqual((widget.peek_id, widget.peek_home), ("", None))

    def test_saving_during_a_peek_keeps_the_home_tile(self):
        widget = GoblinWidget.__new__(GoblinWidget)
        peeked = Mock(actor_id="a")
        peeked.state.return_value = {"id": "a", "x": 600, "y": 100, "placed": True}
        other = Mock(actor_id="b")
        other.state.return_value = {"id": "b", "x": 5, "y": 6, "placed": True}
        widget.streams = {"a": peeked, "b": other}
        widget.peek_id = "a"
        widget.peek_home = (29, 44, False)

        saved = {state["id"]: (state["x"], state["y"], state["placed"]) for state in widget.stream_states()}

        self.assertEqual(saved, {"a": (29, 44, False), "b": (5, 6, True)})


def party_widget(ids=("party", "a", "b", "c", "d", "e")):
    """A selected party whose open_stream records a stream per member, with the desktop stubbed."""
    widget = GoblinWidget.__new__(GoblinWidget)
    widget.demo = False
    widget.thread_id = "party"
    widget.hidden_ids = set()
    widget.actors = [{"id": actor_id} for actor_id in ids]
    widget.streams = {}
    widget.visible_stream_ids = set()
    widget.focused_stream_id = ""
    widget.peek_id = ""
    widget.party_mode = False
    widget.roster_only = set()
    widget.open_stream = Mock(side_effect=lambda actor, saved=None: widget.streams.setdefault(actor["id"], Mock()))
    for name in ("align_streams", "bring_stream_forward", "save_position", "end_peek", "condense_party"):
        setattr(widget, name, Mock())
    return widget


class CalmExpandTests(unittest.TestCase):
    def test_a_big_party_opens_three_windows_and_keeps_the_rest_on_the_roster(self):
        widget = party_widget()
        widget.actors[3]["needsInput"] = True  # "c" needs the person: it always gets a window.
        widget.actors[4]["status"] = "active"  # "d" is working.
        widget.open_party("a")
        self.assertEqual(set(widget.streams), {"a", "c", "d"})
        self.assertEqual(widget.roster_only, {"party", "b", "e"})
        self.assertEqual(widget.focused_stream_id, "a")

    def test_everyone_who_needs_you_opens_even_past_the_limit(self):
        widget = party_widget()
        for actor in widget.actors[1:5]:
            actor["needsInput"] = True
        widget.open_party("party")
        self.assertEqual(set(widget.streams), {"party", "a", "b", "c", "d"})

    def test_the_rally_opens_everyone(self):
        widget = party_widget()
        widget.dismissed = {}
        widget.set_dismissed = Mock()
        widget.open_full_party("a")
        self.assertEqual(set(widget.streams), {"party", "a", "b", "c", "d", "e"})
        self.assertEqual(widget.roster_only, set())


def close(widget, actor_id):
    """What the × on one stream does."""
    widget.streams.pop(actor_id).dispose()
    widget.on_stream_closed(actor_id)


@patch("desktop_widget.STREAM_LIMIT", 10)
class ClosedStreamTests(unittest.TestCase):
    def test_closing_one_of_six_keeps_it_closed_through_polls_expand_and_restart(self):
        widget = party_widget()
        widget.open_party("a")
        self.assertEqual(set(widget.streams), {"party", "a", "b", "c", "d", "e"})
        widget.party_mode = True
        close(widget, "c")
        self.assertEqual(widget.dismissed, {"party": ["c"]})
        # The member stays in the party and its roster; × is not retirement.
        self.assertIn("c", [actor["id"] for actor in widget.visible_actors()])
        widget.align_streams.assert_called_with()

        widget.open_party("a", bring_forward=False, from_poll=True)
        widget.open_party("a")  # Expanding again from the roster or the launchpad.
        self.assertNotIn("c", widget.streams)

        # A restart reads back only what is needed: which streams were closed, per party.
        saved = json.loads(json.dumps({"dismissedStreams": widget.dismissed}))
        again = party_widget()
        again.load_dismissed(saved["dismissedStreams"])
        again.open_party("", bring_forward=False, from_poll=True)
        self.assertEqual(set(again.streams), {"party", "a", "b", "d", "e"})

    def test_a_roster_click_reopens_one_and_the_rally_reopens_all(self):
        widget = party_widget()
        widget.dismissed = {"party": ["c", "d"], "other-party": ["x"]}
        widget.open_party("a", from_poll=True)
        self.assertEqual(set(widget.streams), {"party", "a", "b", "e"})

        widget.open_and_focus_stream({"id": "c"})
        self.assertIn("c", widget.streams)
        self.assertEqual(widget.dismissed["party"], ["d"])
        widget.bring_stream_forward.assert_called_with("c")

        widget.open_full_party()
        self.assertIn("d", widget.streams)
        # Another party's closures are its own.
        self.assertEqual(widget.dismissed, {"other-party": ["x"]})

    def test_focusing_a_closed_member_reopens_it_and_expanding_an_all_closed_party_reopens_everyone(self):
        widget = party_widget(("party", "a", "b"))
        widget.dismissed = {"party": ["a"]}
        widget.open_party("a")  # A launchpad click on that goblin.
        self.assertIn("a", widget.streams)
        widget.streams.clear()
        widget.dismissed = {"party": ["party", "a", "b"]}
        widget.open_party("", from_poll=True)
        self.assertEqual(widget.streams, {})  # A poll leaves an all-closed party condensed.
        widget.open_party("")  # Pressing EXPAND would otherwise show nothing at all.
        self.assertEqual(set(widget.streams), {"party", "a", "b"})
        self.assertEqual(widget.dismissed, {})

    def test_closures_never_carry_into_another_party_or_onto_new_members(self):
        widget = party_widget()
        widget.party_mode = True
        widget.open_party("a")
        close(widget, "b")
        widget.thread_id = "other"
        widget.actors = [{"id": "other"}, {"id": "b2"}]
        widget.streams = {}
        widget.open_party("", from_poll=True)
        self.assertEqual(set(widget.streams), {"other", "b2"})
        self.assertEqual(widget.dismissed, {"party": ["b"]})
        # Closing a stream from another party, or a demo goblin, records nothing for this one.
        widget.on_stream_closed("not-a-member")
        widget.on_stream_closed("demo-1")
        self.assertEqual(widget.dismissed, {"party": ["b"]})

    def test_closing_a_window_kept_from_an_earlier_party_is_remembered_for_that_party_only(self):
        widget = party_widget()
        widget.dismissed = {}
        # "x" is still open from "old-party" while "party" is selected; the menu closes it.
        widget.on_stream_closed("x", "old-party")
        self.assertEqual(widget.dismissed, {"old-party": ["x"]})
        # A member of the selected party is recorded there, whichever party opened its window.
        widget.on_stream_closed("b", "old-party")
        self.assertEqual(widget.dismissed, {"old-party": ["x"], "party": ["b"]})
        widget.open_party("a", from_poll=True)
        self.assertNotIn("b", widget.streams)

        # Back on the old party, neither a poll nor expanding brings "x" back; its tile does.
        widget.thread_id = "old-party"
        widget.actors = [{"id": "old-party"}, {"id": "x"}, {"id": "y"}]
        widget.streams = {}
        widget.open_party("", from_poll=True)
        widget.open_party("old-party")
        self.assertEqual(set(widget.streams), {"old-party", "y"})
        widget.open_and_focus_stream({"id": "x"})
        self.assertIn("x", widget.streams)
        self.assertEqual(widget.dismissed, {"party": ["b"]})

    def test_a_window_remembers_the_party_it_was_opened_for(self):
        widget = GoblinWidget.__new__(GoblinWidget)
        widget.root_id, widget.demo, widget.connection = "", False, "CONNECTING"
        widget.actors, widget.hidden_ids, widget.streams, widget.placements = [], set(), {}, {}
        widget.stream_style = Mock(return_value={})
        widget.pinned_note = Mock(return_value=None)
        widget.pinned_undo = Mock(return_value=False)
        widget.save_position = Mock()
        with patch("desktop_widget.StreamWindow", side_effect=lambda *_args: Mock()):
            widget.thread_id = "party"
            widget.open_stream({"id": "a", "parentThreadId": "party"})
            widget.open_stream({"id": "b", "parentThreadId": "party"}, {"party": "old-party", "x": 0, "y": 0})
            widget.thread_id = "all"
            widget.open_stream({"id": "c", "parentThreadId": "chat"})
        self.assertEqual({actor_id: stream.party_id for actor_id, stream in widget.streams.items()},
                         {"a": "party", "b": "old-party", "c": "chat"})

    def test_stored_closures_and_placements_are_validated_and_bounded(self):
        widget = GoblinWidget.__new__(GoblinWidget)
        widget.load_dismissed({"party": ["a", "a", 5, "", "demo-1", "b"], "all": ["x"], "": ["y"], "bad": "nope",
                               **{f"p{index}": ["m"] for index in range(40)}})
        self.assertLessEqual(len(widget.dismissed), 24)
        widget.load_dismissed({"party": ["a", "a", 5, "", "demo-1", "b"], "all": ["x"], "bad": "nope"})
        self.assertEqual(widget.dismissed, {"party": ["a", "b"]})
        widget.load_dismissed("junk")
        self.assertEqual(widget.dismissed, {})
        widget.load_placements({"a": {"x": -1500, "y": -200, "manual": True}, "b": {"x": True, "y": 0},
                                "c": {"x": 1.5, "y": 0}, "d": {"x": 10 ** 9, "y": 0}, "demo-1": {"x": 0, "y": 0},
                                "e": "nope", "f": {"x": 2588, "y": 40}})
        self.assertEqual(widget.placements, {"a": {"x": -1500, "y": -200, "manual": True},
                                             "f": {"x": 2588, "y": 40, "manual": False}})
        for index in range(250):
            widget.remember_placement(f"m{index}", index, 0, False)
        self.assertEqual(len(widget.placements), 200)
        self.assertIn("m249", widget.placements)
        self.assertEqual(GoblinWidget.placements, {})
        self.assertEqual(GoblinWidget.dismissed, {})


def monitor_widget(streams):
    widget = GoblinWidget.__new__(GoblinWidget)
    widget.demo = False
    widget.thread_id = "party"
    widget.hidden_ids = set()
    widget.connection = "LIVE"
    widget.focused_stream_id = ""
    widget.root = Mock()
    widget.party_dock = Mock()
    widget.hide_home = Mock()
    widget.save_position = Mock()
    widget.streams = streams
    widget.actors = [stream.actor for stream in streams.values()]
    return widget


def window(actor_id, x, y, *, mapped, placed=True, manual=False):
    stream = Mock(x=x, y=y, placed=placed, manual=manual, actor={"id": actor_id, "status": "working"})
    stream.window.winfo_ismapped.return_value = mapped
    stream.move_to.side_effect = lambda new_x, new_y: (setattr(stream, "x", new_x), setattr(stream, "y", new_y))
    return stream


PRIMARY = (0, 0, 1600, 900)
RIGHT = (1600, -200, 4160, 1240)
LEFT = (-1600, -300, 0, 600)


class MonitorPlacementTests(unittest.TestCase):
    def align(self, widget, displays, retile=False):
        with patch("desktop_widget.monitor_work_area", return_value=PRIMARY), \
                patch("desktop_widget.monitor_areas", return_value=displays):
            if retile:
                widget.rebalance_streams()
            else:
                widget.align_streams()

    def test_hand_placed_windows_on_other_displays_survive_retiling_hide_and_restart(self):
        moved = window("a", 2588, 100, mapped=False, manual=True)
        left = window("b", -1500, -250, mapped=False, manual=True)
        tiled = window("c", 0, 0, mapped=False, placed=False)
        widget = monitor_widget({"a": moved, "b": left, "c": tiled})
        widget.dismissed = {}
        self.align(widget, [PRIMARY, RIGHT, LEFT])
        moved.move_to.assert_called_once_with(2588, 100)  # Shown where it was left, not on a tile.
        left.move_to.assert_called_once_with(-1500, -250)
        self.assertEqual((tiled.x, tiled.y), (29, 44))
        self.assertEqual(widget.placements["a"], {"x": 2588, "y": 100, "manual": True})

        # A refresh, or another member joining, never moves a visible window.
        for stream in (moved, left, tiled):
            stream.window.winfo_ismapped.return_value = True
            stream.move_to.reset_mock()
        joining = window("d", 0, 0, mapped=False, placed=False)
        widget.streams["d"] = joining
        widget.actors.append(joining.actor)
        self.align(widget, [PRIMARY, RIGHT, LEFT])
        for stream in (moved, left, tiled):
            stream.move_to.assert_not_called()
        self.assertNotIn((joining.x, joining.y), {(29, 44), (2588, 100), (-1500, -250)})

        # Hidden then expanded: each comes back to its own spot.
        for stream in widget.streams.values():
            stream.window.winfo_ismapped.return_value = False
            stream.move_to.reset_mock()
        self.align(widget, [PRIMARY, RIGHT, LEFT])
        self.assertEqual((moved.x, moved.y, left.x, left.y), (2588, 100, -1500, -250))

        # Rebalance is the one reset: everything is tiled on the widget's display again.
        self.align(widget, [PRIMARY, RIGHT, LEFT], retile=True)
        self.assertFalse(moved.manual)
        for stream in widget.streams.values():
            self.assertTrue(0 <= stream.x < 1600 and 0 <= stream.y < 900, (stream.x, stream.y))

    def test_a_spot_on_a_display_that_is_gone_is_tiled_again(self):
        orphan = window("a", 2588, 100, mapped=False, manual=True)
        stuck = window("b", 2700, 500, mapped=True, manual=True)  # Its display was unplugged while open.
        widget = monitor_widget({"a": orphan, "b": stuck})
        widget.dismissed = {}
        self.align(widget, [PRIMARY])
        self.assertFalse(orphan.manual or stuck.manual)
        for stream in (orphan, stuck):
            self.assertTrue(0 <= stream.x < 1920, stream.x)

    def test_unreadable_displays_keep_saved_spots(self):
        moved = window("a", 2588, 100, mapped=False, manual=True)
        widget = monitor_widget({"a": moved})
        widget.dismissed = {}
        self.align(widget, [])
        moved.move_to.assert_called_once_with(2588, 100)

    def test_a_reopened_window_returns_to_its_last_spot_from_any_party(self):
        widget = GoblinWidget.__new__(GoblinWidget)
        widget.root_id = ""
        widget.thread_id = "party"
        widget.demo = False
        widget.connection = "CONNECTING"
        widget.actors = []
        widget.hidden_ids = set()
        widget.streams = {}
        widget.placements = {"a": {"x": -1500, "y": 30, "manual": True}}
        widget.stream_style = Mock(return_value={})
        widget.pinned_note = Mock(return_value=None)
        widget.pinned_undo = Mock(return_value=False)
        widget.save_position = Mock()
        with patch("desktop_widget.StreamWindow") as stream_class:
            widget.open_stream({"id": "a", "parentThreadId": "some-other-party"})
            widget.open_stream({"id": "fresh"})
        saved = [call.args[3] for call in stream_class.call_args_list]
        self.assertEqual(saved, [{"x": -1500, "y": 30, "placed": True, "manual": True}, None])

    def test_moving_a_peeked_window_makes_that_its_home(self):
        widget = GoblinWidget.__new__(GoblinWidget)
        widget.save_position = Mock()
        stream = Mock(actor_id="a", x=2600, y=90, manual=True)
        widget.peek_id, widget.peek_home = "a", (29, 44, True)
        widget.on_manual_stream_move(stream)
        self.assertEqual(widget.peek_home, (2600, 90, True))
        self.assertEqual(widget.placements, {"a": {"x": 2600, "y": 90, "manual": True}})
        widget.save_position.assert_called_once_with()


class LaunchpadNavigationTests(unittest.TestCase):
    def widget(self):
        widget = GoblinWidget.__new__(GoblinWidget)
        widget.demo = False
        widget.thread_id = "party"
        widget.hidden_ids = set()
        widget.connection = "LIVE"
        widget.actors = [{"id": "party"}, {"id": "helper", "parentThreadId": "party"}]
        widget.party_view = "expanded"
        widget.focused_stream_id = ""
        widget.watched_ids = []
        widget.watch_pending = None
        for name in ("condense_party", "open_party", "follow_source", "peek_member"):
            setattr(widget, name, Mock())
        return widget

    def test_goblin_click_on_loaded_party_opens_roster_and_peeks_without_reloading(self):
        widget = self.widget()
        widget.condense_party.side_effect = lambda: setattr(widget, "display_mode", "compact")

        widget.choose_party("party", "Party", "compact", focus_id="helper", peek=True)

        widget.condense_party.assert_called_once_with()
        widget.peek_member.assert_called_once_with("helper")
        widget.follow_source.assert_not_called()
        self.assertEqual(widget.party_view, "compact")

    def test_expand_chip_on_another_party_loads_it_as_streams(self):
        widget = self.widget()

        widget.choose_party("other", "Other work", "expanded")

        self.assertEqual(widget.party_view, "expanded")
        widget.follow_source.assert_called_once_with("other", "Other work", open_party=True,
                                                     focus_id="other")

    def test_board_uses_the_fuller_scene_for_the_selected_party(self):
        widget = self.widget()
        widget.board_actors = [{"id": "party", "status": "idle"},
                               {"id": "other", "status": "working",
                                "activities": [{"kind": "research", "title": "Searched"}]}]
        widget.actors = [{"id": "party", "status": "working", "activities": [{"kind": "file", "title": "Edit"}]},
                         {"id": "helper", "parentThreadId": "party", "status": "working",
                          "activities": [{"kind": "research", "title": "Searched"}]}]
        widget.source_catalog = []
        widget.board_order = []

        active, _recent, _older = widget.board_cards()

        party = next(card for card in active if card.id == "party")
        self.assertEqual([member["id"] for member in party.members], ["party", "helper"])
        self.assertIn("other", {card.id for card in active})

    def test_board_keeps_feed_classification_after_visiting_a_party(self):
        widget = self.widget()
        # A completed question from hours ago: the feed calls it quiet, the focused scene has no attention.
        old_question = {"id": "party", "status": "completed",
                        "turnStates": [{"status": "completed", "questions": ["Which one?"]}]}
        widget.board_actors = [{**old_question, "attention": "quiet"}]
        widget.source_catalog = []
        widget.board_order = []

        widget.thread_id = "all"
        before = widget.board_cards()
        widget.thread_id = "party"
        widget.actors = [dict(old_question)]
        after = widget.board_cards()

        for active, _recent, _older in (before, after):
            self.assertEqual(active, [])
            self.assertEqual(sum(card.needs for card in active), 0)


if __name__ == "__main__":
    unittest.main()
