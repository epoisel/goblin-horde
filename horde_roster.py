"""The roster: every goblin in one scrolling column, drawn on a canvas and updated in place.

Rows come from horde_model.build_roster. Each row keeps its canvas items between polls; a poll only
moves them and changes the words or colours that changed, so nothing flickers, the scroll position
holds, and the selection follows the agent's id. Goblins are repainted by the app's one ticker, and
only those in view.
"""

from __future__ import annotations

import tkinter as tk
from tkinter import ttk

from desktop_platform import bind_context
from goblin_sprite import SPAN_H, SPAN_W, TOP_ROOM, draw_sprite, sprite_scale
from horde_model import Row
from horde_theme import (AMBER, FAINT, GOLD, HOVER, IVORY, LINE, MUTED, PANEL, SELECTED, Theme, WheelRouter,
                         fit_text, tone)

SECTION_INK = {"needs": AMBER, "results": GOLD}
CUE_COLUMNS = SPAN_W  # A goblin and the cue beside its head; text starts after them.


class RowView:
    """The canvas items of one roster row, kept and updated between polls."""

    def __init__(self, roster: "RosterView", row: Row, serial: int) -> None:
        self.roster = roster
        self.kind = row.kind
        self.row = row
        self.top = -1
        self.height = 0
        self.texts: dict[str, str] = {}
        self.sprite_tag = f"sprite-{serial}"
        self.sprite_at: tuple[int, int] | None = None
        self.painted = ""
        c = roster.canvas
        self.bg = c.create_rectangle(0, 0, 0, 0, outline="", fill=PANEL)
        self.bar = c.create_rectangle(0, 0, 0, 0, outline="", fill=GOLD, state="hidden")
        self.items: dict[str, int] = {}
        theme = roster.theme
        if self.kind == "section":
            self.items["title"] = c.create_text(0, 0, anchor="w", font=theme.small_strong, fill=MUTED)
            self.items["rule"] = c.create_line(0, 0, 0, 0, fill=LINE)
        elif self.kind == "party":
            self.items["title"] = c.create_text(0, 0, anchor="w", font=theme.small_strong, fill=IVORY)
            self.items["meta"] = c.create_text(0, 0, anchor="e", font=theme.small, fill=FAINT)
            self.items["rule"] = c.create_line(0, 0, 0, 0, fill=LINE)
        elif self.kind == "note":
            self.items["title"] = c.create_text(0, 0, anchor="w", font=theme.small, fill=FAINT)
        else:
            self.items["title"] = c.create_text(0, 0, anchor="sw", font=theme.strong, fill=IVORY)
            self.items["meta"] = c.create_text(0, 0, anchor="sw", font=theme.small, fill=FAINT)
            self.items["right"] = c.create_text(0, 0, anchor="se", font=theme.small, fill=FAINT)
            self.items["line"] = c.create_text(0, 0, anchor="nw", font=theme.small, fill=MUTED)
            if self.kind in ("watch", "result"):
                self.items["glyph"] = c.create_text(0, 0, anchor="center", font=theme.symbol, fill=GOLD)

    def text(self, name: str, value: str, **options) -> None:
        if name not in self.items:
            return
        if self.texts.get(name) != value:
            self.texts[name] = value
            self.roster.canvas.itemconfigure(self.items[name], text=value)
        if options:
            self.roster.canvas.itemconfigure(self.items[name], **options)

    def delete(self) -> None:
        c = self.roster.canvas
        c.delete(self.bg, self.bar, *self.items.values())
        c.delete(self.sprite_tag)

    def layout(self, row: Row, top: int, height: int, width: int) -> None:
        roster, theme, c = self.roster, self.roster.theme, self.roster.canvas
        self.row = row
        moved = (top, height) != (self.top, self.height)
        self.top, self.height = top, height
        px = theme.px
        c.coords(self.bg, 0, top, width, top + height)
        c.coords(self.bar, 0, top + px(2), px(3), top + height - px(2))
        middle = top + height // 2
        if self.kind == "section":
            arrow = ("▾ " if row.open else "▸ ") if row.section == "done" else ""
            label = f"{arrow}{row.title} · {row.count}" if row.count or row.section != "results" else f"{arrow}{row.title}"
            self.text("title", label, fill=SECTION_INK.get(row.section, MUTED))
            c.coords(self.items["title"], px(12), middle + px(2))
            right = px(12) + theme.small_strong.measure(label) + px(10)
            c.coords(self.items["rule"], right, middle + px(3), width - px(12), middle + px(3))
            return
        if self.kind == "party":
            c.coords(self.items["rule"], px(12), top + px(1), width - px(12), top + px(1))
            meta = row.meta
            meta_width = theme.small.measure(meta) if meta else 0
            room = width - px(14) - px(12) - (meta_width + px(12) if meta else 0)
            self.text("title", fit_text(theme.small_strong, row.title, room))
            self.text("meta", meta)
            c.coords(self.items["title"], px(12), middle + px(1))
            c.coords(self.items["meta"], width - px(12), middle + px(1))
            return
        if self.kind == "note":
            self.text("title", row.title)
            c.coords(self.items["title"], px(16), middle)
            return
        indent = px(10) + row.depth * px(18)
        if self.kind == "agent":
            scale = roster.sprite_scale
            sprite_x = indent
            sprite_y = top + (height - SPAN_H * scale) // 2 + TOP_ROOM * scale
            if moved or self.sprite_at != (sprite_x, sprite_y):
                self.sprite_at = (sprite_x, sprite_y)
                self.painted = ""
            left = indent + CUE_COLUMNS * scale + px(8)
        else:
            glyph = "★" if self.kind == "watch" else "◷"
            c.coords(self.items["glyph"], indent + px(12), middle)
            self.text("glyph", glyph)
            left = indent + px(28)
        right_text = row.right
        right_width = theme.small.measure(right_text) if right_text else 0
        edge = width - px(12)
        title_room = edge - left - (right_width + px(10) if right_text else 0)
        title = fit_text(theme.strong, row.title, title_room)
        title_ink = MUTED if row.context else IVORY
        self.text("title", title, fill=title_ink)
        meta = row.meta if row.meta and row.meta != row.title and row.kind == "agent" else ""
        meta_room = title_room - theme.strong.measure(title) - px(8)
        meta_text = fit_text(theme.small, f"· {meta}", meta_room) if meta and meta_room > px(60) else ""
        self.text("meta", meta_text)
        self.text("right", right_text)
        line = row.line
        line_text = fit_text(theme.small, line.text, edge - left) if line else ""
        self.text("line", line_text, fill=tone(line.tone) if line else MUTED)
        gap = px(1)
        c.coords(self.items["title"], left, middle - gap)
        c.coords(self.items["meta"], left + theme.strong.measure(title) + px(6), middle - gap - px(1))
        c.coords(self.items["right"], edge, middle - gap - px(1))
        c.coords(self.items["line"], left, middle + px(2))
        self.truncated = title != " ".join(row.title.split()) or (line is not None and line_text != " ".join(line.text.split()))

    def paint_state(self, selected: bool, hovered: bool) -> None:
        c = self.roster.canvas
        if self.kind in ("section", "party", "note"):
            c.itemconfigure(self.bg, fill=PANEL)
            c.itemconfigure(self.bar, state="hidden")
            return
        c.itemconfigure(self.bg, fill=SELECTED if selected else HOVER if hovered else PANEL)
        c.itemconfigure(self.bar, state="normal" if selected else "hidden")

    def paint_sprite(self, force: bool = False) -> None:
        """Draw this row's goblin; unless forced, only when its action or frame changed."""
        if self.kind != "agent" or self.sprite_at is None or not self.row.actor:
            return
        roster = self.roster
        style, action, frame, still = roster.app.sprite_state(self.row.actor, self.row.klass, "roster")
        key = f"{action}:{frame if not still else 0}:{style['name']}"
        if key == self.painted and not force:
            return
        self.painted = key
        c = roster.canvas
        c.delete(self.sprite_tag)
        x, y = self.sprite_at
        draw_sprite(c, x, y, style, action=action, frame=frame, scale=roster.sprite_scale, still=still,
                    tag=self.sprite_tag)
        c.tag_raise(self.sprite_tag, self.bar)


class RosterView:
    """The roster column of the Horde window."""

    WIDTH = 320

    def __init__(self, parent: tk.Misc, app, theme: Theme, wheel: WheelRouter) -> None:
        self.app = app
        self.theme = theme
        self.frame = tk.Frame(parent, bg=PANEL, width=theme.px(self.WIDTH), bd=0, highlightthickness=0)
        self.frame.grid_propagate(False)
        self.canvas = tk.Canvas(self.frame, bg=PANEL, bd=0, highlightthickness=0, takefocus=0,
                                yscrollincrement=theme.px(20))
        self.bar = ttk.Scrollbar(self.frame, orient="vertical", style="Horde.Vertical.TScrollbar",
                                 command=self.canvas.yview)
        self.canvas.configure(yscrollcommand=self._on_scroll)
        self.canvas.grid(row=0, column=0, sticky="nsew")
        self.bar.grid(row=0, column=1, sticky="ns")
        self.bar.grid_remove()
        self.frame.grid_rowconfigure(0, weight=1)
        self.frame.grid_columnconfigure(0, weight=1)
        self.sprite_scale = sprite_scale(2, theme.scale)
        self.views: dict[str, RowView] = {}
        self.rows: list[Row] = []
        self.selected = ""
        self.hovered = ""
        self.serial = 0
        self.width = 0
        self.total = 0
        self.canvas.bind("<Configure>", self._on_configure)
        self.canvas.bind("<Button-1>", self._on_click)
        self.canvas.bind("<Motion>", self._on_motion)
        self.canvas.bind("<Leave>", lambda _event: self._hover(""))
        bind_context(self.canvas, self._on_context)
        wheel.register(self.canvas, self.scroll)

    # Sizes -------------------------------------------------------------------------------------
    def row_height(self, row: Row) -> int:
        px = self.theme.px
        if row.kind == "section":
            return px(34)
        if row.kind == "party":
            return px(30)
        if row.kind == "note":
            return px(34)
        if row.kind == "agent":
            return max(px(58), SPAN_H * self.sprite_scale + px(8))
        return px(48)

    # Drawing -----------------------------------------------------------------------------------
    def render(self, rows: list[Row], selected: str) -> None:
        """Lay the rows out, reusing every row's items; only changes are drawn."""
        self.rows = rows
        self.selected = selected
        width = max(self.canvas.winfo_width(), self.theme.px(120))
        self.width = width
        top = self.theme.px(4)
        keep = set()
        for row in rows:
            view = self.views.get(row.key)
            if view is not None and view.kind != row.kind:
                view.delete()
                view = None
            if view is None:
                self.serial += 1
                view = self.views[row.key] = RowView(self, row, self.serial)
            height = self.row_height(row)
            view.layout(row, top, height, width)
            view.paint_state(row.key == selected, row.key == self.hovered)
            top += height
            keep.add(row.key)
        for key in [key for key in self.views if key not in keep]:
            self.views.pop(key).delete()
        self.total = top + self.theme.px(10)
        self.canvas.configure(scrollregion=(0, 0, width, max(self.total, self.canvas.winfo_height())))
        self.paint_sprites()

    def set_selected(self, key: str) -> None:
        previous, self.selected = self.selected, key
        for name in (previous, key):
            view = self.views.get(name)
            if view:
                view.paint_state(name == key, name == self.hovered)

    def visible_range(self) -> tuple[float, float]:
        top = self.canvas.canvasy(0)
        return top, top + self.canvas.winfo_height()

    def paint_sprites(self, force: bool = False) -> None:
        """Repaint the goblins in view (the ticker calls this every beat)."""
        low, high = self.visible_range()
        for view in self.views.values():
            if view.kind == "agent" and view.top + view.height >= low and view.top <= high:
                view.paint_sprite(force)

    def ensure_visible(self, key: str) -> None:
        view = self.views.get(key)
        if not view or self.total <= 0:
            return
        low, high = self.visible_range()
        margin = self.theme.px(8)
        if view.top < low:
            self.canvas.yview_moveto(max(0, view.top - margin) / self.total)
        elif view.top + view.height > high:
            self.canvas.yview_moveto(max(0, view.top + view.height + margin - (high - low)) / self.total)
        self.paint_sprites()

    # Events ------------------------------------------------------------------------------------
    def _on_scroll(self, first, last) -> None:
        self.bar.set(first, last)
        needed = float(first) > 0.0 or float(last) < 1.0
        if needed and not self.bar.winfo_ismapped():
            self.bar.grid()
        elif not needed and self.bar.winfo_ismapped():
            self.bar.grid_remove()
        self.paint_sprites()

    def _on_configure(self, event) -> None:
        if event.width != self.width and self.rows:
            self.render(self.rows, self.selected)

    def scroll(self, steps: int) -> None:
        if self.total > self.canvas.winfo_height():
            self.canvas.yview_scroll(steps * 3, "units")
            self.paint_sprites()

    def row_at(self, y_widget: int) -> Row | None:
        y = self.canvas.canvasy(y_widget)
        for view in self.views.values():
            if view.top <= y < view.top + view.height:
                return view.row
        return None

    def _on_click(self, event) -> None:
        self.canvas.focus_set()
        row = self.row_at(event.y)
        if row is not None:
            self.app.on_row_click(row)

    def _on_context(self, event) -> None:
        row = self.row_at(event.y)
        self.app.on_row_menu(row, event)

    def _hover(self, key: str) -> None:
        if key == self.hovered:
            return
        previous, self.hovered = self.hovered, key
        for name in (previous, key):
            view = self.views.get(name)
            if view:
                view.paint_state(name == self.selected, name == key)
        if not key:
            self.app.tooltip.hide()

    def _on_motion(self, event) -> None:
        row = self.row_at(event.y)
        clickable = row is not None and row.kind in ("agent", "watch", "result", "party") or (
            row is not None and row.kind == "section" and row.section == "done")
        self.canvas.configure(cursor="hand2" if clickable else "")
        self._hover(row.key if row is not None and row.kind in ("agent", "watch", "result") else "")
        view = self.views.get(row.key) if row is not None else None
        if view is not None and getattr(view, "truncated", False):
            text = row.title + (f"\n{row.line.text}" if row.line else "")
            self.app.tooltip.schedule(text, event.x_root, event.y_root)
        else:
            self.app.tooltip.hide()
