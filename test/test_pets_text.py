"""What the pet field says: the pill, the tips, the menu's rows, and the banners. Headless."""

import unittest
from dataclasses import replace

from goblin_look import look_for, name_for, title_for, unlocked_tiers
from pets_feed import FAILED, read_game
from pets_text import (DIVIDER, HINTS, REASONS, REFUSED, boss_label, bought_line, buy_tip, goblin_tip, hud_line, hud_tip,
                       launch_line, pets_menu, reason_line, result_line)

try:
    from test_pets_feed import game
except ImportError:
    from test.test_pets_feed import game

RICH = read_game(game(coins=12_840, size=37, cleared=5, scrap=80, grip=2))
RICH = replace(RICH, xp=900)
POOR = read_game(game(coins=20, size=3, cleared=0, scrap=0))


def rows_by_action(rows) -> dict:
    return {action: (label, enabled) for label, action, enabled in rows if isinstance(action, tuple)}


class HudTests(unittest.TestCase):
    def test_the_pill_shows_coins_and_goblins_with_commas(self):
        self.assertEqual(hud_line(RICH, 37), "◉ 12,840   37 goblins")
        self.assertEqual(hud_line(replace(RICH, size=1), 1), "◉ 12,840   1 goblin")

    def test_the_pill_adds_how_many_each_drawn_goblin_stands_for(self):
        self.assertEqual(hud_line(replace(RICH, size=5000), 150), "◉ 12,840   5,000 goblins   ×33.3")
        self.assertEqual(hud_line(replace(RICH, size=300), 150), "◉ 12,840   300 goblins   ×2")
        self.assertNotIn("×", hud_line(RICH, 0), "before the crowd is drawn there is nothing to scale")
        self.assertEqual(hud_line(replace(RICH, size=151), 150), "◉ 12,840   151 goblins", "one more than fits is not ×1")
        self.assertEqual(hud_line(replace(RICH, size=158), 150), "◉ 12,840   158 goblins   ×1.1")

    def test_the_boss_leads_the_pill_during_a_battle(self):
        self.assertEqual(hud_line(RICH, 37, "Rustjaw"), "Rustjaw   ◉ 12,840   37 goblins")

    def test_the_tip_is_the_coins_held_earned_and_ever_paid_and_the_next_goblins_cost(self):
        game = replace(RICH, coins=4, lifetime=1234, prices={**RICH.prices, "recruit": {"coins": 40}})
        self.assertEqual(hud_tip(game, earned=59).splitlines(),
                         ["Coins 4", "Earned this session +59", "Lifetime 1,234", "Next goblin costs 40"])
        self.assertEqual(hud_tip(RICH).splitlines(),
                         ["Coins 12,840", "Earned this session +0", "Lifetime 12,850", "Next goblin costs 41"])
        no_recruit = replace(RICH, prices={**RICH.prices, "recruit": None})
        self.assertEqual(hud_tip(no_recruit).splitlines(), ["Coins 12,840", "Earned this session +0", "Lifetime 12,850"])
        self.assertEqual(hud_tip(None), "Click for the menu.")

    def test_the_tips_last_row_says_why_no_coins_are_coming(self):
        facts = hud_tip(RICH).splitlines()
        self.assertEqual(hud_tip(RICH, quiet=12).splitlines(), [*facts, "No finished AI turns seen for 12 min"])
        self.assertEqual(hud_tip(RICH, quiet=1440).splitlines()[-1], "No finished AI turns seen for 1,440 min")
        not_found = "T3 Code's database was not found."
        self.assertEqual(hud_tip(RICH, trouble=not_found).splitlines(), [*facts, not_found])
        self.assertEqual(hud_tip(RICH, quiet=12, trouble=not_found).splitlines(), [*facts, not_found],
                         "the reason work is not counted stands in for the minutes without any")

    def test_a_goblin_is_named_by_its_number_and_titled_by_its_look(self):
        for goblin in range(40):
            name, title = goblin_tip(goblin, frozenset()).splitlines()
            self.assertEqual(name, name_for(goblin))
            self.assertEqual(title, title_for(look_for(goblin)))
            self.assertRegex(title, r"^(Goblin|[A-Z][a-z ]* goblin)$")

    def test_a_shiny_goblin_is_titled_by_its_skin_once_that_tier_is_unlocked(self):
        everything = unlocked_tiers({"bosses": {"cleared": 36}})
        shiny = next(goblin for goblin in range(5000) if look_for(goblin, everything).skin != look_for(goblin).skin)
        skin = look_for(shiny, everything).skin
        self.assertTrue(goblin_tip(shiny, everything).splitlines()[1].startswith(skin.capitalize()))
        self.assertNotIn(skin, goblin_tip(shiny, frozenset()).lower())


class MenuTests(unittest.TestCase):
    def test_every_purchase_is_listed_with_its_level_and_cost(self):
        labels = [label for label, _action, _enabled in pets_menu(RICH)]
        self.assertEqual(labels[:7], [
            "Recruit a goblin (41 coins)", "Level up to 3 (21 coins, 52 XP)", "Gear tier 2 (36 scrap)",
            "Hoard 2, more coins from work (60 coins)", "Training 1, more XP from work (30 coins)",
            "Grip 3, pick up 4 goblins at once (50 coins)", ""],
            "the six purchases, then a divider: there is no vault to buy")
        self.assertEqual(pets_menu(replace(RICH, prices={**RICH.prices, "grip": None}))[5][0], "Grip 2, pick up 3 goblins at once (maxed)")
        self.assertEqual(pets_menu(replace(RICH, prices={**RICH.prices, "hoard": None}))[3][0], "Hoard 1 (maxed)")
        self.assertEqual(pets_menu(replace(RICH, prices={**RICH.prices, "recruit": {"coins": 1234}}))[0][0],
                         "Recruit a goblin (1,234 coins)")

    def test_what_the_player_can_afford_is_enabled_and_nothing_else(self):
        rich, poor = rows_by_action(pets_menu(RICH)), rows_by_action(pets_menu(POOR))
        for kind in ("recruit", "level", "gear", "hoard", "training", "grip"):
            self.assertTrue(rich[("buy", kind)][1], kind)
            self.assertFalse(poor[("buy", kind)][1], kind)
        maxed = rows_by_action(pets_menu(replace(RICH, prices={**RICH.prices, "hoard": None})))
        self.assertFalse(maxed[("buy", "hoard")][1], "a maxed upgrade is locked")
        short_on_xp = replace(RICH, xp=51)
        self.assertFalse(rows_by_action(pets_menu(short_on_xp))[("buy", "level")][1], "the coins alone do not buy a level")

    def test_a_buy_buttons_tip_is_its_menu_row_and_what_the_purchase_is_for(self):
        self.assertEqual(buy_tip(RICH, "recruit"), "Recruit a goblin (41 coins)")
        self.assertEqual(buy_tip(RICH, "level").splitlines(), ["Level up to 3 (21 coins, 52 XP)", HINTS["level"]])
        self.assertEqual(buy_tip(RICH, "grip").splitlines(),
                         ["Grip 3, pick up 4 goblins at once (50 coins)", "Drop goblins on a boss to end the fight sooner."])
        self.assertEqual(buy_tip(replace(RICH, prices={**RICH.prices, "gear": None}), "gear").splitlines()[0], "Gear tier 1 (maxed)")
        for hint in HINTS.values():
            self.assertRegex(hint, r"^[A-Z][A-Za-z ,.]+\.$")

    def test_a_first_grip_is_one_goblin_in_the_singular(self):
        new = replace(RICH, upgrades={**RICH.upgrades, "grip": 0})
        self.assertEqual(bought_line(new, "grip"), "Grip 0, pick up 1 goblin at once")
        self.assertEqual(bought_line(RICH, "grip"), "Grip 2, pick up 3 goblins at once")

    def test_the_next_boss_and_the_newest_cleared_ones_can_be_fought(self):
        rows = pets_menu(replace(RICH, cleared=12, next_boss=12))
        actions = rows_by_action(rows)
        self.assertEqual(actions[("fight", 12)], ("Send the horde to Boss 13, Gristlegut", True))
        label, reruns, enabled = next(row for row in rows if isinstance(row[1], list))
        self.assertEqual((label, enabled), ("Rerun a boss", True))
        self.assertEqual([action for _label, action, _enabled in reruns], [("fight", boss) for boss in range(11, 3, -1)])
        self.assertEqual(reruns[0][0], boss_label(11))

    def test_a_new_player_has_no_reruns_and_a_finished_one_no_next_boss(self):
        self.assertFalse(any(isinstance(row[1], list) for row in pets_menu(POOR)))
        done = pets_menu(replace(RICH, cleared=36, next_boss=None))
        self.assertIn(("Every boss is beaten", None, False), done)
        self.assertEqual(len(next(row for row in done if isinstance(row[1], list))[1]), 8)

    def test_a_choice_of_screen_is_offered_only_when_there_is_more_than_one(self):
        self.assertFalse(any(label == "Move to screen" for label, _action, _enabled in pets_menu(RICH)))
        screens = [("Screen 1, 2560 x 1440 (main)", ("screen", 0), False), ("Screen 2, 1080 x 1920", ("screen", 1), True)]
        rows = pets_menu(RICH, screens=screens)
        self.assertIn(("Move to screen", screens, True), rows)
        self.assertEqual([row[0] for row in rows[-2:]], ["Hide the goblins", "Move to screen"])

    def test_no_fight_starts_during_a_battle_but_buying_goes_on(self):
        rows = pets_menu(RICH, battling=True)
        actions = rows_by_action(rows)
        self.assertFalse(actions[("fight", 5)][1])
        label, reruns, enabled = next(row for row in rows if isinstance(row[1], list))
        self.assertFalse(enabled)
        self.assertFalse(any(row[2] for row in reruns))
        self.assertTrue(actions[("buy", "recruit")][1])

    def test_the_rows_end_with_hiding_the_goblins(self):
        self.assertEqual(pets_menu(RICH)[-2:], [DIVIDER, ("Hide the goblins", ("goblins",), True)])
        self.assertEqual(pets_menu(RICH, hidden=True)[-1], ("Show the goblins", ("goblins",), True))

    def test_without_a_game_the_menu_says_why_and_still_hides_the_goblins(self):
        rows = pets_menu(None, status="Goblin Horde is opening your saved game.")
        self.assertEqual(rows, [("Goblin Horde is opening your saved game.", None, False), DIVIDER,
                                ("Hide the goblins", ("goblins",), True)])


class BannerTests(unittest.TestCase):
    def test_a_win_lists_what_it_paid_and_a_loss_says_so_plainly(self):
        self.assertEqual(result_line(True, {"coins": 54, "scrap": 4, "xp": 40}), "Victory +54 coins, +4 scrap, +40 XP")
        self.assertEqual(result_line(True, {"coins": 1, "scrap": 0, "xp": 1200}), "Victory +1 coin, +1,200 XP")
        self.assertEqual(result_line(True, {"coins": 0, "scrap": 0, "xp": 0}), "Victory")
        self.assertEqual(result_line(False, {"coins": 0, "scrap": 0, "xp": 0}), "Not this time")

    def test_every_reason_is_one_plain_sentence(self):
        for reason in ("locked", "unknown", "coins", "scrap", "xp", "maxed", FAILED, "a reason from a newer viewer", ""):
            with self.subTest(reason=reason):
                line = reason_line(reason)
                self.assertEqual(line, REASONS.get(reason, REFUSED))
                self.assertTrue(line.endswith(".") and line.count(".") == 1, line)
        self.assertNotIn("newer viewer", reason_line("a reason from a newer viewer"), "the viewer's words are not shown")

    def test_coming_back_shows_the_coins_and_a_new_player_a_welcome(self):
        self.assertEqual(launch_line(False, 319), "Welcome back +319")
        self.assertEqual(launch_line(True, 0), "Welcome to the horde")
        self.assertEqual(launch_line(False, 0), "")


if __name__ == "__main__":
    unittest.main()
