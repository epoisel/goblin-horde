"""The 2D goblin art: every look draws every action, mirrors exactly, stands on its anchor, reads on a
dark and a light desktop, and comes out of the sprite cache as the same pixels."""

import re
import tkinter as tk
import unittest
from functools import lru_cache
from itertools import product

import pet_art
from goblin_look import Look, look_for
from pet_art import ACTIONS, FRAMES, PetSprites, effect_pixels, goblin_pixels

CONTRACT = {"idle": 4, "run": 4, "jump": 3, "land": 1, "cheer": 4, "brawl": 4, "climb": 4, "dazed": 4,
            "grabbed": 4, "sit": 2}
EFFECTS = ("coin", "dust", "star", "alert", "spark")
DARK, LIGHT = "#1e2030", "#e8e8ee"
READS = 1.8
HEX = re.compile(r"#[0-9a-f]{6}\Z")
HATS, WEARS, TOOLS = ("", *pet_art.HATS), ("", *pet_art.WEARS), ("", *pet_art.TOOLS)
SKINS = [("green", green) for green in range(len(pet_art.GREENS))] + [(skin, 0) for skin in pet_art.SHINIES]
# The actions whose legs dangle, and the row their legs start on, counted from the ground line: a
# sitter's hang from the ledge down, a grabbed goblin's from where standing legs start.
LEGS_FROM = {"sit": 0, "grabbed": -2}


def look(skin="green", green=0, hat="", cloth=0, tool="", wear=""):
    return Look(f"{skin}{green}.{hat}.{wear}.{tool}.{cloth}", skin, green, hat, cloth, tool, wear)


BARE = look()
DRESSED = (BARE, look(green=3, hat="straw", cloth=0, tool="torch", wear="scarf"),
           look("albino", hat="pointy", cloth=4, tool="club", wear="vest"),
           look("shadow", hat="helmet", cloth=6, tool="sack", wear="sash"))


def every_frame(who):
    for action in ACTIONS:
        for frame in range(FRAMES[action]):
            yield action, frame, goblin_pixels(who, action, frame)


def cells(pixels):
    return [(x, y, colour) for y, row in enumerate(pixels.rows) for x, colour in enumerate(row) if colour]


def edge_cells(pixels):
    """The opaque cells with a clear cell, or the sprite's border, on one of their four sides."""
    rows, last_x, last_y = pixels.rows, pixels.width - 1, pixels.height - 1
    return [(x, y, colour) for x, y, colour in cells(pixels)
            if x in (0, last_x) or y in (0, last_y)
            or not (rows[y][x - 1] and rows[y][x + 1] and rows[y - 1][x] and rows[y + 1][x])]


def luminance(colour):
    channels = (int(colour[index:index + 2], 16) / 255 for index in (1, 3, 5))
    red, green, blue = (c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in channels)
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue


def contrast(one, other):
    light, dark = sorted((luminance(one), luminance(other)), reverse=True)
    return (light + 0.05) / (dark + 0.05)


@lru_cache(maxsize=None)
def reads(colour):
    return min(contrast(colour, DARK), contrast(colour, LIGHT)) >= READS


def dangling_legs(who):
    for action, start in LEGS_FROM.items():
        for frame in range(FRAMES[action]):
            pixels = goblin_pixels(who, action, frame)
            yield action, frame, [cell for cell in cells(pixels) if cell[1] >= pixels.anchor[1] + start]


def span(pixels, rows):
    """How wide the sprite is over ``rows``: its rightmost opaque column less its leftmost."""
    columns = [x for x, y, _ in cells(pixels) if y in rows]
    return max(columns) - min(columns) + 1


class GoblinPixelsTests(unittest.TestCase):
    def test_the_actions_and_frame_counts_are_the_contracts(self):
        self.assertEqual(ACTIONS, tuple(CONTRACT))
        self.assertEqual(FRAMES, CONTRACT)
        for action, count in CONTRACT.items():
            self.assertEqual(goblin_pixels(BARE, action, count + 1), goblin_pixels(BARE, action, 1 % count))
            self.assertEqual(goblin_pixels(BARE, action, -1), goblin_pixels(BARE, action, count - 1))

    def test_every_action_draws_for_every_hat_tool_clothes_and_skin(self):
        outfits = [look(*SKINS[index % len(SKINS)], hat, index % len(pet_art.CLOTH), tool, wear)
                   for index, (hat, tool, wear) in enumerate(product(HATS, TOOLS, WEARS))]
        skins = [look(skin, green, "cap", cloth, "", "vest")
                 for (skin, green), cloth in product(SKINS, range(len(pet_art.CLOTH)))]
        for who in outfits + skins:
            for action, frame, pixels in every_frame(who):
                with self.subTest(who=who.name, action=action, frame=frame):
                    self.assertEqual((pixels.width, pixels.height), (pet_art.CELL_W, pet_art.CELL_H))
                    self.assertEqual({len(row) for row in pixels.rows}, {pixels.width})
                    self.assertEqual(len(pixels.rows), pixels.height)
                    drawn = cells(pixels)
                    self.assertGreater(len(drawn), 40)
                    self.assertFalse([colour for _, _, colour in drawn if not HEX.match(colour)])

    def test_each_hat_tool_piece_of_clothing_and_skin_changes_the_picture(self):
        def pictures(looks):
            return {goblin_pixels(who, "idle", 0).rows for who in looks}

        self.assertEqual(len(pictures(look(hat=hat) for hat in HATS)), len(HATS))
        self.assertEqual(len(pictures(look(tool=tool) for tool in TOOLS)), len(TOOLS))
        self.assertEqual(len(pictures(look(wear=wear) for wear in WEARS)), len(WEARS))
        self.assertEqual(len(pictures(look(skin, green) for skin, green in SKINS)), len(SKINS))
        cloths = range(len(pet_art.CLOTH))
        self.assertEqual(len(pictures(look(wear="vest", cloth=cloth) for cloth in cloths)), len(pet_art.CLOTH))
        self.assertEqual(len(pictures(look(hat="cap", cloth=cloth) for cloth in cloths)), len(pet_art.CLOTH))
        self.assertGreaterEqual(len(pet_art.GREENS), 6)
        self.assertEqual(set(pet_art.SHINIES), {"albino", "blue", "red", "violet", "gold", "shadow"})
        self.assertGreaterEqual(len(pet_art.HATS), 10)
        self.assertEqual(len(pet_art.CLOTH), 8)

    def test_a_flipped_frame_is_the_exact_mirror(self):
        for who in DRESSED:
            for action, frame, pixels in every_frame(who):
                flipped = goblin_pixels(who, action, frame, flip=True)
                self.assertEqual(flipped.rows, tuple(row[::-1] for row in pixels.rows), (who.name, action, frame))
                self.assertEqual(flipped.anchor, (pixels.width - pixels.anchor[0], pixels.anchor[1]))
                self.assertEqual((flipped.width, flipped.height), (pixels.width, pixels.height))
        self.assertNotEqual(goblin_pixels(BARE, "idle", 0, flip=True), goblin_pixels(BARE, "idle", 0))

    def test_the_feet_stay_put_through_every_action(self):
        anchors = {(pixels.width, pixels.height, pixels.anchor)
                   for who in DRESSED for _, _, pixels in every_frame(who)}
        self.assertEqual(len(anchors), 1, "one cell and one anchor for every frame, so nothing slides")
        ax, ay = pet_art.ANCHOR
        backs = {}
        for action, frame, pixels in every_frame(BARE):
            columns = [x for x, _, _ in cells(pixels)]
            backs.setdefault(action, set()).add(min(columns))
            if action != "sit":
                middle = (min(columns) + max(columns) + 1) / 2
                self.assertLessEqual(abs(middle - ax), 1.5, f"{action} {frame} is off its feet")
        self.assertEqual({action: len(columns) for action, columns in backs.items()}, dict.fromkeys(ACTIONS, 1),
                         "an action's frames all start at the same column")
        for frame in range(FRAMES["idle"]):
            self.assertEqual(max(y for _, y, _ in cells(goblin_pixels(BARE, "idle", frame))), ay - 1)

    def test_land_and_dazed_rest_on_the_ground_line(self):
        for who in DRESSED:
            for action in ("land", "dazed"):
                for frame in range(FRAMES[action]):
                    lowest = max(y for _, y, _ in cells(goblin_pixels(who, action, frame)))
                    self.assertEqual(lowest, pet_art.ANCHOR[1] - 1, (who.name, action, frame))

    def test_only_dangling_legs_reach_below_the_ground(self):
        ax, ay = pet_art.ANCHOR
        standing_top = min(y for _, y, _ in cells(goblin_pixels(BARE, "idle", 0)))
        for who in DRESSED:
            for action, frame, pixels in every_frame(who):
                below = [(x, y) for x, y, _ in cells(pixels) if y >= ay]
                self.assertEqual(bool(below), action in LEGS_FROM, (who.name, action, frame))
        for action, frame, legs in dangling_legs(BARE):
            self.assertGreaterEqual(len({x for x, _, _ in legs}), 3, f"{action} {frame}: two legs, not one line")
        for who in DRESSED:
            for frame in range(FRAMES["sit"]):
                pixels = goblin_pixels(who, "sit", frame)
                below = [(x, y) for x, y, _ in cells(pixels) if y >= ay]
                self.assertGreaterEqual(max(y for _, y in below) - ay + 1, 3, "the legs hang three rows down")
                self.assertGreaterEqual(min(x for x, _ in below), ax, "past the ledge's end, never over its face")
                self.assertTrue([x for x, y, _ in cells(pixels) if y == ay - 1 and x < ax], "the seat is on the ledge")
        for frame in range(FRAMES["grabbed"]):
            pixels = goblin_pixels(BARE, "grabbed", frame)
            self.assertEqual(min(y for _, y, _ in cells(pixels)), standing_top, "held where a standing head is")
        for action in LEGS_FROM:
            shapes = {frozenset((x, y) for x, y, _ in legs) for name, _, legs in dangling_legs(BARE) if name == action}
            self.assertGreater(len(shapes), 1, f"{action} legs move")

    def test_dangling_legs_are_a_light_and_dark_pair_that_reads_on_dark_and_light(self):
        for skin, green in SKINS:
            for action, frame, legs in dangling_legs(look(skin, green)):
                colours = {colour for _, _, colour in legs}
                self.assertEqual(len(colours), 2, (skin, green, action, frame))
                self.assertFalse([colour for colour in colours if not reads(colour)], (skin, green, action, frame))
                light, dark = sorted(colours, key=luminance, reverse=True)
                self.assertGreater(contrast(light, dark), 1.5, (skin, green, action, frame))

    def test_every_silhouette_edge_reads_on_a_dark_and_a_light_desktop(self):
        outfits = [look(*SKINS[index % len(SKINS)], hat, index % len(pet_art.CLOTH), tool, wear)
                   for index, (hat, tool, wear) in enumerate(product(HATS, TOOLS, WEARS))]
        dyed = (("cap", "vest"), ("hood", "scarf"), ("mohawk", "sash"))
        outfits += [look(skin, green, hat, cloth, "", wear)
                    for (skin, green), cloth, (hat, wear) in product(SKINS, range(len(pet_art.CLOTH)), dyed)]
        lost = set()
        for who in outfits:
            for action, frame, pixels in every_frame(who):
                lost |= {(who.name, action, colour) for _, _, colour in edge_cells(pixels) if not reads(colour)}
        self.assertFalse(sorted(lost)[:12], f"{len(lost)} edge colours under {READS}:1 against {DARK} or {LIGHT}")
        self.assertFalse(reads("#eceae0") or reads("#121416"), "the check can tell a colour that would vanish")

    def test_climb_spreads_its_hands_and_braces_its_feet(self):
        ay = pet_art.ANCHOR[1]
        standing = goblin_pixels(BARE, "idle", 0)
        shoulders = range(ay - 8, ay - 3)
        for frame in range(FRAMES["climb"]):
            pixels = goblin_pixels(BARE, "climb", frame)
            feet = max(y for _, y, _ in cells(pixels))
            self.assertGreaterEqual(span(pixels, shoulders), span(standing, shoulders) + 4, frame)
            self.assertGreaterEqual(span(pixels, (feet, feet - 1)), span(standing, (ay - 1, ay - 2)) + 4, frame)
        self.assertEqual(len({goblin_pixels(BARE, "climb", frame).rows for frame in range(2)}), 2)

    def test_the_face_two_dot_eyes_a_mouth_that_opens_and_dazed_stars(self):
        def count(pixels, colour):
            return sum(1 for cell in cells(pixels) if cell[2] == colour)

        self.assertEqual(count(goblin_pixels(BARE, "idle", 0), pet_art.BLACK), 2)
        for action in ("run", "cheer", "brawl"):
            mouths = [count(goblin_pixels(BARE, action, frame), pet_art.MOUTH) for frame in range(FRAMES[action])]
            self.assertEqual(min(mouths), 0, action)
            self.assertGreaterEqual(max(mouths), 2, action)
        star = {colour for _, _, colour in cells(effect_pixels("star", 0))}
        for action, frame, pixels in every_frame(BARE):
            colours = {colour for _, _, colour in cells(pixels)}
            self.assertEqual(star <= colours, action == "dazed", (action, frame))
        eyes = [sorted(y for _, y, colour in cells(goblin_pixels(BARE, "dazed", frame)) if colour == pet_art.BLACK)
                for frame in range(FRAMES["dazed"])]
        self.assertTrue(all(len(rows) == 2 and rows[0] != rows[1] for rows in eyes), "dazed eyes are not level")

    def test_the_effects_the_view_needs(self):
        self.assertLessEqual(set(EFFECTS), set(pet_art.EFFECTS))
        for kind in pet_art.EFFECTS:
            count = pet_art.EFFECT_FRAMES[kind]
            self.assertEqual(effect_pixels(kind, count), effect_pixels(kind, 0))
            for frame in range(count):
                pixels = effect_pixels(kind, frame)
                self.assertTrue(cells(pixels), (kind, frame))
                self.assertEqual({len(row) for row in pixels.rows}, {pixels.width})
                self.assertEqual(len(pixels.rows), pixels.height)
                self.assertTrue(0 <= pixels.anchor[0] < pixels.width and 0 <= pixels.anchor[1] < pixels.height)
                self.assertFalse([colour for _, _, colour in edge_cells(pixels) if not reads(colour)], (kind, frame))


class PetSpritesTests(unittest.TestCase):
    def setUp(self):
        self.root = tk.Tk()
        self.root.withdraw()
        self.addCleanup(self.root.destroy)

    def assert_shows(self, image, pixels, scale):
        self.assertEqual((image.width(), image.height()), (pixels.width * scale, pixels.height * scale))
        for y, row in enumerate(pixels.rows):
            for x, colour in enumerate(row):
                for sx, sy in ((x * scale, y * scale), (x * scale + scale - 1, y * scale + scale - 1)):
                    self.assertEqual(image.transparency_get(sx, sy), colour is None, (x, y))
                    if colour:
                        self.assertEqual("#%02x%02x%02x" % tuple(image.get(sx, sy)), colour, (x, y))

    def test_an_image_is_its_pixels_enlarged_with_the_clear_cells_transparent(self):
        sprites = PetSprites(self.root)
        for scale, (who, action, frame, flip) in product((1, 2, 3), ((DRESSED[1], "run", 2, False),
                                                                     (DRESSED[2], "sit", 1, True),
                                                                     (DRESSED[3], "dazed", 3, False))):
            image = sprites.image(who, action, frame, scale, flip)
            self.assert_shows(image, goblin_pixels(who, action, frame, flip), scale)
        for kind in EFFECTS:
            self.assert_shows(sprites.effect(kind, 1, 2), effect_pixels(kind, 1), 2)

    def test_a_frame_is_built_once_and_frames_wrap(self):
        sprites = PetSprites(self.root)
        first = sprites.image(BARE, "run", 1, 2)
        self.assertIs(sprites.image(BARE, "run", 1, 2), first)
        self.assertIs(sprites.image(BARE, "run", 1 + FRAMES["run"], 2), first)
        others = [sprites.image(BARE, "run", 1, 2, flip=True), sprites.image(BARE, "run", 1, 3),
                  sprites.image(BARE, "run", 2, 2), sprites.image(DRESSED[1], "run", 1, 2),
                  sprites.effect("coin", 0, 2)]
        self.assertEqual(len({id(image) for image in [first, *others]}), 6)
        self.assertIs(sprites.effect("coin", pet_art.EFFECT_FRAMES["coin"], 2), others[-1])
        self.assertEqual(sprites.pixels, sum(image.width() * image.height() for image in [first, *others]))

    def test_the_cache_keeps_to_its_budget_and_drops_the_least_recently_shown(self):
        cell = pet_art.CELL_W * 2 * pet_art.CELL_H * 2
        sprites = PetSprites(self.root, budget=3 * cell)
        one, two, three = (sprites.image(BARE, "idle", frame, 2) for frame in range(3))
        self.assertIs(sprites.image(BARE, "idle", 0, 2), one)
        sprites.image(BARE, "idle", 3, 2)
        self.assertLessEqual(sprites.pixels, sprites.budget)
        self.assertIs(sprites.image(BARE, "idle", 0, 2), one, "shown again, so kept")
        self.assertIs(sprites.image(BARE, "idle", 2, 2), three)
        self.assertIsNot(sprites.image(BARE, "idle", 1, 2), two, "the least recently shown was dropped")
        for who, (action, frame, _) in product(DRESSED, list(every_frame(BARE))):
            sprites.image(who, action, frame, 2)
            self.assertLessEqual(sprites.pixels, sprites.budget)
        sprites.clear()
        self.assertEqual(sprites.pixels, 0)

    def test_the_default_budget_holds_64_looks_in_every_frame_and_both_facings_at_unit_2(self):
        cell = pet_art.CELL_W * 2 * pet_art.CELL_H * 2
        self.assertLessEqual(64 * 10 * 4 * 2 * cell, pet_art.BUDGET, "the contract's working set")
        looks = {}
        goblin = 0
        while len(looks) < 64:
            who = look_for(goblin, frozenset(pet_art.SHINIES))
            looks.setdefault(who.name, who)
            goblin += 1
        sprites = PetSprites(self.root)
        shown = [(who, action, frame, flip) for who in looks.values() for action in ACTIONS
                 for frame in range(FRAMES[action]) for flip in (False, True)]
        first = [sprites.image(who, action, frame, 2, flip) for who, action, frame, flip in shown]
        self.assertLessEqual(sprites.pixels, sprites.budget)
        again = [sprites.image(who, action, frame, 2, flip) for who, action, frame, flip in shown]
        self.assertTrue(all(one is other for one, other in zip(first, again)), "nothing was dropped and rebuilt")


if __name__ == "__main__":
    unittest.main()
