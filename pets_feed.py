"""The pet game's feed: what the viewer says about coins, the horde and finished work, as plain values.

PetsFeed.poll() runs on a worker thread and never raises. A viewer that is down, older than the game, or
answering something unreadable comes back as a Feed that is not ready, with one sentence to show. The
answer's shape is checked here, once, so the window can trust every field of a Game. Pure: no Tk.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass
from http.client import HTTPException
from typing import NamedTuple

from horde_api import ApiError

POLL_MS = 900  # The viewer pays finished work every 1000 ms.
# The wait before the next poll after 0, 1, 2, and 3 or more polls in a row that found no game.
BACKOFF_MS = (POLL_MS, 2000, 4000, 8000)
STALE_MS = 60_000  # An event older than this was for a window that was not looking.
MESSAGE_MAX = 160
PURCHASES = ("recruit", "level", "gear", "hoard", "training")
UPGRADES = ("hoard", "training")
CURRENCIES = ("coins", "scrap", "xp")
NO_REWARDS = {"coins": 0, "scrap": 0, "xp": 0}
FAILED = "failed"  # The reason for a purchase or a fight the viewer never answered.

WAITING = {
    "offline": "The goblins are waiting for Goblin Horde's viewer to answer.",
    "old": "This viewer is older than the pet game, so update Goblin Horde to play.",
    "refused": "The viewer would not open the game for this window.",
    "garbled": "The viewer's answer could not be read, so the goblins will ask again.",
    "opening": "Goblin Horde is opening your saved game.",
}
NOT_COUNTING = "The viewer cannot read finished work right now."
# What a failed read means, by the error it raised; the first match wins and anything else is garbled.
TROUBLE = ((AttributeError, "old"), (OSError, "offline"), (HTTPException, "offline"))


@dataclass(frozen=True)
class Game:
    """The game's numbers as the viewer reported them. lifetime is every coin ever paid, spent or not.
    A price is {currency: amount}, or None once that purchase is maxed. next_boss is the boss to clear
    next (None when every boss is beaten) and next_need the power it takes."""
    coins: int
    lifetime: int
    scrap: int
    size: int
    level: int
    xp: int
    gear: int
    upgrades: dict
    cleared: int
    power: float
    prices: dict
    next_boss: int | None
    next_need: float

    def held(self, currency: str) -> int:
        """How much of a currency the player has to spend."""
        return {"coins": self.coins, "scrap": self.scrap, "xp": self.xp}[currency]

    def affords(self, kind: str) -> bool:
        """Whether a purchase would go through now: it has a price, and every part of it is held."""
        price = self.prices[kind]
        return price is not None and all(self.held(currency) >= amount for currency, amount in price.items())


class Work(NamedTuple):
    """Finished AI work that paid, summed over one answer."""
    coins: int
    turns: int


class Launch(NamedTuple):
    """The viewer opened the game: a new player, or coins for the time away and the work caught up."""
    welcome: bool
    coins: int


class Feed(NamedTuple):
    """One poll's answer for the window: a game and its events, or a sentence saying why there is none.
    source is {"ok": True}, or {"ok": False, "message"} while the viewer cannot read finished work."""
    ready: bool
    message: str = ""
    events: tuple = ()
    game: Game | None = None
    source: dict | None = None


def _number(value) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("not a number")
    return value


def _count(value) -> int:
    number = int(_number(value))
    if number < 0:
        raise ValueError("below zero")
    return number


def _line(value) -> str:
    return " ".join(value.split())[:MESSAGE_MAX] if isinstance(value, str) else ""


def _price(quote) -> dict | None:
    if quote is None:
        return None
    price = {currency: _count(quote[currency]) for currency in CURRENCIES if currency in quote}
    if not price:
        raise ValueError("a price in no currency")
    return price


def read_game(raw: dict) -> Game:
    """A Game from the viewer's ``game`` object. Raises KeyError, TypeError or ValueError when it is not
    the shape lib/reward-engine.mjs snapshot() sends."""
    state = raw["state"]
    wallet, horde, upgrades, next_boss = state["wallet"], state["horde"], state["upgrades"], raw["nextBoss"]
    return Game(
        coins=_count(wallet["coins"]), lifetime=_count(wallet["lifetimeCoins"]), scrap=_count(wallet["scrap"]),
        size=_count(horde["size"]), level=_count(horde["level"]), xp=_count(horde["xp"]), gear=_count(horde["gear"]),
        upgrades={name: _count(upgrades[name]) for name in UPGRADES}, cleared=_count(state["bosses"]["cleared"]),
        power=float(_number(raw["power"])), prices={kind: _price(raw["quotes"][kind]) for kind in PURCHASES},
        next_boss=None if next_boss is None else _count(next_boss["index"]),
        next_need=0.0 if next_boss is None else float(_number(next_boss["requiredPower"])))


def _launch(event: dict) -> Launch:
    away, caught = event.get("away") or {}, event.get("caughtUp") or {}
    return Launch(event.get("welcome") is True, _count(away.get("coins", 0)) + _count(caught.get("coins", 0)))


def read_events(raw, now_ms: float) -> tuple:
    """The fresh events of one answer: every work event summed into one Work, then each Launch. An event
    of a kind this window does not know, or one too malformed to count, is left out."""
    coins = turns = 0
    launches = []
    for event in raw if isinstance(raw, list) else ():
        try:
            if now_ms - _number(event["at"]) > STALE_MS:
                continue
            if event["type"] == "work":
                coins, turns = coins + _count(event["coins"]), turns + _count(event["turns"])
            elif event["type"] == "launch":
                launches.append(_launch(event))
        except (KeyError, TypeError, ValueError, AttributeError):
            continue
    return ((Work(coins, turns),) if coins or turns else ()) + tuple(launches)


def _source(raw) -> dict:
    if isinstance(raw, dict) and raw.get("ok") is False:
        return {"ok": False, "message": _line(raw.get("message")) or NOT_COUNTING}
    return {"ok": True}


def _trouble(error: Exception) -> str:
    if isinstance(error, ApiError):
        return "old" if error.missing else "refused"
    return next((name for kind, name in TROUBLE if isinstance(error, kind)), "garbled")


class PetsFeed:
    """Reads the game from one viewer through ``api`` (a HordeApi), remembering which of the viewer's
    numbered events it has already handed over. One poll at a time."""

    def __init__(self, api, now=time.time) -> None:
        self.api = api
        self.now = now
        self.boot: str | None = None
        self.seq = 0
        self.misses = 0

    @property
    def delay_ms(self) -> int:
        """How long to wait before the next poll: longer while polls keep finding no game."""
        return BACKOFF_MS[min(self.misses, len(BACKOFF_MS) - 1)]

    def poll(self) -> Feed:
        """Ask the viewer for the game and the events since the last poll. Never raises."""
        try:
            feed = self._read()
        except Exception as error:
            feed = Feed(False, WAITING[_trouble(error)])
        self.misses = 0 if feed.ready else self.misses + 1
        return feed

    def _ask(self, after: int) -> dict:
        answer = self.api.pets(after)
        if not isinstance(answer, dict):
            raise ValueError("not an object")
        return answer

    def _read(self) -> Feed:
        answer = self._ask(self.seq)
        if answer.get("ready") is True and answer["boot"] != self.boot and self.seq:
            answer = self._ask(0)  # Another run of the viewer numbers its events from 1 again.
        if answer.get("ready") is not True:
            return Feed(False, _line(answer.get("message")) or WAITING["opening"])
        boot, seq = answer["boot"], _count(answer["seq"])
        if not isinstance(boot, str):
            raise ValueError("boot")
        feed = Feed(True, "", read_events(answer.get("events"), self.now() * 1000), read_game(answer["game"]),
                    _source(answer.get("source")))
        self.boot, self.seq = boot, seq
        return feed

    def buy(self, kind: str) -> dict:
        """Buy one purchase: {"ok", "reason", "game"}. The reason is FAILED and the game None when the
        viewer did not answer. Never raises."""
        return self._act(lambda: self.api.pets_buy(kind), lambda answer: {"ok": answer.get("ok") is True})

    def fight(self, boss: int) -> dict:
        """Send the horde against a boss: {"won", "ratio", "rewards", "reason", "game"}. The reason is
        FAILED and the game None when the viewer did not answer. Never raises."""
        def read(answer: dict) -> dict:
            rewards = answer.get("rewards") or {}
            return {"won": answer.get("won") is True, "ratio": float(_number(answer.get("ratio", 0))),
                    "rewards": {name: _count(rewards.get(name, 0)) for name in NO_REWARDS}}
        return self._act(lambda: self.api.pets_fight(boss), read)

    def _act(self, call, read) -> dict:
        try:
            answer = call()
            reason = answer.get("reason")
            return {**read(answer), "reason": reason if isinstance(reason, str) else "", "game": read_game(answer["game"])}
        except Exception:
            return {**read({}), "reason": FAILED, "game": None}
