"""Window setup for the transparent desktop goblins on Windows and macOS.

Every widget window goes through here, so the rest of the widget never asks which system it is on.
Windows keys one colour out of the window (-transparentcolor). macOS Tk (Aqua, 8.6 or newer) makes
the whole window non-opaque (-transparent) and lets widgets painted "systemTransparent" show the
desktop through. Anything else is reported as unavailable instead of drawing an opaque box.
"""

from __future__ import annotations

import ctypes
import ctypes.util
import signal
import subprocess
import sys
import tkinter as tk


WINDOWS_KEY = "#010203"
MAC_CLEAR = "systemTransparent"
# The macOS menu bar; borderless windows can slide under it, so placement keeps clear of it.
MAC_MENU_BAR = 25
# The widget's layout was drawn at Windows' 96 pixels per inch; Aqua Tk assumes 72.
WINDOWS_SCALING = 96 / 72
# Windows fonts the widget names, and the macOS fonts with the same role.
MAC_FONTS = {"Consolas": "Menlo", "Bahnschrift": "Avenir Next Condensed", "Segoe UI": "Helvetica Neue"}
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


def prepare_app(root: tk.Tk, on_quit=None) -> None:
    """App-wide setup once the root exists: Windows needs none."""
    if not is_mac():
        return
    root.tk.call("tk", "scaling", WINDOWS_SCALING)
    if on_quit is not None:
        # A Quit from macOS (Cmd+Q, or the Dock if its icon could not be hidden) saves layout like the menu does.
        root.createcommand("tk::mac::Quit", on_quit)
    hide_dock_icon()


def hide_dock_icon() -> bool:
    """Run as an accessory app: no Dock icon or menu bar for a desktop widget. Best effort."""
    try:
        objc = ctypes.cdll.LoadLibrary(ctypes.util.find_library("objc") or "/usr/lib/libobjc.A.dylib")
        objc.objc_getClass.restype = ctypes.c_void_p
        objc.objc_getClass.argtypes = [ctypes.c_char_p]
        objc.sel_registerName.restype = ctypes.c_void_p
        objc.sel_registerName.argtypes = [ctypes.c_char_p]
        send = objc.objc_msgSend
        send.restype = ctypes.c_void_p
        send.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        app = send(objc.objc_getClass(b"NSApplication"), objc.sel_registerName(b"sharedApplication"))
        if not app:
            return False
        send.restype = ctypes.c_bool
        send.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_long]
        # NSApplicationActivationPolicyAccessory
        return bool(send(app, objc.sel_registerName(b"setActivationPolicy:"), 1))
    except (AttributeError, OSError, TypeError, ValueError):
        return False


def float_window(window: tk.Misc) -> None:
    """Borderless and above other windows: the launchpad, party roster, notes, streams, and tips."""
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


def ui_family(name: str) -> str:
    return MAC_FONTS.get(name, name) if is_mac() else name


def ui_font(name: str, *rest) -> tuple:
    """A Tk font tuple naming this system's equivalent of a Windows font."""
    return (ui_family(name), *rest)


def menu_bar_inset() -> int:
    return MAC_MENU_BAR if is_mac() else 0


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
