"""The Horde window built for real with Windows Tk, from the invented demo world only.

These check what a person sees and does: the roster's sections and lines, selection, the detail
sections, answering and dismissing from the window, in-place updates (no rebuilt rows, kept scroll
and expanded trail rows), the goblin strip, and an older viewer without the 0.6 routes.
"""

import sys
import time
import unittest
from types import SimpleNamespace

from desktop_widget import GoblinWidget
from horde_api import ApiError
from horde_theme import SELECTED, FlatButton

try:
    from widget_fixtures import isolate, load, load_detail, quiet, settle, wait_for
except ImportError:
    from test.widget_fixtures import isolate, load, load_detail, quiet, settle, wait_for


def buttons(root, text: str) -> list[FlatButton]:
    found, pending = [], [root]
    while pending:
        widget = pending.pop()
        pending.extend(widget.winfo_children())
        if isinstance(widget, FlatButton) and widget.cget("text") == text and widget.winfo_manager():
            found.append(widget)
    return found


def press(button: FlatButton) -> None:
    button.update_idletasks()
    button._release(SimpleNamespace(x=1, y=1))


@unittest.skipUnless(sys.platform == "win32", "Builds the real window with Windows Tk")
class HordeWindowTests(unittest.TestCase):
    def make(self, demo_set: str = "default", **options) -> GoblinWidget:
        isolate(self)
        widget = GoblinWidget("", 44191, demo=True, demo_set=demo_set, **options)
        self.addCleanup(widget.close)
        # Runs before close (cleanups run last-in, first-out): no callback may have failed.
        self.addCleanup(lambda: self.assertEqual(widget.error_count, 0, "a Tk callback raised"))
        quiet(widget)
        load(widget)
        return widget

    def row_text(self, widget, key: str, item: str) -> str:
        view = widget.roster.views[key]
        return widget.roster.canvas.itemcget(view.items[item], "text")

    def click_row(self, widget, key: str) -> None:
        view = widget.roster.views[key]
        widget.roster.ensure_visible(key)
        y = view.top - widget.roster.canvas.canvasy(0) + view.height // 2
        widget.roster._on_click(SimpleNamespace(x=40, y=y))
        quiet(widget)
        load_detail(widget)

    # The roster ------------------------------------------------------------------------------------
    def test_needs_you_comes_first_with_the_actual_question_and_is_selected(self):
        widget = self.make()
        sections = [(row.title, row.count) for row in widget.rows if row.kind == "section"]
        self.assertEqual(sections[:2], [("Needs you", 4), ("Working", 9)])
        # The Working heading and the header's chips count alike: 9 working, 1 failed.
        self.assertEqual(self.row_text(widget, "section:working", "title"), "Working · 9 · 1 failed")
        self.assertEqual(widget.window.count_chips["working"].cget("text"), "9 working")
        self.assertEqual(widget.selected, "demo-chat-release-notes", "the longest-waiting ask is chosen")
        # A reply shows its question, not the sentence before it; a permission names what it would run.
        self.assertTrue(self.row_text(widget, "demo-chat-release-notes", "line").startswith("Should I convert the older"))
        self.assertTrue(self.row_text(widget, "claude-agent:demo-login-fix", "line").startswith("Allow PowerShell: Remove-Item"))
        self.assertEqual(widget.window.count_chips["needs"].cget("text"), "4 need you")
        self.assertEqual(widget.window.count_chips["failed"].cget("text"), "1 failed")
        self.assertEqual([label.cget("text") for label in widget.window.source_labels.values()],
                         ["Codex ✓", "Claude ✓", "Orca ✓", "Feeds –"])
        bg = widget.roster.canvas.itemcget(widget.roster.views["demo-chat-release-notes"].bg, "fill")
        self.assertEqual(bg, SELECTED)

    def test_two_goblins_whose_names_cut_the_same_are_told_apart(self):
        widget = self.make()
        world = widget.api.world
        base = world.find("demo-chat-pr-review")
        for ident, region in (("demo-chat-eu-flow", "EU"), ("demo-chat-us-flow", "US")):
            world.actors.append({**base, "id": ident, "parentThreadId": "",
                                 "name": f"Refactor the checkout payment flow for the {region}"})
        load(widget)
        eu = self.row_text(widget, "demo-chat-eu-flow", "title")
        us = self.row_text(widget, "demo-chat-us-flow", "title")
        self.assertNotEqual(eu, us)
        self.assertTrue(eu.endswith("for the EU") and us.endswith("for the US"), (eu, us))

    def test_parties_list_their_lead_first_and_members_indented(self):
        widget = self.make()
        keys = [row.key for row in widget.rows]
        at = keys.index("party:demo-chat-csv-export")
        self.assertEqual(keys[at + 1:at + 6], ["demo-chat-csv-export", "orca-agent:demo-pane-writer",
                                               "orca-agent:demo-pane-schema", "orca-agent:demo-pane-docs",
                                               "demo-chat-csv-explorer"])
        lead, writer = widget.roster.views[keys[at + 1]], widget.roster.views[keys[at + 2]]
        self.assertGreater(widget.roster.canvas.coords(writer.items["title"])[0],
                           widget.roster.canvas.coords(lead.items["title"])[0], "members are indented")
        self.assertTrue(self.row_text(widget, "orca-agent:demo-pane-schema", "line").startswith("Asked the coordinator"))
        self.assertTrue(self.row_text(widget, "orca-agent:demo-pane-docs", "line").startswith("Failed: npm run lint:docs"))

    def test_polls_update_rows_in_place_and_keep_the_scroll_and_selection(self):
        widget = self.make("crowd")
        roster = widget.roster
        self.assertEqual(sum(row.kind == "agent" for row in widget.rows), 20)
        items = {key: (view.bg, view.items["title"]) for key, view in roster.views.items() if view.kind == "agent"}
        roster.canvas.yview_moveto(0.4)
        settle(widget)
        top = roster.canvas.canvasy(0)
        widget.select("orca-agent:demo-crowd-stock")
        roster.canvas.yview_moveto(0.4)
        load(widget)
        widget.refresh()
        settle(widget)
        self.assertEqual({key: (view.bg, view.items["title"]) for key, view in roster.views.items() if view.kind == "agent"},
                         items, "the same canvas items, moved and updated, never rebuilt")
        self.assertEqual(roster.canvas.canvasy(0), top)
        self.assertEqual(widget.selected, "orca-agent:demo-crowd-stock")

    def test_selection_follows_the_agent_when_rows_above_it_go(self):
        widget = self.make()
        self.click_row(widget, "orca-agent:demo-pane-ranker")
        before = widget.roster.views["orca-agent:demo-pane-ranker"].top
        actor = widget.actor("demo-chat-image-pipeline")
        done = []
        widget.respond(actor, "demo-request-7", decision="accept", done=lambda *answer: done.append(answer))
        wait_for(widget, lambda: bool(done))
        load(widget)
        self.assertEqual(widget.selected, "orca-agent:demo-pane-ranker")
        self.assertLess(widget.roster.views["orca-agent:demo-pane-ranker"].top, before, "it moved up a row")
        self.assertNotIn("demo-chat-image-pipeline", [row.key for row in widget.rows if row.section == "needs"])
        bg = widget.roster.canvas.itemcget(widget.roster.views["orca-agent:demo-pane-ranker"].bg, "fill")
        self.assertEqual(bg, SELECTED)

    def test_keyboard_moves_through_the_goblins(self):
        widget = self.make()
        widget.move_selection(1)
        self.assertEqual(widget.selected, "claude-agent:demo-migration-plan")
        widget.move_selection(-1)
        self.assertEqual(widget.selected, "demo-chat-release-notes")

    def test_done_today_opens_from_its_heading(self):
        widget = self.make()
        self.assertNotIn("demo-chat-config-keys", widget.roster.views)
        heading = next(row for row in widget.rows if row.key == "section:done")
        widget.on_row_click(heading)
        settle(widget)
        self.assertIn("demo-chat-config-keys", widget.roster.views)
        self.assertTrue(widget.done_open)

    def test_find_filters_and_enter_searches_older_chats(self):
        widget = self.make()
        widget.on_query("login")
        self.assertEqual([row.key for row in widget.rows if row.kind == "agent"],
                         ["claude-agent:demo-login-fix", "claude-agent:demo-login-fix:a1"])
        widget.search_catalog("rate limits")
        results = [row.key for row in widget.rows if row.kind == "result"]
        self.assertEqual(results, ["result:demo-chat-older-1"])
        self.click_row(widget, "result:demo-chat-older-1")
        self.assertEqual(widget.detail_view.mode, "chat")
        self.assertEqual(widget.detail_view.chat_name.cget("text"), "Draft API rate limits")
        press(buttons(widget.detail_view.chat, "☆ Watch this chat")[0])
        wait_for(widget, lambda: widget.watch_pending is None)
        self.assertIn("demo-chat-older-1", widget.watched_ids)

    # The detail pane -------------------------------------------------------------------------------
    def test_a_working_worker_shows_its_mission_plan_command_trail_files_and_screen(self):
        widget = self.make()
        self.click_row(widget, "orca-agent:demo-pane-writer")
        view = widget.detail_view
        self.assertEqual(view.order, ["mission", "plan", "now", "said", "trail", "files", "screen"])
        self.assertEqual(view.name.cget("text"), "csv-writer")
        self.assertEqual(view.cards["plan"].title.cget("text"), "Plan · 2 of 4")
        self.assertEqual(view.now_title.cget("text"), "Running npm test -- csv")
        self.assertIn("npm test -- --runInBand", view.now_detail.cget("text"))
        self.assertTrue(view.cards["now"].aside.cget("text").startswith("running 1m"))
        self.assertEqual(view.cards["mission"].aside.cget("text").split(" · ")[0], "by its coordinator")
        self.assertIn("Running", view.status_chip.cget("text").replace("Working", "Running"))
        self.assertEqual(view.model_chip.cget("text"), "Opus 5.5")
        self.assertEqual([button.cget("text") for button in view.header_buttons if button.winfo_manager()],
                         ["Open in Orca ↗", "Message…"])

    def test_trail_rows_expand_to_their_output_and_stay_open_across_polls(self):
        widget = self.make()
        self.click_row(widget, "demo-chat-csv-export")
        row = widget.detail_view.trail_rows["c4"]
        self.assertFalse(row.more.winfo_manager())
        row.on_click()
        settle(widget)
        self.assertTrue(row.more.winfo_manager())
        self.assertIn("21 passed", row.output.cget("text"))
        load(widget)
        load_detail(widget)
        self.assertIs(widget.detail_view.trail_rows["c4"], row, "the row is kept, not rebuilt")
        self.assertTrue(row.more.winfo_manager(), "still expanded after the refresh")

    def test_a_subagent_on_the_trail_is_one_click_away(self):
        widget = self.make()
        self.click_row(widget, "claude-agent:demo-login-fix")
        widget.detail_view.trail_rows["l4"].on_click()
        quiet(widget)
        self.assertEqual(widget.selected, "claude-agent:demo-login-fix:a1")

    def test_a_permission_ask_shows_the_command_and_can_be_dismissed(self):
        widget = self.make()
        self.click_row(widget, "claude-agent:demo-login-fix")
        view = widget.detail_view
        self.assertEqual(view.order[0], "ask")
        self.assertEqual(view.cards["ask"].title.cget("text"), "Wants permission")
        self.assertTrue(buttons(view.cards["ask"].body, "Answer in Claude Code ↗"))
        press(buttons(view.cards["ask"].body, "Dismiss")[0])
        self.assertNotIn("claude-agent:demo-login-fix", [row.key for row in widget.rows if row.section == "needs"],
                         "gone from Needs you at once")
        wait_for(widget, lambda: widget.pending is None and not widget.dismissed_keys)
        load(widget)
        actor = widget.actor("claude-agent:demo-login-fix")
        self.assertIsNone(actor["ask"])
        self.assertNotIn("ask", widget.detail_view.order)

    def test_while_a_permission_is_open_the_step_waits_for_you_instead_of_running(self):
        widget = self.make()
        self.click_row(widget, "claude-agent:demo-login-fix")
        view = widget.detail_view
        self.assertTrue(view.now_title.cget("text").startswith("Waiting for your OK to run Remove-Item"))
        self.assertTrue(view.cards["now"].aside.cget("text").startswith("waiting 4m"), view.cards["now"].aside.cget("text"))
        held = view.trail_rows["l5"]
        self.assertEqual([label.cget("text") for label in held.result_labels if label.winfo_manager()], ["waiting for you"])
        view.tick(time.time() * 1000)
        self.assertEqual(held.result_labels[0].cget("text"), "waiting for you", "the timer never turns it back to running")
        # A question hides Now altogether: the ask card says what it waits for.
        self.click_row(widget, "claude-agent:demo-migration-plan")
        self.assertNotIn("now", widget.detail_view.order)

    def test_a_finished_step_reads_as_the_last_step_and_thinking_says_since_when(self):
        widget = self.make()
        # The roster: a past step with how long ago, and Thinking with how long since the last step.
        self.assertEqual(self.row_text(widget, "demo-chat-pr-review", "line"), "Ran gh pr view 214 · 2m ago")
        self.assertRegex(self.row_text(widget, "demo-chat-cache-headers", "line"), r"^Thinking · 3[6-9]s$")
        self.click_row(widget, "demo-chat-pr-review")
        view = widget.detail_view
        self.assertEqual(view.cards["now"].title.cget("text"), "Last step")
        self.assertEqual(view.cards["now"].aside.cget("text"), "2m ago")
        self.assertEqual(view.now_title.cget("text"), "Ran gh pr view 214")
        self.assertEqual(view.status_chip.cget("text"), "Working", "a finished step is not a running timer")
        view.tick(time.time() * 1000 + 60_000)
        self.assertEqual(view.cards["now"].aside.cget("text"), "3m ago")
        # A trail step with no known time shows none.
        self.assertEqual(view.trail_rows["v1"].time.cget("text"), "")
        self.assertNotEqual(view.trail_rows["v3"].time.cget("text"), "")
        self.click_row(widget, "demo-chat-cache-headers")
        self.assertEqual(widget.detail_view.cards["now"].title.cget("text"), "Now")
        self.assertTrue(widget.detail_view.cards["now"].aside.cget("text").endswith("since the last step"))

    def test_an_idle_session_is_out_of_working_and_says_how_long_it_has_been_quiet(self):
        widget = self.make()
        working = [row.key for row in widget.rows if row.section == "working"]
        self.assertNotIn("claude-agent:demo-pricing-rules", working)
        heading = next(row for row in widget.rows if row.key == "section:done")
        widget.on_row_click(heading)
        settle(widget)
        row = next(row for row in widget.rows if row.key == "claude-agent:demo-pricing-rules")
        self.assertEqual(row.section, "done")
        self.assertEqual(row.line.tone, "done")
        self.assertEqual(self.row_text(widget, "claude-agent:demo-pricing-rules", "line"), "No activity for 66m")
        self.click_row(widget, "claude-agent:demo-pricing-rules")
        self.assertEqual(widget.detail_view.status_chip.cget("text"), "Idle · no activity for 66m")
        self.assertNotIn("now", widget.detail_view.order)

    def test_a_goblin_that_just_finished_is_in_view_and_stays_selected(self):
        widget = self.make()
        sections = [row.title for row in widget.rows if row.kind == "section"]
        self.assertLess(sections.index("Just finished"), sections.index("Done today"))
        self.assertTrue(self.row_text(widget, "demo-chat-api-client", "line").startswith("Regenerated the client"))
        # Looking at a working goblin (not clicked: chosen automatically) that then finishes keeps it on screen.
        widget.chosen, widget.selected = False, "orca-agent:demo-pane-ranker"
        actor = widget.api.world.find("orca-agent:demo-pane-ranker")
        actor.update(attention="quiet", status="idle", now=None)
        load(widget)
        self.assertEqual(widget.selected, "orca-agent:demo-pane-ranker")
        self.assertEqual(next(row for row in widget.rows if row.key == widget.selected).section, "just")

    def test_buttons_work_from_the_keyboard(self):
        widget = self.make()
        self.click_row(widget, "demo-chat-image-pipeline")
        view = widget.detail_view
        approve = buttons(view.cards["ask"].body, "Approve once")[0]
        self.assertEqual(widget.roster.canvas.tk_focusNext(), view.open_button, "from the roster, Tab goes to the goblin")
        self.assertIs(view.open_button.tk_focusNext(), view.message_button)
        approve.focus_force()
        settle(widget)
        self.assertEqual(widget.root.focus_get(), approve)
        self.assertGreater(int(approve.cget("highlightthickness")), 0, "a focus ring is drawn")
        # A gold button's ring is not gold: it shows against the button's own fill.
        self.assertNotEqual(approve.cget("highlightcolor").lower(), approve.cget("bg").lower())
        decline = buttons(view.cards["ask"].body, "Decline")[0]
        self.assertNotEqual(decline.cget("highlightcolor").lower(), decline.cget("bg").lower())
        approve.event_generate("<Return>")
        wait_for(widget, lambda: not widget.api.world.requests)
        self.click_row(widget, "claude-agent:demo-migration-plan")
        tag = buttons(widget.detail_view.cards["ask"].body, "Postgres 16 replica")[0]
        self.assertEqual(tag._focusable(), "0", "an option that can only be chosen in Claude Code is not a Tab stop")
        self.assertEqual(buttons(widget.detail_view.cards["ask"].body, "Dismiss")[0]._focusable(), "1")

    # A key press answers only the ask on screen ---------------------------------------------------------
    def ask_widgets(self, widget) -> list:
        found, pending = [], [widget.detail_view.cards["ask"].body]
        while pending:
            item = pending.pop()
            pending.extend(item.winfo_children())
            found.append(item)
        return found

    def press_keys(self, widget, *targets) -> None:
        """Space and Return on whatever has the focus, and on each of `targets` that still exists."""
        for key in ("<space>", "<Return>", "<KP_Enter>"):
            for target in (widget.root.focus_get() or widget.root, *targets):
                if target.winfo_exists():
                    target.event_generate(key)
        settle(widget)
        time.sleep(0.2)  # A respond would go out on a worker thread; give it the time to land.
        settle(widget)

    def test_down_from_an_ask_button_leaves_no_key_that_answers_the_goblin_left_behind(self):
        widget = self.make()
        self.click_row(widget, "demo-chat-image-pipeline")
        view = widget.detail_view
        approve = buttons(view.cards["ask"].body, "Approve once")[0]
        command = approve.command
        approve.focus_force()
        settle(widget)
        approve.event_generate("<Down>")
        quiet(widget)
        settle(widget)
        self.assertEqual(widget.selected, "demo-chat-csv-export")
        self.assertNotIn("ask", view.order)
        self.assertFalse(approve.winfo_exists(), "the old ask's buttons are gone, not just hidden")
        self.assertIs(widget.root.focus_get(), widget.roster.canvas, "the focus follows the selection to the roster")
        self.press_keys(widget, approve)
        command()  # Even a press already on its way finds its ask gone.
        settle(widget)
        time.sleep(0.2)
        settle(widget)
        self.assertEqual([item["id"] for item in widget.api.world.requests], ["demo-request-7"])
        self.assertIsNotNone(widget.api.world.find("demo-chat-image-pipeline")["ask"])

    def test_clicking_the_need_you_chip_leaves_no_key_that_answers_the_goblin_left_behind(self):
        widget = self.make()
        self.click_row(widget, "demo-chat-image-pipeline")
        approve = buttons(widget.detail_view.cards["ask"].body, "Approve once")[0]
        approve.focus_force()
        settle(widget)
        widget.window.count_chips["needs"].event_generate("<Button-1>")  # A label: the click takes no focus.
        quiet(widget)
        settle(widget)
        self.assertEqual(widget.selected, "demo-chat-release-notes")
        self.assertIs(widget.root.focus_get(), widget.roster.canvas)
        self.press_keys(widget, approve)
        self.assertEqual([item["id"] for item in widget.api.world.requests], ["demo-request-7"])

    def test_a_message_being_written_never_goes_to_the_goblin_chosen_next(self):
        widget = self.make()
        self.click_row(widget, "demo-chat-csv-export")
        view = widget.detail_view
        press(view.message_button)
        settle(widget)
        self.assertTrue(view.composer.winfo_ismapped())
        view.composer_text.insert("1.0", "Ship it after the review.")
        view.composer_text.focus_force()
        settle(widget)
        widget.window.count_chips["needs"].event_generate("<Button-1>")
        quiet(widget)
        settle(widget)
        self.assertEqual(widget.selected, "demo-chat-release-notes")
        self.assertIsNot(widget.root.focus_get(), view.composer_text, "the focus left the hidden box")
        # Typing on and Ctrl+Enter, or a send already on its way, reach nobody.
        view.composer_text.insert("end", " Typed after the switch.")
        view.composer_text.event_generate("<Control-Return>")
        view.send_composer()
        settle(widget)
        time.sleep(0.2)
        settle(widget)
        for ident in ("demo-chat-csv-export", "demo-chat-release-notes"):
            trail = widget.api.world.details.get(ident, {}).get("trail", [])
            self.assertFalse(any(row["title"].startswith("You:") for row in trail), ident)
        self.assertIsNotNone(widget.api.world.find("demo-chat-release-notes")["ask"])
        # Opened for the goblin on screen, it sends as before.
        load_detail(widget)
        self.assertTrue(view.message_button.winfo_ismapped())
        press(view.message_button)
        settle(widget)
        view.composer_text.delete("1.0", "end")
        view.composer_text.insert("1.0", "Convert the older ones too.")
        press(view.composer_send)
        wait_for(widget, lambda: any(row["title"].startswith("You: Convert the older") for row in
                                     widget.api.world.details.get("demo-chat-release-notes", {}).get("trail", [])))

    def test_a_hidden_reply_box_never_sends_to_the_goblin_left_behind(self):
        widget = self.make()
        self.click_row(widget, "demo-chat-release-notes")
        box = widget.detail_view.ask_widgets["reply"]
        box.insert("1.0", "Convert them.")
        box.focus_force()
        settle(widget)
        reply = buttons(widget.detail_view.cards["ask"].body, "Reply")[0]
        command = reply.command
        widget.move_selection(1)  # Chosen by the window itself; the arrow keys stay in the box.
        quiet(widget)
        settle(widget)
        self.assertNotEqual(widget.selected, "demo-chat-release-notes")
        self.assertFalse(box.winfo_exists())
        self.assertNotIn(widget.root.focus_get(), self.ask_widgets(widget))
        command()
        settle(widget)
        time.sleep(0.2)
        settle(widget)
        self.assertIsNotNone(widget.api.world.find("demo-chat-release-notes")["ask"], "nothing was sent")
        self.assertFalse(any(row["title"].startswith("You:") for row in
                             widget.api.world.details.get("demo-chat-release-notes", {}).get("trail", [])))

    def test_a_button_on_a_hidden_card_does_nothing(self):
        widget = self.make()
        self.click_row(widget, "demo-chat-image-pipeline")
        view = widget.detail_view
        approve = buttons(view.cards["ask"].body, "Approve once")[0]
        view.cards["ask"].frame.pack_forget()
        settle(widget)
        approve._key()
        approve._release(SimpleNamespace(x=1, y=1))
        settle(widget)
        time.sleep(0.2)
        settle(widget)
        self.assertEqual([item["id"] for item in widget.api.world.requests], ["demo-request-7"])

    def test_a_new_ask_never_takes_the_focus(self):
        widget = self.make()
        self.click_row(widget, "demo-chat-image-pipeline")
        view = widget.detail_view
        approve = buttons(view.cards["ask"].body, "Approve once")[0]
        approve.focus_force()
        settle(widget)
        # The same goblin asks again: a new request with a new key replaces the one in focus.
        world = widget.api.world
        world.requests[0]["id"] = "demo-request-8"
        actor = world.find("demo-chat-image-pipeline")
        actor["ask"] = {**actor["ask"], "requestId": "demo-request-8", "key": "demo-ask-image-2", "at": actor["ask"]["at"] + 1}
        load(widget)
        load_detail(widget)
        fresh = buttons(view.cards["ask"].body, "Approve once")[0]
        self.assertIsNot(fresh, approve)
        self.assertNotIn(widget.root.focus_get(), self.ask_widgets(widget))
        self.press_keys(widget)
        self.assertEqual([item["id"] for item in world.requests], ["demo-request-8"])

    def test_a_refused_reply_offers_one_way_to_open_the_chat(self):
        widget = self.make()
        self.click_row(widget, "demo-chat-release-notes")

        def refused(_ident, _text):
            raise ApiError(409, "This chat is open in the Codex app.")
        widget.api.message = refused
        widget.api.available = lambda _path: True
        for _ in range(3):
            widget.detail_view.ask_widgets["reply"].insert("1.0", "Convert them.")
            press(buttons(widget.detail_view.cards["ask"].body, "Reply")[0])
            wait_for(widget, lambda: "open in the Codex app" in widget.detail_view.ask_widgets["status"].cget("text"))
            widget.detail_view.ask_widgets["status"].say("")
        self.assertEqual(len(buttons(widget.detail_view.cards["ask"].body, "Open in Codex ↗")), 1)

    def test_question_options_are_shown_but_answered_in_the_agents_own_app(self):
        widget = self.make()
        self.click_row(widget, "claude-agent:demo-migration-plan")
        body = widget.detail_view.cards["ask"].body
        option = buttons(body, "Postgres 16 replica")[0]
        self.assertEqual(option.kind, "tag")
        self.assertIsNone(option.command)
        self.assertTrue(buttons(body, "No, keep it running"), "the second question is shown too")

    def test_a_codex_approval_is_answered_from_the_window(self):
        widget = self.make()
        self.click_row(widget, "demo-chat-image-pipeline")
        body = widget.detail_view.cards["ask"].body
        self.assertTrue(buttons(body, "Decline"))
        press(buttons(body, "Approve once")[0])
        wait_for(widget, lambda: not widget.api.world.requests)
        load(widget)
        self.assertNotIn("demo-chat-image-pipeline", [row.key for row in widget.rows if row.section == "needs"])

    def test_a_codex_question_is_answered_with_a_reply(self):
        widget = self.make()
        self.click_row(widget, "demo-chat-release-notes")
        box = widget.detail_view.ask_widgets["reply"]
        box.insert("1.0", "Convert them, please.")
        press(buttons(widget.detail_view.cards["ask"].body, "Reply")[0])
        wait_for(widget, lambda: widget.api.world.find("demo-chat-release-notes")["ask"] is None)
        load(widget)
        load_detail(widget)
        titles = [row.full_title for row in widget.detail_view.trail_rows.values()]
        self.assertIn("You: Convert them, please.", titles)

    def test_message_reports_why_a_control_did_not_work(self):
        widget = self.make()
        self.click_row(widget, "demo-chat-csv-export")
        press(widget.detail_view.open_button)
        wait_for(widget, lambda: bool(widget.detail_view.notice.cget("text")))
        self.assertIn("Nothing opens in the demo", widget.detail_view.notice.cget("text"))

    def test_an_older_viewer_without_agent_records_shows_the_public_steps(self):
        widget = self.make()

        def old_viewer(_ident):
            raise ApiError(404, "Not found", missing=True)
        widget.api.agent = old_viewer
        self.click_row(widget, "orca-agent:demo-pane-docs")
        self.assertIs(widget.detail_route, False)
        view = widget.detail_view
        self.assertIn("trail", view.order)
        self.assertEqual([button.cget("text") for button in view.header_buttons if button.winfo_manager()],
                         ["Open in browser ↗"], "no controls without the 0.6 routes")

    def test_nobody_at_work_shows_the_welcome(self):
        widget = self.make("empty")
        self.assertEqual(widget.detail_view.mode, "welcome")
        self.assertIn("note:working", widget.roster.views)
        self.assertIn("Phone access is off", widget.detail_view.welcome_sources.cget("text"))
        self.assertTrue(widget.welcomed, "the welcome was seen; it is remembered")
        # Without the demo, the welcome says what the feed chips in the header can do.
        widget.demo, widget.connection = False, "LIVE"
        widget.sources = {"codex": {"state": "not-installed"}, "claude": {"state": "not-connected", "canConnect": True}}
        self.assertIn("Click Claude + in the header to connect Claude Code.", widget.welcome_note())

    def test_the_viewer_not_answering_says_so(self):
        widget = self.make()

        def gone():
            raise OSError("connection refused")
        widget.api.scene = gone
        widget.demo = False  # As a live window would.
        for _ in range(2):
            widget.fetch_now()
            wait_for(widget, lambda: widget.pending is None)
        quiet(widget)
        settle(widget)
        self.assertTrue(widget.window.banner.winfo_manager())
        self.assertIn("not answering", widget.window.banner_text.cget("text"))
        self.assertFalse(widget.window.banner_restart.winfo_manager(), "a source checkout cannot restart its viewer")
        self.assertTrue(widget.rows, "the last good list stays")

    # The goblin strip ------------------------------------------------------------------------------
    def test_the_strip_shows_twelve_goblins_then_a_count_and_opens_on_a_click(self):
        widget = self.make("crowd", surface="strip")
        strip = widget.strip
        self.assertEqual(widget.root.state(), "withdrawn")
        self.assertEqual(strip.window.state(), "normal")
        self.assertEqual(len(strip.items), 12)
        self.assertGreater(strip.hidden, 0)
        self.assertEqual([slot[2] for slot in strip.slots][0], "pill")
        self.assertEqual(strip.slots[-1][2], "more")
        self.assertEqual(strip.items[0].klass, "needs", "who needs you stands first")
        left, right, _kind, ident = strip.slots[3]
        strip.on_press(SimpleNamespace(x_root=0, y_root=0))
        strip.on_release(SimpleNamespace(x=(left + right) // 2, y=10))
        quiet(widget)
        settle(widget)
        self.assertEqual(widget.root.state(), "normal")
        self.assertEqual(widget.selected, ident)

    def test_reduced_motion_paints_one_still_frame(self):
        widget = self.make()
        widget.reduced_motion = False
        widget.toggle_reduced_motion()
        self.assertTrue(widget.reduced_motion)
        view = widget.roster.views["orca-agent:demo-pane-writer"]
        widget.roster.ensure_visible(view.row.key)
        painted = view.painted
        for _ in range(3):
            widget.animate_step()
            widget.roster.paint_sprites()
        self.assertEqual(view.painted, painted, "a still goblin is not repainted every beat")


if __name__ == "__main__":
    unittest.main()
