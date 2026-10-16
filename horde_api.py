"""The Horde window's one door to the local viewer (server.mjs).

Every request the desktop window makes goes through HordeApi, so a change to the viewer's routes is
a change to this file alone. Calls block: the window runs them on its worker threads and hands the
answers back to Tk. A route an older viewer does not have (404, or 405 for a POST it treats as
read-only) is remembered in ``missing``, so the window can hide what depends on it instead of
asking again on every poll.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

# The viewer answers a GET it has no route for with 404 "Not found" (its static-file fallback), and
# any POST it has no route for with 405 "Read-only viewer". A 404 with other words is a real answer
# from a route that exists, such as "That agent is unavailable."
UNKNOWN_ROUTE = {404: ("Not found", ""), 405: None}


class ApiError(RuntimeError):
    """A request the viewer refused or could not answer. ``status`` is 0 when nothing answered."""

    def __init__(self, status: int, message: str, data: dict | None = None, missing: bool = False) -> None:
        super().__init__(message)
        self.status = status
        self.data = data or {}
        self.missing = missing  # The viewer has no such route: it is older than this window.


def unknown_route(status: int, data: dict) -> bool:
    if status not in UNKNOWN_ROUTE:
        return False
    words = UNKNOWN_ROUTE[status]
    return words is None or str(data.get("error") or "") in words


def route(path: str) -> str:
    return path.split("?", 1)[0]


def local_opener() -> urllib.request.OpenerDirector:
    """An opener that never uses a proxy. urllib otherwise sends 127.0.0.1 traffic through
    HTTP_PROXY (or the system proxy), which would hand every scene, agent detail, and reply to
    the proxy, or fail outright when it cannot reach this computer's viewer."""
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


class HordeApi:
    """Reads and controls for one viewer on 127.0.0.1:<port>. Only this computer is ever asked."""

    def __init__(self, port: int) -> None:
        self.port = int(port)
        self.origin = f"http://127.0.0.1:{self.port}"
        self.missing: set[str] = set()
        self.opener = local_opener()

    # Transport ---------------------------------------------------------------------------------
    def available(self, path: str) -> bool:
        """False once this route answered 404/405: the viewer is older than the window."""
        return route(path) not in self.missing

    def _fail(self, path: str, error: urllib.error.HTTPError) -> ApiError:
        try:
            data = json.load(error)
        except (ValueError, AttributeError, OSError):
            data = {}
        data = data if isinstance(data, dict) else {}
        missing = unknown_route(error.code, data)
        if missing:
            self.missing.add(route(path))
        message = str(data.get("error") or "") or f"The viewer answered {error.code}."
        return ApiError(error.code, message, data, missing=missing)

    def get(self, path: str, timeout: float = 10) -> dict:
        try:
            with self.opener.open(f"{self.origin}{path}", timeout=timeout) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise self._fail(path, error) from None

    def post(self, path: str, data: dict | None = None, timeout: float = 15) -> dict:
        request = urllib.request.Request(f"{self.origin}{path}", method="POST",
                                         data=json.dumps(data or {}).encode("utf-8"),
                                         headers={"Content-Type": "application/json", "Origin": self.origin})
        try:
            with self.opener.open(request, timeout=timeout) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise self._fail(path, error) from None

    # Reads -------------------------------------------------------------------------------------
    def scene(self) -> dict:
        """Every party the viewer follows (GET /api/scene?id=all)."""
        return self.get("/api/scene?id=all", timeout=20)

    def agent(self, actor_id: str) -> dict:
        """One agent in full: mission, plan, now, what it said, its trail, files, terminal screen."""
        return self.get(f"/api/agent?id={urllib.parse.quote(str(actor_id), safe='')}", timeout=10)

    def capabilities(self) -> dict:
        return self.get("/api/capabilities")

    def threads(self) -> dict:
        """The chat catalog: every Codex chat, Orca workspace, and Claude Code session it knows."""
        return self.get("/api/threads", timeout=20)

    def diagnostics(self) -> dict:
        return self.get("/api/diagnostics")

    # Controls ----------------------------------------------------------------------------------
    def dismiss(self, actor_id: str, key: str) -> dict:
        """Stop alerting about this ask; a new ask (another key) alerts again."""
        return self.post("/api/dismiss", {"id": actor_id, "key": key})

    def open_agent(self, actor_id: str) -> dict:
        """Open the agent in its own app (Codex, Orca, Claude)."""
        return self.post("/api/open", {"id": actor_id})

    def open_app(self, agent_id: str = "", task_id: str = "", reuse: bool = False) -> dict:
        """Open the task view in its own window, on this agent's task (the viewer finds it), or a task.
        With ``reuse`` the window is already open: the viewer only tells it which task to show."""
        data: dict = {}
        if agent_id:
            data["agentId"] = agent_id
        if task_id:
            data["taskId"] = task_id
        if reuse:
            data["reuse"] = True
        return self.post("/api/app/open", data)

    def message(self, actor_id: str, text: str) -> dict:
        """Send words to an agent: a Codex reply, or text typed into an Orca terminal. A viewer
        without /api/message still takes Codex replies through /api/reply."""
        if self.available("/api/message"):
            try:
                return self.post("/api/message", {"id": actor_id, "text": text})
            except ApiError as error:
                if not error.missing:
                    raise
        return self.post("/api/reply", {"threadId": actor_id, "message": text})

    def respond(self, thread_id: str, request_id: str, *, decision: str | None = None,
                answers: dict | None = None) -> dict:
        """Answer a Codex app-server request: approve or decline, or answer its questions."""
        data: dict = {"threadId": thread_id, "requestId": request_id}
        if decision is not None:
            data["decision"] = decision
        if answers is not None:
            data["answers"] = answers
        return self.post("/api/respond", data)

    def join(self, party: str, chat: str | None) -> dict:
        """Join a party to a chat, keep it separate (""), or go back to automatic (None)."""
        return self.post("/api/join", {"party": party, "chat": chat})

    def watch(self, party: str, watched: bool) -> list[str]:
        """Watch a chat (always read it) or stop; returns the saved watch list."""
        result = self.post("/api/watch", {"id": party, "watched": watched}, timeout=10)
        return [str(item) for item in result.get("watched") or []]

    def reconnect(self) -> dict:
        return self.post("/api/reconnect")

    def connect_claude(self) -> dict:
        return self.post("/api/connect-claude")

    def autostart(self, enabled: bool) -> dict:
        return self.post("/api/autostart", {"enabled": enabled})

    def phone(self, enabled: bool) -> dict:
        return self.post("/api/phone", {"enabled": enabled})

    def phone_reset(self) -> dict:
        return self.post("/api/phone/reset")

    def quit(self) -> dict:
        return self.post("/api/quit")

    # Links -------------------------------------------------------------------------------------
    def viewer_url(self, party: str = "") -> str:
        """The browser viewer, opened on one party when given."""
        return f"{self.origin}/" + (f"?thread={urllib.parse.quote(party, safe='')}" if party else "")
