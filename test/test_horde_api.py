"""The widget's one client: it asks only this computer, carries its origin, never uses a proxy, and tells
an older server without a route from a real refusal."""

import json
import os
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

from horde_api import ApiError, HordeApi


class FakeViewer(BaseHTTPRequestHandler):
    """A pretend server.mjs: answers what each test sets in ``routes``; anything else like an old server."""

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

    def test_quit_posts_from_this_computers_origin(self):
        FakeViewer.routes[("POST", "/api/quit")] = (200, {"ok": True})
        self.assertEqual(self.api.quit(), {"ok": True})
        self.assertEqual(FakeViewer.seen, [("POST", "/api/quit", {}, self.api.origin)])
        self.assertEqual(self.api.origin, f"http://127.0.0.1:{self.server.server_address[1]}")

    def test_update_apply_posts_from_this_computers_origin(self):
        FakeViewer.routes[("POST", "/api/update/apply")] = (200, {"applying": True, "version": "0.6.1"})
        self.assertEqual(self.api.update_apply(), {"applying": True, "version": "0.6.1"})
        self.assertEqual(FakeViewer.seen, [("POST", "/api/update/apply", {}, self.api.origin)])

    def test_an_older_server_without_a_route_is_told_apart_from_a_real_404(self):
        with self.assertRaises(ApiError) as raised:
            self.api.pets()
        self.assertTrue(raised.exception.missing)
        FakeViewer.routes[("GET", "/api/pets")] = (404, {"error": "No game is here."})
        with self.assertRaises(ApiError) as raised:
            self.api.pets()
        self.assertFalse(raised.exception.missing)
        self.assertEqual((raised.exception.status, str(raised.exception)), (404, "No game is here."))
        with self.assertRaises(ApiError) as raised:
            self.api.quit()
        self.assertTrue(raised.exception.missing, "a POST an older server has no route for answers 405")

    def test_a_proxy_in_the_environment_never_sees_this_computers_traffic(self):
        FakeViewer.routes[("GET", "/api/pets")] = (200, {"ready": False})
        FakeViewer.routes[("POST", "/api/quit")] = (200, {"ok": True})
        dead = "http://127.0.0.1:9"  # Nothing listens here: a request sent to it would fail.
        with mock.patch.dict(os.environ, {"HTTP_PROXY": dead, "http_proxy": dead, "ALL_PROXY": dead, "NO_PROXY": "", "no_proxy": ""}):
            api = HordeApi(self.server.server_address[1])
            self.assertEqual(api.pets(), {"ready": False})
            api.quit()
        self.assertEqual([entry[1] for entry in FakeViewer.seen], ["/api/pets?after=0", "/api/quit"])
        proxies = [handler for handler in api.opener.handlers if isinstance(handler, urllib.request.ProxyHandler) and handler.proxies]
        self.assertEqual(proxies, [])


if __name__ == "__main__":
    unittest.main()
