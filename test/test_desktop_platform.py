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
                              prepare_app)


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

    def test_mac_app_routes_quit_and_the_dock_icon_through_the_app(self):
        root, quit_, reopen = MagicMock(), MagicMock(), MagicMock()
        with on("darwin"):
            prepare_app(root, on_quit=quit_, on_reopen=reopen)
        root.createcommand.assert_any_call("tk::mac::Quit", quit_)
        root.createcommand.assert_any_call("tk::mac::ReopenApplication", reopen)
        # The window is laid out in points with the system font; Tk's own scaling is left alone.
        root.tk.call.assert_not_called()

    def test_windows_app_setup_is_untouched(self):
        root = MagicMock()
        with on("win32"):
            prepare_app(root, on_quit=MagicMock(), on_reopen=MagicMock())
        root.tk.call.assert_not_called()
        root.createcommand.assert_not_called()


class DisplayTests(unittest.TestCase):
    def test_dpi_awareness_is_asked_for_only_on_windows_and_never_raises(self):
        with on("darwin"):
            self.assertEqual(desktop_platform.enable_dpi_awareness(), "")
        windll = SimpleNamespace(user32=SimpleNamespace(SetProcessDpiAwarenessContext=MagicMock(return_value=0),
                                                        SetProcessDPIAware=MagicMock(return_value=1)),
                                 shcore=SimpleNamespace(SetProcessDpiAwareness=MagicMock(side_effect=OSError("old"))))
        with on("win32"), patch.object(desktop_platform.ctypes, "windll", windll, create=True):
            self.assertEqual(desktop_platform.enable_dpi_awareness(), "system", "falls back to system-aware")
        windll.user32.SetProcessDpiAwarenessContext.return_value = 1
        with on("win32"), patch.object(desktop_platform.ctypes, "windll", windll, create=True):
            self.assertEqual(desktop_platform.enable_dpi_awareness(), "per-monitor-v2")

    def test_one_scale_from_the_real_dpi(self):
        root = MagicMock()
        root.winfo_fpixels.return_value = 120.0
        with on("win32"):
            self.assertEqual(desktop_platform.display_scale(root), 1.25)
        root.winfo_fpixels.return_value = 72.0
        with on("win32"):
            self.assertEqual(desktop_platform.display_scale(root), 1.0, "never smaller than the design")
        with on("darwin"):
            self.assertEqual(desktop_platform.display_scale(root), 1.0)

    def test_the_dark_title_bar_is_windows_only_and_failures_are_ignored(self):
        window = MagicMock()
        window.wm_frame.return_value = "0x1a2b"
        with on("darwin"):
            self.assertFalse(desktop_platform.dark_title_bar(window))
        window.wm_frame.assert_not_called()
        calls = []

        def record(hwnd, attribute, _value, _size):
            calls.append((hwnd, attribute))
            return 0
        dwm = SimpleNamespace(DwmSetWindowAttribute=record)
        with on("win32"), patch.object(desktop_platform.ctypes, "windll", SimpleNamespace(dwmapi=dwm), create=True):
            self.assertTrue(desktop_platform.dark_title_bar(window, caption="#1f3328"))
        self.assertEqual(calls, [(0x1a2b, 20), (0x1a2b, 35)])
        broken = SimpleNamespace(DwmSetWindowAttribute=MagicMock(side_effect=OSError("no DWM")))
        with on("win32"), patch.object(desktop_platform.ctypes, "windll", SimpleNamespace(dwmapi=broken), create=True):
            self.assertFalse(desktop_platform.dark_title_bar(window))

    def test_positions_left_of_the_primary_display_keep_their_sign(self):
        self.assertEqual(desktop_platform.screen_geometry(-1200, 40), "+-1200+40")
        with on("darwin"):
            self.assertEqual(desktop_platform.monitor_areas(), [])


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

    @unittest.skipUnless(sys.platform == "win32", "Measures real Tk fonts")
    def test_readable_type_on_each_system(self):
        from horde_theme import Theme
        root = tk.Tk()
        root.withdraw()
        self.addCleanup(root.destroy)
        windows = Theme(root, 1.25)
        self.assertEqual((windows.body.cget("family"), windows.body.cget("size")), ("Segoe UI", 10))
        self.assertIn(windows.mono.cget("family"), ("Cascadia Mono", "Consolas"))
        self.assertEqual(windows.mono.cget("size"), 9)
        self.assertEqual(windows.px(58), 72, "pixel sizes follow the display scale")
        with on("darwin"):
            mac = Theme(root, 1.0)
        self.assertEqual(mac.body.cget("size"), 13, "the macOS system font size")
        self.assertEqual(mac.mono.cget("family"), "Menlo")
        self.assertGreaterEqual(min(font.cget("size") for font in (mac.small, mac.mono)), 11, "no 7-8 pt prose")

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
    """Builds the whole app (Horde window, goblin strip, tooltip) with the platform layer answering as
    macOS, and inspects every window it made."""

    CLEAR = "#000001"  # Windows Tk has no systemTransparent colour; any marker colour will do.

    def test_the_window_is_native_and_only_the_strip_and_tips_float(self):
        try:
            from widget_fixtures import isolate, load, settle
        except ImportError:
            from test.widget_fixtures import isolate, load, settle
        import desktop_widget
        attributes = []
        original = tk.Wm.wm_attributes

        def record(window, *args, **kwargs):
            attributes.append((str(window), args))
            if args[:1] == ("-transparent",):
                return ""  # Aqua-only; Windows Tk would refuse it.
            return original(window, *args, **kwargs)

        isolate(self)
        with on("darwin"), patch.object(desktop_platform, "MAC_CLEAR", self.CLEAR), \
                patch.object(desktop_platform, "check_support"), \
                patch.object(desktop_platform, "enable_dpi_awareness") as aware, \
                patch.object(tk.Wm, "wm_attributes", record):
            widget = desktop_widget.GoblinWidget("", 44192, demo=True)
            self.addCleanup(widget.close)
            load(widget)
            widget.strip.show()
            widget.tooltip.show("A long goblin name", 10, 10)
            settle(widget)
            aware.assert_called_once_with()  # Asked; the real call answers "" off Windows.
            self.assertEqual(widget.theme.scale, 1.0, "macOS works in points already")
            self.assertEqual(widget.theme.families["mono"], "Menlo")

            self.assertFalse(widget.root.overrideredirect(), "the Horde window is a native window")
            self.assertEqual(int(original(widget.root, "-topmost")), 0, "it is not on top unless asked")
            for window in (widget.strip.window, widget.tooltip.window):
                with self.subTest(window=str(window)):
                    self.assertTrue(window.overrideredirect(), "borderless")
                    self.assertEqual(int(original(window, "-topmost")), 1, "above other windows")
            transparent = {name for name, args in attributes if args[:2] == ("-transparent", True)}
            self.assertEqual(transparent, {str(widget.strip.window)}, "only the strip is see-through")
            self.assertEqual(widget.strip.canvas.cget("bg"), self.CLEAR)
            self.assertFalse([args for _name, args in attributes if "-transparentcolor" in args])
            for surface in (widget.roster.canvas, widget.strip.canvas):
                self.assertLessEqual({"<Button-2>", "<Control-Button-1>", "<Control-ButtonRelease-1>"},
                                     set(surface.bind()), str(surface))


if __name__ == "__main__":
    unittest.main()
