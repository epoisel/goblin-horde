"""Where the open windows are, so goblins can stand on their top edges. Read only.

``snapshot()`` lists the top-level windows a person can see, top of the z-order first, as rectangles
with an opaque key. On macOS and Linux it is always empty, so the ground is the only platform there.
``foreground_is_fullscreen()`` and ``seconds_since_input()`` tell the horde when to step aside and
when nobody is watching.

Privacy. Nothing here copies a window's title or asks which program owns it. The only thing asked
about a title is its length, to tell an untitled helper window from a real one. A window's class
is compared with the shell's own classes and dropped. A WindowRect holds four numbers and a salted
hash of the window handle, and the salt is new on every run.

Coordinates. Every rectangle is measured in real (physical) pixels, the units a DPI-aware Tk window
reports, which is how the widget runs. For that the calling thread is made per-monitor DPI aware
for the length of one call and put back afterwards, and the drawn outline that the compositor
reports is in real pixels whatever the caller is. A process that is not DPI aware sees a scaled-down
screen, so its result is multiplied by the primary display's width as that process sees it over the
display's real width. That matches the process's own Tk coordinates on the primary display.
"""

from __future__ import annotations

import ctypes
import functools
import hashlib
import os
import sys
import threading
from contextlib import contextmanager

from pet_platform import WindowRect


GWL_STYLE, GWL_EXSTYLE = -16, -20
WS_CAPTION = 0x00C00000
WS_THICKFRAME = 0x00040000
WS_EX_TOOLWINDOW, WS_EX_APPWINDOW = 0x00000080, 0x00040000
CLICK_THROUGH = 0x00080000 | 0x00000020  # WS_EX_LAYERED with WS_EX_TRANSPARENT
DWMWA_EXTENDED_FRAME_BOUNDS, DWMWA_CLOAKED = 9, 14
SM_CXSCREEN, SM_CYSCREEN = 0, 1
PER_MONITOR_AWARE_V2 = -4
TASKBAR_CLASS, SECOND_TASKBAR_CLASS = "Shell_TrayWnd", "Shell_SecondaryTrayWnd"
# The desktop itself and the taskbars: under everything or part of the ground, never a platform.
SHELL_CLASSES = frozenset({"Progman", "WorkerW", TASKBAR_CLASS, SECOND_TASKBAR_CLASS})
CLASS_NAME_LENGTH = 64

# Why a visible top-level window is left out, cheapest question first. "own process" stays ahead of
# "untitled": asking a window of this process for its title length would send that window a message.
SKIP_RULES = (
    ("minimized", lambda desktop, hwnd: desktop.minimized(hwnd)),
    ("tool window", lambda desktop, hwnd:
        desktop.ex_style(hwnd) & (WS_EX_TOOLWINDOW | WS_EX_APPWINDOW) == WS_EX_TOOLWINDOW),
    ("click-through overlay", lambda desktop, hwnd: desktop.ex_style(hwnd) & CLICK_THROUGH == CLICK_THROUGH),
    ("own process", lambda desktop, hwnd: desktop.process(hwnd) == desktop.own_process),
    ("cloaked", lambda desktop, hwnd: desktop.cloaked(hwnd)),
    ("shell", lambda desktop, hwnd: desktop.window_class(hwnd) in SHELL_CLASSES),
    ("untitled without a caption", lambda desktop, hwnd:
        not desktop.titled(hwnd) and desktop.style(hwnd) & WS_CAPTION != WS_CAPTION),
)

# Why the window in front is not a full-screen app. A maximized window that kept its frame is only
# maximized: on a desktop whose work area ignores the taskbar it covers the whole display too.
NOT_FULLSCREEN = (
    ("own process", lambda desktop, hwnd: desktop.process(hwnd) == desktop.own_process),
    ("shell", lambda desktop, hwnd: desktop.window_class(hwnd) in SHELL_CLASSES),
    ("maximized", lambda desktop, hwnd:
        desktop.maximized(hwnd) and bool(desktop.style(hwnd) & (WS_CAPTION | WS_THICKFRAME))),
)

_FAILURES = (AttributeError, OSError, ValueError, ctypes.ArgumentError)
_SALT = os.urandom(16)


class _Rect(ctypes.Structure):
    _fields_ = [(name, ctypes.c_long) for name in ("left", "top", "right", "bottom")]


class _LastInput(ctypes.Structure):
    _fields_ = [("size", ctypes.c_uint), ("tick", ctypes.c_ulong)]


class _Win32:
    """The questions this module asks Windows. None returns a title or a program's name."""

    def __init__(self) -> None:
        # Its own library objects: argument types set here never leak into ctypes.windll's shared ones.
        user32, dwmapi, kernel32 = ctypes.WinDLL("user32"), ctypes.WinDLL("dwmapi"), ctypes.WinDLL("kernel32")
        handle = ctypes.c_void_p
        self._callback = ctypes.WINFUNCTYPE(ctypes.c_int, handle, handle)
        self._enum = self._bind(user32.EnumWindows, ctypes.c_int, self._callback, handle)
        self._visible = self._bind(user32.IsWindowVisible, ctypes.c_int, handle)
        self._iconic = self._bind(user32.IsIconic, ctypes.c_int, handle)
        self._long = self._bind(user32.GetWindowLongW, ctypes.c_long, handle, ctypes.c_int)
        self._owner = self._bind(user32.GetWindowThreadProcessId, ctypes.c_ulong, handle,
                                 ctypes.POINTER(ctypes.c_ulong))
        self._class = self._bind(user32.GetClassNameW, ctypes.c_int, handle, ctypes.c_wchar_p, ctypes.c_int)
        self._title_length = self._bind(user32.GetWindowTextLengthW, ctypes.c_int, handle)
        self._rect = self._bind(user32.GetWindowRect, ctypes.c_int, handle, ctypes.POINTER(_Rect))
        self._find = self._bind(user32.FindWindowW, handle, ctypes.c_wchar_p, ctypes.c_wchar_p)
        self._find_next = self._bind(user32.FindWindowExW, handle, handle, handle, ctypes.c_wchar_p, ctypes.c_wchar_p)
        self._shell = self._bind(user32.GetShellWindow, handle)
        self._metric = self._bind(user32.GetSystemMetrics, ctypes.c_int, ctypes.c_int)
        self._foreground = self._bind(user32.GetForegroundWindow, handle)
        self._zoomed = self._bind(user32.IsZoomed, ctypes.c_int, handle)
        self._last_input = self._bind(user32.GetLastInputInfo, ctypes.c_int, ctypes.POINTER(_LastInput))
        self._ticks = self._bind(kernel32.GetTickCount, ctypes.c_ulong)
        self._attribute = self._bind(dwmapi.DwmGetWindowAttribute, ctypes.c_long, handle, ctypes.c_ulong,
                                     ctypes.c_void_p, ctypes.c_ulong)
        try:
            self._awareness = self._bind(user32.SetThreadDpiAwarenessContext, handle, handle)
        except AttributeError:  # Before Windows 10 1607: measure in the process's own units.
            self._awareness = None
        self.own_process = os.getpid()

    @staticmethod
    def _bind(function, restype, *argtypes):
        function.restype, function.argtypes = restype, argtypes
        return function

    @contextmanager
    def real_pixels(self):
        """Answer in real pixels inside the block. Yields the factor from real pixels to this
        process's own units: 1.0 when it is DPI aware."""
        own = self._metric(SM_CXSCREEN)
        previous = self._awareness(PER_MONITOR_AWARE_V2) if self._awareness else None
        try:
            real = self._metric(SM_CXSCREEN)
            yield own / real if own > 0 and real > 0 else 1.0
        finally:
            if previous:
                self._awareness(previous)

    def windows(self) -> list[int]:
        """Visible top-level windows above the desktop, top of the z-order first."""
        found: list[int] = []
        visible, shell = self._visible, self._shell()

        def visit(hwnd, _param) -> int:
            if hwnd == shell:
                # The desktop window spans every display, so nothing under it shows, and the many
                # hidden windows parked below it need no visit.
                return 0
            if visible(hwnd):
                found.append(hwnd)
            return 1

        self._enum(self._callback(visit), None)
        return found

    def minimized(self, hwnd: int) -> bool:
        return bool(self._iconic(hwnd))

    def style(self, hwnd: int) -> int:
        return self._long(hwnd, GWL_STYLE)

    def ex_style(self, hwnd: int) -> int:
        return self._long(hwnd, GWL_EXSTYLE)

    def process(self, hwnd: int) -> int:
        owner = ctypes.c_ulong()
        self._owner(hwnd, ctypes.byref(owner))
        return owner.value

    def cloaked(self, hwnd: int) -> bool:
        """Hidden by the system though marked visible: another virtual desktop, a suspended app."""
        value = ctypes.c_int()
        return self._attribute(hwnd, DWMWA_CLOAKED, ctypes.byref(value), ctypes.sizeof(value)) == 0 and value.value != 0

    def window_class(self, hwnd: int) -> str:
        name = ctypes.create_unicode_buffer(CLASS_NAME_LENGTH)
        self._class(hwnd, name, CLASS_NAME_LENGTH)
        return name.value

    def titled(self, hwnd: int) -> bool:
        return self._title_length(hwnd) > 0

    def frame(self, hwnd: int) -> tuple[int, int, int, int] | None:
        """The window's outline as drawn, without its drop shadow; the plain window rectangle when
        the compositor cannot say."""
        rect = _Rect()
        drawn = self._attribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, ctypes.byref(rect), ctypes.sizeof(rect)) == 0
        if not drawn and not self._rect(hwnd, ctypes.byref(rect)):
            return None
        return rect.left, rect.top, rect.right, rect.bottom

    def taskbar(self, display: tuple[int, int, int, int] | None = None) -> tuple[int, int, int, int] | None:
        """The primary taskbar's rectangle, or None when there is none on show. Given a display's
        rectangle, the taskbar on that display instead: the primary one or a second display's."""
        found = None if display is None else self._second_taskbars(display)
        if found is not None:
            return found
        hwnd = self._find(TASKBAR_CLASS, None)
        rect = _Rect()
        if not hwnd or not self._visible(hwnd) or not self._rect(hwnd, ctypes.byref(rect)):
            return None
        frame = rect.left, rect.top, rect.right, rect.bottom
        return frame if display is None or _inside(frame, display) else None

    def _second_taskbars(self, display: tuple[int, int, int, int]) -> tuple[int, int, int, int] | None:
        """The taskbar Windows draws on a display other than the primary, when one lies on ``display``."""
        hwnd = self._find_next(None, None, SECOND_TASKBAR_CLASS, None)
        while hwnd:
            rect = _Rect()
            if self._visible(hwnd) and self._rect(hwnd, ctypes.byref(rect)):
                frame = rect.left, rect.top, rect.right, rect.bottom
                if _inside(frame, display):
                    return frame
            hwnd = self._find_next(None, hwnd, SECOND_TASKBAR_CLASS, None)
        return None

    def foreground(self) -> int | None:
        """The window the person is working in, or None between two of them."""
        return self._foreground()

    def maximized(self, hwnd: int) -> bool:
        return bool(self._zoomed(hwnd))

    def screen(self) -> tuple[int, int]:
        """The primary display's width and height."""
        return self._metric(SM_CXSCREEN), self._metric(SM_CYSCREEN)

    def idle_ms(self) -> int:
        """Milliseconds since the last key press or pointer move, on a clock that wraps at 32 bits."""
        last = _LastInput(ctypes.sizeof(_LastInput), 0)
        if not self._last_input(ctypes.byref(last)):
            return 0
        return (self._ticks() - last.tick) & 0xFFFFFFFF


@functools.lru_cache(maxsize=1)
def _win32() -> _Win32:
    return _Win32()


def _key(hwnd: int) -> str:
    """A stable name for a window that says nothing about it."""
    return hashlib.blake2s(hwnd.to_bytes(8, "little"), key=_SALT, digest_size=8).hexdigest()


def _scaled(frame: tuple[int, int, int, int], scale: float) -> tuple[int, ...]:
    return frame if scale == 1.0 else tuple(round(value * scale) for value in frame)


def snapshot() -> list[WindowRect]:
    """The windows a goblin could stand on or be hidden by, top of the z-order first.

    Left out: see SKIP_RULES, plus windows with no area. Empty off Windows and whenever Windows
    cannot be asked; never raises."""
    if sys.platform != "win32":
        return []
    try:
        desktop = _win32()
        with desktop.real_pixels() as scale:
            frames = [(hwnd, desktop.frame(hwnd)) for hwnd in desktop.windows()
                      if not any(skip(desktop, hwnd) for _reason, skip in SKIP_RULES)]
    except _FAILURES:
        return []
    rects = (WindowRect(_key(hwnd), *_scaled(frame, scale)) for hwnd, frame in frames if frame)
    return [rect for rect in rects if rect.x1 > rect.x0 and rect.y1 > rect.y0]


def _inside(frame: tuple[int, int, int, int], display: tuple[int, int, int, int]) -> bool:
    """Whether the middle of ``frame`` lies on ``display``, both as (left, top, right, bottom)."""
    x, y = (frame[0] + frame[2]) / 2, (frame[1] + frame[3]) / 2
    return display[0] <= x < display[2] and display[1] <= y < display[3]


def taskbar_top(work_area_bottom: int, display: tuple[int, int, int, int] | None = None) -> int:
    """The y of the taskbar's top edge, where the horde's feet rest.

    Usually the work area ends where the taskbar begins and the two agree. They differ when the
    taskbar lies over the work area: on a desktop whose work area ignores it the answer is the
    taskbar's own top, and when it has slid away to hide (under half of it left above the work
    area's bottom) the answer is ``work_area_bottom``, as it is for a taskbar docked on another
    side or not on show. ``display`` is the (left, top, right, bottom) of the display the horde
    stands on, the primary one when it is left out. Same units as snapshot(); never raises."""
    if sys.platform != "win32":
        return work_area_bottom
    try:
        desktop = _win32()
        with desktop.real_pixels() as scale:
            frame = desktop.taskbar() if display is None else desktop.taskbar(_scaled(display, 1 / scale))
    except _FAILURES:
        return work_area_bottom
    if frame is None:
        return work_area_bottom
    left, top, right, bottom = _scaled(frame, scale)
    along_the_bottom = right - left > bottom - top and bottom >= work_area_bottom
    half_on_show = top + bottom <= 2 * work_area_bottom
    return top if along_the_bottom and half_on_show else work_area_bottom


def foreground_is_fullscreen(display: tuple[int, int, int, int] | None = None) -> bool:
    """Whether a full-screen app (a game, a video, a slide show) is in front on the display where the
    horde lives, the primary one unless ``display`` (left, top, right, bottom) says otherwise: the
    window in front covers that whole display and none of NOT_FULLSCREEN holds for it. A full-screen
    app on another display does not count. False off Windows and whenever Windows cannot be asked;
    never raises."""
    if sys.platform != "win32":
        return False
    try:
        desktop = _win32()
        with desktop.real_pixels() as scale:
            hwnd = desktop.foreground()
            if not hwnd or any(holds(desktop, hwnd) for _reason, holds in NOT_FULLSCREEN):
                return False
            frame = desktop.frame(hwnd)
            left, top, right, bottom = (0, 0, *desktop.screen()) if display is None else _scaled(display, 1 / scale)
    except _FAILURES:
        return False
    return frame is not None and frame[0] <= left and frame[1] <= top and frame[2] >= right and frame[3] >= bottom


def seconds_since_input() -> float:
    """How long the person has left the keyboard and the pointer alone. 0.0 off Windows and whenever
    Windows cannot be asked; never raises."""
    if sys.platform != "win32":
        return 0.0
    try:
        return _win32().idle_ms() / 1000.0
    except _FAILURES:
        return 0.0


class WindowWatcher:
    """Keeps the latest snapshot() fresh, from a daemon thread once start() is called.

    ``on_change(rects)`` runs on the polling thread whenever the list differs from the one before
    (a window moved, opened, closed or changed z-order); a Tk caller reads ``latest()`` from its own
    tick instead of touching widgets there. Nothing here raises."""

    def __init__(self, interval: float = 0.12, on_change=None, snapshot=snapshot) -> None:
        self.interval = interval
        self._on_change = on_change
        self._snapshot = snapshot
        # One immutable tuple, replaced whole: a reader on another thread needs no lock.
        self._latest: tuple[WindowRect, ...] = ()
        self._stopping = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> "WindowWatcher":
        """Begin polling every ``interval`` seconds. Calling it again while running changes nothing."""
        if self._thread is None or not self._thread.is_alive():
            self._stopping.clear()
            self._thread = threading.Thread(target=self._run, name="goblin-window-watcher", daemon=True)
            self._thread.start()
        return self

    def poll_once(self) -> list[WindowRect]:
        """Take one snapshot now, on the calling thread. A failed snapshot keeps the last list."""
        try:
            rects = tuple(self._snapshot())
        except Exception:
            return list(self._latest)
        if rects != self._latest:
            self._latest = rects
            self._notify(rects)
        return list(rects)

    def latest(self) -> list[WindowRect]:
        return list(self._latest)

    def stop(self) -> None:
        """Stop polling. ``latest()`` keeps answering with the last list."""
        self._stopping.set()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=1.0)

    def _notify(self, rects: tuple[WindowRect, ...]) -> None:
        if self._on_change is None:
            return
        try:
            self._on_change(list(rects))
        except Exception:
            pass

    def _run(self) -> None:
        while not self._stopping.is_set():
            self.poll_once()
            self._stopping.wait(self.interval)
