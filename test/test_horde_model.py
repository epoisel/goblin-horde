"""What the Horde window shows, decided without a display: roster sections and order, the line under
each goblin, the strip, the detail sections, timers, sources, search, and settings."""

import time
import unittest

from goblin_motion import goblin_action
from horde_demo import DemoWorld
from horde_model import (DONE, FAILED, NEEDS, WORKING, RosterMemory, actor_class, age_short, ask_of, build_roster,
                         clamp_window, coverage_note, default_selection, detail_from_actor, detail_sections,
                         display_name, duration, elapsed, join_reason, model_badge, motion_view, move_selection,
                         party_tree, progress_label, reachable, read_settings, row_line, search_sources,
                         settings_to_save, source_chips, status_chip, strip_items, trail_result, with_public_steps)

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
        sections = [(row.title, row.count) for row in rows if row.kind == "section"]
        self.assertEqual(sections, [("Needs you", 2), ("Working", 2), ("Done today", 1)])
        self.assertEqual([row.key for row in rows if row.section == "needs" and row.kind == "agent"], ["older", "newer"])
        needs_row = next(row for row in rows if row.key == "older")
        self.assertEqual((needs_row.line.tone, needs_row.line.text), ("ask", "Which one?"))
        self.assertEqual(counts.needs, 2)
        self.assertEqual(counts.working, 2)
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
        self.assertGreaterEqual(counts.working, 19)
        self.assertEqual(len({row.key for row in rows}), len(rows), "every row key is unique")


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
                                  "strip": {"right": "far", "bottom": 5}, "keepOnTop": "yes", "showStrip": True,
                                  "reducedMotion": True, "selected": 42, "aliases": {"a": "Scout", "b": 3},
                                  "paletteOffset": True, "surface": "nowhere"})
        self.assertEqual(settings["window"], {"x": 10, "y": 20, "width": 1100, "height": 700, "zoomed": True})
        self.assertIsNone(settings["strip"])
        self.assertFalse(settings["keepOnTop"])
        self.assertTrue(settings["showStrip"])
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
