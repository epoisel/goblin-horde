"""Action cues: distinct pixel props, visible motion on every beat, and a still fallback."""

import unittest

from goblin_cues import (BEATS, CUE_COLORS, CUE_SIZE, CUES, FOOTPRINT, HELD, POSES, ActionClock,
                         cue_for, cue_runs, pose_for)

WORK = ("search", "build", "think", "waiting", "trouble")


class CueArtTests(unittest.TestCase):
    def test_every_cue_is_an_8x8_grid_in_the_limited_palette(self):
        for action, frames in CUES.items():
            self.assertEqual(len(frames), BEATS, action)
            for frame in frames:
                self.assertEqual(len(frame.art), CUE_SIZE, action)
                for row in frame.art:
                    self.assertEqual(len(row), CUE_SIZE, (action, row))
                    self.assertTrue(set(row) <= set(CUE_COLORS) | {"."}, (action, row))

    def test_each_action_has_its_own_icon_and_waiting_differs_from_failure(self):
        arts = {action: {frame.art for frame in CUES[action]} for action in WORK}
        for first in WORK:
            for second in WORK:
                if first < second:
                    self.assertFalse(arts[first] & arts[second], (first, second))
        waiting_colors = {key for frame in CUES["waiting"] for row in frame.art for key in row}
        failure_colors = {key for frame in CUES["trouble"] for row in frame.art for key in row}
        self.assertIn("y", waiting_colors)
        self.assertNotIn("r", waiting_colors)
        self.assertIn("r", failure_colors)

    def test_thinking_shows_growing_dots_and_never_words(self):
        dots = [sum(row.count("d") for row in frame.art) for frame in CUES["think"]]
        self.assertEqual(dots[:3], [1, 2, 3])
        self.assertEqual(dots[3], 3)

    def test_idle_carries_no_prop(self):
        for frame in range(BEATS * 2):
            self.assertIsNone(cue_for("idle", frame))
            self.assertIsNone(cue_for("idle", frame, still=True))


class MotionTests(unittest.TestCase):
    def test_both_cue_and_body_change_on_every_beat(self):
        for action in WORK:
            for beat in range(BEATS):
                after = (beat + 1) % BEATS
                with self.subTest(action=action, beat=beat):
                    self.assertNotEqual(cue_for(action, beat), cue_for(action, after))
                    self.assertNotEqual(pose_for(action, beat), pose_for(action, after))

    def test_motion_uses_whole_sprite_pixels_so_scale_2_moves_at_least_2px(self):
        for action, poses in POSES.items():
            for pose in poses:
                self.assertIsInstance(pose.dx, int)
                self.assertIsInstance(pose.dy, int)
        for frames in CUES.values():
            for frame in frames:
                self.assertIsInstance(frame.dx, int)
                self.assertIsInstance(frame.dy, int)

    def test_goblin_and_cue_stay_inside_the_reserved_footprint(self):
        for action in WORK:
            for beat in range(BEATS):
                pose = pose_for(action, beat)
                shift = pose.dx if action in HELD else 0
                for column, _row, length, _color in cue_runs(cue_for(action, beat)):
                    self.assertGreaterEqual(column + shift, 0)
                    self.assertLessEqual(column + shift + length, FOOTPRINT, (action, beat))
                # Ears start at column 1, so a one-pixel lean left still stays on the canvas.
                self.assertGreaterEqual(pose.dx, -1)

    def test_still_mode_holds_one_readable_frame(self):
        for action in WORK:
            frames = {cue_for(action, frame, still=True) for frame in range(BEATS * 3)}
            poses = {pose_for(action, frame, still=True) for frame in range(BEATS * 3)}
            self.assertEqual(len(frames), 1, action)
            self.assertEqual(len(poses), 1, action)
            pose = poses.pop()
            self.assertEqual((pose.dx, pose.dy, pose.step), (0, 0, 0), action)
            self.assertNotEqual(pose.arm, "rest", action)
        still_dots = sum(row.count("d") for row in cue_for("think", 0, still=True).art)
        self.assertEqual(still_dots, 3)


class PortalTests(unittest.TestCase):
    def test_portal_art_uses_the_shared_palette_and_stays_in_the_footprint(self):
        from goblin_cues import EXIT_FRAMES, EXIT_STILL, PORTAL_TOP, art_runs

        for frame in (*EXIT_FRAMES, EXIT_STILL):
            for row in frame.ring or ():
                self.assertEqual(len(row), 17)
                self.assertTrue(set(row) <= set(CUE_COLORS) | {"."}, row)
            for column, row, length, _color in art_runs(frame.ring or (), 0, PORTAL_TOP):
                self.assertGreaterEqual(column, 0)
                self.assertLessEqual(column + length, FOOTPRINT)
                self.assertLessEqual(row, 19)  # The 4x portrait canvas and the 2x tiles end at row 20.
            if frame.cue:
                self.assertEqual((len(frame.cue.art), {len(row) for row in frame.cue.art}), (CUE_SIZE, {CUE_SIZE}))
                for column, row, length, _color in cue_runs(frame.cue):
                    self.assertGreaterEqual(min(column, row), 0)
                    self.assertLessEqual(column + length, FOOTPRINT)
                    self.assertLessEqual(row, 19)

    def test_the_goblin_waves_sinks_and_leaves_a_note(self):
        from goblin_cues import EXIT_FRAMES, NOTE, PORTAL_BEATS, exit_frame

        sinks = [frame.sink for frame in EXIT_FRAMES]
        self.assertEqual(sinks, sorted(sinks))
        self.assertEqual(sinks[0], 0)
        self.assertGreaterEqual(sinks[-1], 17)  # The whole body has gone through by the end.
        self.assertTrue(EXIT_FRAMES[0].arm.startswith("wave"))
        self.assertIs(exit_frame(PORTAL_BEATS - 1).cue.art, NOTE)
        self.assertIsNone(exit_frame(PORTAL_BEATS - 1).ring)
        for beat in range(PORTAL_BEATS - 1):
            self.assertNotEqual(exit_frame(beat), exit_frame(beat + 1), beat)
        # Out-of-range beats clamp instead of failing.
        self.assertEqual(exit_frame(-3), EXIT_FRAMES[0])
        self.assertEqual(exit_frame(99), EXIT_FRAMES[-1])

    def test_reduced_motion_shows_the_note_left_behind_at_once(self):
        from goblin_cues import EXIT_FRAMES, EXIT_STILL, NOTE, PORTAL_BEATS, exit_frame

        # No half-sunk still followed by a jump: every beat is already the note on the ground.
        stills = {exit_frame(beat, still=True, outcome=outcome)
                  for beat in range(PORTAL_BEATS) for outcome in ("finished", "stopped", "left")}
        self.assertEqual(stills, {EXIT_STILL})
        self.assertIs(EXIT_STILL, EXIT_FRAMES[-1])
        self.assertGreaterEqual(EXIT_STILL.sink, 17)
        self.assertIs(EXIT_STILL.cue.art, NOTE)
        self.assertIsNone(EXIT_STILL.ring)

    def test_only_a_finished_turn_waves_goodbye(self):
        from goblin_cues import EXIT_FRAMES, NOTE, PORTAL_BEATS, SPARKLE, exit_frame

        self.assertTrue(any(frame.arm.startswith("wave") for frame in EXIT_FRAMES))
        self.assertTrue(any(frame.cue and frame.cue.art is SPARKLE for frame in EXIT_FRAMES))
        for outcome in ("stopped", "left"):
            frames = [exit_frame(beat, outcome=outcome) for beat in range(PORTAL_BEATS)]
            with self.subTest(outcome=outcome):
                # Same portal and sink, but no wave and no sparkle: an unknown end is not a success.
                self.assertEqual({frame.arm for frame in frames}, {"rest"})
                self.assertFalse(any(frame.cue and frame.cue.art is SPARKLE for frame in frames))
                self.assertEqual([frame.sink for frame in frames], [frame.sink for frame in EXIT_FRAMES])
                self.assertIs(frames[-1].cue.art, NOTE)
                for beat in range(PORTAL_BEATS - 1):
                    self.assertNotEqual(frames[beat], frames[beat + 1], beat)


class ActionClockTests(unittest.TestCase):
    def test_a_new_action_starts_on_frame_zero_and_then_advances(self):
        clock = ActionClock()
        self.assertEqual(clock.frame("a", "think", 41), 0)
        self.assertEqual(clock.frame("a", "think", 43), 2)
        self.assertEqual(clock.frame("a", "build", 44), 0)
        self.assertEqual(clock.frame("a", "build", 45), 1)
        # Each goblin keeps its own cycle.
        self.assertEqual(clock.frame("b", "build", 45), 0)

    def test_the_clock_forgets_the_oldest_goblins_beyond_its_limit(self):
        clock = ActionClock(limit=3)
        for index in range(6):
            clock.frame(f"g{index}", "think", index)
        self.assertEqual(len(clock._starts), 3)
        self.assertEqual(clock.frame("g5", "think", 9), 4)


if __name__ == "__main__":
    unittest.main()
