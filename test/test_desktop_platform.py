"""Window setup for the desktop goblins, checked with mocks: what the widget asks Windows and Tk for,
and that any other system is refused with the exit code the manager reads."""

import sys
import tkinter as tk
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import desktop_platform
from desktop_platform import WINDOWS_KEY, TransparencyUnavailable, check_support, float_window, make_transparent


def on(platform):
    return patch.object(desktop_platform, "system", return_value=platform)


class WindowSetupTests(unittest.TestCase):
    def test_transparency_keys_one_colour_out_of_the_window(self):
        window = MagicMock()
        clear = make_transparent(window)
        self.assertEqual(clear, WINDOWS_KEY)
        window.configure.assert_called_once_with(bg="#010203")
        window.wm_attributes.assert_called_once_with("-transparentcolor", "#010203")

    def test_every_floating_window_is_borderless_and_topmost(self):
        window = MagicMock()
        float_window(window)
        window.overrideredirect.assert_called_once_with(True)
        window.wm_attributes.assert_called_once_with("-topmost", True)

    def test_only_windows_can_show_the_goblins(self):
        with on("win32"):
            check_support()
        for platform in ("darwin", "linux"):
            with self.subTest(platform), on(platform), self.assertRaises(TransparencyUnavailable) as raised:
                check_support()
            self.assertIn("Windows", str(raised.exception))


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

    def test_positions_left_of_the_primary_display_keep_their_sign(self):
        self.assertEqual(desktop_platform.screen_geometry(-1200, 40), "+-1200+40")

    def test_the_displays_are_listed_left_to_right_with_the_primary_one_marked(self):
        layout = {1: ((2560, 0, 3640, 1920), 1872, 0), 2: ((0, 0, 2560, 1440), 1392, desktop_platform.MONITORINFOF_PRIMARY)}

        def info(monitor, pointer):
            whole, work_bottom, flags = layout[monitor]
            record = pointer._obj
            (record.rcMonitor.left, record.rcMonitor.top, record.rcMonitor.right, record.rcMonitor.bottom) = whole
            record.rcWork.bottom, record.dwFlags = work_bottom, flags
            return 1

        def enumerate_displays(_dc, _clip, callback, _data):
            for monitor in layout:
                callback(monitor, 0, None, 0)
            return 1
        user32 = SimpleNamespace(GetMonitorInfoW=info, EnumDisplayMonitors=enumerate_displays)
        with on("win32"), patch.object(desktop_platform.ctypes, "windll", SimpleNamespace(user32=user32), create=True):
            self.assertEqual(desktop_platform.screens(), [desktop_platform.Screen(0, 0, 2560, 1440, 1392, True),
                                                          desktop_platform.Screen(2560, 0, 3640, 1920, 1872, False)])
        refused = SimpleNamespace(GetMonitorInfoW=info, EnumDisplayMonitors=lambda *_args: 0)
        with on("win32"), patch.object(desktop_platform.ctypes, "windll", SimpleNamespace(user32=refused), create=True):
            self.assertEqual(desktop_platform.screens(), [])
        with on("darwin"):
            self.assertEqual(desktop_platform.screens(), [])

    def test_the_primary_work_area_comes_from_windows_and_falls_back_to_the_screen(self):
        window = MagicMock()
        window.winfo_screenwidth.return_value, window.winfo_screenheight.return_value = 1920, 1080

        def work_area(action, _param, area, _flags):
            self.assertEqual(action, desktop_platform.SPI_GETWORKAREA)
            area._obj.left, area._obj.top, area._obj.right, area._obj.bottom = 0, 0, 2560, 1392
            return 1
        user32 = SimpleNamespace(SystemParametersInfoW=work_area)
        with on("win32"), patch.object(desktop_platform.ctypes, "windll", SimpleNamespace(user32=user32), create=True):
            self.assertEqual(desktop_platform.primary_work_area(window), (0, 0, 2560, 1392), "above the taskbar")
        refused = SimpleNamespace(SystemParametersInfoW=MagicMock(return_value=0))
        with on("win32"), patch.object(desktop_platform.ctypes, "windll", SimpleNamespace(user32=refused), create=True):
            self.assertEqual(desktop_platform.primary_work_area(window), (0, 0, 1920, 1080))

    def test_reduced_motion_follows_the_windows_animation_setting(self):
        def animations(on_):
            def answer(action, _param, enabled, _flags):
                self.assertEqual(action, desktop_platform.SPI_GETCLIENTAREAANIMATION)
                enabled._obj.value = int(on_)
                return 1
            return SimpleNamespace(user32=SimpleNamespace(SystemParametersInfoW=answer))
        with on("win32"), patch.object(desktop_platform.ctypes, "windll", animations(False), create=True):
            self.assertTrue(desktop_platform.system_prefers_reduced_motion(), "Show animations in Windows is off")
        with on("win32"), patch.object(desktop_platform.ctypes, "windll", animations(True), create=True):
            self.assertFalse(desktop_platform.system_prefers_reduced_motion())
        broken = SimpleNamespace(user32=SimpleNamespace(SystemParametersInfoW=MagicMock(side_effect=OSError("no"))))
        with on("win32"), patch.object(desktop_platform.ctypes, "windll", broken, create=True):
            self.assertFalse(desktop_platform.system_prefers_reduced_motion(), "unknown reads as motion on")

    @unittest.skipUnless(sys.platform == "win32", "Measures real Tk fonts")
    def test_readable_type_at_the_display_scale(self):
        from horde_theme import Theme
        root = tk.Tk()
        root.withdraw()
        self.addCleanup(root.destroy)
        theme = Theme(root, 1.25)
        self.assertEqual((theme.small.cget("family"), theme.small.cget("size")), ("Segoe UI", 9))
        self.assertGreaterEqual(min(font.cget("size") for font in (theme.small, theme.small_strong, theme.title, theme.name)),
                                9, "no 7-8 pt text")
        self.assertEqual(theme.px(58), 72, "pixel sizes follow the display scale")


class StartupReportTests(unittest.TestCase):
    def test_unavailable_transparency_exits_with_the_code_the_manager_reads(self):
        import desktop_widget
        with patch.object(sys, "argv", ["desktop_widget.py"]), \
                patch.object(desktop_widget, "GoblinWidget", side_effect=TransparencyUnavailable("Windows only")), \
                patch("sys.stderr") as stderr, self.assertRaises(SystemExit) as exited:
            desktop_widget.main()
        self.assertEqual(exited.exception.code, desktop_platform.UNAVAILABLE_EXIT)
        written = "".join(str(call.args[0]) for call in stderr.write.call_args_list)
        self.assertIn("Windows only", written)

    def test_off_windows_the_widget_itself_refuses_before_making_a_window(self):
        import desktop_widget
        with on("darwin"), patch.object(desktop_widget.tk, "Tk", side_effect=AssertionError("a window was made")), \
                self.assertRaises(TransparencyUnavailable):
            desktop_widget.GoblinWidget(44190)

    def test_a_working_widget_announces_ready_before_running(self):
        import desktop_widget
        order = []
        widget = MagicMock()
        widget.run.side_effect = lambda: order.append("run")
        with patch.object(sys, "argv", ["desktop_widget.py"]), \
                patch.object(desktop_widget, "GoblinWidget", return_value=widget), \
                patch.object(desktop_platform, "announce_ready", side_effect=lambda: order.append("ready")):
            desktop_widget.main()
        self.assertEqual(order, ["ready", "run"])

    def test_the_port_is_the_only_argument_and_an_old_surface_is_ignored(self):
        import desktop_widget
        for argv, port in ((["desktop_widget.py"], 43917), (["desktop_widget.py", "--port", "44190"], 44190),
                           (["desktop_widget.py", "--port", "44191", "--surface", "strip"], 44191),
                           (["desktop_widget.py", "--surface", "pets", "--port", "44192"], 44192)):
            with self.subTest(argv=argv), patch.object(sys, "argv", argv), \
                    patch.object(desktop_widget, "GoblinWidget") as widget, \
                    patch.object(desktop_platform, "announce_ready"):
                desktop_widget.main()
            widget.assert_called_once_with(port)


if __name__ == "__main__":
    unittest.main()
