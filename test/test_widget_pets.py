"""The widget around the pet field: it starts in the field, its menu, what it saves, quitting, and
closing. The widget is the real one, with no server to answer it and the field parked off every
display."""

import json
import sys
import threading
import tkinter as tk
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import desktop_platform
import desktop_windows
import horde_api
import pet_field
from desktop_widget import QUIT_LABEL, GoblinWidget
from pets_feed import WAITING, Feed, read_game
from pets_text import UPDATE_FAILED

try:
    from test_pets_feed import game
    from widget_fixtures import isolate, settle, wait_for
except ImportError:
    from test.test_pets_feed import game
    from test.widget_fixtures import isolate, settle, wait_for

DISPLAY = pet_field.Display(-4000, -3000, 800, 600, 560)
SCREENS = [desktop_platform.Screen(0, 0, 2560, 1440, 1392, True),
           desktop_platform.Screen(2560, 0, 3640, 1920, 1872, False)]
CLICK = SimpleNamespace(x_root=60, y_root=60)


def labels(menu: tk.Menu) -> list[str]:
    return ["-" if menu.type(index) == "separator" else menu.entrycget(index, "label") for index in range(menu.index("end") + 1)]


@unittest.skipUnless(sys.platform == "win32", "Builds the real widget with Windows Tk")
class PetsWidgetTests(unittest.TestCase):
    def setUp(self):
        self.folder = isolate(self)
        self.screens = []
        for target, name, options in ((pet_field, "field_display", {"return_value": DISPLAY}),
                                      (desktop_platform, "screens", {"side_effect": lambda: self.screens}),
                                      (desktop_windows, "foreground_is_fullscreen", {"return_value": False}),
                                      (horde_api.HordeApi, "get", {"side_effect": OSError("no server")}),
                                      (horde_api.HordeApi, "post", {"side_effect": OSError("no server")})):
            patcher = patch.object(target, name, **options)
            patcher.start()
            self.addCleanup(patcher.stop)

    def make(self, saved: dict | None = None) -> GoblinWidget:
        if saved is not None:
            (Path(self.folder) / "goblins.json").write_text(json.dumps(saved), encoding="utf-8")
        widget = GoblinWidget(44193)
        self.addCleanup(widget.close)
        self.addCleanup(lambda: self.assertEqual(widget.error_count, 0, "a Tk callback raised"))
        settle(widget)
        return widget

    def saved(self) -> dict:
        return json.loads((Path(self.folder) / "goblins.json").read_text(encoding="utf-8"))

    def menu(self, show) -> tk.Menu:
        """The menu a show_* method would pop up, without popping it up."""
        with patch.object(tk.Menu, "tk_popup", autospec=True) as popup:
            show(CLICK)
        return popup.call_args.args[0]

    def test_it_starts_in_the_field_with_the_root_hidden(self):
        widget = self.make()
        field = widget.field
        self.assertEqual((widget.root.state(), field.window.state()), ("withdrawn", "normal"))
        self.assertTrue(field.shown)
        wait_for(widget, lambda: not field.polling and field.status == WAITING["offline"])
        field.frame(field.last + 0.03)
        self.assertEqual(field.canvas.itemcget(field.paint.hud_label, "text"), WAITING["offline"],
                         "no game yet: the pill says why and the field keeps asking")
        self.assertIsNotNone(field.poll_after)

    def test_an_older_widgets_settings_start_the_field_and_survive(self):
        widget = self.make(saved={"surface": "window", "aliases": {"a": "Grub"}, "petScreen": 1})
        self.assertTrue(widget.field.shown, "whatever an older widget last showed, the field starts")
        self.assertEqual(widget.field.screen, 1)
        widget.toggle_reduced_motion()
        saved = self.saved()
        self.assertEqual((saved["surface"], saved["aliases"]), ("window", {"a": "Grub"}), "the other settings are kept")

    def test_the_menu_lists_the_game_then_how_the_goblins_show_then_quit(self):
        widget = self.make()
        field = widget.field
        waiting = labels(self.menu(widget.show_pets_menu))
        self.assertEqual(waiting, [field.status, "-", "Hide the goblins", "Reduced motion", "-", QUIT_LABEL])
        field.take_feed(Feed(True, "", (), read_game(game(coins=64, size=5, cleared=2)), {"ok": True}), field.epoch)
        field.rest()
        menu = widget.pets_menu()
        shown = labels(menu)
        self.assertEqual(shown[:5], ["Recruit a goblin (41 coins)", "Level up to 3 (21 coins, 52 XP)", "Gear tier 2 (36 scrap)",
                                     "Hoard 2, more coins from work (60 coins)", "Training 1, more XP from work (30 coins)"])
        self.assertEqual(shown[5], "Grip 1, pick up 2 goblins at once (50 coins)")
        self.assertEqual([str(menu.entrycget(index, "state")) for index in range(6)],
                         ["normal", "disabled", "disabled", "normal", "normal", "normal"])
        self.assertEqual(shown[6:], ["-", "Send the horde to Boss 3, Pebblebrute", "Rerun a boss", "-",
                                     "Hide the goblins", "Reduced motion", "-", QUIT_LABEL])
        reruns = menu.nametowidget(menu.entrycget(shown.index("Rerun a boss"), "menu"))
        self.assertEqual(labels(reruns), ["Boss 2, Mosswart", "Boss 1, Mudback"])
        with patch.object(field, "buy") as buy, patch.object(field, "fight") as fight:
            menu = widget.pets_menu()
            menu.invoke(0)
            menu.invoke(shown.index("Send the horde to Boss 3, Pebblebrute"))
            reruns = menu.nametowidget(menu.entrycget(shown.index("Rerun a boss"), "menu"))
            reruns.invoke(1)
        buy.assert_called_once_with("recruit")
        self.assertEqual([call.args for call in fight.call_args_list], [(2,), (0,)])
        menu.invoke(shown.index("Hide the goblins"))
        self.assertIn("Show the goblins", labels(widget.pets_menu()))

    def test_moving_to_another_screen_from_the_menu_is_kept_for_the_next_start(self):
        widget = self.make()
        self.screens = SCREENS
        menu = widget.pets_menu()
        shown = labels(menu)
        self.assertEqual(shown[shown.index("Hide the goblins"):], ["Hide the goblins", "Move to screen", "Reduced motion", "-", QUIT_LABEL])
        choices = menu.nametowidget(menu.entrycget(shown.index("Move to screen"), "menu"))
        self.assertEqual(labels(choices), ["Screen 1, 2560 x 1440 (main)", "Screen 2, 1080 x 1920"])
        choices.invoke(1)
        self.assertEqual((widget.field.screen, self.saved()["petScreen"]), (1, 1))
        widget.close()
        self.assertEqual(self.make().field.screen, 1)

    def test_reduced_motion_from_the_menu_reaches_the_field(self):
        widget = self.make()
        widget.reduced_motion = False
        menu = widget.pets_menu()
        menu.invoke(labels(menu).index("Reduced motion"))
        self.assertTrue(widget.reduced_motion)
        self.assertTrue(self.saved()["reducedMotion"])
        field = widget.field
        with patch.object(field.paint, "crowd", wraps=field.paint.crowd) as crowd:
            field.frame(field.last + 0.1)
        self.assertIs(crowd.call_args.args[1], True, "the field draws still frames")

    def test_an_update_the_viewer_keeps_is_offered_above_quit_and_choosing_it_asks_the_server_to_put_it_in_place(self):
        widget = self.make()
        field = widget.field
        self.assertFalse(any("Update" in label for label in labels(widget.pets_menu())), "no row while no update waits")
        field.take_feed(Feed(True, "", (), read_game(game()), {"ok": True}, "0.6.1"), field.epoch)
        field.rest()
        menu = widget.pets_menu()
        shown = labels(menu)
        self.assertEqual(shown[-3:], ["-", "Update to 0.6.1 and restart", QUIT_LABEL])
        with patch.object(horde_api.HordeApi, "post", return_value={"applying": True, "version": "0.6.1"}) as post:
            menu.invoke(shown.index("Update to 0.6.1 and restart"))
            wait_for(widget, lambda: post.called)
            settle(widget)
        post.assert_called_once_with("/api/update/apply")
        self.assertEqual([text for text, _born in field.notices], ["Updating to 0.6.1. The goblins are back in a moment."])
        self.assertFalse(widget.closing, "the goblins stay until this installation's manager stops them")

    def test_an_update_that_did_not_start_says_so(self):
        widget = self.make()
        field = widget.field
        field.take_feed(Feed(False, WAITING["opening"], update="0.6.1"), field.epoch)
        field.rest()
        self.assertIn("Update to 0.6.1 and restart", labels(widget.pets_menu()), "offered while the game is not open, too")
        widget.apply_update()
        wait_for(widget, lambda: UPDATE_FAILED in [text for text, _born in field.notices])

    def test_quit_asks_the_server_to_stop_and_closes(self):
        widget = self.make()
        window = widget.field.window
        with patch.object(horde_api.HordeApi, "post", return_value={"ok": True}) as post:
            menu = widget.pets_menu()
            menu.invoke(labels(menu).index(QUIT_LABEL))
            for thread in threading.enumerate():
                if thread.name == "goblin-horde-quit":
                    thread.join(5)
        post.assert_called_once_with("/api/quit")
        self.assertTrue(widget.closing)
        with self.assertRaises(tk.TclError):
            window.state()

    def test_closing_frees_the_field(self):
        widget = self.make()
        window = widget.field.window
        widget.close()
        self.assertEqual(widget.error_count, 0)
        with self.assertRaises(tk.TclError):
            window.state()

    def test_a_failing_callback_is_counted_and_the_widget_keeps_running(self):
        widget = GoblinWidget(44193)
        self.addCleanup(widget.close)
        with patch.object(sys, "stderr", None):
            widget.root.after(0, lambda: 1 / 0)
            settle(widget)
        self.assertEqual(widget.error_count, 1)
        log = (Path(self.folder) / "run" / "widget.log").read_text(encoding="utf-8")
        self.assertIn("ZeroDivisionError", log)
        self.assertTrue(widget.root.winfo_exists())
        self.assertTrue(widget.field.shown)


if __name__ == "__main__":
    unittest.main()
