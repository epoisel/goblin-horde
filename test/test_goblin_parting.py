"""Retirement rules and parting notes, from synthetic party reads only."""

import time
import unittest

from goblin_parting import (EXCERPT_LIMIT, MARKER_DAYS, MARKER_LIMIT, NOTE_DAYS, NOTE_LIMIT, PARTY_LIMIT,
                            PartingNotes, RetirementTracker, clean_marker, clean_note, ending, note_lines,
                            outcome_word, parting_note)

PARTY = "party-chat"
NOW = time.time() * 1000


def codex(member_id, turn="inProgress", *, status=None, activities=None, questions=None, **extra):
    """A Codex child agent with one turn in the given state."""
    return {"id": member_id, "source": "codex", "name": f"Goblin {member_id}", "parentThreadId": PARTY,
            "status": status or ("active" if turn == "inProgress" else "idle"), "updatedAt": NOW - 60_000,
            "turnStates": [{"id": "t1", "status": turn, "questions": questions or []}],
            "activities": activities if activities is not None else [
                {"id": f"{member_id}-1", "kind": "file", "title": "Changed app.py", "description": "app.py",
                 "status": "inProgress" if turn == "inProgress" else "completed"}],
            **extra}


def orca(member_id, state):
    return {"id": member_id, "source": "orca", "name": f"Orca {member_id}", "parentThreadId": "orca:ws",
            "status": state, "updatedAt": NOW, "turnStates": [],
            "activities": [{"id": f"{member_id}-tool", "kind": "tool", "title": "Used Bash",
                            "description": "Ran a local command.", "detail": "rm -rf secret-build",
                            "status": "inProgress" if state == "working" else "completed"}]}


def kinds(transitions):
    return [(change.kind, change.actor_id, change.outcome) for change in transitions]


class EndingTests(unittest.TestCase):
    def test_only_a_clear_end_counts(self):
        self.assertEqual(ending(codex("a", "completed")), "finished")
        self.assertEqual(ending(codex("a", "interrupted")), "stopped")
        self.assertEqual(ending(orca("o", "done")), "finished")
        for actor in (codex("a"), codex("a", "failed"), codex("a", "completed", questions=["Which one?"]),
                      codex("a", "completed", needsInput=True), codex("a", "completed", status="active"),
                      codex("a", "completed", activities=[{"kind": "command", "title": "Ran project tests",
                                                           "exitCode": 1}]),
                      orca("o", "waiting"), orca("o", "working"), {"id": "x", "source": "other", "status": "done"},
                      {**codex("a", "completed"), "turnStates": []}):
            self.assertIsNone(ending(actor), actor)


class TrackerTests(unittest.TestCase):
    def setUp(self):
        self.tracker = RetirementTracker()

    def read(self, *agents, complete=True, root="root-chat"):
        return self.tracker.observe(PARTY, root, list(agents), complete=complete)

    def test_a_seen_worker_retires_after_two_good_reads(self):
        self.assertEqual(kinds(self.read(codex("a"))[0]), [])
        self.assertEqual(kinds(self.read(codex("a", "completed"))[0]), [])
        self.assertEqual(kinds(self.read(codex("a", "completed"))[0]), [("retired", "a", "finished")])
        # Later reads of the same finished member never retire it again.
        for _ in range(4):
            self.assertEqual(kinds(self.read(codex("a", "completed"))[0]), [])
        self.assertEqual(self.tracker.retired(PARTY), {"a": "finished"})

    def test_root_demo_and_unknowns_never_retire(self):
        no_turn = {**codex("no-turn", "completed"), "turnStates": []}
        for _ in range(4):
            transitions, held = self.read(codex("root-chat", "completed"), codex(PARTY, "completed"),
                                          codex("demo-1", "completed"), {"id": "", "status": "done"},
                                          no_turn, {"id": "plain", "source": "codex", "status": "idle"},
                                          {"id": "other", "source": "other", "status": "done"})
            self.assertEqual(kinds(transitions), [])
            self.assertEqual(held, [])

    def test_a_first_seen_terminal_turn_retires_after_two_good_reads(self):
        # The viewer never saw it work: the source's own completed turn is the evidence.
        self.assertEqual(kinds(self.read(codex("done-at-start", "completed"))[0]), [])
        self.assertEqual(kinds(self.read(codex("done-at-start", "completed"))[0]),
                         [("retired", "done-at-start", "finished")])
        self.assertEqual(self.tracker.retired(PARTY), {"done-at-start": "finished"})
        # Interrupted and Orca-done members part the same way, with their own outcome.
        self.read(codex("cut", "interrupted"), orca("o", "done"))
        self.assertEqual(sorted(kinds(self.read(codex("cut", "interrupted"), orca("o", "done"))[0])),
                         [("retired", "cut", "stopped"), ("retired", "o", "finished")])

    def test_a_restart_parts_old_terminal_children_once_and_never_replays(self):
        """Five children whose last turns completed long before the viewer started (status notLoaded)."""
        old = [codex(f"c{index}", "completed", status="notLoaded") for index in range(5)]
        self.assertEqual(kinds(self.read(*old)[0]), [])
        self.assertEqual(sorted(kinds(self.read(*old)[0])),
                         [("retired", f"c{index}", "finished") for index in range(5)])
        # A restart keeps the markers but not the observation memory: nobody parts twice.
        again = RetirementTracker()
        again.load(self.tracker.to_json(), NOW)
        for _ in range(3):
            self.assertEqual(kinds(again.observe(PARTY, "root-chat", old, complete=True)[0]), [])
        # A restart before anyone parted starts the two-read count over.
        fresh = RetirementTracker()
        self.assertEqual(kinds(fresh.observe(PARTY, "root-chat", old[:1], complete=True)[0]), [])
        self.assertEqual(kinds(fresh.observe(PARTY, "root-chat", old[:1], complete=True)[0]),
                         [("retired", "c0", "finished")])

    def test_an_ending_must_hold_unchanged_across_both_reads(self):
        first = codex("a", "completed")
        self.read(first)
        # A new public event between reads means it has not settled: the count restarts.
        later = {**first, "activities": first["activities"] + [
            {"id": "a-2", "kind": "update", "title": "Answer", "description": "One more thing."}]}
        self.assertEqual(kinds(self.read(later)[0]), [])
        # So does a different ending; a warned read in between neither confirms nor cancels.
        self.assertEqual(kinds(self.read({**later, "turnStates": [{"id": "t1", "status": "interrupted"}]})[0]), [])
        self.assertEqual(kinds(self.read(later)[0]), [])
        self.assertEqual(kinds(self.read(later, complete=False)[0]), [])
        self.assertEqual(kinds(self.read(later)[0]), [("retired", "a", "finished")])

    def test_first_seen_failed_waiting_and_asking_members_stay(self):
        for _ in range(4):
            transitions, _ = self.read(codex("f", "failed"), orca("w", "waiting"),
                                       codex("q", "completed", questions=["Ship it?"]),
                                       codex("n", "completed", needsInput=True),
                                       codex("e", "completed", activities=[{"id": "e-1", "kind": "command",
                                                                            "title": "Ran tests", "exitCode": 1}]))
            self.assertEqual(kinds(transitions), [])

    def test_failed_and_waiting_members_stay(self):
        self.read(codex("f"), orca("w", "working"), codex("q"))
        for _ in range(3):
            transitions, _ = self.read(codex("f", "failed"), orca("w", "waiting"),
                                       codex("q", "completed", questions=["Ship it?"]))
            self.assertEqual(kinds(transitions), [])

    def test_partial_reads_neither_confirm_nor_cancel(self):
        self.read(orca("o", "working"))
        self.read(orca("o", "done"))
        for _ in range(3):
            self.assertEqual(kinds(self.read(orca("o", "done"), complete=False)[0]), [])
        self.assertEqual(kinds(self.read(orca("o", "done"))[0]), [("retired", "o", "finished")])

    def test_new_work_between_reads_restarts_the_count(self):
        self.read(codex("a"))
        self.read(codex("a", "completed"))
        self.read(codex("a"))
        self.assertEqual(kinds(self.read(codex("a", "completed"))[0]), [])
        self.assertEqual(kinds(self.read(codex("a", "completed"))[0]), [("retired", "a", "finished")])

    def test_reactivation_revives_and_a_thin_read_does_not(self):
        self.read(codex("a"))
        self.read(codex("a", "completed"))
        self.read(codex("a", "completed"))
        # A read without turns is missing detail, not evidence of new work.
        self.assertEqual(kinds(self.read({**codex("a", "completed"), "turnStates": []})[0]), [])
        self.assertEqual(kinds(self.read(codex("a"))[0]), [("revived", "a", "")])
        self.assertEqual(self.tracker.retired(PARTY), {})
        # Revived members retire again only through the same two-read rule.
        self.read(codex("a", "completed"))
        self.assertEqual(kinds(self.read(codex("a", "completed"))[0]), [("retired", "a", "finished")])

    def test_a_vanished_worker_is_held_then_left_after_two_complete_reads(self):
        self.read(orca("a", "working"), orca("b", "working"), orca("c", "working"))
        transitions, held = self.read(orca("a", "working"), orca("c", "working"))
        self.assertEqual(kinds(transitions), [])
        self.assertEqual([(index, actor["id"]) for index, actor in held], [(1, "b")])
        transitions, held = self.read(orca("a", "working"), orca("c", "working"))
        self.assertEqual(kinds(transitions), [("retired", "b", "left")])
        self.assertEqual(transitions[0].index, 1)
        self.assertEqual(held, [])
        # Coming back to the list revives it, whatever it is doing.
        self.assertEqual(kinds(self.read(orca("a", "working"), orca("b", "done"))[0]), [("revived", "b", "")])

    def test_a_partial_read_resets_a_disappearance(self):
        self.read(orca("a", "working"), orca("b", "working"), orca("c", "working"))
        self.read(orca("a", "working"), orca("c", "working"))
        transitions, held = self.read(orca("a", "working"), complete=False)
        self.assertEqual((kinds(transitions), held), ([], []))
        self.assertEqual(kinds(self.read(orca("a", "working"), orca("c", "working"))[0]), [])

    def test_a_mass_disappearance_is_a_feed_gap_not_departures(self):
        self.read(*(orca(name, "working") for name in "abcd"))
        for _ in range(4):
            transitions, held = self.read(orca("a", "working"))
            self.assertEqual((kinds(transitions), held), ([], []))
        transitions, held = self.read()
        self.assertEqual((kinds(transitions), held), ([], []))

    def test_partial_reads_never_confirm_a_first_seen_ending(self):
        for _ in range(4):
            self.assertEqual(kinds(self.read(codex("a", "completed"), complete=False)[0]), [])
        self.assertEqual(kinds(self.read(codex("a", "completed"))[0]), [])
        self.assertEqual(kinds(self.read(codex("a", "completed"))[0]), [("retired", "a", "finished")])

    def test_a_member_never_seen_working_does_not_leave(self):
        self.read(orca("a", "working"), orca("b", "done"))
        for _ in range(3):
            self.assertEqual(self.read(orca("a", "working")), ([], []))

    def test_seeded_notes_keep_members_retired_until_new_work(self):
        self.tracker.seed(PARTY, "a", "finished")
        self.assertEqual(kinds(self.read(codex("a", "completed"))[0]), [])
        self.assertEqual(kinds(self.read(codex("a"))[0]), [("revived", "a", "")])

    def retire_on(self, member_id, *turn_ids):
        """Seen working on the first turn, then ended on the last turn in two good reads."""
        self.read(two_turns(member_id, turn_ids[:1], "inProgress"))
        self.read(two_turns(member_id, turn_ids, "completed"))
        transitions, _ = self.read(two_turns(member_id, turn_ids, "completed"))
        self.assertEqual(kinds(transitions), [("retired", member_id, "finished")])

    def test_a_new_turn_that_already_completed_revives_and_then_parts_again(self):
        self.retire_on("a", "t1")
        # Between polls the member ran and finished a whole new turn.
        transitions, _ = self.read(two_turns("a", ("t1", "t2"), "completed"))
        self.assertEqual(kinds(transitions), [("revived", "a", "")])
        self.assertEqual(self.tracker.retired(PARTY), {})
        # The newer turn's read counts once; one more good read parts it again, on t2.
        transitions, _ = self.read(two_turns("a", ("t1", "t2"), "completed"))
        self.assertEqual(kinds(transitions), [("retired", "a", "finished")])
        self.assertEqual(self.tracker.markers[PARTY]["a"]["turns"], ["t1", "t2"])

    def test_the_retired_turn_repeated_or_a_lagging_read_never_revives(self):
        self.retire_on("a", "t1", "t2")
        for _ in range(3):
            self.assertEqual(kinds(self.read(two_turns("a", ("t1", "t2"), "completed"))[0]), [])
        # A surface or feed still holding the older turn is not new work either.
        self.assertEqual(kinds(self.read(two_turns("a", ("t1",), "completed"))[0]), [])
        # A read that lacks turns but repeats a known event is not new work.
        self.assertEqual(kinds(self.read({**two_turns("a", ("t1", "t2"), "completed"), "turnStates": []})[0]), [])
        self.assertEqual(self.tracker.retired(PARTY), {"a": "finished"})

    def test_an_orca_member_with_a_newer_public_event_revives_without_turns(self):
        self.read(orca("o", "working"))
        self.read(orca("o", "done"))
        self.read(orca("o", "done"))
        self.assertEqual(self.tracker.retired(PARTY), {"o": "finished"})
        self.assertEqual(kinds(self.read(orca("o", "done"))[0]), [])
        newer = orca("o", "done")
        newer["activities"] = newer["activities"] + [
            {"id": "o-message-2", "kind": "update", "title": "Update", "description": "Next pass.", "status": "completed"}]
        self.assertEqual(kinds(self.read(newer)[0]), [("revived", "o", "")])

    def test_a_marker_seeded_from_an_old_note_adopts_what_it_first_sees(self):
        self.tracker.seed(PARTY, "a", "finished")
        self.assertEqual(kinds(self.read(two_turns("a", ("t1",), "completed"))[0]), [])
        self.assertEqual(self.tracker.markers[PARTY]["a"]["turns"], ["t1"])
        self.assertTrue(self.tracker.changed)
        self.assertEqual(kinds(self.read(two_turns("a", ("t1",), "completed"))[0]), [])
        self.assertEqual(kinds(self.read(two_turns("a", ("t1", "t2"), "completed"))[0]), [("revived", "a", "")])

    def test_markers_are_saved_apart_from_notes_validated_and_bounded(self):
        self.retire_on("a", "t1")
        saved = self.tracker.to_json()
        self.assertEqual([(m["party"], m["id"], m["outcome"], m["turns"]) for m in saved],
                         [(PARTY, "a", "finished", ["t1"])])
        # A restart with no notes at all still keeps the goblin retired.
        again = RetirementTracker()
        again.load(saved, NOW)
        self.assertEqual(again.retired(PARTY), {"a": "finished"})
        self.assertEqual(kinds(again.observe(PARTY, "root-chat", [two_turns("a", ("t1",), "completed")],
                                             complete=True)[0]), [])
        good = saved[0]
        junk = [None, "x", {**good, "outcome": "won"}, {**good, "id": "all"}, {**good, "id": PARTY},
                {**good, "id": "demo-1"}, {**good, "party": ""}, {**good, "at": True},
                {**good, "at": NOW - (MARKER_DAYS + 1) * 86_400_000}, {**good, "at": NOW + 3 * 86_400_000}]
        self.assertEqual([clean_marker(item, NOW) for item in junk], [None] * len(junk))
        messy = clean_marker({**good, "turns": ["t"] * 50 + [5, "", "z" * 900], "events": "nope"}, NOW)
        self.assertLessEqual(len(messy["turns"]), 8)
        self.assertTrue(all(len(turn) <= 200 for turn in messy["turns"]))
        self.assertEqual(messy["events"], [])
        many = RetirementTracker()
        many.load([{**good, "id": f"m{index}", "at": NOW - index} for index in range(MARKER_LIMIT + 30)], NOW)
        self.assertEqual(len(many.to_json()), MARKER_LIMIT)
        self.assertIn("m0", many.retired(PARTY))
        self.assertNotIn(f"m{MARKER_LIMIT + 29}", many.retired(PARTY))

    def test_observation_memory_is_bounded_but_markers_are_kept(self):
        self.retire_on("a", "t1")
        for index in range(PARTY_LIMIT + 5):
            self.tracker.observe(f"other-{index}", "", [codex("x")], complete=True)
        self.assertLessEqual(len(self.tracker.parties), PARTY_LIMIT)
        self.assertNotIn(PARTY, self.tracker.parties)
        self.assertEqual(self.tracker.retired(PARTY), {"a": "finished"})
        self.assertEqual(kinds(self.read(two_turns("a", ("t1",), "completed"))[0]), [])


def two_turns(member_id, turn_ids, last_status):
    """A Codex member whose turns are ``turn_ids``; the last one is in ``last_status``."""
    turns = [{"id": turn_id, "status": "completed", "questions": []} for turn_id in turn_ids]
    turns[-1]["status"] = last_status
    activities = [{"id": f"{member_id}-{turn_id}-answer", "turnId": turn_id, "kind": "update",
                   "title": "Answer", "description": f"Done with {turn_id}.", "status": "completed"}
                  for turn_id in turn_ids]
    return {"id": member_id, "source": "codex", "name": f"Goblin {member_id}", "parentThreadId": PARTY,
            "status": "active" if last_status == "inProgress" else "idle", "updatedAt": NOW - 60_000,
            "turnStates": turns, "activities": activities}


class NoteTests(unittest.TestCase):
    def finished(self):
        return codex("a", "completed", activities=[
            {"kind": "update", "title": "Update", "description": "Starting on the portal."},
            {"kind": "file", "title": "Changed 2 files", "description": "goblin_cues.py · desktop_widget.py"},
            {"kind": "file", "title": "Changed 9 files", "description": "a.py · b.py · c.py · very_long_na…"},
            {"kind": "command", "title": "Ran project tests", "description": "Checked the project with its test suite.",
             "detail": "npm test -- --secret-flag", "output": "PRIVATE OUTPUT 42 passing", "exitCode": 0},
            {"kind": "research", "title": "Searched the web", "description": "tk canvas clipping"},
            {"kind": "update", "title": "Answer", "description": "Built   the portal\n and the notes. " + "x" * 400},
            {"kind": "update", "title": "Status", "description": "Finished the task."},
        ])

    def test_a_note_keeps_only_public_clipped_facts(self):
        note = parting_note(self.finished(), PARTY, "Synthetic party", "finished", NOW)
        self.assertEqual(note["outcome"], "finished")
        self.assertTrue(note["reported"].startswith("Built the portal and the notes."))
        self.assertLessEqual(len(note["reported"]), EXCERPT_LIMIT)
        self.assertEqual(note["files"], ["goblin_cues.py", "desktop_widget.py", "a.py", "b.py"])
        self.assertEqual(note["fileCount"], 5)
        self.assertEqual((note["commands"], note["searches"], note["tools"]), (1, 1, 0))
        text = repr(note) + repr(note_lines(note, "Goblin a", NOW))
        for private in ("npm test", "secret-flag", "PRIVATE OUTPUT", "passing", "tk canvas clipping"):
            self.assertNotIn(private, text)
        title, meta, reported, seen = note_lines(note, "Goblin a", NOW)
        # A completed turn is only that turn ending, never a verdict on the whole task.
        self.assertEqual(title, "✉ Goblin a · TURN DONE")
        self.assertTrue(meta.startswith("CODEX · Its last turn completed · seen "), meta)
        # The feed never tied this answer to the turn that ended, so it is only the last update.
        self.assertFalse(note["final"])
        self.assertTrue(reported.startswith("Last update: “Built the portal"))
        self.assertEqual(seen, "Seen in feed: changed goblin_cues.py, desktop_widget.py, a.py, b.py +1 more · "
                               "1 command · 1 web search")

    def test_only_the_answer_of_the_turn_that_ended_is_called_final(self):
        def actor(turn_of_answer, last_turn="t2"):
            return codex("a", "completed", turnStates=[{"id": "t1", "status": "completed"},
                                                       {"id": last_turn, "status": "completed"}],
                         activities=[{"kind": "update", "title": "Answer", "turnId": turn_of_answer,
                                      "description": "All set."}])
        final = parting_note(actor("t2"), PARTY, "Party", "finished", NOW)
        self.assertTrue(final["final"])
        self.assertEqual(note_lines(final, "a", NOW)[2], "Final answer: “All set.”")
        # An answer from an earlier turn, a mid-work update, or an interrupted turn is not final.
        self.assertFalse(parting_note(actor("t1"), PARTY, "Party", "finished", NOW)["final"])
        update = codex("a", "completed", activities=[{"kind": "update", "title": "Update", "turnId": "t1",
                                                      "description": "Halfway there."}])
        self.assertEqual(note_lines(parting_note(update, PARTY, "Party", "finished", NOW), "a", NOW)[2],
                         "Last update: “Halfway there.”")
        stopped = parting_note(actor("t2"), PARTY, "Party", "stopped", NOW)
        self.assertFalse(stopped["final"])
        self.assertEqual(note_lines(stopped, "a", NOW)[0], "✉ a · STOPPED")
        # A stored claim of finality is only trusted for a finished note with an excerpt.
        self.assertFalse(clean_note({**stopped, "final": True}, NOW)["final"])
        self.assertFalse(clean_note({**final, "final": "yes"}, NOW)["final"])
        self.assertEqual([outcome_word(*case) for case in (("finished", "codex"), ("finished", "orca"),
                                                           ("stopped", "codex"), ("left", "orca"))],
                         ["TURN DONE", "MARKED DONE", "STOPPED", "LEFT"])

    def test_no_report_and_left_are_said_plainly(self):
        note = parting_note(orca("o", "working"), "orca:ws", "Workspace", "left", NOW)
        title, meta, reported, seen = note_lines(note, "Orca o", NOW)
        self.assertEqual(title, "✉ Orca o · LEFT")
        self.assertEqual(reported, "No public update captured.")
        self.assertIn("Left the party list · outcome unknown", meta)
        self.assertEqual(seen, "Seen in feed: 1 tool step")
        self.assertNotIn("rm -rf", repr(note))

    def test_stored_notes_are_validated_and_limited(self):
        good = parting_note(self.finished(), PARTY, "Party", "finished", NOW)
        junk = [None, "note", [], {"party": PARTY}, {**good, "outcome": "succeeded"}, {**good, "at": "yesterday"},
                {**good, "at": True}, {**good, "at": NOW - (NOTE_DAYS + 1) * 86_400_000},
                {**good, "id": "all"}, {**good, "id": PARTY}, {**good, "id": "demo-3"}, {**good, "party": ""},
                {**good, "id": 7}, {**good, "name": "x", "party": PARTY, "id": "  "}]
        notes = PartingNotes.load(junk, NOW)
        self.assertEqual(notes.items, [])
        self.assertEqual(clean_note({**good, "files": "a.py"}, NOW)["files"], [])
        messy = clean_note({**good, "reported": "y" * 5000, "name": None, "commands": -3, "tools": True,
                            "fileCount": 10 ** 9, "files": ["ok.py", 5, "", "z" * 300] * 3, "source": "evil"}, NOW)
        self.assertLessEqual(len(messy["reported"]), EXCERPT_LIMIT)
        self.assertEqual(messy["name"], "a")
        self.assertEqual((messy["commands"], messy["tools"], messy["source"]), (0, 0, ""))
        self.assertEqual(len(messy["files"]), 4)
        self.assertTrue(all(len(name) <= 60 for name in messy["files"]))
        many = [{**good, "id": f"m{index}", "at": NOW - index * 1000} for index in range(NOTE_LIMIT + 5)]
        notes = PartingNotes.load(many + [None, {**good, "id": "m0", "at": NOW - 1}], NOW)
        self.assertEqual(len(notes.items), NOTE_LIMIT)
        self.assertEqual([note["id"] for note in notes.items[:2]], ["m0", "m1"])

    def test_store_is_scoped_by_party(self):
        notes = PartingNotes()
        base = parting_note(codex("a", "completed"), PARTY, "Party", "finished", NOW)
        notes.add(base, NOW)
        notes.add({**base, "id": "b", "at": NOW + 1}, NOW)
        notes.add({**base, "party": "other", "at": NOW + 2}, NOW)
        notes.add({**base, "at": NOW + 3, "outcome": "stopped"}, NOW)  # Replaces, never duplicates.
        self.assertEqual([(note["party"], note["id"]) for note in notes.items],
                         [(PARTY, "a"), ("other", "a"), (PARTY, "b")])
        self.assertEqual(notes.for_party(PARTY)[0]["outcome"], "stopped")
        self.assertTrue(notes.remove(PARTY, "b"))
        self.assertFalse(notes.remove(PARTY, "b"))
        self.assertEqual(notes.clear(PARTY), 1)
        self.assertEqual([note["party"] for note in notes.items], ["other"])

    def test_taken_notes_can_be_restored_once_and_read_state_is_kept(self):
        notes = PartingNotes()
        base = parting_note(codex("a", "completed"), PARTY, "Party", "finished", NOW)
        for index, member_id in enumerate("abc"):
            notes.add({**base, "id": member_id, "at": NOW - index}, NOW)
        self.assertFalse(any(note["read"] for note in notes.items))
        self.assertTrue(notes.mark_read(PARTY))
        self.assertFalse(notes.mark_read(PARTY))
        taken = notes.take(PARTY, "b")
        self.assertEqual([note["id"] for note in taken], ["b"])
        cleared = notes.take_party(PARTY)
        self.assertEqual(notes.items, [])
        self.assertEqual(notes.restore(cleared + taken, NOW), 3)
        self.assertEqual([note["id"] for note in notes.items], ["a", "b", "c"])
        self.assertTrue(all(note["read"] for note in notes.items))
        # Restoring never duplicates a note that is already back.
        self.assertEqual(notes.restore(taken, NOW), 0)
        self.assertTrue(PartingNotes.load(notes.to_json(), NOW).items[0]["read"])


if __name__ == "__main__":
    unittest.main()
