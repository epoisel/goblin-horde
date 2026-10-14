"""Invented parties for `--demo`, screenshots, and tests. Nothing here is live data.

DemoApi answers every request the window makes from an in-memory world in the 0.6 data contract
(scene actors with ask / waitingOn / now / progress, and /api/agent details), so the whole window
runs, animates, and can be clicked through without a viewer, Codex, Claude Code, or Orca. Every
name, path, and command is made up.
"""

from __future__ import annotations

import copy
import time
import urllib.parse

from horde_api import ApiError, HordeApi, route

MIN = 60_000
OPUS = {"id": "claude-opus-5-5", "label": "Opus 5.5", "family": "claude"}
SONNET = {"id": "claude-sonnet-5", "label": "Sonnet 5", "family": "claude"}
HAIKU = {"id": "claude-haiku-5-5", "label": "Haiku 5.5", "family": "claude"}
SOL = {"id": "gpt-5.6-sol", "label": "GPT-5.6 Sol", "family": "openai", "effort": "high"}
MINI = {"id": "gpt-5.6-mini", "label": "GPT-5.6 mini", "family": "openai", "effort": "medium"}
CONTROLS = {
    "codex": {"open": {"kind": "codex-link", "label": "Open in Codex"},
              "message": {"kind": "codex-reply", "label": "Message…", "hint": "Sends a reply to this chat"}},
    "claude": {"open": {"kind": "claude-link", "label": "Open in Claude"}, "message": None},
    "orca": {"open": {"kind": "orca-terminal", "label": "Open in Orca"},
             "message": {"kind": "orca-send", "label": "Message…", "hint": "Types into its terminal"}},
    "extension": {"open": None, "message": None},
}
SETS = ("default", "empty", "one", "crowd", "long")


def step(kind: str, title: str, description: str = "", *, detail: str = "", status: str = "completed",
         exit_code=None, ms=None, output: str = "", at: float | None = None, ident: str = "") -> dict:
    """One public activity, as older viewers send them with every actor."""
    item = {"id": ident or f"demo-step-{abs(hash((kind, title, description))) % 10**8}", "kind": kind, "title": title,
            "description": description, "detail": detail, "status": status}
    if exit_code is not None:
        item["exitCode"] = exit_code
    if ms is not None:
        item["durationMs"] = ms
    if output:
        item["output"] = output
    if at is not None:
        item["at"] = at
    return item


def agent(ident: str, name: str, source: str, *, updated: float, party: str = "", nickname: str = "",
          model: dict | None = None, cwd: str = "", status: str = "active", attention: str = "working",
          turn: str = "inProgress", activities: list | None = None, **extra) -> dict:
    """One scene actor with the fields the server sends (and the optional 0.6 ones in ``extra``)."""
    actor = {"id": ident, "name": name, "nickname": nickname or name, "source": source, "cwd": cwd,
             "status": status, "attention": attention, "updatedAt": updated,
             "turnStates": [{"id": f"{ident}-turn", "status": turn, "questions": [], "error": ""}] if source != "orca" else [],
             "activities": activities or [], "model": model, "parentThreadId": party,
             "ask": None, "waitingOn": None, "now": None, "progress": None}
    actor.update(extra)
    return actor


def trail(ident: str, kind: str, title: str, at: float, *, status: str = "ok", **extra) -> dict:
    return {"id": ident, "at": at, "kind": kind, "title": title, "status": status, **extra}


class DemoWorld:
    """Scene, catalog, details, and pending requests for one demo set, with times relative to now."""

    def __init__(self, kind: str = "default", now_ms: float | None = None) -> None:
        self.kind = kind if kind in SETS else "default"
        self.t = now_ms if now_ms is not None else time.time() * 1000
        self.actors: list[dict] = []
        self.details: dict[str, dict] = {}
        self.catalog: list[dict] = []
        self.requests: list[dict] = []
        self.watched: list[str] = []
        self.manual_links: dict[str, str] = {}
        getattr(self, f"build_{self.kind}")()

    # Building blocks ---------------------------------------------------------------------------
    def ago(self, minutes: float) -> float:
        return self.t - minutes * MIN

    def add(self, actor: dict, detail: dict | None = None) -> dict:
        self.actors.append(actor)
        if detail is not None:
            self.details[actor["id"]] = detail
        return actor

    def chat(self, ident: str, name: str, cwd: str, minutes: float, model: dict | None = None, source: str = "codex",
             count: int = 0) -> None:
        self.catalog.append({"id": ident, "name": name, "cwd": cwd, "updatedAt": self.ago(minutes), "source": source,
                             "model": model, **({"agentCount": count} if count else {})})

    # Sets --------------------------------------------------------------------------------------
    def build_empty(self) -> None:
        self.chat("demo-chat-cron-jobs", "Migrate the cron jobs to the scheduler", "D:/src/ops-scripts", 5 * 1440, SOL)

    def build_one(self) -> None:
        self.build_csv_party(workers=False)
        self.chat("demo-chat-cron-jobs", "Migrate the cron jobs to the scheduler", "D:/src/ops-scripts", 5 * 1440, SOL)

    def build_default(self) -> None:
        self.build_csv_party()
        self.build_login_party()
        self.build_migration_party()
        self.build_release_notes()
        self.build_image_pipeline()
        self.build_search_workspace()
        self.build_done()
        self.chat("demo-chat-weekly-metrics", "Weekly metrics report", "D:/src/analytics", 3 * 1440, MINI)
        self.watched = ["demo-chat-weekly-metrics"]
        for index, (name, folder, days) in enumerate((
                ("Migrate the cron jobs to the scheduler", "ops-scripts", 5), ("Draft API rate limits", "billing-api", 9),
                ("Spike: streaming exports", "billing-api", 20), ("Fix the timezone bug in reports", "analytics", 2),
                ("Sort out flaky upload retries", "media-service", 12), ("Prototype the dark theme", "web-portal", 30))):
            self.chat(f"demo-chat-older-{index}", name, f"D:/src/{folder}", days * 1440, SOL if index % 2 else MINI)

    def build_long(self) -> None:
        coordinator = "demo-chat-long-name"
        self.chat(coordinator, "Reconcile every quarterly revenue report across the three regional ledgers before the "
                               "board meeting and flag anything that does not add up", "D:/src/finance-reconciliation-tools", 2, SOL)
        long_command = ("python -m reconcile.cli --ledger north --ledger south --ledger west --quarter 2026-Q3 "
                        "--tolerance 0.005 --report out/reconciliation/2026-Q3/full-report-with-every-line-item.csv "
                        "--include-adjustments --include-intercompany --verbose")
        self.add(agent(coordinator, "Reconcile every quarterly revenue report across the three regional ledgers before "
                       "the board meeting and flag anything that does not add up", "codex", updated=self.ago(0.1),
                       model=SOL, cwd="D:/src/finance-reconciliation-tools",
                       activities=[step("command", "Ran a local command", detail=long_command, status="inProgress")],
                       now={"kind": "command", "title": f"Running {long_command}", "detail": long_command,
                            "startedAt": self.ago(3.5)},
                       progress={"done": 11, "total": 23, "current": "Compare intercompany transfers"}),
                 {"mission": {"text": "Reconcile every quarterly revenue report across the three regional ledgers. " * 6,
                              "from": "you", "at": self.ago(50)},
                  "now": {"kind": "command", "title": "Running the reconciliation", "detail": long_command,
                          "startedAt": self.ago(3.5)},
                  "trail": [trail("l1", "command", long_command, self.ago(3.5), status="running", detail=long_command)],
                  "said": {"text": "Every ledger needs a separate pass because the regions book intercompany transfers "
                                   "on different days. " * 8, "at": self.ago(4)}})
        self.add(agent("claude-agent:demo-long", "A Claude Code session with an extraordinarily long descriptive name "
                       "that keeps going well past the edge", "claude", updated=self.ago(1), party=coordinator,
                       model=HAIKU, joined={"from": "claude:demo-long", "reason": "manual"},
                       cwd="D:/src/finance-reconciliation-tools",
                       ask={"kind": "permission", "tool": "Bash", "text": "Allow Bash to run this command?",
                            "command": long_command, "at": self.ago(1), "answerHere": None, "key": "demo-ask-long"}))
        self.build_csv_party(workers=False)

    def build_crowd(self) -> None:
        """Twenty goblins in five parties, for the long-roster screenshot."""
        self.build_csv_party()
        session = "demo-crowd"
        self.chat(f"claude:{session}", "Audit the accessibility of the checkout", "D:/src/web-portal", 1, OPUS, "claude")
        main = f"claude-agent:{session}"
        self.add(agent(main, "Audit the accessibility of the checkout", "claude", updated=self.ago(0.2),
                       party=f"claude:{session}", nickname="Claude Code", model=OPUS, cwd="D:/src/web-portal",
                       activities=[step("update", "Update", "Five subagents are checking one page each.")],
                       now={"kind": "agent", "title": "Waiting on 5 subagents", "startedAt": self.ago(8)},
                       progress={"done": 1, "total": 6}))
        for index, page in enumerate(("cart", "shipping", "payment", "review", "receipt")):
            self.add(agent(f"{main}:p{index}", f"Check the {page} page", "claude", updated=self.ago(0.1 * index),
                           party=f"claude:{session}", nickname=f"Explore subagent · {page}", model=HAIKU, childOf=main,
                           cwd="D:/src/web-portal",
                           activities=[step("research" if index % 2 else "command",
                                            "Searched local files" if index % 2 else "Read a local file",
                                            f"Looked at the {page} page", status="inProgress")],
                           now={"kind": "search" if index % 2 else "read",
                                "title": f"Checking labels on the {page} page", "startedAt": self.ago(index + 1)}))
        workspace = "orca:demo-ws-crowd"
        self.chat(workspace, "Orca · warehouse-sync", "D:/orca/workspaces/warehouse-sync/main", 1, None, "orca", 5)
        lead = self.add(agent("orca-agent:demo-crowd-lead", "sync-lead", "orca", updated=self.ago(0.3), party=workspace,
                              model=SOL, cwd="D:/orca/workspaces/warehouse-sync/main", status="working",
                              pane="demo-crowd-lead", activities=[step("update", "Update", "Splitting the tables.")],
                              now={"kind": "agent", "title": "Coordinating 4 workers", "startedAt": self.ago(14)},
                              progress={"done": 2, "total": 5}))
        for index, table in enumerate(("orders", "stock", "suppliers", "returns")):
            self.add(agent(f"orca-agent:demo-crowd-{table}", f"{table}-sync", "orca", updated=self.ago(0.2 * index),
                           party=workspace, model=SONNET if index % 2 else MINI,
                           cwd=f"D:/orca/workspaces/warehouse-sync/{table}", status="working", parentPane=lead["pane"],
                           pane=f"demo-crowd-{table}",
                           activities=[step("file", f"Changed {table}.sql", f"{table}.sql", status="inProgress")],
                           now={"kind": "edit", "title": f"Editing migrations/{table}.sql", "startedAt": self.ago(2 + index)},
                           progress={"done": index, "total": 4}))
        for index, (name, folder) in enumerate((("Trim the docker image", "media-service"),
                                                 ("Backfill the audit log", "billing-api"))):
            ident = f"demo-chat-crowd-{index}"
            self.chat(ident, name, f"D:/src/{folder}", 0.5, SOL)
            self.add(agent(ident, name, "codex", updated=self.ago(0.4), model=SOL if index else MINI, cwd=f"D:/src/{folder}",
                           activities=[step("command", "Ran a local command", detail="docker build .", status="inProgress")],
                           now={"kind": "command", "title": "Running docker build -t media:slim .",
                                "detail": "docker build -t media:slim .", "startedAt": self.ago(1.5)}))
        self.build_login_party()

    # Parties ----------------------------------------------------------------------------------
    def build_csv_party(self, workers: bool = True) -> None:
        """A Codex coordinator with Orca workers (one running tests, one waiting on its coordinator,
        one failed) and a Codex subagent."""
        chat = "demo-chat-csv-export"
        cwd = "D:/src/billing-api"
        self.chat(chat, "Ship CSV export for invoices", cwd, 0.2, SOL)
        writer, schema, docs = "orca-agent:demo-pane-writer", "orca-agent:demo-pane-schema", "orca-agent:demo-pane-docs"
        explorer = "demo-chat-csv-explorer"
        self.add(agent(chat, "Ship CSV export for invoices", "codex", updated=self.ago(0.2), model=SOL, cwd=cwd,
                       activities=[step("command", "Searched local files", detail='rg -n "export" src/invoices'),
                                   step("update", "Update", "Three workers are on it; I'm wiring the export button.")],
                       now={"kind": "agent", "title": "Waiting on 3 workers" if workers else "Wiring the export button",
                            "detail": "csv-writer, schema-check, docs-pass", "startedAt": self.ago(6)},
                       progress={"done": 3, "total": 7, "current": "Wire the export button"}),
                 {"mission": {"text": "Add a CSV export for invoices: a button on the invoice list that streams every "
                                      "row, plus the API docs. Split the work across workers and review what they "
                                      "send back before anything merges.", "from": "you", "at": self.ago(48)},
                  "plan": {"steps": [{"text": "Read the invoice list code", "status": "done"},
                                     {"text": "Design the export endpoint", "status": "done"},
                                     {"text": "Start three workers", "status": "done"},
                                     {"text": "Wire the export button", "status": "active"},
                                     {"text": "Review the workers' results", "status": "pending"},
                                     {"text": "Run the full test suite", "status": "pending"},
                                     {"text": "Write the release note", "status": "pending"}],
                           "at": self.ago(7), "source": "plan"},
                  "now": {"kind": "agent", "title": "Waiting on 3 workers", "detail": "csv-writer, schema-check, docs-pass",
                          "startedAt": self.ago(6)},
                  "said": {"text": "I split the export into three pieces: csv-writer builds the streaming writer, "
                                   "schema-check confirms which invoice fields are safe to export, and docs-pass "
                                   "updates the API docs. While they work I'm wiring the export button to the new "
                                   "endpoint.", "at": self.ago(6.5)},
                  "trail": [
                      trail("c8", "agent", "Started worker docs-pass", self.ago(6), detail="Update docs/api/invoices.md "
                            "for the export endpoint and run the docs lint.", agentId=docs),
                      trail("c7", "agent", "Started worker schema-check", self.ago(6.2), detail="List which invoice "
                            "fields are safe to export and confirm with me before excluding any.", agentId=schema),
                      trail("c6", "agent", "Started worker csv-writer", self.ago(6.4), detail="Build a streaming CSV "
                            "writer in src/invoices/csv.ts with tests.", agentId=writer),
                      trail("c5", "edit", "Edited src/invoices/routes.ts", self.ago(9), detail="src/invoices/routes.ts",
                            added=42, removed=7),
                      trail("c4", "command", "npm test -- invoices", self.ago(12), detail="npm test -- invoices",
                            exitCode=0, durationMs=18_400,
                            output="PASS src/invoices/list.test.ts (12 tests)\nPASS src/invoices/routes.test.ts (9 tests)\n\n"
                                   "Test Suites: 2 passed, 2 total\nTests:       21 passed, 21 total\nTime:        18.1 s"),
                      trail("c3", "read", "Read 4 files", self.ago(15), paths=["src/invoices/list.ts", "src/invoices/routes.ts",
                                                                              "src/invoices/model.ts", "docs/api/invoices.md"],
                            detail="src/invoices/list.ts\nsrc/invoices/routes.ts\nsrc/invoices/model.ts\ndocs/api/invoices.md"),
                      trail("c2", "search", 'rg -n "export" src/invoices', self.ago(16), detail='rg -n "export" src/invoices',
                            exitCode=0, durationMs=310, output="src/invoices/routes.ts:12:export function listInvoices(\n"
                                                                "src/invoices/model.ts:3:export interface Invoice {"),
                      trail("c1", "message", "Planned the export in three pieces", self.ago(17),
                            detail="The export has three independent parts, so I'll start one worker for each."),
                  ],
                  "files": [{"path": "src/invoices/routes.ts", "added": 42, "removed": 7, "at": self.ago(9)},
                            {"path": "src/invoices/export.ts", "added": 118, "removed": 0, "at": self.ago(10)},
                            {"path": "web/src/pages/InvoiceList.tsx", "added": 16, "removed": 3, "at": self.ago(2)}]})
        if not workers:
            return
        joined = {"from": "orca:demo-ws-billing", "reason": "worker", "verb": "orchestration worker-start"}
        self.add(agent(writer, "csv-writer", "orca", updated=self.ago(0.1), party=chat, model=OPUS,
                       cwd="D:/src/billing-api-worktrees/csv-writer", status="working", joined=joined,
                       pane="demo-pane-writer",
                       activities=[step("command", "Ran project tests", detail="npm test -- csv", status="inProgress")],
                       now={"kind": "command", "title": "Running npm test -- csv",
                            "detail": "npm test -- --runInBand src/invoices/csv.test.ts", "startedAt": self.ago(1.2)},
                       progress={"done": 2, "total": 4, "current": "Make the tests pass"}),
                 {"mission": {"text": "Build a streaming CSV writer for invoices in src/invoices/csv.ts with tests. "
                                      "Memory must stay flat for a million rows.", "from": "coordinator", "at": self.ago(6.4)},
                  "plan": {"steps": [{"text": "Write the row formatter", "status": "done"},
                                     {"text": "Stream rows from the database cursor", "status": "done"},
                                     {"text": "Make the tests pass", "status": "active"},
                                     {"text": "Report back to the coordinator", "status": "pending"}],
                           "at": self.ago(3), "source": "orca-tasks"},
                  "now": {"kind": "command", "title": "Running npm test -- csv",
                          "detail": "npm test -- --runInBand src/invoices/csv.test.ts", "startedAt": self.ago(1.2)},
                  "said": {"text": "The formatter quotes every field that contains a comma, quote, or newline. "
                                   "Running the tests now.", "at": self.ago(1.3)},
                  "trail": [
                      trail("w4", "command", "npm test -- --runInBand src/invoices/csv.test.ts", self.ago(1.2),
                            status="running", detail="npm test -- --runInBand src/invoices/csv.test.ts"),
                      trail("w3", "write", "Wrote src/invoices/csv.test.ts", self.ago(2.5), detail="src/invoices/csv.test.ts",
                            added=64, removed=0),
                      trail("w2", "edit", "Edited src/invoices/csv.ts", self.ago(3.5), detail="src/invoices/csv.ts",
                            added=81, removed=12),
                      trail("w1", "read", "Read src/invoices/model.ts", self.ago(5), detail="src/invoices/model.ts")],
                  "files": [{"path": "src/invoices/csv.ts", "added": 81, "removed": 12, "at": self.ago(3.5)},
                            {"path": "src/invoices/csv.test.ts", "added": 64, "removed": 0, "at": self.ago(2.5)}],
                  "screen": {"lines": ["", " PASS  src/invoices/csv.test.ts", "  formats a plain row (3 ms)",
                                       "  quotes commas and quotes (1 ms)", "  RUNS  streams a million rows",
                                       "", " Tests:       2 passed, 1 running", ""], "at": self.ago(0.1)}})
        self.add(agent(schema, "schema-check", "orca", updated=self.ago(3), party=chat, model=SOL,
                       cwd="D:/src/billing-api-worktrees/schema-check", status="waiting", joined=joined,
                       pane="demo-pane-schema",
                       activities=[step("update", "Update", "Asked the coordinator about archived invoices.")],
                       waitingOn={"who": "coordinator", "text": "Should archived invoices be in the export?",
                                  "at": self.ago(3)},
                       progress={"done": 3, "total": 4}),
                 {"mission": {"text": "List which invoice fields are safe to export and confirm with the coordinator "
                                      "before excluding any.", "from": "coordinator", "at": self.ago(6.2)},
                  "said": {"text": "Every field is safe to export except internal_notes. One question before I finish: "
                                   "should archived invoices be in the export? I've asked the coordinator.",
                           "at": self.ago(3)},
                  "trail": [trail("s3", "ask", "Asked the coordinator", self.ago(3),
                                  detail="Should archived invoices be in the export?"),
                            trail("s2", "read", "Read src/invoices/model.ts", self.ago(4.5), detail="src/invoices/model.ts"),
                            trail("s1", "search", "rg -n \"archived\" src", self.ago(5), detail='rg -n "archived" src',
                                  exitCode=0, durationMs=220)],
                  "screen": {"lines": ["> orca orchestration ask --to coordinator", "  Should archived invoices be in the export?",
                                       "  waiting for a reply…"], "at": self.ago(3)}})
        lint_output = ("docs/api/invoices.md:41:3  error  Link to #export-limits does not exist  link-check\n"
                       "docs/api/invoices.md:58:1  error  Code fence has no language                 fence-lang\n\n"
                       "✖ 2 problems (2 errors, 0 warnings)")
        self.add(agent(docs, "docs-pass", "orca", updated=self.ago(2), party=chat, model=HAIKU,
                       cwd="D:/src/billing-api-worktrees/docs-pass", status="error", attention="failed", joined=joined,
                       pane="demo-pane-docs",
                       activities=[step("command", "Ran a local command", detail="npm run lint:docs", status="failed",
                                        exit_code=1, output=lint_output)]),
                 {"mission": {"text": "Update docs/api/invoices.md for the export endpoint and run the docs lint.",
                              "from": "coordinator", "at": self.ago(6)},
                  "said": {"text": "The docs lint failed on a broken link and a code fence without a language. "
                                   "I'll fix both if you want me to keep going.", "at": self.ago(2)},
                  "trail": [trail("d2", "command", "npm run lint:docs", self.ago(2.2), status="failed", exitCode=1,
                                  durationMs=2_300, detail="npm run lint:docs", output=lint_output),
                            trail("d1", "edit", "Edited docs/api/invoices.md", self.ago(3), detail="docs/api/invoices.md",
                                  added=37, removed=2)],
                  "files": [{"path": "docs/api/invoices.md", "added": 37, "removed": 2, "at": self.ago(3)}]})
        self.add(agent(explorer, "Explorer", "codex", updated=self.ago(0.3), party=chat, nickname="Explorer", model=MINI,
                       cwd=cwd, role="explorer",
                       activities=[step("command", "Read a local file", detail="Get-Content src/invoices/invoice_export.py",
                                        status="inProgress")],
                       now={"kind": "read", "title": "Reading src/invoices/serializers.ts",
                            "detail": "src/invoices/serializers.ts", "startedAt": self.ago(0.4)}),
                 {"mission": {"text": "Find every place invoices are serialized and list them with one line each.",
                              "from": "parent", "at": self.ago(5)},
                  "trail": [trail("e2", "read", "Read src/invoices/serializers.ts", self.ago(0.4), status="running"),
                            trail("e1", "search", 'rg -n "toJSON|serialize" src/invoices', self.ago(1), exitCode=0,
                                  durationMs=180, detail='rg -n "toJSON|serialize" src/invoices')]})

    def build_login_party(self) -> None:
        """A Claude Code session waiting for permission to run a command, with a working subagent."""
        session, cwd = "demo-login-fix", "D:/src/web-portal"
        party, main, child = f"claude:{session}", f"claude-agent:{session}", f"claude-agent:{session}:a1"
        self.chat(party, "Fix the flaky login test", cwd, 4, OPUS, "claude")
        command = "Remove-Item -Recurse -Force .\\.cache\\playwright"
        self.add(agent(main, "Fix the flaky login test", "claude", updated=self.ago(4), party=party, nickname="Claude Code",
                       model=OPUS, cwd=cwd, status="waiting", attention="needs", needsInput=True,
                       activities=[step("command", "Ran a local command", detail="npx playwright test login.spec.ts",
                                        status="failed", exit_code=1)],
                       ask={"kind": "permission", "tool": "PowerShell", "text": "Allow PowerShell to run this command?",
                            "command": command, "at": self.ago(4), "answerHere": None, "key": "demo-ask-login"},
                       progress={"done": 2, "total": 5, "current": "Clear the stale browser cache"}),
                 {"mission": {"text": "The login test fails about one run in five on CI. Find out why and fix it.",
                              "from": "you", "at": self.ago(31)},
                  "plan": {"steps": [{"text": "Reproduce the failure locally", "status": "done"},
                                     {"text": "Find what the test waits on", "status": "done"},
                                     {"text": "Clear the stale browser cache", "status": "active"},
                                     {"text": "Wait for the session cookie instead of a timeout", "status": "pending"},
                                     {"text": "Run the test 50 times", "status": "pending"}],
                           "at": self.ago(5), "source": "todos"},
                  "said": {"text": "The test clicks Sign in before the session cookie is written, and an old browser "
                                   "build in the Playwright cache makes that window wider. I'd like to clear the cache "
                                   "and re-run before changing the test.", "at": self.ago(4.2)},
                  "trail": [trail("l5", "ask", "Asked to run PowerShell", self.ago(4), detail=command),
                            trail("l4", "agent", "Started subagent Explore", self.ago(9), detail="Find every place the "
                                  "login form's selectors are used.", agentId=child),
                            trail("l3", "command", "npx playwright test login.spec.ts --repeat-each=10", self.ago(12),
                                  status="failed", exitCode=1, durationMs=94_000,
                                  detail="npx playwright test login.spec.ts --repeat-each=10",
                                  output="  ✘ login.spec.ts:14 › signs in (5.0s)\n  ✘ login.spec.ts:14 › signs in (5.1s)\n"
                                         "  3 failed\n  7 passed (1.6m)"),
                            trail("l2", "read", "Read tests/login.spec.ts", self.ago(20), detail="tests/login.spec.ts"),
                            trail("l1", "search", "Searched for waitForTimeout", self.ago(22), detail="waitForTimeout",
                                  paths=["tests/login.spec.ts", "tests/helpers/session.ts"])],
                  "files": []})
        self.add(agent(child, "Explore subagent", "claude", updated=self.ago(0.2), party=party, nickname="Explore subagent",
                       model=HAIKU, cwd=cwd, childOf=main, agentType="Explore",
                       activities=[step("research", "Searched local files", "data-testid=login", status="inProgress")],
                       now={"kind": "search", "title": "Searching for the login form's selectors",
                            "detail": 'rg -n "data-testid=\\"login" src/', "startedAt": self.ago(0.5)}),
                 {"mission": {"text": "Find every place the login form's selectors are used, and say which ones the "
                                      "flaky test relies on.", "from": "parent", "at": self.ago(9)},
                  "trail": [trail("x2", "search", 'rg -n "data-testid=\\"login" src/', self.ago(0.5), status="running"),
                            trail("x1", "read", "Read 6 files", self.ago(3), paths=[f"src/auth/file{n}.tsx" for n in range(6)])]})

    def build_migration_party(self) -> None:
        """A Claude Code session asking an AskUserQuestion with options."""
        session, cwd = "demo-migration-plan", "D:/src/data-platform"
        party, main = f"claude:{session}", f"claude-agent:{session}"
        self.chat(party, "Plan the reporting migration", cwd, 9, SONNET, "claude")
        questions = [{"text": "Which database should the migration target first?",
                      "options": ["Postgres 16 replica", "The reporting warehouse", "Both, in parallel"]},
                     {"text": "May I pause the nightly import during the cutover?",
                      "options": ["Yes, for up to an hour", "No, keep it running"]}]
        self.add(agent(main, "Plan the reporting migration", "claude", updated=self.ago(9), party=party,
                       nickname="Claude Code", model=SONNET, cwd=cwd, status="waiting", attention="needs",
                       activities=[step("tool", "Used AskUserQuestion", status="inProgress")],
                       ask={"kind": "question", "tool": "AskUserQuestion", "text": questions[0]["text"],
                            "questions": questions, "options": questions[0]["options"], "at": self.ago(9),
                            "answerHere": None, "key": "demo-ask-migration"}),
                 {"mission": {"text": "Write a migration plan for moving the reporting tables off the primary database.",
                              "from": "you", "at": self.ago(25)},
                  "plan": {"steps": [{"text": "Inventory the reporting tables", "status": "done"},
                                     {"text": "Choose the first target", "status": "active"},
                                     {"text": "Draft the cutover runbook", "status": "pending"}],
                           "at": self.ago(10), "source": "todos"},
                  "said": {"text": "There are 38 reporting tables; 31 are append-only. Before I draft the cutover I "
                                   "need two decisions from you.", "at": self.ago(9.1)},
                  "trail": [trail("m2", "ask", "Asked 2 questions", self.ago(9)),
                            trail("m1", "command", "psql -c \"\\dt reporting.*\"", self.ago(14), exitCode=0, durationMs=900,
                                  detail="psql -c \"\\dt reporting.*\"")]})

    def build_release_notes(self) -> None:
        """A Codex chat whose final answer ended with a question it can be answered here."""
        chat, cwd = "demo-chat-release-notes", "D:/src/mobile-app"
        self.chat(chat, "Tidy the release notes", cwd, 14, MINI)
        text = ("I found two changelog formats. Should I convert the older entries to the new format, or leave "
                "them as they are?")
        self.add(agent(chat, "Tidy the release notes", "codex", updated=self.ago(14), model=MINI, cwd=cwd,
                       status="idle", attention="needs", turn="completed",
                       activities=[step("update", "Answer", text)],
                       ask={"kind": "reply", "text": text, "at": self.ago(14), "answerHere": "reply",
                            "key": "demo-ask-notes"}),
                 {"mission": {"text": "Tidy CHANGELOG.md: one heading per release, newest first, no duplicate entries.",
                              "from": "you", "at": self.ago(30)},
                  "said": {"text": "Merged 6 duplicate entries and sorted the releases newest first. " + text,
                           "at": self.ago(14)},
                  "trail": [trail("r2", "edit", "Edited CHANGELOG.md", self.ago(16), detail="CHANGELOG.md", added=12,
                                  removed=31),
                            trail("r1", "read", "Read CHANGELOG.md", self.ago(25), detail="CHANGELOG.md")],
                  "files": [{"path": "CHANGELOG.md", "added": 12, "removed": 31, "at": self.ago(16)}]})

    def build_image_pipeline(self) -> None:
        """A Codex chat waiting on an app-server approval that can be answered from the window."""
        chat, cwd = "demo-chat-image-pipeline", "D:/src/media-service"
        self.chat(chat, "Upgrade the image pipeline", cwd, 1, SOL)
        command = "pip install --upgrade pillow==11.2.1"
        self.requests.append({"id": "demo-request-7", "method": "item/commandExecution/requestApproval",
                              "params": {"threadId": chat, "command": command,
                                         "reason": "Upgrade Pillow to fix the WebP crash."}})
        self.add(agent(chat, "Upgrade the image pipeline", "codex", updated=self.ago(1), model=SOL, cwd=cwd,
                       status="active", attention="needs", needsInput=True,
                       activities=[step("command", "Ran a local command", detail=command, status="inProgress")],
                       ask={"kind": "approval", "text": "Allow Codex to run this command?", "command": command,
                            "at": self.ago(1), "answerHere": "respond", "requestId": "demo-request-7",
                            "options": ["Approve once", "Decline"], "key": "demo-ask-image"}),
                 {"mission": {"text": "WebP thumbnails crash the worker on large images. Upgrade Pillow and make sure "
                                      "the thumbnail tests still pass.", "from": "you", "at": self.ago(11)},
                  "said": {"text": "Pillow 11.2.1 fixes the WebP decoder crash. I need to upgrade it before re-running "
                                   "the thumbnail tests.", "at": self.ago(1.1)},
                  "trail": [trail("i2", "ask", "Asked to run a command", self.ago(1), detail=command),
                            trail("i1", "command", "python -m pytest tests/test_thumbnails.py -q", self.ago(6),
                                  status="failed", exitCode=1, durationMs=7_800,
                                  detail="python -m pytest tests/test_thumbnails.py -q",
                                  output="FAILED tests/test_thumbnails.py::test_large_webp - OSError: broken data stream\n"
                                         "1 failed, 14 passed in 7.61s")]})

    def build_search_workspace(self) -> None:
        """An Orca workspace: a coordinator pane, a worker editing, and a worker idle at its prompt."""
        workspace, cwd = "orca:demo-ws-search", "D:/orca/workspaces/search-service/main"
        self.chat(workspace, "Orca · search-service", cwd, 0.3, None, "orca", 3)
        lead = "orca-agent:demo-pane-lead"
        self.add(agent(lead, "index-lead", "orca", updated=self.ago(0.3), party=workspace, model=SOL, cwd=cwd,
                       status="working", pane="demo-pane-lead",
                       activities=[step("update", "Update", "Ranking first, then synonyms.")],
                       now={"kind": "agent", "title": "Coordinating 2 workers", "startedAt": self.ago(18)},
                       progress={"done": 1, "total": 3}),
                 {"mission": {"text": "Improve search relevance for short queries.", "from": "you", "at": self.ago(40)},
                  "plan": {"steps": [{"text": "Import the synonym list", "status": "done"},
                                     {"text": "Tune the ranking weights", "status": "active"},
                                     {"text": "Compare before and after on the eval set", "status": "pending"}],
                           "at": self.ago(18), "source": "orca-tasks"},
                  "screen": {"lines": ["● Coordinating 2 workers", "  ✓ synonym-import   done", "  ▶ ranker-tuning    editing ranking.py",
                                       "", "> "], "at": self.ago(0.3)}})
        self.add(agent("orca-agent:demo-pane-ranker", "ranker-tuning", "orca", updated=self.ago(0.1), party=workspace,
                       model=SONNET, cwd="D:/orca/workspaces/search-service/ranker", status="working",
                       pane="demo-pane-ranker", parentPane="demo-pane-lead",
                       activities=[step("file", "Changed ranking.py", "ranking.py", status="inProgress")],
                       now={"kind": "edit", "title": "Editing search/ranking.py", "detail": "search/ranking.py",
                            "startedAt": self.ago(0.6)}),
                 {"mission": {"text": "Tune the ranking weights so exact title matches beat body matches.",
                              "from": "coordinator", "at": self.ago(17)},
                  "trail": [trail("k1", "edit", "Editing search/ranking.py", self.ago(0.6), status="running")],
                  "screen": {"lines": ["  Editing search/ranking.py", "  - TITLE_WEIGHT = 1.2", "  + TITLE_WEIGHT = 2.5"],
                             "at": self.ago(0.1)}})
        self.add(agent("orca-agent:demo-pane-synonyms", "synonym-import", "orca", updated=self.ago(20), party=workspace,
                       model=MINI, cwd="D:/orca/workspaces/search-service/synonyms", status="waiting", attention="quiet",
                       pane="demo-pane-synonyms", parentPane="demo-pane-lead",
                       activities=[step("update", "Update", "Imported 1,204 synonym pairs.")]),
                 {"said": {"text": "Imported 1,204 synonym pairs and re-built the index.", "at": self.ago(20)},
                  "screen": {"lines": ["Imported 1,204 synonym pairs.", "", "> "], "at": self.ago(20)}})

    def build_done(self) -> None:
        cwd = "D:/src/billing-api"
        self.chat("demo-chat-config-keys", "Rename the config keys", cwd, 120, SOL)
        self.add(agent("demo-chat-config-keys", "Rename the config keys", "codex", updated=self.ago(120), model=SOL,
                       cwd=cwd, status="idle", attention="quiet", turn="completed",
                       activities=[step("update", "Answer", "Renamed 14 keys and updated the docs.")]),
                 {"said": {"text": "Renamed 14 keys and updated the docs. The old names still load for one release.",
                           "at": self.ago(120)},
                  "files": [{"path": "src/config/keys.ts", "added": 28, "removed": 28, "at": self.ago(125)}]})
        party = "claude:demo-onboarding"
        self.chat(party, "Write the onboarding guide", "D:/src/handbook", 40, OPUS, "claude")
        self.add(agent("claude-agent:demo-onboarding", "Write the onboarding guide", "claude", updated=self.ago(40),
                       party=party, nickname="Claude Code", model=OPUS, cwd="D:/src/handbook", status="completed",
                       attention="quiet", turn="completed",
                       activities=[step("update", "Answer", "The guide is in docs/onboarding.md.")]))

    # Answers -----------------------------------------------------------------------------------
    def find(self, ident: str) -> dict | None:
        return next((actor for actor in self.actors if actor["id"] == ident), None)

    def scene(self, now_ms: float | None = None) -> dict:
        now = now_ms if now_ms is not None else time.time() * 1000
        for actor in self.actors:
            # Working goblins stay fresh, so they keep acting out their step.
            if actor.get("attention") == "working" and not actor.get("waitingOn"):
                actor["updatedAt"] = now - 2_000
        return {"root": {"id": "all", "name": "All chats and agents", "activities": []},
                "agents": copy.deepcopy(self.actors), "requests": copy.deepcopy(self.requests),
                "watched": list(self.watched), "manualLinks": dict(self.manual_links), "joinedParties": {},
                "warning": "", "checkedAt": now, "servedAt": now, "coverage": {"complete": True}}

    def detail(self, ident: str) -> dict:
        actor = self.find(ident)
        if actor is None:
            raise ApiError(404, "That agent is no longer in the list.")
        source = actor["source"]
        extra = self.details.get(ident, {})
        party = actor.get("parentThreadId") or ident
        name = next((item["name"] for item in self.catalog if item["id"] == party), actor["name"])
        controls = {**CONTROLS[source], "dismiss": bool(actor.get("ask"))}
        return {"agent": {**copy.deepcopy(actor), "project": actor.get("cwd", "").rstrip("/").split("/")[-1],
                          "party": {"id": party, "name": name}, "controls": controls},
                "mission": extra.get("mission"), "plan": extra.get("plan"), "now": extra.get("now") or actor.get("now"),
                "said": extra.get("said"), "trail": copy.deepcopy(extra.get("trail") or []),
                "files": extra.get("files") or [], "screen": extra.get("screen"), "checkedAt": time.time() * 1000}

    def clear_ask(self, ident: str, dismissed: bool) -> dict:
        actor = self.find(ident)
        if actor is None or not actor.get("ask"):
            raise ApiError(404, "There is nothing to dismiss.")
        if dismissed:
            actor["dismissedAsk"] = {"key": actor["ask"].get("key"), "at": time.time() * 1000}
        actor["ask"] = None
        actor["needsInput"] = False
        actor["attention"] = "quiet"
        return {"ask": None, "dismissedAsk": actor.get("dismissedAsk")}

    def note(self, ident: str, title: str, detail: str = "") -> None:
        record = self.details.setdefault(ident, {})
        record.setdefault("trail", []).insert(0, trail(f"you-{time.time()}", "message", title, time.time() * 1000,
                                                       detail=detail))

    def capabilities(self) -> dict:
        return {"sources": {"codex": {"state": "ok", "detail": "Reading Codex chats.", "replies": True},
                            "claude": {"state": "ok", "detail": "Claude Code sessions appear here.", "replies": False},
                            "orca": {"state": "ok", "detail": "Reading Orca workspaces.", "replies": False},
                            "extensions": {"state": "none", "detail": "No extension feeds yet."}},
                "autostart": {"available": True, "enabled": False},
                "phone": {"enabled": False, "listening": False}}


class DemoApi(HordeApi):
    """HordeApi answered by a DemoWorld: nothing leaves this process."""

    def __init__(self, kind: str = "default", world: DemoWorld | None = None) -> None:
        super().__init__(0)
        self.world = world or DemoWorld(kind)

    def get(self, path: str, timeout: float = 10) -> dict:
        where, _, query = path.partition("?")
        params = urllib.parse.parse_qs(query)
        world = self.world
        if where == "/api/scene":
            return world.scene()
        if where == "/api/agent":
            return world.detail((params.get("id") or [""])[0])
        if where == "/api/capabilities":
            return world.capabilities()
        if where == "/api/threads":
            return {"threads": copy.deepcopy(world.catalog), "unavailable": [], "watched": list(world.watched)}
        if where == "/api/diagnostics":
            return {"text": "Goblin Horde demo: invented goblins, no viewer."}
        raise ApiError(404, "Not found", missing=True)

    def post(self, path: str, data: dict | None = None, timeout: float = 15) -> dict:
        data = data or {}
        world = self.world
        where = route(path)
        if where == "/api/dismiss":
            return world.clear_ask(str(data.get("id")), dismissed=True)
        if where == "/api/respond":
            ident = str(data.get("threadId"))
            world.requests = [item for item in world.requests if item["id"] != data.get("requestId")]
            answer = data.get("decision") or "; ".join(str(value) for value in (data.get("answers") or {}).values())
            world.note(ident, f"You answered: {answer}")
            return {**world.clear_ask(ident, dismissed=False), "answered": True}
        if where in ("/api/message", "/api/reply"):
            ident = str(data.get("id") or data.get("threadId"))
            text = str(data.get("text") or data.get("message") or "")
            world.note(ident, f"You: {text[:120]}", text)
            actor = world.find(ident)
            if actor and (actor.get("ask") or {}).get("answerHere") in ("reply", "orca-send"):
                world.clear_ask(ident, dismissed=False)
            return {"sent": True}
        if where == "/api/open":
            raise ApiError(409, "Nothing opens in the demo: these goblins are invented.")
        if where == "/api/watch":
            ident = str(data.get("id"))
            world.watched = [item for item in world.watched if item != ident]
            if data.get("watched"):
                world.watched.insert(0, ident)
            return {"watched": list(world.watched)}
        if where == "/api/join":
            party = str(data.get("party"))
            if data.get("chat") is None:
                world.manual_links.pop(party, None)
            else:
                world.manual_links[party] = str(data.get("chat"))
            return {"manualLinks": dict(world.manual_links)}
        if where in ("/api/reconnect", "/api/connect-claude", "/api/autostart", "/api/phone", "/api/phone/reset", "/api/quit"):
            raise ApiError(409, "The demo does not change anything on this computer.")
        raise ApiError(405, "Read-only viewer", missing=True)
