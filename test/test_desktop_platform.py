"""macOS window setup for the desktop goblins, checked with mocks on any host.

These do not prove the widget runs on a Mac (that needs a Mac; see README "macOS smoke check").
They pin what the widget asks Tk for on macOS, and that Windows still gets exactly what it had."""

import os
import subprocess
import sys
import tempfile
import tkinter as tk
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import desktop_platform
from desktop_platform import (MAC_CLEAR, WINDOWS_KEY, TransparencyUnavailable, bind_context, check_support,
                              context_events, float_window, mac_prefers_reduced_motion, make_transparent,
                              prepare_app, ui_family, ui_font)


def on(platform):
    return patch.object(desktop_platform, "system", return_value=platform)


def fake_root(windowing="aqua", version="8.6"):
    root = MagicMock()
    root.tk.call.side_effect = lambda *args: windowing if args == ("tk", "windowingsystem") else None
    root.getvar.side_effect = lambda name: version if name == "tk_version" else None
    return root


class MacWindowSetupTests(unittest.TestCase):
    def test_mac_transparency_uses_aqua_transparent_attribute_and_system_transparent(self):
        window = MagicMock()
        with on("darwin"):
            clear = make_transparent(window)
        self.assertEqual(clear, MAC_CLEAR)
        window.wm_attributes.assert_called_once_with("-transparent", True)
        window.configure.assert_called_once_with(bg="systemTransparent")
        flat = [arg for call in window.wm_attributes.call_args_list for arg in call.args]
        self.assertNotIn("-transparentcolor", flat, "Aqua Tk has no colour key")

    def test_windows_transparency_is_unchanged(self):
        window = MagicMock()
        with on("win32"):
            clear = make_transparent(window)
        self.assertEqual(clear, WINDOWS_KEY)
        window.configure.assert_called_once_with(bg="#010203")
        window.wm_attributes.assert_called_once_with("-transparentcolor", "#010203")

    def test_every_floating_window_is_borderless_and_topmost(self):
        for platform in ("darwin", "win32"):
            window = MagicMock()
            with on(platform):
                float_window(window)
            window.overrideredirect.assert_called_once_with(True)
            window.wm_attributes.assert_called_once_with("-topmost", True)

    def test_support_check_accepts_aqua_tk_86_and_newer(self):
        with on("darwin"):
            check_support(fake_root("aqua", "8.6"))
            check_support(fake_root("aqua", "9.0"))

    def test_support_check_refuses_what_cannot_draw_a_transparent_widget(self):
        cases = {"x11 Tk": ("darwin", fake_root("x11", "8.6")),
                 "Tk 8.5": ("darwin", fake_root("aqua", "8.5")),
                 "Linux": ("linux", fake_root("x11", "8.6"))}
        for name, (platform, root) in cases.items():
            with self.subTest(name), on(platform), self.assertRaises(TransparencyUnavailable) as raised:
                check_support(root)
            self.assertTrue(str(raised.exception))

    def test_windows_support_check_asks_nothing(self):
        root = MagicMock()
        with on("win32"):
            check_support(root)
        root.tk.call.assert_not_called()

    def test_mac_app_matches_windows_scaling_routes_quit_and_hides_the_dock_icon(self):
        root, quit_ = MagicMock(), MagicMock()
        with on("darwin"), patch.object(desktop_platform, "hide_dock_icon", return_value=True) as hide:
            prepare_app(root, on_quit=quit_)
        root.tk.call.assert_any_call("tk", "scaling", 96 / 72)
        root.createcommand.assert_called_once_with("tk::mac::Quit", quit_)
        hide.assert_called_once()

    def test_windows_app_setup_is_untouched(self):
        root = MagicMock()
        with on("win32"), patch.object(desktop_platform, "hide_dock_icon") as hide:
            prepare_app(root, on_quit=MagicMock())
        root.tk.call.assert_not_called()
        root.createcommand.assert_not_called()
        hide.assert_not_called()

    def test_hiding_the_dock_icon_never_raises_without_appkit(self):
        with patch("ctypes.cdll.LoadLibrary", side_effect=OSError("no libobjc")):
            self.assertFalse(desktop_platform.hide_dock_icon())


class MacInputAndTextTests(unittest.TestCase):
    def test_mac_right_click_covers_both_tk_numberings_and_control_click(self):
        with on("darwin"):
            self.assertEqual(set(context_events()), {"<Button-2>", "<Button-3>", "<Control-Button-1>"})
        with on("win32"):
            self.assertEqual(context_events(), ("<Button-3>",))

    def test_mac_control_click_release_is_not_a_left_click(self):
        widget, callback = MagicMock(), MagicMock()
        with on("darwin"):
            bind_context(widget, callback)
        bound = {call.args[0]: call.args[1] for call in widget.bind.call_args_list}
        for sequence in ("<Button-2>", "<Button-3>", "<Control-Button-1>"):
            self.assertIs(bound[sequence], callback)
        self.assertEqual(bound["<Control-ButtonRelease-1>"](None), "break")

    def test_windows_context_binding_is_only_the_right_button(self):
        widget, callback = MagicMock(), MagicMock()
        with on("win32"):
            bind_context(widget, callback)
        widget.bind.assert_called_once_with("<Button-3>", callback)

    def test_mac_fonts_name_fonts_that_ship_with_macos(self):
        with on("darwin"):
            self.assertEqual(ui_family("Consolas"), "Menlo")
            self.assertEqual(ui_family("Bahnschrift"), "Avenir Next Condensed")
            self.assertEqual(ui_font("Segoe UI", 7), ("Helvetica Neue", 7))
        with on("win32"):
            self.assertEqual(ui_font("Consolas", 8, "bold"), ("Consolas", 8, "bold"))

    def test_mac_reduce_motion_follows_the_accessibility_setting(self):
        answer = lambda out, code=0: (lambda *_a, **_k: SimpleNamespace(returncode=code, stdout=out))
        self.assertTrue(mac_prefers_reduced_motion(run=answer("1\n")))
        self.assertFalse(mac_prefers_reduced_motion(run=answer("0\n")))
        self.assertFalse(mac_prefers_reduced_motion(run=answer("", code=1)), "never set reads as motion on")

        def missing(*_args, **_kwargs):
            raise subprocess.TimeoutExpired("defaults", 3)
        self.assertFalse(mac_prefers_reduced_motion(run=missing))

    def test_goblin_cues_asks_macos_on_darwin(self):
        import goblin_cues
        with patch.object(goblin_cues.sys, "platform", "darwin"), \
                patch.object(desktop_platform, "mac_prefers_reduced_motion", return_value=True):
            self.assertTrue(goblin_cues.system_prefers_reduced_motion())

    def test_manual_mac_start_keeps_settings_in_the_managers_folder(self):
        import desktop_widget
        with tempfile.TemporaryDirectory() as home, on("darwin"), \
                patch.dict(os.environ, {}, clear=False), patch("pathlib.Path.home", return_value=Path(home)):
            os.environ.pop("LOCALAPPDATA", None)
            os.environ.pop("GOBLIN_HORDE_STATE_DIR", None)
            target = desktop_widget.state_file()
        self.assertEqual(target.parent.parts[-3:], ("Library", "Application Support", "GoblinHorde"))


class StartupReportTests(unittest.TestCase):
    def test_unavailable_transparency_exits_with_the_code_the_manager_reads(self):
        import desktop_widget
        with patch.object(sys, "argv", ["desktop_widget.py"]), \
                patch.object(desktop_widget, "GoblinWidget", side_effect=TransparencyUnavailable("x11 Tk")), \
                patch("sys.stderr") as stderr, self.assertRaises(SystemExit) as exited:
            desktop_widget.main()
        self.assertEqual(exited.exception.code, desktop_platform.UNAVAILABLE_EXIT)
        written = "".join(str(call.args[0]) for call in stderr.write.call_args_list)
        self.assertIn("x11 Tk", written)

    def test_a_working_widget_announces_ready_before_running(self):
        import desktop_widget
        order = []
        widget = MagicMock()
        widget.run.side_effect = lambda: order.append("run")
        with patch.object(sys, "argv", ["desktop_widget.py"]), \
                patch.object(desktop_widget, "GoblinWidget", return_value=widget), \
                patch.object(desktop_platform, "announce_ready", side_effect=lambda: order.append("ready")), \
                patch.object(desktop_platform, "close_on_terminate"):
            desktop_widget.main()
        self.assertEqual(order, ["ready", "run"])

    def test_mac_stop_closes_through_the_widget(self):
        root, close = MagicMock(), MagicMock()
        with on("darwin"), patch("signal.signal") as install:
            desktop_platform.close_on_terminate(root, close)
        handler = install.call_args.args[1]
        handler(15, None)
        root.after_idle.assert_called_once_with(close)
        with on("win32"), patch("signal.signal") as install:
            desktop_platform.close_on_terminate(root, close)
        install.assert_not_called()


@unittest.skipUnless(sys.platform == "win32", "Builds the real widget with Windows Tk, posing as macOS")
class EveryWindowOnMacTests(unittest.TestCase):
    """Builds the whole widget (goblin line, launchpad, party roster, streams, notes, tooltip)
    with the platform layer answering as macOS, and inspects every window it made."""

    CLEAR = "#000001"  # Windows Tk has no systemTransparent colour; any marker colour will do.

    def test_every_window_floats_and_the_see_through_ones_use_aqua_transparency(self):
        try:
            from test_party_dock_geometry import settle
            from test_parting_render import Fixture, member, receive
        except ImportError:
            from test.test_party_dock_geometry import settle
            from test.test_parting_render import Fixture, member, receive
        attributes = []
        original = tk.Wm.wm_attributes

        def record(window, *args, **kwargs):
            attributes.append((str(window), args))
            if args[:1] == ("-transparent",):
                return ""  # Aqua-only; Windows Tk would refuse it.
            return original(window, *args, **kwargs)

        with on("darwin"), patch.object(desktop_platform, "MAC_CLEAR", self.CLEAR), \
                patch.object(desktop_platform, "check_support"), \
                patch.object(desktop_platform, "hide_dock_icon", return_value=False), \
                patch.object(tk.Wm, "wm_attributes", record):
            fixture = Fixture(self)
            widget = fixture.widget(self)
            receive(widget, [member(name) for name in "ab"])
            widget.open_party("a")
            settle(widget)
            streams = list(widget.streams.values())
            self.assertTrue(streams, "the party opened its streams")
            self.assertEqual(widget.canvas.cget("bg"), self.CLEAR)
            for stream in streams:
                self.assertEqual(stream.window.cget("bg"), self.CLEAR)
                for canvas in (stream.tail, stream.sprite, stream.roster):
                    self.assertEqual(canvas.cget("bg"), self.CLEAR)
                for bubble in stream.bubbles[:1]:  # Right-click copies an event.
                    self.assertLessEqual({"<Button-2>", "<Control-Button-1>"}, set(bubble.bind()))
            widget.show_notes()
            widget.party_dock.show_compact()
            settle(widget)
            widget.party_dock.show_tooltip("A long party name")
            widget.root.update_idletasks()

            windows = [widget.root]
            pending = list(widget.root.winfo_children())
            while pending:
                child = pending.pop()
                pending.extend(child.winfo_children())
                if child.winfo_class() == "Toplevel":
                    windows.append(child)
            self.assertIsNotNone(widget.party_dock.tooltip, "the roster tooltip opened")
            expected = {widget.root, widget.launchpad.window, widget.party_dock.window, widget.notes_panel.window,
                        widget.party_dock.tooltip, *(stream.window for stream in widget.streams.values())}
            self.assertLessEqual({str(window) for window in expected}, {str(window) for window in windows})
            for window in windows:
                with self.subTest(window=str(window)):
                    self.assertTrue(window.overrideredirect(), "borderless")
                    self.assertEqual(int(original(window, "-topmost")), 1, "above other windows")

            transparent = {name for name, args in attributes if args[:2] == ("-transparent", True)}
            see_through = {str(widget.root), *(str(stream.window) for stream in streams)}
            self.assertLessEqual(see_through, transparent, "the goblin line and every stream are see-through")
            solid = {str(widget.launchpad.window), str(widget.party_dock.window), str(widget.notes_panel.window),
                     str(widget.party_dock.tooltip)}
            self.assertFalse(solid & transparent, "panels stay opaque")
            self.assertFalse([args for _name, args in attributes if "-transparentcolor" in args])

            for surface in (widget.canvas, widget.launchpad.body, widget.party_dock.body):
                self.assertLessEqual({"<Button-2>", "<Control-Button-1>", "<Control-ButtonRelease-1>"},
                                     set(surface.bind()), str(surface))
            self.assertEqual(widget.header_font.cget("family"), "Menlo")
            self.assertEqual(widget.launchpad.title_font.cget("family"), "Avenir Next Condensed")


if __name__ == "__main__":
    unittest.main()
