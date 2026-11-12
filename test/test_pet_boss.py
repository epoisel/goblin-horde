"""Bosses of the 2D pet game: 36 ogre tiers as chunky pixel art, their battle profile and Tk images."""

import sys
import time
import unittest

from pet_boss import (BOSS_COUNT, CHUNK, FIXED, GOBLIN_PX, POSE_FRAMES, BossProfile, PetBossImages, Pixels,
                      boss_frames, boss_height, boss_name, boss_pixels, boss_profile)

ROW = 6
TIER_HEIGHTS = (14, 17, 20, 23, 26, 30)
ONE_OF_EACH_TIER = tuple(range(0, BOSS_COUNT, ROW))


def runs(line):
    """(start, end, value) for each run of equal values along a line."""
    found, start = [], 0
    for x in range(1, len(line) + 1):
        if x == len(line) or line[x] != line[start]:
            found.append((start, x, line[start]))
            start = x
    return found


def frames():
    return [(pose, frame) for pose, count in POSE_FRAMES.items() for frame in range(count)]


def opaque(pixels):
    return {(x, y) for y, row in enumerate(pixels.rows) for x, colour in enumerate(row) if colour}


def hairlines(rows, least=6):
    """How many runs at least ``least`` long are one pixel thick: no pixel beside them shares their colour."""
    found = 0
    for y in range(1, len(rows) - 1):
        for start, end, colour in runs(rows[y]):
            if colour and end - start >= least:
                found += colour not in rows[y - 1][start:end] and colour not in rows[y + 1][start:end]
    return found


def box(pixels):
    """(left, top, right, bottom) of the drawn pixels, right and bottom past the end."""
    xs, ys = zip(*opaque(pixels))
    return min(xs), min(ys), max(xs) + 1, max(ys) + 1


def brightness(colour):
    value = int(colour[1:], 16)
    return sum((value >> shift) & 255 for shift in (16, 8, 0))


class BossTableTests(unittest.TestCase):
    def test_thirty_six_bosses_each_with_its_own_short_name(self):
        self.assertEqual(BOSS_COUNT, 36)
        names = [boss_name(index) for index in range(BOSS_COUNT)]
        self.assertEqual(len(set(names)), len(names))
        for name in names:
            self.assertTrue(name.isalpha() and 3 <= len(name) <= 12 and name[0].isupper(), name)

    def test_the_poses_and_frame_counts_are_the_contracts(self):
        self.assertEqual(POSE_FRAMES, {"stand": 2, "walk": 4, "stomp": 2, "roar": 2, "hurt": 1, "fall": 3})
        for pose, count in POSE_FRAMES.items():
            self.assertEqual(boss_frames(pose), count)
            shots = [boss_pixels(0, pose, frame).rows for frame in range(count)]
            self.assertEqual(len(set(shots)), count, f"every {pose} frame is its own drawing")
            self.assertEqual(boss_pixels(0, pose, count).rows, shots[0], f"{pose} wraps after {count} frames")

    def test_a_sprite_is_the_shared_pixels_shape(self):
        self.assertEqual(Pixels._fields, ("width", "height", "rows", "anchor"))
        self.assertEqual(BossProfile._fields, ("name", "height_goblins", "slices", "mouth", "grip"))
        pixels = boss_pixels(0, "stand", 0)
        self.assertEqual((len(pixels.rows), len(pixels.rows[0])), (pixels.height, pixels.width))
        for row in pixels.rows:
            self.assertEqual(len(row), pixels.width)
            for colour in row:
                self.assertTrue(colour is None or (len(colour) == 7 and colour[0] == "#" and int(colour[1:], 16) >= 0))


class BossArtTests(unittest.TestCase):
    def test_every_boss_draws_every_frame_of_every_pose(self):
        for index in range(BOSS_COUNT):
            for pose, frame in frames():
                pixels = boss_pixels(index, pose, frame)
                drawn = sum(colour is not None for row in pixels.rows for colour in row)
                with self.subTest(boss=boss_name(index), pose=pose, frame=frame):
                    self.assertGreater(drawn, boss_height(index) ** 2 // 6, "a body's worth of pixels")
                    self.assertTrue(0 < pixels.anchor[0] < pixels.width and 0 < pixels.anchor[1] <= pixels.height)

    def test_a_pose_keeps_one_canvas_and_a_steady_silhouette(self):
        for index in ONE_OF_EACH_TIER:
            for pose, count in POSE_FRAMES.items():
                shots = [boss_pixels(index, pose, frame) for frame in range(count)]
                with self.subTest(boss=boss_name(index), pose=pose):
                    self.assertEqual(len({(shot.width, shot.height, shot.anchor) for shot in shots}), 1)
                    if pose in ("stand", "walk"):
                        sizes = [(right - left, bottom - top) for left, top, right, bottom in map(box, shots)]
                        wide, tall = zip(*sizes)
                        self.assertLessEqual(max(tall) - min(tall), boss_height(index) // 12)
                        self.assertLessEqual(max(wide) - min(wide), boss_height(index) // 4)

    def test_the_feet_stay_on_the_anchor_standing_and_walking(self):
        for index in ONE_OF_EACH_TIER:
            stand = [boss_pixels(index, "stand", frame) for frame in range(POSE_FRAMES["stand"])]
            feet = boss_height(index) // 12
            self.assertEqual(stand[0].rows[-feet:], stand[1].rows[-feet:], "breathing never moves the feet")
            for pose in ("stand", "walk"):
                for frame in range(POSE_FRAMES[pose]):
                    pixels = boss_pixels(index, pose, frame)
                    ax, ay = pixels.anchor
                    planted = [x for x, colour in enumerate(pixels.rows[-1]) if colour]
                    with self.subTest(boss=boss_name(index), pose=pose, frame=frame):
                        self.assertEqual(ay, pixels.height, "the canvas ends at the ground")
                        self.assertTrue(planted, "a foot is on the ground")
                        self.assertTrue(planted[0] <= ax <= planted[-1], "the anchor is under the planted feet")

    def test_heights_follow_the_tiers_and_never_shrink(self):
        tops = []
        for index in range(BOSS_COUNT):
            profile = boss_profile(index)
            self.assertEqual(profile.height_goblins, TIER_HEIGHTS[index // ROW])
            self.assertEqual(boss_height(index), profile.height_goblins * GOBLIN_PX)
            pixels = boss_pixels(index, "stand", 0)
            left, top, right, bottom = box(pixels)
            tops.append(bottom - top)
            with self.subTest(boss=boss_name(index)):
                self.assertEqual(bottom, pixels.anchor[1], "it stands on the ground")
                self.assertGreaterEqual(bottom - top, boss_height(index) - CHUNK)
                self.assertLessEqual(bottom - top, boss_height(index) * 1.2, "headgear adds little")
                skull = pixels.rows[pixels.anchor[1] - boss_height(index) + 2 * CHUNK]
                self.assertTrue(any(skull[pixels.anchor[0]:]), "the skull reaches the tier's height")
        self.assertEqual(tops, sorted(tops))
        self.assertLessEqual(abs(tops[0] - TIER_HEIGHTS[0] * GOBLIN_PX), CHUNK, "the first boss wears nothing on its head")

    def test_each_tier_has_its_own_palette_and_gear_only_grows(self):
        colours = [{colour for row in boss_pixels(index, "stand", 0).rows for colour in row if colour}
                   for index in ONE_OF_EACH_TIER]
        for n, palette in enumerate(colours):
            for other in colours[n + 1:]:
                self.assertGreaterEqual(len(palette ^ other), 6)
        self.assertEqual([len(palette) for palette in colours], sorted(len(palette) for palette in colours))
        self.assertEqual([FIXED["G"] in palette for palette in colours], [False] * 5 + [True], "only the last wears gold")
        drawn = [len(opaque(boss_pixels(index, "stand", 0))) / boss_height(index) ** 2 for index in ONE_OF_EACH_TIER]
        self.assertGreater(drawn[-1], drawn[0], "horns, plates, spikes and a crown add to the figure")

    def test_the_art_is_a_few_flat_colours(self):
        for index in ONE_OF_EACH_TIER:
            for pose, frame in frames():
                used = {colour for row in boss_pixels(index, pose, frame).rows for colour in row if colour}
                self.assertLessEqual(len(used), 24, (boss_name(index), pose, frame))

    def test_silhouettes_step_on_the_lattice_at_every_size(self):
        for index in ONE_OF_EACH_TIER:
            for pose, frame in frames():
                pixels = boss_pixels(index, pose, frame)
                ax, ay = pixels.anchor
                masks = [tuple(colour is not None for colour in row) for row in pixels.rows]
                with self.subTest(boss=boss_name(index), pose=pose, frame=frame):
                    for y in range(ay % CHUNK, ay, CHUNK):
                        self.assertEqual(len(set(masks[y:y + CHUNK])), 1, "rows come in lattice steps from the ground")
                        for start, end, _ in runs(masks[y]):
                            self.assertEqual(((start - ax) % CHUNK, (end - ax) % CHUNK), (0, 0))

    def test_details_are_one_sprite_pixel_at_every_size(self):
        for index in ONE_OF_EACH_TIER:
            pixels = boss_pixels(index, "stand", 0)
            dither = sum(end - start == 1 for row in pixels.rows for start, end, colour in runs(row) if colour)
            with self.subTest(boss=boss_name(index)):
                self.assertGreater(dither, boss_height(index), "dither, a pixel at a time")
                self.assertGreaterEqual(hairlines(pixels.rows), 3, "highlight lines, a pixel tall")
                self.assertGreaterEqual(hairlines(list(zip(*pixels.rows))), 3, "finger and toe gaps, a pixel wide")

    def test_a_flash_lightens_colours_without_changing_the_silhouette(self):
        for index in ONE_OF_EACH_TIER:
            for pose in ("stand", "hurt", "roar"):
                plain = boss_pixels(index, pose, 0)
                flash = boss_pixels(index, pose, 0, flash=True)
                with self.subTest(boss=boss_name(index), pose=pose):
                    self.assertEqual((flash.width, flash.height, flash.anchor), (plain.width, plain.height, plain.anchor))
                    self.assertEqual(opaque(flash), opaque(plain))
                    for before, after in zip(plain.rows, flash.rows):
                        for a, b in zip(before, after):
                            if a:
                                self.assertGreater(brightness(b), brightness(a))

    def test_a_flipped_boss_is_the_mirror_image(self):
        for index in (0, 17, 35):
            for pose, frame in frames():
                plain = boss_pixels(index, pose, frame)
                flipped = boss_pixels(index, pose, frame, flip=True)
                self.assertEqual(flipped.rows, tuple(row[::-1] for row in plain.rows))
                self.assertEqual(flipped.anchor, (plain.width - plain.anchor[0], plain.anchor[1]))

    def test_a_frame_index_wraps(self):
        self.assertEqual(boss_pixels(7, "walk", 5), boss_pixels(7, "walk", 1))

    def test_a_fall_ends_flat_on_the_ground_inside_its_canvas(self):
        last = POSE_FRAMES["fall"] - 1
        for index in ONE_OF_EACH_TIER:
            stand, fallen = boss_pixels(index, "stand", 0), boss_pixels(index, "fall", last)
            left, top, right, bottom = box(fallen)
            with self.subTest(boss=boss_name(index)):
                self.assertGreater(right - left, 1.5 * (bottom - top), "it lies along the ground")
                self.assertLess(bottom - top, boss_height(index), "lower than it stood")
                self.assertEqual(bottom, fallen.anchor[1], "it rests on the ground")
                self.assertGreater(len(opaque(fallen)), 0.9 * len(opaque(stand)), "nothing is cut off")
                heights = [box(boss_pixels(index, "fall", frame))[1] for frame in range(last + 1)]
                self.assertEqual(heights, sorted(heights), "each frame is lower than the one before")
                self.assertLessEqual({colour for row in stand.rows for colour in row},
                                     {colour for row in fallen.rows for colour in row}, "weapon and gear came along")


class BossProfileTests(unittest.TestCase):
    def test_slices_climb_from_the_feet_to_the_skull_inside_the_canvas(self):
        for index in range(BOSS_COUNT):
            profile = boss_profile(index)
            pixels = boss_pixels(index, "stand", 0)
            ax, ay = pixels.anchor
            height = boss_height(index)
            heights = [v for v, _ in profile.slices]
            with self.subTest(boss=boss_name(index)):
                self.assertEqual(profile.name, boss_name(index))
                self.assertGreaterEqual(len(profile.slices), 8)
                self.assertEqual(heights, sorted(set(heights)))
                self.assertTrue(0.0 < heights[0] < 0.1 and 0.9 < heights[-1] < 1.0)
                for v, half in profile.slices:
                    self.assertGreater(half, 0.02)
                    self.assertLess(half * height, min(ax, pixels.width - ax))
                    self.assertLess(v * height, ay)

    def test_a_climber_inside_a_slice_is_on_the_body(self):
        for index in ONE_OF_EACH_TIER:
            profile = boss_profile(index)
            pixels = boss_pixels(index, "stand", 0)
            ax, ay = pixels.anchor
            height = boss_height(index)
            for (v, half), (_, behind, ahead) in zip(profile.slices, profile.grip):
                row = pixels.rows[ay - 1 - int(v * height)]
                drawn = [x for x, colour in enumerate(row) if colour]
                with self.subTest(boss=boss_name(index), height=round(v, 2)):
                    self.assertLessEqual(half, min(behind, ahead))
                    self.assertLessEqual(drawn[0], ax - int(half * height))
                    self.assertGreaterEqual(drawn[-1], ax + int(half * height) - 1)

    def test_the_mouth_is_on_the_face(self):
        for index in ONE_OF_EACH_TIER:
            forward, up = boss_profile(index).mouth
            pixels = boss_pixels(index, "roar", 1)
            ax, ay = pixels.anchor
            height = boss_height(index)
            self.assertTrue(0.0 < forward < 0.5 and 0.5 < up < 1.0)
            # The roaring boss leans in, so its mouth is within a twelfth of its height of the spot.
            reach = height // 12
            x, y = ax + int(forward * height), ay - int(up * height)
            near = {colour for row in pixels.rows[y - reach:y + reach] for colour in row[x - reach:x + reach]}
            self.assertGreaterEqual(len(near - {None}), 3, "teeth, maw and tongue are around the mouth point")

    def test_a_profile_is_cheap_once_made(self):
        boss_profile(35)
        start = time.perf_counter()
        for index in range(BOSS_COUNT):
            self.assertIs(boss_profile(index), boss_profile(index))
        self.assertLess(time.perf_counter() - start, 0.5)


@unittest.skipUnless(sys.platform == "win32", "Paints real Tk images")
class BossImageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import tkinter as tk
        cls.root = tk.Tk()
        cls.root.withdraw()

    @classmethod
    def tearDownClass(cls):
        cls.root.destroy()

    def test_an_image_is_the_pixels_zoomed_with_a_clear_background(self):
        images = PetBossImages(self.root)
        self.addCleanup(images.clear)
        for index, zoom, flash, flip in ((0, 3, True, True), (6, 1, False, False)):
            pixels = boss_pixels(index, "roar", 1, flip=flip, flash=flash)
            image = images.image(index, "roar", 1, zoom, flash=flash, flip=flip)
            self.assertEqual((image.width(), image.height()), (pixels.width * zoom, pixels.height * zoom))
            self.assertEqual(images.anchor(index, "roar", zoom, flip=flip),
                             (pixels.anchor[0] * zoom, pixels.anchor[1] * zoom))
            for y in range(0, pixels.height, 3):
                for x in range(0, pixels.width, 3):
                    px, py = x * zoom + zoom // 2, y * zoom + zoom // 2
                    if pixels.rows[y][x] is None:
                        self.assertTrue(image.transparency_get(px, py), (index, x, y))
                    else:
                        self.assertFalse(image.transparency_get(px, py), (index, x, y))
                        self.assertEqual("#%02x%02x%02x" % image.get(px, py), pixels.rows[y][x])

    def test_images_are_cached_by_frame_and_bounded_by_pixels(self):
        walk = boss_pixels(0, "walk", 0)
        images = PetBossImages(self.root, budget=3 * walk.width * walk.height * 4)
        self.addCleanup(images.clear)
        first = images.image(0, "walk", 0, 2)
        self.assertIs(images.image(0, "walk", 4, 2), first, "walk frame 4 is frame 0 again")
        self.assertIs(images.image(5, "walk", 0, 2), first, "a tier's bosses share their frames")
        self.assertIsNot(images.image(0, "walk", 0, 2, flash=True), first)
        for frame in range(1, 4):
            images.image(0, "walk", frame, 2)
            self.assertLessEqual(images.pixels, images.budget)
            self.assertEqual(images.pixels, sum(image.width() * image.height() for image in images.images.values()))
        self.assertIsNot(images.image(0, "walk", 0, 2), first, "the least recently shown frame was dropped")

    def test_the_default_budget_holds_a_whole_fight_with_the_biggest_boss(self):
        images = PetBossImages(self.root)
        fight = sum(boss_pixels(35, pose, 0).width * boss_pixels(35, pose, 0).height * 4 * count
                    for pose, count in POSE_FRAMES.items())
        self.assertLessEqual(fight, images.budget)

    def test_the_biggest_boss_builds_quickly(self):
        images = PetBossImages(self.root)
        self.addCleanup(images.clear)
        boss_pixels(35, "fall", 0)
        start = time.perf_counter()
        image = images.image(35, "fall", 2, 2, flash=True)
        took = time.perf_counter() - start
        self.assertEqual(image.height(), boss_pixels(35, "fall", 2).height * 2)
        self.assertLess(took, 1.0, f"{took * 1000:.0f} ms")


if __name__ == "__main__":
    unittest.main()
