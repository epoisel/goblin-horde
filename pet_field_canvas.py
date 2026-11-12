"""The pet field's drawing: the goblins, the boss, pops, banners and the pill as items on one
see-through canvas.

Two budgets shape it, both measured on a 2560 by 1440 display.

Redraw. Tk redraws every item inside the box that changed, and with goblins along the whole taskbar
that box holds the whole horde: about 0.06 ms an item a frame. So the item count is the budget: one
image item a goblin, one for the boss, and small fixed pools for everything else.

Handles. Windows gives a process 10,000 GDI handles. Tk spends one on every image and one more
while a canvas item holds it, and a goblin switched to an image that no item holds costs 0.15 ms
against nothing for one that is held. So a goblin image is built when first needed, held ready by a
hidden item, and counted; past HELD_IMAGES the least recently shown is let go.
"""

from __future__ import annotations

import time
import tkinter.font as tkfont
from collections import OrderedDict
from typing import NamedTuple

import pet_art
import pet_boss
from goblin_look import look_for
from horde_theme import AMBER, INK, IVORY, LINE, PANEL, Theme, fit_text

OVER = "over"  # Items that stay above the horde: the boss's bar, pops, banners and the pill.
# Goblin images held ready: 7,200 handles. Three minutes of 150 goblins roaming show 6,090 different
# ones; holding 3,600, a frame builds 2.1 of them on average at about half a millisecond each.
HELD_IMAGES = 3600
# Frames that are the same picture share one image: a run's second and fourth step, and a climb's.
# A pose with stars turns them every frame, so it is always its own.
PICTURES = {action: tuple(frame if pose.stars else poses.index(pose) for frame, pose in enumerate(poses))
            for action, poses in pet_art.POSES.items()}
BUILD_SECONDS = 0.004  # What a frame may spend building poses; a goblin still waiting keeps its last one.
RESORT_EVERY = 6  # Frames between depth sorts.
SHOWN_ALPHA = 0.5  # A goblin fading in or out is drawn above this and not below: sprites have no half-clear form.
PIXEL_FONT = ("System", 10)  # Windows' own raster face: hard pixels, so nothing blurs into the see-through colour.
GAIN_FONT = ("MS Sans Serif", 14)  # A raster face too, half as tall again, for coins that arrived.
GOLD = "#fad048"

TEXT_POPS, EFFECT_POPS, BANNERS = 6, 18, 3  # Pool sizes: what can be on show at once.
# A text pop of any other kind is not drawn. The world's own "+N" is one: the field shows its "gain" instead.
POP_INKS = {"gain": GOLD, "hit": IVORY, "banner": IVORY}
GAIN_COIN_GAP = 2  # Sprite pixels between a gain's coin and its number.
EFFECT_FPS = {"coin": 10.0, "alert": 5.0, "dust": 0.0, "star": 0.0}  # 0 plays the frames once over the pop's life.
BANNER_RISE = 76  # Sprite pixels from the ground to the lowest banner: over the heads of hopping goblins.
HUD_MARGIN, HUD_RISE, HUD_MAX = 16, 30, 620  # Design pixels from the right edge and widest; sprite pixels up.
# The pill's gain is a block on its right end: (the block, its number) when bright, then at two steps of fading.
HUD_GAIN_LOOKS = ((GOLD, INK), ("#a48a35", INK), ("#55522b", GOLD))
HP_INKS = ((0.5, "#7cba4a"), (0.25, "#e8a024"), (0.0, "#e23c32"))
HP_BAR = {"gap": 7, "height": 3, "share": 0.45, "least": 40}  # Sprite pixels, and its share of the boss's height.
BOSS_AHEAD_EVERY = 3  # Frames between boss images built ahead: the largest takes 44 ms.
# What a fight shows, in the order it is built ahead while the boss walks on: (pose, hit flash, turned
# round), the last being its walk back out when the horde loses.
BOSS_AHEAD = (("walk", False, False), ("roar", False, False), ("stand", False, False), ("stomp", False, False),
              ("hurt", False, False), ("hurt", True, False), ("stand", True, False), ("roar", True, False),
              ("stomp", True, False), ("fall", False, False), ("walk", False, True))


class BossImage(NamedTuple):
    image: object
    ax: int  # The feet centre, in screen pixels from the image's top left.
    ay: int
    width: int


class Held:
    """Images kept ready to show, at most ``most``: each is held by a hidden canvas item, so Tk
    keeps its drawable and switching to it is free. The least recently asked for goes first."""

    def __init__(self, canvas, most: int) -> None:
        self.canvas = canvas
        self.most = most
        self.entries: OrderedDict[tuple, tuple] = OrderedDict()  # key -> (the item holding it, image)

    def get(self, key: tuple):
        entry = self.entries.get(key)
        if entry is None:
            return None
        self.entries.move_to_end(key)
        return entry[1]

    def put(self, key: tuple, image):
        if len(self.entries) < self.most:
            keeper = self.canvas.create_image(0, 0, anchor="nw", state="hidden", image=image)
        else:
            keeper = self.entries.popitem(last=False)[1][0]
            self.canvas.itemconfigure(keeper, image=image)
        self.entries[key] = (keeper, image)
        return image

    def clear(self) -> None:
        for keeper, _image in self.entries.values():
            self.canvas.delete(keeper)
        self.entries.clear()


def pixel_font(canvas, face: tuple, otherwise):
    """A font for pops: Windows' raster ``face`` where there is one, ``otherwise`` elsewhere."""
    family, size = face
    if family not in tkfont.families(canvas):
        return otherwise
    return tkfont.Font(root=canvas, family=family, size=size, weight="bold")


class FieldCanvas:
    """Everything the field shows. ``unit`` is the screen pixels a sprite pixel takes."""

    def __init__(self, canvas, theme: Theme, unit: int) -> None:
        self.canvas = canvas
        self.theme = theme
        self.unit = unit
        # The caches below decide what lives, so the builders keep nothing of their own.
        self.sprites = pet_art.PetSprites(canvas, budget=0)
        self.bosses = pet_boss.PetBossImages(canvas, budget=0)
        self.held = Held(canvas, HELD_IMAGES)
        self.effect_art = Held(canvas, sum(pet_art.EFFECT_FRAMES.values()) + 1)  # And the one coin of a gain.
        self.size = (1, 1)
        self.ground = 1
        self.unlocked: frozenset = frozenset()
        self.looks: dict[int, object] = {}
        self.items: dict[int, int] = {}  # Goblin id -> its image item.
        self.goblin_of: dict[int, int] = {}
        self.shown: dict[int, tuple] = {}  # Goblin id -> (key, image) its item shows.
        self.spots: dict[int, tuple] = {}
        self.order: list[int] = []
        self.unsorted = False
        self.frames = 0
        self.font = pixel_font(canvas, PIXEL_FONT, theme.small_strong)
        self.gain_font = pixel_font(canvas, GAIN_FONT, theme.name)
        self.gain_unit = unit + unit // 2  # A gain's coin is drawn half as large again, like its number.
        self.gain_coin = (pet_art.effect_pixels("coin").width * self.gain_unit, GAIN_COIN_GAP * unit)  # Width and gap.
        self.line = theme.line_height(self.font)
        self.widths: dict[tuple, int] = {}
        self.shade = max(1, unit // 2)  # How far a pop's shadow falls.
        c = canvas
        self.boss_item = c.create_image(0, 0, anchor="nw", state="hidden")
        self.boss_images: dict[tuple, BossImage] = {}
        self.boss_ahead: list[tuple] = []
        self.boss_now: int | None = None  # The index of the boss on show.
        self.boss_view: tuple | None = None
        self.bar_view: tuple | None = None
        self.bar_back = c.create_rectangle(0, 0, 0, 0, fill=pet_art.BLACK, outline=pet_art.BLACK, state="hidden",
                                           tags=(OVER, "bar"))
        self.bar_fill = c.create_rectangle(0, 0, 0, 0, outline="", state="hidden", tags=(OVER, "bar"))
        self.bar_plate = c.create_rectangle(0, 0, 0, 0, fill=pet_art.BLACK, outline=pet_art.BLACK, state="hidden",
                                            tags=(OVER, "bar"))
        self.bar_name = c.create_text(0, 0, fill=IVORY, font=self.font, state="hidden", tags=(OVER, "bar"))
        self.effects = [c.create_image(0, 0, state="hidden", tags=OVER) for _ in range(EFFECT_POPS)]
        self.effect_views: list = [None] * EFFECT_POPS
        self.words = [(c.create_text(0, 0, fill=pet_art.BLACK, font=self.font, state="hidden", tags=OVER),
                       c.create_text(0, 0, font=self.font, state="hidden", tags=OVER)) for _ in range(TEXT_POPS)]
        self.word_views: list = [None] * TEXT_POPS
        self.banner_items = [(c.create_rectangle(0, 0, 0, 0, fill=PANEL, outline=LINE, state="hidden", tags=OVER),
                              c.create_text(0, 0, fill=IVORY, font=self.font, state="hidden", tags=OVER))
                             for _ in range(BANNERS)]
        self.banner_view: tuple = ()
        self.hud_back = c.create_rectangle(0, 0, 0, 0, fill=PANEL, outline=LINE, tags=OVER)
        self.hud_block = c.create_rectangle(0, 0, 0, 0, state="hidden", tags=OVER)
        self.hud_mark = c.create_text(0, 0, anchor="w", fill=AMBER, font=theme.small_strong, state="hidden", tags=OVER)
        self.hud_label = c.create_text(0, 0, anchor="w", fill=IVORY, font=theme.small_strong, tags=OVER)
        self.hud_gain = c.create_text(0, 0, font=theme.title, state="hidden", tags=OVER)
        self.hud_view: tuple | None = None
        self.hud_box = (0, 0, 0, 0)
        for kind, frames in pet_art.EFFECT_FRAMES.items():
            for frame in range(frames):
                self.effect_art.put((kind, frame), self.sprites.effect(kind, frame, unit))
        self.effect_art.put(("gain", 0), self.sprites.effect("coin", 0, self.gain_unit))

    def resize(self, width: int, height: int, ground: int) -> None:
        """Fit a new field: the pill and the banners move with its corner and its ground."""
        self.size, self.ground = (width, height), ground
        hud, banners = self.hud_view, self.banner_view
        self.hud_view, self.banner_view = None, ()
        if hud:
            self.hud(*hud)
        self.banners(banners)

    def release(self) -> None:
        """Let the horde's items and images go while the field is put away: their handles go back
        to Windows, and the next frame builds what it shows."""
        self._drop(set(self.items))
        self.held.clear()
        self._boss(None, (0, 0))

    def set_unlocked(self, unlocked: frozenset) -> None:
        """Shiny tiers were unlocked or locked: each goblin's look is worked out again."""
        if unlocked != self.unlocked:
            self.unlocked = unlocked
            self.looks = {}

    # The horde ----------------------------------------------------------------------------------
    def crowd(self, frame, still: bool = False, shake: tuple = (0, 0)) -> None:
        """Paint one frame of the world. ``still`` shows one pose an action and ``shake`` moves
        everything in the world, but not the pill or the banners, by that many pixels."""
        self._goblins(frame.draws, still, shake)
        self._boss(frame.boss, shake)
        self._pops(frame.pops, shake, pet_boss.boss_name(frame.boss.index) if frame.boss else "")
        self.frames += 1
        if self.unsorted or self.frames % RESORT_EVERY == 0:
            self._sort(frame)

    def goblin_under(self, x: float, y: float) -> int | None:
        """The front-most goblin whose sprite cell covers canvas point x, y."""
        for item in reversed(self.canvas.find_overlapping(x, y, x, y)):
            if item in self.goblin_of:
                return self.goblin_of[item]
        return None

    def _goblins(self, draws, still: bool, shake: tuple) -> None:
        c, unit, looks, items, shown, spots = self.canvas, self.unit, self.looks, self.items, self.shown, self.spots
        ox, oy = shake[0] - pet_art.AX * unit, shake[1] - pet_art.GY * unit
        seen, waiting = set(), []
        for draw in draws:
            if draw.alpha < SHOWN_ALPHA:
                continue
            goblin = draw.id
            seen.add(goblin)
            look = looks.get(goblin)
            if look is None:
                look = looks[goblin] = look_for(goblin, self.unlocked)
            pictures = PICTURES[draw.action]
            key = (look.name, draw.action, 0 if still else pictures[draw.frame % len(pictures)], draw.flip)
            showing = shown.get(goblin)
            if showing is None or showing[0] != key:
                image = self.held.get(key)
                if image is None:
                    waiting.append((draw, look, key))
                    if showing is None:
                        continue
                else:
                    self._show(goblin, key, image)
            spot = (round(draw.x) + ox, round(draw.y) + oy)
            if spots.get(goblin) != spot:
                spots[goblin] = spot
                c.coords(items[goblin], *spot)
        if waiting:
            self._build(waiting, ox, oy)
        if len(items) > len(seen):
            self._drop(items.keys() - seen)

    def _show(self, goblin: int, key: tuple, image) -> None:
        item = self.items.get(goblin)
        if item is None:
            item = self.items[goblin] = self.canvas.create_image(0, 0, anchor="nw", image=image)
            self.canvas.tag_lower(item, OVER)
            self.goblin_of[item] = goblin
            self.unsorted = True
        else:
            self.canvas.itemconfigure(item, image=image)
        self.shown[goblin] = (key, image)

    def _build(self, waiting: list, ox: int, oy: int) -> None:
        """Build the poses that are not held ready. A goblin with nothing to show is built whatever
        the time, so a horde arrives whole; the rest take turns inside the frame's budget."""
        turn = self.frames % len(waiting)
        waiting = sorted(waiting[turn:] + waiting[:turn], key=lambda want: want[0].id in self.shown)
        deadline = time.perf_counter() + BUILD_SECONDS
        for draw, look, key in waiting:
            if draw.id in self.shown and time.perf_counter() > deadline:
                return
            image = self.held.get(key) or self.held.put(key, self.sprites.image(look, key[1], key[2], self.unit, key[3]))
            self._show(draw.id, key, image)
            spot = self.spots[draw.id] = (round(draw.x) + ox, round(draw.y) + oy)
            self.canvas.coords(self.items[draw.id], *spot)

    def _drop(self, goblins) -> None:
        for goblin in goblins:
            item = self.items.pop(goblin)
            self.canvas.delete(item)
            del self.goblin_of[item]
            for record in (self.looks, self.shown, self.spots):
                record.pop(goblin, None)
        self.order = []

    def _sort(self, frame) -> None:
        """Stack the goblins back to front as the world lists them, with the boss among them: in
        front of the goblins standing in the lanes behind its feet, behind everyone else."""
        self.unsorted = False
        boss, ground, items = frame.boss, self.ground, self.items
        behind, front = [], []
        for draw in frame.draws:
            item = items.get(draw.id)
            if item is not None:
                (behind if boss is not None and ground <= draw.y < boss.y else front).append(item)
        order = behind + [self.boss_item] + front
        if order == self.order:
            return
        self.order = order
        for item in order:
            self.canvas.tag_raise(item)
        self.canvas.tag_raise(OVER)

    # The boss -----------------------------------------------------------------------------------
    def _boss(self, boss, shake: tuple) -> None:
        c = self.canvas
        if boss is None:
            if self.boss_now is not None:
                self.boss_now = self.boss_view = self.bar_view = None
                self.boss_images, self.boss_ahead = {}, []
                c.itemconfigure(self.boss_item, state="hidden", image="")
                c.itemconfigure("bar", state="hidden")
            return
        if self.boss_now != boss.index:
            self.boss_now = boss.index
            self.boss_images, self.unsorted = {}, True
            self.boss_ahead = [(pose, frame, flash, boss.flip != turned) for pose, flash, turned in reversed(BOSS_AHEAD)
                               for frame in reversed(range(pet_boss.boss_frames(pose)))]
            c.itemconfigure(self.boss_item, state="normal")
        key = (boss.pose, boss.frame % pet_boss.boss_frames(boss.pose), boss.flash, boss.flip)
        art = self.boss_images.get(key)
        if art is None and boss.flash:
            art = self.boss_images.get((*key[:2], False, key[3]))  # A flash that was not built ahead is not worth a hitch.
        if art is None:
            art = self._boss_image(boss.index, (*key[:2], False, key[3]))
        elif self.boss_ahead and self.frames % BOSS_AHEAD_EVERY == 0:
            self._boss_image(boss.index, self.boss_ahead.pop())
        x, y = round(boss.x), round(boss.y)
        if boss.pose == "fall":
            x = min(max(x, art.ax), max(art.ax, self.size[0] - art.width + art.ax))
        view = (art.image, x - art.ax + shake[0], y - art.ay + shake[1])
        if view != self.boss_view:
            if self.boss_view is None or view[0] is not self.boss_view[0]:
                c.itemconfigure(self.boss_item, image=art.image)
            c.coords(self.boss_item, view[1], view[2])
            self.boss_view = view
        self._bar(boss, x + shake[0], y + shake[1])

    def _boss_image(self, index: int, key: tuple) -> BossImage:
        art = self.boss_images.get(key)
        if art is None:
            pose, frame, flash, flip = key
            image = self.bosses.image(index, pose, frame, self.unit, flash, flip)
            art = self.boss_images[key] = BossImage(image, *self.bosses.anchor(index, pose, self.unit, flip), image.width())
        return art

    def _bar(self, boss, x: int, y: int) -> None:
        """The boss's name on a plate over a thin health bar, above its head and inside the field.
        Both go when its health does."""
        c, unit = self.canvas, self.unit
        name = pet_boss.boss_name(boss.index)
        hp = max(0.0, min(1.0, boss.hp))
        width = max(HP_BAR["least"] * unit, int(boss.height_px * HP_BAR["share"]))
        half = max(width // 2, self._width(name) // 2 + 3 * unit)
        tall = HP_BAR["height"] * unit
        x = min(max(x, half + unit), self.size[0] - half - unit)
        top = max(self.line + 3 * unit, round(y - boss.height_px) - (HP_BAR["gap"] + HP_BAR["height"]) * unit)
        view = None if hp <= 0.0 else (name, x, top, round((width - 2 * unit) * hp),
                                       next(ink for share, ink in HP_INKS if hp >= share))
        if view == self.bar_view:
            return
        if (view is None) != (self.bar_view is None):
            c.itemconfigure("bar", state="hidden" if view is None else "normal")
        self.bar_view = view
        if view is None:
            return
        left, plate = x - width // 2, self._width(name) // 2 + 3 * unit
        c.coords(self.bar_back, left, top, left + width, top + tall)
        c.coords(self.bar_fill, left + unit, top + unit, left + unit + view[3], top + tall - unit)
        c.itemconfigure(self.bar_fill, fill=view[4])
        c.coords(self.bar_plate, x - plate, top - self.line - unit, x + plate, top)
        c.coords(self.bar_name, x, top - self.line // 2 - unit // 2)
        c.itemconfigure(self.bar_name, text=name)

    # Pops ---------------------------------------------------------------------------------------
    def _width(self, text: str, gain: bool = False) -> int:
        width = self.widths.get((text, gain))
        if width is None:
            if len(self.widths) > 400:
                self.widths.clear()
            width = self.widths[text, gain] = (self.gain_font if gain else self.font).measure(text)
        return width

    def _pops(self, pops, shake: tuple, named: str) -> None:
        """Text pops as words with a one pixel shadow, the others as their small sprites, each from
        a fixed pool. A gain is larger words after a coin seen face on, the pair centred on the
        pop's point. ``named`` is the boss's name, which its plate already shows."""
        c, shade = self.canvas, self.shade
        ox, oy = shake
        words = effects = 0
        for pop in pops:
            x, y = round(pop.x) + ox, round(pop.y) + oy
            if pop.text:
                if words == TEXT_POPS or pop.kind not in POP_INKS or pop.text == named:
                    continue
                gain = pop.kind == "gain"
                if gain:
                    coin, gap = self.gain_coin
                    if effects < EFFECT_POPS:
                        self._sprite(effects, "gain", 0, x - (gap + self._width(pop.text, True)) // 2, y)
                        effects += 1
                    x += (coin + gap) // 2
                under, label = self.words[words]
                view = (pop.text, POP_INKS[pop.kind], gain)
                if view != self.word_views[words]:
                    self.word_views[words] = view
                    font = self.gain_font if gain else self.font
                    c.itemconfigure(under, text=pop.text, font=font, state="normal")
                    c.itemconfigure(label, text=pop.text, font=font, fill=view[1], state="normal")
                c.coords(under, x + shade, y + shade)
                c.coords(label, x, y)
                words += 1
            elif effects < EFFECT_POPS and pop.kind in EFFECT_FPS:
                fps, count = EFFECT_FPS[pop.kind], pet_art.EFFECT_FRAMES[pop.kind]
                frame = int(pop.age * fps) % count if fps else min(count - 1, int(count * pop.age / max(pop.life, 1e-6)))
                self._sprite(effects, pop.kind, frame, x, y)
                effects += 1
        for index in range(words, TEXT_POPS):
            if self.word_views[index] is not None:
                self.word_views[index] = None
                for item in self.words[index]:
                    c.itemconfigure(item, state="hidden")
        for index in range(effects, EFFECT_POPS):
            if self.effect_views[index] is not None:
                self.effect_views[index] = None
                c.itemconfigure(self.effects[index], state="hidden")

    def _sprite(self, index: int, kind: str, frame: int, x: int, y: int) -> None:
        """Show pool sprite ``index`` as the held image of ``kind`` at ``frame``, centred on x, y."""
        item = self.effects[index]
        if self.effect_views[index] != (kind, frame):
            self.effect_views[index] = (kind, frame)
            self.canvas.itemconfigure(item, image=self.effect_art.get((kind, frame)), state="normal")
        self.canvas.coords(item, x, y)

    def banners(self, lines) -> None:
        """Show the field's own lines, newest lowest, on plates above the middle of the ground."""
        lines = tuple(lines)[:BANNERS]
        if lines == self.banner_view:
            return
        self.banner_view = lines
        c, unit = self.canvas, self.unit
        tall = self.line + 2 * unit
        middle, bottom = self.size[0] // 2, self.ground - BANNER_RISE * unit
        for index, (plate, label) in enumerate(self.banner_items):
            if index >= len(lines):
                c.itemconfigure(plate, state="hidden")
                c.itemconfigure(label, state="hidden")
                continue
            half = self._width(lines[index]) // 2 + 4 * unit
            top = bottom - (index + 1) * (tall + unit)
            c.coords(plate, middle - half, top, middle + half, top + tall)
            c.coords(label, middle, top + tall // 2)
            c.itemconfigure(plate, state="normal")
            c.itemconfigure(label, text=lines[index], state="normal")

    # The pill -----------------------------------------------------------------------------------
    def hud(self, text: str, mark: str = "", gain: str = "", dim: int = 0) -> None:
        """Show ``text`` on the pill over the horde's bottom right corner. ``mark`` goes before it in
        amber, with an amber rim. ``gain`` is larger, on a gold block that ends the pill, ``dim``
        steps faded, and the pill's rim matches it, twice as thick while the gain is bright."""
        if (text, mark, gain, dim) == self.hud_view:
            return
        self.hud_view = (text, mark, gain, dim)
        c, theme, px = self.canvas, self.theme, self.theme.px
        font = theme.small_strong
        before = font.measure(mark) + px(6) if mark else 0
        block = theme.title.measure(gain) + px(16) if gain else 0
        room = max(px(80), min(px(HUD_MAX), self.size[0] - px(2 * HUD_MARGIN + 20))) - before - block
        shown = text if font.measure(text) <= room else fit_text(font, text, room)
        right, bottom = self.size[0] - px(HUD_MARGIN), self.ground - HUD_RISE * self.unit
        left = right - block - px(20) - font.measure(shown) - before
        top = bottom - theme.line_height(font) - px(10)
        middle = (top + bottom) // 2
        fill, ink = HUD_GAIN_LOOKS[dim]
        self.hud_box = (left, top, right, bottom)
        c.coords(self.hud_back, left, top, right, bottom)
        c.itemconfigure(self.hud_back, outline=fill if gain else AMBER if mark else LINE, width=2 if gain and not dim else 1)
        c.coords(self.hud_block, right - block, top, right, bottom)
        c.itemconfigure(self.hud_block, fill=fill, outline=fill, state="normal" if gain else "hidden")
        c.coords(self.hud_mark, left + px(10), middle)
        c.itemconfigure(self.hud_mark, text=mark, state="normal" if mark else "hidden")
        c.coords(self.hud_label, left + px(10) + before, middle)
        c.itemconfigure(self.hud_label, text=shown)
        c.coords(self.hud_gain, right - block // 2, middle)
        c.itemconfigure(self.hud_gain, text=gain, fill=ink, state="normal" if gain else "hidden")

    def in_hud(self, x: float, y: float) -> bool:
        left, top, right, bottom = self.hud_box
        return left <= x <= right and top <= y <= bottom

    def destroy(self) -> None:
        """Let go of every image (on the Tk thread, before the window closes)."""
        for images in (self.held.entries, self.effect_art.entries, self.shown, self.boss_images):
            images.clear()
        self.sprites.clear()
        self.bosses.clear()
