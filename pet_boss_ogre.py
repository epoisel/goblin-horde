"""The ogre: its parts as rows of characters, its poses, its gear, and the order they are painted in.

Every drawing is hand-placed, a character a cell, and the ogre stands 77 cells from sole to skull.
``pet_boss`` redraws the rows at each tier's size and gives the characters their meaning
(``pet_boss.INK``):

    S s  skin and its shade      C c  cloth      W w  wood      B b  bone      I i  iron
    G g  gold                    M m  maw and tongue            R gem          K black
    D    the dark accent         :    skin and shade dithered   o    a wart, in shade
    '    a one pixel highlight along the top of a skin cell     ^    the same on metal and bone
    _    a one pixel dark line along the bottom of a cell       !    the same down its left side
    .    clear

Cells are x forward, y up from the ground under the feet centre; the ogre faces right. A pose is a
row of whole-cell offsets. Nothing here imports the painter: ``paint`` speaks to the sheet it is
handed, so the next archetype is another module shaped like this one.
"""

from __future__ import annotations

import math
from typing import NamedTuple


class Part(NamedTuple):
    """A piece of the body as rows of characters. ``origin`` is the lattice corner (cells right of
    and below the drawing's top left) that a body point pins; ``base`` fills the silhouette."""
    rows: tuple[str, ...]
    origin: tuple[int, int]
    base: str = "S"


ROAR = (
    "DDDDDDDDDDDDDDDDDDDDD",
    "MBBMBBMBBMBBMBBMBBMMM",
    "MBBMBBMBBMBBMBBMBBMMM",
    "MMMMMMMMMMMMMMMMMMMMM",
    "MMMMMMMMMMMMMMMMMMMMM",
    "MMMMMMMMMMMMMMMMMMMMM",
    "MMMMMMMMMMMMMMMMMMMMM",
    "MMMMMmmmmmmmmmmMMMMMM",
    "MMMmmmmmmmmmmmmmmMMMM",
    "MMBmmmmmmmmmmmmmmBMMM",
    "MMBBmmmmmmmmmmmmmBBMM",
    "MBBbmmmmmmmmmmmmBBbMM",
    "MBBBbBBMBBMBBMBBBBBbM",
    "MBBBbBBMBBMBBMBBBBBbM",
    "sSSSSSSSSSSSSSSSSSSSS",
    "sSSSSSSSSSSSSSSSSSSSS",
    ".ssssssssssssssssss..",
)
TUSKS = (
    "...B..............B...",
    "..BBB............BBB..",
    "..BBB............BBB..",
    ".BBBBb..........BBBBb.",
    ".BBBBb..........BBBBb.",
    ".BBBBb..........BBBBb.",
)
PARTS = {
    "head": Part((
        "........SSSSSSSSSSSSSSS........",
        "......SSS'''''''''''''SSS......",
        "....SSSSSSSSSSSSSSSSSSSSSS.....",
        "...SSSSSSSSSSSSSSSSSSSSSSSS....",
        "..ss:SSSSSSSSSSSSSSSSSSSSSSS...",
        ".sss:SSSSSSSSSSSSSSSSSSSSSSS...",
        ".sss:SSSSSSSSSSSSSSSSSSSSSSSS..",
        "sss:SSSSSSSSSSSSSSSSSSSSSSSSSS.",
        "sss:SSSSSSSSSSSSSSSSSSSSSSSSSS.",
        "sss:SSSSSSSSSSSSSSSSSSSSSSSSSS.",
        "sss:SSSSSSSSSSSSSSSSSSSSSSSSS..",
        "sss:SSSSSSSSSSSSSSSSSSSSSSSS...",
        "sss:SSSSSSSSSSSSSSSSSSSSSSSS...",
        "sss:SSSSSSSSSSSSSSSSSSSSSSSS...",
        "sss:SSSSSSSSSSSSSSSSSSSSSSSS...",
        "sss:SSSSSSSSSSSSSSSSSSSSSSSSS..",
        "sss:SSSSSSSSSSSSSSSSSSSSSSSSS..",
        "sss:SSSSSSSSSSSSSSSSSSSSSSSSSS.",
        "sss:SSSSSSSSSSSSSSSSSSSSSSSSSS.",
        "sss:SSSSSSSSSSSSSSSSSSSSSSSSSSS",
        "sss:SSSSSSSSSSSSSSSSSSSSSSSSSSS",
        "sss:SSSSSSSSSSSSSSSSSSSSSSSSSSS",
        "sss:SSSSSSSSSSSSSSSSSoSSSSSSSSS",
        "ssss:SSSSSSSSSSSSSSSSSSSSoSSSSS",
        ".ssss:SSSSSSSSSSSSSSSSSSSSSSSSS",
        ".sssss:::::::::::::::::::::::s.",
        "..ssssssssssssssssssssssssssss.",
        "...ssssssssssssssssssssssssss..",
        ".....ssssssssssssssssssssss....",
        "........ssssssssssssssss.......",
    ), (0, 30)),
    "ear": Part((
        "SS.........",
        "SsS........",
        ".SsSS......",
        ".SssSS.....",
        "..SssSSS...",
        "..SSssSSS..",
        "...SSssSSS.",
        "....SSssSSS",
        ".....SSsSSS",
        "......SSSSS",
        ".......SSSS",
        "........SSS",
    ), (11, 12)),
    "brow": Part((
        "DDDDDD..........",
        "DDDDDDDDDDD.....",
        ".....DDDDDDDDDDD",
        "..........DDDDDD",
    ), (0, 0), "D"),
    "eye": Part(("KKK", "KKK", "KKK"), (0, 0), "K"),
    "eye_x": Part(("KK.KK", "KKKKK", ".KKK.", "KKKKK", "KK.KK"), (1, 1), "K"),
    "eye_shut": Part(("KK..", "..KK", "KK.."), (0, 0), "K"),
    "eye_shut_front": Part(("..KK", "KK..", "..KK"), (0, 0), "K"),
    "mouth_shut": Part(TUSKS + (
        "MBBBBbMMMMMMMMMMBBBBbM",
        "MMMMMMMMMMMMMMMMMMMMMM",
    ), (0, 0), "M"),
    "mouth_grit": Part(TUSKS + (
        "MBBBBbMMMMMMMMMMBBBBbM",
        "MBBBBbBBMBBMBBMBBBBBbM",
        "MBBBBbBBMBBMBBMBBBBBbM",
        "MMMMMMMMMMMMMMMMMMMMMM",
    ), (0, 0), "M"),
    "mouth_open": Part(ROAR[:5] + ROAR[9:], (0, 0), "M"),
    "mouth_roar": Part(ROAR, (0, 0), "M"),
    "torso": Part((
        "..............SSSSSSSSSSSSSSSSSSSSSSSSSS..............",
        "..........SSS''''''''''''SSSSSSSSSSSSSSSSSS...........",
        "........ss:SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS.........",
        "......ss:SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS.......",
        ".....ss:SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS......",
        "....sss:SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS.....",
        "...sss:SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS....",
        "..sss:SSSSSSSSSSSoSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS....",
        "..sss:SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS...",
        ".ssss:SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS...",
        ".ssss:SSSooSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS..",
        ".ssss:SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS..",
        "ssss:SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS..",
        "ssss:SSSSSSSSSSSSSSSoSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS.",
        "ssss:SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
        "ssss:SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS_SSSSSSSS",
        "ssss:SSSSSSSSSooSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS_SSSSSSS",
        "ssss:SSSSSSSSSoSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS_SSSSSS",
        "ssss:SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS_SSSSS",
        "ssss:SoSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
        "ssss:SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
        "ssss:SSSoSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
        "ssss:SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSDSSSSSSS",
        "ssss:SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSDDSSSSSS",
        "ssss:SSSSSSSooSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
        "ssss:SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
        "ssss::::::::::::::::::::::::::::::::::::::::::::::::::",
        "ssssssssssssssssssssssssssssssssssssssssssssssssssssss",
        "ssssssssssssssssssssssssssssssssssssssssssssssssssssss",
        "ssssssssssssssssssssssssssssssssssssssssssssssssssssss",
        "ssss:SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
        "ssss:SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
        ".ssss:SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
        ".ssss:SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS.",
        ".ssss:SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS.",
        "..ssss:SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS.",
        "..ssss:SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS..",
        "...ssss:SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS..",
        "....ssss:SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS...",
        ".....ssss:SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS....",
        "......ssss:::::::::::::::::::::::::::::::::::::::.....",
        "........sssssssssssssssssssssssssssssssssssssss.......",
        "..........sssssssssssssssssssssssssssssssssss.........",
        "............sssssssssssssssssssssssssssssss...........",
        "...............sssssssssssssssssssssssss..............",
        "...................sssssssssssssssss..................",
    ), (0, 46)),
    "cloth": Part((
        "cccccccccccccccccccccccccccccccccccccccBBBBccccc",
        "c______________________________________BccB____c",
        "cccCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCBBBBCCCCC",
        "cccCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
        "cccCCCCCCC!_!_!CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
        "cccCCCCCCCcccccCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
        "cccCCCCCC!cccccCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
        "cccCCCCCCCcccccCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
        "cccCCCCCC!ccccc!CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
        "cccCCCCCCC_C_C_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
        "cccCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
        "cccCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
        ".ccCCCCCCCCCCCCCCCCCCCCCC..CCCCCCCCCCCCCCCCCCCC.",
        "...CCCCCCCCCCCCCCCCCCCC......CCCCCCCCCCCCCCCC...",
        ".....CCCCCCCCCC.CCCCC..........CCCCCCCCCCCC.....",
        ".......CCCCCCCC.CCC..............CCCCCCCC.......",
        ".........cccccc.c..................cccc.........",
        "...........ccc..................................",
    ), (0, 0), "C"),
    "shoulder": Part((
        "....SSSSSSS....",
        "..SS'''''''SS..",
        ".SSSSSSSSSSSSS.",
        "sSSSSSSSSSSSSSS",
        "sSSSSSSSSSSSSSS",
        "s:SSSSSSSSSSSSS",
        "ss:SSSSSSSSSSSS",
    ), (7, 4)),
    "fist": Part((
        "....SSSSSSSS....",
        "..SSSSSSSSSSSS..",
        ".SS''''''''SSSS.",
        "SSSSSSSSSSSSSSSS",
        "sSSSSSSSSSSSSSSS",
        "sSSSSSSSSSSSSSSS",
        "sSSSSSSSSS!SS!SS",
        "s:SSSSSSSS!SS!SS",
        "ss:SSSSSSS!SS!SS",
        "ss::SSSSSSSSSSSS",
        ".sss:::::::::SS.",
        "..ssssssssssss..",
        "....ssssssss....",
    ), (8, 7)),
    "foot": Part((
        "...SSSSSSS............",
        "..SSSSSSSSSSS.........",
        ".SSSSSSSSSSSSSSS......",
        "sSSSSSSSSSSSSSSSSSS...",
        "sSSSSSSSSSSSSS!SSS!SS.",
        "sSSSSSSSSSSSSS!SBB!SBB",
        "s:::::::::::::::::::::",
        "ssssssssssssssssssssss",
    ), (0, 8)),
    "stud": Part((".II.", "I^Ii", "IIIi", ".ii."), (2, 2), "I"),
    "ball": Part((
        ".......b.......",
        ".......B.......",
        "..b..IIIII..b..",
        "...BIIIIIIIB...",
        "...III^^IIII...",
        "..IIIIIIIIIII..",
        "..IIIIIIIIIIi..",
        "bBIIIIIIIIIIiBb",
        "..IIIIIIIIIii..",
        "..IIIIIIIIIii..",
        "...IIIIIIiii...",
        "...BiiiiiiiB...",
        "..b..iiiii..b..",
        ".......B.......",
        ".......b.......",
    ), (7, 7), "I"),
    "horn": Part((
        "......bB.",
        ".....bBB.",
        "....bBBb.",
        "...bB!Bb.",
        "..bBB!b..",
        "..bBBBb..",
        ".bBBBBb..",
        ".b___b...",
        "bBBBBBb..",
        "b____Bb..",
        "bBBBBBb..",
        "bBBBBBb..",
    ), (0, 12), "B"),
    "crown": Part((
        ".G......G......G.",
        ".G......G......G.",
        "GGG....GGG....GGG",
        "GGGG..GGGGG..GGGG",
        "GGGGGGGGGGGGGGGGG",
        "G^^^^^GRRRG^^^^^g",
        "GGGGGGGRRRGGGGGGg",
        "ggggggggggggggggg",
    ), (0, 8), "G"),
    "pauldron": Part((
        ".....IIIIIII.....",
        "...IIIIIIIIIII...",
        "..II^^^^^^^IIII..",
        ".IIIIIIIIIIIIIII.",
        "IIIIIIIIIIIIIIIII",
        "iIIKIIIIIIIIIKIII",
        "iiIIIIIIIIIIIIIIi",
        ".iiiiiiiiiiiiiii.",
    ), (8, 5), "I"),
    "plate": Part((
        "iIIIIIIIIi",
        "I^^^^^^^^I",
        "IKIIIIIIKI",
        "IIII!IIIII",
        "IIIII!IIII",
        "IKIIIIIIKi",
        "iIIIIIIIii",
        ".iiiiiiii.",
    ), (0, 0), "I"),
    "spike": Part(("..I..", "..I..", ".IIi.", ".^Ii.", "IIIii", "IIIii"), (2, 6), "I"),
    "thorn": Part(("b.....", "bB....", ".bBB..", ".bBBB.", "..bBBB", "...bBB"), (6, 6), "B"),
}


class Rig(NamedTuple):
    """One frame of the ogre, in whole cells."""
    bob: int = 0  # the trunk and head, up
    shift: int = 0  # the trunk and head, forward
    head: tuple[int, int] = (0, 0)
    near: tuple[int, int] = (0, 0)  # the near foot (forward, up)
    far: tuple[int, int] = (0, 0)
    arm: tuple[int, int] = (7, -26)  # the weapon hand from its shoulder
    club: tuple[int, int] = (-28, 38)  # the weapon's tip from the hand, about 47 cells away
    far_arm: tuple[int, int] = (-4, -26)
    mouth: str = "shut"  # a MOUTHS key
    eyes: str = "open"  # an EYES key
    lean: float = 0.0  # every row sheared forward (+) or back (-) by this share of its height
    flat: bool = False  # lying on its back, a quarter turn


R = Rig
POSES = {
    "stand": (R(), R(bob=-1)),
    "walk": (
        R(bob=-1, near=(14, 0), far=(-18, 0), arm=(3, -26), club=(-30, 36), far_arm=(12, -23)),
        R(bob=1, far=(-6, 6), far_arm=(4, -26)),
        R(bob=-1, near=(-8, 0), far=(8, 0), arm=(11, -25), club=(-26, 39), far_arm=(-8, -25)),
        R(bob=1, near=(4, 6), far_arm=(2, -26)),
    ),
    "stomp": (
        R(bob=2, shift=-3, near=(8, 14), arm=(-1, 24), club=(12, 45), far_arm=(12, -20), mouth="grit"),
        R(bob=-4, shift=3, head=(2, -2), near=(14, 0), arm=(25, -8), club=(46, -8), far_arm=(-10, -22),
          mouth="open"),
    ),
    "roar": (
        R(bob=-2, shift=-3, head=(-2, 2), arm=(-6, -25), club=(-44, 16), far_arm=(-10, -24), mouth="open"),
        R(shift=4, head=(4, 0), arm=(-3, 25), club=(-12, 45), far_arm=(28, -8), mouth="roar"),
    ),
    "hurt": (
        R(bob=-1, shift=-4, head=(-3, 1), near=(-4, 0), arm=(12, -16), club=(-20, 42), far_arm=(16, -8),
          mouth="grit", eyes="shut"),
    ),
    "fall": (
        R(shift=-2, head=(-2, 1), far=(4, 5), arm=(-14, 2), club=(-30, 36), far_arm=(24, -6), mouth="open",
          eyes="x", lean=-0.3),
        R(arm=(-2, 25), club=(-8, 46), far_arm=(22, 2), mouth="roar", eyes="x", lean=0.22, flat=True),
        R(arm=(-4, 24), club=(-4, 46), far_arm=(10, -20), mouth="open", eyes="x", flat=True),
    ),
}
MOUTH = (20, 56)  # Where roars come from, in the standing pose.

# Body points in the standing pose, before a rig moves them.
SHOULDER, FAR_SHOULDER = (-6, 51), (6, 51)
HIP, FAR_HIP = (-11, 30), (7, 30)
ANKLE = 6  # A leg ends this far above its sole.
HEEL = -8  # A foot's heel, from its leg's centre line.
LIFTED = 8  # Off the ground past this, the near knee shows in front of the cloth.
BODY = {"torso": (-30, 15), "cloth": (-26, 31)}
FACE = {"ear": (-5, 65), "head": (-8, 47), "brow": (5, 70)}  # In the order they are painted.
EYE_SPOTS = ((8, 66), (15, 66))
EYES = {"open": ("eye", "eye"), "shut": ("eye_shut", "eye_shut_front"), "x": ("eye_x", "eye_x")}
MOUTHS = {"shut": ("mouth_shut", (1, 64)), "grit": ("mouth_grit", (1, 64)), "open": ("mouth_open", (2, 61)),
          "roar": ("mouth_roar", (2, 61))}


class Worn(NamedTuple):
    """A piece of gear: the gear that brings it, its part, the body point it rides and its cells
    from that point."""
    gear: str
    part: str
    pin: str  # trunk | head | shoulder
    at: tuple[int, int]
    far: bool = False


GEAR = {  # What the ogre wears, by the moment in the painting it goes on.
    "back": (Worn("spikes", "thorn", "trunk", (-22, 55)), Worn("spikes", "thorn", "trunk", (-27, 46)),
             Worn("spikes", "thorn", "trunk", (-28, 36))),
    "hip": (Worn("armour", "plate", "trunk", (-22, 31)),),
    "skull_far": (Worn("horns", "horn", "head", (0, 75), far=True),),
    "skull": (Worn("crown", "crown", "head", (-5, 75)), Worn("horns", "horn", "head", (11, 74))),
    "shoulder": (Worn("spikes", "spike", "shoulder", (-6, 2)), Worn("spikes", "spike", "shoulder", (2, 4)),
                 Worn("armour", "pauldron", "shoulder", (0, 0))),
}
BRACER = ((0.55, 0.85, b"I", b"i"),)  # Armour's band on the weapon arm, as a stretch of its length.
WRAP, RING = (0.0, 0.1, b"w", b"w"), (0.47, 0.5, b"w", b"w")


class Weapon(NamedTuple):
    """Something to swing: a shaft from below the hand to the tip, with studs or a head on it."""
    widths: tuple[int, int]  # the shaft at the grip and at the tip
    log: bool  # a tapered log: its end rounded, a line of grain along it
    bands: tuple
    studs: tuple[tuple[float, int], ...] = ()  # (share along the shaft, cells off its centre line)
    head: str = ""  # a part pinned to the tip


WEAPONS = {
    "club": Weapon((5, 15), True, (WRAP, RING), ((0.6, 2), (0.74, -3), (0.88, 3))),
    "mace": Weapon((5, 6), False, (WRAP,), head="ball"),
}
GRIP = 0.17  # The share of the shaft's reach that sticks out below the hand.
GRAIN = ((0.62, b"w"),)  # One pixel lines along a limb, as (share across it, code).
CONTOUR = ((1.0, b"D"),)  # The weapon arm's front edge, so it reads against the belly behind it.


def _add(a: tuple[float, float], b: tuple[float, float]) -> tuple[float, float]:
    return a[0] + b[0], a[1] + b[1]


def _leg(sheet, hip: tuple[float, float], step: tuple[int, int], far: bool) -> None:
    sheet.limb(hip, (hip[0] + step[0], step[1] + ANKLE), 15, 14, *((b"s", b"z") if far else (b"S", b"s")))
    sheet.stamp("foot", hip[0] + HEEL + step[0], step[1], far=far)


def _wield(sheet, weapon: Weapon, hand: tuple[float, float], reach: tuple[int, int]) -> None:
    tip = _add(hand, reach)
    sheet.limb((hand[0] - reach[0] * GRIP, hand[1] - reach[1] * GRIP), tip, *weapon.widths, b"W", b"w",
               bands=weapon.bands, seams=GRAIN if weapon.log else (), rounded=weapon.log)
    length = math.hypot(*reach)
    for along, side in weapon.studs:
        sheet.stamp("stud", hand[0] + reach[0] * along - reach[1] / length * side,
                    hand[1] + reach[1] * along + reach[0] / length * side)
    if weapon.head:
        sheet.stamp(weapon.head, *tip)


def paint(sheet, rig: Rig, gear: frozenset[str]) -> None:
    """Paint one frame onto a sheet, far side first."""
    trunk = (rig.shift, rig.bob)
    pins = {"trunk": trunk, "head": _add(trunk, rig.head), "shoulder": _add(trunk, SHOULDER)}

    def wear(moment: str) -> None:
        for piece in GEAR[moment]:
            if piece.gear in gear:
                sheet.stamp(piece.part, *_add(pins[piece.pin], piece.at), far=piece.far)

    far_shoulder = _add(trunk, FAR_SHOULDER)
    far_hand = _add(far_shoulder, rig.far_arm)
    sheet.limb(far_shoulder, far_hand, 12, 10, b"s", b"z")
    sheet.stamp("fist", *far_hand, far=True)
    _leg(sheet, _add(trunk, FAR_HIP), rig.far, far=True)
    wear("back")
    sheet.stamp("torso", *_add(trunk, BODY["torso"]))
    lifted = rig.near[1] > LIFTED
    if not lifted:
        _leg(sheet, _add(trunk, HIP), rig.near, far=False)
    sheet.stamp("cloth", *_add(trunk, BODY["cloth"]))
    if lifted:
        _leg(sheet, _add(trunk, HIP), rig.near, far=False)
    wear("hip")
    wear("skull_far")
    for part, at in FACE.items():
        sheet.stamp(part, *_add(pins["head"], at))
    for part, at in zip(EYES[rig.eyes], EYE_SPOTS):
        sheet.stamp(part, *_add(pins["head"], at))
    mouth, at = MOUTHS[rig.mouth]
    sheet.stamp(mouth, *_add(pins["head"], at))
    wear("skull")
    hand = _add(pins["shoulder"], rig.arm)
    for key, weapon in WEAPONS.items():
        if key in gear:
            _wield(sheet, weapon, hand, rig.club)
    sheet.limb(pins["shoulder"], hand, 13, 11, b"S", b"s", bands=BRACER if "armour" in gear else (),
               seams=CONTOUR)
    sheet.stamp("shoulder", *pins["shoulder"])
    wear("shoulder")
    sheet.stamp("fist", *hand)
