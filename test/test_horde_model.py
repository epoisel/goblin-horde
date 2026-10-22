"""What the Horde window shows, decided without a display: roster sections and order, the line under
each goblin, the strip, the detail sections, timers, sources, search, and settings."""

import time
import unittest

from goblin_motion import goblin_action
from horde_demo import DemoWorld
from horde_model import roster_titles  # noqa: E402 - beside the long list below
from horde_model import (DONE, FAILED, NEEDS, WORKING, RosterMemory, actor_class, age_short, ago, ask_of, build_roster,
                         clamp_window, coverage_note, default_selection, detail_from_actor, detail_now, detail_sections,
                         display_name, duration, elapsed, final_question, join_reason, model_badge, motion_view,
                         move_selection, now_line, party_tree, progress_label, quiet_for, reachable, read_settings,
                         row_line, search_sources, settings_to_save, source_chips, sources_hint, status_chip,
                         strip_items, strip_label, strip_labels, strip_tooltip, trail_result, waiting_steps,
                         with_public_steps)

# Noon, local time, so "today" never straddles midnight in a test.
NOW = time.mktime((2026, 10, 14, 12, 0, 0, 0, 0, -1)) * 1000
MIN = 60_000


def agent(ident, **fields):
    base = {"id": ident, "name": ident, "source": "codex", "status": "active", "attention": "working",
            "updatedAt": NOW - MIN, "activities": [], "turnStates": [{"status": "inProgress", "questions": []}],
            "ask": None, "waitingOn": None, "now": None, "progress": None}
    base.update(fields)
    return base


def ask(text="Allow PowerShell to run this?", at=NOW - 5 * MIN, key="k1", **fields):
    return {"kind": "permission", "text": text, "at": at, "key": key, "answerHere": None, **fields}


class AskTests(unittest.TestCase):
    def test_a_viewer_that_sends_ask_decides(self):
        self.assertEqual(ask_of(agent("a", ask=ask()))["text"], "Allow PowerShell to run this?")
        # null means nothing to ask, even with the old needsInput flag still set.
        self.assertIsNone(ask_of(agent("a", ask=None, needsInput=True, attention="needs")))

    def test_an_older_viewer_still_shows_the_real_question(self):
        legacy = {"id": "chat-1", "source": "codex", "attention": "needs", "updatedAt": NOW,
                  "turnStates": [{"status": "completed", "questions": ["Should I keep the old format?"]}]}
        found = ask_of(legacy)
        self.assertEqual(found["text"], "Should I keep the old format?")
        self.assertTrue(found["legacy"])
        self.assertIsNone(found["answerHere"])
        approval = ask_of({"id": "chat-2", "source": "codex", "needsInput": True, "updatedAt": NOW})
        self.assertIn("approve", approval["text"])

    def test_orca_waiting_and_subagent_questions_are_never_for_the_person(self):
        orca = {"id": "orca-agent:p1", "source": "orca", "status": "waiting", "attention": "waiting", "updatedAt": NOW}
        self.assertIsNone(ask_of(orca))
        self.assertEqual(actor_class(orca), DONE)
        claude_child = {"id": "claude-agent:s:a", "source": "claude", "childOf": "claude-agent:s",
                        "turnStates": [{"status": "completed", "questions": ["Is this what you wanted?"]}]}
        self.assertIsNone(ask_of(claude_child))
        codex_child = {"id": "child-thread", "source": "codex", "parentThreadId": "parent-thread",
                       "turnStates": [{"status": "completed", "questions": ["Done?"]}]}
        self.assertIsNone(ask_of(codex_child))
        quiet = {"id": "chat-3", "source": "codex", "attention": "quiet", "needsInput": True}
        self.assertIsNone(ask_of(quiet), "a question the feed calls quiet is history")


class ClassAndLineTests(unittest.TestCase):
    def test_classes(self):
        self.assertEqual(actor_class(agent("a", ask=ask())), NEEDS)
        self.assertEqual(actor_class(agent("a", attention="failed")), FAILED)
        self.assertEqual(actor_class(agent("a", waitingOn={"who": "coordinator", "at": NOW})), WORKING)
        self.assertEqual(actor_class(agent("a", attention="quiet", status="idle")), DONE)
        # attention "needs" without an ask was dismissed: it no longer needs the person.
        self.assertEqual(actor_class(agent("a", attention="needs")), DONE)
        self.assertEqual(actor_class({"id": "old", "status": "active"}), WORKING, "no attention: local status")

    def test_line_choice_is_ask_then_waiting_then_failure_then_now(self):
        failed_step = {"kind": "command", "title": "Ran a local command", "detail": "npm test", "status": "failed",
                       "exitCode": 1}
        now = {"kind": "command", "title": "Running npm test", "startedAt": NOW}
        waiting = {"who": "coordinator", "text": "Include archived rows?", "at": NOW}
        everything = agent("a", ask=ask(text="May I?"), waitingOn=waiting, now=now, attention="failed",
                           activities=[failed_step])
        self.assertEqual(row_line(everything), ("ask", "May I?"))
        everything["ask"] = None
        self.assertEqual(row_line(everything), ("waiting", "Asked the coordinator: Include archived rows?"))
        everything["waitingOn"] = None
        self.assertEqual(row_line(everything), ("failed", "Failed: npm test · exit 1"))
        everything["attention"] = "working"
        self.assertEqual(row_line(everything), ("now", "Running npm test"))
        everything["now"] = None
        everything["activities"] = [{"kind": "update", "title": "Update", "description": "Reading   the  code."}]
        self.assertEqual(row_line(everything), ("now", "Reading the code."))
        self.assertEqual(row_line(agent("done", attention="quiet", status="idle")), ("done", "Done."))
        still_working = agent("w", activities=[{"kind": "command", "title": "Ran checks", "status": "failed"}])
        self.assertEqual(row_line(still_working), ("failed", "Failed: Ran checks"), "a failed newest step shows in coral")
        self.assertEqual(row_line(agent("p", waitingOn={"who": "parent"})).text, "Waiting on its parent agent")

    def test_progress_and_names(self):
        self.assertEqual(progress_label(agent("a", progress={"done": 3, "total": 7})), "3/7")
        self.assertEqual(progress_label(agent("a", progress={"done": 9, "total": 7})), "7/7")
        self.assertEqual(progress_label(agent("a", progress={"done": 0, "total": 0})), "")
        self.assertEqual(progress_label(agent("a", progress="bad")), "")
        main = {"id": "claude-agent:s", "source": "claude", "name": "Fix the login test", "nickname": "Claude Code"}
        self.assertEqual(display_name(main), "Fix the login test")
        child = {"id": "claude-agent:s:a", "source": "claude", "name": "x", "nickname": "Explore subagent", "childOf": "c"}
        self.assertEqual(display_name(child), "Explore subagent")
        self.assertEqual(display_name(main, {"claude-agent:s": "Scout"}), "Scout · Fix the login test")

    def test_the_bell_rings_only_for_a_real_ask(self):
        idle_orca = {"id": "orca-agent:p", "source": "orca", "status": "waiting", "attention": "waiting",
                     "activities": [{"kind": "update", "title": "Update", "description": "Done."}]}
        self.assertEqual(goblin_action(idle_orca), "waiting", "the raw actor would wave the bell")
        self.assertNotEqual(goblin_action(motion_view(idle_orca, actor_class(idle_orca))), "waiting")
        asking = agent("a", ask=ask())
        self.assertEqual(goblin_action(motion_view(asking, NEEDS), needs_input=True), "waiting")
        child = {"id": "c", "source": "claude", "childOf": "m", "attention": "working", "status": "active",
                 "turnStates": [{"status": "completed", "questions": ["Anything else?"]}]}
        self.assertNotEqual(goblin_action(motion_view(child, actor_class(child))), "waiting")


class PartyTreeTests(unittest.TestCase):
    def test_lead_first_and_members_under_whoever_they_report_to(self):
        lead = agent("chat-1")
        worker = agent("orca-agent:w1", source="orca", parentThreadId="chat-1", pane="w1")
        helper = agent("orca-agent:w2", source="orca", parentThreadId="chat-1", parentPane="w1", pane="w2")
        child = agent("chat-1-child", parentThreadId="chat-1")
        tree = party_tree([lead, worker, helper, child], "chat-1")
        self.assertEqual([(actor["id"], depth) for actor, depth in tree],
                         [("chat-1", 0), ("orca-agent:w1", 1), ("orca-agent:w2", 2), ("chat-1-child", 1)])

    def test_claude_subagents_sit_under_their_session_and_orca_workers_under_their_pane(self):
        main = agent("claude-agent:s", source="claude", parentThreadId="claude:s")
        sub = agent("claude-agent:s:a", source="claude", parentThreadId="claude:s", childOf="claude-agent:s")
        self.assertEqual([(a["id"], d) for a, d in party_tree([sub, main], "claude:s")],
                         [("claude-agent:s", 0), ("claude-agent:s:a", 1)])
        lead = agent("orca-agent:l", source="orca", parentThreadId="orca:ws", pane="l")
        one = agent("orca-agent:1", source="orca", parentThreadId="orca:ws", parentPane="l")
        self.assertEqual([(a["id"], d) for a, d in party_tree([one, lead], "orca:ws")],
                         [("orca-agent:l", 0), ("orca-agent:1", 1)])

    def test_siblings_keep_the_order_they_were_first_seen_and_loops_are_cut(self):
        lead = agent("chat")
        kids = [agent(f"k{index}", parentThreadId="chat") for index in range(3)]
        first = [a["id"] for a, _ in party_tree([lead, *kids], "chat", ["chat", "k2", "k0", "k1"])]
        self.assertEqual(first, ["chat", "k2", "k0", "k1"])
        looped = [agent("x", childOf="y"), agent("y", childOf="x")]
        self.assertEqual(sorted(a["id"] for a, _ in party_tree(looped, "p")), ["x", "y"])


class RosterTests(unittest.TestCase):
    def build(self, actors, **options):
        return build_roster(actors, now_ms=NOW, **options)

    def test_sections_order_counts_and_needs_first_by_how_long_they_waited(self):
        actors = [
            agent("newer", ask=ask(at=NOW - MIN, key="n")),
            agent("older", ask=ask(text="Which one?", at=NOW - 30 * MIN, key="o")),
            agent("busy", now={"kind": "command", "title": "Running tests", "startedAt": NOW}),
            agent("broke", attention="failed"),
            agent("finished", attention="quiet", status="idle", updatedAt=NOW - 60 * MIN),
            agent("yesterday", attention="quiet", status="idle", updatedAt=NOW - 26 * 60 * MIN),
        ]
        rows, counts = self.build(actors)
        sections = [(row.title, row.count, row.meta) for row in rows if row.kind == "section"]
        self.assertEqual(sections, [("Needs you", 2, ""), ("Working", 1, "1 failed"), ("Done today", 1, "")],
                         "as the header counts: one working, one failed")
        self.assertEqual((counts.working, counts.failed), (1, 1))
        self.assertEqual([row.key for row in rows if row.section == "needs" and row.kind == "agent"], ["older", "newer"])
        needs_row = next(row for row in rows if row.key == "older")
        self.assertEqual((needs_row.line.tone, needs_row.line.text), ("ask", "Which one?"))
        self.assertEqual(counts.needs, 2)
        self.assertEqual(counts.working, 1, "the failed goblin is counted once, as failed")
        self.assertEqual(counts.failed, 1)
        self.assertEqual(counts.done_today, 1)
        self.assertNotIn("yesterday", [row.key for row in rows])
        self.assertNotIn("finished", [row.key for row in rows], "Done today is folded by default")
        rows, _ = self.build(actors, done_open=True)
        self.assertIn("finished", [row.key for row in rows])

    def test_working_is_grouped_by_party_with_the_lead_first_and_members_indented(self):
        lead = agent("chat-1", name="Ship CSV export", model={"label": "GPT-5.6 Sol", "family": "openai"},
                     cwd="D:/src/billing-api", attention="quiet", status="idle")
        worker = agent("orca-agent:w", source="orca", name="csv-writer", parentThreadId="chat-1",
                       now={"kind": "command", "title": "Running npm test", "startedAt": NOW})
        stuck = agent("orca-agent:s", source="orca", name="schema-check", parentThreadId="chat-1",
                      waitingOn={"who": "coordinator", "text": "Archived too?", "at": NOW})
        solo = agent("chat-2", name="Trim the image")
        rows, counts = self.build([solo, worker, lead, stuck], catalog=[{"id": "chat-1", "name": "Ship CSV export"}])
        working = [row for row in rows if row.section == "working"]
        kinds = [(row.kind, row.key, row.depth) for row in working]
        self.assertIn(("party", "party:chat-1", 0), kinds)
        party_at = kinds.index(("party", "party:chat-1", 0))
        self.assertEqual(kinds[party_at + 1:party_at + 4], [("agent", "chat-1", 0), ("agent", "orca-agent:w", 1),
                                                            ("agent", "orca-agent:s", 1)])
        lead_row = working[party_at + 1]
        self.assertTrue(lead_row.context, "the idle lead is shown only to hold its party together")
        self.assertEqual(lead_row.title, "Lead · Codex · GPT-5.6 Sol")
        self.assertEqual(working[party_at].meta, "billing-api")
        self.assertNotIn("party:chat-2", [row.key for row in rows], "a chat working alone needs no banner")
        self.assertEqual(next(row for row in working if row.key == "orca-agent:s").line.tone, "waiting")
        self.assertEqual(counts.working, 3)

    def test_party_and_member_order_hold_between_polls(self):
        memory = RosterMemory()
        first = [agent("a", parentThreadId=""), agent("b")]
        rows, _ = self.build(first, memory=memory)
        order = [row.key for row in rows if row.kind == "agent"]
        rows, _ = self.build(list(reversed(first)), memory=memory)
        self.assertEqual([row.key for row in rows if row.kind == "agent"], order)

    def test_watching_search_and_older_chats(self):
        catalog = [{"id": "chat-w", "name": "Weekly metrics", "cwd": "D:/src/analytics", "updatedAt": NOW - 3 * 1440 * MIN},
                   {"id": "chat-x", "name": "Draft rate limits", "cwd": "D:/src/api", "updatedAt": NOW - 9 * 1440 * MIN}]
        actors = [agent("busy", name="Fix the login test"), agent("other", name="Tidy notes")]
        rows, _ = self.build(actors, catalog=catalog, watched=["chat-w", "busy"])
        watch = [row for row in rows if row.kind == "watch"]
        self.assertEqual([row.key for row in watch], ["watch:chat-w"], "a watched party that is working is in Working")
        rows, _ = self.build(actors, catalog=catalog, query="login")
        self.assertEqual([row.key for row in rows if row.kind == "agent"], ["busy"])
        rows, _ = self.build(actors, catalog=catalog, query="zzz")
        self.assertIn("note:working", [row.key for row in rows])
        rows, _ = self.build(actors, catalog=catalog, query="rate", results=search_sources(catalog, "rate"))
        self.assertEqual([row.key for row in rows if row.kind == "result"], ["result:chat-x"])
        rows, _ = self.build([], results=[])
        self.assertIn("note:results", [row.key for row in rows])

    def test_selection_defaults_and_keyboard_moves(self):
        rows, _ = self.build([agent("w1"), agent("n1", ask=ask())])
        self.assertEqual(default_selection(rows), "n1")
        rows, _ = self.build([agent("w1"), agent("w2")])
        self.assertEqual(default_selection(rows), "w1")
        self.assertEqual(default_selection(self.build([])[0]), "")
        self.assertEqual(move_selection(rows, "w1", 1), "w2")
        self.assertEqual(move_selection(rows, "w2", 1), "w2")
        self.assertEqual(move_selection(rows, "", 1), "w1")
        self.assertEqual(move_selection(rows, "gone", -1), "w2")

    def test_twenty_goblins_from_the_demo_crowd(self):
        world = DemoWorld("crowd", now_ms=NOW)
        rows, counts = build_roster(world.scene(NOW)["agents"], now_ms=NOW, catalog=world.catalog)
        self.assertEqual(sum(row.kind == "agent" for row in rows), 20)
        self.assertEqual((counts.needs, counts.working, counts.failed), (1, 18, 1), "each goblin counted once")
        self.assertEqual(len({row.key for row in rows}), len(rows), "every row key is unique")
        # The Working heading agrees with the header's chips: the failed goblin is said apart, not counted as working.
        heading = next(row for row in rows if row.key == "section:working")
        self.assertEqual((heading.count, heading.meta), (18, "1 failed"))

    def test_roster_titles_that_would_read_the_same_are_told_apart_by_how_they_end(self):
        fit = lambda text: text[:26] + "…" if len(text) > 27 else text  # noqa: E731 - 27 characters of room
        fit_end = lambda text: "…" + text[-26:] if len(text) > 27 else text  # noqa: E731
        names = ["Refactor the checkout payment flow for the EU", "Refactor the checkout payment flow for the US",
                 "Fix login"]
        self.assertEqual([fit(name) for name in names[:2]], ["Refactor the checkout paym…"] * 2, "cut, they read the same")
        told = roster_titles(names, [fit] * 3, [fit_end] * 3)
        self.assertEqual(told, [fit_end(names[0]), fit_end(names[1]), "Fix login"])
        self.assertTrue(told[0].endswith("for the EU") and told[1].endswith("for the US"), told)
        # Names that also end the same are told apart by the words after the ones they share.
        same_end = ["Refactor the checkout payments service so every EU flow is retried",
                    "Refactor the checkout payments module so every EU flow is retried"]
        told = roster_titles(same_end, [fit] * 2, [fit_end] * 2)
        self.assertTrue(told[0].startswith("…service so") and told[1].startswith("…module so"), told)
        self.assertEqual(roster_titles(["Same name", "Same name"], [fit] * 2, [fit_end] * 2), ["Same name", "Same name"])


class StripTests(unittest.TestCase):
    def test_parties_that_need_you_come_first_with_gaps_and_an_overflow_count(self):
        actors = [agent(f"w{index}", parentThreadId="busy-party") for index in range(14)]
        actors.append(agent("asker", ask=ask()))
        items, hidden, needs = strip_items(actors, now_ms=NOW, limit=12)
        self.assertEqual(items[0].actor["id"], "asker")
        self.assertEqual(len(items), 12)
        self.assertEqual(hidden, 3)
        self.assertEqual(needs, 1)
        self.assertFalse(items[0].gap)
        self.assertTrue(items[1].gap, "a new party starts with a gap")
        self.assertFalse(items[2].gap)

    def test_finished_goblins_only_fill_seats_left_over(self):
        actors = [agent("busy"), agent("done", attention="quiet", status="idle", updatedAt=NOW - MIN),
                  agent("old", attention="quiet", status="idle", updatedAt=NOW - 30 * 60 * MIN)]
        items, hidden, _needs = strip_items(actors, now_ms=NOW)
        self.assertEqual([(item.actor["id"], item.klass) for item in items], [("busy", WORKING), ("done", DONE)])
        items, hidden, _needs = strip_items(actors, now_ms=NOW, limit=1)
        self.assertEqual([item.actor["id"] for item in items], ["busy"])
        self.assertEqual(hidden, 1)


class DetailTests(unittest.TestCase):
    def test_sections_appear_only_when_they_have_something(self):
        self.assertEqual(detail_sections({}), [])
        full = {"agent": agent("a", ask=ask()), "mission": {"text": "Do it", "from": "you"},
                "plan": {"steps": [{"text": "one", "status": "done"}]}, "now": {"title": "Running", "startedAt": NOW},
                "said": {"text": "Hello"}, "trail": [{"id": "1", "title": "x"}], "files": [{"path": "a.py"}],
                "screen": {"lines": ["$ "]}}
        self.assertEqual(detail_sections(full), ["ask", "mission", "plan", "now", "said", "trail", "files", "screen"])
        sparse = {**full, "mission": {"text": "  "}, "plan": {"steps": []}, "screen": {"lines": []}}
        sparse["agent"] = agent("a")
        self.assertEqual(detail_sections(sparse), ["now", "said", "trail", "files"])

    def test_an_older_viewer_still_shows_the_public_steps(self):
        actor = agent("a", activities=[
            {"id": "1", "kind": "command", "title": "Ran project tests", "detail": "npm test", "status": "failed",
             "exitCode": 1, "durationMs": 2300, "output": "1 failed"},
            {"id": "2", "kind": "update", "title": "Update", "description": "Fixing the test now."},
            {"id": "3", "kind": "update", "title": "Status", "description": "Finished the task."},
        ])
        detail = detail_from_actor(actor)
        self.assertEqual([item["id"] for item in detail["trail"]], ["2", "1"], "newest first, no status pings")
        self.assertEqual(detail["trail"][1]["status"], "failed")
        self.assertEqual(detail["said"]["text"], "Fixing the test now.")
        self.assertEqual(detail_sections(detail), ["said", "trail"])

    def test_public_steps_without_a_time_of_their_own_show_none(self):
        actor = agent("a", now={"kind": "command", "title": "Running npm test", "startedAt": NOW - 30_000},
                      activities=[
                          {"id": "1", "kind": "command", "title": "Ran a local command", "status": "completed",
                           "turnStartedAt": NOW - 600_000},
                          {"id": "2", "kind": "command", "title": "Ran a local command", "status": "inProgress",
                           "turnStartedAt": NOW - 600_000},
                          {"id": "3", "kind": "tool", "title": "Used a tool", "status": "completed", "at": NOW - 5_000,
                           "turnStartedAt": NOW - 600_000}])
        trail = {item["id"]: item for item in detail_from_actor(actor)["trail"]}
        self.assertIsNone(trail["1"]["at"], "never the turn's start")
        self.assertEqual(trail["3"]["at"], NOW - 5_000, "a step's own time is kept")
        self.assertEqual(trail["2"]["at"], NOW - 30_000, "the running step is timed from its own start")
        self.assertEqual(trail_result(trail["2"], NOW), [("running 30s", "lively")])

    def test_a_source_without_records_still_shows_its_public_steps(self):
        actor = agent("ext-agent:relay:build:coder", activities=[
            {"id": "1", "kind": "command", "title": "Ran checks", "status": "failed"}])
        filled = with_public_steps({"agent": actor, "trail": [], "said": None, "plan": None}, actor)
        self.assertEqual([item["id"] for item in filled["trail"]], ["1"])
        own = {"agent": actor, "trail": [{"id": "own", "title": "x"}], "said": {"text": "Hi"}}
        self.assertIs(with_public_steps(own, actor)["trail"], own["trail"], "the viewer's own records win")
        self.assertIsNone(with_public_steps(None, actor))

    def test_trail_results_and_timers(self):
        self.assertEqual(trail_result({"status": "failed", "exitCode": 1, "durationMs": 2300}), [("exit 1 · 2.3s", "coral")])
        self.assertEqual(trail_result({"status": "ok", "exitCode": 0, "durationMs": 18400}), [("exit 0 · 18.4s", "muted")])
        self.assertEqual(trail_result({"kind": "edit", "added": 42, "removed": 7}), [("+42", "lively"), ("−7", "coral")])
        self.assertEqual(trail_result({"status": "running", "at": NOW - 72_000}, NOW), [("running 1m 12s", "lively")])
        self.assertEqual(trail_result({"status": "ok", "paths": ["a", "b", "c"]}), [("3 files", "muted")])
        self.assertEqual(trail_result({"status": "ok"}), [])
        self.assertEqual([elapsed(ms) for ms in (0, 12_000, 245_000, 4_320_000, 97_200_000)],
                         ["0s", "12s", "4m 05s", "1h 12m", "1d 3h"])
        self.assertEqual([duration(ms) for ms in (400, 2300, 72_000, None, -1)], ["0.4s", "2.3s", "1m 12s", "", ""])
        self.assertEqual([age_short(NOW - ms, NOW) for ms in (5_000, 4 * MIN, 3 * 60 * MIN, 50 * 60 * MIN)],
                         ["now", "4m", "3h", "2d"])
        self.assertEqual(age_short(None, NOW), "")

    def test_status_chip_counts_from_when_it_started(self):
        self.assertEqual(status_chip(agent("a", ask=ask(at=NOW - 65_000)), NOW), ("Needs you · 1m 05s", "ask"))
        working = agent("a", now={"title": "Running", "startedAt": NOW - 12_000})
        self.assertEqual(status_chip(working, NOW), ("Working · 12s", "now"))
        waiting = agent("a", waitingOn={"who": "coordinator", "at": NOW - 3000})
        self.assertEqual(status_chip(waiting, NOW), ("Waiting on coordinator · 3s", "waiting"))
        # A finished step or Thinking has no running timer: its time says how long ago, not how long it worked.
        finished = agent("a", now={"kind": "command", "title": "Ran npm test", "startedAt": NOW - 120_000, "done": True})
        self.assertEqual(status_chip(finished, NOW), ("Working", "now"))
        self.assertEqual(status_chip(agent("a", now={"kind": "think", "title": "Thinking", "startedAt": NOW - 3_960_000}), NOW),
                         ("Working", "now"))
        idle = agent("claude-agent:s", source="claude", attention="quiet", status="idle", idleSince=NOW - 66 * MIN,
                     updatedAt=NOW - 66 * MIN, turnStates=[{"status": "idle", "questions": []}])
        self.assertEqual(status_chip(idle, NOW), ("Idle · no activity for 66m", "done"))
        # A turn stopped with Esc or a denied permission did not finish: it reads Stopped, never Done.
        stopped = agent("claude-agent:s", source="claude", attention="quiet", status="stopped", updatedAt=NOW - 3 * MIN,
                        turnStates=[{"status": "interrupted", "questions": []}],
                        activities=[{"kind": "command", "title": "Ran a local command", "status": "stopped"},
                                    {"kind": "update", "title": "Status", "description": "Stopped before it finished."}])
        self.assertEqual(status_chip(stopped, NOW), ("Stopped · 3m ago", "done"))
        self.assertEqual(row_line(stopped, now_ms=NOW).text, "Stopped before it finished.")


class LiveLineTests(unittest.TestCase):
    """Every line says something true: a finished step as a past one, Thinking with how long since the
    last visible step, and a session left idle as idle, never as working."""

    def test_spans_and_ages_read_short(self):
        self.assertEqual([quiet_for(ms) for ms in (0, 35_000, 4 * MIN, 66 * MIN, 200 * MIN, 12 * 60 * MIN, 50 * 60 * MIN)],
                         ["0s", "35s", "4m", "66m", "3h 20m", "12h", "2d"])
        self.assertEqual(ago(NOW - 20_000, NOW), "just now")
        self.assertEqual(ago(NOW - 2 * MIN, NOW), "2m ago")
        self.assertEqual(ago(None, NOW), "")

    def test_a_finished_step_reads_as_a_past_step(self):
        done = {"kind": "command", "title": "Ran gh pr view 214", "startedAt": NOW - 2 * MIN - 5_000, "done": True}
        self.assertEqual(row_line(agent("a", now=done), now_ms=NOW), ("now", "Ran gh pr view 214 · 2m ago"))
        self.assertEqual(now_line({**done, "startedAt": NOW - 5_000}, NOW), "Ran gh pr view 214 · just now")
        self.assertEqual(now_line({**done, "startedAt": 0}, NOW), "Ran gh pr view 214", "no time, no age")
        self.assertEqual(actor_class(agent("a", now=done)), WORKING, "a working chat between steps is still working")
        thinking = {"kind": "think", "title": "Thinking", "startedAt": NOW - 4 * MIN}
        self.assertEqual(row_line(agent("a", now=thinking), now_ms=NOW).text, "Thinking · 4m")
        running = {"kind": "command", "title": "Running npm test", "startedAt": NOW - 4 * MIN}
        self.assertEqual(row_line(agent("a", now=running), now_ms=NOW).text, "Running npm test", "a running step keeps its title")

    def test_an_idle_session_is_quiet_and_says_how_long(self):
        idle = agent("claude-agent:s", source="claude", attention="quiet", status="idle", idleSince=NOW - 66 * MIN,
                     updatedAt=NOW - 66 * MIN, turnStates=[{"status": "idle", "questions": []}],
                     activities=[{"kind": "command", "title": "Ran a local command", "status": "completed"}])
        self.assertEqual(actor_class(idle), DONE)
        self.assertEqual(row_line(idle, now_ms=NOW), ("done", "No activity for 66m"))
        rows, counts = build_roster([idle, agent("w")], now_ms=NOW, done_open=True)
        found = next(row for row in rows if row.key == "claude-agent:s")
        self.assertEqual(found.section, "done", "out of Working, into Done today")
        self.assertEqual(found.line, ("done", "No activity for 66m"))
        self.assertEqual(counts.working, 1)
        self.assertEqual(detail_now({"now": None}, idle), None)

    def test_the_demo_has_a_finished_step_a_thinking_chat_and_an_idle_session(self):
        world = DemoWorld("default", now_ms=NOW)
        rows, _counts = build_roster(world.scene(NOW)["agents"], now_ms=NOW, done_open=True)
        lines = {row.key: row.line.text for row in rows if row.kind == "agent"}
        self.assertEqual(lines["demo-chat-pr-review"], "Ran gh pr view 214 · 2m ago")
        self.assertEqual(lines["demo-chat-cache-headers"], "Thinking · 36s")
        self.assertEqual(lines["claude-agent:demo-pricing-rules"], "No activity for 66m")


class ReviewFindingTests(unittest.TestCase):
    """What the product review found hard to read: whose ask is whose, what a waiting goblin waits on,
    why one failed, and which one just finished."""

    def test_a_permission_row_names_what_it_would_run(self):
        bash = ask(text="Allow Bash to run this command?", tool="Bash", command="npm test -- csv\nsecond line")
        self.assertEqual(row_line(agent("claude-agent:s", source="claude", ask=bash)).text, "Allow Bash: npm test -- csv")
        codex = ask(kind="approval", text="Allow Codex to run this command? Upgrade Pillow.", tool="command",
                    command="pip install --upgrade pillow==11.2.1")
        self.assertEqual(row_line(agent("chat", ask=codex)).text, "Allow Codex: pip install --upgrade pillow==11.2.1")
        files = ask(kind="approval", text="Allow Codex to change these files?", tool="fileChange", command="src/a.py, src/b.py")
        self.assertEqual(row_line(agent("chat", ask=files)).text, "Allow Codex to change src/a.py, src/b.py")
        maybe = ask(kind="approval", text="Codex may be waiting for your approval.", command="make deploy")
        self.assertEqual(row_line(agent("chat", ask=maybe)).text, "May be waiting for your OK: make deploy")
        read = ask(text="Allow Read to open cron.conf?", tool="Read", command="C:\\etc\\cron.conf")
        self.assertEqual(row_line(agent("claude-agent:s", source="claude", ask=read)).text, "Allow Read to open cron.conf?",
                         "a file ask already names its file")
        notice = ask(text="Claude Code is waiting for your answer.", tool="PowerShell", command="Remove-Item x")
        self.assertEqual(row_line(agent("claude-agent:s", source="claude", ask=notice)).text, "Allow PowerShell: Remove-Item x")

    def test_a_reply_row_shows_the_question_not_the_lead_in(self):
        reply = ask(kind="reply", text="Merged six duplicate entries and sorted releases newest first. Want me to "
                                       "also update the README?")
        actor = agent("chat", ask=reply)
        self.assertEqual(row_line(actor).text, "Want me to also update the README?")
        self.assertTrue(strip_tooltip(actor).endswith("Want me to also update the README?"))
        self.assertEqual(final_question("Two formats. Convert them? Or leave them?"), "Convert them? Or leave them?")
        self.assertEqual(final_question("No question here."), "No question here.")

    def test_while_a_permission_is_open_now_waits_and_the_step_waits_for_you(self):
        running = {"kind": "command", "title": "Running rm -rf ./.cache", "detail": "rm -rf ./.cache", "startedAt": NOW - 16 * MIN}
        permission = ask(text="Allow Bash to run this command?", tool="Bash", command="rm -rf ./.cache", at=NOW - 2 * MIN)
        actor = agent("claude-agent:s", source="claude", ask=permission, now=running)
        shown = detail_now({"now": running}, actor)
        self.assertEqual(shown["title"], "Waiting for your OK to run rm -rf ./.cache")
        self.assertTrue(shown["waiting"])
        self.assertEqual(shown["startedAt"], NOW - 2 * MIN, "the timer counts the wait, not the run")
        read = ask(text="Allow Read to open cron.conf?", tool="Read", command="/etc/cron.conf")
        self.assertEqual(detail_now({}, agent("a", ask=read))["title"], "Waiting for your OK to open cron.conf")
        question = ask(kind="question", text="Which database first?", tool="AskUserQuestion")
        self.assertIsNone(detail_now({"now": running}, agent("a", ask=question, now=running)), "the ask card says it all")
        self.assertNotIn("now", detail_sections({"now": running}, agent("a", ask=question)))
        self.assertEqual(detail_now({"now": running}, agent("a", now=running))["title"], "Running rm -rf ./.cache")
        trail = [{"id": "t2", "kind": "command", "title": "rm -rf ./.cache", "detail": "rm -rf ./.cache", "status": "running"},
                 {"id": "t1", "kind": "command", "title": "npm run build", "detail": "npm run build", "status": "running"},
                 {"id": "t0", "kind": "command", "title": "ls", "status": "ok"}]
        self.assertEqual(waiting_steps(trail, permission), {"t2"}, "only the call the permission is about")
        self.assertEqual(waiting_steps([trail[1]], permission), {"t1"}, "one open step and a prompt: that step")
        self.assertEqual(waiting_steps([{"id": "q", "kind": "ask", "status": "running"}, trail[1]], question), {"q"})
        self.assertEqual(waiting_steps(trail, None), set())
        self.assertEqual(trail_result(trail[0], NOW, waiting=True), [("waiting for you", "ask")])

    def test_a_stopped_turn_says_why(self):
        stopped = agent("claude-agent:s", source="claude", attention="failed",
                        turnStates=[{"status": "failed", "error": "Claude Code hit a rate limit."}],
                        activities=[{"kind": "update", "title": "Stopped", "description": "Claude Code hit a rate limit.",
                                     "status": "failed"}])
        self.assertEqual(row_line(stopped), ("failed", "Failed: Claude Code hit a rate limit."))
        tool = agent("w", attention="failed", activities=[{"kind": "tool", "title": "Read cron.conf",
                                                           "description": "Opened a local file.", "status": "failed"}])
        self.assertEqual(row_line(tool).text, "Failed: Read cron.conf")

    def test_one_goblin_gets_no_party_banner_from_any_source(self):
        session = agent("claude-agent:s1", source="claude", name="Add a CSV export", parentThreadId="claude:s1",
                        cwd="C:/src/billing-api")
        worker = agent("orca-agent:w", source="orca", name="ranker-tuning", parentThreadId="orca:ws")
        idle = agent("orca-agent:i", source="orca", name="synonyms", parentThreadId="orca:ws", attention="quiet",
                     status="idle", updatedAt=NOW - 50 * MIN)
        feed = agent("ext-agent:relay:run:scout", source="extension", name="Scout", parentThreadId="ext:relay:run")
        rows, _ = build_roster([session, worker, idle, feed], now_ms=NOW,
                               catalog=[{"id": "orca:ws", "name": "Orca · search-service"}])
        self.assertEqual([row.key for row in rows if row.kind == "party"], [])
        by_key = {row.key: row for row in rows}
        self.assertEqual(by_key["orca-agent:w"].meta, "Orca · search-service", "its party is named beside it")
        self.assertEqual(by_key["claude-agent:s1"].meta, "billing-api", "a session named for its prompt shows its folder")
        self.assertEqual(by_key["claude-agent:s1"].depth, 0)

    def test_goblins_that_just_finished_stay_in_view_with_their_last_line(self):
        fresh = agent("fresh", attention="quiet", status="idle", updatedAt=NOW - 3 * MIN,
                      activities=[{"kind": "update", "title": "Answer", "description": "Fixed: all 14 tests pass."}])
        older = agent("older", attention="quiet", status="idle", updatedAt=NOW - 90 * MIN)
        rows, counts = build_roster([fresh, older, agent("busy")], now_ms=NOW)
        sections = [(row.title, row.count, row.open) for row in rows if row.kind == "section"]
        self.assertEqual(sections, [("Working", 1, True), ("Just finished", 1, True), ("Done today", 1, False)])
        row = next(row for row in rows if row.key == "fresh")
        self.assertEqual((row.section, row.line), ("just", ("finished", "Fixed: all 14 tests pass.")))
        self.assertNotIn("older", [row.key for row in rows], "earlier ones stay folded")
        self.assertEqual(counts.done_today, 2)
        rows, _ = build_roster([fresh], now_ms=NOW)
        self.assertEqual(default_selection(rows), "fresh", "with nobody busy, the one that just finished")

    def test_strip_labels_keep_the_part_that_differs(self):
        self.assertEqual(strip_label({"id": "claude-agent:s", "source": "claude", "name": "Claude · billing-api · 1a2b"}),
                         "billing-api · 1a2b")
        self.assertEqual(strip_label({"id": "claude-agent:s", "source": "claude", "name": "Tune the ranker"}), "Tune the ranker")
        child = {"id": "claude-agent:s:a", "source": "claude", "childOf": "claude-agent:s", "nickname": "Explore: Find fixtures"}
        self.assertEqual(strip_label(child), "Find fixtures")
        self.assertEqual(strip_label(child, {"claude-agent:s:a": "Scout"}), "Scout")

    def test_strip_labels_that_would_read_the_same_are_told_apart(self):
        fit = lambda text: text[:8] + "…" if len(text) > 9 else text  # noqa: E731 - nine characters of room
        fit_end = lambda text: "…" + text[-8:] if len(text) > 9 else text  # noqa: E731
        session = lambda n, cwd, name: {"id": f"claude-agent:{n}", "source": "claude", "name": name, "cwd": cwd}  # noqa: E731
        apart = [session(1, "C:/src/proj-1", "Task number 1: refactor"), session(2, "C:/src/proj-2", "Task number 2: refactor")]
        self.assertEqual(strip_labels(apart, {}, fit, fit_end), ["proj-1", "proj-2"], "different folders tell them apart")
        same_folder = [session(1, "C:/src/api", "Add tests for the parser"), session(2, "C:/src/api", "Add tests for the lexer")]
        self.assertEqual(strip_labels(same_folder, {}, fit, fit_end), ["parser", "lexer"], "else the words they do not share")
        endings = [session(1, "C:/src/api", "Run checks on service-alpha-one"), session(2, "C:/src/api", "Run checks on service-alpha-two")]
        self.assertEqual(strip_labels(endings, {}, fit, fit_end), ["…lpha-one", "…lpha-two"], "else how the names end")
        distinct = [session(1, "C:/src/api", "Fix login"), session(2, "C:/src/api", "Ship CSV")]
        self.assertEqual(strip_labels(distinct, {}, fit, fit_end), ["Fix login", "Ship CSV"])
        named = strip_labels(apart, {"claude-agent:1": "Task numbers"}, fit, fit_end)
        self.assertEqual(named[0], "Task num…", "a name the person chose is kept")

    def test_the_welcome_says_what_the_feed_chips_can_do(self):
        self.assertEqual(sources_hint({"claude": {"state": "not-connected", "canConnect": True}}),
                         "Click Claude + in the header to connect Claude Code.")
        self.assertIn("Click Codex ✕ in the header to reconnect Codex.", sources_hint({"codex": {"state": "unavailable"}}))
        self.assertIn("appear here once those tools are installed", sources_hint({"codex": {"state": "not-installed"}}))


class SourcesSearchAndBadgesTests(unittest.TestCase):
    def test_each_feed_is_named_and_broken_ones_offer_their_fix(self):
        chips = source_chips({
            "codex": {"state": "unavailable", "detail": "Codex stopped."},
            "claude": {"state": "not-connected", "detail": "Not connected.", "canConnect": True},
            "orca": {"state": "ok", "detail": "Reading Orca workspaces.", "replies": False},
            "extensions": {"state": "none", "detail": "No extension feeds yet."},
        })
        self.assertEqual([(chip.label, chip.glyph, chip.action) for chip in chips],
                         [("Codex", "✕", "reconnect_codex"), ("Claude", "+", "connect_claude"), ("Orca", "✓", ""),
                          ("Feeds", "–", "")])
        self.assertIn("reply in the app itself", chips[2].tip)

    def test_optional_feeds_not_in_use_are_neutral_and_nothing_is_said_before_the_viewer_answers(self):
        chips = source_chips({"claude": {"state": "not-connected", "canConnect": False},
                              "orca": {"state": "unavailable"}, "codex": {"state": "not-installed"}})
        self.assertEqual([(chip.key, chip.tone, chip.action) for chip in chips],
                         [("codex", "off", ""), ("claude", "off", ""), ("orca", "off", "")])
        self.assertEqual(source_chips({}), [])

    def test_search_reaches_any_chat_and_prefers_title_matches(self):
        catalog = [{"id": "a", "name": "Fix login", "cwd": "D:/src/portal"}, {"id": "b", "name": "Notes", "cwd": "D:/src/login-svc"},
                   {"id": "all", "name": "All chats"}]
        self.assertEqual([item["id"] for item in search_sources(catalog, "login")], ["a", "b"])
        self.assertEqual([item["id"] for item in search_sources(catalog, "portal fix")], ["a"])

    def test_coverage_badges_and_join_reasons(self):
        self.assertEqual(coverage_note({"complete": False, "codexPending": 2}), "Checking 2 chats")
        self.assertEqual(coverage_note({"complete": True}), "")
        self.assertEqual(model_badge({"model": {"label": "GPT-5.6 Sol", "effort": "xhigh"}}, with_effort=True),
                         "GPT-5.6 Sol · xhigh")
        self.assertEqual(model_badge({"model": None}), "")
        self.assertEqual(join_reason({"joined": {"reason": "drives", "verb": "orchestration worker-start"}}),
                         "This chat drives it (orca orchestration worker-start).")
        self.assertEqual(join_reason({}), "")


class SettingsTests(unittest.TestCase):
    def test_one_bad_value_keeps_every_other_setting(self):
        settings = read_settings({"window": {"x": 10, "y": 20, "width": 1100, "height": 700, "zoomed": True},
                                  "strip": {"right": "far", "bottom": 5}, "keepOnTop": "yes", "stripWithWindow": False,
                                  "reducedMotion": True, "selected": 42, "aliases": {"a": "Scout", "b": 3},
                                  "paletteOffset": True, "surface": "nowhere"})
        self.assertEqual(settings["window"], {"x": 10, "y": 20, "width": 1100, "height": 700, "zoomed": True})
        self.assertIsNone(settings["strip"])
        self.assertFalse(settings["keepOnTop"])
        self.assertFalse(settings["stripWithWindow"])
        self.assertTrue(read_settings({})["stripWithWindow"], "the strip stays on screen unless turned off")
        self.assertTrue(read_settings({"showStrip": False})["stripWithWindow"], "an old preview choice is not kept")
        self.assertIs(settings["reducedMotion"], True)
        self.assertEqual(settings["selected"], "")
        self.assertEqual(settings["aliases"], {"a": "Scout"})
        self.assertEqual(settings["paletteOffset"], 0)
        self.assertEqual(settings["surface"], "window")
        self.assertEqual(read_settings("not a dict")["surface"], "window")

    def test_older_widget_settings_are_tolerated_and_retired_keys_dropped_on_save(self):
        old = {"x": 5, "y": 6, "columns": 3, "displayMode": "hidden", "partingNotes": [{"id": "n"}],
               "streams": [{"id": "s"}], "aliases": {"a": "Scout"}, "reducedMotion": False, "futureKey": {"keep": 1}}
        settings = read_settings(old)
        self.assertEqual(settings["surface"], "strip", "a widget hidden to its tab comes back as the strip")
        self.assertEqual(settings["aliases"], {"a": "Scout"})
        saved = settings_to_save(old, {"surface": "window", "aliases": {"a": "Scout"}})
        self.assertEqual(saved["futureKey"], {"keep": 1}, "unknown keys survive")
        for retired in ("x", "y", "columns", "displayMode", "partingNotes", "streams"):
            self.assertNotIn(retired, saved)
        self.assertEqual(saved["surface"], "window")
        self.assertIs(saved["reducedMotion"], False)

    def test_a_saved_window_must_still_fit_a_display(self):
        areas = [(0, 0, 1920, 1040)]
        kept = clamp_window({"x": 100, "y": 50, "width": 1100, "height": 700, "zoomed": False}, areas)
        self.assertEqual((kept["x"], kept["y"], kept["width"]), (100, 50, 1100))
        gone = clamp_window({"x": -3000, "y": 50, "width": 1100, "height": 700, "zoomed": False}, areas)
        self.assertEqual((gone["width"], gone["height"]), (1000, 660))
        self.assertEqual((gone["x"], gone["y"]), (460, 190), "centred on the display")
        scaled = clamp_window(None, areas, 1.25)
        self.assertEqual((scaled["width"], scaled["height"]), (1250, 825))
        tiny = clamp_window({"x": 0, "y": 0, "width": 200, "height": 100, "zoomed": False}, areas)
        self.assertEqual((tiny["width"], tiny["height"]), (720, 460), "never below the minimum")
        self.assertTrue(reachable((-500, 10), (300, 80), [(-1920, 0, 0, 1080), (0, 0, 1920, 1080)]))
        self.assertFalse(reachable((5000, 10), (300, 80), [(0, 0, 1920, 1080)]))
        self.assertTrue(reachable((5000, 10), (300, 80), []))


if __name__ == "__main__":
    unittest.main()
