# Goblin Horde package

This folder is the Goblin Horde pet game. Tiny goblins live along the Windows taskbar. Work that AI agents finish in T3 Code pays coins, and coins grow the horde and send it against bosses. The game runs on Windows only. Its manager is `goblin.mjs`, which needs only Node.js.

The earlier Goblin Horde agent monitor is a separate app on the `main` branch of the same repository.

When the user asks to install or set up Goblin Horde, install the pet game. Read `README.md` before acting.

## Install the pet game

The package is this folder. It is either a clone of `https://github.com/epoisel/goblin-horde` on branch `goblin-pets`, or the `GoblinHorde` folder from an unzipped `GoblinHorde-Team.zip`. Run every command in this section from this folder.

1. **Check the computer.** Run `node goblin.mjs doctor`. It changes nothing. Report anything missing in plain words. Do not install Node.js, Python, T3 Code, or Tailscale unless the user separately asks. The lines under "Pet game" say what the game needs:
   - `pets-node` wants Node.js 22.13 or newer, because the game reads T3 Code's database with the SQLite built into Node.js.
   - `pets-t3` wants T3 Code's database, which exists once T3 Code has been opened on this computer.
   - `pets-python` wants Python 3 with Tkinter, which draws the goblins. Python from python.org with its default options has it.

   If `node` or `pets-python` shows ✗, stop and report it, because the game cannot show. If `pets-node` or `pets-t3` is not ✓, you can still install. Say that the game shows but pays no coins for AI work until that is fixed. A line from Node.js that starts with `ExperimentalWarning: SQLite` is expected. Under "Updates", `update-key` with `!` means this build has no update key, so it cannot update itself. The game still runs. Say so, and say that a build made after the maintainer ran `keygen` updates itself.
2. **Install and start.** Run `node goblin.mjs install`. It copies only the files in `package-files.json` into the user's own app folder, installs a manager skill for Codex and Claude Code, adds a Start menu entry, and starts the local server and the pet game. It needs no administrator rights and never starts at sign-in. An earlier build of Goblin Horde could add its own entries to the Claude Code settings file. Install, start, and uninstall take out this installation's own entries and keep every other setting. Relay what the manager says about that.
3. **Confirm.** The line `The desktop goblins are running.` means the game's window is up. Then read `http://127.0.0.1:43917/api/pets`, which answers this computer only. `ready: true` means the game is open. If `ready` is false, read it again after a few seconds. `game.state.wallet.coins` is the coin count and `game.state.horde.size` is the number of goblins. A new game starts with 25 coins and 3 goblins. When `source.ok` is false, `source.message` says why finished T3 Code work is not being counted.
4. **Report.** Say what doctor found missing, whether the desktop goblins are running, and how many coins and goblins the game has. Ask the user to look at the taskbar, because only they can see the goblins.

Relay these outcomes as the manager words them:

- A port conflict. The manager says whether another program or another Goblin Horde copy holds port 43917. Suggest `--port 43918` on the install command, and read that port in step 3.
- The pet game did not start. Report the reason the manager gives.

## Use it later

Use the installed copy's manager. The installed skill gives its exact command. With the default folder it is `node "%LOCALAPPDATA%\Programs\GoblinHorde\goblin.mjs"` (in PowerShell, write `$env:LOCALAPPDATA`). Add one action:

- `start` starts the local server and the pet game. Running it twice is safe.
- `stop` stops the game and the local server. It ends only processes that run this installation's own files.
- `status` says what is installed and running. `doctor` runs the checks again.
- `uninstall` stops Goblin Horde and removes the app files, the manager skills, the Start menu entry, and only this installation's own Claude Code settings entries. The saved game and the settings stay. Use `--remove-settings` only when the user asks to remove their Goblin Horde data too, because it deletes the saved game. Do not remove this source folder unless the user asks.
- `update` looks on github.com for a newer signed release of the pet game and puts it in place now: it stops the game, installs the release with the release's own manager, and starts it. `update --check` only says what is there and changes nothing. `update --rollback` goes back to the version installed before the last update.

**Updates.** An installed copy updates itself from the repository's GitHub releases. While the game runs, it looks for a newer release two minutes after it starts and about once a day after that, and a release it finds goes in the next time Goblin Horde starts. The game's menu also offers **Update to** the new version **and restart**. Every release is signed: a copy uses one only when its signature checks out against the key built into the copy and its package has exactly the signed size, SHA-256, version, and files. A release that fails any check is not written anywhere, and an update never opens the saved game or the settings. If a new version does not install or start, the earlier one is put back and started, and the new one is not tried again by itself. `update --off` stops the daily look and `update --on` resumes it. Change it only when the user asks. `status` and `doctor` show the installed version, the last check and its result, a release waiting, and whether the daily look is on. Relay what `update` says as worded, a refusal included. Never fetch or install a release any other way. Never change `lib/update-key.mjs` by hand, since only the maintainer's `node scripts/release.mjs keygen` writes it, once, and never change the state folder's `updates` folder.

A copy installed before the updater existed has no updater. The first install of a build with the updater is by hand on each computer, with the steps above. From then on, releases reach it by themselves.

The Start menu's **Goblin Horde** entry runs `start`.

**Quit.** In the game, click the pill that shows the coin count, or right-click a goblin, and choose **Quit Goblin Horde**. That closes the game and stops the local server.

**Another screen.** With more than one display, the same menu has **Move to screen**. The game remembers the choice.

**Where things live.** The app files are in `%LOCALAPPDATA%\Programs\GoblinHorde`. The state folder is `%LOCALAPPDATA%\GoblinHorde`. In it, `pets.json` is the saved game and `pets.json.bak` its backup. `pets.lock` names the one Goblin Horde that may save it. `goblins.json` holds the widget's settings, the chosen screen among them, and `run` holds the logs. That one writer is enforced by a lock with a heartbeat, not by a lock of the operating system, and `docs/SHARED-PETS.md` says what that leaves open. A file named `pets.json.unreadable.<time>-<letters>` is a copy the game kept of a saved game it could not read. Leave it where it is. `--install-dir` and `--state-dir` choose other folders. `manage.ps1 -Action Install|Start|Stop|Status|Uninstall` runs the same manager.

## One game on several computers

The pet game pays only for T3 Code work on the computer it runs on. When the user's T3 Code runs on one computer and they sit at another, set up a shared game over Tailscale. Read `docs/SHARED-PETS.md` first. The host is the computer where T3 Code runs: it keeps the only saved game and pays the coins. Every other computer is a display that shows the host's game. A computer is a host or a display, never both.

Set it up only when the user asks, with the installed manager:

- On the host: `pets-host enable`, then `start`. `pets-host status` prints the Tailscale address and port to join at, the number of paired sessions, and the saved game as counts. `pets-host disable` asks the Goblin Horde that is running to close the listener and sign every display out, and says they are signed out only when it confirms that.
- On a display: `pets-join --host <address>:<port> --code-file <file>`, then `stop` and `start`. Stop first, because Goblin Horde chooses its own game or the host's when it starts. The user puts the host's pairing code in that file. Give `--host` the address as `pets-host status` printed it: four plain numbers, or the MagicDNS name. `pets-join --off` goes back to the computer's own game.
- `pets-adopt <path>` starts a host from a `pets.json` the user brought from another computer. Use it only on a host with no saved game, unless the user asks to replace one. `--replace` keeps a copy first. It saves the moment of adoption with the game, and work that finished in T3 Code before that moment is never paid. The path must be the real path of an ordinary file on that computer's own disk. A network share, a drive or folder that stands for one, a link, and a path through a link or a junction are refused.

The host needs the `tailscale` program that Tailscale installs. Without it `pets-host enable` refuses and nothing listens, because only that program can say which address is the computer's Tailscale address and who is calling. The host asks for that address when its listener opens and every 60 seconds after, and closes the listener when the address is no longer the one it listens on. Before it listens it makes `pairing-code.txt` and `shared.json` private to the user's account, and it does not listen when it cannot. Do not install Tailscale unless the user asks.

`docs/SHARED-HOST-PROMPT.md` and `docs/SHARED-JOIN-PROMPT.md` are the two prompts a user gives an agent on each computer. `manage.ps1 -Action PetsHost -HostAction enable`, `-Action PetsJoin -HostAddress <address> -CodeFile <file>`, and `-Action PetsAdopt -SaveFile <path>` run the same commands.

The pairing code is the user's to read. Never open `pairing-code.txt` or `remote-code.txt`, never pass the code on a command line, and never repeat it. The code is shown on a screen in one place only, on the host: `pets-host code` in a terminal the user sits at. Tell the user to run `pets-host code` themselves. The code leaves a computer only when a display pairs, to the host's Tailscale address. Copy no file between computers yourself: the user moves a pairing code or a `pets.json`.

If `pets-host status` says another Goblin Horde holds the saved game, stop and report it. `pets-host status` and `pets-adopt` can take 20 seconds when a lock was left behind, because they watch it first. If `pets-host enable` or `pets-host disable` says a Goblin Horde holds the saved game and did not answer, it changed nothing: report that, and do not edit `shared.json` yourself. A `pets-join` that fails saves nothing on that computer. Its check pairs with the host, so it can leave a session on the host, which ends within a day. Relay what `pets-host`, `pets-join`, and `doctor` say as worded, such as a host that is not reachable, a code the host did not accept, a host address that was refused, a file that could not be made private, or a tailscale program that was not found.

If `/api/pets` answers `ready: false` with `The saved game could not be read. A copy was kept next to it. Nothing was replaced.`, no game was started in its place. Report it as worded, and move, edit, or delete no file in the state folder: what happens to the saved game is the user's to decide.

## Report plainly

Report missing prerequisites, a port conflict, and a pet game that did not start, with the reason the manager gives.

## Privacy

The pet game reads T3 Code's local database read-only, and takes only token counts, statuses, and timestamps from it. It learns where open windows are only as rectangles, with no window titles and no program names. The local server listens on 127.0.0.1 only. The daily update check asks github.com, whose release files come from githubusercontent.com, and sends nothing but an ordinary HTTPS request with `User-Agent: GoblinHorde/<version>`. `update --off` turns it off. Nothing else leaves the computer unless the user set up a shared game. Then this crosses between the user's own paired computers on their Tailscale network, and nothing else does: the pairing code when a display pairs, each purchase and fight a display asks for, and back from the host the game's numbers and short codes that say why a game is not ready or why work is not counted. No sentence, chat text, or T3 Code data crosses. The shared game stays off until the user asks for `pets-host enable`. Never turn it on unasked.

Never print or transmit the pairing code, chat contents, Claude Code settings contents, or files from the Goblin Horde state folder during setup or removal.

## Tests and packaging (source checkout only)

`npm test` uses temporary folders and never touches real settings or starts the local server. `python -m unittest discover -s test -p "test_*.py"` runs the widget's tests. `node scripts/package.mjs` builds `dist/GoblinHorde-Team.zip` from `package-files.json`. Add any new runtime file there. `node scripts/dev/clean-install.mjs` installs that ZIP into a temporary folder and checks that the pet game loads from the installed copy.
