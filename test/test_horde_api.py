"""The window's one client: routes, the Origin header, older viewers without a route, and the demo world."""

import json
import os
import threading
import time
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

from horde_api import ApiError, HordeApi
from horde_demo import SETS, DemoApi, DemoWorld
from horde_model import ask_of, build_roster


class FakeViewer(BaseHTTPRequestHandler):
    """A pretend server.mjs: answers what each test sets in ``routes``; anything else like an old viewer."""

    routes: dict = {}
    seen: list = []

    def log_message(self, *_args):
        pass

    def answer(self, status: int, data: dict) -> None:
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.seen.append(("GET", self.path, None, self.headers.get("Origin")))
        route = self.routes.get(("GET", self.path.split("?")[0]))
        self.answer(*(route(self.path) if callable(route) else route or (404, {"error": "Not found"})))

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        data = json.loads(self.rfile.read(length) or b"{}")
        self.seen.append(("POST", self.path, data, self.headers.get("Origin")))
        route = self.routes.get(("POST", self.path))
        self.answer(*(route or (405, {"error": "Read-only viewer"})))


class ClientTests(unittest.TestCase):
    def setUp(self):
        FakeViewer.routes = {}
        FakeViewer.seen = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeViewer)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.api = HordeApi(self.server.server_address[1])

    def test_reads_go_to_this_computer_and_posts_carry_its_origin(self):
        FakeViewer.routes[("GET", "/api/scene")] = (200, {"agents": [{"id": "a"}]})
        FakeViewer.routes[("POST", "/api/dismiss")] = (200, {"ask": None})
        self.assertEqual(self.api.scene()["agents"], [{"id": "a"}])
        self.api.dismiss("claude-agent:s", "k1")
        method, path, data, origin = FakeViewer.seen[-1]
        self.assertEqual((method, path, data), ("POST", "/api/dismiss", {"id": "claude-agent:s", "key": "k1"}))
        self.assertEqual(origin, self.api.origin)
        self.assertEqual(FakeViewer.seen[0][1], "/api/scene?id=all")

    def test_an_older_viewer_without_a_route_is_remembered_but_a_real_404_is_not(self):
        with self.assertRaises(ApiError) as raised:
            self.api.agent("orca-agent:p1")
        self.assertTrue(raised.exception.missing)
        self.assertFalse(self.api.available("/api/agent"))
        self.assertEqual(FakeViewer.seen[0][1], "/api/agent?id=orca-agent%3Ap1")
        FakeViewer.routes[("GET", "/api/threads")] = (404, {"error": "That chat is unavailable."})
        with self.assertRaises(ApiError) as raised:
            self.api.threads()
        self.assertFalse(raised.exception.missing)
        self.assertTrue(self.api.available("/api/threads"))
        with self.assertRaises(ApiError) as raised:
            self.api.open_agent("chat-1")
        self.assertTrue(raised.exception.missing, "a POST an older viewer has no route for answers 405")
        self.assertFalse(self.api.available("/api/open"))

    def test_messages_fall_back_to_codex_replies_on_an_older_viewer(self):
        FakeViewer.routes[("POST", "/api/reply")] = (200, {"threadId": "chat-1"})
        self.api.message("chat-1", "Leave them as they are.")
        self.assertEqual([entry[1] for entry in FakeViewer.seen], ["/api/message", "/api/reply"])
        self.assertEqual(FakeViewer.seen[-1][2], {"threadId": "chat-1", "message": "Leave them as they are."})
        FakeViewer.seen.clear()
        self.api.message("chat-1", "Again")
        self.assertEqual([entry[1] for entry in FakeViewer.seen], ["/api/reply"], "the missing route is not asked again")

    def test_refusals_keep_the_viewers_words(self):
        FakeViewer.routes[("POST", "/api/message")] = (409, {"error": "This chat is open in Codex."})
        with self.assertRaises(ApiError) as raised:
            self.api.message("chat-1", "hi")
        self.assertEqual((raised.exception.status, str(raised.exception)), (409, "This chat is open in Codex."))
        self.assertFalse(raised.exception.missing)

    def test_a_proxy_in_the_environment_never_sees_this_computers_traffic(self):
        FakeViewer.routes[("GET", "/api/scene")] = (200, {"agents": []})
        FakeViewer.routes[("POST", "/api/dismiss")] = (200, {"ask": None})
        dead = "http://127.0.0.1:9"  # Nothing listens here: a request sent to it would fail.
        with mock.patch.dict(os.environ, {"HTTP_PROXY": dead, "http_proxy": dead, "ALL_PROXY": dead, "NO_PROXY": "", "no_proxy": ""}):
            api = HordeApi(self.server.server_address[1])
            self.assertEqual(api.scene(), {"agents": []})
            api.dismiss("claude-agent:s", "k1")
        self.assertEqual([entry[1] for entry in FakeViewer.seen], ["/api/scene?id=all", "/api/dismiss"])
        proxies = [handler for handler in api.opener.handlers if isinstance(handler, urllib.request.ProxyHandler) and handler.proxies]
        self.assertEqual(proxies, [])

    def test_answers_and_watch_lists(self):
        FakeViewer.routes[("POST", "/api/respond")] = (200, {"answered": True})
        FakeViewer.routes[("POST", "/api/watch")] = (200, {"watched": ["chat-b", 3, "chat-a"]})
        self.api.respond("chat-1", "req-7", decision="accept")
        self.assertEqual(FakeViewer.seen[-1][2], {"threadId": "chat-1", "requestId": "req-7", "decision": "accept"})
        self.api.respond("chat-1", "req-8", answers={"q1": "Postgres"})
        self.assertEqual(FakeViewer.seen[-1][2], {"threadId": "chat-1", "requestId": "req-8", "answers": {"q1": "Postgres"}})
        self.assertEqual(self.api.watch("chat-b", True), ["chat-b", "3", "chat-a"])
        self.assertEqual(self.api.viewer_url("orca:ws 1"), f"{self.api.origin}/?thread=orca%3Aws%201")


class DemoTests(unittest.TestCase):
    def test_every_demo_set_builds_a_valid_scene(self):
        for kind in SETS:
            with self.subTest(kind=kind):
                api = DemoApi(kind)
                scene = api.scene()
                rows, _counts = build_roster(scene["agents"], catalog=api.threads()["threads"])
                self.assertTrue(rows)
                for actor in scene["agents"]:
                    detail = api.agent(actor["id"])
                    self.assertEqual(detail["agent"]["id"], actor["id"])
                    self.assertIn("controls", detail["agent"])

    def test_the_default_demo_covers_every_kind_of_goblin(self):
        world = DemoWorld("default")
        kinds = {(ask_of(actor) or {}).get("kind") for actor in world.actors}
        self.assertLessEqual({"permission", "question", "reply", "approval"}, kinds)
        self.assertTrue(any(actor.get("waitingOn") for actor in world.actors))
        self.assertTrue(any(actor.get("attention") == "failed" for actor in world.actors))
        self.assertTrue(any(actor.get("childOf") for actor in world.actors), "a Claude subagent")
        self.assertTrue(any(actor.get("joined") for actor in world.actors), "Orca workers joined to a Codex chat")
        self.assertTrue(world.requests, "a Codex approval answerable with /api/respond")
        names = " ".join(str(actor.get("name")) for actor in world.actors)
        self.assertNotRegex(names, r"\\Users\\|/Users/|/home/")

    def test_the_demo_answers_controls_without_touching_anything(self):
        api = DemoApi("default")
        api.dismiss("claude-agent:demo-login-fix", "demo-ask-login")
        actor = next(item for item in api.scene()["agents"] if item["id"] == "claude-agent:demo-login-fix")
        self.assertIsNone(actor["ask"])
        self.assertEqual(actor["dismissedAsk"]["key"], "demo-ask-login")
        api.respond("demo-chat-image-pipeline", "demo-request-7", decision="accept")
        self.assertFalse(api.scene()["requests"])
        api.message("demo-chat-release-notes", "Convert them, please.")
        trail = api.agent("demo-chat-release-notes")["trail"]
        self.assertEqual(trail[0]["title"], "You: Convert them, please.")
        with self.assertRaises(ApiError) as raised:
            api.open_agent("demo-chat-release-notes")
        self.assertEqual(raised.exception.status, 409)
        self.assertEqual(api.watch("chat-x", True)[0], "chat-x")
        with self.assertRaises(ApiError):
            api.phone(True)

    def test_working_goblins_stay_fresh_so_they_keep_acting(self):
        world = DemoWorld("default", now_ms=1_000_000_000_000)
        later = 1_000_000_000_000 + 600_000
        scene = world.scene(later)
        writer = next(actor for actor in scene["agents"] if actor["id"] == "orca-agent:demo-pane-writer")
        self.assertGreater(writer["updatedAt"], later - 5_000)
        self.assertLess(time.time() * 1000 - DemoWorld("default").t, 5_000)


if __name__ == "__main__":
    unittest.main()
