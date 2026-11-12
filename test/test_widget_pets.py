"""The pet field as one of the widget's surfaces: starting in it, switching to it and back, what is
saved, and its menu. The widget is the real one, with no viewer to answer it and the field parked off
every display."""

import json
import sys
import tkinter as tk
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import desktop_platform
import desktop_windows
import horde_api
import pet_field
from desktop_widget import PETS_LABEL, QUIT_LABEL, GoblinWidget, starting_surface
from horde_model import SURFACES, read_settings
from pets_feed import WAITING, Feed, read_game
from pets_text import TASK_VIEW_LABEL

try:
    from test_pets_feed import game
    from widget_fixtures import isolate, quiet, settle, wait_for
except ImportError:
    from test.test_pets_feed import game
    from test.widget_fixtures import isolate, quiet, settle, wait_for

DISPLAY = pet_field.Display(-4000, -3000, 800, 600, 560)
CLICK = SimpleNamespace(x_root=60, y_root=60)


def labels(menu: tk.Menu) -> list[str]:
    return ["-" if menu.type(index) == "separator" else menu.entrycget(index, "label") for index in range(menu.index("end") + 1)]


class StartingSurfaceTests(unittest.TestCase):
    def test_only_the_pet_field_is_remembered_from_one_start_to_the_next(self):
        cases = {
            ("", "window"): "window", ("", "strip"): "window", ("", "pets"): "pets",
            ("strip", "window"): "strip", ("strip", "strip"): "strip", ("strip", "pets"): "pets",
            ("window", "pets"): "window", ("window", "strip"): "window",
            ("pets", "window"): "pets", ("pets", "strip"): "pets", ("pets", "pets"): "pets",
            ("nowhere", "window"): "window",
        }
        for (asked, saved), surface in cases.items():
            with self.subTest(asked=asked, saved=saved):
                self.assertEqual(starting_surface(asked, saved, True), surface)

    def test_where_the_field_cannot_be_shown_nothing_changes(self):
        for asked in ("", "window", "strip", "pets"):
            for saved in SURFACES:
                with self.subTest(asked=asked, saved=saved):
                    self.assertEqual(starting_surface(asked, saved, False), "strip" if asked == "strip" else "window")

    def test_a_saved_pets_surface_is_read_back(self):
        self.assertEqual(read_settings({"surface": "pets"})["surface"], "pets")
        self.assertEqual(read_settings({"surface": "moon"})["surface"], "window")


@unittest.skipUnless(sys.platform == "win32", "Builds the real window with Windows Tk")
class PetsSurfaceTests(unittest.TestCase):
    def setUp(self):
        self.folder = isolate(self)
        for target, name, options in ((pet_field, "primary_display", {"return_value": DISPLAY}),
                                      (desktop_windows, "foreground_is_fullscreen", {"return_value": False}),
                                      (desktop_platform, "find_app_window", {"return_value": None}),
                                      (horde_api.HordeApi, "get", {"side_effect": OSError("no viewer")}),
                                      (horde_api.HordeApi, "post", {"side_effect": OSError("no viewer")})):
            patcher = patch.object(target, name, **options)
            patcher.start()
            self.addCleanup(patcher.stop)

    def make(self, surface: str = "", saved: dict | None = None, **options) -> GoblinWidget:
        if saved is not None:
            (Path(self.folder) / "goblins.json").write_text(json.dumps(saved), encoding="utf-8")
        widget = GoblinWidget("", 44193, surface=surface, **options)
        self.addCleanup(widget.close)
        self.addCleanup(lambda: self.assertEqual(widget.error_count, 0, "a Tk callback raised"))
        quiet(widget)
        settle(widget)
        return widget

    def saved(self) -> dict:
        return json.loads((Path(self.folder) / "goblins.json").read_text(encoding="utf-8"))

    def menu(self, show) -> tk.Menu:
        """The menu a show_* method would pop up, without popping it up."""
        with patch.object(tk.Menu, "tk_popup", autospec=True) as popup:
            show(CLICK)
        return popup.call_args.args[0]

    def states(self, widget) -> tuple:
        field = widget.field.window.state() if widget.field is not None else "none"
        return widget.surface, widget.root.state(), widget.strip.window.state(), field

    def test_surface_pets_starts_in_the_field_with_the_window_and_the_strip_away(self):
        widget = self.make("pets")
        self.assertEqual(self.states(widget), ("pets", "withdrawn", "withdrawn", "normal"))
        self.assertTrue(widget.field.shown)
        field = widget.field
        wait_for(widget, lambda: not field.polling and field.status == WAITING["offline"])
        field.frame(field.last + 0.03)
        self.assertEqual(field.canvas.itemcget(field.paint.hud_label, "text"), WAITING["offline"],
                         "no game yet: the pill says why and the field keeps asking")
        self.assertIsNotNone(field.poll_after)
        self.assertIs(widget.dialog_parent(), field.window)

    def test_the_pets_surface_is_saved_and_starts_again(self):
        widget = self.make("pets")
        widget.close()
        self.assertEqual(self.saved()["surface"], "pets")
        again = self.make()
        self.assertEqual(self.states(again), ("pets", "withdrawn", "withdrawn", "normal"))
        again.close()
        signed_in = self.make("strip")
        self.assertEqual(signed_in.surface, "pets", "the sign-in start brings the goblins back too")
        signed_in.close()
        asked = self.make("window")
        wait_for(asked, lambda: asked.root.state() == "normal")
        quiet(asked)
        self.assertEqual(asked.surface, "window")
        self.assertIsNone(asked.field, "the field is not even made until it is asked for")
        asked.close()
        self.assertEqual(self.saved()["surface"], "window")

    def test_asking_for_the_pets_surface_saves_it_at_once(self):
        self.make("pets", saved={"surface": "window", "aliases": {"a": "Grub"}})
        saved = self.saved()
        self.assertEqual(saved["surface"], "pets", "a run stopped without its Quit still comes back to the field")
        self.assertEqual(saved["aliases"], {"a": "Grub"}, "the other settings are kept")

    def test_the_default_surface_is_still_the_window(self):
        widget = self.make()
        wait_for(widget, lambda: widget.root.state() == "normal")
        quiet(widget)
        self.assertEqual(widget.surface, "window")
        self.assertIsNone(widget.field)
        strip = self.make("strip", saved={"surface": "strip"})
        self.assertEqual(self.states(strip), ("strip", "withdrawn", "normal", "none"))

    def test_the_menus_gain_goblin_pets_and_it_switches_to_the_field(self):
        widget = self.make()
        wait_for(widget, lambda: widget.root.state() == "normal")
        quiet(widget)
        self.assertIn(PETS_LABEL, labels(self.menu(widget.show_strip_menu)))
        menu = self.menu(widget.show_menu)
        self.assertIn(PETS_LABEL, labels(menu))
        self.assertIn(TASK_VIEW_LABEL, labels(menu))
        menu.invoke(labels(menu).index(PETS_LABEL))
        settle(widget)
        self.assertEqual(self.states(widget), ("pets", "withdrawn", "withdrawn", "normal"))
        self.assertEqual(self.saved()["surface"], "pets")

    def test_back_to_the_horde_window_restores_the_window_and_the_strip(self):
        widget = self.make("pets")
        menu = self.menu(widget.show_pets_menu)
        menu.invoke(labels(menu).index("Back to the Horde window"))
        quiet(widget)
        settle(widget)
        self.assertEqual(self.states(widget), ("window", "normal", "normal", "withdrawn"))
        field = widget.field
        self.assertEqual((field.shown, field.frame_after, field.poll_after), (False, None, None), "the field rests")
        self.assertEqual(self.saved()["surface"], "window")
        widget.show_pets()
        self.assertEqual(self.states(widget), ("pets", "withdrawn", "withdrawn", "normal"))
        self.assertIs(widget.field, field, "the same field comes back")

    def test_the_demo_has_no_game_so_it_offers_no_pets(self):
        widget = self.make("pets", demo=True)
        self.assertEqual(widget.surface, "window")
        self.assertNotIn(PETS_LABEL, labels(self.menu(widget.show_menu)))
        self.assertNotIn(PETS_LABEL, labels(self.menu(widget.show_strip_menu)))

    def test_the_pets_menu_lists_the_game_then_what_every_menu_ends_with(self):
        widget = self.make("pets")
        field = widget.field
        waiting = labels(self.menu(widget.show_pets_menu))
        self.assertEqual(waiting[0], field.status)
        self.assertEqual(waiting[-6:], ["Back to the Horde window", "-", "Reduced motion", "Phone access (Wi-Fi): Off", "-", QUIT_LABEL])
        field.take_feed(Feed(True, "", (), read_game(game(coins=64, size=5, cleared=2)), {"ok": True}), field.epoch)
        quiet(widget)
        field.rest()
        menu = widget.pets_menu()
        shown = labels(menu)
        self.assertEqual(shown[:5], ["Recruit a goblin (41 coins)", "Level up to 3 (21 coins, 52 XP)", "Gear tier 2 (36 scrap)",
                                     "Hoard 2, more coins from work (60 coins)", "Training 1, more XP from work (30 coins)"])
        self.assertEqual([str(menu.entrycget(index, "state")) for index in range(5)],
                         ["normal", "disabled", "disabled", "normal", "normal"])
        self.assertEqual(shown[5:9], ["-", "Send the horde to Boss 3, Pebblebrute", "Rerun a boss", "-"])
        self.assertEqual(shown[9:12], [TASK_VIEW_LABEL, "Hide the goblins", "Back to the Horde window"])
        self.assertNotIn("Keep on top", shown, "the field is always on top")
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

    def test_reduced_motion_from_the_pets_menu_reaches_the_field(self):
        widget = self.make("pets")
        widget.reduced_motion = False
        menu = widget.pets_menu()
        menu.invoke(labels(menu).index("Reduced motion"))
        self.assertTrue(widget.reduced_motion)
        self.assertTrue(self.saved()["reducedMotion"])
        field = widget.field
        with patch.object(field.paint, "crowd", wraps=field.paint.crowd) as crowd:
            field.frame(field.last + 0.1)
        self.assertIs(crowd.call_args.args[1], True, "the field draws still frames")

    def test_the_task_view_opens_beside_the_field_without_the_strip(self):
        widget = self.make("pets")
        with patch.object(horde_api.HordeApi, "post", return_value={"opened": True}) as post:
            widget.open_app()
            wait_for(widget, lambda: post.called)
            settle(widget)
        self.assertEqual(post.call_args.args[0], "/api/app/open")
        self.assertEqual(self.states(widget), ("pets", "withdrawn", "withdrawn", "normal"))

    def test_closing_in_the_field_frees_it(self):
        widget = self.make("pets")
        window = widget.field.window
        widget.close()
        self.assertEqual(widget.error_count, 0)
        with self.assertRaises(tk.TclError):
            window.state()


if __name__ == "__main__":
    unittest.main()
