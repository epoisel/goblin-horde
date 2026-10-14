"""The pixel goblins: tribes, outfits, and the one renderer every surface draws them with.

Goblin bodies, faces, gear, and outfits come from goblin_art.json, the sprite file the browser viewer
draws from too, so a goblin looks the same on every surface. Action props and poses stay in
goblin_cues; which action a goblin acts out comes from goblin_motion. Nothing here knows about
windows: give draw_sprite any Tk canvas (or anything with create_rectangle/create_oval).
"""

from __future__ import annotations

import json
from pathlib import Path

from goblin_cues import HELD, PORTAL_CLIP, PORTAL_TOP, Pose, art_runs, cue_for, cue_runs, exit_frame, pose_for

ART = json.loads(Path(__file__).with_name("goblin_art.json").read_text(encoding="utf-8"))
# Each agent's model picks its tribe: Claude models are hooded hexers, OpenAI models sapper
# war-machinists, and everything else (Orca, feeds without a model) ragged raiders.
TRIBES: dict[str, list[dict]] = {
    name: [{**outfit, "tribe": name, "body": spec["body"], "arm": spec["arm"]} for outfit in spec["outfits"]]
    for name, spec in ART["tribes"].items()
}
KINDS = [outfit for outfits in TRIBES.values() for outfit in outfits]
FAMILY_TRIBE = {"claude": "shaman", "openai": "sapper"}
SOURCE_TRIBE = {"claude": "shaman", "codex": "sapper"}
ART_EYES = {"front": "eyesFwd", "right": "eyesRight", "up": "eyesFwd", "squint": "eyesWorry", "blink": "eyesShut"}
# The art sits one column right and one row down on the widget grid: its feet stand on the shadow at
# row 16 and a tall helm or hood (art rows -1 to -4) still drops fully through the floor portal.
ART_COL, ART_ROW = 1, 1
FEET_ROW = ART_ROW + len(ART["layers"]["body"]["rows"]) - 1
# A goblin, its cue, its staff, its hop, and its shadow fit in SPAN_W x SPAN_H sprite pixels; layouts
# reserve that times the scale and place the sprite origin at the box's left, TOP_ROOM rows below its
# top (headgear and a hop reach two rows above the origin, the shadow ends 20 rows below it).
SPAN_W = 24
SPAN_H = 22
TOP_ROOM = 2
_ART_RUNS: dict[str, tuple[tuple[int, int, int, str], ...]] = {}


def model_of(actor: dict) -> dict:
    """The model an actor reports ({id, label, family, effort}), or {} when its source did not say."""
    model = actor.get("model")
    return model if isinstance(model, dict) else {}


def art_layer_runs(name: str) -> tuple[tuple[int, int, int, str], ...]:
    """Horizontal (column, row, length, palette key) runs of one goblin_art layer, in widget sprite pixels."""
    if name not in _ART_RUNS:
        layer = ART["layers"][name]
        left, top = layer["at"]
        runs = []
        for row, line in enumerate(layer["rows"]):
            column = 0
            while column < len(line):
                key, length = line[column], 1
                while column + length < len(line) and line[column + length] == key:
                    length += 1
                if key != ".":
                    runs.append((ART_COL + left + column, ART_ROW + top + row, length, key))
                column += length
        _ART_RUNS[name] = tuple(runs)
    return _ART_RUNS[name]


def art_color(key: str, style: dict) -> str:
    role = ART["styleColors"].get(key)
    if role is None:
        return ART["colors"][key]
    if role == "coatDark":
        value = int(style["coat"][1:], 16)
        return "#" + "".join(f"{round(((value >> shift) & 255) * ART['coatDark']):02x}" for shift in (16, 8, 0))
    return style[role]


def stable_style(actor_id: str) -> int:
    """A stable hash of an actor id; the same agent always wears the same outfit."""
    value = 2166136261
    for byte in actor_id.encode("utf-8"):
        value = ((value ^ byte) * 16777619) & 0xffffffff
    return value


def tribe_for(actor: dict) -> str:
    """The goblin tribe for an agent: its model's family first, then the source it came from."""
    family = str(model_of(actor).get("family") or "")
    return FAMILY_TRIBE.get(family) or SOURCE_TRIBE.get(str(actor.get("source") or ""), "raider")


def tribe_title(actor: dict) -> str:
    """The tribe's name for tooltips: 'Hexer', 'Sapper', or 'Raider'."""
    return str(ART["tribes"].get(tribe_for(actor), {}).get("label") or "")


def style_for(actor: dict, offset: int = 0, index: int | None = None) -> dict:
    """The outfit an agent wears: its tribe's outfit by a stable hash of its id (or ``index``)."""
    outfits = TRIBES.get(tribe_for(actor)) or TRIBES["raider"]
    named = [index for index, outfit in enumerate(outfits) if outfit["name"] == actor.get("outfit")]
    if named and index is None:
        index = named[0]
    base = stable_style(str(actor.get("id") or "")) if index is None else index
    return outfits[(base + offset) % len(outfits)]


def sprite_scale(base: int, ui_scale: float) -> int:
    """Whole screen pixels per sprite pixel: the design's 2x or 4x times the display scale, rounded
    half up, so a goblin stays crisp at 125% and 150% and never shrinks below one pixel."""
    return max(1, int(base * max(ui_scale, 0.5) + 0.5))


def draw_sprite(c, x: int, y: int, style: dict, action: str = "idle", frame: int = 0, scale: int = 4,
                still: bool = False, tag: str = "", exit_beat: int | None = None,
                exit_outcome: str = "finished", stipple: str = "") -> None:
    """Draw a goblin on a 17x16 pixel grid with its action cue in the 8 columns to its right.

    Body offsets and cues move whole sprite pixels, so every beat stays visible at scale 2.
    ``still`` draws one readable frame for reduced motion. ``exit_beat`` draws the retiring
    goblin sinking through a floor portal instead, in the same footprint; only a finished
    ``exit_outcome`` waves and sparkles on the way down. ``stipple`` (e.g. "gray50") fades a
    goblin whose work is done; on a see-through window the gaps show the desktop.
    """
    s = scale
    k = scale / 4  # The shadow was drawn for the 4x goblin.
    extra = {"tags": tag} if tag else {}
    if stipple:
        extra["stipple"] = stipple
    leaving = exit_frame(exit_beat, still, exit_outcome) if exit_beat is not None else None
    ground_x, ground_y = x, y
    clip_y = None
    if leaving:
        action = "exit"
        pose = Pose(0, leaving.sink, leaving.arm)
        # The body vanishes row by row into the portal's middle line.
        clip_y = ground_y + PORTAL_CLIP * s
        for column, row, length, color in art_runs(leaving.ring or (), 0, PORTAL_TOP):
            c.create_rectangle(x + column * s, y + row * s, x + (column + length) * s, y + (row + 1) * s,
                               fill=color, outline=color, tags=(tag, "exit") if tag else ("exit",))
    else:
        pose = pose_for(action, frame, still)
        c.create_oval(x + round(7 * k), y + round(69 * k), x + round(69 * k), y + round(80 * k),
                      fill="#6d765b", outline="", stipple="gray50", **({"tags": tag} if tag else {}))
    x += pose.dx * s
    y += pose.dy * s

    def block(ox: int, oy: int, px: int, py: int, w: int, h: int, color: str) -> None:
        top, bottom = oy + py * s, oy + (py + h) * s
        if clip_y is not None:
            if top >= clip_y:
                return
            bottom = min(bottom, clip_y)
        c.create_rectangle(ox + px * s, top, ox + (px + w) * s, bottom,
                           fill=color, outline=color, **extra)

    def rect(px: int, py: int, w: int, h: int, color: str) -> None:
        block(x, y, px, py, w, h, color)

    def layer(name: str, dy: int = 0) -> None:
        for column, row, length, key in art_layer_runs(name):
            rect(column, row + dy, length, 1, art_color(key, style))
    # The body, face, and gear are the shared goblin_art.json sprite. Feet are drawn on their own:
    # a slumped goblin sinks onto planted feet, a hopping one lifts one, and a goblin going
    # through a portal takes its feet with it.
    feet_y = ground_y if pose.dy > 0 and not leaving else y
    for column, row, length, key in art_layer_runs(style.get("body", "body")):
        if row == FEET_ROW:
            lift = 1 if (pose.step == 1 and column < 8 + ART_COL) or (pose.step == 2 and column >= 8 + ART_COL) else 0
            block(x, feet_y, column, row - lift, length, 1, art_color(key, style))
        else:
            rect(column, row, length, 1, art_color(key, style))
    blink = action == "idle" and not still and frame % 12 in (10, 11)
    layer(ART_EYES["blink" if blink else pose.eyes if pose.eyes in ART_EYES else "front"], dy=-1 if pose.eyes == "up" else 0)
    layer(f"gear.{style['gear']}")

    # Held tools (magnifier, hammer) travel with the body; signs (thought, bell, cross)
    # float beside the head. Idle goblins carry nothing.
    # A portal shows its sparkle or the note left behind, never the work prop.
    cue = leaving.cue if leaving else cue_for(action, frame, still)
    if cue:
        cue_x, cue_y = (x, y) if action in HELD else (ground_x, ground_y)
        kind = "exit" if leaving else "cue"
        cue_tags = (tag, kind) if tag else (kind,)
        faded = {"stipple": stipple} if stipple else {}
        for column, row, length, color in cue_runs(cue):
            c.create_rectangle(cue_x + column * s, cue_y + row * s,
                               cue_x + (column + length) * s, cue_y + (row + 1) * s,
                               fill=color, outline=color, tags=cue_tags, **faded)
    # The right arm draws last so a goblin visibly grips its tool; it starts at the art's shoulder
    # (row 11) and ends where the held props in goblin_cues expect a hand.
    sleeve, skin, ink = style["coat"], style["skin"], ART["colors"]["K"]
    arm = pose.arm
    if arm == "reach":
        rect(13, 11, 2, 1, sleeve); rect(14, 10, 2, 1, sleeve); rect(16, 8, 1, 2, skin); rect(16, 10, 1, 1, ink)
    elif arm == "reach_high":
        rect(13, 11, 1, 1, sleeve); rect(14, 9, 1, 2, sleeve); rect(15, 8, 1, 1, sleeve); rect(16, 7, 1, 2, skin)
    elif arm == "raise":
        rect(13, 10, 2, 2, sleeve); rect(14, 8, 1, 2, sleeve); rect(15, 6, 2, 2, skin)
    elif arm == "chin":
        layer("armChin")
    elif arm == "wave_high":
        layer("waveUp")
    elif arm == "wave_low":
        layer("waveOut")
    elif arm == "slump":
        rect(13, 12, 1, 2, sleeve); rect(13, 14, 1, 1, skin); rect(14, 12, 1, 3, ink)
    else:
        layer(style.get("arm", "armRest"))
