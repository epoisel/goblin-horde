"""The detail pane: one goblin in full, from its own records.

A header with the goblin at 4x, its name, model, source, and status, and the controls the viewer
offers (Open, Message…, Dismiss); then sections that each appear only when they have something:
the ask (answerable here when the agent allows it), what it was asked to do, its plan, what it is
doing now with a live timer, what it last said, its trail of steps (click to see a command's
output, or to jump to a subagent), the files it changed, and an Orca agent's terminal screen.

Every section keeps its widgets between polls and only changes what changed: typed replies, the
scroll position, and expanded trail rows all survive the two-second refresh.
"""

from __future__ import annotations

import time
import tkinter as tk

from goblin_sprite import KINDS, SPAN_H, SPAN_W, TOP_ROOM, place_sprite, sprite_scale
from goblin_motion import stamp_ms
from horde_model import (APP_NAMES, SOURCE_NAMES, actor_class, actor_id, age_label, ago, ask_of, ask_text,
                         clock_label, detail_now, detail_sections, elapsed, family_ink, is_done_step, is_thinking,
                         model_badge, party_scope, plan_counts, plan_steps, progress_of, project_name, quiet_for,
                         screen_tail, source_of, status_chip, trail_result, display_name, waiting_of, waiting_steps)
from horde_theme import (AMBER, CARD, CORAL, ENTRY, FAINT, GOLD, HOVER, IVORY, LILAC, LINE, LIVELY, MONO_BG,
                         MUTED, PANEL, FlatButton, ScrollArea, Theme, WheelRouter, chip, copy_menu, fit_text, tone)

TRAIL_GLYPHS = {"command": "❯", "edit": "✎", "write": "✚", "read": "≡", "search": "⌕", "web": "◎",
                "agent": "◆", "tool": "⚙", "message": "❝", "ask": "?", "error": "✕"}
NOW_GLYPHS = {**TRAIL_GLYPHS, "think": "…"}
ASK_TITLES = {"permission": "Wants permission", "question": "Asks you", "approval": "Needs your approval",
              "reply": "Asks you"}
SAID_LIMIT = 700
WELCOME = (
    ("Each goblin is one AI agent at work.", "Its tribe tells you the model: hooded hexers run Claude models, "
     "sapper war-machinists run OpenAI models in Codex, and ragged raiders are everything else."),
    ("Needs you first.", "Amber rows are waiting on you, with their actual question. Answer here when the agent "
     "allows it, or open it in its own app."),
    ("Click any goblin", "to see what it was asked to do, its plan, the exact command it is running, what it said, "
     "and every step it took."),
)


class Card:
    """One section: a titled card that can be shown or hidden without being rebuilt."""

    def __init__(self, view: "DetailView", name: str, border: str = LINE) -> None:
        self.view = view
        self.name = name
        theme = view.theme
        self.frame = tk.Frame(view.area.content, bg=CARD, highlightthickness=theme.px(1) if border == LINE else theme.px(2),
                              highlightbackground=border, highlightcolor=border, bd=0)
        self.head = tk.Frame(self.frame, bg=CARD)
        self.head.pack(fill="x", padx=theme.px(14), pady=(theme.px(10), theme.px(4)))
        self.title = tk.Label(self.head, text="", bg=CARD, fg=MUTED, font=theme.small_strong, anchor="w")
        self.title.pack(side="left")
        self.aside = tk.Label(self.head, text="", bg=CARD, fg=FAINT, font=theme.small, anchor="e")
        self.aside.pack(side="right")
        self.body = tk.Frame(self.frame, bg=CARD)
        self.body.pack(fill="x", padx=theme.px(14), pady=(0, theme.px(12)))
        self.signature = None

    def set_title(self, text: str, aside: str = "") -> None:
        if self.title.cget("text") != text:
            self.title.configure(text=text)
        if self.aside.cget("text") != aside:
            self.aside.configure(text=aside)

    def label(self, parent=None, *, font=None, fg=IVORY, bg=CARD, margin: int = 0, mono: bool = False, **options) -> tk.Label:
        """A wrapping label whose width follows the pane."""
        theme = self.view.theme
        label = tk.Label(parent or self.body, text="", bg=MONO_BG if mono else bg, fg=fg,
                         font=font or (theme.mono if mono else theme.body), justify="left", anchor="w",
                         padx=theme.px(8) if mono else 0, pady=theme.px(6) if mono else 0, **options)
        # The card's side padding, border, and body padding, plus a mono box's own padding.
        self.view.wrapping(label, margin + theme.px(84) + (theme.px(18) if mono else 0))
        copy_menu(label, lambda: label.cget("text"))
        return label


def tab_out(box: tk.Text) -> None:
    """Tab and Shift+Tab leave a text box for the next or previous control, as everywhere else,
    instead of typing a tab character into the message."""
    def move(step: int) -> str:
        target = box.tk_focusNext() if step > 0 else box.tk_focusPrev()
        if target is not None:
            target.focus_set()
        return "break"
    box.bind("<Tab>", lambda _event: move(1))
    for sequence in ("<Shift-Tab>", "<ISO_Left_Tab>"):
        try:
            box.bind(sequence, lambda _event: move(-1))
        except tk.TclError:
            pass  # This platform's Tk has no such key.


def set_text(label: tk.Label, text: str, **options) -> None:
    if label.cget("text") != text:
        label.configure(text=text)
    if options:
        label.configure(**options)


class StatusLine(tk.Label):
    """A line of feedback under a card's buttons ("Sending…", why it failed) that takes no room when empty."""

    def __init__(self, parent: tk.Misc, theme: Theme) -> None:
        super().__init__(parent, text="", bg=CARD, fg=MUTED, font=theme.small, anchor="w", justify="left")
        self.theme = theme

    def say(self, text: str, fg: str = MUTED) -> None:
        set_text(self, text, fg=fg)
        if text and not self.winfo_manager():
            self.pack(fill="x", pady=(self.theme.px(8), 0))
        elif not text and self.winfo_manager():
            self.pack_forget()


class TrailRow:
    """One step on the trail; click it to see its command and output (or, for a subagent, to jump to it)."""

    def __init__(self, card: Card, item: dict) -> None:
        self.card = card
        view = card.view
        theme = view.theme
        self.item = item
        self.expanded = False
        self.frame = tk.Frame(card.body, bg=CARD)
        self.line = tk.Frame(self.frame, bg=CARD, cursor="hand2")
        self.line.pack(fill="x")
        self.time = tk.Label(self.line, text="", bg=CARD, fg=FAINT, font=theme.small, width=5, anchor="w")
        self.icon = tk.Label(self.line, text="", bg=CARD, fg=MUTED, font=theme.symbol, width=2)
        self.title = tk.Label(self.line, text="", bg=CARD, fg=IVORY, font=theme.mono, anchor="w")
        self.result = tk.Frame(self.line, bg=CARD)
        self.time.pack(side="left", padx=(0, theme.px(4)))
        self.icon.pack(side="left")
        self.result.pack(side="right", padx=(theme.px(8), 0))
        self.title.pack(side="left", fill="x", expand=True, padx=(theme.px(4), 0))
        self.result_labels: list[tk.Label] = []
        self.more = tk.Frame(self.frame, bg=CARD)
        self.detail = card.label(self.more, mono=True, margin=theme.px(56), fg=MUTED)
        self.output = card.label(self.more, mono=True, margin=theme.px(56))
        for widget in (self.line, self.time, self.icon, self.title, self.result):
            widget.bind("<Button-1>", self.on_click)
            widget.bind("<Enter>", lambda _event: self.hover(True))
            widget.bind("<Leave>", lambda _event: self.hover(False))
        self.full_title = ""
        self.update(item)

    def hover(self, on: bool) -> None:
        color = HOVER if on else CARD
        for widget in (self.line, self.time, self.icon, self.title, self.result, *self.result_labels):
            widget.configure(bg=color)

    def on_click(self, _event=None) -> None:
        target = str(self.item.get("agentId") or "")
        if target and self.card.view.app.has_agent(target):
            self.card.view.app.select(target)
            return
        if not self.has_more():
            return
        self.expanded = not self.expanded
        self.card.view.set_expanded(str(self.item.get("id")), self.expanded)
        self.show_more()

    def has_more(self) -> bool:
        detail = str(self.item.get("detail") or "").strip()
        return bool(str(self.item.get("output") or "").strip() or (detail and detail != self.item.get("title"))
                    or self.item.get("paths"))

    def show_more(self) -> None:
        if self.expanded and self.has_more():
            if not self.more.winfo_manager():
                self.more.pack(fill="x", padx=(self.card.view.theme.px(54), 0), pady=(self.card.view.theme.px(2),
                                                                                       self.card.view.theme.px(6)))
        elif self.more.winfo_manager():
            self.more.pack_forget()

    def waiting(self) -> bool:
        """Held by an open permission or question: it waits for the person, it is not running."""
        return str(self.item.get("id")) in self.card.view.waiting_ids

    def update(self, item: dict) -> None:
        self.item = item
        view = self.card.view
        kind = str(item.get("kind") or "tool")
        failed = item.get("status") == "failed"
        running = item.get("status") == "running"
        set_text(self.time, clock_label(item.get("at")))
        set_text(self.icon, TRAIL_GLYPHS.get(kind, "•"),
                 fg=CORAL if failed else AMBER if running and self.waiting() else LIVELY if running
                 else GOLD if kind == "agent" else MUTED)
        title = " ".join(str(item.get("title") or "").split())
        if item.get("agentId") and view.app.has_agent(str(item.get("agentId"))):
            title += "  →"
        self.full_title = title
        self.fit()
        parts = trail_result(item, waiting=self.waiting())
        while len(self.result_labels) < len(parts):
            label = tk.Label(self.result, text="", bg=self.line.cget("bg"), font=view.theme.small)
            label.pack(side="left", padx=(view.theme.px(4), 0))
            label.bind("<Button-1>", self.on_click)
            self.result_labels.append(label)
        for index, label in enumerate(self.result_labels):
            if index < len(parts):
                set_text(label, parts[index][0], fg=tone(parts[index][1]))
                if not label.winfo_manager():
                    label.pack(side="left", padx=(view.theme.px(4), 0))
            elif label.winfo_manager():
                label.pack_forget()
        detail = str(item.get("detail") or "").strip()
        paths = item.get("paths") if isinstance(item.get("paths"), list) else []
        if paths and not detail:
            detail = "\n".join(str(path) for path in paths)
        show_detail = bool(detail) and detail != item.get("title")
        set_text(self.detail, detail)
        if show_detail and not self.detail.winfo_manager():
            self.detail.pack(fill="x", pady=(0, view.theme.px(4)))
        elif not show_detail and self.detail.winfo_manager():
            self.detail.pack_forget()
        output = str(item.get("output") or "").rstrip()
        set_text(self.output, output, fg=CORAL if failed else IVORY)
        if output and not self.output.winfo_manager():
            self.output.pack(fill="x")
        elif not output and self.output.winfo_manager():
            self.output.pack_forget()
        cursor = "hand2" if self.has_more() or item.get("agentId") else ""
        for widget in (self.line, self.title):
            widget.configure(cursor=cursor)
        self.show_more()

    def fit(self) -> None:
        theme = self.card.view.theme
        width = self.card.view.width - theme.px(64) - theme.px(60) - sum(
            label.winfo_reqwidth() for label in self.result_labels if label.winfo_manager()) - theme.px(40)
        set_text(self.title, fit_text(theme.mono, self.full_title, max(theme.px(80), width)))


class DetailView:
    """The right side of the Horde window."""

    def __init__(self, parent: tk.Misc, app, theme: Theme, wheel: WheelRouter) -> None:
        self.app = app
        self.theme = theme
        px = theme.px
        self.frame = tk.Frame(parent, bg=PANEL, bd=0, highlightthickness=0)
        self.width = px(600)
        self.wrap_labels: list[tuple[tk.Label, int]] = []
        self.agent_id = ""
        self.actor: dict = {}
        self.detail: dict | None = None
        self.loading = False
        self.mode = ""  # agent, welcome, chat
        self.sprite_scale = sprite_scale(4, theme.scale)
        self.build_header()
        self.build_composer()
        self.area = ScrollArea(self.frame, theme, wheel)
        self.area.content.configure(pady=px(9))  # Room after the last card, so it never touches the edge.
        self.area.pack(fill="both", expand=True)
        self.area.width_listeners.append(self.on_width)
        self.cards: dict[str, Card] = {}
        self.order: list[str] = []
        self.build_cards()
        self.build_welcome()
        self.build_chat()

    # Layout helpers ----------------------------------------------------------------------------
    def wrapping(self, label: tk.Label, margin: int) -> None:
        self.wrap_labels.append((label, margin))
        label.configure(wraplength=max(self.theme.px(120), self.width - margin))

    def on_width(self, width: int) -> None:
        self.width = width
        floor = self.theme.px(120)
        for label, margin in self.wrap_labels:
            try:
                label.configure(wraplength=max(floor, width - margin))
            except tk.TclError:
                pass
        for row in self.trail_rows.values():
            row.fit()
        self.fit_files()

    # Header ------------------------------------------------------------------------------------
    def build_header(self) -> None:
        theme, px = self.theme, self.theme.px
        self.header = tk.Frame(self.frame, bg=PANEL)
        self.header.pack(fill="x", padx=px(18), pady=(px(14), px(6)))
        scale = self.sprite_scale
        self.sprite = tk.Canvas(self.header, width=SPAN_W * scale, height=SPAN_H * scale, bg=PANEL,
                                highlightthickness=0, bd=0)
        self.sprite.pack(side="left", anchor="n")
        self.sprite_item = place_sprite(self.sprite, 0, TOP_ROOM * scale, scale, "hero")
        self.sprite_painted = None
        column = tk.Frame(self.header, bg=PANEL)
        column.pack(side="left", fill="x", expand=True, padx=(px(12), 0))
        self.header_column = column
        self.name = tk.Label(column, text="", bg=PANEL, fg=IVORY, font=theme.name, anchor="w", justify="left")
        self.name.pack(fill="x")
        copy_menu(self.name, lambda: self.name.cget("text"))
        self.subtitle = tk.Label(column, text="", bg=PANEL, fg=FAINT, font=theme.small, anchor="w", justify="left")
        self.subtitle.pack(fill="x", pady=(px(1), px(6)))
        self.chips = tk.Frame(column, bg=PANEL)
        self.chips.pack(fill="x")
        self.model_chip = chip(self.chips, theme)
        self.source_chip = chip(self.chips, theme, fg=MUTED)
        self.status_chip = chip(self.chips, theme)
        self.progress_chip = chip(self.chips, theme, fg=MUTED)  # Steps done, when no plan is shown.
        for item in (self.model_chip, self.source_chip, self.status_chip):
            item.pack(side="left", padx=(0, px(6)))
        self.subtitle_full = ""
        column.bind("<Configure>", lambda _event: (self.fit_subtitle(), self.fit_chips()))
        self.buttons = tk.Frame(column, bg=PANEL)
        self.buttons.pack(fill="x", pady=(px(10), 0))
        self.open_button = FlatButton(self.buttons, theme, "Open ↗", self.on_open, kind="secondary")
        self.message_button = FlatButton(self.buttons, theme, "Message…", self.toggle_composer, kind="secondary")
        self.viewer_button = FlatButton(self.buttons, theme, "Open in browser ↗", self.on_viewer, kind="quiet")
        self.notice = tk.Label(self.buttons, text="", bg=PANEL, fg=MUTED, font=theme.small, anchor="w")
        self.notice_after = None
        self.header_buttons = [self.open_button, self.message_button, self.viewer_button]
        self.rule = tk.Frame(self.frame, bg=LINE, height=1)
        self.rule.pack(fill="x", padx=px(18), pady=(px(8), 0))
        self.header.bind("<Configure>", lambda event: self.name.configure(
            wraplength=max(px(160), event.width - SPAN_W * scale - px(20))))

    def fit_subtitle(self) -> None:
        width = self.header_column.winfo_width()
        if width > 1:
            set_text(self.subtitle, fit_text(self.theme.small, self.subtitle_full, width - self.theme.px(8)))

    def fit_chips(self) -> None:
        """The chips that fit on one line: status always, then model, steps, and source while room lasts."""
        chips = [self.model_chip, self.source_chip, self.status_chip, self.progress_chip]
        wanted = {item for item in chips if item.cget("text")}
        room = self.header_column.winfo_width()
        gap = self.theme.px(6)
        if room > 1:
            for dropped in (self.source_chip, self.progress_chip, self.model_chip):
                if sum(item.winfo_reqwidth() + gap for item in wanted) <= room:
                    break
                wanted.discard(dropped)
        shown = [item for item in chips if item in wanted]
        if [item for item in self.chips.pack_slaves()] != shown:
            for item in chips:
                item.pack_forget()
            for item in shown:
                item.pack(side="left", padx=(0, gap))

    def show_buttons(self, wanted: list[FlatButton]) -> None:
        current = [button for button in self.header_buttons if button.winfo_manager()]
        if current == wanted:
            return
        for button in self.header_buttons:
            button.pack_forget()
        self.notice.pack_forget()
        for button in wanted:
            button.pack(side="left", padx=(0, self.theme.px(6)))
        self.notice.pack(side="left", padx=(self.theme.px(6), 0))

    def say(self, text: str, error: bool = False, seconds: float = 6.0) -> None:
        """A short note beside the header buttons ('Sent.', or why something did not work)."""
        set_text(self.notice, text, fg=CORAL if error else LIVELY)
        if self.notice_after:
            self.frame.after_cancel(self.notice_after)
        self.notice_after = self.frame.after(int(seconds * 1000), lambda: set_text(self.notice, ""))

    def paint_sprite(self, force: bool = False) -> None:
        if self.mode != "agent" or not self.actor:
            return
        klass = actor_class(self.actor)
        style, action, frame, still = self.app.sprite_state(self.actor, klass, "detail")
        image = self.app.sprite_images.image(style, action, frame, self.sprite_scale, still)
        if image is self.sprite_painted and not force:
            return
        self.sprite_painted = image
        self.sprite.itemconfigure(self.sprite_item, image=image)

    def update_header(self, now_ms: float) -> None:
        actor, detail = self.actor, self.detail or {}
        agent = detail.get("agent") if isinstance(detail.get("agent"), dict) else {}
        set_text(self.name, display_name(actor, self.app.aliases))
        party = agent.get("party") if isinstance(agent.get("party"), dict) else {}
        party_label = str(party.get("name") or self.app.party_label(party_scope(actor)) or "")
        project = str(agent.get("project") or project_name(actor) or "")
        own_name = display_name(actor)
        bits = [bit for bit in dict.fromkeys((project, party_label)) if bit and bit != own_name]
        branch = str(agent.get("branch") or "")
        if branch:
            bits.append(f"branch {branch}")
        self.subtitle_full = " · ".join(bits) or SOURCE_NAMES.get(source_of(actor), "")
        self.fit_subtitle()
        progress = progress_of(actor)
        steps = f"{progress['done']} of {progress['total']} steps" if progress and "plan" not in \
            detail_sections(detail, actor) else ""
        set_text(self.progress_chip, steps)
        badge = model_badge(actor, with_effort=True)
        set_text(self.model_chip, badge, fg=family_ink(actor))
        set_text(self.source_chip, SOURCE_NAMES.get(source_of(actor), "Agent"))
        status, status_tone = status_chip(actor, now_ms)
        set_text(self.status_chip, status, fg=tone(status_tone))
        self.fit_chips()
        controls = agent.get("controls") if isinstance(agent.get("controls"), dict) else {}
        wanted = []
        opener = controls.get("open") if isinstance(controls.get("open"), dict) else None
        if opener and self.app.can("/api/open"):
            set_text(self.open_button, f"{opener.get('label') or 'Open'} ↗")
            wanted.append(self.open_button)
        messenger = controls.get("message") if isinstance(controls.get("message"), dict) else None
        if messenger and self.app.can("/api/message", "/api/reply"):
            label = str(messenger.get("label") or "Message").rstrip(".… ")
            set_text(self.message_button, f"{label}…")  # It opens a box to write in first.
            wanted.append(self.message_button)
        # Dismiss sits on the ask card itself, beside the ways to answer it.
        if not opener or not self.app.can("/api/open"):
            wanted.append(self.viewer_button)
        self.show_buttons(wanted)
        if not messenger and self.composer.winfo_manager():
            self.composer.pack_forget()

    # Message composer --------------------------------------------------------------------------
    def build_composer(self) -> None:
        theme, px = self.theme, self.theme.px
        self.composer = tk.Frame(self.frame, bg=CARD, highlightthickness=px(1), highlightbackground=LINE)
        self.composer_hint = tk.Label(self.composer, text="", bg=CARD, fg=MUTED, font=theme.small, anchor="w")
        self.composer_hint.pack(fill="x", padx=px(12), pady=(px(10), px(4)))
        self.composer_text = tk.Text(self.composer, height=3, wrap="word", bg=ENTRY, fg=IVORY, insertbackground=GOLD,
                                     relief="flat", font=theme.body, padx=px(8), pady=px(6), highlightthickness=1,
                                     highlightbackground=LINE, highlightcolor=GOLD, undo=True)
        self.composer_text.pack(fill="x", padx=px(12))
        tab_out(self.composer_text)
        self.composer_text.bind("<Control-Return>", lambda _event: (self.send_composer(), "break")[1])
        self.composer_text.bind("<Escape>", lambda _event: self.toggle_composer(False))
        actions = tk.Frame(self.composer, bg=CARD)
        actions.pack(fill="x", padx=px(12), pady=(px(8), px(10)))
        self.composer_send = FlatButton(actions, theme, "Send", self.send_composer, kind="primary")
        self.composer_send.pack(side="left")
        FlatButton(actions, theme, "Cancel", lambda: self.toggle_composer(False), kind="quiet").pack(side="left",
                                                                                                    padx=(px(6), 0))
        self.composer_status = tk.Label(actions, text="Ctrl+Enter sends", bg=CARD, fg=FAINT, font=theme.small)
        self.composer_status.pack(side="left", padx=(px(10), 0))

    def toggle_composer(self, show: bool | None = None) -> None:
        show = not self.composer.winfo_manager() if show is None else show
        if show:
            agent = (self.detail or {}).get("agent") or {}
            messenger = (agent.get("controls") or {}).get("message") or {}
            hint = str(messenger.get("hint") or "")
            set_text(self.composer_hint, f"Message {display_name(self.actor)}" + (f" · {hint}" if hint else ""))
            set_text(self.composer_status, "Ctrl+Enter sends", fg=FAINT)
            self.composer.pack(fill="x", padx=self.theme.px(18), pady=(self.theme.px(6), 0), after=self.header)
            self.composer_text.focus_set()
        elif self.composer.winfo_manager():
            self.composer.pack_forget()

    def send_composer(self) -> None:
        text = self.composer_text.get("1.0", "end").strip()
        if not text:
            return
        self.composer_send.set_enabled(False)
        set_text(self.composer_status, "Sending…", fg=MUTED)

        def done(_result, error) -> None:
            self.composer_send.set_enabled(True)
            if error:
                set_text(self.composer_status, str(error), fg=CORAL)
                return
            self.composer_text.delete("1.0", "end")
            self.toggle_composer(False)
            self.say("Sent.")
        self.app.send_message(self.actor, text, done)

    # Buttons -----------------------------------------------------------------------------------
    def on_open(self) -> None:
        self.app.open_agent(self.actor, self)

    def on_dismiss(self) -> None:
        self.app.dismiss_ask(self.actor)

    def on_viewer(self) -> None:
        self.app.open_viewer(party_scope(self.actor) if self.actor else "")

    # Cards -------------------------------------------------------------------------------------
    def build_cards(self) -> None:
        theme, px = self.theme, self.theme.px
        self.cards["ask"] = Card(self, "ask", border=AMBER)
        self.ask_key = None
        self.ask_widgets: dict = {}
        waiting = self.cards["waiting"] = Card(self, "waiting", border=LILAC)
        waiting.title.configure(fg=LILAC)
        self.waiting_text = waiting.label()
        self.waiting_text.pack(fill="x")
        self.waiting_note = waiting.label(fg=FAINT, font=theme.small)
        self.waiting_note.pack(fill="x", pady=(px(6), 0))
        mission = self.cards["mission"] = Card(self, "mission")
        self.mission_text = mission.label()
        self.mission_text.pack(fill="x")
        plan = self.cards["plan"] = Card(self, "plan")
        self.plan_rows: list[tuple[tk.Frame, tk.Label, tk.Label]] = []
        now = self.cards["now"] = Card(self, "now")
        row = tk.Frame(now.body, bg=CARD)
        row.pack(fill="x")
        self.now_icon = tk.Label(row, text="", bg=CARD, fg=LIVELY, font=theme.symbol)
        self.now_icon.pack(side="left")
        self.now_title = tk.Label(row, text="", bg=CARD, fg=IVORY, font=theme.strong, anchor="w", justify="left")
        self.now_title.pack(side="left", fill="x", expand=True, padx=(px(6), 0))
        self.wrapping(self.now_title, px(120))
        self.now_detail = now.label(mono=True)
        self.now_started = 0.0
        self.now_waiting = False
        self.now_mode = "running"  # running, waiting, done (the last step), or think
        self.now_heading = "Now"
        said = self.cards["said"] = Card(self, "said")
        self.said_text = said.label()
        self.said_text.pack(fill="x")
        self.said_full = ""
        self.said_open = False
        self.said_more = FlatButton(said.body, theme, "Show all", self.toggle_said, kind="quiet", padx=0)
        self.cards["trail"] = Card(self, "trail")
        self.waiting_ids: set[str] = set()  # Trail steps an open ask holds: they wait, they do not run.
        self.trail_rows: dict[str, TrailRow] = {}
        self.trail_order: list[str] = []
        self.expanded_for: dict[str, set] = {}
        self.cards["files"] = Card(self, "files")
        self.file_rows: list[tuple[tk.Frame, tk.Label, tk.Label, tk.Label, str]] = []
        screen = self.cards["screen"] = Card(self, "screen")
        self.screen_open = True
        self.screen_toggle = FlatButton(screen.head, theme, "Hide", self.toggle_screen, kind="quiet", padx=4, pady=0)
        self.screen_toggle.pack(side="right")
        self.screen_text = screen.label(mono=True)
        self.screen_text.pack(fill="x")
        for card in self.cards.values():
            card.frame.bind("<Button-1>", lambda _event: self.frame.focus_set())

    def show_cards(self, names: list[str]) -> None:
        if names == self.order:
            return
        for card in self.cards.values():
            card.frame.pack_forget()
        for frame in (self.welcome, self.chat):
            frame.pack_forget()
        px = self.theme.px
        for name in names:
            self.cards[name].frame.pack(fill="x", padx=px(18), pady=(px(12), 0))
        self.order = list(names)

    def focus_inside(self) -> bool:
        """Whether the keyboard focus (or the focus this window gets back when it is next active) is on
        something in the detail pane."""
        for getter in (self.frame.focus_get, self.frame.focus_lastfor):
            try:
                widget = getter()
            except (tk.TclError, KeyError):  # A menu that is open has no Python widget of its own.
                continue
            while widget is not None:
                if widget is self.frame:
                    return True
                widget = getattr(widget, "master", None)
        return False

    def leave_focus(self) -> None:
        """Another goblin is shown: a key meant for the one before must not land on this one's controls."""
        if self.focus_inside():
            self.app.focus_roster()

    def clear_ask(self) -> None:
        """The ask card's controls are destroyed, never just hidden, once its goblin or its ask is gone, so
        no key press or late callback can answer an ask that is no longer on screen."""
        for child in self.cards["ask"].body.winfo_children():
            child.destroy()
        self.wrap_labels = [(label, margin) for label, margin in self.wrap_labels if label.winfo_exists()]
        self.ask_key = None
        self.ask_widgets = {}

    def update_ask(self, actor: dict) -> None:
        ask = ask_of(actor) or {}
        card = self.cards["ask"]
        theme, px = self.theme, self.theme.px
        kind = str(ask.get("kind") or "question")
        since = stamp_ms(ask.get("at"))
        card.set_title(ASK_TITLES.get(kind, "Asks you"), f"{age_label(since)}" if since else "")
        card.title.configure(fg=AMBER)
        agent = (self.detail or {}).get("agent") or {}
        controls = agent.get("controls") if isinstance(agent.get("controls"), dict) else {}
        # Rebuilt only when the ask itself or how it can be answered changes, so a reply being typed survives polls.
        key = (actor_id(actor), ask.get("key"), ask.get("text"), ask.get("command"), bool(controls.get("open")),
               bool(controls.get("dismiss", True)), bool(self.app.request_for(ask)))
        if key == self.ask_key:
            return
        self.clear_ask()
        self.ask_key = key
        widgets = self.ask_widgets = {}
        app = self.app

        def live(action):
            """An answer goes out only while this very ask, of the goblin on screen, is shown."""
            def run(*args):
                if self.ask_key is key and self.mode == "agent" and "ask" in self.order \
                        and actor_id(self.actor) == key[0] and (ask_of(self.actor) or {}).get("key") == key[1]:
                    return action(*args)
                return None
            return run
        answer_here = ask.get("answerHere")
        request = app.request_for(ask) if answer_here == "respond" else None
        questions = [item for item in ask.get("questions") or [] if isinstance(item, dict)]
        if request and request.get("method") == "item/tool/requestUserInput":
            questions = [{"id": item.get("id"), "text": item.get("question") or item.get("header") or "",
                          "options": [option.get("label") for option in item.get("options") or [] if isinstance(option, dict)]}
                         for item in (request.get("params") or {}).get("questions") or [] if isinstance(item, dict)]
        # The ask's own words are shown once: not again as the first of its questions.
        repeated = bool(questions) and str(questions[0].get("text") or "").strip() == ask_text(ask)
        if not repeated:
            text = card.label(font=theme.body)
            text.configure(text=ask_text(ask))
            text.pack(fill="x")
        command = str(ask.get("command") or "").strip()
        if command:
            box = card.label(mono=True)
            box.configure(text=command)
            box.pack(fill="x", pady=(px(8), 0))
        source = source_of(actor)
        app_name = APP_NAMES.get(source, "its app")
        status = StatusLine(card.body, theme)
        widgets["status"] = status
        choices: dict[int, tk.StringVar] = {}
        for index, question in enumerate(questions):
            block = tk.Frame(card.body, bg=CARD)
            block.pack(fill="x", pady=(px(10) if index or not repeated else 0, 0))
            if str(question.get("text") or "").strip():
                label = card.label(block, font=theme.strong)
                label.configure(text=str(question["text"]))
                label.pack(fill="x", pady=(0, px(6)))
            options = [str(option) for option in question.get("options") or [] if str(option).strip()]
            choice = choices[index] = tk.StringVar(card.body, "")
            row = tk.Frame(block, bg=CARD)
            row.pack(fill="x")
            buttons: list[FlatButton] = []
            answerable = answer_here == "respond"
            for option in options[:6]:
                def pick(value=option, group=buttons, var=choice) -> None:
                    var.set(value)
                    for item in group:
                        item.set_kind("chosen" if item.cget("text") == value else "option")
                button = FlatButton(row, theme, option, pick if answerable else None,
                                    kind="option" if answerable else "tag", font=theme.small)
                button.pack(side="left", padx=(0, px(6)), pady=(0, px(4)))
                buttons.append(button)
            if answerable and not options:
                entry = tk.Entry(block, textvariable=choice, bg=ENTRY, fg=IVORY, insertbackground=GOLD, relief="flat",
                                 font=theme.body, highlightthickness=1, highlightbackground=LINE, highlightcolor=GOLD)
                entry.pack(fill="x", ipady=px(3))
        actions = tk.Frame(card.body, bg=CARD)
        actions.pack(fill="x", pady=(px(12), 0))
        thread = actor_id(actor)

        def finish(_result, error) -> None:
            if not actions.winfo_exists():
                return  # Answered: the ask is gone and its card with it.
            for button in actions.winfo_children():
                if isinstance(button, FlatButton):
                    button.set_enabled(True)
            if error:
                status.say(str(error), fg=CORAL)
                # One way to open it however often the answer is refused, not another button each time.
                if getattr(error, "status", 0) == 409 and app.can("/api/open") and not widgets.get("open"):
                    widgets["open"] = FlatButton(actions, theme, f"Open in {app_name} ↗", self.on_open, kind="secondary")
                    widgets["open"].pack(side="left", padx=(px(6), 0))
            else:
                status.say("Sent. The goblin will pick it up on its next step.", fg=LIVELY)

        def busy() -> None:
            for button in actions.winfo_children():
                if isinstance(button, FlatButton):
                    button.set_enabled(False)
            status.say("Sending…", fg=MUTED)

        if answer_here == "respond" and app.can("/api/respond"):
            request_id = str(ask.get("requestId") or "")
            if questions:
                def send_answers() -> None:
                    answers = {}
                    for index, question in enumerate(questions):
                        value = choices[index].get().strip()
                        if not value:
                            status.say("Answer every question first.", fg=CORAL)
                            return
                        answers[str(question.get("id") or index)] = value
                    busy()
                    app.respond(actor, request_id, answers=answers, done=finish)
                FlatButton(actions, theme, "Send answer", live(send_answers), kind="primary").pack(side="left")
            else:
                def decide(decision: str) -> None:
                    busy()
                    app.respond(actor, request_id, decision=decision, done=finish)
                options = [str(option) for option in ask.get("options") or []] or ["Approve once", "Decline"]
                approve = next((option for option in options if not option.lower().startswith(("decline", "deny", "no"))),
                               "Approve once")
                decline = next((option for option in options if option.lower().startswith(("decline", "deny", "no"))),
                               "Decline")
                FlatButton(actions, theme, approve, live(lambda: decide("accept")), kind="primary").pack(side="left")
                FlatButton(actions, theme, decline, live(lambda: decide("decline")), kind="secondary").pack(
                    side="left", padx=(px(6), 0))
        elif answer_here in ("reply", "orca-send") and app.can("/api/message", "/api/reply"):
            box = tk.Text(card.body, height=3, wrap="word", bg=ENTRY, fg=IVORY, insertbackground=GOLD, relief="flat",
                          font=theme.body, padx=px(8), pady=px(6), highlightthickness=1, highlightbackground=LINE,
                          highlightcolor=GOLD, undo=True)
            box.pack(fill="x", pady=(px(10), 0), before=actions)
            box.lower(actions)  # Tab reaches the box before the buttons that send it.
            tab_out(box)
            widgets["reply"] = box

            def reply() -> None:
                words = box.get("1.0", "end").strip()
                if not words:
                    status.say("Write a reply first.", fg=CORAL)
                    return
                busy()

                def sent(result, error) -> None:
                    finish(result, error)
                    if not error and box.winfo_exists():
                        box.delete("1.0", "end")
                app.send_message(actor, words, sent)
            send = live(reply)
            box.bind("<Control-Return>", lambda _event: (send() if box.winfo_viewable() else None, "break")[1])
            label = "Reply" if answer_here == "reply" else "Type into its terminal"
            FlatButton(actions, theme, label, send, kind="primary").pack(side="left")
        else:
            agent = (self.detail or {}).get("agent") or {}
            opener = ((agent.get("controls") or {}).get("open")) if isinstance(agent.get("controls"), dict) else None
            if opener and app.can("/api/open"):
                FlatButton(actions, theme, f"Answer in {app_name} ↗", self.on_open, kind="primary").pack(side="left")
            else:
                tk.Label(actions, text=f"Answer it in {app_name}.", bg=CARD, fg=MUTED, font=theme.body).pack(side="left")
        if not ask.get("legacy") and app.can("/api/dismiss") and (
                ((self.detail or {}).get("agent") or {}).get("controls", {}) or {}).get("dismiss", True):
            FlatButton(actions, theme, "Dismiss", live(self.on_dismiss), kind="quiet").pack(side="right")

    def update_plan(self, plan: dict) -> None:
        steps = plan_steps(plan)
        done, total = plan_counts(plan)
        card = self.cards["plan"]
        card.set_title(f"Plan · {done} of {total}", age_label(stamp_ms(plan.get("at"))) if plan.get("at") else "")
        theme, px = self.theme, self.theme.px
        while len(self.plan_rows) < len(steps):
            row = tk.Frame(card.body, bg=CARD)
            # A fixed-width gutter, so steps line up whatever glyph (and font) marks them.
            gutter = tk.Frame(row, bg=CARD, width=px(24), height=theme.line_height(theme.body))
            gutter.pack_propagate(False)
            gutter.pack(side="left", anchor="n")
            glyph = tk.Label(gutter, text="", bg=CARD, font=theme.symbol, anchor="w")
            glyph.pack(side="left", fill="y")
            text = card.label(row, margin=px(30))
            text.pack(side="left", fill="x", expand=True)
            self.plan_rows.append((row, glyph, text))
        for index, (row, glyph, text) in enumerate(self.plan_rows):
            if index >= len(steps):
                if row.winfo_manager():
                    row.pack_forget()
                continue
            status = steps[index].get("status")
            mark, ink, words = ("✓", LIVELY, FAINT) if status == "done" else ("▶", GOLD, IVORY) if status == "active" \
                else ("○", FAINT, MUTED)
            # The triangle runs large in the symbol font; at the small size it matches ✓ and ○.
            set_text(glyph, mark, fg=ink, font=theme.small if status == "active" else theme.symbol)
            set_text(text, " ".join(str(steps[index].get("text")).split()), fg=words,
                     font=theme.strong if status == "active" else theme.body)
            if not row.winfo_manager():
                row.pack(fill="x", pady=(0, px(3)))

    def now_aside(self, now_ms: float) -> str:
        """The Now card's live time: how long a step has run or waited, how long ago the last step
        finished, or how long it has been thinking since its last visible step."""
        if not self.now_started:
            return ""
        if self.now_mode == "done":
            return ago(self.now_started, now_ms)
        if self.now_mode == "think":
            return f"{quiet_for(now_ms - self.now_started)} since the last step"
        return f"{'waiting' if self.now_mode == 'waiting' else 'running'} {elapsed(now_ms - self.now_started)}"

    def update_now(self, now: dict, now_ms: float) -> None:
        """What it is doing, with a live timer; a step waiting for the person's OK says so, in amber. With
        nothing running, the step that just finished shows as the "Last step", with how long ago."""
        card = self.cards["now"]
        kind = str(now.get("kind") or "tool")
        self.now_waiting = bool(now.get("waiting"))
        self.now_mode = "waiting" if self.now_waiting else "done" if is_done_step(now) else "think" if is_thinking(now) else "running"
        ink = AMBER if self.now_waiting else MUTED if self.now_mode == "done" else LIVELY
        set_text(self.now_icon, NOW_GLYPHS.get(kind, "▶"), fg=ink)
        set_text(self.now_title, " ".join(str(now.get("title") or "").split()))
        self.now_started = stamp_ms(now.get("startedAt")) or 0.0
        self.now_heading = "Last step" if self.now_mode == "done" else "Now"
        card.set_title(self.now_heading, self.now_aside(now_ms))
        card.aside.configure(fg=AMBER if self.now_waiting else FAINT if self.now_mode == "done" else LIVELY)
        detail = str(now.get("detail") or "").strip()
        set_text(self.now_detail, detail)
        if detail and not self.now_detail.winfo_manager():
            self.now_detail.pack(fill="x", pady=(self.theme.px(8), 0))
        elif not detail and self.now_detail.winfo_manager():
            self.now_detail.pack_forget()

    def toggle_said(self) -> None:
        self.said_open = not self.said_open
        self.show_said()

    def show_said(self) -> None:
        text = self.said_full
        long = len(text) > SAID_LIMIT
        shown = text if self.said_open or not long else text[:SAID_LIMIT].rsplit(" ", 1)[0] + " …"
        set_text(self.said_text, shown)
        set_text(self.said_more, "Show less" if self.said_open else "Show all")
        if long and not self.said_more.winfo_manager():
            self.said_more.pack(anchor="w", pady=(self.theme.px(6), 0))
        elif not long and self.said_more.winfo_manager():
            self.said_more.pack_forget()

    def set_expanded(self, trail_id: str, expanded: bool) -> None:
        opened = self.expanded_for.setdefault(self.agent_id, set())
        (opened.add if expanded else opened.discard)(trail_id)
        if len(self.expanded_for) > 50:
            self.expanded_for.pop(next(iter(self.expanded_for)))

    def update_trail(self, items: list[dict]) -> None:
        items = [item for item in items if isinstance(item, dict)][:60]
        card = self.cards["trail"]
        failed = sum(item.get("status") == "failed" for item in items)
        card.set_title(f"Trail · {len(items)} {'step' if len(items) == 1 else 'steps'}",
                       f"{failed} failed" if failed else "newest first")
        card.aside.configure(fg=CORAL if failed else FAINT)
        opened = self.expanded_for.get(self.agent_id, set())
        ids = []
        for index, item in enumerate(items):
            ident = str(item.get("id") or f"row-{index}")
            ids.append(ident)
            row = self.trail_rows.get(ident)
            if row is None:
                row = self.trail_rows[ident] = TrailRow(card, item)
            else:
                row.update(item)
            row.expanded = ident in opened
            row.show_more()
        for ident in [ident for ident in self.trail_rows if ident not in ids]:
            self.trail_rows.pop(ident).frame.destroy()
        self.wrap_labels = [(label, margin) for label, margin in self.wrap_labels if label.winfo_exists()]
        if ids != self.trail_order:
            for ident in ids:
                self.trail_rows[ident].frame.pack_forget()
            for ident in ids:
                self.trail_rows[ident].frame.pack(fill="x", pady=(0, self.theme.px(2)))
            self.trail_order = ids

    def update_files(self, files: list[dict]) -> None:
        files = [item for item in files if isinstance(item, dict) and item.get("path")][:40]
        card = self.cards["files"]
        added = sum(int(item.get("added") or 0) for item in files)
        removed = sum(int(item.get("removed") or 0) for item in files)
        card.set_title(f"Files changed · {len(files)}", f"+{added} −{removed}")
        theme, px = self.theme, self.theme.px
        while len(self.file_rows) < len(files):
            row = tk.Frame(card.body, bg=CARD)
            path = tk.Label(row, text="", bg=CARD, fg=IVORY, font=theme.mono, anchor="w")
            plus = tk.Label(row, text="", bg=CARD, fg=LIVELY, font=theme.small)
            minus = tk.Label(row, text="", bg=CARD, fg=CORAL, font=theme.small)
            minus.pack(side="right")
            plus.pack(side="right", padx=(px(8), px(6)))
            path.pack(side="left", fill="x", expand=True)
            self.file_rows.append((row, path, plus, minus, ""))
        for index, (row, path, plus, minus, _full) in enumerate(self.file_rows):
            if index >= len(files):
                if row.winfo_manager():
                    row.pack_forget()
                continue
            item = files[index]
            self.file_rows[index] = (row, path, plus, minus, str(item["path"]))
            set_text(plus, f"+{int(item.get('added') or 0)}")
            set_text(minus, f"−{int(item.get('removed') or 0)}")
            if not row.winfo_manager():
                row.pack(fill="x", pady=(0, px(2)))
        self.fit_files()

    def fit_files(self) -> None:
        theme = self.theme
        for row, path, plus, minus, full in self.file_rows:
            if full:
                room = self.width - theme.px(60) - theme.px(120)
                set_text(path, fit_text(theme.mono, full, max(theme.px(80), room)))

    def toggle_screen(self) -> None:
        self.screen_open = not self.screen_open
        self.update_screen((self.detail or {}).get("screen") or {})

    def update_screen(self, screen: dict) -> None:
        lines = screen_tail(screen)
        card = self.cards["screen"]
        card.set_title("Terminal screen", age_label(stamp_ms(screen.get("at"))) if screen.get("at") else "")
        set_text(self.screen_toggle, "Hide" if self.screen_open else "Show")
        set_text(self.screen_text, "\n".join(lines))
        if self.screen_open and not self.screen_text.winfo_manager():
            self.screen_text.pack(fill="x")
        elif not self.screen_open and self.screen_text.winfo_manager():
            self.screen_text.pack_forget()

    # Showing an agent --------------------------------------------------------------------------
    def show_agent(self, actor: dict, detail: dict | None, now_ms: float | None = None) -> None:
        """Show (or refresh) one agent. A new agent starts at the top; a refresh keeps the place."""
        now = now_ms if now_ms is not None else time.time() * 1000
        changed = actor_id(actor) != self.agent_id or self.mode != "agent"
        if changed:
            self.leave_focus()
            self.agent_id = actor_id(actor)
            for row in self.trail_rows.values():
                row.frame.destroy()
            self.trail_rows.clear()
            self.trail_order = []
            self.clear_ask()
            self.said_open = False
            self.sprite_painted = None
            if self.composer.winfo_manager():
                self.composer.pack_forget()
            self.composer_text.delete("1.0", "end")
            set_text(self.notice, "")
        self.mode = "agent"
        self.actor = actor
        self.loading = detail is None
        self.detail = detail or {}
        if not self.header.winfo_manager():
            self.header.pack(fill="x", padx=self.theme.px(18), pady=(self.theme.px(14), self.theme.px(6)),
                             before=self.area)
            self.rule.pack(fill="x", padx=self.theme.px(18), pady=(self.theme.px(8), 0), before=self.area)
        self.update_header(now)
        names = detail_sections(self.detail, actor)
        if "ask" in names:
            self.update_ask(actor)
        elif self.ask_key is not None:
            self.clear_ask()  # Answered, dismissed, or gone: its controls go with it.
        if "waiting" in names:
            waiting = waiting_of(actor) or {}
            parent = waiting.get("who") == "parent"
            since = stamp_ms(waiting.get("at"))
            self.cards["waiting"].set_title("Waiting on its parent agent" if parent else "Asked its coordinator",
                                            age_label(since) if since else "")
            set_text(self.waiting_text, " ".join(str(waiting.get("text") or "").split()) or
                     "It is waiting for an answer before it goes on.")
            set_text(self.waiting_note, "Not a question for you: the answer comes from its "
                     + ("parent agent." if parent else "coordinator."))
        mission = self.detail.get("mission") if isinstance(self.detail.get("mission"), dict) else {}
        if "mission" in names:
            who = {"you": "by you", "coordinator": "by its coordinator", "parent": "by its parent agent"}.get(
                str(mission.get("from") or ""), "")
            when = age_label(stamp_ms(mission.get("at"))) if mission.get("at") else ""
            self.cards["mission"].set_title("Asked to", " · ".join(part for part in (who, when) if part))
            set_text(self.mission_text, str(mission.get("text") or "").strip())
        if "plan" in names:
            self.update_plan(self.detail.get("plan") or {})
        if "now" in names:
            self.update_now(detail_now(self.detail, actor) or {}, now)
        if "said" in names:
            said = self.detail.get("said") or {}
            self.cards["said"].set_title("Last said", age_label(stamp_ms(said.get("at"))) if said.get("at") else "")
            if said.get("text") != self.said_full:
                self.said_full = str(said.get("text") or "").strip()
            self.show_said()
        if "trail" in names:
            self.waiting_ids = waiting_steps(self.detail.get("trail") or [], ask_of(actor))
            self.update_trail(self.detail.get("trail") or [])
        if "files" in names:
            self.update_files(self.detail.get("files") or [])
        if "screen" in names:
            self.update_screen(self.detail.get("screen") or {})
        self.show_cards(names)
        if not names:
            self.show_empty_note()
        elif self.empty_note.winfo_manager():
            self.empty_note.pack_forget()
        if changed:
            self.area.to_top()
        self.paint_sprite(force=changed)

    def show_empty_note(self) -> None:
        set_text(self.empty_note, "Reading this goblin's records…" if self.loading else
                 "Nothing more to show for this goblin yet.")
        if not self.empty_note.winfo_manager():
            self.empty_note.pack(fill="x", padx=self.theme.px(18), pady=(self.theme.px(16), 0))

    def tick(self, now_ms: float) -> None:
        """Once a second: the live timers."""
        if self.mode != "agent" or not self.actor:
            return
        status, status_tone = status_chip(self.actor, now_ms)
        set_text(self.status_chip, status, fg=tone(status_tone))
        self.fit_chips()
        if "now" in self.order and self.now_started:
            self.cards["now"].set_title(self.now_heading, self.now_aside(now_ms))
        if "ask" in self.order:
            ask = ask_of(self.actor) or {}
            since = stamp_ms(ask.get("at"))
            card = self.cards["ask"]
            card.set_title(card.title.cget("text"), age_label(since, now_ms) if since else "")
        if "trail" in self.order:
            for row in self.trail_rows.values():
                if row.item.get("status") == "running" and not row.waiting():
                    parts = trail_result(row.item, now_ms)
                    if parts and row.result_labels:
                        set_text(row.result_labels[0], parts[0][0])

    # Welcome and chat cards --------------------------------------------------------------------
    def build_welcome(self) -> None:
        theme, px = self.theme, self.theme.px
        self.empty_note = tk.Label(self.area.content, text="", bg=PANEL, fg=FAINT, font=theme.body, anchor="w")
        self.welcome = tk.Frame(self.area.content, bg=PANEL)
        title = tk.Label(self.welcome, text="Welcome to Goblin Horde", bg=PANEL, fg=IVORY, font=theme.name, anchor="w")
        title.pack(fill="x", pady=(px(24), px(4)))
        intro = tk.Label(self.welcome, text="See what every agent is doing, and answer the ones waiting on you.",
                         bg=PANEL, fg=MUTED, font=theme.body, anchor="w", justify="left")
        intro.pack(fill="x")
        self.wrapping(intro, px(60))
        scale = sprite_scale(3, theme.scale)
        self.tribes = tk.Canvas(self.welcome, height=(SPAN_H + 2) * scale + px(26), bg=PANEL, highlightthickness=0, bd=0)
        self.tribes.pack(fill="x", pady=(px(18), px(8)))
        self.tribe_scale = scale
        self.tribe_beat = 0
        for heading, text in WELCOME:
            block = tk.Frame(self.welcome, bg=PANEL)
            block.pack(fill="x", pady=(px(6), 0))
            label = tk.Label(block, text=f"{heading} {text}", bg=PANEL, fg=IVORY, font=theme.body, anchor="w",
                             justify="left")
            label.pack(fill="x")
            self.wrapping(label, px(60))
        self.welcome_sources = tk.Label(self.welcome, text="", bg=PANEL, fg=MUTED, font=theme.small, anchor="w",
                                        justify="left")
        self.welcome_sources.pack(fill="x", pady=(px(16), 0))
        self.wrapping(self.welcome_sources, px(60))

    TRIBE_LABELS = (("shaman", "Hexer · Claude", "think"), ("sapper", "Sapper · Codex", "build"),
                    ("raider", "Raider · everything else", "search"))

    def paint_tribes(self) -> None:
        """One goblin of each tribe acting out a different job, with what its tribe stands for."""
        canvas, scale, px = self.tribes, self.tribe_scale, self.theme.px
        if not canvas.find_all():
            step = max(px(190), (SPAN_W + 12) * scale)
            for index, (_tribe, label, _action) in enumerate(self.TRIBE_LABELS):
                x = px(4) + index * step
                place_sprite(canvas, x, TOP_ROOM * scale, scale, f"tribe-{index}")
                canvas.create_text(x, SPAN_H * scale + px(14), text=label, anchor="w", fill=MUTED, font=self.theme.small)
        for index, (tribe, _label, action) in enumerate(self.TRIBE_LABELS):
            outfit = next(outfit for outfit in KINDS if outfit["tribe"] == tribe)
            image = self.app.sprite_images.image(outfit, action, self.tribe_beat, scale, self.app.reduced_motion)
            canvas.itemconfigure(f"tribe-{index}-image", image=image)

    def show_welcome(self, sources_note: str = "") -> None:
        if self.mode != "welcome":
            self.leave_focus()
        self.clear_ask()
        self.mode = "welcome"
        self.agent_id = ""
        self.actor = {}
        if self.composer.winfo_manager():
            self.composer.pack_forget()
        self.header.pack_forget()
        self.rule.pack_forget()
        self.show_cards([])
        self.empty_note.pack_forget()
        self.chat.pack_forget()
        set_text(self.welcome_sources, sources_note)
        if not self.welcome.winfo_manager():
            self.welcome.pack(fill="x", padx=self.theme.px(24))
            self.paint_tribes()
        self.order = ["welcome"]
        self.area.to_top()

    def build_chat(self) -> None:
        theme, px = self.theme, self.theme.px
        self.chat = tk.Frame(self.area.content, bg=PANEL)
        self.chat_name = tk.Label(self.chat, text="", bg=PANEL, fg=IVORY, font=theme.name, anchor="w", justify="left")
        self.chat_name.pack(fill="x", pady=(px(24), px(4)))
        self.wrapping(self.chat_name, px(60))
        self.chat_meta = tk.Label(self.chat, text="", bg=PANEL, fg=MUTED, font=theme.body, anchor="w", justify="left")
        self.chat_meta.pack(fill="x")
        self.wrapping(self.chat_meta, px(60))
        self.chat_note = tk.Label(self.chat, text="", bg=PANEL, fg=FAINT, font=theme.small, anchor="w", justify="left")
        self.chat_note.pack(fill="x", pady=(px(10), 0))
        self.wrapping(self.chat_note, px(60))
        buttons = tk.Frame(self.chat, bg=PANEL)
        buttons.pack(fill="x", pady=(px(14), 0))
        self.chat_watch = FlatButton(buttons, theme, "Watch", None, kind="primary")
        self.chat_watch.pack(side="left")
        self.chat_viewer = FlatButton(buttons, theme, "Open in browser ↗", None, kind="secondary")
        self.chat_viewer.pack(side="left", padx=(px(6), 0))
        self.chat_party = ""

    def show_chat(self, source: dict, watched: bool, members: int = 0) -> None:
        """A watched chat with nobody at work, or a chat found by search."""
        party = str(source.get("id") or "")
        if self.mode != "chat" or party != self.chat_party:
            self.leave_focus()
        self.clear_ask()
        self.mode = "chat"
        self.agent_id = ""
        self.actor = {}
        self.chat_party = party
        if self.composer.winfo_manager():
            self.composer.pack_forget()
        self.header.pack_forget()
        self.rule.pack_forget()
        self.show_cards([])
        self.empty_note.pack_forget()
        self.welcome.pack_forget()
        set_text(self.chat_name, " ".join(str(source.get("name") or party).split()))
        stamp = stamp_ms(source.get("updatedAt"))
        bits = [bit for bit in (project_name(source), SOURCE_NAMES.get(source_of(source), ""),
                                model_badge(source), f"last active {age_label(stamp)}" if stamp else "") if bit]
        set_text(self.chat_meta, " · ".join(bits))
        set_text(self.chat_note, ("Watched: the viewer always reads this chat, so its goblins appear the moment it "
                                  "starts working." if watched else
                                  "Watch it to have the viewer always read this chat; its goblins then appear here "
                                  "whenever it works.") + (f" {members} goblins seen today." if members else ""))
        set_text(self.chat_watch, "Stop watching" if watched else "☆ Watch this chat")
        self.chat_watch.set_kind("secondary" if watched else "primary")
        self.chat_watch.command = lambda: self.app.set_watched(party, not watched)
        self.chat_watch.set_enabled(self.app.can("/api/watch"))
        self.chat_viewer.command = lambda: self.app.open_viewer(party)
        if not self.chat.winfo_manager():
            self.chat.pack(fill="x", padx=self.theme.px(24))
        self.order = ["chat"]
        self.area.to_top()

    def animate(self) -> None:
        if self.mode == "agent":
            self.paint_sprite()
        elif self.mode == "welcome" and not self.app.reduced_motion:
            self.tribe_beat += 1
            self.paint_tribes()
