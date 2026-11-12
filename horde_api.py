"""The widget's one door to the local server (server.mjs).

Every request the pet game makes goes through HordeApi, so a change to the server's routes is a
change to this file alone. Calls block: the widget runs them on its worker threads and hands the
answers back to Tk. A route an older server does not have (404, or 405 for a POST it treats as
read-only) comes back as an ApiError marked ``missing``, so the game can say the server is too old.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request

# The server answers a GET it has no route for with 404 "Not found" (its static-file fallback), and
# any POST it has no route for with 405 "Read-only viewer". A 404 with other words is a real answer
# from a route that exists.
UNKNOWN_ROUTE = {404: ("Not found", ""), 405: None}


class ApiError(RuntimeError):
    """A request the server refused or could not answer. ``status`` is 0 when nothing answered."""

    def __init__(self, status: int, message: str, data: dict | None = None, missing: bool = False) -> None:
        super().__init__(message)
        self.status = status
        self.data = data or {}
        self.missing = missing  # The server has no such route: it is older than this widget.


def unknown_route(status: int, data: dict) -> bool:
    if status not in UNKNOWN_ROUTE:
        return False
    words = UNKNOWN_ROUTE[status]
    return words is None or str(data.get("error") or "") in words


def refusal(error: urllib.error.HTTPError) -> ApiError:
    """The server's refusal with its own words, when it gave any."""
    try:
        data = json.load(error)
    except (ValueError, AttributeError, OSError):
        data = {}
    data = data if isinstance(data, dict) else {}
    message = str(data.get("error") or "") or f"The viewer answered {error.code}."
    return ApiError(error.code, message, data, missing=unknown_route(error.code, data))


def local_opener() -> urllib.request.OpenerDirector:
    """An opener that never uses a proxy. urllib otherwise sends 127.0.0.1 traffic through
    HTTP_PROXY (or the system proxy), which would hand the game to the proxy, or fail outright when
    it cannot reach this computer's server."""
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


class HordeApi:
    """Reads and controls for one server on 127.0.0.1:<port>. Only this computer is ever asked."""

    def __init__(self, port: int) -> None:
        self.port = int(port)
        self.origin = f"http://127.0.0.1:{self.port}"
        self.opener = local_opener()

    def get(self, path: str, timeout: float = 10) -> dict:
        try:
            with self.opener.open(f"{self.origin}{path}", timeout=timeout) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise refusal(error) from None

    def post(self, path: str, data: dict | None = None, timeout: float = 15) -> dict:
        request = urllib.request.Request(f"{self.origin}{path}", method="POST",
                                         data=json.dumps(data or {}).encode("utf-8"),
                                         headers={"Content-Type": "application/json", "Origin": self.origin})
        try:
            with self.opener.open(request, timeout=timeout) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise refusal(error) from None

    def pets(self, after: int = 0) -> dict:
        """The game: coins, horde, prices, and the events numbered above ``after``. ``boot`` names the
        server's run: when it changes, event numbers began again at 1, so ask again from 0."""
        return self.get(f"/api/pets?after={int(after)}")

    def pets_buy(self, kind: str) -> dict:
        """Buy one recruit, level, gear tier, or upgrade level; ``ok`` says whether it went through."""
        return self.post("/api/pets/buy", {"kind": kind})

    def pets_fight(self, boss: int) -> dict:
        """Send the whole horde against boss number ``boss``; ``won`` says how it went."""
        return self.post("/api/pets/fight", {"boss": boss})

    def quit(self) -> dict:
        """Ask the server to stop: Quit Goblin Horde."""
        return self.post("/api/quit")

    def update_apply(self) -> dict:
        """Ask the server to put the verified update it keeps in place and restart: {"applying", "version"}."""
        return self.post("/api/update/apply")
