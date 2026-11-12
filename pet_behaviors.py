"""Goblin behaviour tables for the side-view pet world, and the functions that carry out a row.

Standard library only, no Tk. Lengths are sprite pixels and times are seconds: the world works
in sprite pixels and converts to screen pixels at its edges. A goblin's (x, y) is the point
between its feet, and y grows downward. What a goblin can do, what it does next, and how each
state is drawn are tables; `pet_battle` adds the motions and entry hooks of a boss fight.
"""
import random
from typing import NamedTuple

INF = float('inf')

GOBLIN_H = 11.0       # body height; bosses are measured in these
STACK_H = 9.0         # how much higher a rider stands than its carrier
GRAVITY = 900.0
RUN_SPEED = 44.0
JUMP_SPEED = 205.0
THROW_MAX = 420.0
EDGE = 2.0            # how near a platform end counts as at the edge
REACH = 6.0           # how near a chaser gets before it acts
SIGHT = 110.0         # how far a goblin looks for someone to chase or climb
LANES = 6             # depth rows on the ground, one pixel apart, so a crowd is not a single line
TOWER = 3             # goblins in one stack
MOUNT_SPEED = 48.0
SPREAD_SLACK = 1.5    # seconds before its time is up that a scattering goblin is at its spot
DASH = 8.0            # multiple of RUN_SPEED a goblin with far to go may reach
DAZED_SHARE = 0.2     # of the horde, flat on its back at once


class Draw(NamedTuple):
    """One goblin for the view. (x, y) is its feet centre in screen pixels; sprites face right."""
    id: int
    action: str
    frame: int
    x: float
    y: float
    flip: bool
    alpha: float
    scale: float


class BossDraw(NamedTuple):
    """The boss for the view. (x, y) is its feet centre in screen pixels; `hp` runs 1 to 0."""
    index: int
    pose: str
    frame: int
    x: float
    y: float
    flip: bool
    flash: bool
    hp: float
    height_px: float


class Pop(NamedTuple):
    """A short-lived effect. A pop with `text` is drawn as that text, any other as the `kind` sprite."""
    kind: str    # coin | hit | crit | alert | dust | star | banner
    x: float
    y: float
    text: str
    age: float   # seconds since it appeared
    life: float  # seconds it lasts


class Frame(NamedTuple):
    """Everything to draw for one instant, goblins back to front."""
    draws: tuple
    boss: object  # BossDraw, or None when no boss is on screen
    pops: tuple
    phase: str    # roam | enter | charge | swarm | finish | rout | disperse
    quake: float  # screen shake in pixels


class Personality(NamedTuple):
    speed: float = 1.0    # run speed multiple
    energy: float = 1.0   # weight on moving states
    social: float = 1.0   # weight on chasing, wrestling and stacking
    brave: float = 0.5    # higher charges in an earlier wave


def personality_for(goblin_id):
    """The same goblin id is the same character in every session."""
    rng = random.Random(goblin_id * 7919 + 17)
    return Personality(rng.uniform(0.7, 1.45), rng.uniform(0.4, 1.9), rng.uniform(0.3, 1.9), rng.random())


class Behavior(NamedTuple):
    anim: str
    motion: str
    dur: tuple = (0.0, 0.0)  # seconds range; (0, 0) lasts until its motion ends it
    speed: float = 0.0       # multiple of RUN_SPEED
    edge: str = 'turn'       # at a window's end: turn | stop | fall
    fail: str = 'idle'       # where it goes when it cannot start, or a goal times out
    lands: str = 'land'      # state on touching a platform, for air motions
    bounce: float = 0.0      # drawn hop height, no physics
    hits: bool = False       # lands blows on the boss
    still: bool = False      # others may climb onto it
    push: bool = True        # takes part in separation
    goal: bool = False       # timing out means it failed


B = Behavior
BEHAVIORS = {
    'idle': B('idle', 'stand', (0.5, 2.2), still=True),
    'look': B('idle', 'stand', (0.3, 0.8), still=True),
    'run': B('run', 'walk', (0.6, 2.4), 1.0),
    'sprint': B('run', 'walk', (0.5, 1.5), 2.0),
    'bump': B('run', 'walk', (0.3, 0.7), 1.2),
    'hop': B('jump', 'air', push=False),
    'fall': B('jump', 'air', push=False),
    'leap': B('jump', 'air', push=False),
    'drop_in': B('jump', 'air', lands='cheer', push=False),
    'flung': B('grabbed', 'air', lands='dazed', push=False),
    'land': B('land', 'stand', (0.08, 0.14)),
    'chase': B('run', 'seek', (2.5, 2.5), 1.8, goal=True),
    'wrestle': B('brawl', 'scuffle', (0.9, 2.4), bounce=2, still=True),
    'stack': B('run', 'seek', (2.0, 2.0), 1.4, goal=True),
    'mount': B('climb', 'mount', push=False),
    'perch': B('cheer', 'ride', (1.2, 3.2), still=True, push=False),
    'pileon': B('brawl', 'ride', (1.0, 2.6), hits=True, still=True, push=False),
    'cheer': B('cheer', 'stand', (0.8, 1.5), bounce=7),
    'dazed': B('dazed', 'stand', (0.9, 1.8), fail='land', push=False),
    'held': B('grabbed', 'held', push=False),
    'thrown': B('jump', 'hurl', push=False),
    'stroll': B('run', 'walk', (4.0, 4.0), 0.55, edge='stop'),
    'sit': B('sit', 'stand', (1.5, 3.5), push=False),
    'walkoff': B('run', 'walk', (4.0, 4.0), 1.0, edge='fall'),
    'gawk': B('idle', 'stand', (0.15, 0.5)),
    'flee': B('run', 'walk', (0.4, 1.0), 2.0, fail='gawk'),
    'rally': B('run', 'rally', (4.0, 4.0), 2.0, edge='fall', fail='gawk'),
    'charge': B('run', 'storm', (9.0, 9.0), 3.0, edge='fall', fail='gawk', goal=True),
    'climb': B('climb', 'scale', (5.0, 5.0), fail='brawl', push=False),
    'cling': B('grip', 'cling', (1.2, 3.0), hits=True, push=False),
    'brawl': B('brawl', 'scuffle', (0.7, 1.8), bounce=2, hits=True, still=True),
    'scatter': B('run', 'spread', (6.0, 6.0), 2.2, edge='fall', goal=True),
}
IDLERS = ('idle', 'look')


class To(NamedTuple):
    state: str
    weight: float
    trait: str = ''  # personality field that scales the weight


_FIGHT = {
    'charge': (To('climb', 3), To('brawl', 2)),
    'climb': (To('cling', 1),),
    'cling': (To('cling', 2), To('climb', 2), To('leap', 0.5)),
    'brawl': (To('brawl', 2), To('climb', 3), To('stack', 1.2), To('charge', 1), To('hop', 0.5)),
    'stack': (To('mount', 1),),
    'mount': (To('pileon', 1),),
    'pileon': (To('pileon', 2), To('leap', 1)),
    '*': (To('charge', 1),),
}
_LET_GO = {'cling': (To('leap', 1),), 'climb': (To('leap', 1),), 'pileon': (To('leap', 1),)}
TRANSITIONS = {  # context -> finished state -> weighted choices; '*' is every other state
    'ground': {
        'idle': (To('run', 5, 'energy'), To('sprint', 2, 'energy'), To('hop', 2.5, 'energy'),
                 To('look', 1.5), To('idle', 1), To('chase', 2.5, 'social'), To('stack', 1.2, 'social')),
        'look': (To('idle', 1), To('run', 2, 'energy')),
        'run': (To('idle', 2), To('run', 3), To('sprint', 2, 'energy'), To('hop', 3, 'energy'),
                To('chase', 2, 'social'), To('stack', 1, 'social')),
        'sprint': (To('run', 2), To('idle', 1), To('hop', 2), To('sprint', 1, 'energy')),
        'chase': (To('wrestle', 3), To('bump', 2)),
        'stack': (To('mount', 1),),
        'mount': (To('perch', 1),),
        'perch': (To('hop', 1),),
        'wrestle': (To('run', 2), To('dazed', 1), To('idle', 1), To('cheer', 0.7)),
        'cheer': (To('idle', 1), To('run', 2)),
        '*': (To('run', 3), To('idle', 2)),
    },
    'window': {
        'idle': (To('stroll', 4), To('look', 1), To('idle', 1.5), To('walkoff', 0.35)),
        'look': (To('idle', 1), To('stroll', 1)),
        'stroll': (To('sit', 3), To('stroll', 1.5), To('idle', 1)),
        'sit': (To('stroll', 2), To('walkoff', 1), To('sit', 1)),
        '*': (To('idle', 1),),
    },
    'enter': {'*': (To('gawk', 3), To('flee', 2), To('hop', 0.6))},
    'muster': {'*': (To('rally', 1),)},
    'charge': _FIGHT,
    'swarm': _FIGHT,
    'finish': {**_LET_GO, 'brawl': (To('flee', 1),), 'charge': (To('flee', 1),), '*': (To('cheer', 1),)},
    'rout': {**_LET_GO, '*': (To('flee', 3), To('gawk', 1))},
    'disperse': {'*': (To('scatter', 1),)},
}


class Anim(NamedTuple):
    action: str  # the sprite sheet row the view draws
    fps: float
    seq: tuple


ACTION_FRAMES = {'idle': 4, 'run': 4, 'jump': 3, 'land': 1, 'cheer': 4, 'brawl': 4, 'climb': 4,
                 'dazed': 4, 'grabbed': 4, 'sit': 2}
ANIMS = {
    'idle': Anim('idle', 5, (0, 0, 1, 1, 0, 0, 1, 1, 0, 2, 0, 2, 0, 0, 1, 1, 0, 3)),
    'run': Anim('run', 11, (0, 1, 2, 3)),
    'jump': Anim('jump', 0, (0, 1, 2)),
    'land': Anim('land', 0, (0,)),
    'cheer': Anim('cheer', 8, (0, 1, 2, 3)),
    'brawl': Anim('brawl', 10, (0, 1, 2, 3)),
    'climb': Anim('climb', 7, (0, 1, 2, 3)),
    'grip': Anim('climb', 2.5, (1, 1, 0, 1, 1, 2)),  # hanging on, shifting one hand at a time
    'dazed': Anim('dazed', 6, (0, 1, 2, 3)),
    'grabbed': Anim('grabbed', 9, (0, 1, 2, 3)),
    'sit': Anim('sit', 1.6, (0, 1)),
}
FRAME_PICK = {  # animations whose frame follows the body, not the clock
    'jump': lambda g: 0 if g.vy < -40 else 2 if g.vy > 40 else 1,
}


class EffectKind(NamedTuple):
    pop: str             # the Pop kind the view gets
    ttl: tuple
    gravity: float = 0.0
    bounce: float = 0.0  # share of speed kept on hitting the ground


EFFECTS = {
    'coin': EffectKind('coin', (1.3, 2.2), GRAVITY, 0.5),
    'gain': EffectKind('coin', (1.2, 1.2)),
    'dust': EffectKind('dust', (0.4, 0.6)),
    'spark': EffectKind('star', (0.12, 0.2)),
    'hit': EffectKind('hit', (0.55, 0.55)),
    'smash': EffectKind('crit', (0.9, 0.9)),
    'alert': EffectKind('alert', (0.5, 0.8)),
    'banner': EffectKind('banner', (1.8, 1.8)),
}


class Goblin:
    __slots__ = ('id', 'x', 'y', 'vx', 'vy', 'grounded', 'platform', 'facing', 'state', 'timer',
                 'personality', 'lane', 'clock', 'rate', 'tempo', 'pace', 'behavior', 'move',
                 'target', 'carrier', 'rider', 'goal', 'spot', 'wave', 'hit', 'u', 'v', 'tu', 'tv',
                 'alpha', 'hang')


def _stand(world, g, dt):
    pass


def _open_end(world, x):
    """False where the screen edge cut a window top short: there is no drop to step off or sit over."""
    return EDGE < x < world.width - EDGE


def _walk(world, g, dt):
    p = g.platform
    x = g.x + g.facing * g.pace * world.haste * dt
    if x < p.x0 + EDGE or x > p.x1 - EDGE:
        x = EDGES['turn' if p.kind == 'ground' else g.behavior.edge](world, g, p, x)
    g.x = x


def _edge_turn(world, g, p, x):
    g.facing = -g.facing
    return min(max(x, p.x0 + EDGE), p.x1 - EDGE)


def _edge_stop(world, g, p, x):
    g.x = min(max(x, p.x0 + EDGE), p.x1 - EDGE)
    world.advance(g)
    return g.x


def _edge_fall(world, g, p, x):
    if not _open_end(world, x):
        return _edge_turn(world, g, p, x)
    if x < p.x0 or x > p.x1:
        world.throw(g, 'fall', g.facing * g.pace, 0.0)
    return x


EDGES = {'turn': _edge_turn, 'stop': _edge_stop, 'fall': _edge_fall}


def air(world, g, dt):
    g.vy += GRAVITY * dt
    x = g.x + g.vx * dt
    if x < EDGE or x > world.width - EDGE:
        g.vx *= -0.4
        x = min(max(x, EDGE), world.width - EDGE)
    y = g.y + g.vy * dt
    if y < GOBLIN_H:
        y, g.vy = GOBLIN_H, max(g.vy, 0.0)
    if g.vy > 0.0:
        line = world.floor + g.lane
        home = world.ground if y >= line else None
        for p in world.windows:  # only a top edge crossed from above catches a goblin
            if g.y <= p.y <= y and p.y < line and p.x0 <= x <= p.x1:
                home, line = p, p.y
        if home is not None:
            g.x, g.y, g.vx, g.vy = x, line, 0.0, 0.0
            g.grounded, g.platform = True, home
            world.enter(g, g.behavior.lands)
            return
    g.x, g.y = x, y


def _held(world, g, dt):
    x, y = world.hand
    x = min(max(x + g.hang[0], EDGE), world.width - EDGE)
    y = min(y + g.hang[1] + GOBLIN_H, world.floor)
    g.vx = 0.6 * g.vx + 0.4 * (x - g.x) / dt
    g.vy = 0.6 * g.vy + 0.4 * (y - g.y) / dt
    g.x, g.y = x, y


def _seek(world, g, dt):
    t = g.target
    if t is None or not (t.platform is g.platform or t.carrier is not None):
        world.enter(g, g.behavior.fail)
        return
    dx = t.x - g.x
    if -REACH < dx < REACH:
        world.advance(g)
        return
    g.facing = 1 if dx > 0 else -1
    _walk(world, g, dt)


def _scuffle(world, g, dt):
    rng, p = world.rng, g.platform
    g.x = min(max(g.x + (rng.random() - 0.5) * 36.0 * dt, p.x0), p.x1)
    if not g.behavior.hits and rng.random() < 0.05:
        world.effect('dust', g.x + rng.uniform(-4, 4), g.y - rng.uniform(2, 9))


def _mount(world, g, dt):
    c = g.carrier
    if c is None or not c.behavior.still:
        world.throw(g, 'fall', -g.facing * 25.0, -40.0)
        return
    top = c.y - STACK_H
    g.x += (c.x - g.x) * min(1.0, 12.0 * dt)
    g.y -= MOUNT_SPEED * dt
    if g.y <= top:
        g.x, g.y = c.x, top
        world.advance(g)


def _ride(world, g, dt):
    c = g.carrier
    if c is None or c.rider is not g or not c.behavior.still:
        world.throw(g, 'fall', -g.facing * 25.0, -40.0)
        return
    g.x, g.y = c.x, c.y - STACK_H


def run_to(world, g, dt, aim):
    """Head along the ground for x = aim, stepping off a window that is in the way; True once there."""
    p = g.platform
    aim = min(max(aim, 2.0 * EDGE), world.width - 2.0 * EDGE)
    if p.kind != 'ground' and p.x0 <= aim <= p.x1:
        ends = [end for end in (p.x0 - 1.0, p.x1 + 1.0) if _open_end(world, end)]
        if not ends:  # a top that spans the screen has no way round, so the goblin drops through it
            g.y += 0.5
            world.throw(g, 'fall', 0.0, 0.0)
            return False
        aim = min(ends, key=lambda end: abs(end - aim))
    dx = aim - g.x
    if -REACH < dx < REACH and p.kind == 'ground':
        return True
    g.facing = 1 if dx > 0 else -1
    _walk(world, g, dt)
    return False


def hurry(g, gap, left):
    """Speed a runner up to cover `gap` in `left` seconds: never slower than it was, nor past DASH."""
    g.pace = max(g.pace, min(gap / max(0.3, left), DASH * RUN_SPEED))


def _spread(world, g, dt):
    """Run to its own spot on the ground, as fast as it takes to be there in time."""
    spot = g.spot
    if spot is None:
        world.advance(g)
        return
    hurry(g, abs(spot - g.x), g.timer - SPREAD_SLACK)
    if run_to(world, g, dt, spot):
        g.spot = None
        world.advance(g)


MOTIONS = {'stand': _stand, 'walk': _walk, 'air': air, 'held': _held, 'seek': _seek,
           'scuffle': _scuffle, 'mount': _mount, 'ride': _ride, 'spread': _spread}
NEEDS_FOOTING = frozenset(('stand', 'walk', 'seek', 'scuffle', 'rally', 'storm', 'spread'))
STACKED = frozenset(('mount', 'ride'))


def free(o):
    """On its feet and its own goblin: fair game to chase, cheer or knock about."""
    return o.grounded and o.behavior.push


def _depth(o):
    """How many goblins this one is standing on."""
    count = 0
    while o.carrier is not None:
        o = o.carrier
        count += 1
    return count


def _stackable(o):
    return o.behavior.still and o.rider is None and (o.grounded or _depth(o) < TOWER - 1)


def _on_ground(g):
    return g.platform is not None and g.platform.kind == 'ground'


def _start_run(world, g):
    if world.rng.random() < 0.35:
        g.facing = -g.facing
    return True


def _start_look(world, g):
    g.facing = -g.facing
    return True


def _start_hop(world, g):
    rng = world.rng
    g.vx = g.facing * RUN_SPEED * g.personality.speed * rng.choice((0.0, 1.0, 2.0))
    g.vy = -JUMP_SPEED * rng.uniform(0.6, 1.15)
    world.lift(g)
    return True


def _start_chase(world, g):
    if not _on_ground(g):
        return False
    g.target = world.neighbor(g, free)
    return g.target is not None


def _start_stack(world, g):
    if not _on_ground(g):
        return False
    g.target = world.neighbor(g, _stackable, sight=SIGHT / 2)
    return g.target is not None


def _start_mount(world, g):
    c = g.target
    if c is None or not _stackable(c):
        return False
    world.lift(g)
    c.rider, g.carrier = g, c
    if c.timer < 2.5:
        c.timer = 2.5  # the one underneath holds still long enough to be stood on
    return True


def _start_wrestle(world, g):
    t, g.target = g.target, None
    if t is not None and free(t) and t.platform is g.platform:
        g.facing = 1 if t.x >= g.x else -1
        t.facing = -g.facing
        t.target = None
        world.enter(t, 'wrestle')
    return True


def _start_bump(world, g):
    t, g.target = g.target, None
    if t is not None and free(t):
        world.throw(t, 'fall', g.facing * 70.0, -130.0)
    return True


def _start_dazed(world, g):
    """Only so many lie flat at once; whoever is flung past that lands on its feet."""
    room = max(1, int(len(world.goblins) * DAZED_SHARE))
    return sum(1 for o in world.goblins if o.state == 'dazed') < room


def _start_stroll(world, g):
    p = g.platform
    if p is None:
        return False
    left, right = g.x - p.x0, p.x1 - g.x
    at_edge = min(left, right) <= EDGE + 1
    g.facing = 1 if (left < right) == at_edge else -1
    return True


def _start_sit(world, g):
    """Only at a window's end, where the legs can hang over the side."""
    p = g.platform
    if p is None or p.kind != 'window':
        return False
    if g.x - p.x0 <= EDGE + 1 and _open_end(world, p.x0):
        g.x, g.facing = p.x0, -1
    elif p.x1 - g.x <= EDGE + 1 and _open_end(world, p.x1):
        g.x, g.facing = p.x1, 1
    else:
        return False
    return True


def _start_walkoff(world, g):
    p = g.platform
    if p is None:
        return False
    g.facing = -1 if g.x - p.x0 < p.x1 - g.x else 1
    return True


def _start_scatter(world, g):
    return g.spot is not None and g.platform is not None


START = {  # state -> hook run on entry; returning False sends the goblin to the row's `fail`
    'run': _start_run, 'sprint': _start_run, 'look': _start_look, 'hop': _start_hop,
    'chase': _start_chase, 'stack': _start_stack, 'mount': _start_mount, 'wrestle': _start_wrestle,
    'bump': _start_bump, 'dazed': _start_dazed, 'stroll': _start_stroll, 'sit': _start_sit,
    'walkoff': _start_walkoff, 'scatter': _start_scatter,
}


def check_tables(motions, starts):
    """Fail at import, not mid-show, when a row names something that does not exist."""
    for context, table in TRANSITIONS.items():
        assert '*' in table, context
        for state, options in table.items():
            assert state == '*' or state in BEHAVIORS, (context, state)
            for o in options:
                assert o.state in BEHAVIORS and o.weight > 0, (context, state, o.state)
                assert not o.trait or o.trait in Personality._fields, (context, state, o.trait)
    for name, b in BEHAVIORS.items():
        assert b.anim in ANIMS and b.motion in motions and b.edge in EDGES, name
        assert b.fail in BEHAVIORS and b.lands in BEHAVIORS, name
        seen = {name}
        while name in starts:  # a refused start must end at a state that never refuses
            name = BEHAVIORS[name].fail
            assert name not in seen, seen
            seen.add(name)
    for name, anim in ANIMS.items():
        assert max(anim.seq) < ACTION_FRAMES[anim.action], name
    for name, kind in EFFECTS.items():
        assert kind.pop in ('coin', 'hit', 'crit', 'alert', 'dust', 'star', 'banner'), name
    assert set(starts) <= set(BEHAVIORS), set(starts) - set(BEHAVIORS)
