"""Goblin Horde's look on the desktop: the camp palette, readable fonts, one display scale, and the
tooltip the pet field shows.

Type is Segoe UI. Pixel sizes are written for a 96-DPI display and multiplied by ``Theme.scale``;
fonts are given in points, which Tk already scales for the display.
"""

from __future__ import annotations

import tkinter as tk
from tkinter import font as tkfont

import desktop_platform

PANEL = "#1b2a22"
LINE = "#3d5a4a"
IVORY = "#f6ecd2"
AMBER = "#f0c75e"
INK = "#15201a"


def fit_text(font, value: str, max_width: int) -> str:
    """One line that fits ``max_width`` pixels, ending in … when it had to be cut."""
    value = " ".join(str(value).split())
    if max_width <= 0:
        return ""
    if font.measure(value) <= max_width:
        return value
    low, high = 0, len(value)
    while low < high:  # The longest prefix that fits with its ellipsis.
        middle = (low + high + 1) // 2
        if font.measure(value[:middle].rstrip() + "…") <= max_width:
            low = middle
        else:
            high = middle - 1
    return value[:low].rstrip() + "…" if low else "…"


class Theme:
    """Fonts and the pixel scale for one Tk root."""

    def __init__(self, root: tk.Misc, scale: float = 1.0) -> None:
        self.scale = max(0.5, float(scale))
        strong = "Segoe UI Semibold" if "Segoe UI Semibold" in set(tkfont.families(root)) else "Segoe UI"
        weight = "normal" if strong != "Segoe UI" else "bold"
        self.small = tkfont.Font(root=root, family="Segoe UI", size=9)
        self.small_strong = tkfont.Font(root=root, family=strong, size=9, weight=weight)
        self.title = tkfont.Font(root=root, family=strong, size=12, weight=weight)
        self.name = tkfont.Font(root=root, family=strong, size=14, weight=weight)

    def px(self, value: float) -> int:
        """Design pixels (96 DPI) to screen pixels."""
        return int(round(value * self.scale))

    def line_height(self, font) -> int:
        return int(font.metrics("linespace"))


class Tooltip:
    """A small dark tip near the pointer, shown after a pause and gone when the pointer leaves."""

    def __init__(self, root: tk.Misc, theme: Theme) -> None:
        self.root = root
        self.theme = theme
        self.window: tk.Toplevel | None = None
        self.after = None
        self.text = ""

    def schedule(self, text: str, x_root: int, y_root: int, delay: int = 450) -> None:
        if text == self.text and (self.window is not None or self.after is not None):
            return
        self.hide()
        self.text = text
        if text:
            self.after = self.root.after(delay, lambda: self.show(text, x_root, y_root))

    def show(self, text: str, x_root: int, y_root: int) -> None:
        self.after = None
        if self.window is None:
            self.window = tk.Toplevel(self.root)
            self.window.withdraw()
            desktop_platform.float_window(self.window)
            self.window.configure(bg=LINE)
            self.label = tk.Label(self.window, bg=INK, fg=IVORY, font=self.theme.small, justify="left",
                                  padx=self.theme.px(8), pady=self.theme.px(5),
                                  wraplength=self.theme.px(360))
            self.label.pack(padx=1, pady=1)
        self.label.configure(text=text)
        self.window.update_idletasks()
        width, height = self.window.winfo_reqwidth(), self.window.winfo_reqheight()
        left, top, right, bottom = desktop_platform.monitor_work_area(self.root)
        x = max(left, min(x_root + self.theme.px(14), right - width - 4))
        y = y_root + self.theme.px(18)
        if y + height > bottom:
            y = y_root - height - self.theme.px(10)
        self.window.geometry(f"+{int(x)}+{int(y)}")
        self.window.deiconify()
        self.window.lift()

    def hide(self) -> None:
        self.text = ""
        if self.after is not None:
            self.root.after_cancel(self.after)
            self.after = None
        if self.window is not None:
            self.window.withdraw()

    def destroy(self) -> None:
        self.hide()
        if self.window is not None:
            self.window.destroy()
            self.window = None
