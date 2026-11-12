"""The side-view pet world: goblins roam the taskbar and window tops, get dragged about, and answer rewards.

Every check drives a seeded World through the calls a view makes and reads back what it would draw."""

import math
import os
import statistics
import subprocess
import sys
import time
import unittest
from pathlib import Path

from pet_behaviors import ACTION_FRAMES, LANES, THROW_MAX
from pet_platform import Platform
from pet_world import World

W, H, GROUND, UNIT = 1920, 1080, 1032, 2
TICK = 1 / 30
GOBLIN = 11 * UNIT             # a goblin's height on screen
DEPTH = (LANES - 1) * UNIT     # feet rest up to this far under the ground line
FOOTED = ("idle", "run", "sit", "land", "dazed")  # actions only a goblin with footing is drawn in


def horde(size=30, seed=1, **options):
    world = World(W, H, GROUND, unit=UNIT, seed=seed, **options)
    world.set_horde(size)
    return world


def run(world, seconds, each=None):
    events = []
    for _ in range(round(seconds / TICK)):
        events += world.step(TICK)
        if each:
            each(world.frame())
    return events


def top(key, x0, x1, y, origin=None):
    """A window's visible top edge; `origin` is the window's own corner when a neighbour clips x0."""
    return Platform(float(x0), float(x1), float(y), "window", key, (float(x0 if origin is None else origin), float(y)))


def place(world, goblin_id, x, y):
    """Carry a goblin to rest just above (x, y) and let go, as a slow cursor would."""
    world.grab(goblin_id)
    world.move_grabbed(x, y - GOBLIN - 12)
    run(world, 0.4)
    world.drop()
    run(world, 0.6)


def draw_of(world, goblin_id):
    return next(d for d in world.frame().draws if d.id == goblin_id)


def on_ground(draw):
    return GROUND - 0.01 <= draw.y <= GROUND + DEPTH + 0.01


def lands(world, goblin_id, within=3.0, falling=False):
    """Step until the goblin is on the ground; False if it is not there in time, or, when it must
    be `falling` all the way, if anything caught it."""
    for _ in range(round(within / TICK)):
        world.step(TICK)
        d = draw_of(world, goblin_id)
        if on_ground(d):
            return True
        if falling and d.action != "jump":
            return False
    return False


def tenths(frame):
    """How many goblins stand in each tenth of the ground's width."""
    counts = [0] * 10
    for d in frame.draws:
        counts[min(9, int(d.x * 10 / W))] += 1
    return counts


def mean_speed(world, seconds):
    total, count, last = 0.0, 0, {d.id: d for d in world.frame().draws}
    for _ in range(round(seconds / TICK)):
        world.step(TICK)
        now = {d.id: d for d in world.frame().draws}
        total += sum(abs(d.x - last[i].x) / TICK for i, d in now.items())
        count += len(now)
        last = now
    return total / count


class Determinism(unittest.TestCase):
    def show(self, seed):
        world = horde(40, seed)
        frames = []
        for n in range(round(20 / TICK)):
            world.set_platforms([top("a", 300 + n, 700 + n, 600), top("b", 900, 1300, 400)] if n < 400 else [])
            if n == 30:
                place(world, 3, 500, 600)
            if n == 90:
                world.reward(12, 800)
            if n == 150:
                world.stir(0.8)
            if n == 200:
                world.start_battle(None, 7, True, 1.2)
            world.step(TICK)
            if n % 50 == 0:
                frames.append(world.frame())
        return frames

    def test_the_same_seed_plays_the_same_show(self):
        self.assertEqual(self.show(11), self.show(11))

    def test_another_seed_plays_another(self):
        self.assertNotEqual(self.show(11), self.show(12))

    def test_a_seed_plays_the_same_show_in_another_interpreter(self):
        code = "; ".join((
            "import hashlib, pet_world",
            "world = pet_world.World(1920, 1080, 1032, seed=5)",
            "world.set_horde(60)",
            "world.start_battle(None, 3, True, 1.4)",
            "[world.step(1 / 30) for _ in range(900)]",
            "print(hashlib.sha256(repr(world.frame()).encode()).hexdigest())"))
        root = Path(__file__).resolve().parent.parent
        digests = set()
        for hash_seed in ("1", "2"):
            done = subprocess.run([sys.executable, "-c", code], cwd=root, capture_output=True, text=True, timeout=120,
                                  env={**os.environ, "PYTHONHASHSEED": hash_seed})
            self.assertEqual(done.returncode, 0, done.stderr)
            digests.add(done.stdout.strip())
        self.assertEqual(len(digests), 1)


class HordeSize(unittest.TestCase):
    def test_an_empty_world_fills_in_place_along_the_ground(self):
        world = horde(30)
        frame = world.frame()
        self.assertEqual(world.shown, 30)
        self.assertEqual(sorted(d.id for d in frame.draws), list(range(30)))
        self.assertTrue(all(on_ground(d) for d in frame.draws))
        self.assertGreater(max(d.x for d in frame.draws) - min(d.x for d in frame.draws), W / 2)

    def test_the_cap_limits_how_many_show(self):
        world = horde(500, cap=150)
        self.assertEqual(world.shown, 150)
        self.assertEqual(len(world.frame().draws), 150)
        self.assertEqual(horde(500, cap=20).shown, 20)

    def test_newcomers_drop_in_from_an_edge_and_cheer(self):
        world = horde(5)
        run(world, 2)
        world.set_horde(8)
        self.assertEqual(world.shown, 8)
        arrivals = [d for d in world.frame().draws if d.id >= 5]
        self.assertEqual(sorted(d.id for d in arrivals), [5, 6, 7])
        for d in arrivals:
            self.assertTrue(d.x < 40 or d.x > W - 40, d)
            self.assertLess(d.y, GROUND - GOBLIN, d)
            self.assertLess(d.alpha, 1.0)
        cheered = set()
        run(world, 3, lambda frame: cheered.update(d.id for d in frame.draws if d.action == "cheer"))
        self.assertLessEqual({5, 6, 7}, cheered)
        self.assertTrue(all(d.alpha == 1.0 for d in world.frame().draws))

    def test_newcomers_end_up_all_along_the_ground_not_at_the_edge(self):
        world = horde(3)
        world.set_horde(63)
        run(world, 12)
        arrivals = [d for d in world.frame().draws if d.id >= 3]
        inland = [d for d in arrivals if W * 0.2 < d.x < W * 0.8]
        self.assertGreater(len(inland), len(arrivals) * 0.4)

    def test_a_shrinking_horde_fades_out_its_highest_ids(self):
        world = horde(30)
        run(world, 1)
        world.set_horde(10)
        self.assertEqual(world.shown, 10)
        fading = [d for d in world.frame().draws if d.id >= 10]
        self.assertEqual(len(fading), 20)
        run(world, 1)
        self.assertEqual(sorted(d.id for d in world.frame().draws), list(range(10)))
        world.set_horde(0)
        run(world, 1)
        self.assertEqual(world.frame().draws, ())

    def test_a_held_goblin_can_leave_with_a_shrinking_horde(self):
        world = horde(10)
        world.grab(9)
        world.set_horde(5)
        world.drop()
        run(world, 2)
        self.assertEqual(sorted(d.id for d in world.frame().draws), list(range(5)))


class Bounds(unittest.TestCase):
    def churn(self, n):
        """Window tops that slide, rise, shrink, appear and vanish, plus ones too thin or too low to count."""
        tops = [top("slider", 200 + 3 * (n % 300), 700 + 3 * (n % 300), 500),
                top("lift", 1200, 1700, 800 - (n % 240)),
                top("thin", 100, 120, 300), top("low", 300, 900, GROUND - 6),
                top("nan", float("nan"), 900, 450), top("inside out", 900, 300, 450),
                top("edge", -200, 260, 250), top("split", 1000, 1150, 620), top("split", 1260, 1500, 620, origin=1000)]
        if n % 400 < 250:
            tops.append(top("blink", 1400, 1900, 300))
        if n % 90 < 45:
            tops.append(top("shrink", 600, 1100 - 4 * (n % 90), 380))
        return tops

    def test_everyone_stays_on_screen_and_on_something_through_window_churn(self):
        world = horde(60, seed=5)
        drops = iter([(4, 400, 500), (9, 1450, 800), (14, 1600, 300), (19, 100, 250), (24, 1300, 620), (29, 700, 380),
                      (34, 110, 300), (39, 600, GROUND - 6)])
        stood_on_a_window = set()
        for n in range(round(60 / TICK)):
            tops = self.churn(n)
            world.set_platforms(tops)
            if n % 150 == 20:
                goblin_id, x, y = next(drops, (n % 60, 300 + n % 1300, 200))
                world.grab(goblin_id)
                world.move_grabbed(x, y - 40)
            if n % 150 == 32:
                world.drop()
            world.step(TICK)
            for d in world.frame().draws:
                self.assertTrue(math.isfinite(d.x) and math.isfinite(d.y), d)
                self.assertTrue(0 <= d.x <= W and 0 <= d.y <= GROUND + DEPTH, (n, d))
                if d.action in FOOTED and not on_ground(d):
                    under = [t for t in tops if t.y == d.y and max(t.x0, 0) - 0.01 <= d.x <= min(t.x1, W) + 0.01]
                    self.assertTrue(under, (n, d))
                    self.assertNotIn(under[0].key, ("thin", "low", "nan", "inside out"), (n, d))
                    stood_on_a_window.add(under[0].key)
        self.assertGreaterEqual(len(stood_on_a_window), 3, stood_on_a_window)

    def test_bad_and_huge_steps_do_not_explode(self):
        world = horde(40, seed=2)
        world.set_platforms([top("a", 300, 900, 500)])
        place(world, 1, 600, 500)
        world.start_battle("left", 3, True, 2.0)
        before = world.frame()
        for dt in (0.0, -1.0, float("nan"), float("inf")):
            self.assertEqual(world.step(dt), [])
        self.assertEqual(world.frame(), before)
        for dt in (1e9, 5.0, TICK, 1e9, 0.5) * 40:
            world.step(dt)
            frame = world.frame()
            for d in frame.draws:
                self.assertTrue(0 <= d.x <= W and 0 <= d.y <= GROUND + DEPTH, d)
            if frame.boss:
                self.assertTrue(math.isfinite(frame.boss.x) and -W < frame.boss.x < 2 * W)

    def test_a_huge_step_is_not_replayed(self):
        world = horde(1, seed=3)
        world.grab(0)
        world.move_grabbed(900, 300)
        run(world, 0.5)
        world.drop()
        world.step(1e6)
        self.assertLess(draw_of(world, 0).y, GROUND - 200)

    def test_resize_keeps_everyone_inside_the_new_area(self):
        world = horde(60, seed=4)
        run(world, 3)
        world.resize(1280, 720, 680)
        run(world, 2, lambda frame: self.assertTrue(
            all(0 <= d.x <= 1280 and d.y <= 680 + DEPTH for d in frame.draws)))
        self.assertGreater(sum(680 - 0.01 <= d.y for d in world.frame().draws), 45)


class Roaming(unittest.TestCase):
    def test_the_horde_covers_the_whole_ground(self):
        for seed in (1, 2, 3):
            world = horde(150, seed)
            samples = []
            for _ in range(60):
                run(world, 1)
                samples.append(tenths(world.frame()))
            for tenth in range(10):
                share = statistics.mean(sample[tenth] for sample in samples) / 150
                self.assertTrue(0.04 < share < 0.2, (seed, tenth, share))
            self.assertTrue(all(min(sample) > 0 for sample in samples), seed)

    def test_goblins_do_different_things(self):
        world = horde(100, seed=6)
        seen = {}
        run(world, 30, lambda frame: [seen.setdefault(d.id, set()).add(d.action) for d in frame.draws])
        self.assertEqual(len(seen), 100)
        self.assertGreater(statistics.mean(len(actions) for actions in seen.values()), 3)
        self.assertGreaterEqual(len({d.action for d in world.frame().draws}), 4)
        every = set().union(*seen.values())
        self.assertLessEqual({"idle", "run", "jump", "land", "brawl", "cheer", "climb", "dazed"}, every)
        self.assertLessEqual(every, set(ACTION_FRAMES))

    def test_goblins_are_not_in_lockstep(self):
        world = horde(100, seed=6)
        last, switched_at = {d.id: d.action for d in world.frame().draws}, {}
        for tick in range(round(10 / TICK)):
            world.step(TICK)
            for d in world.frame().draws:
                if last[d.id] != d.action:
                    switched_at.setdefault(d.id, tick)
                last[d.id] = d.action
        self.assertEqual(len(switched_at), 100)
        self.assertGreater(len(set(switched_at.values())), 40)
        runners = [d for d in world.frame().draws if d.action == "run"]
        self.assertGreater(len(runners), 10)
        self.assertGreater(len({d.frame for d in runners}), 1)
        self.assertEqual({d.flip for d in runners}, {True, False})

    def test_every_frame_index_fits_its_action(self):
        world = horde(80, seed=8)
        world.set_platforms([top("a", 300, 900, 500)])
        place(world, 2, 600, 500)
        world.start_battle("right", 0, False, 0.5)
        run(world, 40, lambda frame: self.assertTrue(
            all(0 <= d.frame < ACTION_FRAMES[d.action] and d.scale == 1.0 for d in frame.draws)))


class Excitement(unittest.TestCase):
    def test_a_stir_speeds_the_horde_up_and_wears_off(self):
        for seed in (1, 2, 3):
            calm, stirred = horde(100, seed), horde(100, seed)
            run(calm, 5)
            run(stirred, 5)
            stirred.stir(1.0)
            self.assertGreater(mean_speed(stirred, 3), 1.3 * mean_speed(calm, 3), seed)
            run(calm, 40)
            run(stirred, 40)
            self.assertLess(abs(mean_speed(stirred, 8) / mean_speed(calm, 8) - 1.0), 0.2, seed)

    def test_a_small_stir_does_less_than_a_big_one(self):
        small, big = horde(100, 4), horde(100, 4)
        small.stir(0.2)
        big.stir(1.0)
        self.assertLess(mean_speed(small, 3), mean_speed(big, 3))


class Dragging(unittest.TestCase):
    def test_a_grabbed_goblin_hangs_from_the_cursor_on_top_of_the_rest(self):
        world = horde(30, seed=3)
        run(world, 1)
        self.assertTrue(world.grab(7))
        frames = set()
        for n in range(30):
            world.move_grabbed(600 + 5 * n, 400)
            world.step(TICK)
            frame = world.frame()
            held = frame.draws[-1]
            self.assertEqual((held.id, held.action), (7, "grabbed"))
            self.assertAlmostEqual(held.x, 600 + 5 * n, delta=0.01)
            self.assertAlmostEqual(held.y, 400 + GOBLIN, delta=0.01)
            frames.add(held.frame)
        self.assertGreaterEqual(len(frames), 3)
        self.assertEqual(world.goblin_at(745, 400 + GOBLIN // 2), 7)

    def crowd(self, size=120):
        """A dense horde at rest, and a goblin on its feet near the middle of it."""
        world = horde(size, seed=9, cap=size)
        run(world, 4)
        frame = world.frame()
        middle = next(d.id for d in frame.draws if d.action in FOOTED and W * 0.4 < d.x < W * 0.6)
        return world, middle, {d.id: d for d in frame.draws}

    def test_a_hand_that_carries_more_picks_up_the_nearest_goblins_too(self):
        world, middle, before = self.crowd()
        self.assertTrue(world.grab(middle, 5))
        world.move_grabbed(700, 300)
        run(world, 0.5)
        frame = world.frame()
        held = [d for d in frame.draws if d.action == "grabbed"]
        self.assertEqual(len(held), 5)
        self.assertEqual(frame.draws[-1].id, middle, "the one under the cursor is drawn on top")
        self.assertEqual({d.id for d in frame.draws[-5:]}, {d.id for d in held})
        self.assertEqual(len({(round(d.x), round(d.y)) for d in held}), 5, "each hangs in its own place")
        for d in held:
            self.assertLessEqual(abs(before[d.id].x - before[middle].x), 120 + 0.01, "it stood within reach")
            self.assertLessEqual(abs(d.x - 700), 30)
            self.assertTrue(300 + GOBLIN <= d.y <= 300 + GOBLIN + 30, d)
        self.assertIn(world.goblin_at(700, 300 + GOBLIN // 2), {d.id for d in held})

    def test_a_hand_takes_no_more_than_it_carries(self):
        for most, carried in ((1, 1), (3, 3), (8, 8), (50, 8), (0, 1)):
            world, middle, before = self.crowd(200)
            near = sum(abs(d.x - before[middle].x) <= 120 and abs(d.y - before[middle].y) <= 120 for d in before.values())
            self.assertGreaterEqual(near, 8, "enough stand within reach to fill any hand")
            world.grab(middle, most)
            world.move_grabbed(700, 300)
            run(world, 0.3)
            self.assertEqual(sum(d.action == "grabbed" for d in world.frame().draws), carried, most)

    def test_a_hand_gathers_nobody_from_far_away(self):
        world = horde(3, seed=1)
        for goblin_id, x in ((0, 300), (1, 900), (2, 1500)):
            world.grab(goblin_id)
            world.move_grabbed(x, GROUND - GOBLIN - 2)
            run(world, 0.2)
            world.drop()
        run(world, 0.2)
        world.grab(0, 8)
        run(world, 0.3)
        self.assertEqual([d.id for d in world.frame().draws if d.action == "grabbed"], [0])

    def test_a_handful_let_go_flies_off_together_and_fans_out(self):
        world, middle, _ = self.crowd()
        world.grab(middle, 6)
        for n in range(15):
            world.move_grabbed(500 + 60 * n, 300)
            world.step(TICK)
        held = [d.id for d in world.frame().draws if d.action == "grabbed"]
        start = {d.id: d.x for d in world.frame().draws if d.id in held}
        world.drop()
        run(world, 0.3)
        flown = {d.id: d.x - start[d.id] for d in world.frame().draws if d.id in held}
        self.assertEqual(len(flown), 6)
        self.assertTrue(all(far > 80 for far in flown.values()), flown)
        self.assertGreater(max(flown.values()) - min(flown.values()), 8, "not as one lump")
        self.assertEqual(world.frame().draws[-1].action == "grabbed", False)
        for goblin_id in held:
            self.assertTrue(on_ground(draw_of(world, goblin_id)) or lands(world, goblin_id))

    def test_grabbing_nobody_is_refused(self):
        world = horde(5)
        self.assertFalse(world.grab(5))
        self.assertFalse(world.grab(-1))
        world.move_grabbed(100, 100)
        world.drop()
        self.assertEqual(len(world.frame().draws), 5)

    def test_the_cursor_finds_the_goblin_drawn_on_top(self):
        world = horde(120, seed=9)
        run(world, 4)
        frame = world.frame()
        order = {d.id: n for n, d in enumerate(frame.draws)}
        by_id = {d.id: d for d in frame.draws}
        for d in frame.draws:
            if d.action in FOOTED:
                found = world.goblin_at(d.x, d.y - GOBLIN / 2)
                self.assertIsNotNone(found, d)
                self.assertGreaterEqual(order[found], order[d.id])
                self.assertLess(abs(by_id[found].x - d.x), 2 * GOBLIN)
        self.assertIsNone(world.goblin_at(W / 2, 100))

    def test_a_goblin_dropped_on_a_window_stays_until_it_walks_off_the_end(self):
        for seed in (1, 2, 3, 5):
            world = horde(6, seed)
            world.set_platforms([top("a", 400, 820, 700)])
            place(world, 0, 600, 700)
            self.assertEqual(draw_of(world, 0).y, 700, seed)
            last_on = None
            for _ in range(round(400 / TICK)):
                world.step(TICK)
                d = draw_of(world, 0)
                if d.y != 700:
                    break
                self.assertTrue(390 <= d.x <= 830 and d.action in ("idle", "run", "sit", "land", "jump"), d)
                last_on = d
            else:
                self.fail("never left the window (seed %d)" % seed)
            self.assertTrue(last_on.x < 400 + 14 or last_on.x > 820 - 14, last_on)
            self.assertEqual(d.action, "jump")
            self.assertTrue(lands(world, 0), seed)

    def test_a_goblin_sits_at_a_window_end_with_its_legs_over_the_side(self):
        world = horde(8, seed=2)
        world.set_platforms([top("a", 400, 820, 700)])
        for goblin_id, x in ((0, 450), (1, 600), (2, 780)):
            place(world, goblin_id, x, 700)
        sits = []
        run(world, 90, lambda frame: sits.extend(d for d in frame.draws if d.action == "sit"))
        self.assertTrue(sits)
        self.assertEqual({d.frame for d in sits}, {0, 1})
        for d in sits:
            self.assertEqual(d.y, 700)
            self.assertIn((d.x, d.flip), ((400, True), (820, False)), d)

    def test_a_thrown_goblin_keeps_the_cursor_speed_up_to_a_limit(self):
        world = horde(3, seed=1)
        world.grab(0)
        for n in range(15):
            world.move_grabbed(300 + 100 * n, 300)
            world.step(TICK)
        world.drop()
        before = draw_of(world, 0)
        world.step(TICK)
        after = draw_of(world, 0)
        speed = math.hypot(after.x - before.x, after.y - before.y) / TICK
        self.assertGreater(after.x, before.x + 5)
        self.assertLessEqual(speed, THROW_MAX * UNIT * 1.1)
        self.assertGreater(speed, THROW_MAX * UNIT * 0.5)

    def test_a_goblin_let_go_at_rest_falls_straight_down(self):
        world = horde(3, seed=1)
        world.grab(0)
        world.move_grabbed(900, 300)
        run(world, 1)
        world.drop()
        self.assertTrue(lands(world, 0, falling=True))
        self.assertLess(abs(draw_of(world, 0).x - 900), 2)

    def test_a_goblin_at_the_very_end_of_a_window_rides_it_at_any_scale(self):
        for unit in (2, 3, 4):
            world = World(W, H, GROUND, unit=unit, seed=2)
            world.set_horde(8)
            world.set_platforms([top("a", 400, 820, 700)])
            for goblin_id, x in ((0, 450), (1, 600), (2, 780)):
                world.grab(goblin_id)
                world.move_grabbed(x, 700 - 11 * unit - 12)
                run(world, 0.4)
                world.drop()
            sitter = None
            for _ in range(round(120 / TICK)):
                world.step(TICK)
                sitter = next((d for d in world.frame().draws if d.action == "sit"), None)
                if sitter:
                    break
            self.assertIsNotNone(sitter, unit)
            for n in range(1, 16):
                world.set_platforms([top("a", 400 + 7 * n, 820 + 7 * n, 700 - n)])
                world.step(TICK)
                moved = draw_of(world, sitter.id)
                self.assertEqual((moved.action, moved.y), ("sit", 700 - n), (unit, n))
                self.assertAlmostEqual(moved.x - sitter.x, 7 * n, delta=0.01)


class Windows(unittest.TestCase):
    def riders(self, world, tops, spots):
        world.set_platforms(tops)
        for goblin_id, x in spots:
            place(world, goblin_id, x, tops[0].y)
        return [goblin_id for goblin_id, _ in spots]

    def test_a_window_dragged_sideways_carries_its_goblins(self):
        world = horde(8, seed=4)
        ids = self.riders(world, [top("a", 400, 900, 600)], ((0, 500), (1, 650), (2, 800)))
        last = {i: draw_of(world, i) for i in ids}
        for n in range(1, 31):
            world.set_platforms([top("a", 400 + 20 * n, 900 + 20 * n, 600)])
            world.step(TICK)
            for i in ids:
                d = draw_of(world, i)
                if d.y == 600 and last[i].y == 600:
                    self.assertLess(abs(d.x - last[i].x - 20), 5, (n, d))
                last[i] = d
        riding = [d for d in last.values() if d.y == 600]
        self.assertGreaterEqual(len(riding), 2)
        self.assertTrue(all(1000 <= d.x <= 1500 for d in riding), riding)

    def test_a_window_moved_up_or_down_carries_its_goblins(self):
        world = horde(8, seed=4)
        ids = self.riders(world, [top("a", 400, 900, 600)], ((0, 500), (1, 800)))
        for y in (560, 300, 720):
            world.set_platforms([top("a", 400, 900, y)])
            world.step(TICK)
            self.assertEqual([draw_of(world, i).y for i in ids], [y, y])

    def test_a_window_that_closes_drops_its_goblins(self):
        world = horde(8, seed=4)
        ids = self.riders(world, [top("a", 400, 900, 600)], ((0, 500), (1, 800)))
        world.set_platforms([])
        world.step(TICK)
        self.assertEqual([draw_of(world, i).action for i in ids], ["jump", "jump"])
        self.assertTrue(all(lands(world, i) for i in ids))

    def test_a_stretch_another_window_covers_drops_who_stood_there_and_nobody_else(self):
        world = horde(8, seed=4)
        ids = self.riders(world, [top("a", 400, 900, 600)], ((0, 480), (1, 820)))
        kept = draw_of(world, 1).x
        world.set_platforms([top("a", 700, 900, 600, origin=400)])
        world.step(TICK)
        self.assertEqual(draw_of(world, 0).action, "jump")
        stayed = draw_of(world, 1)
        self.assertEqual(stayed.y, 600)
        self.assertLess(abs(stayed.x - kept), 6)

    def test_tops_too_thin_or_too_near_the_ground_are_not_platforms(self):
        world = horde(4, seed=4)
        world.set_platforms([top("thin", 600, 622, 500), top("low", 900, 1300, GROUND - 10)])
        for goblin_id, x, y in ((0, 611, 500), (1, 1100, GROUND - 10)):
            world.grab(goblin_id)
            world.move_grabbed(x, y - GOBLIN - 12)
            run(world, 0.4)
            world.drop()
            self.assertTrue(lands(world, goblin_id, falling=True), goblin_id)

    def test_a_top_cut_short_by_the_screen_edge_has_no_drop_there(self):
        world = horde(4, seed=6)
        world.set_platforms([top("a", -300, 280, 500)])
        place(world, 0, 60, 500)
        left_at = None
        for _ in range(round(400 / TICK)):
            world.step(TICK)
            d = draw_of(world, 0)
            self.assertGreaterEqual(d.x, 0, d)
            self.assertFalse(d.action == "sit" and d.x < 100, d)
            if d.y != 500:
                break
            left_at = d.x
        self.assertGreater(left_at, 280 - 14)

    def test_goblins_on_a_top_as_wide_as_the_screen_still_get_down_to_a_battle(self):
        world = horde(6, seed=6)
        world.set_platforms([top("a", 0, W, 500)])
        for goblin_id, x in ((0, 300), (1, 1000), (2, 1700)):
            place(world, goblin_id, x, 500)
        self.assertEqual([draw_of(world, i).y for i in range(3)], [500, 500, 500])
        world.start_battle("right", 0, True, 1.8)
        down = set()
        run(world, 12, lambda frame: down.update(d.id for d in frame.draws if d.id < 3 and on_ground(d)))
        self.assertEqual(down, {0, 1, 2})

    def test_a_goblin_lands_on_the_highest_top_under_it(self):
        world = horde(4, seed=4)
        world.set_platforms([top("a", 400, 900, 700), top("b", 500, 800, 400)])
        place(world, 0, 650, 300)
        self.assertEqual(draw_of(world, 0).y, 400)
        place(world, 1, 650, 550)
        self.assertEqual(draw_of(world, 1).y, 700)


class Rewards(unittest.TestCase):
    def test_a_reward_pops_its_amount_and_coins_and_neighbours_jump_and_cheer(self):
        world = horde(80, seed=5)
        run(world, 3)
        calm = sum(d.action == "cheer" for d in world.frame().draws)
        world.reward(12, near=700)
        frame = world.frame()
        amount = [p for p in frame.pops if p.text == "+12"]
        self.assertEqual(len(amount), 1)
        self.assertEqual(amount[0].kind, "coin")
        self.assertLess(abs(amount[0].x - 700), 120)
        self.assertGreaterEqual(sum(p.kind == "coin" and not p.text for p in frame.pops), 3)
        cheering = [d.id for d in frame.draws if d.action == "cheer" and abs(d.x - 700) < 200]
        self.assertGreaterEqual(len(cheering), 5)
        self.assertGreater(sum(d.action == "cheer" for d in frame.draws), calm)
        heights = {i: [] for i in cheering}
        run(world, 0.8, lambda f: [heights[d.id].append(d.y) for d in f.draws if d.id in heights])
        self.assertTrue(all(max(ys) - min(ys) > 8 for ys in heights.values()), heights)
        run(world, 4)
        self.assertEqual([p for p in world.frame().pops if p.text], [])

    def test_pops_age_toward_their_life(self):
        world = horde(10, seed=5)
        world.reward(3)
        run(world, 0.5)
        for p in world.frame().pops:
            self.assertTrue(0 < p.age < p.life, p)
            self.assertIn(p.kind, ("coin", "hit", "alert", "dust", "star", "banner"))

    def test_a_reward_with_nobody_home_still_pops(self):
        world = horde(0)
        world.reward(5, near=400)
        self.assertEqual([p.text for p in world.frame().pops if p.text], ["+5"])


class WithTheArt(unittest.TestCase):
    def test_the_sim_loads_no_tk_and_none_of_the_old_top_down_modules(self):
        code = ("import sys, pet_world; print(sorted(m for m in sys.modules "
                "if m == 'tkinter' or m.startswith(('goblin_', 'field_', 'desktop_', 'horde_'))))")
        root = Path(__file__).resolve().parent.parent
        done = subprocess.run([sys.executable, "-c", code], cwd=root, capture_output=True, text=True, timeout=60)
        self.assertEqual((done.returncode, done.stdout.strip()), (0, "[]"), done.stderr)

    def test_every_goblin_frame_and_pop_the_sim_asks_for_can_be_drawn(self):
        import goblin_look
        import pet_art
        world = horde(60, seed=8)
        world.set_platforms([top("a", 300, 900, 500)])
        for goblin_id, x in ((1, 350), (2, 600), (3, 850)):
            place(world, goblin_id, x, 500)
        world.grab(4)
        world.reward(5)
        asked, pops = set(), set()

        def note(frame):
            asked.update((d.action, d.frame, d.flip) for d in frame.draws)
            pops.update(p.kind for p in frame.pops if not p.text)

        run(world, 30, note)
        world.start_battle("left", 0, True, 1.8)
        run(world, 30, note)
        self.assertEqual({action for action, _, _ in asked}, set(ACTION_FRAMES))
        for action, frame, flip in asked:
            pixels = pet_art.goblin_pixels(goblin_look.look_for(7), action, frame, flip)
            self.assertTrue(any(cell for row in pixels.rows for cell in row), (action, frame))
        self.assertLessEqual({"coin", "dust", "star", "alert"}, pops)
        for kind in pops:
            self.assertTrue(pet_art.effect_pixels(kind).rows, kind)


class Cost(unittest.TestCase):
    def test_two_hundred_goblins_step_and_draw_fast_enough(self):
        world = horde(200, seed=7, cap=200)
        world.set_platforms([top("a", 400, 900, 600), top("b", 1000, 1500, 400)])
        run(world, 3)
        world.start_battle("right", 0, True, 1.8)
        steps, draws = [], []
        for _ in range(450):
            t0 = time.perf_counter()
            world.step(TICK)
            t1 = time.perf_counter()
            frame = world.frame()
            t2 = time.perf_counter()
            steps.append(t1 - t0)
            draws.append(t2 - t1)
        self.assertEqual(len(frame.draws), 200)
        self.assertLess(statistics.median(steps), 0.006)
        self.assertLess(statistics.median(draws), 0.003)


if __name__ == "__main__":
    unittest.main()
