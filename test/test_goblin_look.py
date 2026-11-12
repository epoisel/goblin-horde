"""Each goblin's name and look come from its number alone, the same in every process."""

import json
import os
import subprocess
import sys
import unittest
from collections import Counter
from pathlib import Path

import pet_art
from goblin_look import SKIN_TIERS, Look, look_for, name_for, title_for, unlocked_tiers

ROOT = Path(__file__).resolve().parents[1]
COMMON = SKIN_TIERS[0].name
SHINIES = [tier.name for tier in SKIN_TIERS[1:]]
ALL = frozenset(SHINIES)
RUDE = ("ass", "fuck", "shit", "cunt", "dick", "cock", "piss", "slut", "whore", "bitch", "crap", "fag", "nazi",
        "rape", "porn", "sex", "tit", "cum", "turd", "wank", "twat", "prick", "boob", "anus", "tard", "bum", "pube")


class LookTest(unittest.TestCase):
    def test_same_goblin_same_look_and_name_in_a_fresh_interpreter(self):
        ids = [0, 1, 7, 99, 4096, 123456, -3]
        here = [[list(look_for(i, ALL)), list(look_for(i)), name_for(i)] for i in ids]
        script = ("import json, goblin_look as g\n"
                  f"every = frozenset({sorted(ALL)!r})\n"
                  f"print(json.dumps([[g.look_for(i, every), g.look_for(i), g.name_for(i)] for i in {ids!r}]))")
        out = subprocess.run([sys.executable, "-c", script], cwd=ROOT, capture_output=True, text=True, check=True,
                             env={**os.environ, "PYTHONHASHSEED": "12345"})
        self.assertEqual(json.loads(out.stdout), here)

    def test_a_look_names_parts_the_art_has_and_draws(self):
        tiers = {tier.name for tier in SKIN_TIERS}
        for goblin in range(0, 6000, 3):
            look = look_for(goblin, ALL)
            self.assertIsInstance(look, Look)
            self.assertEqual(look._fields[:6], ("name", "skin", "green", "hat", "cloth", "tool"))
            self.assertIn(look.skin, tiers)
            self.assertIn(look.green, range(len(pet_art.GREENS)))
            self.assertIn(look.cloth, range(len(pet_art.CLOTH)))
            pixels = pet_art.goblin_pixels(look, "idle", 0)
            self.assertTrue(any(any(row) for row in pixels.rows))
        self.assertEqual(set(pet_art.SHINIES), set(SHINIES), "every shiny tier has a skin, and every skin a tier")

    def test_name_is_one_to_one_with_the_look_and_with_the_picture(self):
        by_name, by_look, by_picture = {}, {}, {}
        for goblin in range(5000):
            look = look_for(goblin, ALL)
            by_name.setdefault(look.name, set()).add(look[1:])
            by_look.setdefault(look[1:], set()).add(look.name)
            self.assertLessEqual(len(look.name), 40)
        self.assertTrue(all(len(looks) == 1 for looks in by_name.values()))
        self.assertTrue(all(len(names) == 1 for names in by_look.values()))
        self.assertGreater(len(by_name), 1000, "the crowd wears many looks")
        for name, (parts,) in by_name.items():
            picture = tuple(pet_art.goblin_pixels(Look(name, *parts), action, 0).rows for action in ("idle", "run"))
            by_picture.setdefault(picture, set()).add(name)
        self.assertEqual([names for names in by_picture.values() if len(names) > 1], [],
                         "two looks never draw the same goblin, so no sprite is cached twice")

    def test_every_piece_of_the_wardrobe_turns_up_and_plain_ones_more_often(self):
        looks = [look_for(goblin) for goblin in range(20_000)]
        hats = Counter(look.hat for look in looks)
        self.assertEqual(set(hats), {"", *pet_art.HATS})
        self.assertEqual({look.tool for look in looks}, {"", *pet_art.TOOLS})
        self.assertEqual({look.wear for look in looks}, {"", *pet_art.WEARS})
        greens = Counter(look.green for look in looks)
        self.assertEqual(set(greens), set(range(len(pet_art.GREENS))))
        cloths = Counter(look.cloth for look in looks if look.wear)
        self.assertEqual(set(cloths), set(range(len(pet_art.CLOTH))))
        for counts in (hats, greens, cloths):
            common = counts.most_common()
            self.assertGreater(common[0][1], 2 * common[-1][1], "some are commoner than others")
        self.assertGreater(hats[""], 0.2 * len(looks), "plenty of bare heads")
        dyed = {look.cloth for look in looks if look.hat == "cap" and not look.wear}
        self.assertGreater(len(dyed), 4, "a dyed hat comes in many colours")

    def test_greens_only_until_a_shiny_is_unlocked(self):
        locked = [look_for(goblin) for goblin in range(20_000)]
        self.assertTrue(all(look.skin == COMMON for look in locked))
        unlocked = [look_for(goblin, ALL) for goblin in range(20_000)]
        self.assertGreaterEqual(sum(look.skin == COMMON for look in unlocked) / 20_000, 0.95)
        self.assertEqual({look.skin for look in unlocked}, {COMMON, *SHINIES})

    def test_an_unlocked_tier_shows_at_about_its_chance(self):
        for tier in SKIN_TIERS[1:]:
            rate = sum(look_for(goblin, frozenset({tier.name})).skin == tier.name for goblin in range(40_000)) / 40_000
            self.assertGreater(rate, 0.6 / tier.one_in, tier.name)
            self.assertLess(rate, 1.5 / tier.one_in, tier.name)

    def test_unlocking_a_tier_changes_only_the_goblins_that_rolled_it(self):
        for count in range(1, len(SHINIES) + 1):
            before, after = frozenset(SHINIES[:count - 1]), frozenset(SHINIES[:count])
            tier = SKIN_TIERS[count]
            changed = 0
            for goblin in range(10_000):
                old, new = look_for(goblin, before), look_for(goblin, after)
                self.assertEqual((old.hat, old.cloth, old.tool, old.wear), (new.hat, new.cloth, new.tool, new.wear))
                if old != new:
                    changed += 1
                    self.assertEqual(new.skin, tier.name)
                    self.assertEqual(title_for(new).split()[0], tier.name.capitalize())
            self.assertGreater(changed, 0, tier.name)
            self.assertLess(changed, 3 * 10_000 / tier.one_in, tier.name)

    def test_the_rarest_unlocked_tier_a_goblin_rolled_wins(self):
        commoner, rarer = SHINIES[:2]
        both = [goblin for goblin in range(60_000) if look_for(goblin, frozenset({commoner})).skin == commoner
                and look_for(goblin, frozenset({rarer})).skin == rarer]
        self.assertTrue(both, "some goblin rolled both tiers")
        for goblin in both:
            self.assertEqual(look_for(goblin, frozenset({commoner, rarer})).skin, rarer)

    def test_titles_are_plain_words(self):
        self.assertEqual(title_for(Look("a", COMMON, 0, "", 0, "", "")), "Goblin")
        self.assertEqual(title_for(Look("b", COMMON, 2, "helmet", 0, "club", "vest")), "Helmeted goblin")
        self.assertEqual(title_for(Look("c", "albino", 0, "", 0, "", "")), "Albino goblin")
        self.assertEqual(title_for(Look("d", "albino", 0, "hood", 3, "", "")), "Albino hooded goblin")
        titles = {title_for(look_for(goblin, ALL)) for goblin in range(20_000)}
        for title in titles:
            self.assertRegex(title, r"^[A-Z][a-z]+( [a-z]+)*$")
            self.assertTrue(title.lower().endswith("goblin"), title)
        self.assertFalse([title for title in {title_for(look_for(goblin)) for goblin in range(5000)}
                          if title.split()[0].lower() in ALL], "no shiny word before a tier is unlocked")

    def test_names_are_distinct_plain_and_polite(self):
        names = [name_for(goblin) for goblin in range(50_000)]
        self.assertEqual(len(set(names)), len(names))
        for name in names:
            self.assertRegex(name, r"^[A-Z][a-z]{2,24}$")
            self.assertFalse([word for word in RUDE if word in name.lower()], name)

    def test_bosses_unlock_rarer_tiers_later(self):
        self.assertEqual(unlocked_tiers({}), frozenset())
        self.assertEqual(unlocked_tiers({"bosses": {}}), frozenset())
        self.assertEqual(unlocked_tiers({"horde": {"size": 40, "level": 3}}), frozenset())
        previous = frozenset()
        for cleared in range(60):
            now = unlocked_tiers({"horde": {"size": 1, "level": 1}, "bosses": {"cleared": cleared}})
            self.assertLessEqual(previous, now)
            self.assertEqual(now, frozenset(SHINIES[:len(now)]), "a rarer tier never comes before a commoner one")
            previous = now
        self.assertEqual(previous, ALL)


if __name__ == "__main__":
    unittest.main()
