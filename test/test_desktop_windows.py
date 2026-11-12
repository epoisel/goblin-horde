"""Window tops as goblin platforms: the pure geometry, the Windows listing behind a stand-in for
Windows, the watcher, and on Windows the real desktop (rectangles and counts only)."""

import re
import sys
import threading
import tkinter as tk
import unittest
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import patch

import desktop_windows
from desktop_windows import (CLICK_THROUGH, WS_CAPTION, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW, WS_THICKFRAME, WindowWatcher,
                             foreground_is_fullscreen, seconds_since_input, snapshot, taskbar_top)
from pet_platform import Platform, WindowRect, window_platforms


WORK = (0, 0, 1920, 1040)
OFFSCREEN = -20000


def win(key, x0, y0, x1, y1):
    return WindowRect(key, x0, y0, x1, y1)


def spans(platforms, key):
    return [(p.x0, p.x1) for p in platforms if p.key == key]


class WindowPlatformTests(unittest.TestCase):
    def test_the_types_keep_the_shape_the_other_modules_build_on(self):
        self.assertEqual(Platform._fields, ("x0", "x1", "y", "kind", "key", "origin"))
        self.assertEqual(WindowRect._fields, ("key", "x0", "y0", "x1", "y1"))

    def test_a_lone_window_is_one_platform_along_its_whole_top_edge(self):
        self.assertEqual(window_platforms([win("a", 300, 200, 900, 700)], WORK),
                         [Platform(300.0, 900.0, 200.0, "window", "a", (300.0, 200.0))])

    def test_a_window_half_covered_by_another_keeps_the_part_that_shows(self):
        front, back = win("front", 500, 100, 1300, 600), win("back", 100, 200, 900, 700)
        platforms = window_platforms([front, back], WORK)
        self.assertEqual(spans(platforms, "back"), [(100, 500)])
        self.assertEqual(spans(platforms, "front"), [(500, 1300)])
        self.assertEqual([p.key for p in platforms], ["front", "back"], "top of the z-order first")

    def test_three_overlapping_windows_split_the_lowest_into_the_stretches_between(self):
        top, middle, bottom = win("c", 900, 250, 1200, 500), win("b", 300, 200, 700, 800), win("a", 100, 300, 1500, 900)
        platforms = window_platforms([top, middle, bottom], WORK)
        self.assertEqual(spans(platforms, "a"), [(100, 300), (700, 900), (1200, 1500)])
        self.assertEqual(spans(platforms, "b"), [(300, 700)], "the top window sits wholly below this edge")
        self.assertEqual(spans(platforms, "c"), [(900, 1200)])
        self.assertEqual({p.y for p in platforms if p.key == "a"}, {300.0})

    def test_a_window_entirely_covered_has_no_platform(self):
        platforms = window_platforms([win("front", 100, 100, 800, 700), win("back", 200, 300, 600, 500)], WORK)
        self.assertEqual([p.key for p in platforms], ["front"])

    def test_a_window_in_front_covers_an_edge_only_where_it_spans_that_height(self):
        back = win("back", 100, 300, 900, 700)
        for name, front, expected in (("ends exactly at the edge", win("f", 200, 100, 600, 300), [(100, 900)]),
                                      ("starts below the edge", win("f", 200, 301, 600, 600), [(100, 900)]),
                                      ("beside it on the right", win("f", 1000, 100, 1300, 600), [(100, 900)]),
                                      ("touching it on the left", win("f", 0, 100, 100, 600), [(100, 900)]),
                                      ("starts level with the edge", win("f", 200, 300, 600, 600), [(100, 200), (600, 900)]),
                                      ("spans the edge", win("f", 200, 100, 600, 301), [(100, 200), (600, 900)])):
            with self.subTest(name):
                self.assertEqual(spans(window_platforms([front, back], WORK), "back"), expected)

    def test_a_maximized_window_is_no_platform_and_hides_everything_under_it(self):
        maximized, under = win("max", 0, 0, 1920, 1040), win("under", 300, 200, 900, 700)
        floating = win("float", 400, 300, 800, 600)
        self.assertEqual(window_platforms([maximized, under], WORK), [])
        self.assertEqual([p.key for p in window_platforms([floating, maximized, under], WORK)], ["float"])
        self.assertEqual(window_platforms([win("oversized", -8, -8, 1928, 1048)], WORK), [])
        self.assertEqual(window_platforms([maximized], WORK, headroom=0), [], "whatever the headroom asked for")

    def test_a_window_poking_above_the_work_area_is_no_platform(self):
        self.assertEqual(window_platforms([win("a", 300, -20, 900, 400)], WORK), [])
        self.assertEqual(window_platforms([win("a", 300, 80, 900, 400)], (0, 100, 1920, 1040)), [])

    def test_a_top_edge_needs_headroom_inside_the_work_area(self):
        self.assertEqual(window_platforms([win("a", 300, 39, 900, 400)], WORK), [])
        self.assertEqual(len(window_platforms([win("a", 300, 40, 900, 400)], WORK)), 1)
        self.assertEqual(len(window_platforms([win("a", 300, 139, 900, 400)], (0, 100, 1920, 1040))), 0)
        self.assertEqual(len(window_platforms([win("a", 300, 10, 900, 400)], WORK, headroom=10)), 1)

    def test_a_top_edge_at_or_below_the_ground_is_no_platform(self):
        self.assertEqual(window_platforms([win("a", 300, 1040, 900, 1400)], WORK), [])
        self.assertEqual(len(window_platforms([win("a", 300, 1039, 900, 1400)], WORK)), 1)

    def test_a_window_narrower_than_24_pixels_is_no_platform(self):
        self.assertEqual(window_platforms([win("thin", 100, 200, 123, 400)], WORK), [])
        self.assertEqual(spans(window_platforms([win("ok", 100, 200, 124, 400)], WORK), "ok"), [(100, 124)])
        self.assertEqual(len(window_platforms([win("thin", 100, 200, 140, 400)], WORK, min_width=50)), 0)

    def test_a_stretch_left_narrower_than_24_pixels_is_dropped(self):
        front, back = win("front", 120, 100, 880, 600), win("back", 100, 200, 910, 700)
        self.assertEqual(spans(window_platforms([front, back], WORK), "back"), [(880, 910)])

    def test_covers_that_overlap_or_touch_leave_one_hole_not_slivers(self):
        back = win("back", 100, 400, 1500, 900)
        overlapping = [win("f1", 400, 100, 800, 600), win("f2", 600, 150, 1000, 650), back]
        touching = [win("f1", 400, 100, 700, 600), win("f2", 700, 150, 1000, 650), back]
        nested = [win("f1", 400, 100, 1000, 600), win("f2", 500, 150, 700, 650), back]
        for name, rects in (("overlapping", overlapping), ("touching", touching), ("nested", nested)):
            with self.subTest(name):
                self.assertEqual(spans(window_platforms(rects, WORK), "back"), [(100, 400), (1000, 1500)])

    def test_stretches_are_clipped_to_the_work_area_and_keep_the_windows_own_corner(self):
        platforms = window_platforms([win("left", -200, 300, 400, 700), win("right", 1700, 500, 2300, 900)], WORK)
        self.assertEqual(spans(platforms, "left"), [(0, 400)])
        self.assertEqual(spans(platforms, "right"), [(1700, 1920)])
        self.assertEqual([p.origin for p in platforms], [(-200.0, 300.0), (1700.0, 500.0)])
        self.assertEqual(window_platforms([win("other display", 2000, 300, 2800, 700)], WORK), [])

    def test_keys_are_stable_across_calls_and_a_moved_window_keeps_its_key(self):
        front, back = win("front", 500, 100, 1300, 600), win("back", 100, 200, 900, 700)
        first = window_platforms([front, back], WORK)
        self.assertEqual(window_platforms([front, back], WORK), first)
        moved = window_platforms([front, win("back", 130, 260, 930, 760)], WORK)
        before, after = (next(p for p in platforms if p.key == "back") for platforms in (first, moved))
        self.assertEqual((after.origin[0] - before.origin[0], after.origin[1] - before.origin[1]), (30.0, 60.0))

    def test_a_cover_moving_changes_the_stretch_but_not_where_its_riders_are_carried(self):
        back = win("back", 100, 200, 900, 700)
        near, far = (window_platforms([win("front", x, 100, x + 300, 600), back], WORK) for x in (50, 60))
        self.assertNotEqual(spans(near, "back"), spans(far, "back"))
        self.assertEqual({p.origin for p in near + far if p.key == "back"}, {(100.0, 200.0)})

    def test_every_stretch_is_a_window_platform_in_floats(self):
        for platform in window_platforms([win("front", 500, 100, 1300, 600), win("back", 100, 200, 900, 700)], WORK):
            self.assertEqual(platform.kind, "window")
            self.assertEqual({type(value) for value in (platform.x0, platform.x1, platform.y, *platform.origin)}, {float})
            self.assertLess(platform.x0, platform.x1)


@dataclass
class FakeWindow:
    hwnd: int
    frame: tuple | None = (100, 100, 500, 400)
    minimized: bool = False
    ex_style: int = 0
    style: int = WS_CAPTION
    process: int = 7
    cloaked: bool = False
    window_class: str = "SomeApp"
    title_length: int = 9
    maximized: bool = False


class FakeDesktop:
    """Stands in for Windows: visible windows from the top down. It has no way to hand out a title."""

    own_process = 4242

    def __init__(self, windows=(), scale=1.0, taskbar=None, screen=(2560, 1440), idle_ms=0):
        self._windows = {window.hwnd: window for window in windows}
        self.scale, self._taskbar, self._screen, self._idle_ms = scale, taskbar, screen, idle_ms

    @contextmanager
    def real_pixels(self):
        yield self.scale

    def windows(self):
        return list(self._windows)

    def titled(self, hwnd):
        return self._windows[hwnd].title_length > 0

    def taskbar(self):
        return self._taskbar

    def foreground(self):
        """The first window listed is the one in front; none listed is nothing in front."""
        return next(iter(self._windows), None)

    def screen(self):
        return self._screen

    def idle_ms(self):
        return self._idle_ms

    def __getattr__(self, fact):
        if fact not in ("frame", "minimized", "ex_style", "style", "process", "cloaked", "window_class", "maximized"):
            raise AttributeError(fact)
        return lambda hwnd: getattr(self._windows[hwnd], fact)


def listed(*windows, scale=1.0):
    with patch.object(sys, "platform", "win32"), \
            patch.object(desktop_windows, "_win32", return_value=FakeDesktop(windows, scale)):
        return snapshot()


class SnapshotRuleTests(unittest.TestCase):
    def test_ordinary_windows_come_back_as_rectangles_top_first(self):
        rects = listed(FakeWindow(11, (500, 100, 1300, 600)), FakeWindow(12, (100, 200, 900, 700)))
        self.assertEqual([rect[1:] for rect in rects], [(500, 100, 1300, 600), (100, 200, 900, 700)])
        self.assertTrue(all(isinstance(rect, WindowRect) for rect in rects))

    def test_what_is_not_a_window_a_person_sees_is_left_out(self):
        left_out = {
            "minimized": FakeWindow(2, minimized=True),
            "tool window": FakeWindow(2, ex_style=WS_EX_TOOLWINDOW),
            "click-through overlay": FakeWindow(2, ex_style=CLICK_THROUGH),
            "this process's own window": FakeWindow(2, process=FakeDesktop.own_process),
            "cloaked": FakeWindow(2, cloaked=True),
            "the desktop": FakeWindow(2, window_class="Progman"),
            "the desktop's wallpaper layer": FakeWindow(2, window_class="WorkerW", title_length=0),
            "the taskbar": FakeWindow(2, window_class="Shell_TrayWnd"),
            "a second display's taskbar": FakeWindow(2, window_class="Shell_SecondaryTrayWnd"),
            "untitled with no caption": FakeWindow(2, title_length=0, style=0),
            "no area": FakeWindow(2, frame=(300, 300, 300, 300)),
            "inside out": FakeWindow(2, frame=(300, 300, 200, 500)),
            "no rectangle to be had": FakeWindow(2, frame=None),
        }
        for name, window in left_out.items():
            with self.subTest(name):
                rects = listed(FakeWindow(1, (0, 0, 50, 50)), window, FakeWindow(3, (60, 60, 90, 90)))
                self.assertEqual([rect[1:] for rect in rects], [(0, 0, 50, 50), (60, 60, 90, 90)])

    def test_windows_that_only_look_like_the_left_out_ones_stay(self):
        kept = {
            "a tool window flagged as an app": FakeWindow(2, ex_style=WS_EX_TOOLWINDOW | WS_EX_APPWINDOW),
            "untitled but with a caption bar": FakeWindow(2, title_length=0, style=WS_CAPTION),
            "titled with a drawn-by-the-app title bar": FakeWindow(2, title_length=4, style=0),
            "layered but clickable": FakeWindow(2, ex_style=0x00080000),
        }
        for name, window in kept.items():
            with self.subTest(name):
                self.assertEqual(len(listed(window)), 1)

    def test_a_window_keeps_one_key_and_the_key_gives_nothing_away(self):
        first = listed(FakeWindow(0xABCDEF, (0, 0, 50, 50)), FakeWindow(0x123456, (5, 5, 60, 60)))
        again = listed(FakeWindow(0x123456, (40, 40, 95, 95)), FakeWindow(0xABCDEF, (0, 0, 50, 50)))
        self.assertEqual([rect.key for rect in first], [rect.key for rect in reversed(again)], "moved and restacked")
        self.assertNotEqual(first[0].key, first[1].key)
        for rect in first:
            self.assertRegex(rect.key, r"^[0-9a-f]{16}$")
            self.assertNotIn("abcdef", rect.key)
            self.assertNotIn("123456", rect.key)

    def test_a_process_that_is_not_dpi_aware_gets_its_own_scaled_units(self):
        self.assertEqual(listed(FakeWindow(1, (300, 150, 1500, 900)), scale=2 / 3)[0][1:], (200, 100, 1000, 600))
        self.assertEqual(listed(FakeWindow(1, (301, 151, 1501, 901)))[0][1:], (301, 151, 1501, 901))

    def test_trouble_asking_windows_is_an_empty_list(self):
        class Broken(FakeDesktop):
            def windows(self):
                raise OSError("no window station")
        with patch.object(sys, "platform", "win32"), patch.object(desktop_windows, "_win32", return_value=Broken()):
            self.assertEqual(snapshot(), [])
        with patch.object(sys, "platform", "win32"), \
                patch.object(desktop_windows, "_win32", side_effect=OSError("no dwmapi")):
            self.assertEqual(snapshot(), [])
            self.assertEqual(taskbar_top(900), 900)

    def test_no_field_of_a_rectangle_holds_text_but_the_key(self):
        for rect in listed(FakeWindow(11), FakeWindow(12, (1, 2, 30, 40)), scale=0.5):
            self.assertEqual([type(value) for value in rect], [str, int, int, int, int])

    def test_the_module_binds_nothing_that_copies_a_title_or_names_a_program(self):
        source = Path(desktop_windows.__file__).read_text(encoding="utf-8")
        forbidden = (r"GetWindowText(?!Length)|InternalGetWindowText|WM_GETTEXT\b"
                     r"|OpenProcess|ImageFileName|ModuleFileName|ModuleBaseName")
        self.assertEqual(re.findall(forbidden, source), [])


class TaskbarTopTests(unittest.TestCase):
    def top(self, taskbar, work_area_bottom, scale=1.0):
        with patch.object(sys, "platform", "win32"), \
                patch.object(desktop_windows, "_win32", return_value=FakeDesktop(taskbar=taskbar, scale=scale)):
            return taskbar_top(work_area_bottom)

    def test_the_ground_is_the_taskbars_top_or_the_work_areas_bottom(self):
        cases = (
            ("the work area ends at the taskbar", (0, 1392, 2560, 1440), 1392, 1392),
            ("the work area ignores the taskbar", (0, 1392, 2560, 1440), 1440, 1392),
            ("slid away to hide, a sliver left", (0, 1438, 2560, 1486), 1440, 1440),
            ("docked along the top", (0, 0, 2560, 48), 1440, 1440),
            ("docked on the left", (0, 0, 48, 1440), 1440, 1440),
            ("docked on the right", (2512, 0, 2560, 1440), 1440, 1440),
            ("on a taller display beside this one", (2560, 1872, 3640, 1920), 1440, 1440),
            ("none on show", None, 1440, 1440),
        )
        for name, taskbar, work_area_bottom, expected in cases:
            with self.subTest(name):
                self.assertEqual(self.top(taskbar, work_area_bottom), expected)

    def test_a_process_that_is_not_dpi_aware_gets_the_top_in_its_own_units(self):
        self.assertEqual(self.top((0, 2784, 5120, 2880), 1440, scale=0.5), 1392)


class FullscreenTests(unittest.TestCase):
    SCREEN = (0, 0, 2560, 1440)

    def fullscreen(self, *windows, screen=(2560, 1440)):
        with patch.object(sys, "platform", "win32"),                 patch.object(desktop_windows, "_win32", return_value=FakeDesktop(windows, screen=screen)):
            return foreground_is_fullscreen()

    def test_a_window_in_front_that_covers_the_whole_primary_display_is_a_full_screen_app(self):
        self.assertTrue(self.fullscreen(FakeWindow(1, self.SCREEN, style=0)))
        self.assertTrue(self.fullscreen(FakeWindow(1, (-2, -2, 2562, 1442), style=0)), "a little larger still covers it")
        self.assertTrue(self.fullscreen(FakeWindow(1, self.SCREEN, style=0), FakeWindow(2, (100, 100, 500, 400))))

    def test_a_window_that_leaves_any_of_the_display_showing_is_not(self):
        for name, frame in (("an ordinary window", (100, 100, 900, 700)), ("stops at the taskbar", (0, 0, 2560, 1392)),
                            ("a column short", (1, 0, 2560, 1440)), ("on a second display", (2560, 0, 3640, 1920)),
                            ("no rectangle to be had", None)):
            with self.subTest(name):
                self.assertFalse(self.fullscreen(FakeWindow(1, frame, style=0)))
        self.assertFalse(self.fullscreen(FakeWindow(1, (100, 100, 900, 700)), FakeWindow(2, self.SCREEN, style=0)),
                         "only the window in front counts")
        self.assertFalse(self.fullscreen(), "nothing in front")

    def test_the_desktop_the_shell_and_this_process_are_never_a_full_screen_app(self):
        for name, window in (("the desktop", FakeWindow(1, self.SCREEN, window_class="Progman")),
                             ("the wallpaper layer", FakeWindow(1, self.SCREEN, window_class="WorkerW")),
                             ("the taskbar", FakeWindow(1, self.SCREEN, window_class="Shell_TrayWnd")),
                             ("the pet field itself", FakeWindow(1, self.SCREEN, style=0, process=FakeDesktop.own_process))):
            with self.subTest(name):
                self.assertFalse(self.fullscreen(window))

    def test_a_maximized_window_that_kept_its_frame_is_only_maximized(self):
        """Where the work area ignores the taskbar, a maximized window covers the whole display too."""
        for style in (WS_CAPTION, WS_THICKFRAME, WS_CAPTION | WS_THICKFRAME):
            with self.subTest(style=style):
                self.assertFalse(self.fullscreen(FakeWindow(1, self.SCREEN, style=style, maximized=True)))
        self.assertTrue(self.fullscreen(FakeWindow(1, self.SCREEN, style=0, maximized=True)),
                        "maximized with its frame taken off is how some apps go full screen")
        self.assertTrue(self.fullscreen(FakeWindow(1, self.SCREEN, style=WS_CAPTION)),
                        "a framed window sized over the display by hand hides the taskbar all the same")

    def test_trouble_asking_windows_is_not_a_full_screen_app(self):
        with patch.object(sys, "platform", "win32"),                 patch.object(desktop_windows, "_win32", side_effect=OSError("no user32")):
            self.assertFalse(foreground_is_fullscreen())
            self.assertEqual(seconds_since_input(), 0.0)


class IdleTests(unittest.TestCase):
    def test_the_time_since_the_last_input_comes_back_in_seconds(self):
        with patch.object(sys, "platform", "win32"),                 patch.object(desktop_windows, "_win32", return_value=FakeDesktop(idle_ms=301_500)):
            self.assertEqual(seconds_since_input(), 301.5)


class WatcherTests(unittest.TestCase):
    A, B = win("a", 0, 0, 50, 50), win("b", 5, 5, 60, 60)

    def test_poll_once_keeps_only_the_latest_list(self):
        feed = iter([[self.A], [self.A, self.B], []])
        watcher = WindowWatcher(snapshot=lambda: next(feed))
        self.assertEqual(watcher.latest(), [])
        self.assertEqual(watcher.poll_once(), [self.A])
        self.assertEqual(watcher.latest(), [self.A])
        watcher.poll_once()
        self.assertEqual(watcher.latest(), [self.A, self.B])
        watcher.poll_once()
        self.assertEqual(watcher.latest(), [])

    def test_latest_hands_out_a_copy(self):
        watcher = WindowWatcher(snapshot=lambda: [self.A])
        watcher.poll_once()
        watcher.latest().clear()
        self.assertEqual(watcher.latest(), [self.A])

    def test_on_change_hears_only_changes_including_a_new_stacking_order(self):
        feed = iter([[self.A, self.B], [self.A, self.B], [self.B, self.A], [self.B, self.A], []])
        heard = []
        watcher = WindowWatcher(on_change=heard.append, snapshot=lambda: next(feed))
        for _ in range(5):
            watcher.poll_once()
        self.assertEqual(heard, [[self.A, self.B], [self.B, self.A], []])

    def test_a_failing_snapshot_or_listener_never_raises_and_keeps_the_last_list(self):
        answers = iter([[self.A], OSError("gone"), [self.B]])

        def flaky():
            answer = next(answers)
            if isinstance(answer, Exception):
                raise answer
            return answer

        def angry(_rects):
            raise RuntimeError("listener bug")

        watcher = WindowWatcher(on_change=angry, snapshot=flaky)
        self.assertEqual(watcher.poll_once(), [self.A])
        self.assertEqual(watcher.poll_once(), [self.A], "the failed poll answers with the last good list")
        self.assertEqual(watcher.poll_once(), [self.B])

    def test_the_thread_polls_until_stopped_and_is_a_daemon(self):
        polls, enough = [], threading.Event()

        def fake():
            polls.append(threading.current_thread())
            if len(polls) >= 3:
                enough.set()
            return [self.A]

        watcher = WindowWatcher(interval=0.005, snapshot=fake)
        self.addCleanup(watcher.stop)
        self.assertIs(watcher.start(), watcher)
        watcher.start()
        self.assertTrue(enough.wait(5.0), "the thread never polled three times")
        self.assertEqual(watcher.latest(), [self.A])
        self.assertEqual(len(set(polls)), 1, "a second start() must not add a second thread")
        self.assertTrue(polls[0].daemon)
        self.assertIsNot(polls[0], threading.current_thread())
        watcher.stop()
        self.assertFalse(polls[0].is_alive())
        count = len(polls)
        threading.Event().wait(0.05)
        self.assertEqual(len(polls), count, "no poll after stop()")
        self.assertEqual(watcher.latest(), [self.A], "the last list stays readable")

    def test_stop_from_the_listener_itself_ends_the_thread(self):
        stopped = threading.Event()
        box = {}

        def listener(_rects):
            box["thread"] = threading.current_thread()
            box["watcher"].stop()
            stopped.set()

        box["watcher"] = WindowWatcher(interval=0.005, on_change=listener, snapshot=lambda: [self.A])
        self.addCleanup(box["watcher"].stop)
        box["watcher"].start()
        self.assertTrue(stopped.wait(5.0))
        box["thread"].join(5.0)
        self.assertFalse(box["thread"].is_alive())


class OtherSystemsTests(unittest.TestCase):
    def test_off_windows_there_are_no_windows_and_nothing_asks_for_any(self):
        for platform in ("darwin", "linux"):
            with self.subTest(platform), patch.object(sys, "platform", platform), \
                    patch.object(desktop_windows, "_win32", side_effect=AssertionError("asked Windows")):
                self.assertEqual(snapshot(), [])
                self.assertEqual(taskbar_top(1040), 1040)
                self.assertFalse(foreground_is_fullscreen())
                self.assertEqual(seconds_since_input(), 0.0)
                watcher = WindowWatcher()
                self.assertEqual(watcher.poll_once(), [])
                self.assertEqual(watcher.latest(), [])
                self.assertEqual(window_platforms(snapshot(), WORK), [], "the ground is the only platform")


@unittest.skipUnless(sys.platform == "win32", "Asks the real Windows desktop, for rectangles only")
class RealDesktopTests(unittest.TestCase):
    def own_window(self, title):
        """A real titled Tk window of this process, placed far off every display."""
        root = tk.Tk()
        self.addCleanup(root.destroy)
        root.title(title)
        root.geometry(f"320x200+{OFFSCREEN}+{OFFSCREEN}")
        root.update()
        return root

    @staticmethod
    def far_off(rects):
        return [rect for rect in rects if rect.x0 < OFFSCREEN / 2]

    def test_a_real_call_returns_sane_rectangles_with_distinct_keys(self):
        rects = snapshot()
        self.assertIsInstance(rects, list)
        for rect in rects:
            self.assertIsInstance(rect, WindowRect)
            self.assertEqual([type(value) for value in rect], [str, int, int, int, int])
            self.assertGreater(rect.x1, rect.x0)
            self.assertGreater(rect.y1, rect.y0)
            self.assertTrue(all(abs(value) < 100000 for value in rect[1:]))
        self.assertEqual(len({rect.key for rect in rects}), len(rects))
        self.assertIsInstance(window_platforms(rects, WORK), list)

    def test_this_process_own_tk_window_is_never_listed(self):
        self.own_window("Goblin test window")
        self.assertEqual(self.far_off(snapshot()), [])
        with patch.object(desktop_windows._win32(), "own_process", 0):
            as_a_strangers = self.far_off(snapshot())
            again = self.far_off(snapshot())
        self.assertEqual(len(as_a_strangers), 1, "the same window is listed once it counts as another program's")
        rect = as_a_strangers[0]
        self.assertTrue(320 <= rect.x1 - rect.x0 <= 420 and 200 <= rect.y1 - rect.y0 <= 400,
                        "a 320 by 200 window and its frame")
        self.assertEqual(again[0].key, rect.key)

    def test_a_windows_title_never_reaches_the_results_or_the_watcher(self):
        canary = "goblin-canary-5f1c9"
        self.own_window(canary)
        watcher = WindowWatcher()
        with patch.object(desktop_windows._win32(), "own_process", 0):
            rects = snapshot()
            watcher.poll_once()
        self.assertEqual(len(self.far_off(rects)), 1, "the titled window was listed")
        self.assertNotIn("canary", repr(rects))
        self.assertNotIn("canary", repr(vars(watcher)))
        self.assertNotIn("canary", repr(vars(desktop_windows._win32())))

    def test_the_real_taskbar_top_is_on_the_screen(self):
        import ctypes
        height = ctypes.windll.user32.GetSystemMetrics(1)
        top = taskbar_top(height)
        self.assertIsInstance(top, int)
        self.assertTrue(0 < top <= height, top)


if __name__ == "__main__":
    unittest.main()
