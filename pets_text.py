"""What the pet field says: the HUD line and its tip, a goblin's name tag, the menu's rows, a buy
button's tip, and the banners. Every word here is fixed or a number from a Game, so nothing the viewer
sends reaches the screen
as text. Pure: no Tk.
"""

from __future__ import annotations

from goblin_look import look_for, name_for, title_for
from pet_boss import BOSS_COUNT, boss_name
from pets_feed import FAILED, Game

COIN = "◉"
TROUBLE_MARK = "!"  # Goes on the pill while finished work is not being counted.
GAP = "   "
RERUNS = 8  # The Rerun submenu lists this many of the newest cleared bosses.
DIVIDER = ("", None, False)
UNITS = {"coins": ("coin", "coins"), "scrap": ("scrap", "scrap"), "xp": ("XP", "XP")}

# Each purchase: what its row calls the thing it buys next, and the same thing once it is bought.
BUYS = {
    "recruit": (lambda game: "Recruit a goblin", lambda game: ""),
    "level": (lambda game: f"Level up to {game.level + 1}", lambda game: f"Level {game.level}"),
    "gear": (lambda game: f"Gear tier {game.gear + 1}", lambda game: f"Gear tier {game.gear}"),
    "hoard": (lambda game: f"Hoard {game.upgrades['hoard'] + 1}, more coins from work",
              lambda game: f"Hoard {game.upgrades['hoard']}"),
    "training": (lambda game: f"Training {game.upgrades['training'] + 1}, more XP from work",
                 lambda game: f"Training {game.upgrades['training']}"),
    "grip": (lambda game: f"Grip {game.upgrades['grip'] + 1}, pick up {goblins(game.carry + 1)} at once",
             lambda game: f"Grip {game.upgrades['grip']}, pick up {goblins(game.carry)} at once"),
}
# What a purchase is for, where its name does not say: the second row of its button's tip.
HINTS = {
    "level": "Every goblin fights harder.",
    "gear": "Every goblin fights harder. Beaten bosses pay scrap.",
    "grip": "Drop goblins on a boss to end the fight sooner.",
}
# Why a purchase or a fight did not happen, by the viewer's reason for it.
REASONS = {
    "coins": "Not enough coins for that yet.",
    "scrap": "Not enough scrap for that yet.",
    "xp": "Not enough XP for that yet.",
    "maxed": "That is already as high as it goes.",
    "locked": "That boss is still locked, so beat the one before it first.",
    "unknown": "There is no such thing in this game.",
    FAILED: "The viewer did not answer, so nothing changed.",
}
REFUSED = "That did not go through, so nothing changed."
UPDATE_FAILED = "The update did not start, so nothing changed."
WON, LOST = "Victory", "Not this time"
WELCOME, WELCOME_BACK = "Welcome to the horde", "Welcome back"
MENU_TIP = "Click for the menu."


def count(number: int) -> str:
    """A whole number with commas: 1,284."""
    return f"{int(number):,}"


def amount(number: int, currency: str) -> str:
    """'1 coin', '40 coins', '36 scrap', '52 XP'."""
    one, many = UNITS[currency]
    return f"{count(number)} {one if number == 1 else many}"


def goblins(number: int) -> str:
    """'1 goblin', '37 goblins'."""
    return f"{count(number)} goblin{'' if number == 1 else 's'}"


def gain_text(coins: int) -> str:
    """Coins that just arrived: '+12', '+1,200'."""
    return f"+{count(coins)}"


def boss_title(index: int) -> str:
    """The boss's name, as the field draws it over its head."""
    return boss_name(min(index, BOSS_COUNT - 1))


def boss_label(index: int) -> str:
    """'Boss 6, Rustjaw': bosses count from 1 for the player."""
    return f"Boss {index + 1}, {boss_title(index)}"


def stands_for(game: Game, shown: int) -> str:
    """How many goblins each one on screen stands for ('2.7'), or '' while that is one, as near as a
    decimal place can say."""
    if not 0 < shown < game.size:
        return ""
    scale = f"{game.size / shown:.1f}".rstrip("0").rstrip(".")
    return "" if scale == "1" else scale


def hud_line(game: Game, shown: int, boss: str = "") -> str:
    """The pill: '◉ 1,284   37 goblins', '×N' while one drawn goblin stands for several, and the boss's
    name first during a battle."""
    scale = stands_for(game, shown)
    parts = (boss, f"{COIN} {count(game.coins)}", goblins(game.size), f"×{scale}" if scale else "")
    return GAP.join(part for part in parts if part)


def hud_tip(game: Game | None, earned: int = 0, quiet: int = 0, trouble: str = "") -> str:
    """The pill's tip, a fact a row: the coins held, the coins paid since the widget started
    (``earned``) and ever, and what the next goblin costs. One more row says why no coins are coming
    when that is so: ``trouble``, the viewer's sentence for finished work it cannot read, or else the
    ``quiet`` minutes without finished AI work, when the field counts any. Without a game the pill
    already says why, so the tip only points at the menu."""
    if game is None:
        return MENU_TIP
    rows = [f"Coins {count(game.coins)}", f"Earned this session {gain_text(earned)}", f"Lifetime {count(game.lifetime)}"]
    recruit = (game.prices["recruit"] or {}).get("coins")
    if recruit is not None:
        rows.append(f"Next goblin costs {count(recruit)}")
    if trouble or quiet:
        rows.append(trouble or f"No finished AI turns seen for {count(quiet)} min")
    return "\n".join(rows)


def goblin_tip(goblin_id: int, unlocked: frozenset) -> str:
    """A goblin's name over its title: 'Wartboar' and 'Albino hooded goblin'."""
    return f"{name_for(goblin_id)}\n{title_for(look_for(goblin_id, unlocked))}"


def _buy_row(game: Game, kind: str) -> tuple:
    price = game.prices[kind]
    cost = "maxed" if price is None else ", ".join(amount(number, currency) for currency, number in price.items())
    name = BUYS[kind][1](game) if price is None else BUYS[kind][0](game)
    return (f"{name} ({cost})", ("buy", kind), game.affords(kind))


def buy_tip(game: Game, kind: str) -> str:
    """A buy button's tip: the menu row's words, and under them what the purchase is for."""
    return "\n".join(row for row in (_buy_row(game, kind)[0], HINTS.get(kind, "")) if row)


def pets_menu(game: Game | None, *, battling: bool = False, hidden: bool = False, status: str = "",
              screens: list = ()) -> list:
    """The field's menu as (label, action, enabled) rows. A row with no label is a divider, and an action
    that is a list is a submenu of rows. Without a game the purchases and fights give way to ``status``.
    Nothing the player cannot afford is enabled, and no fight starts while one is running. ``screens``
    are the rows of a "Move to screen" submenu, which is left out when there are none."""
    if game is None:
        rows = [(status, None, False)]
    else:
        rows = [_buy_row(game, kind) for kind in BUYS]
        rows.append(DIVIDER)
        if game.next_boss is None:
            rows.append(("Every boss is beaten", None, False))
        else:
            rows.append((f"Send the horde to {boss_label(game.next_boss)}", ("fight", game.next_boss), not battling))
        reruns = [(boss_label(boss), ("fight", boss), not battling)
                  for boss in range(game.cleared - 1, max(-1, game.cleared - 1 - RERUNS), -1)]
        if reruns:
            rows.append(("Rerun a boss", reruns, not battling))
    moves = [("Move to screen", list(screens), True)] if screens else []
    return rows + [DIVIDER, ("Show the goblins" if hidden else "Hide the goblins", ("goblins",), True), *moves]


def reason_line(reason: str) -> str:
    """One plain sentence for a purchase or a fight the viewer turned down."""
    return REASONS.get(reason, REFUSED)


def update_label(version: str) -> str:
    """The menu row for a verified update the viewer keeps: 'Update to 0.6.1 and restart'."""
    return f"Update to {version} and restart"


def updating_line(version: str) -> str:
    """The banner while that update goes in: the goblins leave, and the new version brings them back."""
    return f"Updating to {version}. The goblins are back in a moment."


def result_line(won: bool, rewards: dict) -> str:
    """A battle's result: 'Victory +54 coins, +4 scrap, +40 XP' or 'Not this time'."""
    if not won:
        return LOST
    gains = ", ".join(f"+{amount(rewards[currency], currency)}" for currency in UNITS if rewards.get(currency))
    return f"{WON} {gains}".strip()


def bought_line(game: Game, kind: str) -> str:
    """What a purchase just made of the horde ('Level 4'), or '' for a recruit, who runs in instead."""
    return BUYS[kind][1](game)


def launch_line(welcome: bool, coins: int) -> str:
    """The banner for the viewer opening the game: a new player, or coins earned while away."""
    if coins:
        return f"{WELCOME_BACK} {gain_text(coins)}"
    return WELCOME if welcome else ""
