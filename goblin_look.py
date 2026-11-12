"""Who each goblin in the horde is: its name and its look, from its number alone.

Nothing about a single goblin is saved, only the horde's size, so goblin ``n`` must come out the same
every session and on every machine. Each part of a look is a weighted pick from a table below, keyed by a
stable hash of the goblin's number and that part's slot, so changing one slot never moves another.
``pet_art`` draws a look; the names of hats, clothes and tools here are its table keys. Pure: no Tk, no
files.
"""

from __future__ import annotations

from bisect import bisect_right
from itertools import accumulate
from typing import NamedTuple

import pet_art


class Look(NamedTuple):
    name: str  # One key per distinct look, for caches.
    skin: str  # The skin tier's name.
    green: int  # Which green a common goblin is; 0 for a shiny.
    hat: str  # "" for a bare head.
    cloth: int  # The colour of a dyed hat and of the clothes; 0 when it wears neither.
    tool: str
    wear: str


class SkinTier(NamedTuple):
    name: str
    one_in: int  # The chance a goblin rolls this tier; the common tier is everyone else.
    bosses: int | None  # Bosses cleared that unlock it; None for the common tier, which is never locked.


# Common first, then each shiny rarer than the last. A goblin rolls every shiny on its own, and the
# rarest unlocked one it rolled wins, so unlocking a tier only changes goblins that rolled it.
SKIN_TIERS = (
    SkinTier(pet_art.COMMON, 1, None),
    SkinTier("albino", 50, 3),  # tune
    SkinTier("blue", 90, 8),  # tune
    SkinTier("red", 150, 14),  # tune
    SkinTier("violet", 250, 19),  # tune
    SkinTier("gold", 450, 24),  # tune
    SkinTier("shadow", 800, 34),  # tune
)
# Weighted picks, plain ones common and grand ones rare. Greens and cloths are pet_art's, by index.
GREENS = (9, 8, 5, 6, 6, 4, 5, 3)
CLOTHS = (6, 5, 4, 6, 3, 3, 7, 1)
HATS = (  # (hat, weight, the word it adds to a title)
    ("", 28, ""), ("cap", 9, "capped"), ("headband", 8, "headband"), ("hood", 7, "hooded"),
    ("horns", 6, "horned"), ("straw", 6, "straw hat"), ("pot", 5, "pot helm"), ("helmet", 5, "helmeted"),
    ("mohawk", 4, "mohawk"), ("feather", 4, "feathered"), ("pointy", 3, "pointy hat"), ("crown", 1, "crowned"),
)
WEARS = (("", 12), ("vest", 6), ("sash", 3), ("scarf", 3))
TOOLS = (("", 15), ("club", 3), ("sack", 2), ("torch", 1))
# Name parts, screened so that no two- or three-part name spells anything rude.
NAME_PARTS = tuple("""
    mud gut ash bil ochre bone soot bolt rust cinder smoke fuse fang rot knuckle grat hex grin jaw wick
    stack wyrd grub moss muck slag grit scab mold wart bog fen dreg sludge peat clay flint char coal rag
    burr thorn nettle toad newt rat crow grime dirt dust silt stump twig root knot lump mange tusk horn
    claw nail tooth snout nose ear toe chin brow skull rib hide scale wort weed gnash gnaw chew bite gob
    snarl growl grunt sneer smirk lurk sneak skulk creep scamp junk nub nib pip flea tick mite slug
    snail beetle gristle sinew marrow ember spark flare cog rivet gear wrench hammer spade sack pouch
    rope latch hook spike barb prong blade axe club mace sling dart boot patch sock mitt hood cap belt
    buckle pebble rock stone crag cave pit ditch puddle marsh mire swamp gloom murk fog mist frost hail
    thistle gourd turnip radish onion leek crust crumb mush gruel stew broth bean lard grease wax glue
    gum pitch bark moth gnat wasp hog boar mole vole badger ferret weasel stoat cobble tinder kettle
    ladle spoon fork rake tangle snag scrub brush bristle splint chip chunk hunk grip grab fist elbow
    knee shin heel belly lip teeth fizz pop boom thud clank rattle grumble mutter caller hexer biter
    digger kicker bag bib bob bug bix bub burk barg bolk baz blag blib blob blug blix blub blurk blarg
    blolk blaz brag brib brob brug brix brub brog brurk brarg brolk braz dag dib dob dug dub dog durk
    darg dolk daz drag drib drob drix drub drog drurk drarg drolk draz gib gug gix gub gog gurk garg
    golk gaz glag glib glob glug glix glub glog glurk glarg glolk glaz gnag gnib gnob gnug gnix gnub
    gnog gnurk gnarg gnolk grag grib grob grug grix grog grurk grarg grolk graz kag kib kob kug kix kub
    kog kurk karg kolk kaz krag krib krob krug krix krub krog krurk krarg krolk kraz mag mib mob mug mix
    mub mog marg molk maz nag nug nix nog nurk narg nolk skib skob skug skix skub skog skurk skarg skolk
    skaz skrag skrib skrob skrug skrix skrub skrog skrurk skrarg skrolk skraz snib snob snug snix snub
    snurk snarg snolk snaz spag spib spob spug spix spog spurk sparg spolk thag thib thob thix thub thog
    thurk tharg tholk thaz thrag thrib thrug thrix thrub throg thrurk thrarg throlk thraz zag zib zob
    zug zix zub zog zurk zarg zolk zaz
""".split())
NAME_MIDDLES = ("ag", "ob", "ug", "en", "ul", "ak", "ot", "og")
THREE_PART_ONE_IN = 12
NAME_COUNT = len(NAME_PARTS) ** 2

_HAT_WORDS = {hat: word for hat, _, word in HATS}


def _hash(goblin_id: int, slot: str) -> int:
    """A well-mixed 32-bit hash of one slot of one goblin: FNV-1a, then murmur3's finalizer so
    neighbouring numbers land far apart."""
    value = 2166136261
    for byte in f"{goblin_id}:{slot}".encode("ascii"):
        value = ((value ^ byte) * 16777619) & 0xffffffff
    value ^= value >> 16
    value = (value * 0x85ebca6b) & 0xffffffff
    value ^= value >> 13
    value = (value * 0xc2b2ae35) & 0xffffffff
    return value ^ (value >> 16)


def _pick(goblin_id: int, slot: str, weights: tuple[int, ...]) -> int:
    totals = list(accumulate(weights))
    return bisect_right(totals, _hash(goblin_id, slot) % totals[-1])


def _shuffle(index: int, size: int) -> int:
    """A fixed permutation of range(size), so goblins 0 to size - 1 each get a different name: a small
    Feistel network over the next even power of two, walking the cycle until it lands inside."""
    half = ((size - 1).bit_length() + 1) // 2
    mask = (1 << half) - 1
    while True:
        left, right = index >> half, index & mask
        for round_ in range(4):
            left, right = right, left ^ (_hash(right, f"name{round_}") & mask)
        index = (left << half) | right
        if index < size:
            return index


def _skin_tier(goblin_id: int, unlocked: frozenset[str]) -> SkinTier:
    for tier in reversed(SKIN_TIERS[1:]):
        if tier.name in unlocked and _hash(goblin_id, f"skin.{tier.name}") % tier.one_in == 0:
            return tier
    return SKIN_TIERS[0]


def look_for(goblin_id: int, unlocked: frozenset[str] = frozenset()) -> Look:
    """Goblin ``goblin_id``'s look for ``pet_art``, with shinies limited to ``unlocked`` tiers."""
    tier = _skin_tier(goblin_id, unlocked)
    hat = HATS[_pick(goblin_id, "hat", tuple(weight for _, weight, _ in HATS))][0]
    wear = WEARS[_pick(goblin_id, "wear", tuple(weight for _, weight in WEARS))][0]
    tool = TOOLS[_pick(goblin_id, "tool", tuple(weight for _, weight in TOOLS))][0]
    # A colour nothing shows is left at 0, so goblins that look alike share one look.
    common = tier is SKIN_TIERS[0]
    green = _pick(goblin_id, "green", GREENS) if common else 0
    cloth = _pick(goblin_id, "cloth", CLOTHS) if pet_art.wears_cloth(hat, wear) else 0
    skin = f"{tier.name}{green}" if common else tier.name
    name = f"{skin}.{hat or 'bare'}.{wear or 'plain'}.{tool or 'empty'}.c{cloth}"
    return Look(name, tier.name, green, hat, cloth, tool, wear)


def unlocked_tiers(state: dict) -> frozenset[str]:
    """The shiny tiers a game state has unlocked, by bosses cleared."""
    cleared = (state.get("bosses") or {}).get("cleared") or 0
    return frozenset(tier.name for tier in SKIN_TIERS[1:] if cleared >= tier.bosses)


def name_for(goblin_id: int) -> str:
    """Goblin ``goblin_id``'s name, such as ``Wartboar`` or, rarely, ``Glogaglurk``."""
    index = _shuffle(goblin_id % NAME_COUNT, NAME_COUNT)
    head, tail = NAME_PARTS[index // len(NAME_PARTS)], NAME_PARTS[index % len(NAME_PARTS)]
    middle = ""
    if _hash(goblin_id, "name.form") % THREE_PART_ONE_IN == 0:
        middle = NAME_MIDDLES[_hash(goblin_id, "name.middle") % len(NAME_MIDDLES)]
    return (head + middle + tail).capitalize()


def title_for(look: Look) -> str:
    """The hover subtitle for a look: 'Goblin', 'Helmeted goblin', 'Albino hooded goblin'."""
    tier = "" if look.skin == SKIN_TIERS[0].name else look.skin
    return " ".join(word for word in (tier, _HAT_WORDS[look.hat], "goblin") if word).capitalize()
