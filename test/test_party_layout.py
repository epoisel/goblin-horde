"""The party layout must fit the display and keep urgent work visible."""

import unittest

from goblin_motion import goblin_action, member_status
from party_layout import (age_label, compact_active, coverage_note, launchpad_board, observed_loop, party_scope,
                          project_for, reachable, search_sources, stable_layout, tile_plan)

NOW = 1_800_000_000_000


def actor(number: int, status: str = "working", group: str = "party") -> dict:
    return {"id": f"agent-{number}", "source": "codex", "status": status,
            "workflowGroupId": group, "workflowName": group, "updatedAt": 1_800_000_000_000 + number}


class PartyLayoutTests(unittest.TestCase):
    def test_overflow_does_not_overlap_and_focus_can_replace_a_tile(self):
        actors = [actor(index) for index in range(13)]
        plan = tile_plan(actors, (0, 0, 1080, 1872), 506, 400, "agent-0", 1_800_000_100_000)
        self.assertEqual(plan.capacity, 8)
        self.assertEqual(len(plan.positions), 8)
        self.assertEqual(len(plan.hidden), 5)
        self.assertIn("agent-0", plan.positions)
        boxes = [(x, y, x + 506, y + 400) for x, y in plan.positions.values()]
        for index, first in enumerate(boxes):
            self.assertGreaterEqual(first[0], 0)
            self.assertLessEqual(first[2], 1080)
            self.assertLessEqual(first[3], 1872)
            for second in boxes[index + 1:]:
                self.assertTrue(first[2] <= second[0] or second[2] <= first[0] or
                                first[3] <= second[1] or second[3] <= first[1])

    def test_input_and_failure_outrank_completed_other_workflows(self):
        actors = [actor(index, "done", f"work-{index}") for index in range(10)]
        actors += [actor(10, "waiting", "urgent"), actor(11, "failed", "urgent")]
        plan = tile_plan(actors, (0, 0, 1080, 1872), 506, 400,
                         now_ms=1_800_000_100_000)
        self.assertIn("agent-10", plan.positions)
        self.assertIn("agent-11", plan.positions)

    def test_loop_marker_requires_observed_return(self):
        once = {"activities": [{"title": "Build"}, {"title": "Test"}]}
        repeated = {"activities": [{"title": "Build"}, {"title": "Test"},
                                   {"title": "Build"}]}
        self.assertFalse(observed_loop([once]))
        self.assertTrue(observed_loop([repeated]))

    def test_orca_members_share_workspace_party_and_project(self):
        member = {"id": "agent", "source": "orca", "parentThreadId": "workspace-id",
                  "cwd": "C:/workspaces/greenhouse/agent"}
        self.assertEqual(party_scope(member), "workspace-id")
        self.assertEqual(project_for(member), ("workspace:greenhouse", "greenhouse"))
        self.assertEqual(party_scope({"id": "codex-agent", "source": "codex",
                                      "parentThreadId": "codex-chat"}), "codex-chat")


def no_overlap(test, boxes, width=506, height=400):
    for index, first in enumerate(boxes):
        for second in boxes[index + 1:]:
            test.assertTrue(abs(first[0] - second[0]) >= width or abs(first[1] - second[1]) >= height,
                            f"{first} overlaps {second}")


class StableLayoutTests(unittest.TestCase):
    area = (0, 0, 1600, 900)

    def plan(self, count):
        return tile_plan([actor(index) for index in range(count)], self.area, 506, 400,
                         now_ms=1_800_000_100_000)

    def test_without_memory_it_is_the_ordinary_tiling(self):
        plan = self.plan(4)
        self.assertEqual(stable_layout(plan, {}, {}, 506, 400), plan.positions)

    def test_visible_window_never_moves_and_newcomer_takes_a_free_tile(self):
        plan = self.plan(3)
        dragged = {"agent-0": (900, 300)}
        placed = stable_layout(plan, dragged, {}, 506, 400)
        self.assertEqual(placed["agent-0"], (900, 300))
        self.assertEqual(set(placed), set(plan.positions))
        no_overlap(self, list(placed.values()))
        for spot in placed.values():
            self.assertIn(spot, plan.slots + ((900, 300),))

    def test_remembered_spot_returns_unless_a_visible_window_covers_it(self):
        plan = self.plan(2)
        home = plan.slots[4]
        self.assertEqual(stable_layout(plan, {}, {"agent-1": home}, 506, 400)["agent-1"], home)
        covered = stable_layout(plan, {"agent-0": home}, {"agent-1": home}, 506, 400)
        self.assertEqual(covered["agent-0"], home)
        self.assertNotEqual(covered["agent-1"], home)
        no_overlap(self, list(covered.values()))

    def test_newcomer_finds_a_free_spot_when_dragged_windows_cover_every_slot(self):
        plan = self.plan(3)
        dragged = {"agent-0": (288, 250), "agent-1": (1300, 250)}
        self.assertFalse([slot for slot in plan.slots
                          if all(abs(slot[0] - x) >= 506 or abs(slot[1] - y) >= 400 for x, y in dragged.values())])
        placed = stable_layout(plan, dragged, {}, 506, 400)
        self.assertEqual(placed["agent-2"], (794, 250))
        no_overlap(self, list(placed.values()))

    def test_without_any_free_spot_the_newcomer_shares_the_least_covered_slot(self):
        plan = self.plan(4)
        dragged = {"agent-0": (288, 250), "agent-1": (1065, 250), "agent-2": (29, 44)}
        placed = stable_layout(plan, dragged, {}, 506, 400)
        self.assertEqual(placed["agent-3"], (547, 44))

    def test_hand_placed_windows_stay_on_any_display_and_newcomers_avoid_them(self):
        plan = self.plan(2)  # agent-0 and agent-1 need tiles; the pinned ones are outside the plan.
        pinned = {"right": (2588, 100), "left": (-1500, -200), "here": (29, 44)}
        placed = stable_layout(plan, {}, {}, 506, 400, pinned)
        self.assertEqual({key: placed[key] for key in pinned}, pinned)
        self.assertEqual(set(placed), set(pinned) | set(plan.positions))
        # The pinned window on this display keeps its tile; the newcomers take the next free ones.
        self.assertEqual(sorted((placed["agent-0"], placed["agent-1"])), [(547, 44), (1065, 44)])
        no_overlap(self, [placed[key] for key in ("here", "agent-0", "agent-1")])
        # A pinned spot even wins over a visible window's memory of the same tile.
        both = stable_layout(plan, {"agent-0": (29, 44)}, {}, 506, 400, {"here": (29, 44)})
        self.assertEqual(both["here"], (29, 44))
        # With nobody needing a tile, only the pinned windows are placed.
        self.assertEqual(stable_layout(self.plan(0), {}, {}, 506, 400, pinned), pinned)


class ReachableTests(unittest.TestCase):
    grip = (103, 8, 498, 80)
    displays = [(0, 0, 1920, 1040), (1920, -300, 4480, 1140), (-1600, -200, 0, 700)]

    def test_spots_on_any_display_including_negative_ones_are_reachable(self):
        for spot in ((29, 44), (2588, 100), (2588, -250), (-1500, -150), (-1500, 600)):
            self.assertTrue(reachable(spot, self.grip, self.displays), spot)

    def test_a_spot_on_a_display_that_is_gone_or_with_its_header_off_screen_is_not(self):
        primary_only = self.displays[:1]
        self.assertFalse(reachable((2588, 100), self.grip, primary_only))
        self.assertFalse(reachable((-1500, -150), self.grip, primary_only))
        # Only a sliver of the header showing is not enough to grab it.
        self.assertFalse(reachable((1920 - 103 - 40, 100), self.grip, primary_only))
        self.assertFalse(reachable((100, -75), self.grip, primary_only))
        self.assertTrue(reachable((100, -40), self.grip, primary_only))

    def test_unknown_displays_trust_the_saved_spot(self):
        self.assertTrue(reachable((99_000, 99_000), self.grip, []))


class LaunchpadBoardTests(unittest.TestCase):
    def scene(self):
        building = {"id": "chat-a", "source": "codex", "status": "active", "cwd": "C:/work/alpha",
                    "turnStates": [{"status": "inProgress"}], "updatedAt": NOW - 1_000,
                    "activities": [{"kind": "file", "title": "Changed app.py", "status": "inProgress"}]}
        searcher = {"id": "orca-1", "source": "orca", "parentThreadId": "orca:ws", "status": "working",
                    "cwd": "C:/orca/workspaces/greenhouse/map", "updatedAt": NOW - 2_000,
                    "activities": [{"kind": "research", "title": "Searched the web"}]}
        finished_helper = {"id": "orca-2", "source": "orca", "parentThreadId": "orca:ws",
                           "status": "done", "updatedAt": NOW - 3_000, "activities": []}
        asking = {"id": "chat-b", "source": "codex", "status": "idle", "needsInput": True,
                  "updatedAt": NOW - 500_000, "activities": []}
        finished = {"id": "chat-done", "source": "codex", "status": "idle", "updatedAt": NOW - 60_000,
                    "activities": [{"kind": "update", "description": "All set."}]}
        catalog = [
            {"id": "chat-a", "name": "Alpha build", "source": "codex", "updatedAt": NOW - 1_000, "cwd": "C:/work/alpha"},
            {"id": "orca:ws", "name": "Orca · greenhouse", "source": "orca", "agentCount": 3,
             "updatedAt": NOW - 2_000, "cwd": "C:/orca/workspaces/greenhouse/map"},
            {"id": "chat-done", "name": "Finished chat", "source": "codex", "updatedAt": NOW - 60_000},
            {"id": "chat-b", "name": "Asks a question", "source": "codex", "updatedAt": NOW - 500_000},
        ] + [{"id": f"recent-{index}", "name": f"Recent {index}", "source": "codex",
              "updatedAt": NOW - (index + 2) * 3_600_000} for index in range(5)] + [
            {"id": "ancient", "name": "Ancient chat", "source": "codex", "updatedAt": NOW - 40 * 86_400_000}]
        return [building, searcher, finished_helper, asking, finished], catalog

    def test_working_and_recent_are_separate_and_old_chats_stay_off_screen(self):
        actors, catalog = self.scene()
        active, recent, older = launchpad_board(actors, catalog, now_ms=NOW)
        self.assertEqual([card.id for card in active], ["chat-b", "chat-a", "orca:ws"])
        self.assertTrue(all(card.active for card in active))
        self.assertEqual([card.id for card in recent], ["chat-done", "recent-0", "recent-1", "recent-2"])
        self.assertFalse(any(card.active for card in recent))
        self.assertEqual(older, len(catalog) - 7)
        self.assertNotIn("ancient", {card.id for card in active + recent})

    def test_party_groups_related_agents_with_honest_counts(self):
        actors, catalog = self.scene()
        workspace = next(card for card in launchpad_board(actors, catalog, now_ms=NOW)[0] if card.id == "orca:ws")
        self.assertEqual(workspace.name, "Orca · greenhouse")
        self.assertEqual(workspace.project, "greenhouse")
        self.assertEqual(workspace.source, "ORCA")
        self.assertEqual([member["id"] for member in workspace.members], ["orca-1", "orca-2"])
        self.assertEqual((workspace.working, workspace.agent_count), (1, 3))

    def test_rows_keep_their_order_but_attention_rises(self):
        actors, catalog = self.scene()
        active, _recent, _older = launchpad_board(actors, catalog, ["orca:ws", "chat-a"], now_ms=NOW)
        self.assertEqual([card.id for card in active], ["chat-b", "orca:ws", "chat-a"])

    def test_search_reaches_any_chat_and_prefers_title_matches(self):
        _actors, catalog = self.scene()
        catalog = catalog + [{"id": "path-only", "name": "Unrelated", "cwd": "C:/greenhouse-notes"}]
        found = [source["id"] for source in search_sources(catalog, "greenhouse")]
        self.assertEqual(found, ["orca:ws", "path-only"])
        self.assertEqual([source["id"] for source in search_sources(catalog, "ancient chat")], ["ancient"])
        self.assertEqual(len(search_sources(catalog, "", limit=3)), 3)

    def test_every_working_party_reaches_the_board_beyond_five(self):
        def working(index: int) -> dict:
            return {"id": f"busy-{index}", "source": "codex", "status": "notLoaded", "updatedAt": NOW - index * 1_000,
                    "turnStates": [{"status": "inProgress"}],
                    "activities": [{"kind": "file", "title": "Changed app.py", "status": "inProgress"}]}
        asking = {"id": "asks", "source": "codex", "status": "idle", "needsInput": True,
                  "updatedAt": NOW - 9 * 3_600_000, "activities": []}
        actors = [working(index) for index in range(9)] + [asking]
        catalog = [{"id": actor["id"], "name": actor["id"], "source": "codex", "updatedAt": actor["updatedAt"]}
                   for actor in actors]
        active, _recent, _older = launchpad_board(actors, catalog, now_ms=NOW)
        self.assertEqual(len(active), 10)
        self.assertEqual(active[0].id, "asks")
        rows, folded = compact_active(active, 6)
        self.assertEqual(len(rows), 6)
        self.assertEqual(folded, 4)
        self.assertEqual(rows[0].id, "asks")

    def test_compact_rows_never_fold_away_parties_that_need_you(self):
        def urgent(index: int) -> dict:
            return {"id": f"need-{index}", "source": "codex", "needsInput": True, "updatedAt": NOW - index}
        actors = [urgent(index) for index in range(7)] + [
            {"id": "busy", "source": "codex", "turnStates": [{"status": "inProgress"}], "updatedAt": NOW,
             "activities": [{"kind": "file", "title": "Changed app.py", "status": "inProgress"}]}]
        active, _recent, _older = launchpad_board(actors, [], now_ms=NOW)
        rows, folded = compact_active(active, 6)
        self.assertEqual(sorted(card.id for card in rows), sorted(f"need-{index}" for index in range(7)))
        self.assertEqual(folded, 1)
        self.assertEqual(compact_active([], 6), ([], 0))

    def test_board_follows_feed_attention_over_local_status(self):
        # The server calls a 12h-old finished question quiet; the local reading alone would say it asks you.
        old_question = {"id": "old-ask", "source": "codex", "status": "notLoaded", "attention": "quiet",
                        "updatedAt": NOW - 12 * 3_600_000, "activities": [],
                        "turnStates": [{"status": "completed", "questions": ["Ship it?"]}]}
        # Orca reports a blocked agent, which the server counts as working.
        blocked = {"id": "orca-blocked", "source": "orca", "parentThreadId": "orca:ws", "status": "blocked",
                   "attention": "working", "updatedAt": NOW - 1_000, "activities": []}
        self.assertEqual(member_status(old_question).word, "ASKED YOU")
        self.assertGreater(member_status(blocked).rank, 4)
        active, recent, _older = launchpad_board([old_question, blocked], [], now_ms=NOW)
        self.assertEqual([card.id for card in active], ["orca:ws"])
        self.assertEqual((active[0].needs, active[0].failed, active[0].working), (0, 0, 1))
        self.assertEqual([card.id for card in recent], ["old-ask"])
        self.assertEqual((recent[0].needs, recent[0].active), (0, False))
        # Animation keeps its own reading.
        self.assertEqual(goblin_action(old_question), "waiting")

    def test_board_falls_back_to_local_status_without_feed_attention(self):
        asking = {"id": "asks", "source": "codex", "status": "idle", "needsInput": True, "updatedAt": NOW}
        failed_orca = {"id": "orca-x", "source": "orca", "status": "failed", "attention": "failed", "updatedAt": NOW}
        waiting_orca = {"id": "orca-w", "source": "orca", "status": "waiting", "attention": "waiting", "updatedAt": NOW}
        active, _recent, _older = launchpad_board([asking, failed_orca, waiting_orca], [], now_ms=NOW)
        counts = {card.id: (card.needs, card.failed) for card in active}
        self.assertEqual(counts, {"asks": (1, 0), "orca-x": (0, 1), "orca-w": (1, 0)})

    def test_coverage_note_names_the_gap_instead_of_claiming_everything(self):
        self.assertEqual(coverage_note(None), "")
        self.assertEqual(coverage_note({"complete": True, "codexPending": 0}), "")
        self.assertEqual(coverage_note({"complete": False, "codexPending": 1}), "CHECKING 1 CHAT")
        self.assertEqual(coverage_note({"complete": False, "codexPending": 12}), "CHECKING 12 CHATS")
        self.assertEqual(coverage_note({"complete": False, "activeTotal": 70, "activeShown": 60}),
                         "TOO MANY ACTIVE TO LIST")
        self.assertEqual(coverage_note({"complete": False, "codexAvailable": False, "codexListComplete": False}),
                         "CODEX UNAVAILABLE")
        self.assertEqual(coverage_note({"complete": False, "codexFailed": 2}), "SOME CHATS UNREADABLE")
        self.assertEqual(coverage_note({"complete": False, "codexListComplete": False}), "CHAT LIST CUT SHORT")
        self.assertEqual(coverage_note({"complete": False, "orcaAvailable": False}), "ORCA UNAVAILABLE")
        self.assertEqual(coverage_note({"complete": False}), "PARTIAL FEED")

    def test_age_labels_are_short(self):
        self.assertEqual(age_label(NOW - 10_000, NOW), "now")
        self.assertEqual(age_label(NOW - 5 * 60_000, NOW), "5m ago")
        self.assertEqual(age_label(NOW - 3 * 3_600_000, NOW), "3h ago")
        self.assertEqual(age_label(NOW - 3 * 86_400_000, NOW), "3d ago")
        self.assertEqual(age_label(0, NOW), "")


if __name__ == "__main__":
    unittest.main()
