"""Window setup for the Horde window and the goblin strip on Windows and macOS.

Every window goes through here, so the rest of the widget never asks which system it is on.
The strip is see-through: Windows keys one colour out of the window (-transparentcolor), and macOS
Tk (Aqua, 8.6 or newer) makes the whole window non-opaque (-transparent) and lets widgets painted
"systemTransparent" show the desktop through. Anything else is reported as unavailable instead of
drawing an opaque box. The main window is an ordinary decorated window; on Windows it gets a dark
title bar and the process is made DPI-aware so text stays sharp at 125% and 150%.
"""

from __future__ import annotations

import ctypes
import signal
import subprocess
import sys
import tkinter as tk


WINDOWS_KEY = "#010203"
MAC_CLEAR = "systemTransparent"
# The macOS menu bar; borderless windows can slide under it, so placement keeps clear of it.
MAC_MENU_BAR = 25
# DwmSetWindowAttribute: dark title bar (20; 19 on early Windows 10 builds) and caption colour (35, Windows 11).
DWM_DARK, DWM_DARK_OLD, DWM_CAPTION = 20, 19, 35
APP_ID = "GoblinHorde.Window"
# The exit code and stdout line the manager reads to tell a working widget from a fallback.
UNAVAILABLE_EXIT = 3
READY_LINE = "GOBLIN_HORDE_WIDGET_READY"


class TransparencyUnavailable(RuntimeError):
    """This Python/Tk cannot draw a transparent always-on-top window."""


def system() -> str:
    return sys.platform


def is_mac() -> bool:
    return system() == "darwin"


def check_support(root: tk.Tk) -> None:
    """Raise TransparencyUnavailable when this system's Tk cannot show the transparent widget."""
    platform = system()
    if platform == "win32":
        return
    if platform != "darwin":
        raise TransparencyUnavailable("The transparent desktop goblins run on Windows and macOS.")
    windowing = str(root.tk.call("tk", "windowingsystem"))
    if windowing != "aqua":
        raise TransparencyUnavailable(f"This Python uses an {windowing} Tk; the transparent widget needs the native macOS (Aqua) Tk.")
    version = str(root.getvar("tk_version"))
    if tuple(int(part) for part in version.split(".")[:2]) < (8, 6):
        raise TransparencyUnavailable(f"This Python ships Tk {version}; the transparent widget needs Tk 8.6 or newer "
                                      "(python.org or Homebrew Python).")


def prepare_process() -> None:
    """Before any window exists. Windows: the taskbar shows Goblin Horde's own icon, not Python's."""
    if system() != "win32":
        return
    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_ID)
    except (AttributeError, OSError):
        pass


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
    1.0 elsewhere, where Tk already works in points."""
    if system() != "win32":
        return 1.0
    try:
        return max(1.0, min(4.0, round(float(root.winfo_fpixels("1i")) / 96, 2)))
    except (tk.TclError, ValueError):
        return 1.0


def _colorref(color: str) -> int:
    value = int(color.lstrip("#"), 16)
    return ((value & 0xff) << 16) | (value & 0xff00) | ((value >> 16) & 0xff)


def dark_title_bar(window: tk.Misc, caption: str = "") -> bool:
    """A dark title bar for a decorated window on Windows 10 and 11, and on Windows 11 a caption in
    the window's own colour. Failures are ignored: an older Windows keeps its usual title bar."""
    if system() != "win32":
        return False
    try:
        window.update_idletasks()
        hwnd = int(str(window.wm_frame()), 16)
        dwm = ctypes.windll.dwmapi
        on = ctypes.c_int(1)
        done = dwm.DwmSetWindowAttribute(hwnd, DWM_DARK, ctypes.byref(on), ctypes.sizeof(on)) == 0
        if not done:
            done = dwm.DwmSetWindowAttribute(hwnd, DWM_DARK_OLD, ctypes.byref(on), ctypes.sizeof(on)) == 0
        if caption:
            color = ctypes.c_int(_colorref(caption))
            dwm.DwmSetWindowAttribute(hwnd, DWM_CAPTION, ctypes.byref(color), ctypes.sizeof(color))
        return bool(done)
    except (AttributeError, OSError, ValueError, tk.TclError):
        return False


def set_icon(root: tk.Tk, path: str) -> None:
    """The window and taskbar icon (Windows .ico); macOS uses the Dock's own."""
    if system() != "win32":
        return
    try:
        root.iconbitmap(default=path)
    except tk.TclError:
        pass


def prepare_app(root: tk.Tk, on_quit=None, on_reopen=None) -> None:
    """App-wide setup once the root exists: on macOS, Cmd+Q quits through the app (so settings are
    saved) and clicking the Dock icon brings the window back. Windows needs none."""
    if not is_mac():
        return
    if on_quit is not None:
        root.createcommand("tk::mac::Quit", on_quit)
    if on_reopen is not None:
        root.createcommand("tk::mac::ReopenApplication", on_reopen)


def float_window(window: tk.Misc) -> None:
    """Borderless and above other windows: the goblin strip and tooltips."""
    window.overrideredirect(True)
    window.wm_attributes("-topmost", True)


def make_transparent(window: tk.Misc) -> str:
    """Make a floating window see-through where nothing is drawn; returns the background to paint
    with wherever the desktop should show (the window itself and its transparent canvases)."""
    if is_mac():
        window.wm_attributes("-transparent", True)
        window.configure(bg=MAC_CLEAR)
        return MAC_CLEAR
    window.configure(bg=WINDOWS_KEY)
    window.wm_attributes("-transparentcolor", WINDOWS_KEY)
    return WINDOWS_KEY


def context_events() -> tuple[str, ...]:
    """The right-click events. Aqua Tk 8.6 reports the right button as 2 (Tk 9 as 3), and a Mac
    without a second button uses Control-click."""
    if is_mac():
        return ("<Button-2>", "<Button-3>", "<Control-Button-1>")
    return ("<Button-3>",)


def bind_context(widget: tk.Misc, callback) -> None:
    for sequence in context_events():
        widget.bind(sequence, callback)
    if is_mac():
        # The release of a Control-click is not a left click: it must not select, drag, or press.
        widget.bind("<Control-ButtonRelease-1>", lambda _event: "break")


def menu_bar_inset() -> int:
    return MAC_MENU_BAR if is_mac() else 0


class _Rect(ctypes.Structure):
    _fields_ = [(name, ctypes.c_long) for name in ("left", "top", "right", "bottom")]


class _MonitorInfo(ctypes.Structure):
    _fields_ = [("cbSize", ctypes.c_ulong), ("rcMonitor", _Rect), ("rcWork", _Rect), ("dwFlags", ctypes.c_ulong)]


def monitor_work_area(window: tk.Misc) -> tuple[int, int, int, int]:
    """The work area (without the taskbar) of the display holding ``window``, including a second
    Windows display; elsewhere (macOS) the main display below its menu bar."""
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
    return (window.winfo_vrootx(), window.winfo_vrooty() + menu_bar_inset(),
            window.winfo_vrootx() + window.winfo_vrootwidth(),
            window.winfo_vrooty() + window.winfo_vrootheight())


def monitor_areas() -> list[tuple[int, int, int, int]]:
    """Work areas of every connected Windows display, including ones left of or above the primary.

    An empty list means the displays could not be read; callers then trust saved positions."""
    if system() != "win32":
        return []
    areas: list[tuple[int, int, int, int]] = []
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
                work = info.rcWork
                areas.append((work.left, work.top, work.right, work.bottom))
            return 1

        callback = callback_type(collect)
        user32.EnumDisplayMonitors.argtypes = [ctypes.c_void_p, ctypes.c_void_p, callback_type, ctypes.c_void_p]
        user32.EnumDisplayMonitors.restype = ctypes.c_int
        if not user32.EnumDisplayMonitors(None, None, callback, None):
            return []
    except (AttributeError, OSError, ValueError, TypeError):
        return []
    return areas


def screen_geometry(x: int, y: int) -> str:
    """A Tk position from the virtual screen's origin. Tk reads "-300" as 300 pixels in from
    the right edge, so a display left of or above the primary needs "+-300"."""
    return f"+{int(x)}+{int(y)}"


def mac_prefers_reduced_motion(run=subprocess.run) -> bool:
    """System Settings → Accessibility → Display → Reduce motion."""
    try:
        result = run(["defaults", "read", "com.apple.universalaccess", "reduceMotion"],
                     capture_output=True, text=True, timeout=3)
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0 and result.stdout.strip() == "1"


def close_on_terminate(root: tk.Tk, close) -> None:
    """On macOS, `stop` sends SIGTERM: close through the widget so its layout is saved first."""
    if is_mac():
        signal.signal(signal.SIGTERM, lambda *_args: root.after_idle(close))


def announce_ready() -> None:
    """Tell the manager the transparent windows are up (start waits for this line in run/widget.log)."""
    try:
        print(READY_LINE, flush=True)
    except (OSError, ValueError, AttributeError):
        pass  # pythonw started by anything but the manager has no stdout.
