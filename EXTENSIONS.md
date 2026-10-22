# Extension feeds

Codex and Claude Code have built-in feeds, and Orca is optional. Any other orchestrator, agent
runner, or script can show its agents as goblin parties by writing a small **extension feed**: newline-
delimited JSON (NDJSON), one event per line, in Goblin Horde's local drop folder.

A feed shows **public progress only**: who is working, what kind of step they took, file base names,
short status messages, and when they need you or fail. A feed cannot carry shell commands, command
output, prompts, transcripts, diffs, environment variables, or secrets. Records that try are rejected.

## Where feeds live

One file per feed, named after it:

| System  | Folder                                                    |
|---------|-----------------------------------------------------------|
| Windows | `%LOCALAPPDATA%\GoblinHorde\feeds\<feed>.ndjson`          |
| macOS   | `~/Library/Application Support/GoblinHorde/feeds/<feed>.ndjson` |
| Linux   | `$XDG_STATE_HOME/goblin-horde/feeds/<feed>.ndjson` (default `~/.local/state/goblin-horde/feeds/`) |

`GOBLIN_HORDE_STATE_DIR` (or `--state-dir`) replaces the base folder. A feed name is 1-32 lowercase
letters, digits, or dashes, such as `relay` or `my-runner`.

The easiest way to write a feed is the manager, which validates every line before saving it:

```
node goblin.mjs emit --feed relay --record '{"v":1,"at":1760000000000,"party":"build-42","agent":"planner","event":"start","lead":true}'
my-orchestrator --events | node goblin.mjs emit --feed relay
node goblin.mjs emit --feed relay --check < sample.ndjson     # validate only, write nothing
```

You can also append lines to the file yourself. Invalid lines are skipped and counted in the
viewer's **Feeds** panel and in `node goblin.mjs status`. Keep each line under 4 KB. The viewer reads
the newest 2 MB of each feed; the manager rolls a feed over to `<feed>.1.ndjson` at 1 MB. If you append
to the file yourself, roll it over the same way.

## Record format (version 1)

| Field       | Required | Meaning |
|-------------|----------|---------|
| `v`         | yes | Always `1`. |
| `feed`      | yes* | The feed name. Must match the file name. *`emit --feed` fills it in. |
| `at`        | yes | When it happened: milliseconds or seconds since 1970, or an ISO 8601 string. Not in the future. |
| `party`     | yes | Stable id for the group of agents working together (1-64 of `A-Z a-z 0-9 . _ -`). |
| `agent`     | yes | Stable id for one agent within the party. |
| `event`     | yes | One of `start`, `step`, `message`, `needs`, `failed`, `done`, `ended`. |
| `partyName` |     | Display name for the party (80 characters). |
| `agentName` |     | Display name for the agent (60 characters). |
| `role`      |     | Short role, such as `Reviewer` (60 characters). |
| `model`     |     | The model this agent runs, such as `claude-sonnet-4-5` or `gpt-5-codex` (80 characters). The goblin shows it on a badge and Claude and OpenAI models get their own goblin tribe. |
| `lead`      |     | `true` marks the party's lead goblin. |
| `cwd`       |     | The project folder; its last part labels the party's project. |
| `step`      | for `step` | One of `read`, `edit`, `search`, `command`, `test`, `research`, `tool`, `plan`. |
| `stepId`    |     | Pairs a `started` step with its later `completed` or `failed` record. |
| `status`    |     | For steps: `started`, `completed` (default), or `failed`. |
| `target`    |     | For `read`/`edit`: a file's **base name** only (no folders). Names that look secret show as "a private file". |
| `label`     |     | For `tool`: a short tool name. |
| `text`      |     | Up to 600 characters, for `message`, `needs`, `failed`, `done`, and `plan`/`research`/`search` steps. Credential-like strings are removed. Ignored on `command` and `test` steps. |

Unknown fields are ignored (and listed by `emit`). The fields `command`, `cmd`, `args`, `output`,
`stdout`, `stderr`, `prompt`, `input`, `transcript`, `diff`, `patch`, `env`, `token`, and `secret`
make the record invalid.

### What each event does

- `start`: the agent begins a turn of work (its goblin starts moving).
- `step`: one observable action. `command` and `test` steps always read "Ran a local command" and
  "Ran checks", whatever else the record says.
- `message`: a public progress update.
- `needs`: the agent is waiting for a person; `text` is the question. A `needs` event without `text` does not alert, because there would be nothing to show. Any later event clears it.
- `failed`: the turn ended in failure; `text` says why in plain words.
- `done`: the turn finished; `text` is a short final answer.
- `ended`: the agent left (its goblin moves to **Done today** in the Horde window).

A turn with no events for two hours is shown as stale rather than working.

### Party and goblin mapping

Each `(feed, party)` becomes one party with the id `ext:<feed>:<party>`; each agent becomes the
goblin `ext-agent:<feed>:<party>:<agent>`. Ids are stable across restarts and file roll-over, so the
widget keeps names, window positions, and notes. The lead is the agent marked `lead`, else the agent
whose id equals the party id, else the first agent seen. Other agents appear as its party members.

Extension parties are watch-only: the viewer cannot send messages to them.

### Example

```
{"v":1,"feed":"relay","at":"2026-10-09T15:00:00Z","party":"build-42","partyName":"Release 42","agent":"planner","agentName":"Planner","lead":true,"event":"start","cwd":"/work/shop"}
{"v":1,"feed":"relay","at":"2026-10-09T15:00:05Z","party":"build-42","agent":"coder","agentName":"Coder","event":"step","step":"edit","target":"cart.js","stepId":"s1","status":"started"}
{"v":1,"feed":"relay","at":"2026-10-09T15:00:40Z","party":"build-42","agent":"coder","event":"step","step":"edit","stepId":"s1","status":"completed"}
{"v":1,"feed":"relay","at":"2026-10-09T15:01:10Z","party":"build-42","agent":"coder","event":"step","step":"test","status":"failed"}
{"v":1,"feed":"relay","at":"2026-10-09T15:02:00Z","party":"build-42","agent":"planner","event":"needs","text":"Two checks fail on Windows. Ship the macOS build anyway?"}
```

## Adapters

Orca has its own built-in reader. To connect another orchestrator, write a small adapter that turns
its events into these records and pipes them to `node goblin.mjs emit --feed <name>`, or appends them
to the feed file. Map only what a person could see on screen; never forward raw command lines or tool
output.
