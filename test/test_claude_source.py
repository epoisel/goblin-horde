"""Direct Claude Code parties in the Horde window, from synthetic feed members only."""

import time
import unittest

from goblin_motion import goblin_action, member_status
from horde_model import SOURCE_NAMES, build_roster, party_scope, party_tree, source_of

NOW = time.time() * 1000
PARTY = "claude:a1b2c3d4-0000-4000-8000-000000000001"


def claude(member_id, turn="inProgress", *, status=None, activities=None, questions=None, **extra):
    """A Claude Code goblin shaped as the server's Claude reader returns it."""
    return {"id": member_id, "source": "claude", "name": "Claude · goblin-horde · ab12", "nickname": "Claude Code",
            "parentThreadId": PARTY, "cwd": "/work/goblin-horde",
            "status": status or ("active" if turn == "inProgress" else "completed"), "updatedAt": NOW - 1000,
            "attention": {"inProgress": "working", "failed": "failed"}.get(turn, "quiet"),
            "turnStates": [{"id": "turn-1", "status": turn, "questions": questions or [], "error": ""}],
            "activities": activities if activities is not None else [
                {"id": "claude-1", "kind": "tool", "title": "Read a local file",
                 "description": "Opened a local file to inspect its contents.", "status": "inProgress"}],
            **extra}


class ClaudeSourceTest(unittest.TestCase):
    def test_reading_a_file_animates_investigation(self):
        self.assertEqual(goblin_action(claude("claude-agent:s"), now_ms=NOW), "search")
        self.assertEqual(member_status(claude("claude-agent:s")).word, "SEARCHING")

    def test_needs_you_and_failure_map_to_goblin_states(self):
        self.assertEqual(goblin_action(claude("m", status="waiting", needsInput=True), needs_input=True), "waiting")
        self.assertEqual(member_status(claude("m", needsInput=True)).word, "NEEDS YOU")
        failed = claude("m", "failed", status="failed", activities=[
            {"id": "x", "kind": "update", "title": "Stopped", "description": "Claude hit a server error.", "status": "failed"}])
        self.assertEqual(member_status(failed).word, "FAILED")

    def test_a_session_and_its_subagent_are_one_party_with_the_session_first(self):
        main = claude("claude-agent:s")
        child = claude("claude-agent:s:agent-1", childOf="claude-agent:s", nickname="Explore subagent")
        self.assertEqual(party_scope(main), PARTY)
        self.assertEqual(party_scope(child), PARTY)
        self.assertEqual(source_of({"id": PARTY}), "claude")
        self.assertEqual(SOURCE_NAMES[source_of(child)], "Claude Code")
        self.assertEqual([(actor["id"], depth) for actor, depth in party_tree([child, main], PARTY)],
                         [("claude-agent:s", 0), ("claude-agent:s:agent-1", 1)])
        catalog = [{"id": PARTY, "name": "Claude · goblin-horde · ab12", "source": "claude", "updatedAt": NOW}]
        rows, counts = build_roster([child, main], now_ms=NOW, catalog=catalog)
        banner = next(row for row in rows if row.kind == "party")
        self.assertEqual((banner.party, banner.title), (PARTY, "Claude · goblin-horde · ab12"))
        self.assertEqual([row.title for row in rows if row.kind == "agent"], ["Lead · Claude Code", "Explore subagent"])
        self.assertEqual(counts.working, 2)


if __name__ == "__main__":
    unittest.main()
