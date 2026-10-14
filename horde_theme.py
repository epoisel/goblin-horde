"""The Horde window's look: the camp palette, readable fonts, one display scale, and the few
flat widgets (buttons, chips, tooltips, a scrolling area) every view builds with.

Colours are the dark-green palette shared with the browser viewer. Type is the platform's UI font
(Segoe UI 10 pt on Windows, the system font at 13 on macOS) with commands in a monospace face.
Pixel sizes are written for a 96-DPI display and multiplied by ``Theme.scale``; fonts are given in
points, which Tk already scales for the display.
"""

from __future__ import annotations

import sys
import tkinter as tk
from tkinter import font as tkfont, ttk

import desktop_platform

PANEL = "#1b2a22"
HEADER = "#1f3328"
CARD = "#243a2e"
LINE = "#3d5a4a"
IVORY = "#f6ecd2"
MUTED = "#b3c9b4"
FAINT = "#8aa391"
GOLD = "#dfbb78"
CORAL = "#e18a78"
LIVELY = "#a7d6b0"
LILAC = "#c7b9e2"
AMBER = "#f0c75e"
INK = "#15201a"
MONO_BG = "#16231c"
BUTTON = "#2e4739"
BUTTON_HOVER = "#3b5a48"
SELECTED = "#2d4a3a"
HOVER = "#223a2d"
ENTRY = "#122019"
TONES = {"ask": AMBER, "waiting": LILAC, "failed": CORAL, "now": MUTED, "done": FAINT, "finished": MUTED, "muted": MUTED,
         "lively": LIVELY, "coral": CORAL, "gold": GOLD, "ok": LIVELY, "starting": MUTED, "off": FAINT,
         "broken": CORAL, "offer": GOLD, "faint": FAINT, "ivory": IVORY}


def tone(name: str) -> str:
    return TONES.get(name, MUTED)


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


def fit_text_end(font, value: str, max_width: int) -> str:
    """One line that fits ``max_width`` pixels, keeping its end and starting with … when it had to be
    cut: "…module 43" for names that differ only at the end."""
    value = " ".join(str(value).split())
    if max_width <= 0:
        return ""
    if font.measure(value) <= max_width:
        return value
    low, high = 0, len(value)
    while low < high:  # The longest ending that fits after its ellipsis.
        middle = (low + high + 1) // 2
        if font.measure("…" + value[len(value) - middle:].lstrip()) <= max_width:
            low = middle
        else:
            high = middle - 1
    return "…" + value[len(value) - low:].lstrip() if low else "…"


def wrap_text(font, value: str, max_width: int) -> list[str]:
    """Word-wrapped lines no wider than ``max_width``; a word too long for a line is broken."""
    words = " ".join(str(value).split()).split(" ")
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if font.measure(candidate) <= max_width:
            current = candidate
            continue
        if current:
            lines.append(current)
            current = ""
        while word and font.measure(word) > max_width:
            prefix = fit_text(font, word, max_width).removesuffix("…")
            if not prefix:
                break
            lines.append(prefix)
            word = word[len(prefix):]
        current = word
    if current:
        lines.append(current)
    return lines or [""]


class Theme:
    """Fonts and the pixel scale for one Tk root."""

    def __init__(self, root: tk.Misc, scale: float = 1.0) -> None:
        self.root = root
        self.scale = max(0.5, float(scale))
        families = set(tkfont.families(root))
        mac = desktop_platform.is_mac()
        if sys.platform == "win32" and not mac:
            body, strong = "Segoe UI", "Segoe UI Semibold" if "Segoe UI Semibold" in families else "Segoe UI"
            strong_weight = "normal" if strong != "Segoe UI" else "bold"
            mono = "Cascadia Mono" if "Cascadia Mono" in families else "Consolas"
            symbol = "Segoe UI Symbol" if "Segoe UI Symbol" in families else body
            sizes = {"body": 10, "small": 9, "mono": 9, "title": 12, "name": 14, "symbol": 10}
        else:
            body = tkfont.nametofont("TkDefaultFont", root=root).actual("family")
            strong, strong_weight = body, "bold"
            mono = "Menlo" if mac else tkfont.nametofont("TkFixedFont", root=root).actual("family")
            symbol = body
            sizes = {"body": 13, "small": 11, "mono": 11, "title": 15, "name": 17, "symbol": 13} if mac else \
                {"body": 10, "small": 9, "mono": 9, "title": 12, "name": 14, "symbol": 10}
        self.families = {"body": body, "strong": strong, "mono": mono, "symbol": symbol}
        self.body = tkfont.Font(root=root, family=body, size=sizes["body"])
        self.strong = tkfont.Font(root=root, family=strong, size=sizes["body"], weight=strong_weight)
        self.small = tkfont.Font(root=root, family=body, size=sizes["small"])
        self.small_strong = tkfont.Font(root=root, family=strong, size=sizes["small"], weight=strong_weight)
        self.mono = tkfont.Font(root=root, family=mono, size=sizes["mono"])
        self.title = tkfont.Font(root=root, family=strong, size=sizes["title"], weight=strong_weight)
        self.name = tkfont.Font(root=root, family=strong, size=sizes["name"], weight=strong_weight)
        self.symbol = tkfont.Font(root=root, family=symbol, size=sizes["symbol"])
        self.style = ttk.Style(root)
        try:
            self.style.theme_use("clam")  # The one theme whose scrollbar takes colours on every platform.
        except tk.TclError:
            pass
        self.style.layout("Horde.Vertical.TScrollbar", [
            ("Vertical.Scrollbar.trough", {"sticky": "ns", "children": [
                ("Vertical.Scrollbar.thumb", {"expand": "1", "sticky": "nswe"})]})])
        self.style.configure("Horde.Vertical.TScrollbar", troughcolor=PANEL, background=LINE, bordercolor=PANEL,
                             lightcolor=LINE, darkcolor=LINE, gripcount=0, arrowsize=self.px(9), relief="flat")
        self.style.map("Horde.Vertical.TScrollbar", background=[("pressed", "#5b8068"), ("active", "#4d705b")])

    def px(self, value: float) -> int:
        """Design pixels (96 DPI) to screen pixels."""
        return int(round(value * self.scale))

    def line_height(self, font) -> int:
        return int(font.metrics("linespace"))


class FlatButton(tk.Label):
    """A flat button that keeps its colours on every platform (Aqua ignores tk.Button colours).

    It works from the keyboard like a real button: Tab reaches it whenever it can be pressed, a gold
    ring shows which one has focus, Return or Space presses it, and a button scrolled out of sight
    comes into view when it gets focus."""

    KINDS = {
        "primary": (GOLD, INK, "#ecd09a"),
        "secondary": (BUTTON, IVORY, BUTTON_HOVER),
        "quiet": (None, MUTED, HOVER),
        "danger": (BUTTON, CORAL, BUTTON_HOVER),
        "option": (INK, IVORY, BUTTON_HOVER),
        "chosen": (GOLD, INK, "#ecd09a"),
        "tag": (INK, MUTED, INK),  # Shown, not pressed: an option that can only be chosen in the agent's app.
    }

    def __init__(self, parent: tk.Misc, theme: Theme, text: str, command=None, kind: str = "secondary",
                 font=None, padx: int = 10, pady: int = 4, **options) -> None:
        self.theme = theme
        self.command = command
        self.kind = kind
        self.enabled = True
        background = parent.cget("bg")
        options.setdefault("highlightthickness", theme.px(2))
        super().__init__(parent, text=text, font=font or theme.small_strong, cursor="hand2",
                         padx=theme.px(padx), pady=theme.px(pady), bd=0, bg=background, takefocus=self._focusable,
                         highlightbackground=background, highlightcolor=GOLD, **options)
        self.set_kind(kind)
        self.bind("<Enter>", lambda _event: self._paint(True))
        self.bind("<Leave>", lambda _event: self._paint(False))
        self.bind("<ButtonRelease-1>", self._release)
        for key in ("<Return>", "<KP_Enter>", "<space>"):
            self.bind(key, self._key)
        self.bind("<FocusIn>", self._focused)

    def pressable(self) -> bool:
        """Whether a press does anything now: enabled, with a command, and on screen. A button left on a
        hidden card keeps the focus it had, but Space or Return on it does nothing."""
        try:
            return bool(self.enabled and self.command and self.winfo_exists() and self.winfo_viewable())
        except tk.TclError:
            return False

    def _focusable(self, _path: str = "") -> str:
        """Tab stops here only while pressing it would do something (a shown-only option tag never)."""
        return "1" if self.pressable() else "0"

    def _key(self, _event=None) -> str:
        if self.pressable():
            self.command()
        return "break"

    def _focused(self, _event=None) -> None:
        widget = self.master
        while widget is not None:
            if isinstance(widget, ScrollArea):
                widget.see(self)
                return
            widget = getattr(widget, "master", None)

    def set_kind(self, kind: str) -> None:
        self.kind = kind
        self._paint(False)

    def _colors(self) -> tuple[str, str, str]:
        fill, ink, hover = self.KINDS.get(self.kind, self.KINDS["secondary"])
        background = self.master.cget("bg")
        return fill or background, ink, hover

    def _paint(self, hovered: bool) -> None:
        # The focus ring is drawn only with focus; otherwise it blends into whatever is behind the button.
        self.configure(highlightbackground=self.master.cget("bg"))
        fill, ink, hover = self._colors()
        if not self.enabled:
            self.configure(bg=fill, fg=FAINT, cursor="")
            return
        self.configure(bg=hover if hovered else fill, fg=ink, cursor="hand2" if self.command else "")

    def _release(self, event) -> None:
        inside = 0 <= event.x < self.winfo_width() and 0 <= event.y < self.winfo_height()
        if inside and self.pressable():
            self.command()

    def set_enabled(self, enabled: bool) -> None:
        self.enabled = bool(enabled)
        self._paint(False)


def chip(parent: tk.Misc, theme: Theme, text: str = "", fg: str = MUTED, bg: str = INK, font=None) -> tk.Label:
    """A small label on a dark pill: counts, model, source, status."""
    return tk.Label(parent, text=text, fg=fg, bg=bg, font=font or theme.small_strong,
                    padx=theme.px(8), pady=theme.px(2), bd=0)


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


class WheelRouter:
    """One mouse-wheel handler for the whole app: the scrollable area under the pointer scrolls,
    wherever inside it the pointer is (a label, a button, a nested frame)."""

    def __init__(self, root: tk.Misc) -> None:
        self.root = root
        self.targets: dict[str, object] = {}
        root.bind_all("<MouseWheel>", self.on_wheel, add="+")

    def register(self, widget: tk.Misc, callback) -> None:
        self.targets[str(widget)] = callback

    def on_wheel(self, event) -> str | None:
        try:
            widget = self.root.winfo_containing(event.x_root, event.y_root)
        except (tk.TclError, KeyError):
            return None
        while widget is not None:
            callback = self.targets.get(str(widget))
            if callback is not None:
                delta = event.delta
                steps = -delta // 120 if abs(delta) >= 120 else (-1 if delta > 0 else 1)
                callback(int(steps) or (-1 if delta > 0 else 1))
                return "break"
            widget = getattr(widget, "master", None)
        return None


class ScrollArea(tk.Frame):
    """A vertically scrolling column of widgets with a thin dark scrollbar that hides when unneeded."""

    def __init__(self, parent: tk.Misc, theme: Theme, wheel: WheelRouter, bg: str = PANEL) -> None:
        super().__init__(parent, bg=bg, bd=0, highlightthickness=0)
        self.theme = theme
        self.canvas = tk.Canvas(self, bg=bg, bd=0, highlightthickness=0, yscrollincrement=theme.px(24))
        self.bar = ttk.Scrollbar(self, orient="vertical", style="Horde.Vertical.TScrollbar", command=self.canvas.yview)
        self.content = tk.Frame(self.canvas, bg=bg, bd=0)
        self.window = self.canvas.create_window(0, 0, anchor="nw", window=self.content)
        self.canvas.configure(yscrollcommand=self._on_scroll)
        self.canvas.grid(row=0, column=0, sticky="nsew")
        self.bar.grid(row=0, column=1, sticky="ns")
        self.grid_rowconfigure(0, weight=1)
        self.grid_columnconfigure(0, weight=1)
        self.width_listeners: list = []
        self.width = 0
        self.content.bind("<Configure>", self._on_content)
        self.canvas.bind("<Configure>", self._on_canvas)
        wheel.register(self, self.scroll)

    def _on_scroll(self, first, last) -> None:
        self.bar.set(first, last)
        needed = float(first) > 0.0 or float(last) < 1.0
        if needed and not self.bar.winfo_ismapped():
            self.bar.grid()
        elif not needed and self.bar.winfo_ismapped():
            self.bar.grid_remove()

    def _on_content(self, _event=None) -> None:
        self.canvas.configure(scrollregion=(0, 0, self.width, self.content.winfo_reqheight()))

    def _on_canvas(self, event) -> None:
        if event.width != self.width:
            self.width = event.width
            self.canvas.itemconfigure(self.window, width=event.width)
            for listener in list(self.width_listeners):
                listener(event.width)
        self._on_content()

    def scroll(self, steps: int) -> None:
        if self.content.winfo_reqheight() > self.canvas.winfo_height():
            self.canvas.yview_scroll(steps * 2, "units")

    def to_top(self) -> None:
        self.canvas.yview_moveto(0)

    def see(self, widget: tk.Misc) -> None:
        """Scroll just enough to show ``widget`` (a descendant of the content frame)."""
        self.update_idletasks()
        top = widget.winfo_rooty() - self.content.winfo_rooty()
        bottom = top + widget.winfo_height()
        view_top = self.canvas.canvasy(0)
        height = self.canvas.winfo_height()
        total = max(1, self.content.winfo_reqheight())
        if top < view_top:
            self.canvas.yview_moveto(top / total)
        elif bottom > view_top + height:
            self.canvas.yview_moveto(max(0, bottom - height) / total)


def copy_menu(widget: tk.Misc, get_text) -> None:
    """Right-click copies the text a label shows."""
    def show(event) -> None:
        text = get_text()
        if not text:
            return
        menu = tk.Menu(widget, tearoff=False)
        menu.add_command(label="Copy", command=lambda: (widget.clipboard_clear(), widget.clipboard_append(text)))
        menu.tk_popup(event.x_root, event.y_root)
    desktop_platform.bind_context(widget, show)
