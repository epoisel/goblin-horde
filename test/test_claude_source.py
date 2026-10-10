"""Direct Claude Code parties in the desktop goblins, from synthetic feed members only."""

import time
import unittest

from goblin_motion import goblin_action, member_status
from goblin_parting import clean_note, ending, note_lines
from party_layout import launchpad_board, party_scope, source_label
from stream_windows import workflow_for

NOW = time.time() * 1000
PARTY = "claude:a1b2c3d4-0000-4000-8000-000000000001"


def claude(member_id, turn="inProgress", *, status=None, activities=None, questions=None, **extra):
    """A Claude Code goblin shaped as the server's Claude reader returns it."""
    return {"id": member_id, "source": "claude", "name": "Claude · goblin-horde · ab12", "nickname": "Claude Code",
            "parentThreadId": PARTY, "cwd": "/work/goblin-horde",
            "status": status or ("active" if turn == "inProgress" else "completed"), "updatedAt": NOW - 1000,
            "turnStates": [{"id": "turn-1", "status": turn, "questions": questions or [], "error": ""}],
            "activities": activities if activities is not None else [
                {"id": "claude-1", "kind": "tool", "title": "Read a local file",
                 "description": "Opened a local file to inspect its contents.", "status": "inProgress"}],
            **extra}


class ClaudeSourceTest(unittest.TestCase):
    def test_reading_a_file_animates_investigation(self):
        self.assertEqual(goblin_action(claude("claude-agent:s"), now_ms=NOW), "search")
        self.assertEqual(member_status(claude("claude-agent:s")).word, "SEARCHING")

    def test_needs_you_failure_and_finish_map_to_goblin_states(self):
        self.assertEqual(goblin_action(claude("m", status="waiting", needsInput=True), needs_input=True), "waiting")
        self.assertEqual(member_status(claude("m", needsInput=True)).word, "NEEDS YOU")
        failed = claude("m", "failed", status="failed", activities=[
            {"id": "x", "kind": "update", "title": "Stopped", "description": "Claude hit a server error.", "status": "failed"}])
        self.assertEqual(member_status(failed).word, "FAILED")
        self.assertEqual(ending(claude("m", "completed")), "finished")
        self.assertEqual(ending(claude("m", "interrupted", status="ended")), "stopped")
        self.assertIsNone(ending(claude("m", "stale", status="stale")))
        self.assertIsNone(ending(claude("m")))

    def test_party_grouping_and_labels(self):
        main = claude("claude-agent:s")
        child = claude("claude-agent:s:agent-1", childOf="claude-agent:s", nickname="Explore subagent")
        self.assertEqual(party_scope(main), PARTY)
        self.assertEqual(party_scope(child), PARTY)
        self.assertEqual(workflow_for(main), workflow_for(child))
        self.assertEqual(workflow_for(main)[1], "Claude · goblin-horde")
        self.assertEqual(source_label({"source": "claude"}), "CLAUDE")
        self.assertEqual(source_label({}, PARTY), "CLAUDE")
        self.assertEqual(source_label({"source": "orca"}), "ORCA")
        self.assertEqual(source_label({"source": "codex"}), "CODEX")
        catalog = [{"id": PARTY, "name": "Claude · goblin-horde · ab12", "source": "claude", "updatedAt": NOW, "agentCount": 2}]
        active, _recent, _older = launchpad_board([main, child], catalog, now_ms=NOW)
        self.assertEqual([(card.id, card.source, len(card.members)) for card in active], [(PARTY, "CLAUDE", 2)])

    def test_parting_note_names_claude(self):
        note = clean_note({"party": PARTY, "id": "claude-agent:s:agent-1", "name": "Explore subagent", "source": "claude",
                           "outcome": "finished", "at": NOW}, NOW)
        self.assertEqual(note["source"], "claude")
        self.assertTrue(note_lines(note, "Explore subagent", NOW)[1].startswith("CLAUDE · "))


if __name__ == "__main__":
    unittest.main()
