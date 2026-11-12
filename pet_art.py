"""Pixel art for the 2D pets: the round blob goblin, its wardrobe and the small effects.

A frame is one pose row painted by a small rig onto a fixed cell as rows of tone keys, which a look's
palette then colours, so a new action, hat or skin is a table row. Goblins face right and ``flip``
mirrors them. Every colour on a silhouette's edge reads on a dark and on a light desktop. The drawing
is pure; only ``PetSprites`` touches Tk.
"""

from __future__ import annotations

import base64
import struct
import zlib
from typing import NamedTuple

CELL_W, CELL_H = 22, 20
AX, GY = 11, 17
# Every goblin frame is one cell with one anchor, in both facings: the feet stand on the top edge of
# row GY, centred on the left edge of column AX. A view draws a frame's top left at
# (x - AX * scale, y - GY * scale). Dangling legs reach below the ground, into the rows after GY.
ANCHOR = (AX, GY)
HEIGHT = 11  # A standing goblin's rows above the ground, before its hat.

BLACK = "#121416"
MOUTH = "#681e2e"


class Pixels(NamedTuple):
    """A sprite: ``rows`` of ``"#rrggbb"`` or None for clear, and its ``anchor`` in pixels from the
    top left (a goblin's feet centre, an effect's middle)."""
    width: int
    height: int
    rows: tuple[tuple[str | None, ...], ...]
    anchor: tuple[int, int]


class Skin(NamedTuple):
    fill: tuple[str, str]  # (base, shade)
    edge: tuple[str, str] | None = None  # The same pair on the silhouette, for a fill a desktop would swallow.
    eye: str = BLACK
    mouth: str = MOUTH


GREENS = (
    Skin(("#7cba4a", "#528a3a")),
    Skin(("#62aa52", "#3e7a40")),
    Skin(("#9ab83a", "#6a842c")),
    Skin(("#569c68", "#367052")),
    Skin(("#488c42", "#2c6234")),
    Skin(("#6eba86", "#448060")),
    Skin(("#8a963e", "#5a6628")),
    Skin(("#40a082", "#2a6e5c")),
)
SHINIES = {
    "albino": Skin(("#eceae0", "#cfc9c4"), ("#d696a0", "#a86c7c"), eye="#b02840"),
    "blue": Skin(("#5c9ce8", "#3a68b0")),
    "red": Skin(("#e2564a", "#a03438")),
    "violet": Skin(("#a86ed6", "#7046a0")),
    "gold": Skin(("#fad048", "#e8b030"), ("#cc9228", "#a0681e")),
    "shadow": Skin(("#3a344c", "#2a2638"), ("#8072a8", "#605486"), eye="#f0e890", mouth="#d04860"),
}
COMMON = "green"  # The skin tier that takes its colour from GREENS.
CLOTH = (  # (base, dark)
    ("#cc423a", "#8c282c"),
    ("#e48634", "#a65824"),
    ("#d0a630", "#94701c"),
    ("#487cd0", "#2e5096"),
    ("#8c58bc", "#5e3888"),
    ("#3eb0ac", "#26787c"),
    ("#966842", "#66442e"),
    ("#e078a0", "#a04a70"),
)
CLOTH_NAMES = ("red", "orange", "yellow", "blue", "purple", "teal", "brown", "pink")

# Tone keys in a figure: B S the skin's base and shade, b s the same on the silhouette's edge, K eye,
# M mouth, 1 2 3 the hat's tones, C D the cloth and its dark, and the fixed tones below, which the
# effects share.
FIXED = {
    "G": "#fad048",  # buckle
    "W": "#966842", "w": "#68462c",  # wood
    "F": "#b49c70", "f": "#8a6e48",  # sack
    "Y": "#f0963c",  # flame
    "o": "#cc9228", "y": "#fad048", "h": "#fff4aa",  # coin: rim, face, shine
    "t": "#a8967e", "u": "#d8ccb8",  # dust
    "a": "#e8a024",  # star, spark
    "r": "#e23c32", "p": "#ffd2c8",  # alert
}
BONE = ("#b6a682", "#b6a682", "#b6a682")
STEEL = ("#a0aab8", "#68728c", "#e0e6ee")
STRAW = ("#c8a454", "#946c2e", "#c8a454")
FEATHER = ("#e04840", "#68462c", "#f0963c")
POT = ("#68728c", "#485060", "#a0aab8")
CROWN = ("#cc9228", "#a0681e", "#e23c32")


class Shape(NamedTuple):
    rows: tuple[str, ...]  # The body, top to bottom.
    eyes: tuple[tuple[int, int], tuple[int, int]]
    mouth: tuple[int, int]
    ear: int  # the row the ears grow from
    shoulder: int
    hat: int  # columns a hat sits in from the left


SHAPES = {
    "tall": Shape(("..BBBB..", ".BBBBBB.", "BBBBBBBB", "BBBBBBBB", "BBBBBBBB", "BBBBBBBB", "BBBBBBBB",
                   "BBBBBBBB", ".SSSSSS."), ((4, 3), (6, 3)), (5, 5), 3, 5, 0),
    "short": Shape(("..BBBB..", ".BBBBBB.", "BBBBBBBB", "BBBBBBBB", "BBBBBBBB", "BBBBBBBB", "BBBBBBBB",
                    ".SSSSSS."), ((4, 3), (6, 3)), (5, 5), 3, 5, 0),
    "squat": Shape(("..BBBBBB..", ".BBBBBBBB.", "BBBBBBBBBB", "BBBBBBBBBB", "BBBBBBBBBB", "BBBBBBBBBB",
                    "BBBBBBBBBB", ".SSSSSSSS."), ((5, 3), (7, 3)), (6, 5), 3, 4, 1),
    "flat": Shape(("..BBBBBBB..", ".BBBBBBBBB.", "BBBBBBBBBBB", "BBBBBBBBBBB", "BBBBBBBBBBB", ".SSSSSSSSS."),
                  ((5, 2), (7, 2)), (5, 4), 3, 3, 1),
}

LEFT, RIGHT = 0, 1


class Stance(NamedTuple):
    clear: int  # rows between the body and the ground
    shift: int  # columns the body sits behind the anchor
    hips: tuple[tuple[int, int, int], tuple[int, int, int]]  # (body side, columns, rows) for each leg
    sides: tuple[int, int]  # which way each leg's forward points


STANCES = {
    "stand": Stance(2, 0, ((LEFT, 2, 1), (RIGHT, -2, 1)), (1, 1)),
    "crouch": Stance(1, 0, ((LEFT, 2, 1), (RIGHT, -2, 1)), (1, 1)),
    "cling": Stance(2, 0, ((LEFT, 1, 1), (RIGHT, -1, 1)), (-1, 1)),
    "flat": Stance(0, 0, ((LEFT, -1, 0), (RIGHT, 1, 0)), (-1, 1)),
    # Seated on the end of a ledge, which stops at the anchor: the legs hang past it, over the side.
    "seat": Stance(0, 3, ((RIGHT, -2, 0), (RIGHT, 0, 0)), (1, 1)),
}

# Limbs and ears are hand-placed pixels from a joint, the far end last.
ARMS = {  # (out, up) from the shoulder
    "down": ((0, 0), (0, -1)),
    "low": ((0, 0), (1, -1)),
    "out": ((0, 0), (1, 0)),
    "up": ((0, 0), (1, 1)),
    "high": ((0, 0), (0, 1)),
    "jab": ((0, 0), (1, 0), (2, 0)),
    "grip": ((0, 0), (1, 0), (2, 0), (2, 1)),
    "reach": ((0, 0), (1, 0), (2, 1), (2, 2)),
}
LEGS = {  # (forward, down) from the hip
    "stand": ((0, 0), (0, 1)),
    "fwd": ((0, 0), (1, 1)),
    "back": ((0, 0), (-1, 1)),
    "knee": ((0, 0), (1, 0)),
    "kick": ((0, 0), (-1, 0)),
    "tuck": ((0, 0),),
    "out": ((0, 0), (1, 0), (2, 0)),
    "twitch": ((0, 0), (1, 0), (2, -1)),
    "splay": ((0, 0), (1, 1), (2, 1)),
    "flail": ((0, 0), (-1, 1), (-2, 1)),
    "hang": ((0, 0), (0, 1), (0, 2), (1, 2)),
    "dangle": ((0, 0), (1, 0), (2, 0), (2, 1), (2, 2), (2, 3), (3, 3)),
    "swing": ((0, 0), (1, 0), (2, 0), (2, 1), (3, 2), (4, 2)),
}
EARS = {  # (out, up) from the body's side
    "up": ((1, 0), (1, 1), (2, 1), (2, 2), (3, 2), (3, 3)),
    "flat": ((1, 0), (1, 1), (2, 1), (2, 0), (3, 1)),
    "down": ((1, 0), (1, -1), (2, -1), (2, 0), (3, -1), (3, -2)),
}
EYES = {  # (column, row, tone) marks for the back eye and the front eye
    "open": (((0, 0, "K"),), ((0, 0, "K"),)),
    "shut": (((0, 0, "S"),), ((0, 0, "S"),)),
    "tall": (((0, 0, "K"), (0, -1, "K")), ((0, 0, "K"), (0, -1, "K"))),
    "woozy": (((0, 0, "K"),), ((0, 1, "K"),)),
    "dizzy": (((0, 1, "K"),), ((0, 0, "K"),)),
}
MOUTHS = {
    "shut": ((0, 0, "S"), (1, 0, "S")),
    "chew": ((0, 0, "S"), (1, 0, "M")),
    "open": ((0, 0, "M"), (1, 0, "M")),
    "wide": ((0, 0, "M"), (1, 0, "M"), (0, 1, "M"), (1, 1, "M")),
}
# Two stars circle a dazed head, half a turn apart, one step a frame.
ORBIT = ((4, 0), (3, 1), (0, 2), (-3, 1), (-4, 0), (-3, -1), (0, -2), (3, -1))
ORBIT_RISE = 5


class Pose(NamedTuple):
    arms: tuple[str, str] = ("down", "down")  # (back, front)
    legs: tuple[str, str] = ("stand", "stand")
    mouth: str = "shut"
    eyes: str = "open"
    ear: str = "up"
    shape: str = "tall"
    stance: str = "stand"
    lift: int = 0  # rows the whole figure is off the ground
    gaze: int = 0  # rows the eyes look up
    sway: int = 0  # rows a scarf's tail flutters
    stars: bool = False


P = Pose
POSES = {
    "idle": (P(), P(shape="short"), P(mouth="chew"), P(eyes="shut")),
    "run": (
        P(("out", "up"), ("back", "fwd"), "wide", sway=1),
        P(("low", "low"), ("tuck", "tuck"), ear="flat", lift=1),
        P(("up", "out"), ("fwd", "back"), "wide", sway=-1),
        P(("low", "low"), ("tuck", "tuck"), ear="flat", lift=1),
    ),
    "jump": (
        P(("high", "high"), mouth="open", ear="down", sway=-1),
        P(("out", "out"), ("kick", "knee"), "wide", ear="flat"),
        P(("up", "up"), ("back", "fwd"), "wide", "tall", sway=1),
    ),
    "land": (P(("out", "out"), ("kick", "knee"), eyes="shut", ear="flat", shape="squat", stance="crouch"),),
    "cheer": (
        P(("up", "up"), mouth="wide"),
        P(("high", "high"), mouth="wide", ear="flat", lift=1),
        P(("up", "up"), mouth="open"),
        P(("out", "out"), ("tuck", "tuck"), ear="down", stance="crouch"),
    ),
    "brawl": (
        P(("low", "up"), ("back", "fwd"), ear="flat"),
        P(("out", "jab"), ("back", "fwd"), "wide"),
        P(("up", "out"), mouth="open", ear="flat", lift=1),
        P(("high", "jab"), ("fwd", "back"), "wide"),
    ),
    # Spread on a wall it faces: both hands hooked out wide, both feet braced, one limb moving at a time.
    "climb": (
        P(("reach", "grip"), ("splay", "out"), stance="cling", gaze=1),
        P(("grip", "grip"), ("splay", "splay"), "open", stance="cling", gaze=1, lift=1),
        P(("grip", "reach"), ("out", "splay"), stance="cling", gaze=1),
        P(("grip", "grip"), ("splay", "splay"), "open", stance="cling", gaze=1, lift=1),
    ),
    "dazed": (
        P(("out", "out"), ("out", "out"), "open", "woozy", "down", shape="flat", stance="flat", stars=True),
        P(("out", "low"), ("out", "twitch"), "chew", "dizzy", "down", shape="flat", stance="flat", stars=True),
        P(("out", "out"), ("out", "out"), "open", "woozy", "down", shape="flat", stance="flat", stars=True),
        P(("low", "out"), ("twitch", "out"), "shut", "dizzy", "down", shape="flat", stance="flat", stars=True),
    ),
    # Held by the head, which stays where a standing head is, so the kicking legs hang below the feet.
    "grabbed": (
        P(("up", "out"), ("hang", "splay"), "wide", "tall", "down"),
        P(("out", "low"), ("hang", "hang"), "open", "tall", "down"),
        P(("out", "up"), ("flail", "hang"), "wide", "tall", "down"),
        P(("low", "out"), ("hang", "hang"), "open", "tall", "down"),
    ),
    "sit": (
        P(legs=("dangle", "swing"), stance="seat"),
        P(legs=("swing", "dangle"), mouth="chew", stance="seat"),
    ),
}
ACTIONS = tuple(POSES)
FRAMES = {action: len(frames) for action, frames in POSES.items()}


class Hat(NamedTuple):
    rows: tuple[str, ...]
    at: tuple[int, int]  # the top left of ``rows`` from the head's
    tones: tuple[str, str, str] | None = None  # fixed colours for 1 2 3, or None to take the cloth's


HATS = {
    "cap": Hat((".111111...", "1111111122"), (0, -1)),
    "pointy": Hat(("...1......", "...11.....", "...111....", "...1111...", "..111111..", "2222222222"), (-1, -5)),
    "horns": Hat(("1......1", ".1....1."), (0, -2), BONE),
    "helmet": Hat(("....2...", ".111111.", "11311111", "22222222"), (0, -2), STEEL),
    "headband": Hat((".211111111", "2........."), (-2, 1)),
    "hood": Hat(("2.111111..", ".211111111", ".211......", "..1.......", "..2......."), (-2, -1)),
    "straw": Hat(("....1111....", "...222222...", "111111111111"), (-2, -2), STRAW),
    "feather": Hat(("3.......", "1.......", ".1......", ".1......", "22222222"), (0, -3), FEATHER),
    "pot": Hat((".131111..", ".111111.2", "22222222."), (0, -2), POT),
    "mohawk": Hat((".22...", "..11..", "..111.", ".1...."), (0, -3)),
    "crown": Hat(("1.1.1", "11311"), (1, -2), CROWN),
}


class Trim(NamedTuple):
    side: int  # counted from this side of the body
    column: int
    row: int  # rows up from the body's bottom
    tone: str
    sways: bool = False


class Wear(NamedTuple):
    bands: tuple[tuple[int, str], ...]  # (rows up from the body's bottom, tone): whole body rows
    trims: tuple[Trim, ...] = ()


NOTHING = Wear(())
WEARS = {
    "vest": Wear(((2, "C"), (1, "C"), (0, "D"))),
    "sash": Wear(((1, "C"),), (Trim(RIGHT, -1, 1, "G"),)),
    "scarf": Wear(((2, "C"),), (Trim(LEFT, -1, 2, "D"), Trim(LEFT, -2, 2, "C", sways=True),
                                Trim(LEFT, -3, 1, "C", sways=True))),
}


class Tool(NamedTuple):
    held: bool  # just past the front hand, or slung from the back shoulder
    pixels: tuple[tuple[int, int, str], ...]  # (column, row, tone) from there


TOOLS = {
    "club": Tool(True, ((0, -1, "w"), (1, -2, "W"), (2, -2, "W"), (1, -3, "W"), (2, -3, "W"))),
    "sack": Tool(False, ((-1, -1, "F"), (0, -1, "F"), (-1, 0, "F"), (0, 0, "F"), (-2, 0, "F"), (-1, 1, "f"),
                         (0, 1, "f"), (-2, 1, "f"), (0, -2, "f"))),
    "torch": Tool(True, ((0, 0, "w"), (0, -1, "w"), (0, -2, "Y"), (0, -3, "Y"))),
}

EFFECTS = {  # kind -> frames of rows, each centred on its point
    "coin": (
        (".ooo.", "oyyyo", "oyhyo", "oyyyo", ".ooo."),
        ("ooo", "oyo", "oho", "oyo", "ooo"),
        ("o", "o", "o", "o", "o"),
        ("ooo", "oyo", "oho", "oyo", "ooo"),
    ),
    "dust": (
        (".tt.", "tuut", ".tt."),
        (".tt...", "tuut.t", "tuuut.", ".ttt.."),
        ("t...t.", "..t...", ".....t", ".t...."),
    ),
    "star": (
        (".a.", "aha", ".a."),
        ("..a..", "..a..", "aahaa", "..a..", "..a.."),
        ("a...a", ".a.a.", "..a..", ".a.a.", "a...a"),
    ),
    "alert": (
        ("rr", "rr", "rr", "rr", "..", "rr"),
        ("rrr", "rpr", "rpr", "rpr", "rrr", "...", "rrr"),
    ),
    "spark": (
        (".a.", "aha", ".a."),
        ("a...a", ".a.a.", "..a..", ".a.a.", "a...a"),
        ("a.a.a", ".....", "a...a", ".....", "a.a.a"),
    ),
}
EFFECT_FRAMES = {kind: len(frames) for kind, frames in EFFECTS.items()}

# A cell at the default unit of 2 is 44 by 40 screen pixels, 1,760 in all. The working set to hold is
# 64 looks, 10 actions, 4 frames and 2 facings: 5,120 images, 9,011,200 pixels, a tenth under this.
BUDGET = 10_000_000


def wears_cloth(hat: str, wear: str) -> bool:
    """Whether a goblin in this hat and these clothes shows its cloth colour anywhere."""
    return bool(wear) or (bool(hat) and HATS[hat].tones is None)


def _stamp(px: dict, rows: tuple[str, ...], left: int, top: int) -> None:
    px.update({(left + column, top + row): tone
               for row, line in enumerate(rows) for column, tone in enumerate(line) if tone != "."})


def _figure(action: str, frame: int, hat: str, wear: str, tool: str) -> list[str]:
    """One frame facing right, as the cell's rows of tone keys with ``.`` for clear."""
    pose = POSES[action][frame]
    shape, stance = SHAPES[pose.shape], STANCES[pose.stance]
    width, height = len(shape.rows[0]), len(shape.rows)
    bottom = GY - 1 - stance.clear - pose.lift
    left, top = AX - width // 2 - stance.shift, bottom - height + 1
    right = left + width - 1
    edges = (left, right)
    worn = WEARS[wear] if wear else NOTHING
    px: dict[tuple[int, int], str] = {}

    for (side, across, below), way, name, tone in zip(stance.hips, stance.sides, pose.legs, "SB"):
        for forward, down in LEGS[name]:
            px[edges[side] + across + way * forward, bottom + below + down] = tone
    body: dict[tuple[int, int], str] = {}
    _stamp(body, shape.rows, left, top)
    px.update(body)
    for out, up in EARS[pose.ear]:
        px[left - out, top + shape.ear - up] = px[right + out, top + shape.ear - up] = "B"
    for up, tone in worn.bands:
        px.update({spot: tone for spot in body if spot[1] == bottom - up})

    for (column, row), marks in zip(shape.eyes, EYES[pose.eyes]):
        for across, down, tone in marks:
            px[left + column + across, top + row - pose.gaze + down] = tone
    for across, down, tone in MOUTHS[pose.mouth]:
        px[left + shape.mouth[0] + across, top + shape.mouth[1] + down] = tone
    if hat:
        _stamp(px, HATS[hat].rows, left + shape.hat + HATS[hat].at[0], top + HATS[hat].at[1])

    shoulder = top + shape.shoulder
    hand = (0, 0)
    for way, socket, name, tone in ((-1, left - 1, pose.arms[0], "S"), (1, right + 1, pose.arms[1], "B")):
        for out, up in ARMS[name]:
            hand = (socket + way * out, shoulder - up)
            px[hand] = tone
    for trim in worn.trims:
        px[edges[trim.side] + trim.column, bottom - trim.row + (pose.sway if trim.sways else 0)] = trim.tone
    if tool:
        x, y = (hand[0] + 1, hand[1]) if TOOLS[tool].held else (left - 1, shoulder)
        for column, row, tone in TOOLS[tool].pixels:
            px[x + column, y + row] = tone
    if pose.stars:
        for step in (frame, frame + len(ORBIT) // 2):
            across, down = ORBIT[step % len(ORBIT)]
            _stamp(px, EFFECTS["star"][0], AX + across - 1, top - ORBIT_RISE + down - 1)

    cell = [["."] * CELL_W for _ in range(CELL_H)]
    for (x, y), tone in px.items():
        if not (0 <= x < CELL_W and 0 <= y < CELL_H):
            raise ValueError(f"{action} frame {frame} with {hat or 'no hat'} and {tool or 'no tool'} leaves its cell")
        if tone in "BS" and not all(spot in px for spot in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1))):
            tone = tone.lower()
        cell[y][x] = tone
    return ["".join(row) for row in cell]


def _tones(look) -> dict[str, str]:
    """Every tone key's colour for one look."""
    skin = GREENS[look.green] if look.skin == COMMON else SHINIES[look.skin]
    cloth, cloth_dark = CLOTH[look.cloth]
    hat = (HATS[look.hat].tones if look.hat else None) or (cloth, cloth_dark, cloth_dark)
    base, shade = skin.fill
    edge_base, edge_shade = skin.edge or skin.fill
    return {**FIXED, "B": base, "S": shade, "b": edge_base, "s": edge_shade, "K": skin.eye, "M": skin.mouth,
            "C": cloth, "D": cloth_dark, "1": hat[0], "2": hat[1], "3": hat[2]}


def goblin_pixels(look, action: str, frame: int, flip: bool = False) -> Pixels:
    """Goblin ``look`` (a ``goblin_look.Look``) in frame ``frame`` (wrapped to the action's count) of
    ``action``, facing right or, with ``flip``, left."""
    rows = _figure(action, frame % FRAMES[action], look.hat, look.wear, look.tool)
    if flip:
        rows = [row[::-1] for row in rows]
    tone = _tones(look).get
    return Pixels(CELL_W, CELL_H, tuple(tuple(map(tone, row)) for row in rows), ANCHOR)


def effect_pixels(kind: str, frame: int = 0) -> Pixels:
    """Frame ``frame`` (wrapped) of the small effect ``kind``, anchored at its middle."""
    rows = EFFECTS[kind][frame % EFFECT_FRAMES[kind]]
    return Pixels(len(rows[0]), len(rows), tuple(tuple(map(FIXED.get, row)) for row in rows),
                  (len(rows[0]) // 2, len(rows) // 2))


class _Rgba(dict):
    """RGBA bytes for a cell's colour, ``scale`` pixels wide, made on first use."""

    def __init__(self, scale: int) -> None:
        super().__init__()
        self.scale = scale

    def __missing__(self, colour: str | None) -> bytes:
        value = self[colour] = (bytes.fromhex(colour[1:] + "ff") if colour else bytes(4)) * self.scale
        return value


_RGBA: dict[int, _Rgba] = {}


def _chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))


def png_bytes(pixels: Pixels, scale: int = 1) -> bytes:
    """``pixels`` as a PNG file, each cell ``scale`` pixels square and clear cells transparent."""
    table = _RGBA.get(scale)
    if table is None:
        table = _RGBA[scale] = _Rgba(scale)
    lines = b"".join((b"\0" + b"".join(map(table.__getitem__, row))) * scale for row in pixels.rows)
    header = struct.pack(">IIBBBBB", pixels.width * scale, pixels.height * scale, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", header) + _chunk(b"IDAT", zlib.compress(lines, 1))
            + _chunk(b"IEND", b""))


class PetSprites:
    """Tk images of goblin frames and effects, each built once from its pixels and kept until the
    cache passes ``budget`` pixels, when the least recently shown go first. A dropped image lives on
    while its caller holds it. An image's clear pixels are fully transparent, so a see-through
    window shows the desktop there."""

    def __init__(self, master, budget: int = BUDGET) -> None:
        self.master = master
        self.budget = budget
        self.pixels = 0
        self.images: dict[tuple, object] = {}

    def image(self, look, action: str, frame: int, scale: int, flip: bool = False):
        """The PhotoImage of a goblin frame at ``scale`` whole screen pixels a sprite pixel; its
        anchor is ``ANCHOR`` times ``scale``."""
        frame %= FRAMES[action]
        return self._cached((look.name, action, frame, scale, flip), scale,
                            lambda: goblin_pixels(look, action, frame, flip))

    def effect(self, kind: str, frame: int, scale: int):
        """The PhotoImage of an effect frame, to be centred on its point."""
        frame %= EFFECT_FRAMES[kind]
        return self._cached((kind, frame, scale), scale, lambda: effect_pixels(kind, frame))

    def _cached(self, key: tuple, scale: int, pixels):
        found = self.images.pop(key, None)
        if found is None:
            import tkinter as tk
            # One PNG read is the cheapest way in, and it carries the transparency with it.
            found = tk.PhotoImage(master=self.master, data=base64.b64encode(png_bytes(pixels(), scale)))
            self.pixels += found.width() * found.height()
            while self.pixels > self.budget and self.images:
                dropped = self.images.pop(next(iter(self.images)))
                self.pixels -= dropped.width() * dropped.height()
        self.images[key] = found
        return found

    def clear(self) -> None:
        """Drop every image (on the Tk thread, before the window closes)."""
        self.images.clear()
        self.pixels = 0
