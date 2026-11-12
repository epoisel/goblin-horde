"""The pet field: the see-through window that draws the horde, with a stand-in app and viewer.

The window is the real one, parked off every display, and the pointer is never moved: presses and
drags are Tk events."""

import re
import sys
import time
import tkinter as tk
import tkinter.font as tkfont
import unittest
from concurrent.futures import Future
from types import SimpleNamespace
from unittest.mock import patch

import desktop_platform
import desktop_windows
import pet_art
import pet_boss
import pet_field
from goblin_look import Look, look_for, name_for, title_for
from horde_theme import Theme
from pet_behaviors import BossDraw, Draw, Frame, Pop
from pet_field import AWAY_AFTER, FRAME_MS, HUD, Display, PetField, primary_display, unit_for
from pet_field_canvas import EFFECT_POPS, PICTURES, TEXT_POPS, FieldCanvas
from pet_platform import WindowRect
from pets_feed import WAITING, Feed, Launch, Work, read_game
from pets_text import COIN, LOST, REASONS, REFUSED, TROUBLE_MARK, WELCOME, WELCOME_BACK, WON, reason_line, result_line

try:
    from test_pets_feed import game
except ImportError:
    from test.test_pets_feed import game

DISPLAY = Display(-4000, -3000, 900, 500, 440)
EXTRAS = 46  # The boss, its bar and plate, the pools of pops and banners, and the pill with its mark and its gain.
WIN = {"won": True, "ratio": 3.4, "rewards": {"coins": 54, "scrap": 4, "xp": 0}, "reason": ""}
LOSS = {"won": False, "ratio": 0.2, "rewards": {"coins": 0, "scrap": 0, "xp": 0}, "reason": ""}
NOT_FOUND = "T3 Code's database was not found."


def ready(**numbers) -> Feed:
    return Feed(True, "", (), read_game(game(**numbers)), {"ok": True})


class Viewer:
    """Stands in for PetsFeed: every answer is scripted and nothing leaves the process."""

    delay_ms = 900

    def __init__(self) -> None:
        self.answer = Feed(False, WAITING["offline"])
        self.fight_reply: dict = {}
        self.buy_reply: dict = {}
        self.fights: list[int] = []
        self.buys: list[str] = []

    def poll(self) -> Feed:
        return self.answer

    def buy(self, kind: str) -> dict:
        self.buys.append(kind)
        return self.buy_reply

    def fight(self, boss: int) -> dict:
        self.fights.append(boss)
        return self.fight_reply


class Tips:
    """Stands in for the app's tooltip: remembers the text on show."""

    text = ""

    def schedule(self, text, _x, _y, delay=0) -> None:
        self.text = text

    def hide(self) -> None:
        self.text = ""


class Watcher:
    """Stands in for the window watcher: the test says which windows are open."""

    def __init__(self) -> None:
        self.rects: list = []
        self.running = False

    def start(self):
        self.running = True
        return self

    def stop(self) -> None:
        self.running = False

    def latest(self) -> list:
        return list(self.rects)


def stand_in_app(root) -> SimpleNamespace:
    """What the widget gives a field, with worker calls answered at once on the calling thread."""
    def submit(call, *values) -> Future:
        future = Future()
        future.set_result(call(*values))
        return future
    app = SimpleNamespace(root=root, api=None, tooltip=Tips(), reduced_motion=False, closing=False, menus=[],
                          executor=SimpleNamespace(submit=submit))
    app.when_done = lambda future, done: done(future.result(), None)
    app.show_pets_menu = app.menus.append
    return app


class LayoutTests(unittest.TestCase):
    def test_a_sprite_pixel_is_two_screen_pixels_until_the_display_scales_up(self):
        self.assertEqual([unit_for(scale) for scale in (1.0, 1.25, 1.5, 1.75, 2.0)], [2, 2, 3, 4, 4])

    def test_the_field_stands_on_the_taskbar_and_stops_a_row_short_of_the_display(self):
        window = SimpleNamespace(winfo_screenwidth=lambda: 2560, winfo_screenheight=lambda: 1440)
        with patch.object(desktop_platform, "primary_work_area", return_value=(0, 0, 2560, 1440)), \
                patch.object(desktop_windows, "taskbar_top", return_value=1392) as taskbar_top:
            self.assertEqual(primary_display(window), Display(0, 0, 2560, 1439, 1392))
        taskbar_top.assert_called_once_with(1440)
        with patch.object(desktop_platform, "primary_work_area", return_value=(0, 0, 2560, 1440)), \
                patch.object(desktop_windows, "taskbar_top", return_value=1440):
            self.assertEqual(primary_display(window).ground, 1439, "no taskbar on show: the ground is the field's last row")

    def test_the_field_is_for_windows_where_a_keyed_colour_lets_the_pointer_through(self):
        for system, supported in (("win32", True), ("darwin", False), ("linux", False)):
            with patch.object(desktop_platform, "system", return_value=system):
                self.assertEqual(pet_field.supported(), supported)


class KeyColourTests(unittest.TestCase):
    """A pixel in the see-through colour would be a hole in a sprite that clicks fall through."""

    KEY = desktop_platform.WINDOWS_KEY

    def colours(self, pixels) -> set:
        return {colour for row in pixels.rows for colour in row}

    def test_no_goblin_or_effect_pixel_is_the_see_through_colour(self):
        hats, wears, tools = ["", *pet_art.HATS], ["", *pet_art.WEARS], ["", *pet_art.TOOLS]
        skins = [(pet_art.COMMON, green) for green in range(len(pet_art.GREENS))] + [(skin, 0) for skin in pet_art.SHINIES]
        used = set()
        for index in range(max(len(hats) * 2, len(skins), len(pet_art.CLOTH))):
            skin, green = skins[index % len(skins)]
            look = Look(f"look{index}", skin, green, hats[index % len(hats)], index % len(pet_art.CLOTH),
                        tools[index % len(tools)], wears[index % len(wears)])
            for action, frames in pet_art.FRAMES.items():
                for frame in range(frames):
                    used |= self.colours(pet_art.goblin_pixels(look, action, frame))
        for kind, frames in pet_art.EFFECT_FRAMES.items():
            for frame in range(frames):
                used |= self.colours(pet_art.effect_pixels(kind, frame))
        self.assertGreater(len(used), 40, "the sample dressed goblins in every table's colours")
        self.assertNotIn(self.KEY, used)

    def test_no_boss_pixel_is_the_see_through_colour(self):
        used = set()
        for index in range(0, pet_boss.BOSS_COUNT, pet_boss.ROW):
            for pose, flash in (("stand", False), ("roar", False), ("hurt", True)):
                used |= self.colours(pet_boss.boss_pixels(index, pose, 0, flash=flash))
        self.assertGreater(len(used), 40)
        self.assertNotIn(self.KEY, used)


class PictureTests(unittest.TestCase):
    def test_frames_that_share_one_image_are_drawn_alike_on_every_goblin(self):
        looks = [look_for(goblin) for goblin in range(40)]
        shared = 0
        for action, pictures in PICTURES.items():
            self.assertEqual(len(pictures), pet_art.FRAMES[action])
            for frame, picture in enumerate(pictures):
                shared += picture != frame
                for look in looks:
                    self.assertEqual(pet_art.goblin_pixels(look, action, frame), pet_art.goblin_pixels(look, action, picture),
                                     (action, frame))
        self.assertGreater(shared, 0)


@unittest.skipUnless(sys.platform == "win32", "Builds the real see-through window with Windows Tk")
class FieldCase(unittest.TestCase):
    def setUp(self):
        self.root = tk.Tk()
        self.root.withdraw()
        self.addCleanup(self.root.destroy)
        self.fullscreen = self.idle = None
        for target, name, value in ((pet_field, "primary_display", lambda window: DISPLAY),
                                    (desktop_windows, "WindowWatcher", Watcher),
                                    (desktop_windows, "foreground_is_fullscreen", lambda: bool(self.fullscreen)),
                                    (desktop_windows, "seconds_since_input", lambda: float(self.idle or 0.0))):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.app = stand_in_app(self.root)
        self.field = PetField(self.app, Theme(self.root, 1.0))
        self.addCleanup(self.field.destroy)
        self.field.world.rng.seed(11)
        self.viewer = self.field.feed = Viewer()
        self.field.show()
        self.hold()
        self.root.update()
        self.now = self.field.last

    def hold(self) -> None:
        """Stop the field's own timers so the test drives every frame and poll by hand."""
        for name in ("frame_after", "poll_after"):
            timer = getattr(self.field, name)
            if timer is not None:
                self.root.after_cancel(timer)
                setattr(self.field, name, None)

    def run_frames(self, seconds: float, fps: int = 30) -> None:
        for _ in range(round(seconds * fps)):
            self.now += 1 / fps
            self.field.frame(self.now)

    def skip(self, seconds: float) -> None:
        """Let that long pass in one frame."""
        self.now += seconds
        self.field.frame(self.now)

    def open_game(self, **numbers) -> None:
        self.viewer.answer = ready(**numbers)
        self.field.poll()
        self.hold()
        self.run_frames(0.5)

    def pay(self, *events, source=None, **numbers) -> None:
        """One answer from the viewer with these events in it, then a frame."""
        self.viewer.answer = ready(**numbers)._replace(events=events, source=source or {"ok": True})
        self.field.poll()
        self.hold()
        self.viewer.answer = self.viewer.answer._replace(events=())
        self.skip(1 / 30)

    def fight(self, reply: dict, **after) -> None:
        self.viewer.fight_reply = {**reply, "game": read_game(game(**after)) if after else None}
        self.field.fight(2)

    def fight_out(self) -> None:
        """Run the battle on show to its end."""
        for _ in range(600):
            if self.field.battle is None:
                break
            self.run_frames(0.1, fps=10)
        self.assertIsNone(self.field.battle, "the battle ended")
        self.run_frames(0.1, fps=10)

    def texts(self) -> list[str]:
        canvas = self.field.canvas
        return [canvas.itemcget(item, "text") for item in canvas.find_all()
                if canvas.type(item) == "text" and canvas.itemcget(item, "state") != "hidden"]

    def on_show(self) -> list[int]:
        canvas = self.field.canvas
        return [item for item in canvas.find_all() if canvas.itemcget(item, "state") != "hidden"]

    def pill(self) -> str:
        return self.field.canvas.itemcget(self.field.paint.hud_label, "text")

    def shown(self, item: int, option: str = "text") -> str:
        """What a canvas item shows, or '' while it is hidden."""
        canvas = self.field.canvas
        return "" if canvas.itemcget(item, "state") == "hidden" else canvas.itemcget(item, option)

    def ticker(self) -> str:
        """The gain on the pill."""
        return self.shown(self.field.paint.hud_gain)

    def pops(self) -> list[int]:
        """The words of the pops on show, without their shadows."""
        return [label for _under, label in self.field.paint.words if self.shown(label)]

    def pop_texts(self) -> list[str]:
        return [self.shown(label) for label in self.pops()]

    def pill_tip(self) -> list[str]:
        """The rows of the tip that hovering the pill brings up."""
        left, top, _right, _bottom = self.field.paint.hud_box
        self.field.canvas.event_generate("<Motion>", x=left + 4, y=top + 4)
        rows = self.app.tooltip.text.splitlines()
        self.field.canvas.event_generate("<Leave>")
        return rows

    def standing(self) -> tuple[int, int, int]:
        """A goblin on the ground and a canvas point on its body where it is the one in front."""
        world, unit = self.field.world, self.field.unit
        for draw in world.frame().draws:
            x, y = round(draw.x), round(draw.y) - 5 * unit
            if draw.y >= DISPLAY.ground and world.goblin_at(x, y) == draw.id:
                return draw.id, x, y
        raise AssertionError("no goblin stands clear of the others")


class HordeTests(FieldCase):
    def test_the_window_covers_the_display_it_was_given_and_the_world_fills_it(self):
        self.assertEqual(self.field.window.state(), "normal")
        self.assertEqual((self.field.window.winfo_width(), self.field.window.winfo_height()), (900, 500))
        self.assertEqual((self.field.window.winfo_rootx(), self.field.window.winfo_rooty()), (-4000, -3000))
        world = self.field.world
        self.assertEqual((world.width * world.unit, world.height * world.unit, world.floor * world.unit), (900, 500, 440))

    def test_every_goblin_is_one_image_at_its_feet_and_goes_when_the_horde_shrinks(self):
        self.open_game(size=12)
        canvas, unit = self.field.canvas, self.field.unit
        self.assertEqual(sorted(self.field.paint.items), list(range(12)))
        for draw in self.field.world.frame().draws:
            item = self.field.paint.items[draw.id]
            self.assertEqual(canvas.type(item), "image")
            self.assertEqual(tuple(canvas.coords(item)), (round(draw.x) - pet_art.AX * unit, round(draw.y) - pet_art.GY * unit))
        kept = dict(self.field.paint.items)
        self.open_game(size=5)
        self.run_frames(1.0)
        self.assertEqual(sorted(self.field.paint.items), list(range(5)))
        self.assertEqual({goblin: kept[goblin] for goblin in range(5)}, self.field.paint.items, "the ones that stay keep their items")
        self.assertEqual([canvas.type(kept[goblin]) for goblin in range(5, 12)], [None] * 7)

    def test_a_horde_past_the_cap_shows_the_cap_and_says_what_each_goblin_stands_for(self):
        self.open_game(size=400)
        self.assertEqual(len(self.field.paint.items), 150)
        self.assertEqual(self.pill(), "◉ 64   400 goblins   ×2.7")

    def test_the_pill_says_why_until_the_game_opens_then_shows_its_numbers(self):
        self.run_frames(0.1)
        self.assertEqual(self.pill(), WAITING["offline"])
        self.assertEqual(self.field.menu_rows()[0], (WAITING["offline"], None, False))
        self.open_game(coins=1284, size=37)
        self.assertEqual(self.pill(), "◉ 1,284   37 goblins")
        self.viewer.answer = Feed(False, WAITING["offline"])
        self.field.poll()
        self.hold()
        self.run_frames(0.1)
        self.assertEqual(self.pill(), WAITING["offline"], "a viewer that went away is said, over the old numbers")

    def test_paid_work_pops_the_coins_over_the_horde_and_stirs_it(self):
        self.open_game(size=20)
        self.pay(Work(12, 1), size=20)
        self.assertGreater(self.field.world.excite, 0.0)
        self.assertEqual(self.pop_texts(), ["+12"])
        canvas, label = self.field.canvas, self.pops()[0]
        start = canvas.coords(label)
        self.assertLess(start[1], DISPLAY.ground - 11 * self.field.unit, "over a goblin's head")
        self.run_frames(1.8)
        self.assertEqual(self.pop_texts(), ["+12"], "still up after most of two seconds")
        self.assertEqual(canvas.coords(label)[0], start[0])
        self.assertLess(canvas.coords(label)[1], start[1] - 20, "it has climbed")
        self.run_frames(0.3)
        self.assertEqual(self.pop_texts(), [], "a pop is gone when its time is up")

    def test_coming_back_to_coins_puts_a_banner_up_for_a_while(self):
        self.open_game(size=20)
        self.viewer.answer = ready(size=20)._replace(events=(Launch(False, 319),))
        self.field.poll()
        self.hold()
        self.run_frames(0.2)
        self.assertIn("Welcome back +319", self.texts())
        self.assertIn("+319", self.texts())
        self.run_frames(pet_field.NOTICE_LIFE)
        self.assertNotIn("Welcome back +319", self.texts())

    def test_reduced_motion_shows_one_pose_an_action_and_no_rumble(self):
        self.open_game(size=10)
        self.app.reduced_motion = True
        canvas, world = self.field.canvas, self.field.world
        world.quake = 9.0
        self.run_frames(0.1, fps=10)
        seen = {}
        for _ in range(12):
            before = {draw.id: (draw.action, draw.flip) for draw in world.frame().draws}
            self.run_frames(0.1, fps=10)
            world.quake = 9.0
            for draw in world.frame().draws:
                if before.get(draw.id) == (draw.action, draw.flip):
                    seen.setdefault((draw.id, draw.action, draw.flip), set()).add(canvas.itemcget(self.field.paint.items[draw.id], "image"))
                self.assertEqual(canvas.coords(self.field.paint.items[draw.id])[1], round(draw.y) - pet_art.GY * self.field.unit)
        self.assertTrue(seen)
        self.assertEqual({len(images) for images in seen.values()}, {1})

    def test_putting_the_field_away_frees_its_images_and_stops_what_ran(self):
        self.open_game(size=30)
        self.field.tick()
        self.field.poll()
        self.assertTrue(self.field.watcher.running)
        self.field.hide()
        self.assertEqual((self.field.shown, self.field.frame_after, self.field.poll_after), (False, None, None))
        self.assertFalse(self.field.watcher.running)
        self.assertEqual(self.field.window.state(), "withdrawn")
        self.assertEqual((self.field.paint.items, len(self.field.paint.held.entries)), ({}, 0))
        self.field.show()
        self.hold()
        self.run_frames(0.1)
        self.assertEqual(len(self.field.paint.items), 30, "the same horde is drawn again")


class PointerTests(FieldCase):
    def test_a_goblin_is_picked_up_carried_and_dropped_on_a_window_top(self):
        self.field.watcher.rects = [WindowRect("w", DISPLAY.left + 300, DISPLAY.top + 200, DISPLAY.left + 700, DISPLAY.top + 380)]
        self.open_game(size=8)
        canvas, world = self.field.canvas, self.field.world
        goblin, x, y = self.standing()
        canvas.event_generate("<ButtonPress-1>", x=x, y=y)
        self.assertEqual((world.held.id, str(canvas.cget("cursor"))), (goblin, "fleur"))
        for step in range(1, 11):
            canvas.event_generate("<B1-Motion>", x=x + (500 - x) * step // 10, y=y + (150 - y) * step // 10)
            self.run_frames(0.05)
        draw = next(draw for draw in world.frame().draws if draw.id == goblin)
        self.assertEqual(draw.action, "grabbed")
        self.assertAlmostEqual(draw.x, 500, delta=2)
        self.run_frames(0.5)
        canvas.event_generate("<ButtonRelease-1>", x=500, y=150)
        self.assertIsNone(world.held)
        self.assertEqual(str(canvas.cget("cursor")), "")
        self.run_frames(1.0)
        landed = world.goblins[goblin]
        self.assertEqual((landed.platform.kind, landed.y * world.unit), ("window", 200.0))
        self.assertEqual(self.app.menus, [], "picking a goblin up opens nothing")

    def test_a_click_on_the_pill_or_a_right_click_on_a_goblin_opens_the_menu(self):
        self.open_game(size=6)
        canvas = self.field.canvas
        left, top, right, bottom = self.field.paint.hud_box
        canvas.event_generate("<ButtonPress-1>", x=(left + right) // 2, y=(top + bottom) // 2)
        self.assertEqual(self.app.menus, [])
        canvas.event_generate("<ButtonRelease-1>", x=(left + right) // 2, y=(top + bottom) // 2)
        self.assertEqual(len(self.app.menus), 1)
        _goblin, x, y = self.standing()
        canvas.event_generate("<Button-3>", x=x, y=y)
        self.assertEqual(len(self.app.menus), 2)
        canvas.event_generate("<Button-3>", x=450, y=60)
        canvas.event_generate("<ButtonPress-1>", x=450, y=60)
        canvas.event_generate("<ButtonRelease-1>", x=450, y=60)
        self.assertEqual(len(self.app.menus), 2, "nothing is there to click")
        self.assertIsNone(self.field.world.held)

    def test_hovering_names_the_goblin_and_the_pill_explains_itself(self):
        self.open_game(size=6, coins=64)
        canvas = self.field.canvas
        goblin, x, y = self.standing()
        canvas.event_generate("<Motion>", x=x, y=y)
        self.assertEqual(self.app.tooltip.text, f"{name_for(goblin)}\n{title_for(look_for(goblin))}")
        self.assertEqual(str(canvas.cget("cursor")), "hand2")
        left, top, right, bottom = self.field.paint.hud_box
        canvas.event_generate("<Motion>", x=left + 4, y=top + 4)
        self.assertIn("Coins 64", self.app.tooltip.text)
        canvas.event_generate("<Leave>")
        self.assertEqual(self.app.tooltip.text, "")

    def test_the_pill_is_the_only_thing_to_click_with_the_goblins_hidden(self):
        self.open_game(size=6)
        _goblin, x, y = self.standing()
        self.field.toggle_goblins()
        self.run_frames(0.1)
        self.assertEqual(self.field.paint.items, {})
        self.assertIsNone(self.field.target(x, y))
        left, top, _right, _bottom = self.field.paint.hud_box
        self.assertEqual(self.field.target(left + 2, top + 2), HUD)
        self.field.toggle_goblins()
        self.run_frames(0.1)
        self.assertEqual(len(self.field.paint.items), 6)


class IncomeTests(FieldCase):
    """Coins that arrive are hard to miss: a gain on the pill, a "+N" over the horde, and a tip that
    counts them or says why there are none."""

    def test_coins_that_arrive_show_beside_the_count_for_six_seconds_fading_in_two_steps(self):
        self.open_game(coins=24, size=5)
        plain = self.field.paint.hud_box
        self.assertEqual(self.ticker(), "")
        self.pay(Work(12, 1), coins=36, size=5)
        self.assertEqual((self.pill(), self.ticker()), ("◉ 36   5 goblins", "+12"))
        self.assertLess(self.field.paint.hud_box[0], plain[0], "the pill grows to hold it")
        canvas, block = self.field.canvas, self.field.paint.hud_block
        fills = [self.shown(block, "fill")]
        self.assertNotIn(fills[0], ("", canvas.itemcget(self.field.paint.hud_back, "fill")), "a block of its own colour")
        number, under = canvas.bbox(self.field.paint.hud_gain), canvas.bbox(block)
        self.assertTrue(under[0] <= number[0] and number[2] <= under[2], "the number sits on the block")
        self.skip(4.8)
        self.assertEqual((self.ticker(), self.shown(block, "fill")), ("+12", fills[0]), "bright for most of its time")
        for seconds in (0.4, 0.5):
            self.skip(seconds)
            self.assertEqual(self.ticker(), "+12")
            fills.append(self.shown(block, "fill"))
        self.assertEqual(len(set(fills)), 3, "two fading steps")
        self.skip(0.4)
        self.assertEqual((self.pill(), self.ticker()), ("◉ 36   5 goblins", ""), "gone a little after six seconds")
        self.assertEqual(self.field.paint.hud_box, plain)

    def test_coins_that_arrive_while_a_gain_shows_join_it_and_its_time_starts_again(self):
        self.open_game(coins=24, size=5)
        self.pay(Work(12, 1), coins=36, size=5)
        self.skip(3.0)
        self.pay(Work(7, 1), coins=43, size=5)
        self.assertEqual((self.pill(), self.ticker()), ("◉ 43   5 goblins", "+19"))
        self.skip(4.5)
        self.assertEqual(self.ticker(), "+19", "seven and a half seconds after the first coins")
        self.skip(2.0)
        self.assertEqual(self.ticker(), "")
        self.pay(Launch(False, 30), coins=73, size=5)
        self.assertEqual(self.ticker(), "+30", "a gain that had gone is not added to")

    def test_a_battle_keeps_every_gain_off_the_pill_until_it_is_over(self):
        self.open_game(coins=52, size=20, cleared=2)
        self.pay(Work(12, 1), coins=64, size=20, cleared=2)
        self.assertEqual(self.ticker(), "+12")
        self.fight(WIN, coins=118, size=20, cleared=3)
        self.run_frames(1.0, fps=10)
        self.assertEqual((self.pill(), self.ticker()), ("Pebblebrute   ◉ 64   20 goblins", ""))
        self.pay(Work(5, 1), coins=123, size=20, cleared=3)
        self.run_frames(1.0, fps=10)
        self.assertEqual((self.pill(), self.ticker()), ("Pebblebrute   ◉ 64   20 goblins", ""), "work paid in the middle waits too")
        self.assertEqual(self.pill_tip()[:3], ["Coins 64", "Earned this session +12", "Lifetime 74"], "the tip gives nothing away")
        self.fight_out()
        self.assertEqual((self.pill(), self.ticker()), ("◉ 123   20 goblins", "+59"), "the fight's 54 coins and the work's 5")
        self.assertEqual(self.pill_tip()[:3], ["Coins 123", "Earned this session +71", "Lifetime 133"])
        self.skip(6.1)
        self.assertEqual(self.ticker(), "")

    def test_a_fight_that_pays_nothing_shows_no_gain(self):
        self.open_game(coins=64, size=20, cleared=2)
        self.fight(LOSS, coins=64, size=20, cleared=2)
        self.fight_out()
        self.assertEqual((self.pill(), self.ticker()), ("◉ 64   20 goblins", ""))
        self.fight({**LOSS, "reason": "locked"})
        self.skip(0.1)
        self.assertEqual(self.ticker(), "")
        self.assertEqual(self.pill_tip()[1], "Earned this session +0")

    def test_coins_paid_within_700_ms_share_one_pop_over_the_same_goblin(self):
        self.open_game(size=20)
        self.pay(Work(12, 1), Launch(False, 30), size=20)
        self.assertEqual(self.pop_texts(), ["+42"], "one answer's work and welcome back")
        self.assertEqual(self.ticker(), "+42")
        first = self.field.canvas.coords(self.pops()[0])[0]
        self.skip(0.5)
        self.pay(Work(7, 1), size=20)
        self.assertEqual(self.pop_texts(), ["+49"], "half a second after it went up")
        self.assertEqual(self.field.canvas.coords(self.pops()[0])[0], first, "still over that goblin")
        self.skip(1.5)
        self.assertEqual(self.pop_texts(), [], "it lasts two seconds from when it went up, however much joined it")

    def test_coins_paid_later_get_a_pop_of_their_own_once_the_one_before_has_climbed_clear(self):
        self.open_game(size=20)
        self.pay(Work(12, 1), size=20)
        canvas = self.field.canvas
        went_up = canvas.bbox(self.pops()[0])
        self.skip(0.7)
        self.assertLessEqual(canvas.bbox(self.pops()[0])[3], went_up[1], "above where a pop over the same goblin would go up")
        self.pay(Work(7, 1), size=20)
        self.assertEqual(sorted(self.pop_texts()), ["+12", "+7"])

    def test_hovering_the_pill_counts_the_coins_held_earned_and_ever_paid(self):
        self.open_game(coins=4, size=5)
        self.assertEqual(self.pill_tip(), ["Coins 4", "Earned this session +0", "Lifetime 14", "Next goblin costs 41"])
        self.pay(Work(36, 2), coins=40, size=5)
        self.skip(1.0)
        self.pay(Work(23, 1), coins=63, size=5)
        self.assertEqual(self.pill_tip(), ["Coins 63", "Earned this session +59", "Lifetime 73", "Next goblin costs 41"])

    def test_work_the_viewer_cannot_count_marks_the_pill_and_the_tip_says_why(self):
        self.open_game(coins=4, size=5)
        mark = self.field.paint.hud_mark
        self.assertEqual(self.shown(mark), "")
        self.pay(coins=4, size=5, source={"ok": False, "message": NOT_FOUND})
        self.assertEqual((self.shown(mark), self.pill()), ("!", "◉ 4   5 goblins"))
        self.assertLess(self.field.canvas.bbox(mark)[2], self.field.canvas.bbox(self.field.paint.hud_label)[0] + 1, "before the coins")
        self.assertEqual(self.pill_tip(), ["Coins 4", "Earned this session +0", "Lifetime 14", "Next goblin costs 41", NOT_FOUND])
        self.skip(700.0)
        self.assertEqual(self.pill_tip()[-1], NOT_FOUND, "the reason, not the minutes it has lasted")
        self.pay(coins=4, size=5)
        self.assertEqual(self.shown(mark), "", "the mark goes when work is counted again")

    def test_ten_minutes_without_paid_work_are_said_in_the_tip_until_work_pays(self):
        self.open_game(coins=4, size=5, cleared=2)
        facts = ["Coins 4", "Earned this session +0", "Lifetime 14", "Next goblin costs 41"]
        self.skip(590.0)
        self.assertEqual(self.pill_tip(), facts, "not yet ten minutes")
        self.skip(10.0)
        self.assertEqual(self.pill_tip(), [*facts, "No finished AI turns seen for 10 min"])
        self.skip(150.0)
        self.assertEqual(self.pill_tip()[-1], "No finished AI turns seen for 12 min")
        self.assertEqual(self.shown(self.field.paint.hud_mark), "", "nothing is wrong, so no mark")
        self.fight(WIN, coins=58, size=5, cleared=3)
        self.fight_out()
        self.assertRegex(self.pill_tip()[-1], r"^No finished AI turns seen for 1[23] min$", "a boss is not AI work")
        self.pay(Work(2, 1), coins=60, size=5, cleared=3)
        self.assertEqual(self.pill_tip(), ["Coins 60", "Earned this session +56", "Lifetime 70", "Next goblin costs 41"])
        self.skip(600.0)
        self.assertEqual(self.pill_tip()[-1], "No finished AI turns seen for 10 min", "counted from the last paid work")

    def test_with_the_game_open_the_field_writes_only_numbers_and_its_own_words(self):
        fixed = {word.strip(".,") for line in (COIN, TROUBLE_MARK, WON, LOST, WELCOME, WELCOME_BACK, REFUSED, *REASONS.values(),
                                               "goblin goblins coin coins scrap XP Level Gear tier Hoard Training",
                                               *map(pet_boss.boss_name, range(pet_boss.BOSS_COUNT)))
                 for word in line.split()}
        seen: set[str] = set()

        def look() -> None:
            seen.update(self.texts())

        source = {"ok": False, "message": "C:\\Users\\someone\\statev2.sqlite could not be opened."}
        self.open_game(coins=64, size=400, cleared=2)
        self.pay(Work(12, 1), Launch(False, 319), coins=395, size=400, cleared=2, source=source)
        look()
        self.viewer.buy_reply = {"ok": True, "reason": "", "game": read_game(game(coins=374, size=400, cleared=2))}
        self.field.buy("level")
        self.viewer.buy_reply = {"ok": False, "reason": "a reason from a newer viewer", "game": None}
        self.field.buy("hoard")
        self.skip(0.1)
        look()
        self.fight(WIN, coins=428, size=400, cleared=3)
        for _ in range(600):
            if self.field.battle is None:
                break
            self.run_frames(0.1, fps=10)
            look()
        self.skip(0.1)
        look()
        self.assertTrue({"!", "+54", "◉ 428   400 goblins   ×2.7", "Victory +54 coins, +4 scrap", "Pebblebrute", "Level 2",
                         REFUSED} <= seen, sorted(seen))
        for text in seen:
            words = re.sub(r"[+\-×]?\d[\d,.]*", " ", text).split()
            self.assertEqual([word for word in words if word.strip(".,") not in fixed], [], text)


class BattleTests(FieldCase):
    def test_a_battle_holds_the_pill_until_it_is_over_then_says_how_it_went(self):
        self.open_game(coins=64, size=20, cleared=2)
        self.fight(WIN, coins=118, size=20, cleared=3)
        self.assertEqual(self.viewer.fights, [2])
        self.assertTrue(self.field.world.battling)
        self.run_frames(1.0, fps=10)
        self.assertEqual(self.pill(), "Pebblebrute   ◉ 64   20 goblins", "the boss's name, over the numbers from before")
        self.assertIn("Pebblebrute", self.texts())
        fights = [row for row in self.field.menu_rows() if isinstance(row[1], tuple) and row[1][0] == "fight"]
        buys = [row for row in self.field.menu_rows() if isinstance(row[1], tuple) and row[1][0] == "buy"]
        self.assertEqual([enabled for _label, _action, enabled in fights], [False])
        self.assertTrue(any(enabled for _label, _action, enabled in buys), "buying goes on")
        self.field.fight(2)
        self.assertEqual(self.viewer.fights, [2], "one fight at a time")
        self.viewer.answer = ready(coins=118, size=20, cleared=3)
        self.field.poll()
        self.hold()
        self.run_frames(1.0, fps=10)
        self.assertEqual(self.pill(), "Pebblebrute   ◉ 64   20 goblins", "a poll in the middle gives nothing away")
        for _ in range(600):
            if self.field.battle is None:
                break
            self.run_frames(0.1, fps=10)
        self.assertIsNone(self.field.battle)
        self.run_frames(0.1, fps=10)
        self.assertEqual(self.pill(), "◉ 118   20 goblins")
        self.assertIn(result_line(True, WIN["rewards"]), self.texts())
        self.assertIn("Victory +54 coins, +4 scrap", self.texts())

    def test_a_lost_fight_says_so_plainly(self):
        self.open_game(size=20, cleared=2)
        self.fight(LOSS, size=20, cleared=2)
        for _ in range(600):
            if self.field.battle is None:
                break
            self.run_frames(0.1, fps=10)
        self.run_frames(0.1, fps=10)
        self.assertIn("Not this time", self.texts())

    def test_a_fight_the_viewer_turns_down_is_one_sentence_and_no_battle(self):
        self.open_game(size=20, cleared=2)
        for reason in ("locked", "unknown", "failed"):
            with self.subTest(reason=reason):
                self.fight({"won": False, "ratio": 0.0, "rewards": {"coins": 0, "scrap": 0, "xp": 0}, "reason": reason})
                self.assertFalse(self.field.world.battling)
                self.assertIsNone(self.field.battle)
                self.run_frames(0.1)
                self.assertIn(reason_line(reason), self.texts())
        self.assertNotIn("Pebblebrute", self.pill())

    def test_a_purchase_shows_what_it_made_of_the_horde_and_a_recruit_joins_it(self):
        self.open_game(coins=64, size=5)
        self.viewer.buy_reply = {"ok": True, "reason": "", "game": read_game(game(coins=23, size=6))}
        self.field.buy("recruit")
        self.run_frames(1.0)
        self.assertEqual((self.viewer.buys, len(self.field.paint.items), self.pill()), (["recruit"], 6, "◉ 23   6 goblins"))
        self.viewer.buy_reply = {"ok": True, "reason": "", "game": read_game(game(coins=2, size=6))}
        self.field.buy("level")
        self.run_frames(0.1)
        self.assertIn("Level 2", self.texts())
        self.viewer.buy_reply = {"ok": False, "reason": "coins", "game": read_game(game(coins=2, size=6))}
        self.field.buy("hoard")
        self.run_frames(0.1)
        self.assertIn(reason_line("coins"), self.texts())

    def test_the_items_on_show_stay_within_budget_through_a_battle(self):
        self.open_game(size=150, cleared=2)
        self.fight(WIN, size=150, cleared=3)
        most = 0
        for _ in range(400):
            if self.field.battle is None:
                break
            self.run_frames(0.1, fps=10)
            most = max(most, len(self.on_show()))
        self.assertIsNone(self.field.battle, "the battle ended")
        self.assertGreater(most, 150)
        self.assertLessEqual(most, 150 + EXTRAS)


class SurroundingsTests(FieldCase):
    def test_window_tops_reach_the_world_in_its_own_pixels_and_only_when_they_change(self):
        self.open_game(size=4)
        world = self.field.world
        with patch.object(world, "set_platforms", wraps=world.set_platforms) as laid:
            self.run_frames(0.2)
            self.assertEqual(laid.call_count, 0, "no window opened or moved")
            self.field.watcher.rects = [WindowRect("w", DISPLAY.left + 100, DISPLAY.top + 150, DISPLAY.left + 500, DISPLAY.top + 300),
                                        WindowRect("maximized", DISPLAY.left, DISPLAY.top, DISPLAY.left + 900, DISPLAY.top + 500)]
            self.run_frames(0.2)
            self.assertEqual(laid.call_count, 1)
            self.run_frames(0.2)
            self.assertEqual(laid.call_count, 1)
            self.field.watcher.rects = [WindowRect("w", DISPLAY.left + 130, DISPLAY.top + 150, DISPLAY.left + 530, DISPLAY.top + 300)]
            self.run_frames(0.1)
            self.assertEqual(laid.call_count, 2)
        self.assertEqual([(top.x0 * world.unit, top.x1 * world.unit, top.y * world.unit) for top in world.windows], [(130, 530, 150)])

    def test_a_window_below_the_taskbars_top_edge_is_no_platform(self):
        self.field.watcher.rects = [WindowRect("low", DISPLAY.left + 100, DISPLAY.top + DISPLAY.ground + 5, DISPLAY.left + 500,
                                               DISPLAY.top + 499)]
        self.run_frames(0.1)
        self.assertEqual(self.field.world.windows, ())

    def test_a_full_screen_app_puts_the_field_away_until_it_leaves(self):
        self.open_game(size=10)
        self.fullscreen = True
        self.run_frames(pet_field.WATCH_EVERY + 0.1)
        self.assertEqual((self.field.window.state(), self.field.pace(), self.field.shown), ("withdrawn", "covered", True))
        clock = self.field.world.clock
        self.run_frames(1.0)
        self.assertEqual(self.field.world.clock, clock, "nothing is stepped or drawn behind the app")
        self.fullscreen = False
        self.run_frames(pet_field.WATCH_EVERY + 0.1)
        self.assertEqual((self.field.window.state(), self.field.pace()), ("normal", "lively"))
        self.assertGreater(self.field.world.clock, clock)

    def test_the_pace_follows_reduced_motion_and_an_empty_chair(self):
        self.assertEqual((FRAME_MS["lively"], FRAME_MS["still"]), (33, 100))
        self.assertEqual(round(1000 / FRAME_MS["away"]), 12)
        self.run_frames(pet_field.WATCH_EVERY + 0.1)
        self.assertEqual(self.field.pace(), "lively")
        self.idle = AWAY_AFTER + 1
        self.run_frames(pet_field.WATCH_EVERY + 0.1)
        self.assertEqual(self.field.pace(), "away")
        self.app.reduced_motion = True
        self.assertEqual(self.field.pace(), "still")
        self.app.reduced_motion = False
        self.idle = 2.0
        self.run_frames(pet_field.WATCH_EVERY + 0.1)
        self.assertEqual(self.field.pace(), "lively", "back at the keyboard")

    def test_the_next_frame_is_asked_for_at_the_pace(self):
        def delay() -> int:
            """Milliseconds to the next frame, after one that started on time."""
            self.field.due = time.perf_counter()
            with patch.object(self.root, "after", wraps=self.root.after) as after:
                self.field.tick()
                self.hold()
            return after.call_args.args[0]
        self.assertLessEqual(delay(), FRAME_MS["lively"])
        self.app.reduced_motion = True
        self.assertTrue(FRAME_MS["lively"] < delay() <= FRAME_MS["still"])


@unittest.skipUnless(sys.platform == "win32", "Draws on a real Windows Tk canvas")
class CanvasTests(unittest.TestCase):
    """The drawing alone, fed frames made by hand."""

    def setUp(self):
        self.root = tk.Tk()
        self.root.geometry("900x500+-4000+-3000")
        self.addCleanup(self.root.destroy)
        self.canvas = tk.Canvas(self.root, bg=desktop_platform.WINDOWS_KEY, bd=0, highlightthickness=0)
        self.canvas.pack(fill="both", expand=True)
        self.root.update()
        self.paint = FieldCanvas(self.canvas, Theme(self.root, 1.0), 2)
        self.addCleanup(self.paint.destroy)
        self.paint.resize(900, 500, 440)

    def boss(self, pose="stand", x=450.0, hp=1.0, flip=False, index=0) -> BossDraw:
        return BossDraw(index, pose, 0, x, 446.0, flip, False, hp, pet_boss.boss_height(index) * 2.0)

    def shown_texts(self) -> list[str]:
        return [self.canvas.itemcget(item, "text") for item in self.canvas.find_all()
                if self.canvas.type(item) == "text" and self.canvas.itemcget(item, "state") != "hidden"
                and self.canvas.itemcget(item, "text")]

    def test_a_goblin_changes_picture_with_its_frame_and_facing_and_holds_one_pose_when_still(self):
        def image(frame: int, still: bool = False, flip: bool = False) -> str:
            self.paint.crowd(Frame((Draw(0, "run", frame, 300.0, 440.0, flip, 1.0, 1.0),), None, (), "roam", 0.0), still)
            return self.canvas.itemcget(self.paint.items[0], "image")
        self.assertNotEqual(image(0), image(2))
        self.assertEqual(image(4), image(0), "frames wrap round the action")
        self.assertNotEqual(image(0, flip=True), image(0), "facing the other way is another picture")
        self.assertEqual(len({image(frame, still=True) for frame in range(4)}), 1)

    def test_goblins_that_look_alike_share_their_pictures(self):
        alike: dict[str, list[int]] = {}
        for goblin in range(400):
            alike.setdefault(look_for(goblin).name, []).append(goblin)
        twins = next(goblins for goblins in alike.values() if len(goblins) > 1)[:2]
        draws = tuple(Draw(goblin, "idle", 0, 100.0 + 60 * n, 440.0, False, 1.0, 1.0) for n, goblin in enumerate(twins))
        self.paint.crowd(Frame(draws, None, (), "roam", 0.0))
        self.assertEqual(len({self.canvas.itemcget(self.paint.items[goblin], "image") for goblin in twins}), 1)

    def test_a_goblin_fading_in_or_out_is_drawn_only_once_it_is_mostly_there(self):
        def drawn(alpha: float) -> bool:
            self.paint.crowd(Frame((Draw(0, "idle", 0, 300.0, 440.0, False, alpha, 1.0),), None, (), "roam", 0.0))
            return 0 in self.paint.items
        self.assertEqual([drawn(alpha) for alpha in (0.1, 0.6, 1.0, 0.3)], [False, True, True, False])

    def test_the_boss_carries_its_name_and_health_until_it_has_none(self):
        self.paint.crowd(Frame((), self.boss(hp=0.6), (), "swarm", 0.0))
        self.assertEqual(self.shown_texts().count("Mudback"), 1)
        full = self.canvas.coords(self.paint.bar_back)
        fill = self.canvas.coords(self.paint.bar_fill)
        self.assertAlmostEqual((fill[2] - fill[0]) / (full[2] - full[0] - 4), 0.6, delta=0.02)
        self.assertLess(full[3], 446 - pet_boss.boss_height(0) * 2, "above its head")
        self.assertEqual(self.canvas.itemcget(self.paint.boss_item, "state"), "normal")
        self.paint.crowd(Frame((), self.boss(pose="hurt", hp=0.0), (), "finish", 0.0))
        self.assertNotIn("Mudback", self.shown_texts())
        self.paint.crowd(Frame((), None, (), "disperse", 0.0))
        self.assertEqual(self.canvas.itemcget(self.paint.boss_item, "state"), "hidden")

    def test_the_boss_stands_with_its_feet_where_the_world_put_them(self):
        self.paint.crowd(Frame((), self.boss(x=450.0), (), "swarm", 0.0))
        ax, ay = pet_boss.boss_anchor(0, "stand")
        self.assertEqual(tuple(self.canvas.coords(self.paint.boss_item)), (450 - 2 * ax, 446 - 2 * ay))

    def test_a_fallen_boss_stays_inside_the_field_and_a_walking_one_may_come_from_outside(self):
        for flip, x in ((False, 60.0), (True, 840.0)):
            with self.subTest(flip=flip):
                self.paint.crowd(Frame((), None, (), "roam", 0.0))
                self.paint.crowd(Frame((), self.boss(pose="fall", x=x, hp=0.0, flip=flip), (), "finish", 0.0))
                left, _top, right, _bottom = self.canvas.bbox(self.paint.boss_item)
                self.assertGreaterEqual(left, 0)
                self.assertLessEqual(right, 900)
        self.paint.crowd(Frame((), None, (), "roam", 0.0))
        self.paint.crowd(Frame((), self.boss(pose="walk", x=-40.0), (), "enter", 0.0))
        self.assertLess(self.canvas.bbox(self.paint.boss_item)[0], 0)

    def sprites(self) -> list[int]:
        return [item for item in self.paint.effects if self.canvas.itemcget(item, "state") != "hidden"]

    def test_the_bosss_own_name_banner_is_left_to_its_plate_and_other_words_pop(self):
        pops = (Pop("banner", 450.0, 100.0, "Mudback", 0.1, 1.8), Pop("hit", 440.0, 200.0, "-7", 0.1, 0.5),
                Pop("coin", 300.0, 400.0, "+12", 0.1, 1.2), Pop("coin", 310.0, 420.0, "", 0.1, 1.5),
                Pop("dust", 500.0, 438.0, "", 0.1, 0.5), Pop("star", 510.0, 430.0, "", 0.05, 0.15),
                Pop("alert", 520.0, 400.0, "", 0.1, 0.6))
        self.paint.crowd(Frame((), self.boss(), pops, "swarm", 0.0))
        texts = self.shown_texts()
        self.assertEqual((texts.count("Mudback"), texts.count("-7")), (1, 2))
        self.assertNotIn("+12", texts, "the world's own count of the coins is left to the field's gain")
        self.assertEqual(len(self.sprites()), 4)
        self.assertEqual(tuple(self.canvas.coords(self.sprites()[0])), (310.0, 420.0))

    def test_a_gain_is_gold_half_as_tall_again_as_other_words_and_led_by_a_coin(self):
        pops = (Pop("gain", 300.0, 380.0, "+1,200", 0.1, 2.0), Pop("hit", 600.0, 200.0, "-7", 0.1, 0.5))
        self.paint.crowd(Frame((), None, pops, "roam", 0.0))
        canvas = self.canvas
        (gain_shadow, gain), (_hit_shadow, hit) = self.paint.words[:2]
        self.assertEqual((canvas.itemcget(gain, "text"), canvas.itemcget(hit, "text")), ("+1,200", "-7"))
        self.assertNotEqual(canvas.itemcget(gain, "fill"), canvas.itemcget(hit, "fill"))
        tall = [tkfont.nametofont(canvas.itemcget(item, "font"), root=self.root).metrics("linespace") for item in (gain, hit)]
        self.assertGreaterEqual(tall[0], 1.4 * tall[1])
        self.assertEqual([a - b for a, b in zip(canvas.coords(gain_shadow), canvas.coords(gain))], [1.0, 1.0],
                         "a one pixel shadow")
        coin, = self.sprites()
        coin_box, text_box = canvas.bbox(coin), canvas.bbox(gain)
        self.assertLess(coin_box[2], text_box[0] + 1, "the coin comes first")
        self.assertEqual(canvas.coords(coin)[1], canvas.coords(gain)[1], "level with the number")
        self.assertAlmostEqual((coin_box[0] + text_box[2]) / 2, 300, delta=3, msg="the pair is centred on the pop")
        self.paint.crowd(Frame((), None, pops[1:], "roam", 0.0))
        self.assertEqual(self.sprites(), [], "the coin goes with its gain")
        first = self.paint.words[0][1]
        self.assertEqual(tkfont.nametofont(canvas.itemcget(first, "font"), root=self.root).metrics("linespace"), tall[1],
                         "a pool item that showed a gain shows other words at their own size")

    def test_more_pops_than_the_pools_hold_are_left_out_not_piled_up(self):
        gain = (Pop("gain", 60.0, 300.0, "+12", 0.1, 2.0),)
        words = tuple(Pop("hit", 100.0 + 20 * n, 200.0, f"-{n}", 0.1, 0.5) for n in range(TEXT_POPS + 5))
        coins = tuple(Pop("coin", 100.0 + 9 * n, 400.0, "", 0.1, 1.5) for n in range(EFFECT_POPS + 30))
        before = len(self.canvas.find_all())
        self.paint.crowd(Frame((), None, gain + words + coins, "finish", 0.0))
        self.assertEqual(len(self.canvas.find_all()), before)
        self.assertEqual(len(self.shown_texts()), 2 * TEXT_POPS)
        self.assertEqual(len(self.sprites()), EFFECT_POPS)
        self.assertEqual(self.shown_texts().count("+12"), 2, "a gain the field lists first keeps its place")
        self.paint.crowd(Frame((), None, (), "roam", 0.0))
        self.assertEqual(self.shown_texts(), [])

    def test_the_pill_sits_over_the_bottom_right_of_the_ground_and_a_long_line_is_cut_to_fit(self):
        self.paint.hud("◉ 1,284   37 goblins")
        left, top, right, bottom = self.paint.hud_box
        self.assertTrue(0 < left < right <= 900 - 16 and 0 < top < bottom < 440)
        self.assertTrue(self.paint.in_hud((left + right) / 2, (top + bottom) / 2))
        self.assertFalse(self.paint.in_hud(left - 3, top))
        self.paint.hud("The viewer would not open the game for this window. " * 6)
        self.assertGreaterEqual(self.paint.hud_box[0], 0)
        self.assertTrue(self.canvas.itemcget(self.paint.hud_label, "text").endswith("…"))

    def test_the_pills_mark_line_and_gain_sit_in_a_row_inside_it(self):
        parts = (self.paint.hud_mark, self.paint.hud_label, self.paint.hud_gain)
        self.paint.hud("◉ 36   5 goblins", "!", "+12")
        left, top, right, bottom = self.paint.hud_box
        self.assertEqual([self.canvas.itemcget(item, "text") for item in parts], ["!", "◉ 36   5 goblins", "+12"])
        mark, line, gain = (self.canvas.bbox(item) for item in parts)
        self.assertTrue(left < mark[0] and mark[2] <= line[0] and line[2] <= gain[0] and gain[2] < right, (mark, line, gain))
        self.assertTrue(all(top < box[1] and box[3] < bottom for box in (mark, line, gain)))
        self.paint.hud("◉ 36   5 goblins")
        self.assertEqual([self.canvas.itemcget(item, "state") for item in (self.paint.hud_mark, self.paint.hud_block,
                                                                           self.paint.hud_gain)], ["hidden"] * 3)
        self.assertGreater(self.paint.hud_box[0], left, "the pill shrinks back to its line")

    def test_the_fields_own_lines_stack_on_plates_and_go(self):
        self.paint.banners(("Victory +54 coins", "Level 4"))
        self.assertEqual(self.shown_texts()[:2], ["Victory +54 coins", "Level 4"])
        first, second = (self.canvas.coords(label) for _plate, label in self.paint.banner_items[:2])
        self.assertEqual(first[0], 450.0)
        self.assertGreater(first[1], second[1], "the newest is lowest")
        self.assertLess(first[1], 440 - 100, "clear of the horde's heads")
        self.paint.banners(())
        self.assertNotIn("Level 4", self.shown_texts())


if __name__ == "__main__":
    unittest.main()
