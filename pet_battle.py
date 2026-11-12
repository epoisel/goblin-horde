"""The boss fight of the pet world: a boss walks in, the horde swarms it, and it falls or leaves.

Standard library only, no Tk. The outcome is settled before the show starts, so nothing here
decides it: the tables stage it. Show lengths, health curves, boss beats and phases are data,
and the functions under them carry out one row. Lengths are sprite pixels, as in `pet_behaviors`.
"""
import bisect
import math
from typing import NamedTuple

from pet_behaviors import GOBLIN_H, INF, BossDraw, run_to
from pet_boss import boss_profile

BOSS_COUNT = 36
BOSS_LANE = 3.0       # the boss stands mid-depth on the ground
BOSS_ROOM = 0.75      # body widths kept behind the boss, past its height, so it falls on screen
STRIDE = 0.31         # body heights between footfalls
PROWL = 0.3           # body heights it shifts when it lumbers
ALERT_CHANCE = 0.12
CLING_DENSITY = 0.3   # share of the silhouette climbers may cover
CLIMB_SPEED = 62.0
WAVES = 4
WAVE_GAP = 0.6
CHARGE_SHARE = 0.125  # of the horde at the boss before the charge counts as a swarm
FLEE_MARGIN = 130.0   # how far past the danger a goblin still runs from it
HIT_EVERY = 0.5
HIT_POP_EVERY = 0.3
DOWN_TIME = 3.0       # a beaten boss lies there this long
BLINK_TIME = 0.7      # and blinks out over the last of it,
BLINK_RATE = 14.0     # this many flickers a second
COINS = 30
MARGIN = 6.0          # ground left clear at each screen edge
FIGHT_PHASES = ('charge', 'swarm')


class Show(NamedTuple):
    ratio: float   # plays when the horde's power ratio is at least this
    swarm: float   # seconds the horde is on the boss
    curve: str     # HP_CURVES row
    beats: tuple   # boss states, looped while it stands its ground
    shed: float    # share of its climbers a roar shakes off
    knock: float   # share of the goblins at its feet a stomp flings


WIN_SHOWS = (  # first row the ratio reaches: a walkover is short, a close call long
    Show(3.0, 8.0, 'crumble', ('stand', 'roar', 'stand', 'stomp'), 0.2, 0.1),
    Show(1.5, 14.0, 'steady', ('stand', 'stomp', 'stand', 'roar', 'lumber'), 0.35, 0.18),
    Show(0.0, 19.0, 'grind', ('stomp', 'stand', 'roar', 'lumber', 'stand'), 0.5, 0.25),
)
LOSS_SHOWS = (
    Show(0.7, 18.0, 'stall', ('stand', 'stomp', 'roar', 'lumber', 'stomp'), 0.55, 0.25),
    Show(0.35, 13.0, 'stall', ('stomp', 'stand', 'roar', 'lumber'), 0.65, 0.3),
    Show(0.0, 8.0, 'bounce', ('stomp', 'roar', 'stand'), 0.8, 0.4),
)
HP_CURVES = {  # (share of the swarm gone, share of the damage dealt), rising to (1, 1)
    'crumble': ((0.0, 0.0), (0.3, 0.5), (0.7, 0.85), (1.0, 1.0)),
    'steady': ((0.0, 0.0), (0.2, 0.12), (0.8, 0.8), (1.0, 1.0)),
    'grind': ((0.0, 0.0), (0.35, 0.15), (0.7, 0.45), (0.9, 0.75), (1.0, 1.0)),
    'stall': ((0.0, 0.0), (0.3, 0.55), (0.6, 0.85), (1.0, 1.0)),
    'bounce': ((0.0, 0.0), (0.4, 0.8), (1.0, 1.0)),
}


class BossState(NamedTuple):
    pose: str            # sprite pose: stand | walk | stomp | roar | hurt | fall
    frame: str           # FRAME_RULES row
    dur: float = INF
    next: str = ''       # '' takes the next beat of the show
    at: float = INF      # seconds in, when `effect` fires
    effect: str = ''
    shake: float = 0.0   # sway in pixels while it lasts
    lean: float = 0.0    # how far the head leans toward the face at the peak, in body heights
    dip: float = 0.0     # how far the body sinks at the peak, in body heights
    walks: float = 0.0   # body heights per second toward its aim
    aim: str = ''        # AIMS row
    turns: bool = False  # faces the way it walks
    holds: bool = True   # climbers can stay on


BOSS_STATES = {
    'walk': BossState('walk', 'stride', next='arrive', dip=0.012, walks=0.6, aim='home'),
    'arrive': BossState('roar', 'strike', 1.3, at=0.35, effect='announce', shake=2.0, lean=0.04),
    'stand': BossState('stand', 'clock', 1.3),
    'stomp': BossState('stomp', 'strike', 0.8, at=0.4, effect='stomp', dip=0.03),
    'roar': BossState('roar', 'strike', 1.3, at=0.35, effect='shake_off', shake=2.0, lean=0.04),
    'lumber': BossState('walk', 'stride', dip=0.012, walks=0.3, aim='prowl'),
    'flinch': BossState('hurt', 'hold', 0.35, shake=2.0, lean=-0.03),
    'stagger': BossState('hurt', 'hold', 0.9, next='fall', shake=3.0, lean=-0.05),
    'fall': BossState('fall', 'tip', 0.55, next='down', at=0.5, effect='crash', holds=False),
    'down': BossState('fall', 'flat', holds=False),
    'bellow': BossState('roar', 'strike', 1.4, next='leave', at=0.4, effect='shockwave', shake=3.0, lean=0.05),
    'leave': BossState('walk', 'stride', next='gone', dip=0.012, walks=0.75, aim='out', turns=True,
                       holds=False),
    'gone': BossState('walk', 'hold', holds=False),
}
BOSS_FRAMES = {'stand': 2, 'walk': 4, 'stomp': 2, 'roar': 2, 'hurt': 1, 'fall': 3}
FRAME_RULES = {  # rule -> (frames it needs of its pose, which one to show)
    'clock': (2, lambda boss, spec: int(boss.clock * 1.6) % 2),
    'stride': (4, lambda boss, spec: int(2.0 * boss.walked / (STRIDE * boss.h)) % 4),
    'strike': (2, lambda boss, spec: 1 if boss.fired else 0),
    'hold': (1, lambda boss, spec: 0),
    'tip': (3, lambda boss, spec: min(2, int(3.0 * boss.timer / spec.dur))),
    'flat': (3, lambda boss, spec: 2),
}


class Boss:
    __slots__ = ('x', 'y', 'h', 'heights', 'widths', 'reach', 'mouth', 'facing', 'home', 'out', 'goal',
                 'state', 'timer', 'clock', 'fired', 'walked', 'hp', 'tenths', 'flash', 'sway', 'lean', 'dip')


class Battle:
    __slots__ = ('index', 'name', 'won', 'end', 'show', 'boss', 'phase', 'clock', 'beat', 'began',
                 'blows', 'pop_at', 'room', 'attached', 'counted', 'over')


def _boss(world):
    battle = world.battle
    return battle.boss if battle is not None else None


def _half_at(boss, v):
    """The half width, in body heights, a climber may use at height `v`: the profile's slices joined up."""
    heights, widths = boss.heights, boss.widths
    n = bisect.bisect_right(heights, v)
    if n == 0 or n == len(heights):
        return widths[max(0, n - 1)]
    return widths[n - 1] + (widths[n] - widths[n - 1]) * (v - heights[n - 1]) / (heights[n] - heights[n - 1])


def _dealt(curve, t):
    """Share of the damage dealt once share `t` of the swarm has gone."""
    points = HP_CURVES[curve]
    for (t0, d0), (t1, d1) in zip(points, points[1:]):
        if t <= t1:
            return d0 + (d1 - d0) * (t - t0) / (t1 - t0)
    return 1.0


def end_hp(won, ratio):
    """The health a fight ends on: none for a win, and more the worse the horde was outmatched."""
    return 0.0 if won else min(max(1.0 - ratio, 0.1), 0.9)


def begin(world, side, index, won, ratio):
    """Bring boss `index` on from `side` and hand the world's horde to the phase machine."""
    index = min(max(int(index), 0), BOSS_COUNT - 1)
    ratio = float(ratio)
    if not 0.0 <= ratio < INF:
        ratio = 1.0
    profile = boss_profile(index)
    came = side if side in ('left', 'right') else world.rng.choice(('left', 'right'))
    boss = Boss()
    boss.h = profile.height_goblins * GOBLIN_H
    boss.heights, boss.widths = zip(*sorted(profile.slices))
    boss.reach = max(boss.widths) * boss.h
    boss.mouth = (profile.mouth[0] * boss.h, profile.mouth[1] * boss.h)
    inset = min(boss.h + 2.0 * boss.reach * BOSS_ROOM, world.width * 0.6)
    inset = max(inset, min(boss.reach, world.width / 2))
    boss.facing = 1 if came == 'left' else -1
    boss.home = inset if came == 'left' else world.width - inset
    boss.x = boss.out = -boss.reach if came == 'left' else world.width + boss.reach
    boss.y = world.floor + BOSS_LANE
    boss.hp, boss.tenths = 1.0, 10
    boss.clock = boss.flash = boss.sway = boss.walked = 0.0
    battle = Battle()
    battle.index, battle.name, battle.boss = index, profile.name, boss
    battle.won = bool(won)
    battle.end = end_hp(battle.won, ratio)
    battle.show = next(s for s in (WIN_SHOWS if battle.won else LOSS_SHOWS) if ratio >= s.ratio)
    battle.beat, battle.began, battle.pop_at, battle.counted = -1, world.clock, 0.0, -1.0
    battle.blows = battle.attached = 0
    battle.over = False
    area = 2.0 * sum(boss.widths) / len(boss.widths) * boss.h * boss.h
    battle.room = max(2, int(CLING_DENSITY * area / (GOBLIN_H * 8.0)))
    world.battle = battle
    _pose(world, battle, 'walk')
    _go(world, battle, 'enter')


def _aim_prowl(world, boss):
    """A few steps toward the horde, and back home the next time."""
    if abs(boss.x - boss.home) > 1.0:
        return boss.home
    edge = boss.reach + MARGIN
    return min(max(boss.home + boss.facing * PROWL * boss.h, edge), max(edge, world.width - edge))


AIMS = {
    'home': lambda world, boss: boss.home,
    'prowl': _aim_prowl,
    'out': lambda world, boss: boss.out,
}


def _pose(world, battle, state):
    """Put the boss in `state`; a walking state picks where it is heading."""
    boss, spec = battle.boss, BOSS_STATES[state]
    boss.state, boss.timer, boss.fired = state, 0.0, False
    boss.lean = boss.dip = 0.0
    if spec.aim:
        boss.goal = AIMS[spec.aim](world, boss)
        if spec.turns:
            boss.facing = 1 if boss.goal >= boss.x else -1


def _next_pose(world, battle, spec):
    state = spec.next
    if not state:
        battle.beat += 1
        state = battle.show.beats[battle.beat % len(battle.show.beats)]
    _pose(world, battle, state)


def _boss_step(world, battle, dt):
    boss = battle.boss
    spec = BOSS_STATES[boss.state]
    boss.clock += dt
    boss.timer += dt
    boss.flash = max(0.0, boss.flash - dt)
    boss.sway = spec.shake * math.sin(boss.clock * 55.0)
    if spec.walks:
        gap = boss.goal - boss.x
        pace = spec.walks * boss.h * dt
        if abs(gap) <= pace:
            boss.x = boss.goal
            _next_pose(world, battle, spec)
            return
        boss.x += math.copysign(pace, gap)
        stride = STRIDE * boss.h
        before, boss.walked = boss.walked, boss.walked + pace
        boss.dip = spec.dip * abs(math.sin(math.pi * boss.walked / stride))
        if before // stride != boss.walked // stride:
            _fx_step(world, battle, 1 if gap > 0 else -1)
        return
    if spec.dur != INF:
        swell = math.sin(math.pi * min(1.0, boss.timer / spec.dur))
        boss.lean, boss.dip = spec.lean * swell, spec.dip * swell
    if not boss.fired and boss.timer >= spec.at:
        boss.fired = True
        BOSS_EFFECTS[spec.effect](world, battle)
    if boss.timer >= spec.dur:
        _next_pose(world, battle, spec)


def _knock(world, x0, x1, push, chance, power=1.0):
    """Fling goblins standing on the ground between x0 and x1; push 0 scatters them outward."""
    rng = world.rng
    mid = (x0 + x1) / 2
    for g in world.goblins:
        if g.grounded and g.platform.kind == 'ground' and x0 <= g.x <= x1 and rng.random() < chance:
            side = push or (1 if g.x >= mid else -1)
            world.throw(g, 'flung', side * power * rng.uniform(50, 150), -power * rng.uniform(130, 260))


def _shed(world, chance, below=1.0):
    """The boss shakes: climbers at or under height `below` may be flung off."""
    rng = world.rng
    for g in world.goblins:
        if g.move in ON_BOSS and g.v <= below and rng.random() < chance:
            side = 1 if rng.random() < 0.5 else -1
            world.throw(g, 'flung', side * rng.uniform(40, 170), -rng.uniform(90, 250))


def _fx_step(world, battle, heading):
    boss = battle.boss
    world.quake = max(world.quake, 1.5)
    lead = boss.x + heading * boss.reach * 0.4
    chance = 0.9 if battle.phase == 'enter' else battle.show.knock
    _knock(world, lead - boss.reach * 0.6, lead + boss.reach * 0.6, heading, chance)
    world.dust(lead, 3)


def _breath(world, boss, puffs):
    """A roar is seen as well as heard: dust blown out of the mouth."""
    rng = world.rng
    x, y = boss.x + boss.facing * boss.mouth[0], boss.y - boss.mouth[1]
    for _ in range(puffs):
        world.effect('dust', x, y + rng.uniform(-3, 3), boss.facing * rng.uniform(60, 160), rng.uniform(-25, 25))


def _fx_announce(world, battle):
    boss = battle.boss
    world.quake = max(world.quake, 2.5)
    _breath(world, boss, 6)
    world.effect('banner', boss.x, boss.y - boss.h - 10.0, 0.0, -6.0, battle.name)


def _fx_stomp(world, battle):
    boss = battle.boss
    world.quake = max(world.quake, 4.0)
    _knock(world, boss.x - boss.reach - 24.0, boss.x + boss.reach + 24.0, 0, battle.show.knock)
    _shed(world, 0.35, below=0.3)
    world.dust(boss.x + boss.facing * boss.reach * 0.4, 6)


def _fx_shake_off(world, battle):
    world.quake = max(world.quake, 2.5)
    _breath(world, battle.boss, 6)
    _shed(world, battle.show.shed)


def _fx_crash(world, battle):
    boss, rng = battle.boss, world.rng
    world.quake = max(world.quake, 7.0)
    head = boss.x - boss.facing * boss.h
    x0, x1 = min(boss.x, head), max(boss.x, head)
    _knock(world, x0, x1, 0, 0.7)
    world.dust((x0 + x1) / 2, 10, (x1 - x0) / 2)
    for _ in range(COINS + 2 * battle.index):
        world.effect('coin', rng.uniform(x0, x1), boss.y - rng.uniform(4.0, boss.reach),
                     rng.uniform(-110, 110), -rng.uniform(140, 330))
    world.rouse(lambda g: rng.random() * 0.5)


def _fx_shockwave(world, battle):
    boss, rng = battle.boss, world.rng
    world.quake = max(world.quake, 6.0)
    _breath(world, boss, 10)
    _shed(world, 1.0)
    wide = boss.reach + boss.h
    _knock(world, boss.x - wide, boss.x + wide, 0, 0.85, 1.5)
    world.dust(boss.x, 12, wide * 0.6)
    world.rouse(lambda g: rng.random() * 0.5)


BOSS_EFFECTS = {'announce': _fx_announce, 'stomp': _fx_stomp, 'shake_off': _fx_shake_off,
                'crash': _fx_crash, 'shockwave': _fx_shockwave}


def _enter_start(world, battle):
    boss, rng = battle.boss, world.rng
    world.rouse(lambda g: 0.05 + abs(g.x - boss.x) / 900.0 + rng.random() * 0.35)


def _enter_done(world, battle):
    return battle.boss.state != 'walk'


def _charge_start(world, battle):
    ranked = sorted(world.goblins, key=lambda g: -g.personality.brave)
    for rank, g in enumerate(ranked):
        g.wave = rank * WAVES // len(ranked)
    battle.began = world.clock
    world.rouse(lambda g: world.rng.random() * 0.25)


def _charge_done(world, battle):
    at_it = sum(1 for g in world.goblins if g.behavior.hits or g.move in ON_BOSS)
    return at_it > len(world.goblins) * CHARGE_SHARE


def _swarm_start(world, battle):
    pass


def _swarm_done(world, battle):
    return battle.clock >= battle.show.swarm


def _finish_start(world, battle):
    _pose(world, battle, 'stagger')
    world.rouse(lambda g: world.rng.random() * 0.45)


def _finish_done(world, battle):
    return battle.boss.state == 'down' and battle.boss.timer >= DOWN_TIME


def _rout_start(world, battle):
    _pose(world, battle, 'bellow')


def _rout_done(world, battle):
    return battle.boss.state == 'gone'


def _disperse_start(world, battle):
    """The fight is over: every goblin on the ground gets its own stretch of it to run to."""
    battle.boss, battle.over = None, True
    world.events.append(('battle_over', {'won': battle.won, 'boss': battle.index}))
    rng = world.rng
    crowd = sorted((g for g in world.goblins
                    if g is not world.held and (g.platform is None or g.platform.kind == 'ground')),
                   key=lambda g: g.x)
    span = world.width - 2.0 * MARGIN
    for rank, g in enumerate(crowd):  # in standing order, so nobody has to cross anybody
        g.spot = MARGIN + span * (rank + rng.uniform(0.2, 0.8)) / len(crowd)
    world.rouse(lambda g: rng.random() * 0.8)


def _disperse_done(world, battle):
    return all(g.spot is None for g in world.goblins)


class Phase(NamedTuple):
    start: object
    done: object
    next: tuple   # the phase after it, (on a loss, on a win); '' hands the horde back to roaming
    limit: float  # seconds it may last, whatever `done` says


PHASES = {
    'enter': Phase(_enter_start, _enter_done, ('charge', 'charge'), 9.0),
    'charge': Phase(_charge_start, _charge_done, ('swarm', 'swarm'), 5.0),
    'swarm': Phase(_swarm_start, _swarm_done, ('rout', 'finish'), 30.0),
    'finish': Phase(_finish_start, _finish_done, ('disperse', 'disperse'), 6.0),
    'rout': Phase(_rout_start, _rout_done, ('disperse', 'disperse'), 8.0),
    'disperse': Phase(_disperse_start, _disperse_done, ('', ''), 9.0),
}


def _go(world, battle, name):
    if not name:
        world.battle = None
        world.events.append(('phase', 'roam'))
        return
    battle.phase, battle.clock = name, 0.0
    world.events.append(('phase', name))
    PHASES[name].start(world, battle)


def _wear_down(world, battle):
    """Health follows the show's curve; the blows goblins land only pace the numbers that pop."""
    boss, show = battle.boss, battle.show
    t = battle.clock / show.swarm
    boss.hp = battle.end if t >= 1.0 else 1.0 - (1.0 - battle.end) * _dealt(show.curve, t)
    tenths = math.ceil(10.0 * boss.hp)
    if tenths < boss.tenths:
        boss.tenths, boss.flash = tenths, 0.12
        if boss.state == 'stand':
            _pose(world, battle, 'flinch')
    if battle.blows and world.clock >= battle.pop_at:
        rng = world.rng
        world.effect('hit', boss.x + rng.uniform(-0.6, 0.6) * boss.reach,
                     boss.y - rng.uniform(0.45, 1.0) * boss.h, 0.0, -26.0, '-%d' % battle.blows)
        world.events.append(('hit', battle.blows))
        battle.blows = 0
        battle.pop_at = world.clock + HIT_POP_EVERY


def step(world, dt):
    """Advance the fight: the boss's beat, its health, then the phase machine."""
    battle = world.battle
    battle.clock += dt
    if battle.boss is not None:
        battle.boss.y = world.floor + BOSS_LANE
        _boss_step(world, battle, dt)
        if battle.phase == 'swarm':
            _wear_down(world, battle)
    phase = PHASES[battle.phase]
    if phase.done(world, battle) or battle.clock >= phase.limit:
        _go(world, battle, phase.next[battle.won])


def strike(world, g):
    """One blow from a goblin in a hitting state; it counts only within reach of the boss."""
    battle, rng = world.battle, world.rng
    g.hit = HIT_EVERY * rng.uniform(0.7, 1.3)
    if abs(g.x - battle.boss.x) > battle.boss.reach + 30.0:
        return
    battle.blows += 1
    if rng.random() < 0.3:
        world.effect('spark', g.x + g.facing * 4.0, g.y - 6.0 - rng.random() * 4.0)


def boss_draw(battle, unit):
    """The boss as the view draws it, or None once it is gone or while a beaten one blinks out."""
    boss = battle.boss
    if boss is None:
        return None
    spec = BOSS_STATES[boss.state]
    if boss.state == 'down' and boss.timer > DOWN_TIME - BLINK_TIME and int(boss.timer * BLINK_RATE) % 2:
        return None
    frame = FRAME_RULES[spec.frame][1](boss, spec)
    return BossDraw(battle.index, spec.pose, frame, (boss.x + boss.sway) * unit, boss.y * unit,
                    boss.facing < 0, boss.flash > 0.0, boss.hp, boss.h * unit)


def _storm(world, g, dt):
    boss = _boss(world)
    if boss is None or run_to(world, g, dt, boss.x + g.goal):
        world.advance(g)


def _grip(world, g):
    """Pin a climber to its spot on the boss's body, wherever the body has gone; None if it lost hold."""
    boss = _boss(world)
    if boss is None or not BOSS_STATES[boss.state].holds:
        world.enter(g, 'leap')
        return None
    v = g.v
    g.x = boss.x + boss.sway + boss.facing * (g.u + boss.lean * v) * boss.h
    g.y = boss.y - (v - boss.dip * min(1.0, 3.0 * v)) * boss.h
    return boss


def _scale(world, g, dt):
    boss = _grip(world, g)
    if boss is None:
        return
    du, dv = (g.tu - g.u) * boss.h, (g.tv - g.v) * boss.h
    gap = math.hypot(du, dv)
    reach = CLIMB_SPEED * dt
    if gap <= reach:
        g.u, g.v = g.tu, g.tv
        world.advance(g)
        return
    g.v += dv / gap * reach / boss.h
    half = _half_at(boss, g.v)
    g.u = min(max(g.u + du / gap * reach / boss.h, -half), half)


def _cling(world, g, dt):
    _grip(world, g)


ON_BOSS = (_scale, _cling)


def _start_leap(world, g):
    rng = world.rng
    boss = _boss(world)
    away = 1 if boss is None or g.x >= boss.x else -1
    g.vx = away * rng.uniform(40, 120)
    g.vy = -rng.uniform(110, 200)
    world.lift(g)
    return True


def _start_gawk(world, g):
    boss = _boss(world)
    if boss is not None:
        g.facing = 1 if boss.x >= g.x else -1
        if world.battle.phase == 'enter' and world.rng.random() < ALERT_CHANCE:
            world.effect('alert', g.x, g.y - GOBLIN_H - 5.0, 0.0, -10.0)
    return True


def _start_flee(world, g):
    boss = _boss(world)
    if boss is None or not g.grounded:
        return False
    danger = boss.x
    if boss.hp <= 0.0:
        danger -= boss.facing * boss.h * 0.5  # the middle of where it will land
    if abs(g.x - danger) > 0.5 * boss.h + FLEE_MARGIN:
        return False
    g.facing = 1 if g.x >= danger else -1
    return True


def _start_charge(world, g):
    battle, boss = world.battle, _boss(world)
    if boss is None or g.platform is None or world.clock - battle.began < g.wave * WAVE_GAP:
        return False
    g.goal = world.rng.uniform(-1.0, 1.0) * (boss.reach + 22.0)
    return True


def _start_climb(world, g):
    battle, boss = world.battle, _boss(world)
    if boss is None or boss.hp <= 0.0 or not BOSS_STATES[boss.state].holds:
        return False
    rng = world.rng
    if g.move not in ON_BOSS:
        if battle.counted != world.clock:  # one count a tick, however many ask
            battle.counted = world.clock
            battle.attached = sum(1 for o in world.goblins if o.move in ON_BOSS)
        if battle.attached >= battle.room:
            return False
        battle.attached += 1
        foot = boss.widths[0]
        g.u = min(max((g.x - boss.x) / (boss.facing * boss.h), -foot), foot)
        g.v = 0.0
        world.lift(g)
    g.tv = rng.uniform(0.12, 0.96)
    half = _half_at(boss, g.tv)
    g.tu = rng.uniform(-half, half)
    g.facing = 1 if boss.facing * (g.tu - g.u) >= 0 else -1
    return True


def _face_boss(world, g):
    boss = _boss(world)
    if boss is not None:
        g.facing = 1 if boss.x >= g.x else -1
    return True


MOTIONS = {'storm': _storm, 'scale': _scale, 'cling': _cling}
START = {'leap': _start_leap, 'gawk': _start_gawk, 'flee': _start_flee, 'charge': _start_charge,
         'climb': _start_climb, 'cling': _face_boss, 'brawl': _face_boss}


def check_tables():
    """Fail at import when a boss row names something that does not exist."""
    for name, spec in BOSS_STATES.items():
        assert FRAME_RULES[spec.frame][0] <= BOSS_FRAMES[spec.pose], name
        assert not spec.next or spec.next in BOSS_STATES, name
        assert not spec.effect or spec.effect in BOSS_EFFECTS, name
        assert bool(spec.walks) == bool(spec.aim) and (not spec.aim or spec.aim in AIMS), name
    for show in WIN_SHOWS + LOSS_SHOWS:
        assert show.curve in HP_CURVES and all(beat in BOSS_STATES for beat in show.beats), show
        assert show.swarm < PHASES['swarm'].limit, show
    assert WIN_SHOWS[-1].ratio == 0.0 and LOSS_SHOWS[-1].ratio == 0.0
    for name, points in HP_CURVES.items():
        assert points[0] == (0.0, 0.0) and points[-1] == (1.0, 1.0), name
        assert all(a[0] < b[0] and a[1] <= b[1] for a, b in zip(points, points[1:])), name
    for name, phase in PHASES.items():
        assert all(not n or n in PHASES for n in phase.next), name


check_tables()
