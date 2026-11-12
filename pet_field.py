"""The pet field: the horde loose along the taskbar, in a see-through window over the primary display.

A borderless, always-on-top window whose empty pixels let the pointer through, so the desktop under
the goblins stays usable. The field owns the game's flow: it steps the world, feeds it the tops of
the open windows, polls the viewer, stirs the horde when AI work pays and shows the coins on the
pill and over a goblin, sends it to a boss, and holds the result back until the battle is over. The
simulation is pet_world's, the drawing pet_field_canvas's, the words pets_text's, and the viewer is
reached through pets_feed on the app's worker threads.
"""

from __future__ import annotations

import math
import time
import tkinter as tk
from dataclasses import dataclass
from typing import NamedTuple

import desktop_platform
import desktop_windows
from desktop_platform import bind_context, float_window, make_transparent, screen_geometry
from goblin_look import unlocked_tiers
from horde_theme import Theme
from pet_field_canvas import FieldCanvas
from pet_platform import window_platforms
from pet_world import Frame, Pop, World
from pets_feed import WAITING, Game, Launch, PetsFeed, Work
from pets_text import (TROUBLE_MARK, boss_title, bought_line, gain_text, goblin_tip, hud_line, hud_tip, launch_line,
                       pets_menu, reason_line, result_line)

# Milliseconds between frames, by what the field is doing: 30 frames a second, 10 under reduced
# motion, 12 while nobody is at the machine, and one look a second while a full-screen app hides it.
FRAME_MS = {"lively": 33, "still": 100, "away": 83, "covered": 1000}
AWAY_AFTER = 300.0  # Seconds without a key press or a pointer move before the field slows down.
WATCH_EVERY = 1.0  # Seconds between looks at the display, the window in front and the last input.
STIR = (0.25, 40)  # A paying turn stirs the horde this much, and by one more for every this many coins.
NOTICE_LIFE = 4.5  # Seconds one of the field's own banners stays up.
TICKER_LIFE = 6.0  # Seconds the pill shows a gain, counted from the last coins that joined it.
TICKER_DIMS = (5.0, 5.5)  # Seconds after which the gain on the pill has faded a step, and a second one.
QUIET_AFTER = 600.0  # Seconds without paid AI work before the pill's tip says so.
POP_LIFE = 2.0  # Seconds a "+N" stays up over the goblin that was paid.
POP_MERGE = 0.7  # Coins paid within this many seconds of a "+N" going up join it.
POP_RISE = 30  # Sprite pixels a "+N" climbs in its life, fast at first: clear of its own height before POP_MERGE is up.
SHAKE_RATE = 61.0  # Radians a second a stomp's rumble swings at.
TIP_MS = 250
HUD = "hud"  # What target() answers for the pill.
NO_CROWD = Frame((), None, (), "roam", 0.0)


class Display(NamedTuple):
    """The part of the primary display the field covers, in screen pixels, and how far down it the
    ground is."""
    left: int
    top: int
    width: int
    height: int
    ground: int


def supported() -> bool:
    """Whether this system can show the field: only Windows lets the pointer through a keyed colour."""
    return desktop_platform.system() == "win32"


def primary_display(window) -> Display:
    """The primary display, taskbar included, with the taskbar's top edge as the ground. The work
    area cannot say where the ground is: on some desktops it runs under the taskbar. The field stops
    a row short of the bottom, because Windows takes a window that covers a whole display for a
    full-screen app, hides the taskbar behind whatever is maximized, and holds notifications back."""
    width, height = window.winfo_screenwidth(), window.winfo_screenheight() - 1
    work_bottom = desktop_platform.primary_work_area(window)[3]
    return Display(0, 0, width, height, min(max(desktop_windows.taskbar_top(work_bottom), 1), height))


def unit_for(scale: float) -> int:
    """Screen pixels a sprite pixel: 2 at 100% and 125%, 3 at 150%, 4 at 200%."""
    return max(2, round(2 * scale))


@dataclass
class Fight:
    """One trip to a boss: asked of the viewer, then played out by the world. ``held`` is the game from
    before it, which the pill and the looks keep showing so the result is not given away early;
    ``reply`` is the viewer's answer, None until it comes."""
    boss: int
    held: Game
    reply: dict | None = None


class Gain(NamedTuple):
    """A "+N" over the goblin that was paid: where it went up, in canvas pixels, and when."""
    coins: int
    x: float
    y: float
    born: float


@dataclass
class Income:
    """The coins the field has seen paid since it started. ``earned`` is all of them. ``gain`` is what
    the pill shows beside the coin count, and ``gain_at`` when coins last joined it. ``held`` is what a
    battle paid and what work paid during it, kept off the pill until the battle is over. ``turn_at`` is
    when finished AI work last paid, or when the game opened while none has."""
    earned: int = 0
    held: int = 0
    gain: int = 0
    gain_at: float = -math.inf
    turn_at: float | None = None

    def pay(self, coins: int, now: float, hold: bool = False) -> None:
        """Count coins that arrived. They join the gain on show and its time starts again, unless a
        battle holds them back."""
        if hold:
            self.held += coins
        elif coins:
            self.earned += coins
            self.gain = coins + (self.gain if now - self.gain_at < TICKER_LIFE else 0)
            self.gain_at = now

    def release(self, now: float) -> None:
        """The battle is over, so what it held back is paid now."""
        coins, self.held = self.held, 0
        self.pay(coins, now)

    def ticker(self, now: float) -> tuple[int, int]:
        """The gain for the pill and how many steps it has faded, or (0, 0) when there is none."""
        age = now - self.gain_at
        if age >= TICKER_LIFE:
            return 0, 0
        return self.gain, sum(age >= step for step in TICKER_DIMS)

    def opened(self, now: float) -> None:
        """The game is open: the wait for finished AI work starts here, the first time."""
        if self.turn_at is None:
            self.turn_at = now

    def quiet_minutes(self, now: float) -> int:
        """Whole minutes since finished AI work last paid, or 0 until that is QUIET_AFTER seconds."""
        quiet = 0.0 if self.turn_at is None else now - self.turn_at
        return int(quiet // 60) if quiet >= QUIET_AFTER else 0


class PetField:
    """The pets surface. ``app`` provides root, executor, when_done, api, tooltip, reduced_motion and
    show_pets_menu."""

    def __init__(self, app, theme: Theme) -> None:
        self.app = app
        self.theme = theme
        self.window = tk.Toplevel(app.root)
        self.window.withdraw()
        self.window.title("Goblin Horde")
        float_window(self.window)
        self.canvas = tk.Canvas(self.window, bg=make_transparent(self.window), bd=0, highlightthickness=0)
        self.canvas.pack(fill="both", expand=True)
        self.unit = unit_for(theme.scale)
        self.world = World(1, 1, 1, unit=self.unit)
        self.paint = FieldCanvas(self.canvas, theme, self.unit)
        self.feed = PetsFeed(app.api)
        self.watcher = desktop_windows.WindowWatcher()
        self.shown = False
        self.covered = False  # A full-screen app is in front, so the window is put away until it is not.
        self.away = False
        self.display: Display | None = None
        self.rects: list | None = None
        self.game: Game | None = None
        self.status = WAITING["opening"]  # Why there are no numbers to show; "" while the game is open.
        self.trouble = ""  # Why finished work is not being counted, when it is not.
        self.battle: Fight | None = None
        self.income = Income()
        self.gains: list[Gain] = []  # The "+N"s that are up, oldest first.
        self.goblins_hidden = False
        self.notices: list[tuple[str, float]] = []
        self.hover: int | None = None
        self.pressed = None  # What the left button went down on.
        self.epoch = 0  # Counts purchases and fights, so a poll from before one cannot bring its old numbers back.
        self.polling = False
        self.frame_after = self.poll_after = None
        self.last = self.due = self.watch_due = 0.0
        self.world_events = {"battle_over": self.end_fight}
        self.feed_events = {Work: self.on_work, Launch: self.on_launch}
        self.canvas.bind("<ButtonPress-1>", self.on_press)
        self.canvas.bind("<B1-Motion>", self.on_drag)
        self.canvas.bind("<ButtonRelease-1>", self.on_release)
        self.canvas.bind("<Motion>", self.on_motion)
        self.canvas.bind("<Leave>", self.on_leave)
        bind_context(self.canvas, self.on_context)
        # Alt+F4 on the field leaves it where it is; Quit lives in the menu.
        self.window.protocol("WM_DELETE_WINDOW", lambda: None)

    # Showing ------------------------------------------------------------------------------------
    def show(self) -> None:
        if self.shown:
            return
        self.shown = True
        self.covered = False
        self.fit(force=True)
        self.window.deiconify()
        self.window.lift()
        self.watcher.start()
        self.last = self.due = time.perf_counter()
        self.watch_due = self.last + WATCH_EVERY
        self.tick()
        self.poll()

    def hide(self) -> None:
        self.shown = False
        self.rest()
        self.paint.release()
        self.window.withdraw()

    def destroy(self) -> None:
        self.shown = False
        self.rest()
        self.paint.destroy()
        self.window.destroy()

    def rest(self) -> None:
        """Stop everything that runs while the field is on show."""
        for name in ("frame_after", "poll_after"):
            timer = getattr(self, name)
            if timer is not None:
                self.app.root.after_cancel(timer)
                setattr(self, name, None)
        self.watcher.stop()
        self.let_go()
        self.app.tooltip.hide()

    def fit(self, force: bool = False) -> None:
        """Cover the primary display, taskbar and all: the horde's feet rest a few pixels below the
        taskbar's top edge. Asked again every second, since a display can change."""
        display = primary_display(self.window)
        if display == self.display and not force:
            return
        self.display = display
        self.window.geometry(f"{display.width}x{display.height}{screen_geometry(display.left, display.top)}")
        self.world.resize(display.width, display.height, display.ground)
        self.paint.resize(display.width, display.height, display.ground)
        self.rects = None

    def lay_platforms(self) -> None:
        """Hand the world the window tops, whenever a window moved, opened, closed or was restacked."""
        rects = self.watcher.latest()
        if rects == self.rects:
            return
        self.rects = rects
        left, top, width, _height, ground = self.display
        self.world.set_platforms([
            platform._replace(x0=platform.x0 - left, x1=platform.x1 - left, y=platform.y - top,
                              origin=(platform.origin[0] - left, platform.origin[1] - top))
            for platform in window_platforms(rects, (left, top, left + width, top + ground))])

    def watch(self) -> None:
        """The slow look around: the display's size, whether anyone is at the machine, and whether a
        full-screen app is in front, which puts the window away until it is not."""
        self.fit()
        self.away = desktop_windows.seconds_since_input() >= AWAY_AFTER
        covered = desktop_windows.foreground_is_fullscreen()
        if covered == self.covered:
            return
        self.covered = covered
        if covered:
            self.let_go()
            self.app.tooltip.hide()
            self.window.withdraw()
        else:
            self.window.deiconify()
            self.window.lift()

    def toggle_goblins(self) -> None:
        """Hide the horde and leave only the pill, or bring the horde back."""
        self.goblins_hidden = not self.goblins_hidden
        self.let_go()
        self.app.tooltip.hide()

    # The beat -----------------------------------------------------------------------------------
    def pace(self) -> str:
        if self.covered:
            return "covered"
        if self.app.reduced_motion:
            return "still"
        return "away" if self.away else "lively"

    def tick(self) -> None:
        self.frame_after = None
        if not self.shown:
            return
        # The beat is rescheduled even when a frame fails, so one bad frame never freezes the goblins.
        try:
            self.frame(time.perf_counter())
        finally:
            if self.shown and not getattr(self.app, "closing", False):
                # Frames keep to a clock, so one that Tk started late is followed sooner. A frame that
                # took longer than a beat starts the clock again, so lost time is never made up in a burst.
                now = time.perf_counter()
                self.due = max(self.due + FRAME_MS[self.pace()] / 1000, now)
                self.frame_after = self.app.root.after(max(1, round((self.due - now) * 1000)), self.tick)

    def frame(self, now: float) -> None:
        """One beat: step the world by the time that really passed, then draw it."""
        elapsed, self.last = now - self.last, now
        gains = self.gain_pops(now)
        if now >= self.watch_due:
            self.watch_due = now + WATCH_EVERY
            self.watch()
        if self.covered:
            return
        self.lay_platforms()
        for name, detail in self.world.step(elapsed):
            if name in self.world_events:
                self.world_events[name](detail)
        still = bool(self.app.reduced_motion)
        frame = NO_CROWD if self.goblins_hidden else self.world.frame()
        if gains and not self.goblins_hidden:
            frame = frame._replace(pops=gains + frame.pops)  # First, so a full pool never leaves one out.
        shake = (0, 0) if still else (0, round(frame.quake * math.sin(now * SHAKE_RATE)))
        self.paint.crowd(frame, still, shake)
        self.paint.banners(self.notice_lines(now))
        self.paint.hud(*self.hud())
        self.watch_hover()
        self.canvas.update_idletasks()

    def hud(self) -> tuple:
        """The pill's parts: its line, a mark while finished work is not being counted, and the gain
        on show with how far it has faded. The line is the game's numbers, or why there are none.
        While a battle runs they are the numbers from before it, with no gain."""
        game = self.battle.held if self.battle else self.game
        if game is None or self.status:
            return (self.status,)
        boss = boss_title(self.battle.boss) if self.battle and self.battle.reply else ""
        gain, dim = (0, 0) if self.battle else self.income.ticker(self.last)
        return (hud_line(game, self.world.shown, boss), TROUBLE_MARK if self.trouble else "",
                gain_text(gain) if gain else "", dim)

    def gain_pops(self, now: float) -> tuple:
        """The "+N"s still up, each as high as its age has taken it."""
        self.gains = [gain for gain in self.gains if now - gain.born < POP_LIFE]
        climb = POP_RISE * self.unit
        return tuple(Pop("gain", gain.x, gain.y - climb * (1 - (1 - (now - gain.born) / POP_LIFE) ** 2),
                         gain_text(gain.coins), now - gain.born, POP_LIFE) for gain in self.gains)

    def say(self, text: str) -> None:
        """Put a banner up over the horde."""
        if text:
            self.notices.append((text, self.last))

    def notice_lines(self, now: float) -> tuple:
        """The banners still up, newest first."""
        self.notices = [notice for notice in self.notices if now - notice[1] < NOTICE_LIFE]
        return tuple(text for text, _born in reversed(self.notices))

    # The viewer ---------------------------------------------------------------------------------
    def poll(self) -> None:
        self.poll_after = None
        if not self.shown or self.polling or getattr(self.app, "closing", False):
            return
        self.polling = True
        epoch = self.epoch
        self.app.when_done(self.app.executor.submit(self.feed.poll), lambda feed, _error: self.take_feed(feed, epoch))

    def take_feed(self, feed, epoch: int) -> None:
        self.polling = False
        if feed is not None:
            self.status = feed.message
            if feed.ready:
                self.income.opened(self.last)
                self.trouble = "" if feed.source["ok"] else feed.source["message"]
                if epoch == self.epoch:
                    self.take_game(feed.game)
                for event in feed.events:
                    self.feed_events[type(event)](event)
        if self.shown:
            self.poll_after = self.app.root.after(self.feed.delay_ms, self.poll)

    def take_game(self, game: Game | None) -> None:
        """The viewer's latest numbers. The horde follows at once; the pill and the looks follow too,
        unless a battle is holding them back."""
        if game is None:
            return
        self.game = game
        self.world.set_horde(game.size)
        self.sync_looks()

    def sync_looks(self) -> None:
        game = self.battle.held if self.battle else self.game
        if game is not None:
            self.paint.set_unlocked(unlocked_tiers({"bosses": {"cleared": game.cleared}}))

    def on_work(self, work: Work) -> None:
        self.income.turn_at = self.last
        self.world.stir(min(1.0, STIR[0] + work.coins / STIR[1]))
        if work.coins:
            self.reward(work.coins)

    def on_launch(self, launch: Launch) -> None:
        if launch.coins:
            self.world.stir(1.0)
            self.reward(launch.coins)
        self.say(launch_line(launch.welcome, launch.coins))

    def reward(self, coins: int) -> None:
        """Coins arrived: goblins cheer under a "+N", and the pill counts them. Coins that come within
        POP_MERGE seconds of a "+N" going up join it, over the same goblin."""
        now = self.last
        newest = self.gains[-1] if self.gains else None
        if newest is not None and now - newest.born < POP_MERGE:
            self.world.reward(coins, newest.x)
            self.gains[-1] = newest._replace(coins=newest.coins + coins)
        else:
            self.world.reward(coins)
            # The world puts a "+N" of its own over the goblin it paid, and the field draws this one in its place.
            marks = [pop for pop in self.world.frame().pops if pop.kind == "coin" and pop.text]
            if marks:
                self.gains.append(Gain(coins, marks[-1].x, marks[-1].y, now))
        self.income.pay(coins, now, hold=self.battle is not None)

    # Buying and fighting --------------------------------------------------------------------------
    def menu_rows(self) -> list:
        """The menu's rows for the game as it stands."""
        open_ = self.game is not None and not self.status
        return pets_menu(self.game if open_ else None, battling=self.battle is not None, hidden=self.goblins_hidden,
                         status=self.status)

    def ask(self, call, value, done) -> None:
        """Run a purchase or a fight on a worker thread and hand its answer to ``done``."""
        self.epoch += 1

        def landed(reply, _error) -> None:
            self.epoch += 1
            if reply is not None:
                done(reply)
        self.app.when_done(self.app.executor.submit(call, value), landed)

    def buy(self, kind: str) -> None:
        self.ask(self.feed.buy, kind, lambda reply: self.take_purchase(kind, reply))

    def take_purchase(self, kind: str, reply: dict) -> None:
        self.take_game(reply["game"])
        if not reply["ok"]:
            self.say(reason_line(reply["reason"]))
        elif self.game is not None:
            self.world.stir(STIR[0])
            self.say(bought_line(self.game, kind))  # Nothing for a recruit, who drops in instead.

    def fight(self, boss: int) -> None:
        """Send the horde to a boss. One fight at a time, and the pill keeps the numbers from before it
        until it is over."""
        if self.battle or self.game is None:
            return
        self.battle = Fight(boss, self.game)
        self.ask(self.feed.fight, boss, self.take_fight)

    def take_fight(self, reply: dict) -> None:
        battle = self.battle
        if battle is None:
            return
        self.take_game(reply["game"])
        self.income.pay(reply["rewards"]["coins"], self.last, hold=True)
        # The boss comes on from either side, as the world picks.
        if reply["reason"] or not self.world.start_battle(None, battle.boss, reply["won"], reply["ratio"]):
            self.battle = None
            self.income.release(self.last)
            self.sync_looks()
            self.say(reason_line(reply["reason"]))
            return
        battle.reply = reply

    def end_fight(self, _result: dict) -> None:
        battle, self.battle = self.battle, None
        self.income.release(self.last)
        if battle and battle.reply:
            self.say(result_line(battle.reply["won"], battle.reply["rewards"]))
        self.sync_looks()

    # Pointer ------------------------------------------------------------------------------------
    def target(self, x: float, y: float):
        """What a canvas point is on: HUD, a goblin's id, or None for the boss and the pops. (The
        desktop under an empty pixel never gets here: the window lets the pointer through.)"""
        if self.paint.in_hud(x, y):
            return HUD
        if self.goblins_hidden:
            return None
        goblin = self.world.goblin_at(x, y)
        return goblin if goblin is not None else self.paint.goblin_under(x, y)

    def tip(self, target) -> str:
        if target != HUD:
            return goblin_tip(target, self.paint.unlocked)
        game = self.battle.held if self.battle else self.game
        income = self.income
        return hud_tip(None if self.status else game, income.earned, income.quiet_minutes(self.last), self.trouble)

    def holding(self) -> bool:
        return isinstance(self.pressed, int)

    def let_go(self) -> None:
        if self.holding():
            self.world.drop()
            self.canvas.configure(cursor="")
        self.pressed = None

    def on_press(self, event) -> None:
        """A goblin is picked up by the scruff; the pill waits for the button to come up."""
        target = self.target(event.x, event.y)
        if target is not None and target != HUD:
            if not self.world.grab(target):
                return
            self.world.move_grabbed(event.x, event.y)
            self.hover = None
            self.app.tooltip.hide()
            self.canvas.configure(cursor="fleur")
        self.pressed = target

    def on_drag(self, event) -> None:
        if self.holding():
            self.world.move_grabbed(event.x, event.y)

    def on_release(self, event) -> None:
        pressed = self.pressed
        self.let_go()
        if pressed == HUD:
            self.open_menu(event)

    def on_context(self, event) -> None:
        if self.target(event.x, event.y) is not None:
            self.open_menu(event)

    def open_menu(self, event) -> None:
        self.app.tooltip.hide()
        self.app.show_pets_menu(event)

    def on_motion(self, event) -> None:
        if self.holding():
            return
        target = self.target(event.x, event.y)
        self.canvas.configure(cursor="hand2" if target is not None else "")
        self.hover = None if target in (None, HUD) else target
        if target is None:
            self.app.tooltip.hide()
        else:
            self.app.tooltip.schedule(self.tip(target), event.x_root, event.y_root, delay=TIP_MS)

    def on_leave(self, _event=None) -> None:
        self.hover = None
        self.app.tooltip.hide()

    def watch_hover(self) -> None:
        """A goblin's name tag comes down once the goblin has run out from under a pointer that stayed put."""
        if self.hover is None:
            return
        x, y = self.canvas.winfo_pointerxy()
        if self.target(x - self.canvas.winfo_rootx(), y - self.canvas.winfo_rooty()) != self.hover:
            self.on_leave()
