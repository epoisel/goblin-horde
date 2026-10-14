import unittest

from goblin_motion import (BEAT_MS, PULSE_MS, RESYNC_MS, ActionPulse, event_action, goblin_action, member_status,
                           with_pulse)

T0 = 1_700_000_000_000
READ = {"id": "read-1", "kind": "command", "title": "Read a local file", "status": "completed",
        "description": "Opened a local file for inspection.", "detail": "Get-Content app.py", "exitCode": 0}
WRITE = {"id": "write-1", "kind": "file", "title": "Changed app.py", "status": "completed"}
UPDATE = {"id": "update-1", "kind": "update", "title": "Update", "description": "Next I'll fix the layout.",
          "status": "completed"}


def finished(*events, **extra):
    """A goblin whose turn completed a minute before T0: its steady action is idle."""
    return {"id": "g1", "status": "idle", "updatedAt": T0 - 60_000, "turnStates": [{"status": "completed"}],
            "activities": list(events), **extra}


class GoblinMotionTests(unittest.TestCase):
    def test_research_and_local_search_use_magnifier(self):
        actor = {"status": "working", "activities": [{"kind": "research", "title": "Searched the web"}]}
        self.assertEqual(goblin_action(actor), "search")
        actor["activities"] = [{"kind": "tool", "title": "Used Bash", "detail": "rg -n widget ."}]
        self.assertEqual(goblin_action(actor), "search")

    def test_file_edit_builds_even_when_filename_contains_search(self):
        actor = {"status": "working", "activities": [{"kind": "file", "title": "Changed search_test.py"}]}
        self.assertEqual(goblin_action(actor), "build")

    def test_planning_update_thinks_before_building(self):
        actor = {"status": "working", "activities": [{"kind": "update", "title": "Update",
                                                           "description": "I’m thinking through the build."}]}
        self.assertEqual(goblin_action(actor), "think")

    def test_finished_worker_stops_acting_and_request_waves(self):
        actor = {"status": "done", "activities": [{"kind": "file", "title": "Changed app.py"}]}
        self.assertEqual(goblin_action(actor), "idle")
        self.assertEqual(goblin_action(actor, needs_input=True), "waiting")

    def test_old_completed_action_becomes_thinking_during_active_turn(self):
        actor = {"status": "unknown", "updatedAt": 1_700_000_000_000,
                 "turnStates": [{"status": "inProgress"}],
                 "activities": [{"kind": "file", "title": "Changed app.py", "status": "completed"}]}
        self.assertEqual(goblin_action(actor, now_ms=1_700_000_050_000), "think")

    def test_member_status_prioritizes_attention_and_failure(self):
        actor = {"status": "completed", "needsInput": True,
                 "activities": [{"status": "failed", "exitCode": 1}]}
        self.assertEqual(member_status(actor).word, "NEEDS YOU")
        actor["needsInput"] = False
        self.assertEqual(member_status(actor).word, "FAILED")
        actor["activities"] = []
        actor["turnStates"] = [{"status": "completed", "questions": [{"prompt": "Choose"}]}]
        self.assertEqual(member_status(actor).word, "ASKED YOU")

    def test_a_failure_or_question_the_feed_calls_quiet_is_history(self):
        # A Codex chat that failed 31 minutes ago and never changed again: the feed now calls it quiet.
        failed = {"id": "c", "status": "notLoaded", "attention": "quiet", "updatedAt": T0 - 31 * 60_000,
                  "turnStates": [{"status": "failed", "questions": []}],
                  "activities": [{"kind": "command", "title": "Ran project tests", "status": "failed", "exitCode": 1}]}
        self.assertNotEqual(member_status(failed).word, "FAILED")
        self.assertEqual(member_status(failed).word, "QUIET")
        self.assertEqual(goblin_action(failed), "idle")
        self.assertEqual(member_status({**failed, "attention": "failed"}).word, "FAILED")
        self.assertEqual(member_status({**failed, "attention": None}).word, "FAILED", "older viewers send no attention")
        asked = {"id": "q", "status": "completed", "attention": "quiet",
                 "turnStates": [{"status": "completed", "questions": ["Ship it?"]}], "activities": []}
        self.assertEqual(member_status(asked).word, "DONE")
        self.assertEqual(goblin_action(asked), "idle")
        self.assertEqual(member_status({**asked, "attention": "needs"}).word, "ASKED YOU")
        # A request still pending always wins.
        self.assertEqual(member_status({**asked, "needsInput": True}).word, "NEEDS YOU")
        self.assertEqual(goblin_action(asked, needs_input=True), "waiting")

    def test_member_status_uses_public_activity_and_honest_unknown(self):
        actor = {"status": "working", "activities": [{"kind": "research", "title": "Searched the web"}]}
        self.assertEqual(member_status(actor).word, "SEARCHING")
        self.assertEqual(member_status({"status": "unknown"}).word, "QUIET")
        self.assertEqual(member_status(actor, "OFFLINE").word, "OFFLINE")

    def test_events_map_to_their_props(self):
        self.assertEqual(event_action(READ), "search")
        self.assertEqual(event_action({"kind": "command", "title": "Checked Git changes"}), "search")
        self.assertEqual(event_action({"kind": "command", "title": "Ran project tests"}), "search")
        self.assertEqual(event_action({"kind": "command", "title": "Ran a local command",
                                       "detail": "npm run build"}), "build")
        self.assertEqual(event_action(WRITE), "build")
        self.assertEqual(event_action(UPDATE), "think")


class ActionPulseTests(unittest.TestCase):
    def test_first_look_records_history_without_replaying_it(self):
        pulses = ActionPulse()
        self.assertEqual(pulses.action(finished(WRITE, READ), now_ms=T0), "idle")
        self.assertEqual(pulses.action(finished(WRITE, READ), now_ms=T0 + BEAT_MS), "idle")

    def test_new_completed_read_pulses_the_magnifier_then_rests(self):
        # The reported case: a finished "Read a local file" bubble appears and the goblin stood still.
        pulses = ActionPulse()
        pulses.action(finished(WRITE), now_ms=T0)
        actor = finished(WRITE, READ)
        beats = [pulses.action(actor, now_ms=T0 + 3000 + beat * BEAT_MS) for beat in range(12)]
        self.assertGreaterEqual(beats.count("search"), 4)
        self.assertEqual(beats[:PULSE_MS // BEAT_MS], ["search"] * (PULSE_MS // BEAT_MS))
        self.assertEqual(beats[-1], "idle")
        # Later polls of the same event never replay it.
        self.assertEqual(pulses.action(actor, now_ms=T0 + 9000), "idle")

    def test_write_uses_hammer_and_update_uses_thought_dots(self):
        pulses = ActionPulse()
        pulses.action(finished(READ), now_ms=T0)
        self.assertEqual(pulses.action(finished(READ, WRITE), now_ms=T0 + 3000), "build")
        self.assertEqual(pulses.action(finished(READ, WRITE, UPDATE), now_ms=T0 + 6000), "think")

    def test_a_lagging_feed_does_not_replay_an_event_already_seen(self):
        pulses = ActionPulse()
        pulses.action(finished(WRITE), now_ms=T0)
        pulses.action(finished(WRITE, READ), now_ms=T0 + 1000)
        # Another surface still holds the older list, then the newer one comes back.
        self.assertEqual(pulses.action(finished(WRITE), now_ms=T0 + 5000), "idle")
        self.assertEqual(pulses.action(finished(WRITE, READ), now_ms=T0 + 5300), "idle")

    def test_every_surface_sees_the_same_pulse(self):
        pulses = ActionPulse()
        pulses.action(finished(WRITE), now_ms=T0)
        portrait = pulses.action(finished(WRITE, READ), now_ms=T0 + 3000)
        tile = pulses.action(finished(WRITE, READ), now_ms=T0 + 3010)
        self.assertEqual((portrait, tile), ("search", "search"))

    def test_waiting_and_failure_outrank_a_pulse(self):
        pulses = ActionPulse()
        pulses.action(finished(WRITE), now_ms=T0)
        self.assertEqual(pulses.action(finished(WRITE, READ), needs_input=True, now_ms=T0 + 3000), "waiting")
        broken = {**READ, "id": "read-2", "status": "failed", "exitCode": 1}
        self.assertEqual(pulses.action(finished(WRITE, READ, broken), now_ms=T0 + 6000), "trouble")

    def test_still_mode_records_without_pulsing_and_never_replays_later(self):
        pulses = ActionPulse()
        pulses.action(finished(WRITE), now_ms=T0, animate=False)
        self.assertEqual(pulses.action(finished(WRITE, READ), now_ms=T0 + 3000, animate=False), "idle")
        self.assertEqual(pulses.action(finished(WRITE, READ), now_ms=T0 + 3360), "idle")

    def test_returning_after_a_long_gap_does_not_act_out_dormant_history(self):
        pulses = ActionPulse()
        pulses.action(finished(WRITE), now_ms=T0)
        later = T0 + RESYNC_MS + 1
        self.assertEqual(pulses.action(finished(WRITE, READ), now_ms=later), "idle")
        self.assertEqual(pulses.action(finished(WRITE, READ, UPDATE), now_ms=later + 3000), "think")

    def test_first_sight_of_a_just_finished_read_still_shows_the_magnifier(self):
        # The goblin is first seen one second after its "Read a local file" landed.
        pulses = ActionPulse()
        actor = finished(WRITE, READ, updatedAt=T0 - 1000)
        beats = [pulses.action(actor, now_ms=T0 + beat * BEAT_MS) for beat in range(12)]
        self.assertEqual(beats[:4], ["search"] * 4)
        self.assertEqual(beats[-1], "idle")
        # The pulse is shortened by the step's age rather than replayed in full.
        self.assertLess(beats.count("search"), PULSE_MS // BEAT_MS)
        self.assertEqual(pulses.action(actor, now_ms=T0 + 9000), "idle")

    def test_a_fresh_step_seen_late_in_its_window_still_gets_one_visible_cycle(self):
        pulses = ActionPulse()
        actor = finished(WRITE, READ, updatedAt=T0 - (PULSE_MS - 50))
        beats = [pulses.action(actor, now_ms=T0 + beat * BEAT_MS) for beat in range(8)]
        self.assertEqual(beats[:4], ["search"] * 4)
        self.assertEqual(beats[-1], "idle")

    def test_first_sight_trusts_only_stamps_that_vouch_for_the_newest_step(self):
        status = {"id": "status-1", "kind": "update", "title": "Status", "status": "completed"}
        cases = {
            "older than the window": finished(WRITE, READ, updatedAt=T0 - PULSE_MS),
            "no stamp": finished(WRITE, READ, updatedAt=None),
            "zero stamp": finished(WRITE, READ, updatedAt=0),
            "far future stamp": finished(WRITE, READ, updatedAt=T0 + 60_000),
            # A fresh stamp from a status ping does not vouch for the older read behind it.
            "hidden behind a status ping": finished(WRITE, READ, status, updatedAt=T0 - 500),
            # A step from a turn that started after the stamp cannot be what the stamp dates.
            "turn newer than stamp": finished(WRITE, {**READ, "turnStartedAt": T0 + 5000}, updatedAt=T0 - 500),
        }
        for name, actor in cases.items():
            with self.subTest(name):
                self.assertEqual(ActionPulse().action(actor, now_ms=T0), "idle")

    def test_first_sight_accepts_second_stamps_and_small_clock_skew(self):
        self.assertEqual(ActionPulse().action(finished(WRITE, READ, updatedAt=(T0 - 1000) / 1000), now_ms=T0),
                         "search")
        self.assertEqual(ActionPulse().action(finished(WRITE, READ, updatedAt=T0 + 1000), now_ms=T0), "search")

    def test_first_sight_in_still_mode_never_pulses_and_never_replays_later(self):
        pulses = ActionPulse()
        actor = finished(WRITE, READ, updatedAt=T0 - 500)
        self.assertEqual(pulses.action(actor, now_ms=T0, animate=False), "idle")
        self.assertEqual(pulses.action(actor, now_ms=T0 + BEAT_MS), "idle")

    def test_returning_soon_after_a_fresh_step_pulses_it_once(self):
        pulses = ActionPulse()
        pulses.action(finished(WRITE), now_ms=T0)
        later = T0 + RESYNC_MS + 1
        actor = finished(WRITE, READ, updatedAt=later - 500)
        self.assertEqual(pulses.action(actor, now_ms=later), "search")
        self.assertEqual(pulses.action(actor, now_ms=later + PULSE_MS), "idle")
        # A second long gap does not replay a step already seen.
        self.assertEqual(pulses.action(actor, now_ms=later + PULSE_MS + RESYNC_MS + 1), "idle")

    def test_a_first_look_records_all_history_so_a_lagging_surface_never_replays_it(self):
        pulses = ActionPulse()
        self.assertEqual(pulses.action(finished(WRITE, READ), now_ms=T0), "idle")
        # Another surface still holds the list from before the read; the write is history too.
        self.assertEqual(pulses.action(finished(WRITE), now_ms=T0 + 500), "idle")
        self.assertEqual(pulses.action(finished(WRITE), now_ms=T0 + RESYNC_MS + 1), "idle")

    def test_two_steps_landing_in_one_read_never_replay_the_skipped_one(self):
        pulses = ActionPulse()
        pulses.action(finished(WRITE), now_ms=T0)
        self.assertEqual(pulses.action(finished(WRITE, READ, UPDATE), now_ms=T0 + 3000), "think")
        # After the pulse, a lagging list whose newest step is the read does not act it out.
        self.assertEqual(pulses.action(finished(WRITE, READ), now_ms=T0 + 3000 + PULSE_MS + 1), "idle")

    def test_turning_motion_off_clears_a_pulse_already_running(self):
        pulses = ActionPulse()
        pulses.action(finished(WRITE), now_ms=T0)
        self.assertEqual(pulses.action(finished(WRITE, READ), now_ms=T0 + 3000), "search")
        self.assertEqual(pulses.pulsing("g1", T0 + 3000 + BEAT_MS), "search")
        self.assertEqual(pulses.action(finished(WRITE, READ), now_ms=T0 + 3000 + BEAT_MS, animate=False), "idle")
        self.assertIsNone(pulses.pulsing("g1", T0 + 3000 + 2 * BEAT_MS))
        # Turning motion back on mid-way does not resume the old pulse.
        self.assertEqual(pulses.action(finished(WRITE, READ), now_ms=T0 + 3000 + 2 * BEAT_MS), "idle")

    def test_the_pulse_record_forgets_the_least_recently_seen_goblins(self):
        pulses = ActionPulse(actors=3)
        for index in range(5):
            pulses.action(finished(WRITE, id=f"g{index}"), now_ms=T0 + index)
        self.assertEqual(sorted(pulses._looked), ["g2", "g3", "g4"])
        self.assertEqual(sorted(pulses._seen), ["g2", "g3", "g4"])
        # A forgotten goblin is a first look again: its history is recorded, not replayed.
        self.assertEqual(pulses.action(finished(WRITE, READ, id="g0"), now_ms=T0 + 3000), "idle")
        self.assertLessEqual(len(pulses._looked), 3)

    def test_a_replayed_step_reads_in_the_past_tense_only_while_it_plays(self):
        idle = member_status(finished(WRITE))
        self.assertEqual(idle.word, "IDLE")
        self.assertEqual([with_pulse(idle, action).word for action in ("search", "build", "think")],
                         ["CHECKED", "BUILT", "UPDATED"])
        self.assertEqual(with_pulse(member_status({"status": "completed"}), "search").word, "CHECKED")
        self.assertIs(with_pulse(idle, None), idle)
        for status in (member_status(finished(WRITE, needsInput=True)), member_status(finished(WRITE), "STALE"),
                       member_status({"status": "working", "activities": [WRITE]})):
            self.assertIs(with_pulse(status, "search"), status)
        pulses = ActionPulse()
        pulses.action(finished(WRITE), now_ms=T0)
        pulses.action(finished(WRITE, READ), now_ms=T0 + 3000)
        self.assertEqual(pulses.pulsing("g1", T0 + 3000 + PULSE_MS - 1), "search")
        self.assertIsNone(pulses.pulsing("g1", T0 + 3000 + PULSE_MS))
        self.assertIsNone(pulses.pulsing("nobody", T0))

    def test_goblins_without_an_id_never_pulse(self):
        pulses = ActionPulse()
        actor = finished(WRITE)
        actor.pop("id")
        pulses.action(actor, now_ms=T0)
        self.assertEqual(pulses.action({**actor, "activities": [WRITE, READ]}, now_ms=T0 + 3000), "idle")


if __name__ == "__main__":
    unittest.main()
