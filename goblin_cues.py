"""Pixel cues and body poses that show a goblin's public action at a glance.

Every surface (launchpad, party roster, stream portrait, goblin line) draws the same cue
on the goblin's own pixel grid, so a cue is 8x8 sprite pixels at any scale: 16 screen
pixels at scale 2 and 32 at scale 4. Cues illustrate observable work only. The thought
bubble holds animated dots, never words, because the widget cannot see private reasoning.
"""

from __future__ import annotations

import ctypes
import sys
from typing import NamedTuple

# A limited palette that reads on the dark dialogue panels and on a light desktop alike:
# light fills carry the shape on dark panels, the near-black rim carries it on light ones.
CUE_COLORS = {
    "o": "#10201a",  # rim
    "p": "#f6ecd2",  # parchment
    "h": "#fffbed",  # glint
    "g": "#bfe4df",  # lens glass
    "y": "#dfbb78",  # brass
    "w": "#b07a46",  # haft wood
    "s": "#aeb9ae",  # iron
    "r": "#e18a78",  # alarm red
    "d": "#24352b",  # ink dots
    "l": "#c7b9e2",  # portal lilac
    "v": "#7a68b0",  # portal violet
    "m": "#2b2342",  # portal depth
}

# Cues sit up and to the right of the head. With body sway, a goblin and its cue stay
# within FOOTPRINT columns, which the launchpad, roster, and stream layouts reserve.
CUE_LEFT = 15
CUE_TOP = 0
CUE_SIZE = 8
FOOTPRINT = 24
BEATS = 4
HELD = {"search", "build"}  # Held tools move with the body; signs float beside the head.

MAGNIFIER = (
    "...oooo.",
    "..ohgggo",
    "..oggggo",
    "..oggggo",
    "...oooo.",
    "..yy....",
    ".yy.....",
    "yy......",
)
MAGNIFIER_GLINT = (
    "...oooo.",
    "..ogggho",
    "..ogghgo",
    "..oggggo",
    "...oooo.",
    "..yy....",
    ".yy.....",
    "yy......",
)
HAMMER_UP = (
    "oooooo..",
    "osssso..",
    "oowooo..",
    "..w.....",
    "..w.....",
    "..w.....",
    "..w.....",
    "..y.....",
)
HAMMER_HIT = (
    "........",
    ".....ooo",
    ".....oso",
    "ywwwwwso",
    ".....oso",
    ".....ooo",
    "........",
    "........",
)
HAMMER_SPARK = (
    "......y.",
    ".....ooo",
    ".....oso",
    "ywwwwwso",
    ".....oso",
    ".....ooo",
    "....y..y",
    "......y.",
)


def _bubble(dots: int) -> tuple[str, ...]:
    a, b, c = ("d" if index < dots else "p" for index in range(3))
    return (
        ".oooooo.",
        "oppppppo",
        f"op{a}p{b}p{c}o",
        "oppppppo",
        ".oooooo.",
        ".pp.....",
        "p.......",
        "........",
    )


def _bell(clapper: int) -> tuple[str, ...]:
    bottom = ["."] * 8
    bottom[clapper] = bottom[clapper + 1] = "p"
    return (
        "...oo...",
        "..oyyo..",
        ".oyhyyo.",
        ".oyhyyo.",
        ".oyyyyo.",
        "oyyyyyyo",
        "oooooooo",
        "".join(bottom),
    )


CROSS = (
    "rr....rr",
    "rrr..rrr",
    ".rrrrrr.",
    "..rrrr..",
    "..rrrr..",
    ".rrrrrr.",
    "rrr..rrr",
    "rr....rr",
)
CROSS_FLASH = (
    "rr....rr",
    "rrr..rrr",
    ".rrrrrr.",
    "..rhhr..",
    "..rhhr..",
    ".rrrrrr.",
    "rrr..rrr",
    "rr....rr",
)


class CueFrame(NamedTuple):
    art: tuple[str, ...]
    dx: int = 0
    dy: int = 0


class Pose(NamedTuple):
    """Body offset in sprite pixels, plus arm, eye, and foot poses."""
    dx: int = 0
    dy: int = 0
    arm: str = "rest"
    eyes: str = "front"
    step: int = 0  # 1 lifts the left foot, 2 the right.


# Four beats per action. Both the cue and the body change on every beat, so motion stays
# visible at scale 2 where one sprite pixel is two screen pixels.
CUES: dict[str, tuple[CueFrame, ...]] = {
    "search": (CueFrame(MAGNIFIER, 0, 1), CueFrame(MAGNIFIER, 0, 0),
               CueFrame(MAGNIFIER_GLINT, 0, 1), CueFrame(MAGNIFIER, -1, 0)),
    "build": (CueFrame(HAMMER_UP, 0, 0), CueFrame(HAMMER_UP, 0, -1),
              CueFrame(HAMMER_SPARK, 0, 1), CueFrame(HAMMER_HIT, 0, 1)),
    "think": (CueFrame(_bubble(1)), CueFrame(_bubble(2)),
              CueFrame(_bubble(3)), CueFrame(_bubble(3), 0, -1)),
    "waiting": (CueFrame(_bell(3)), CueFrame(_bell(2), -1, 0),
                CueFrame(_bell(3)), CueFrame(_bell(4), 1, 0)),
    "trouble": (CueFrame(CROSS), CueFrame(CROSS_FLASH),
                CueFrame(CROSS, 1, 0), CueFrame(CROSS_FLASH, -1, 0)),
}

POSES: dict[str, tuple[Pose, ...]] = {
    "search": (Pose(0, 0, "reach", "right"), Pose(1, -1, "reach_high", "right", 1),
               Pose(0, 0, "reach", "right"), Pose(-1, -1, "reach_high", "front", 2)),
    "build": (Pose(0, 0, "raise", "right"), Pose(0, -1, "raise", "right"),
              Pose(1, 0, "reach", "right"), Pose(0, 0, "reach", "front")),
    "think": (Pose(0, 0, "chin", "up"), Pose(0, -1, "chin", "up"),
              Pose(0, 0, "chin", "up"), Pose(1, 0, "chin", "right")),
    "waiting": (Pose(0, 0, "wave_high", "front"), Pose(0, -1, "wave_low", "front"),
                Pose(0, 0, "wave_high", "front"), Pose(0, -1, "wave_low", "right")),
    "trouble": (Pose(0, 1, "slump", "squint"), Pose(-1, 1, "slump", "squint"),
                Pose(1, 1, "slump", "squint"), Pose(0, 1, "slump", "front")),
    "idle": (Pose(), Pose(), Pose(0, -1), Pose()),
}

# The single frame shown with reduced motion: the clearest pose, with three thought dots.
STILL_BEAT = {"search": 0, "build": 0, "think": 2, "waiting": 0, "trouble": 0, "idle": 0}


def beat_for(action: str, frame: int, still: bool = False) -> int:
    return STILL_BEAT.get(action, 0) if still else frame % BEATS


def pose_for(action: str, frame: int, still: bool = False) -> Pose:
    poses = POSES.get(action, POSES["idle"])
    if still:
        # A still goblin keeps the readable arm and eyes but never shifts its body.
        return poses[beat_for(action, frame, True)]._replace(dx=0, dy=0, step=0)
    return poses[beat_for(action, frame)]


def cue_for(action: str, frame: int, still: bool = False) -> CueFrame | None:
    """The cue for this beat, or None when idle so props stop with the work."""
    frames = CUES.get(action)
    return frames[beat_for(action, frame, still)] if frames else None


def art_runs(art: tuple[str, ...], left: int, top: int) -> list[tuple[int, int, int, str]]:
    """Horizontal color runs (column, row, length, color) in sprite pixels."""
    runs = []
    for row, line in enumerate(art):
        column = 0
        while column < len(line):
            key = line[column]
            length = 1
            while column + length < len(line) and line[column + length] == key:
                length += 1
            if key != ".":
                runs.append((left + column, top + row, length, CUE_COLORS[key]))
            column += length
    return runs


def cue_runs(cue: CueFrame) -> list[tuple[int, int, int, str]]:
    """Horizontal color runs (column, row, length, color) in sprite pixels, cue-relative."""
    return art_runs(cue.art, CUE_LEFT + cue.dx, CUE_TOP + cue.dy)


# A retiring goblin waves, sinks through a floor portal, and leaves a folded note where it
# stood. The portal lies on the ground under the 17-column body (rows 15-19, where the
# shadow normally sits), so every beat fits the same footprint as the action cues.
PORTAL_TOP = 15
PORTAL_CLIP = 17  # Body pixels at or below this row have gone through the portal.
RING_SMALL = (
    ".................",
    "......ooooo......",
    ".....olllllo.....",
    "......ooooo......",
    ".................",
)
RING_MID = (
    "....ooooooooo....",
    "..oolvvvvvvvloo..",
    "..olvmmmmmmmvlo..",
    "..oolvvvvvvvloo..",
    "....ooooooooo....",
)
RING_WIDE = (
    "..ooooooooooooo..",
    ".olvvvvvvvvvvvlo.",
    "olvmmmmmmmmmmmvlo",
    ".olvvvvvvvvvvvlo.",
    "..ooooooooooooo..",
)
SPARKLE = (
    "........",
    "...l....",
    "..lhl...",
    "...l....",
    "......l.",
    ".....lhl",
    "......l.",
    "........",
)
NOTE = (
    "ooooo...",
    "opppoo..",
    "opddpoo.",
    "oppppppo",
    "opdddppo",
    "oppppppo",
    "oppppyyo",
    "oooooooo",
)


class ExitFrame(NamedTuple):
    ring: tuple[str, ...] | None  # Floor portal art, or None once it has closed.
    sink: int  # Sprite rows the body has dropped into the portal.
    arm: str
    cue: CueFrame | None  # Sparkle beside the head, or the note left behind.


# The note lands on the ground where the goblin stood: columns 5-12, rows 9-16.
NOTE_ON_GROUND = CueFrame(NOTE, -10, 9)
EXIT_FRAMES = (
    ExitFrame(RING_SMALL, 0, "wave_high", CueFrame(SPARKLE)),
    ExitFrame(RING_MID, 0, "wave_low", CueFrame(SPARKLE, 0, 1)),
    ExitFrame(RING_WIDE, 3, "wave_high", None),
    ExitFrame(RING_WIDE, 7, "wave_high", None),
    ExitFrame(RING_WIDE, 12, "wave_low", CueFrame(SPARKLE)),
    ExitFrame(RING_MID, 17, "rest", NOTE_ON_GROUND),
    ExitFrame(None, 17, "rest", NOTE_ON_GROUND),
)
PORTAL_BEATS = len(EXIT_FRAMES)
# A goblin that stopped or left the list sinks without waving or sparkles: only a finished
# turn gets the farewell, so an unknown or interrupted ending never reads as a success.
QUIET_EXIT_FRAMES = tuple(frame._replace(arm="rest", cue=None if frame.cue and frame.cue.art is SPARKLE else frame.cue)
                          for frame in EXIT_FRAMES)
# Reduced motion skips the portal: the goblin is already gone and its note lies where it stood.
EXIT_STILL = EXIT_FRAMES[-1]


def exit_frame(beat: int, still: bool = False, outcome: str = "finished") -> ExitFrame:
    """The portal frame for this beat; the last frame is the note left behind."""
    if still:
        return EXIT_STILL
    beat = max(0, min(beat, PORTAL_BEATS - 1))
    return (EXIT_FRAMES if outcome == "finished" else QUIET_EXIT_FRAMES)[beat]


class ActionClock:
    """Start each goblin's cycle on frame 0 the moment its action changes."""

    def __init__(self, limit: int = 512) -> None:
        self.limit = limit
        self._starts: dict[object, tuple[str, int]] = {}

    def frame(self, key: object, action: str, tick: int) -> int:
        start = self._starts.get(key)
        if start is None or start[0] != action:
            if start is None and len(self._starts) >= self.limit:
                # Goblins long gone from every surface are forgotten first.
                self._starts.pop(next(iter(self._starts)))
            self._starts[key] = (action, tick)
            return 0
        return max(0, tick - start[1])


def system_prefers_reduced_motion() -> bool:
    """Follow Windows' 'Show animations in Windows' setting when it is off, or macOS's Reduce motion."""
    if sys.platform == "darwin":
        from desktop_platform import mac_prefers_reduced_motion
        return mac_prefers_reduced_motion()
    if sys.platform != "win32":
        return False
    try:
        enabled = ctypes.c_int(1)
        # SPI_GETCLIENTAREAANIMATION
        if ctypes.windll.user32.SystemParametersInfoW(0x1042, 0, ctypes.byref(enabled), 0):
            return not enabled.value
    except (AttributeError, OSError):
        pass
    return False
