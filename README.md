# Goblin Horde

**See what your AI coding agents are doing, at a glance.** Goblin Horde turns the agents working on your computer into a party of pixel goblins. Codex chats and their helper agents, Claude Code sessions and their subagents, Orca workspaces, and any tool that writes a simple [extension feed](EXTENSIONS.md) each get a goblin. Each goblin wears its model on a badge (for example **OPUS 5.5** or **GPT-5.6 SOL · XHIGH**), and the model picks its tribe: Claude models are hooded **hexers** with bone-topped staves, OpenAI models are soot-black **sappers** in iron helms and bomb bandoliers, and everything else is a ragged **raider**. Each goblin shows what its agent said and what it visibly did, and flags the ones that need you or have failed. Everything runs on your computer, and Goblin Horde itself sends nothing to any online service.

Goblin Horde shows what your agents visibly did, never their private reasoning (it cannot see it; a goblin's "thinking" bubble means only that the agent is working quietly). **On this computer** that includes the messages agents show you, tool and file names, and statuses, plus, where the source provides them, Codex command lines with up to 5,000 characters of their output, Codex tool (MCP) arguments, Orca agents' tool input, and the details of pending Codex approvals. All of this text passes a credential filter first, which removes passwords, tokens, and keys it recognises; it cannot promise to catch every secret. **On a paired phone** (phone access is off unless you turn it on) command output and tool arguments are left out entirely; titles, descriptions, messages, filtered command lines, and approval details are shown. Claude Code sessions record less; see [Connecting Claude Code](#connecting-claude-code).

> **Status: early (0.5).** It works day to day on Windows, but expect rough edges. The macOS desktop widget is implemented but **has not yet been tested on a real Mac**. See [Platform support](#platform-support) and the [macOS smoke check](#on-macos).

## Platform support

| System | What you get | Status |
|---|---|---|
| Windows | Transparent desktop goblins (Python 3 with Tkinter), or the browser viewer | Desktop widget tested locally by the maintainer |
| macOS | Transparent desktop goblins (python.org or Homebrew Python with Tk 8.6+), or the browser viewer | Desktop widget implemented and unit-tested with mocks, **not yet run on a real Mac**. Needs a smoke test by someone with a Mac. Falls back to the browser viewer when Tk cannot draw transparent windows. |
| Linux | Browser viewer at <http://127.0.0.1:43917> | No desktop widget. The browser viewer is the full product. |

All systems need **Node.js 20 or newer**. There are no packages to install.

## Quick start

**On Windows:**

1. Install [Node.js](https://nodejs.org) (the LTS version). For the desktop goblins, also install [Python 3](https://www.python.org/downloads/) with its default options ("tcl/tk" stays ticked; "Add python.exe to PATH" is not needed); without it, Goblin Horde opens in your browser instead. If you install Python later, open Goblin Horde again from the Start menu.
2. Download [GoblinHorde-Team.zip](https://github.com/epoisel/goblin-horde/releases/latest/download/GoblinHorde-Team.zip) from the [latest release](https://github.com/epoisel/goblin-horde/releases/latest) and unzip it.
3. Double-click **Install Goblin Horde.cmd**. It shows what it found on this computer, asks whether to show your Claude Code sessions too and whether to start with Windows, installs, and opens your goblins.

Open it again any time from the Start menu (**Goblin Horde**). To update, unzip a newer release and double-click the installer again: your settings, watched chats, and notes are kept, and its two questions default to what you chose before.

**On macOS or Linux** (or from a terminal on Windows), open a terminal in the unzipped folder and run `node goblin.mjs setup`, the same guided install. `node goblin.mjs install` installs without questions; add `--claude-hooks` to also show Claude Code sessions (see [Connecting Claude Code](#connecting-claude-code)). On macOS, the native desktop widget still needs a smoke test on a real Mac (see [On macOS](#on-macos)); the browser viewer is the fallback.

Install copies the app into your own user folder and starts it. It never needs administrator rights, and it starts at sign-in only if you say so (change it later from the widget's ⋯ menu, **Start with Windows**, or with `node goblin.mjs autostart on|off`).

**Uninstall** on Windows by double-clicking **Uninstall Goblin Horde.cmd** (in the unzipped folder or the app folder); it asks before removing anything. Or use the installed copy's manager:

```
node "%LOCALAPPDATA%\Programs\GoblinHorde\goblin.mjs" uninstall                    # Windows (cmd)
node "$env:LOCALAPPDATA\Programs\GoblinHorde\goblin.mjs" uninstall                 # Windows (PowerShell)
node ~/"Library/Application Support/GoblinHorde/app/goblin.mjs" uninstall           # macOS
node ~/.local/share/goblin-horde/goblin.mjs uninstall                               # Linux
```

This stops Goblin Horde and removes its app files, its manager skills, and its own Claude Code hook entries. Add `--remove-settings` to also delete your layout settings, pairing code, and recorded activity. If you installed with `--install-dir`, use the `goblin.mjs` in that folder instead.

**About the overview video.** The [overview video (GoblinHorde-Overview.mp4)](https://github.com/epoisel/goblin-horde/releases/download/v0.2.0-preview/GoblinHorde-Overview.mp4), recorded with v0.2 before the goblin tribes and model badges, is published separately as a release asset. It is not tracked in the source tree and is not inside the installer ZIP, and you do not need it to install or run Goblin Horde.

## Contributing, security, license

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Please report security problems privately as described there. Goblin Horde is released under the [MIT license](LICENSE).

---

# Manual

A local view of the AI agents working on this computer: Codex chats and their helper agents, Claude Code sessions and their subagents, optional Orca workspaces, and any other orchestrator that writes an [extension feed](EXTENSIONS.md). The all-chats view follows the chats in use right now and any you **watch** (☆ on a launchpad row): watched chats are always read and keep their own **★ WATCHING** rows, whatever their age. The selector keeps the most recent chats and workspaces close at hand; **⌕ FIND ANY CHAT** searches the full history. Choose a source for a focused view. Each agent gets a pixel goblin from its model's tribe, its own outfit, and a badge naming its model. Dialogue bubbles remain in a scrollable conversation; older ones can be loaded without interrupting new activity.

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

**What you see.** On Windows and macOS with Python and Tkinter, the transparent desktop goblins open on top of your other windows (see below and [On macOS](#on-macos); the macOS widget has not yet been verified on a real Mac). On Linux, and on Windows or macOS without a suitable Python/Tk, the **browser viewer** opens instead at <http://127.0.0.1:43917> and `start` says why; its **Pop out** button opens a small window that keeps the party in view. The browser viewer is the full product on every system; there is no native Linux desktop widget.

**Start, stop, check, remove.** Ask your agent ("Start Goblin Horde", "Stop Goblin Horde", "Is Goblin Horde running?", "Uninstall Goblin Horde"), or run the installed manager, `node <app folder>/goblin.mjs`, with:

- `start` and `stop`. In the widget menu, **Close goblins** closes only the desktop goblins and **Quit Goblin Horde** also stops the viewer. Closing a goblin window with Alt+F4 only hides it; opening Goblin Horde from the Start menu (or `start`) brings a running widget back to the front. Stop ends only processes in which Node or Python runs this installation's own viewer or widget file directly (a command line that merely mentions the file, for example as an argument to another script, does not count), and checks each one again just before stopping it; never other programs by name or port. Running `start` twice is safe.
- `status` says what is installed, running, and connected. `doctor` checks prerequisites, the Claude Code connection, extension feeds, and the port. `doctor --report` prints a short report that is safe to paste into a bug report: versions, connection states, counts, error categories, and timings, with no chats, names, folder paths, addresses, or pairing codes. The widget menu's **Copy diagnostic report** copies the same report.
- The launchpad's top row names every feed: **CODEX ✓ · CLAUDE – CONNECT · ORCA ✓ · FEEDS –**. Hover a feed for what it means and whether it takes replies here. **CODEX ✕ FIX** reconnects a stopped Codex at once (it is also retried by itself, after 5 seconds and then up to a minute apart), and **CLAUDE – CONNECT** connects Claude Code after you confirm (the same change as `hooks install`, with a backup). When the viewer answers with a list it built a while ago, the status line says **UPDATED 45s AGO** instead of LIVE, and search names any chat list it could not read.
- `open --compact` opens the small browser view.
- `uninstall` stops Goblin Horde, removes its app files, its manager skills, and only its own Claude Code hook entries (the ones that run this installation's receiver; another Goblin Horde copy's hooks stay). Your layout settings and phone pairing code stay for a later reinstall. `uninstall --remove-settings` also removes those and the recorded activity. Neither deletes the ZIP or the folder you unzipped.

If port 43917 is busy, install and start stop with a message saying whether another program or another Goblin Horde copy has it. Close that copy (right-click a goblin, **Quit Goblin Horde**) and run the installer again, or choose another port from a terminal in the unzipped folder: `node goblin.mjs setup --port 43918`. On Windows, `manage.ps1 -Action Install|Start|Stop|Status|Uninstall` still works and runs the same manager.

### Connecting Claude Code

Goblin Horde sees Claude Code through Claude Code's own **hooks**: small commands Claude Code runs at moments like "a tool is about to run" or "the reply is finished". They are added only by `--claude-hooks` or `hooks install`; a plain `node goblin.mjs install` never opens your Claude Code settings. Asking your coding agent to install Goblin Horde on a computer with Claude Code counts as asking for them: the agent runs `install --claude-hooks` and then tells you what changed and how to undo it. To connect or disconnect yourself:

```
node goblin.mjs install --claude-hooks       # at install time
node goblin.mjs hooks install                # or any time later
node goblin.mjs hooks remove                 # disconnect (also done by uninstall)
```

This adds Goblin Horde entries to your Claude Code user settings (`~/.claude/settings.json`, or the folder in `CLAUDE_CONFIG_DIR`). Your other settings and hooks are kept exactly as they were, and the file as it was before Goblin Horde first changed it is saved beside it as `settings.json.goblin-horde-backup` (never overwritten later), with the copy from just before the most recent change in `settings.json.goblin-horde-backup.last`. If that file is not valid JSON, nothing is changed and you are told why. Each entry runs this installation's `claude-hook.mjs` with Node directly, in the background, so Claude Code never waits for it.

**What is recorded**, in a local file in your state folder only: the event type, session and subagent ids, the project folder, the tool's name (for example "Edit" or "Bash"), a file's base name when a tool clearly works on one file (secret-looking names are hidden), statuses, and a short excerpt (up to 600 characters, with credential-like text removed) of each finished reply, and the model's name (for example `claude-opus-5-5`). The model's name comes from the hook itself, or, when the hook does not say, from the newest end of the session's own transcript, where only the model id is read. **Never recorded:** your prompts, tool inputs and outputs, command text, error text, transcript contents, or reasoning. Nothing is sent over the network. The file rolls over at about 1 MB.

To disconnect, run `node goblin.mjs hooks remove` (or uninstall). It removes only this installation's Goblin Horde entries; if another Goblin Horde copy is connected to the same Claude Code settings, its entries stay. Claude Code sessions that were already open pick up the change after a restart. Replies to Claude Code sessions are made in Claude Code; the viewer is watch-only for them.

### Codex chats that drive Orca

If you run your work from a Codex chat that starts and steers an Orca coordinator (for example a Claude Opus engineer and its workers), Goblin Horde shows them as **one party**: the chat's row holds your Codex goblin and the Orca agents it drives, and the Orca workspace and Claude Code session rows they came from step aside. The link is made when one of the chat's own commands drives an Orca terminal (`orca orchestration worker-start`, `run-create`, `send`, `check`, `terminal send`, and the like; reading or showing a terminal does not count). Workers the coordinator starts follow it, as does anything else working in the same Orca worktree (never the main checkout, where much else runs), and the Orca pane and the Claude Code session that are the same agent become one goblin. Only command lines are read, never their output or your messages. Hover a joined goblin to see why it joined.

When the guess is wrong or missing, right-click a party on the launchpad: **Join … to a Codex chat** picks the chat, **Separate** keeps it apart, and **Back to automatic joining** undoes your choice. Choices and links are kept in `links.json` in the state folder.

### Other orchestrators

Orca is read directly when it is installed and running. Any other tool can appear by writing the small NDJSON format in [EXTENSIONS.md](EXTENSIONS.md), for example with `node goblin.mjs emit --feed my-tool`. Feeds carry public progress only; raw commands and output are refused. The **Feeds** list in the viewer's **Camp** panel and `node goblin.mjs status` show which feeds are connected and what is missing.

### Building the package

`node scripts/package.mjs` (or `npm run package`) builds `dist/GoblinHorde-Team.zip` from the explicit allowlist in `package-files.json`, on any system. It stops if a listed file is missing, looks like local state (chats, pairing codes, logs), or contains a personal folder path, e-mail address, or credential-like text. The ZIP holds everything needed to install and run, and none of your chats, tokens, pairing code, state, or machine-specific paths.

Existing Activity Lens layout settings and pairing codes on Windows are copied into Goblin Horde on first launch. The original files are left in place for rollback. A full reset removes both sets of app-owned settings.

## Run from this folder (Windows, for development)

Open PowerShell in this folder and run:

```powershell
.\start.ps1
```

Open <http://127.0.0.1:43917>. The browser viewer matches the desktop widget: an **ALL PARTIES** launchpad on the left and goblin streams on the right. The launchpad lists **WORKING NOW** parties, with parties that need you or failed at the top and a signal pill on each (for example **NEEDS YOU · 1 QUESTION** or **FAILED · LINT CHECK**), each party's goblins acting out their current work, and up to four parties **RECENTLY USED** in the past week. **Find** (or `/`) and **Find any chat** search saved Codex chats from every workspace, Claude Code sessions, extension-feed parties, and Orca workspaces. **Hide** tucks the launchpad into a small pill that still shows the most urgent party; **Expand** on the pill brings it back.

With **All parties** selected, every working, waiting, or failed goblin gets a stream; click a party to see all of its members. Each stream shows the goblin at the bottom left beside its parchment dialogue (what the agent said) and a **FIELD LOG** of what it visibly did; click a field-log step to see its command and result when the source provides them. Both follow the newest output until you scroll up, then count new lines until you return to the bottom or press **Follow new**. **Condense** folds a stream to one line, **Expand** makes it tall, and **×** hides it for this party until **Show** brings it back. On a phone, the launchpad sits on top and each stream switches between **Dialogue** and **Field log** tabs. Pass `-ThreadId <id>` to start on a specific Codex chat. On any system, `node server.mjs` runs the viewer from this folder too.

Use **Party demo** to watch four invented parties (one waiting on you, one with a failed check, two working, from Codex, Claude Code, an extension feed, and Orca) and two recently used ones. The demo is simulated and does not read chats, start real agents, or change project files.

## Desktop goblins

On Windows, run:

```powershell
.\start_goblins.ps1
```

This starts Goblin Horde if needed and opens the always-on-top **All parties** launchpad, the widget's home; pass `-ThreadId <id>` to follow one Codex chat instead. On macOS, `node goblin.mjs start` is designed to open the same widget (not yet verified on a Mac; see [On macOS](#on-macos)).

The launchpad lists **WORKING NOW** parties from across this computer, with goblins that need you or have failed at the top. It shows up to six rows; parties that need you or failed always appear, and **SHOW N MORE WORKING** reveals the rest. These are followed by up to four parties **RECENTLY USED** in the past week. Rows keep their order between updates. Click a row to open that party's roster, click one of its goblins to peek at only that member's stream, or click **EXPAND** to open its streams (any you closed with **×** stay closed). While a party is open, a **YOUR PARTY** card at the top returns to it, with **CONDENSE** and **EXPAND** shortcuts. Older chats stay out of the list: **FIND ⌕**, the **⌕ FIND ANY CHAT** footer, or simply typing searches every chat and workspace by title, project, and folder, newest first, with title matches ranked higher. Use ↑/↓ to choose, Enter to open the roster, and Esc or **×** to close the search; **BY PROJECT ▾** browses the full list grouped by project. Drag the header to move the launchpad, **HIDE** collapses it to a tab, and **⋯** or a right-click opens the menu with the browser catalog, pause, outfits, still goblins, and **Show the goblin line instead**. Each goblin on a working row, and on each roster card, shows its current action cue (see below). The stream and roster **◂ ALL** buttons always return to the launchpad.

The optional goblin line starts with two goblins and rotates through recent activity every eight seconds; its menu has **Show the launchpad (home)** to switch back. The goblins are a scrappy, hunched horde with long ears, hooked noses, and fanged grins, in three tribes: Claude's hooded hexers (rust cloaks, warpaint, antlers or bone headdresses, a skull-topped staff), OpenAI's sappers (iron pot helms, welding masks, smokestacks, leather aprons, a lit bomb in hand), and raiders for every other agent (spiked caps, skull helms, rag wraps, a rusty blade). Every launchpad row, roster card, and stream header names the model; hover a goblin for its tribe, model, and reasoning effort. The control strip has source selection, previous/next page, auto rotation, pause, and a menu. Rotation holds while your pointer is over the widget. Long dialogue advances through every line in its own bubble, with a line count; use the mouse wheel or click **MORE** to move manually, and **REPLAY** to start again. Short updates finish before the goblins rotate; very long updates resume where they left off when that page returns. In **Recent activity**, click a goblin to select its chat or Orca workspace as a party; **CHOOSE** opens a project-grouped party menu. In a selected source, click a goblin or **PARTY** to open its whole party, including members on other overview pages. **OPEN CHAT** inside a stream opens the corresponding browser view. Drag a goblin to move the overview. Right-click a goblin to hide it, restore hidden goblins, change the number of columns, preview the animated goblin actions, or change outfits. Layout and hidden goblins are remembered. The widget keeps its last good scene visible when a source is temporarily unavailable. Python 3 with Tkinter is required.

For a parallel-work view, open a party from the launchpad. Every stream has a **◂ ALL** button that returns to the launchpad, and its **PARTY ▾** menu can switch to a recent party, browse by project, or search; switching opens the chosen party. Each window places its goblin at the bottom left of a fantasy dialogue box. Miniature portraits of party members appear in the window's left edge; click one to focus its stream without changing the party, and use the mouse wheel over the roster if the party has more than 14 members. The numbered roster and name header identify each member, and the roster shows how many streams fit on screen. Windows tile automatically; members beyond the display's capacity stay in the roster, and selecting one swaps it into a tile. Input requests and failures receive priority, while related streams stay grouped. The stage label describes observable planning, exploration, building, checking, waiting, or repair; ↺ appears only when recorded public activity shows a repeated stage. The terminal-like field log sits to the goblin's right, with distinct, scrollable event entries, a workflow badge, **DETAILS** for technical actions, **OPEN CHAT**, and a follow-new control. Each goblin carries a small pixel cue beside its head, the same in the launchpad, the party roster, the goblin line, and every stream: a magnifier swept over the work while investigating, a hammer raised and struck with sparks while building, a thought bubble filling with **· · ·** while planning or in quiet active intervals, a swinging brass bell with a waving arm when it needs you, and a red cross with a slumped, squinting goblin when something failed. The body moves with the cue on every beat, and a new action starts on its first frame as soon as it is seen. Idle, finished, or disconnected goblins put their tools away. These cues follow public activity and working state; the thought bubble never shows words, because private reasoning is not visible. **EARLIER** loads older events in groups without discarding the current ones; right-click an event to copy it. Drag a window by its header, or move it with Windows' own keys (such as Win+Shift+Arrow), to put it anywhere, including another display left of, right of, or above the main one. A window you moved keeps exactly that spot through refreshes, members joining or leaving, hiding and expanding, closing and reopening, and restarts; new windows tile neatly around it. If its display is no longer connected, it is tiled again on the main display. **Rebalance party windows** is the one action that puts every window back on the automatic tiles. Every stream has **CLOSE ×**, an edge close button, **OVERVIEW**, and **PARTY** controls. **×** closes only that window: the member stays in the party and its roster, keeps working or retiring as before, and its window stays closed through refreshes, **EXPAND**, and restarts. A closed member's roster tile is dimmed and says **▸ OPEN** on hover; click it, or pick the member in the party menu, to reopen that one window. **Rally whole party (reopen closed)** in the party menu or right-click menu reopens every window. Members who join later still open on their own, and closing windows in one party never affects another. Closing every window leaves the party condensed to its roster; **EXPAND** from there opens them all again. The party menu can rename the current goblin locally, preview its motions, focus or close any open stream, and manage streams retained from a previous source; closing one of those keeps it closed when you return to its own party. A local name appears beside the agent name reported by Codex or Orca. The open set and reading preferences are remembered across restarts. A stream can reach all events currently available from its selected source; Orca events before the viewer started and older events beyond its retained history may be unavailable.

Each stream opens on its newest available output and follows new bubbles. All members of a focused party refresh from the same party scene, including child agents. Scrolling up holds that reading position and counts new bubbles; scrolling back to the bottom or pressing **FOLLOW NEW** resumes live following. That temporary hold clears when the stream is hidden or reopened. Finished agents make a small idle motion with no cue; **PARTY → Preview motions (demo)** cycles through the actions on demand. **Still goblins (reduce motion)**, in the launchpad **⋯** menu, the party menu, and the goblin line's right-click menu, freezes every goblin on one readable frame (the magnifier raised, the hammer up, three thought dots, the bell, or the cross) that changes only when its action does; **Animate goblin actions** turns motion back on. Until you choose, the widget follows the Windows **Show animations in Windows** setting (on macOS, **Reduce motion** in Accessibility → Display), and your choice is remembered.

**Retiring goblins and parting notes.** When a member of the open party ends its work, its goblin sinks through a small pixel portal and leaves a **parting note** in the widget. A child member retires when its source says its work ended (its latest Codex turn completed or was interrupted, or Orca marked it done) and that ending reads the same, with no new public events, in two complete reads of the party in a row. The widget does not need to have watched it work, so children that finished before the widget started also part, once. The outcome is one of **TURN DONE** (a Codex child agent's turn completed with no open question), **MARKED DONE** (Orca marked the agent done), **STOPPED** (the turn was interrupted), or **LEFT** (a member seen working went missing from two complete reads; the outcome is unknown). **TURN DONE** means only that the agent's latest turn ended, not that the whole task succeeded. Only **TURN DONE** and **MARKED DONE** goblins wave goodbye on the way down; stopped and left goblins sink without waving. Failed members, members waiting on you or with an open question, idle members with no recorded turn, the party's own chat, and other parties on the launchpad stay put. Nothing retires on a partial or failed read, or when much of the party disappears at once.

A note gives the agent's name and source, the outcome, when it was seen, and an excerpt: **Final answer** only when the feed marked it as the answer of the turn that ended, otherwise **Last update** (the newest public update the feed showed), or **No public update captured**. It also lists up to four changed file names and the command, web search, or tool-step counts the feed showed. It never includes reasoning, command text, or command output. In the compact roster, the newest note sits in a band under the goblins: click it or **READ** to open the party's notes, and **×** dismisses that note. The notes panel opens beside the roster or stream, can be dragged by its header, grows with its notes and then scrolls, and has **OPEN CHAT** and **DISMISS** on each note and **CLEAR ALL** for the party; **×** or Esc closes it. After a dismissal or **CLEAR ALL**, **UNDO** brings the notes back for 30 seconds. An expanded stream pins the note above its field log; closing the stream keeps the note. When the party is hidden, the tab counts unread notes (**✉ N NEW**) separately from the needs-you and failed counts, and its **✉** button opens the roster with the notes. The party menu also has **Read parting notes** and **Clear this party's parting notes**. With **Still goblins** there is no portal: the goblin leaves at once and its note appears immediately. **Preview motions (demo)** never writes a note.

Each retirement is also remembered by a small local marker, saved separately from the notes, so dismissing, clearing, or expiring a note never brings a goblin back; only public work newer than the marker revives it and removes its note. Known limits: notes keep the newest 20 for up to 14 days, with excerpts of up to 180 characters; markers keep the newest 400 for up to 90 days. A goblin that already parted never parts again after a restart; one that had not yet parted needs two fresh complete reads. **LEFT** says nothing about whether the work succeeded.

Use **CONDENSE** in any stream to gather the selected party into one compact roster. Click a goblin there to peek at only that member's stream; click the same goblin again to close the peek, or click another to swap it. **EXPAND** restores the party's streams (except ones you closed with **×**) and focuses the last member you peeked at; peeking at a closed member reopens its window. **HIDE ALL** in a stream, or **HIDE** on the roster, leaves a small tab. Click the tab's badge to return to the view you hid, or use **ROSTER** or **EXPAND** to choose a view directly. Right-click the roster or tab for party management, including leaving the party or closing Goblin Horde. Switching to a new party keeps your preferred expanded or compact layout. The chosen display mode is restored when the desktop widget starts again, and a connection outage leaves a party roster visible for recovery.

### On macOS

> **Not yet verified on a Mac.** Everything in this section describes how the macOS support is designed and unit-tested with mocks on Windows. It has not been run on real Mac hardware. If you have a Mac, please run the smoke check below and report what you find.

The macOS widget is the same program as on Windows (launchpad, goblin line, party roster, streams, parting notes, controls, animations, and saved layout) with macOS window setup: the goblin line and the streams use Tk's native transparent windows (`wm attributes -transparent` with a `systemTransparent` background) instead of Windows' colour key; every panel is borderless and stays above other windows; right-click, a two-finger click, or Control-click opens the menus; Menlo, Avenir Next Condensed, and Helvetica Neue stand in for Consolas, Bahnschrift, and Segoe UI, at the Windows layout's scale; it runs without a Dock icon or menu bar; `stop` closes it the same way **Close goblins** does, so the layout is saved. It uses no extra packages, only Python 3 with Tkinter: python.org Python, or Homebrew `python` plus `python-tk`, with Tk 8.6 or newer. `doctor` names the Python it found. Apple's `/usr/bin/python3` is only tried when the Command Line Tools are installed (otherwise running it asks to install them), and its older Tk is refused.

`start` waits up to 15 seconds for the widget to confirm its transparent windows are up. If this Python's Tk cannot draw them (an X11 Tk, Tk older than 8.6, or no window server, for example over SSH), the widget exits, `start` says why, and the browser viewer opens instead; details are in `run/widget.log` in the state folder. Known limits: windows are placed on the main display, below the menu bar, and saved spots on other displays are trusted as they are; Windows' own keys for moving windows have no macOS equivalent, so drag the header; the Dock is not measured, so tiles may sit over a Dock on the side or bottom; trackpad scrolling moves one row per scroll event.

**macOS smoke check** (not yet run on a Mac; a teammate with a Mac needs to run it before macOS is described as supported):

1. `node goblin.mjs doctor` shows `✓ desktop-widget` and names a python.org or Homebrew Python with Tk 8.6+.
2. `node goblin.mjs install` (or `start`) says "The desktop goblins are running." No Python icon appears in the Dock.
3. The **All parties** launchpad appears bottom right, above other apps, and stays visible after clicking another app's window.
4. **FIND ⌕**, then type: letters appear in the search box; ↑/↓, Enter, and Esc work.
5. Right-click, two-finger click, and Control-click on the launchpad each open the **⋯** menu, without also opening a row.
6. Open a party and **EXPAND**: each stream's goblin, speech tail, and roster portraits stand on the desktop with no box or dark fringe around them, and clicking in an empty transparent area reaches the window behind.
7. Goblins animate (magnifier, hammer, thought dots, bell, cross). With System Settings → Accessibility → Display → **Reduce motion** on and no choice saved, they hold still.
8. Drag a stream and the launchpad by their headers, scroll a field log and the roster with the trackpad and a mouse wheel, right-click an event and paste the copied text.
9. **CONDENSE**, **HIDE**, the tab, parting notes, **Rename this goblin…** in the party menu (its dialog must appear in front), and **Show the goblin line instead** with its transparent background and right-click menu.
10. `node goblin.mjs stop`, then `start`: the layout, open streams, and display mode come back.
11. `node goblin.mjs status` while running shows `Desktop goblins: running`; `stop` ends both processes; `uninstall` leaves no `run/widget.log`.
12. Fallback: run `start` from a shell where the only Python has no Tkinter (or an X11 Tk, for example MacPorts without `+quartz`): `start` says why and opens the browser viewer.

## Open on a phone

Phone access is **off** until you turn it on; install and setup never turn it on. While it is off the viewer listens only on `127.0.0.1`. Turn it on from the desktop goblins' launchpad **⋯** menu (**Phone access (Wi-Fi): Off/On**) or the browser viewer's **Camp** panel. A paired phone can read the chats listed here, send replies to Codex chats, and approve or decline Codex commands and file changes, so only turn it on at home or on another network you trust.

Once it is on, connect your phone to the same Wi-Fi as this computer. The **Camp** panel shows the **phone address** and, when you press **Pair a phone**, the **pairing code**. Open that address on your phone and enter the code. A paired phone stays signed in until the viewer restarts or one day passes; the same code can pair it again after a restart. **New pairing code (forget phones)** in either place makes a new code and signs every phone out; turning phone access off also signs every phone out. If you e-mailed the code to yourself earlier, the pairing page's **Look for a code email** button opens a Gmail search for that message; Goblin Horde never asks for your address and does not send e-mail itself.

With phone access on, the server listens on one private (10.x, 172.16-31.x, 192.168.x) Wi-Fi address, or a wired one when there is no Wi-Fi. It skips VPN and virtual adapters, and on Windows it refuses a network Windows marks as **Public** (set your home network to Private in Windows Settings). The choice is saved as `phone.json` in your Goblin Horde state folder, so it lasts across restarts; so does the pairing code, until you make a new one. For development, `LAN_IP` picks the address by hand, but only while phone access is on. On macOS and Linux the viewer usually finds no Wi-Fi address by name, so set `LAN_IP` there. Anyone with the code and access to the network can view the chats listed here, send replies, and answer Codex approvals. Phone pairing uses plain HTTP, so others on the same network may be able to observe the code or session; see [SECURITY.md](SECURITY.md).

## Alerts and replies

The **Alerts** panel flags new requests for input, completed replies, and failed steps across every party. It retains alerts in the browser. While the page remains open, it checks every two seconds. System notifications work in browsers that permit them on a secure origin; a plain HTTP phone connection does not provide background phone notifications after the page is closed.

The reply box appears in a selected Codex chat and attempts to send there. If that chat is already open in the Codex desktop app, Codex prevents another app-server process from writing to it. Goblin Horde then offers **Send in mobile branch**. This copies the saved conversation into a separate Codex chat, sends the message there, and switches the viewer to the branch. Later phone replies continue there. The desktop chat and mobile branch do not automatically merge. If Codex sends an input or approval request to the Goblin Horde-owned branch, the viewer can present it for a response. Orca agent replies are not wired into the phone viewer; use Orca for those conversations.

Requires Node.js 20+. Codex chats need the `codex` CLI; Claude Code sessions need the hooks described above; the Orca feed needs the `orca` CLI and a running Orca desktop app. It uses existing local sign-ins; no separate API key or dependency install is needed.

## How it works

The server starts `codex app-server` locally, reads chats with `thread/list` and `thread/read`, and looks for descendant agent threads. It also reads Orca's local `worktree ps` and `terminal list` snapshots, using visible assistant messages, tool names, and states to build the Orca bubbles. It keeps a short live Orca event history while the server is running. For Codex replies it uses `turn/start` or, when the user chooses a branch, `thread/fork` followed by `turn/start`. The web server listens on `127.0.0.1` and, only when you turned phone access on, one private Wi-Fi address with pairing required.

Dialogue is derived from user-visible progress messages and observable actions. It does not display private internal reasoning. Some activity types may have a generic label until a clearer mapping is added. A running Codex turn may appear after Codex saves its next item. The all-chats feed reads only Codex chats that are in use: changed in the past 15 minutes, last seen working, waiting on you, or failed (followed for up to a day), flagged by their list status or a pending Goblin Horde request, or **watched**. Every other chat stays in the catalog, unread, until you open it or watch it. A chat that cannot be read (a very long one can time out) waits 30 seconds before the next try, doubling up to ten minutes, instead of slowing every update. The feed reports every chat it reads that is working, needs input, or failed, along with every working or failed Orca agent and up to five recent quiet chats and agents for context. A chat is reread only when its saved timestamp changes, or every few seconds while it is working, so hundreds of dormant chats cost one paged `thread/list` and no reads. At most 16 chats are read per update; after a restart or a burst of changes the launchpad says **CHECKING N CHATS** until it catches up, and it names other gaps (Codex or Orca unavailable, unreadable chats, too many active members) instead of claiming the whole machine. Claude Code keeps up to 100 sessions with 24 subagents each, and each extension feed up to 50 parties with 24 agents each; members that need you, failed, or are working fill those places first, and whatever is still left out is counted in the scene's coverage; an active member left out is reported as a gap rather than hidden. Each read loads only a chat's newest turns (3 for the all-parties view, 8 for an opened chat), never its whole history, so even chats with hundreds of megabytes of history open in well under a second. A chat running in the Codex app or CLI shows its unfinished turn as working while the chat stayed active in the last ten minutes. Codex never saves an approval request, so a chat held on one in the Codex app or CLI is recognized from its own session file: when its approval policy can ask, its newest tool call has no result, and nothing has been written for 45 seconds, it shows **NEEDS YOU** with **Waiting for approval?** (only record types, call ids, and timestamps are read from that file, never content). A command that runs silently for that long under such a policy can look the same, which the note says. Known limits: older turns of an opened chat are not shown, and a turn that writes nothing for more than a day falls outside the window. The selector shows up to ten sources from the past week, and search covers every discovered Codex chat and Orca workspace. Orca history from before the viewer started is limited to the latest message and action in its snapshot.

## Check

In a source checkout (the tests are not part of the team ZIP):

```
npm test
python -m unittest discover -s test -p "test_*.py"
```

The installer, hook, feed, and packaging tests use temporary folders for every location, so they never read or change your real Claude Code settings or start the viewer.
