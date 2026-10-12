import time
import unittest
from unittest.mock import Mock, patch

from goblin_cues import ActionClock
from stream_windows import StreamWindow, group_color, workflow_for


class WorkflowGroupingTests(unittest.TestCase):
    def test_orca_agents_in_sibling_worktrees_share_project_group(self):
        first = {"source": "orca", "id": "a", "cwd": "C:/orca/workspaces/courtyard-duo/map"}
        second = {"source": "orca", "id": "b", "cwd": "C:/orca/workspaces/courtyard-duo/enemies"}
        self.assertEqual(workflow_for(first), workflow_for(second))

    def test_codex_children_share_parent_group(self):
        first = {"source": "codex", "id": "a", "parentThreadId": "parent", "workflowName": "Widget review"}
        second = {"source": "codex", "id": "b", "parentThreadId": "parent", "workflowName": "Widget review"}
        self.assertEqual(workflow_for(first), workflow_for(second))

    def test_root_and_child_can_share_explicit_workflow(self):
        root = {"source": "codex", "id": "parent", "workflowGroupId": "codex-parent:parent", "workflowName": "Widget review"}
        child = {"source": "codex", "id": "child", "parentThreadId": "parent", "workflowGroupId": "codex-parent:parent", "workflowName": "Widget review"}
        self.assertEqual(workflow_for(root), workflow_for(child))

    def test_codex_chats_in_same_workspace_share_group(self):
        first = {"source": "codex", "id": "a", "cwd": "C:/project/work"}
        second = {"source": "codex", "id": "b", "cwd": "C:/project/work"}
        self.assertEqual(workflow_for(first), workflow_for(second))

    def test_group_color_is_stable(self):
        key, _ = workflow_for({"source": "codex", "id": "a", "cwd": "C:/project/work"})
        self.assertEqual(group_color(key), group_color(key))

    def test_first_shared_scene_replaces_saved_placeholder_position(self):
        stream = StreamWindow.__new__(StreamWindow)
        stream.loaded_focused = False
        stream.visible_start = 0
        stream.fingerprint = "saved-placeholder"
        stream.rendered_signatures = [("old",)]
        stream.unread = 3
        stream.render_actor = Mock()
        actor = {"id": "child", "activities": [{"id": "fresh"}]}

        stream.receive_actor(actor, "LIVE")

        self.assertTrue(stream.loaded_focused)
        self.assertIsNone(stream.visible_start)
        self.assertEqual(stream.rendered_signatures, [])
        self.assertEqual(stream.unread, 0)
        stream.render_actor.assert_called_once_with(actor, "LIVE")


def motion_stream(owner, action="build", mapped=True):
    stream = StreamWindow.__new__(StreamWindow)
    stream.owner = owner
    stream.style = {}
    stream.sprite = Mock()
    stream.window = Mock()
    stream.window.winfo_ismapped.return_value = mapped
    stream.closed = False
    stream.motion_frame = 0
    stream.motion_clock = ActionClock()
    stream.motion_preview = False
    stream.state_label = Mock()
    stream.model_label = Mock()
    stream.render_actor = Mock()
    stream.actor = Mock()
    stream.connection = Mock()
    stream.current_action = Mock(return_value=action)
    stream.actor_id = "a"
    stream.roster = Mock()
    stream.roster_cells = []
    return stream


def roster_stream(owner, actions, mapped=True):
    """A stream for member 'a' whose roster shows each member in ``actions``."""
    stream = motion_stream(owner, action=actions["a"], mapped=mapped)
    stream.connection = "LIVE"
    stream.roster_cells = [(f"roster-{index}", 0, 0, {}, {"id": member_id})
                           for index, member_id in enumerate(actions)]
    owner.sprite_action = Mock(side_effect=lambda actor, _connection: actions[actor["id"]])
    return stream


def roster_draws(owner):
    return [(call.kwargs["tag"], call.kwargs["action"], call.kwargs["frame"], call.kwargs["still"])
            for call in owner.draw_sprite.call_args_list if call.kwargs.get("tag")]


def motion_owner():
    owner = Mock(paused=False, reduced_motion=False, party_mode=False)
    owner.visible_stream_ids = set()
    # The old shared clock lived on the owner; keep a real one there to catch a regression.
    owner.motion_clock = ActionClock()
    return owner


def run_search_then_build(stream):
    """Start 'build' late, so a stale start tick would hold a fresh cycle on frame 0."""
    stream.current_action.return_value = "search"
    for _ in range(6):
        stream.animate_sprite()
    stream.current_action.return_value = "build"
    for _ in range(6):
        stream.animate_sprite()


def drawn_frames(owner):
    return [call.kwargs["frame"] for call in owner.draw_sprite.call_args_list]


class StreamMotionTests(unittest.TestCase):
    def test_a_reopened_stream_advances_from_its_first_frame(self):
        owner = motion_owner()
        run_search_then_build(motion_stream(owner))
        owner.draw_sprite.reset_mock()

        reopened = motion_stream(owner)
        for _ in range(4):
            reopened.animate_sprite()

        self.assertEqual(drawn_frames(owner), [0, 1, 2, 3])

    def test_motion_advances_after_a_preview_reset(self):
        owner = motion_owner()
        stream = motion_stream(owner)
        run_search_then_build(stream)
        stream.toggle_motion_preview()
        stream.toggle_motion_preview()
        stream.render_actor.assert_called_once_with(stream.actor, stream.connection)
        self.assertEqual(stream.motion_frame, 0)
        owner.draw_sprite.reset_mock()

        for _ in range(4):
            stream.animate_sprite()

        self.assertEqual(drawn_frames(owner), [0, 1, 2, 3])

    def test_a_hidden_stream_keeps_time_without_repainting(self):
        owner = motion_owner()
        stream = motion_stream(owner, mapped=False)
        for _ in range(3):
            stream.animate_sprite()

        owner.draw_sprite.assert_not_called()
        self.assertEqual(stream.motion_frame, 3)
        self.assertEqual(stream.window.after.call_count, 3)

    def test_a_visible_stream_repaints_every_beat(self):
        owner = motion_owner()
        stream = motion_stream(owner)
        for _ in range(3):
            stream.animate_sprite()

        self.assertEqual(owner.draw_sprite.call_count, 3)


class RosterMotionTests(unittest.TestCase):
    def test_each_tile_keeps_its_own_beat_and_a_changed_action_restarts_only_that_tile(self):
        owner = motion_owner()
        actions = {"a": "think", "b": "search", "c": "build"}
        stream = roster_stream(owner, actions)
        for _ in range(3):
            stream.animate_sprite()
        actions["c"] = "trouble"
        for _ in range(2):
            stream.animate_sprite()

        draws = roster_draws(owner)
        frames = {tag: [frame for drawn, _action, frame, _still in draws if drawn == tag]
                  for tag in ("roster-0", "roster-1", "roster-2")}
        self.assertEqual(frames["roster-0"], [0, 1, 2, 3, 4])
        self.assertEqual(frames["roster-1"], [0, 1, 2, 3, 4])
        self.assertEqual(frames["roster-2"], [0, 1, 2, 0, 1])
        # The selected tile follows the stream's own portrait; the rest use party data.
        self.assertEqual({action for tag, action, *_ in draws if tag == "roster-0"}, {"think"})
        self.assertEqual([action for tag, action, *_ in draws if tag == "roster-2"],
                         ["build"] * 3 + ["trouble"] * 2)
        stream.roster.tag_raise.assert_called_with("badge")

    def test_party_change_paints_the_new_action_on_its_first_frame(self):
        owner = motion_owner()
        actions = {"a": "idle", "b": "search"}
        stream = roster_stream(owner, actions)
        stream.paint_roster()
        self.assertEqual(roster_draws(owner), [("roster-0", "idle", 0, False), ("roster-1", "search", 0, False)])

    def test_reduced_motion_paints_one_still_frame_and_beats_do_not_repaint(self):
        owner = motion_owner()
        owner.reduced_motion = True
        stream = roster_stream(owner, {"a": "build", "b": "waiting"})
        for _ in range(3):
            stream.animate_sprite()
        owner.draw_sprite.assert_not_called()

        stream.paint_roster()
        self.assertEqual([still for *_rest, still in roster_draws(owner)], [True, True])

    def test_an_unconfirmed_feed_rests_the_roster_without_repainting(self):
        owner = motion_owner()
        stream = roster_stream(owner, {"a": "idle", "b": "build"})
        for connection in ("CONNECTING", "STALE", "OFFLINE"):
            stream.connection = connection
            self.assertTrue(stream.roster_still())
            stream.animate_sprite()
        self.assertEqual(roster_draws(owner), [])

    def test_a_withdrawn_stream_does_not_repaint_its_roster(self):
        owner = motion_owner()
        stream = roster_stream(owner, {"a": "build", "b": "search"}, mapped=False)
        for _ in range(3):
            stream.animate_sprite()
        owner.draw_sprite.assert_not_called()
        self.assertEqual(stream.motion_frame, 3)

    def test_an_unchanged_flow_does_not_rebuild_the_rail(self):
        stream = StreamWindow.__new__(StreamWindow)
        stream.flow_loop, stream.flow_visible, stream.flow_total = False, 0, 0
        stream.party = [{"id": "a"}]
        stream.set_party = Mock()
        stream.refresh_group_label = Mock()

        stream.set_flow(True, 2, 3)
        stream.set_flow(True, 2, 3)
        self.assertEqual(stream.set_party.call_count, 1)
        self.assertEqual(stream.refresh_group_label.call_count, 1)

        stream.set_flow(True, 1, 3)
        self.assertEqual((stream.flow_loop, stream.flow_visible, stream.flow_total), (True, 1, 3))
        self.assertEqual(stream.set_party.call_count, 2)
        self.assertEqual(stream.refresh_group_label.call_count, 2)

    def test_set_party_can_defer_painting_to_the_caller(self):
        owner = motion_owner()
        owner.visible_stream_ids = {"a"}
        owner.stream_style = Mock(return_value={"accent": "#000"})
        stream = roster_stream(owner, {"a": "think", "b": "build"})
        stream.roster_row_offset = 0
        stream.flow_visible = 0
        stream.roster_hint = Mock()
        party = [{"id": "a"}, {"id": "b"}]

        stream.set_party(party, paint=False)
        self.assertEqual(roster_draws(owner), [])
        self.assertEqual(len(stream.roster_cells), 2)

        stream.paint_roster()
        self.assertEqual(roster_draws(owner), [("roster-0", "think", 0, False),
                                               ("roster-1", "build", 0, False)])

    def test_hover_names_the_member_and_the_action_its_cue_shows(self):
        owner = motion_owner()
        stream = roster_stream(owner, {"a": "idle", "b": "waiting"})
        stream.party = [{"id": "a"}, {"id": "b"}]
        stream.roster_row_offset = 0
        stream.roster_hint = Mock()
        owner.display_name = Mock(return_value="A goblin with a long name")
        stream.on_roster_hover(Mock(x=60, y=20))
        text = stream.roster_hint.configure.call_args.kwargs["text"]
        self.assertTrue(text.endswith("NEEDS YOU"), text)
        self.assertLessEqual(len(text), 16)

    def test_hit_targets_follow_tiles_and_scrolling(self):
        from stream_windows import ROSTER_COLUMNS, ROSTER_ROWS, ROSTER_STEP_X, ROSTER_STEP_Y

        stream = StreamWindow.__new__(StreamWindow)
        stream.party = [{"id": str(index)} for index in range(13)]
        for offset in (0, 2):
            stream.roster_row_offset = offset
            for row in range(ROSTER_ROWS):
                for column in range(ROSTER_COLUMNS):
                    x = 1 + column * ROSTER_STEP_X + 25
                    y = 1 + row * ROSTER_STEP_Y + 22
                    index = (row + offset) * ROSTER_COLUMNS + column
                    expected = stream.party[index] if index < 13 else None
                    self.assertIs(stream.roster_actor_at(x, y), expected)
        self.assertIsNone(stream.roster_actor_at(1 + 2 * ROSTER_STEP_X + 5, 10))


class SharedPulseTests(unittest.TestCase):
    """A new finished step makes the portrait and every party tile act it out together."""

    def setUp(self):
        from desktop_widget import GoblinWidget
        from goblin_motion import ActionPulse

        self.owner = GoblinWidget.__new__(GoblinWidget)
        self.owner.action_pulses = ActionPulse()
        self.owner.reduced_motion = False
        self.stream = StreamWindow.__new__(StreamWindow)
        self.stream.owner = self.owner
        self.stream.actor_id = "g1"
        self.stream.connection = "LIVE"
        self.before = {"id": "g1", "status": "idle", "turnStates": [{"status": "completed"}],
                       "activities": [{"id": "e1", "kind": "file", "title": "Changed app.py", "status": "completed"}]}
        self.after = {**self.before, "activities": self.before["activities"] + [
            {"id": "e2", "kind": "command", "title": "Read a local file", "status": "completed", "exitCode": 0}]}

    def show(self, actor):
        self.stream.actor = actor
        return (self.stream.current_action(), self.owner.sprite_action(actor, "LIVE"),
                self.stream.member_action({"id": "g1"}))

    def test_portrait_tile_and_dock_agree_on_the_magnifier(self):
        self.assertEqual(self.show(self.before), ("idle", "idle", "idle"))
        self.assertEqual(self.show(self.after), ("search", "search", "search"))

    def test_stale_feed_and_still_mode_keep_the_goblin_resting(self):
        self.show(self.before)
        self.stream.connection = "STALE"
        self.assertEqual(self.stream.current_action(), "idle")
        self.assertEqual(self.owner.sprite_action(self.after, "OFFLINE"), "idle")
        self.owner.reduced_motion = True
        self.stream.connection = "LIVE"
        self.assertEqual(self.show(self.after), ("idle", "idle", "idle"))

    def line_owner(self, connection):
        """Just enough of the widget to paint one goblin-line sprite."""
        owner = self.owner
        owner.canvas = Mock()
        owner.phase = 0
        owner.demo = False
        owner.attention = ""
        owner.root_id = ""
        owner.connection = connection
        owner.motion_clock = ActionClock()
        owner.draw_sprite = Mock()
        return owner

    def test_the_goblin_line_obeys_the_stale_guard_like_every_surface(self):
        self.show(self.before)
        owner = self.line_owner("STALE")
        owner.paint_overview_sprite(0, self.after, {})
        self.assertEqual(owner.draw_sprite.call_args.kwargs["action"], "idle")
        owner.connection = "LIVE"
        owner.paint_overview_sprite(0, self.after, {})
        self.assertEqual(owner.draw_sprite.call_args.kwargs["action"], "search")

    def test_the_header_names_the_model_in_its_tribe_colour(self):
        self.show(self.before)
        self.stream.state_label = Mock()
        self.stream.model_label = Mock()
        self.stream.actor = {**self.after, "model": {"id": "gpt-5.6-sol", "label": "GPT-5.6 Sol",
                                                     "family": "openai", "effort": "xhigh"}}
        self.stream.refresh_state(force=True)
        shown = self.stream.model_label.configure.call_args.kwargs
        self.assertEqual(shown["text"], "◈ GPT-5.6 SOL · XHIGH")
        self.assertEqual(shown["fg"], "#8fcbd6")
        # A source that names no model shows no badge.
        self.stream.actor = {**self.after, "model": None}
        self.stream.refresh_state(force=True)
        self.assertEqual(self.stream.model_label.configure.call_args.kwargs["text"], "")

    def test_the_header_names_a_replayed_step_in_the_past_tense_until_it_ends(self):
        self.show(self.before)
        self.assertEqual(self.show(self.after)[0], "search")
        self.stream.actor = self.after
        self.stream.state_label = Mock()
        self.stream.model_label = Mock()
        self.stream.refresh_state()
        text = self.stream.state_label.configure.call_args.kwargs["text"]
        self.assertIn("CHECKED", text)
        self.assertNotIn("IDLE", text)
        # Once the pulse is over the next beat's check says IDLE again, without a new poll.
        with patch("goblin_motion.time.time", return_value=time.time() + 10):
            self.stream.refresh_state()
        self.assertIn("IDLE", self.stream.state_label.configure.call_args.kwargs["text"])
        # A beat with nothing new does not touch the label.
        calls = self.stream.state_label.configure.call_count
        with patch("goblin_motion.time.time", return_value=time.time() + 10):
            self.stream.refresh_state()
        self.assertEqual(self.stream.state_label.configure.call_count, calls)


class RosterLabelTests(unittest.TestCase):
    def test_the_tile_count_counts_live_members_only(self):
        owner = motion_owner()
        owner.visible_stream_ids = {"a", "b", "gone"}
        owner.stream_style = Mock(return_value={"accent": "#000"})
        stream = roster_stream(owner, {"a": "idle", "b": "idle"})
        stream.roster_row_offset = 0
        stream.roster_hint = Mock()
        # Three windows are on screen, but one is a retired member's pinned note.
        stream.flow_visible = 3
        stream.set_party([{"id": "a"}, {"id": "b"}], paint=False)
        self.assertEqual(stream.roster_hint.configure.call_args.kwargs["text"], "2/2 TILES")

    def test_hover_on_a_resting_goblin_replaying_a_step_says_what_it_did(self):
        owner = motion_owner()
        stream = roster_stream(owner, {"a": "idle", "b": "search"})
        stream.party = [{"id": "a"}, {"id": "b"}]
        stream.roster_row_offset = 0
        stream.roster_hint = Mock()
        owner.display_name = Mock(return_value="Reader")
        stream.on_roster_hover(Mock(x=60, y=20))
        self.assertEqual(stream.roster_hint.configure.call_args.kwargs["text"], "Reader CHECKED")

    def test_hover_on_a_closed_members_tile_offers_to_open_it(self):
        owner = motion_owner()
        owner.party_mode = True
        owner.visible_stream_ids = {"a"}
        stream = roster_stream(owner, {"a": "idle", "b": "build"})
        stream.party = [{"id": "a"}, {"id": "b"}]
        stream.roster_row_offset = 0
        stream.roster_hint = Mock()
        owner.display_name = Mock(return_value="Closed goblin")
        stream.on_roster_hover(Mock(x=60, y=20))
        text = stream.roster_hint.configure.call_args.kwargs["text"]
        self.assertTrue(text.endswith("▸ OPEN"), text)
        self.assertLessEqual(len(text), 16)


def placed_stream(x=100, y=50, placed=True, manual=False):
    """A stream at (x, y) whose window reports the same spot unless a test moves it."""
    stream = StreamWindow.__new__(StreamWindow)
    stream.owner = Mock()
    stream.window = Mock()
    stream.window.winfo_ismapped.return_value = True
    stream.window.winfo_x.return_value, stream.window.winfo_y.return_value = x, y
    stream.closed = False
    stream.drag_origin = None
    stream.os_move_after = None
    stream.moved_at = 0.0
    stream.x, stream.y, stream.placed, stream.manual = x, y, placed, manual
    stream.actor_id = "a"
    return stream


class ManualPlacementTests(unittest.TestCase):
    def test_negative_coordinates_are_written_from_the_left_and_top(self):
        from stream_windows import screen_geometry
        # Tk reads "-1500" as 1500 pixels in from the right edge, which is a different display.
        self.assertEqual(screen_geometry(-1500, -200), "+-1500+-200")
        self.assertEqual(screen_geometry(2588, 40), "+2588+40")
        stream = placed_stream()
        stream.move_to(-1500, 30)
        stream.window.geometry.assert_called_once_with("+-1500+30")
        self.assertEqual((stream.x, stream.y), (-1500, 30))

    def test_a_drag_to_another_display_is_a_manual_spot_and_a_click_is_not(self):
        stream = placed_stream(placed=True, manual=False)
        stream.start_drag(Mock(x_root=10, y_root=10))
        stream.drag(Mock(x_root=12, y_root=11))
        stream.end_drag(Mock())
        self.assertFalse(stream.manual)
        stream.owner.on_manual_stream_move.assert_called_once_with(stream)

        stream.start_drag(Mock(x_root=10, y_root=10))
        stream.drag(Mock(x_root=2510, y_root=40))
        stream.end_drag(Mock())
        self.assertEqual((stream.x, stream.y, stream.placed, stream.manual), (2600, 80, True, True))

    def test_a_move_made_by_windows_is_adopted_but_the_apps_own_move_is_not(self):
        stream = placed_stream(100, 50)
        # Win+Shift+Arrow put it on a display left of the primary.
        stream.window.winfo_x.return_value, stream.window.winfo_y.return_value = -1800, 120
        stream.adopt_os_move()
        self.assertEqual((stream.x, stream.y, stream.placed, stream.manual), (-1800, 120, True, True))
        stream.owner.on_manual_stream_move.assert_called_once_with(stream)

        # Right after the app moves it, a stale report of the old spot is not a person's move.
        echo = placed_stream(100, 50)
        echo.move_to(400, 50)
        echo.adopt_os_move()
        self.assertEqual((echo.x, echo.y, echo.manual), (400, 50, False))
        # A withdrawn window, or one reporting where the app put it, changes nothing either.
        hidden = placed_stream(100, 50)
        hidden.window.winfo_ismapped.return_value = False
        hidden.window.winfo_x.return_value = 900
        hidden.adopt_os_move()
        self.assertEqual((hidden.x, hidden.manual), (100, False))
        steady = placed_stream(100, 50)
        steady.adopt_os_move()
        steady.owner.on_manual_stream_move.assert_not_called()

    def test_only_the_windows_own_configure_schedules_a_check(self):
        stream = placed_stream()
        stream.window.after.return_value = "after-1"
        stream.on_configure(Mock(widget=Mock()))  # A child widget resizing.
        stream.window.after.assert_not_called()
        stream.on_configure(Mock(widget=stream.window))
        stream.window.after.assert_called_once_with(400, stream.adopt_os_move)
        self.assertEqual(stream.os_move_after, "after-1")

    def test_a_direct_check_cancels_the_pending_one(self):
        # Otherwise the orphaned timer outlives the window and Tk reports an invalid command.
        stream = placed_stream()
        stream.os_move_after = "after-1"
        stream.adopt_os_move()
        stream.window.after_cancel.assert_called_once_with("after-1")
        self.assertIsNone(stream.os_move_after)

    def test_saved_state_keeps_the_manual_flag(self):
        stream = placed_stream(2588, 100, manual=True)
        for name in ("actor", "show_details"):
            setattr(stream, name, {"id": "a"} if name == "actor" else False)
        stream.party_id = "old-party"
        self.assertEqual({key: stream.state()[key] for key in ("x", "y", "placed", "manual", "party")},
                         {"x": 2588, "y": 100, "placed": True, "manual": True, "party": "old-party"})


if __name__ == "__main__":
    unittest.main()
