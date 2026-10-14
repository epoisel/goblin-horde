"""The goblin strip: just the goblins, standing in a row on the desktop.

A borderless, see-through, always-on-top window, docked above the taskbar at the bottom right until
it is dragged somewhere else. Goblins stand at 2x grouped by party with small gaps; a bubble over
each head says ? (needs you), ! (failed), … (working), or ✓ (done, and the goblin is faded). Hover
for the goblin's name and what it is doing; click one to open the Horde window on it. The pill on
the left counts who needs you and opens the window too. At most twelve goblins, then "+N".
"""

from __future__ import annotations

import tkinter as tk

import desktop_platform
from desktop_platform import bind_context, float_window, make_transparent, screen_geometry
from goblin_sprite import SPAN_H, SPAN_W, TOP_ROOM, place_sprite, sprite_scale
from horde_model import DONE, FAILED, NEEDS, StripItem, actor_id, clip, display_name, strip_tooltip
from horde_theme import AMBER, CORAL, FAINT, GOLD, INK, IVORY, LINE, LIVELY, MUTED, PANEL, Theme, fit_text

SLOT_COLUMNS = SPAN_W  # A goblin and the cue beside its head.
BUBBLES = {NEEDS: ("?", AMBER, INK), FAILED: ("!", CORAL, INK), DONE: ("✓", PANEL, FAINT)}


class GoblinStrip:
    """The compact surface. ``app`` provides sprite_state, open_window, tooltip, and the menu."""

    def __init__(self, app, theme: Theme) -> None:
        self.app = app
        self.theme = theme
        self.window = tk.Toplevel(app.root)
        self.window.withdraw()
        self.window.title("Goblin Horde")
        float_window(self.window)
        self.clear = make_transparent(self.window)
        self.canvas = tk.Canvas(self.window, bg=self.clear, bd=0, highlightthickness=0)
        self.canvas.pack(fill="both", expand=True)
        self.scale = sprite_scale(2, theme.scale)
        self.items: list[StripItem] = []
        self.hidden = 0
        self.needs = 0
        self.slots: list[tuple[int, int, str, str]] = []  # (left, right, kind, actor id)
        self.sprites: list[tuple[str, int, int, StripItem]] = []
        self.painted: dict[str, str] = {}
        self.shown = False
        self.size = (0, 0)
        self.anchor: tuple[int, int] | None = None  # The bottom-right corner, in screen pixels.
        self.drag: tuple[int, int, int, int] | None = None
        self.dragged = False
        self.signature = None
        self.canvas.bind("<ButtonPress-1>", self.on_press)
        self.canvas.bind("<B1-Motion>", self.on_drag)
        self.canvas.bind("<ButtonRelease-1>", self.on_release)
        self.canvas.bind("<Motion>", self.on_motion)
        self.canvas.bind("<Leave>", lambda _event: self.app.tooltip.hide())
        bind_context(self.canvas, lambda event: self.app.show_strip_menu(event))
        # Alt+F4 on the strip leaves it where it is; Quit lives in the menu.
        self.window.protocol("WM_DELETE_WINDOW", lambda: None)

    # Geometry ---------------------------------------------------------------------------------
    def metrics(self) -> dict:
        px, s = self.theme.px, self.scale
        bubble = px(18)
        sprite_h = SPAN_H * s
        name_h = self.theme.line_height(self.theme.small) + px(4)
        return {"bubble": bubble, "sprite_top": px(4) + bubble, "sprite_h": sprite_h, "name_h": name_h,
                "slot": SLOT_COLUMNS * s, "gap": px(12), "height": px(4) + bubble + sprite_h + name_h + px(6)}

    def default_anchor(self) -> tuple[int, int]:
        left, top, right, bottom = desktop_platform.monitor_work_area(self.app.root)
        return right - self.theme.px(16), bottom - self.theme.px(6)

    def place(self) -> None:
        width, height = self.size
        right, bottom = self.anchor or self.default_anchor()
        areas = desktop_platform.monitor_areas()
        if areas and not any(left <= right - 40 and right <= r + 2 * width and top <= bottom - 20 <= b
                             for left, top, r, b in areas):
            right, bottom = self.default_anchor()  # Its display is gone: dock it again.
        self.window.geometry(f"{width}x{height}{screen_geometry(right - width, bottom - height)}")

    # Drawing ----------------------------------------------------------------------------------
    def update(self, items: list[StripItem], hidden: int, needs: int, force: bool = False) -> None:
        """Lay the goblins out again when who is shown changed; otherwise only repaint."""
        signature = ([(actor_id(item.actor), item.klass, item.gap, display_name(item.actor, self.app.aliases))
                      for item in items], hidden, needs)
        self.items, self.hidden, self.needs = items, hidden, needs
        if signature == self.signature and not force:
            self.paint_sprites()
            return
        self.signature = signature
        self.layout()

    def layout(self) -> None:
        c, theme, px = self.canvas, self.theme, self.theme.px
        m = self.metrics()
        c.delete("all")
        self.slots = []
        self.sprites = []
        self.painted = {}
        x = px(4)
        middle = m["sprite_top"] + m["sprite_h"] // 2
        label = (f"{self.needs} need{'s' if self.needs == 1 else ''} you" if self.needs
                 else "Goblin Horde" if self.items else "Goblin Horde · all quiet")
        pill_w = theme.small_strong.measure(label) + px(20)
        fill, ink = (AMBER, INK) if self.needs else (PANEL, IVORY)
        c.create_rectangle(x, middle - px(12), x + pill_w, middle + px(12), fill=fill, outline=GOLD if self.needs else LINE)
        c.create_text(x + pill_w // 2, middle, text=label, fill=ink, font=theme.small_strong)
        self.slots.append((x, x + pill_w, "pill", ""))
        x += pill_w + px(10)
        for index, item in enumerate(self.items):
            if item.gap:
                x += m["gap"]
            left = x
            tag = f"goblin-{index}"
            place_sprite(c, left, m["sprite_top"] + TOP_ROOM * self.scale, self.scale, tag)
            self.sprites.append((tag, left, m["sprite_top"], item))
            # The bubble over the head: centred over the body (columns 1-17).
            glyph, back, front = BUBBLES.get(item.klass, ("", PANEL, LIVELY))
            center = left + 9 * self.scale
            half_w, half_h = px(13), px(8)
            bubble_tag = f"bubble-{index}"
            c.create_oval(center - half_w, px(4), center + half_w, px(4) + 2 * half_h, fill=back,
                          outline=back if item.klass in (NEEDS, FAILED) else LINE, tags=bubble_tag)
            c.create_text(center, px(4) + half_h, text=glyph, fill=front, font=theme.small_strong,
                          tags=(bubble_tag, f"{bubble_tag}-text"))
            # A short name under each goblin, on a dark tab so it reads on any wallpaper.
            name = clip(display_name(item.actor, self.app.aliases), 18)
            shown = fit_text(theme.small, name, m["slot"] - px(4))
            text_w = theme.small.measure(shown) + px(8)
            name_top = m["sprite_top"] + m["sprite_h"] + px(1)
            name_center = left + m["slot"] // 2
            c.create_rectangle(name_center - text_w // 2, name_top, name_center + text_w // 2, name_top + m["name_h"],
                               fill=PANEL, outline=PANEL)
            c.create_text(name_center, name_top + m["name_h"] // 2, text=shown,
                          fill=FAINT if item.klass == DONE else IVORY, font=theme.small)
            self.slots.append((left, left + m["slot"], "goblin", actor_id(item.actor)))
            x = left + m["slot"]
        if self.hidden:
            label = f"+{self.hidden}"
            width = theme.small_strong.measure(label) + px(16)
            x += px(6)
            c.create_rectangle(x, middle - px(11), x + width, middle + px(11), fill=PANEL, outline=LINE)
            c.create_text(x + width // 2, middle, text=label, fill=MUTED, font=theme.small_strong)
            self.slots.append((x, x + width, "more", ""))
            x += width
        width, height = x + px(4), m["height"]
        c.configure(width=width, height=height)
        self.size = (width, height)
        if self.shown:
            self.place()
        self.paint_sprites(force=True)

    def paint_sprites(self, force: bool = False) -> None:
        if not self.shown and not force:
            return
        c = self.canvas
        for tag, _x, _y, item in self.sprites:
            style, action, frame, still = self.app.sprite_state(item.actor, item.klass, "strip")
            done = item.klass == DONE  # Faded, and resting on one frame.
            image = self.app.sprite_images.image(style, action, frame, self.scale, still or done, faded=done)
            if self.painted.get(tag) is image and not force:
                continue
            self.painted[tag] = image
            c.itemconfigure(f"{tag}-image", image=image)
        # Working goblins' bubbles count dots on the shared beat.
        dots = "•" * (1 + self.app.phase % 3) if not self.app.reduced_motion else "•••"
        for index, (_tag, _x, _y, item) in enumerate(self.sprites):
            if item.klass not in BUBBLES:
                c.itemconfigure(f"bubble-{index}-text", text=dots, fill=LIVELY)

    def animate(self) -> None:
        if self.shown:
            self.paint_sprites()

    # Showing ----------------------------------------------------------------------------------
    def show(self) -> None:
        if not self.size[0]:
            self.layout()
        self.shown = True
        self.place()
        self.window.deiconify()
        self.window.lift()
        self.paint_sprites(force=True)

    def hide(self) -> None:
        self.shown = False
        self.app.tooltip.hide()
        self.window.withdraw()

    def destroy(self) -> None:
        self.window.destroy()

    # Pointer ----------------------------------------------------------------------------------
    def slot_at(self, x: int) -> tuple[int, int, str, str] | None:
        return next((slot for slot in self.slots if slot[0] <= x <= slot[1]), None)

    def on_press(self, event) -> None:
        self.dragged = False
        self.drag = (event.x_root, event.y_root, self.window.winfo_x(), self.window.winfo_y())

    def on_drag(self, event) -> None:
        if not self.drag:
            return
        px_, py_, x, y = self.drag
        self.dragged = self.dragged or abs(event.x_root - px_) + abs(event.y_root - py_) > 5
        if self.dragged:
            self.app.tooltip.hide()
            self.window.geometry(screen_geometry(x + event.x_root - px_, y + event.y_root - py_))

    def on_release(self, event) -> None:
        self.drag = None
        if self.dragged:
            self.anchor = (self.window.winfo_x() + self.size[0], self.window.winfo_y() + self.size[1])
            self.app.strip_moved(self.anchor)
            return
        slot = self.slot_at(event.x)
        if slot is None:
            return
        _left, _right, kind, ident = slot
        if kind == "pill" and self.needs:
            # "2 need you": open on the first of them.
            ident = next((actor_id(item.actor) for item in self.items if item.klass == NEEDS), "")
        self.app.open_window(select=ident or None)

    def on_motion(self, event) -> None:
        slot = self.slot_at(event.x)
        self.canvas.configure(cursor="hand2" if slot else "")
        if not slot or self.drag:
            self.app.tooltip.hide()
            return
        _left, _right, kind, ident = slot
        if kind == "goblin":
            item = next((item for item in self.items if actor_id(item.actor) == ident), None)
            text = strip_tooltip(item.actor, self.app.aliases) if item else ""
        elif kind == "more":
            text = f"{self.hidden} more goblins. Click to open the Horde window."
        else:
            text = "Open the Horde window." if not self.needs else \
                f"{self.needs} {'goblin needs' if self.needs == 1 else 'goblins need'} you. Click to see their questions."
        self.app.tooltip.schedule(text, event.x_root, event.y_root, delay=250)
