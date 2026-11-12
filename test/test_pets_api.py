"""The widget's game calls: the routes they ask, the JSON they send, and an older viewer without the game."""

import threading
import unittest
from http.server import ThreadingHTTPServer

from horde_api import ApiError, HordeApi
from test_horde_api import FakeViewer


class PetsClientTests(unittest.TestCase):
    def setUp(self):
        FakeViewer.routes = {}
        FakeViewer.seen = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeViewer)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.api = HordeApi(self.server.server_address[1])

    def test_the_game_is_read_from_the_last_event_number_shown(self):
        game = {"ready": True, "seq": 7, "events": [], "game": {"state": {"wallet": {"coins": 64}}}, "source": {"ok": True}}
        FakeViewer.routes[("GET", "/api/pets")] = (200, game)
        self.assertEqual(self.api.pets(), game)
        self.assertEqual(self.api.pets(after=7), game)
        self.assertEqual([entry[:2] for entry in FakeViewer.seen], [("GET", "/api/pets?after=0"), ("GET", "/api/pets?after=7")])

    def test_a_purchase_and_a_fight_post_json_from_this_computers_origin(self):
        FakeViewer.routes[("POST", "/api/pets/buy")] = (200, {"ok": True, "reason": None, "game": {}})
        FakeViewer.routes[("POST", "/api/pets/fight")] = (200, {"won": False, "ratio": 0.9, "first": True, "rewards": {}, "reason": None, "game": {}})
        self.assertTrue(self.api.pets_buy("recruit")["ok"])
        self.assertEqual(FakeViewer.seen[-1], ("POST", "/api/pets/buy", {"kind": "recruit"}, self.api.origin))
        self.assertFalse(self.api.pets_fight(0)["won"])
        self.assertEqual(FakeViewer.seen[-1], ("POST", "/api/pets/fight", {"boss": 0}, self.api.origin))

    def test_an_older_viewer_without_the_game_is_told_apart(self):
        calls = {"/api/pets": self.api.pets, "/api/pets/buy": lambda: self.api.pets_buy("recruit"), "/api/pets/fight": lambda: self.api.pets_fight(0)}
        for path, call in calls.items():
            with self.subTest(path=path):
                with self.assertRaises(ApiError) as raised:
                    call()
                self.assertTrue(raised.exception.missing)

    def test_a_refusal_keeps_the_viewers_words_and_is_not_a_missing_route(self):
        FakeViewer.routes[("GET", "/api/pets")] = (403, {"error": "The game is on this computer only."})
        FakeViewer.routes[("POST", "/api/pets/buy")] = (503, {"error": "Goblin Horde is opening your saved game."})
        FakeViewer.routes[("POST", "/api/pets/fight")] = (400, {"error": "Choose a boss by its number, a whole number from 0 up."})
        refused = {"/api/pets": (self.api.pets, 403), "/api/pets/buy": (lambda: self.api.pets_buy("recruit"), 503), "/api/pets/fight": (lambda: self.api.pets_fight(-1), 400)}
        for path, (call, status) in refused.items():
            with self.subTest(path=path):
                with self.assertRaises(ApiError) as raised:
                    call()
                self.assertEqual((raised.exception.status, str(raised.exception)), (status, FakeViewer.routes[("GET" if path == "/api/pets" else "POST", path)][1]["error"]))
                self.assertFalse(raised.exception.missing)


if __name__ == "__main__":
    unittest.main()
