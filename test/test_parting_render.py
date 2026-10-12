"""Real Tk checks for retiring goblins: portal frames, parting notes, revival, and restraint.

Every scene here is synthetic and the widget's settings live in a temporary folder."""

import os
import sys
import tempfile
import time
import tkinter as tk
import unittest
from concurrent.futures import Future
from types import SimpleNamespace
from unittest.mock import patch

from desktop_widget import DOCK_CARD, EXIT_BEAT_SECONDS, EXIT_SECONDS, NOTE_CHIP, GoblinWidget, NotesPanel, state_file
from goblin_cues import PORTAL_BEATS
from stream_windows import MUTED, ROSTER_SPRITE, ROSTER_TILE

try:
    from test_party_dock_geometry import quiet, settle
except ImportError:  # Run as a package from the repository root.
    from test.test_party_dock_geometry import quiet, settle

PARTY = "synthetic-party-0001"


def member(member_id, turn="inProgress", **extra):
    """A Codex child agent; a finished one carries a public answer, a file change, and a command."""
    working = turn == "inProgress"
    activities = [{"id": f"{member_id}-file", "turnId": "t1", "kind": "file", "title": "Changed app.py",
                   "description": "app.py · notes.md", "status": "inProgress" if working else "completed"}]
    if not working:
        activities += [
            {"id": f"{member_id}-cmd", "turnId": "t1", "kind": "command", "title": "Ran project tests",
             "description": "Checked the project with its test suite.", "detail": "npm test",
             "output": "SYNTHETIC OUTPUT", "exitCode": 0, "status": "completed"},
            {"id": f"{member_id}-answer", "turnId": "t1", "kind": "update", "title": "Answer",
             "description": f"{member_id} wrapped up the synthetic task.", "status": "completed"}]
    return {"id": member_id, "source": "codex", "name": f"Goblin {member_id}", "parentThreadId": PARTY,
            "status": "active" if working else "idle", "updatedAt": time.time() * 1000 - 60_000,
            "turnStates": [{"id": "t1", "status": turn, "questions": []}], "activities": activities, **extra}


ROOT = {"id": PARTY, "source": "codex", "name": "Synthetic party", "status": "idle",
        "turnStates": [{"id": "r1", "status": "completed"}],
        "activities": [{"id": "root-1", "kind": "update", "title": "Update", "description": "Coordinating."}]}


def receive(widget, agents, warning=""):
    """Land one selected-party read exactly as the poller would."""
    future = Future()
    future.set_result({"root": ROOT, "agents": agents, "warning": warning, "requests": []})
    widget.pending, widget.pending_scope = future, widget.thread_id
    widget.receive_scene()
    settle(widget)


def age_exit(widget, actor_id, seconds):
    """Move one portal's single start time back, as if ``seconds`` had passed."""
    widget.exits[actor_id] = widget.exits[actor_id]._replace(start=time.monotonic() - seconds)


def sprite_items(canvas, tag):
    return sorted((canvas.type(item), tuple(canvas.coords(item)), canvas.itemcget(item, "fill"))
                  for item in canvas.find_withtag(tag))


def dock_cards(widget):
    return {actor_id: (x1, y1, x2, y2) for x1, y1, x2, y2, actor_id in widget.party_dock.member_hitboxes}


def retire(widget, member_id, others, turn="completed"):
    """Seen working, then seen ending (finished by default) in two complete reads."""
    receive(widget, [member(member_id), *others])
    receive(widget, [member(member_id, turn), *others])
    receive(widget, [member(member_id, turn), *others])


def next_turn(member_id):
    """The same member after it ran and completed a second turn between two polls."""
    actor = member(member_id, "completed")
    actor["turnStates"] = [{"id": "t1", "status": "completed", "questions": []},
                           {"id": "t2", "status": "completed", "questions": []}]
    actor["activities"] = actor["activities"] + [
        {"id": f"{member_id}-answer-2", "turnId": "t2", "kind": "update", "title": "Answer",
         "description": "Second synthetic task done.", "status": "completed"}]
    return actor


def reader(*events):
    """A goblin never seen working (so it never retires) whose turn already completed."""
    return {"id": "r", "source": "codex", "name": "Reader goblin", "parentThreadId": PARTY, "status": "idle",
            "updatedAt": time.time() * 1000 - 60_000,
            "turnStates": [{"id": "t1", "status": "completed", "questions": []}], "activities": list(events)}


WROTE = {"id": "r-write", "turnId": "t1", "kind": "file", "title": "Changed notes.md", "description": "notes.md",
         "status": "completed"}
READ = {"id": "r-read", "turnId": "t1", "kind": "command", "title": "Read a local file",
        "description": "Opened notes.md for inspection.", "status": "completed", "exitCode": 0}


def canvas_texts(canvas):
    return [canvas.itemcget(item, "text") for item in canvas.find_all() if canvas.type(item) == "text"]


def finish_all(widget):
    for actor_id in list(widget.exits):
        age_exit(widget, actor_id, EXIT_SECONDS + 0.01)
    widget.finish_exits()
    settle(widget)


def click_hint(widget, prefix):
    """Click the band target whose hint starts with ``prefix``."""
    dock = widget.party_dock
    box = next(box for box in dock.note_hitboxes if box[5].startswith(prefix))
    dock.on_member_click(SimpleNamespace(x=(box[0] + box[2]) // 2, y=(box[1] + box[3]) // 2))
    settle(widget)
    return box


def card_label(widget, actor_id):
    dock = widget.party_dock
    item = next(item for item, actor in dock.labels if actor["id"] == actor_id)
    return dock.body.itemcget(item, "text")


class Fixture:
    def __init__(self, test):
        self.folder = tempfile.TemporaryDirectory(prefix="goblin-parting-test-")
        self.env = patch.dict(os.environ, {"LOCALAPPDATA": self.folder.name})
        self.env.start()
        test.addCleanup(self.folder.cleanup)
        test.addCleanup(self.env.stop)

    def widget(self, test, reduced=False):
        widget = GoblinWidget(PARTY, 43917)
        test.addCleanup(widget.close)
        quiet(widget)
        widget.reduced_motion = reduced
        widget.open_viewer = lambda *_args, **_kwargs: None  # Never opens a browser from a test.
        return widget


@unittest.skipUnless(sys.platform == "win32", "Desktop widget requires Windows Tk")
class PortalFrameGeometryTests(unittest.TestCase):
    def test_every_portal_frame_fits_the_tile_the_card_and_the_portrait(self):
        fixture = Fixture(self)
        widget = fixture.widget(self)
        canvas = tk.Canvas(widget.root, width=200, height=200)
        style = widget.stream_style({"id": "a"})
        # (scale, sprite origin, box the drawing must stay inside)
        surfaces = {"roster tile": (2, ROSTER_SPRITE, (0, 0, *ROSTER_TILE)),
                    "dock card": (2, (4, 5), (0, 0, DOCK_CARD, 49)),
                    "portrait": (4, (0, 14), (0, 0, 97, 100))}
        for name, (scale, (ox, oy), (left, top, right, bottom)) in surfaces.items():
            drawn = []
            for still in (False, True):
                for beat in range(PORTAL_BEATS):
                    canvas.delete("all")
                    widget.draw_sprite(ox, oy, style, canvas=canvas, scale=scale, still=still,
                                       tag="goblin", exit_beat=beat)
                    items = canvas.find_withtag("goblin")
                    for item in items:
                        x1, y1, x2, y2 = canvas.coords(item)
                        with self.subTest(surface=name, beat=beat, still=still):
                            self.assertGreaterEqual(x1, left)
                            self.assertGreaterEqual(y1, top)
                            self.assertLessEqual(x2, right)
                            self.assertLessEqual(y2, bottom)
                    if not still:
                        drawn.append(sprite_items(canvas, "goblin"))
            # Every beat changes the picture, so the portal reads as motion even at 2x.
            for beat in range(PORTAL_BEATS - 1):
                self.assertNotEqual(drawn[beat], drawn[beat + 1], (name, beat))
            # The last frame is only the note left on the ground: no goblin, no portal.
            canvas.delete("all")
            widget.draw_sprite(ox, oy, style, canvas=canvas, scale=scale, tag="goblin", exit_beat=PORTAL_BEATS - 1)
            self.assertEqual({canvas.itemcget(item, "fill") for item in canvas.find_withtag("goblin")},
                             {"#10201a", "#f6ecd2", "#24352b", "#dfbb78"})


@unittest.skipUnless(sys.platform == "win32", "Desktop widget requires Windows Tk")
class CompactRetirementTests(unittest.TestCase):
    def test_a_finished_member_portals_out_once_and_leaves_a_reachable_note(self):
        fixture = Fixture(self)
        widget = fixture.widget(self)
        widget.condense_party()
        dock = widget.party_dock
        retire(widget, "a", [member("b")])

        # The portal plays on the member's own card, in its own place.
        self.assertIn("a", widget.exits)
        cards = dock_cards(widget)
        self.assertEqual(list(cards), [PARTY, "a", "b"])
        # Mid-portal the card already names the outcome, in the note's own words.
        self.assertEqual(card_label(widget, "a"), "✉ TURN DONE")
        self.assertEqual(dock.note_hitboxes, [])  # The note waits until the goblin is through.
        tag = next(tag for tag, *_rest, actor in dock.sprites if actor["id"] == "a")
        first = sprite_items(dock.body, tag)
        self.assertTrue(dock.body.find_withtag("exit"))
        age_exit(widget, "a", 3 * EXIT_BEAT_SECONDS + 0.01)
        dock.animate()
        self.assertNotEqual(sprite_items(dock.body, tag), first)

        # More reads of the same finished member never replay the portal or add notes.
        started = widget.exits["a"].start
        for _ in range(3):
            receive(widget, [member("a", "completed"), member("b")])
        self.assertEqual(widget.exits["a"].start, started)
        self.assertEqual(len(widget.notes.items), 1)

        age_exit(widget, "a", EXIT_SECONDS + 0.01)
        widget.finish_exits()
        settle(widget)
        self.assertNotIn("a", widget.exits)
        self.assertEqual(list(dock_cards(widget)), [PARTY, "b"])
        self.assertIn("✉ 1 NOTE", dock.status_text)
        self.assertNotIn("NEED YOU", dock.status_text)

        # The note band sits below every card, inside the window, with READ and × big enough to hit.
        band_top = min(box[1] for box in dock.note_hitboxes)
        self.assertGreaterEqual(band_top, max(box[3] for box in dock_cards(widget).values()))
        self.assertLessEqual(max(box[3] for box in dock.note_hitboxes), dock.body.winfo_height())
        self.assertGreaterEqual(dock.window.winfo_height(), dock.window.winfo_reqheight())
        for left, top, right, bottom, _command, hint in dock.note_hitboxes:
            self.assertGreaterEqual(right - left, NOTE_CHIP[0], hint)
            self.assertGreaterEqual(bottom - top, NOTE_CHIP[1], hint)
        texts = canvas_texts(dock.body)
        self.assertIn("READ", texts)
        self.assertIn("×", texts)
        self.assertTrue(any(text.startswith("✉ Goblin a · TURN DONE") for text in texts), texts)

        # One click on the band opens the party's notes; the note is factual and public.
        x1, y1, x2, y2 = dock.note_hitboxes[-1][:4]
        dock.on_member_click(SimpleNamespace(x=x1 + 12, y=(y1 + y2) // 2))
        settle(widget)
        panel = widget.notes_panel
        self.assertTrue(panel.window.winfo_ismapped())
        self.assertEqual(list(panel.cards), ["a"])
        shown = panel.text.get("1.0", "end") + " ".join(
            child.cget("text") for card in panel.cards.values() for child in card.winfo_children()[1].winfo_children()
            if isinstance(child, tk.Label))
        # The feed marked this as the answer of the turn that ended, so it is called final.
        self.assertIn("Final answer: “a wrapped up the synthetic task.”", shown)
        self.assertNotIn("Reported:", shown)
        self.assertIn("Seen in feed: changed app.py, notes.md · 1 command", shown)
        self.assertIn("CODEX · Its last turn completed · seen ", shown)
        for private in ("npm test", "SYNTHETIC OUTPUT"):
            self.assertNotIn(private, shown + repr(widget.notes.items))

        # The note survives a restart, and the retired goblin stays retired without replaying.
        # (Close first: Tk fonts belong to one interpreter, so two widgets never run at once.)
        widget.close()
        again = fixture.widget(self)
        again.condense_party()
        receive(again, [member("a", "completed"), member("b")])
        self.assertEqual(again.exits, {})
        self.assertEqual(list(dock_cards(again)), [PARTY, "b"])
        self.assertEqual([note["id"] for note in again.party_notes()], ["a"])

        # × on the band dismisses only that note; the goblin stays retired, and UNDO is offered.
        click_hint(again, "Dismiss")
        self.assertEqual(again.party_notes(), [])
        self.assertEqual([box[5] for box in again.party_dock.note_hitboxes], ["Bring back the note from Goblin a"])
        self.assertIn("✉ Dismissed the note from Goblin a", canvas_texts(again.party_dock.body))
        self.assertEqual(list(dock_cards(again)), [PARTY, "b"])
        click_hint(again, "Bring back")
        self.assertEqual([note["id"] for note in again.party_notes()], ["a"])
        self.assertIsNone(again.undo)

        # Dismissed for good this time: a restart with no note still keeps the goblin retired.
        click_hint(again, "Dismiss")
        again.close()
        third = fixture.widget(self)
        third.condense_party()
        receive(third, [member("a", "completed"), member("b")])
        self.assertEqual((third.exits, third.party_notes()), ({}, []))
        self.assertEqual(list(dock_cards(third)), [PARTY, "b"])
        self.assertEqual(third.party_dock.note_hitboxes, [])  # Undo does not survive a restart.

    def test_new_work_revives_the_goblin_and_removes_its_note(self):
        fixture = Fixture(self)
        widget = fixture.widget(self)
        widget.condense_party()
        retire(widget, "a", [member("b")])
        age_exit(widget, "a", EXIT_SECONDS + 0.01)
        widget.finish_exits()
        widget.show_notes("a")
        settle(widget)
        self.assertEqual(list(widget.notes_panel.cards), ["a"])

        receive(widget, [member("a"), member("b")])
        self.assertEqual(list(dock_cards(widget)), [PARTY, "a", "b"])
        self.assertEqual(widget.notes.items, [])
        self.assertEqual(widget.notes_panel.cards, {})
        self.assertEqual(widget.party_dock.note_hitboxes, [])

    def test_reduced_motion_skips_the_portal_and_shows_the_note_at_once(self):
        fixture = Fixture(self)
        widget = fixture.widget(self, reduced=True)
        widget.condense_party()
        retire(widget, "a", [member("b")])
        dock = widget.party_dock
        # No half-sunk still frame and later jump: the goblin is gone and its note is ready.
        self.assertEqual(widget.exits, {})
        self.assertEqual(list(dock_cards(widget)), [PARTY, "b"])
        self.assertFalse(dock.body.find_withtag("exit"))
        self.assertEqual([note["id"] for note in widget.party_notes()], ["a"])
        self.assertTrue(any(text.startswith("✉ Goblin a · TURN DONE") for text in canvas_texts(dock.body)))
        widget.animate()
        widget.root.after_cancel(widget.animate_after)
        self.assertEqual(list(dock_cards(widget)), [PARTY, "b"])

    def test_a_stopped_member_parts_quietly_and_says_so(self):
        fixture = Fixture(self)
        widget = fixture.widget(self)
        widget.condense_party()
        retire(widget, "a", [member("b")], turn="interrupted")
        self.assertEqual(widget.exit_outcome("a"), "stopped")
        self.assertEqual(card_label(widget, "a"), "✉ STOPPED")
        finish_all(widget)
        [note] = widget.party_notes()
        self.assertFalse(note["final"])
        self.assertTrue(any(text.startswith("✉ Goblin a · STOPPED") for text in canvas_texts(widget.party_dock.body)))

    def test_a_retired_goblin_that_completed_a_new_turn_comes_back_then_parts_again(self):
        fixture = Fixture(self)
        widget = fixture.widget(self)
        widget.condense_party()
        retire(widget, "a", [member("b")])
        finish_all(widget)
        self.assertEqual(list(dock_cards(widget)), [PARTY, "b"])
        # Between two polls it ran a whole new turn and finished it: the old note is stale.
        receive(widget, [next_turn("a"), member("b")])
        self.assertEqual(list(dock_cards(widget)), [PARTY, "a", "b"])
        self.assertEqual(widget.party_notes(), [])
        receive(widget, [next_turn("a"), member("b")])
        self.assertIn("a", widget.exits)
        finish_all(widget)
        [note] = widget.party_notes()
        self.assertEqual((note["reported"], note["final"]), ("Second synthetic task done.", True))
        # The same turn read again is not new work.
        for _ in range(3):
            receive(widget, [next_turn("a"), member("b")])
        self.assertEqual((widget.exits, list(dock_cards(widget))), ({}, [PARTY, "b"]))

    def test_cleared_notes_do_not_bring_retired_goblins_back_after_a_restart(self):
        fixture = Fixture(self)
        widget = fixture.widget(self)
        widget.condense_party()
        retire(widget, "a", [member("b")])
        finish_all(widget)
        widget.clear_notes()
        settle(widget)
        self.assertEqual(widget.notes.items, [])
        widget.close()
        saved = state_file().read_text(encoding="utf-8")
        self.assertIn('"retiredMarkers"', saved)
        for private in ("npm test", "SYNTHETIC OUTPUT", "wrapped up"):
            self.assertNotIn(private, saved.split('"retiredMarkers"')[1])
        again = fixture.widget(self)
        again.condense_party()
        receive(again, [member("a", "completed"), member("b")])
        self.assertEqual((again.exits, again.party_notes()), ({}, []))
        self.assertEqual(list(dock_cards(again)), [PARTY, "b"])
        # Only new work brings it back.
        receive(again, [member("a"), member("b")])
        self.assertEqual(list(dock_cards(again)), [PARTY, "a", "b"])

    def test_dismiss_and_clear_all_each_offer_one_undo_that_expires(self):
        fixture = Fixture(self)
        widget = fixture.widget(self)
        widget.condense_party()
        others = [member("c")]
        receive(widget, [member("a"), member("b"), *others])
        for _ in range(2):
            receive(widget, [member("a", "completed"), member("b", "completed"), *others])
        finish_all(widget)
        self.assertEqual(len(widget.party_notes()), 2)

        click_hint(widget, "Dismiss")
        self.assertEqual(len(widget.party_notes()), 1)
        click_hint(widget, "Bring back")
        self.assertEqual(len(widget.party_notes()), 2)

        widget.show_notes()
        settle(widget)
        panel = widget.notes_panel
        self.assertFalse(panel.undo_button.winfo_ismapped())
        panel.clear_button.invoke()
        settle(widget)
        self.assertEqual(widget.party_notes(), [])
        self.assertTrue(panel.undo_button.winfo_ismapped())
        self.assertIn("Dismissed 2 notes", panel.text.get("1.0", "end"))
        self.assertIn("✉ Dismissed 2 notes", canvas_texts(widget.party_dock.body))
        panel.undo_button.invoke()
        settle(widget)
        self.assertEqual(len(widget.party_notes()), 2)
        self.assertFalse(panel.undo_button.winfo_ismapped())

        # An UNDO not taken runs out, and the band forgets it.
        click_hint(widget, "Dismiss")
        widget.undo = widget.undo._replace(until=time.monotonic() - 1)
        widget.expire_undo()
        settle(widget)
        self.assertIsNone(widget.undo)
        self.assertFalse(any(box[5].startswith("Bring back") for box in widget.party_dock.note_hitboxes))
        self.assertEqual(len(widget.party_notes()), 1)

    def test_three_notes_panel_counts_scrolls_drags_and_a_single_note_stays_small(self):
        fixture = Fixture(self)
        widget = fixture.widget(self)
        widget.condense_party()

        def wordy(member_id):
            # A long public answer wraps over several lines, so three cards always overflow.
            actor = member(member_id, "completed")
            actor["activities"][-1]["description"] = f"{member_id} summarised the synthetic task. " * 8
            return actor
        receive(widget, [member("a"), member("b"), member("c"), member("d")])
        for _ in range(2):
            receive(widget, [wordy("a"), wordy("b"), wordy("c"), member("d")])
        finish_all(widget)
        widget.show_notes()
        settle(widget)
        panel = widget.notes_panel
        self.assertTrue(panel.title.cget("text").startswith("✉ 3 NOTES · Synthetic party"))
        self.assertEqual(sorted(panel.cards), ["a", "b", "c"])
        self.assertTrue(panel.scrollbar.winfo_ismapped())
        self.assertLessEqual(panel.window.winfo_height(), NotesPanel.HEIGHT)
        # Three notes overflow the panel; the wheel scrolls from anywhere, buttons included.
        self.assertLess(panel.text.yview()[1], 1.0)
        for card in panel.cards.values():
            buttons = [child for child in card.winfo_children()[1].winfo_children()[-1].winfo_children()]
            self.assertTrue(all(button.bind("<MouseWheel>") for button in buttons))
        self.assertEqual(panel.on_wheel(SimpleNamespace(delta=-120)), "break")
        settle(widget)
        self.assertGreater(panel.text.yview()[0], 0.0)
        # Dragged by its header, it stays where it was put when its notes change.
        x, y = panel.window.winfo_x(), panel.window.winfo_y()
        panel.start_drag(SimpleNamespace(x_root=600, y_root=400))
        panel.drag(SimpleNamespace(x_root=570, y_root=380))
        panel.end_drag(None)
        settle(widget)
        self.assertEqual((panel.window.winfo_x(), panel.window.winfo_y()), (x - 30, y - 20))
        tall = panel.height
        widget.dismiss_note(PARTY, "a")
        widget.dismiss_note(PARTY, "b")
        settle(widget)
        self.assertEqual((panel.window.winfo_x(), panel.window.winfo_y()), (x - 30, y - 20))
        self.assertTrue(panel.title.cget("text").startswith("✉ 1 NOTE · "))
        # One note is a short card, not a tall empty box: it fits whole with little room below.
        self.assertLess(panel.height, tall)
        self.assertLess(panel.window.winfo_height(), NotesPanel.HEIGHT)
        self.assertEqual(panel.text.yview(), (0.0, 1.0))
        [card] = panel.cards.values()
        self.assertLess(panel.text.winfo_height() - (card.winfo_y() + card.winfo_height()), 60)

    def test_the_hidden_tab_counts_new_notes_and_opens_them_from_the_roster(self):
        fixture = Fixture(self)
        widget = fixture.widget(self)
        widget.condense_party()
        retire(widget, "a", [member("b")])
        finish_all(widget)
        widget.hide_party()
        settle(widget)
        dock = widget.party_dock
        self.assertIn("✉ 1 NEW", dock.mini_badge.cget("text"))
        self.assertTrue(dock.mini_notes.winfo_ismapped())
        self.assertEqual(dock.mini_notes.cget("text"), "✉ 1")
        right = dock.window.winfo_rootx() + dock.window.winfo_width()
        for button in (dock.mini_notes, *dock.mini_buttons):
            self.assertLessEqual(button.winfo_rootx() + button.winfo_width(), right)
        dock.mini_notes.invoke()
        settle(widget)
        # The roster is the party's launchpad: the notes open beside it, and are now read.
        self.assertEqual((widget.display_mode, dock.mode), ("compact", "compact"))
        self.assertTrue(widget.notes_panel.window.winfo_ismapped())
        self.assertTrue(all(note["read"] for note in widget.party_notes()))
        widget.hide_party()
        settle(widget)
        self.assertNotIn("NEW", dock.mini_badge.cget("text"))
        self.assertEqual(dock.mini_notes.cget("text"), "✉ 1")
        # With no notes at all, the tab carries no note button.
        widget.clear_notes()
        widget.undo = None
        dock.refresh()
        settle(widget)
        self.assertFalse(dock.mini_notes.winfo_ismapped())

    def test_a_replayed_read_says_checked_on_its_card_until_the_pulse_ends(self):
        fixture = Fixture(self)
        widget = fixture.widget(self)
        widget.condense_party()
        receive(widget, [reader(WROTE)])
        self.assertEqual(card_label(widget, "r"), "– IDLE")
        receive(widget, [reader(WROTE, READ)])
        self.assertEqual(card_label(widget, "r"), "✓ CHECKED")
        with patch("goblin_motion.time.time", return_value=time.time() + 10):
            widget.party_dock.sync_labels()
        self.assertEqual(card_label(widget, "r"), "– IDLE")

    def test_partial_feeds_and_missing_members_do_not_spam_notes(self):
        fixture = Fixture(self)
        widget = fixture.widget(self)
        widget.condense_party()
        receive(widget, [member("a"), member("b"), member("c")])
        # Warned reads never confirm an ending.
        for _ in range(4):
            receive(widget, [member("a", "completed"), member("b"), member("c")], warning="Some party members could not be read.")
        self.assertEqual((widget.exits, widget.notes.items), ({}, []))
        self.assertEqual(widget.connection, "PARTIAL")
        # A member missing from a partial read just disappears as before; nothing is claimed.
        receive(widget, [member("a"), member("c")], warning="Some party members could not be read.")
        receive(widget, [member("a"), member("c")], warning="Some party members could not be read.")
        self.assertEqual(widget.notes.items, [])
        # Missing from one complete read: held in its place; from a second: it portals out as LEFT.
        receive(widget, [member("a"), member("b"), member("c")])
        receive(widget, [member("a"), member("c")])
        self.assertEqual(list(dock_cards(widget)), [PARTY, "a", "b", "c"])
        self.assertEqual(widget.notes.items, [])
        receive(widget, [member("a"), member("c")])
        self.assertIn("b", widget.exits)
        self.assertEqual(list(dock_cards(widget)), [PARTY, "a", "b", "c"])
        age_exit(widget, "b", EXIT_SECONDS + 0.01)
        widget.finish_exits()
        settle(widget)
        self.assertEqual(list(dock_cards(widget)), [PARTY, "a", "c"])
        [note] = widget.party_notes()
        self.assertEqual(note["outcome"], "left")
        # The whole party vanishing at once is a feed gap, not departures.
        receive(widget, [])
        receive(widget, [])
        self.assertEqual(len(widget.notes.items), 1)
        self.assertEqual(widget.exits, {})

    def test_reselecting_a_party_never_replays_a_portal(self):
        fixture = Fixture(self)
        widget = fixture.widget(self)
        widget.condense_party()
        retire(widget, "a", [member("b")])
        self.assertIn("a", widget.exits)
        widget.follow_source("another-party-0002", "Another", open_party=True)
        self.assertEqual(widget.exits, {})
        self.assertEqual(widget.party_notes(), [])
        widget.follow_source(PARTY, "Synthetic party", open_party=True)
        receive(widget, [member("a", "completed"), member("b")])
        self.assertEqual(widget.exits, {})
        self.assertEqual(list(dock_cards(widget)), [PARTY, "b"])
        self.assertEqual(len(widget.party_notes()), 1)


@unittest.skipUnless(sys.platform == "win32", "Desktop widget requires Windows Tk")
class ExpandedRetirementTests(unittest.TestCase):
    def test_an_open_stream_keeps_its_place_and_pins_the_note(self):
        fixture = Fixture(self)
        widget = fixture.widget(self)
        receive(widget, [member("a"), member("b")])
        widget.open_party("a")
        settle(widget)
        stream = widget.streams["a"]
        place = (stream.x, stream.y)
        self.assertTrue(stream.window.winfo_ismapped())

        receive(widget, [member("a", "completed"), member("b")])
        receive(widget, [member("a", "completed"), member("b")])
        self.assertIn("a", widget.exits)
        stream.render_sprite()
        self.assertTrue(stream.sprite.find_withtag("exit"))
        self.assertIsNone(stream.note_frame)
        age_exit(widget, "a", EXIT_SECONDS + 0.01)
        widget.finish_exits()
        receive(widget, [member("a", "completed"), member("b")])

        self.assertTrue(stream.window.winfo_ismapped())
        self.assertEqual((stream.x, stream.y), place)
        self.assertIsNotNone(stream.note_frame)
        self.assertTrue(stream.note_frame.winfo_ismapped())
        # One story in the header: parted, how, and a log that has ended rather than one following.
        self.assertTrue(stream.name_label.cget("text").startswith("✉  Goblin a"))
        self.assertEqual(stream.note_title.cget("text"), "✉ PARTING NOTE · TURN DONE")
        self.assertTrue(stream.state_label.cget("text").startswith("CODEX · PARTED · TURN DONE"),
                        stream.state_label.cget("text"))
        self.assertNotIn("IDLE", stream.state_label.cget("text"))
        self.assertEqual((stream.follow_button.cget("text"), str(stream.follow_button.cget("state"))),
                         ("LOG ENDED", "disabled"))
        self.assertEqual(stream.follow_button.cget("disabledforeground"), MUTED)
        self.assertIn("ENDED", stream.footer_label.cget("text"))
        stream.set_follow(True)  # Scrolling to the bottom cannot restart following.
        self.assertEqual(stream.follow_button.cget("text"), "LOG ENDED")
        # The pinned note's window is not a live tile: every rail counts the two live members.
        for item in widget.streams.values():
            if item.window.winfo_ismapped():
                self.assertEqual(item.roster_hint.cget("text"), "2/2 TILES", item.actor_id)
        # The note card sits inside the dialogue box, above the field log, with clearance, and
        # the log opens on its last TURN header, whole, rather than tucked under the parchment.
        self.assertLess(stream.note_frame.winfo_y() + stream.note_frame.winfo_height(),
                        stream.text_frame.winfo_y())
        stream._show_final_turn()
        settle(widget)
        turns = stream.text.tag_ranges("turn")
        self.assertTrue(turns)
        line = stream.text.dlineinfo(turns[-2])
        self.assertIsNotNone(line)
        self.assertGreaterEqual(line[1], 0)
        # The other member's rail no longer shows the retired goblin.
        self.assertEqual([actor["id"] for actor in widget.streams["b"].party], [PARTY, "b"])

        # Closing the stream is not dismissing the note.
        stream.close()
        settle(widget)
        self.assertNotIn("a", widget.streams)
        self.assertEqual([note["id"] for note in widget.party_notes()], ["a"])
        receive(widget, [member("a", "completed"), member("b")])
        self.assertNotIn("a", widget.streams)

    def test_dismiss_on_the_pinned_note_removes_only_the_note(self):
        fixture = Fixture(self)
        widget = fixture.widget(self)
        receive(widget, [member("a"), member("b")])
        widget.open_party("a")
        retire(widget, "a", [member("b")])
        age_exit(widget, "a", EXIT_SECONDS + 0.01)
        widget.finish_exits()
        settle(widget)
        stream = widget.streams["a"]
        dismiss = next(button for button in stream.note_buttons if button.cget("text") == "DISMISS")
        dismiss.invoke()
        settle(widget)
        self.assertEqual(widget.notes.items, [])
        self.assertTrue(stream.window.winfo_ismapped())
        # A slim strip takes the card's place for one UNDO; the only copy is never lost silently.
        self.assertEqual([button.cget("text") for button in stream.note_buttons], ["UNDO"])
        stream.note_buttons[0].invoke()
        settle(widget)
        self.assertEqual([note["id"] for note in widget.notes.items], ["a"])
        self.assertEqual(stream.note_title.cget("text"), "✉ PARTING NOTE · TURN DONE")
        # Once the undo has run out the strip goes too.
        next(button for button in stream.note_buttons if button.cget("text") == "DISMISS").invoke()
        widget.undo = widget.undo._replace(until=time.monotonic() - 1)
        widget.expire_undo()
        settle(widget)
        self.assertIsNone(stream.note_frame)

    def test_a_replayed_read_is_named_in_the_past_tense_in_the_stream_header(self):
        fixture = Fixture(self)
        widget = fixture.widget(self)
        receive(widget, [reader(WROTE)])
        widget.open_party("r")
        settle(widget)
        stream = widget.streams["r"]
        self.assertIn("IDLE", stream.state_label.cget("text"))
        receive(widget, [reader(WROTE, READ)])
        text = stream.state_label.cget("text")
        self.assertIn("CHECKED", text)
        self.assertNotIn("IDLE", text)
        # The word expires with the motion on the next beat, without waiting for a poll.
        with patch("goblin_motion.time.time", return_value=time.time() + 10):
            stream.refresh_state()
        self.assertIn("IDLE", stream.state_label.cget("text"))


if __name__ == "__main__":
    unittest.main()


@unittest.skipUnless(sys.platform == "win32", "Desktop widget requires Windows Tk")
class StreamHeaderTests(unittest.TestCase):
    def test_a_long_name_keeps_one_line_so_the_status_and_model_row_stays_visible(self):
        fixture = Fixture(self)
        widget = fixture.widget(self)
        long_name = "Client-facing requirements and flow-map package for the quarterly review"
        model = {"id": "claude-opus-5-5", "label": "Opus 5.5", "family": "claude"}
        receive(widget, [member("a", name=long_name, nickname=long_name, model=model), member("b")])
        widget.open_party("a")
        settle(widget)
        stream = widget.streams["a"]
        stream.window.update_idletasks()
        text = stream.name_label.cget("text")
        self.assertTrue(text.endswith("…"), text)
        self.assertLessEqual(stream.name_font.measure(text), stream.name_label.master.winfo_width())
        # The status and model row sits fully inside the fixed-height header.
        row = stream.state_label.master
        self.assertLessEqual(row.winfo_y() + row.winfo_reqheight(), row.master.winfo_height())
        self.assertEqual(stream.model_label.cget("text"), "◈ OPUS 5.5")
