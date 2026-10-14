# Goblin Horde

**See what your AI coding agents are doing, at a glance.** Goblin Horde turns the agents working on your computer into a party of pixel goblins. Codex chats and their helper agents, Claude Code sessions and their subagents, Orca workspaces, and any tool that writes a simple [extension feed](EXTENSIONS.md) each get a goblin. Each goblin wears its model on a badge (for example **OPUS 5.5** or **GPT-5.6 SOL · XHIGH**), and the model picks its tribe: Claude models are hooded **hexers** with bone-topped staves, OpenAI models are soot-black **sappers** in iron helms and bomb bandoliers, and everything else is a ragged **raider**. Each goblin shows what its agent said and what it visibly did, and flags the ones that need you or have failed. Everything runs on your computer, and Goblin Horde itself sends nothing to any online service.

Goblin Horde shows what your agents visibly did, never their private reasoning (it cannot see it; a goblin's "thinking" bubble means only that the agent is working quietly). **On this computer** that includes the messages agents show you, what each one is asking you (the question itself with its options, or the command, file, or web address a permission prompt is about), what it is doing right now, how far its plan has got, tool and file names, and statuses, plus, where the source provides them, Codex command lines with up to 5,000 characters of their output, Codex tool (MCP) arguments, Orca agents' tool input, the details of pending Codex approvals, and Claude Code commands, file paths, prompt excerpts, and todo lists (see [Connecting Claude Code](#connecting-claude-code)). To show an agent's details, the viewer reads that agent's own records on this computer, and only for agents on screen: a Claude Code session's transcript, a Codex chat, and the newest part of a Codex chat's session file (for its plan and, while its turn is open, the command it may be waiting to have approved). All of this text passes a credential filter first, which removes passwords, tokens, and keys it recognises; it cannot promise to catch every secret. **On a paired phone** (phone access is off unless you turn it on) you get summaries. A phone sees each agent's name, model, and status, its steps' titles and descriptions, filtered Codex command lines, and the messages agents show you, but never command output or tool arguments, and never the words of a question an agent asks you: in a message, each line that asks you something (with any options listed under it) reads "(Asked you a question: see it on this computer.)", and a question in a chat's turn reads just "Asked you a question". Of what an agent asks, is doing, and plans, a phone gets only the kind, how many questions or plan steps, and when, never the question, its options, the command, the path, or the plan step. A pending Codex approval shows the filtered command or folder it would allow, so you never approve blind, but not Codex's reason for asking; Codex's own questions are answered on this computer, and a phone sees only how many are waiting. An alert you have dealt with elsewhere can be dismissed on this computer (remembered for a week in `dismissed.json` in the state folder); a new question from the same agent alerts again.

**Full detail, on this computer only.** When you select a goblin, the viewer reads that one agent's own records here to show what Codex and Claude Code hide: the request that started its current work, its plan, what is running now, every command with its exit code, time and an output tail, the files it changed with line counts, and what it last said. A Claude Code goblin's detail comes from the newest part of its session transcript, a Codex goblin's from the chat's newest turns and its session file's plan, and an Orca goblin's from its terminal screen and Orca's orchestration inbox and task list. Nothing from these reads is saved, all of it passes the credential filter, and it is never sent to a phone: `/api/agent` answers this computer only, so a phone keeps the summaries above.

> **Status: early (0.6).** It works day to day on Windows, but expect rough edges. The macOS desktop widget is implemented but **has not yet been tested on a real Mac**. See [Platform support](#platform-support) and the [macOS smoke check](#on-macos).

## Platform support

| System | What you get | Status |
|---|---|---|
| Windows | The Horde window and goblin strip (Python 3 with Tkinter), or the browser viewer | Desktop widget tested locally by the maintainer |
| macOS | The Horde window and goblin strip (python.org or Homebrew Python with Tk 8.6+), or the browser viewer | Desktop widget implemented and unit-tested with mocks, **not yet run on a real Mac**. Needs a smoke test by someone with a Mac. Falls back to the browser viewer when Tk cannot draw transparent windows. |
| Linux | Browser viewer at <http://127.0.0.1:43917> | No desktop widget. The browser viewer is the full product. |

All systems need **Node.js 20 or newer**. There are no packages to install.

## Quick start

**On Windows:**

1. Install [Node.js](https://nodejs.org) (the LTS version). For the desktop goblins, also install [Python 3](https://www.python.org/downloads/) with its default options ("tcl/tk" stays ticked; "Add python.exe to PATH" is not needed); without it, Goblin Horde opens in your browser instead. If you install Python later, open Goblin Horde again from the Start menu.
2. Download [GoblinHorde-Team.zip](https://github.com/epoisel/goblin-horde/releases/latest/download/GoblinHorde-Team.zip) from the [latest release](https://github.com/epoisel/goblin-horde/releases/latest) and unzip it.
3. Double-click **Install Goblin Horde.cmd**. It shows what it found on this computer, asks whether to show your Claude Code sessions too and whether to start with Windows, installs, and opens your goblins.

Open it again any time from the Start menu (**Goblin Horde**). To update, unzip a newer release and double-click the installer again: your settings, watched chats, and notes are kept, and its two questions default to what you chose before.

**On macOS or Linux** (or from a terminal on Windows), open a terminal in the unzipped folder and run `node goblin.mjs setup`, the same guided install. `node goblin.mjs install` installs without questions; add `--claude-hooks` to also show Claude Code sessions (see [Connecting Claude Code](#connecting-claude-code)). On macOS, the native desktop widget still needs a smoke test on a real Mac (see [On macOS](#on-macos)); the browser viewer is the fallback.

Install copies the app into your own user folder and starts it. It never needs administrator rights, and it starts at sign-in (as the goblin strip; the Start menu entry opens the window) only if you say so (change it later from the widget's ⋯ menu, **Start with Windows**, or with `node goblin.mjs autostart on|off`).

**Uninstall** on Windows by double-clicking **Uninstall Goblin Horde.cmd** (in the unzipped folder or the app folder); it asks before removing anything. Or use the installed copy's manager:

```
node "%LOCALAPPDATA%\Programs\GoblinHorde\goblin.mjs" uninstall                    # Windows (cmd)
node "$env:LOCALAPPDATA\Programs\GoblinHorde\goblin.mjs" uninstall                 # Windows (PowerShell)
node ~/"Library/Application Support/GoblinHorde/app/goblin.mjs" uninstall           # macOS
node ~/.local/share/goblin-horde/goblin.mjs uninstall                               # Linux
```

This stops Goblin Horde and removes its app files, its manager skills, and its own Claude Code hook entries. Add `--remove-settings` to also delete your layout settings, pairing code, watched chats, dismissed alerts, party links, and recorded activity. If you installed with `--install-dir`, use the `goblin.mjs` in that folder instead.

**About the overview video.** The [overview video (GoblinHorde-Overview.mp4)](https://github.com/epoisel/goblin-horde/releases/download/v0.2.0-preview/GoblinHorde-Overview.mp4), recorded with v0.2 before the goblin tribes and model badges, is published separately as a release asset. It is not tracked in the source tree and is not inside the installer ZIP, and you do not need it to install or run Goblin Horde.

## Contributing, security, license

See [CONTRIBUTING.md](https://github.com/epoisel/goblin-horde/blob/main/CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Please report security problems privately as described there. Goblin Horde is released under the [MIT license](LICENSE).

---

# Manual

A local view of the AI agents working on this computer: Codex chats and their helper agents, Claude Code sessions and their subagents, optional Orca workspaces, and any other orchestrator that writes an [extension feed](EXTENSIONS.md). The all-chats view follows the chats in use right now and any you **watch** (☆ on a browser launchpad row, or **Watch this chat** in the Horde window): watched chats are always read and keep their own **Watching** rows, whatever their age. The selector keeps the most recent chats and workspaces close at hand; **⌕ FIND ANY CHAT** searches the full history. Choose a source for a focused view. Each agent gets a pixel goblin from its model's tribe, its own outfit, and a badge naming its model. Dialogue bubbles remain in a scrollable conversation; older ones can be loaded without interrupting new activity.

## Set it up (Windows, macOS, or Linux)

Download this repository, or build `GoblinHorde-Team.zip` with `node scripts/package.mjs` and share that (see [Building the package](#building-the-package)). Unzip it anywhere, then either ask your coding agent **"Install Goblin Horde from this folder and start it"** (Codex and Claude Code follow `AGENTS.md`), or open a terminal in the unzipped folder and run:

```
node goblin.mjs doctor                   # optional: see what this computer has; changes nothing
node goblin.mjs install --claude-hooks   # with Claude Code on this computer: also show its sessions
node goblin.mjs install                  # or: install without touching Claude Code settings
```

When you ask your agent to install it and Claude Code is on this computer, the agent connects Claude Code too and tells you what it changed (see [Connecting Claude Code](#connecting-claude-code)); you are not asked a second time. Say **"without Claude Code"** if you do not want that, or disconnect later with `hooks remove`.

You need **Node.js 20 or newer**. Everything else is optional and only adds feeds: the **Codex CLI** for Codex chats, **Claude Code** for Claude sessions, **Orca** for Orca workspaces, and on Windows or macOS **Python with Tkinter** for the desktop goblins (on macOS, Python 3 from python.org or Homebrew `python-tk`, with Tk 8.6 or newer). Nothing is downloaded or installed for you.

**What install does, in plain terms.** It copies the app (only the files listed in `package-files.json`) into a folder that belongs to you, adds a small "Goblin Horde manager" skill so Codex and Claude Code know how to start, stop, and remove it later, and starts it. On Windows it also adds a **Goblin Horde** Start menu entry (and a sign-in shortcut only if you ask for one). It does not need administrator rights and does not touch anything else outside the folders below; uninstall removes the shortcuts too.

| | App files | Your settings and recorded activity |
|---|---|---|
| Windows | `%LOCALAPPDATA%\Programs\GoblinHorde` | `%LOCALAPPDATA%\GoblinHorde` |
| macOS | `~/Library/Application Support/GoblinHorde/app` | `~/Library/Application Support/GoblinHorde` |
| Linux | `~/.local/share/goblin-horde` | `~/.local/state/goblin-horde` |

Use `--install-dir` and `--state-dir` (or `GOBLIN_HORDE_INSTALL_DIR` and `GOBLIN_HORDE_STATE_DIR`) to choose other folders.

**What you see.** On Windows and macOS with Python and Tkinter, the **Horde window** opens: every agent as a goblin, what it is doing, and what it is asking you (see [The Horde window](#the-horde-window) and [On macOS](#on-macos); the macOS window has not yet been verified on a real Mac). On Linux, and on Windows or macOS without a suitable Python/Tk, the **browser viewer** opens instead at <http://127.0.0.1:43917> and `start` says why; its **Pop out** button opens a small window that keeps the party in view. The browser viewer is the full product on every system; there is no native Linux desktop widget.

**Start, stop, check, remove.** Ask your agent ("Start Goblin Horde", "Stop Goblin Horde", "Is Goblin Horde running?", "Uninstall Goblin Horde"), or run the installed manager, `node <app folder>/goblin.mjs`, with:

- `start` and `stop`. **Quit Goblin Horde**, in the Horde window's **⋯** menu or the goblin strip's right-click menu, closes the window and stops the viewer. Closing the window (its **×** or Alt+F4) only collapses it to the goblin strip; opening Goblin Horde from the Start menu (or `start`) brings the window back to the front. Stop ends only processes in which Node or Python runs this installation's own viewer or widget file directly (a command line that merely mentions the file, for example as an argument to another script, does not count), and checks each one again just before stopping it; never other programs by name or port. Running `start` twice is safe.
- `status` says what is installed, running, and connected. `doctor` checks prerequisites, the Claude Code connection, extension feeds, and the port. `doctor --report` prints a short report that is safe to paste into a bug report: versions, connection states, counts, error categories, and timings, with no chats, names, folder paths, addresses, or pairing codes. The Horde window's **⋯** menu has **Copy diagnostic report**, which copies the same report.
- The Horde window's header names every feed: **Codex ✓ · Claude + · Orca ✓ · Feeds –**. Hover a feed for what it means and whether it takes replies here. Click **Codex ✕** to reconnect a stopped Codex at once (it is also retried by itself, after 5 seconds and then up to a minute apart), and **Claude +** to connect Claude Code after you confirm (the same change as `hooks install`, with a backup). When the viewer answers with a list it built a while ago, the header says **Updated 45s ago**, and it names any gap in what it could read.
- `open --compact` opens the small browser view.
- `uninstall` stops Goblin Horde, removes its app files, its manager skills, and only its own Claude Code hook entries (the ones that run this installation's receiver; another Goblin Horde copy's hooks stay). Your layout settings and phone pairing code stay for a later reinstall. `uninstall --remove-settings` also removes those, the watched chats, dismissed alerts, party links, and the recorded activity. Neither deletes the ZIP or the folder you unzipped.

If port 43917 is busy, install and start stop with a message saying whether another program or another Goblin Horde copy has it. Close that copy (**⋯** → **Quit Goblin Horde** in its window, or right-click its goblins) and run the installer again, or choose another port from a terminal in the unzipped folder: `node goblin.mjs setup --port 43918`. On Windows, `manage.ps1 -Action Install|Start|Stop|Status|Uninstall` still works and runs the same manager.

### Connecting Claude Code

Goblin Horde sees Claude Code through Claude Code's own **hooks**: small commands Claude Code runs at moments like "a tool is about to run" or "the reply is finished". They are added only by `--claude-hooks` or `hooks install`; a plain `node goblin.mjs install` never opens your Claude Code settings. Asking your coding agent to install Goblin Horde on a computer with Claude Code counts as asking for them: the agent runs `install --claude-hooks` and then tells you what changed and how to undo it. To connect or disconnect yourself:

```
node goblin.mjs install --claude-hooks       # at install time
node goblin.mjs hooks install                # or any time later
node goblin.mjs hooks remove                 # disconnect (also done by uninstall)
```

This adds Goblin Horde entries to your Claude Code user settings (`~/.claude/settings.json`, or the folder in `CLAUDE_CONFIG_DIR`). Your other settings and hooks are kept exactly as they were, and the file as it was before Goblin Horde first changed it is saved beside it as `settings.json.goblin-horde-backup` (never overwritten later), with the copy from just before the most recent change in `settings.json.goblin-horde-backup.last`. If that file is not valid JSON, nothing is changed and you are told why. Each entry runs this installation's `claude-hook.mjs` with Node directly, in the background, so Claude Code never waits for it.

**What is recorded**, in a local file in your state folder only, so you can see what each Claude Code agent is doing where Claude Code folds it away: the event type, session and subagent ids, the project folder, the tool's name (for example "Edit" or "Bash"), and what each tool call works on, up to 400 characters: the command line, the full file path (titles use the file's base name, and hide secret-looking names), the search pattern, the web address or search words, a subagent's description and type, or a skill's or connected (MCP) tool's name. Also recorded: the questions Claude asks you with their options, its todo list and task titles with their states, an excerpt of each prompt you send (up to 600 characters), an excerpt of each finished reply with its closing question (up to 600 characters each), where the session's and its subagents' transcript files are, statuses, and the model's name (for example `claude-opus-5-5`). Every text passes the credential filter before it is written, so passwords, tokens, and keys it recognises are blanked as `[secret removed]`. The model's name comes from the hook itself, or, when the hook does not say, from the newest end of the session's own transcript. A subagent's last message is never treated as a question for you: it goes to the agent that started it. **Never recorded:** tool output, file contents, error text, or reasoning. The viewer reads a session's transcript itself only to show the details of an agent on screen, on this computer. Nothing is sent over the network, and a paired phone gets only summaries (see above). The file rolls over at about 1 MB.

**Read, not recorded:** when you select a Claude Code goblin, the viewer reads the newest part of that session's (or subagent's) transcript under `<Claude config folder>/projects` on this computer, at most 8 MB from its end, to show its prompt, plan, commands and their output, and what it said. That read is shown only on this computer and never written anywhere. **Open** brings a session up where it runs: its Orca terminal when it runs in an Orca pane, or the Claude app when the app started it (the app's own link accepts only its own session ids, so the viewer looks up which app session wraps this one in the app's session index, reading only those ids). A session running in another terminal has no Open.

To disconnect, run `node goblin.mjs hooks remove` (or uninstall). It removes only this installation's Goblin Horde entries; if another Goblin Horde copy is connected to the same Claude Code settings, its entries stay. Claude Code sessions that were already open pick up the change after a restart. Replies to Claude Code sessions are made in Claude Code; the viewer is watch-only for them.

### Codex chats that drive Orca

If you run your work from a Codex chat that starts and steers an Orca coordinator (for example a Claude Opus engineer and its workers), Goblin Horde shows them as **one party**: the chat's row holds your Codex goblin and the Orca agents it drives, and the Orca workspace and Claude Code session rows they came from step aside. The link is made when one of the chat's own commands drives an Orca terminal (`orca orchestration worker-start`, `run-create`, `send`, `check`, `terminal send`, and the like; reading or showing a terminal does not count). Workers the coordinator starts follow it, as does anything else working in the same Orca worktree (never the main checkout, where much else runs), and the Orca pane and the Claude Code session that are the same agent become one goblin. Only command lines are read, never their output or your messages. Hover a joined goblin to see why it joined.

When the guess is wrong or missing, right-click a goblin or a party in the Horde window (or a party on the browser launchpad): **Join party to a Codex chat** picks the chat, **Separate** keeps it apart, and **Back to automatic joining** undoes your choice. Choices and links are kept in `links.json` in the state folder.

### Other orchestrators

Orca is read directly when it is installed and running. Orca says "waiting" both for an agent idle at its prompt and for a worker blocked on a question to its coordinator, so a waiting Orca goblin needs you only when its terminal shows a real prompt for you (a permission or question menu, or a y/n question); a worker waiting on its coordinator is shown at work with **Asked the coordinator**, and an idle one rests. To tell them apart the viewer reads the rendered screen of a waiting agent once per state change (a few at a time, three seconds at most) and Orca's orchestration inbox; a coordinator's task list gives its progress. **Open** switches Orca to the agent's terminal and **Message** types one line into it and presses Enter; both are available on this computer only. Any other tool can appear by writing the small NDJSON format in [EXTENSIONS.md](EXTENSIONS.md), for example with `node goblin.mjs emit --feed my-tool`. Feeds carry public progress only; raw commands and output are refused. The **Feeds** list in the viewer's **Camp** panel and `node goblin.mjs status` show which feeds are connected and what is missing.

### Building the package

`node scripts/package.mjs` (or `npm run package`) builds `dist/GoblinHorde-Team.zip` from the explicit allowlist in `package-files.json`, on any system. It stops if a listed file is missing, looks like local state (chats, pairing codes, logs), or contains a personal folder path, e-mail address, or credential-like text. The ZIP holds everything needed to install and run, and none of your chats, tokens, pairing code, state, or machine-specific paths.

Existing Activity Lens layout settings and pairing codes on Windows are copied into Goblin Horde on first launch. The original files are left in place for rollback. A full reset removes both sets of app-owned settings.

## Run from this folder (Windows, for development)

Open PowerShell in this folder and run:

```powershell
.\start.ps1
```

Open <http://127.0.0.1:43917>. The browser viewer has an **ALL PARTIES** launchpad on the left and goblin streams on the right. The launchpad lists **WORKING NOW** parties, with parties that need you or failed at the top and a signal pill on each (for example **NEEDS YOU · 1 QUESTION** or **FAILED · LINT CHECK**), each party's goblins acting out their current work, and up to four parties **RECENTLY USED** in the past week. **Find** (or `/`) and **Find any chat** search saved Codex chats from every workspace, Claude Code sessions, extension-feed parties, and Orca workspaces. **Hide** tucks the launchpad into a small pill that still shows the most urgent party; **Expand** on the pill brings it back.

With **All parties** selected, every working, waiting, or failed goblin gets a stream; click a party to see all of its members. Each stream shows the goblin at the bottom left beside its parchment dialogue (what the agent said) and a **FIELD LOG** of what it visibly did; click a field-log step to see its command and result when the source provides them. Both follow the newest output until you scroll up, then count new lines until you return to the bottom or press **Follow new**. **Condense** folds a stream to one line, **Expand** makes it tall, and **×** hides it for this party until **Show** brings it back. On a phone, the launchpad sits on top and each stream switches between **Dialogue** and **Field log** tabs. Pass `-ThreadId <id>` to start on a specific Codex chat. On any system, `node server.mjs` runs the viewer from this folder too.

Use **Party demo** to watch four invented parties (one waiting on you, one with a failed check, two working, from Codex, Claude Code, an extension feed, and Orca) and two recently used ones. The demo is simulated and does not read chats, start real agents, or change project files.

## The Horde window

On Windows and macOS, `start` (or **Goblin Horde** in the Start menu) opens the **Horde window**: one ordinary window that snaps, alt-tabs, and has its own taskbar button. From a source checkout on Windows, `.\start_goblins.ps1` starts the viewer if needed and opens it; pass `-ThreadId <id>` to open it on one chat. On macOS, `node goblin.mjs start` is designed to open the same window (not yet verified on a Mac; see [On macOS](#on-macos)).

The **header** counts who **needs you**, who is **working**, who **failed**, and who is **done today** (click a count to jump there), names every feed the viewer reads with its one-click fix, and has **Find a chat…** and the **⋯** menu (Reconnect Codex, Connect Claude Code…, Start with Windows, Phone access, New pairing code, Copy diagnostic report, Reduced motion, Keep on top, Show goblin strip, Change goblin outfits, Open the browser viewer, Quit Goblin Horde). If the viewer stops answering, a banner says so, keeps the last good list on screen, and offers **Retry now** (and, in an installed copy, **Restart the viewer**).

The **roster** on the left lists every goblin:

- **Needs you**: each agent waiting on you, the longest waiting first, with its actual question in amber: what a permission would run ("Allow PowerShell: Remove-Item .cache"), the question a Claude Code session asked, or the question at the end of a Codex reply. A worker that asked its Orca coordinator, an Orca agent idle at its prompt, and a subagent's closing words are never here: none of those is a question for you.
- **Working**, grouped by party: the party's name, then its lead (the Codex chat, the Claude Code session, or the Orca coordinator pane), then its members indented under whoever started them, subagents under their parent. A goblin alone in its party has no party heading; its party's name (or a Claude Code session's folder) is shown beside its own. A Claude Code session is named for the newest prompt that says what it is doing, and a subagent for its task ("Explore: Find invoice fixtures"). Each row shows the goblin acting out its work, its name, its plan progress (**3/7**) and how long ago it last moved, and one line: what it is doing now, **Asked the coordinator: …** in lilac, or what failed in coral.
- **Watching**: chats you watch that nobody is working in right now.
- **Just finished**: goblins that finished in the last ten minutes, with their last line, so a finish is never missed. The goblin you are looking at stays selected when it finishes.
- **Done today**: the rest of today's, folded until you open it.

Click a goblin (or use ↑/↓) to see it in full on the right: the goblin at 4x with its model, source, and status (with a live timer), and **Open in Codex / Orca / Claude ↗** and **Message…** when its app allows them. Below that, each section appears only when there is something to show: the **ask** with its exact command and options (a Codex approval can be approved or declined here, and a question at the end of a Codex reply answered with **Reply**; anything else says where to answer it, and **Dismiss** stops the alert until it asks something new), what the agent was **asked to** do and by whom, its **plan** (✓ done, ▸ now, ○ next), what it is doing **now** with the exact command (while a permission is open: what waits for your OK, timed in amber), what it **last said**, its **trail** of steps newest first (click a step to see its command and output, or a started subagent to jump to it), the **files** it changed with lines added and removed, and an Orca agent's **terminal screen**. Every button works from the keyboard too: Tab moves between the roster and the buttons (a gold ring shows where), ↑/↓ choose a goblin, and Return or Space presses a button. These details are read from each agent's own records on this computer, only for the agent you are looking at, with credential-like text removed; a paired phone still sees summaries only. Right-click a goblin to join or separate its party, watch its chat, dismiss its alert, or give it a local name (shown beside its own).

**Find a chat…** filters the roster as you type; press Enter to search every older chat, workspace, and session by title, project, and folder, then pick one to watch it. Ctrl+F jumps to the search, Esc clears it.

The window keeps its size and place (on a display that is still connected), the roster and detail update in place every two seconds without flicker or losing your scroll position, and the selected goblin's records are read only while the window is open. Text uses the system font (Segoe UI on Windows) with commands in Cascadia Mono or Consolas, and the window draws sharply on high-DPI displays; set `"scaleWithDisplay": false` in `goblins.json` in the state folder to let Windows scale it instead. `desktop_widget.py --demo` (also `--demo crowd`, `one`, `long`, or `empty`) shows invented parties without a viewer, for trying it out and for screenshots.

### The goblin strip

Closing the window (×) collapses it to the **goblin strip** (the first time, a short note says so): just the goblins, standing in a row above the taskbar at the bottom right, grouped by party, on top of other windows. A bubble over each head says **?** (needs you), **!** (failed), **…** (working), or **✓** (done, and the goblin is faded); the pill on the left counts who needs you. Each goblin is labelled with the part of its name that tells it from its neighbours. Hover a goblin for its name and what it is doing or asking; click it to open the window on that goblin, or click the pill. Drag the strip anywhere; it remembers where. It shows at most twelve goblins, then **+N**. **Show goblin strip** in the **⋯** menu keeps it on the desktop while the window is open too.

### The goblins

The goblins are a scrappy, hunched horde with long ears, hooked noses, and fanged grins, in three tribes: Claude's hooded hexers (rust cloaks, warpaint, antlers or bone headdresses, a skull-topped staff), OpenAI's sappers (iron pot helms, welding masks, smokestacks, leather aprons, a lit bomb in hand), and raiders for every other agent (spiked caps, skull helms, rag wraps, a rusty blade). Each agent keeps its own outfit. Each goblin carries a small pixel cue beside its head, the same in the roster, the detail, and the strip: a magnifier swept over the work while investigating, a hammer raised and struck with sparks while building, a thought bubble filling with **· · ·** while planning or in quiet active intervals, a swinging brass bell with a waving arm when it needs you, and a red cross with a slumped, squinting goblin when something failed. The body moves with the cue on every beat, and a new action starts on its first frame as soon as it is seen; a goblin briefly acts out each new step it finished. Idle, finished, or disconnected goblins put their tools away. These cues follow public activity and working state; the thought bubble never shows words. **Reduced motion** in the **⋯** menu freezes every goblin on one readable frame (the magnifier raised, the hammer up, three thought dots, the bell, or the cross) that changes only when its action does. Until you choose, the window follows the Windows **Show animations in Windows** setting (on macOS, **Reduce motion** in Accessibility → Display), and your choice is remembered.

### On macOS

> **Not yet verified on a Mac.** Everything in this section describes how the macOS support is designed and unit-tested with mocks on Windows. It has not been run on real Mac hardware. If you have a Mac, please run the smoke check below and report what you find.

The macOS app is the same program as on Windows. The Horde window is an ordinary macOS window with a Dock icon (click the Dock icon to bring the window back from the strip; Cmd+Q closes it and saves its place, leaving the viewer running); the goblin strip uses Tk's native transparent window (`wm attributes -transparent` with a `systemTransparent` background) instead of Windows' colour key, and stays above other windows; right-click, a two-finger click, or Control-click opens the menus; text uses the system font at 13 points with commands in Menlo; `stop` closes it the same way, so its place is saved. It uses no extra packages, only Python 3 with Tkinter: python.org Python, or Homebrew `python` plus `python-tk`, with Tk 8.6 or newer. `doctor` names the Python it found. Apple's `/usr/bin/python3` is only tried when the Command Line Tools are installed (otherwise running it asks to install them), and its older Tk is refused.

`start` waits up to 15 seconds for the app to confirm its windows are up. If this Python's Tk cannot draw the see-through strip (an X11 Tk, Tk older than 8.6, or no window server, for example over SSH), the app exits, `start` says why, and the browser viewer opens instead; details are in `run/widget.log` in the state folder. Known limits: the strip docks on the main display, below the menu bar, and the Dock is not measured, so it may sit over a Dock at the bottom until you drag it; trackpad scrolling moves one step per scroll event.

**macOS smoke check** (not yet run on a Mac; a teammate with a Mac needs to run it before macOS is described as supported):

1. `node goblin.mjs doctor` shows `✓ desktop-widget` and names a python.org or Homebrew Python with Tk 8.6+.
2. `node goblin.mjs install` (or `start`) says "The desktop goblins are running." The Horde window opens with the system font, and a Python icon in the Dock brings it back.
3. Type in **Find a chat…**: letters appear, Enter lists older chats, Esc clears it; ↑/↓ move through the roster.
4. Right-click, two-finger click, and Control-click on a goblin each open its menu without also selecting another row.
5. Click a working goblin: its plan, command, trail, and files appear; click a trail step to see its output; scroll the roster and the detail with the trackpad and a mouse wheel.
6. Close the window: the goblin strip stands on the desktop with no box or dark fringe around it, and clicking in an empty transparent area reaches the window behind. Drag it, then click a goblin: the window opens on that goblin.
7. Goblins animate (magnifier, hammer, thought dots, bell, cross). With System Settings → Accessibility → Display → **Reduce motion** on and no choice saved, they hold still.
8. **Rename goblin…** in a goblin's menu: its dialog appears in front.
9. `node goblin.mjs stop`, then `start`: the window comes back where it was, or the strip if it was collapsed.
10. `node goblin.mjs status` while running shows `Desktop goblins: running`; `stop` ends both processes; `uninstall` leaves no `run/widget.log`.
11. Fallback: run `start` from a shell where the only Python has no Tkinter (or an X11 Tk, for example MacPorts without `+quartz`): `start` says why and opens the browser viewer.

## Open on a phone

Phone access is **off** until you turn it on; install and setup never turn it on. While it is off the viewer listens only on `127.0.0.1`. Turn it on from the Horde window's **⋯** menu (**Phone access (Wi-Fi): Off/On**) or the browser viewer's **Camp** panel. A paired phone can read the chats listed here (as summaries; see the top of this page), send replies to Codex chats, and approve or decline Codex commands and file changes, so only turn it on at home or on another network you trust.

Once it is on, connect your phone to the same Wi-Fi as this computer. The **Camp** panel shows the **phone address** and, when you press **Pair a phone**, the **pairing code**. Open that address on your phone and enter the code. A paired phone stays signed in until the viewer restarts or one day passes; the same code can pair it again after a restart. **New pairing code (forget phones)** in either place makes a new code and signs every phone out; turning phone access off also signs every phone out. If you e-mailed the code to yourself earlier, the pairing page's **Look for a code email** button opens a Gmail search for that message; Goblin Horde never asks for your address and does not send e-mail itself.

With phone access on, the server listens on one private (10.x, 172.16-31.x, 192.168.x) Wi-Fi address, or a wired one when there is no Wi-Fi. It skips VPN and virtual adapters, and on Windows it refuses a network Windows marks as **Public** (set your home network to Private in Windows Settings). The choice is saved as `phone.json` in your Goblin Horde state folder, so it lasts across restarts; so does the pairing code, until you make a new one. For development, `LAN_IP` picks the address by hand, but only while phone access is on. On macOS and Linux the viewer usually finds no Wi-Fi address by name, so set `LAN_IP` there. Anyone with the code and access to the network can view the chats listed here, send replies, and answer Codex approvals. Phone pairing uses plain HTTP, so others on the same network may be able to observe the code or session; see [SECURITY.md](SECURITY.md).

## Alerts and replies

The **Alerts** panel flags new requests for input, completed replies, and failed steps across every party. It retains alerts in the browser. While the page remains open, it checks every two seconds. System notifications work in browsers that permit them on a secure origin; a plain HTTP phone connection does not provide background phone notifications after the page is closed.

The reply box appears in a selected Codex chat and attempts to send there. If that chat is already open in the Codex desktop app, Codex prevents another app-server process from writing to it. Goblin Horde then offers **Send in mobile branch**. This copies the saved conversation into a separate Codex chat, sends the message there, and switches the viewer to the branch. Later phone replies continue there. The desktop chat and mobile branch do not automatically merge. If Codex sends an input or approval request to the Goblin Horde-owned branch, the viewer can present it for a response: a phone can approve or decline a command or file change, and Codex's questions are answered on this computer (a phone is told how many are waiting, not what they say). Orca agent replies are not wired into the phone viewer; use Orca for those conversations.

Requires Node.js 20+. Codex chats need the `codex` CLI; Claude Code sessions need the hooks described above; the Orca feed needs the `orca` CLI and a running Orca desktop app. It uses existing local sign-ins; no separate API key or dependency install is needed.

## How it works

The server starts `codex app-server` locally, reads chats with `thread/list` and `thread/read`, and looks for descendant agent threads. It also reads Orca's local `worktree ps` and `terminal list` snapshots, using visible assistant messages, tool names, and states to build the Orca bubbles, plus `terminal read --screen` for waiting agents and the selected agent, `orchestration inbox`, `orchestration run-list`, and `orchestration task-list`, each with a short timeout. It keeps a short live Orca event history while the server is running. The window's **Open** uses `codex://threads/<id>` for a Codex chat, `orca terminal switch` for an Orca agent, and `claude://code/continue?session=<app session id>` for a session the Claude app runs, each started without a shell after its id is checked; **Message** uses the Codex reply below or `orca terminal send`. For Codex replies it uses `turn/start` or, when the user chooses a branch, `thread/fork` followed by `turn/start`. The web server listens on `127.0.0.1` and, only when you turned phone access on, one private Wi-Fi address with pairing required.

Dialogue is derived from user-visible progress messages and observable actions. It does not display private internal reasoning. Some activity types may have a generic label until a clearer mapping is added. A running Codex turn may appear after Codex saves its next item. The all-chats feed reads only Codex chats that are in use: changed in the past 15 minutes, last seen working, waiting on you, or failed (followed for up to a day), flagged by their list status or a pending Goblin Horde request, or **watched**. Every other chat stays in the catalog, unread, until you open it or watch it. A chat that cannot be read (a very long one can time out) waits 30 seconds before the next try, doubling up to ten minutes, instead of slowing every update. The feed reports every chat it reads that is working, needs input, or failed, along with every working or failed Orca agent and up to five recent quiet chats and agents for context. A chat is reread only when its saved timestamp changes, or every few seconds while it is working, so hundreds of dormant chats cost one paged `thread/list` and no reads. At most 16 chats are read per update; after a restart or a burst of changes the browser launchpad says **CHECKING N CHATS** (the Horde window's header **Checking N chats**) until it catches up, and it names other gaps (Codex or Orca unavailable, unreadable chats, too many active members) instead of claiming the whole machine. Claude Code keeps up to 100 sessions with 24 subagents each, and each extension feed up to 50 parties with 24 agents each; members that need you, failed, or are working fill those places first, and whatever is still left out is counted in the scene's coverage; an active member left out is reported as a gap rather than hidden. Each read loads only a chat's newest turns (3 for the all-parties view, 8 for an opened chat), never its whole history, so even chats with hundreds of megabytes of history open in well under a second. A chat running in the Codex app or CLI shows its unfinished turn as working while the chat stayed active in the last ten minutes. Codex never saves an approval request, so a chat held on one in the Codex app or CLI is recognized from its own session file: when its approval policy can ask, its newest tool call has no result, and nothing has been written for 45 seconds, it shows **NEEDS YOU** with **Waiting for approval?**. From the newest part of that file the viewer reads record types, call ids, timestamps, and the approval policy, plus what the waiting call would do (its command line, or the names of the files a patch changes) and the plan the chat last set (`update_plan` steps); those are shown on this computer only, after the credential filter, and nothing else in the file is kept. A command that runs silently for that long under such a policy can look the same, which the note says. Known limits: older turns of an opened chat are not shown, and a turn that writes nothing for more than a day falls outside the window. The selector shows up to ten sources from the past week, and search covers every discovered Codex chat and Orca workspace. Orca history from before the viewer started is limited to the latest message and action in its snapshot.

## Check

In a source checkout (the tests are not part of the team ZIP):

```
npm test
python -m unittest discover -s test -p "test_*.py"
```

The installer, hook, feed, and packaging tests use temporary folders for every location, so they never read or change your real Claude Code settings or start the viewer.
