"""The pet world of one monitor: goblins on the taskbar and on window tops, and a boss when one comes.

Standard library only, no Tk. Screen pixels go in and come out; inside, everything is sprite
pixels (screen pixels / unit), so the tables in `pet_behaviors` and `pet_battle` hold at any
scale. The view feeds it window tops and the cursor, calls `step`, and draws `frame`. The cursor is a
hand: it carries one goblin or a handful, and a goblin it lets go over a boss lands on it.
"""
import math
import random
from typing import NamedTuple

import pet_battle
import pet_behaviors
from pet_behaviors import (ANIMS, BEHAVIORS, EDGE, EFFECTS, FRAME_PICK, GOBLIN_H, IDLERS, INF, LANES,
                           NEEDS_FOOTING, RUN_SPEED, SIGHT, STACKED, THROW_MAX, TRANSITIONS, BossDraw,
                           Draw, Frame, Goblin, Pop, free, personality_for)
from pet_platform import WINDOW

__all__ = ('World', 'Frame', 'Draw', 'BossDraw', 'Pop')

MOTIONS = {**pet_behaviors.MOTIONS, **pet_battle.MOTIONS}
START = {**pet_behaviors.START, **pet_battle.START}
pet_behaviors.check_tables(MOTIONS, START)

MAX_STEP = 0.1        # seconds one step may cover: a view that stalled does not replay the stall
MIN_PLATFORM = 24.0   # screen pixels; a narrower window top is no place to stand
CLEARANCE = 14.0      # a window top this close to the ground is not a second floor
SLIP = 0.01           # rounding a goblin at the very end of a moved window top is allowed
SEPARATION = 4.0
SEPARATION_PUSH = 0.3
BOUNCE_RATE = 11.0
GRAB_HALF = 6.0       # half width of the box a cursor grabs a goblin by
GRAB_REACH = 60.0     # how far from that goblin a hand that carries more gathers the rest
# Where each goblin of a handful hangs from the cursor, the first one grabbed first. Its length is
# the most a hand can carry.
HANG = ((0.0, 0.0), (-8.0, 2.0), (8.0, 2.0), (-15.0, 6.0), (15.0, 6.0), (-5.0, 9.0), (5.0, 9.0),
        (0.0, 15.0))
THROW_SPREAD = 0.12   # how far the speeds of a handful let go differ, so it fans out
FADE_RATE = 3.0       # alpha per second, arriving and leaving
MAX_EFFECTS = 320
CHEER_CROWD = 7
REWARD_COINS = 3
EXCITE_SPEED = 0.8    # extra run speed at full excitement
EXCITE_ENERGY = 2.0   # extra pull of moving states at full excitement
EXCITE_FADE = 6.0     # seconds for excitement to fall to about a third
QUAKE_FADE = 4.9
SPAWN_MARGIN = 8.0


class Surface(NamedTuple):
    """A platform in sprite pixels. `ox` is the window's own left edge, which its riders follow."""
    x0: float
    x1: float
    y: float
    kind: str
    key: object
    ox: float
    n: int  # place in the world's list, so one sort groups each platform's goblins


class Effect:
    __slots__ = ('kind', 'x', 'y', 'vx', 'vy', 'age', 'ttl', 'text')


def _spot(g):
    return g.platform.n * 1e6 + g.x


def _layer(g):
    """Draw order: nearer lanes in front, and a rider just in front of whoever carries it."""
    up = 0
    while g.carrier is not None:
        g = g.carrier
        up += 1
    return g.lane + 0.5 * up


def _pull(option, person, lively):
    """How strongly one choice draws this goblin; excitement adds to the pull of moving states."""
    if not option.trait:
        return option.weight
    pull = option.weight * getattr(person, option.trait)
    return pull * lively if option.trait == 'energy' else pull


def _draw(g, unit):
    behavior = g.behavior
    anim = ANIMS[behavior.anim]
    pick = FRAME_PICK.get(behavior.anim)
    index = pick(g) if pick else anim.seq[int(g.clock * anim.fps * g.tempo) % len(anim.seq)]
    y = g.y
    if behavior.bounce:
        y -= behavior.bounce * abs(math.sin(g.clock * BOUNCE_RATE))
    return Draw(g.id, anim.action, index, g.x * unit, y * unit, g.facing < 0, g.alpha, 1.0)


class World:
    """Goblins, platforms and at most one boss fight, stepped by the view and read back as a Frame.

    Screen pixels are measured from the world's top left corner. The view calls `resize`,
    `set_horde`, `set_platforms`, `keep_clear`, `grab`, `move_grabbed`, `drop`, `goblin_at`,
    `reward`, `stir`, `start_battle`, `step`, `frame`, `battling` and `shown`; the other methods without an
    underscore are what the behaviour and battle rows work through. The crowd has depth: feet
    rest up to LANES - 1 sprite pixels below `ground_y`, so the view draws that far past the line.
    """

    def __init__(self, width, height, ground_y, unit=2, seed=None, cap=150):
        self.unit = max(1.0, float(unit))
        self.cap = max(0, int(cap))
        self.rng = random.Random(seed)
        self.goblins = []
        self.leaving = []
        self.effects = []
        self.events = []
        self.battle = None
        self.held = []
        self.hand = (0.0, 0.0)
        self.wings = (0.0, 0.0)
        self.clock = self.quake = self.excite = 0.0
        self.haste = 1.0
        self.floor = 0.0
        self._tops = ()
        self.resize(width, height, ground_y)

    @property
    def shown(self):
        """How many goblins are in the horde on screen."""
        return len(self.goblins)

    @property
    def battling(self):
        """True from `start_battle` until that fight's `battle_over` event."""
        return self.battle is not None and not self.battle.over

    def resize(self, width, height, ground_y):
        """Fit a new work area; everyone keeps their height above the taskbar as it moves."""
        unit, old_floor = self.unit, self.floor
        self.width = max(4.0 * EDGE, width / unit)
        self.height = max(2.0 * GOBLIN_H, height / unit)
        self.floor = min(max(ground_y / unit, 2.0 * GOBLIN_H), self.height)
        self.ground = Surface(0.0, self.width, self.floor, 'ground', '', 0.0, 0)
        for g in self.goblins:
            g.x, g.y = min(g.x, self.width - EDGE), g.y + self.floor - old_floor
        self._lay()

    def set_horde(self, size):
        """Show min(size, cap) goblins, ids from 0. An empty world fills in place; later arrivals
        drop in from a screen edge with a cheer, and the highest ids fade out when it shrinks."""
        want = max(0, min(int(size), self.cap))
        have = len(self.goblins)
        self.leaving = [g for g in self.leaving if g.id >= want]
        if want < have:
            self.leaving += self.goblins[want:]
            del self.goblins[want:]
            self.held = [g for g in self.held if g.id < want]
            for g in self.goblins:
                for link in ('target', 'carrier', 'rider'):
                    other = getattr(g, link)
                    if other is not None and other.id >= want:
                        setattr(g, link, None)
        for _ in range(have, want):
            self._spawn(settled=not have)

    def set_platforms(self, platforms):
        """This tick's window tops, as `pet_platform.Platform`s. A goblin on a top that moved rides
        along; on one that left, or under a window that now covers its spot, it falls."""
        tops = tuple((p.x0, p.x1, p.y, p.key, p.origin[0]) for p in platforms if p.kind == WINDOW)
        if tops != self._tops:
            self._tops = tops
            self._lay()

    def keep_clear(self, left=0.0, right=0.0):
        """Screen pixels at each end of the ground that the view covers with things of its own. The
        next boss stands, and falls, clear of them."""
        self.wings = (max(0.0, left) / self.unit, max(0.0, right) / self.unit)

    def grab(self, goblin_id, most=1):
        """Pick a goblin up by the scruff, and its nearest neighbours with it, `most` in all and never
        more than HANG has places. They hang from the cursor until `drop`. False for no such id."""
        if not 0 <= goblin_id < len(self.goblins):
            return False
        self.drop()
        first = self.goblins[goblin_id]
        near = sorted((g for g in self.goblins if g is not first
                       and abs(g.x - first.x) <= GRAB_REACH and abs(g.y - first.y) <= GRAB_REACH),
                      key=lambda g: abs(g.x - first.x) + abs(g.y - first.y))
        self.hand = (first.x, first.y - GOBLIN_H)
        for g, hang in zip([first] + near, HANG[:max(1, int(most))]):
            self.lift(g)
            g.vx = g.vy = 0.0
            g.hang = hang
            self.enter(g, 'held')
            self.held.append(g)
        return True

    def move_grabbed(self, x, y):
        """Move the cursor that holds the scruff, in screen pixels; the body hangs below it."""
        if math.isfinite(x) and math.isfinite(y):
            self.hand = (min(max(x / self.unit, EDGE), self.width - EDGE),
                         min(max(y / self.unit, 0.0), self.floor - GOBLIN_H))

    def drop(self):
        """Let go: each goblin keeps the cursor's speed, up to a limit, and falls to what is below,
        or onto a boss in its way."""
        held, self.held = self.held, []
        for g in held:
            speed = math.hypot(g.vx, g.vy)
            if speed > THROW_MAX:
                g.vx, g.vy = g.vx * THROW_MAX / speed, g.vy * THROW_MAX / speed
            if len(held) > 1:
                g.vx *= self.rng.uniform(1.0 - THROW_SPREAD, 1.0 + THROW_SPREAD)
                g.vy *= self.rng.uniform(1.0 - THROW_SPREAD, 1.0 + THROW_SPREAD)
            self.enter(g, 'thrown')

    def goblin_at(self, x, y):
        """The id of the goblin drawn on top at this screen point, or None."""
        px, py = x / self.unit, y / self.unit
        top = None
        for g in self.goblins:
            if abs(g.x - px) <= GRAB_HALF and g.y - GOBLIN_H - 2.0 <= py <= g.y + 1.0:
                if g in self.held:
                    return g.id
                if top is None or _layer(g) >= _layer(top):
                    top = g
        return top.id if top is not None else None

    def reward(self, coins, near=None):
        """A paid turn: "+N" and a few coins over one goblin, and its neighbours jump and cheer."""
        rng = self.rng
        if near is None or not math.isfinite(near):
            x = rng.uniform(0.15, 0.85) * self.width
        else:
            x = min(max(near / self.unit, 0.0), self.width)
        y = self.floor
        crowd = sorted((g for g in self.goblins if free(g) and g.platform.kind == 'ground'),
                       key=lambda g: abs(g.x - x))
        if crowd:
            x, y = crowd[0].x, crowd[0].y
        self.effect('gain', x, y - GOBLIN_H - 8.0, 0.0, -14.0, '+%d' % coins)
        for _ in range(REWARD_COINS):
            self.effect('coin', x, y - GOBLIN_H, rng.uniform(-45, 45), -rng.uniform(120, 190))
        for g in crowd[:CHEER_CROWD]:
            self.enter(g, 'cheer')
            g.timer = rng.uniform(0.9, 1.6)

    def stir(self, amount):
        """Excite the horde by 0..1: it runs faster and stands about less, and calms down again."""
        if not amount > 0.0:
            return
        self.excite = min(1.0, self.excite + amount)
        rng = self.rng
        for g in self.goblins:
            if g.state in IDLERS and rng.random() < amount:
                g.timer = min(g.timer, rng.random() * 0.4)

    def start_battle(self, side, boss, won, ratio):
        """Stage a fight whose outcome is already known: boss index `boss` walks in from `side`
        ('left', 'right' or None for either). False, and nothing happens, while one is still on."""
        if self.battling:
            return False
        pet_battle.begin(self, side, boss, won, ratio)
        return True

    def step(self, dt):
        """Advance dt seconds and return what happened since the last step as (name, detail) tuples:
        ('battle_over', {'won': bool, 'boss': int}), ('hit', blows) and ('phase', name)."""
        if not 0.0 < dt < INF:
            return []
        dt = min(dt, MAX_STEP)
        self.clock += dt
        self.excite *= math.exp(-dt / EXCITE_FADE)
        self.haste = 1.0 + EXCITE_SPEED * self.excite
        if self.battle is not None:
            pet_battle.step(self, dt)
        fighting = self.battle is not None and self.battle.phase in pet_battle.FIGHT_PHASES
        fade = FADE_RATE * dt
        for g in self.goblins:
            g.clock += dt * g.rate
            if g.alpha < 1.0:
                g.alpha = min(1.0, g.alpha + fade)
            g.move(self, g, dt)
            g.timer -= dt
            behavior = g.behavior
            if g.timer <= 0.0:
                if behavior.goal:
                    self.enter(g, behavior.fail)
                else:
                    self.advance(g)
            elif fighting and behavior.hits:
                g.hit -= dt
                if g.hit <= 0.0:
                    pet_battle.strike(self, g)
        self._separate()
        self._age(dt)
        self.quake *= math.exp(-QUAKE_FADE * dt)
        events, self.events = self.events, []
        return events

    def frame(self):
        """This instant as draw records in screen pixels, back to front. Changes nothing."""
        unit, held, battle = self.unit, self.held, self.battle
        draws = [_draw(g, unit) for g in self.leaving]
        draws += [_draw(g, unit) for g in sorted(self.goblins, key=_layer) if g not in held]
        draws += [_draw(g, unit) for g in reversed(held)]
        pops = tuple(Pop(EFFECTS[e.kind].pop, e.x * unit, e.y * unit, e.text, e.age, e.ttl)
                     for e in self.effects)
        boss = pet_battle.boss_draw(battle, unit) if battle is not None else None
        return Frame(tuple(draws), boss, pops, battle.phase if battle is not None else 'roam',
                     self.quake * unit)

    def context(self, g):
        """Which transition table a goblin reads: the fight's phase, its trip home, or its footing."""
        battle = self.battle
        if battle is not None and battle.phase != 'disperse':
            return pet_battle.context(self, g)
        if g.spot is not None:
            return 'disperse'
        return g.platform.kind if g.platform is not None else 'ground'

    def advance(self, g):
        """Choose a goblin's next state from its context's table, weighted by who it is."""
        table = TRANSITIONS[self.context(g)]
        options = table.get(g.state) or table['*']
        choice = options[0]
        if len(options) > 1:
            lively = 1.0 + EXCITE_ENERGY * self.excite
            pulls = [_pull(o, g.personality, lively) for o in options]
            choice = self.rng.choices(options, pulls)[0]
        self.enter(g, choice.state)

    def enter(self, g, state):
        """Put a goblin in `state`, or in the state its row falls back on when it cannot start."""
        hook = START.get(state)
        while hook is not None and not hook(self, g):
            state = BEHAVIORS[state].fail
            hook = START.get(state)
        if g.platform is None and BEHAVIORS[state].motion in NEEDS_FOOTING:
            state = 'fall'  # a rider or climber whose next state wants ground drops to find some
        behavior = BEHAVIORS[state]
        if g.carrier is not None and behavior.motion not in STACKED:
            if g.carrier.rider is g:
                g.carrier.rider = None
            g.carrier = None
        g.state, g.behavior, g.move = state, behavior, MOTIONS[behavior.motion]
        lo, hi = behavior.dur
        g.timer = lo + (hi - lo) * self.rng.random() if hi else INF
        g.pace = behavior.speed * RUN_SPEED * g.personality.speed
        g.tempo = max(0.7, behavior.speed) if behavior.speed else 1.0

    def lift(self, g):
        g.grounded, g.platform = False, None

    def throw(self, g, state, vx, vy):
        self.lift(g)
        g.vx, g.vy = vx, vy
        self.enter(g, state)

    def neighbor(self, g, want, sight=SIGHT):
        """Someone nearby that `want` accepts, picked at random with a taste for a scrap in progress."""
        rng = self.rng
        best, best_score = None, 0.0
        for o in self.goblins:
            if o is g or abs(o.x - g.x) > sight or abs(o.y - g.y) > 40.0 or not want(o):
                continue
            score = rng.random() * (3.0 if o.state == 'wrestle' else 1.0)
            if score > best_score:
                best, best_score = o, score
        return best

    def effect(self, kind, x, y, vx=0.0, vy=0.0, text=''):
        """Start a pop. When too many are flying the sprites give way and the words still show."""
        if len(self.effects) >= MAX_EFFECTS and not text:
            return
        e = Effect()
        e.kind, e.x, e.y, e.vx, e.vy, e.text = kind, x, y, vx, vy, text
        e.age = 0.0
        e.ttl = self.rng.uniform(*EFFECTS[kind].ttl)
        self.effects.append(e)

    def dust(self, x, count, spread=14.0):
        rng = self.rng
        for _ in range(count):
            self.effect('dust', x + rng.uniform(-spread, spread), self.floor - rng.uniform(1, 6),
                        rng.uniform(-22, 22), -rng.uniform(4, 20))

    def rouse(self, delay):
        """Cut every timed state short, each after `delay(g)` seconds, so the moment's table decides."""
        for g in self.goblins:
            if g.timer != INF:
                g.timer = min(g.timer, delay(g))

    def _spawn(self, settled):
        rng = self.rng
        g = Goblin()
        g.id = len(self.goblins)
        g.personality = personality_for(g.id)
        g.lane = g.id * 5 % LANES
        g.clock, g.rate = rng.uniform(0.0, 10.0), rng.uniform(0.85, 1.2)
        g.target = g.carrier = g.rider = g.spot = None
        g.vx = g.vy = g.goal = g.hit = g.u = g.v = g.tu = g.tv = g.alpha = 0.0
        g.hang = HANG[0]
        g.wave = 0
        g.state, g.behavior = 'idle', BEHAVIORS['idle']
        g.facing = rng.choice((-1, 1))
        self.goblins.append(g)
        if settled:
            g.grounded, g.platform = True, self.ground
            g.x, g.y = rng.uniform(EDGE, self.width - EDGE), self.floor + g.lane
            self.enter(g, 'idle')
            g.timer *= rng.random()
            return
        g.grounded, g.platform = False, None
        g.x = EDGE + 2.0 if g.facing > 0 else self.width - EDGE - 2.0
        g.y = self.floor - rng.uniform(30.0, 70.0)
        g.vx, g.vy = g.facing * rng.uniform(30.0, 110.0), -rng.uniform(20.0, 120.0)
        g.spot = rng.uniform(SPAWN_MARGIN, self.width - SPAWN_MARGIN)
        self.enter(g, 'drop_in')

    def _lay(self):
        """Rebuild the surfaces from the last window tops and re-seat every goblin standing on one."""
        unit, width, floor = self.unit, self.width, self.floor
        windows, by_key = [], {}
        for x0, x1, y, key, ox in self._tops:
            a, b = max(0.0, x0 / unit), min(width, x1 / unit)
            if x0 < x1 and (b - a) * unit >= MIN_PLATFORM and GOBLIN_H <= y / unit <= floor - CLEARANCE:
                top = Surface(a, b, y / unit, 'window', key, ox / unit, len(windows) + 1)
                windows.append(top)
                by_key.setdefault(key, []).append(top)
        self.windows = tuple(windows)
        for g in self.goblins:
            old = g.platform
            if old is None:
                continue
            if old.kind == 'ground':
                g.platform = self.ground
                g.x, g.y = min(max(g.x, EDGE), width - EDGE), floor + g.lane
                continue
            for top in by_key.get(old.key, ()):
                x = g.x + top.ox - old.ox
                if top.x0 - SLIP <= x <= top.x1 + SLIP:
                    g.x, g.y, g.platform = min(max(x, top.x0), top.x1), top.y, top
                    break
            else:
                self.throw(g, 'fall', 0.0, 0.0)

    def _separate(self):
        crowd = [g for g in self.goblins if g.grounded and g.behavior.push]
        crowd.sort(key=_spot)
        prev = None
        for g in crowd:
            if prev is not None and prev.platform is g.platform:
                gap = g.x - prev.x
                if gap < SEPARATION:
                    shove = (SEPARATION - gap) * SEPARATION_PUSH
                    p = g.platform
                    prev.x = max(p.x0, prev.x - shove)
                    g.x = min(p.x1, g.x + shove)
            prev = g

    def _age(self, dt):
        floor = self.floor + LANES / 2
        alive = []
        for e in self.effects:
            e.age += dt
            if e.age >= e.ttl:
                continue
            kind = EFFECTS[e.kind]
            e.vy += kind.gravity * dt
            e.x += e.vx * dt
            e.y += e.vy * dt
            if kind.bounce and e.y > floor:
                e.y = floor
                e.vy *= -kind.bounce
                e.vx *= 0.7
            alive.append(e)
        self.effects = alive
        if self.leaving:
            fade = FADE_RATE * dt
            for g in self.leaving:
                g.alpha -= fade
            self.leaving = [g for g in self.leaving if g.alpha > 0.0]
