# Goblin Horde package

This folder is the portable Goblin Horde package. Its manager is `goblin.mjs`, which needs only Node.js. One installation holds two things:

- **The pet game** (Windows only for now). Tiny goblins live along the taskbar. Work that AI agents finish in T3 Code pays coins, and coins grow the horde and send it against bosses.
- **The agent monitor** (Windows, macOS, Linux). The older Horde window, goblin strip, and browser viewer, which show what AI coding agents are doing. See [The agent monitor](#the-agent-monitor-also-available).

When the user asks to install or set up Goblin Horde on Windows, install the pet game, unless they ask for the monitor. Read `README.md` before acting.

## Install the pet game

The package is this folder. It is either a clone of `https://github.com/epoisel/goblin-horde` on branch `goblin-pets`, or the `GoblinHorde` folder from an unzipped `GoblinHorde-Team.zip`. Run every command in this section from this folder.

1. **Check the computer.** Run `node goblin.mjs doctor`. It changes nothing. Report anything missing in plain words. Do not install Node.js, Python, T3 Code, Codex, Claude Code, or Orca unless the user separately asks. The lines under "Pet game" say what the game needs:
   - `pets-node` wants Node.js 22.13 or newer, because the game reads T3 Code's database with the SQLite built into Node.js. An older Node.js (20 or newer) still runs the monitor.
   - `pets-t3` wants T3 Code's database, which exists once T3 Code has been opened on this computer.
   - `pets-python` wants Python 3 with Tkinter, which draws the goblins. Python from python.org with its default options has it.

   If `node` or `pets-python` shows ✗, stop and report it, because the game cannot show. If `pets-node` or `pets-t3` is not ✓, you can still install. Say that the game shows but pays no coins for AI work until that is fixed. A line from Node.js that starts with `ExperimentalWarning: SQLite` is expected.
2. **Install and start.** Run `node goblin.mjs install --no-claude-hooks --surface pets`. It copies only the files in `package-files.json` into the user's own app folder, installs a manager skill for Codex and Claude Code, adds a Start menu entry, and starts the local viewer and the pet game. It needs no administrator rights and never starts at sign-in. The game does not use Claude Code's hooks, so install with `--no-claude-hooks`. With that option, install reads the Claude Code settings file and adds nothing to it. If install stops because that file is not valid JSON, report that, then run the same command without `--no-claude-hooks`, which does not open the file.
3. **Confirm.** The line `The desktop goblins are running.` means the game's window is up. Then read `http://127.0.0.1:43917/api/pets`, which answers this computer only. `ready: true` means the game is open. If `ready` is false, read it again after a few seconds. `game.state.wallet.coins` is the coin count and `game.state.horde.size` is the number of goblins. A new game starts with 25 coins and 3 goblins. When `source.ok` is false, `source.message` says why finished T3 Code work is not being counted.
4. **Report.** Say what doctor found missing, whether the desktop goblins are running, and how many coins and goblins the game has. Ask the user to look at the taskbar, because only they can see the goblins.

Relay these outcomes as the manager words them:

- A port conflict. The manager says whether another program or another Goblin Horde copy holds port 43917. Suggest `--port 43918` on the install command, and read that port in step 3.
- `The pet game did not start`, or `Using the browser viewer instead`. The game is not showing. Report the reason the manager gives.

## Use it later

Use the installed copy's manager. The installed skill gives its exact command. With the default folder on Windows it is `node "%LOCALAPPDATA%\Programs\GoblinHorde\goblin.mjs"` (in PowerShell, write `$env:LOCALAPPDATA`). Add one action:

- `start --surface pets` starts the viewer and the pet game. If the desktop goblins are already running, they keep what they show, and the manager says how to switch. The widget's menu has **Goblin pets**, or you can stop it and start it again with `--surface pets`.
- `stop` stops the game and the viewer. It ends only processes that run this installation's own files.
- `status` says what is installed and running. `doctor` runs the checks again.
- `uninstall` stops Goblin Horde and removes the app files, the manager skills, the Start menu entry, and only this installation's own Claude Code hook entries. The saved game and the settings stay. Use `--remove-settings` only when the user asks to remove their Goblin Horde data too, because it deletes the saved game. Do not remove this source folder unless the user asks.

The Start menu's **Goblin Horde** entry runs `start` without a surface. That opens whatever was showing when the user last chose **Quit Goblin Horde**, so it brings the game back once the user has quit the game that way.

**Quit.** In the game, click the pill that shows the coin count, or right-click a goblin, and choose **Quit Goblin Horde**. That closes the game and stops the viewer.

**Where things live on Windows.** The app files are in `%LOCALAPPDATA%\Programs\GoblinHorde`. The state folder is `%LOCALAPPDATA%\GoblinHorde`. In it, `pets.json` is the saved game, `pets.lock` names the one Goblin Horde that may save it, `goblins.json` holds the widget's settings, and `run` holds the logs. That one writer is enforced by a lock with a heartbeat, not by a lock of the operating system, and `docs/SHARED-PETS.md` says what that leaves open. A file named `pets.json.unreadable.<time>-<letters>` is a copy the game kept of a saved game it could not read. Leave it where it is. `--install-dir` and `--state-dir` choose other folders. On Windows, `manage.ps1 -Action Install|Start|Stop|Status|Uninstall` runs the same manager, and `-Surface pets` starts the pet game.

## One game on several computers

The pet game pays only for T3 Code work on the computer it runs on. When the user's T3 Code runs on one computer and they sit at another, set up a shared game over Tailscale. Read `docs/SHARED-PETS.md` first. The host is the computer where T3 Code runs: it keeps the only saved game and pays the coins. Every other computer is a display that shows the host's game. A computer is a host or a display, never both.

Set it up only when the user asks, with the installed manager:

- On the host: `pets-host enable`, then `start --surface pets`. `pets-host status` prints the Tailscale address and port to join at, the number of paired sessions, and the saved game as counts. `pets-host disable` asks the Goblin Horde that is running to close the listener and sign every display out, and says they are signed out only when it confirms that.
- On a display: `pets-join --host <address>:<port> --code-file <file>`, then `stop` and `start --surface pets`. Stop first, because a viewer chooses its own game or the host's when it starts. The user puts the host's pairing code in that file. Give `--host` the address as `pets-host status` printed it: four plain numbers, or the MagicDNS name. `pets-join --off` goes back to the computer's own game.
- `pets-adopt <path>` starts a host from a `pets.json` the user brought from another computer. Use it only on a host with no saved game, unless the user asks to replace one. `--replace` keeps a copy first. It saves the moment of adoption with the game, and work that finished in T3 Code before that moment is never paid. The path must be the real path of an ordinary file on that computer's own disk. A network share, a drive or folder that stands for one, a link, and a path through a link or a junction are refused.

The host needs the `tailscale` program that Tailscale installs. Without it `pets-host enable` refuses and nothing listens, because only that program can say which address is the computer's Tailscale address and who is calling. The host asks for that address when its listener opens and every 60 seconds after, and closes the listener when the address is no longer the one it listens on. Before it listens it makes `pairing-code.txt` and `shared.json` private to the user's account, and it does not listen when it cannot. Do not install Tailscale unless the user asks.

`docs/SHARED-HOST-PROMPT.md` and `docs/SHARED-JOIN-PROMPT.md` are the two prompts a user gives an agent on each computer. On Windows, `manage.ps1 -Action PetsHost -HostAction enable`, `-Action PetsJoin -HostAddress <address> -CodeFile <file>`, and `-Action PetsAdopt -SaveFile <path>` run the same commands.

The pairing code is the user's to read. Never open `pairing-code.txt` or `remote-code.txt`, never pass the code on a command line, and never repeat it. The code is shown on a screen in two places only, both on the host: `pets-host code` in a terminal the user sits at, and the phone pairing page while phone access is on. Tell the user to run `pets-host code` themselves. The code leaves a computer only when a display pairs, to the host's Tailscale address. Copy no file between computers yourself: the user moves a pairing code or a `pets.json`.

If `pets-host status` says another Goblin Horde holds the saved game, stop and report it. `pets-host status` and `pets-adopt` can take 20 seconds when a lock was left behind, because they watch it first. If `pets-host enable` or `pets-host disable` says a Goblin Horde holds the saved game and did not answer, it changed nothing: report that, and do not edit `shared.json` yourself. A `pets-join` that fails saves nothing on that computer. Its check pairs with the host, so it can leave a session on the host, which ends within a day. Relay what `pets-host`, `pets-join`, and `doctor` say as worded, such as a host that is not reachable, a code the host did not accept, a host address that was refused, a file that could not be made private, or a tailscale program that was not found.

If `/api/pets` answers `ready: false` with `The saved game could not be read. A copy was kept next to it. Nothing was replaced.`, no game was started in its place. Report it as worded, and move, edit, or delete no file in the state folder: what happens to the saved game is the user's to decide.

## The agent monitor (also available)

The same installation is also the agent monitor. `start` without `--surface` opens it, and **Back to the Horde window** in the game's menu switches to it. It shows the transparent desktop goblins on Windows or macOS with Python and Tkinter, and the browser viewer otherwise. On macOS and Linux the monitor is the only part that runs. Install it there with `node goblin.mjs install --no-claude-hooks`. Its other actions are `open --compact`, `app [--task <id>]` (the task view in its own window), and `hooks install|remove|status`.

The monitor can show Claude Code sessions through hooks in the user's Claude Code settings. The pet game never needs them. Connect them only when the user asks to see Claude Code sessions, and ask first unless they already said yes or no. Asking to install Goblin Horde is not by itself a yes. Say it adds Goblin Horde hook entries to `~/.claude/settings.json` (or `CLAUDE_CONFIG_DIR`), keeps every other setting and a backup, and lets Claude Code sessions appear. On yes, run `hooks install` with the installed manager, or `node goblin.mjs install --claude-hooks`. If you cannot ask, do not connect it, and tell the user how to connect it later (`hooks install`).

When Claude Code was connected, say so in the report in a sentence or two: it added Goblin Horde hook entries to their Claude Code user settings (`~/.claude/settings.json` or `CLAUDE_CONFIG_DIR`), kept every other setting, saved a backup beside the file, and records Claude Code activity to a local file on this computer: tool names and what each call works on (commands, file paths, search patterns, web addresses), the questions Claude asks with their options, what its needs-you notifications say, its todo list, prompt and reply excerpts, where the transcripts are, and inside Orca the ids of the Orca terminal it runs in and the terminals its commands direct, with credential-like text blanked first; never tool output, file contents, or reasoning. The viewer reads a Claude Code transcript only to show an agent's details, and to name a session from the title at the transcript's end or the first prompt at its start, on this computer, and a paired phone gets only summaries. Give the opt-out, which is `hooks remove` with the installed manager. If install refused to edit the settings file, report why and that nothing was changed.

## Report plainly

Report missing prerequisites, a port conflict, or a Claude Code settings file the manager refused to edit and why. On macOS, if the manager opened the browser viewer instead of the desktop goblins, give its reason (no Python 3 with Tk 8.6+, or a Tk that cannot draw transparent windows) and say python.org Python or Homebrew `python-tk` provides it. Do not install it unless asked. On Linux, say the browser viewer is used because the transparent desktop widget runs on Windows and macOS.

## Privacy

The pet game reads T3 Code's local database read-only, and takes only token counts, statuses, and timestamps from it. It learns where open windows are only as rectangles, with no window titles and no program names. Nothing leaves the computer unless the user set up a shared game. Then this crosses between the user's own paired computers on their Tailscale network, and nothing else does: the pairing code when a display pairs, each purchase and fight a display asks for, and back from the host the game's numbers and short codes that say why a game is not ready or why work is not counted. No sentence, chat text, or T3 Code data crosses. Phone access (Wi-Fi) stays off until the user turns it on in the menu, and the shared game stays off until the user asks for `pets-host enable`. Never turn either on unasked.

Never print or transmit the pairing code, chat contents, Claude Code settings contents, or files from the Goblin Horde state folder during setup or removal. Other orchestrators connect through the NDJSON format in `EXTENSIONS.md`. Never forward raw commands or tool output into a feed.

## Tests and packaging (source checkout only)

`npm test` uses temporary folders and never touches real settings or starts the viewer. `python -m unittest discover -s test -p "test_*.py"` runs the widget's tests. `node scripts/package.mjs` builds `dist/GoblinHorde-Team.zip` from `package-files.json`. Add any new runtime file there. `node scripts/dev/clean-install.mjs` installs that ZIP into a temporary folder and checks that the pet game loads from the installed copy.
