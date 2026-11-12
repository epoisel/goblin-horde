"""The pet game's feed: a ready game, a game still opening, a restarted viewer, and every way a read fails.

Headless: the viewer is a stand-in whose answers each test scripts."""

import unittest
import urllib.error

from horde_api import ApiError
from pets_feed import BACKOFF_MS, FAILED, POLL_MS, STALE_MS, WAITING, Feed, Launch, PetsFeed, Work, read_game

NOW = 1_800_000_000.0


def game(coins=64, size=5, cleared=2, scrap=3, **quotes) -> dict:
    """The viewer's ``game`` object, as lib/reward-engine.mjs snapshot() shapes it."""
    return {
        "state": {"schema": 1, "wallet": {"coins": coins, "scrap": scrap, "lifetimeCoins": coins + 10},
                  "horde": {"size": size, "level": 2, "xp": 30, "gear": 1},
                  "upgrades": {"hoard": 1, "training": 0}, "bosses": {"cleared": cleared},
                  "today": {"key": "2026-11-11", "reruns": {}}},
        "quotes": {"recruit": {"coins": 41}, "level": {"xp": 52, "coins": 21}, "gear": {"scrap": 36},
                   "hoard": {"coins": 60}, "training": {"coins": 30}, **quotes},
        "power": size * 1.265, "nextBoss": {"index": cleared, "requiredPower": 2.5 * (cleared + 1) ** 2},
    }


def work(seq, coins=12, turns=1, age_ms=0) -> dict:
    return {"seq": seq, "at": NOW * 1000 - age_ms, "type": "work", "coins": coins, "xp": 1, "turns": turns, "subagents": 0}


def ready(boot="run-a", seq=0, events=(), **numbers) -> dict:
    return {"ready": True, "boot": boot, "seq": seq, "events": list(events), "game": game(**numbers), "source": {"ok": True}}


class Viewer:
    """A stand-in HordeApi: each call takes the next scripted answer (an exception is raised)."""

    def __init__(self, *answers) -> None:
        self.answers = list(answers)
        self.asked: list[int] = []

    def next(self):
        answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if isinstance(answer, Exception):
            raise answer
        return answer

    def pets(self, after=0):
        self.asked.append(after)
        return self.next()

    def pets_buy(self, kind):
        return self.next()

    def pets_fight(self, boss):
        return self.next()


def feed_for(*answers) -> tuple[PetsFeed, Viewer]:
    viewer = Viewer(*answers)
    return PetsFeed(viewer, now=lambda: NOW), viewer


class ReadyTests(unittest.TestCase):
    def test_a_ready_game_comes_back_as_checked_numbers(self):
        feed, _viewer = feed_for(ready(seq=3, events=[work(3)], coins=1284, size=37, gear=None))
        answer = feed.poll()
        self.assertTrue(answer.ready)
        self.assertEqual(answer.message, "")
        self.assertEqual((answer.game.coins, answer.game.scrap, answer.game.size, answer.game.level, answer.game.gear),
                         (1284, 3, 37, 2, 1))
        self.assertEqual(answer.game.lifetime, 1294, "every coin ever paid, not the coins held")
        self.assertEqual(answer.game.upgrades, {"hoard": 1, "training": 0})
        self.assertEqual((answer.game.cleared, answer.game.next_boss, answer.game.next_need), (2, 2, 22.5))
        self.assertEqual(answer.game.prices["level"], {"coins": 21, "xp": 52})
        self.assertIsNone(answer.game.prices["gear"], "a maxed purchase has no price")
        self.assertEqual(answer.source, {"ok": True})
        self.assertEqual(answer.events, (Work(12, 1),))

    def test_the_next_poll_asks_only_for_newer_events(self):
        feed, viewer = feed_for(ready(seq=3, events=[work(3)]), ready(seq=5, events=[work(4, 7), work(5, 9, turns=2)]))
        feed.poll()
        self.assertEqual(feed.poll().events, (Work(16, 3),), "one answer's work is one cheer")
        self.assertEqual(viewer.asked, [0, 3])
        self.assertEqual(feed.seq, 5)

    def test_what_a_player_can_afford_comes_from_the_prices(self):
        numbers = read_game(game(coins=41, scrap=35))
        self.assertTrue(numbers.affords("recruit"))
        self.assertFalse(numbers.affords("gear"), "one scrap short")
        self.assertFalse(numbers.affords("level"), "the coins are there but not the XP")
        self.assertFalse(numbers.affords("hoard"))
        self.assertFalse(read_game(game(coins=9_999, training=None)).affords("training"), "maxed")

    def test_the_vault_an_older_viewer_still_reports_is_left_out(self):
        raw = game()
        raw["state"]["upgrades"]["vault"] = 2
        raw["state"]["today"]["coinsEarned"] = 12
        raw["quotes"]["vault"] = {"coins": 60}
        numbers = read_game(raw)
        self.assertEqual(numbers.upgrades, {"hoard": 1, "training": 0})
        self.assertEqual(sorted(numbers.prices), ["gear", "hoard", "level", "recruit", "training"])

    def test_launch_events_carry_the_coins_paid_for_the_time_away(self):
        launch = {"seq": 1, "at": NOW * 1000, "type": "launch", "welcome": False, "away": {"minutes": 90, "coins": 9},
                  "caughtUp": {"turns": 18, "coins": 310}}
        new_player = {"seq": 2, "at": NOW * 1000, "type": "launch", "welcome": True, "away": None, "caughtUp": {"turns": 0, "coins": 0}}
        feed, _viewer = feed_for(ready(seq=2, events=[launch, new_player]))
        self.assertEqual(feed.poll().events, (Launch(False, 319), Launch(True, 0)))

    def test_old_unknown_and_broken_events_are_left_out(self):
        events = [work(1, coins=50, age_ms=STALE_MS + 1), work(2, coins=7), {"seq": 3, "at": NOW * 1000, "type": "parade"},
                  {"seq": 4, "at": NOW * 1000, "type": "work", "coins": "many", "turns": 1}, "not an event"]
        feed, _viewer = feed_for(ready(seq=4, events=events))
        self.assertEqual(feed.poll().events, (Work(7, 1),))

    def test_a_source_that_cannot_read_work_is_passed_on_in_one_line(self):
        answer = {**ready(), "source": {"ok": False, "reason": "missing", "message": "T3 Code's database\nwas not found."}}
        feed, _viewer = feed_for(answer)
        self.assertEqual(feed.poll().source, {"ok": False, "message": "T3 Code's database was not found."})


class NotReadyTests(unittest.TestCase):
    def test_a_game_that_is_still_opening_says_so_in_the_viewers_words(self):
        feed, _viewer = feed_for({"ready": False, "message": "Goblin Horde is opening your saved game."})
        self.assertEqual(feed.poll(), Feed(False, "Goblin Horde is opening your saved game."))
        self.assertIsNone(feed.poll().game)

    def test_a_long_or_missing_message_is_cut_or_replaced(self):
        feed, _viewer = feed_for({"ready": False, "message": "x" * 500}, {"ready": False})
        self.assertEqual(len(feed.poll().message), 160)
        self.assertEqual(feed.poll().message, WAITING["opening"])

    def test_polls_slow_down_while_there_is_no_game_and_speed_up_when_it_opens(self):
        feed, _viewer = feed_for({"ready": False, "message": "Opening."}, {"ready": False, "message": "Opening."},
                                 OSError("down"), OSError("down"), OSError("down"), ready())
        delays = [feed.delay_ms]
        for _ in range(5):
            feed.poll()
            delays.append(feed.delay_ms)
        self.assertEqual(delays[:5], [POLL_MS, *BACKOFF_MS[1:], BACKOFF_MS[-1]])
        self.assertEqual(delays[5], BACKOFF_MS[-1], "it stays at the slowest wait")
        self.assertTrue(feed.poll().ready)
        self.assertEqual(feed.delay_ms, POLL_MS)
        self.assertLessEqual(POLL_MS, 900, "the viewer pays every 1000 ms")


class RestartTests(unittest.TestCase):
    def test_a_new_run_of_the_viewer_is_asked_again_from_zero(self):
        fresh = ready(boot="run-b", seq=2, events=[work(1, 5), work(2, 6)])
        feed, viewer = feed_for(ready(boot="run-a", seq=57), {**fresh, "events": []}, fresh, ready(boot="run-b", seq=2))
        feed.poll()
        answer = feed.poll()
        self.assertEqual(viewer.asked, [0, 57, 0], "the answer to after=57 held none of the new run's events")
        self.assertEqual(answer.events, (Work(11, 2),))
        self.assertEqual((feed.boot, feed.seq), ("run-b", 2))
        feed.poll()
        self.assertEqual(viewer.asked[-1], 2)

    def test_a_first_poll_and_a_run_with_no_events_yet_need_no_second_ask(self):
        feed, viewer = feed_for(ready(boot="run-a", seq=0), ready(boot="run-b", seq=1, events=[work(1)]))
        feed.poll()
        self.assertEqual(feed.poll().events, (Work(12, 1),))
        self.assertEqual(viewer.asked, [0, 0])


class FailureTests(unittest.TestCase):
    CASES = {
        "offline": (urllib.error.URLError("refused"), TimeoutError("slow"), ConnectionResetError("gone")),
        "old": (ApiError(404, "Not found", missing=True), AttributeError("pets")),
        "refused": (ApiError(403, "The game is on this computer only."), ApiError(500, "Unable to read the game.")),
        "garbled": (ValueError("Expecting value"), {"ready": True, "boot": "b", "seq": 1}, ["not", "an", "object"],
                    {**ready(), "game": {"state": {}}}, {**ready(), "seq": "seven"}, {**ready(), "boot": 9},
                    {**ready(), "game": game(coins=float("nan"))}, {**ready(), "game": game(recruit={})}),
    }

    def test_every_failure_is_one_plain_sentence_and_never_an_exception(self):
        for kind, answers in self.CASES.items():
            for answer in answers:
                with self.subTest(kind=kind, answer=repr(answer)[:60]):
                    feed, _viewer = feed_for(answer)
                    got = feed.poll()
                    self.assertEqual(got, Feed(False, WAITING[kind]))
                    self.assertEqual(got.message.count("."), 1, "one sentence")
                    self.assertEqual(feed.delay_ms, BACKOFF_MS[1])

    def test_the_viewers_own_error_text_never_reaches_the_message(self):
        feed, _viewer = feed_for(ApiError(500, "SECRET PATH C:\\Users\\someone"))
        self.assertNotIn("SECRET", feed.poll().message)

    def test_an_older_viewer_without_the_game_keeps_being_asked_slowly(self):
        feed, viewer = feed_for(ApiError(404, "Not found", missing=True))
        for _ in range(6):
            self.assertEqual(feed.poll().message, WAITING["old"])
        self.assertEqual(feed.delay_ms, BACKOFF_MS[-1])
        self.assertEqual(len(viewer.asked), 6)

    def test_it_recovers_where_it_left_off_when_the_same_viewer_answers_again(self):
        feed, viewer = feed_for(ready(seq=4, events=[work(4)]), OSError("down"), OSError("down"),
                                ready(seq=5, events=[work(5, 3)]))
        feed.poll()
        self.assertFalse(feed.poll().ready)
        self.assertFalse(feed.poll().ready)
        self.assertEqual(feed.seq, 4, "a failure forgets nothing")
        back = feed.poll()
        self.assertEqual((back.ready, back.events, feed.misses), (True, (Work(3, 1),), 0))
        self.assertEqual(viewer.asked, [0, 4, 4, 4])


class ActionTests(unittest.TestCase):
    def test_a_purchase_answers_ok_with_the_game_after_it(self):
        feed, _viewer = feed_for({"ok": True, "reason": None, "game": game(coins=23, size=6)})
        answer = feed.buy("recruit")
        self.assertEqual((answer["ok"], answer["reason"], answer["game"].coins, answer["game"].size), (True, "", 23, 6))

    def test_a_refused_purchase_names_the_viewers_reason(self):
        feed, _viewer = feed_for({"ok": False, "reason": "coins", "game": game()})
        answer = feed.buy("recruit")
        self.assertEqual((answer["ok"], answer["reason"]), (False, "coins"))

    def test_a_fight_answers_how_it_went(self):
        won = {"won": True, "ratio": 1.31, "first": True, "rewards": {"coins": 54, "scrap": 4, "xp": 40}, "reason": None,
               "game": game(coins=118, cleared=3)}
        feed, _viewer = feed_for(won, {"won": False, "ratio": 0, "first": False, "rewards": {"coins": 0, "scrap": 0, "xp": 0},
                                       "reason": "locked", "game": game()})
        answer = feed.fight(2)
        self.assertEqual((answer["won"], answer["ratio"], answer["rewards"], answer["reason"], answer["game"].cleared),
                         (True, 1.31, {"coins": 54, "scrap": 4, "xp": 40}, "", 3))
        self.assertEqual(feed.fight(9)["reason"], "locked")

    def test_a_viewer_that_does_not_answer_fails_the_action_without_raising(self):
        for failure in (OSError("down"), ApiError(503, "Goblin Horde is opening your saved game."), {"ok": True}, "nonsense"):
            with self.subTest(failure=repr(failure)[:40]):
                feed, _viewer = feed_for(failure)
                self.assertEqual(feed.buy("recruit"), {"ok": False, "reason": FAILED, "game": None})
                fight = feed.fight(0)
                self.assertEqual((fight["won"], fight["ratio"], fight["reason"], fight["game"]), (False, 0.0, FAILED, None))
                self.assertEqual(fight["rewards"], {"coins": 0, "scrap": 0, "xp": 0})


if __name__ == "__main__":
    unittest.main()
