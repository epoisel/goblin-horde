"""The Horde window: one native window with a header, the roster, and the detail pane.

The window is the Tk root, so it snaps, alt-tabs, and has its own taskbar button. Closing it (X)
collapses to the goblin strip; Quit is in the ⋯ menu. The header carries the counts, the feeds
the viewer reads (with their one-click fixes), "Find a chat…", and the ⋯ menu.
"""

from __future__ import annotations

import tkinter as tk

from horde_detail import DetailView
from horde_model import Counts, SourceChip
from horde_roster import RosterView
from horde_theme import (AMBER, CORAL, ENTRY, FAINT, GOLD, HEADER, INK, IVORY, LINE, LIVELY, MUTED, PANEL, FlatButton,
                         Theme, WheelRouter, chip, tone)

PLACEHOLDER = "Find a chat…"


def keyboard(label: tk.Label, action, when=lambda: True) -> None:
    """A clickable label that Tab also reaches (while `when()` holds), shown by a gold ring, and that
    Return or Space presses like a click."""
    background = label.master.cget("bg")
    label.configure(cursor="hand2", highlightthickness=1, highlightbackground=background, highlightcolor=GOLD,
                    takefocus=lambda _path="": "1" if when() and label.winfo_viewable() else "0")

    def press(_event=None) -> str:
        if when():
            action()
        return "break"
    label.bind("<Button-1>", press)
    for key in ("<Return>", "<KP_Enter>", "<space>"):
        label.bind(key, press)


class HordeWindow:
    """Builds and lays out the main window's widgets; the app owns what they show."""

    def __init__(self, app, root: tk.Tk, theme: Theme, wheel: WheelRouter) -> None:
        self.app = app
        self.root = root
        self.theme = theme
        px = theme.px
        root.configure(bg=PANEL)
        root.title("Goblin Horde")
        root.minsize(px(720), px(460))
        self.header = tk.Frame(root, bg=HEADER, height=px(48))
        self.header.pack(fill="x")
        self.header.pack_propagate(False)
        # Made in the order Tab visits them (search, then ⋯); the right side is packed first, so a narrow
        # window squeezes the feeds, never the search box.
        self.search = tk.Entry(self.header, bg=ENTRY, fg=FAINT, insertbackground=GOLD, relief="flat", width=22,
                               font=theme.body, highlightthickness=1, highlightbackground=LINE, highlightcolor=GOLD)
        self.menu_button = FlatButton(self.header, theme, "⋯", app.show_menu, kind="quiet", font=theme.title,
                                      padx=10, pady=0)
        self.menu_button.configure(bg=HEADER)
        self.menu_button.pack(side="right", padx=(px(4), px(10)), fill="y", pady=px(8))
        self.search.pack(side="right", pady=px(9), ipady=px(2))
        self.title = tk.Label(self.header, text="Goblin Horde", bg=HEADER, fg=IVORY, font=theme.title)
        self.title.pack(side="left", padx=(px(16), px(12)))
        self.counts = tk.Frame(self.header, bg=HEADER)
        self.counts.pack(side="left")
        self.count_chips = {
            "needs": chip(self.counts, theme, fg=INK, bg=AMBER),
            "working": chip(self.counts, theme, fg=LIVELY),
            "failed": chip(self.counts, theme, fg=CORAL),
            "done": chip(self.counts, theme, fg=MUTED),
            "feed": chip(self.counts, theme, fg=FAINT),
        }
        keyboard(self.count_chips["needs"], lambda: app.select_first("needs"))
        keyboard(self.count_chips["done"], lambda: app.toggle_done(True))
        self.sources = tk.Frame(self.header, bg=HEADER)
        self.sources.pack(side="left", padx=(px(10), 0))
        self.source_labels: dict[str, tk.Label] = {}
        self.chips: list[SourceChip] = []
        self.header.bind("<Configure>", lambda _event: self.fit_header())
        self.search.insert(0, PLACEHOLDER)
        self.search.bind("<FocusIn>", self.on_search_focus)
        self.search.bind("<FocusOut>", self.on_search_blur)
        self.search.bind("<KeyRelease>", self.on_search_key)
        self.search.bind("<Return>", lambda _event: app.search_catalog(self.query()))
        self.search.bind("<Escape>", lambda _event: self.clear_search())
        self.search.bind("<Down>", lambda _event: (app.move_selection(1), self.root.focus_set()))
        self.banner = tk.Frame(root, bg="#3b2a24", highlightthickness=0)
        self.banner_text = tk.Label(self.banner, text="", bg="#3b2a24", fg=IVORY, font=theme.body, anchor="w",
                                    justify="left")
        self.banner_text.pack(side="left", padx=(px(16), px(8)), pady=px(8), fill="x", expand=True)
        self.banner_restart = FlatButton(self.banner, theme, "Restart the viewer", app.restart_viewer, kind="primary")
        self.banner_retry = FlatButton(self.banner, theme, "Retry now", app.retry_now, kind="secondary")
        self.rule = tk.Frame(root, bg=LINE, height=1)
        self.rule.pack(fill="x")
        self.body = tk.Frame(root, bg=PANEL)
        self.body.pack(fill="both", expand=True)
        self.roster = RosterView(self.body, app, theme, wheel)
        self.roster.frame.pack(side="left", fill="y")
        tk.Frame(self.body, bg=LINE, width=1).pack(side="left", fill="y")
        self.detail = DetailView(self.body, app, theme, wheel)
        self.detail.frame.pack(side="left", fill="both", expand=True)
        root.bind("<Control-f>", lambda _event: self.focus_search())
        root.bind("<Up>", lambda event: self.arrow(event, -1))
        root.bind("<Down>", lambda event: self.arrow(event, 1))

    # Header -------------------------------------------------------------------------------------
    def update_counts(self, counts: Counts, feed_note: str = "") -> None:
        values = {
            "needs": f"{counts.needs} need{'s' if counts.needs == 1 else ''} you" if counts.needs else "",
            "working": f"{counts.working} working",
            "failed": f"{counts.failed} failed" if counts.failed else "",
            "done": f"{counts.done_today} done today" if counts.done_today else "",
            "feed": feed_note,
        }
        for name, text in values.items():
            if self.count_chips[name].cget("text") != text:
                self.count_chips[name].configure(text=text)
        # Only the chips with something to say, always in this order.
        shown = [self.count_chips[name] for name in ("needs", "working", "failed", "done", "feed") if values[name]]
        if [widget for widget in self.counts.pack_slaves()] != shown:
            for widget in self.counts.pack_slaves():
                widget.pack_forget()
            for widget in shown:
                widget.pack(side="left", padx=(0, self.theme.px(6)))
        self.fit_header()

    def fit_header(self) -> None:
        """Show the feed chips only when they fit beside the title, counts, and search."""
        px = self.theme.px
        needed = (self.title.winfo_reqwidth() + px(28) + self.counts.winfo_reqwidth() + self.sources.winfo_reqwidth()
                  + px(10) + self.search.winfo_reqwidth() + self.menu_button.winfo_reqwidth() + px(30))
        fits = self.header.winfo_width() >= needed
        if fits and not self.sources.winfo_manager():
            self.sources.pack(side="left", padx=(px(10), 0), after=self.counts)
        elif not fits and self.sources.winfo_manager():
            self.sources.pack_forget()

    def update_sources(self, chips: list[SourceChip]) -> None:
        self.chips = chips
        keys = [item.key for item in chips]
        for key in [key for key in self.source_labels if key not in keys]:
            self.source_labels.pop(key).destroy()
        for item in chips:
            label = self.source_labels.get(item.key)
            if label is None:
                label = self.source_labels[item.key] = tk.Label(self.sources, bg=HEADER, font=self.theme.small_strong,
                                                                padx=self.theme.px(4))
                label.pack(side="left")
                label.bind("<Enter>", lambda event, key=item.key: self.app.source_tip(key, event))
                label.bind("<Leave>", lambda _event: self.app.tooltip.hide())
                # A chip with a fix (reconnect Codex, connect Claude Code) is a button, keyboard included.
                keyboard(label, lambda key=item.key: self.app.fix_source(key),
                         when=lambda key=item.key: any(chip.key == key and chip.action for chip in self.chips))
            text = f"{item.label} {item.glyph}"
            if label.cget("text") != text:
                label.configure(text=text)
            label.configure(fg=tone(item.tone), cursor="hand2" if item.action else "")
        self.fit_header()

    # Search ------------------------------------------------------------------------------------
    def query(self) -> str:
        text = self.search.get()
        return "" if text == PLACEHOLDER and self.search.cget("fg") == FAINT else text.strip()

    def focus_search(self) -> str:
        self.search.focus_set()
        self.search.select_range(0, "end")
        return "break"

    def on_search_focus(self, _event=None) -> None:
        if self.search.cget("fg") == FAINT:
            self.search.delete(0, "end")
            self.search.configure(fg=IVORY)

    def on_search_blur(self, _event=None) -> None:
        if not self.search.get().strip():
            self.search.delete(0, "end")
            self.search.insert(0, PLACEHOLDER)
            self.search.configure(fg=FAINT)

    def on_search_key(self, event) -> None:
        if event.keysym in ("Return", "Escape", "Down", "Up"):
            return
        self.app.on_query(self.query())

    def clear_search(self) -> None:
        self.search.delete(0, "end")
        self.app.on_query("")
        self.app.clear_results()
        self.root.focus_set()
        self.on_search_blur()

    def arrow(self, event, step: int) -> str | None:
        if isinstance(event.widget, (tk.Entry, tk.Text)):
            return None
        self.app.move_selection(step)
        return "break"

    # The viewer is not answering ---------------------------------------------------------------
    def show_banner(self, text: str, restart: bool) -> None:
        if self.banner_text.cget("text") != text:
            self.banner_text.configure(text=text)
        wanted = [self.banner_retry] + ([self.banner_restart] if restart else [])
        if [widget for widget in (self.banner_restart, self.banner_retry) if widget.winfo_manager()] != \
                [widget for widget in (self.banner_restart, self.banner_retry) if widget in wanted]:
            for widget in (self.banner_restart, self.banner_retry):
                widget.pack_forget()
            for widget in reversed(wanted):
                widget.pack(side="right", padx=(0, self.theme.px(10)), pady=self.theme.px(8))
        if not self.banner.winfo_manager():
            self.banner.pack(fill="x", after=self.header)

    def hide_banner(self) -> None:
        if self.banner.winfo_manager():
            self.banner.pack_forget()
