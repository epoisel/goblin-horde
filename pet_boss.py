"""Bosses the horde battles, as hand-placed pixel art in the goblins' style.

An archetype (``pet_boss_ogre``) is drawn once as rows of characters, a cell a character. A tier
redraws those rows at its own height: every stair of a drawing becomes a straight run on a two
pixel lattice, so a boss of any size keeps the same chunky steps, while the dither, the highlight
lines, the cracks and the finger gaps stay one sprite pixel, the goblins' own density. A boss leans
by shearing its rows and lies down by a quarter turn; nothing is ever rotated by an angle or
smoothed. Bosses face right and ``flip`` mirrors them. The drawing is pure; only ``PetBossImages``
touches Tk.
"""

from __future__ import annotations

import base64
import math
import struct
import zlib
from functools import lru_cache
from typing import Callable, Iterator, NamedTuple

import pet_boss_ogre

GOBLIN_PX = 11  # A standing goblin's height in sprite pixels; bosses are measured in these.
CELLS = 77  # Every archetype is drawn 77 cells tall, sole to skull.
CHUNK = 2  # Silhouettes step on a two pixel lattice; line details and dither are one pixel.
ROW = 6  # Bosses in a row: one tier of height, palette and gear.
RIM = 0.22  # The shaded share of a limb's width, on its back or under side.
SOLE = 6  # Cells ahead of the feet centre where a fallen boss's soles come to rest.
SLICES = 14  # Heights the profile samples the silhouette at.
INSET = 0.9  # The share of a slice's half width a climber can count on being body.
FLASH = 0.62  # How far a hit flash lightens every colour toward white.
# Pixels of zoomed images a PetBossImages keeps. At zoom 2 the largest boss's largest frame is
# 1.06 million and its 14 frames in one facing are 10.3 million, so a whole fight fits with room
# for a few flashes. A larger zoom needs a budget grown by its square.
BUDGET = 12_000_000

POSE_FRAMES = {"stand": 2, "walk": 4, "stomp": 2, "roar": 2, "hurt": 1, "fall": 3}
ARCHETYPES = {
    "ogre": pet_boss_ogre,
    # troll, golem, cyclops, wyrm and giant join here: a module with PARTS, POSES, WEAPONS, MOUTH
    # and paint(sheet, rig, gear), whose rigs carry ``lean`` and ``flat``.
}


class Slot(NamedTuple):
    """One of a row's six places: the archetype it is named for, the one drawn there today, and
    its bosses' names from the first tier to the last."""
    key: str
    archetype: str
    names: tuple[str, ...]


SLOTS = (  # Every slot is drawn as an ogre until its own archetype joins ARCHETYPES.
    Slot("ogre", "ogre", ("Mudback", "Bogbelly", "Gristlegut", "Rustjaw", "Skullmash", "Gorehulk")),
    Slot("troll", "ogre", ("Mosswart", "Bridgegrub", "Stonenose", "Bramblefang", "Rotclaw", "Gloomtroll")),
    Slot("golem", "ogre", ("Pebblebrute", "Clayhulk", "Cragfist", "Runeguard", "Obsidius", "Doomforge")),
    Slot("cyclops", "ogre", ("Peeper", "Glarebrute", "Hornseye", "Ironstare", "Dreadgaze", "Allseer")),
    Slot("wyrm", "ogre", ("Snapling", "Bogwyrm", "Ashscale", "Venomcoil", "Cinderwing", "Nightwyrm")),
    Slot("giant", "ogre", ("Hilltop", "Boulderhurl", "Frostbeard", "Ironwarden", "Stormhide", "Highking")),
)


class Pixels(NamedTuple):
    """A sprite: ``rows`` of ``"#rrggbb"`` or None for clear, and its ``anchor`` in pixels from the
    top left. A boss's feet stand on the top edge of row ``anchor[1]``, centred on the left edge of
    column ``anchor[0]``."""
    width: int
    height: int
    rows: tuple[tuple[str | None, ...], ...]
    anchor: tuple[int, int]


class BossProfile(NamedTuple):
    """What the battle needs to stage a boss. Lengths are shares of the boss's pixel height from
    its feet centre, x toward the way it faces."""
    name: str
    height_goblins: float
    slices: tuple[tuple[float, float], ...]  # (height, half width a climber can cling inside), feet first
    mouth: tuple[float, float]  # (forward, height) of the mouth, where roars come from
    grip: tuple[tuple[float, float, float], ...]  # (height, reach behind, reach ahead): the body's true edges


class Tier(NamedTuple):
    """One row of six bosses: its palette name, height in goblins, colours and gear."""
    key: str
    height: int
    skin: tuple[str, str, str, str, str]  # highlight line, base, shade, far side, dark accent
    cloth: tuple[str, str]
    gear: frozenset[str]


TIERS = (
    Tier("mud", 14, ("#e8b480", "#ce9662", "#a06a4a", "#7a4e3c", "#4a2c24"), ("#74523c", "#52382c"),
         frozenset({"club"})),
    Tier("bog", 17, ("#b8cc78", "#92a85a", "#667c42", "#4a5c36", "#2a3620"), ("#6a4e3a", "#48342a"),
         frozenset({"club", "horns"})),
    Tier("rust", 20, ("#f0a070", "#d07a48", "#a05434", "#763a2a", "#45201a"), ("#4e5660", "#363c46"),
         frozenset({"club", "horns", "armour"})),
    Tier("slate", 23, ("#a4b6d4", "#7288aa", "#506080", "#3a4662", "#1e2638"), ("#7a4838", "#56322a"),
         frozenset({"club", "horns", "armour", "spikes"})),
    Tier("ember", 26, ("#f08a5a", "#d0503a", "#9a3030", "#6e222a", "#3e1218"), ("#3c3440", "#28222c"),
         frozenset({"mace", "horns", "armour", "spikes"})),
    Tier("royal", 30, ("#b894e0", "#8e62c0", "#644094", "#482c70", "#26143e"), ("#a82c3c", "#741c2c"),
         frozenset({"mace", "horns", "armour", "spikes", "crown"})),
)
BOSS_COUNT = len(TIERS) * ROW

BLACK = "#121416"
FIXED = {  # Materials every boss shares: wood, bone, iron, gold, maw, tongue, gem, metal's glint, black.
    "W": "#96683e", "w": "#68462c", "B": "#ece4cc", "b": "#c4b48c", "I": "#9aa2b0", "i": "#646c7c",
    "G": "#fad048", "g": "#c48c28", "M": "#681e2e", "m": "#c0485a", "R": "#e0404a", "H": "#f6f8fa",
    "K": BLACK,
}
SKIN, CLOTH = "LSszD", "Cc"  # A tier's own tones, in the order of Tier.skin and Tier.cloth.
# What a character of a drawing paints: (material code, which pixels of its cell). ":" and ";"
# are dither, resolved to their two tones pixel by pixel.
WHOLE, TOP, BOTTOM, LEFT = "whole", "top", "bottom", "left"
INK = {ch: (ord(ch), WHOLE) for ch in "SszCcWwBbIiGgMmRKDH:;"}
INK.update({
    "o": (ord("s"), WHOLE),  # a wart: shade, drawn as its own shape so it never joins the back's shade
    "'": (ord("L"), TOP),  # a one pixel highlight line on skin
    "^": (ord("H"), TOP),  # the same on metal and bone
    "_": (ord("D"), BOTTOM),  # a one pixel dark line under a cell
    "!": (ord("D"), LEFT),  # a one pixel dark line beside a cell
})
LAYERS = "SszCcWwIiGgBbMmR:;oDHK'^_!"  # Paint order inside a part; later characters go on top.
FAR = bytes.maketrans(b"LS:sBH", b"ss;zbb")  # A far-side part, one tone darker.
DITHER = (bytes.maketrans(b":;", b"Ss"), bytes.maketrans(b":;", b"sz"))  # By the parity of x + y.


def _q(cells: float, k: float) -> int:
    """Cells to pixels on the lattice, at ``k`` pixels a cell."""
    return CHUNK * math.floor(cells * k / CHUNK + 0.5)


def _runs(row: str, wanted: Callable[[str], bool]) -> list[tuple[int, int]]:
    runs, start = [], None
    for x, ch in enumerate(row + "."):
        if wanted(ch):
            start = x if start is None else start
        elif start is not None:
            runs.append((start, x))
            start = None
    return runs


def _shapes(rows: list[str], wanted: Callable[[str], bool]) -> Iterator[tuple[int, list[tuple[int, int]]]]:
    """(top row, a span a row) for each shape of the wanted cells. Rows with as many runs, each
    touching the run above it, stack run by run into shapes."""
    stacks: list[tuple[int, list[tuple[int, int]]]] = []
    for y, row in enumerate(rows + [""]):
        runs = _runs(row, wanted)
        joined = len(runs) == len(stacks) and all(
            run[0] <= spans[-1][1] and spans[-1][0] <= run[1] for (_, spans), run in zip(stacks, runs))
        if joined:
            for (_, spans), run in zip(stacks, runs):
                spans.append(run)
        else:
            yield from stacks
            stacks = [(y, [run]) for run in runs]


def _stairs(edge: list[int]) -> list[tuple[int, float, int, int]]:
    """The steps down one edge of a shape: (row, half the rows its ramp takes, edge above, below).
    A one cell step is a stair of a slope and ramps across half of the shorter run on either side;
    a longer jump between two flats is a ledge and stays one; any other jump ramps row to row."""
    runs: list[list[int]] = []
    for row, value in enumerate(edge):
        if runs and runs[-1][2] == value:
            runs[-1][1] += 1
        else:
            runs.append([row, 1, value])
    steps = []
    for (_, above, v0), (row, below, v1) in zip(runs, runs[1:]):
        half = min(above, below) / 2 if abs(v1 - v0) == 1 else 0.0 if above > 1 and below > 1 else 0.5
        steps.append((row, half, v0, v1))
    return steps


def _edge_at(edge: list[int], steps: list[tuple[int, float, int, int]], y: float) -> float:
    for row, half, v0, v1 in steps:
        if half and row - half < y < row + half:
            return v0 + (v1 - v0) * (y - row + half) / (2 * half)
    return edge[min(len(edge) - 1, max(0, int(y)))]


def _strokes(rows: list[str], wanted: Callable[[str], bool], k: float, rule: str) -> Iterator[tuple[int, int, int]]:
    """Pixel runs (y, x0, x1) of the wanted cells at ``k`` pixels a cell."""
    for top, spans in _shapes(rows, wanted):
        if rule != WHOLE:
            for n, (left, right) in enumerate(spans):
                y0, y1, x0, x1 = _q(top + n, k), _q(top + n + 1, k), _q(left, k), _q(right, k)
                if rule == LEFT:
                    yield from ((y, x0, x0 + 1) for y in range(y0, y1))
                else:
                    yield (y0 if rule == TOP else y1 - 1), x0, x1
            continue
        lefts, rights = [span[0] for span in spans], [span[1] for span in spans]
        left_steps, right_steps = _stairs(lefts), _stairs(rights)
        for y in range(_q(top, k), _q(top + len(spans), k), CHUNK):
            at = (y + CHUNK / 2) / k - top
            x0, x1 = _q(_edge_at(lefts, left_steps, at), k), _q(_edge_at(rights, right_steps, at), k)
            yield from ((line, x0, x1) for line in range(y, y + CHUNK))


def _segments(row: bytearray) -> Iterator[tuple[int, bytes]]:
    x = 0
    for piece in bytes(row).split(b"\0"):
        if piece:
            yield x, piece
        x += len(piece) + 1


@lru_cache(maxsize=None)
def _scaled(kind: str, name: str, k: float) -> tuple[int, int, tuple[tuple[tuple[int, bytes], ...], ...]]:
    """A part redrawn at ``k`` pixels a cell: its origin in pixels from its top left, and each
    pixel row as (x, codes) segments."""
    part = ARCHETYPES[kind].PARTS[name]
    width = max(map(len, part.rows))
    rows = [row.ljust(width, ".") for row in part.rows]
    grid = [bytearray(_q(width, k)) for _ in range(_q(len(rows), k))]
    for y, x0, x1 in _strokes(rows, lambda ch: ch != ".", k, WHOLE):
        grid[y][x0:x1] = part.base.encode() * (x1 - x0)
    for ch in sorted(set("".join(rows)) - {".", part.base}, key=LAYERS.index):
        code, rule = INK[ch]
        for y, x0, x1 in _strokes(rows, ch.__eq__, k, rule):
            line = grid[y]
            for x in range(x0, min(x1, len(line))):
                if line[x]:  # Never outside the silhouette.
                    line[x] = code
    return _q(part.origin[0], k), _q(part.origin[1], k), tuple(tuple(_segments(row)) for row in grid)


class _Sheet:
    """A working sheet of material codes in one tier's pixels, which an archetype paints a frame
    onto. Callers speak cells: x forward from the feet centre, y up from the ground."""

    def __init__(self, kind: str, height: int) -> None:
        self.kind = kind
        self.k = height / CELLS
        self.ox, self.oy = 2 * height, 2 * height  # the feet centre's column, and the rows above the ground
        self.w, self.h = 4 * height, 2 * height + height // 2
        self.rows = [bytearray(self.w) for _ in range(self.h)]

    def q(self, cells: float) -> int:
        return _q(cells, self.k)

    def fill(self, x0: int, x1: int, y0: int, y1: int, code: bytes) -> None:
        """Pixels: columns x0 to x1 and heights y0 to y1, both half open."""
        x0, x1 = max(0, x0 + self.ox), min(self.w, x1 + self.ox)
        if x1 > x0:
            for row in self.rows[max(0, self.oy - y1):max(0, self.oy - y0)]:
                row[x0:x1] = code * (x1 - x0)

    def lay(self, line: int, x: int, codes: bytes) -> None:
        """Codes onto sheet row ``line`` from sheet column ``x``, clipped to the sheet."""
        if 0 <= line < self.h and x < self.w:
            codes = codes[max(0, -x):self.w - x]
            self.rows[line][max(0, x):max(0, x) + len(codes)] = codes

    def stamp(self, name: str, x: float, y: float, far: bool = False) -> None:
        """Pin a part's origin to a point; ``far`` paints it a tone darker."""
        ox, oy, lines = _scaled(self.kind, name, self.k)
        left, top = self.q(x) - ox + self.ox, self.oy - self.q(y) - oy
        for line, segments in enumerate(lines, top):
            for x0, codes in segments:
                self.lay(line, left + x0, codes.translate(FAR) if far else codes)

    def limb(self, a, b, w0: float, w1: float, tone: bytes, shade: bytes, bands=(), seams=(),
             rounded: bool = False) -> None:
        """A stepped bar from a to b, ``w0`` cells wide at a and ``w1`` at b, its back or under side
        shaded. ``bands`` are (from, to, tone, shade) stretches of its length in other materials,
        ``seams`` are (share across, code) one pixel lines along it, and ``rounded`` steps the end
        at b in."""
        upright = abs(b[1] - a[1]) >= abs(b[0] - a[0])
        (s0, c0), (s1, c1) = ((a[1], a[0]), (b[1], b[0])) if upright else (a, b)
        if s0 == s1:
            return
        first, last = sorted((self.q(s0), self.q(s1)))
        for s in range(first, last, CHUNK):
            t = ((s + CHUNK / 2) / self.k - s0) / (s1 - s0)
            half = (w0 + (w1 - w0) * t) / 2
            if rounded:
                half -= max(0, 2 - int((1 - t) * abs(s1 - s0)))  # The last two cells step in, a cell each.
            centre = c0 + (c1 - c0) * t
            lo, hi = self.q(centre - half), self.q(centre + half)
            light, dark = next(((band[2], band[3]) for band in bands if band[0] <= t < band[1]), (tone, shade))
            rim = min(hi, lo + max(CHUNK, self.q(2 * half * RIM)))
            lines = [(lo + int((hi - lo - 1) * across), code) for across, code in seams]
            for u0, u1, code in [(lo, hi, light), (lo, rim, dark)] + [(u, u + 1, code) for u, code in lines]:
                if upright:
                    self.fill(u0, u1, s, s + CHUNK, code)
                else:
                    self.fill(s, s + CHUNK, u0, u1, code)

    def box(self) -> tuple[int, int, int, int]:
        """The drawn pixels' bounds as (left, top, right, bottom) sheet indexes, right and bottom past the end."""
        drawn = [n for n, row in enumerate(self.rows) if row.count(0) < self.w]
        lefts = [len(self.rows[n]) - len(self.rows[n].lstrip(b"\0")) for n in drawn]
        rights = [len(self.rows[n].rstrip(b"\0")) for n in drawn]
        return min(lefts), drawn[0], max(rights), drawn[-1] + 1

    def lean(self, share: float) -> None:
        """Shear every row forward by ``share`` of its height, in lattice steps."""
        for n, row in enumerate(self.rows[:self.oy]):
            move = CHUNK * round(share * ((self.oy - 1 - n) // CHUNK))
            if move > 0:
                row[:] = bytes(move) + row[:-move]
            elif move < 0:
                row[:] = row[-move:] + bytes(-move)

    def lie_down(self) -> None:
        """A quarter turn backward: the skull to the back, the belly up, the back on the ground and
        the soles ``SOLE`` cells ahead of where the feet stood."""
        left, top, right, bottom = self.box()
        turned = [bytes(column) for column in zip(*(row[left:right] for row in self.rows[top:bottom]))][::-1]
        for row in self.rows:
            row[:] = bytes(self.w)
        x1 = self.ox + self.q(SOLE)
        for line, codes in enumerate(turned, self.oy - len(turned)):
            self.lay(line, x1 - len(codes), codes)


def _look(index: int) -> tuple[str, int]:
    """What a boss looks like: its archetype and tier. Bosses that share both share every frame."""
    return SLOTS[index % ROW].archetype, index // ROW


def boss_name(index: int) -> str:
    """The boss's display name."""
    return SLOTS[index % ROW].names[index // ROW]


def boss_height(index: int) -> int:
    """The boss's standing height in sprite pixels, sole to skull (headgear stands above it)."""
    return TIERS[index // ROW].height * GOBLIN_PX


def boss_frames(pose: str) -> int:
    """How many frames a pose has."""
    return POSE_FRAMES[pose]


def _paint(kind: str, tier: int, rig, gear: frozenset[str]) -> tuple[int, int, list[bytes]]:
    """One frame as (pixels behind the feet centre, pixels above the ground, rows of codes)."""
    sheet = _Sheet(kind, TIERS[tier].height * GOBLIN_PX)
    ARCHETYPES[kind].paint(sheet, rig, gear)
    if rig.lean:
        sheet.lean(rig.lean)
    if rig.flat:
        sheet.lie_down()
    left, top, right, _ = sheet.box()
    return sheet.ox - left, sheet.oy - top, [bytes(row[left:right]) for row in sheet.rows[top:sheet.oy]]


@lru_cache(maxsize=8)
def _frames(kind: str, tier: int, pose: str) -> tuple[tuple[int, int], tuple[tuple[bytes, ...], ...]]:
    """Every frame of a pose on one canvas: (anchor, the rows of codes of each frame)."""
    painted = [_paint(kind, tier, rig, TIERS[tier].gear) for rig in ARCHETYPES[kind].POSES[pose]]
    behind = max(back for back, _, _ in painted)
    above = max(up for _, up, _ in painted)
    width = behind + max(len(rows[0]) - back for back, _, rows in painted)
    frames = []
    for back, up, rows in painted:
        lines = [bytes(width)] * (above - up) + [(bytes(behind - back) + row).ljust(width, b"\0") for row in rows]
        for y, line in enumerate(lines):
            mixed = bytearray(line)
            for phase in (0, 1):
                mixed[phase::2] = line[phase::2].translate(DITHER[(y + phase) % 2])
            lines[y] = bytes(mixed)
        frames.append(tuple(lines))
    return (behind, above), tuple(frames)


def _mix(colour: str, toward: str, share: float) -> str:
    a, b = (tuple(int(c[i:i + 2], 16) for i in (1, 3, 5)) for c in (colour, toward))
    return "#%02x%02x%02x" % tuple(round(x + (y - x) * share) for x, y in zip(a, b))


@lru_cache(maxsize=None)
def _colours(tier: int, flash: bool) -> tuple[str | None, ...]:
    """A colour for every material code of a tier; None for clear."""
    tones = {**FIXED, **dict(zip(SKIN, TIERS[tier].skin)), **dict(zip(CLOTH, TIERS[tier].cloth))}
    table: list[str | None] = [None] * 256
    for code, colour in tones.items():
        table[ord(code)] = _mix(colour, "#ffffff", FLASH) if flash else colour
    return tuple(table)


def _sprite(index: int, pose: str, frame: int, flip: bool) -> tuple[tuple[int, int], tuple[bytes, ...]]:
    (ax, ay), frames = _frames(*_look(index), pose)
    rows = frames[frame % len(frames)]
    if flip:
        return (len(rows[0]) - ax, ay), tuple(row[::-1] for row in rows)
    return (ax, ay), rows


@lru_cache(maxsize=8)
def boss_pixels(index: int, pose: str, frame: int, flip: bool = False, flash: bool = False) -> Pixels:
    """Frame ``frame`` (wrapped) of a boss pose at one pixel a sprite pixel. Every frame of a pose
    shares one canvas and one anchor. ``flash`` is the same silhouette lightened, the hit flash."""
    anchor, rows = _sprite(index, pose, frame, flip)
    colours = _colours(index // ROW, flash)
    return Pixels(len(rows[0]), len(rows), tuple(tuple(map(colours.__getitem__, row)) for row in rows), anchor)


def boss_anchor(index: int, pose: str, flip: bool = False) -> tuple[int, int]:
    """The anchor every frame of a pose shares, without building its colours."""
    return _sprite(index, pose, 0, flip)[0]


@lru_cache(maxsize=None)
def _silhouette(kind: str, tier: int) -> tuple[tuple[float, float, float], ...]:
    """(height, reach behind, reach ahead) of the standing, unarmed body at SLICES heights, in
    shares of its pixel height. A slice's reach is the middle one of its rows."""
    archetype = ARCHETYPES[kind]
    back, up, rows = _paint(kind, tier, archetype.POSES["stand"][0], TIERS[tier].gear - set(archetype.WEAPONS))
    height = TIERS[tier].height * GOBLIN_PX
    bands = []
    for n in range(SLICES):
        lines = [row for row in rows[max(0, up - (n + 1) * height // SLICES):max(0, up - n * height // SLICES)]
                 if any(row)]
        behind = sorted(back - (len(row) - len(row.lstrip(b"\0"))) for row in lines)
        ahead = sorted(len(row.rstrip(b"\0")) - back for row in lines)
        bands.append(((n + 0.5) / SLICES, behind[len(lines) // 2] / height, ahead[len(lines) // 2] / height))
    return tuple(bands)


@lru_cache(maxsize=None)
def boss_profile(index: int) -> BossProfile:
    """The boss's name, height and standing silhouette for the battle; see ``BossProfile``."""
    kind, tier = _look(index)
    grip = _silhouette(kind, tier)
    slices = tuple((v, max(0.0, min(behind, ahead)) * INSET) for v, behind, ahead in grip)
    mouth = ARCHETYPES[kind].MOUTH
    return BossProfile(boss_name(index), float(TIERS[tier].height), slices,
                       (mouth[0] / CELLS, mouth[1] / CELLS), grip)


def boss_png(index: int, pose: str, frame: int, flip: bool = False, flash: bool = False) -> bytes:
    """A boss frame as an RGBA PNG at one pixel a sprite pixel."""
    _, rows = _sprite(index, pose, frame, flip)
    inks = [b"\0\0\0\0" if colour is None else bytes.fromhex(colour[1:]) + b"\xff"
            for colour in _colours(index // ROW, flash)]
    raw = b"".join(b"\0" + b"".join(map(inks.__getitem__, row)) for row in rows)

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    header = struct.pack(">IIBBBBB", len(rows[0]), len(rows), 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 1)) + chunk(b"IEND", b"")


class PetBossImages:
    """Tk images of boss frames: each painted once at one pixel a sprite pixel and enlarged whole
    by Tk, then kept until the cache passes ``budget`` zoomed pixels, when the least recently
    shown go first. The newest image is always kept, and a dropped one lives while its caller
    holds it. Draw an image's top left at the feet minus ``anchor``."""

    def __init__(self, master, budget: int = BUDGET) -> None:
        self.master = master
        self.budget = budget
        self.pixels = 0
        self.images: dict[tuple, object] = {}

    def image(self, index: int, pose: str, frame: int, zoom: int, flash: bool = False, flip: bool = False):
        """The PhotoImage of a boss frame at ``zoom`` screen pixels a sprite pixel."""
        key = (_look(index), pose, frame % POSE_FRAMES[pose], max(1, int(zoom)), bool(flash), bool(flip))
        found = self.images.pop(key, None)
        if found is None:
            found = self._paint(index, *key[1:])
            self.pixels += found.width() * found.height()
            while self.pixels > self.budget and self.images:
                dropped = self.images.pop(next(iter(self.images)))
                self.pixels -= dropped.width() * dropped.height()
        self.images[key] = found
        return found

    def anchor(self, index: int, pose: str, zoom: int, flip: bool = False) -> tuple[int, int]:
        """Where the feet centre sits in a pose's images, in screen pixels from their top left."""
        ax, ay = boss_anchor(index, pose, flip)
        return ax * max(1, int(zoom)), ay * max(1, int(zoom))

    def _paint(self, index: int, pose: str, frame: int, zoom: int, flash: bool, flip: bool):
        import tkinter as tk
        small = tk.PhotoImage(master=self.master, data=base64.b64encode(boss_png(index, pose, frame, flip, flash)))
        if zoom == 1:
            return small
        big = tk.PhotoImage(master=self.master, width=small.width() * zoom, height=small.height() * zoom)
        big.tk.call(big, "copy", small, "-zoom", zoom, zoom)
        return big

    def clear(self) -> None:
        """Drop every image (on the Tk thread, before the window closes)."""
        self.images.clear()
        self.pixels = 0
