"""The boss fight of the side-view pet world: the boss walks in, the horde swarms it, it falls or leaves.

Every check plays a seeded battle through World's public calls and reads back what a view would draw."""

import functools
import math
import unittest

from pet_battle import boss_profile
from pet_behaviors import LANES
from pet_platform import Platform
from pet_world import World

W, H, GROUND, UNIT = 1920, 1080, 1032, 2
TICK = 1 / 30
GOBLIN = 11 * UNIT
DEPTH = (LANES - 1) * UNIT
LIMITS = {"enter": 9, "charge": 5, "swarm": 20, "finish": 6, "rout": 8, "disperse": 9}
BOSS_FRAMES = {"stand": 2, "walk": 4, "stomp": 2, "roar": 2, "hurt": 1, "fall": 3}


class Show:
    """One battle as a view saw it: (seconds since it began, Frame) per tick, and the timed events."""

    def __init__(self, frames, events, over):
        self.frames, self.events, self.over = frames, events, over

    def spans(self):
        """[(phase, start, end)] in the order the frames showed them."""
        spans = []
        for t, frame in self.frames:
            if not spans or spans[-1][0] != frame.phase:
                spans.append([frame.phase, t - TICK, t])
            spans[-1][2] = t
        return [tuple(span) for span in spans]

    def during(self, phase):
        return [(t, frame) for t, frame in self.frames if frame.phase == phase]

    def at(self, phase, seconds):
        """The frame `seconds` into a phase."""
        frames = self.during(phase)
        return frames[min(len(frames) - 1, round(seconds / TICK))][1]

    def after(self, seconds):
        """The frame `seconds` after battle_over."""
        return min(self.frames, key=lambda item: abs(item[0] - self.over - seconds))[1]

    def named(self, name):
        return [detail for _, (kind, detail) in self.events if kind == name]


def begin(size=120, seed=1, cap=200):
    world = World(W, H, GROUND, unit=UNIT, seed=seed, cap=cap)
    world.set_horde(size)
    for _ in range(round(3 / TICK)):
        world.step(TICK)
    return world


def play(world, after=10.0):
    """Step a world whose battle has started until `after` seconds past its battle_over."""
    frames, events, t, over = [], [], 0.0, None
    while over is None or t < over + after:
        happened = world.step(TICK)
        t += TICK
        events += [(t, event) for event in happened]
        if over is None and any(event[0] == "battle_over" for event in happened):
            over = t
        frames.append((t, world.frame()))
        if t > 90:
            raise AssertionError("the battle never ended")
    return Show(frames, events, over)


@functools.lru_cache(maxsize=None)
def played(size=120, seed=1, boss=0, won=True, ratio=1.8, side="right"):
    world = begin(size, seed)
    assert world.start_battle(side, boss, won, ratio)
    return play(world)


def half_width(boss, v):
    """The boss profile's half width in screen pixels at height fraction `v`."""
    pairs = sorted(boss_profile(boss.index).slices)
    below = max((p for p in pairs if p[0] <= v), default=pairs[0])
    above = min((p for p in pairs if p[0] >= v), default=pairs[-1])
    k = (v - below[0]) / (above[0] - below[0]) if above[0] > below[0] else 0.0
    return (below[1] + (above[1] - below[1]) * k) * boss.height_px


def climbers(frame):
    """Goblins drawn gripping, high enough that they are on the boss and not mounting a friend."""
    return [d for d in frame.draws if d.action == "climb" and d.y < GROUND - 3 * GOBLIN]


def near_boss(frame, x):
    return sum(abs(d.x - x) <= 250 for d in frame.draws) / len(frame.draws)


def tenths(frame):
    counts = [0] * 10
    for d in frame.draws:
        counts[min(9, int(d.x * 10 / W))] += 1
    return counts


class Phases(unittest.TestCase):
    def check_order(self, show, ending):
        spans = show.spans()
        order = ["enter", "charge", "swarm", ending, "disperse", "roam"]
        self.assertEqual([name for name, _, _ in spans], order)
        self.assertEqual(show.named("phase"), order)
        for name, start, end in spans[:-1]:
            self.assertLessEqual(end - start, LIMITS[name] + TICK, name)
            self.assertGreater(end - start, 0.2, name)

    def test_a_win_runs_its_phases_in_order_inside_their_time_limits(self):
        self.check_order(played(won=True, ratio=1.8), "finish")
        self.check_order(played(won=True, ratio=1.05, seed=3, side="left"), "finish")

    def test_a_loss_runs_its_phases_in_order_inside_their_time_limits(self):
        self.check_order(played(won=False, ratio=0.6), "rout")
        self.check_order(played(won=False, ratio=0.1, seed=3, side="left"), "rout")

    def test_a_fight_lasts_about_25_seconds_and_a_close_one_longer_than_a_walkover(self):
        walkover, usual, close = (played(won=True, ratio=r).over for r in (5.0, 1.8, 1.05))
        self.assertTrue(20 <= usual <= 30, usual)
        self.assertLess(walkover + 3, usual)
        self.assertLess(usual + 3, close)
        self.assertLess(close, 40)
        hopeless, near_miss = (played(won=False, ratio=r).over for r in (0.1, 0.9))
        self.assertLess(hopeless + 5, near_miss)
        self.assertTrue(12 <= hopeless and near_miss <= 40, (hopeless, near_miss))

    def test_battle_over_fires_exactly_once_with_the_outcome(self):
        for won, ratio, boss in ((True, 1.8, 0), (False, 0.6, 0), (True, 3.5, 23)):
            show = played(won=won, ratio=ratio, boss=boss)
            self.assertEqual(show.named("battle_over"), [{"won": won, "boss": boss}])

    def test_battling_is_true_until_battle_over(self):
        world = begin(40)
        self.assertFalse(world.battling)
        world.start_battle("left", 2, True, 2.0)
        self.assertTrue(world.battling)
        over = False
        for _ in range(round(60 / TICK)):
            over = over or any(event[0] == "battle_over" for event in world.step(TICK))
            self.assertEqual(world.battling, not over)
        self.assertTrue(over)

    def test_a_second_battle_is_refused_until_the_first_is_over(self):
        world = begin(40)
        self.assertTrue(world.start_battle("left", 2, True, 2.0))
        self.assertFalse(world.start_battle("right", 9, False, 0.2))
        show = play(world, after=1.0)
        self.assertEqual(show.named("battle_over"), [{"won": True, "boss": 2}])
        self.assertEqual({frame.boss.index for _, frame in show.frames if frame.boss}, {2})
        self.assertTrue(world.start_battle("right", 9, False, 0.2))
        again = play(world, after=1.0)
        self.assertEqual(again.named("battle_over"), [{"won": False, "boss": 9}])
        self.assertEqual(again.frames[0][1].phase, "enter")


class TheBoss(unittest.TestCase):
    def test_it_walks_in_from_the_chosen_edge_along_the_ground(self):
        for side, start, flip in (("left", lambda x: x < 0, False), ("right", lambda x: x > W, True)):
            show = played(side=side)
            walk = [frame.boss for _, frame in show.during("enter")]
            self.assertTrue(start(walk[0].x), walk[0])
            self.assertTrue(all(b.pose == "walk" and b.flip == flip for b in walk[:-1]))
            self.assertTrue(all(GROUND <= b.y <= GROUND + DEPTH for b in walk))
            steps = [after.x - before.x for before, after in zip(walk, walk[1:-1])]
            self.assertTrue(all(step < 0 for step in steps) if flip else all(step > 0 for step in steps))
            self.assertTrue(0 < walk[-1].x < W)
            self.assertGreater(len({b.frame for b in walk}), 2)

    def test_it_stands_and_falls_clear_of_the_ground_the_view_keeps_and_is_no_longer_coming_on(self):
        kept = 400
        for won, ending in ((True, "finish"), (False, "rout")):
            plain = played(side="right", won=won, ratio=1.8 if won else 0.6)
            world = begin(120, 1)
            world.keep_clear(right=kept)
            world.start_battle("right", 0, won, 1.8 if won else 0.6)
            show = play(world)
            widest = max(half_width(show.at("swarm", 1).boss, v / 10) for v in range(1, 10))
            stood = [frame.boss for _, frame in show.during("swarm") + show.during("finish") if frame.boss]
            self.assertGreater(len(stood), 100)
            for boss in stood:
                self.assertLessEqual(boss.x + widest, W - kept + 1)
                if boss.pose == "fall":
                    self.assertLessEqual(boss.x + boss.height_px, W - kept + 1, "it falls on clear ground too")
            self.assertGreater(plain.at("swarm", 1).boss.x + widest, W - kept, "without the word it stood there")
            for phase in ("enter", ending):
                took = {name: end - start for name, start, end in show.spans()}[phase]
                usual = {name: end - start for name, start, end in plain.spans()}[phase]
                self.assertAlmostEqual(took, usual, delta=0.25, msg=phase)
        world = begin(120, 1)
        world.keep_clear(right=kept)
        world.start_battle("left", 0, True, 1.8)
        self.assertEqual(play(world).at("swarm", 1).boss.x, played(side="left").at("swarm", 1).boss.x, "the far side is as it was")

    def test_no_side_picks_one_by_the_seed(self):
        sides = set()
        for seed in range(8):
            world = begin(5, seed)
            world.start_battle(None, 0, True, 2.0)
            world.step(TICK)
            sides.add(world.frame().boss.flip)
        self.assertEqual(sides, {True, False})

    def test_it_is_as_tall_as_its_profile_says(self):
        heights = []
        for boss in (0, 6, 17, 35):
            world = begin(3)
            world.start_battle("left", boss, True, 2.0)
            world.step(TICK)
            height = world.frame().boss.height_px
            self.assertAlmostEqual(height, boss_profile(boss).height_goblins * GOBLIN)
            heights.append(height)
        self.assertEqual(heights, sorted(heights))
        self.assertGreater(heights[-1], 1.8 * heights[0])

    def test_its_poses_and_frames_are_ones_the_art_has(self):
        for show in (played(won=True, ratio=1.05), played(won=False, ratio=0.6)):
            poses = set()
            for _, frame in show.frames:
                if frame.boss:
                    self.assertIn(frame.boss.pose, BOSS_FRAMES)
                    self.assertTrue(0 <= frame.boss.frame < BOSS_FRAMES[frame.boss.pose], frame.boss)
                    poses.add(frame.boss.pose)
            self.assertLessEqual({"stand", "walk", "stomp", "roar", "hurt"}, poses)

    def test_the_art_can_draw_every_boss_frame_the_sim_asks_for(self):
        import pet_boss
        asked = {(frame.boss.index, frame.boss.pose, frame.boss.frame, frame.boss.flip, frame.boss.flash)
                 for show in (played(won=True, ratio=1.05), played(won=False, ratio=0.6, side="left"))
                 for _, frame in show.frames if frame.boss}
        self.assertGreater(len(asked), 20)
        for index, pose, frame, flip, flash in asked:
            pixels = pet_boss.boss_pixels(index, pose, frame, flip, flash)
            self.assertTrue(any(cell for row in pixels.rows for cell in row), (pose, frame))

    def test_every_boss_can_be_fought(self):
        for boss in range(36):
            world = World(W, H, GROUND, unit=UNIT, seed=boss, cap=20)
            world.set_horde(12)
            self.assertTrue(world.start_battle(None, boss, boss % 2 == 0, 0.4 + boss % 5))
            show = play(world, after=0.5)
            self.assertEqual(show.named("battle_over"), [{"won": boss % 2 == 0, "boss": boss}])
            self.assertTrue(all(math.isfinite(d.x) and 0 <= d.x <= W and 0 <= d.y <= GROUND + DEPTH
                                for _, frame in show.frames for d in frame.draws), boss)


class Health(unittest.TestCase):
    def hp(self, show):
        return [frame.boss.hp for _, frame in show.frames if frame.boss]

    def test_a_win_drains_it_to_nothing(self):
        for ratio in (5.0, 1.8, 1.05):
            show = played(won=True, ratio=ratio)
            hp = self.hp(show)
            self.assertEqual(hp[0], 1.0)
            self.assertEqual(hp[-1], 0.0)
            self.assertTrue(all(later <= earlier for earlier, later in zip(hp, hp[1:])))
            self.assertTrue(all(frame.boss.hp == 1.0 for _, frame in show.during("enter")))
            swarm = [frame.boss.hp for _, frame in show.during("swarm")]
            self.assertGreater(len(set(swarm)), 100)
            self.assertTrue(all(frame.boss.hp == 0.0 for _, frame in show.during("finish") if frame.boss))

    def test_a_loss_leaves_what_the_horde_could_not_take(self):
        for ratio, left in ((0.6, 0.4), (0.05, 0.9), (0.98, 0.1), (0.3, 0.7)):
            show = played(won=False, ratio=ratio)
            hp = self.hp(show)
            self.assertEqual(hp[0], 1.0)
            self.assertAlmostEqual(hp[-1], left)
            self.assertAlmostEqual(min(hp), left)
            self.assertTrue(all(later <= earlier for earlier, later in zip(hp, hp[1:])))

    def test_it_flashes_and_hits_are_reported_while_the_horde_is_on_it(self):
        show = played(won=True, ratio=1.8)
        self.assertTrue(any(frame.boss.flash for _, frame in show.during("swarm")))
        self.assertFalse(any(frame.boss.flash for _, frame in show.during("enter")))
        hits = [(t, blows) for t, (kind, blows) in show.events if kind == "hit"]
        self.assertGreater(len(hits), 10)
        self.assertTrue(all(isinstance(blows, int) and blows > 0 for _, blows in hits))
        swarm_start, swarm_end = next((s, e) for name, s, e in show.spans() if name == "swarm")
        self.assertTrue(all(swarm_start <= t <= swarm_end + TICK for t, _ in hits))
        texts = {p.text for _, frame in show.during("swarm") for p in frame.pops if p.kind == "hit"}
        self.assertLessEqual({"-%d" % blows for _, blows in hits[:5]}, texts)


class TheSwarm(unittest.TestCase):
    def test_the_horde_gathers_on_the_boss_and_was_spread_before(self):
        show = played(size=150)
        self.assertLess(near_boss(show.frames[0][1], show.at("swarm", 6).boss.x), 0.45)
        mid = show.at("swarm", 6)
        self.assertGreater(near_boss(mid, mid.boss.x), 0.8)
        self.assertGreater(len(climbers(mid)), 10)
        self.assertGreater(sum(d.action == "brawl" and d.y >= GROUND - GOBLIN for d in mid.draws), 10)

    def test_the_charge_goes_in_waves(self):
        for seed in (1, 2, 3):
            show = played(size=150, seed=seed)
            began = next(start for name, start, _ in show.spans() if name == "charge")
            frames = [(t - began, frame) for t, frame in show.frames if began <= t <= began + 3.1]
            charged, share = set(), {}
            for (_, before), (t, after) in zip(frames, frames[1:]):
                was = {d.id: d.x for d in before.draws}
                boss_x = after.boss.x
                charged |= {d.id for d in after.draws
                            if d.action == "run" and abs(d.x - boss_x) < abs(was[d.id] - boss_x) - 2}
                share[round(t, 2)] = len(charged) / 150
            waves = [share[mark] for mark in (0.47, 1.07, 1.67, 2.27)]
            self.assertTrue(0.1 < waves[0] < 0.35, (seed, waves))
            for earlier, later in zip(waves, waves[1:]):
                self.assertGreater(later, earlier + 0.1, (seed, waves))
            self.assertGreater(share[3.0], 0.85, seed)

    def test_climbers_cling_inside_the_boss_silhouette(self):
        """Half a goblin of overhang is allowed, and the lean of a roaring body: a twentieth of its
        height at the head."""
        for show in (played(size=200), played(size=150, boss=35, seed=2), played(won=False, ratio=0.6, side="left")):
            most = 0
            for _, frame in show.during("swarm"):
                boss = frame.boss
                on_it = climbers(frame)
                most = max(most, len(on_it))
                for d in on_it:
                    v = (boss.y - d.y) / boss.height_px
                    self.assertTrue(0.0 <= v <= 1.0, (v, d))
                    reach = half_width(boss, v) + GOBLIN / 2 + 0.05 * boss.height_px * v
                    self.assertLessEqual(abs(d.x - boss.x), reach, (v, d, boss))
            self.assertGreater(most, 20)

    def test_climbers_keep_their_hold_while_the_boss_walks(self):
        show = played(size=200)
        swarm = [frame for _, frame in show.during("swarm")]
        first = next(n for n, frame in enumerate(swarm) if frame.boss.pose == "walk")
        last = next(n for n in range(first, len(swarm)) if swarm[n].boss.pose != "walk") - 1
        carried = swarm[last].boss.x - swarm[first].boss.x
        self.assertGreater(abs(carried), 0.2 * swarm[first].boss.height_px)
        holding = set.intersection(*({d.id for d in climbers(frame)} for frame in swarm[first:last + 1]))
        start = {d.id: d for d in swarm[first].draws}
        end = {d.id: d for d in swarm[last].draws}
        kept = [i for i in holding
                if abs((end[i].x - swarm[last].boss.x) - (start[i].x - swarm[first].boss.x)) < 2
                and abs((end[i].y - swarm[last].boss.y) - (start[i].y - swarm[first].boss.y)) < 6]
        self.assertGreaterEqual(len(kept), 5)
        for i in kept:
            self.assertAlmostEqual(end[i].x - start[i].x, carried, delta=2)

    def test_climbers_shake_with_a_roaring_boss(self):
        show = played(size=200)
        frames = [frame for _, frame in show.during("swarm")]
        shaken = 0
        for before, after in zip(frames, frames[1:]):
            shift = after.boss.x - before.boss.x
            if before.boss.pose == after.boss.pose == "roar" and abs(shift) > 4:
                was = {d.id: d.x for d in climbers(before)}
                moved = [d.x - was[d.id] for d in climbers(after) if d.id in was]
                self.assertGreater(len(moved), 5)
                self.assertGreater(sum(abs(m - shift) < 2.5 for m in moved), 0.7 * len(moved), (shift, moved))
                shaken += 1
        self.assertGreater(shaken, 5)

    def test_a_stomp_never_floors_more_than_a_fifth_of_the_horde(self):
        for size, shows in ((200, (played(size=200), played(size=200, won=False, ratio=0.2))),
                            (30, (played(size=30),)), (3, (played(size=3),))):
            for show in shows:
                floored = [sum(d.action == "dazed" for d in frame.draws) for _, frame in show.frames]
                self.assertLessEqual(max(floored), max(1, size // 5), size)
                if size == 200:
                    self.assertGreater(max(floored), 10)
                    flung = max(sum(d.action == "grabbed" for d in frame.draws) for _, frame in show.frames)
                    self.assertGreater(flung, 20)

    def test_goblins_on_a_window_run_off_it_to_join_in(self):
        world = begin(12)
        world.set_platforms([Platform(500.0, 900.0, 600.0, "window", "a", (500.0, 600.0))])
        for goblin_id, x in ((0, 600), (1, 800)):
            world.grab(goblin_id)
            world.move_grabbed(x, 600 - GOBLIN - 12)
            for _ in range(12):
                world.step(TICK)
            world.drop()
        for _ in range(20):
            world.step(TICK)
        self.assertEqual([d.y for d in world.frame().draws if d.id < 2], [600, 600])
        world.start_battle("right", 0, True, 1.8)
        show = play(world, after=0.5)
        mid = show.at("swarm", 6)
        self.assertTrue(all(d.y != 600 and abs(d.x - mid.boss.x) < 300 for d in mid.draws if d.id < 2))


@functools.lru_cache(maxsize=None)
def on_a_screen(width, size=150, seed=1, side="left"):
    """A won fight on a screen `width` pixels wide, from the moment it is asked for."""
    world = World(width, H, GROUND, unit=UNIT, seed=seed, cap=size)
    world.set_horde(size)
    for _ in range(round(3 / TICK)):
        world.step(TICK)
    before = world.frame()
    assert world.start_battle(side, 5, True, 1.8)
    return before, play(world, after=0.5)


def gathered(show, share, within=300):
    """Seconds into a fight until `share` of the horde is within `within` pixels of the boss."""
    return next(t for t, frame in show.frames
                if frame.boss and sum(abs(d.x - frame.boss.x) <= within for d in frame.draws) >= share * len(frame.draws))


class WideScreens(unittest.TestCase):
    def test_the_horde_reaches_the_boss_as_fast_on_a_wide_screen_as_on_a_narrow_one(self):
        for seed, side in ((1, "left"), (2, "right")):
            narrow = gathered(on_a_screen(1920, seed=seed, side=side)[1], 0.5)
            for width in (3440, 5120):
                wide = gathered(on_a_screen(width, seed=seed, side=side)[1], 0.5)
                self.assertLess(abs(wide - narrow), 1.5, (width, seed, wide, narrow))
                self.assertLess(wide, 7.0, (width, seed))

    def test_goblins_far_from_the_boss_close_up_while_it_walks_in(self):
        before, show = on_a_screen(5120)
        roar = show.during("charge")[0][1]
        far = {d.id: d.x for d in before.draws if abs(d.x - roar.boss.x) > 2400}
        self.assertGreater(len(far), 30)
        closer = [abs(far[d.id] - roar.boss.x) - abs(d.x - roar.boss.x) for d in roar.draws if d.id in far]
        self.assertGreater(sorted(closer)[len(closer) // 10], 600, "nine in ten came at least 600 pixels nearer")

    def test_goblins_near_the_boss_stand_and_watch_it_walk_in(self):
        before, show = on_a_screen(5120)
        roar = show.during("charge")[0][1]
        near = {d.id: d.x for d in before.draws if 250 < abs(d.x - roar.boss.x) < 800}
        self.assertGreater(len(near), 8)
        moved = sorted(abs(d.x - near[d.id]) for d in roar.draws if d.id in near)
        self.assertLess(moved[len(moved) // 2], 150)

    def test_nobody_runs_faster_than_a_dash(self):
        _, show = on_a_screen(5120)
        fight = [frame for _, frame in show.frames if frame.phase in ("enter", "charge", "swarm")]
        for earlier, later in zip(fight, fight[1:]):
            was = {d.id: d.x for d in earlier.draws if d.action == "run"}
            steps = [abs(d.x - was[d.id]) for d in later.draws if d.action == "run" and d.id in was]
            self.assertLess(max(steps, default=0), 8 * 44 * UNIT * TICK + 4)


def throw_at_boss(world, most=1, pick=None):
    """Carry goblins to the middle of the boss, as a cursor would, and let go. The ids it carried."""
    boss = world.frame().boss
    farthest = max(world.frame().draws, key=lambda d: abs(d.x - boss.x))
    assert world.grab(farthest.id if pick is None else pick, most)
    carried = []
    for _ in range(6):
        boss = world.frame().boss
        world.move_grabbed(boss.x, boss.y - boss.height_px / 2)
        world.step(TICK)
        carried = [d.id for d in world.frame().draws if d.action == "grabbed"]
    world.drop()
    return carried


def fight(size=60, seed=4, boss=3, won=True, ratio=1.8):
    """A fight stepped to its swarm."""
    world = begin(size, seed)
    assert world.start_battle("left", boss, won, ratio)
    while world.frame().phase != "swarm":
        world.step(TICK)
    return world


def seconds_left(world):
    """Step a fight to its end; how long that took."""
    t = 0.0
    while world.battling:
        world.step(TICK)
        t += TICK
        assert t < 90
    return t


class Throwing(unittest.TestCase):
    def test_a_goblin_thrown_onto_the_boss_takes_hold_and_its_blow_shows(self):
        world = fight()
        before = world.frame().boss.hp
        (thrown,) = throw_at_boss(world)
        seen = []
        for _ in range(8):
            world.step(TICK)
            seen.append(world.frame())
        boss = seen[-1].boss
        held_on = next(d for d in seen[-1].draws if d.id == thrown)
        self.assertEqual(held_on.action, "climb")
        self.assertLess(abs(held_on.x - boss.x), half_width(boss, 0.5) + GOBLIN)
        self.assertLess(held_on.y, GROUND - GOBLIN)
        crits = {pop.text for frame in seen for pop in frame.pops if pop.kind == "crit"}
        self.assertEqual(crits, {"-25"})
        self.assertTrue(any(frame.boss.flash for frame in seen))
        self.assertLess(boss.hp, before)
        self.assertGreater(max(frame.quake for frame in seen), 0)

    def test_a_handful_thrown_at_once_pops_as_one_number(self):
        world = fight(size=120)
        carried = throw_at_boss(world, 5)
        self.assertEqual(len(carried), 5)
        crits = []
        for _ in range(8):
            world.step(TICK)
            crits += [pop.text for pop in world.frame().pops if pop.kind == "crit" and pop.age < TICK * 1.5]
        self.assertEqual(sum(int(text) for text in crits), -125, crits)
        self.assertLessEqual(len(crits), 3)

    def test_throwing_goblins_at_the_boss_ends_the_fight_sooner_but_never_skips_more_than_half_the_swarm(self):
        plain = seconds_left(fight())
        once = fight()
        throw_at_boss(once)
        self.assertAlmostEqual(plain - seconds_left(once), 0.4, delta=0.25)
        some = fight()
        for _ in range(5):
            throw_at_boss(some)
        self.assertAlmostEqual(plain - seconds_left(some) - 5 * 6 * TICK, 2.0, delta=0.5)
        many = fight(size=120)
        swarm = 14.0
        spent = 0.0
        for _ in range(12):
            throw_at_boss(many, 8)
            spent += 6 * TICK
        left = seconds_left(many)
        whole = seconds_left(fight(size=120))
        self.assertGreater(whole - left - spent, swarm / 2 - 1.5)
        self.assertLess(whole - left - spent, swarm / 2 + 0.5)

    def test_a_thrown_goblin_that_misses_the_boss_just_lands(self):
        world = fight()
        boss = world.frame().boss
        far = next(d for d in world.frame().draws if d.action in ("idle", "run") and abs(d.x - boss.x) > 300)
        hp = boss.hp
        world.grab(far.id)
        world.move_grabbed(far.x, GROUND - 200)
        for _ in range(4):
            world.step(TICK)
        world.drop()
        pops = []
        for _ in range(30):
            world.step(TICK)
            pops += [pop for pop in world.frame().pops if pop.kind == "crit"]
        self.assertEqual(pops, [])
        self.assertAlmostEqual(world.frame().boss.hp, hp, delta=0.12)

    def test_a_goblin_can_be_thrown_at_the_boss_while_it_is_still_walking_in(self):
        world = begin(60, 4)
        world.start_battle("left", 3, True, 1.8)
        for _ in range(round(1.5 / TICK)):
            world.step(TICK)
        self.assertEqual(world.frame().phase, "enter")
        throw_at_boss(world, 3)
        for _ in range(4):
            world.step(TICK)
        frame = world.frame()
        self.assertTrue(any(pop.kind == "crit" for pop in frame.pops))
        self.assertLess(frame.boss.hp, 1.0)

    def test_a_goblin_thrown_at_a_beaten_boss_passes_through(self):
        world = fight()
        while world.frame().phase != "finish":
            world.step(TICK)
        for _ in range(round(1.6 / TICK)):
            world.step(TICK)
        self.assertEqual(world.frame().boss.pose, "fall")
        thrown = next(d.id for d in world.frame().draws if d.action in ("idle", "run", "cheer"))
        throw_at_boss(world, pick=thrown)
        pops, actions = [], set()
        for _ in range(20):
            world.step(TICK)
            pops += [pop for pop in world.frame().pops if pop.kind == "crit"]
            actions.add(next(d.action for d in world.frame().draws if d.id == thrown))
        self.assertEqual(pops, [])
        self.assertNotIn("climb", actions, "it takes no hold of a boss that is down")

    def test_a_fight_nobody_throws_at_plays_as_it_always_did(self):
        show = played()
        self.assertFalse(any(pop.kind == "crit" for _, frame in show.frames for pop in frame.pops))
        self.assertTrue(all(frame.boss.hp == 1.0 for _, frame in show.during("enter") + show.during("charge")))


class Endings(unittest.TestCase):
    def test_a_win_ends_with_a_fall_a_coin_burst_and_cheers(self):
        show = played(size=150)
        finish = show.during("finish")
        poses = [(frame.boss.pose, frame.boss.frame) for _, frame in finish if frame.boss]
        self.assertEqual(poses[0], ("hurt", 0))
        falls = [frame for pose, frame in poses if pose == "fall"]
        self.assertEqual(falls, sorted(falls))
        self.assertEqual(sorted(set(falls)), [0, 1, 2])
        self.assertEqual(poses[-1], ("fall", 2))
        self.assertFalse(climbers(show.at("finish", 2.0)))
        coins = [sum(p.kind == "coin" and not p.text for p in frame.pops) for _, frame in finish]
        self.assertEqual(coins[0], 0)
        self.assertGreaterEqual(max(coins), 30)
        self.assertGreater(max(frame.quake for _, frame in finish), 6)
        cheering = max(sum(d.action == "cheer" for d in frame.draws) for _, frame in finish)
        self.assertGreater(cheering, 75)
        self.assertIsNone(show.after(0.1).boss)

    def test_a_beaten_boss_falls_back_onto_the_screen(self):
        for side in ("left", "right"):
            show = played(size=30, side=side, boss=35)
            down = next(frame.boss for _, frame in reversed(show.during("finish")) if frame.boss)
            back = down.x + (down.height_px if down.flip else -down.height_px)
            self.assertTrue(0 <= back <= W, (side, down))

    def test_a_loss_ends_with_a_roar_a_shockwave_and_the_boss_walking_out(self):
        for side, flip in (("right", True), ("left", False)):
            show = played(size=150, won=False, ratio=0.6, side=side)
            rout = [frame for _, frame in show.during("rout")]
            self.assertEqual(rout[0].boss.pose, "roar")
            self.assertGreater(len(climbers(show.at("swarm", 12))), 10)
            self.assertFalse(climbers(show.at("rout", 0.8)))
            thrown = max(sum(d.action == "grabbed" for d in frame.draws) for frame in rout)
            self.assertGreater(thrown, 60)
            self.assertGreater(max(frame.quake for frame in rout), 6)
            walking = [frame.boss for frame in rout if frame.boss.pose == "walk"]
            self.assertTrue(all(b.flip != flip for b in walking))
            self.assertTrue(walking[-1].x > W if side == "right" else walking[-1].x < 0, walking[-1])
            self.assertTrue(all(b.hp == rout[0].boss.hp for b in walking))
            self.assertIsNone(show.after(0.1).boss)

    def test_the_boss_is_announced_by_name(self):
        show = played()
        banners = {p.text for _, frame in show.frames for p in frame.pops if p.kind == "banner"}
        self.assertEqual(banners, {boss_profile(0).name})


class Afterwards(unittest.TestCase):
    def test_the_horde_spreads_along_the_whole_ground_again(self):
        for won, ratio, side, seed in ((True, 1.8, "right", 1), (True, 1.05, "left", 2), (False, 0.6, "right", 3),
                                       (False, 0.9, "left", 4), (True, 5.0, "right", 5)):
            show = played(size=150, won=won, ratio=ratio, side=side, seed=seed)
            bunched = tenths(show.at("swarm", 6))
            self.assertGreaterEqual(sum(count == 0 for count in bunched), 5, bunched)
            spread = tenths(show.after(10.0))
            self.assertGreaterEqual(min(spread), 2, (won, side, spread))
            self.assertLessEqual(max(spread), 38, (won, side, spread))
            self.assertEqual(show.after(10.0).phase, "roam")

    def test_a_small_horde_spreads_out_too(self):
        show = played(size=10)
        xs = sorted(d.x for d in show.after(6.0).draws)
        self.assertGreater(xs[-1] - xs[0], W * 0.6)
        self.assertTrue(all(b - a < W * 0.4 for a, b in zip(xs, xs[1:])), xs)

    def test_roaming_goes_on_as_before(self):
        show = played(size=60)
        actions = {d.action for t, frame in show.frames if t > show.over + 8 for d in frame.draws}
        self.assertLessEqual({"idle", "run", "jump"}, actions)
        self.assertFalse([t for t, (kind, _) in show.events if kind == "hit" and t > show.over])


class Edges(unittest.TestCase):
    def test_a_fight_plays_out_with_three_goblins_or_none(self):
        self.assertEqual(played(size=3).named("battle_over"), [{"won": True, "boss": 0}])
        self.assertEqual(played(size=0, won=False, ratio=0.5).named("battle_over"), [{"won": False, "boss": 0}])
        self.assertTrue(any(climbers(frame) for _, frame in played(size=3).during("swarm")))

    def test_odd_inputs_still_make_a_show(self):
        for boss, ratio in ((-4, 1.0), (99, float("nan")), (5, -3.0), (5, float("inf"))):
            world = begin(8)
            self.assertTrue(world.start_battle("sideways", boss, True, ratio))
            show = play(world, after=0.5)
            self.assertEqual(len(show.named("battle_over")), 1)
            self.assertTrue(0 <= show.named("battle_over")[0]["boss"] <= 35)

    def test_the_horde_can_change_size_mid_fight(self):
        world = begin(40)
        world.start_battle("left", 4, True, 1.8)
        for n in range(round(40 / TICK)):
            if n == 200:
                world.set_horde(10)
            if n == 320:
                world.set_horde(60)
            world.step(TICK)
            self.assertTrue(all(0 <= d.x <= W and 0 <= d.y <= GROUND + DEPTH for d in world.frame().draws))
        self.assertEqual(world.shown, 60)
        self.assertFalse(world.battling)


if __name__ == "__main__":
    unittest.main()
