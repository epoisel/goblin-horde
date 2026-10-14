"""Rendered goblins: the cue and the body both move, at the launchpad's 2x and the stream's 4x."""

import unittest

from goblin_sprite import KINDS, SPAN_H, SPAN_W, TOP_ROOM, draw_sprite, sprite_scale
from goblin_cues import ActionClock

WORK = ("search", "build", "think", "waiting", "trouble")


class CanvasSpy:
    def __init__(self):
        self.shapes = []

    def __getattr__(self, name):
        if name.startswith("create_"):
            def capture(*args, **kwargs):
                self.shapes.append((name, args, kwargs))
            return capture
        raise AttributeError(name)


def is_cue(shape):
    return "cue" in (shape[2].get("tags") or ())


class SpriteMotionTests(unittest.TestCase):
    def shapes(self, action, number, scale=4, still=False, style=KINDS[0]):
        canvas = CanvasSpy()
        draw_sprite(canvas, 12, 11, style,
                    action=action, frame=number, scale=scale, still=still)
        return canvas.shapes

    def parts(self, action, number, scale=2, still=False):
        shapes = self.shapes(action, number, scale, still)
        return ([shape for shape in shapes if not is_cue(shape)],
                [shape for shape in shapes if is_cue(shape)])

    def test_cue_and_body_both_change_every_beat_at_scale_2_and_4(self):
        for scale in (2, 4):
            for action in WORK:
                for beat in range(4):
                    with self.subTest(scale=scale, action=action, beat=beat):
                        body, cue = self.parts(action, beat, scale)
                        next_body, next_cue = self.parts(action, beat + 1, scale)
                        self.assertTrue(cue)
                        self.assertNotEqual(body, next_body)
                        self.assertNotEqual(cue, next_cue)

    def test_cue_is_large_enough_to_read_at_scale_2(self):
        for action in WORK:
            _body, cue = self.parts(action, 0)
            left = min(shape[1][0] for shape in cue)
            right = max(shape[1][2] for shape in cue)
            top = min(shape[1][1] for shape in cue)
            bottom = max(shape[1][3] for shape in cue)
            self.assertGreaterEqual(right - left, 12, action)
            self.assertGreaterEqual(bottom - top, 10, action)

    def test_idle_goblins_carry_no_prop(self):
        for number in range(8):
            _body, cue = self.parts("idle", number)
            self.assertEqual(cue, [])

    def test_no_words_are_drawn_beside_a_goblin(self):
        for action in (*WORK, "idle"):
            for number in range(4):
                kinds = {shape[0] for shape in self.shapes(action, number, 2)}
                self.assertNotIn("create_text", kinds, action)

    def test_still_mode_draws_the_same_readable_frame(self):
        for action in WORK:
            first = self.shapes(action, 0, 2, still=True)
            self.assertTrue(any(is_cue(shape) for shape in first), action)
            for number in range(1, 6):
                self.assertEqual(self.shapes(action, number, 2, still=True), first, action)

    def test_a_new_action_renders_its_first_frame_immediately(self):
        clock = ActionClock()
        tick = 37
        clock.frame("goblin", "search", tick - 5)
        frame = clock.frame("goblin", "build", tick)
        self.assertEqual(self.shapes("build", frame, 2), self.shapes("build", 0, 2))

    def test_tagged_sprites_tag_every_shape(self):
        canvas = CanvasSpy()
        draw_sprite(canvas, 0, 0, KINDS[1], action="build", frame=2, scale=2, tag="lp-sprite-0")
        for shape in canvas.shapes:
            tags = shape[2].get("tags")
            self.assertIn("lp-sprite-0", (tags,) if isinstance(tags, str) else tags)

    def test_every_goblin_fits_the_box_every_layout_reserves(self):
        for style in KINDS:
            for action in (*WORK, "idle"):
                for number in range(4):
                    canvas = CanvasSpy()
                    draw_sprite(canvas, 0, 0, style, action=action, frame=number, scale=1)
                    for _kind, box, _options in canvas.shapes:
                        with self.subTest(outfit=style["name"], action=action, frame=number):
                            self.assertGreaterEqual(min(box[0], box[2]), 0)
                            self.assertLessEqual(max(box[0], box[2]), SPAN_W)
                            self.assertGreaterEqual(min(box[1], box[3]), -TOP_ROOM)
                            self.assertLessEqual(max(box[1], box[3]), SPAN_H - TOP_ROOM)

    def test_a_faded_goblin_is_the_same_goblin_stippled(self):
        plain = self.shapes("think", 1, 2)
        canvas = CanvasSpy()
        draw_sprite(canvas, 12, 11, KINDS[0], action="think", frame=1, scale=2, stipple="gray50")
        self.assertEqual([shape[:2] for shape in canvas.shapes], [shape[:2] for shape in plain])
        self.assertTrue(all(shape[2].get("stipple") == "gray50" for shape in canvas.shapes))

    def test_display_scale_rounds_to_whole_sprite_pixels(self):
        self.assertEqual([sprite_scale(2, scale) for scale in (1.0, 1.25, 1.5, 2.0)], [2, 3, 3, 4])
        self.assertEqual([sprite_scale(4, scale) for scale in (1.0, 1.25, 1.5)], [4, 5, 6])
        self.assertEqual(sprite_scale(1, 0.1), 1)

    def test_every_outfit_draws_every_action(self):
        for style in KINDS:
            for action in (*WORK, "idle"):
                self.assertTrue(self.shapes(action, 1, 2, style=style))


if __name__ == "__main__":
    unittest.main()
