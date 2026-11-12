"""Window setup for the pet field and its tooltips on Windows.

Every window goes through here, so the rest of the widget never calls Windows itself. The field is
see-through: Windows keys one colour out of the window (-transparentcolor) and lets the pointer through
those pixels. Any other system is reported as unavailable instead of drawing an opaque box. The
process is made DPI-aware so the goblins and text stay sharp at 125% and 150%.
"""

from __future__ import annotations

import ctypes
import sys
import tkinter as tk
from typing import NamedTuple


WINDOWS_KEY = "#010203"
# The exit code and stdout line the manager reads to tell a working widget from one that cannot show.
UNAVAILABLE_EXIT = 3
READY_LINE = "GOBLIN_HORDE_WIDGET_READY"


class TransparencyUnavailable(RuntimeError):
    """This system cannot draw a see-through, always-on-top window the pointer goes through."""


def system() -> str:
    return sys.platform


def check_support() -> None:
    """Raise TransparencyUnavailable off Windows: only Windows lets the pointer through a keyed colour."""
    if system() != "win32":
        raise TransparencyUnavailable("The desktop goblins run on Windows only.")


def enable_dpi_awareness() -> str:
    """Draw at the display's real resolution instead of letting Windows blur a 96-DPI bitmap.

    Per-monitor awareness first, then system-wide; returns which one took ('' when none did, or off
    Windows). It must run before the first Tk window is created."""
    if system() != "win32":
        return ""
    attempts = (
        ("per-monitor-v2", lambda: ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)) != 0),
        ("per-monitor", lambda: ctypes.windll.shcore.SetProcessDpiAwareness(2) == 0),
        ("system", lambda: ctypes.windll.shcore.SetProcessDpiAwareness(1) == 0),
        ("system", lambda: ctypes.windll.user32.SetProcessDPIAware() != 0),
    )
    for name, attempt in attempts:
        try:
            if attempt():
                return name
        except (AttributeError, OSError, ValueError):
            continue
    return ""


def display_scale(root: tk.Misc) -> float:
    """One scale for pixel sizes: the display's pixels per inch over 96 on Windows (1.25 at 125%),
    1.0 elsewhere."""
    if system() != "win32":
        return 1.0
    try:
        return max(1.0, min(4.0, round(float(root.winfo_fpixels("1i")) / 96, 2)))
    except (tk.TclError, ValueError):
        return 1.0


def float_window(window: tk.Misc) -> None:
    """Borderless and above other windows: the pet field and tooltips."""
    window.overrideredirect(True)
    window.wm_attributes("-topmost", True)


def make_transparent(window: tk.Misc) -> str:
    """Make a floating window see-through, and the pointer go through it, wherever nothing is drawn;
    returns the background to paint with wherever the desktop should show."""
    window.configure(bg=WINDOWS_KEY)
    window.wm_attributes("-transparentcolor", WINDOWS_KEY)
    return WINDOWS_KEY


class _Rect(ctypes.Structure):
    _fields_ = [(name, ctypes.c_long) for name in ("left", "top", "right", "bottom")]


class _MonitorInfo(ctypes.Structure):
    _fields_ = [("cbSize", ctypes.c_ulong), ("rcMonitor", _Rect), ("rcWork", _Rect), ("dwFlags", ctypes.c_ulong)]


def monitor_work_area(window: tk.Misc) -> tuple[int, int, int, int]:
    """The work area (without the taskbar) of the display holding ``window``, including a second
    display; the whole virtual screen when Windows cannot say."""
    if system() == "win32":
        try:
            user32 = ctypes.windll.user32
            user32.MonitorFromWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
            user32.MonitorFromWindow.restype = ctypes.c_void_p
            user32.GetMonitorInfoW.argtypes = [ctypes.c_void_p, ctypes.POINTER(_MonitorInfo)]
            user32.GetMonitorInfoW.restype = ctypes.c_int
            monitor = user32.MonitorFromWindow(window.winfo_id(), 2)
            info = _MonitorInfo()
            info.cbSize = ctypes.sizeof(_MonitorInfo)
            if monitor and user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
                work = info.rcWork
                return work.left, work.top, work.right, work.bottom
        except (AttributeError, OSError, ValueError, tk.TclError):
            pass
    return (window.winfo_vrootx(), window.winfo_vrooty(), window.winfo_vrootx() + window.winfo_vrootwidth(),
            window.winfo_vrooty() + window.winfo_vrootheight())


SPI_GETWORKAREA = 0x0030


def primary_work_area(window: tk.Misc) -> tuple[int, int, int, int]:
    """The primary display's work area (without the taskbar): where the pet field lives."""
    if system() == "win32":
        try:
            area = _Rect()
            if ctypes.windll.user32.SystemParametersInfoW(SPI_GETWORKAREA, 0, ctypes.byref(area), 0):
                return area.left, area.top, area.right, area.bottom
        except (AttributeError, OSError, ValueError):
            pass
    return 0, 0, window.winfo_screenwidth(), window.winfo_screenheight()


class Screen(NamedTuple):
    """One connected display: its whole rectangle in virtual-screen pixels, where its work area ends,
    and whether it is the primary one."""
    left: int
    top: int
    right: int
    bottom: int
    work_bottom: int
    primary: bool


MONITORINFOF_PRIMARY = 1


def _monitor_infos() -> list[_MonitorInfo]:
    """What Windows says of each connected display, in its own order. Empty when it cannot be asked."""
    if system() != "win32":
        return []
    found: list[_MonitorInfo] = []
    try:
        user32 = ctypes.windll.user32
        user32.GetMonitorInfoW.argtypes = [ctypes.c_void_p, ctypes.POINTER(_MonitorInfo)]
        user32.GetMonitorInfoW.restype = ctypes.c_int
        callback_type = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p,
                                           ctypes.POINTER(_Rect), ctypes.c_void_p)

        def collect(monitor, _dc, _rect, _data) -> int:
            info = _MonitorInfo()
            info.cbSize = ctypes.sizeof(_MonitorInfo)
            if user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
                found.append(info)
            return 1

        callback = callback_type(collect)
        user32.EnumDisplayMonitors.argtypes = [ctypes.c_void_p, ctypes.c_void_p, callback_type, ctypes.c_void_p]
        user32.EnumDisplayMonitors.restype = ctypes.c_int
        if not user32.EnumDisplayMonitors(None, None, callback, None):
            return []
    except (AttributeError, OSError, ValueError, TypeError):
        return []
    return found


def screens() -> list[Screen]:
    """Every connected Windows display, left to right and then top to bottom, so "screen 2" means the
    same display each time it is asked. Empty when the displays could not be read, and off Windows."""
    whole = [(info.rcMonitor, info) for info in _monitor_infos()]
    return sorted((Screen(rect.left, rect.top, rect.right, rect.bottom, info.rcWork.bottom,
                          bool(info.dwFlags & MONITORINFOF_PRIMARY)) for rect, info in whole),
                  key=lambda screen: (screen.left, screen.top))


def screen_geometry(x: int, y: int) -> str:
    """A Tk position from the virtual screen's origin. Tk reads "-300" as 300 pixels in from
    the right edge, so a display left of or above the primary needs "+-300"."""
    return f"+{int(x)}+{int(y)}"


SPI_GETCLIENTAREAANIMATION = 0x1042


def system_prefers_reduced_motion() -> bool:
    """Follow Windows' 'Show animations in Windows' setting when it is off."""
    if system() != "win32":
        return False
    try:
        enabled = ctypes.c_int(1)
        if ctypes.windll.user32.SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, ctypes.byref(enabled), 0):
            return not enabled.value
    except (AttributeError, OSError):
        pass
    return False


def announce_ready() -> None:
    """Tell the manager the transparent windows are up (start waits for this line in run/widget.log)."""
    try:
        print(READY_LINE, flush=True)
    except (OSError, ValueError, AttributeError):
        pass  # pythonw started by anything but the manager has no stdout.
