"""Save what the screen shows as a PNG, to see the desktop goblins as a person would.

    python scripts/dev/screenshot.py out.png [--region x,y,w,h] [--monitor primary|all]
    python scripts/dev/screenshot.py out.png --burst 10 --interval 0.2    (writes out-0.png to out-9.png)

A region is in screen pixels, the coordinates a DPI-aware Tk window reports. Needs Pillow.
"""

from __future__ import annotations

import argparse
import ctypes
import sys
import time
from pathlib import Path


def enable_dpi_awareness() -> None:
    """Make this process see real pixels on Windows. Without it Windows hands a scaled display's
    coordinates over in its own smaller units, and a region would miss what a DPI-aware widget drew there."""
    if sys.platform != "win32":
        return
    for attempt in (lambda: ctypes.windll.shcore.SetProcessDpiAwareness(2), lambda: ctypes.windll.user32.SetProcessDPIAware()):
        try:
            attempt()
            return
        except (AttributeError, OSError):
            continue


def region(text: str) -> tuple[int, int, int, int]:
    """'x,y,w,h' as the left, top, right, bottom box a capture takes."""
    try:
        x, y, width, height = (int(part) for part in text.split(","))
    except ValueError:
        raise argparse.ArgumentTypeError("write a region as x,y,w,h in whole pixels, for example 0,0,800,600") from None
    if width <= 0 or height <= 0:
        raise argparse.ArgumentTypeError("a region's width and height must be above 0")
    return (x, y, x + width, y + height)


def frame_paths(out: Path, burst: int) -> list[Path]:
    """One path for a single capture; out-0.png, out-1.png, and so on for a burst."""
    return [out.with_name(f"{out.stem}-{index}{out.suffix}") for index in range(burst)] if burst else [out]


def main() -> None:
    parser = argparse.ArgumentParser(description="Save a PNG of the screen.")
    parser.add_argument("out", type=Path, help="The PNG to write. With --burst, the frames are out-0.png, out-1.png, and so on.")
    parser.add_argument("--region", type=region, default=None, metavar="x,y,w,h",
                        help="Only this part of the screen. Write a negative x as --region=-100,0,50,50.")
    parser.add_argument("--monitor", choices=("primary", "all"), default="primary",
                        help="The primary monitor, or every monitor as one picture (Windows only).")
    parser.add_argument("--burst", type=int, default=0, metavar="N", help="Capture N frames instead of one.")
    parser.add_argument("--interval", type=float, default=0.2, help="Seconds from one burst frame to the next.")
    args = parser.parse_args()
    if args.burst < 0 or args.interval < 0:
        parser.error("--burst and --interval cannot be below 0")
    enable_dpi_awareness()
    try:
        from PIL import ImageGrab
    except ImportError:
        sys.exit("screenshot.py needs Pillow, which this Python does not have. Install it with: python -m pip install Pillow")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    start = time.monotonic()
    for index, path in enumerate(frame_paths(args.out, args.burst)):
        time.sleep(max(0.0, start + index * args.interval - time.monotonic()))
        try:
            # The widget's see-through window is a layered window on Windows, and this is Pillow's switch for those.
            image = ImageGrab.grab(bbox=args.region, include_layered_windows=True, all_screens=args.monitor == "all")
        except OSError as error:
            sys.exit(f"The screen could not be captured: {error}")
        image.save(path, "PNG")
        print(f"{path} {image.width}x{image.height}")


if __name__ == "__main__":
    main()
