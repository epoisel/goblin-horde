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
        self.count_chips["needs"].bind("<Button-1>", lambda _event: app.select_first("needs"))
        self.count_chips["done"].bind("<Button-1>", lambda _event: app.toggle_done(True))
        for name in ("needs", "done"):
            self.count_chips[name].configure(cursor="hand2")
        self.sources = tk.Frame(self.header, bg=HEADER)
        self.sources.pack(side="left", padx=(px(10), 0))
        self.source_labels: dict[str, tk.Label] = {}
        self.menu_button = FlatButton(self.header, theme, "⋯", app.show_menu, kind="quiet", font=theme.title,
                                      padx=10, pady=0)
        self.menu_button.configure(bg=HEADER)
        self.menu_button.pack(side="right", padx=(px(4), px(10)), fill="y", pady=px(8))
        self.search = tk.Entry(self.header, bg=ENTRY, fg=FAINT, insertbackground=GOLD, relief="flat", width=22,
                               font=theme.body, highlightthickness=1, highlightbackground=LINE, highlightcolor=GOLD)
        self.search.pack(side="right", pady=px(9), ipady=px(2))
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
        for name in ("needs", "working", "failed", "done", "feed"):
            label = self.count_chips[name]
            text = values[name]
            if label.cget("text") != text:
                label.configure(text=text)
            if text and not label.winfo_manager():
                label.pack(side="left", padx=(0, self.theme.px(6)))
            elif not text and label.winfo_manager():
                label.pack_forget()
        # Keep the chips in their order when one reappears.
        shown = [self.count_chips[name] for name in ("needs", "working", "failed", "done", "feed") if values[name]]
        if [widget for widget in self.counts.pack_slaves()] != shown:
            for widget in self.counts.pack_slaves():
                widget.pack_forget()
            for widget in shown:
                widget.pack(side="left", padx=(0, self.theme.px(6)))

    def update_sources(self, chips: list[SourceChip]) -> None:
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
                label.bind("<Button-1>", lambda _event, key=item.key: self.app.fix_source(key))
            text = f"{item.label} {item.glyph}"
            if label.cget("text") != text:
                label.configure(text=text)
            label.configure(fg=tone(item.tone), cursor="hand2" if item.action else "")

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
