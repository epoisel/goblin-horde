"""Where a goblin can stand: the ground and the visible top edges of open windows.

The simulation and the window tracker share these types, so this module is pure: no Tk, no system
calls. Coordinates are screen pixels, x right and y down."""

from __future__ import annotations

from typing import NamedTuple


GROUND = "ground"
WINDOW = "window"


class Platform(NamedTuple):
    """A horizontal stretch a goblin stands on, feet at ``y``.

    ``kind`` is GROUND or WINDOW. The same kind and ``key`` next tick is the same surface, moved.
    ``origin`` is the surface's own anchor: a window's top-left corner, even where a window in front
    hides it or the work area clips it. A rider follows the change in ``origin``, so a stretch that
    only got clipped differently carries nobody sideways."""
    x0: float
    x1: float
    y: float
    kind: str
    key: str
    origin: tuple[float, float]


class WindowRect(NamedTuple):
    """One top-level window: an opaque stable key and its outer rectangle. Nothing else is kept."""
    key: str
    x0: int
    y0: int
    x1: int
    y1: int


def window_platforms(rects, work_area, min_width: int = 24, headroom: int = 40) -> list[Platform]:
    """The visible stretches of each window's top edge, top window first, each left to right.

    ``rects`` are WindowRects in z-order, top first; ``work_area`` is (left, top, right, bottom),
    with the ground the goblins run on as its bottom when a taskbar lies over the work area.
    A stretch is the part of a top edge inside the work area that no window above it covers; every
    stretch of one window carries that window's key. Left out: stretches narrower than
    ``min_width`` (so every window that narrow), windows with under ``headroom`` pixels of work
    area above their top edge (a maximized or full-screen window has none), and top edges at or
    below the work area's bottom. A window that is left out still covers the ones below it."""
    left, top, right, bottom = work_area
    platforms: list[Platform] = []
    for depth, rect in enumerate(rects):
        y = rect.y0
        if y <= top or y - top < headroom or y >= bottom:
            continue
        covers = [(above.x0, above.x1) for above in rects[:depth] if above.y0 <= y < above.y1]
        origin = (float(rect.x0), float(y))
        platforms += [Platform(float(x0), float(x1), float(y), WINDOW, rect.key, origin)
                      for x0, x1 in _uncovered(max(rect.x0, left), min(rect.x1, right), covers)
                      if x1 - x0 >= min_width]
    return platforms


def _uncovered(start: float, end: float, covers: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """The parts of start..end outside every (x0, x1) cover, left to right and never touching."""
    gaps = []
    for x0, x1 in sorted(covers):
        if start >= end:
            break
        if x0 > start:
            gaps.append((start, min(x0, end)))
        start = max(start, x1)
    if start < end:
        gaps.append((start, end))
    return gaps
